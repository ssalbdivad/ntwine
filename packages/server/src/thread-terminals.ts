import { randomBytes } from "node:crypto"
import { basename } from "node:path"
import type { IPty, IPtyForkOptions } from "node-pty"
import type { ThreadTerminal } from "@ntwine/shared"
import type { ThreadTerminalRow, Storage } from "./storage.ts"
import type { TerminalAttachment } from "./terminal.ts"
import { launchEnvironment } from "./backend/worker-env.ts"

// THREAD TERMINALS — a live pty that belongs to one thread. The human opens it from the thread's drawer
// (or types `$ cmd` into the thread's prompt box), and it runs in the folder that thread's agent is
// working in: the project root, or the worktree the agent moved into (thread-cwd.ts). It is never a
// thread of its own. It has no row in the rail and no card in the queue; it shows INSIDE its thread
// (the drawer's terminals strip, a mark on the thread's row and card), and it ends with its thread:
// marking the thread done stops every terminal it still has running.
//
// This is the second shape of the feature. It shipped on 2026-09-23 as TERMINAL COMMAND THREADS: the
// prompt box's Terminal tab ran a command as a top-level `kind: "command"` thread with its own row, its
// own queue card and its own Done. That was reversed on 2026-09-29 (maintainer: prompt threads are the
// only top-level thread kind; terminals hang off a thread), for two reasons raised upstream in Frizz: a
// standalone terminal ran in the project root and so ignored which worktree an agent was actually in —
// Ntwine deliberately leaves the worktree choice to the agent, so the terminal has to follow it — and
// every terminal was one more row in a sidebar whose whole value is density. The table, `thread_terminal`,
// was named `command_thread` until 2026-10-06 (storage.ts renameCommandThreadTable); `parent_slug` is what
// makes a row a thread's terminal, and a row without one is a pre-2026-09-29 command thread, archived at boot.
//
// The pty rides the hardened /term/<id> transport (terminal.ts): ONE process per terminal, a bounded
// replay so a tab that opens late (or reloads) sees the screen so far, and a subscriber set so two tabs
// watch the SAME process rather than each starting one.
//
// node-pty IS LOADED LAZILY, on the start path only. It is a native addon, and upstream removed it on
// 2026-09-24 because a static `import "node-pty"` killed every Linux/WSL install at boot (#42): a failed
// native load took the WHOLE server down, every project with it, for a feature most boards never touch.
// So nothing here imports it at module load. A start that cannot load it records a failed run whose
// screen says why, which is where the human who pressed "Open terminal" is already looking.
//
// WHAT IS DURABLE AND WHAT IS NOT. The row — its thread, the command, the folder, how its last run ended —
// lives in SQLite, so the thread keeps it across a restart. The process does not: a pty is a child of this
// server, and replacing the control plane (Restart Ntwine, an update) closes the pty master and hangs the
// process up. Boot records every run that never reported an exit as interrupted, so the strip says
// "interrupted" and offers Restart rather than showing a process that is not there.
//
// ONE WAY A TERMINAL REACHES THE QUEUE: A RUN SITTING AT A PROMPT. `npm publish` stopping at "Enter
// one-time password:", an ssh passphrase, a `[y/N]` — the process is alive and will stay alive forever,
// and the human is the only one who can move it. See `awaitingInput`; the board queues the PARENT thread
// on it (board.ts withThreadTerminals), since the terminal has no card of its own to queue.

// How long a run must be silent, sitting on an unterminated line, before it reads as waiting for input.
// Long enough that a program between two writes of one line (a spinner frame, a slow `printf`) is not
// mistaken for a prompt; short enough that the card is up before the human has looked elsewhere.
const INPUT_QUIET_MS = 3_000
// How soon after the human's keystroke a write still counts as that keystroke's ECHO. A pty echoes typed
// characters within a millisecond or two; this only has to be generous enough for a loaded machine.
const ECHO_WINDOW_MS = 1_000
// How much of the screen's tail the prompt test reads. A prompt is one line; this only has to reach
// past whatever escape sequences a program paints after it.
const PROMPT_TAIL_CHARS = 2_048
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

