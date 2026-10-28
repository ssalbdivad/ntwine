// END-TO-END proof that a PROMOTED ARTIFACT can actually run Codex.
//
// The failure this guards against lives ONLY in a built artifact: the runtime is a single esbuild
// bundle, so a detached daemon referenced as a sibling `.ts` resolves to a path that was never
// emitted — node exits MODULE_NOT_FOUND and every Codex dispatch/follow-up/steer fails with
// "codex app-server daemon exited before it became ready" (live outage 2026-07-23). A source-run
// stack cannot see it either way, so this builds a REAL artifact and drives the REAL app from it.
//
// Isolation: temp HOME + state dir, unique port, wakers and reaper off. CODEX_HOME
// points at the real ~/.codex so the app-server can authenticate; nothing is written there beyond the
// throwaway rollout codex records for itself.
//
//   node scripts/verify-artifact-daemon-closure.mjs
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { buildNtwineArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { DETACHED_DAEMON_ENTRIES, detachedDaemonOutputName } from "../packages/server/src/detached-daemons.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const SOURCE = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.VERIFY_PORT ?? 4941)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[verify]", ...a)
// NTWINE_CODEX_NATIVE_LISTEN=1 swaps the hand-written daemon for `codex app-server --listen unix://`
// (codex-app-server-native.ts). It reaches the booted runtime through this script's own environment,
// so the same closure assertions run against either transport — only the record dir differs.
const NATIVE = process.env.NTWINE_CODEX_NATIVE_LISTEN === "1" || process.env.NTWINE_CODEX_NATIVE_LISTEN === "true"
const RECORD_DIR = NATIVE ? "codex-app-server-native" : "codex-app-server"
let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-verify-codex-")))
const home = join(root, "home")
mkdirSync(join(home, ".ntwine"), { recursive: true })
// A THROWAWAY project dir, never the operator's checkout: launch ownership is held per project dir,
// and the live ntwine server already owns the real one. The codex worker runs here too, so nothing it
// does can touch real work.
const PROJECT_DIR = join(root, "project")
mkdirSync(PROJECT_DIR, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: PROJECT_DIR })
writeFileSync(join(PROJECT_DIR, "README.md"), "# verify fixture\n")
let child
let release
const stateDir = join(root, "state")
mkdirSync(stateDir, { recursive: true })

const api = createRpcClient(`http://127.0.0.1:${PORT}/`)

