import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptToolCall } from "@ntwine/shared"
import type { ChatMessage } from "../hooks.ts"
import { coalesceToolActivityMessages, coalesceToolActivityMessagesFull } from "./toolActivity.ts"

// coalesceToolActivityMessages resumes from the last message two calls share by identity
// (toolActivity.ts, INCREMENTAL). Every case here drives a transcript the way the live channel does —
// the same message objects, with messages appended, replaced or prepended — and holds each answer to a
// pass from scratch over the same list.

let clock = 0
const at = () => new Date(Date.UTC(2026, 9, 16, 12, 0, clock++)).toISOString()
const call = (name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall => ({ name, status: "completed", ...over })
const tools = (id: string, calls: TranscriptToolCall[]): ChatMessage => ({ sourceId: id, role: "assistant", text: "", tools: calls, parts: [{ kind: "tools", tools: calls }], at: at() })
const prose = (id: string, text: string, tail: TranscriptToolCall[] = []): ChatMessage => ({
  sourceId: id, role: "assistant", text, tools: tail,
  parts: [{ kind: "text", text }, ...(tail.length ? [{ kind: "tools" as const, tools: tail }] : [])], at: at(),
})
const human = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ sourceId: id, role: "user", text, tools: [], at: at(), ...over })
const shell = (id: string): ChatMessage => ({ sourceId: id, role: "assistant", text: "", tools: [], parts: [], at: at() })

// Each list in `versions` is what the channel delivers next. Every answer must equal a pass from scratch,
// and so must every EARLIER answer once later ones have been computed: the fold mutates the open run's
// entry, and a resumed run must never do that to an output another render still holds.
function assertTracksFull(versions: readonly (readonly ChatMessage[])[]): void {
  const answers: { input: readonly ChatMessage[]; output: unknown }[] = []
  for (const input of versions) {
    const output = coalesceToolActivityMessages(input)
    assert.deepEqual(output, coalesceToolActivityMessagesFull(input))
    answers.push({ input, output })
  }
  for (const { input, output } of answers) assert.deepEqual(output, coalesceToolActivityMessagesFull(input))
}

// A run that stays OPEN across the appends: each batch folds into the entry the previous answer ended on.
test("a streaming tool run folds each new batch into the run the last answer left open", () => {
  const list: ChatMessage[] = [human("h1", "Fix the table"), prose("p1", "Looking.", [call("Read", { detail: "a.ts" })])]
  const versions = [list.slice()]
  for (let i = 0; i < 6; i++) versions.push((list.push(tools(`t${i}`, [call("Grep", { detail: `q${i}` })])), list.slice()))
  assertTracksFull(versions)
  const last = coalesceToolActivityMessages(versions.at(-1)!)
  assert.deepEqual(last.at(-1)!.message.tools.map((t) => t.detail), ["a.ts", "q0", "q1", "q2", "q3", "q4", "q5"])
})

// The boundaries that close a run, each arriving as the newest message after the run was open.
test("a human turn, prose and a dedicated card each close the open run when they arrive", () => {
  const base = [prose("p0", "Starting.", [call("Read")]), tools("t0", [call("Grep")])]
  const closers = [
    human("h", "Actually, check the footer too"),
    prose("p", "Found it."),
    tools("agent", [call("Agent", { agentId: "a1", prompt: "inspect", status: "pending" })]),
  ]
  for (const closer of closers) {
    const after = [...base, closer, tools("t-after", [call("Read", { detail: "after" })])]
    assertTracksFull([base, [...base, closer], after])
  }
})

// A message the server finalizes (a pending call completes) arrives as a NEW object in the middle of
// what was shared: the fold resumes from just before it, not from the tail.
test("a message replaced mid-transcript re-coalesces from that message on", () => {
  const pending = tools("t1", [call("Bash", { status: "pending" })])
  const v1 = [prose("p0", "Running the suite.", [call("Read")]), pending, prose("p1", "Waiting on it."), tools("t2", [call("Grep")])]
  const v2 = v1.map((m) => (m === pending ? { ...pending, tools: [call("Bash", { status: "completed" })], parts: [{ kind: "tools" as const, tools: [call("Bash", { status: "completed" })] }] } : m))
  assertTracksFull([v1, v2, [...v2, tools("t3", [call("Read")])]])
})

// A queued bubble neither ends a run nor stays put: it is pinned, then lands as an ordinary human turn,
// which shrinks the list's identity overlap to before the bubble.
test("a queued send that lands as a human turn", () => {
  const base = [prose("p0", "Reading.", [call("Read")]), tools("t0", [call("Grep")])]
  const queued = human("q", "also the header", { queued: true })
  const withQueued = [...base, queued, tools("t1", [call("Read", { detail: "late" })])]
  const landed = [...base, human("q", "also the header"), tools("t1b", [call("Read", { detail: "late" })])]
  assertTracksFull([base, withQueued, landed])
})

// Ordinary calls batched AHEAD of a dispatch move up into the run above (messageToolPrefix), and empty
// provider shells in between are invisible; both have to survive a resume that lands right on them.
test("a leading ordinary call and an empty shell, resumed onto", () => {
  const base = [prose("p0", "Planning.", [call("Read")])]
  const mixed = tools("mixed", [call("ToolSearch"), call("Agent", { agentId: "a2", prompt: "go", status: "pending" })])
  assertTracksFull([base, [...base, shell("s1")], [...base, shell("s1"), mixed], [...base, shell("s1"), mixed, tools("t9", [call("Grep")])]])
})

// A page of history arrives ABOVE the head: a new first message, and so a pass from scratch.
test("history prepended above the head", () => {
  const live = [prose("p5", "Continuing.", [call("Read")]), tools("t5", [call("Grep")])]
  const earlier = [human("h0", "Start"), prose("p4", "On it.", [call("Read")]), tools("t4", [call("Grep")])]
  assertTracksFull([live, [...earlier, ...live], [...earlier, ...live, tools("t6", [call("Read")])]])
})
