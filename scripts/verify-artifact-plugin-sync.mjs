// END-TO-END proof, ON A BUILT ARTIFACT, that an update reaches a worker that is already running.
//
// The pieces are each proved elsewhere: `_live_plugin_sync.mts` shows real claude re-reading a plugin
// that moved, and the broker tests show the daemon asking for it between turns. What neither can see
// is the seam between them, and that seam only exists in an artifact launch: the launcher names an
// immutable plugin directory (FRIZZ_WORKER_PLUGIN_DIR), the server stages it and hands the daemon the
// STABLE path instead, the daemon is the BUNDLED detached entry rather than a source file, and the
// "update" is a second server process booting with a different directory while the first server's
// worker lives on. A source-run stack takes none of those branches.
//
// So this builds a real artifact, boots the real server from it, dispatches a Claude thread, then
// replaces the server with one launched against a newer plugin and sends the thread a follow-up.
// The worker must have been launched against the stable path, must survive, and must re-read its
// plugin before the follow-up reaches it.
//
// The Claude CLI is the protocol stand-in the SDK contract tests use (FRIZZ_CLAUDE_BIN): it records
// its own argv and every control request and input it receives, which is exactly the evidence wanted
// here, and it needs no credential — so this runs under a temp HOME, where real claude cannot sign in.
//
// Isolation: temp HOME + state dir + project dir, unique port, wakers and reaper off.
//
//   nub scripts/verify-artifact-plugin-sync.mjs
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFrizzArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const SOURCE = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.VERIFY_PORT ?? 4947)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[plugin-sync]", ...a)
let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }

const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-plugin-sync-")))
const home = join(root, "home")
const stateDir = join(root, "state")
const PROJECT_DIR = join(root, "project")
// `<home>/.frizz` existing makes it the legacy root, so the cache this server stages under is
// `<home>/.frizz` — nothing here can reach the machine's real stable path.
for (const d of [join(home, ".frizz"), stateDir, PROJECT_DIR, join(root, "bin")]) mkdirSync(d, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: PROJECT_DIR })
writeFileSync(join(PROJECT_DIR, "README.md"), "# plugin sync fixture\n")
const stablePath = join(home, ".frizz", "current", "cc-worker")

// The stand-in CLI names its scenario in its file name and writes `capture.jsonl` beside itself.
const fakeClaude = join(root, "bin", "fake-claude--basic.mjs")
copyFileSync(join(SOURCE, "packages/server/src/backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs"), fakeClaude)
chmodSync(fakeClaude, 0o700)
const captured = () => {
  const path = join(root, "bin", "capture.jsonl")
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
}
const capturedWhen = async (predicate, ms = 30_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const rows = captured()
    if (predicate(rows) || Date.now() > deadline) return rows
    await sleep(250)
  }
}

const api = createRpcClient(`http://127.0.0.1:${PORT}/`)
const servers = []
let release
let daemonPid

