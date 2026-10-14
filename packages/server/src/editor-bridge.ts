import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, sep } from "node:path"
import { WebSocketServer, type RawData, type WebSocket } from "ws"
import {
  EDITOR_CLOSE,
  EDITOR_FEATURES,
  EDITOR_PROTOCOL_VERSION,
  EDITOR_SOCKET_PATH,
  EditorClientMessageSchema,
  editorKindOf,
  queuedThread,
  queueUrgency,
  workingThread,
  type EditorAttentionNeeds,
  type EditorAttentionThread,
  type EditorComposeInput,
  type EditorComposeItem,
  type EditorFront,
  type EditorHello,
  type EditorKind,
  type EditorProject,
  type EditorReviewTarget,
  type EditorServerMessage,
  type EditorSnapshot,
  type EditorStateResult,
  type EditorStateWindow,
  type EditorWindowSummary,
  type FilePosition,
  type ServerEvent,
  type ThreadView,
} from "@ntwine/shared"
import { isHomeWorkspace } from "./home-workspace.ts"
import { isUnder } from "./local-file.ts"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"

// THE EDITOR BRIDGE — the server end of `/_ntwine/editor`, the socket every VS Code / Cursor / Windsurf
// window running the ntwine extension (packages/vscode) dials. Design: ARCHITECTURE.md § VS Code extension; the
// wire: @ntwine/shared editor-protocol.ts.
//
// ONE PER MACHINE, like the server. index.ts builds it once beside the tenant map and answers the
// upgrade before tenant routing, and every project's router reaches it through `ctx.editors`: a
// window's folders can span several projects, and a file link clicked in any project's page has to be
// able to land in any window.
//
// What it holds is small and all in memory: the connected windows (their folders, focus and app, and
// what their editor last showed, for the agents), the requests waiting on a window's answer, and the
// selections an editor sent to the prompt box until a page claims one. Nothing survives a restart, and
// nothing needs to — the extension reconnects and says it all again.
//
// And it tells ONE window when a thread needs the human (`attention`): it listens on every open
// project's bus for the board's own needs-you edge while a window wants to hear it, and hands each one
// to the window the human was in last of those that have the project open.

export const EDITOR_MAX_WINDOWS = 32
/**
 * `ws`'s own frame ceiling, sized for a compose: its text may be EDITOR_COMPOSE_MAX_TEXT (64 Ki) UTF-16
 * units (editor-protocol.ts), which is 64 KiB of ASCII but up to three times that as UTF-8. A frame past
 * this is closed 1009 by `ws` before it reaches a schema, so the extension has to fit a compose by its
 * encoded size, not its text's length.
 */
export const EDITOR_MAX_PAYLOAD_BYTES = 128 * 1024
/**
 * Every other frame is a hello, a state, a result or an editor snapshot. A real hello is a few KiB; only
 * dozens of folders with kilobyte-long paths come near this. A snapshot can be larger — a selection's
 * text, a hundred diagnostics — and the extension fits it under EDITOR_STATE_MAX_BYTES (editor-protocol.ts),
 * which is below this, before sending. It is a limit of its own, not implied by the per-field ones
 * in editor-protocol.ts (EDITOR_MAX_FOLDERS x EDITOR_MAX_PATH alone allows 256 KiB): a frame past it is
 * refused 4401, and one past EDITOR_MAX_PAYLOAD_BYTES is closed 1009 by `ws` first.
 */
export const EDITOR_MAX_FRAME_BYTES = 64 * 1024
export const EDITOR_HEARTBEAT_MS = 15_000
export const EDITOR_PROJECTS_POLL_MS = 2_000
export const EDITOR_REQUEST_TIMEOUT_MS = 5_000
/**
 * A review asks git several questions per checkout before it answers (packages/vscode review.ts): the
 * base, the changed files, which are binary. Each is milliseconds, but a cold repository on a busy disk
 * is not, and an answer late is a review the human sees anyway — a false "did not answer" is worse.
 */
export const EDITOR_REVIEW_TIMEOUT_MS = 20_000
export const EDITOR_HELLO_TIMEOUT_MS = 10_000
export const EDITOR_COMPOSE_TTL_MS = 10 * 60_000
/**
 * How long the bridge gathers editor changes before it tells the pages (`editor-front`). A selection
 * dragged over lines arrives as a frame every 250ms (the extension's debounce), and a click into another
 * window as a `state` from each; one ping per burst is all a page needs, since it asks for the whole
 * picture anyway.
 */
export const EDITOR_FRONT_COALESCE_MS = 100
export const EDITOR_COMPOSE_MAX_ITEMS = 20

export interface EditorBridgeDeps {
  /** The server's boot id, read at each hello (the launching context's, which exists only once boot has built it). */
  bootId: () => string
  /** Every registered project and Home, with counts for the open ones (listEditorProjects). */
  listProjects: () => EditorProject[] | Promise<EditorProject[]>
  /** Publish on EVERY open project's bus: a page hears only its own project's. */
  publish: (event: ServerEvent) => void
  /**
   * Every OPEN project: the folder its agents run in (what a window "has open" is judged against), the
   * bus its board publishes the needs-you edge on, and the board to read that thread from. Read on every
   * projects poll while a window listens for attention; absent, no window is ever told.
   */
  openProjects?: () => readonly AttentionSource[]
  now?: () => number
  /** This server's `os.homedir()` / `process.platform` — what a window must share before it may take a file no folder of it holds. */
  home?: string
  platform?: string
  requestTimeoutMs?: number
  reviewTimeoutMs?: number
  heartbeatMs?: number
  projectsPollMs?: number
  helloTimeoutMs?: number
  composeTtlMs?: number
  maxComposeItems?: number
  maxWindows?: number
  frontCoalesceMs?: number
}

