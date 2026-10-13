// The detached daemon exists for exactly ONE reason: an in-flight Codex turn must SURVIVE the ntwine
// runtime being recycled (Update & Restart). Before it, a restart SIGTERMed the app-server and every
// running turn died mid-sentence — no task_complete, no turn_aborted, no resume; the thread just went
// quiet until a human poked it (that is the "agents shutting down and pausing" complaint).
//
// _live_appserver_daemon_survival.mts proves this from SOURCE. That is not enough: the daemon was
// BROKEN IN THE PROMOTED ARTIFACT for its entire existence (the sibling-.ts entry the bundle never
// emitted), so the survival property has never once held for a real user. This proves it where it
// actually has to hold — a built artifact, killed hard, restarted.
//
// Isolation: temp HOME + state dir + project dir, unique port, wakers/reaper off.
// CODEX_HOME points at the real ~/.codex so the app-server can authenticate.
//
//   nub scripts/verify-artifact-restart-survival.mjs
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildNtwineArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const SOURCE = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.VERIFY_PORT ?? 4942)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[survival]", ...a)
let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }

const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-survival-")))
const home = join(root, "home")
const stateDir = join(root, "state")
const PROJECT_DIR = join(root, "project")
for (const d of [join(home, ".ntwine"), stateDir, PROJECT_DIR]) mkdirSync(d, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: PROJECT_DIR })
writeFileSync(join(PROJECT_DIR, "README.md"), "# survival fixture\n")

const api = createRpcClient(`http://127.0.0.1:${PORT}/`)
const servers = []
let release
let daemonRecord = null

