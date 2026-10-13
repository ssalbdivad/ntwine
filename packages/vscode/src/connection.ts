// THE EDITOR SOCKET — this window's one live line to Ntwine (`/_ntwine/editor`, packages/shared
// editor-protocol.ts; design in ARCHITECTURE.md § VS Code extension).
//
// The extension dials out: Ntwine is a singleton with a known way to find it, every editor window is a
// client of it. Over the socket this window says which folders it has open and whether it has focus,
// and Ntwine sends it files to open, folders to raise and the projects its folders belong to.
//
// What keeps it honest:
//   - Discovery runs again before EVERY attempt. The private port behind the restart supervisor moves on
//     each restart, and a Ntwine started after this window opened has to be found, not remembered.
//   - The upgrade carries `Origin: http://127.0.0.1:<port>` — the server refuses a socket without one,
//     and the restart supervisor destroys it without even a status line. That is why this uses the `ws`
//     package: the WHATWG WebSocket cannot set Origin.
//   - Backoff from 1s to 30s, jittered so N windows a restart dropped do not stampede it together, and
//     reset by a `welcome` — not by a bare TCP connect, which a broken server also accepts.
//   - Silence is a dead link. Ntwine sends `hb` every 15s; 45s without any frame and the socket is torn
//     down and dialled again (a sleeping laptop's socket can stay "open" for minutes after the far end
//     is gone).
//   - One log line per change of state, not per retry: a window left open on a stopped Ntwine would
//     otherwise write a line every 30s for days.
//   - Nothing goes out that Ntwine will refuse. A refused hello (4401) is refused again on every redial,
//     forever, so the folders a window reports are fitted to Ntwine's limits (`fitFolders`) rather than
//     sent whole, and the editor's picture is fitted to its byte ceiling (editor-state.ts).
//   - Nothing goes out that Ntwine does not know. The server closes the socket on a frame it has never
//     heard of, so the `editor` frame — newer than v1 — goes only to a Ntwine whose welcome names it
//     (`features`). An older Ntwine simply never hears it, and its agents cannot read the editor. A field
//     newer than the frame (a selection's `withheld`) is spelled the way that Ntwine's schema takes
//     (`forServer`): its schema is strict, so an unknown key would be refused like an unknown frame. The
//     same for this window's own `features` frame (it can show a thread's changes), sent only to a Ntwine
//     whose welcome names `review`: the one way Ntwine learns a window can, since the hello reaches every Ntwine.
//
// Pure node (no `vscode` import): the host interface is how the window is reached, and the tests drive
// this against a real `ws` server in-process.

import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import {
  EDITOR_CLOSE,
  EDITOR_FEATURES,
  EDITOR_MAX_FOLDERS,
  EDITOR_MAX_PATH,
  EDITOR_PROTOCOL_VERSION,
  EDITOR_SOCKET_PATH,
  type EditorClientMessage,
  type EditorComposeInput,
  type EditorComposed,
  type EditorFocus,
  type EditorHello,
  type EditorOpen,
  type EditorProject,
  type EditorReview,
  type EditorServerMessage,
  type EditorSnapshot,
  type EditorState,
} from "@ntwine/shared/editor-protocol"
import { fitEditorSnapshot } from "./editor-state.ts"

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "connected"; origin: string; bootId: string }
  | { kind: "offline"; reason: string }
  | { kind: "incompatible"; reason: string }

export interface ConnectionLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface OpenResult {
  ok: boolean
  error?: string
}

export interface ConnectionHost {
  /** Where Ntwine is now, or undefined; `detail` is for the log. */
  discover(): Promise<{ origin: string; detail: string } | undefined>
  /** Everything the hello carries about this window, read at the moment it is sent. */
  hello(): Omit<EditorHello, "t" | "v">
  state(): Omit<EditorState, "t">
  /** What the window's editor shows, for Ntwine's agents (editor-state-feed.ts). Absent: this host reports none. */
  editor?(): EditorSnapshot
  open(message: EditorOpen): Promise<OpenResult>
  focus(message: EditorFocus): Promise<OpenResult>
  /** Show a thread's changes and raise the window. Absent: this window cannot, and never says it can. */
  review?(message: EditorReview): Promise<OpenResult>
  projects(projects: EditorProject[]): void
  status(status: ConnectionStatus): void
  log: ConnectionLog
}

export interface ConnectionOptions {
  minBackoffMs?: number
  maxBackoffMs?: number
  /** No frame for this long and the link is presumed dead. */
  silenceMs?: number
  composeTimeoutMs?: number
  handshakeTimeoutMs?: number
  random?: () => number
}

