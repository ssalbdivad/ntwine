import { randomBytes } from "node:crypto"
import pty from "node-pty"
import type { CommandThreadState, ThreadView } from "@frizz/shared"
import type { CommandThreadRow, Storage } from "./storage.ts"
import type { LoginAttachment } from "./login-utility.ts"

// TERMINAL COMMAND THREADS — the prompt box's Terminal tab. The human types `npm run dev`, and instead
// of dispatching an agent Frizz runs that command in a pty in the project directory and puts it on the
// board as its own row, whose drawer IS the live terminal.
//
// The pty rides the same hardened /term/<slug> transport as the sign-in terminal (terminal.ts), and is
// modelled on that utility's shape for the same reason: ONE process per thread, a bounded replay so a
// tab that opens late (or reloads) sees the screen so far, and a subscriber set so two tabs watch the
// SAME process rather than each starting one.
//
// WHAT IS DURABLE AND WHAT IS NOT. The row — the command, when it ran, how its last run ended — lives in
// SQLite, so the board keeps it across a restart. The process does not: a pty is a child of this
// server, and replacing the control plane (Restart Frizz, an update) closes the pty master and hangs the
// process up. Boot records every run that never reported an exit as interrupted, so the rail says
// "interrupted" and offers Restart rather than showing a server that is not there.
//
// NOT an agent surface, and nothing here pretends to be one: no transcript and no wake. It DOES share
// the board's lifecycle: a finished run is waiting on the human exactly like a rested thread (`needsYou`),
// and it leaves the threads band the same way, by being marked done (`state: archived`). A run that is
// still going — `npm run dev` — never queues; it sits with the running threads until it ends.
//
// ONE EXCEPTION: A RUN SITTING AT A PROMPT. `npm publish` stopping at "Enter one-time password:", an
// ssh passphrase, a `[y/N]` — the process is alive and will stay alive forever, so without this it spun
// in the running band with nothing saying it was waiting on the human (maintainer 2026-09-24: shells
// "stuck in running after some 2fa call"). See `awaitingInput`.

// How long a run must be silent, sitting on an unterminated line, before it reads as waiting for input.
// Long enough that a program between two writes of one line (a spinner frame, a slow `printf`) is not
// mistaken for a prompt; short enough that the card is up before the human has looked elsewhere.
const INPUT_QUIET_MS = 3_000
// How much of the screen's tail the prompt test reads. A prompt is one line; this only has to reach
// past whatever escape sequences a program paints after it.
const PROMPT_TAIL_CHARS = 2_048
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

// A dev server's log is long-lived and chatty; a late viewer needs the recent screen, not the banner.
// Trimmed from the FRONT, at a line boundary where one is near, so the replay starts on a clean line.
const REPLAY_CAP_BYTES = 1024 * 1024
// How long Stop waits after SIGTERM before it SIGKILLs the process group.
const STOP_GRACE_MS = 5_000

export interface CommandRunner {
  start(command: string): { slug: string }
  /** A fresh run of an existing thread's command: stops the current run first if it is alive. */
  restart(slug: string): Promise<void>
  /** The thread's NEXT command, typed into its drawer once a run finished — the terminal's follow-up
   *  prompt. Stops a live run first, like restart; unlike restart the screen carries on (see `followUpScreen`). */
  run(slug: string, command: string): Promise<void>
  /** SIGTERM the run's whole process group, SIGKILL it if it outlives the grace. */
  stop(slug: string): Promise<void>
  /** Stop, then forget the thread entirely. */
  remove(slug: string): Promise<void>
  /** The /term transport's gate: non-null iff this slug is a command thread of this project. */
  attach(slug: string): LoginAttachment | null
  has(slug: string): boolean
  threads(): ThreadView[]
  /** Server shutdown: hang up every live run. */
  shutdown(): void
}

interface Run {
  term: pty.IPty
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
  promptTimer?: NodeJS.Timeout
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

export interface CommandRunnerDeps {
  cwd: string
  storage: Pick<Storage,
    "insertCommandThread" | "listCommandThreads" | "restartCommandThread" | "recordCommandExit" |
    "interruptRunningCommandThreads" | "dropCommandThread">
  /** The board's overlay refresh — every state change is a row change. */
  onChange: () => void
  env?: NodeJS.ProcessEnv
  spawnPty?: typeof pty.spawn
  now?: () => number
  stopGraceMs?: number
  inputQuietMs?: number
}

/** The shell a command runs under, and how it is handed the line. A LOGIN shell on POSIX so the
 *  human's own PATH additions (nvm, volta, a Homebrew prefix) apply exactly as in their terminal. */
export function commandShell(command: string, env: NodeJS.ProcessEnv, platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] }
  return { file: env.SHELL || "/bin/sh", args: ["-l", "-c", command] }
}

