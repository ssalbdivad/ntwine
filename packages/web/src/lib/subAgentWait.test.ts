import assert from "node:assert/strict"
import test from "node:test"
import type { ThreadView } from "@ntwine/shared"
import { drawsSubAgentWaitCard, showsSubAgentWait, subAgentWait, subAgentWaitHeading } from "./subAgentWait.ts"

const running = (id: string, over: Partial<ThreadView["subAgents"][number]> = {}) => ({ id, label: id, startedAt: "2026-09-29T10:00:00.000Z", state: "running" as const, ...over })
const back = (id: string) => ({ id, label: id, status: "completed" as const, finishedAt: "2026-09-29T10:03:00.000Z" })
const queued = (over: Partial<ThreadView> = {}) => ({
  kind: "session" as const, foreign: false, runtime: "turn-idle" as const, pendingQuestion: false, questions: [],
  lastFence: { kind: "awaiting" as const, body: "Waiting on the audits.", hints: [] },
  subAgents: [running("b"), running("c")], returnedSubAgents: [back("a")], ...over,
})

test("the heading counts the batch in place of a bare 'Awaiting'", () => {
  assert.equal(subAgentWaitHeading(subAgentWait(queued())!), "1 of 3 sub-agents returned")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: [back("a"), back("b")], subAgents: [running("c")] }))!), "2 of 3 sub-agents returned")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: undefined }))!), "Waiting on 2 sub-agents")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: undefined, subAgents: [running("c")] }))!), "Waiting on 1 sub-agent")
  // A descendant is not a sibling in the batch: it neither counts nor opens the wait.
  assert.equal(subAgentWait(queued({ subAgents: [running("c"), running("g", { depth: 2 })] }))!.total, 2)
  assert.equal(subAgentWait(queued({ subAgents: [running("g", { depth: 2 })] })), undefined)
})

test("the card states the wait only at rest, with a child running, and nothing that outranks it", () => {
  assert.equal(showsSubAgentWait(queued()), true)
  // Negative controls, one reason each.
  assert.equal(showsSubAgentWait(queued({ subAgents: [running("b", { state: "stale" })] })), false, "nothing running")
  assert.equal(showsSubAgentWait(queued({ runtime: "running" })), false, "mid-turn")
  assert.equal(showsSubAgentWait(queued({ lastFence: { kind: "done", body: "", hints: [] } })), false, "a done handoff")
  assert.equal(showsSubAgentWait(queued({ pendingQuestion: true })), false, "a question")
  assert.equal(showsSubAgentWait(queued({ foreign: true })), false, "another tool's session")
})

// WHO LISTS THE CHILDREN (2026-09-29). The awaiting card did, and nothing else on the card — so the moment
// a human reply retired the fence (the worker back at work), or a question or a done stood beside live
// children, the card listed none of them: "no longer appears to be running anything". The ops column under
// the reply box (QueueChildOps) lists them in every one of those states; the wait card only at rest on it.
test("the awaiting card lists the children only when drawn; every other state leaves them to the ops column", () => {
  const awaiting = [{ kind: "awaiting" }]
  assert.equal(drawsSubAgentWaitCard(queued(), awaiting), true, "at rest on the wait")
  assert.equal(drawsSubAgentWaitCard(queued(), undefined), true, "before the handoff is read, off the thread's own fence")
  assert.equal(drawsSubAgentWaitCard(queued({ runtime: "running", lastFence: undefined }), undefined), false, "a reply set the worker going")
  assert.equal(drawsSubAgentWaitCard(queued({ runtime: "running" }), awaiting), false, "a card held while its worker runs")
  assert.equal(drawsSubAgentWaitCard(queued({ pendingQuestion: true }), awaiting), false, "a question beside live children")
  assert.equal(drawsSubAgentWaitCard(queued({ lastFence: { kind: "done", body: "", hints: [] } }), [{ kind: "done" }]), false, "a done beside live children")
  assert.equal(drawsSubAgentWaitCard(queued(), []), false, "a handoff with no awaiting fence draws no wait card")
})