/** Why the server closed us, in words the log and the status bar can use. */
export function describeClose(code: number, reason: string): { reason: string; incompatible: boolean } {
  const said = reason ? ` (${reason})` : ""
  switch (code) {
    case EDITOR_CLOSE.unsupportedVersion:
      return { reason: "This Ntwine speaks a different version of the editor connection. Update Ntwine or the extension.", incompatible: true }
    case EDITOR_CLOSE.invalidMessage:
      return { reason: `Ntwine refused a message from this window${said}.`, incompatible: false }
    case EDITOR_CLOSE.helloRequired:
      return { reason: `Ntwine expected this window to introduce itself first${said}.`, incompatible: false }
    case 1000:
      return { reason: `Ntwine closed the connection${said}.`, incompatible: false }
    case 1001:
      return { reason: "Ntwine is restarting.", incompatible: false }
    case 1006:
      return { reason: "The connection to Ntwine dropped.", incompatible: false }
    default:
      return { reason: `Ntwine closed the connection: code ${code}${said}.`, incompatible: false }
  }
}

function stateKey(state: Omit<EditorState, "t">): string {
  return JSON.stringify([state.folders, state.focused, state.acceptsOpens])
}

/**
 * Bytes of folder paths one hello or state may carry, encoded. Ntwine refuses any frame but a compose
 * past 64 KiB (editor-bridge.ts EDITOR_MAX_FRAME_BYTES), and 64 folders of 4096 units each could be
 * 768 KiB of UTF-8. 32 KiB is hundreds of real folders' worth, and leaves the rest of a hello room.
 */
export const FOLDERS_MAX_BYTES = 32 * 1024

/**
 * The window's folders as Ntwine takes them: none longer than EDITOR_MAX_PATH, at most EDITOR_MAX_FOLDERS,
 * within FOLDERS_MAX_BYTES, in the workspace's own order — so a multi-root workspace past a limit still
 * connects, with Ntwine knowing its first folders, instead of being refused on every redial.
 */
export function fitFolders(folders: readonly string[]): string[] {
  const fitted: string[] = []
  let bytes = 0
  for (const folder of folders) {
    if (fitted.length >= EDITOR_MAX_FOLDERS) break
    if (!folder || folder.length > EDITOR_MAX_PATH) continue
    const size = Buffer.byteLength(JSON.stringify(folder), "utf8") + 1
    if (bytes + size > FOLDERS_MAX_BYTES) break
    fitted.push(folder)
    bytes += size
  }
  return fitted
}

/**
 * When this window last had focus, for the hello's `focusedAgoMs`. Ntwine ranks windows by it for an open
 * no folder claims, and every window redials after a Ntwine restart — while the human is in the browser,
 * so none is focused, and without this whichever redialled last would win. Gaining focus and losing it
 * both mean "focused until now", the rule the server applies to a `state` frame. Monotonic, so a clock
 * change cannot make it negative.
 */
