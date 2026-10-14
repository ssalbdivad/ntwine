// Disposable, fully-ISOLATED ntwine stack for ad hoc CDP / manual verification.
//
// Why this exists: verifying an ntwine change means driving the REAL app end-to-end, but you must never
// touch the maintainer's live instance or real ~/.ntwine SQLite. This boots a
// throwaway stack that is sandboxed on every axis:
//   • HOME              → a fresh temp dir, so the SQLite DB + server.lock live in an empty ~/.ntwine
//   • PORT              → a unique high port, so it never fights the dev server on 5175
//   • NTWINE_WAKERS_OFF=1 → scheduler OFF by default (no wake side effects); pass --wakers to arm it
// The project defaults to the ntwine repo itself (a gh-authed repo, an empty board under the temp HOME).
//
// Usage:
//   nub scripts/adhoc-stack.mjs [--port=4930] [--project=/abs/dir] [--claude-bin=/abs/bin] [--wakers] [--reaper] [--prime] [--keep] [--home=/abs] [--seed] [--log=/abs/server.log] [--dist]
//
// It prints ONE json line to stdout: {"url","port","home","project","log",…} once /health is green,
// then stays up until SIGINT/SIGTERM, deleting the temp HOME on exit (unless --keep). Run it with Bash
// run_in_background:true, parse that json line, then drive the url with Chrome DevTools MCP or shot.mjs.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ntwinePaths } from "../packages/server/src/ntwine-paths.ts"

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

const port = Number(opt("port", "4930"))
const projectDir = opt("project", process.cwd()) // default: the ntwine repo root
const claudeBin = opt("claude-bin", undefined)
// ONE ntwine serves N projects, so a whole class of bugs only exists in a project the server did NOT
// launch from — the tenant's board, its tailer, its scheduler, and the env its workers are spawned
// with. `--also-project=/abs/dir` (repeatable) registers extra projects so the stack has a launcher
// AND at least one tenant; each one's id + slug comes back in the json line, and a tenant is addressed
// as `/_ntwine/<id-or-slug>/rpc/…`. Without this you can only ever test the launching project, which is
// exactly the half that already works.
const alsoProjects = args.filter((a) => a.startsWith("--also-project=")).map((a) => a.slice("--also-project=".length))
// A DISPATCH needs real credentials, and a fresh sandbox HOME has none — the broker is the sole claude
// transport, so a worker under a credential-less HOME simply never starts. `--creds` symlinks the real
// `~/.claude*` into the sandbox; everything ntwine itself writes still lands in the throwaway `~/.ntwine`.
const creds = flag("creds")
// --home=/abs reuses a sandbox a previous `--keep` run left behind, which is the only way to verify
// anything that happens at BOOT against state that already exists — a schema migration, a registry
// repair, resume/recovery. Implies --keep: a HOME you were handed is never one this run may delete.
const reuseHome = opt("home", undefined)
const keep = flag("keep") || reuseHome !== undefined

