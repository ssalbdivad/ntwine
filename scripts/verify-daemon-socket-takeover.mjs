// Real-subsystem harness: the Claude broker's 2026-09-30 socket-takeover loss (0dc073b7,
// scripts/verify-broker-resume-race.mjs), checked against the OTHER two detached daemons — the codex
// app-server daemon (one per project) and the ACP agent daemon (one per session).
//
// What happened on the Claude side: two daemons were forked for one session on one socket PATH; the
// second unlinked the first's socket file and bound its own; when the first later self-collected, its
// `server.close()` made libuv unlink the path BY NAME — the survivor's file — and the survivor ran on,
// recorded and unreachable. Three things were missing there, and each is checked here per backend:
//
//   1. a loser's teardown must never remove a socket file it no longer owns;
//   2. a recorded daemon whose socket file is gone must collect itself instead of squatting;
//   3. concurrent callers must not fork two daemons for one key (single-flight).
//
// Everything is REAL except the provider binary: the real daemon entry forked detached with the same
// payload its host builds, the real unix socket, the real record and `.exit` breadcrumb, the real ACP
// bridge. `codex app-server` is a ten-line node stand-in that answers `initialize`; the ACP agent is the
// repo's fake-acp-agent fixture, which logs every frame it is handed (FAKE_ACP_LOG), so "one agent"
// below means one agent process actually initialized, not one host call.
//
//   run: node scripts/verify-daemon-socket-takeover.mjs   → PASS/FAIL lines; exit 1 on any fail. ~5s.
//
// DAEMON_DIR=<dist> forks the BUNDLED daemons there (`node scripts/build-package.mjs --server` emits them
// into packages/server-release/dist) instead of the source entries, for scenarios A–C — the artifact is
// one esbuild bundle per daemon, and a helper that failed to bundle would only show up there.
//
// Scenarios, each for codex and for ACP:
//   A. the 2026-09-30 sequence itself: two daemons on one path, the record names the second, the first
//      self-collects (`self-collected-record-reassigned`). The survivor must stay reachable. (These
//      daemons never call `server.close()` — `process.exit` does not unlink — so this is the CONTROL
//      that says whether the Claude mechanism exists here at all.)
//   B. the same takeover, but the loser dies while the record is ABSENT — the window every host opens
//      on purpose (forkDaemon unlinks the record before spawning; a failed attach and stop* drop it).
//      The record-only owner check unlinked the path then; the survivor's socket must survive.
//   C. a recorded, unattached daemon whose socket file is gone must exit `self-collected-socket-lost`.
// and for ACP only (codex already shares one connect per project, CodexAppServerBridge.ensureConnected):
//   D. two concurrent follow-ups to a session with no live agent (the waker's delivery and an
//      operator's send, as on 2026-09-30) must start ONE agent and deliver both messages to it.
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { codexAppServerDaemonRecordPath, codexAppServerSocketPath } from "../packages/server/src/backend/codex-app-server-host.ts"
import { acpDaemonRecordPath, acpDaemonSocketPath, daemonAcpHost, liveAcpDaemonSessionIds, stopAcpDaemon } from "../packages/server/src/backend/acp-host.ts"
import { createAcpBridge } from "../packages/server/src/backend/acp-bridge.ts"
import { detachedDaemonOutputName } from "../packages/server/src/detached-daemons.ts"

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS", msg) } else { fail++; console.log("FAIL", msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const t0 = Date.now()
const log = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

// An `error` event nobody listens for is thrown out of the event loop, and in the server that EXITS
// the control plane (dev-child.ts). Here it is recorded as a failure instead, so the run still reaches
// its teardown and kills what it forked.
const escaped = []
process.on("uncaughtException", (error) => { escaped.push(error); log(`UNCAUGHT (the server would have exited): ${error?.stack?.split("\n").slice(0, 3).join(" | ") ?? error}`) })