export interface EditorBridge {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
  /** The connected windows, in the order they connected. */
  windows(): EditorWindowSummary[]
  /**
   * Hand a file to the editor window that should show it. True: a window opened it. False: no window
   * of `kinds` may take it, it did not answer in time, or it went away — the caller spawns the opener
   * instead. THROWS with the window's own words when it answered that it could not, because a second
   * opener would only fail the same way in another window.
   */
  openFile(path: string, position: FilePosition | undefined, kinds: readonly EditorKind[]): Promise<boolean>
  /**
   * Raise a window of `kinds` that has `dir` open as a workspace folder. True: it came to the front.
   * False otherwise — never a throw: a window that answers it cannot raise itself (an editor without
   * `workbench.action.focusWindow`) is exactly the case the caller's fallback serves, since the editor's
   * own CLI spawned on the folder raises the window that has it open.
   */
  focusFolder(dir: string, kinds: readonly EditorKind[]): Promise<boolean>
  /**
   * Show a thread's changes (`review`) in the window that should: one that can and takes things from
   * ntwine, whose workspace folder holds a checkout of the review — the deepest, the first checkout first —
   * or the project folder; else the window the human was in last that shares this server's filesystem.
   * True: it opened them. False: no window can, or it did not answer. THROWS with the window's own words
   * when it answered that it could not (nothing to review, not a repository).
   */
  review(target: EditorReviewTarget, projectDir: string): Promise<boolean>
  /** Claim a held compose item: that one, or with no id the oldest. Null when there is none (or it expired). */
  takeCompose(id?: string): EditorComposeItem | null
  /**
   * What the editor windows that have `dir` open show — their file in front, selection, tabs and
   * problems — the one the human was in last first; and how many windows are connected at all. A window
   * "has" the project when a workspace folder of it holds the project folder or sits inside it (a
   * package of a monorepo, a thread's worktree opened with "Open in editor"), or when its file in front
   * is under the project folder. `also` are more folders that count the same way — a thread's checkout
   * outside the project folder (a sibling worktree), so a window opened on it is the thread's window.
   */
  editorState(dir: string, also?: readonly string[]): EditorStateResult
  /**
   * What a browser tab beside the editor shows of it (editor-protocol.ts EditorFront): the file in front of
   * the window `editorState` would put first for `dir` — the one the agents' `editor` tool reads — and its
   * selection's lines. Null when no window has the project open, when that window does not share its
   * editor (or has not said), or when it has no text editor in front: the tool would read nothing either.
   */
  front(dir: string): EditorFront | null
  /**
   * What a click on that line adds to a prompt box: the selection WITH its text — or, past what the frame
   * carried whole, or from a file whose text stays home, its lines alone — or with nothing selected the
   * file. The compose shape an editor's own "Add to ntwine prompt" sends, so the page makes the same chip.
   * Null when `front` is, and for an untitled buffer, which no chip can name.
   */
  frontItem(dir: string): EditorComposeInput | null
}

/** One open project, as the needs-you notifications read it (EditorBridgeDeps.openProjects). */
export interface AttentionSource {
  id: string
  dir: string
  bus: { subscribe(listener: (event: ServerEvent) => void): () => void }
  board: { snapshot(): Promise<{ threads: ThreadView[] }> }
}

interface EditorWindow {
  windowId: string
  app: string
  /** The extension's build, as its hello said it. */
  extensionVersion: string
  kind: EditorKind
  folders: string[]
  focused: boolean
  /** The last moment this window was seen focused: when it gained focus, and again when it lost it — or, from a hello, what its `focusedAgoMs` says. 0 is never. */
  lastFocusedAt: number
  acceptsOpens: boolean
  home: string
  platform: string
  /** Its latest `editor` frame and when it arrived; absent until the extension sends one. */
  editor?: { snapshot: Omit<EditorSnapshot, "t">; at: number }
  /** What it said it can do beyond v1 (its `features` frame); empty until it says. */
  features: ReadonlySet<string>
  /** It said it shows needs-you notifications (`listen`); false until it does. */
  attention: boolean
}

/** How a request to a window ended: its answer, or "gone" for a timeout or a dropped socket. */
type Outcome = { ok: true } | { ok: false; error?: string } | "gone"

interface Connection {
  ws: WebSocket
  /** Order of arrival — the last tie-break, so of two windows nobody has focused the newer one wins. */
  seq: number
  /** Set by the hello; until then the socket is not a window and nothing is routed to it. */
  window?: EditorWindow
  helloTimer?: NodeJS.Timeout
  missedPongs: number
  pending: Map<string, (outcome: Outcome) => void>
  /** The projects frame this window last got, so the poll re-sends only what changed. */
  sentProjects?: string
}