// Sandbox HOME first — resolveProject() reads homedir() lazily, so setting it now redirects the whole
// state tree (~/.ntwine/projects/<id>/) into the throwaway dir before the server derives any path.
const home = reuseHome ?? mkdtempSync(join(tmpdir(), "ntwine-adhoc-home-"))
mkdirSync(join(home, ".ntwine"), { recursive: true })
const realHome = process.env.HOME
process.env.HOME = home
// The pinned Claude Code and Codex (runtimes.ts) live under the cache root, which the sandbox HOME
// just moved — so without this every stack would download both pins again. Point the sandbox at the
// machine's real copies; a stack that must exercise provisioning itself sets NTWINE_RUNTIMES_DIR.
if (!process.env.NTWINE_RUNTIMES && !process.env.NTWINE_RUNTIMES_DIR) {
  process.env.NTWINE_RUNTIMES_DIR = join(ntwinePaths({ home: realHome }).cache, "runtimes")
}
if (creds) {
  // The agent CLIs read their own credentials out of HOME. `.ntwine/builds` rides along so a stack that
  // promotes an artifact starts warm instead of rebuilding from cold.
  for (const name of [".claude", ".claude.json", ".codex", ".config"]) {
    try { symlinkSync(join(realHome, name), join(home, name)) } catch {}
  }
  // ACP agents keep their credentials under XDG data dirs (opencode: ~/.local/share/opencode/auth.json),
  // so a real `backend: "acp"` dispatch needs those too. Linked per agent, never the whole ~/.local.
  for (const name of [join(".local", "share", "opencode")]) {
    try { mkdirSync(join(home, dirname(name)), { recursive: true }); symlinkSync(join(realHome, name), join(home, name)) } catch {}
  }
  try { symlinkSync(join(realHome, ".ntwine", "builds"), join(home, ".ntwine", "builds")) } catch {}
}
if (!flag("wakers")) process.env.NTWINE_WAKERS_OFF = "1"
// A disposable stack must never reap the real machine's leaked worker processes (the orphan reaper
// enumerates ALL processes, not just this stack's). Off by default, exactly like the scheduler; pass
// --reaper to arm it when verifying the reaper itself.
if (!flag("reaper")) process.env.NTWINE_ORPHAN_REAPER_OFF = "1"
// The server OPENS every registered project a few seconds after boot, so the rail can badge them all
// (tenant-prime.ts). Harmless under a sandbox HOME — the registry there holds only this stack's
// projects — but `--home=$HOME` reuses the REAL registry, and priming would then put a second tailer
// on every one of the maintainer's live boards. Off by default for the same reason the reaper is; pass
// --prime when what you are verifying is the priming (a sandbox HOME, where it costs nothing).
if (!flag("prime")) process.env.NTWINE_TENANT_PRIME_OFF = "1"
// Its own Vite dependency cache: re-optimizing into the shared node_modules/.vite rewrote the deps
// under the maintainer's running `npm run dev`, and their open tab then loaded a second React (see
// packages/web/vite.config.ts). Relative to packages/web; shared by every throwaway stack.
process.env.NTWINE_VITE_CACHE_DIR ||= "node_modules/.vite-scratch"
process.chdir(projectDir)

// Optional: drop a tiny fixture note so the board isn't stone empty when eyeballing the shell. Off by
// default — most verification wants a known clean board and seeds its own rows through the RPC surface.
if (flag("seed")) {
  try {
    writeFileSync(join(home, ".ntwine", "ADHOC_SEED"), "adhoc stack seed marker\n")
  } catch {}
}

let close = async () => {}
const cleanup = () => {
  if (!keep) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
}
const stop = (code) => {
  void (async () => {
    try { await close() } catch {}
    cleanup()
    process.exit(code ?? 0)
  })()
}
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("uncaughtException", (e) => { console.error("[adhoc-stack] uncaught", e); stop(1) })

// The server's own log. `startServer` is the in-process half of a launch, and the launcher is the one
// that opens a run log — so a stack booted here logged NOWHERE: `ambientLogger()` invents no file for a
// process nobody configured, and every tailer, scheduler, broker and tenant record was dropped. The 37
// stack logs agents left in /tmp on 2026-10-01 held Vite's chatter and nothing of the server's. Now the
// full feed goes to `--log=/abs` (default: inside the sandbox HOME), the path rides in the json line,
// and every WARN/ERROR is mirrored to stderr — the stack.log a caller is already reading — since the
// server is meant to be silent there on a healthy board. NTWINE_LOG_FILE carries the file to anything
// the server forks, exactly as the real launcher's environment does.
const serverLog = opt("log", join(home, "ntwine-server.log"))
{
  const { createLogger, formatFeedLine, setAmbientLogger } = await import("../packages/server/src/logging.ts")
  const logger = setAmbientLogger(createLogger({ file: serverLog, owner: false }))
  process.env.NTWINE_LOG_FILE = serverLog
  logger.onRecord((record) => {
    if (record.level === "warn" || record.level === "error") process.stderr.write(`[ntwine] ${formatFeedLine(record)}\n`)
  })
}