const CHECK_MS = 150 // the daemons' reachability interval, shortened through their own test seam
const owned = new Set() // every daemon and provider pid this harness caused, killed by exact pid at the end
const dirs = []

async function waitFor(cond, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return true; await sleep(25) }
  log(`gave up waiting for ${what} after ${ms}ms`)
  return false
}
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null } }

/** Connect, read the daemon's `hello`, and hang up. Null when nothing answers at the path. */
function hello(socketPath) {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    let buf = ""
    const done = (value) => { sock.destroy(); resolve(value) }
    sock.on("data", (c) => {
      buf += c
      const i = buf.indexOf("\n")
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))) } catch { done(null) } }
    })
    sock.on("error", () => done(null))
    setTimeout(() => done(null), 3_000).unref()
  })
}

// ---- the two daemon families, forked exactly as their hosts fork them ---------------------------------

const backendDir = fileURLToPath(new URL("../packages/server/src/backend/", import.meta.url))
const FAKE_APP_SERVER = `let b = ""
process.stdin.on("data", (c) => {
  b += c
  for (let i; (i = b.indexOf("\\n")) >= 0;) {
    const line = b.slice(0, i); b = b.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "ntwine/0.144.6 (harness)" } }) + "\\n")
  }
})
process.stdin.resume()
`

const families = {
  codex: (dir) => {
    writeFileSync(join(dir, "fake-app-server.mjs"), FAKE_APP_SERVER)
    const projectId = "proj"
    return {
      socketPath: codexAppServerSocketPath(dir, projectId),
      recordPath: codexAppServerDaemonRecordPath(dir, projectId),
      fork: (generation) => forkDaemon("codex-app-server-daemon.ts", "NTWINE_CODEX_APP_SERVER_DAEMON", {
        projectId, socketPath: codexAppServerSocketPath(dir, projectId), recordPath: codexAppServerDaemonRecordPath(dir, projectId),
        codexBin: process.execPath, cwd: dir, env: { PATH: process.env.PATH ?? "" }, generation,
        clientInfo: { name: "ntwine", version: "0" }, capabilities: {}, appServerArgs: [join(dir, "fake-app-server.mjs")],
        reachabilityCheckMs: CHECK_MS,
      }, dir),
    }
  },
  acp: (dir) => {
    const sessionId = "s1"
    return {
      socketPath: acpDaemonSocketPath(dir, sessionId),
      recordPath: acpDaemonRecordPath(dir, sessionId),
      fork: (generation) => forkDaemon("acp-daemon.ts", "NTWINE_ACP_DAEMON", {
        threadSlug: "t1", sessionId, socketPath: acpDaemonSocketPath(dir, sessionId), recordPath: acpDaemonRecordPath(dir, sessionId),
        command: process.execPath, args: [join(backendDir, "acp.fixtures/fake-acp-agent.mjs")], cwd: dir,
        env: { PATH: process.env.PATH ?? "" }, generation, reachabilityCheckMs: CHECK_MS,
      }, dir),
    }
  },
}

const sockets = new Set() // every socket path a daemon here was told to bind, removed at the end
function forkDaemon(entry, envKey, payload, cwd) {
  sockets.add(payload.socketPath)
  mkdirSync(join(payload.recordPath, ".."), { recursive: true })
  const script = process.env.DAEMON_DIR
    ? join(process.env.DAEMON_DIR, detachedDaemonOutputName(`packages/server/src/backend/${entry}`))
    : join(backendDir, entry)
  const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, [envKey]: JSON.stringify(payload) }, detached: true, stdio: "ignore" })
  child.unref()
  owned.add(child.pid)
  return child.pid
}

/** Two daemons for one key, the second taking the path and the record — the 2026-09-30 state. */
async function takeover(fam) {
  const genA = randomUUID(), genB = randomUUID()
  const a = fam.fork(genA)
  if (!await waitFor(() => readJson(fam.recordPath)?.daemonPid === a, 10_000, "daemon A's record")) return null
  const childA = readJson(fam.recordPath).childPid
  owned.add(childA)
  const b = fam.fork(genB)
  if (!await waitFor(() => readJson(fam.recordPath)?.daemonPid === b, 10_000, "daemon B's record")) return null
  owned.add(readJson(fam.recordPath).childPid)
  log(`A=${a} (child ${childA}) and B=${b} share ${fam.socketPath}; the record names B`)
  return { a, b, genA, genB, childA }
}