// A dev server's log is long-lived and chatty; a late viewer needs the recent screen, not the banner.
// Trimmed from the FRONT, at a line boundary where one is near, so the replay starts on a clean line.
const REPLAY_CAP_BYTES = 1024 * 1024
// How long Stop waits after SIGTERM before it SIGKILLs the process group.
const STOP_GRACE_MS = 5_000
// The code a run that never got a process records — a shell's own "command not found" code, so the
// strip reads it as a failure rather than a success or an interruption.
const START_FAILED_EXIT = 127

type SpawnPty = (file: string, args: string[], options: IPtyForkOptions) => IPty

export interface StartTerminalInput {
  /** The thread the terminal belongs to. */
  parent: string
  /** One line of shell, run under the login shell. Absent ⇒ an interactive login shell. */
  command?: string
  /** Absolute, existing directory — the caller resolved and checked it (thread-cwd.ts). */
  cwd: string
}

export interface TerminalRunner {
  start(input: StartTerminalInput): Promise<{ id: string }>
  /** A fresh run of a terminal's command (or shell): stops the current run first if it is alive. */
  restart(id: string): Promise<void>
  /** The terminal's NEXT command, typed into its drawer once a run finished — a shell's next line.
   *  Stops a live run first, like restart; unlike restart the screen carries on (see `followUpScreen`). */
  run(id: string, command: string): Promise<void>
  /** SIGTERM the run's whole process group, SIGKILL it if it outlives the grace. */
  stop(id: string): Promise<void>
  /** Stop, then forget the terminal entirely. */
  remove(id: string): Promise<void>
  /** Stop every live terminal the PARENT has — together, not one grace after another. */
  stopThread(parent: string): Promise<void>
  /** Mark as done on the PARENT: stop every live terminal it has, then file them all away. */
  closeThread(parent: string): Promise<void>
  /** The parent was forgotten (dismissed): stop its terminals and drop them — nothing is left to show them. */
  forgetThread(parent: string): Promise<void>
  /** The confirmation dialog's list: this thread's terminals still running something — alive, and not an
   *  interactive shell idle at its own prompt (`shellIdle`). */
  live(parent: string): ThreadTerminal[]
  /** The /term transport's gate: non-null iff this id is one of this project's terminals. */
  attach(id: string): TerminalAttachment | null
  has(id: string): boolean
  /** Every open terminal, grouped by the thread it belongs to — what the board attaches to its rows. */
  byThread(): Map<string, ThreadTerminal[]>
  /** Server shutdown: hang up every live run. */
  shutdown(): void
}

interface Run {
  /** Absent for a run that never got a process (node-pty would not load, the shell would not spawn):
   *  its screen is the reason, and it is exited from birth. */
  term?: IPty
  exited: boolean
  exitCode?: number
  stopRequested: boolean
  buffer: string
  bufferBytes: number
  dataListeners: Set<(chunk: string) => void>
  exitListeners: Set<(exitCode?: number) => void>
  exitedPromise: Promise<void>
  /** The replay already opens with this run's own `$ command` line — a follow-up run, whose screen
   *  carries its predecessors' (followUpScreen). A first run's command is the drawer's title instead. */
  echoed: boolean
  /** When the process last wrote. The prompt test's clock. */
  lastOutputAt: number
  /** What the board was last told about the prompt, so a change is announced once, not per chunk. */
  promptShown: boolean
  /** When the prompt the board is showing was first announced — the terminal's `awaitingSince`. */
  promptSince?: number
  /** When the human last typed into it — to tell the echo of an answer from the program moving on. */
  lastInputAt?: number
  promptTimer?: NodeJS.Timeout
  /** An interactive shell sits at its own prompt by design; the input heuristic must never read it. */
  interactive: boolean
  /** An interactive shell's own foreground-process name, read at spawn — see `shellIdle`. */
  shellProcess?: string
}

