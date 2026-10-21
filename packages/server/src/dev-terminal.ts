// THE DESKTOP WINDOW'S DEV BOARD: `nub run dev` started as a terminal thread before any server exists.
//
// The window (packages/desktop/src/launch.ts) runs this when its search finds no board. It forks a terminal
// daemon (backend/terminal-host.ts) running `nub run dev` in this checkout, exactly as the board forks one
// for a `$ nub run dev` typed in the prompt box, and leaves a CLAIM beside it: the row it wants. The dev
// server it starts is the first server to boot, and its terminal runner turns the claim into a top-level
// terminal thread (thread-terminals.ts) — drawer, live output, the R / L keys src/dev.ts reads — then adopts
// the daemon like any other. So the dev board, its keys and its ctrl-c live on the board it serves, and
// the daemon outlives every control-plane recycle, as every terminal does.
//
// ONE TERMINAL, REUSED. `<stateDir>/dev-terminal.json` names the terminal the last start used, so the next
// one (after a reboot, or after the human stopped it) is a fresh run of the SAME thread — `@nub-run-dev`,
// not an interrupted `@nub-run-dev` in Ready every morning beside a new `@nub-run-dev-2`. Its run number
// is past every run its files have seen; the claim puts the row on it (claimRowAction).
//
// A run that ended with no server to file it — the dev supervisor itself died, or the last start failed
// before a board came up — left its last screen in its exit record, and the next run opens on that
// screen under its own `$ nub run dev` line, as a follow-up line in a terminal does: the crash is still
// there to read once a board is back. (A control plane that crashes is a different case, and needs
// nothing: the supervisor and the daemon carry on, the daemon keeps the error in its replay, and the
// next control plane adopts it with that screen.)
//
// It starts nothing when a board for this project already runs (its launch owner is alive: the window just
// cannot see it yet, a control plane mid-recycle) or when that terminal's daemon is still alive.
//
// It exits 0 once a server has made the row (the claim is gone) — the board is booting and the window's
// own search takes over — and 1 when the run ended before that, printing the run's last screen to stdout,
// which the window appends to its log. The claim and the exit record stay, so the next server to boot
// files that failure on the thread, where the human reads it.
//
//   nub packages/server/src/dev-terminal.ts [--command="nub run dev -- --port 9400"]
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  createTerminalHost,
  dropTerminalClaim,
  liveTerminalHostRecord,
  readTerminalExit,
  readTerminalHostRecord,
  terminalClaimPath,
  terminalHostDir,
  writeTerminalClaim,
  type TerminalExitRecord,
} from "./backend/terminal-host.ts"
import { pidIsAlive } from "./project-identity.ts"
import { servedByAnotherProcess } from "./project-launch.ts"
import { resolveProject } from "./project.ts"
import { commandEnvironment, commandShell, followUpScreen, plainScreen, startFailureScreen } from "./thread-terminals.ts"

export const DEV_TERMINAL_COMMAND = "nub run dev"

/** The terminal the last start used. */
export interface DevTerminalMemo {
  id: string
  runId: number
  command?: string
  /** That run opened on a carried screen that already shows its `$ command` line. */
  echoed?: boolean
}

export type DevTerminalPlan =
  /** A board for this project is already up or coming up. */
  | { kind: "served"; pid: number }
  /** The dev terminal's daemon is alive: wait on it. */
  | { kind: "running"; id: string; runId: number }
  | { kind: "start"; id: string; runId: number }

/** What to do, from what is on disk. Pure. `seenRunIds` are the run numbers of the terminal's leftover
 *  record and exit files, which a server may have advanced past the memo (a Restart from the board). */
export function planDevTerminal(input: {
  servedBy?: number
  memo?: DevTerminalMemo
  live?: { runId: number }
  seenRunIds?: readonly number[]
  mint: () => string
}): DevTerminalPlan {
  if (input.servedBy !== undefined) return { kind: "served", pid: input.servedBy }
  if (!input.memo) return { kind: "start", id: input.mint(), runId: 1 }
  if (input.live) return { kind: "running", id: input.memo.id, runId: input.live.runId }
  return { kind: "start", id: input.memo.id, runId: Math.max(input.memo.runId, ...(input.seenRunIds ?? [])) + 1 }
}

