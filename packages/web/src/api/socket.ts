import type { QueryClient } from "@tanstack/react-query"
import type { SocketClientMsg, SocketServerMsg, TranscriptMessage, TranscriptPushPage } from "@ntwine/shared"
import { applyTranscriptPatch } from "@ntwine/shared"
import { store } from "../store.ts"
import { BoardStream, refreshProjectList } from "./board-stream.ts"
import { connectSSE, onForeignSSEFrame, rebindSSEProject } from "./sse.ts"
import { mergeOptimistic, preserveMessageIdentity, type QueuedMessage } from "../lib/transcript-sync.ts"
import { reconcileLatestPage, reconcileLiveMessages, type PaginatedTranscriptData } from "../lib/transcriptPagination.ts"
import { invalidateInteractionQueries } from "./interaction-cache.ts"
import { NTWINE_ROUTE_PREFIX } from "@ntwine/shared"
import { apiBase, projectSlug } from "../lib/base-path.ts"
import { localFileQueryKey } from "../lib/localFileQuery.ts"

// The stage-2 multiplexed client: ONE WebSocket("/ws") carrying the board channel (keyframe + deltas +
// notify, driven through the shared BoardStream) AND per-thread transcript push (replacing the 1.5s
// threadTranscript poll).
//
// GRACEFUL FALLBACK: a pre-restart server has no /ws route — its upgrade handler destroys the socket, so
// we never see `onopen`. On a close/error BEFORE the socket ever confirms, we hand the board channel back
// to the proven SSE path (connectSSE) and useTranscript keeps polling — i.e. EXACTLY today's behavior.
// Once confirmed, transient drops reconnect on /ws (never fall back); the boot-id reload closes the
// bundle-mismatch window across a server bounce.

let ws: WebSocket | null = null
let qc: QueryClient | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let health: ReturnType<typeof setInterval> | null = null
let failures = 0
let lastMsg = 0
let protocolReady = false
// /ws proved live at least once this session (onopen fired). A PERMANENT latch by design: after the first
// confirm, later drops reconnect on /ws with backoff and never fall back. Bounces are forward-only (/ws is
// only ever ADDED), so a hypothetical restart to a /ws-less build would retry (backoff-capped, not a storm)
// rather than degrade — an accepted tradeoff for not re-probing SSE on every transient blip.
let confirmed = false
let fellBack = false // committed to the SSE fallback — never touch /ws again this session

// slug → count of interested surfaces (main ChatView + any drawer ChatViews on the same running thread).
// Ref-counted so a drawer close doesn't unsubscribe a slug the main view still shows; the server holds one
// subscription per connection per slug, so we send `sub` on 0→1 and `unsub` on 1→0.
const subs = new Map<string, number>()

// path → count of READERS showing that local file (the /full split viewer, and every Markdown drawer
// stacked over it). Same ref-count discipline as `subs`: `sub` on 0→1, `unsub` on 1→0, replayed on
// every (re)connect. The server answers a change with `file-changed`, and the handler below
// invalidates the reader's query so it re-reads through its own gated RPC.
const fileSubs = new Map<string, number>()

// slug → the transcript window the CURRENT socket last delivered, exactly as the server sent it (before
// any reconcile with loaded history or optimistic bubbles). A `transcript-delta` is a recipe over this
// copy, never over the query cache, which holds more than the window. Reset with every socket: the server
// keeps the matching record per connection, so a new connection's first frame per slug is a full one.
let windows = new Map<string, { sig: string; messages: TranscriptMessage[] }>()
// Slugs whose delta did not match the window held here and that have asked for a fresh snapshot. Further
// deltas for them are ignored until it lands, so one mismatch costs one resubscribe, not one per frame.
const resyncing = new Set<string>()
// How many times this session has reached a live protocol (a keyframe on /ws). The first is the
// initial connect; every later one is a reconnect, across which a change to an open file may have
// gone unheard — so those re-read every open file once, and the first does not (the reader's own
// mount read is at most seconds old).
let liveGenerations = 0

// Board seq-gap resync = reconnect the socket (mirror sse.ts): drop + immediately re-open; the connect
// handshake re-sends a full keyframe with the current seq. Deliberately skips the backoff/failure counter.
const stream = new BoardStream(
  () => resync(),
  (event) => {
    if (qc) void invalidateInteractionQueries(qc, event)
  },
  () => refreshProjectList(qc),
)

