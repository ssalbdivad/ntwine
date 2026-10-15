import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { KEEP_WORKING_MESSAGE, type AwaitingHint, type TranscriptMessage } from "@ntwine/shared"
import { AwaitingBackgroundCard } from "./AwaitingBackgroundCard.tsx"
import { AwaitingSubAgentsCard } from "./AwaitingSubAgentsCard.tsx"
import { KeepWorkingMarker } from "./KeepWorking.tsx"
import { drawsKeepWorkingMarker, offersKeepWorking } from "../lib/keepWorking.ts"
import { lastHumanTurnIndex } from "../lib/messagePresentation.ts"

// KEEP WORKING: offered on a resting card for a `needs_input` park, or a rest with no fence at all, while
// the thread's own work still runs; and the message it sends drawn as the human's one-line marker, never as
// their bubble of worker-facing words.

const AT = "2026-10-14T12:00:00.000Z"
const devServer = { id: "toolu_s", taskId: "bzvtnt3ig", label: "vite dev", startedAt: AT, state: "running" as const }
const lane = { id: "toolu_a", taskId: "a1b2c3", label: "Audit lane", startedAt: AT, state: "running" as const }
const hints = (...h: [AwaitingHint["kind"], string][]): AwaitingHint[] => h.map(([kind, value]) => ({ kind, value }))
const tryIt = hints(["shell", "bzvtnt3ig"], ["status", "needs_input"])

type CardThread = NonNullable<Parameters<typeof AwaitingBackgroundCard>[0]["thread"]>
const resting = (fenceHints: AwaitingHint[], over: Partial<CardThread> = {}) => ({
  id: "demo-thread", sessionId: "sess-demo", kind: "session", state: "open", awaitingBackground: true, runtime: "turn-idle",
  lastAssistantAt: AT, subAgents: [], bgShells: [devServer],
  // No prose: the card renders it through the DOM sanitizer, which node has not got.
  lastFence: { kind: "awaiting", body: "", hints: fenceHints },
  ...over,
} as CardThread)

const card = (thread: CardThread, fence?: { body: string; hints: AwaitingHint[] }) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AwaitingBackgroundCard, { thread, fence })))
const offered = (thread: CardThread, fence?: { body: string; hints: AwaitingHint[] }) => card(thread, fence).includes("data-keep-working")

test("offered on a needs_input park that names a shell or sub-agent still running, by any handle it answers to", () => {
  assert.equal(offered(resting(tryIt)), true)
  assert.match(card(resting(tryIt)), /data-keep-working[^>]*>Keep working</)
  // Named by its label, and a sub-agent named by the task id the runtime handed the worker.
  assert.equal(offered(resting(hints(["shell", "vite dev"], ["status", "needs_input"]))), true)
  assert.equal(offered(resting(hints(["agent", "a1b2c3"], ["status", "needs_input"]), { bgShells: [], subAgents: [lane] })), true)
})

test("not offered where there is nothing to go back to, or the worker did not ask for the human", () => {
  // Already parked working (or watching): it is not asking for anything.
  assert.equal(offered(resting(hints(["shell", "bzvtnt3ig"], ["status", "working"]))), false)
  // The named shell has finished: there is no work left to wait on.
  assert.equal(offered(resting(tryIt, { bgShells: [{ ...devServer, state: "stale" }] })), false)
  // A live shell the fence never named is not the park's work.
  assert.equal(offered(resting(hints(["shell", "other"], ["status", "needs_input"]))), false)
  // Steps are the human's to do, and carry their own Done (read at the gate: a step renders through the
  // DOM sanitizer).
  assert.equal(offersKeepWorking(resting(hints(["shell", "bzvtnt3ig"], ["step", "Sign in to the staging account"]))), false)
  // Mid-turn, and on the card drawn from a fence the thread has since moved past.
  assert.equal(offered(resting(tryIt, { runtime: "working" })), false)
  assert.equal(offered(resting(tryIt), { body: "", hints: tryIt }), false)
  // Archived: no verbs at all.
  assert.equal(offered(resting(tryIt, { archived: true })), false)
})

