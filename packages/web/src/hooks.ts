import { useEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BackgroundShellOutputResult, BoardSnapshot, InteractionRecord, ThreadView, TranscriptMessage, TranscriptPage } from "@frizz/shared"
import { store, threadBySlug } from "./store.ts"
import { projectRpc, rpc } from "./api/rpc.ts"
import { projectQueryKeyHash } from "./lib/queryKeyScope.ts"
import { useThreadApi } from "./api/threadApi.tsx"
import { retryTranscriptSocket, subscribeFile, subscribeTranscript, unsubscribeFile, unsubscribeTranscript } from "./api/socket.ts"
import { mergeOptimistic, preserveMessageIdentity, isTranscriptStale, newestRenderedAt } from "./lib/transcript-sync.ts"
import { pendingInteractionsKey } from "./api/interaction-cache.ts"
import { reconcileLatestPage, type PaginatedTranscriptData } from "./lib/transcriptPagination.ts"
import { nextShellLogDelay, ShellLogStream } from "./lib/shellLog.ts"

// A transcript message carrying a transient client-only flag: a follow-up we optimistically appended
// on send that hasn't yet appeared in a server refetch. The flag drives the "queued" affordance and
// is naturally dropped when server truth overwrites the cache — EXCEPT that a blunt overwrite would drop
// it too early (before the server's own copy lands), so overwrites now route through mergeOptimistic.
export type ChatMessage = TranscriptMessage & { queued?: boolean; deliveryId?: string }
export type TranscriptData = Partial<Omit<PaginatedTranscriptData, "messages">> & { messages: ChatMessage[] }

// `mergeToolRuns` stays deleted: mutating transcript truth before the ordered-parts walk hoisted tools
// across prose and lost block fidelity. The minimal renderer now performs a narrower PRESENTATION-ONLY
// coalescing in lib/toolActivity.ts: a visible tool tail and its following provider-only turns share
// one disclosure; prose and dedicated block tools such as sub-agent operations are hard boundaries.
// VISUAL ORDER == TURN ORDER remains the invariant; no persisted/query-cached message is rewritten.

// React-only helpers live here, not in store.ts, because store.ts is also imported by
// non-React code (api/sse.ts) that has no business pulling in React/valtio hooks.

// Valtio's useSnapshot() produces a DeepReadonly view that doesn't structurally match
// BoardSnapshot/ThreadView (readonly arrays vs. the mutable shapes zod infers), so every read
// needs a cast. Centralized here so it happens once instead of scattered `as BoardSnapshot`
// casts across components.
export function useBoard(): BoardSnapshot | null {
  const snap = useSnapshot(store)
  return snap.board as BoardSnapshot | null
}

// The project root every display path is shortened against (see relativeToolPaths). Narrower than
// useBoard() on purpose: valtio tracks the single property, so a transcript row that only needs the
// root does not re-render on unrelated board churn.
export function useProjectDir(): string | undefined {
  return useSnapshot(store).board?.projectDir
}

// The server's home directory — what /full's rail and file viewer write as `~` (see editedFileSegments).
// Narrow for the same reason as useProjectDir.
export function useHomeDir(): string | undefined {
  return useSnapshot(store).board?.homeDir
}

export function asThreads(threads: readonly unknown[]): ThreadView[] {
  return threads as ThreadView[]
}

// True once the /ws multiplex is the transcript source (server pushes into the cache). Components read
// this to skip pull-based refetch paths that the push now covers.
export function useSocketTranscripts(): boolean {
  return useSnapshot(store).socketTranscripts
}

// A READER'S LIVE HOLD on the local file it shows (the /full split viewer, the Markdown drawer). For
// as long as the surface is mounted the server watches the file and pushes `file-changed`, which
// invalidates the reader's query (api/socket.ts) — so a file a worker is editing re-renders as it is
// saved instead of sitting at whatever it read on open (maintainer 2026-09-03: "it needs to be live").
// Returns whether that push is up: without it (a pre-/ws server, the SSE fallback) the reader polls
// on LOCAL_FILE_POLL_MS instead, which is the same "read it again" on a clock.
export function useLiveLocalFile(path: string): boolean {
  const live = useSnapshot(store).socketTranscripts
  useEffect(() => {
    subscribeFile(path)
    return () => unsubscribeFile(path)
  }, [path])
  return live
}