function rawText(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}

function realpathOrUndefined(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

/**
 * `real` (a file under `realFolder`) spelled through the folder the WINDOW has open. A window whose
 * folder is a symlink (`/tmp` on macOS is `/private/tmp`; a checkout linked into `~/src`) shows a file
 * opened by its real path as one OUTSIDE its workspace — a separate tab with no git decorations — so
 * the path goes back in the window's own terms. Where the two do not share a string prefix (a Windows
 * path in another case, matched by identity) the real path is the honest answer.
 */
function spelledThrough(folder: string, realFolder: string, real: string): string {
  if (real === realFolder) return folder
  const prefix = realFolder.endsWith(sep) ? realFolder : realFolder + sep
  if (!real.startsWith(prefix)) return real
  const rest = real.slice(prefix.length)
  return folder.endsWith(sep) ? folder + rest : folder + sep + rest
}

/** Whether `a` was focused more recently than `b`; a window focused right now beats every other. */
function moreRecentlyFocused(a: Connection, b: Connection): boolean {
  const rank = (c: Connection) => (c.window!.focused ? Number.POSITIVE_INFINITY : c.window!.lastFocusedAt)
  const ra = rank(a)
  const rb = rank(b)
  return ra !== rb ? ra > rb : a.seq > b.seq
}

export function createEditorBridge(deps: EditorBridgeDeps): EditorBridge {
  const now = deps.now ?? Date.now
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const requestTimeoutMs = deps.requestTimeoutMs ?? EDITOR_REQUEST_TIMEOUT_MS
  const reviewTimeoutMs = deps.reviewTimeoutMs ?? EDITOR_REVIEW_TIMEOUT_MS
  const heartbeatMs = deps.heartbeatMs ?? EDITOR_HEARTBEAT_MS
  const projectsPollMs = deps.projectsPollMs ?? EDITOR_PROJECTS_POLL_MS
  const helloTimeoutMs = deps.helloTimeoutMs ?? EDITOR_HELLO_TIMEOUT_MS
  const composeTtlMs = deps.composeTtlMs ?? EDITOR_COMPOSE_TTL_MS
  const maxComposeItems = deps.maxComposeItems ?? EDITOR_COMPOSE_MAX_ITEMS
  const maxWindows = deps.maxWindows ?? EDITOR_MAX_WINDOWS
  const frontCoalesceMs = deps.frontCoalesceMs ?? EDITOR_FRONT_COALESCE_MS

  const wss = new WebSocketServer({ noServer: true, maxPayload: EDITOR_MAX_PAYLOAD_BYTES })
  wss.on("error", () => {})
  const connections = new Set<Connection>()
  const terminationTimers = new WeakMap<WebSocket, NodeJS.Timeout>()
  let pendingUpgrades = 0
  let seq = 0
  let closing = false
  let closePromise: Promise<void> | null = null
  let heartbeatTimer: NodeJS.Timeout | undefined
  let projectsTimer: NodeJS.Timeout | undefined
  let projectsPoll: Promise<void> | null = null
  let projectsPollAgain = false
  // What the pages were last told, so a window's focus moving (which they do not show) publishes nothing.
  let publishedEditors = "[]"
  // What every page could learn from `editorFront` as of the last `editor-front`, so a frame that changes
  // nothing a page shows (a tab opened, a diagnostic, the lines on screen) publishes nothing.
  let publishedFronts = "[]"
  let frontTimer: NodeJS.Timeout | undefined
  const compose: { item: EditorComposeItem; expiresAt: number }[] = []

  function send(conn: Connection, msg: EditorServerMessage): boolean {
    if (conn.ws.readyState !== conn.ws.OPEN) return false
    try {
      conn.ws.send(JSON.stringify(msg), () => {})
      return true
    } catch {
      return false
    }
  }

  function closeWith(conn: Connection, code: number, reason: string): void {
    const { ws } = conn
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    try {
      ws.close(code, reason)
      // A peer that stopped reading may never take the close frame; reclaim it after a short grace, as
      // the application socket does.
      const timer = setTimeout(() => {
        try { ws.terminate() } catch {}
      }, 250)
      timer.unref?.()
      terminationTimers.set(ws, timer)
    } catch {
      try { ws.terminate() } catch {}
    }
  }

  function summaries(): EditorWindowSummary[] {
    const out: EditorWindowSummary[] = []
    for (const conn of connections) {
      if (!conn.window) continue
      const { app, kind, acceptsOpens, features, extensionVersion } = conn.window
      out.push({ app, kind, acceptsOpens, ...(features.has(EDITOR_FEATURES.review) ? { reviews: true as const } : {}), ...(extensionVersion ? { extensionVersion } : {}) })
    }
    return out
  }

  // The `editors` event carries exactly what the page shows — app, family, whether opens are on — so it
  // goes out when one of those changes or a window comes or goes, and never for a focus change.
  function publishEditorsIfChanged(): void {
    if (closing) return
    const windows = summaries()
    const json = JSON.stringify(windows)
    if (json === publishedEditors) return
    publishedEditors = json
    try { deps.publish({ type: "editors", windows }) } catch {}
  }

  // `editor-front`, after the burst a change arrives in (EDITOR_FRONT_COALESCE_MS), when what a browser tab
  // shows of some window changed. The diff is over every window in the order `editorState` ranks them —
  // their folders, which decide whose project each one has open, and what each has in front — so a page
  // asks again exactly when the answer for SOME project could differ. Payload-free and machine-wide: the
  // ping cannot say which project, so it says nothing about any, and each page asks its own.
  function frontsChanged(): void {
    if (closing || frontTimer) return
    frontTimer = setTimeout(() => {
      frontTimer = undefined
      if (closing) return
      const ranked = [...connections].filter((c) => c.window).sort((a, b) => (moreRecentlyFocused(a, b) ? -1 : moreRecentlyFocused(b, a) ? 1 : 0))
      const json = JSON.stringify(ranked.map((c) => [c.window!.folders, frontOf(c.window!)]))
      if (json === publishedFronts) return
      publishedFronts = json
      try { deps.publish({ type: "editor-front" }) } catch {}
    }, frontCoalesceMs)
    frontTimer.unref?.()
  }

  // An in-memory diff of the projects list, re-sent to each window whose last copy differs. Polled
  // rather than evented because the counts it carries are board facts of EVERY open project, and two
  // seconds of lag on a status-bar number is worth not threading a listener through each tenant's bus.
  async function pollProjects(): Promise<void> {
    if (projectsPoll) {
      projectsPollAgain = true
      return projectsPoll
    }
    projectsPoll = (async () => {
      do {
        projectsPollAgain = false
        // A project opened or closed since the last tick changes which buses there are to hear.
        watchAttention()
        if (closing || ![...connections].some((c) => c.window)) return
        let projects: EditorProject[]
        try {
          projects = await deps.listProjects()
        } catch {
          return // a registry read failing mid-write; the next tick tries again
        }
        const json = JSON.stringify(projects)
        for (const conn of connections) {
          if (!conn.window || conn.sentProjects === json) continue
          if (send(conn, { t: "projects", projects })) conn.sentProjects = json
        }
      } while (projectsPollAgain)
    })().finally(() => { projectsPoll = null })
    return projectsPoll
  }

  // Protocol pings reap a socket whose peer vanished without a close (a laptop lid, a killed extension
  // host); the `hb` frame is the extension's half — it reconnects when it hears none for 45s.
  function heartbeat(): void {
    for (const conn of connections) {
      if (conn.missedPongs >= 2) {
        try { conn.ws.terminate() } catch {}
        continue
      }
      conn.missedPongs++
      try { conn.ws.ping() } catch {}
      if (conn.window) send(conn, { t: "hb" })
    }
  }

  function startTimers(): void {
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(heartbeat, heartbeatMs)
      heartbeatTimer.unref?.()
    }
    if (!projectsTimer) {
      projectsTimer = setInterval(() => void pollProjects(), projectsPollMs)
      projectsTimer.unref?.()
    }
  }

  function stopTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (projectsTimer) clearInterval(projectsTimer)
    heartbeatTimer = undefined
    projectsTimer = undefined
  }

  function drop(conn: Connection): void {
    if (!connections.delete(conn)) return
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    const timer = terminationTimers.get(conn.ws)
    if (timer) clearTimeout(timer)
    for (const settle of [...conn.pending.values()]) settle("gone")
    if (conn.window) {
      conn.window = undefined
      publishEditorsIfChanged()
      frontsChanged()
      watchAttention()
    }
    if (connections.size === 0) stopTimers()
  }

  function onHello(conn: Connection, msg: EditorHello): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    // A window that reconnected before its old socket was reaped: the old one is dead weight that would
    // otherwise win an open, time out, and cost the human five seconds before the fallback.
    for (const other of connections) {
      if (other !== conn && other.window?.windowId === msg.windowId) {
        other.window = undefined
        closeWith(other, 1000, "superseded")
      }
    }
    // A reconnect must not erase which window the human used last: after an ntwine restart every window
    // redials while they are in the browser, and with every one at 0 the last to redial won each open
    // no folder claims. Clamped, so a window that says it was focused before the epoch ranks as never.
    const at = now()
    const lastFocusedAt = msg.focused ? at : msg.focusedAgoMs === undefined ? 0 : Math.min(at, Math.max(0, at - msg.focusedAgoMs))
    conn.window = {
      windowId: msg.windowId,
      app: msg.app,
      extensionVersion: msg.extensionVersion,
      kind: editorKindOf(msg.app),
      folders: msg.folders,
      focused: msg.focused,
      lastFocusedAt,
      acceptsOpens: msg.acceptsOpens,
      home: msg.home,
      platform: msg.platform,
      features: new Set(),
      attention: false,
    }
    send(conn, { t: "welcome", v: EDITOR_PROTOCOL_VERSION, bootId: deps.bootId(), features: [EDITOR_FEATURES.editorState, EDITOR_FEATURES.selectionWithheld, EDITOR_FEATURES.review, EDITOR_FEATURES.sidebar, EDITOR_FEATURES.attention] })
    publishEditorsIfChanged()
    frontsChanged()
    void pollProjects()
  }

  function onFrame(conn: Connection, raw: RawData, isBinary: boolean): void {
    const { ws } = conn
    if (closing || ws.readyState !== ws.OPEN) return
    if (isBinary) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "text frames only")
    const bytes = rawText(raw)
    let decoded: unknown
    try {
      decoded = JSON.parse(bytes.toString("utf8"))
    } catch {
      return closeWith(conn, EDITOR_CLOSE.invalidMessage, "invalid frame")
    }
    const t = typeof decoded === "object" && decoded !== null ? (decoded as { t?: unknown }).t : undefined
    if (!conn.window) {
      if (t !== "hello") return closeWith(conn, EDITOR_CLOSE.helloRequired, "hello required")
      // Before the schema, which would call any other version merely invalid: the extension has to be
      // able to tell "update one of us" from "a bug".
      if ((decoded as { v?: unknown }).v !== EDITOR_PROTOCOL_VERSION) {
        return closeWith(conn, EDITOR_CLOSE.unsupportedVersion, `unsupported version; this ntwine speaks ${EDITOR_PROTOCOL_VERSION}`)
      }
    }
    if (t !== "compose" && bytes.length > EDITOR_MAX_FRAME_BYTES) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "frame too large")
    const parsed = EditorClientMessageSchema.safeParse(decoded)
    if (!parsed.success) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "invalid frame")
    const msg = parsed.data
    if (msg.t === "hello") {
      if (conn.window) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "hello twice")
      return onHello(conn, msg)
    }
    const window = conn.window!
    if (msg.t === "state") {
      // Gaining focus and losing it both mean "focused until now"; that moment is what ranks windows.
      if (msg.focused || window.focused) window.lastFocusedAt = now()
      window.folders = msg.folders
      window.focused = msg.focused
      window.acceptsOpens = msg.acceptsOpens
      publishEditorsIfChanged()
      frontsChanged()
      return
    }
    if (msg.t === "result") {
      conn.pending.get(msg.id)?.(msg.ok ? { ok: true } : { ok: false, error: msg.error })
      return
    }
    if (msg.t === "features") {
      window.features = new Set(msg.features)
      publishEditorsIfChanged()
      return
    }
    if (msg.t === "listen") {
      window.attention = msg.attention
      watchAttention()
      return
    }
    if (msg.t === "editor") {
      // Kept whole, replacing the last: the extension sends the entire picture on every change, so there
      // is nothing to merge, and a window that turned sharing off sends `shared: false` with nothing else.
      const { t: _t, ...snapshot } = msg
      window.editor = { snapshot, at: now() }
      frontsChanged()
      return
    }
    // compose: held for whichever page claims it (composeTake), announced to every open project's pages.
    pruneCompose()
    if (compose.length >= maxComposeItems) {
      send(conn, { t: "composed", id: msg.id, ok: false, error: `${maxComposeItems} selections are already waiting. Open ntwine to insert them.` })
      return
    }
    const at = now()
    const item: EditorComposeItem = { ...msg.item, id: randomUUID(), app: window.app, at: new Date(at).toISOString() }
    compose.push({ item, expiresAt: at + composeTtlMs })
    send(conn, { t: "composed", id: msg.id, ok: true })
    try { deps.publish({ type: "compose-pending", id: item.id }) } catch {}
  }

  function pruneCompose(): void {
    const at = now()
    for (let i = compose.length - 1; i >= 0; i--) if (compose[i]!.expiresAt <= at) compose.splice(i, 1)
  }

  function accept(ws: WebSocket): void {
    const conn: Connection = { ws, seq: ++seq, missedPongs: 0, pending: new Map() }
    connections.add(conn)
    conn.helloTimer = setTimeout(() => {
      if (!conn.window) closeWith(conn, EDITOR_CLOSE.helloRequired, "hello required")
    }, helloTimeoutMs)
    conn.helloTimer.unref?.()
    ws.on("pong", () => { conn.missedPongs = 0 })
    ws.on("message", (raw, isBinary) => onFrame(conn, raw, isBinary))
    ws.on("close", () => drop(conn))
    ws.on("error", () => closeWith(conn, 1011, "transport failed"))
    startTimers()
  }

  /** Send `open`/`focus`/`review` and wait for the window's `result`. */
  function request(
    conn: Connection,
    frame: { t: "open"; path: string } & Partial<FilePosition> | { t: "focus"; path: string } | { t: "review" } & EditorReviewTarget,
    timeoutMs = requestTimeoutMs,
  ): Promise<boolean> {
    const id = randomUUID()
    const app = conn.window!.app
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => settle("gone"), timeoutMs)
      function settle(outcome: Outcome): void {
        clearTimeout(timer)
        conn.pending.delete(id)
        if (outcome === "gone") resolve(false)
        else if (outcome.ok) resolve(true)
        else reject(new Error(outcome.error || (frame.t === "review" ? `${app} could not show the changes` : `${app} could not open ${basename(frame.path)}`)))
      }
      conn.pending.set(id, settle)
      if (!send(conn, { ...frame, id } as EditorServerMessage)) settle("gone")
    })
  }

  function eligible(kinds: readonly EditorKind[]): Connection[] {
    return [...connections].filter((c) => c.window && c.window.acceptsOpens && kinds.includes(c.window.kind))
  }

  /** Whether `window` has the project at `dir` (realpath `realDir`) open; see EditorBridge.editorState. */
  function holdsProject(window: EditorWindow, dir: string, realDir: string): boolean {
    for (const folder of window.folders) {
      const realFolder = realpathOrUndefined(folder)
      if (realFolder && (isUnder(realDir, folder) || isUnder(realFolder, dir))) return true
    }
    const active = window.editor?.snapshot.active
    if (!active || active.untitled) return false
    const realActive = realpathOrUndefined(active.path)
    return realActive !== undefined && isUnder(realActive, dir)
  }

  /**
   * The windows that have the project at `dir` (or one of `also`) open, the one the human was in last
   * first — EditorBridge.editorState's ranking, which `front` reads the head of, so the browser's line and
   * the agents' tool name the same window.
   */
  function windowsHolding(dir: string, also: readonly string[] = []): Connection[] {
    const targets = closing ? [] : [dir, ...also].flatMap((folder) => {
      const real = realpathOrUndefined(folder)
      return real ? [{ folder, real }] : []
    })
    const matched: Connection[] = []
    for (const conn of connections) {
      const window = conn.window
      if (window && targets.some((target) => holdsProject(window, target.folder, target.real))) matched.push(conn)
    }
    return matched.sort((a, b) => (moreRecentlyFocused(a, b) ? -1 : moreRecentlyFocused(b, a) ? 1 : 0))
  }

  /** What a window shows a browser tab (EditorFront): its file in front and selection, while it shares. */
  function frontOf(window: EditorWindow): EditorFront | null {
    const snapshot = window.editor?.snapshot
    const active = snapshot?.shared ? snapshot.active : null
    if (!active) return null
    const { selection } = active
    return {
      app: window.app,
      kind: window.kind,
      path: active.path,
      ...(active.untitled ? { untitled: true as const } : {}),
      ...(active.dirty ? { dirty: true as const } : {}),
      cursorLine: active.cursorLine,
      ...(selection ? { selection: { startLine: selection.startLine, endLine: selection.endLine } } : {}),
      ...(selection?.withheld ? { withheld: true as const } : {}),
    }
  }

  function mostRecent(candidates: readonly Connection[]): Connection | undefined {
    let best: Connection | undefined
    for (const c of candidates) if (!best || moreRecentlyFocused(c, best)) best = c
    return best
  }

  // ── attention: one window told when a thread needs the human ────────────────────────────────────
  //
  // THE SIGNAL IS THE BOARD'S OWN: `notify` `needs-decision`, which board.ts notifyNeedsYou publishes on
  // the edge of a thread entering the queue — a question, a request, a finished turn — deduped, primed at
  // boot so a restart does not announce the whole queue, and quiet for a thread that comes back to the
  // place it left. The page's desktop notifications fire on the same event, so a VS Code notification is
  // never news the board would not call news. Computing an edge here from the projects poll would be a
  // second notifier, and the two disagreeing is what shared queueUrgency was written to end.
  //
  // Buses are heard only while some window wants it: a subscription per open project, kept in step with
  // the open projects on every projects poll (2s), and dropped when the last listening window goes.

  const watching = new Map<string, { bus: AttentionSource["bus"]; stop: () => void }>()

  function watchAttention(): void {
    const wanted = closing || !deps.openProjects || ![...connections].some((c) => c.window?.attention) ? [] : deps.openProjects()
    const keep = new Set<string>()
    for (const source of wanted) {
      keep.add(source.id)
      const current = watching.get(source.id)
      // The same bus is the same project still open; a project reopened (a moved checkout) has a new one.
      if (current?.bus === source.bus) continue
      current?.stop()
      const stop = source.bus.subscribe((event) => {
        if (event.type !== "notify" || event.kind !== "needs-decision") return
        // After this task: the board publishes the edge from INSIDE its assembly, before the snapshot it
        // is assembling becomes the one `snapshot()` answers, so a read now would still see the thread out
        // of the queue.
        setTimeout(() => void tellAttention(source, event.slug, event.body), 0)
      })
      watching.set(source.id, { bus: source.bus, stop })
    }
    for (const [id, entry] of watching) {
      if (keep.has(id)) continue
      entry.stop()
      watching.delete(id)
    }
  }

  async function tellAttention(source: AttentionSource, slug: string, body: string | undefined): Promise<void> {
    let thread: ThreadView | undefined
    try {
      thread = (await source.board.snapshot()).threads.find((candidate) => candidate.id === slug)
    } catch {
      return // a board stopping: its project is closing, and nobody needs telling
    }
    // Answered in the moment since (another tab, a fast human): no longer news.
    if (!thread || !queuedThread(thread) || closing) return
    const realDir = realpathOrUndefined(source.dir)
    if (!realDir) return
    // Decided now, after the read: the window the human is in at the moment it is shown.
    const target = mostRecent([...connections].filter((c) => c.window?.attention && holdsProject(c.window, source.dir, realDir)))
    if (!target) return
    send(target, { t: "attention", projectId: source.id, thread: attentionThread(thread), needs: attentionNeeds(thread), ...(body ? { body } : {}) })
  }

  return {
    handleUpgrade(req, socket, head) {
      if ((req.url ?? "").split("?")[0] !== EDITOR_SOCKET_PATH) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // The same mandatory Origin as the application socket: a page on another origin must not be able
      // to pose as an editor and be handed every file link the human clicks.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }
      if (connections.size + pendingUpgrades >= maxWindows) {
        rejectWebSocketUpgrade(socket, 503, "Too many editor windows")
        return true
      }
      pendingUpgrades++
      let reserved = true
      const release = () => {
        if (!reserved) return
        reserved = false
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          release()
          if (closing) {
            try { ws.terminate() } catch {}
            return
          }
          accept(ws)
        })
      } catch {
        rejectWebSocketUpgrade(socket, 400, "Bad Request")
      } finally {
        // A handshake ws refuses itself (no key, a version it does not speak, a POST, a peer that already
        // sent FIN) is answered 400/405 by ws and NEVER calls back, so a release only in the callback
        // leaked the slot for good — 32 malformed upgrades refused every editor until restart. Without a
        // verifyClient, ws calls back synchronously or not at all, so by here the socket is either a
        // counted connection or refused, and no reservation has to outlive the call.
        release()
      }
      return true
    },

    close() {
      if (closePromise) return closePromise
      closing = true
      stopTimers()
      if (frontTimer) clearTimeout(frontTimer)
      frontTimer = undefined
      watchAttention()
      for (const conn of connections) for (const settle of [...conn.pending.values()]) settle("gone")
      // Terminate rather than handshake, as the application socket does: the extension reconnects on
      // any close, and a polite close can keep a replaced server alive while a sleeping peer dawdles.
      const drains = [...wss.clients].map((ws) => new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once("close", () => resolve())
        try { ws.terminate() } catch { resolve() }
      }))
      closePromise = Promise.allSettled(drains).then(() => {
        try { wss.close() } catch {}
      })
      return closePromise
    },

    windows: summaries,

    async openFile(path, position, kinds) {
      if (closing || kinds.length === 0) return false
      const real = realpathOrUndefined(path)
      if (!real) return false
      const candidates = eligible(kinds)
      // The window whose workspace folder holds the file — the deepest folder, so a window on a package
      // beats one on the whole monorepo — and among equals the one the human was in last.
      let best: { conn: Connection; depth: number; path: string } | undefined
      for (const conn of candidates) {
        for (const folder of conn.window!.folders) {
          const realFolder = realpathOrUndefined(folder)
          if (!realFolder || !isUnder(real, folder)) continue
          const depth = realFolder.length
          if (!best || depth > best.depth || (depth === best.depth && moreRecentlyFocused(conn, best.conn))) {
            best = { conn, depth, path: spelledThrough(folder, realFolder, real) }
          }
        }
      }
      // No folder holds it: what `code -g` would do, the last window the human was in — but only one
      // that reads this server's filesystem, or the path means nothing there (a Windows-side window
      // beside a WSL server, a Remote-SSH window on another box).
      const target = best ?? (() => {
        const conn = mostRecent(candidates.filter((c) => c.window!.home === home && c.window!.platform === platform))
        return conn ? { conn, path: real } : undefined
      })()
      if (!target) return false
      return request(target.conn, {
        t: "open",
        path: target.path,
        ...(position ? { line: position.line } : {}),
        ...(position?.column !== undefined ? { column: position.column } : {}),
        ...(position?.endLine !== undefined ? { endLine: position.endLine } : {}),
      })
    },

    async focusFolder(dir, kinds) {
      if (closing || kinds.length === 0) return false
      const realDir = realpathOrUndefined(dir)
      if (!realDir) return false
      // A window whose folder IS this folder: contained both ways, the same identity isUnder gives a
      // file, so a symlinked spelling and a Windows case difference still match.
      const matches: { conn: Connection; folder: string }[] = []
      for (const conn of eligible(kinds)) {
        for (const folder of conn.window!.folders) {
          const realFolder = realpathOrUndefined(folder)
          if (realFolder && isUnder(realDir, folder) && isUnder(realFolder, dir)) {
            matches.push({ conn, folder })
            break
          }
        }
      }
      const conn = mostRecent(matches.map((m) => m.conn))
      if (!conn) return false
      return request(conn, { t: "focus", path: matches.find((m) => m.conn === conn)!.folder }).catch(() => false)
    },

    async review(target, projectDir) {
      if (closing) return false
      const candidates = [...connections].filter((c) => c.window && c.window.acceptsOpens && c.window.features.has(EDITOR_FEATURES.review))
      // The checkouts first, in the review's order, then the project: a window on the thread's worktree
      // beats one on the whole project, and either beats a window on something else.
      const dirs = [...target.checkouts.map((checkout) => checkout.dir), projectDir]
      let best: { conn: Connection; rank: number; depth: number } | undefined
      for (const [rank, dir] of dirs.entries()) {
        const real = realpathOrUndefined(dir)
        if (!real) continue
        for (const conn of candidates) {
          for (const folder of conn.window!.folders) {
            const realFolder = realpathOrUndefined(folder)
            if (!realFolder || !isUnder(real, folder)) continue
            const depth = realFolder.length
            const better = !best || rank < best.rank || (rank === best.rank && (depth > best.depth || (depth === best.depth && moreRecentlyFocused(conn, best.conn))))
            if (better) best = { conn, rank, depth }
          }
        }
      }
      const conn = best?.conn ?? mostRecent(candidates.filter((c) => c.window!.home === home && c.window!.platform === platform))
      if (!conn) return false
      return request(conn, { t: "review", title: target.title, checkouts: target.checkouts }, reviewTimeoutMs)
    },

    editorState(dir, also = []) {
      const at = now()
      const matched = windowsHolding(dir, also)
      // The windows on other projects are counted, never described: their folders are not this worker's.
      const connected = [...connections].filter((conn) => conn.window).length
      const windows = matched.map(({ window }): EditorStateWindow => {
        const { app, kind, focused, lastFocusedAt, folders, editor } = window!
        return {
          app,
          kind,
          focused,
          ...(!focused && lastFocusedAt > 0 ? { focusedAgoMs: Math.max(0, at - lastFocusedAt) } : {}),
          folders,
          ...(editor ? { editor: { ...editor.snapshot, reportedAgoMs: Math.max(0, at - editor.at) } } : {}),
        }
      })
      return { windows, connected }
    },

    front(dir) {
      const first = windowsHolding(dir)[0]
      return first ? frontOf(first.window!) : null
    },

    frontItem(dir) {
      const first = windowsHolding(dir)[0]
      const front = first ? frontOf(first.window!) : null
      if (!front || front.untitled) return null
      const selection = first!.window!.editor!.snapshot.active!.selection
      if (!selection) return { path: front.path }
      // Only a WHOLE text is quoted: the start of a selection, in a chip that names all its lines, would
      // tell the agent those lines say less than they do. Cut or withheld, the lines alone, which the agent
      // reads from the file — as an editor's own add does past its ceiling.
      const whole = selection.text !== undefined && !selection.truncated && !selection.withheld
      return { path: front.path, startLine: selection.startLine, endLine: selection.endLine, ...(whole ? { text: selection.text } : {}) }
    },

    takeCompose(id) {
      pruneCompose()
      const index = id === undefined ? 0 : compose.findIndex((entry) => entry.item.id === id)
      if (index < 0 || index >= compose.length) return null
      return compose.splice(index, 1)[0]!.item
    },
  }
}

