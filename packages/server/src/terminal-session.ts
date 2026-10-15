import type { IPty, IPtyForkOptions } from "node-pty"

// ONE LIVE PTY AND EVERYTHING ITS VIEWERS NEED TO KNOW ABOUT IT: the replay ring, the prompt detector,
// the shell-idle reading and Stop. It is shared by the two places a terminal's pty can live:
//   - the detached terminal daemon (backend/terminal-daemon.ts), which is where it lives in production
//     on POSIX, so the run outlives an ntwine restart or update;
//   - the server process itself (thread-terminals.ts), the in-process fallback: tests, Windows (where the
//     daemon is unverified), and a daemon that could not be forked.
// Keeping it in one module is what makes the two paths read identically to the board: the same 3s rule,
// the same echo window, the same trim. node-pty is never imported here — the caller hands in a spawned
// IPty — so this module costs nothing to load on a box without the addon.

// How long a run must be silent, sitting on an unterminated line, before it reads as waiting for input.
// Long enough that a program between two writes of one line (a spinner frame, a slow `printf`) is not
// mistaken for a prompt; short enough that the card is up before the human has looked elsewhere.
export const INPUT_QUIET_MS = 3_000
// How soon after the human's keystroke a write still counts as that keystroke's ECHO. A pty echoes typed
// characters within a millisecond or two; this only has to be generous enough for a loaded machine.
const ECHO_WINDOW_MS = 1_000
// How much of the screen's tail the prompt test reads. A prompt is one line; this only has to reach
// past whatever escape sequences a program paints after it.
const PROMPT_TAIL_CHARS = 2_048
export const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

// A dev server's log is long-lived and chatty; a late viewer needs the recent screen, not the banner.
// Trimmed from the FRONT, at a line boundary where one is near, so the replay starts on a clean line.
export const REPLAY_CAP_BYTES = 1024 * 1024
// How long Stop waits after SIGTERM before it SIGKILLs the process group.
export const STOP_GRACE_MS = 5_000

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

/** A bounded screen: appends, and trims from the front once it passes REPLAY_CAP_BYTES. */
export class ReplayRing {
  private text: string
  private bytes: number
  constructor(initial = "") {
    this.text = initial
    this.bytes = Buffer.byteLength(initial)
    this.trim()
  }
  get value(): string { return this.text }
  append(chunk: string): void {
    this.text += chunk
    this.bytes += Buffer.byteLength(chunk)
    this.trim()
  }
  reset(text: string): void {
    this.text = text
    this.bytes = Buffer.byteLength(text)
    this.trim()
  }
  private trim(): void {
    while (this.bytes > REPLAY_CAP_BYTES) {
      // Cut roughly a quarter, then advance to the next newline so the replay opens on a whole line.
      let cut = Math.ceil(this.text.length / 4)
      const newline = this.text.indexOf("\n", cut)
      if (newline !== -1 && newline - cut < 4096) cut = newline + 1
      const drop = this.text.slice(0, cut)
      this.text = this.text.slice(cut)
      this.bytes -= Buffer.byteLength(drop)
    }
  }
}

export interface TerminalExit {
  /** Absent only for a run whose end nobody saw (an interrupted run). */
  exitCode?: number
  /** The signal that ended it, when one did (node-pty reports it as a number). */
  signal?: number
  /** Ended by Stop (or a teardown), not by itself. */
  stopped: boolean
}

/**
 * What the runner holds for one run, wherever its pty lives. Every reading is synchronous: the board
 * builds a view at any moment, and a run in another process mirrors its state here as it changes.
 */
export interface TerminalProcess {
  /** The screen so far (bounded). */
  replay(): string
  /** Set once the run is over; never cleared. */
  readonly exit: TerminalExit | undefined
  /** When the run sat down at a prompt, while it is still sitting at one; else undefined. */
  awaitingSince(): number | undefined
  /** An interactive shell with nothing running in it (see `shellIdle` in thread-terminals.ts). */
  shellIdle(): boolean
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: (chunk: string) => void): () => void
  /** Fires once, when the run ends. A listener added after the end is never called — read `exit`. */
  onExit(listener: (exit: TerminalExit) => void): () => void
  /** The prompt or idle reading changed: the board's cue to refresh the row. */
  onChange(listener: () => void): () => void
  /** SIGTERM the run's whole process group, SIGKILL it if it outlives the grace; resolves once it ended. */
  stop(): Promise<void>
  /** The SERVER is going away. An in-process run is hung up with it; a daemon's run is only detached. */
  release(): void
}

/** A run that has no process: it never got one (its screen says why), or it ended before this server
 *  could see it (an exit filed from the daemon's exit file, with the screen it left). */
export function finishedProcess(screen: string, exit: TerminalExit): TerminalProcess {
  return {
    replay: () => screen,
    exit,
    awaitingSince: () => undefined,
    shellIdle: () => false,
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    onChange: () => () => {},
    stop: async () => {},
    release: () => {},
  }
}

export interface PtySessionOptions {
  /** Absent ⇒ a one-off command: the prompt detector runs. Present ⇒ an interactive shell, never read
   *  as asking (it sits at its own prompt by design), whose idle reading starts from this process name. */
  interactive: boolean
  /** The screen this run opens on (a follow-up run carries its predecessor's). */
  screen?: string
  now?: () => number
  inputQuietMs?: number
  stopGraceMs?: number
  platform?: NodeJS.Platform
  /** How often an interactive shell's foreground process is re-read for `onChange`. 0 ⇒ only on output. */
  idlePollMs?: number
}

export interface PtySession extends TerminalProcess {
  readonly pid: number
}