export class FocusRecency {
  readonly #now: () => number
  #focused = false
  #at: number | undefined

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
  }

  /** The window's focus at activation, and at every change. */
  observe(focused: boolean): void {
    if (focused || this.#focused) this.#at = this.#now()
    this.#focused = focused
  }

  /** How long ago the window last had focus: undefined while it has it, and when it never has. */
  agoMs(focused: boolean): number | undefined {
    if (focused || this.#at === undefined) return undefined
    return Math.max(0, Math.round(this.#now() - this.#at))
  }
}

/** 1s, 2s, 4s … 30s, each ±20%. `attempt` counts from 0. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30))
  return Math.min(maxMs, Math.round(base * (0.8 + 0.4 * random())))
}

export class EditorConnection {
  readonly #host: ConnectionHost
  readonly #minBackoffMs: number
  readonly #maxBackoffMs: number
  readonly #silenceMs: number
  readonly #composeTimeoutMs: number
  readonly #handshakeTimeoutMs: number
  readonly #random: () => number

  #running = false
  /** Bumped by every dial, so a dead socket's late events cannot touch the live one. */
  #generation = 0
  #socket: WebSocket | undefined
  #attempt = 0
  #retryTimer: NodeJS.Timeout | undefined
  #silenceTimer: NodeJS.Timeout | undefined
  #status: ConnectionStatus = { kind: "offline", reason: "Not started." }
  #origin: string | undefined
  #bootId: string | undefined
  #welcomed = false
  #lastState: string | undefined
  /** The state the hello carried, which becomes `#lastState` once Ntwine welcomes it. */
  #helloState: string | undefined
  #lastLogged: string | undefined
  #foldersNote: string | undefined
  /** What the Ntwine this socket is connected to said it takes beyond v1 (`welcome.features`). */
  #features = new Set<string>()
  /** The last `editor` frame sent on this socket, so an unchanged picture is not sent again. */
  #lastEditor: string | undefined
  /** The Ntwine at this origin answered the socket with a 404: it predates the editor connection, and so the sidebar. */
  #predatesBridge = false
  readonly #composes = new Map<string, { resolve: (value: EditorComposed) => void; timer: NodeJS.Timeout }>()

  constructor(host: ConnectionHost, options: ConnectionOptions = {}) {
    this.#host = host
    this.#minBackoffMs = options.minBackoffMs ?? 1_000
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.#silenceMs = options.silenceMs ?? 45_000
    this.#composeTimeoutMs = options.composeTimeoutMs ?? 10_000
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.#random = options.random ?? Math.random
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  /** The origin of the Ntwine this window is connected to (welcomed), else undefined. */
  get origin(): string | undefined {
    return this.#welcomed ? this.#origin : undefined
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#setStatus({ kind: "connecting" })
    void this.#dial()
  }

  /** Drop whatever is in flight and dial now, from a fresh discovery and a reset backoff. */
  reconnect(): void {
    if (!this.#running) return this.start()
    this.#attempt = 0
    this.#teardown(1000, "reconnecting")
    this.#setStatus({ kind: "connecting" })
    void this.#dial()
  }

  stop(): void {
    this.#running = false
    this.#teardown(1000, "window closing")
  }

  /** Tell Ntwine this window's folders, focus or open-links setting changed. Unchanged state is not resent. */
  sendState(): void {
    if (!this.#welcomed) return
    const state = this.#fitted(this.#host.state())
    const key = stateKey(state)
    if (key === this.#lastState) return
    if (this.#send({ t: "state", ...state })) this.#lastState = key
  }

  /** What the Ntwine this window is connected to takes beyond v1 (its welcome's `features`); undefined while not connected. */
  get features(): ReadonlySet<string> | undefined {
    return this.#welcomed ? this.#features : undefined
  }

  /**
   * The Ntwine last dialled answered the editor socket with a 404 — one from before the editor connection,
   * and so from before the sidebar too. False once any Ntwine welcomes this window.
   */
  get predatesBridge(): boolean {
    return this.#predatesBridge
  }

  /** Whether the Ntwine this window is connected to takes the editor's picture (its welcome named it). */
  get sharesEditor(): boolean {
    return this.#welcomed && this.#features.has(EDITOR_FEATURES.editorState)
  }

  /**
   * Tell Ntwine what the editor shows now (`host.editor()`), fitted to its ceiling. Only to a Ntwine that
   * said it takes it; an unchanged picture is not resent.
   */
  sendEditor(): void {
    if (!this.sharesEditor || !this.#host.editor) return
    const snapshot = forServer(fitEditorSnapshot(this.#host.editor()), this.#features)
    const key = JSON.stringify(snapshot)
    if (key === this.#lastEditor) return
    if (this.#send(snapshot)) this.#lastEditor = key
  }

  /** Hand Ntwine something for the page's prompt box; resolves with its `composed` answer. */
  compose(item: EditorComposeInput): Promise<EditorComposed> {
    const id = randomUUID()
    if (!this.#welcomed || !this.#send({ t: "compose", id, item })) {
      return Promise.resolve({ t: "composed", id, ok: false, error: "Ntwine isn't running." })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#composes.delete(id)
        resolve({ t: "composed", id, ok: false, error: "Ntwine didn't answer." })
      }, this.#composeTimeoutMs)
      this.#composes.set(id, { resolve, timer })
    })
  }

  /** The window's state with its folders fitted to Ntwine's limits, saying so once when that leaves some out. */
  #fitted<T extends { folders: string[] }>(state: T): T {
    const folders = fitFolders(state.folders)
    const note = folders.length < state.folders.length
      ? `This window has ${state.folders.length} folders; Ntwine takes ${folders.length} of them (at most ${EDITOR_MAX_FOLDERS}, none over ${EDITOR_MAX_PATH} characters), so file links to the rest open elsewhere.`
      : undefined
    if (note && note !== this.#foldersNote) this.#host.log.warn(note)
    this.#foldersNote = note
    return { ...state, folders }
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status
    this.#host.status(status)
  }

  /** Log a line only when it differs from the last one — retries of one failure say it once. */
  #logOnce(level: keyof ConnectionLog, line: string): void {
    if (line === this.#lastLogged) return
    this.#lastLogged = line
    this.#host.log[level](line)
  }

  #teardown(code: number, reason: string): void {
    this.#generation++
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#silenceTimer)
    this.#retryTimer = undefined
    this.#silenceTimer = undefined
    const socket = this.#socket
    this.#socket = undefined
    this.#welcomed = false
    this.#lastState = undefined
    this.#lastEditor = undefined
    this.#features.clear()
    this.#failComposes("The connection to Ntwine closed.")
    if (socket) {
      socket.removeAllListeners()
      // A listener stays on 'error': a socket closed mid-handshake emits one, and an unheard 'error' throws.
      socket.on("error", () => {})
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      else socket.terminate()
    }
  }

  #failComposes(error: string): void {
    for (const [id, pending] of this.#composes) {
      clearTimeout(pending.timer)
      pending.resolve({ t: "composed", id, ok: false, error })
    }
    this.#composes.clear()
  }

  #scheduleRetry(incompatible = false): void {
    if (!this.#running) return
    clearTimeout(this.#retryTimer)
    // An incompatible Ntwine stays incompatible until someone updates it; ask at the slowest pace.
    const delay = incompatible ? this.#maxBackoffMs : backoffDelay(this.#attempt++, this.#minBackoffMs, this.#maxBackoffMs, this.#random)
    this.#retryTimer = setTimeout(() => void this.#dial(), delay)
  }

  #armSilence(generation: number): void {
    clearTimeout(this.#silenceTimer)
    this.#silenceTimer = setTimeout(() => {
      if (generation !== this.#generation) return
      this.#host.log.warn(`Ntwine sent nothing for ${Math.round(this.#silenceMs / 1000)}s; reconnecting.`)
      this.#lastLogged = undefined
      this.#socket?.terminate()
    }, this.#silenceMs)
  }

  #send(message: EditorClientMessage): boolean {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  async #dial(): Promise<void> {
    if (!this.#running) return
    const generation = ++this.#generation
    clearTimeout(this.#retryTimer)
    let found: { origin: string; detail: string } | undefined
    try {
      found = await this.#host.discover()
    } catch (error) {
      this.#host.log.error(`Looking for Ntwine failed: ${(error as Error).message}`)
    }
    if (generation !== this.#generation || !this.#running) return
    if (!found) {
      const reason = "Ntwine isn't running."
      this.#logOnce("info", `Ntwine isn't running; looking again shortly.`)
      if (this.#status.kind !== "offline" || this.#status.reason !== reason) this.#setStatus({ kind: "offline", reason })
      this.#scheduleRetry()
      return
    }

    const { origin, detail } = found
    const url = `${origin.replace(/^http/u, "ws")}${EDITOR_SOCKET_PATH}`
    const socket = new WebSocket(url, { origin, handshakeTimeout: this.#handshakeTimeoutMs, maxPayload: 8 * 1024 * 1024 })
    this.#socket = socket
    this.#origin = origin
    let refusal: string | undefined

    socket.on("unexpected-response", (_request, response) => {
      // A Ntwine from before the editor connection answers the upgrade with a plain 404.
      this.#predatesBridge = response.statusCode === 404
      refusal = response.statusCode === 404
        ? "This Ntwine has no editor connection yet. Update Ntwine."
        : `Ntwine refused the connection (HTTP ${response.statusCode}).`
      socket.terminate()
    })
    socket.on("error", (error) => {
      if (generation !== this.#generation) return
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ECONNREFUSED") this.#predatesBridge = false
      // A Ntwine from before the editor connection, behind its restart supervisor, does not answer the
      // upgrade at all: the child drops a path it has no handler for. Measured against one 2026-10-01.
      refusal ??= code === "ECONNREFUSED"
        ? "Ntwine isn't running."
        : code === "ECONNRESET" || error.message === "socket hang up"
          ? "Ntwine didn't accept the editor connection. Update Ntwine if this keeps happening."
          : `Couldn't reach Ntwine: ${error.message}`
    })
    socket.on("open", () => {
      if (generation !== this.#generation) return
      this.#armSilence(generation)
      const hello = this.#fitted(this.#host.hello())
      this.#helloState = stateKey(hello)
      this.#send({ t: "hello", v: EDITOR_PROTOCOL_VERSION, ...hello })
    })
    socket.on("message", (data) => {
      if (generation !== this.#generation) return
      this.#armSilence(generation)
      let message: EditorServerMessage
      try {
        message = JSON.parse(data.toString()) as EditorServerMessage
      } catch {
        this.#host.log.warn("Ntwine sent a frame that is not JSON; ignored.")
        return
      }
      void this.#receive(message, generation, origin, detail)
    })
    socket.on("close", (code, buffer) => {
      if (generation !== this.#generation) return
      clearTimeout(this.#silenceTimer)
      this.#socket = undefined
      const wasWelcomed = this.#welcomed
      this.#welcomed = false
      this.#lastState = undefined
      this.#lastEditor = undefined
      this.#features.clear()
      this.#failComposes("The connection to Ntwine closed.")
      const closed = refusal && !wasWelcomed ? { reason: refusal, incompatible: false } : describeClose(code, buffer.toString())
      this.#logOnce(closed.incompatible ? "error" : "warn", `${closed.reason}${refusal && !wasWelcomed ? "" : ` [${code}]`}`)
      this.#setStatus(closed.incompatible ? { kind: "incompatible", reason: closed.reason } : { kind: "offline", reason: closed.reason })
      this.#scheduleRetry(closed.incompatible)
    })
  }

  async #receive(message: EditorServerMessage, generation: number, origin: string, detail: string): Promise<void> {
    switch (message.t) {
      case "welcome": {
        const restarted = this.#bootId !== undefined && this.#bootId !== message.bootId
        this.#bootId = message.bootId
        this.#welcomed = true
        this.#predatesBridge = false
        this.#attempt = 0
        this.#lastState = this.#helloState
        this.#lastLogged = undefined
        this.#features = new Set(Array.isArray(message.features) ? message.features.filter((feature): feature is string => typeof feature === "string") : [])
        this.#lastEditor = undefined
        const blind = this.#host.editor && !this.#features.has(EDITOR_FEATURES.editorState) ? "; this Ntwine is too old for its agents to read the editor, so update it" : ""
        this.#host.log.info(`Connected to Ntwine at ${origin} (${detail})${restarted ? "; Ntwine restarted since the last connection" : ""}${blind}.`)
        this.#setStatus({ kind: "connected", origin, bootId: message.bootId })
        // What this window can do beyond v1, to a Ntwine that takes the frame (see the header).
        if (this.#host.review && this.#features.has(EDITOR_FEATURES.review)) this.#send({ t: "features", features: [EDITOR_FEATURES.review] })
        // Anything that changed between the hello and the welcome, and the editor's picture: a Ntwine that
        // just (re)started knows nothing of it.
        this.sendState()
        this.sendEditor()
        return
      }
      case "projects":
        this.#host.projects(Array.isArray(message.projects) ? message.projects : [])
        return
      case "open":
      case "focus":
      case "review": {
        let result: OpenResult
        try {
          if (message.t === "open") result = await this.#host.open(message)
          else if (message.t === "focus") result = await this.#host.focus(message)
          else result = this.#host.review ? await this.#host.review(message) : { ok: false, error: "This window can't show changes." }
        } catch (error) {
          result = { ok: false, error: (error as Error).message }
        }
        if (generation !== this.#generation) return
        this.#send({ t: "result", id: message.id, ok: result.ok, ...(result.ok || !result.error ? {} : { error: result.error.slice(0, 1000) }) })
        return
      }
      case "composed": {
        const pending = this.#composes.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#composes.delete(message.id)
        pending.resolve(message)
        return
      }
      case "hb":
        return
      default:
        // A newer Ntwine may say things this version does not know; ignoring them is the compatible answer.
        return
    }
  }
}

/**
 * The frame as THIS Ntwine's schema takes it. A server from before `withheld` (its welcome does not name
 * EDITOR_FEATURES.selectionWithheld) refuses the key, so a withheld selection goes to it as one whose text
 * did not fit — `truncated`, no text — which still keeps the text home, and its agents are told to read the
 * file if they need it.
 */
export function forServer(snapshot: EditorSnapshot, features: ReadonlySet<string>): EditorSnapshot {
  const selection = snapshot.active?.selection
  if (!selection?.withheld || features.has(EDITOR_FEATURES.selectionWithheld)) return snapshot
  const { withheld: _withheld, ...rest } = selection
  return { ...snapshot, active: { ...snapshot.active!, selection: { ...rest, truncated: true } } }
}
