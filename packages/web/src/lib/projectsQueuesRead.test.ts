import assert from "node:assert/strict"
import test from "node:test"
import type { ProjectQueue } from "@ntwine/shared"
import { QueryClient } from "@tanstack/react-query"
import { projectsQueuesQuery, readStartedAt } from "./projectsQueuesRead.ts"

// The cache entry must say when the read it holds STARTED, on every read, through a real QueryClient — the
// layer that broke it. react-query's structural sharing never stores the array a read returned (a fresh
// copy when anything changed, the previous array when nothing did), so the read's own stamp was lost from
// the second changed read on, and the page's two readers (AllQueues.tsx useDepartedQueue and
// useLeavingCards) waited forever for a read they could never see: a project's queue the page left stayed
// frozen until a reload (found 2026-10-06 by scripts/verify-all-queues.mjs).
async function withQueues(answers: readonly unknown[], run: (fetched: () => Promise<{ data: readonly ProjectQueue[]; startedBefore: number; startedAfter: number }>) => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  const previous = globalThis.location
  let call = 0
  globalThis.location = { pathname: "/all", search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: answers[Math.min(call++, answers.length - 1)] }), { headers: { "content-type": "application/json" } })) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await run(async () => {
      const startedBefore = Date.now()
      await client.fetchQuery({ ...projectsQueuesQuery, staleTime: 0 })
      const startedAfter = Date.now()
      return { data: client.getQueryData(projectsQueuesQuery.queryKey)!, startedBefore, startedAfter }
    })
  } finally {
    client.clear()
    globalThis.fetch = original
    globalThis.location = previous
  }
}

const queue = (threads: readonly string[]) => [{ projectId: "p1", projectSlug: "acme", threads: threads.map((id) => ({ id })) }]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("a read that changed the queues still says when it started", async () => {
  await withQueues([queue(["a"]), queue(["a", "b"]), queue(["b"])], async (fetched) => {
    for (let read = 0; read < 3; read++) {
      const { data, startedBefore, startedAfter } = await fetched()
      const at = readStartedAt(data)
      assert.ok(at !== undefined, `read ${read + 1} lost its start`)
      assert.ok(at >= startedBefore && at <= startedAfter, `read ${read + 1} carries another read's start`)
      await sleep(5)
    }
  })
})

test("a read that changed nothing keeps the cached array and moves its start to the newer read", async () => {
  await withQueues([queue(["a"])], async (fetched) => {
    const first = await fetched()
    const firstAt = readStartedAt(first.data)!
    await sleep(5)
    const second = await fetched()
    // Structural sharing kept the identity, which is what spares every memo on the page a re-derive…
    assert.equal(second.data, first.data)
    // …and the stamp now names the newer read, which saw exactly this.
    const at = readStartedAt(second.data)!
    assert.ok(at > firstAt && at >= second.startedBefore && at <= second.startedAfter)
  })
})
