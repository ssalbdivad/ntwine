import { randomBytes } from "node:crypto"
import { basename } from "node:path"
import type { IPty, IPtyForkOptions } from "node-pty"
import { THREAD_HANDLE_MAX_CHARS, terminalOutcome, type ThreadTerminal, type ThreadView } from "@ntwine/shared"
import type { ThreadTerminalRow, Storage } from "./storage.ts"
import type { TerminalAttachment } from "./terminal.ts"
import { launchEnvironment } from "./backend/worker-env.ts"

// TERMINAL THREADS — a live pty a human or an agent started, and a thread of its own (plans/terminal-threads.md,
// maintainer 2026-10-15): a row in one of the six bands, a card when it needs the human, its own drawer and an
// `@handle` minted from its command. It is started from anywhere — a top-level `$ cmd` in the prompt box (no
// parent, in the folder the box's picker names), or `t` / Open terminal / a `$ cmd` line in a thread's box,
// which make it a CHILD of that thread (`parent_slug`) running where that thread's agent works (thread-cwd.ts).
// A child shows in its parent's strip as a link to its own row; it does NOT end with its parent, because a
// dev server is meant to outlive the effort that started it — the parent's Done dialog offers to stop it.
//
// ITS BAND IS ITS PROCESS'S STATE (shared terminalOutcome): running → Working; at a prompt, failed by itself,
// or interrupted by a restart → Ready; exit 0, Stop, Ctrl-C, or the end of an interactive shell → Done. The
// last is DERIVED here, not written on exit, so every path that records an exit (the live runner, a host that
// reports one after a restart) files the run the same way. (History: a top-level command thread from
// 2026-09-23, reversed on 2026-09-29 into a terminal hanging off a thread, reversed back on 2026-10-15.)
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
// WHAT IS DURABLE AND WHAT IS NOT. The row — the command, the folder, who started it, how its last run ended,
// its pin and snooze — lives in SQLite. The process does not: a pty is a child of this server, and replacing
// the control plane (Restart ntwine, an update) hangs it up. Boot records every run that never reported an
// exit as interrupted, so the row says "interrupted" and offers Restart rather than showing a process that is
// not there.

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
  /** The thread it was started from, when it was. */
  parent?: string
  /** `human`, or the slug of the thread whose agent started it. */
  startedBy: string
  /** Handles already taken by other threads (their names), so this one's gets a suffix rather than a clash. */
  takenHandles?: Iterable<string>
  /** One line of shell, run under the login shell. Absent ⇒ an interactive login shell. */
  command?: string
  /** Absolute, existing directory — the caller resolved and checked it (thread-cwd.ts). */
  cwd: string
}

export interface TerminalRunner {
  start(input: StartTerminalInput): Promise<{ id: string; handle: string }>
  /** A fresh run of a terminal's command (or shell): stops the current run first if it is alive. */
  restart(id: string): Promise<void>
  /** The terminal's NEXT command, typed into its drawer once a run finished — a shell's next line.
   *  Stops a live run first, like restart; unlike restart the screen carries on (see `followUpScreen`). */
  run(id: string, command: string): Promise<void>
  /** SIGTERM the run's whole process group, SIGKILL it if it outlives the grace. */
  stop(id: string): Promise<void>
  /** Stop, then forget the terminal entirely. */
  remove(id: string): Promise<void>
  /** Stop these terminals together, not one grace after another — the Done dialog's ticked boxes. */
  stopMany(ids: readonly string[]): Promise<void>
  /** Mark as done (`archived`, stopping a live run first) or reopen (`open`) a terminal thread. */
  setState(id: string, state: "open" | "archived"): Promise<void>
  /** Pin (an ISO instant) or unpin (null). */
  setPinned(id: string, at: string | null): void
  /** A human snooze to an ISO instant, or null to wake it. Refused on a running terminal by the caller. */
  setSnooze(id: string, until: string | null): void
  /** The parent's Done dialog's list: the terminals it started still running something — alive, and not
   *  an interactive shell idle at its own prompt (`shellIdle`). */
  live(parent: string): ThreadTerminal[]
  /** The run's screen so far, escape sequences dropped — `read-thread`'s answer for a terminal. */
  screenTail(id: string, maxChars?: number): string
  /** The /term transport's gate: non-null iff this id is one of this project's terminals. */
  attach(id: string): TerminalAttachment | null
  has(id: string): boolean
  /** Every terminal not yet Done, grouped by the thread it was started from — the parent's strip. */
  byThread(): Map<string, ThreadTerminal[]>
  /** Every terminal thread with its process — what the board draws as rows. */
  terminals(): { row: ThreadTerminalRow; terminal: ThreadTerminal }[]
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
    ? "ntwine could not start this terminal: the node-pty native module did not load."
    : "ntwine could not start this terminal: the shell did not spawn."
  const hint = what === "load"
    ? `\r\n\r\nTerminals need node-pty's prebuilt binary for ${process.platform}-${process.arch}.\r\nEverything else in ntwine works without it.`
    : ""
  return `\x1b[31m${head}\x1b[0m\r\n\r\n\x1b[2m${detail}\x1b[22m${hint}\r\n`
}