try {
  log("building a real artifact from the current checkout…")
  const artifact = buildNtwineArtifact(SOURCE, join(root, "artifacts"))
  log("artifact", artifact.digest)

  // 1. The packaging invariant: every detached daemon is a real, loadable file in the artifact.
  for (const entry of DETACHED_DAEMON_ENTRIES) {
    const emitted = join(artifact.runtimeDir, "src", detachedDaemonOutputName(entry))
    check(existsSync(emitted), `artifact ships ${detachedDaemonOutputName(entry)}`, emitted)
  }

  // 2. Boot the real ntwine server FROM the artifact.
  const projectId = randomUUID()
  const target = { projectId, projectDir: PROJECT_DIR, stateDir }
  const owner = acquireProjectLaunchOwner(target, "launcher")
  release = owner.release
  let output = ""
  child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
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
        NTWINE_SANDBOX_TAG: `ntwine-verify-${PORT}-${process.pid}`,
        NTWINE_STABLE_ARTIFACT: artifact.digest,
        NTWINE_STABLE_WEB_DIST: artifact.webDir,
        NTWINE_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
        NTWINE_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
      },
      target,
      owner.token,
    ),
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (c) => { output += c })
  child.stderr.on("data", (c) => { output += c })

  const healthy = await api.waitForHealth(30_000)
  check(healthy, "the artifact server booted and serves /health", `port ${PORT}`)
  if (!healthy) throw new Error(`server never came up:\n${output.slice(-4000)}`)

  // PRECONDITION, not a product assertion. These harnesses isolate HOME to a temp dir and inject
  // CODEX_HOME so the app-server can still authenticate. When that var does not reach the child the
  // lookup falls back to <tempHOME>/.codex, finds nothing, and dispatch fails with a bare
  // "AUTH_REQUIRED:codex" 500 that reads like a product bug. Say what it actually is. (A real user's
  // HOME is their own, so this fallback finds their real ~/.codex — the hazard is harness-only.)
  const auth = await api.query("authStatus").catch((e) => ({ error: e.message }))
  if (auth?.codex !== "authed") {
    throw new Error(`HARNESS ENV: the server cannot see codex credentials (authStatus=${JSON.stringify(auth)}). CODEX_HOME did not reach it; re-run.`)
  }


  // 3. Dispatch a REAL codex thread through the artifact — this is what forks the daemon.
  log("dispatching a real codex thread…")
  const dispatched = await api.mutate("dispatch", {
    title: "artifact daemon smoke",
    prompt: "Reply with exactly the word READY and nothing else. Do not use any tools.",
    backend: "codex",
  })
  check(!!dispatched?.slug, "codex dispatch succeeded through the bundled artifact", JSON.stringify(dispatched).slice(0, 400))
  const { slug, sessionId } = dispatched

  // The on-disk record proves a DETACHED host really started, not the in-process fallback.
  const recordDir = join(stateDir, RECORD_DIR)
  let records = []
  for (let i = 0; i < 80; i++) {
    records = existsSync(recordDir) ? readdirSync(recordDir) : []
    if (records.length) break
    await sleep(250)
  }
  check(records.length > 0, `the DETACHED ${NATIVE ? "native listener" : "daemon"} started and published its record`, `${recordDir} → ${records.join(",") || "(empty)"}`)

  // An ntwine-created codex worker is headless: it must launch at danger-full-access, because a
  // restrictive sandbox just stalls an unattended worker on a modal nobody is watching.
  const stored = execFileSync("sqlite3", [
    join(stateDir, "ui.db"),
    `SELECT permission_mode FROM session WHERE slug = '${slug}';`,
  ], { encoding: "utf8" }).trim()
  check(stored === "bypassPermissions", "a fresh codex dispatch stores full access, not workspace-write", `permission_mode=${stored || "(null)"}`)
  check(!/exited before it became ready/.test(output), "server output is free of 'daemon exited before it became ready'")
  check(!/falling back to an in-process app-server/.test(output), "the daemon path was used (no fallback)")

  const threadOnBoard = async () => (await api.query("board"))?.threads?.find((t) => t.id === slug)
  const waitForRuntime = async (want, ms) => {
    for (let i = 0; i < Math.ceil(ms / 500); i++) {
      const t = await threadOnBoard()
      if (t && want(t.runtime)) return t
      await sleep(500)
    }
    return await threadOnBoard()
  }

  let thread = await waitForRuntime((r) => !!r, 20_000)
  check(!!thread, "the codex thread reached the board", thread ? `runtime=${thread.runtime} status=${thread.status}` : "missing")

  // 4a. STEER an IN-FLIGHT turn — the operation the operator watched fail.
  log("steering the in-flight turn… runtime =", thread?.runtime)
  let steerError = null
  await api.mutate("followUp", {
    slug, sessionId,
    message: "Ignore that. Reply with exactly the word STEERED instead.",
    deliveryId: randomUUID(),
  }).catch((e) => { steerError = e.message })
  check(steerError === null, "steer of the in-flight turn was accepted", steerError ?? "")

  // 4b. FOLLOW UP once the turn has rested — the other half of the same button.
  log("waiting for the turn to rest, then following up…")
  thread = await waitForRuntime((r) => r !== "running" && r !== "spawning", 90_000)
  log("runtime at rest:", thread?.runtime)
  let followError = null
  await api.mutate("followUp", {
    slug, sessionId,
    message: "Now reply with exactly the word AGAIN.",
    deliveryId: randomUUID(),
  }).catch((e) => { followError = e.message })
  check(followError === null, "follow-up on the rested thread was accepted", followError ?? "")

  console.log("\n--- server output tail ---")
  console.log(output.slice(-3000))
} catch (error) {
  check(false, "harness completed without throwing", String(error?.stack ?? error?.message ?? error))
} finally {
  if (child?.pid) { try { process.kill(child.pid, "SIGTERM") } catch {} }
  await sleep(2500)
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL") } catch {} }
  try { release?.() } catch {}
  // Kill only the daemon THIS run forked, read from its own record — never a broad pkill, which
  // would take out other agents' servers on this machine.
  try {
    const dir = join(stateDir, RECORD_DIR)
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const rec = JSON.parse(readFileSync(join(dir, file), "utf8"))
      for (const pid of [rec.childPid, rec.daemonPid, rec.listenerPid]) { if (pid) { try { process.kill(pid, "SIGKILL") } catch {} } }
    }
  } catch {}
  rmSync(root, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
