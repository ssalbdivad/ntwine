import { execFile, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { DEFAULT_DEV_PORT, DEFAULT_PORT, fallbackPort } from "@frizz/shared"
import { readStableServerOwner, type ServerOwnerRead } from "../../../src/server-owner.ts"
import { PRODUCTION_PRINT_LAUNCHER_FLAG } from "../../../src/production-update.ts"

/**
 * Finding the ONE Frizz server on this machine, and starting it when there is none.
 *
 * This process never runs the server itself. The server loads native modules built for the system
 * Node (node-pty), which Electron's embedded Node cannot load, and it has a launcher that already
 * owns everything about starting it — the machine-wide lease, port allocation, self-update, crash
 * recovery. So the desktop app is a CLIENT of that launcher, exactly as a browser tab is: it joins
 * the server that is running, or runs `frizz` the way a terminal would and then joins that.
 */

export interface LocateOptions {
  readOwner?: () => ServerOwnerRead
  healthy?: (port: number) => Promise<boolean>
}

/** A Frizz answering on this loopback port, by the launcher's own health handshake. */
export async function frizzAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_frizz/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const health = (await response.json()) as { ok?: unknown; bootId?: unknown }
    return health.ok === true && typeof health.bootId === "string"
  } catch {
    return false
  }
}

/**
 * The origin of the running server, `"starting"` when a launcher holds the machine-wide lease but has
 * not opened its listener yet, or undefined when nothing is running.
 *
 * The owner record is what the published launcher writes, and it is authoritative. The well-known
 * ports are the fallback for a server that writes no record: `frizz-dev` (the source launcher, on the
 * dev port) and launchers from before the record existed — the same probe the launcher itself makes
 * before it decides to start a second one.
 */
export async function locateServer(options: LocateOptions = {}): Promise<string | "starting" | undefined> {
  const readOwner = options.readOwner ?? (() => readStableServerOwner())
  const healthy = options.healthy ?? ((port: number) => frizzAnswers(port))
  const owner = readOwner()
  if (owner.kind === "running" && await healthy(owner.port)) return loopbackOrigin(owner.port)
  for (const port of new Set([DEFAULT_PORT, fallbackPort(DEFAULT_PORT), DEFAULT_DEV_PORT, fallbackPort(DEFAULT_DEV_PORT)])) {
    if (await healthy(port)) return loopbackOrigin(port)
  }
  // A live owner whose listener is not up (or not answering yet) is a launch in progress. Starting a
  // second launcher would only queue behind its lease, so wait for this one instead.
  return owner.kind === "idle" ? undefined : "starting"
}

export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** An executable on this PATH, the way a shell would pick it. */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""]
  for (const dir of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return undefined
}

/** The last `frizz: <label>: <value>` row the launcher printed, e.g. `local` or `failed`. */
export function readoutValue(log: string, label: string): string | undefined {
  const prefix = `frizz: ${label}: `
  const line = log.split("\n").reverse().find((row) => row.startsWith(prefix))
  return line?.slice(prefix.length).trim()
}

/** The launcher's latest progress row, for the loading screen — `frizz: ··· installing — …`. */
export function latestProgress(log: string): string | undefined {
  const line = log.trimEnd().split("\n").reverse().find((row) => row.startsWith("frizz: "))
  return line?.slice("frizz: ".length).replace(/^···\s*/u, "").trim() || undefined
}

/** The launcher refused to guess a project: nothing is registered yet and it was started from $HOME. */
export function needsProjectDirectory(failure: string): boolean {
  return failure.includes("there is no other project to show")
}

export type StartOutcome =
  | { kind: "ready"; origin: string }
  | { kind: "failed"; message: string; needsProject: boolean }

export interface StartOptions {
  env: NodeJS.ProcessEnv
  /** Where `frizz` runs. $HOME opens the all-projects page; a repository opens (and adopts) that one. */
  cwd: string
  logPath: string
  onProgress?: (line: string) => void
  timeoutMs?: number
  locate?: () => Promise<string | "starting" | undefined>
}