const { startServer } = await import("../packages/server/src/index.ts")
try {
  // --dist serves the BUILT client (packages/web/dist — run `vite build` in packages/web first) instead of
  // Vite's dev middleware. Anything judged by load time — first paint, time to interactive — must use it:
  // in dev every module is transformed on request, which measures Vite, not Ntwine.
  const started = await startServer({ dev: !flag("dist"), port, installSignalHandlers: false, claudeBin })
  close = () => started.close()
  // Confirm the API is actually serving before announcing — a race here would hand CDP a dead port.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  // `url` is the launcher's DRAWER PREFIX on the one page — `/all/<slug>` — so `${url}/thread/<t>` is
  // that thread's drawer over Everything and `${url}/thread/<t>/full` its fullscreen page, which is how
  // every caller uses it. A bare `url` is not a page of its own: it redirects to `/`, Everything, which
  // is the right landing for a caller that only wants "the app".
  //
  // Until 2026-09-28 this announced the project's BOARD, `/project/<slug>`, because `/` was then the
  // all-projects grid and a `threads: N` assertion aimed there read 0 forever. The board and the grid
  // are both gone — Everything at `/` is the home — and `/project/…` landed on `/` until 2026-10-06, so a
  // caller appending `/thread/<t>` to the old shape silently got the home page instead of a thread. It is
  // the project's focused board again since then (`/project/<slug>/thread/<t>` opens that thread too), but
  // `url` stays the drawer prefix. `gridUrl` is kept for older callers, naming All projects — the
  // grid's successor — at `/all` since 2026-10-06, when `/` became a redirect to the browser's last view
  // (which need not be All projects for a browser that has chosen a board).
  const { findByPath, registerProject } = await import("../packages/server/src/project-registry.ts")
  const { resolveProject } = await import("../packages/server/src/project.ts")
  // The real launcher stamps the project it was run in as LAUNCHED (src/production.ts noteLaunchedHere),
  // which is what All projects' prompt box aims at when a browser has no pick of its own. This stack boots
  // the server without a launcher, so it stamps its own project the same way — BEFORE registering the
  // tenants, so they read as projects added after the launch, as `--also-project` means them.
  {
    const own = findByPath(projectDir, home)
    if (own) registerProject({ dir: own.path, id: own.id, launched: true }, home)
  }
  // Extra projects are registered AFTER boot, the way opening one in the grid does it — the server
  // activates a tenant lazily on the first `/_ntwine/<id-or-slug>/…` request, so nothing else is needed.
  const tenants = []
  for (const dir of alsoProjects) {
    try {
      process.chdir(dir)
      const project = resolveProject()
      registerProject({ dir: project.dir, id: project.id })
      tenants.push({ id: project.id, slug: findByPath(project.dir, home)?.slug, dir: project.dir, stateDir: project.stateDir })
    } catch (error) {
      console.error(`[adhoc-stack] could not register ${dir}:`, error instanceof Error ? error.message : error)
    } finally {
      process.chdir(projectDir)
    }
  }
  const launcher = findByPath(projectDir, home)
  const slug = launcher?.slug
  console.log(JSON.stringify({
    url: slug ? `http://127.0.0.1:${port}/all/${slug}` : `http://127.0.0.1:${port}/`,
    gridUrl: `http://127.0.0.1:${port}/`,
    slug, port, home, project: projectDir,
    log: serverLog,
    // The launcher is the project whose `server.lock` this process publishes — the one file every
    // worker on this stack, in ANY project, reads the port out of.
    launcher: launcher ? { id: launcher.id, slug: launcher.slug, dir: projectDir, serverLock: join(home, ".ntwine", "projects", launcher.id, "server.lock") } : undefined,
    tenants,
    wakers: flag("wakers"),
    creds,
  }))
} catch (error) {
  console.error("[adhoc-stack] boot failed:", error)
  cleanup()
  process.exit(1)
}