export function ownedInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  if (!thread || thread.kind !== "session" || thread.foreign || !thread.sessionId) return undefined
  return { slug: thread.id, sessionId: thread.sessionId }
}

// A current server emits an exact board-level presence bit, so unrelated needs-you rows (questions,
// done handoffs, native prompts) do not each fan out another list RPC. During a rolling update an older
// board omits the optional field; preserve the prior query behavior until the server catches up so a
// real typed request is never hidden merely because client and server bundles changed out of order.
export function pendingInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  const scope = ownedInteractionScope(thread)
  if (!scope || thread?.pendingInteraction === false) return undefined
  return scope
}

// Keep an expiring card accurate even if the provider edge or push transport is lost. The server's
// scoped list call performs the authoritative expiry transition; otherwise SSE/WS invalidations keep
// this query pull-free.
export function nextInteractionExpiryDelay(interactions: readonly InteractionRecord[], now = Date.now()): number | false {
  let earliest = Infinity
  for (const interaction of interactions) {
    if (!interaction.expiresAt) continue
    const expires = Date.parse(interaction.expiresAt)
    if (Number.isFinite(expires)) earliest = Math.min(earliest, expires)
  }
  if (!Number.isFinite(earliest)) return false
  return Math.max(250, earliest - now + 50)
}

// Read through the thread's OWN project (useThreadApi): in All projects the cards list every project's
// threads, and `rpc` addresses whichever one the page is bound to. The key needs no project — a
// session id names one session on the machine.
export function usePendingInteractions(thread: ThreadView | undefined) {
  const scope = pendingInteractionScope(thread)
  const api = useThreadApi()
  return useQuery({
    queryKey: scope ? pendingInteractionsKey(scope.slug, scope.sessionId) : ["interactions", "pending", "unowned"],
    queryFn: () => api.pendingInteractions(scope!),
    enabled: scope !== undefined,
    refetchInterval: (query) => nextInteractionExpiryDelay(query.state.data?.interactions ?? []),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  })
}

// Shared transcript query. `poll` controls whether the transcript stays LIVE (chat while the agent is
// running) or is left to refetch only on explicit triggers (the To-dos pager).
//
// Freshness has two transports: with the /ws multiplex live (store.socketTranscripts), a live surface
// SUBSCRIBES and the server PUSHES updates into this same cache — no interval poll. Without it (before the
// socket confirms, or on SSE fallback against a pre-restart server) it falls back to the 1.5s interval —
// exactly today's behavior. Either way the mount fetch (staleTime 0) paints immediately.
// Watchdog cadence + staleness threshold. The board's lastActivityAt can legitimately lead the rendered
// tail by a couple seconds (the two ride different reads of the same JSONL), so only a LARGER lead is a
// real delivery miss. A genuine miss self-heals on the first refetch (it pulls the whole transcript); the
// attempt cap stops us hammering when the lead is a benign tail-advance with nothing new to render.
const WATCHDOG_MS = 7000
const STALE_MS = 5000
const MAX_HEAL_ATTEMPTS = 3

// ── The revisit cache: a thread you have already read must not re-download on the way back in ──────────
// This query carried no staleTime at all, so react-query treated every cached copy as stale the instant
// it landed and EVERY open issued a fresh threadTranscript — including a return to the thread you just
// left. Measured against a copy of the maintainer's 558-thread board (2026-09-04): four cold opens
// painted their first row at 408 / 910 / 2072 / 1660ms with zero client-side long tasks (the wait is the
// server reading JSONL, not us), while a REVISIT painted from cache in 63ms and then spent 1998ms on a
// request whose answer was already on screen — one of ~11 RPCs fighting over the browser's six HTTP/1.1
// connections, which is how a transcript read came to report `stall: 1978ms` before it was ever sent.
const REVISIT_STALE_MS = 15_000
// Long enough that moving around a board keeps the threads you visited warm. The cost is bounded by what
// the server actually sends — the latest page of a windowed transcript, not a thread's whole history.
const REVISIT_GC_MS = 30 * 60_000

