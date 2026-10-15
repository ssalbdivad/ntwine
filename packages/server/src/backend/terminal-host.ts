// Client side of the detached terminal daemon (terminal-daemon.ts): fork one for a terminal's run,
// find the live ones a booting server should adopt, attach to one over its socket, read the exit a
// daemon left while no server was listening, and end the ones no row claims.
//
// The lifetime split is the point. `release()` on an attachment DETACHES; the server going away never
// ends a terminal. Only Stop does (a `stop` control line, or a SIGTERM to the daemon, which the daemon
// turns into the same group stop), and the audit below for a daemon whose terminal the board forgot.
//
// Paths follow the other daemon families (acp-host.ts, claude-broker-host.ts): a record per terminal
// under `<stateDir>/terminal-host/<id>.json`, and a socket hashed from the identity into the OS temp dir
// (ipc-path.ts: a named pipe on Windows). Unlike theirs, the socket name hashes the GENERATION too: a
// terminal's restart forks a successor for the same id moments after its predecessor exits, and a
// name of its own means the dying daemon can never unlink the successor's socket — the race the other
// families answer with inode checks (socket-ownership.ts), which the daemon also keeps.
//
// Beside the record, the daemon writes `<id>.exit.json` before it exits (code, signal, stopped, the
// final screen), and the server deletes it once the run is filed. Both carry the row's run number, so
// a record or exit left by an earlier run never files against a later one.
import { spawn } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import { DAEMON_CONTROL_KEY, isDaemonControlLine } from "./daemon-control.ts"
import { recordedDaemonIsLive } from "./daemon-identity.ts"
import { endDaemonTree } from "./daemon-tree.ts"
import { ntwineIpcPath } from "./ipc-path.ts"
import { isNtwineInternalEnvKey, launchEnvironment } from "./worker-env.ts"
import { ReplayRing, endsOnPrompt, STOP_GRACE_MS, type TerminalExit, type TerminalProcess } from "../terminal-session.ts"
import type { TerminalDaemonConfig, TerminalExitRecord } from "./terminal-daemon.ts"

export type { TerminalExitRecord } from "./terminal-daemon.ts"

export interface TerminalHostRecord {
  id: string
  runId: number
  generation: string
  daemonPid: number
  ptyPid: number
  socketPath: string
  createdAt: string
  echoed: boolean
  /** The daemon's own birth marker (daemon-identity.ts). Linux only. */
  processStart?: string
}

/** A run handed to a daemon. `file`/`args`/`env` are already resolved (commandShell, commandEnvironment). */
export interface TerminalRunSpec {
  id: string
  runId: number
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  interactive: boolean
  /** The opening screen of a follow-up run. */
  screen?: string
  /** That screen already opens with this run's own `$ command` line (thread-terminals.ts followUpScreen). */
  echoed: boolean
  cols: number
  rows: number
}

/** A run whose pty lives in a daemon, as the runner holds it. */
export interface RemoteTerminal extends TerminalProcess {
  readonly daemonPid: number
  /** As the run was started (TerminalRunSpec.echoed), so an adopted run's follow-up screen reads right. */
  readonly echoed: boolean
}

export interface TerminalHostOptions {
  stateDir: string
  /** Test seams. */
  daemonEntry?: string
  readyTimeoutMs?: number
  inputQuietMs?: number
  stopGraceMs?: number
  reachabilityCheckMs?: number
}

/** What a runner needs from the host. One per project (state dir). */
export interface TerminalHost {
  /** Fork a daemon for a run and attach to it. `finished` is a run that was over before the attachment
   *  was: one that never got a process (its daemon could load no node-pty or spawn no shell, and says
   *  why in `startFailure`), or a command quicker than the handshake. Rejects only when no daemon could
   *  be started at all; the caller falls back to an in-process pty. */
  start(spec: TerminalRunSpec): Promise<{ process: RemoteTerminal } | { finished: TerminalExitRecord }>
  /** Boot: attach to the live daemon serving this run, if there is one. Returns at once; the screen and
   *  state arrive with the daemon's hello (`onChange` fires then). */
  adopt(id: string, runId: number): RemoteTerminal | undefined
  /** The exit the daemon for this run recorded, if it recorded one. */
  exitOf(id: string, runId: number): TerminalExitRecord | undefined
  /** The run is filed (or its row is gone): drop its exit record. The runner calls this, after it
   *  recorded the exit, so a crash between the two leaves the record for the next boot. */
  consumeExit(id: string): void
  /** Every terminal id with an exit record on disk. */
  exitIds(): string[]
  /** Every live daemon under this state dir. */
  live(): TerminalHostRecord[]
  /** End a daemon and its pty's group (SIGTERM to the daemon, which runs Stop). Never throws. */
  end(id: string): boolean
}

