import assert from "node:assert/strict"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { noteStandaloneThreadRender, primeFullscreenReturn, resetProjectState, store } from "./store.ts"

// Leaving /full plays the door's transition in reverse, which can only morph the fullscreen column into a
// drawer that exists in the page's FIRST commit — so primeFullscreenReturn pushes it there rather than
// leaving it to resolveRoutedThread one effect later. It skipped a QUEUED thread until 2026-09-28: on the
// project board a queued thread's surface was its card. On the one page the card is a summary and the
// drawer is the thread, so every thread, queued or not, returns to its drawer at once.

const thread = (over: Partial<ThreadView>) =>
  ({ id: "fix-auth", kind: "session", state: "open", status: "active", runtime: "turn-idle", needsYou: false, ...over }) as unknown as ThreadView

function returnFrom(t: ThreadView) {
  const previous = globalThis.window
  globalThis.window = { setTimeout: () => 0 } as unknown as Window & typeof globalThis
  try {
    resetProjectState()
    store.board = { threads: [t] } as unknown as BoardSnapshot
    noteStandaloneThreadRender(t.id)
    primeFullscreenReturn(t.id)
    return store.drawers.map((d) => `${d.kind}:${d.slug}${d.routed ? " (routed)" : ""}`)
  } finally {
    resetProjectState()
    globalThis.window = previous
  }
}

test("a queued thread returns from fullscreen to its drawer in the first commit", () => {
  assert.deepEqual(returnFrom(thread({ needsYou: true })), ["thread:fix-auth (routed)"])
})

test("a thread that is not queued returns to its drawer, as it always did", () => {
  assert.deepEqual(returnFrom(thread({ runtime: "running" })), ["thread:fix-auth (routed)"])
})

test("a thread with a terminal on it still returns to its own drawer", () => {
  assert.deepEqual(returnFrom(thread({ needsYou: true, terminals: [{ id: "term-1", command: "npm publish", cwd: "/repo", state: "running", awaitingInput: true, runId: 1, startedAt: "2026-09-29T10:00:00.000Z" }] })), ["thread:fix-auth (routed)"])
})

test("a return URL naming another thread pushes nothing", () => {
  const previous = globalThis.window
  globalThis.window = { setTimeout: () => 0 } as unknown as Window & typeof globalThis
  try {
    resetProjectState()
    store.board = { threads: [thread({ needsYou: true })] } as unknown as BoardSnapshot
    noteStandaloneThreadRender("fix-auth")
    primeFullscreenReturn("something-else")
    assert.deepEqual(store.drawers, [])
  } finally {
    resetProjectState()
    globalThis.window = previous
  }
})