/**
 * How long a cached transcript may be served without re-reading it. The NUMBER is the easy part; the
 * GATE is what makes this safe, because a stale transcript is far worse than a slow one.
 *
 * `dataUpdatedAt` is when the SERVER last confirmed this cache entry — a queryFn refetch and a socket
 * push both stamp it — and the board delivers `lastActivityAt` per thread over its own delta channel.
 * A marker NEWER than that stamp therefore means the thread moved after our freshest confirmation, and
 * the copy is re-read on sight. So does a thread with no board row at all (a board that has not seeded
 * yet, another project's thread): with no marker there is nothing to gate on, and the answer is 0.
 *
 * The one window this cannot see is a read whose FLIGHT spanned the activity — the response lands after
 * a marker it does not contain. Three things already cover it and none of them consult staleTime: the
 * socket push (a fresh subscription makes the server send a full snapshot, app-socket.ts
 * `enqueueSubscriptionPush`), the activity-edge refetch beyond the subscription budget
 * (api/transcript-live.ts), and the level-triggered watchdog below. The window is also bounded — it
 * closes on its own after REVISIT_STALE_MS.
 */
export function transcriptStaleTime(board: BoardSnapshot | null, slug: string, dataUpdatedAt: number): number {
  const activity = threadBySlug(board, slug)?.lastActivityAt
  if (!activity) return 0
  const movedAt = Date.parse(activity)
  if (!Number.isFinite(movedAt)) return 0
  return movedAt > dataUpdatedAt ? 0 : REVISIT_STALE_MS
}

/**
 * Whether a view MOUNTING over a cached transcript must hold that copy back until the server answers.
 * The revisit cache above serves a calm thread instantly; a thread that moved since the copy was
 * confirmed (staleTime 0, so the mount re-reads) used to PAINT the old copy while that read was in
 * flight, then swap in the new one — opening a running thread flashed whatever it showed the last time
 * it was read (a question card from an hour ago, an old tail) and then jumped to the current bottom.
 * Decided once, at mount, from the same gate: the stamp to wait past, or null to serve the cache.
 */
export function staleOpenHoldStamp(board: BoardSnapshot | null, slug: string, cached: { data: unknown; dataUpdatedAt: number } | undefined): number | null {
  if (!cached || cached.data === undefined) return null
  return transcriptStaleTime(board, slug, cached.dataUpdatedAt) === 0 ? cached.dataUpdatedAt : null
}

// The later of the server's last confirmation of a cache entry (`dataUpdatedAt`, as an ISO string for
// isTranscriptStale) and the newest rendered message's own timestamp. Exported for the watchdog test.
export function latestConfirmation(dataUpdatedAt: number | undefined, newestRendered: string | undefined): string | undefined {
  const rendered = newestRendered ? Date.parse(newestRendered) : NaN
  const confirmed = dataUpdatedAt && dataUpdatedAt > 0 ? dataUpdatedAt : NaN
  if (!Number.isFinite(rendered) && !Number.isFinite(confirmed)) return newestRendered
  const at = Math.max(Number.isFinite(rendered) ? rendered : 0, Number.isFinite(confirmed) ? confirmed : 0)
  return new Date(at).toISOString()
}

// A fetched page folded into what the cache already holds — the one transform every read of
// ["transcript", slug] goes through, so a prefetch lands exactly what the hook would have.
function transcriptQueryData(prev: TranscriptData | undefined, res: TranscriptPage): TranscriptData {
  const reconciled = reconcileLatestPage(prev as PaginatedTranscriptData | undefined, res)
  return {
    ...reconciled,
    // preserveMessageIdentity: unchanged messages keep their previous object so memoized rows
    // bail out of re-render — a refetch repaints only what actually changed.
    messages: preserveMessageIdentity(
      prev?.messages,
      mergeOptimistic(prev?.messages, reconciled.messages as ChatMessage[]),
    ),
  }
}

/**
 * Start reading ANOTHER project's thread before the page has moved to that project, so its drawer finds
 * the transcript cached instead of asking for it once it mounts — the round trip then runs alongside the
 * page's rebind rather than after it. The entry is written under that project's cache scope by name
 * (queryKeyScope.ts hashes by the page's project, which at the click is still the one being left).
 */
export function prefetchProjectTranscript(qc: QueryClient, project: { id: string; slug: string }, slug: string): void {
  void qc.prefetchQuery({
    queryKey: ["transcript", slug],
    queryKeyHashFn: (key) => projectQueryKeyHash(project.slug, key),
    queryFn: async () => transcriptQueryData(undefined, await projectRpc(project.id).threadTranscript({ slug })),
  })
}