// Server pushes a 10s heartbeat; if we go quiet past this we assume the socket is dead and reconnect.
const HEARTBEAT_TIMEOUT = 35_000

function wsUrl(): string {
  return `${location.origin.replace(/^http/, "ws")}${apiBase()}/ws`
}

// WHICH PROJECT THE LIVE FEED IS ON — one copy of that fact, kept by the module that actually holds the
// connection, and readable by anyone who needs to ask (`feedIsBoundTo`). It covers BOTH transports,
// because the SSE fallback is only ever reached through here.
//
// The point is that there is no SECOND copy. routes.tsx used to keep its own note of the project it had
// bound, in a ref, and a remount reset that note to whatever the new route said — so the app believed it
// was bound to a project it had never connected to, and every board showed the previous one until a
// document load (`0fb8574`). A bystander cannot get this wrong if it has nothing to remember: the thing
// that holds the socket is the only thing that says what the socket is for.
let feedProject: string | undefined
let feedBound = false

// A FRAME DROPPED BECAUSE THE PAGE HAS LEFT IS NEWS THE PROJECT'S BOARD NEVER GOT, so the feed stops
// vouching for that board. Leaving a board for a page that names no project — All queues and the project
// grid, when this was written; `/`'s welcome page now —
// keeps the connection on purpose (coming straight back is then free), but every frame that arrives
// meanwhile is discarded below, and the board in the store stays exactly as it was when the page left.
// All queues is where that bites: the operator marks the project's threads done THERE, the deltas that
// say so are dropped HERE, and a return to the board found `feedIsBoundTo` still true, so nothing
// rebound and the finished cards were still in its queue. Unbound, the return re-seeds from a keyframe.
function missedFrame(): void {
  feedBound = false
}
onForeignSSEFrame(missedFrame)

function noteFeedProject(): void {
  feedProject = projectSlug()
  feedBound = true
}

/** Is the live feed already pointed at `slug`? A caller with nothing of its own to remember. */
export function feedIsBoundTo(slug: string | undefined): boolean {
  return feedBound && feedProject === slug
}