export function devTerminalMemoPath(stateDir: string): string {
  return join(stateDir, "dev-terminal.json")
}

export function readDevTerminalMemo(stateDir: string): DevTerminalMemo | undefined {
  try {
    const value = JSON.parse(readFileSync(devTerminalMemoPath(stateDir), "utf8")) as Partial<DevTerminalMemo>
    if (typeof value.id === "string" && /^term-[0-9a-f]{12}$/u.test(value.id) && Number.isInteger(value.runId) && value.runId! >= 1) {
      return { id: value.id, runId: value.runId!, ...(typeof value.command === "string" ? { command: value.command } : {}), ...(value.echoed === true ? { echoed: true } : {}) }
    }
  } catch {}
  return undefined
}

function writeDevTerminalMemo(stateDir: string, memo: DevTerminalMemo): void {
  const path = devTerminalMemoPath(stateDir)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(memo))
  renameSync(temp, path)
}

export type DevTerminalOutcome =
  | { kind: "served"; pid: number }
  /** A server made the row: the board is booting. */
  | { kind: "claimed"; id: string; runId: number }
  /** The run ended before any server made its row. `exit` is absent when its daemon left no record. */
  | { kind: "ended"; id: string; runId: number; exit?: TerminalExitRecord }
  /** No daemon could be started at all. */
  | { kind: "failed"; message: string }

export interface StartDevTerminalOptions {
  stateDir: string
  projectId: string
  /** The checkout the dev board runs in. */
  cwd: string
  command?: string
  env?: NodeJS.ProcessEnv
  pollMs?: number
  /** Test seams. */
  servedBy?: () => number | undefined
  daemonEntry?: string
}

/**
 * Start (or find) the dev terminal and wait until a server makes its row or its run ends. Holds a lock
 * across deciding and forking, so two windows opened at once start one dev board, not two forking the
 * same terminal id.
 */
export async function startDevTerminal(options: StartDevTerminalOptions): Promise<DevTerminalOutcome> {
  const { stateDir } = options
  const command = options.command ?? DEV_TERMINAL_COMMAND
  const env = options.env ?? process.env
  const host = createTerminalHost({ stateDir, ...(options.daemonEntry ? { daemonEntry: options.daemonEntry } : {}) })
  const release = await lockDevTerminal(stateDir)
  let plan: DevTerminalPlan
  try {
    const memo = readDevTerminalMemo(stateDir)
    const live = memo ? liveTerminalHostRecord(stateDir, memo.id) : null
    const lastExit = memo ? readTerminalExit(stateDir, memo.id) : null
    const leftovers = memo ? [readTerminalHostRecord(stateDir, memo.id)?.runId, lastExit?.runId] : []
    const servedBy = options.servedBy ? options.servedBy() : servedByAnotherProcess(stateDir, options.projectId)
    plan = planDevTerminal({
      ...(servedBy === undefined ? {} : { servedBy }),
      ...(memo ? { memo } : {}),
      ...(live ? { live: { runId: live.runId } } : {}),
      seenRunIds: leftovers.filter((n): n is number => typeof n === "number"),
      mint: () => `term-${randomBytes(6).toString("hex")}`,
    })
    if (plan.kind === "served") return plan
    if (plan.kind === "start") {
      const { id, runId } = plan
      // The claim goes down BEFORE the fork: a server that boots in between must find the row's request,
      // never a daemon nobody asked for (which its audit would end).
      writeTerminalClaim(stateDir, { id, runId, command, cwd: options.cwd, startedBy: "human", createdAt: new Date().toISOString() })
      // The last run's screen, when nobody filed its end (see the header). The fork deletes the record.
      const carried = memo && lastExit?.screen ? exitScreen(lastExit) : undefined
      const screen = carried === undefined ? undefined : followUpScreen({ command: memo!.command ?? command, buffer: carried, echoed: memo!.echoed === true }, command)
      writeDevTerminalMemo(stateDir, { id, runId, command, ...(screen === undefined ? {} : { echoed: true }) })
      // The shell a terminal started from the board gets: the login shell, so nvm and friends are on PATH.
      // A window's launch reaches here through `wsl.exe --exec`, which sets no SHELL.
      const shellEnv = { ...env, SHELL: env.SHELL || userShell() }
      const { file, args } = commandShell(command, shellEnv)
      try {
        // Forked, never attached: the server is the one client. A run already over is waited on like a
        // live one, and reads as ended.
        await host.fork({ id, runId, file, args, cwd: options.cwd, env: commandEnvironment(shellEnv), interactive: false, echoed: screen !== undefined, ...(screen === undefined ? {} : { screen }), cols: 120, rows: 30 })
      } catch (cause) {
        dropTerminalClaim(stateDir, id)
        return { kind: "failed", message: (cause as Error).message }
      }
    }
  } finally {
    release()
  }
  return awaitDevTerminal(stateDir, plan.id, plan.runId, options.pollMs ?? 250)
}