export interface TerminalRunnerDeps {
  storage: Pick<Storage,
    "insertThreadTerminal" | "listThreadTerminals" | "restartThreadTerminal" | "recordTerminalExit" |
    "interruptRunningTerminals" | "dropThreadTerminal" | "setThreadTerminalState" | "setThreadTerminalPin" |
    "setThreadTerminalSnooze" | "setThreadTerminalHandle">
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
 *  running server's own project, state dir and log — a `npm run dev` of ntwine itself inside ntwine would
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

// How many of a command's words its handle keeps: `nub run dev` is the whole of it, and a long line's first
// three words still say which program it is (`printf 'Continue? '; read x` → `printf-continue-read`).
const HANDLE_WORDS = 3

/**
 * A terminal's `@handle`, from its command (plans/terminal-threads.md § The model): `$ nub run dev` →
 * `nub-run-dev`, a bare shell `shell`, its first words kebab-cased as a thread's name is (shared threadHandle)
 * and held to a thread handle's length at a word boundary. A handle another thread already carries gets the
 * first free `-2`, `-3`, … suffix, so `@nub-run-dev` always names one thing.
 */
export function terminalHandle(command: string | undefined, taken: Iterable<string> = []): string {
  // A program named by its path is named by its file: `./node_modules/.bin/vite --port 3000` → `vite-port-3000`.
  const tokens = command === undefined ? [] : command.trim().split(/\s+/)
  if (tokens[0]) tokens[0] = tokens[0].slice(tokens[0].lastIndexOf("/") + 1)
  const words = tokens.join(" ").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  let base = ""
  for (const word of words.slice(0, HANDLE_WORDS)) {
    const next = base ? `${base}-${word}` : word
    if (next.length > THREAD_HANDLE_MAX_CHARS) break
    base = next
  }
  if (!base) base = words[0]?.slice(0, THREAD_HANDLE_MAX_CHARS) || (command === undefined ? "shell" : "terminal")
  const used = new Set([...taken].map((h) => h.toLowerCase()))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

/** The text of a screen: escape sequences dropped, and on each line only what the last carriage return left
 *  (a progress bar's final frame, not every frame). */
export function plainScreen(screen: string): string {
  return screen.replace(ANSI_RE, "").split("\n").map((line) => {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line
    return bare.slice(bare.lastIndexOf("\r") + 1)
  }).join("\n")
}

/**
 * A terminal thread's row, as the board lists it. Its band is its process's state (shared terminalOutcome):
 * it is queued (`needsYou`) at a prompt, after a failure and after an interruption, and Done (`archived`) when
 * the human marked it so or it finished cleanly. A human snooze to a time parks a Ready one; a running one
 * cannot be snoozed (router), and a snooze ends at its next exit (storage recordTerminalExit).
 */
export function terminalThreadView(row: Pick<ThreadTerminalRow, "slug" | "state" | "created_at" | "pinned_at" | "snoozed_until">, terminal: ThreadTerminal, nowMs = Date.now()): ThreadView {
  const outcome = terminalOutcome(terminal)
  const archived = row.state === "archived" || outcome === "finished"
  const snoozedUntil = row.snoozed_until && Date.parse(row.snoozed_until) > nowMs && outcome !== "running" ? row.snoozed_until : undefined
  const ready = !archived && (outcome === "prompt" || outcome === "failed" || outcome === "interrupted")
  // The instant it last changed state: what the row's age and the queue's order read.
  const at = terminal.awaitingSince ?? terminal.exitedAt ?? terminal.startedAt
  return {
    id: row.slug,
    title: terminal.command,
    status: "active", // required by the shape, unused — as on every row that is not a legacy file
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    // `turn-idle` at a prompt so a Ready terminal is at rest (it can be snoozed); `running` only while it moves.
    runtime: outcome === "running" ? "running" : outcome === "prompt" ? "turn-idle" : "exited",
    unread: false,
    archived,
    spawnedAt: new Date(row.created_at).toISOString(),
    lastActivityAt: at,
    lastUserAt: terminal.startedAt,
    subAgents: [],
    bgShells: [],
    watches: [],
    pendingQuestion: false,
    questions: [],
    kind: "terminal",
    // Its slug stands in for a session id: the human's verbs (pin, snooze, Mark as done) carry one, and the
    // router answers a terminal by its slug before it looks for a session.
    sessionId: row.slug,
    terminal,
    state: archived ? "archived" : "open",
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
    needsYou: ready && snoozedUntil === undefined,
  } as ThreadView
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

  // Every row is a terminal thread — a 2026-09-23 command thread included, archived, as the record it is.
  function rows(): Map<string, ThreadTerminalRow> {
    return new Map(deps.storage.listThreadTerminals().map((row) => [row.slug, row]))
  }

  // A row migrated from a thread's terminal (storage.ts, 2026-10-15) has no handle yet: mint it once.
  {
    const taken: string[] = []
    for (const row of rows().values()) if (row.handle) taken.push(row.handle)
    for (const row of rows().values()) {
      if (row.handle) continue
      const handle = terminalHandle(row.shell === 1 ? undefined : row.command, taken)
      deps.storage.setThreadTerminalHandle(row.slug, handle)
      taken.push(handle)
    }
  }

  // A snooze ends at its time: the board has to be told then, since nothing else changes at that instant.
  const snoozeTimers = new Map<string, NodeJS.Timeout>()
  function armSnooze(id: string, until: string | null | undefined): void {
    clearTimeout(snoozeTimers.get(id))
    snoozeTimers.delete(id)
    const ms = Date.parse(until ?? "") - now()
    if (!Number.isFinite(ms) || ms <= 0) return
    // setTimeout's own ceiling is ~24.8 days; a longer snooze re-arms on the next board change anyway.
    const timer = setTimeout(() => { snoozeTimers.delete(id); deps.onChange() }, Math.min(ms + 50, 2 ** 31 - 1))
    timer.unref?.()
    snoozeTimers.set(id, timer)
  }
  for (const row of rows().values()) armSnooze(row.slug, row.snoozed_until)

  /** The handles open terminal threads carry, beside whatever the caller says is taken. */
  function openHandles(): string[] {
    return [...rows().values()].filter((row) => row.state !== "archived" && row.handle).map((row) => row.handle!)
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
    term.onExit(({ exitCode, signal }) => {
      run.exited = true
      run.exitCode = exitCode
      clearTimeout(run.promptTimer)
      // A run replaced by restart() has already been swapped out of the map; its outcome is history.
      if (runs.get(id) === run && !shuttingDown) {
        deps.storage.recordTerminalExit(id, { exitedAtMs: now(), exitCode, ...(signal ? { signal } : {}), stopped: run.stopRequested })
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
      ...(!running && row.exit_signal ? { signal: row.exit_signal } : {}),
      ...(row.parent_slug ? { parent: row.parent_slug } : {}),
      ...(row.started_by ? { startedBy: row.started_by } : {}),
      ...(row.handle ? { handle: row.handle } : {}),
    }
  }

  /** Done as the board files it: marked so, or finished cleanly (see terminalThreadView). */
  function done(row: ThreadTerminalRow): boolean {
    return row.state === "archived" || terminalOutcome(view(row)) === "finished"
  }

  // Every stop at once: two dev servers should not wait out one grace, then the other.
  async function stopMany(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => stopRun(runs.get(id))))
  }

  function knownRow(id: string): ThreadTerminalRow {
    const row = rows().get(id)
    if (!row) throw new Error(`no terminal ${id}`)
    return row
  }

  function requireRow(id: string): ThreadTerminalRow {
    const row = rows().get(id)
    if (!row) throw new Error(`no terminal ${id}`)
    if (!row.cwd) throw new Error(`terminal ${id} has no folder to run in`)
    return row
  }

  return {
    async start({ parent, startedBy, takenHandles = [], command, cwd }) {
      const id = `term-${randomBytes(6).toString("hex")}`
      const line = command?.trim() || undefined
      const handle = terminalHandle(line, [...openHandles(), ...takenHandles])
      deps.storage.insertThreadTerminal({ slug: id, parentSlug: parent ?? null, startedBy, handle, command: line ?? shellLabel(env), cwd, shell: line === undefined, createdAtMs: now() })
      try {
        await spawn(id, { command: line, cwd })
      } finally {
        deps.onChange()
      }
      return { id, handle }
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
    stopMany,
    async setState(id, state) {
      knownRow(id)
      // Mark as done on a running terminal stops it first (SIGTERM, SIGKILL past the grace), so nothing live
      // is ever filed under Done.
      if (state === "archived") await stopRun(runs.get(id))
      if (state === "archived") armSnooze(id, null)
      if (deps.storage.setThreadTerminalState(id, state)) deps.onChange()
    },
    setPinned(id, at) {
      knownRow(id)
      if (deps.storage.setThreadTerminalPin(id, at)) deps.onChange()
    },
    setSnooze(id, until) {
      knownRow(id)
      if (deps.storage.setThreadTerminalSnooze(id, until)) {
        armSnooze(id, until)
        deps.onChange()
      }
    },
    screenTail(id, maxChars = 8_000) {
      const run = runs.get(id)
      if (!run) return ""
      return plainScreen(run.buffer.slice(-Math.max(maxChars * 4, PROMPT_TAIL_CHARS))).replace(/\s+$/, "").slice(-maxChars)
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
        // Done (marked so, or finished cleanly) leaves the parent's strip; it is in Done on its own row.
        if (!row.parent_slug || done(row)) continue
        const list = out.get(row.parent_slug) ?? []
        list.push(view(row))
        out.set(row.parent_slug, list)
      }
      return out
    },
    terminals() {
      return [...rows().values()].map((row) => ({ row, terminal: view(row) }))
    },
    shutdown() {
      shuttingDown = true
      for (const timer of snoozeTimers.values()) clearTimeout(timer)
      snoozeTimers.clear()
      for (const run of runs.values()) {
        clearTimeout(run.promptTimer)
        if (!run.exited) signalGroup(run, "SIGHUP")
      }
      runs.clear()
    },
  }
}