/** Wrap a spawned pty. The session owns it from here: its output, its prompt state, its end. */
export function createPtySession(term: IPty, options: PtySessionOptions): PtySession {
  const now = options.now ?? Date.now
  const inputQuietMs = options.inputQuietMs ?? INPUT_QUIET_MS
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  const platform = options.platform ?? process.platform
  const ring = new ReplayRing(options.screen ?? "")
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(exit: TerminalExit) => void>()
  const changeListeners = new Set<() => void>()
  let exit: TerminalExit | undefined
  let stopRequested = false
  let promptShown = false
  let promptSince: number | undefined
  let lastInputAt: number | undefined
  let promptTimer: NodeJS.Timeout | undefined
  let settle!: () => void
  const exited = new Promise<void>((resolve) => { settle = resolve })
  // An interactive shell's own foreground-process name, read at spawn.
  let shellProcess: string | undefined
  if (options.interactive) { try { shellProcess = term.process } catch { /* unreadable: never idle */ } }

  const changed = (): void => { for (const l of changeListeners) { try { l() } catch { /* ignore */ } } }

  const shellIdle = (): boolean => {
    if (!options.interactive || exit || shellProcess === undefined) return false
    try {
      return term.process === shellProcess
    } catch {
      return false
    }
  }
  // `shellIdle()` reads the pty live, which is all an in-process caller needs. A caller in ANOTHER
  // process (the daemon's client) only hears a change, so the daemon passes `idlePollMs`: the shell
  // re-reads its foreground process on that slow timer and reports a flip. A timer rather than a read
  // per output chunk, because a command typed into the shell can finish without printing anything, and
  // a `cat` of a big file must not cost a /proc read per chunk.
  let lastIdle = shellIdle()
  let idleTimer: NodeJS.Timeout | undefined
  if (options.interactive && (options.idlePollMs ?? 0) > 0) {
    idleTimer = setInterval(() => {
      const idle = shellIdle()
      if (idle !== lastIdle) { lastIdle = idle; changed() }
    }, options.idlePollMs)
    idleTimer.unref?.()
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
  const watchForPrompt = (chunk: string): void => {
    if (options.interactive) return
    clearTimeout(promptTimer)
    if (promptShown) {
      const echo = lastInputAt !== undefined && now() - lastInputAt <= ECHO_WINDOW_MS && !chunk.includes("\n") && endsOnPrompt(ring.value)
      if (echo) return
      promptShown = false
      promptSince = undefined
      changed()
    }
    if (!endsOnPrompt(ring.value)) return
    promptTimer = setTimeout(() => {
      if (exit || !endsOnPrompt(ring.value)) return
      promptShown = true
      promptSince = now()
      changed()
    }, inputQuietMs)
    promptTimer.unref?.()
  }

  term.onData((chunk) => {
    ring.append(chunk)
    watchForPrompt(chunk)
    for (const listener of dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
  })
  term.onExit(({ exitCode, signal }) => {
    exit = { exitCode, ...(signal ? { signal } : {}), stopped: stopRequested }
    clearTimeout(promptTimer)
    clearInterval(idleTimer)
    for (const listener of exitListeners) { try { listener(exit) } catch { /* ignore */ } }
    exitListeners.clear()
    settle()
  })

  // The pty's child leads its own session (node-pty setsid()s it), so its pid is also its process
  // GROUP: signalling -pid reaches `npm` AND the node it forked, which signalling the shell alone would
  // orphan still holding the port.
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (platform === "win32") {
      try { term.kill() } catch { /* already gone */ }
      return
    }
    try {
      process.kill(-term.pid, signal)
    } catch {
      try { term.kill(signal) } catch { /* already gone */ }
    }
  }

  return {
    pid: term.pid,
    replay: () => ring.value,
    get exit() { return exit },
    awaitingSince: () => (!exit && !options.interactive && promptShown && endsOnPrompt(ring.value) ? promptSince ?? now() : undefined),
    shellIdle,
    write(data) {
      if (exit) return
      lastInputAt = now()
      try { term.write(data) } catch { /* died mid-write */ }
    },
    resize(cols, rows) {
      if (exit) return
      try { term.resize(cols, rows) } catch { /* ignore */ }
    },
    onData(listener) {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onExit(listener) {
      if (exit) return () => {}
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    onChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    async stop() {
      if (exit) return
      stopRequested = true
      signalGroup("SIGTERM")
      let timer: NodeJS.Timeout | undefined
      const killed = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (!exit) signalGroup("SIGKILL")
          resolve()
        }, stopGraceMs)
        timer.unref?.()
      })
      await Promise.race([exited, killed])
      clearTimeout(timer)
      await exited
    },
    release() {
      clearTimeout(promptTimer)
      clearInterval(idleTimer)
      if (!exit) signalGroup("SIGHUP")
    },
  }
}

export type SpawnPty = (file: string, args: string[], options: IPtyForkOptions) => IPty

/**
 * node-pty, loaded on first use — never at module load. It is a native addon, and a static
 * `import "node-pty"` once killed every Linux/WSL install at boot (#42): a failed native load took the
 * WHOLE server down for a feature most boards never touch. The daemon calls this too, so a box without
 * the addon gets a terminal that says why, never a dead daemon. Not memoised on failure: a missing module
 * can be installed while the server runs, and a retry costs one resolve. Handles both module shapes an
 * `import()` of a CommonJS addon can produce.
 */
export async function loadNodePty(): Promise<SpawnPty> {
  const mod = (await import("node-pty")) as { spawn?: SpawnPty; default?: { spawn?: SpawnPty } }
  const spawn = mod.spawn ?? mod.default?.spawn
  if (typeof spawn !== "function") throw new Error("node-pty loaded but exports no spawn()")
  return spawn
}
