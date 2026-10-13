import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProjectQueue, ThreadView } from "@ntwine/shared"
import { notify } from "../api/board-stream.ts"
import { store } from "../store.ts"
import { queueArrivals } from "./crossProjectNotify.ts"

// The one page binds one project's feed, so every OTHER project's threads reach it only by the
// projectsQueues poll — and until 2026-09-29 that poll raised no notification, so a thread that queued
// in any project but the focused one queued silently (one tab per project used to hear all of them).

const thread = (id: string, over: Partial<ThreadView> = {}) =>
  ({ id, title: id, kind: "session", foreign: false, needsYou: true, state: "open", lastAssistant: `${id} is ready`, ...over }) as ThreadView
const project = (projectId: string, threads: ThreadView[]): ProjectQueue =>
  ({ projectId, projectSlug: projectId, projectName: projectId, projectDir: `/p/${projectId}`, threads, doneCount: 0 }) as ProjectQueue

test("the first read is a baseline: a page that opens onto a full queue raises nothing", () => {
  const { arrivals } = queueArrivals(null, [project("alpha", [thread("a")]), project("beta", [thread("b")])])
  assert.deepEqual(arrivals, [])
})

test("a thread that newly enters a queue arrives once; the next read with it still queued is quiet", () => {
  const first = queueArrivals(null, [project("beta", [thread("b", { needsYou: false })])])
  const second = queueArrivals(first.next, [project("beta", [thread("b")])])
  assert.deepEqual(second.arrivals.map((a) => `${a.project.projectSlug}/${a.thread.id}`), ["beta/b"])
  const third = queueArrivals(second.next, [project("beta", [thread("b")])])
  assert.deepEqual(third.arrivals, [], "a second poll must not re-notify")
})

test("a project's first appearance is a baseline too, and a thread that leaves and returns arrives again", () => {
  const first = queueArrivals(null, [project("alpha", [])])
  const opened = queueArrivals(first.next, [project("alpha", []), project("beta", [thread("b")])])
  assert.deepEqual(opened.arrivals, [], "a project that has just been opened is not news")
  const gone = queueArrivals(opened.next, [project("alpha", []), project("beta", [])])
  const back = queueArrivals(gone.next, [project("alpha", []), project("beta", [thread("b")])])
  assert.deepEqual(back.arrivals.map((a) => a.thread.id), ["b"])
})

// Review 2026-09-30: a thread that leaves another project's queue for a moment and comes back with the very
// rest it left with is not news. The server stays quiet for that return (board.ts notifyNeedsYou `resumed`);
// this watcher must too, or the tab bound elsewhere raises a desktop notification for a card nothing
// happened to.
test("a thread back at the place it left, with the rest it left with, is not a new arrival — unless it is urgent", () => {
  const place = { queuedAt: "2026-09-30T09:30:00.000Z", lastAssistantAt: "2026-09-30T09:29:00.000Z" }
  const read = (over: Partial<ThreadView>) => [project("beta", [thread("p", { ...place, ...over })])]
  const first = queueArrivals(null, read({}))
  const away = queueArrivals(first.next, read({ needsYou: false, runtime: "running", queuedAt: undefined }))
  assert.deepEqual(away.arrivals, [])

  const back = queueArrivals(away.next, read({}))
  assert.deepEqual(back.arrivals, [], "the same place and the same rest: nothing new to say")

  // Anything new still notifies: the worker said something (a new rest)…
  assert.deepEqual(queueArrivals(away.next, read({ lastAssistantAt: "2026-09-30T09:31:00.000Z" })).arrivals.map((a) => a.thread.id), ["p"])
  // …the human acted, so it re-entered at the back (a new place)…
  assert.deepEqual(queueArrivals(away.next, read({ queuedAt: "2026-09-30T09:31:00.000Z" })).arrivals.map((a) => a.thread.id), ["p"])
  // …or it came back on something only a person can clear, which moves neither for a Codex approval.
  assert.deepEqual(queueArrivals(away.next, read({ runtime: "perm-prompt" })).arrivals.map((a) => a.thread.id), ["p"])
  assert.deepEqual(queueArrivals(away.next, read({ actionableInteraction: true })).arrivals.map((a) => a.thread.id), ["p"])
  assert.deepEqual(queueArrivals(away.next, read({ crashed: true })).arrivals.map((a) => a.thread.id), ["p"])

  // The remembered sighting survives more than one read out of the queue — a cold resume spans several polls.
  const stillAway = queueArrivals(away.next, read({ needsYou: false, runtime: "running", queuedAt: undefined }))
  assert.deepEqual(queueArrivals(stillAway.next, read({})).arrivals, [])
  // …but not the thread leaving the board altogether: that is forgotten, as on the server.
  const gone = queueArrivals(away.next, [project("beta", [])])
  assert.deepEqual(queueArrivals(gone.next, read({})).arrivals.map((a) => a.thread.id), ["p"])
})

// The server compares the urgent REASONS whole (shared queueUrgency), so a thread resting on a question keeps
// it through a departure and stays quiet; a first cut here exempted anything urgent and announced it anyway.
test("a thread resting on a question comes back from a departure with that question and stays quiet", () => {
  const place = { queuedAt: "2026-09-30T09:30:00.000Z", lastAssistantAt: "2026-09-30T09:29:00.000Z" }
  const asked = { questions: [{ id: "q_1" }] } as Partial<ThreadView>
  const read = (over: Partial<ThreadView>) => [project("beta", [thread("p", { ...place, ...asked, ...over })])]
  const first = queueArrivals(null, read({}))
  const away = queueArrivals(first.next, read({ needsYou: false, runtime: "running", queuedAt: undefined }))
  assert.deepEqual(queueArrivals(away.next, read({})).arrivals, [], "the same question is the same card")
  // A second question it did not leave with is news.
  assert.deepEqual(
    queueArrivals(away.next, read({ questions: [{ id: "q_1" }, { id: "q_2" }] } as Partial<ThreadView>)).arrivals.map((a) => a.thread.id),
    ["p"],
  )
})

test("only session threads queue a notification, as on the server", () => {
  const first = queueArrivals(null, [project("beta", [])])
  const { arrivals } = queueArrivals(first.next, [project("beta", [thread("cmd", { kind: "command" } as Partial<ThreadView>), thread("ext", { foreign: true })])])
  assert.deepEqual(arrivals, [])
})

test("a notification for another project is tagged by THAT project's address", () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const raised: { title: string; opts: { body?: string; tag?: string } }[] = []
  class FakeNotification {
    static permission = "granted"
    onclick: (() => void) | null = null
    constructor(readonly title: string, readonly opts: { body?: string; tag?: string }) { raised.push(this) }
    close(): void {}
  }
  install("Notification", FakeNotification)
  install("document", { hidden: true })
  install("location", { pathname: "/" })
  const before = store.notificationsEnabled
  store.notificationsEnabled = true
  try {
    notify({ type: "notify", slug: "fix-auth", kind: "needs-decision", title: "Fix auth" }, "beta")
    assert.equal(raised.at(-1)?.opts.tag, "/all/beta/fix-auth", "the same tag the beta-bound socket would raise, so a second copy replaces rather than stacks")
  } finally {
    store.notificationsEnabled = before
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<PropertyKey, unknown>)[key]
    }
  }
})
