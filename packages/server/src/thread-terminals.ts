import { randomBytes } from "node:crypto"
import { basename } from "node:path"
import { THREAD_HANDLE_MAX_CHARS, terminalOutcome, type ThreadTerminal, type ThreadView } from "@ntwine/shared"
import type { ThreadTerminalRow, Storage } from "./storage.ts"
import type { TerminalAttachment } from "./terminal.ts"
import { launchEnvironment } from "./backend/worker-env.ts"
import { classifyUnownedTerminalHosts, type TerminalExitRecord, type TerminalHost } from "./backend/terminal-host.ts"
import { ANSI_RE, createPtySession, finishedProcess, loadNodePty, type SpawnPty, type TerminalExit, type TerminalProcess } from "./terminal-session.ts"

export { endsOnPrompt, loadNodePty } from "./terminal-session.ts"

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
// its pin and snooze — lives in SQLite. The PROCESS lives in a detached terminal
// daemon (backend/terminal-daemon.ts, forked by backend/terminal-host.ts), one per run, in its own
// process group: replacing the control plane (Restart ntwine, an update, a crash) only detaches it, and
// the next server adopts it at boot with its screen and prompt state intact. A run that ended while no
// server was listening left an exit record beside the daemon's, and boot files it with its real code.
// Only a run with NEITHER a live daemon nor an exit record — its daemon was killed outright, or the run
// was a server child (below) — reads as interrupted, and the strip offers Restart.
//
// The pty is a child of THIS process instead when there is no host (Windows, where the detached daemon
// is unverified; tests that do not pass one) or the daemon could not be forked. That path is the
// pre-2026-10-15 behaviour, kept whole: a restart hangs those up and boot marks them interrupted.
// Both paths run the same terminal-session.ts, so the board cannot tell them apart while they run.

// The code a run that never got a process records — a shell's own "command not found" code, so the
// strip reads it as a failure rather than a success or an interruption.
const START_FAILED_EXIT = 127
// How often the host audit looks for daemons the board no longer has a row for.
const HOST_AUDIT_INTERVAL_MS = 60_000

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
  /** Server shutdown: detach every hosted run (it keeps running) and hang up every in-process one. */
  shutdown(): void
}

interface Run {
  /** The run's pty wherever it lives — in its daemon, or in this process — or a finished stand-in. */
  proc: TerminalProcess
  /** The replay already opens with this run's own `$ command` line — a follow-up run, whose screen
   *  carries its predecessors' (followUpScreen). A first run's command is the drawer's title instead. */
  echoed: boolean
  /** An interactive shell sits at its own prompt by design; the input heuristic must never read it. */
  interactive: boolean
  /** Its pty lives in a daemon, whose exit record the runner drops once it filed the exit. */
  hosted: boolean
}

/** An interactive shell with nothing running in it: the pty's FOREGROUND process is still the shell it
 *  spawned. node-pty reads that off the terminal's foreground process group (measured on Linux 2026-09-29:
 *  "/bin/bash" at the prompt, "sleep" / "vim" while one runs, back to "/bin/bash" after), so a `npm run dev`
 *  typed into the shell reads busy and a bare prompt reads idle. Mark as done still stops an idle shell —
 *  it just is not work worth a confirmation. On Windows node-pty reports the spawned file whatever runs,
 *  so a shell there always reads idle. (terminal-session.ts reads it; a daemon reports each change.) */