async function scenarioA(name, fam) {
  console.log(`\n== ${name} A: the loser self-collects with the record naming the survivor (control)`)
  const t = await takeover(fam)
  if (!t) { ok(false, `${name} A: both daemons came up`); return }
  const gone = await waitFor(() => !alive(t.a), 20 * CHECK_MS + 5_000, "the loser to self-collect")
  ok(gone, `${name} A: the loser (pid ${t.a}) self-collected`)
  ok(readJson(`${fam.recordPath}.exit`)?.reason === "self-collected-record-reassigned", `${name} A: …as self-collected-record-reassigned (breadcrumb: ${readJson(`${fam.recordPath}.exit`)?.reason})`)
  ok(existsSync(fam.socketPath), `${name} A: the survivor's socket file outlived the loser's teardown`)
  const h = await hello(fam.socketPath)
  ok(h?.generation === t.genB, `${name} A: and a connect reaches the survivor (hello generation ${h?.generation === t.genB ? "B" : h?.generation ?? "none"})`)
}

async function scenarioB(name, fam) {
  console.log(`\n== ${name} B: the loser dies while the record is absent (a forker's window)`)
  const t = await takeover(fam)
  if (!t) { ok(false, `${name} B: both daemons came up`); return }
  // Hold a client on the survivor so it is ATTACHED: an attached daemon never self-collects, so the
  // only thing that can hurt it below is the loser's teardown.
  const holder = connect(fam.socketPath)
  await new Promise((r) => holder.once("data", r))
  // The window: a host about to fork unlinks the record first (forkDaemon), as does a failed attach
  // and stop*. The loser is SIGTERMed by exact pid — its `die("signal-SIGTERM")` path.
  unlinkSync(fam.recordPath)
  process.kill(t.a, "SIGTERM")
  await waitFor(() => !alive(t.a), 5_000, "the loser to exit")
  ok(!alive(t.a), `${name} B: the loser exited on SIGTERM`)
  ok(existsSync(fam.socketPath), `${name} B: the survivor's socket file outlived the loser's teardown`)
  holder.destroy()
  const h = await hello(fam.socketPath)
  ok(h?.generation === t.genB, `${name} B: and a connect reaches the survivor (hello generation ${h?.generation === t.genB ? "B" : h?.generation ?? "none"})`)
}

async function scenarioC(name, fam) {
  console.log(`\n== ${name} C: a recorded, unattached daemon whose socket file is gone`)
  const gen = randomUUID()
  const pid = fam.fork(gen)
  if (!await waitFor(() => readJson(fam.recordPath)?.daemonPid === pid, 10_000, "the daemon's record")) { ok(false, `${name} C: daemon came up`); return }
  const child = readJson(fam.recordPath).childPid
  owned.add(child)
  unlinkSync(fam.socketPath) // a $TMPDIR cleaner, a sweep, a sibling's teardown
  const collected = await waitFor(() => !alive(pid), 20 * CHECK_MS, "the daemon to collect itself")
  ok(collected, `${name} C: the unreachable daemon collected itself within ${20 * CHECK_MS}ms (pid ${pid} ${alive(pid) ? "still alive" : "gone"})`)
  ok(readJson(`${fam.recordPath}.exit`)?.reason === "self-collected-socket-lost", `${name} C: …as self-collected-socket-lost (breadcrumb: ${readJson(`${fam.recordPath}.exit`)?.reason ?? "none"})`)
  await waitFor(() => !alive(child), 3_000, "its provider child")
  ok(!alive(child), `${name} C: and its provider child went with it`)
  ok(!existsSync(fam.recordPath), `${name} C: and it removed its own record, so the next attach forks at once`)
}

