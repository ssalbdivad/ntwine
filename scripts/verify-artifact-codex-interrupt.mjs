// END-TO-END proof that STOPPING a Codex thread actually stops the Codex turn.
//
// The bug this guards against: back when frizz still drove workers through tmux, an app-server Codex
// thread had no pane, yet every "stop this thread" verb went through the tmux terminator —
// kill-session for a session that never existed, reported as "stopped", while the turn kept running. That was masked while the app-server died with
// the frizz runtime. It no longer does: the app-server lives in a DETACHED daemon that deliberately
// outlives us (see verify-artifact-restart-survival.mjs), so a turn frizz claims to have stopped keeps
// burning tokens and touching the repo with no frizz-side owner and no UI trace.
//
// A unit test with a mocked bridge cannot prove a turn stopped. This drives the REAL thing: a built
// artifact, a real codex worker running `sleep 60`, killed over the real RPC surface, and the CODEX
// ROLLOUT ITSELF as ground truth — `turn_aborted` (the turn was interrupted) must appear and
// `task_complete` (the turn ran to its own ending) must NOT.
//
// Isolation: temp HOME + state dir + project dir, unique port, wakers/reaper off.
// CODEX_HOME points at the real ~/.codex so the app-server can authenticate; nothing is written there
// beyond the throwaway rollouts codex records for itself.
//
//   nub scripts/verify-artifact-codex-interrupt.mjs
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFrizzArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const SOURCE = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.VERIFY_PORT ?? 4943)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[interrupt]", ...a)
let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }

const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-interrupt-")))
const home = join(root, "home")
const stateDir = join(root, "state")
const PROJECT_DIR = join(root, "project")
for (const d of [join(home, ".frizz"), stateDir, PROJECT_DIR]) mkdirSync(d, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: PROJECT_DIR })
writeFileSync(join(PROJECT_DIR, "README.md"), "# interrupt fixture\n")

const api = createRpcClient(`http://127.0.0.1:${PORT}/`)
const servers = []
let release
let daemonRecord = null

// Ground truth for "did the turn stop?", read from codex's OWN rollout journal rather than from
// anything frizz reports about itself. `turn_aborted` is emitted when a turn is interrupted;
// `task_complete` when it runs to its own ending. (Same parse as _live_appserver_daemon_survival.mts.)
function rolloutStats(codexSessionId) {
  const base = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(`-${codexSessionId}.jsonl`)) hit = p
    }
  }
  try { walk(base) } catch {}
  if (!hit) return { found: false, started: 0, completed: 0, aborted: 0, execCalls: 0, pendingExec: 0 }
  const records = readFileSync(hit, "utf8").trim().split("\n")
    .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  const kinds = records.filter((r) => r.type === "event_msg").map((r) => r.payload?.type)
  // "Is a shell command running right now?" — this codex version journals tool calls as
  // response_item/function_call (name exec_command), NOT as exec_command_begin/end event_msgs, so an
  // in-flight command is a function_call whose call_id has no function_call_output yet.
  const items = records.filter((r) => r.type === "response_item").map((r) => r.payload ?? {})
  const calls = items.filter((p) => p.type === "function_call").map((p) => p.call_id)
  const answered = new Set(items.filter((p) => p.type === "function_call_output").map((p) => p.call_id))
  return {
    found: true,
    file: hit,
    started: kinds.filter((k) => k === "task_started").length,
    completed: kinds.filter((k) => k === "task_complete").length,
    aborted: kinds.filter((k) => k === "turn_aborted").length,
    execCalls: calls.length,
    pendingExec: calls.filter((id) => !answered.has(id)).length,
  }
}

function bootServer(artifact, target, token, label) {
  let output = ""
  const child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
    cwd: PROJECT_DIR,
    env: projectLaunchEnvironment(
      {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(homedir(), ".codex"),
        FRIZZ_DEV_CHILD: "1",
        FRIZZ_DEV_PORT: String(PORT),
        FRIZZ_WAKERS_OFF: "1",
        FRIZZ_ORPHAN_REAPER_OFF: "1",
        FRIZZ_SANDBOX_TAG: `frizz-interrupt-${PORT}-${process.pid}`,
        FRIZZ_STABLE_ARTIFACT: artifact.digest,
        FRIZZ_STABLE_WEB_DIST: artifact.webDir,
        FRIZZ_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
        FRIZZ_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
      },
      target,
      token,
    ),
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (c) => { output += c })
  child.stderr.on("data", (c) => { output += c })
  servers.push(child)
  log(`${label} server pid ${child.pid}`)
  return { child, out: () => output }
}

const readRecord = () => {
  const dir = join(stateDir, "codex-app-server")
  const files = existsSync(dir) ? readdirSync(dir) : []
  return files.length ? JSON.parse(readFileSync(join(dir, files[0]), "utf8")) : null
}

