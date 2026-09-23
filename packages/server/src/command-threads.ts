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

// A dev server's log is long-lived and chatty; a late viewer needs the recent screen, not the banner.
// Trimmed from the FRONT, at a line boundary where one is near, so the replay starts on a clean line.
const REPLAY_CAP_BYTES = 1024 * 1024
// How long Stop waits after SIGTERM before it SIGKILLs the process group.
const STOP_GRACE_MS = 5_000

export interface CommandRunner {
  start(command: string): { slug: string }
  /** A fresh run of an existing thread's command: stops the current run first if it is alive. */
  restart(slug: string): Promise<void>
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
  const runs = new Map<string, Run>()
  let shuttingDown = false

  // Whatever was running when the last server went away went with it.
  deps.storage.interruptRunningCommandThreads(now())

  function rows(): Map<string, CommandThreadRow> {
    return new Map(deps.storage.listCommandThreads().map((row) => [row.slug, row]))
  }

  function spawn(slug: string, command: string): void {
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
      buffer: "",
      bufferBytes: 0,
      dataListeners: new Set(),
      exitListeners: new Set(),
      exitedPromise: new Promise<void>((resolve) => { settle = resolve }),
    }
    runs.set(slug, run)
    term.onData((chunk) => {
      run.buffer += chunk
      run.bufferBytes += Buffer.byteLength(chunk)
      trimReplay(run)
      for (const listener of run.dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
    })
    term.onExit(({ exitCode }) => {
      run.exited = true
      run.exitCode = exitCode
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
    const command: CommandThreadState = {
      command: row.command,
      state: running ? "running" : "exited",
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
      lastActivityAt: command.exitedAt ?? startedAt,
      lastUserAt: startedAt,
      subAgents: [],
      bgShells: [],
      watches: [],
      pendingQuestion: false,
      questions: [],
      kind: "command",
      command,
      state: row.state,
      needsYou: !running && row.state !== "archived",
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
        if (!run.exited) signalGroup(run, "SIGHUP")
      }
      runs.clear()
    },
  }
}