/** An interactive shell with nothing running in it: the pty's FOREGROUND process is still the shell it
 *  spawned. node-pty reads that off the terminal's foreground process group (measured on Linux 2026-09-29:
 *  "/bin/bash" at the prompt, "sleep" / "vim" while one runs, back to "/bin/bash" after), so a `npm run dev`
 *  typed into the shell reads busy and a bare prompt reads idle. Mark as done still stops an idle shell —
 *  it just is not work worth a confirmation. On Windows node-pty reports the spawned file whatever runs,
 *  so a shell there always reads idle. */
function shellIdle(run: Run | undefined): boolean {
  if (!run?.interactive || !run.term || run.exited || run.shellProcess === undefined) return false
  try {
    return run.term.process === run.shellProcess
  } catch {
    return false
  }
}

/** True when a screen ENDS ON AN UNTERMINATED LINE with something printed on it — the shape of every
 *  interactive prompt ("Password: ", "Enter OTP: ", "Continue? [y/N] "). A program that has merely gone
 *  quiet — a dev server after "ready on :3000", a watcher after its last rebuild — ends on a newline, and
 *  that is the whole distinction: silence alone cannot tell a prompt from an idle server, and the line the
 *  cursor was left on can. Escape sequences are dropped first (a prompt library repaints and hides the
 *  cursor after the text), and so is anything a carriage return overwrote. */
export function endsOnPrompt(screen: string): boolean {
  const tail = screen.slice(-PROMPT_TAIL_CHARS).replace(ANSI_RE, "")
  const line = tail.slice(tail.lastIndexOf("\n") + 1)
  // After a carriage return the cursor is back at column 0: a spinner frame, not a question.
  return line.slice(line.lastIndexOf("\r") + 1).trim().length > 0
}

/**
 * node-pty, loaded on first use — see the header for why never at module load. Not memoised on
 * failure: a missing module can be installed while the server runs, and a retry costs one resolve.
 * Handles both module shapes an `import()` of a CommonJS addon can produce.
 */
export async function loadNodePty(): Promise<SpawnPty> {
  const mod = (await import("node-pty")) as { spawn?: SpawnPty; default?: { spawn?: SpawnPty } }
  const spawn = mod.spawn ?? mod.default?.spawn
  if (typeof spawn !== "function") throw new Error("node-pty loaded but exports no spawn()")
  return spawn
}

/** The screen a run that never got a process shows instead of output: what failed, in the terminal's
 *  own red, then the underlying error, and — for the addon — what would fix it. */
export function startFailureScreen(what: "load" | "spawn", cause: unknown): string {
  const detail = (cause instanceof Error ? cause.message : String(cause)).trim().split("\n").slice(0, 6).join("\r\n")
  const head = what === "load"
    ? "Ntwine could not start this terminal: the node-pty native module did not load."
    : "Ntwine could not start this terminal: the shell did not spawn."
  const hint = what === "load"
    ? `\r\n\r\nTerminals need node-pty's prebuilt binary for ${process.platform}-${process.arch}.\r\nEverything else in Ntwine works without it.`
    : ""
  return `\x1b[31m${head}\x1b[0m\r\n\r\n\x1b[2m${detail}\x1b[22m${hint}\r\n`
}

export interface TerminalRunnerDeps {
  storage: Pick<Storage,
    "insertThreadTerminal" | "listThreadTerminals" | "restartThreadTerminal" | "recordTerminalExit" |
    "interruptRunningTerminals" | "dropThreadTerminal" | "archiveThreadTerminals" | "dropThreadTerminals">
  /** The board's overlay refresh — every state change is a change to a thread's row. */
  onChange: () => void
  env?: NodeJS.ProcessEnv
  /** node-pty's spawn, resolved on demand. Tests inject a rejecting one for the load failure. */
  loadPty?: () => Promise<SpawnPty>
  now?: () => number
  stopGraceMs?: number
  inputQuietMs?: number
}

/** The shell a terminal runs under, and how it is handed the line. A LOGIN shell on POSIX so the human's
 *  own PATH additions (nvm, volta, a Homebrew prefix) apply exactly as in their terminal. No command ⇒
 *  the shell itself, interactive. */