const thread = async (slug) => (await api.query("board"))?.threads?.find((x) => x.id === slug)

// The codex ROLLOUT id frizz pinned for this row (not the frizz session UUID). ThreadView does not carry
// it and no RPC returns it, so it is read off the row's own `agent_session_id` column, which is filled
// in shortly after the spawn (verify-artifact-daemon-closure.mjs reads its column the same way).
const codexRolloutId = async (slug) => {
  for (let i = 0; i < 120; i++) {
    const id = execFileSync("sqlite3", [
      join(stateDir, "ui.db"),
      `SELECT agent_session_id FROM session WHERE slug = '${slug}';`,
    ], { encoding: "utf8" }).trim()
    if (id) return id
    await sleep(500)
  }
  return null
}

const waitForThread = async (slug, predicate, seconds, label) => {
  for (let i = 0; i < seconds * 2; i++) {
    const t = await thread(slug)
    if (t && predicate(t)) return t
    await sleep(500)
  }
  log(`  (timed out waiting for ${label})`)
  return null
}

// A long, observable turn. `sleep` needs a real sandbox, which a frizz-dispatched codex worker gets.
const LONG_TURN = "Run exactly this shell command and wait for it to finish: `sleep 60`. After it completes, reply with exactly the word FINISHED and nothing else."