/** The environment a command runs in: the server's, minus every FRIZZ_* variable. Those name the
 *  running server's own project, state dir and log — a `npm run dev` of Frizz itself inside Frizz would
 *  otherwise obey them and write into the live server's files. */
export function commandEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value == null || key.startsWith("FRIZZ_")) continue
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

/** The opening screen of a FOLLOW-UP run: what the thread's last run left, then the new command's line.
 *  Restart deliberately starts blank (the same command again is a fresh attempt, not the next step);
 *  a follow-up is the next line of one session — `whoami`, then `ls` — and should read as one. When the
 *  previous run was a first run, its own line is added above its output so the history starts cleanly.
 *  No previous run in memory (the server restarted since) ⇒ only the new line. */
export function followUpScreen(previous: { command: string; buffer: string; echoed: boolean } | undefined, command: string): string {
  if (!previous) return echoLine(command)
  const screen = previous.echoed ? previous.buffer : echoLine(previous.command) + previous.buffer
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

export function createCommandRunner(deps: CommandRunnerDeps): CommandRunner {
  const spawnPty = deps.spawnPty ?? pty.spawn
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS
  const inputQuietMs = deps.inputQuietMs ?? INPUT_QUIET_MS
  const runs = new Map<string, Run>()
  let shuttingDown = false

  // Whatever was running when the last server went away went with it.
  deps.storage.interruptRunningCommandThreads(now())

  function rows(): Map<string, CommandThreadRow> {
    return new Map(deps.storage.listCommandThreads().map((row) => [row.slug, row]))
  }

  function spawn(slug: string, command: string, screen?: string): void {
    const { file, args } = commandShell(command, env)
    let term: pty.IPty
    try {
      term = spawnPty(file, args, {
        name: "xterm-256color",
        cwd: deps.cwd,
        env: commandEnvironment(env),
        cols: 120,
        rows: 30,
      })
    } catch (cause) {
      // The shell itself would not start. Record it as a failed run so the row says so.
      deps.storage.recordCommandExit(slug, { exitedAtMs: now(), exitCode: 127, stopped: false })
      throw cause
    }
    let settle!: () => void
    const run: Run = {
      term,
      exited: false,
      stopRequested: false,
      buffer: screen ?? "",
      bufferBytes: screen ? Buffer.byteLength(screen) : 0,
      echoed: screen !== undefined,
      lastOutputAt: now(),
      promptShown: false,
      dataListeners: new Set(),
      exitListeners: new Set(),
      exitedPromise: new Promise<void>((resolve) => { settle = resolve }),
    }
    runs.set(slug, run)
    trimReplay(run)
    term.onData((chunk) => {
      run.buffer += chunk
      run.bufferBytes += Buffer.byteLength(chunk)
      trimReplay(run)
      run.lastOutputAt = now()
      watchForPrompt(slug, run)
      for (const listener of run.dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
    })
    term.onExit(({ exitCode }) => {
      run.exited = true
      run.exitCode = exitCode
      clearTimeout(run.promptTimer)
      // A run replaced by restart() has already been swapped out of the map; its outcome is history.
      if (runs.get(slug) === run && !shuttingDown) {
        deps.storage.recordCommandExit(slug, { exitedAtMs: now(), exitCode, stopped: run.stopRequested })
        deps.onChange()
      }
      for (const listener of run.exitListeners) { try { listener(exitCode) } catch { /* ignore */ } }
      run.exitListeners.clear()
      settle()
    })
  }

  // Output moves the prompt clock: any write clears a prompt the board is showing (the human answered,
  // or the program carried on), and a write that leaves the cursor on an unterminated line re-arms the
  // quiet timer. Only a CHANGE reaches the board, so a chatty dev server costs a clearTimeout per chunk.
  function watchForPrompt(slug: string, run: Run): void {
    clearTimeout(run.promptTimer)
    if (run.promptShown) {
      run.promptShown = false
      if (runs.get(slug) === run) deps.onChange()
    }
    if (!endsOnPrompt(run.buffer)) return
    run.promptTimer = setTimeout(() => {
      if (run.exited || runs.get(slug) !== run || !endsOnPrompt(run.buffer)) return
      run.promptShown = true
      deps.onChange()
    }, inputQuietMs)
    run.promptTimer.unref?.()
  }

  // The pty's child leads its own session (node-pty setsid()s it), so its pid is also its process
  // GROUP: signalling -pid reaches `npm` AND the node it forked, which signalling the shell alone would
  // orphan still holding the port.
  function signalGroup(run: Run, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      try { run.term.kill() } catch { /* already gone */ }
      return
    }
    try {
      process.kill(-run.term.pid, signal)
    } catch {
      try { run.term.kill(signal) } catch { /* already gone */ }
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

  function view(row: CommandThreadRow): ThreadView {
    const run = runs.get(row.slug)
    const running = run !== undefined && !run.exited && row.exited_at === null
    // Read off the run, not the timer's flag alone: the flag is what was ANNOUNCED, and a view built
    // between a write and its timer must not show a prompt the screen has already moved past.
    const awaitingInput = running && run.promptShown && now() - run.lastOutputAt >= inputQuietMs && endsOnPrompt(run.buffer)
    const command: CommandThreadState = {
      command: row.command,
      state: running ? "running" : "exited",
      ...(awaitingInput ? { awaitingInput: true } : {}),
      runId: row.runs,
      startedAt: new Date(row.started_at).toISOString(),
      ...(running || row.exited_at === null ? {} : { exitedAt: new Date(row.exited_at).toISOString() }),
      ...(!running && row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.stopped === 1 ? { stopped: true } : {}),
    }
    const startedAt = new Date(row.started_at).toISOString()
    return {
      id: row.slug,
      title: row.command,
      status: "active", // required by the shape, unused — the same as every non-legacy row
      hasPlan: false,
      mechanism: null,
      humanBlocked: false,
      ready: false,
      dependsOn: [],
      externalDeps: [],
      agents: [],
      errors: [],
      warnings: [],
      runtime: running ? "running" : "exited",
      unread: false,
      archived: row.state === "archived",
      spawnedAt: new Date(row.created_at).toISOString(),
      lastActivityAt: command.exitedAt ?? (awaitingInput ? new Date(run.lastOutputAt).toISOString() : startedAt),
      lastUserAt: startedAt,
      subAgents: [],
      bgShells: [],
      watches: [],
      pendingQuestion: false,
      questions: [],
      kind: "command",
      command,
      state: row.state,
      // A prompt queues a LIVE run: the process is waiting on the human exactly as a finished one is.
      needsYou: (!running || awaitingInput) && row.state !== "archived",
    }
  }

  return {
    start(command) {
      const slug = `term-${randomBytes(6).toString("hex")}`
      deps.storage.insertCommandThread({ slug, command, createdAtMs: now() })
      try {
        spawn(slug, command)
      } finally {
        deps.onChange()
      }
      return { slug }
    },
    async restart(slug) {
      const row = rows().get(slug)
      if (!row) throw new Error(`no terminal command ${slug}`)
      const previous = runs.get(slug)
      // Take the old run out of the map BEFORE stopping it, so its exit is not recorded over the new
      // run's row, and its viewers close on the old terminal while the browser remounts the new one.
      runs.delete(slug)
      await stopRun(previous)
      deps.storage.restartCommandThread(slug, now())
      try {
        spawn(slug, row.command)
      } finally {
        deps.onChange()
      }
    },
    async run(slug, command) {
      const row = rows().get(slug)
      if (!row) throw new Error(`no terminal command ${slug}`)
      const previous = runs.get(slug)
      runs.delete(slug) // before the stop, for the same reason as restart
      await stopRun(previous)
      const screen = followUpScreen(previous && { command: row.command, buffer: previous.buffer, echoed: previous.echoed }, command)
      deps.storage.restartCommandThread(slug, now(), command)
      try {
        spawn(slug, command, screen)
      } finally {
        deps.onChange()
      }
    },
    async stop(slug) {
      await stopRun(runs.get(slug))
    },
    async remove(slug) {
      const run = runs.get(slug)
      runs.delete(slug)
      deps.storage.dropCommandThread(slug)
      deps.onChange()
      await stopRun(run)
    },
    attach(slug) {
      if (!rows().has(slug)) return null
      const run = runs.get(slug)
      // A row with no live pty (interrupted by a restart): attachable, but there is nothing to show.
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
        write: (data) => { if (!run.exited) { try { run.term.write(data) } catch { /* died mid-write */ } } },
        resize: (cols, rows) => { if (!run.exited) { try { run.term.resize(cols, rows) } catch { /* ignore */ } } },
        onExit: (listener) => {
          // DEFERRED for a finished run: the transport delivers the replay in a microtask queued when
          // it subscribed to data, and an exit reported synchronously here would close the viewer
          // before that replay went out — the last screen of a failed build is exactly what the
          // human opened the thread to read.
          if (run.exited) { queueMicrotask(() => listener(run.exitCode)); return () => {} }
          run.exitListeners.add(listener)
          return () => run.exitListeners.delete(listener)
        },
        close: () => { /* detaching a viewer never touches the process — another tab may be watching */ },
      }
    },
    has(slug) {
      return rows().has(slug)
    },
    threads() {
      return deps.storage.listCommandThreads().map(view)
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
