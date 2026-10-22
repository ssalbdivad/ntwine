// The Windows half of `nub run desktop` on WSL: a native Windows Electron, driven from Linux.
//
// Under WSL the Linux Electron renders through WSLg — a Wayland window in a remote-desktop surface, with
// its own fonts, scaling, clipboard bridge and no real taskbar entry. The Windows build of the SAME
// Electron version runs natively instead, and still reaches the board, because WSL forwards Windows'
// loopback into the distro (NAT mode's localhostForwarding, on by default; mirrored mode shares it).
//
// What that takes, each because a Windows process cannot see what a Linux one can:
// - The binary: `@electron/get` (the `electron` package's own downloader) fetches the win32-x64 zip,
//   checked against the package's checksums.json, into a folder under %LOCALAPPDATA%, and Windows'
//   tar.exe unpacks it there (native, where unpacking ~300MB over the 9p mount is slow).
// - The app: Electron is pointed at a COPY of dist/ on the Windows disk, refreshed before every launch.
//   It could load the bundle through \\wsl.localhost, but a UNC app path is slow and an odd origin for
//   the preload, and the copy is two files.
// - The board: the app searches the Linux home through \\wsl.localhost, where the owner records are,
//   and starts ntwine in the distro when none answers. Both come from the server.json the app copy
//   carries (src/launch.ts), since no Linux environment variable crosses into a Windows process unless
//   named in WSLENV; so does `--url=`, handed over as `--ntwine-url=`.
// - Stopping it: signalling the WSL interop proxy does not end the Windows process, so the app writes
//   its pid to `--ntwine-pid-file=` and this kills it with taskkill.exe — politely first (WM_CLOSE, so
//   the window saves where it was), then by force.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export function isWsl(): boolean {
  return process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")
}

export const toWindowsPath = (path: string) => execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim()
const toLinuxPath = (path: string) => execFileSync("wslpath", ["-u", path], { encoding: "utf8" }).trim()

/** A Windows environment variable, read through cmd.exe (cwd on the Windows disk, or cmd warns about UNC). */
function windowsVariable(name: string): string {
  const value = execFileSync("cmd.exe", ["/d", "/c", `echo %${name}%`], { cwd: "/mnt/c", encoding: "utf8" }).trim()
  if (!value || value === `%${name}%`) throw new Error(`Windows has no %${name}%`)
  return value
}

export interface WindowsElectron {
  /** The folder under %LOCALAPPDATA% holding the binary and the app copy, as a Linux path. */
  root: string
  start(dist: string, args: string[]): ChildProcess
  stop(child: ChildProcess): Promise<void>
}

export async function prepareWindowsElectron(): Promise<WindowsElectron> {
  // The `electron` package pins the version and carries the checksums; its downloader is its own dependency.
  const electronRequire = createRequire(createRequire(import.meta.url).resolve("electron/package.json"))
  const { version } = electronRequire("./package.json") as { version: string }
  const root = join(toLinuxPath(windowsVariable("LOCALAPPDATA")), "ntwine", "desktop-dev")
  const binaryDir = join(root, `electron-v${version}-win32-x64`)
  const exe = join(binaryDir, "electron.exe")
  if (!existsSync(exe)) {
    console.log(`[desktop] fetching Windows Electron ${version} into ${toWindowsPath(root)}`)
    mkdirSync(root, { recursive: true })
    const { downloadArtifact } = electronRequire("@electron/get") as {
      downloadArtifact(options: { version: string; artifactName: string; platform: string; arch: string; cacheRoot: string; checksums: Record<string, string> }): Promise<string>
    }
    const zip = await downloadArtifact({
      version,
      artifactName: "electron",
      platform: "win32",
      arch: "x64",
      cacheRoot: join(root, "cache"),
      checksums: electronRequire("./checksums.json") as Record<string, string>,
    })
    const unpacking = `${binaryDir}.partial`
    rmSync(unpacking, { recursive: true, force: true })
    mkdirSync(unpacking)
    execFileSync("tar.exe", ["-xf", toWindowsPath(zip), "-C", toWindowsPath(unpacking)], { cwd: root, stdio: "inherit" })
    // Whole or not at all: a download killed halfway must not pass the existsSync above next time.
    renameSync(unpacking, binaryDir)
  }

  const appDir = join(root, "app")
  // One pid file per launch, never one per folder: a second loop on the same folder must not clear or
  // overwrite the file the first needs to stop its own window.
  const pids = new Map<ChildProcess, Promise<string | undefined>>()
  let launches = 0
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "ntwine-desktop-dev", productName: "ntwine", main: "main.mjs" }))

  return {
    root,
    start(dist, args) {
      for (const file of ["main.mjs", "preload.cjs", "icon.ico"]) copyFileSync(join(dist, file), join(appDir, file))
      // How the app starts ntwine, and finds it, from Windows (src/launch.ts). A launch that could not
      // write one (no nub or WSL_DISTRO_NAME in its environment, as in an agent's sandbox) keeps the one
      // already here rather than deleting it: this folder is also what a taskbar pin opens, and without
      // the record that window can neither find the board nor start it (2026-10-22: a staging run on
      // 2026-10-21 deleted it, and the pinned window sat on "No board is running" beside a live board).
      if (existsSync(join(dist, "server.json"))) copyFileSync(join(dist, "server.json"), join(appDir, "server.json"))
      const pidFile = join(root, `electron-${process.pid}-${++launches}.pid`)
      const child = spawn(exe, [toWindowsPath(appDir), `--ntwine-pid-file=${toWindowsPath(pidFile)}`, ...args], { cwd: root, stdio: "inherit" })
      const running = () => child.exitCode === null && child.signalCode === null
      // The pid is written once the app is ready.
      const pid = (async () => {
        while (running()) {
          const written = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : ""
          if (written) return written
          await delay(100)
        }
        return undefined
      })()
      pids.set(child, pid)
      // The interop proxy that stands for the window here outlives it whenever the server it started
      // is running: Windows hands that detached wsl.exe Electron's inheritable stdio, and the proxy
      // exits only once the last copy closes. So the window's own process is watched, and the proxy
      // ended with it — or a restart would wait forever for an exit, and closing the window would not
      // end this loop.
      void pid.then((id) => {
        if (!id || !running()) return
        const watch = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Wait-Process -Id ${id}`], { cwd: root, stdio: "ignore" })
        watch.once("exit", () => { if (running()) child.kill("SIGKILL") })
        child.once("exit", () => watch.kill())
      })
      child.once("exit", () => {
        pids.delete(child)
        rmSync(pidFile, { force: true })
      })
      return child
    },
    async stop(child) {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      // A stop that races a launch waits for the pid briefly.
      const pid = await Promise.race([pids.get(child)!, delay(5_000).then(() => undefined)])
      if (!pid) {
        child.kill("SIGTERM")
        return exited
      }
      const taskkill = (...flags: string[]) => {
        try {
          execFileSync("taskkill.exe", ["/PID", pid, ...flags], { cwd: root, stdio: "ignore" })
        } catch {
          // Already gone, or (without /F) a process that does not take WM_CLOSE.
        }
      }
      // The polite close goes to the main process alone: with /T, taskkill refuses a parent whose
      // children are still running, and Chromium's GPU and utility processes take only /F, so every
      // stop was a force-kill and the window never saved where it was.
      taskkill()
      if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return
      taskkill("/T", "/F")
      return exited
    },
  }
}
