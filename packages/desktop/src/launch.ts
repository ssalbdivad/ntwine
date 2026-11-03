import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Starting ntwine when the window finds none running, so a window pinned to the taskbar is one click
 * after a reboot. scripts/dev.ts writes everything this needs into dist/server.json, since the app copy
 * a Windows Electron runs from (%LOCALAPPDATA%) has no other way to know it.
 *
 * What it starts is the DEV board, `pnpm run dev` in this checkout, as a terminal thread on the board it
 * serves (packages/server/src/dev-terminal.ts): its R / L keys, its output and its ctrl-c are in that
 * thread's drawer, and the run outlives the window, the dev supervisor's recycles and a server crash, as
 * every terminal does. (Until 2026-10-21 it started the stable board, `ntwine-dev --no-app`, because a
 * dev board the window started had nowhere to show its keys, its log or its ctrl-c; a terminal thread
 * is that place.) The starter exits 0 once a server has made the thread and 1 when the run ended before
 * that, with the run's last screen in the log.
 */
export interface ServerLaunch {
  repo: string
  /** node, absolute. */
  node: string
  /**
   * The PATH of the terminal that ran `pnpm run desktop`. A Windows launch reaches WSL through a
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

/** How the launch's own line in the log begins when the recorded node is gone (serverCommand). */
export const STALE_LAUNCH = "ntwine desktop: the node this window was set up with"

export function readServerLaunch(path: string): ServerLaunch | undefined {
  try {
    const launch = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerLaunch>
    if (typeof launch.repo !== "string" || typeof launch.node !== "string" || typeof launch.path !== "string" || typeof launch.log !== "string") return undefined
    if (launch.distro !== undefined && (typeof launch.roots?.data !== "string" || typeof launch.roots.state !== "string")) return undefined
    return launch as ServerLaunch
  } catch {
    return undefined
  }
}

/**
 * The command: the dev terminal's starter in the repo, on the recorded PATH, its output appended to the log.
 *
 * server.json is a snapshot of the terminal `pnpm run desktop` last ran in, and the Windows app copy
 * keeps its own until that runs again. A node it names can go away under it — an nvm upgrade, a
 * rebuilt distro (2026-11-02: a copy from Oct 22 still named v25's `nub`, and the log said only
 * "setsid: failed to execute"). So a missing node is checked for here, inside the distro where the
 * path means something, and the log's last line says what to run.
 */
export function serverCommand(launch: ServerLaunch): [command: string, args: string[]] {
  // Node is its own positional ($3) and the starter is named in the script, so whatever follows is a
  // prefix to run it under: nothing on Linux, `setsid -w` from Windows.
  const shell = [
    "sh",
    "-c",
    'export PATH="$1" && mkdir -p "$(dirname "$2")" && log="$2" && node="$3" && shift 3 && ' +
      `{ [ -x "$node" ] || { echo "${STALE_LAUNCH}: $node is gone. Run \\\`pnpm run desktop\\\` in $(pwd) to refresh it." >> "$log"; exit 127; }; } && ` +
      'exec "$@" "$node" packages/server/src/dev-terminal.ts >> "$log" 2>&1 </dev/null',
    "sh",
    launch.path,
    launch.log,
    launch.node,
  ]
  if (!launch.distro) return [shell[0]!, shell.slice(1)]
  // In a session of its own (spawn's `detached` is that on Linux, and reaches no further than wsl.exe
  // on Windows): when WSL ends the session of a wsl.exe that is killed, it signals everything in it. The
  // terminal's daemon has a session of its own anyway; this keeps the starter's wait from being cut
  // short. `-w` still waits, so a launch that fails is seen to.
  return ["wsl.exe", ["-d", launch.distro, "--cd", launch.repo, "--exec", ...shell, "setsid", "-w"]]
}

/** One argument as Windows' command-line parsing (CommandLineToArgvW) reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/u.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
}

/**
 * Start ntwine, calling `onFailed` if its run stops before a board comes up (the starter exits non-zero)
 * or the starter could not run at all. Exit 0 is the board coming up, which the window's search sees.
 *
 * On Linux and macOS it is spawned detached, out of the window's process group.
 *
 * On Windows, libuv puts every attached child in a job that ends it with the window, and a detached
 * console program (wsl.exe) gets a console of its own, which Windows 11 shows as a Windows Terminal
 * window whatever windowsHide says. So a hidden, attached PowerShell starts wsl.exe with
 * `Start-Process -WindowStyle Hidden`: a grandchild leaves libuv's job silently, and a console created
 * hidden stays hidden. PowerShell then waits on it and exits with its code, so a failed start is seen;
 * PowerShell itself ends with the window, which the dev board's terminal does not.
 */
export function startServer(launch: ServerLaunch, onFailed: () => void): void {
  const [command, args] = serverCommand(launch)
  if (!launch.distro) {
    const child = spawn(command, args, { cwd: launch.repo, detached: true, stdio: "ignore" })
    child.on("error", onFailed)
    child.on("exit", (code) => { if (code !== 0) onFailed() })
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
  child.on("exit", (code) => { if (code !== 0) onFailed() })
}