function bootServer(artifact, target, token, label) {
  let output = ""
  const child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
    cwd: PROJECT_DIR,
    env: projectLaunchEnvironment(
      {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(homedir(), ".codex"),
        NTWINE_DEV_CHILD: "1",
        NTWINE_DEV_PORT: String(PORT),
        NTWINE_WAKERS_OFF: "1",
        NTWINE_ORPHAN_REAPER_OFF: "1",
        NTWINE_SANDBOX_TAG: `ntwine-survival-${PORT}-${process.pid}`,
        NTWINE_STABLE_ARTIFACT: artifact.digest,
        NTWINE_STABLE_WEB_DIST: artifact.webDir,
        NTWINE_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
        NTWINE_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
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

// NTWINE_CODEX_NATIVE_LISTEN=1 swaps the hand-written daemon for `codex app-server --listen unix://`
// (codex-app-server-native.ts). It reaches the booted runtimes through the `...process.env` spread in
// bootServer, so running this harness with the flag set exercises that transport instead. The native
// listener is ONE process rather than a daemon wrapping a child, so its pid stands in for both — every
// assertion below then reads "the app-server outlived the runtime" exactly as it does for the daemon.
const NATIVE = process.env.NTWINE_CODEX_NATIVE_LISTEN === "1" || process.env.NTWINE_CODEX_NATIVE_LISTEN === "true"
const readRecord = () => {
  const dir = join(stateDir, NATIVE ? "codex-app-server-native" : "codex-app-server")
  const files = existsSync(dir) ? readdirSync(dir) : []
  if (!files.length) return null
  const record = JSON.parse(readFileSync(join(dir, files[0]), "utf8"))
  return NATIVE ? { ...record, daemonPid: record.listenerPid, childPid: record.listenerPid } : record
}

try {
  log("building a real artifact…")
  const artifact = buildNtwineArtifact(SOURCE, join(root, "artifacts"))
  log("artifact", artifact.digest)

  const target = { projectId: randomUUID(), projectDir: PROJECT_DIR, stateDir }
  const owner = acquireProjectLaunchOwner(target, "launcher")
  release = owner.release

  const first = bootServer(artifact, target, owner.token, "first")
  check(await api.waitForHealth(40_000), "first server is serving")

  // PRECONDITION, not a product assertion. These harnesses isolate HOME to a temp dir and inject
  // CODEX_HOME so the app-server can still authenticate. When that var does not reach the child the
  // lookup falls back to <tempHOME>/.codex, finds nothing, and dispatch fails with a bare
  // "AUTH_REQUIRED:codex" 500 that reads like a product bug. Say what it actually is. (A real user's
  // HOME is their own, so this fallback finds their real ~/.codex — the hazard is harness-only.)
  const auth = await api.query("authStatus").catch((e) => ({ error: e.message }))
  if (auth?.codex !== "authed") {
    throw new Error(`HARNESS ENV: the server cannot see codex credentials (authStatus=${JSON.stringify(auth)}). CODEX_HOME did not reach it; re-run.`)
  }


  // A turn long enough to still be running when the runtime dies under it. `sleep` needs a real
  // sandbox, which a ntwine-dispatched codex worker gets (danger-full-access).
  log("dispatching a codex turn that will still be in flight when we kill the server…")
  const { slug, sessionId } = await api.mutate("dispatch", {
    title: "restart survival",
    prompt: "Run exactly this shell command and wait for it to finish: `sleep 40`. After it completes, reply with exactly the word SURVIVED and nothing else.",
    backend: "codex",
  })
  check(!!slug, "codex dispatch succeeded", `${slug} / ${sessionId}`)

  for (let i = 0; i < 80 && !daemonRecord; i++) { daemonRecord = readRecord(); if (!daemonRecord) await sleep(250) }
  check(!!daemonRecord, "the detached daemon published its record", JSON.stringify(daemonRecord)?.slice(0, 160))

  const running = await (async () => {
    for (let i = 0; i < 60; i++) {
      const t = (await api.query("board"))?.threads?.find((x) => x.id === slug)
      if (t?.runtime === "running") return t
      await sleep(500)
    }
    return null
  })()
  check(!!running, "the turn is in flight before the restart", running ? `runtime=${running.runtime}` : "never went running")

  // ---- the actual event: a HARD kill of the runtime, mid-turn -------------------------------------
  log("SIGKILLing the ntwine runtime mid-turn (the harshest form of Update & Restart)…")
  process.kill(first.child.pid, "SIGKILL")
  await sleep(2500)
  check(!alive(first.child.pid), "the ntwine runtime is gone")
  check(alive(daemonRecord.daemonPid), "the DETACHED daemon outlived it", `daemonPid=${daemonRecord.daemonPid}`)
  check(alive(daemonRecord.childPid), "and so did the codex app-server running the turn", `childPid=${daemonRecord.childPid}`)

  // ---- a new generation rejoins ------------------------------------------------------------------
  // Reuse the SAME lease: this harness process is the launch owner and the servers are its delegates,
  // exactly as the real launcher works. Re-acquiring would contend with the lease we still hold.
  const second = bootServer(artifact, target, owner.token, "second")
  check(await api.waitForHealth(40_000), "a new runtime booted against the same state")

  const after = readRecord()
  check(
    after && after.generation === daemonRecord.generation && after.childPid === daemonRecord.childPid,
    "the new runtime rejoined the SAME app-server process, it did not start a fresh one",
    after ? `generation ${after.generation === daemonRecord.generation ? "unchanged" : "CHANGED"}, childPid ${after.childPid}` : "no record",
  )

  // The payoff: the turn that was running when we killed the runtime must still finish on its own,
  // without a human poking the thread.
  log("waiting for the pre-restart turn to complete under the new runtime…")
  const settled = await (async () => {
    for (let i = 0; i < 160; i++) {
      const t = (await api.query("board"))?.threads?.find((x) => x.id === slug)
      if (t && t.runtime !== "running" && t.runtime !== "spawning") return t
      await sleep(1000)
    }
    return null
  })()
  check(!!settled, "the interrupted turn reached rest by itself", settled ? `runtime=${settled.runtime}` : "still running after 160s")
  check(
    !/exited before it became ready|falling back to an in-process/.test(second.out()),
    "no daemon failure or fallback in the new runtime's output",
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
  // The daemon may still be unlinking its socket/record; retry rather than throwing out of `finally`
  // and hiding the real result.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
