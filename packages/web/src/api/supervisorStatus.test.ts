import assert from "node:assert/strict"
import { test } from "node:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { isDevNtwineBuild } from "./restart.ts"
import { supervisorPollMs, supervisorStatusQueryOptions } from "./supervisorStatus.ts"

// The contract, not an optimisation detail: THREE independent surfaces ask the supervisor the same
// question — App's control-plane monitor, the Restart ntwine button, and the dev-build verb in a thread
// header (one header per queue card). On the maintainer's board they were measured firing at t+58ms,
// t+61ms and t+63ms of a single navigation, into a six-connection HTTP/1.1 pool that was already
// carrying ~11 RPCs. Sharing one query is what keeps that at one request.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

function stubFetch(handler: () => Promise<Response>): () => number {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return handler() }) as typeof fetch
  test.after(() => { globalThis.fetch = original })
  return () => calls
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
}

// A surface reading the status: exactly what useSupervisorStatus() mounts, minus React.
function observe(qc: QueryClient): { stop: () => void; observer: QueryObserver<Awaited<ReturnType<typeof supervisorStatusQueryOptions.queryFn>>> } {
  const observer = new QueryObserver(qc, supervisorStatusQueryOptions)
  return { stop: observer.subscribe(() => {}), observer }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test("however many surfaces read the supervisor, ONE status request goes on the wire", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls = stubFetch(async () => { await gate; return json({ protocol: 1, state: "ready", dev: true }) })
  const qc = makeClient()

  // Concurrent, the shape of one navigation: App, the restart button and a card's footer verb together.
  const readers = [observe(qc), observe(qc), observe(qc)]
  release()
  await settle()
  assert.equal(calls(), 1, "three simultaneous readers must not make three requests")
  for (const reader of readers) assert.equal(reader.observer.getCurrentResult().data?.dev, true)

  // A card mounting AFTERWARDS is answered from the shared entry — sharing the key is not enough on its
  // own, because a zero staleTime would send every late arrival back to the supervisor.
  const late = observe(qc)
  await settle()
  assert.equal(calls(), 1, "a reader mounting inside the poll's period reads the cache")
  assert.equal(late.observer.getCurrentResult().data?.dev, true)

  for (const reader of [...readers, late]) reader.stop()
  qc.clear()
})

// A `null` answer is not evidence of a production build: getNtwineSupervisorStatus folds an unreachable
// supervisor, a non-protocol reply and the SPA HTML fallback all into it, and a supervisor is
// legitimately unreachable while it restarts. The poll is the retry — the module-level promise this
// replaced could cache that window for the rest of the page's life.
test("an unreachable supervisor reads as not-dev, and the next read asks again", async () => {
  let down = true
  const calls = stubFetch(async () => {
    if (down) throw new Error("supervisor restarting")
    return json({ protocol: 1, state: "ready", dev: true })
  })
  const qc = makeClient()

  const reader = observe(qc)
  await settle()
  assert.equal(reader.observer.getCurrentResult().data, null)
  assert.equal(isDevNtwineBuild(reader.observer.getCurrentResult().data ?? null), false, "never show a dev-only verb on no evidence")
  assert.equal(calls(), 1)

  down = false
  await reader.observer.refetch()
  assert.equal(isDevNtwineBuild(reader.observer.getCurrentResult().data ?? null), true, "the next read believes the supervisor, not the outage")
  assert.equal(calls(), 2)

  reader.stop()
  qc.clear()
})

test("the poll runs gently at rest and promptly across a handoff", () => {
  assert.equal(supervisorPollMs("ready", false), 8_000)
  assert.equal(supervisorPollMs(undefined, false), 8_000)
  assert.equal(supervisorPollMs("failed", false), 8_000)
  assert.equal(supervisorPollMs("restarting", false), 500)
  // The optimistic window: the button raised the overlay, the supervisor has not confirmed it yet.
  assert.equal(supervisorPollMs("ready", true), 500)
})
