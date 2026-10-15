import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Starting ntwine when the window finds none running, so a window pinned to the taskbar is one click
 * after a reboot. scripts/dev.ts writes everything this needs into dist/server.json, since the app copy
 * a Windows Electron runs from (%LOCALAPPDATA%) has no other way to know it.
 *
 * What it starts is this checkout's launcher, `ntwine-dev --no-app` (src/index.ts): the stable board,
 * the one a published `ntwine` would run, which finds or builds a verified artifact and records itself
 * in the server owner record the window's search reads. Not `nub run dev`: that board belongs to a
 * terminal, where its keys, its log and its ctrl-c are, and a window that started one would hide all
 * three. The board outlives the window, as one started from a terminal outlives a tab.
 */
export interface ServerLaunch {
  repo: string
  /** nub, absolute. */
  nub: string
  /**
   * The PATH of the terminal that ran `nub run desktop`. A Windows launch reaches WSL through a
   * non-interactive shell, which has no nvm on its PATH; and every agent the board starts inherits it.
   */
  path: string
  /** Where the board's output goes, in the Linux filesystem. */
  log: string
  /** Set when the window runs on Windows and ntwine in this WSL distro. */
  distro?: string
  /**
   * The Linux data and state roots as `\\wsl.localhost` paths, set with `distro`: a Windows window
   * searches through them, since the owner records that prove a board is ours live in the Linux home.
   */
  roots?: { data: string; state: string }
}

export function readServerLaunch(path: string): ServerLaunch | undefined {
  try {
    const launch = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerLaunch>
    if (typeof launch.repo !== "string" || typeof launch.nub !== "string" || typeof launch.path !== "string" || typeof launch.log !== "string") return undefined
    if (launch.distro !== undefined && (typeof launch.roots?.data !== "string" || typeof launch.roots.state !== "string")) return undefined
    return launch as ServerLaunch
  } catch {
    return undefined
  }
}

/**
 * The command: `ntwine-dev --no-app` in the repo, on the recorded PATH, its output appended to the log.
 * NTWINE_SOURCE_COMMAND is what the `ntwine-dev` shim sets, so the launcher names itself that way.
 */
export function serverCommand(launch: ServerLaunch): [command: string, args: string[]] {
  const shell = [
    "sh",
    "-c",
    'export PATH="$1" NTWINE_SOURCE_COMMAND=ntwine-dev && mkdir -p "$(dirname "$2")" && log="$2" && shift 2 && exec "$@" >> "$log" 2>&1 </dev/null',
    "sh",
    launch.path,
    launch.log,
    launch.nub,
    "--no-env-file",
    "src/index.ts",
    "--no-app",
  ]
  if (!launch.distro) return [shell[0]!, shell.slice(1)]
  // In a session of its own (spawn's `detached` is that on Linux, and reaches no further than wsl.exe
  // on Windows): when WSL ends the session of a wsl.exe that is killed, it signals everything in it, and
  // the launcher takes that as a stop. `-w` still waits, so a launch that fails is seen to.
  return ["wsl.exe", ["-d", launch.distro, "--cd", launch.repo, "--exec", ...shell.slice(0, 6), "setsid", "-w", ...shell.slice(6)]]
}

/** One argument as Windows' command-line parsing (CommandLineToArgvW) reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/u.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
}

/**
 * Start ntwine, calling `onFailed` if it stops before a board answers (or could not start at all).
 *
 * On Linux and macOS it is spawned detached, out of the window's process group.
 *
 * On Windows, libuv puts every attached child in a job that ends it with the window, and a detached
 * console program (wsl.exe) gets a console of its own, which Windows 11 shows as a Windows Terminal
 * window whatever windowsHide says. So a hidden, attached PowerShell starts wsl.exe with
 * `Start-Process -WindowStyle Hidden`: a grandchild leaves libuv's job silently, and a console created
 * hidden stays hidden. PowerShell then waits on it and exits with its code, so a failed start is seen;
 * PowerShell itself ends with the window, which the server does not.
 */
export function startServer(launch: ServerLaunch, onFailed: () => void): void {
  const [command, args] = serverCommand(launch)
  if (!launch.distro) {
    const child = spawn(command, args, { cwd: launch.repo, detached: true, stdio: "ignore" })
    child.on("error", onFailed)
    child.on("exit", onFailed)
    child.unref()
    return
  }
  const argumentList = args.map(quoteWindowsArg).join(" ").replaceAll("'", "''")
  // Reading Handle before the exit is what makes ExitCode readable after it.
  const script = `$p = Start-Process -FilePath ${command} -WindowStyle Hidden -PassThru -ArgumentList '${argumentList}'; $null = $p.Handle; $p.WaitForExit(); exit $p.ExitCode`
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "ignore", windowsHide: true },
  )
  child.on("error", onFailed)
  child.on("exit", onFailed)
}
