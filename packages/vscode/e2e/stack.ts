// A DISPOSABLE NTWINE FOR THE END-TO-END HARNESSES — scripts/e2e.ts --stack and scripts/e2e-sidebar.ts both
// boot one: `scripts/adhoc-stack.mjs` with a sandbox HOME this run owns from the first moment, a free
// port, throwaway git repos as its projects, and every file opener the server could spawn replaced by a
// stub on its PATH that writes down how it was called. Torn down by process group, then by anything still
// carrying the sandbox HOME in its environment (a detached worker daemon inherits it), pass or fail.
//
// Runs in the harness (Node), never inside the editor.

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

export interface StackProject {
  id: string
  slug: string
  dir: string
}

export interface StackInfo {
  url: string
  port: number
  home: string
  /** The launching project, with the lock a worker's MCP server finds the server by. */
  launcher: StackProject & { serverLock: string }
  tenants: StackProject[]
}

export interface Stack {
  origin: string
  info: StackInfo
  /** The file adhoc-stack's stdout and stderr go to; its first json line is `info`. */
  logFile: string
  /** The stub openers' directory, first on the server's PATH (and on any other PATH a harness hands it). */
  stubs: string
  /** Every opener a stub recorded: one line each, `<name> <args>`; empty when nothing spawned one. */
  openers(): string
  teardown(): Promise<void>
}

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A git repo at `dir` with a README committed — what an ntwine project needs to be one. */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=ntwine e2e", "-c", "user.email=e2e@ntwine.invalid", ...args], { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`)
  git("add", ".")
  git("commit", "-q", "-m", "init")
  return realpathSync(dir)
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function waitGone(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (check()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

/**
 * Processes a run left behind: anything whose environment carries `HOME=<home>` (a detached worker daemon
 * inherits it) or whose command line names `marker` (default: the HOME). Read from /proc where there is
 * one, and from `ps` everywhere. Never ourselves, never our ancestors.
 */
export function leftovers(home: string, marker = home): number[] {
  const found = new Set<number>()
  const own = new Set([process.pid, process.ppid])
  if (existsSync("/proc")) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`HOME=${home}`)) found.add(Number(entry))
      } catch {}
    }
  }
  try {
    for (const line of execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
      if (match && match[2]!.includes(marker)) found.add(Number(match[1]))
    }
  } catch {}
  return [...found].filter((pid) => !own.has(pid))
}

/** SIGTERM everything `find` names, wait, SIGKILL what is left; returns what STILL survives. */
export async function killAll(find: () => number[], ms = 10_000): Promise<number[]> {
  for (const pid of find()) try { process.kill(pid, "SIGTERM") } catch {}
  if (!(await waitGone(() => find().length > 0, ms))) {
    for (const pid of find()) try { process.kill(pid, "SIGKILL") } catch {}
    await waitGone(() => find().length > 0, 5_000)
  }
  return find()
}

/** Openers a server could fall back to — each one a stub on PATH that logs instead of opening anything. */
const OPENERS = ["code", "code-insiders", "cursor", "windsurf", "xdg-open", "gio", "open", "wslview", "explorer.exe", "cmd.exe", "sensible-browser", "x-www-browser", "firefox", "google-chrome", "chromium"]

/**
 * A PATH with the stubs first and every Windows directory (`/mnt/…`, WSL's interop) dropped: on WSL `code`
 * on PATH is the human's Windows VS Code and `explorer.exe` opens on their screen.
 */
export function stubbedPath(stubs: string): string {
  return [stubs, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => dir && !dir.startsWith("/mnt/"))].join(delimiter)
}

export interface BootOptions {
  /** The run's scratch directory: the projects, the stub openers and the stack's log go under it. */
  scratch: string
  /** Directory names of the projects — the first launches the server; a project's slug is its name. */
  projects: [string, ...string[]]
  /** Real credentials (`--creds`), for runs that start a real agent. */
  creds?: boolean
  log(line: string): void
  /** Called the moment the stack's process group exists, with its teardown: a Ctrl-C during the boot must still reach it. */
  onSpawn?(teardown: () => Promise<void>): void
}

export async function bootStack(options: BootOptions): Promise<Stack> {
  const { scratch, log } = options
  const [launcherName, ...tenantNames] = options.projects
  const launcher = gitRepo(join(scratch, launcherName))
  const tenantDirs = tenantNames.map((name) => gitRepo(join(scratch, name)))
  // A HOME this run owns from the first moment, so its processes can be found even if the stack dies
  // before it says where it is. `--home` keeps adhoc-stack from deleting it; the teardown does.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-vscode-e2e-home-")))
  // Every opener the server could fall back to is a stub that writes down how it was called: a spawn
  // must never reach the human's real VS Code or browser, and one that happened is the harness's to judge.
  const stubs = join(scratch, "stub-bin")
  const opened = join(scratch, "openers.log")
  mkdirSync(stubs, { recursive: true })
  for (const name of OPENERS) {
    writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${opened}'\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: stubbedPath(stubs) }
  delete env.WAYLAND_DISPLAY
  delete env.NTWINE_E2E_UNDER_XVFB

  const port = await freePort()
  const logFile = join(scratch, "stack.log")
  const out = openSync(logFile, "w")
  // Its own process group (`detached`), so the teardown reaches nub's node child with one signal.
  const child: ChildProcess = spawn("nub", [
    "scripts/adhoc-stack.mjs", `--port=${port}`, `--project=${launcher}`, ...tenantDirs.map((dir) => `--also-project=${dir}`), `--home=${home}`, ...(options.creds ? ["--creds"] : []),
  ], { cwd: join(import.meta.dirname, "..", "..", ".."), env, stdio: ["ignore", out, out], detached: true })
  closeSync(out)
  const pid = child.pid!
  let exited = false
  child.on("exit", () => (exited = true))
  log(`stack: pid ${pid} (process group), port ${port}, HOME ${home}; its log is ${logFile}`)

  const groupAlive = () => alive(-pid)
  const tearDown = async () => {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
    if (!(await waitGone(groupAlive, 20_000))) {
      log(`stack: process group ${pid} ignored SIGTERM for 20s; killing it`)
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
      await waitGone(groupAlive, 5_000)
    }
    // Worker daemons are detached into groups of their own; the sandbox HOME in their environment names them.
    const strays = await killAll(() => leftovers(home))
    log(strays.length ? `stack: STILL RUNNING after teardown: ${strays.join(", ")}` : `stack: torn down (pid ${pid}${exited ? " exited" : ""}; nothing left with its HOME)`)
    rmSync(home, { recursive: true, force: true })
  }
  let tearing: Promise<void> | undefined
  const teardown = () => (tearing ??= tearDown())
  options.onSpawn?.(teardown)

  try {
    const deadline = Date.now() + 180_000
    let info: StackInfo | undefined
    while (!info) {
      const line = readFileSync(logFile, "utf8").split("\n").find((candidate) => candidate.startsWith('{"url"'))
      if (line) info = JSON.parse(line) as StackInfo
      else if (exited) throw new Error(`the stack exited before it was up; see ${logFile}`)
      else if (Date.now() > deadline) throw new Error(`the stack was not up within 180s; see ${logFile}`)
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (info.tenants.length !== tenantNames.length) throw new Error(`the stack registered ${info.tenants.length} tenants of ${tenantNames.length}; see ${logFile}`)
    return {
      origin: `http://127.0.0.1:${info.port}`,
      info,
      logFile,
      stubs,
      openers: () => (existsSync(opened) ? readFileSync(opened, "utf8").trim() : ""),
      teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}