try {
  log("building a real artifact…")
  const artifact = buildFrizzArtifact(SOURCE, join(root, "artifacts"))
  log("artifact", artifact.digest)

  const target = { projectId: randomUUID(), projectDir: PROJECT_DIR, stateDir }
  const owner = acquireProjectLaunchOwner(target, "launcher")
  release = owner.release

  const server = bootServer(artifact, target, owner.token, "only")
  check(await api.waitForHealth(40_000), "server is serving")

  // ============ A — killAgent on a RUNNING codex turn must actually stop it ============
  log("A: dispatching a codex turn that will still be running when we stop it…")
  const a = await api.mutate("dispatch", { title: "interrupt me", prompt: LONG_TURN, backend: "codex" })
  check(!!a.slug, "codex dispatch succeeded", `${a.slug} / ${a.sessionId}`)

  for (let i = 0; i < 80 && !daemonRecord; i++) { daemonRecord = readRecord(); if (!daemonRecord) await sleep(250) }
  check(!!daemonRecord, "the detached daemon published its record", daemonRecord ? `daemonPid=${daemonRecord.daemonPid} childPid=${daemonRecord.childPid}` : "")

  const runningA = await waitForThread(a.slug, (t) => t.runtime === "running", 60, "turn A to go running")
  check(!!runningA, "the turn is in flight before we stop it", runningA ? `runtime=${runningA.runtime}` : "never went running")

  const codexSessionA = await codexRolloutId(a.slug)
  check(!!codexSessionA, "frizz pinned the codex rollout id for this thread", String(codexSessionA))
  log(`  codex rollout id: ${codexSessionA}`)

  // Wait until `sleep 60` is genuinely EXECUTING, so the interrupt lands mid-command and the
  // "no orphaned work continues" window is real rather than a turn we killed before it did anything.
  let midCommand = null
  for (let i = 0; i < 120; i++) {
    const s = rolloutStats(codexSessionA)
    if (s.found && s.pendingExec > 0) { midCommand = s; break }
    if (s.completed > 0) break
    await sleep(1000)
  }
  check(!!midCommand, "the worker is mid-`sleep 60` when we stop it", midCommand ? `execCalls=${midCommand.execCalls} pendingExec=${midCommand.pendingExec}` : "never had a command in flight")

  const beforeA = rolloutStats(codexSessionA)
  log(`  rollout BEFORE the stop: ${JSON.stringify({ ...beforeA, file: undefined })}`)
  check(beforeA.found && beforeA.started >= 1, "codex recorded a started turn", JSON.stringify({ started: beforeA.started, completed: beforeA.completed, aborted: beforeA.aborted }))
  check(beforeA.completed === 0, "and it had NOT completed on its own before we stopped it")

  const t0 = Date.now()
  log("  calling killAgent on the running codex thread…")
  await api.mutate("killAgent", { slug: a.slug })
  log(`  killAgent returned in ${Date.now() - t0}ms`)

  const afterA = rolloutStats(codexSessionA)
  log(`  rollout AFTER the stop: ${JSON.stringify({ ...afterA, file: undefined })}`)
  check(afterA.aborted >= 1, "GROUND TRUTH: the codex rollout records turn_aborted — the turn was interrupted", `aborted=${afterA.aborted}`)
  check(afterA.completed === 0, "and NOT task_complete — the turn did not run to its own ending", `completed=${afterA.completed}`)

  // …and the ROW settles coherently with it. An app-server codex row has no pane, so "stopped" is not
  // "dead" — board.ts derives its runtime from the rollout, and the stopped thread must come to REST.
  // Carding it as still-running (and then, once the stall grace expires, as crashed/"Stalled" with a
  // Retry) is exactly what the turn_aborted bracket fixes.
  const stoppedRow = await waitForThread(a.slug, (t) => t.runtime !== "running", 30, "row A to settle")
  check(stoppedRow?.runtime === "turn-idle", "the row settles AT REST, not spinning and not falsely crashed", `runtime=${stoppedRow?.runtime}`)

  // The turn must stay dead. We interrupt within a few seconds of `sleep 60` starting, so an
  // uninterrupted turn would reach its own task_complete comfortably inside this window — the point
  // of watching past it is that a stop frizz only CLAIMED would show up here as a turn finishing
  // normally inside the daemon, with no frizz-side owner left to notice.
  log("  watching for 90s to prove no orphaned work continues inside the daemon…")
  await sleep(90_000)
  const settledA = rolloutStats(codexSessionA)
  log(`  rollout AFTER +90s: ${JSON.stringify({ ...settledA, file: undefined })}`)
  check(settledA.completed === 0, "90s later the interrupted turn STILL has no task_complete", `completed=${settledA.completed}`)
  check(settledA.aborted === afterA.aborted, "and nothing else ran in the daemon on its behalf", `aborted=${settledA.aborted}`)
  check(alive(daemonRecord.childPid), "the app-server itself is untouched — we stopped a TURN, not the process")

  // ============ B — NEGATIVE CONTROL: stopping a thread with no active turn ============
  log("B: negative control — a codex thread at rest must report 'nothing to stop', not error…")
  const b = await api.mutate("dispatch", { title: "already at rest", prompt: "Reply with exactly the word READY and nothing else.", backend: "codex" })
  check(!!b.slug, "second codex dispatch succeeded", `${b.slug} / ${b.sessionId}`)
  const restedB = await waitForThread(b.slug, (t) => t.runtime !== "running" && t.runtime !== "spawning", 120, "turn B to reach rest")
  check(!!restedB, "the second thread reached rest on its own", restedB ? `runtime=${restedB.runtime}` : "still running")

  const codexSessionB = await codexRolloutId(b.slug)
  const beforeB = rolloutStats(codexSessionB)
  log(`  rollout at rest: ${JSON.stringify({ ...beforeB, file: undefined })}`)
  check(beforeB.completed >= 1, "its turn completed normally (task_complete)", `completed=${beforeB.completed}`)

  let negativeControlError = null
  try {
    await api.mutate("killAgent", { slug: b.slug })
  } catch (error) {
    negativeControlError = error
  }
  check(!negativeControlError, "stopping a resting codex thread does not error", negativeControlError ? String(negativeControlError.message) : "resolved")
  const afterB = rolloutStats(codexSessionB)
  check(afterB.aborted === beforeB.aborted, "and nothing was aborted — there was nothing to stop", `aborted ${beforeB.aborted} -> ${afterB.aborted}`)
  // A resting app-server codex row still derives runtime from its rollout (board.ts deriveRuntime:
  // these threads have no pane, and a persisted bridge thread is always resumable), so "stopped" does
  // not turn it into a dead row — and must not wedge it either.
  const rowB = await thread(b.slug)
  check(!!rowB && rowB.runtime === "turn-idle", "the row stays at rest rather than wedging", `runtime=${rowB?.runtime}`)

  // It must remain a USABLE row, not a wedged one: Mark as done is the next thing an operator does.
  let doneError = null
  let doneResult = null
  try { doneResult = await api.mutate("completeThread", { slug: b.slug, sessionId: b.sessionId, terminateLive: false }) }
  catch (error) { doneError = error }
  check(!doneError && doneResult?.needsConfirmation === false, "and Mark as done still works on it afterwards",
    doneError ? String(doneError.message) : JSON.stringify(doneResult))
  const archivedB = await thread(b.slug)
  check(archivedB?.archived === true || archivedB === undefined, "the thread archives", `archived=${archivedB?.archived}`)

  check(
    !/exited before it became ready|falling back to an in-process/.test(server.out()),
    "no daemon failure or fallback in the server's output",
  )
} catch (error) {
  check(false, "harness completed without throwing", String(error?.stack ?? error?.message ?? error))
} finally {
  for (const child of servers) { if (child?.pid) { try { process.kill(child.pid, "SIGKILL") } catch {} } }
  try { release?.() } catch {}
  // Only the pids THIS run created, read from its own record. Never a broad pkill — other agents'
  // servers are running on this machine.
  const rec = daemonRecord ?? readRecord()
  for (const pid of [rec?.childPid, rec?.daemonPid]) { if (pid) { try { process.kill(pid, "SIGKILL") } catch {} } }
  await sleep(1000)
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