function connect(): void {
  if (ws || fellBack) return
  if (store.connection !== "open") store.connection = "connecting"
  noteFeedProject()
  const sock = new WebSocket(wsUrl())
  // The project THIS socket was opened for, frozen at construction. Every frame it later delivers is
  // checked against it: a socket outlives the navigation that supersedes it by however long the close
  // takes, and a board or a transcript arriving down that pipe belongs to a project nobody is looking
  // at any more. Frozen rather than re-derived, because re-deriving is how a stale frame passes.
  const socketProject = projectSlug()
  ws = sock
  windows = new Map()
  resyncing.clear()
  protocolReady = false
  lastMsg = Date.now()

  sock.onopen = () => {
    // The server spoke WebSocket on /ws → the route exists → commit to socket mode.
    confirmed = true
    lastMsg = Date.now()
    store.connection = "open"
    store.socketTranscripts = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  sock.onmessage = (e) => {
    // A frame for the project we have left goes nowhere. `ws !== sock` catches a socket already
    // superseded here; the project check catches the window before that, where this IS the current
    // socket and the address bar has already moved on.
    if (ws !== sock) return
    if (socketProject !== projectSlug()) {
      missedFrame()
      return
    }
    lastMsg = Date.now()
    try {
      const msg = JSON.parse(e.data) as SocketServerMsg
      const healthy = handle(msg)
      // A TCP upgrade alone is not proof of a healthy protocol session: a server that accepts and then
      // immediately rejects would otherwise reset this counter forever. Reset only after useful protocol
      // traffic. Typed payload downgrades deliberately return false and choose their stable fallback path.
      if (healthy) failures = 0
      if (healthy && msg.t === "event" && msg.event.type === "board") {
        protocolReady = true
        liveGenerations++
        resubscribe() // replay subscriptions only after this generation delivered a valid base keyframe
        // The keyframe restores the BOARD across a gap; the project list has no keyframe, so a
        // `projects-changed` published while this tab had no socket is caught up here instead. Not on
        // the first generation: the rail's own mount read is at most seconds old.
        if (liveGenerations > 1) refreshProjectList(qc)
      }
    } catch (err) {
      console.error("bad /ws message", err)
    }
  }

  // Let onclose drive recovery (onerror always precedes a close for a failed/closed socket).
  sock.onerror = () => {}
  sock.onclose = () => {
    if (ws !== sock) return // superseded by a newer socket (resync/forceReconnect already handled it)
    ws = null
    onDrop()
  }

  installHealth()
}

// Detach handlers + close WITHOUT triggering the onclose recovery path — for INTENTIONAL drops
// (resync / watchdog) that immediately reconnect themselves.
function dropWs(): void {
  const sock = ws
  ws = null
  protocolReady = false
  if (!sock) return
  sock.onopen = null
  sock.onmessage = null
  sock.onerror = null
  sock.onclose = null
  try {
    sock.close()
  } catch {
    // already closing/closed
  }
}

// An UNEXPECTED close. If /ws never confirmed, the server has no /ws route (pre-restart) → fall back to
// SSE for good. Otherwise it's a transient drop → reconnect on /ws with backoff (same robustness as SSE).
function onDrop(): void {
  stream.reset() // the socket is gone; the fresh keyframe re-establishes the seq
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect()
}

function scheduleReconnect(immediate = false): void {
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

// Board seq gap: drop the socket and immediately re-open for a fresh keyframe. NOT a failure (the
// connection is healthy) so it skips the backoff/failure counter; connect()'s "open" guard avoids flicker.
function resync(): void {
  stream.reset()
  dropWs()
  connect()
}

function installHealth(): void {
  if (health) return
  health = setInterval(() => {
    if (ws && Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect()
  }, 10_000)

  // Timers throttle in hidden tabs and stall across machine sleep, so a dead socket can sit unnoticed.
  // These wake signals force an immediate staleness check the moment the user is back.
  const wake = () => {
    if (fellBack) return
    if (!ws || Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect(true)
  }
  window.addEventListener("focus", wake)
  window.addEventListener("online", wake)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake()
  })
}

// Watchdog/wake-triggered reconnect. A socket that never confirmed and has now gone stale is treated like
// an unconfirmed drop (fall back to SSE); a confirmed one reconnects with backoff.
function forceReconnect(immediate = false): void {
  if (fellBack) return
  dropWs()
  stream.reset()
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect(immediate)
}

function fallBackToSSE(boardFallback?: { actualBytes: number; maxBytes: number }): void {
  if (fellBack) return
  fellBack = true
  if (boardFallback) {
    store.socketBoardFallback = boardFallback
    store.socketTranscriptFallbacks = {}
  }
  // A typed board downgrade arrives on an OPEN socket. Detach its handlers before closing so this
  // intentional handoff cannot enter the reconnect path; the SSE keyframe becomes the sole board source.
  dropWs()
  store.socketTranscripts = false // useTranscript resumes its 1.5s poll (today's behavior)
  // Hand the board channel + notifications to the proven SSE path.
  connectSSE(qc ?? undefined)
}

// Write one pushed window — a full frame's, or a delta's once applied — into the SAME cache useTranscript
// reads, so components are unchanged and both frame kinds take exactly one path.
function writeTranscript(slug: string, messages: TranscriptMessage[], page: TranscriptPushPage | undefined): void {
  // PRESERVE any optimistic `queued` bubble the incoming truth doesn't yet carry (mergeOptimistic), so a
  // just-sent follow-up never vanishes in the window before the server's own copy lands (the S1 sync-audit fix).
  qc?.setQueryData<PaginatedTranscriptData | { messages: QueuedMessage[] }>(["transcript", slug], (prev) => {
    const previous = prev as PaginatedTranscriptData | undefined
    // A push that carries its page envelope is the SAME bounded latest window the HTTP page read
    // returns, so it reconciles through the same function the queryFn uses — the envelope (cursor,
    // hasEarlier, transcriptKey) stays as fresh as the messages, and a long thread whose window slid
    // under a push cannot page "earlier" from a cursor that no longer names its head. `editedFiles`
    // never rides a push (see TranscriptPushPage); the rail keeps its last HTTP copy. A server that
    // predates the envelope pushes messages only, and those take the messages-only reconcile.
    const reconciled = page
      ? reconcileLatestPage(previous, { ...page, messages, editedFiles: previous?.editedFiles })
      : reconcileLiveMessages(previous, messages)
    return {
      ...reconciled,
      // preserveMessageIdentity: unchanged messages keep the previous render's object so the
      // memoized rows bail out — a push re-renders only what actually changed.
      messages: preserveMessageIdentity(
        prev?.messages,
        mergeOptimistic(prev?.messages, reconciled.messages as QueuedMessage[]),
      ),
    }
  })
}

// Ask the server for a full window of a slug this tab still shows. An unsub/sub pair is the existing
// protocol for it: the server forgets what this connection holds, and a new subscription always starts
// with the whole window.
function requestTranscriptSnapshot(slug: string): void {
  if (!subs.has(slug) || resyncing.has(slug) || store.socketTranscriptFallbacks[slug]) return
  resyncing.add(slug)
  send({ t: "unsub", topic: "transcript", slug })
  send({ t: "sub", topic: "transcript", slug })
}

function handle(msg: SocketServerMsg): boolean {
  switch (msg.t) {
    case "event":
      stream.handle(msg.event)
      if (msg.event.type === "board") store.socketBoardFallback = null
      return true
    case "transcript":
      if (msg.sig && subs.has(msg.slug)) windows.set(msg.slug, { sig: msg.sig, messages: msg.messages })
      else windows.delete(msg.slug)
      resyncing.delete(msg.slug)
      writeTranscript(msg.slug, msg.messages, msg.page)
      delete store.socketTranscriptFallbacks[msg.slug]
      return true
    case "transcript-delta": {
      const held = windows.get(msg.slug)
      const messages = held?.sig === msg.base ? applyTranscriptPatch(held.messages, msg.ops) : undefined
      if (!messages) {
        // Cut against a window this tab does not hold: never render it. A fresh subscription answers with
        // the full window, which re-establishes the base.
        windows.delete(msg.slug)
        requestTranscriptSnapshot(msg.slug)
        return true
      }
      windows.set(msg.slug, { sig: msg.sig, messages })
      writeTranscript(msg.slug, messages, msg.page)
      delete store.socketTranscriptFallbacks[msg.slug]
      return true
    }
    case "file-changed":
      // A notice, not the bytes: the reader's query goes stale and refetches through the same gated
      // read it mounted with, so nothing reaches the page that the read gate would not have admitted.
      void qc?.invalidateQueries({ queryKey: localFileQueryKey(msg.path) })
      return true
    case "payload-too-large":
      if (msg.channel === "board") {
        if (!store.socketBoardFallback) {
          console.warn("[ntwine] live board payload exceeded the socket limit; using SSE", {
            actualBytes: msg.actualBytes,
            maxBytes: msg.maxBytes,
          })
        }
        fallBackToSSE({ actualBytes: msg.actualBytes, maxBytes: msg.maxBytes })
      } else {
        if (!store.socketTranscriptFallbacks[msg.slug]) {
          console.warn("[ntwine] live transcript payload exceeded the socket limit; updates paused", {
            slug: msg.slug,
            actualBytes: msg.actualBytes,
            maxBytes: msg.maxBytes,
          })
        }
        store.socketTranscriptFallbacks[msg.slug] = {
          kind: "payload-too-large",
          actualBytes: msg.actualBytes,
          maxBytes: msg.maxBytes,
        }
      }
      return false
    case "resource-limited":
      if (!store.socketTranscriptFallbacks[msg.slug]) {
        console.warn("[ntwine] live transcript read budget reached; updates paused", {
          slug: msg.slug,
          scope: msg.scope,
          retryAfterMs: msg.retryAfterMs,
        })
      }
      store.socketTranscriptFallbacks[msg.slug] = {
        kind: "read-budget",
        scope: msg.scope,
        retryAfterMs: msg.retryAfterMs,
      }
      scheduleBudgetRetry(msg.slug, msg.retryAfterMs)
      return false
    case "hb":
      return true // lastMsg already bumped
  }
}

function send(msg: SocketClientMsg): void {
  if (protocolReady && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// A reconnect replays every held subscription in batches of REPLAY_BATCH per REPLAY_MS — the same drip
// api/transcript-live.ts uses for first subscriptions, for the same reason: the server budgets on-demand
// transcript reads per origin (16 per second, app-socket.ts), every tab on this origin shares that
// budget, and a board holding two dozen queue cards replayed in one burst asks for two dozen reads in one
// check-phase batch. The overflow came back as resource-limited, which the client then treated as a
// permanent pause. Dripping keeps the replay under the budget; the latch reset below handles the rest.
const REPLAY_BATCH = 6
const REPLAY_MS = 700
let replayTimer: ReturnType<typeof setTimeout> | null = null

function resubscribe(): void {
  // A fresh live generation is fresh server state: whatever refused a subscription before this keyframe
  // (a frame over the cap, a read budget spent) is not known to hold now, and the server-side subscription
  // that was dropped with the refusal has to be re-asked for anyway. Clear every latch and let the replay
  // retry; a refusal that still stands simply re-latches, with its banner. Without this a tab that hit one
  // refusal in its lifetime stayed paused across every reconnect — including a server upgrade that had
  // fixed the very overflow it was paused on (maintainer 2026-09-18: "the problem definitely still
  // exists"; it did not, in a fresh tab).
  for (const slug of Object.keys(store.socketTranscriptFallbacks)) delete store.socketTranscriptFallbacks[slug]
  for (const slug of budgetRetryTimers.keys()) cancelBudgetRetry(slug)
  budgetRetries.clear()
  if (replayTimer) {
    clearTimeout(replayTimer)
    replayTimer = null
  }
  const pending = [...subs.keys()]
  const replayBatch = (): void => {
    replayTimer = null
    for (const slug of pending.splice(0, REPLAY_BATCH)) {
      if (subs.has(slug) && !store.socketTranscriptFallbacks[slug]) send({ t: "sub", topic: "transcript", slug })
    }
    if (pending.length) replayTimer = setTimeout(replayBatch, REPLAY_MS)
  }
  replayBatch()
  for (const path of fileSubs.keys()) {
    send({ t: "sub", topic: "file", path })
    // A reconnect may have slept through a change; one re-read per open file closes that gap. Not on
    // the first connect, where the reader's own mount read just happened.
    if (liveGenerations > 1) void qc?.invalidateQueries({ queryKey: localFileQueryKey(path) })
  }
}

// ── Public API (used by useTranscript) ───────────────────────────────────────────────────────────────

// Register interest in a thread's transcript. Ref-counted: the first interested surface sends `sub`;
// later ones just bump the count. A no-op before the socket opens — resubscribe() replays on open.
export function subscribeTranscript(slug: string): void {
  const n = (subs.get(slug) ?? 0) + 1
  subs.set(slug, n)
  if (n === 1 && !store.socketTranscriptFallbacks[slug]) send({ t: "sub", topic: "transcript", slug })
}

// Drop one surface's interest. The LAST one sends `unsub` and forgets the slug (no leak); others decrement.
export function unsubscribeTranscript(slug: string): void {
  const n = (subs.get(slug) ?? 0) - 1
  if (n <= 0) {
    subs.delete(slug)
    windows.delete(slug)
    resyncing.delete(slug)
    send({ t: "unsub", topic: "transcript", slug })
  } else {
    subs.set(slug, n)
  }
}

// A reader opened a local file: the first reader on a path sends `sub`; later ones bump the count.
// Before the socket opens it is a no-op that resubscribe() replays, exactly as a transcript is.
export function subscribeFile(path: string): void {
  const n = (fileSubs.get(path) ?? 0) + 1
  fileSubs.set(path, n)
  if (n === 1) send({ t: "sub", topic: "file", path })
}

// The last reader on a path sends `unsub` and forgets it; the others decrement.
export function unsubscribeFile(path: string): void {
  const n = (fileSubs.get(path) ?? 0) - 1
  if (n <= 0) {
    fileSubs.delete(path)
    send({ t: "unsub", topic: "file", path })
  } else {
    fileSubs.set(path, n)
  }
}

// Human-triggered recovery for a per-thread logical overflow or read-budget rejection. The server removed
// the failed subscription, so one explicit retry is at most one budgeted read + serialization. Success
// resumes push; another typed rejection restores the stable warning without reconnecting the board socket.
export function retryTranscriptSocket(slug: string): void {
  if (!store.socketTranscriptFallbacks[slug]) return
  cancelBudgetRetry(slug)
  delete store.socketTranscriptFallbacks[slug]
  if (subs.has(slug)) send({ t: "sub", topic: "transcript", slug })
}

// A read-budget refusal is TRANSIENT by its own definition — the server names the retry-after — so the
// client retries on its own after that much (plus a little spread, so the tabs that were refused together
// do not all ask again in the same millisecond), up to MAX_BUDGET_RETRIES times per slug per live
// generation. Past that it is the banner's manual "Retry live", as it always was. An overflow is not
// retried here: its refusal is a property of the thread, and re-asking every edge would only re-trip it.
const MAX_BUDGET_RETRIES = 5
const BUDGET_RETRY_SPREAD_MS = 400
const budgetRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const budgetRetries = new Map<string, number>()

function scheduleBudgetRetry(slug: string, retryAfterMs: number): void {
  const attempts = budgetRetries.get(slug) ?? 0
  if (attempts >= MAX_BUDGET_RETRIES) return
  cancelBudgetRetry(slug)
  const delay = Math.max(1, retryAfterMs) + Math.random() * BUDGET_RETRY_SPREAD_MS
  budgetRetryTimers.set(slug, setTimeout(() => {
    budgetRetryTimers.delete(slug)
    budgetRetries.set(slug, attempts + 1)
    const fallback = store.socketTranscriptFallbacks[slug]
    if (!fallback || fallback.kind !== "read-budget") return
    delete store.socketTranscriptFallbacks[slug]
    if (subs.has(slug)) send({ t: "sub", topic: "transcript", slug })
  }, delay))
}

function cancelBudgetRetry(slug: string): void {
  const timer = budgetRetryTimers.get(slug)
  if (!timer) return
  clearTimeout(timer)
  budgetRetryTimers.delete(slug)
}

/**
 * Point the live feed at a DIFFERENT project, in place.
 *
 * The rail switches projects without a document load, and every stream in this module is bound to one
 * project: `wsUrl()` derives from `apiBase()`, which derives from the page's own path. So a switch is
 * a resync against a URL that has already changed — the same drop-and-reopen the seq-gap path uses,
 * plus the two pieces of per-project bookkeeping a seq gap must NOT clear:
 *
 *   · `subs` is keyed by THREAD SLUG, which is only unique within a project. Carrying it across would
 *     re-subscribe the new project's socket to the old project's threads, and slugs collide.
 *   · `connection` goes back to connecting, so the status bar stops claiming a live feed it no longer
 *     has while the new socket opens.
 *
 * `confirmed`/`fellBack` are deliberately KEPT: they describe whether this SERVER speaks /ws at all,
 * which is a property of the process, not of the project it happens to be serving.
 */
export function rebindProject(): void {
  subs.clear()
  // Absolute paths do not collide across projects the way slugs do, but the file gate is the NEW
  // project's, and the readers holding these are unmounting with the page they were on.
  fileSubs.clear()
  stream.reset()
  dropWs()
  store.connection = "connecting"
  noteFeedProject()
  // A session that fell back has no socket to re-open — its board comes down the EventSource, which is
  // bound to one project in exactly the same way and needs the same instruction. `rebindSSEProject` was
  // written for this and never wired up: it sat exported with no caller in the repo, so on any server
  // without `/ws` a project switch left the board fed by the project you just left. Same bug as
  // `0fb8574`, second instance, found while auditing the first.
  if (fellBack) rebindSSEProject()
  else connect()
}

// Entry point (replaces connectSSE in main.tsx). Deferred to `load` so the socket doesn't consume one of
// Chrome's 6 per-host connection slots while Vite is still streaming modules in dev.
export function connectSync(queryClient: QueryClient): void {
  qc = queryClient
  // Commit to this page's project NOW, not when the socket actually opens. The open is deferred to
  // `load`, and in between the router renders and asks whether the feed is bound: answering "nothing is
  // bound yet" would make a cold load tear down and re-establish the connection main.tsx had already
  // arranged. The module is committed from here, so that is what it reports.
  noteFeedProject()
  const go = () => connect()
  if (document.readyState === "complete") go()
  else window.addEventListener("load", go, { once: true })
}
