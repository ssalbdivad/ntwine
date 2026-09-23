import type { ServerEvent } from "@frizz/shared"
import type { QueryClient } from "@tanstack/react-query"
import { store } from "../store.ts"
import { BoardStream } from "./board-stream.ts"
import { invalidateInteractionQueries } from "./interaction-cache.ts"
import { frizzRoute } from "@frizz/shared"
import { apiBase, projectSlug } from "../lib/base-path.ts"

// The SSE transport — the FALLBACK path once the /ws multiplex exists (socket.ts calls connectSSE() when
// a pre-restart server has no /ws route). It carries the board channel (keyframe + deltas + notify) through
// the shared BoardStream — the exact same delta/seq/boot state machine the socket uses. Transcript freshness
// on this path stays the 1.5s useTranscript poll (store.socketTranscripts is false while SSE is the source).

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastMsg = 0
let health: ReturnType<typeof setInterval> | null = null
let failures = 0
let qc: QueryClient | null = null

// Board seq-gap resync = reconnect the EventSource: the connect handshake re-sends the full board as a
// fresh keyframe with the current seq. NOT a failure (the connection is healthy) so it skips backoff.
const stream = new BoardStream(
  () => resync(),
  (event) => {
    if (qc) void invalidateInteractionQueries(qc, event)
  },
)

// Server pushes full board snapshots (+ optional heartbeats). If we go quiet for
// this long we assume the connection is dead and reconnect. Reattach is cheap.
const HEARTBEAT_TIMEOUT = 35_000

function connect() {
  if (es) return
  if (store.connection !== "open") store.connection = "connecting"
  es = new EventSource(`${apiBase()}/events`)
  // The project THIS stream was opened for, frozen at construction — the socket freezes the same thing
  // for the same reason (see api/socket.ts `socketProject`): a stream outlives the navigation that
  // supersedes it, and what it delivers in that window belongs to a project nobody is looking at.
  const streamProject = projectSlug()
  lastMsg = Date.now()

  es.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    failures = 0
    lastMsg = Date.now()
    store.connection = "open"
  }

  es.addEventListener("heartbeat", () => {
    lastMsg = Date.now()
  })

  es.onmessage = (e) => {
    if (streamProject !== projectSlug()) {
      foreignFrame()
      return
    }
    lastMsg = Date.now()
    try {
      stream.handle(JSON.parse(e.data) as ServerEvent)
    } catch (err) {
      console.error("bad SSE event", err)
    }
  }

  es.onerror = () => reconnect()

  if (!health) {
    health = setInterval(() => {
      if (es && Date.now() - lastMsg > HEARTBEAT_TIMEOUT) reconnect()
    }, 10_000)

    // Timers throttle in hidden tabs and stall across machine sleep, so a dead socket can sit
    // unnoticed until long after the user returns. These wake signals force an IMMEDIATE
    // staleness check + reconnect the moment the user is back.
    const wake = () => {
      if (!es || Date.now() - lastMsg > HEARTBEAT_TIMEOUT) reconnect(true)
    }
    window.addEventListener("focus", wake)
    window.addEventListener("online", wake)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) wake()
    })
  }
}

// Drop the socket and schedule a retry. While actively retrying the dot shows "connecting…";
// only a run of consecutive failures reads as truly "disconnected". Backoff grows 1s → 15s;
// `immediate` (user-return wake signals) skips the wait entirely.
function reconnect(immediate = false) {
  es?.close()
  es = null
  // The socket is gone; the fresh connect will re-establish the keyframe. Drop the seq so any stray
  // delta arriving before that keyframe forces a resync rather than applying against a torn base.
  stream.reset()
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  if (reconnectTimer) {
    if (!immediate) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const delay = immediate ? 0 : Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

// Force a fresh full-board keyframe by reconnecting. A seq gap means we can no longer trust the
// incremental board, and SSE is one-directional (no in-band resync request), so the cleanest resync is
// to drop and immediately re-open: the connect handshake re-sends the whole board with the current seq.
// This is NOT a failure — the connection is healthy — so it deliberately skips the backoff/failure
// counter; connect()'s "open" guard keeps `store.connection` from flickering.
function resync() {
  stream.reset()
  es?.close()
  es = null
  connect()
}

// Connect after load so the SSE socket doesn't consume one of Chrome's 6 per-host
// connection slots while Vite is still streaming modules in dev.
/**
 * Re-open the event stream against the project the page is NOW showing.
 *
 * The socket path is the usual one, but a server with no `/ws` has committed to SSE for the session,
 * and this stream is bound to one project exactly as the socket is — `apiBase()` derives from the
 * page's own path. Without this, switching projects on such a server leaves the board fed by the
 * project you just left.
 *
 * Called by `rebindProject` in api/socket.ts, which is the single entry point for "the page is showing
 * a different project now" and dispatches to whichever transport is live. It went a while with NO
 * caller at all, which meant the paragraph above described a bug rather than a fix.
 */
// Told when a frame is dropped because the page has left this stream's project — socket.ts owns the
// binding for both transports and un-binds on it (see `missedFrame` there). A registration rather than
// an import, because socket.ts already imports this module.
let foreignFrame: () => void = () => {}
export function onForeignSSEFrame(listener: () => void): void {
  foreignFrame = listener
}

export function rebindSSEProject(): void {
  stream.reset()
  es?.close()
  es = null
  store.connection = "connecting"
  connect()
}

export function connectSSE(queryClient?: QueryClient) {
  if (queryClient) qc = queryClient
  if (document.readyState === "complete") connect()
  else window.addEventListener("load", connect, { once: true })
}