export function commandShell(command: string | undefined, env: NodeJS.ProcessEnv, platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") {
    const file = env.ComSpec || "cmd.exe"
    return command === undefined ? { file, args: [] } : { file, args: ["/d", "/s", "/c", command] }
  }
  const file = env.SHELL || "/bin/sh"
  return command === undefined ? { file, args: ["-l"] } : { file, args: ["-l", "-c", command] }
}

/** What an interactive-shell terminal is called on its row: the shell's own name, as a terminal tab does. */
export function shellLabel(env: NodeJS.ProcessEnv, platform = process.platform): string {
  return basename(platform === "win32" ? env.ComSpec || "cmd.exe" : env.SHELL || "/bin/sh")
}

/** The environment a terminal runs in: the server's, minus every NTWINE_* variable. Those name the
 *  running server's own project, state dir and log — a `npm run dev` of Ntwine itself inside Ntwine would
 *  otherwise obey them and write into the live server's files. The keys Vite writes into the dev
 *  server's process.env go back to their launch values first, exactly as for a worker
 *  (backend/worker-env.ts): a `next build` typed here must not inherit NODE_ENV=development. */
export function commandEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(launchEnvironment(env))) {
    if (value == null || key.startsWith("NTWINE_")) continue
    out[key] = value
  }
  out.TERM = "xterm-256color"
  out.COLORTERM = "truecolor"
  return out
}

/** A `$ command` line in the shell's own shape, dim, so a carried-forward screen reads like a terminal
 *  session: each run's output under the line that started it. */
function echoLine(command: string): string {
  return `\x1b[2m$\x1b[22m ${command.replace(/\r?\n/g, "\r\n")}\r\n`
}

/** The opening screen of a FOLLOW-UP run: what the terminal's last run left, then the new command's line.
 *  Restart deliberately starts blank (the same command again is a fresh attempt, not the next step);
 *  a follow-up is the next line of one session — `whoami`, then `ls` — and should read as one. When the
 *  previous run was a first run, its own line is added above its output so the history starts cleanly
 *  (a shell's first run has no line: the shell drew its own prompts). No previous run in memory (the
 *  server restarted since) ⇒ only the new line. */
export function followUpScreen(previous: { command: string; buffer: string; echoed: boolean; interactive?: boolean } | undefined, command: string): string {
  if (!previous) return echoLine(command)
  const screen = previous.echoed || previous.interactive ? previous.buffer : echoLine(previous.command) + previous.buffer
  // Reset any colour or hidden cursor the last program left, and start on a fresh line.
  return screen + "\x1b[0m\x1b[?25h" + (screen.endsWith("\n") ? "" : "\r\n") + echoLine(command)
}

function trimReplay(run: Run): void {
  if (run.bufferBytes <= REPLAY_CAP_BYTES) return
  // Cut roughly a quarter, then advance to the next newline so the replay opens on a whole line.
  let cut = Math.ceil(run.buffer.length / 4)
  const newline = run.buffer.indexOf("\n", cut)
  if (newline !== -1 && newline - cut < 4096) cut = newline + 1
  const drop = run.buffer.slice(0, cut)
  run.buffer = run.buffer.slice(cut)
  run.bufferBytes -= Buffer.byteLength(drop)
}

