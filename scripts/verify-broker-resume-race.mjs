// Real-subsystem harness for the Claude broker's COLD-RESUME RACE (the real-subsystem-harness skill).
//
// The incident it reproduces (2026-09-30, thread `we-ve-got-to-start-working`, 0.15.3): a hibernated
// thread received two inputs in the same instant — the waker delivering four question answers and the
// operator's own send. Each followUp saw no live daemon and FORKED one (pids 51062 and 51063, back to
// back), while the server's event loop sat starved behind the blocking orphan-reaper `ps` sweeps. Both
// daemons bound the SAME socket path; the second unlinked the first's socket file and took the record.
// Sixty seconds later the first self-collected ("record reassigned") and its `server.close()` — libuv
// unlinks a unix socket's PATH on close — deleted the SURVIVOR's socket file. The survivor lived on,
// recorded and unreachable. When the loop finally ran, both followUps (and the later "GO!!") bound a
// client to a path that no longer existed, `sendInput` buffered the frame and returned, the router
// wrote `delivered`, and the client gave up 30s later and dropped the frame. Nothing reached the agent.
//
// Everything here is REAL except `claude` itself: the real bridge, the real forked detached daemon, the
// real unix socket, the real record and diagnostics files. The CLI is the repo's fake-claude fixture,
// which records every input it is handed (`user-input` in capture.jsonl) — so "delivered" below means
// the input reached the process that would run the turn, not that a frame was written somewhere.
//
// THE INVARIANT under test, in every scenario: a followUp that RESOLVES handed its text to a live
// claude process. A followUp that cannot promise that must REJECT, so the operator's send rolls back.
//
//   run: nub scripts/verify-broker-resume-race.mjs     → PASS/FAIL lines; exit 1 on any fail. ~4 min.
//
// Scenarios:
//   1. two concurrent follow-ups to a hibernated thread, with the event loop stalled past the loser's
//      self-collection (the incident, end to end), then a third follow-up ("GO!!").
//   2. two daemons forked for one session directly (bypassing the bridge — a second server, or any
//      future caller that forks without the bridge's single-flight): the loser's teardown must not
//      take the survivor's socket with it.
//   3. a live daemon whose socket file vanished (a $TMPDIR cleaner, a sweep): a follow-up must reject
//      rather than report success, and the daemon must stop squatting on the record so the next one
//      cold-resumes.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createClaudeAgentBrokerBridge } from "../packages/server/src/backend/claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, claudeBrokerSocketPath, forkBroker, readBrokerRecord } from "../packages/server/src/backend/claude-broker-host.ts"
import { connectClaudeBroker } from "../packages/server/src/backend/claude-broker-client.ts"
import { claudeBrokerDiagnosticLogPath } from "../packages/server/src/backend/claude-broker-diagnostics.ts"

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS", msg) } else { fail++; console.log("FAIL", msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const t0 = Date.now()
const log = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
// The production stall, reproduced exactly: SYNCHRONOUS work on the server's event loop (0.15.3 ran
// 22 per-project `execFileSync ps` sweeps back to back). Timers, socket I/O and child-exit events all
// wait behind it, while the detached daemons — separate processes — carry on without us.
const stallEventLoop = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const fakeCli = fileURLToPath(new URL("../packages/server/src/backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const owned = new Set() // every daemon pid this harness caused, killed by exact pid in teardown

function sandbox(tag) {
  const dir = mkdtempSync(join(tmpdir(), `cbrk-race-${tag}-`))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const lines = (path) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
  return {
    dir, exe,
    capture: () => lines(join(dir, "capture.jsonl")),
    startups: () => lines(join(dir, "capture.jsonl")).filter((r) => r.kind === "startup").length,
    inputs: () => new Set(lines(join(dir, "capture.jsonl")).filter((r) => r.kind === "user-input").map((r) => r.uuid)),
    diagnostics: (sessionId) => lines(claudeBrokerDiagnosticLogPath(dir, sessionId)),
  }
}

async function waitFor(cond, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return true; await sleep(100) }
  log(`gave up waiting for ${what} after ${ms}ms`)
  return false
}

const settle = (p) => p.then(() => ({ ok: true }), (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))

function track(dir, sessionId) {
  const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  if (r) owned.add(r.daemonPid)
  return r
}

// ---------------------------------------------------------------------------------------------------
async function scenarioConcurrentResume() {
  console.log("\n# 1. two concurrent follow-ups to a hibernated thread, event loop stalled past self-collection")
  const box = sandbox("s1")
  const bridge = createClaudeAgentBrokerBridge({ stateDir: box.dir, executablePath: box.exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  const sessionId = randomUUID(), slug = "we-ve-got-to-start-working"
  const input = (text) => ({ threadSlug: slug, sessionId, cwd: box.dir, text, deliveryId: randomUUID() })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: box.dir, prompt: "start", permissionMode: "default" })
    const first = track(box.dir, sessionId)
    await waitFor(() => box.startups() >= 1, 10_000, "the dispatch's claude")
    // Hibernate, exactly as thread-hibernation.ts does, and wait for the process to be gone.
    bridge.retireDaemon({ threadSlug: slug, sessionId, reason: "hibernate" })
    await waitFor(() => !alive(first.daemonPid), 10_000, "the hibernated daemon to exit")
    const startupsBefore = box.startups()

    // The waker's question answers and the operator's send, in the same tick.
    const answers = input("4 question answers"), steer = input("x".repeat(4000))
    const pAnswers = settle(bridge.followUp(answers)), pSteer = settle(bridge.followUp(steer))
    log("both follow-ups issued; stalling the event loop 75s (past a loser's 60s self-collection)")
    stallEventLoop(75_000)
    log("event loop released")
    const [rAnswers, rSteer] = await Promise.all([pAnswers, pSteer])
    track(box.dir, sessionId)
    log(`answers: ${JSON.stringify(rAnswers)} steer: ${JSON.stringify(rSteer)}`)
    // The operator, seeing nothing happen, sends "GO!!".
    const go = input("GO!!")
    const rGo = await settle(bridge.followUp(go))
    log(`GO!!: ${JSON.stringify(rGo)}`)

    const sends = [["answers", answers, rAnswers], ["steer", steer, rSteer], ["GO!!", go, rGo]]
    const resolved = sends.filter(([, , r]) => r.ok)
    // Early exit on success; the failure budget is the client's own 30s give-up plus slack.
    await waitFor(() => resolved.every(([, s]) => box.inputs().has(s.deliveryId)), 40_000, "every RESOLVED send to reach claude")
    const forks = box.startups() - startupsBefore
    for (const r of box.diagnostics(sessionId)) if (r.daemonPid) owned.add(r.daemonPid)
    const daemonStarts = box.diagnostics(sessionId).filter((r) => r.diagnostic?.phase === "started").length - 1
    log(`claude processes started by the resume: ${forks}; daemons started: ${daemonStarts}`)
    ok(daemonStarts === 1, `exactly ONE daemon cold-resumed the session (saw ${daemonStarts})`)
    for (const [name, s, r] of sends) {
      const reached = box.inputs().has(s.deliveryId)
      ok(!r.ok || reached, `${name}: resolved ⇒ reached claude (resolved=${r.ok}, reached=${reached})`)
      ok(r.ok, `${name}: the send succeeded (nothing about this race should fail an operator's send)`)
    }
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
  }
  return box
}

