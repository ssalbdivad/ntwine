// The detached terminal daemon: ONE per running terminal. It owns the pty (and so the shell, the
// `npm run dev`, the node it forks) and serves it over a local socket, so a terminal OUTLIVES the ntwine
// server that started it: Restart ntwine, an update, a crash — the dev server keeps serving, and the next
// server attaches to the same process. It is the terminal's version of what the Claude session broker
// (claude-agent-broker.ts), the Codex app-server daemon and the ACP daemon (acp-daemon.ts) buy their
// agents: forked `detached: true` into its own process group, not a child of ntwine.
//
// Before this existed the pty was a child of the control plane, and replacing the control plane closed
// the pty master and hung every terminal up; boot then marked each run interrupted.
//
// What it keeps so a server that was away misses nothing it needs:
//   - the 1 MiB replay ring and the prompt detector's state (terminal-session.ts — the same module the
//     in-process fallback runs), fed by the pty WHETHER OR NOT anyone is attached. So a reattaching
//     server gets the screen, and a `npm publish` that reached its OTP prompt while ntwine was down
//     still reads as waiting for input;
//   - the run's end. Before it exits it writes `<id>.exit.json` beside its record (code, signal, whether
//     Stop ended it, and the final screen), so a server that was down at that moment files the run
//     with its real outcome instead of calling it interrupted. The server deletes the file once filed.
//
// The wire is newline-delimited JSON. Control lines carry the reserved DAEMON_CONTROL_KEY
// (daemon-control.ts) like every other daemon's; a pty byte chunk travels as `{"d": "<text>"}` in both
// directions (output out, keystrokes in). Out: a `hello` (screen, state) on attach, then data, `state`
// (prompt / shell-idle) on a change, and `exit`. In: data, `resize`, `stop`.
//
// It has NO idle timer. An agent daemon whose ntwine never returns is abandoned work; a dev server
// whose ntwine never returns is still the dev server the human asked for. It ends when its process ends,
// when Stop (or a SIGTERM) ends that process, or when it can never be reached again (self-collection,
// below). A daemon whose row the server no longer has is ended by the server (terminal-host.ts,
// `auditUnownedTerminalHosts`).
//
// Launched by forkTerminalDaemon() in terminal-host.ts, which passes its config as JSON in
// NTWINE_TERMINAL_DAEMON (the opening screen of a follow-up run, up to 1 MiB, rides in a seed file
// instead: one environment string caps at 128 KiB on Linux). No stdio; its interface is the socket and
// the files in its record directory.
import { createServer, type Socket } from "node:net"
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { DAEMON_CONTROL_KEY } from "./daemon-control.ts"
import { daemonBirthMarker } from "./daemon-identity.ts"
import { socketPathOwnership } from "./socket-ownership.ts"
import { sweepStaleSockets } from "./stale-socket-sweep.ts"
import { createPtySession, loadNodePty, type PtySession, type TerminalExit } from "../terminal-session.ts"

export interface TerminalDaemonConfig {
  id: string
  /** The row's run number this daemon serves — so a stale record or exit file never files against a later run. */
  runId: number
  generation: string
  socketPath: string
  recordPath: string
  exitPath: string
  /** The opening screen (a follow-up run's), read once and deleted. */
  seedPath?: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  interactive: boolean
  /** Carried into the record for the server that adopts this run (terminal-host.ts TerminalRunSpec). */
  echoed: boolean
  /** Test seams; production leaves them undefined. */
  inputQuietMs?: number
  stopGraceMs?: number
  reachabilityCheckMs?: number
}

/** What a daemon leaves behind when its run ends. */
export interface TerminalExitRecord extends TerminalExit {
  id: string
  runId: number
  generation: string
  at: string
  screen: string
  /** The run never got a process: node-pty would not load, or the shell would not spawn. */
  startFailure?: { what: "load" | "spawn"; message: string }
}