async function scenarioD() {
  console.log("\n== acp D: two concurrent follow-ups to a session with no live agent")
  const dir = mkdtempSync(join(tmpdir(), "dsock-acp-bridge-")); dirs.push(dir)
  const agentLog = join(dir, "agent-frames.jsonl")
  let hostCalls = 0
  const daemonPids = new Set()
  const bridge = createAcpBridge({
    projectId: "proj", stateDir: dir, env: { ...process.env, FAKE_ACP_LOG: agentLog },
    customAgents: () => [{ id: "fake", label: "Fake agent", command: process.execPath, args: [join(backendDir, "acp.fixtures/fake-acp-agent.mjs")] }],
    initializeTimeoutMs: 5_000, flushMs: 20,
    host: async (o) => { hostCalls++; sockets.add(acpDaemonSocketPath(o.stateDir, o.sessionId)); const a = await daemonAcpHost({ ...o, reachabilityCheckMs: CHECK_MS }); daemonPids.add(a.daemonPid); owned.add(a.daemonPid); return a },
  })
  const input = (text) => ({ threadSlug: "t1", sessionId: "s1", cwd: dir, agentId: "fake", text, deliveryId: randomUUID() })
  const escapedBefore = escaped.length
  const settled = await Promise.allSettled([bridge.followUp(input("the waker's answers")), bridge.followUp(input("the operator's send"))])
  for (const s of settled) if (s.status === "rejected") log(`a follow-up rejected: ${s.reason?.message ?? s.reason}`)
  ok(settled.every((s) => s.status === "fulfilled"), `acp D: both follow-ups resolved (${settled.map((s) => s.status).join(", ")})`)
  ok(hostCalls === 1, `acp D: the host was asked for an agent once (asked ${hostCalls}x)`)
  await waitFor(() => { const l = bridge.turnLiveness("t1", "s1"); return !l || (!l.turnActive && l.queued === 0) }, 10_000, "both turns to finish")
  const frames = (() => { try { return readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } })()
  const inits = frames.filter((f) => f.method === "initialize").length
  const prompts = frames.filter((f) => f.method === "session/prompt").map((f) => f.params?.prompt?.[0]?.text)
  ok(inits === 1, `acp D: exactly one agent process was initialized (${inits})`)
  ok(prompts.includes("the waker's answers") && prompts.includes("the operator's send"), `acp D: both messages reached the agent (${JSON.stringify(prompts)})`)
  await sleep(4 * CHECK_MS) // long enough for a superseded, unattached daemon to self-collect
  const live = [...daemonPids].filter(alive)
  ok(live.length === 1, `acp D: one daemon is alive afterwards (${live.length} of ${daemonPids.size} forked)`)
  ok(escaped.length === escapedBefore, `acp D: no error escaped to the process (${escaped.length - escapedBefore} uncaught)`)
  await bridge.shutdown()
  for (const sessionId of liveAcpDaemonSessionIds(dir)) await stopAcpDaemon(dir, sessionId)
}

try {
  for (const [name, make] of Object.entries(families)) {
    for (const scenario of [scenarioA, scenarioB, scenarioC]) {
      const dir = mkdtempSync(join(tmpdir(), `dsock-${name}-`)); dirs.push(dir)
      await scenario(name, make(dir))
    }
  }
  if (process.env.DAEMON_DIR) console.log("\n== acp D skipped: it forks through daemonAcpHost, which resolves the source entry")
  else await scenarioD()
} finally {
  for (const pid of owned) { try { process.kill(pid, "SIGKILL") } catch {} }
  await sleep(200)
  const survivors = [...owned].filter(alive)
  if (survivors.length) console.log(`WARNING: still alive after teardown: ${survivors.join(" ")}`)
  for (const path of sockets) { try { unlinkSync(path) } catch {} }
  for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
process.exit(fail ? 1 : 0)