/**
 * The `projects` frame: every registered project and Home, minus any whose folder is gone (no file can
 * be in it, and a thread sent there could not run). A project open on this server carries its counts —
 * Ready is the queue (`queuedThread`), Working the rail's spinning count (`workingThread`), the same
 * predicates the page's rail badge uses. A project that is not open has no honest count, and getting
 * one is not worth opening it, so it has none (AppContext.activeTenants says why).
 */
export async function listEditorProjects(
  workspaces: readonly { id: string; slug: string; name?: string; path: string; stale: boolean }[],
  open: ReadonlyArray<{ project: { id: string }; board: { snapshot(): Promise<{ threads: ThreadView[] }> } }>,
): Promise<EditorProject[]> {
  const boards = new Map(open.map((tenant) => [tenant.project.id, tenant.board]))
  const out: EditorProject[] = []
  for (const entry of workspaces) {
    if (entry.stale) continue
    const project: EditorProject = {
      id: entry.id,
      slug: entry.slug,
      name: entry.name ?? (basename(entry.path) || entry.path),
      dir: entry.path,
      ...(isHomeWorkspace(entry.id) ? { home: true as const } : {}),
    }
    const board = boards.get(entry.id)
    if (board) {
      try {
        const { threads } = await board.snapshot()
        project.ready = threads.filter(queuedThread).length
        project.working = threads.filter(workingThread).length
      } catch {
        // A board stopping mid-walk: this round it reads as not open, which is what it is about to be.
      }
    }
    out.push(project)
  }
  return out
}