/** Until a server makes the row (its claim is gone) or the run ends first. */
export async function awaitDevTerminal(stateDir: string, id: string, runId: number, pollMs = 250): Promise<DevTerminalOutcome> {
  for (;;) {
    if (!existsSync(terminalClaimPath(stateDir, id))) return { kind: "claimed", id, runId }
    const exit = readTerminalExit(stateDir, id)
    if (exit && exit.runId === runId) return { kind: "ended", id, runId, exit }
    const live = liveTerminalHostRecord(stateDir, id)
    if (!live || live.runId !== runId) {
      // Gone without a word yet: its exit record may be a moment behind its record's removal.
      await delay(500)
      if (!existsSync(terminalClaimPath(stateDir, id))) return { kind: "claimed", id, runId }
      const late = readTerminalExit(stateDir, id)
      return { kind: "ended", id, runId, ...(late && late.runId === runId ? { exit: late } : {}) }
    }
    await delay(pollMs)
  }
}

function userShell(): string {
  try {
    return userInfo().shell || "/bin/sh"
  } catch {
    return "/bin/sh"
  }
}

/** An exclusive lock file holding our pid; one left by a process that died is taken over. */
async function lockDevTerminal(stateDir: string, timeoutMs = 30_000): Promise<() => void> {
  mkdirSync(terminalHostDir(stateDir), { recursive: true })
  const path = join(terminalHostDir(stateDir), "dev-terminal.lock")
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(path) } catch {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let holder: number | undefined
    try { holder = Number(readFileSync(path, "utf8")) } catch {}
    if (!pidIsAlive(holder) || Date.now() > deadline) {
      try { unlinkSync(path) } catch {}
      continue
    }
    await delay(100)
  }
}

function exitScreen(exit: TerminalExitRecord): string {
  return exit.startFailure ? exit.screen + startFailureScreen(exit.startFailure.what, exit.startFailure.message) : exit.screen
}

/** The last lines of the run's screen, for the window's log. */
export function endedReport(outcome: Extract<DevTerminalOutcome, { kind: "ended" }>, maxLines = 40): string {
  const exit = outcome.exit
  if (!exit) return `the dev board's terminal stopped before a board came up, and left no record of how`
  const screen = exitScreen(exit)
  const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exitCode ?? "unknown"}`
  const tail = plainScreen(screen).replace(/\s+$/u, "").split("\n").slice(-maxLines).join("\n")
  return `the dev board stopped before it came up (${how}). Its last output:\n${tail}`
}

if (import.meta.main) {
  const commandFlag = process.argv.find((arg) => arg.startsWith("--command="))
  const project = resolveProject()
  const say = (line: string) => console.log(`[${new Date().toISOString()}] [dev-terminal] ${line}`)
  say(`starting the dev board for ${project.dir}`)
  const outcome = await startDevTerminal({
    stateDir: project.stateDir,
    projectId: project.id,
    cwd: project.dir,
    ...(commandFlag ? { command: commandFlag.slice("--command=".length) } : {}),
  })
  if (outcome.kind === "served") say(`a board for this project is already running (pid ${outcome.pid})`)
  else if (outcome.kind === "claimed") say(`the dev board is up in terminal ${outcome.id} (run ${outcome.runId})`)
  else if (outcome.kind === "failed") say(`could not start a terminal: ${outcome.message}`)
  else say(endedReport(outcome))
  process.exit(outcome.kind === "served" || outcome.kind === "claimed" ? 0 : 1)
}
