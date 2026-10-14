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
// - The board: it is found on the Linux side (owner records live in the Linux home) and handed over as
//   `--ntwine-url=`, since no Linux environment variable crosses into a Windows process unless named in
//   WSLENV.
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

const toWindowsPath = (path: string) => execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim()
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
  const root = join(toLinuxPath(windowsVariable("LOCALAPPDATA")), "Ntwine", "desktop-dev")
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
  const pidFiles = new Map<ChildProcess, string>()
  let launches = 0
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "ntwine-desktop-dev", productName: "Ntwine", main: "main.mjs" }))

  return {
    root,
    start(dist, args) {
      for (const file of ["main.mjs", "preload.cjs", "icon.ico"]) copyFileSync(join(dist, file), join(appDir, file))
      const pidFile = join(root, `electron-${process.pid}-${++launches}.pid`)
      const child = spawn(exe, [toWindowsPath(appDir), `--ntwine-pid-file=${toWindowsPath(pidFile)}`, ...args], { cwd: root, stdio: "inherit" })
      pidFiles.set(child, pidFile)
      child.once("exit", () => {
        pidFiles.delete(child)
        rmSync(pidFile, { force: true })
      })
      return child
    },
    async stop(child) {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      // The pid is written once the app is ready; a stop that races a launch waits for it briefly.
      const pidFile = pidFiles.get(child)!
      let pid: string | undefined
      for (let i = 0; i < 50 && !pid; i++) {
        pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : undefined
        if (!pid) await delay(100)
      }
      if (!pid) {
        child.kill("SIGTERM")
        return exited
      }
      const taskkill = (...flags: string[]) => {
        try {
          execFileSync("taskkill.exe", ["/PID", pid!, "/T", ...flags], { cwd: root, stdio: "ignore" })
        } catch {
          // Already gone, or (without /F) a process that does not take WM_CLOSE.
        }
      }
      taskkill()
      if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return
      taskkill("/F")
      return exited
    },
  }
}