/** Ticks (of WATCHDOG_MS) the watchdog waits on a fetch already in flight before treating it as hung. */
export const WATCHDOG_MAX_DEFER_TICKS = 4

export type TranscriptWatchdogStep =
  | { kind: "fresh" }
  | { kind: "defer" }
  | { kind: "heal"; lagMs: number | null }

/**
 * One watchdog tick's decision, pure so it is tested apart from the timer.
 *
 * DEFER while a read is already in flight: that read IS the heal. Healing over it used to call
 * `query.refetch()`, whose default `cancelRefetch: true` ABORTS the in-flight read and starts it again
 * — so on a slow server (a cold transcript, a loaded box) the watchdog's first tick, 7s after mount,
 * threw away a read that was about to land and paid for it twice, and the breadcrumb blamed delivery.
 * A read still in flight after WATCHDOG_MAX_DEFER_TICKS ticks is treated as hung and healed anyway, so
 * a request that never settles cannot disarm the watchdog.
 *
 * `lagMs` is measured against the SAME confirmation the decision used. It was measured against the
 * newest rendered message, which on a thread with nothing rendered yet is the epoch, so every
 * breadcrumb from a cold view reported a lag of ~56 years: all 47 watchdog lines across the 2026-10-01
 * adhoc stack logs read `lagMs: 17909…` (46 of them attempt 1, i.e. the first tick after a mount).
 * null when nothing has confirmed the cache at all.
 */
export function transcriptWatchdogStep(input: {
  activity: string | undefined
  confirmedAt: string | undefined
  staleMs: number
  fetching: boolean
  /** Consecutive earlier ticks that already found this read in flight. */
  fetchingTicks: number
}): TranscriptWatchdogStep {
  if (!isTranscriptStale(input.activity, input.confirmedAt, input.staleMs)) return { kind: "fresh" }
  if (input.fetching && input.fetchingTicks < WATCHDOG_MAX_DEFER_TICKS) return { kind: "defer" }
  const activity = input.activity ? Date.parse(input.activity) : NaN
  const confirmed = input.confirmedAt ? Date.parse(input.confirmedAt) : NaN
  return { kind: "heal", lagMs: Number.isFinite(activity) && Number.isFinite(confirmed) ? activity - confirmed : null }
}