function shellIdle(run: Run | undefined): boolean {
  return run !== undefined && run.interactive && run.proc.shellIdle()
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
  /** Where each run's pty lives. Absent ⇒ in this process (see the header). Production passes the
   *  project's detached terminal host on every platform it is verified on. */
  host?: TerminalHost
  /** Where the host audit and a host fallback are reported. */
  log?: (message: string) => void
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

/** The screen an exit record leaves: the run's last screen, or why it never got a process. */
function exitScreen(exit: TerminalExitRecord): string {
  return exit.startFailure ? exit.screen + startFailureScreen(exit.startFailure.what, exit.startFailure.message) : exit.screen
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
  const host = deps.host
  const runs = new Map<string, Run>()
  let shuttingDown = false

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

  function recordExit(id: string, exit: TerminalExit, exitedAtMs = now()): void {
    deps.storage.recordTerminalExit(id, { exitedAtMs, exitCode: exit.exitCode ?? null, ...(exit.signal ? { signal: exit.signal } : {}), stopped: exit.stopped })
  }

  /** Hold a run and file its end. An exit is filed only while this run is still the terminal's current
   *  one (a run replaced by restart() is history) and the server is not going away; a hosted run's exit
   *  record is dropped once filed, or once nothing will ever file it — never before, so a server that
   *  dies in between still finds it at boot. */
  function hold(id: string, run: Run): void {
    runs.set(id, run)
    run.proc.onChange(() => { if (runs.get(id) === run) deps.onChange() })
    const filed = (exit: TerminalExit): void => {
      const current = runs.get(id) === run
      if (current && shuttingDown) return
      if (current) {
        recordExit(id, exit)
        deps.onChange()
      }
      if (run.hosted) host?.consumeExit(id)
    }
    if (run.proc.exit) filed(run.proc.exit)
    else run.proc.onExit(filed)
  }

  // A run that never got a process: exited from birth, its screen the reason, its row a failure.
  function failRun(id: string, screen: string, interactive: boolean): void {
    const exit = { exitCode: START_FAILED_EXIT, stopped: false }
    runs.set(id, { proc: finishedProcess(screen, exit), echoed: false, interactive, hosted: false })
    recordExit(id, exit)
  }

  async function spawn(id: string, row: { command: string | undefined; cwd: string }, screen?: string): Promise<void> {
    const interactive = row.command === undefined
    const echoed = screen !== undefined
    const { file, args } = commandShell(row.command, env)
    const ptyEnv = commandEnvironment(env)
    if (host) {
      const runId = rows().get(id)?.runs ?? 1
      try {
        const outcome = await host.start({ id, runId, file, args, cwd: row.cwd, env: ptyEnv, interactive, echoed, ...(screen === undefined ? {} : { screen }), cols: 120, rows: 30 })
        if ("finished" in outcome) {
          // Over before the handshake: a start failure, or a command quicker than it.
          const exit = outcome.finished
          if (exit.startFailure) {
            failRun(id, exitScreen(exit), interactive)
            host.consumeExit(id)
          } else {
            hold(id, { proc: finishedProcess(exit.screen, exit), echoed, interactive, hosted: true })
          }
          return
        }
        hold(id, { proc: outcome.process, echoed, interactive, hosted: true })
        return
      } catch (cause) {
        // LAST RESORT, and deliberately not a failure: the daemon buys restart survival, and a daemon
        // that cannot start must cost that property, never the terminal itself.
        deps.log?.(`terminal ${id}: the terminal daemon did not start (${(cause as Error).message}); running it in the server, where a restart will hang it up`)
      }
    }
    let spawnPty: SpawnPty
    try {
      spawnPty = await loadPty()
    } catch (cause) {
      failRun(id, (screen ?? "") + startFailureScreen("load", cause), interactive)
      return
    }
    let session
    try {
      const term = spawnPty(file, args, { name: "xterm-256color", cwd: row.cwd, env: ptyEnv, cols: 120, rows: 30 })
      session = createPtySession(term, {
        interactive,
        ...(screen === undefined ? {} : { screen }),
        now,
        ...(deps.inputQuietMs === undefined ? {} : { inputQuietMs: deps.inputQuietMs }),
        ...(deps.stopGraceMs === undefined ? {} : { stopGraceMs: deps.stopGraceMs }),
      })
    } catch (cause) {
      failRun(id, (screen ?? "") + startFailureScreen("spawn", cause), interactive)
      return
    }
    hold(id, { proc: session, echoed, interactive, hosted: false })
  }

  // ── Boot: what was running when the last server went away ──────────────────────────────────────
  // With a host, each run that the last server saw start and never saw end is one of three things: its
  // daemon is alive (adopt it — the process never noticed the restart), its daemon recorded the end
  // (file that, code and all), or neither (interrupted). Without one, every such run was a child of the
  // last server and went with it.
  if (!host) {
    deps.storage.interruptRunningTerminals(now())
  } else {
    const open = new Set<string>()
    for (const row of rows().values()) {
      if (row.exited_at !== null) continue
      const interactive = row.shell === 1
      const exit = host.exitOf(row.slug, row.runs)
      if (exit) {
        const at = Date.parse(exit.at)
        runs.set(row.slug, { proc: finishedProcess(exitScreen(exit), exit), echoed: false, interactive, hosted: true })
        recordExit(row.slug, exit, Number.isFinite(at) ? at : now())
        host.consumeExit(row.slug)
        continue
      }
      const proc = host.adopt(row.slug, row.runs)
      if (proc) {
        hold(row.slug, { proc, echoed: proc.echoed, interactive, hosted: true })
        open.add(row.slug)
        continue
      }
      recordExit(row.slug, { stopped: false })
    }
    // An exit record no open run will ever claim (its row was forgotten, or already filed).
    for (const id of host.exitIds()) if (!open.has(id)) host.consumeExit(id)
  }

  // ── The host audit: a daemon the board no longer expects is ended (terminal-host.ts) ──────────────
  function auditHosts(): void {
    if (!host || shuttingDown) return
    let expected: Map<string, { runId: number; running: boolean }>
    try {
      expected = new Map([...rows().values()].map((row) => [row.slug, { runId: row.runs, running: row.exited_at === null }]))
    } catch {
      return // no board to compare against ⇒ end nothing
    }
    for (const entry of classifyUnownedTerminalHosts({ daemons: host.live(), rows: expected, nowMs: now() })) {
      if (runs.get(entry.id)?.hosted && !runs.get(entry.id)?.proc.exit) continue // ours and live: never
      if (host.end(entry.id)) deps.log?.(`terminal ${entry.id}: ended its daemon (pid ${entry.daemonPid}): ${entry.reason === "no-row" ? "no terminal row claims it" : entry.reason === "other-run" ? "its row is on another run" : "its row's run is over"}`)
    }
  }
  let auditTimer: NodeJS.Timeout | undefined
  if (host) {
    auditHosts()
    auditTimer = setInterval(auditHosts, HOST_AUDIT_INTERVAL_MS)
    auditTimer.unref?.()
  }

  async function stopRun(run: Run | undefined): Promise<void> {
    await run?.proc.stop()
  }

  function view(row: ThreadTerminalRow): ThreadTerminal {
    const run = runs.get(row.slug)
    const running = run !== undefined && !run.proc.exit && row.exited_at === null
    // Exact by construction (terminal-session.ts): set only after the quiet window, cleared by any write
    // that moves past the prompt, and checked against the screen, so a view built at any moment shows a
    // prompt only while the screen still ends on one.
    const awaitingSince = running && !run.interactive ? run.proc.awaitingSince() : undefined
    return {
      id: row.slug,
      command: row.command,
      ...(row.shell === 1 ? { shell: true } : {}),
      cwd: row.cwd ?? "",
      state: running ? "running" : "exited",
      ...(awaitingSince !== undefined ? { awaitingInput: true, awaitingSince: new Date(awaitingSince).toISOString() } : {}),
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
      const screen = followUpScreen(previous && { command: row.command, buffer: previous.proc.replay(), echoed: previous.echoed, interactive: previous.interactive }, command)
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
      return plainScreen(run.proc.replay().slice(-maxChars * 4)).replace(/\s+$/, "").slice(-maxChars)
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
      const { proc } = run
      return {
        replay: () => proc.replay(),
        onData: (listener) => proc.onData(listener),
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        onExit: (listener) => {
          // DEFERRED for a finished run: the transport delivers the replay in a microtask queued when
          // it subscribed to data, and an exit reported synchronously here would close the viewer
          // before that replay went out — the last screen of a failed build (or of a terminal that
          // could not load node-pty) is exactly what the human opened it to read.
          const exit = proc.exit
          if (exit) { queueMicrotask(() => listener(exit.exitCode)); return () => {} }
          return proc.onExit((ended) => listener(ended.exitCode))
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
      // The server is going away. A hosted run is only DETACHED — it keeps running, and the next server
      // adopts it — while an in-process one is hung up with this process.
      shuttingDown = true
      for (const timer of snoozeTimers.values()) clearTimeout(timer)
      snoozeTimers.clear()
      clearInterval(auditTimer)
      for (const run of runs.values()) run.proc.release()
      runs.clear()
    },
  }
}