// ---------------------------------------------------------------------------------------------------
async function scenarioTwoDaemons() {
  console.log("\n# 2. two daemons forked for one session: the loser must not delete the survivor's socket")
  const box = sandbox("s2")
  const sessionId = randomUUID()
  const opts = { stateDir: box.dir, cwd: box.dir, sessionId, executablePath: box.exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, resume: false }
  // Staggered like production (the two `started` lines were 287ms apart): simultaneous binds race to
  // EADDRINUSE instead, which is a different — and self-limiting — outcome.
  const pA = settle(forkBroker(opts))
  stallEventLoop(300)
  const pB = settle(forkBroker(opts))
  // Hold the loop so both daemons publish before either poll runs — the second overwrites the first's
  // record and steals its socket path, which is exactly the production ordering.
  stallEventLoop(3_000)
  await Promise.all([pA, pB])
  const survivor = track(box.dir, sessionId)
  const starts = box.diagnostics(sessionId).filter((r) => r.diagnostic?.phase === "started")
  for (const s of starts) owned.add(s.daemonPid)
  ok(starts.length === 2 && !!survivor, `precondition: two daemons started, one holds the record (${starts.length} started)`)
  const loser = starts.find((s) => s.daemonPid !== survivor?.daemonPid)
  log(`survivor ${survivor?.daemonPid}, loser ${loser?.daemonPid}; waiting for the loser to self-collect (~60s)`)
  // Early exit on the loser dying; fail fast if the survivor dies instead.
  await waitFor(() => !loser || !alive(loser.daemonPid) || !alive(survivor.daemonPid), 80_000, "the loser to self-collect")
  log(`exits: ${JSON.stringify(box.diagnostics(sessionId).filter((r) => r.exit).map((r) => [r.daemonPid, r.exit.reason]))}`)
  ok(!!loser && !alive(loser.daemonPid), "the loser self-collected")
  ok(!!survivor && alive(survivor.daemonPid), "the survivor is still running")
  const socketPath = claudeBrokerSocketPath(box.dir, sessionId)
  ok(existsSync(socketPath), "the survivor's socket file still exists after the loser's teardown")
  // Reachability, end to end: an input sent on the path must reach the survivor's claude.
  const client = connectClaudeBroker(socketPath, {}, { connectDeadlineMs: 5_000 })
  const id = randomUUID()
  try { client.sendInput({ id, text: "are you reachable?" }) } catch {}
  await waitFor(() => box.inputs().has(id), 8_000, "the probe input to reach the survivor's claude")
  ok(box.inputs().has(id), "an input sent to the socket path reaches the survivor's claude")
  client.close()
  return box
}

