// End-to-end check of the desktop app's START path against the REAL published launcher: `npx -y frizz`
// resolves it from the npm registry, startServer runs it exactly as the app does, and a real
// frizz-server boots — all under a throwaway HOME, so nothing touches this machine's ~/.frizz.
//
//   nub packages/desktop/scripts/verify-start.ts [--keep] [--launcher=<path to a built frizz.js>]
//
// --launcher stands in only for the `npx -y frizz` lookup — use it to test an unreleased launcher
// (`node scripts/build-package.mjs --shell` writes dist/frizz.js); that launcher still installs the
// real frizz-server from npm. Needs the network (npm). Asserts, in order:
//   1. from an empty $HOME the launcher refuses to guess a project, and the app reads that as "ask for
//      a folder" (the real wording, not a copy of it);
//   2. from a fresh repository a real server starts, publishes its owner record, and serves the board;
//   3. the launcher is DETACHED — its own process group — so quitting the app cannot stop the server.
// Prints one JSON line. With --keep the server and sandbox are left up for the Electron check
// (verify-window.ts --home=<sandbox>); otherwise both are torn down.
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const keep = process.argv.includes("--keep")
const launcherOverride = process.argv.find((a) => a.startsWith("--launcher="))?.slice("--launcher=".length)
const home = mkdtempSync(join(tmpdir(), "frizz-desktop-verify-"))

// The sandbox must be HOME before frizz-paths resolves anything, and none of this worker's own FRIZZ_*
// or XDG_* variables may leak into the launcher it starts.
const env: NodeJS.ProcessEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  // nub's own runtime hooks (NODE_OPTIONS and its __NUB_* bookkeeping) are this harness's, not a
  // user's: a Dock-launched app hands the launcher a login shell's environment, which has neither.
  if (key.startsWith("FRIZZ_") || key.startsWith("XDG_") || key.startsWith("npm_") || key.startsWith("__NUB") || key === "NODE_OPTIONS" || key === "NODE_PATH") continue
  env[key] = value
}
env.HOME = home
// A disposable server must not reap this machine's worker processes, wake anything, or prime boards.
env.FRIZZ_ORPHAN_REAPER_OFF = "1"
env.FRIZZ_WAKERS_OFF = "1"
env.FRIZZ_TENANT_PRIME_OFF = "1"
// What a user's shell would have: no repo-local node_modules/.bin, no worker plugin bin.
env.PATH = (env.PATH ?? "").split(":").filter((dir) => !dir.includes("node_modules/.bin") && !dir.includes("cc-worker")).join(":")
if (launcherOverride) {
  const bin = join(home, "npx-shim")
  mkdirSync(bin)
  writeFileSync(join(bin, "npx"), `#!/bin/sh\n[ "$3" = "--_frizz-print-launcher" ] && echo "${launcherOverride}"\n`)
  chmodSync(join(bin, "npx"), 0o755)
  env.PATH = `${bin}:${env.PATH}`
}
for (const key of Object.keys(process.env)) if (key.startsWith("XDG_")) delete process.env[key]
process.env.HOME = home

const { startServer, frizzAnswers, loopbackOrigin } = await import("../src/server.ts")
const { readStableServerOwner } = await import("../../../src/server-owner.ts")

/** The record only — never the well-known ports, where this machine's own board may be answering. */
async function recordOnly(): Promise<string | "starting" | undefined> {
  const owner = readStableServerOwner()
  if (owner.kind === "running" && (await frizzAnswers(owner.port))) return loopbackOrigin(owner.port)
  return owner.kind === "idle" ? undefined : "starting"
}

function fail(message: string): never {
  console.error(`verify-start: FAIL — ${message}`)
  if (!keep) rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const progress: string[] = []
const fromHome = await startServer({ env, cwd: home, logPath: join(home, "logs", "home.log"), locate: recordOnly, onProgress: (l) => progress.push(l) })
if (fromHome.kind !== "failed" || !fromHome.needsProject) fail(`expected a project-folder request from $HOME, got ${JSON.stringify(fromHome)}`)

const repo = join(home, "demo-project")
mkdirSync(repo)
writeFileSync(join(repo, "README.md"), "# demo\n")
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" })
git("init", "-q")
git("-c", "user.name=verify", "-c", "user.email=verify@example.com", "commit", "-q", "--allow-empty", "-m", "init")

const started = await startServer({ env, cwd: repo, logPath: join(home, "logs", "repo.log"), locate: recordOnly, onProgress: (l) => progress.push(l) })
if (started.kind !== "ready") fail(`the server did not start: ${JSON.stringify(started)}`)

const owner = readStableServerOwner()
if (owner.kind !== "running") fail(`no running owner record after start: ${owner.kind}`)
const page = await fetch(`${started.origin}/`)
const html = await page.text()
if (!page.ok || !html.includes('id="root"')) fail(`the board page did not serve: ${page.status}`)
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(owner.owner.pid)], { encoding: "utf8" }).trim())
if (pgid !== owner.owner.pid) fail(`launcher pid ${owner.owner.pid} is in process group ${pgid}, not its own`)

console.log(JSON.stringify({
  ok: true,
  home,
  origin: started.origin,
  launcherPid: owner.owner.pid,
  homeRefusal: fromHome.message,
  progress: [...new Set(progress)],
}))

if (!keep) {
  process.kill(-owner.owner.pid, "SIGTERM")
  for (let i = 0; i < 100 && (await frizzAnswers(owner.port, 300)); i++) await new Promise((r) => setTimeout(r, 100))
  rmSync(home, { recursive: true, force: true })
}