function bootServer(artifact, pluginDir, target, token, label) {
  let output = ""
  const env = { ...process.env }
  // This harness is usually run BY a Frizz worker, whose own identity must not reach the server it boots.
  for (const key of ["FRIZZ_THREAD", "FRIZZ_PERM_DIR", "FRIZZ_PLUGIN_SYNC_OFF", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NODE_COMPAT"]) delete env[key]
  const child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
    cwd: PROJECT_DIR,
    env: projectLaunchEnvironment(
      {
        ...env,
        HOME: home,
        FRIZZ_DEV_CHILD: "1",
        FRIZZ_DEV_PORT: String(PORT),
        FRIZZ_WAKERS_OFF: "1",
        FRIZZ_ORPHAN_REAPER_OFF: "1",
        FRIZZ_SANDBOX_TAG: `frizz-plugin-sync-${PORT}-${process.pid}`,
        FRIZZ_RUNTIMES: "path",
        FRIZZ_CLAUDE_BIN: fakeClaude,
        FRIZZ_STABLE_ARTIFACT: artifact.digest,
        FRIZZ_STABLE_WEB_DIST: artifact.webDir,
        FRIZZ_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
        // What the launcher names: an immutable, version-specific directory.
        FRIZZ_WORKER_PLUGIN_DIR: pluginDir,
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

const brokerRecord = () => {
  const dir = join(stateDir, "claude-broker")
  const file = existsSync(dir) ? readdirSync(dir).find((name) => /^[0-9a-f]{16}\.json$/.test(name)) : undefined
  return file ? JSON.parse(readFileSync(join(dir, file), "utf8")) : null
}

try {
  log("building a real artifact…")
  const artifact = buildFrizzArtifact(SOURCE, join(root, "artifacts"))
  log("artifact", artifact.digest)
  const generationOne = join(artifact.runtimeDir, "cc-worker")
  // The next version's plugin: the same closure with one more skill, at its own immutable path.
  const generationTwo = join(root, "generation-2", "runtime", "cc-worker")
  cpSync(generationOne, generationTwo, { recursive: true })
  mkdirSync(join(generationTwo, "skills", "added-by-the-update"), { recursive: true })
  writeFileSync(join(generationTwo, "skills", "added-by-the-update", "SKILL.md"), "---\nname: added-by-the-update\ndescription: Exists only in the second generation.\n---\n")

  const target = { projectId: randomUUID(), projectDir: PROJECT_DIR, stateDir }
  const owner = acquireProjectLaunchOwner(target, "launcher")
  release = owner.release

  // ---- the first version boots, and a worker starts under it -----------------------------------
  const first = bootServer(artifact, generationOne, target, owner.token, "first")
  check(await api.waitForHealth(40_000), "the artifact server booted", `port ${PORT}`)
  check(existsSync(stablePath) && lstatSync(stablePath).isSymbolicLink(), "booting published the plugin at the stable path", stablePath)
  const stagedOne = existsSync(stablePath) ? realpathSync(stablePath) : ""
  check(stagedOne.startsWith(join(realpathSync(home), ".frizz", "plugins")) && !existsSync(join(stagedOne, "skills", "added-by-the-update")),
    "and it leads to a staged copy of the first generation", stagedOne)

  log("dispatching a claude thread…")
  const { slug, sessionId } = await api.mutate("dispatch", { title: "plugin sync", prompt: "first turn" })
  check(!!slug, "claude dispatch succeeded through the bundled artifact", `${slug} / ${sessionId}`)
  let rows = await capturedWhen((r) => r.some((row) => row.kind === "user-input"))
  // Both spellings: the SDK passes `--flag value` or `--flag=value` depending on its version.
  const argv = rows.find((row) => row.kind === "startup")?.argv ?? []
  const pluginArg = argv.includes("--plugin-dir")
    ? argv[argv.indexOf("--plugin-dir") + 1]
    : argv.find((arg) => arg.startsWith("--plugin-dir="))?.slice("--plugin-dir=".length)
  check(pluginArg === stablePath, "the worker was launched against the STABLE path, not the generation's own directory", `--plugin-dir ${pluginArg}`)
  daemonPid = brokerRecord()?.daemonPid
  check(!!daemonPid && alive(daemonPid), "the bundled broker daemon is running", `daemonPid=${daemonPid}`)
  await sleep(1_000) // let the first turn's result land before the server goes away

  // ---- the update: a server launched against the next generation takes over --------------------
  log("replacing the server with one launched against the second generation…")
  process.kill(first.child.pid, "SIGKILL")
  await sleep(2_000)
  check(alive(daemonPid), "the worker's daemon outlived the server that started it")
  const second = bootServer(artifact, generationTwo, target, owner.token, "second")
  check(await api.waitForHealth(40_000), "the second server booted against the same state")
  const stagedTwo = realpathSync(stablePath)
  check(stagedTwo !== stagedOne && existsSync(join(stagedTwo, "skills", "added-by-the-update")),
    "its boot repointed the stable path at the second generation's plugin", stagedTwo)
  check(captured().filter((row) => row.kind === "host-control" && row.subtype === "reload_plugins").length === 0,
    "nothing has asked the idle worker to reload yet")

  // ---- and the running worker follows, with nobody asking it to --------------------------------
  await api.mutate("followUp", { slug, sessionId, message: "second turn" })
  rows = await capturedWhen((r) => r.filter((row) => row.kind === "user-input").length >= 2)
  const order = rows
    .filter((row) => row.kind === "user-input" || (row.kind === "host-control" && row.subtype === "reload_plugins"))
    .map((row) => row.kind === "user-input" ? row.text.replace(/[\s\S]*(first turn|second turn)[\s\S]*/, "$1") : "reload")
  check(JSON.stringify(order) === JSON.stringify(["first turn", "reload", "second turn"]),
    "the worker re-read its plugin between the turns, ahead of the follow-up", JSON.stringify(order))
  check(brokerRecord()?.daemonPid === daemonPid && alive(daemonPid), "in the same process it has been in all along", `daemonPid=${daemonPid}`)
  check(rows.filter((row) => row.kind === "startup").length === 1, "and the CLI was started exactly once")
  check(!/exited before it became ready/.test(first.out() + second.out()), "no daemon failure in either server's output")
} catch (error) {
  check(false, "harness completed without throwing", String(error?.stack ?? error?.message ?? error))
} finally {
  for (const child of servers) { if (child?.pid) { try { process.kill(child.pid, "SIGKILL") } catch {} } }
  try { release?.() } catch {}
  // Only the pid THIS run created, read from its own record. Never a broad pkill — other agents'
  // servers and daemons are running on this machine.
  const pid = daemonPid ?? brokerRecord()?.daemonPid
  if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
  await sleep(1_000)
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