const RECORD_DIR = "terminal-host"
const SOCKET_PREFIX = "ntwine-term-"

export function terminalHostDir(stateDir: string): string { return join(stateDir, RECORD_DIR) }
export function terminalHostRecordPath(stateDir: string, id: string): string { return join(terminalHostDir(stateDir), `${id}.json`) }
export function terminalExitPath(stateDir: string, id: string): string { return join(terminalHostDir(stateDir), `${id}.exit.json`) }
function seedPath(stateDir: string, id: string): string { return join(terminalHostDir(stateDir), `${id}.seed`) }

/** Short and hashed: unix socket paths cap at ~104 bytes on macOS. See the header for the generation. */
export function terminalHostSocketPath(stateDir: string, id: string, generation: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(id).update("\0").update(generation).digest("hex").slice(0, 16)
  return ntwineIpcPath(`${SOCKET_PREFIX}${key}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    return value && typeof value === "object" ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function readTerminalHostRecord(stateDir: string, id: string): TerminalHostRecord | null {
  const value = readJson(terminalHostRecordPath(stateDir, id))
  if (!value || typeof value.daemonPid !== "number" || typeof value.socketPath !== "string" || typeof value.generation !== "string" || typeof value.runId !== "number") return null
  return {
    id,
    runId: value.runId,
    generation: value.generation,
    daemonPid: value.daemonPid,
    ptyPid: typeof value.ptyPid === "number" ? value.ptyPid : 0,
    socketPath: value.socketPath,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    echoed: value.echoed === true,
    ...(typeof value.processStart === "string" && value.processStart ? { processStart: value.processStart } : {}),
  }
}

/** Live only while ITS process runs — the pid and the birth it recorded (daemon-identity.ts). A stale
 *  record is pruned. */
export function liveTerminalHostRecord(stateDir: string, id: string): TerminalHostRecord | null {
  const record = readTerminalHostRecord(stateDir, id)
  if (!record) return null
  if (recordedDaemonIsLive(record.daemonPid, record.processStart, pidAlive)) return record
  try { unlinkSync(terminalHostRecordPath(stateDir, id)) } catch {}
  return null
}

export function liveTerminalHostRecords(stateDir: string): TerminalHostRecord[] {
  let names: string[]
  try { names = readdirSync(terminalHostDir(stateDir)) } catch { return [] }
  return names
    .filter((name) => name.endsWith(".json") && !name.endsWith(".exit.json"))
    .map((name) => liveTerminalHostRecord(stateDir, name.slice(0, -".json".length)))
    .filter((record): record is TerminalHostRecord => record !== null)
}

export function readTerminalExit(stateDir: string, id: string): TerminalExitRecord | null {
  const value = readJson(terminalExitPath(stateDir, id))
  if (!value || typeof value.runId !== "number" || typeof value.generation !== "string") return null
  return {
    id,
    runId: value.runId,
    generation: value.generation,
    at: typeof value.at === "string" ? value.at : "",
    screen: typeof value.screen === "string" ? value.screen : "",
    stopped: value.stopped === true,
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === "number" && value.signal > 0 ? { signal: value.signal } : {}),
    ...(value.startFailure && typeof value.startFailure === "object" ? { startFailure: value.startFailure as TerminalExitRecord["startFailure"] } : {}),
  }
}

/** Every terminal id that left an exit record — the boot sweep drops the ones no running row expects. */
export function terminalExitIds(stateDir: string): string[] {
  let names: string[]
  try { names = readdirSync(terminalHostDir(stateDir)) } catch { return [] }
  return names.filter((name) => name.endsWith(".exit.json")).map((name) => name.slice(0, -".exit.json".length))
}

/** The daemon's own environment: the launch environment minus ntwine's control-plane variables, so it
 *  carries no NTWINE_THREAD for the orphan reaper to attribute it by, plus its config. The pty's
 *  environment travels in the config and is applied by the daemon. */
function daemonEnvironment(config: TerminalDaemonConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(launchEnvironment())) {
    if (value === undefined || isNtwineInternalEnvKey(key)) continue
    env[key] = value
  }
  env.NTWINE_TERMINAL_DAEMON = JSON.stringify(config)
  return env
}

type ForkOutcome = { record: TerminalHostRecord } | { finished: TerminalExitRecord }

function forkTerminalDaemon(options: TerminalHostOptions, spec: TerminalRunSpec): Promise<ForkOutcome> {
  const { stateDir } = options
  const dir = terminalHostDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const recordPath = terminalHostRecordPath(stateDir, spec.id)
  const exitPath = terminalExitPath(stateDir, spec.id)
  try { unlinkSync(recordPath) } catch {}
  try { unlinkSync(exitPath) } catch {}
  const generation = randomUUID()
  let seed: string | undefined
  if (spec.screen) {
    seed = seedPath(stateDir, spec.id)
    writeFileSync(seed, spec.screen)
  }
  const config: TerminalDaemonConfig = {
    id: spec.id, runId: spec.runId, generation,
    socketPath: terminalHostSocketPath(stateDir, spec.id, generation), recordPath, exitPath,
    ...(seed ? { seedPath: seed } : {}),
    file: spec.file, args: spec.args, cwd: spec.cwd, env: spec.env, cols: spec.cols, rows: spec.rows, interactive: spec.interactive, echoed: spec.echoed,
    ...(options.inputQuietMs === undefined ? {} : { inputQuietMs: options.inputQuietMs }),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    ...(options.reachabilityCheckMs === undefined ? {} : { reachabilityCheckMs: options.reachabilityCheckMs }),
  }
  const entry = options.daemonEntry ?? resolveDetachedDaemonEntry(import.meta.url, "terminal-daemon")
  const child = spawn(process.execPath, [entry], {
    // Its own directory, not the terminal's: a folder that has since gone must fail the PTY spawn (and
    // say so on the terminal's screen), not the daemon's.
    cwd: dir,
    env: daemonEnvironment(config),
    detached: true,
    stdio: "ignore",
    // A detached process owns no console on Windows; keep the daemon from being handed a visible one.
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000)
  return new Promise<ForkOutcome>((resolve, reject) => {
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      outcome()
    }
    const poll = (): void => {
      if (settled) return
      const record = readTerminalHostRecord(stateDir, spec.id)
      if (record && record.generation === generation && pidAlive(record.daemonPid)) return settle(() => resolve({ record }))
      const exit = readTerminalExit(stateDir, spec.id)
      if (exit && exit.generation === generation) return settle(() => resolve({ finished: exit }))
      if (Date.now() > deadline) {
        try { if (child.pid) process.kill(child.pid, "SIGKILL") } catch {}
        return settle(() => reject(new Error("terminal daemon did not become ready")))
      }
      setTimeout(poll, 25)
    }
    child.once("error", (error) => settle(() => reject(error)))
    // Died before either file: give its last write a moment to land, then say how it died.
    child.once("exit", (code, signal) => {
      const until = Date.now() + 500
      const read = (): void => {
        if (settled) return
        const exit = readTerminalExit(stateDir, spec.id)
        if (exit && exit.generation === generation) return settle(() => resolve({ finished: exit }))
        if (Date.now() < until) { setTimeout(read, 25); return }
        settle(() => reject(new Error(`terminal daemon exited before it became ready (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`)))
      }
      read()
    })
    poll()
  })
}

interface RemoteOptions {
  stateDir: string
  record: TerminalHostRecord
  stopGraceMs: number
  /** Resolves once the first hello arrived (or the attachment failed). */
  onReady?: (ok: boolean) => void
}

// How long a lost attachment keeps retrying a daemon that is still alive: a daemon drops a client whose
// backlog overflowed, and a server restart briefly holds two clients. Neither is the run ending.
const RECONNECT_ATTEMPTS = 20
const RECONNECT_DELAY_MS = 100
const HELLO_TIMEOUT_MS = 10_000

/** An attachment to one daemon, presented as the runner's TerminalProcess. */
function remoteTerminal(options: RemoteOptions): RemoteTerminal {
  const { stateDir, record } = options
  const ring = new ReplayRing()
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(exit: TerminalExit) => void>()
  const changeListeners = new Set<() => void>()
  let exit: TerminalExit | undefined
  let awaitingSince: number | null = null
  let idle = false
  let socket: Socket | null = null
  let connected = false
  let released = false
  let stopRequested = false
  let attempts = 0
  let readyReported = false
  let settle!: () => void
  const exited = new Promise<void>((resolve) => { settle = resolve })

  const reportReady = (ok: boolean): void => {
    if (readyReported) return
    readyReported = true
    options.onReady?.(ok)
  }
  const changed = (): void => { for (const l of changeListeners) { try { l() } catch {} } }
  const finish = (value: TerminalExit, screen?: string): void => {
    if (exit) return
    if (screen !== undefined && screen.length > 0) ring.reset(screen)
    exit = value
    for (const listener of exitListeners) { try { listener(value) } catch {} }
    exitListeners.clear()
    try { socket?.destroy() } catch {}
    socket = null
    reportReady(true)
    settle()
  }
  const sendLine = (line: string): void => {
    if (!socket || !connected) return
    try { socket.write(line) } catch {}
  }

  // The attachment is gone and the daemon did not say the run ended. Alive ⇒ reattach. Dead ⇒ its exit
  // record, if it wrote one; otherwise nobody saw the end, which is an interrupted run.
  const lost = (): void => {
    socket = null
    connected = false
    if (released || exit) return
    if (recordedDaemonIsLive(record.daemonPid, record.processStart, pidAlive) && attempts < RECONNECT_ATTEMPTS) {
      attempts++
      setTimeout(connect, RECONNECT_DELAY_MS).unref?.()
      return
    }
    const until = Date.now() + 500
    const read = (): void => {
      if (exit || released) return
      const onDisk = readTerminalExit(stateDir, record.id)
      if (onDisk && onDisk.runId === record.runId) return finish(onDisk, onDisk.screen)
      if (Date.now() < until) { setTimeout(read, 25).unref?.(); return }
      finish({ stopped: stopRequested })
    }
    read()
  }

  const readLine = (line: string): void => {
    if (!isDaemonControlLine(line)) {
      let chunk: unknown
      try { chunk = (JSON.parse(line) as { d?: unknown }).d } catch { return }
      if (typeof chunk !== "string") return
      ring.append(chunk)
      for (const listener of dataListeners) { try { listener(chunk) } catch {} }
      return
    }
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    const state = message.state as { awaitingSince?: unknown; idle?: unknown } | undefined
    if (state) {
      awaitingSince = typeof state.awaitingSince === "number" ? state.awaitingSince : null
      idle = state.idle === true
    }
    if (message.hello === 1) {
      if (typeof message.screen === "string") ring.reset(message.screen)
      attempts = 0
      reportReady(true)
      changed()
      return
    }
    if (message.exit && typeof message.exit === "object") {
      const value = message.exit as { exitCode?: unknown; signal?: unknown; stopped?: unknown }
      finish({
        ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
        ...(typeof value.signal === "number" && value.signal > 0 ? { signal: value.signal } : {}),
        stopped: value.stopped === true,
      })
      return
    }
    if (state) changed()
  }

  function connect(): void {
    if (released || exit) return
    const sock = createConnection(record.socketPath)
    socket = sock
    const helloTimer = setTimeout(() => { if (!readyReported) sock.destroy() }, HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    sock.on("connect", () => { connected = true })
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    sock.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      for (;;) {
        const index = buffer.indexOf("\n")
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) readLine(line)
      }
    })
    let gone = false
    const onGone = (): void => {
      if (gone) return
      gone = true
      clearTimeout(helloTimer)
      if (socket === sock) lost()
    }
    sock.on("close", onGone)
    sock.on("error", onGone)
  }

  // The daemon could not be told (no attachment) or did not end in time: signal it, then kill outright.
  const forceEnd = async (): Promise<void> => {
    endDaemonTree(record.daemonPid, "SIGTERM")
    const deadline = Date.now() + options.stopGraceMs + 2_000
    while (!exit && recordedDaemonIsLive(record.daemonPid, record.processStart, pidAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!exit && recordedDaemonIsLive(record.daemonPid, record.processStart, pidAlive)) {
      if (process.platform !== "win32" && record.ptyPid > 0) { try { process.kill(-record.ptyPid, "SIGKILL") } catch {} }
      endDaemonTree(record.daemonPid, "SIGKILL")
    }
  }

  connect()
  return {
    daemonPid: record.daemonPid,
    echoed: record.echoed,
    replay: () => ring.value,
    get exit() { return exit },
    awaitingSince: () => (!exit && awaitingSince !== null && endsOnPrompt(ring.value) ? awaitingSince : undefined),
    shellIdle: () => !exit && idle,
    write: (data) => { if (!exit) sendLine(`${JSON.stringify({ d: data })}\n`) },
    resize: (cols, rows) => { if (!exit) sendLine(`${JSON.stringify({ [DAEMON_CONTROL_KEY]: 1, resize: { cols, rows } })}\n`) },
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
      if (socket && connected) sendLine(`${JSON.stringify({ [DAEMON_CONTROL_KEY]: 1, stop: 1 })}\n`)
      else void forceEnd()
      // The daemon's own grace (SIGTERM, then SIGKILL) runs first; this is the backstop for a daemon
      // that is wedged or unreachable.
      let timer: NodeJS.Timeout | undefined
      const backstop = new Promise<void>((resolve) => {
        timer = setTimeout(() => { void forceEnd().then(resolve) }, options.stopGraceMs + 3_000)
        timer.unref?.()
      })
      await Promise.race([exited, backstop])
      clearTimeout(timer)
      if (!exit) finish({ stopped: true })
    },
    release() {
      released = true
      try { socket?.destroy() } catch {}
      socket = null
    },
  }
}

export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  return {
    async start(spec) {
      const outcome = await forkTerminalDaemon(options, spec)
      if ("finished" in outcome) return outcome
      let ready!: (ok: boolean) => void
      const helloed = new Promise<boolean>((resolve) => { ready = resolve })
      const process = remoteTerminal({ stateDir: options.stateDir, record: outcome.record, stopGraceMs, onReady: ready })
      await helloed
      return { process }
    },
    adopt(id, runId) {
      const record = liveTerminalHostRecord(options.stateDir, id)
      if (!record || record.runId !== runId) return undefined
      return remoteTerminal({ stateDir: options.stateDir, record, stopGraceMs })
    },
    exitOf(id, runId) {
      const exit = readTerminalExit(options.stateDir, id)
      return exit && exit.runId === runId ? exit : undefined
    },
    consumeExit(id) {
      try { unlinkSync(terminalExitPath(options.stateDir, id)) } catch {}
    },
    exitIds: () => terminalExitIds(options.stateDir),
    live: () => liveTerminalHostRecords(options.stateDir),
    end(id) {
      const record = liveTerminalHostRecord(options.stateDir, id)
      if (!record) return false
      endDaemonTree(record.daemonPid, "SIGTERM")
      return true
    },
  }
}

// ── Unowned daemons ─────────────────────────────────────────────────────────────────────────────────
//
// A daemon outlives the server on purpose, so the board can forget a terminal whose daemon is still
// running: its row dropped while it ran (a thread forgotten during a crash, a row deleted by hand), or a
// row that no longer expects this run (a later run is on it, or it was filed as over). Nobody can see,
// type into or stop such a terminal again, so it is ENDED — the one thing that makes "a daemon per
// terminal" safe to leave running across restarts. A daemon the board still expects is never touched.
// An age guard covers a start between its row and its fork; it fails CLOSED like the orphan reaper:
// no rows to compare against ⇒ nothing ended.

/** Younger than this, a daemon may be a start whose row is a moment from reading as running. */
export const UNOWNED_TERMINAL_MIN_AGE_MS = 60_000

export interface UnownedTerminal {
  id: string
  daemonPid: number
  reason: "no-row" | "other-run" | "row-finished"
}

/** Which live daemons the board does not expect. Pure. `rows` maps a terminal id to its current run
 *  number and whether that run is still open (`exited_at` is null). */
export function classifyUnownedTerminalHosts(input: {
  daemons: readonly Pick<TerminalHostRecord, "id" | "runId" | "daemonPid" | "createdAt">[]
  rows: ReadonlyMap<string, { runId: number; running: boolean }>
  nowMs: number
  minAgeMs?: number
}): UnownedTerminal[] {
  const minAge = input.minAgeMs ?? UNOWNED_TERMINAL_MIN_AGE_MS
  const out: UnownedTerminal[] = []
  for (const daemon of input.daemons) {
    const born = Date.parse(daemon.createdAt)
    if (!Number.isFinite(born) || input.nowMs - born < minAge) continue
    const row = input.rows.get(daemon.id)
    const reason = !row ? "no-row" : row.runId !== daemon.runId ? "other-run" : !row.running ? "row-finished" : null
    if (reason) out.push({ id: daemon.id, daemonPid: daemon.daemonPid, reason })
  }
  return out
}