export function useTranscript(slug: string, opts: { poll: boolean }) {
  const qc = useQueryClient()
  const snap = useSnapshot(store)
  const socket = snap.socketTranscripts
  const transportFallback = snap.socketTranscriptFallbacks[slug]
  // Liveness is NOT this hook's job anymore: transcript-live.ts watches the query cache and keeps every
  // OBSERVED ["transcript", slug] fresh centrally (socket subscription within budget, activity-edge
  // refetch beyond, nothing for typed-fallback slugs). Mounting this hook is what registers the observer.
  // `poll` retains exactly one meaning: the 1.5s HTTP interval for a RUNNING thread when the socket is
  // down (SSE fallback) — an at-rest thread must never interval-poll.

  // Decided BEFORE useQuery mounts, so the mount's own re-read cannot have stamped the entry yet.
  const holdRef = useRef<{ slug: string; stamp: number | null; errorAt: number } | null>(null)
  if (holdRef.current?.slug !== slug) {
    const cached = qc.getQueryState<TranscriptData>(["transcript", slug])
    holdRef.current = { slug, stamp: staleOpenHoldStamp(store.board as BoardSnapshot | null, slug, cached), errorAt: cached?.errorUpdatedAt ?? 0 }
  }

  const query = useQuery({
    queryKey: ["transcript", slug],
    // Preserve optimistic sends across a poll refetch too (not just the socket push) — see mergeOptimistic.
    queryFn: async () => {
      const res = await rpc.threadTranscript({ slug })
      return transcriptQueryData(qc.getQueryData<TranscriptData>(["transcript", slug]), res)
    },
    // A typed per-subscription transport rejection (logical overflow or aggregate read budget) never
    // interval-polls: keep the last complete copy visible and let the banner offer explicit one-shot
    // refresh/retry actions. An overflowed slug is still kept fresh — one paged HTTP pull per activity
    // edge, owned centrally by api/transcript-live.ts. Ordinary SSE fallback still polls exactly as before.
    refetchInterval: opts.poll && !socket && !transportFallback ? 1500 : false,
    // A window focus is one bounded HTTP read; under a transport pause it is the cheapest recovery there is.
    refetchOnWindowFocus: true,
    // Serve a revisited thread from cache instead of re-reading it — see transcriptStaleTime above for
    // the activity gate that keeps that from ever showing a transcript the board says has moved on.
    // Nothing that keeps a LIVE thread live goes through here: the socket push writes the cache
    // directly, and the interval poll, the activity-edge refetch and the watchdog below all fetch
    // unconditionally. staleTime governs exactly one decision — whether MOUNTING re-reads.
    staleTime: (query) => transcriptStaleTime(store.board as BoardSnapshot | null, slug, query.state.dataUpdatedAt),
    gcTime: REVISIT_GC_MS,
  })

  // LEVEL-TRIGGERED freshness watchdog — the self-healing complement to the edge-triggered push/poll. A
  // missed edge (a dropped subscription across a reconnect/HMR, a suppressed broadcast, a mount-order flip)
  // would otherwise wedge a live view FOREVER with no recovery — the class of bug behind "it needed a hard
  // reload". Every WATCHDOG_MS (cheap: one timestamp compare, no network unless stale) we check the board's
  // lastActivityAt for this slug (delivered independently over the board-delta channel) against the moment
  // the SERVER last confirmed this cache entry; a lead beyond STALE_MS means the transcript is provably
  // behind, so we force a pull refetch (always works — plain HTTP) AND re-establish the subscription (fixes
  // a lost server-side sub for FUTURE pushes), and warn a structured breadcrumb so the underlying delivery
  // bug stays diagnosable. Lives in the hook so every consumer (main ChatView + the drawer's) inherits it.
  //
  // "Confirmed" is react-query's `dataUpdatedAt` — stamped by a push and by a refetch alike — not the
  // newest rendered message's own timestamp. Until 2026-09-18 it was the latter, and on a STREAMING thread
  // that reads as permanently stale: the board's marker moves on every rollout record (a token count, a
  // reasoning summary, a tool result still in flight) while the newest message that carries an `at` sits
  // minutes back during a long tool stretch. Pushes were landing every few seconds and the watchdog still
  // fired every 7s, twice per page (main view + rail), each firing an unsub+sub (a full server re-read)
  // and an HTTP refetch (another) — on a 19 MB codex rollout, ~300 ms of parse each, on a server already
  // re-parsing that file once a second for the push. The attempt cap never engaged, because "the transcript
  // advanced" re-armed it on every push. The rendered timestamp is kept only as the floor for a cache the
  // server has never stamped.
  useEffect(() => {
    // Armed whenever the surface has a live source to guard: the SSE interval poll, or (socket mode) the
    // centrally-managed subscription/edge-refetch — a missed push edge would otherwise freeze the view
    // exactly like the pre-subscription bug this watchdog exists for.
    if ((!opts.poll && !socket) || transportFallback) return // typed pause stays manual; never turn the watchdog into a full-read loop
    let inFlight = false
    let attempts = 0
    let fetchingTicks = 0
    let lastHealNewest: string | undefined
    const tick = () => {
      if (inFlight) return
      const activity = threadBySlug(store.board as BoardSnapshot | null, slug)?.lastActivityAt
      const state = qc.getQueryState<TranscriptData>(["transcript", slug])
      const newest = newestRenderedAt(state?.data?.messages)
      const confirmedAt = latestConfirmation(state?.dataUpdatedAt, newest)
      const fetching = state?.fetchStatus === "fetching"
      // fetchingTicks counts the EARLIER ticks that already found this read in flight.
      const step = transcriptWatchdogStep({ activity, confirmedAt, staleMs: STALE_MS, fetching, fetchingTicks })
      fetchingTicks = fetching ? fetchingTicks + 1 : 0
      if (step.kind === "fresh") {
        attempts = 0 // caught up — re-arm
        return
      }
      if (step.kind === "defer") return // a read is already landing; healing over it would abort it
      // Stale. If the transcript advanced since our last heal, re-arm; otherwise the lead is likely a benign
      // tail-advance (sidecar records with nothing renderable) — cap attempts so we don't hammer forever.
      if (newest !== lastHealNewest) attempts = 0
      if (attempts >= MAX_HEAL_ATTEMPTS) return
      attempts++
      lastHealNewest = newest
      console.warn("[frizz] transcript watchdog: stale view — self-healing", { slug, lagMs: step.lagMs, transport: socket ? "socket" : "poll", attempt: attempts })
      if (socket) {
        // Re-establish the server-side subscription (drop→re-add on the ref count) so future pushes resume.
        unsubscribeTranscript(slug)
        subscribeTranscript(slug)
      }
      inFlight = true
      void query.refetch().finally(() => {
        inFlight = false
      })
    }
    const iv = setInterval(tick, WATCHDOG_MS)
    return () => clearInterval(iv)
    // query.refetch is stable across renders (react-query); slug/poll/socket cover the meaningful deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, opts.poll, socket, transportFallback])

  // Released for good by the first fresh answer — a refetch or a socket push, both stamp dataUpdatedAt —
  // or by a failed read, after which the old copy beats an endless "Loading…".
  const hold = holdRef.current
  if (hold.stamp !== null && (query.dataUpdatedAt !== hold.stamp || query.errorUpdatedAt !== hold.errorAt)) hold.stamp = null
  const holding = hold.stamp !== null

  return {
    ...query,
    ...(holding ? { data: undefined, isPending: true as const } : {}),
    transportFallback: transportFallback
      ? transportFallback.kind === "payload-too-large"
        ? {
            kind: "payload-too-large" as const,
            actualBytes: transportFallback.actualBytes,
            maxBytes: transportFallback.maxBytes,
          }
        : {
            kind: "read-budget" as const,
            scope: transportFallback.scope,
            retryAfterMs: transportFallback.retryAfterMs,
          }
      : null,
    retryLiveUpdates: () => retryTranscriptSocket(slug),
  }
}

// A live/stale sub-agent's OWN transcript, for the drill-in drawer. Keyed by (slug, id) so distinct
// children never collide, and polled ONLY while the child is still running — once the RPC reports
// stale/gone the drawer is showing a settled (or unavailable) transcript, so we stop hammering the
// connection budget. The predicate reads the last result so polling self-cancels as the state flips.
export function useSubAgentTranscript(slug: string, id: string) {
  return useQuery({
    queryKey: ["subAgentTranscript", slug, id],
    queryFn: () => rpc.subAgentTranscript({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2500 : false),
  })
}

// AN AGENT TERMINAL'S LOG, FOLLOWED — the one poll behind an open agent-terminal drawer (TerminalSheet): the
// header reads the reply's metadata, the read-only xterm (ShellLogPane) writes the stream. Each read resumes
// at the last reply's `end`, raw, so only what arrived is sent and colour survives; it asks again at once
// while `more` is waiting, every 1.5s while the shell runs, and stops once it has ended. `refresh` reads now
// — after a Stop, so the header says so without waiting out the poll.
//
// The page's `rpc`, never a card's project: the drawer stack is always the FOCUSED project's, which is why
// a queue card only pushes this drawer when its thread's project is the one in focus.
export function useShellLog(slug: string, shellId: string): { stream: ShellLogStream; meta: BackgroundShellOutputResult | undefined; error: boolean; refresh: () => void } {
  const stream = useMemo(() => new ShellLogStream(), [slug, shellId])
  const [meta, setMeta] = useState<BackgroundShellOutputResult>()
  const [error, setError] = useState(false)
  const kick = useRef<() => void>(() => {})
  useEffect(() => {
    let stopped = false
    let inflight = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // `gone` replies in a row since the shell was last seen running (nextShellLogDelay rechecks those).
    let seenRunning = false
    let gones = 0
    const read = async (): Promise<void> => {
      if (stopped) return
      if (inflight) {
        again = true
        return
      }
      inflight = true
      clearTimeout(timer)
      try {
        const reply = await rpc.backgroundShellOutput({ slug, id: shellId, raw: true, ...(stream.from !== undefined ? { from: stream.from } : {}) })
        if (stopped) return
        stream.apply(reply)
        // A `gone` after output keeps what the last real reply said — the command (Copy command), the
        // folder (the subtitle) — and changes only the state, as the log itself stays (ShellLogStream.apply).
        setMeta((prev) => (reply.state === "gone" && stream.received > 0 && prev ? { ...prev, state: "gone", stoppable: false } : { ...reply, output: "" }))
        setError(false)
        if (reply.state === "running") seenRunning = true
        gones = reply.state === "gone" && seenRunning ? gones + 1 : 0
        const delay = nextShellLogDelay(reply, gones)
        if (delay !== undefined) timer = setTimeout(() => void read(), delay)
      } catch {
        if (stopped) return
        setError(true)
        timer = setTimeout(() => void read(), 3_000)
      } finally {
        inflight = false
        if (again && !stopped) {
          again = false
          void read()
        }
      }
    }
    kick.current = () => void read()
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [slug, shellId, stream])
  return { stream, meta, error, refresh: () => kick.current() }
}

// The ops strip's LIVE OUTPUT COUNTER: lines produced, per shell row on screen, refreshed while any of
// them is still running. One batched request per poll for the whole strip.
//
// The key carries the sorted ids, so a strip that gains or loses a shell re-keys rather than serving
// the old set's answer; sorting keeps a re-ordered board frame from thrashing the cache.
//
// Polling continues while any named shell is RUNNING — including one that has no readable output yet
// (`lines: null`), which is the state a shell sits in between its tool_use and its launch ack. Keying
// the stop on "did anything report a number" instead stopped the poll during that window and the
// counter never arrived. It stops when every named shell has settled, and when the server knows none
// of them at all: a settled shell's line count cannot move again.
//
// SCOPED TO WHAT IS RENDERED, on purpose: this is the reason the reading is not a board field. An
// operator looking at one thread pays for that thread's shells and nothing else, and closing the view
// unmounts the poll entirely.
export function useBackgroundShellLines(slug: string, ids: readonly string[]): Map<string, number> {
  const key = [...ids].sort()
  const query = useQuery({
    queryKey: ["backgroundShellActivity", slug, key],
    queryFn: () => rpc.backgroundShellActivity({ slug, ids: key }),
    enabled: key.length > 0,
    refetchInterval: (q) => (q.state.data && !q.state.data.shells.some((s) => s.running) ? false : 1500),
  })
  return useMemo(
    () => new Map((query.data?.shells ?? []).flatMap((s) => (s.lines === null ? [] : [[s.id, s.lines] as const]))),
    [query.data],
  )
}

// Follow-ups are injected into the agent's terminal stdin and only surface in the transcript once the
// agent's next turn picks them up — so the message would otherwise vanish on send. Optimistically
// append it to the ["transcript", slug] cache as a user bubble tagged `queued`; the next real refetch
// (which never sets `queued`) overwrites the cache and dedupes it against the server's own copy.
export function appendQueuedMessage(
  qc: QueryClient,
  slug: string,
  text: string,
  // `held`: the operator sent it TO THE QUEUE while a turn runs, so the bubble says it is waiting for
  // the agent's rest from the first frame — the server's own copy (deliveryState "held") says the same.
  opts: { scrollToBottom?: boolean; deliveryId?: string; held?: boolean } = {},
) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    const messages = prev?.messages ?? []
    return { ...prev, messages: [...messages, { role: "user", text, tools: [], parts: [], queued: true, deliveryId: opts.deliveryId, ...(opts.held ? { deliveryState: "held" as const } : {}) }] }
  })
  // Chat replies commit to the conversation tail, so they normally force the page to the bottom even
  // when the reader sent from up-thread. Queue cards opt out: their post-answer destination is the
  // recorded next queue card, and a global bottom-pin would race it. rAF lets the optimistic bubble
  // lay out before the document height is read.
  if (opts.scrollToBottom !== false && typeof window !== "undefined") {
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }))
  }
}

// Roll back the optimistic bubble appendQueuedMessage added, when the send actually FAILS. Removes
// the LAST still-queued message whose text matches (only optimistic entries carry `queued`, so a
// server-confirmed copy is never touched). Keeps the optimistic UX honest: a failed follow-up no
// longer leaves a phantom "sent" bubble the reload silently erases.
export function removeQueuedMessage(qc: QueryClient, slug: string, text: string, deliveryId?: string) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    if (!prev?.messages?.length) return prev
    const i = prev.messages.findLastIndex((m) => m.queued && m.role === "user" && m.text === text &&
      (deliveryId === undefined || m.deliveryId === deliveryId))
    if (i === -1) return prev
    return { ...prev, messages: prev.messages.filter((_, j) => j !== i) }
  })
}
