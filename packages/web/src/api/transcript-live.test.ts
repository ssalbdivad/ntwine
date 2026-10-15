import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { initTranscriptLive, _transcriptLiveState, _resetTranscriptLive } from "./transcript-live.ts"
import { store } from "../store.ts"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"

// The drip flushes every 700ms; wait one beat past it.
const DRIP_WAIT = 850
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
}

function observe(qc: QueryClient, slug: string): () => void {
  const observer = new QueryObserver(qc, { queryKey: ["transcript", slug], queryFn: async () => ({ messages: [] }), enabled: false })
  return observer.subscribe(() => {})
}

function boardWith(threads: Array<Partial<ThreadView> & { id: string }>): BoardSnapshot {
  return { threads: threads as ThreadView[], errors: [] } as unknown as BoardSnapshot
}

afterEach(() => {
  _resetTranscriptLive()
  store.board = null
  store.socketTranscripts = false
  store.socketTranscriptFallbacks = {}
})

test("an observed transcript query becomes live after the drip; unobserving releases it", async () => {
  const qc = makeClient()
  initTranscriptLive(qc)
  const stop = observe(qc, "alpha")
  await sleep(DRIP_WAIT)
  assert.equal(_transcriptLiveState().tracked.get("alpha")?.live, true)
  stop()
  await sleep(20)
  assert.equal(_transcriptLiveState().tracked.has("alpha"), false)
})

test("the live window caps at 24 by observation recency; older slugs stay tracked but not live", async () => {
  const qc = makeClient()
  initTranscriptLive(qc)
  const stops = Array.from({ length: 26 }, (_, i) => observe(qc, `slug-${i}`))
  // Drip grants 6 per beat: wait enough beats to drain the whole queue.
  await sleep(DRIP_WAIT * 5)
  const state = _transcriptLiveState().tracked
  assert.equal(state.get("slug-0")?.live, false) // pushed out of the recency window
  assert.equal(state.get("slug-1")?.live, false)
  assert.equal(state.get("slug-25")?.live, true)
  assert.equal([...state.values()].filter((t) => t.live).length, 24)
  stops.forEach((s) => s())
})

test("a board activity edge refetches an observed slug the push channel does not cover", async () => {
  const qc = makeClient()
  const refetched: string[] = []
  const original = qc.refetchQueries.bind(qc)
  qc.refetchQueries = ((filters: { queryKey?: unknown[] }) => {
    refetched.push(String(filters?.queryKey?.[1]))
    return original(filters as never)
  }) as typeof qc.refetchQueries
  initTranscriptLive(qc)
  store.socketTranscripts = false // SSE mode: even a "live"-flagged slug needs the pull
  store.board = boardWith([{ id: "edge-1", lastActivityAt: "2026-07-21T00:00:00.000Z" }])
  const stop = observe(qc, "edge-1")
  await sleep(DRIP_WAIT)
  assert.deepEqual(refetched, []) // no edge yet — observation alone must not refetch
  store.board = boardWith([{ id: "edge-1", lastActivityAt: "2026-07-21T00:00:05.000Z" }])
  await sleep(60) // valtio notifies asynchronously
  assert.deepEqual(refetched, ["edge-1"])
  stop()
})

// Socket-covered slugs are NOT edge-refetched; a slug the socket refused — payload-too-large or read
// budget — IS. Before 2026-09-16 both refusals were left manual, which froze the thread page of any refused
// thread until a hard reload — the paged HTTP read is bounded and off the socket's budget, so one pull per
// activity edge is the same policy a beyond-budget slug already gets.
test("edge refetch: not for a socket-covered slug; yes for a refused one, whichever refusal", async () => {
  const qc = makeClient()
  const refetched: string[] = []
  qc.refetchQueries = ((filters: { queryKey?: unknown[] }) => {
    refetched.push(String(filters?.queryKey?.[1]))
    return Promise.resolve()
  }) as typeof qc.refetchQueries
  initTranscriptLive(qc)
  store.socketTranscripts = true
  store.socketTranscriptFallbacks = {
    paused: { kind: "read-budget", scope: "origin", retryAfterMs: 1000 },
    oversized: { kind: "payload-too-large", actualBytes: 4_465_249, maxBytes: 4_194_304 },
  }
  store.board = boardWith([
    { id: "covered", lastActivityAt: "2026-07-21T00:00:00.000Z" },
    { id: "paused", lastActivityAt: "2026-07-21T00:00:00.000Z" },
    { id: "oversized", lastActivityAt: "2026-07-21T00:00:00.000Z" },
  ])
  const stops = [observe(qc, "covered"), observe(qc, "paused"), observe(qc, "oversized")]
  await sleep(DRIP_WAIT)
  assert.equal(_transcriptLiveState().tracked.get("covered")?.live, true)
  store.board = boardWith([
    { id: "covered", lastActivityAt: "2026-07-21T00:00:09.000Z" },
    { id: "paused", lastActivityAt: "2026-07-21T00:00:09.000Z" },
    { id: "oversized", lastActivityAt: "2026-07-21T00:00:09.000Z" },
  ])
  await sleep(60)
  assert.deepEqual(refetched, ["paused", "oversized"]) // push owns "covered"; both refusals pull
  // No edge, no pull: the refusal policy is one request per real change, never a poll.
  store.board = boardWith([
    { id: "covered", lastActivityAt: "2026-07-21T00:00:09.000Z" },
    { id: "paused", lastActivityAt: "2026-07-21T00:00:09.000Z" },
    { id: "oversized", lastActivityAt: "2026-07-21T00:00:09.000Z" },
  ])
  await sleep(60)
  assert.deepEqual(refetched, ["paused", "oversized"])
  stops.forEach((s) => s())
})