// ---------------------------------------------------------------------------------------------------
async function scenarioSocketLost() {
  console.log("\n# 3. a live daemon whose socket file vanished")
  const box = sandbox("s3")
  const bridge = createClaudeAgentBrokerBridge({ stateDir: box.dir, executablePath: box.exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  const sessionId = randomUUID(), slug = "socket-lost"
  const input = (text) => ({ threadSlug: slug, sessionId, cwd: box.dir, text, deliveryId: randomUUID() })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: box.dir, prompt: "start", permissionMode: "default" })
    const daemon = track(box.dir, sessionId)
    await waitFor(() => box.startups() >= 1, 10_000, "the dispatch's claude")
    // Detach (an ntwine restart), then the socket file disappears under the idle daemon.
    bridge.close()
    unlinkSync(claudeBrokerSocketPath(box.dir, sessionId))
    const bridge2 = createClaudeAgentBrokerBridge({ stateDir: box.dir, executablePath: box.exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
    try {
      const lost = input("sent into a daemon nobody can reach")
      const rLost = await settle(bridge2.followUp(lost))
      await sleep(2_000)
      const reached = box.inputs().has(lost.deliveryId)
      log(`send to the unreachable daemon: ${JSON.stringify(rLost)}; reached=${reached}`)
      ok(!rLost.ok || reached, "a send to an unreachable daemon does not resolve without reaching claude")
      // The unreachable daemon must get out of the way so the thread is recoverable.
      await waitFor(() => !alive(daemon.daemonPid), 80_000, "the unreachable daemon to self-collect")
      ok(!alive(daemon.daemonPid), "the unreachable daemon self-collected instead of squatting on the record")
      const exit = box.diagnostics(sessionId).find((r) => r.daemonPid === daemon.daemonPid && r.exit)
      log(`its exit record: ${JSON.stringify(exit?.exit)}`)
      const next = input("the next send cold-resumes")
      const rNext = await settle(bridge2.followUp(next))
      track(box.dir, sessionId)
      await waitFor(() => box.inputs().has(next.deliveryId), 15_000, "the recovery send to reach claude")
      ok(rNext.ok && box.inputs().has(next.deliveryId), `the next send cold-resumes and reaches claude (${JSON.stringify(rNext)})`)
    } finally {
      bridge2.releaseSession(slug, sessionId, "session-deleted")
      bridge2.close()
    }
  } catch (error) {
    ok(false, `scenario 3 threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  return box
}

const boxes = []
const only = process.argv[2]
try {
  if (!only || only === "1") boxes.push(await scenarioConcurrentResume())
  if (!only || only === "2") boxes.push(await scenarioTwoDaemons())
  if (!only || only === "3") boxes.push(await scenarioSocketLost())
} catch (error) {
  ok(false, `harness threw: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const pid of owned) { try { process.kill(pid, "SIGKILL") } catch {} }
  await sleep(300)
  for (const box of boxes) { try { rmSync(box.dir, { recursive: true, force: true }) } catch {} }
  const survivors = [...owned].filter(alive)
  console.log(`\n${pass} passed, ${fail} failed${survivors.length ? `; SURVIVING daemons: ${survivors.join(",")}` : ""}`)
  process.exit(fail > 0 ? 1 : 0)
}
