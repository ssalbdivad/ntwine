import type { QueryClient } from "@tanstack/react-query"
import { subscribe as subscribeStore } from "valtio/vanilla"
import type { BoardSnapshot } from "@ntwine/shared"
import { store } from "../store.ts"
import { subscribeTranscript, unsubscribeTranscript } from "./socket.ts"

// ── Observer-driven transcript liveness ────────────────────────────────────────────────────────────────
// Freshness used to be each surface's OWN job: ChatView decided when to hold the socket subscription,
// queue cards wired their own activity-edge refetch, SSE mode had a third path — and every new surface
// could (and did) silently reintroduce the "this view is frozen" bug. This module makes freshness a
// property of the DATA being observed instead: it watches the react-query cache, and any ["transcript",
// slug] query with at least one active observer is kept live centrally. Components just useQuery; they
// never manage subscriptions.
//
// Policy, per observed slug:
//  • Socket mode, within budget → hold a server push subscription (idle threads cost nothing: the server
//    pushes only when the JSONL advances).
//  • Beyond budget, or in SSE fallback → refetch on the thread's lastActivityAt edge (one HTTP pull
//    exactly when this thread actually moved, delivered over the board channel).
//  • A slug the socket refused — payload-too-large OR read budget — is kept fresh the same way as a
//    beyond-budget slug: one paged HTTP pull per activity edge. The paged read is bounded whatever the
//    thread's size, so it cannot be what overflowed; it does not draw on the socket's read budget; and an
//    edge refetch is one request per real change — not a loop. (Until 2026-09-16 both fallbacks were left
//    entirely manual, and a /full page on a refused thread sat frozen — optimistic bubbles "queued"
//    forever, a rest card for a thread mid-turn — until a hard reload; the banner that offered the manual
//    retry sits at the top of the transcript, scrolled out of sight on exactly the page that needs it.)
//    Re-SUBSCRIBING is api/socket.ts's business: it retries a read-budget refusal after the server's own
//    retry-after and clears every latch on a fresh live generation, and it leaves an overflow to the
//    banner's "Retry live", because that is the one retry that would re-trip on every edge.
//
// Budget: the server caps 32 subscriptions per connection and 16 transcript reads/sec per origin. We keep
// headroom under both: at most MAX_LIVE subscriptions (most-recently-observed win), and new subscriptions
// are DRIPPED (batches of DRIP_BATCH per DRIP_MS) so mounting a board full of queue cards can't blow the
// per-origin read budget in one check-phase burst (a rejected read would drop the sub into the manual
// fallback banner — the opposite of what an automatic policy should cause).

const MAX_LIVE = 24
const DRIP_BATCH = 6
const DRIP_MS = 700

interface Tracked {
  observers: number
  live: boolean // we currently hold one subscribeTranscript ref for this slug
  queued: boolean // waiting in the drip queue for a subscription slot
  lastActivityAt: string | undefined // last board activity marker we acted on (edge detection)
}

const tracked = new Map<string, Tracked>() // insertion order = observation recency (refreshed on observe)
let client: QueryClient | null = null
let dripTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeCache: (() => void) | null = null
let unsubscribeBoard: (() => void) | null = null

function transcriptSlug(queryKey: unknown): string | null {
  if (!Array.isArray(queryKey) || queryKey.length !== 2) return null
  return queryKey[0] === "transcript" && typeof queryKey[1] === "string" ? queryKey[1] : null
}

function threadActivity(slug: string): string | undefined {
  const board = store.board as BoardSnapshot | null
  return board?.threads.find((t) => t.id === slug)?.lastActivityAt
}