// A Workflow run is a direct sub-agent row; its agents are depth 2 under it (tailer subAgentViews).
const workflowRun = { id: "toolu_w", taskId: "wlx2xkdou", label: "Voice rewrite", startedAt: AT, state: "running" as const, workflow: true }
const workflowAgent = { id: "ae0727b11fe7bb7de", label: "revise", startedAt: AT, state: "running" as const, depth: 2, parentId: "toolu_w" }
const bare = (over: Partial<CardThread> = {}) => resting([], { lastFence: undefined, bgShells: [], subAgents: [workflowRun, workflowAgent], ...over })

test("offered on a rest with no fence while its own sub-agent or Workflow runs: the reply that owed a park", () => {
  assert.equal(offered(bare()), true)
  assert.equal(offered(bare({ subAgents: [lane] })), true)
  // Only the Workflow's own agents still out, or only a shell nobody declared, is not the thread's wait.
  assert.equal(offered(bare({ subAgents: [workflowAgent] })), false)
  assert.equal(offered(bare({ subAgents: [], bgShells: [devServer] })), false)
  assert.equal(offered(bare({ subAgents: [{ ...workflowRun, state: "stale" }] })), false)
  // A done is finished, whatever is still out; and an open question outranks it (the server then clears
  // awaitingBackground, as it does for a limit or provider fault).
  assert.equal(offered(bare({ lastFence: { kind: "done", body: "", hints: [] } })), false)
  assert.equal(offered(bare({ awaitingBackground: false })), false)
})

test("a needs_input park that names no live work is offered while a sub-agent of its own runs", () => {
  const prOnly = hints(["pr", "acme/app#391"], ["status", "needs_input"])
  assert.equal(offered(resting(prOnly, { bgShells: [], subAgents: [workflowRun] })), true)
  assert.equal(offered(resting(prOnly, { bgShells: [devServer], subAgents: [] })), false)
  // A fence that gave no answer is bumped for one, not offered a verb that presumes it.
  assert.equal(offered(resting(hints(["agent", "wlx2xkdou"]), { subAgents: [workflowRun] })), false)
})

test("the queue's sub-agent batch card carries it too, which the queue draws in place of the resting card", () => {
  const batch = (thread: CardThread) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AwaitingSubAgentsCard, {
    project: { id: "p1", slug: "demo", projectDir: undefined }, thread, body: "", openThread: () => {},
  })))
  const parked = resting(hints(["agent", "wlx2xkdou"], ["status", "needs_input"]), { bgShells: [], subAgents: [workflowRun] })
  assert.match(batch(parked), /data-keep-working[^>]*>Keep working</)
  assert.equal(batch(resting(hints(["agent", "wlx2xkdou"], ["status", "working"]), { bgShells: [], subAgents: [workflowRun] })).includes("data-keep-working"), false)
  assert.equal(batch({ ...parked, archived: true }).includes("data-keep-working"), false)
})

const user = (over: Partial<TranscriptMessage>): TranscriptMessage => ({ role: "user", text: KEEP_WORKING_MESSAGE, tools: [], parts: [], ...over })

// ChatView's Message cannot load under node (it pulls in CSS), so its branch is pinned at the predicate it
// calls and the marker it returns.
test("the sent message draws as the human's marker, served or optimistic, and never as its raw words", () => {
  assert.equal(drawsKeepWorkingMarker(user({ keepWorking: true })), true)
  // The optimistic copy carries only the raw text.
  assert.equal(drawsKeepWorkingMarker(user({ queued: true })), true)
  // The envelope pasted inside a message of the human's own is just their message.
  assert.equal(drawsKeepWorkingMarker(user({ text: `look at this:\n${KEEP_WORKING_MESSAGE}` })), false)
  const marker = renderToStaticMarkup(createElement(KeepWorkingMarker, { sourceId: "u1" }))
  assert.equal(marker.replace(/<[^>]+>/g, ""), "Told it to keep working")
  assert.match(renderToStaticMarkup(createElement(KeepWorkingMarker, { dimmed: true })), /opacity-50/)
})

test("it is not the human's turn the queue card opens at", () => {
  const ask = user({ text: "Add the login flow", sourceId: "u0" })
  const reply = { role: "assistant" as const, text: "Try it on :5173.", tools: [], parts: [] }
  assert.equal(lastHumanTurnIndex([ask, reply, user({ keepWorking: true }), reply]), 0)
})
