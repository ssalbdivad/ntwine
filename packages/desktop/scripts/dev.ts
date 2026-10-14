// `nub run desktop`: the Electron window onto the dev board, rebuilt and relaunched on every edit to
// this package.
//
// Two reload loops, and they never overlap. The BOARD hot-reloads itself — the window shows the page
// `nub run dev` serves, so Vite HMR and the dev supervisor's control-plane recycles reach it exactly as
// they reach a browser tab, and this script has nothing to do with them. The SHELL (main.ts, preload.ts
// and what they import) is bundled here with esbuild in watch mode, and a rebuild restarts Electron,
// because a main process cannot be swapped in place. The window reopens where it was (main.ts keeps
// its bounds and path).
//
// Bundled rather than run as TypeScript because Electron's own Node does not strip types, and main.ts
// reads the server owner record through the launcher's module (src/server-owner.ts). The preload is
// CommonJS because a sandboxed preload cannot be an ES module.
//
// On WSL it runs the WINDOWS build of Electron, natively, rather than the Linux one through WSLg
// (scripts/windows.ts); `--wslg` runs the Linux one there instead.
//
// Pass `--url=http://127.0.0.1:<port>` to show a particular board (NTWINE_DESKTOP_URL); without it the
// window joins whichever board of ours answers (server.ts). Extra arguments go to Electron.
import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { context, type BuildOptions, type Plugin } from "esbuild"
import { locateServer } from "../src/server.ts"
import { isWsl, prepareWindowsElectron } from "./windows.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(pkg, "dist")
// The `electron` package's main export is the path of its binary, which it downloads on first use
// (no install script runs: the workspace trusts none for it).
const electronBinary = createRequire(import.meta.url)("electron") as string

const urlFlag = process.argv.find((arg) => arg.startsWith("--url="))
const pinnedUrl = urlFlag?.slice("--url=".length)
const onWindows = isWsl() && !process.argv.includes("--wslg")
// `nub run desktop -- …` passes its own `--` through, and Electron would read everything after it as
// app arguments rather than Chromium switches.
const electronArgs = process.argv.slice(2).filter((arg) => arg !== urlFlag && arg !== "--" && arg !== "--wslg")
const env: NodeJS.ProcessEnv = { ...process.env, ...(pinnedUrl ? { NTWINE_DESKTOP_URL: pinnedUrl } : {}) }
// Set by `electron` when run from a terminal that is itself inside an Electron app (VS Code's); with it,
// the binary runs as plain Node and no window ever opens.
delete env.ELECTRON_RUN_AS_NODE

const windows = onWindows ? await prepareWindowsElectron() : undefined
// A Windows Electron cannot search for the board (the owner records are in the Linux home), so it is
// found here, once, and pinned. Nothing up yet means the default port: the window waits for it.
const windowsUrl = windows ? pinnedUrl ?? await locateServer() ?? "http://127.0.0.1:9393" : undefined
if (windowsUrl) console.log(`[desktop] Windows Electron onto ${windowsUrl}`)

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
// The window icon on Linux.
copyFileSync(join(pkg, "..", "web", "public", "icon-512.png"), join(dist, "icon.png"))

let electron: ChildProcess | undefined
let quitting = false
let pendingRestart: NodeJS.Timeout | undefined

function launch(): void {
  const child = windows
    ? windows.start(dist, [`--ntwine-url=${windowsUrl}`, ...electronArgs])
    : spawn(electronBinary, [pkg, ...electronArgs], { env, stdio: "inherit" })
  electron = child
  child.on("exit", (code, signal) => {
    if (electron !== child) return
    electron = undefined
    // Closing the window ends the loop, as closing a dev server's tab does not — there is nothing left
    // to show the rebuild in.
    if (!quitting) {
      console.log(`[desktop] Electron exited (${signal ?? code}); stopping the watcher`)
      void shutdown()
    }
  })
}

function restart(): void {
  const previous = electron
  if (!previous) return launch()
  electron = undefined
  previous.once("exit", launch)
  void stop(previous)
}

async function stop(child: ChildProcess): Promise<void> {
  if (windows) await windows.stop(child)
  else child.kill("SIGTERM")
}

/** Both bundles report through this; the first build launches, every later one restarts once. */
let builds = 0
const relaunchOnRebuild: Plugin = {
  name: "relaunch",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return console.error("[desktop] build failed; keeping the running window")
      builds += 1
      if (builds < 2) return
      clearTimeout(pendingRestart)
      pendingRestart = setTimeout(() => {
        if (builds === 2) launch()
        else {
          console.log("[desktop] shell rebuilt; restarting Electron")
          restart()
        }
      }, 50)
    })
  },
}

const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron"],
  absWorkingDir: pkg,
  logLevel: "warning",
  sourcemap: "inline",
  plugins: [relaunchOnRebuild],
}
const main = await context({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: join(dist, "main.mjs"),
  format: "esm",
  banner: { js: 'import { createRequire as __ntwineCreateRequire } from "node:module"; const require = __ntwineCreateRequire(import.meta.url);' },
})
const preload = await context({ ...shared, entryPoints: ["src/preload.ts"], outfile: join(dist, "preload.cjs"), format: "cjs" })
await Promise.all([main.watch(), preload.watch()])

async function shutdown(): Promise<void> {
  quitting = true
  clearTimeout(pendingRestart)
  if (electron) await stop(electron)
  await Promise.all([main.dispose(), preload.dispose()])
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