const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2
// A stalled server must not make the daemon buffer without bound. Past this the attachment is dropped;
// the next one is handed the ring, which is the screen it needs.
const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
const IDLE_POLL_MS = 1_000
const START_FAILED_EXIT = 127

function readConfig(): TerminalDaemonConfig {
  const raw = process.env.NTWINE_TERMINAL_DAEMON
  if (!raw) throw new Error("terminal daemon started without NTWINE_TERMINAL_DAEMON")
  const config = JSON.parse(raw) as TerminalDaemonConfig
  if (!config.id || !config.socketPath || !config.recordPath || !config.exitPath || !config.file || !config.generation) {
    throw new Error("terminal daemon config is incomplete")
  }
  return config
}

/** Written whole or not at all: a server reading it mid-write must never file half an exit. */
function writeExitRecord(path: string, record: TerminalExitRecord): void {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(record))
    renameSync(temp, path)
  } catch {
    try { unlinkSync(temp) } catch {}
  }
}

async function main(): Promise<void> {
  const config = readConfig()
  let seed: string | undefined
  if (config.seedPath) {
    try { seed = readFileSync(config.seedPath, "utf8") } catch {}
    try { unlinkSync(config.seedPath) } catch {}
  }
  const exitRecord = (exit: TerminalExit, screen: string, startFailure?: TerminalExitRecord["startFailure"]): TerminalExitRecord => ({
    id: config.id, runId: config.runId, generation: config.generation, at: new Date().toISOString(),
    ...exit, screen, ...(startFailure ? { startFailure } : {}),
  })
  const failStart = (what: "load" | "spawn", cause: unknown): never => {
    const message = cause instanceof Error ? cause.message : String(cause)
    writeExitRecord(config.exitPath, exitRecord({ exitCode: START_FAILED_EXIT, stopped: false }, seed ?? "", { what, message }))
    process.exit(0)
  }

  let spawnPty: Awaited<ReturnType<typeof loadNodePty>>
  try {
    spawnPty = await loadNodePty()
  } catch (cause) {
    return failStart("load", cause)
  }
  let session: PtySession
  try {
    const term = spawnPty(config.file, config.args, { name: "xterm-256color", cwd: config.cwd, env: config.env, cols: config.cols, rows: config.rows })
    session = createPtySession(term, {
      interactive: config.interactive,
      ...(seed === undefined ? {} : { screen: seed }),
      idlePollMs: IDLE_POLL_MS,
      ...(config.inputQuietMs === undefined ? {} : { inputQuietMs: config.inputQuietMs }),
      ...(config.stopGraceMs === undefined ? {} : { stopGraceMs: config.stopGraceMs }),
    })
  } catch (cause) {
    return failStart("spawn", cause)
  }

  let client: Socket | null = null
  let published = false
  // Whether the socket PATH still leads to the socket this daemon bound (socket-ownership.ts).
  let socketPathIsOurs: () => boolean = () => true

  const control = (payload: Record<string, unknown>): string => `${JSON.stringify({ [DAEMON_CONTROL_KEY]: 1, ...payload })}\n`
  const state = (): Record<string, unknown> => ({ awaitingSince: session.awaitingSince() ?? null, idle: session.shellIdle() })
  const send = (line: string): void => {
    const sock = client
    if (!sock) return
    try {
      sock.write(line)
      if (sock.writableLength > MAX_CLIENT_BACKLOG_BYTES) { client = null; sock.destroy() }
    } catch {}
  }

  const recordOwner = (): number | null => {
    try {
      const value = JSON.parse(readFileSync(config.recordPath, "utf8")) as { daemonPid?: unknown }
      return typeof value.daemonPid === "number" ? value.daemonPid : null
    } catch {
      return null
    }
  }
  // Only ever remove what is still ours. Never `server.close()`: libuv unlinks a unix socket's path by
  // name on close (socket-ownership.ts), and `process.exit` without one touches no file.
  const cleanup = (): void => {
    if (recordOwner() === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    if (published && process.platform !== "win32" && socketPathIsOurs()) { try { unlinkSync(config.socketPath) } catch {} }
  }

  // The run ended. The exit file goes down FIRST — it is the record a server that is away right now
  // reads at its next boot — then the attached server hears it, then the daemon goes.
  session.onExit((exit) => {
    writeExitRecord(config.exitPath, exitRecord(exit, session.replay()))
    const sock = client
    client = null
    cleanup()
    if (!sock) process.exit(0)
    const done = (): never => process.exit(0)
    try { sock.end(control({ exit }), done) } catch { done() }
    setTimeout(done, 2_000).unref?.()
  })
  session.onChange(() => send(control({ state: state() })))
  session.onData((chunk) => send(`${JSON.stringify({ d: chunk })}\n`))

  const readClientLine = (line: string): void => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (message[DAEMON_CONTROL_KEY] === 1) {
      const resize = message.resize as { cols?: unknown; rows?: unknown } | undefined
      if (resize && Number.isInteger(resize.cols) && Number.isInteger(resize.rows)) session.resize(resize.cols as number, resize.rows as number)
      if (message.stop === 1) void session.stop()
      return
    }
    if (typeof message.d === "string") session.write(message.d)
  }

  const server = createServer((sock) => {
    // One client at a time: a new ntwine generation supersedes the old one's socket outright.
    if (client) { try { client.destroy() } catch {} }
    client = sock
    sock.setNoDelay(true)
    try { sock.write(control({ hello: 1, generation: config.generation, runId: config.runId, screen: session.replay(), state: state() })) } catch {}
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    sock.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      for (;;) {
        const index = buffer.indexOf("\n")
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line && !sock.destroyed && client === sock) readClientLine(line)
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) sock.destroy()
    })
    const drop = (): void => { if (client === sock) client = null }
    sock.on("close", drop)
    sock.on("error", drop)
  })

  const birthMarker = daemonBirthMarker()
  const writeRecord = (): void => {
    writeFileSync(config.recordPath, JSON.stringify({
      id: config.id,
      runId: config.runId,
      generation: config.generation,
      daemonPid: process.pid,
      ptyPid: session.pid,
      socketPath: config.socketPath,
      createdAt: new Date().toISOString(),
      echoed: config.echoed,
      // So the server can tell this daemon from a stranger that later got its pid (daemon-identity.ts).
      ...(birthMarker ? { processStart: birthMarker } : {}),
    }))
  }

  // Self-collection, as for the ACP and codex daemons: reachable only through the record naming it AND
  // the socket path still leading to it. Unattached and unreachable twice running ⇒ nobody can ever
  // see, type into or stop this terminal again, so it stops its process group rather than leave an
  // invisible dev server holding a port. Gated on being unattached, so a restart window is invisible.
  let unreachableStrikes = 0
  const checkReachable = (): void => {
    if (client) { unreachableStrikes = 0; return }
    if (recordOwner() === process.pid && socketPathIsOurs()) { unreachableStrikes = 0; return }
    if (++unreachableStrikes < REACHABILITY_STRIKES) return
    void session.stop()
  }

  if (process.platform !== "win32" && existsSync(config.socketPath)) { try { unlinkSync(config.socketPath) } catch {} }
  server.on("error", () => { void session.stop() })
  server.listen(config.socketPath, () => {
    published = true
    socketPathIsOurs = socketPathOwnership(config.socketPath)
    writeRecord()
    setInterval(checkReachable, config.reachabilityCheckMs ?? REACHABILITY_CHECK_MS).unref?.()
    setTimeout(() => sweepStaleSockets({ dir: dirname(config.socketPath), prefix: "ntwine-term-", keep: [config.socketPath] }), 5_000).unref?.()
  })

  // A signal to the daemon is a Stop: the pty's group gets SIGTERM, then SIGKILL after the grace, and
  // the exit is recorded as stopped. (Detached into its own session, it never receives a terminal's
  // hang-up; a SIGHUP here was sent on purpose.)
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void session.stop() })
}

void main().catch(() => process.exit(5))