/**
 * What a queued thread needs from the human, most pressing first — read off the same reasons the queue
 * calls urgent (shared queueUrgency), so the notification says what the card will: a terminal at a prompt,
 * a request to approve, a question, a stop it cannot get past on its own, a usage limit; and with none of
 * those, a turn that finished and is ready for the human to read.
 */
export function attentionNeeds(t: ThreadView): EditorAttentionNeeds {
  const reasons = queueUrgency(t).split(" ")
  const has = (...names: string[]) => reasons.some((reason) => names.includes(reason) || names.some((name) => name.endsWith(":") && reason.startsWith(name)))
  if (has("terminal")) return "terminal"
  if (has("interaction", "perm-prompt")) return "approval"
  if (has("ask", "question", "q:")) return "question"
  if (has("crashed", "provider-error")) return "stopped"
  if (has("limit")) return "limit"
  return "ready"
}

/** The fields the extension names a thread by (its port of groups.ts displayTitle), and nothing else. */
export function attentionThread(t: ThreadView): EditorAttentionThread {
  return {
    id: t.id,
    title: t.title,
    ...(t.aiTitle !== undefined ? { aiTitle: t.aiTitle } : {}),
    ...(t.titleAuto !== undefined ? { titleAuto: t.titleAuto } : {}),
    ...(t.titleLocked !== undefined ? { titleLocked: t.titleLocked } : {}),
    ...(t.titleNamed !== undefined ? { titleNamed: t.titleNamed } : {}),
    ...(t.spawnedAt !== undefined ? { spawnedAt: t.spawnedAt } : {}),
    ...(t.backend !== undefined ? { backend: t.backend } : {}),
    ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
  }
}