/**
 * Run the published launcher, detached, and wait for the server it starts.
 *
 * `npx -y frizz` resolves the launcher exactly as a terminal would (and installs it on first use);
 * `--_frizz-print-launcher` makes it print its own path and exit, so the long-lived process is plain
 * `node <launcher> --no-app` rather than an npm process wrapped around it for the server's lifetime.
 *
 * DETACHED, WITH ITS OUTPUT IN A FILE, is load-bearing. The launcher stays in the foreground as the
 * server's supervisor, and the server dies with it. A launcher on this app's pipes would die with this
 * app — the first write after quitting raises EPIPE — and take every board and scheduled wake with
 * it. Detached into its own process group with a file for stdout, it outlives the window the same way
 * a server started from a terminal outlives a closed browser tab.
 */
export async function startServer(options: StartOptions): Promise<StartOutcome> {
  const { env, cwd, logPath } = options
  const npx = findExecutable("npx", env)
  const node = findExecutable("node", env)
  if (!npx || !node) {
    return {
      kind: "failed",
      message: "Frizz needs Node.js 22.13 or newer on your PATH, the same as `npx frizz`. Install it from nodejs.org, then try again.",
      needsProject: false,
    }
  }
  options.onProgress?.("finding the frizz launcher")
  let launcher: string
  try {
    launcher = await printLauncher(npx, env, cwd)
  } catch (error) {
    return { kind: "failed", message: `npx could not run frizz: ${error instanceof Error ? error.message : error}`, needsProject: false }
  }

  mkdirSync(dirname(logPath), { recursive: true })
  const out = openSync(logPath, "w")
  let exit: number | null | undefined
  try {
    const child = spawn(node, [launcher, "--no-app"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    })
    child.on("exit", (code) => { exit = code })
    child.on("error", () => { exit = -1 })
    child.unref()
  } finally {
    closeSync(out)
  }

  const locate = options.locate ?? (() => locateServer())
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  let reported: string | undefined
  while (Date.now() < deadline) {
    const found = await locate()
    if (found && found !== "starting") return { kind: "ready", origin: found }
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
    const progress = latestProgress(log)
    if (progress && progress !== reported) options.onProgress?.((reported = progress))
    if (exit !== undefined) {
      // The launcher exits 0 only when it JOINED a server rather than starting one — a server that
      // answers on no port this app probes, such as one started with `--port`. Its ready row names it.
      const local = readoutValue(log, "local")
      if (exit === 0 && local) return { kind: "ready", origin: new URL(local).origin }
      const failure = readoutValue(log, "failed") ?? (log.trim().split("\n").pop() || `frizz exited with code ${exit}`)
      return { kind: "failed", message: failure, needsProject: needsProjectDirectory(failure) }
    }
    await delay(300)
  }
  return { kind: "failed", message: `Frizz did not start within ${Math.round((options.timeoutMs ?? 10 * 60_000) / 60_000)} minutes.`, needsProject: false }
}

function printLauncher(npx: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  // npx is a .cmd shim on Windows, which Node will only run through a shell. The arguments are this
  // file's own constants, so there is nothing for the shell to misread; the path is quoted because
  // the default install lives under "Program Files".
  const shell = process.platform === "win32"
  return new Promise((resolve, reject) => {
    execFile(
      shell ? `"${npx}"` : npx,
      ["-y", "frizz", PRODUCTION_PRINT_LAUNCHER_FLAG],
      { cwd, env, timeout: 5 * 60_000, windowsHide: true, shell },
      (error, stdout, stderr) => {
        const path = stdout.trim().split(/\r?\n/u).pop()?.trim()
        if (path && existsSync(path)) resolve(path)
        else reject(new Error((stderr || error?.message || "no launcher path printed").trim()))
      },
    )
  })
}