// The live set is the MAX_LIVE most recently observed slugs. Newly observed slugs enter through the drip
// queue; slugs pushed out of the window (or losing their last observer) release their subscription ref.
function reconcileLiveSet(): void {
  const observed = [...tracked.entries()].filter(([, t]) => t.observers > 0)
  const liveWindow = new Set(observed.slice(-MAX_LIVE).map(([slug]) => slug))
  for (const [slug, t] of tracked) {
    if (t.observers <= 0) {
      if (t.live) {
        t.live = false
        unsubscribeTranscript(slug)
      }
      tracked.delete(slug)
      continue
    }
    if (!liveWindow.has(slug)) {
      t.queued = false // fell out of the recency window while still waiting for a slot
      if (t.live) {
        t.live = false
        unsubscribeTranscript(slug)
      }
    } else if (!t.live && !t.queued) {
      t.queued = true
    }
  }
  scheduleDrip()
}

function scheduleDrip(): void {
  if (dripTimer) return
  const pending = [...tracked.values()].some((t) => t.queued)
  if (!pending) return
  dripTimer = setTimeout(() => {
    dripTimer = null
    let granted = 0
    let liveCount = [...tracked.values()].filter((t) => t.live).length
    for (const [slug, t] of tracked) {
      if (granted >= DRIP_BATCH || liveCount >= MAX_LIVE) break
      if (!t.queued) continue
      t.queued = false
      if (t.observers <= 0 || t.live) continue
      t.live = true
      liveCount++
      t.lastActivityAt = threadActivity(slug) // a fresh subscription pushes a full snapshot; re-baseline
      subscribeTranscript(slug)
      granted++
    }
    scheduleDrip()
  }, DRIP_MS)
}

// Board moved: any observed-but-not-subscribed slug whose lastActivityAt advanced gets ONE pull refetch.
// Subscribed slugs are covered by the push (strictly more sensitive — it fires on byte-advance, not just
// activity); a slug the push refused — oversized or over budget — pulls here instead.
function onBoardChange(): void {
  if (!client) return
  for (const [slug, t] of tracked) {
    if (t.observers <= 0) continue
    const activity = threadActivity(slug)
    if (activity === t.lastActivityAt) continue
    t.lastActivityAt = activity
    const fallback = store.socketTranscriptFallbacks[slug]
    if (t.live && store.socketTranscripts && !fallback) continue // push channel owns freshness for this slug
    void client.refetchQueries({ queryKey: ["transcript", slug], exact: true, type: "active" })
  }
}

// Entry point — called once from main alongside connectSync. Idempotent; inert until a transcript query
// gains an observer.
export function initTranscriptLive(queryClient: QueryClient): void {
  if (client) return
  client = queryClient
  unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    const slug = transcriptSlug(event.query.queryKey)
    if (!slug) return
    if (event.type !== "observerAdded" && event.type !== "observerRemoved") return
    const observers = event.query.getObserversCount()
    const existing = tracked.get(slug)
    if (event.type === "observerAdded") {
      // Delete + re-set so Map insertion order tracks observation recency (the live-window sort key).
      tracked.delete(slug)
      tracked.set(slug, {
        observers,
        live: existing?.live ?? false,
        queued: existing?.queued ?? false,
        lastActivityAt: existing ? existing.lastActivityAt : threadActivity(slug),
      })
    } else if (existing) {
      existing.observers = observers
    }
    reconcileLiveSet()
  })
  unsubscribeBoard = subscribeStore(store, onBoardChange)
}

// Test seam: inspect/reset module state (module-level singletons survive between vitest cases otherwise).
export function _transcriptLiveState(): { tracked: Map<string, { observers: number; live: boolean }>; hasClient: boolean } {
  return { tracked: new Map([...tracked.entries()].map(([s, t]) => [s, { observers: t.observers, live: t.live }])), hasClient: client !== null }
}

export function _resetTranscriptLive(): void {
  for (const [slug, t] of tracked) {
    if (t.live) unsubscribeTranscript(slug)
  }
  tracked.clear()
  if (dripTimer) {
    clearTimeout(dripTimer)
    dripTimer = null
  }
  unsubscribeCache?.()
  unsubscribeCache = null
  unsubscribeBoard?.()
  unsubscribeBoard = null
  client = null
}