export function createTerminalRunner(deps: TerminalRunnerDeps): TerminalRunner {
  const loadPty = deps.loadPty ?? loadNodePty
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS
  const inputQuietMs = deps.inputQuietMs ?? INPUT_QUIET_MS
  const runs = new Map<string, Run>()
  let shuttingDown = false

  // Whatever was running when the last server went away went with it.
  deps.storage.interruptRunningTerminals(now())

  // A thread's terminals only: a row with no parent is a pre-2026-09-29 command thread (see the header),
  // which nothing addresses any more.
  function rows(): Map<string, ThreadTerminalRow & { parent_slug: string }> {
    const out = new Map<string, ThreadTerminalRow & { parent_slug: string }>()
    for (const row of deps.storage.listThreadTerminals()) {
      if (row.parent_slug) out.set(row.slug, row as ThreadTerminalRow & { parent_slug: string })
    }
    return out
  }

  function newRun(screen: string | undefined, interactive: boolean): { run: Run; settle: () => void } {
    let settle!: () => void
    const run: Run = {
      exited: false,
      stopRequested: false,
      buffer: screen ?? "",
      bufferBytes: screen ? Buffer.byteLength(screen) : 0,
      echoed: screen !== undefined,
      lastOutputAt: now(),
      promptShown: false,
      interactive,
      dataListeners: new Set(),
      exitListeners: new Set(),
      exitedPromise: new Promise<void>((resolve) => { settle = resolve }),
    }
    return { run, settle }
  }

  // A run that never got a process: exited from birth, its screen the reason, its row a failure.
  function failRun(id: string, run: Run, settle: () => void, screen: string): void {
    run.buffer += screen
    run.bufferBytes += Buffer.byteLength(screen)
    run.exited = true
    run.exitCode = START_FAILED_EXIT
    runs.set(id, run)
    deps.storage.recordTerminalExit(id, { exitedAtMs: now(), exitCode: START_FAILED_EXIT, stopped: false })
    settle()
  }

  async function spawn(id: string, row: { command: string | undefined; cwd: string }, screen?: string): Promise<void> {
    const interactive = row.command === undefined
    const { run, settle } = newRun(screen, interactive)
    let spawnPty: SpawnPty
    try {
      spawnPty = await loadPty()
    } catch (cause) {
      failRun(id, run, settle, startFailureScreen("load", cause))
      return
    }
    const { file, args } = commandShell(row.command, env)
    let term: IPty
    try {
      term = spawnPty(file, args, {
        name: "xterm-256color",
        cwd: row.cwd,
        env: commandEnvironment(env),
        cols: 120,
        rows: 30,
      })
    } catch (cause) {
      failRun(id, run, settle, startFailureScreen("spawn", cause))
      return
    }
    run.term = term
    if (interactive) run.shellProcess = term.process
    runs.set(id, run)
    trimReplay(run)
    term.onData((chunk) => {
      run.buffer += chunk
      run.bufferBytes += Buffer.byteLength(chunk)
      trimReplay(run)
      run.lastOutputAt = now()
      watchForPrompt(id, run, chunk)
      for (const listener of run.dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
    })
    term.onExit(({ exitCode }) => {
      run.exited = true
      run.exitCode = exitCode
      clearTimeout(run.promptTimer)
      // A run replaced by restart() has already been swapped out of the map; its outcome is history.
      if (runs.get(id) === run && !shuttingDown) {
        deps.storage.recordTerminalExit(id, { exitedAtMs: now(), exitCode, stopped: run.stopRequested })
        deps.onChange()
      }
      for (const listener of run.exitListeners) { try { listener(exitCode) } catch { /* ignore */ } }
      run.exitListeners.clear()
      settle()
    })
  }

  // Output moves the prompt clock: a write clears a prompt the board is showing (the human answered, or
  // the program carried on), and a write that leaves the cursor on an unterminated line re-arms the quiet
  // timer. Only a CHANGE reaches the board, so a chatty dev server costs a clearTimeout per chunk.
  //
  // EXCEPT THE ECHO OF AN ANSWER BEING TYPED. The human typing `123456` into "Enter one-time password: "
  // makes the pty echo each digit onto the same line — output, but not the program moving on. Clearing on
  // it (as this did at first) took the prompt away at the first keystroke: the card's live screen, which
  // is drawn only while the terminal waits, unmounted under the human's cursor and ate the rest of the
  // answer (seen on the real stack, 2026-09-29: the pty received "12"). So a write that follows a
  // keystroke, stays on the prompt's line and still ends on it keeps the prompt up; the Enter that ends
  // the answer puts a newline on the screen, and that clears it.
  //
  // Never for an interactive shell: it sits at its own prompt by design, and would queue its thread the
  // moment it opened.
  function watchForPrompt(id: string, run: Run, chunk: string): void {
    if (run.interactive) return
    clearTimeout(run.promptTimer)
    if (run.promptShown) {
      const echo = run.lastInputAt !== undefined && now() - run.lastInputAt <= ECHO_WINDOW_MS && !chunk.includes("\n") && endsOnPrompt(run.buffer)
      if (echo) return
      run.promptShown = false
      run.promptSince = undefined
      if (runs.get(id) === run) deps.onChange()
    }
    if (!endsOnPrompt(run.buffer)) return
    run.promptTimer = setTimeout(() => {
      if (run.exited || runs.get(id) !== run || !endsOnPrompt(run.buffer)) return
      run.promptShown = true
      run.promptSince = now()
      deps.onChange()
    }, inputQuietMs)
    run.promptTimer.unref?.()
  }

  // The pty's child leads its own session (node-pty setsid()s it), so its pid is also its process
  // GROUP: signalling -pid reaches `npm` AND the node it forked, which signalling the shell alone would
  // orphan still holding the port.
  function signalGroup(run: Run, signal: NodeJS.Signals): void {
    const term = run.term
    if (!term) return
    if (process.platform === "win32") {
      try { term.kill() } catch { /* already gone */ }
      return
    }
    try {
      process.kill(-term.pid, signal)
    } catch {
      try { term.kill(signal) } catch { /* already gone */ }
    }
  }

  async function stopRun(run: Run | undefined): Promise<void> {
    if (!run || run.exited) return
    run.stopRequested = true
    signalGroup(run, "SIGTERM")
    let timer: NodeJS.Timeout | undefined
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (!run.exited) signalGroup(run, "SIGKILL")
        resolve()
      }, stopGraceMs)
      timer.unref?.()
    })
    await Promise.race([run.exitedPromise, killed])
    clearTimeout(timer)
    await run.exitedPromise
  }

  function view(row: ThreadTerminalRow): ThreadTerminal {
    const run = runs.get(row.slug)
    const running = run !== undefined && !run.exited && row.exited_at === null
    // The flag is kept exact by watchForPrompt — set only after the quiet window, cleared synchronously by
    // any write that moves past the prompt — and the screen is checked too, so a view built at any moment
    // shows a prompt only while the screen still ends on one.
    const awaitingInput = running && !run.interactive && run.promptShown && endsOnPrompt(run.buffer)
    return {
      id: row.slug,
      command: row.command,
      ...(row.shell === 1 ? { shell: true } : {}),
      cwd: row.cwd ?? "",
      state: running ? "running" : "exited",
      ...(awaitingInput ? { awaitingInput: true, awaitingSince: new Date(run.promptSince ?? run.lastOutputAt).toISOString() } : {}),
      runId: row.runs,
      startedAt: new Date(row.started_at).toISOString(),
      ...(running || row.exited_at === null ? {} : { exitedAt: new Date(row.exited_at).toISOString() }),
      ...(!running && row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.stopped === 1 ? { stopped: true } : {}),
    }
  }

  // Every stop at once: a thread with two dev servers should not wait out one grace, then the other.
  async function stopThread(parent: string): Promise<void> {
    const mine = [...rows().values()].filter((row) => row.parent_slug === parent)
    await Promise.all(mine.map((row) => stopRun(runs.get(row.slug))))
  }

  function requireRow(id: string): ThreadTerminalRow & { parent_slug: string } {
    const row = rows().get(id)
    if (!row) throw new Error(`no terminal ${id}`)
    if (!row.cwd) throw new Error(`terminal ${id} has no folder to run in`)
    return row
  }

  return {
    async start({ parent, command, cwd }) {
      const id = `term-${randomBytes(6).toString("hex")}`
      const line = command?.trim() || undefined
      deps.storage.insertThreadTerminal({ slug: id, parentSlug: parent, command: line ?? shellLabel(env), cwd, shell: line === undefined, createdAtMs: now() })
      try {
        await spawn(id, { command: line, cwd })
      } finally {
        deps.onChange()
      }
      return { id }
    },
    async restart(id) {
      const row = requireRow(id)
      const previous = runs.get(id)
      // Take the old run out of the map BEFORE stopping it, so its exit is not recorded over the new
      // run's row, and its viewers close on the old terminal while the browser remounts the new one.
      runs.delete(id)
      await stopRun(previous)
      deps.storage.restartThreadTerminal(id, now())
      try {
        await spawn(id, { command: row.shell === 1 ? undefined : row.command, cwd: row.cwd! })
      } finally {
        deps.onChange()
      }
    },
    async run(id, command) {
      const row = requireRow(id)
      const previous = runs.get(id)
      runs.delete(id) // before the stop, for the same reason as restart
      await stopRun(previous)
      const screen = followUpScreen(previous && { command: row.command, buffer: previous.buffer, echoed: previous.echoed, interactive: previous.interactive }, command)
      deps.storage.restartThreadTerminal(id, now(), command)
      try {
        await spawn(id, { command, cwd: row.cwd! }, screen)
      } finally {
        deps.onChange()
      }
    },
    async stop(id) {
      await stopRun(runs.get(id))
    },
    async remove(id) {
      const run = runs.get(id)
      runs.delete(id)
      deps.storage.dropThreadTerminal(id)
      deps.onChange()
      await stopRun(run)
    },
    stopThread,
    async closeThread(parent) {
      // The rows are filed away only after every stop, so nothing live is ever listed as closed.
      await stopThread(parent)
      if (deps.storage.archiveThreadTerminals(parent) > 0) deps.onChange()
    },
    async forgetThread(parent) {
      await stopThread(parent)
      const mine = [...rows().values()].filter((row) => row.parent_slug === parent)
      for (const row of mine) runs.delete(row.slug)
      if (deps.storage.dropThreadTerminals(parent) > 0) deps.onChange()
    },
    live(parent) {
      return [...rows().values()].filter((row) => row.parent_slug === parent).map(view)
        .filter((t) => t.state === "running" && !shellIdle(runs.get(t.id)))
    },
    attach(id) {
      if (!rows().has(id)) return null
      const run = runs.get(id)
      // A row with no run in memory (interrupted by a restart): attachable, but there is nothing to show.
      if (!run) {
        return {
          replay: () => "",
          onData: () => () => {},
          write: () => {},
          resize: () => {},
          onExit: (listener) => { queueMicrotask(() => listener()); return () => {} },
          close: () => {},
        }
      }
      return {
        replay: () => run.buffer,
        onData: (listener) => {
          run.dataListeners.add(listener)
          return () => run.dataListeners.delete(listener)
        },
        write: (data) => {
          if (run.exited || !run.term) return
          run.lastInputAt = now()
          try { run.term.write(data) } catch { /* died mid-write */ }
        },
        resize: (cols, rows) => { if (!run.exited && run.term) { try { run.term.resize(cols, rows) } catch { /* ignore */ } } },
        onExit: (listener) => {
          // DEFERRED for a finished run: the transport delivers the replay in a microtask queued when
          // it subscribed to data, and an exit reported synchronously here would close the viewer
          // before that replay went out — the last screen of a failed build (or of a terminal that
          // could not load node-pty) is exactly what the human opened it to read.
          if (run.exited) { queueMicrotask(() => listener(run.exitCode)); return () => {} }
          run.exitListeners.add(listener)
          return () => run.exitListeners.delete(listener)
        },
        close: () => { /* detaching a viewer never touches the process — another tab may be watching */ },
      }
    },
    has(id) {
      return rows().has(id)
    },
    byThread() {
      const out = new Map<string, ThreadTerminal[]>()
      for (const row of rows().values()) {
        // Filed away with its thread (Mark as done). Restart, or a follow-up line, reopens it.
        if (row.state === "archived") continue
        const list = out.get(row.parent_slug) ?? []
        list.push(view(row))
        out.set(row.parent_slug, list)
      }
      return out
    },
    shutdown() {
      shuttingDown = true
      for (const run of runs.values()) {
        clearTimeout(run.promptTimer)
        if (!run.exited) signalGroup(run, "SIGHUP")
      }
      runs.clear()
    },
  }
}
