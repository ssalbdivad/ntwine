import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { withoutRedundantRestDividers } from "./restDividers.ts"

// The client's real predicate mirrored: only an assistant message with no prose and no tools renders
// nothing. Kept local so this stays a pure unit test rather than importing ChatView's React module.
const rendersNothing = (m: ChatMessage): boolean =>
  m.kind !== "event" && m.kind !== "reasoning" && m.role !== "user" && (m.tools?.length ?? 0) === 0 && !m.text.trim()

const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({ sourceId: over.sourceId ?? "x", role: "assistant", text: "", tools: [], parts: [], ...over }) as ChatMessage

const rest = (id = "r") => msg({ sourceId: id, kind: "event", boundary: "rest", text: "Agent rested" })
const prose = (id = "a") => msg({ sourceId: id, text: "Fixed — landed on main." })
const human = (id = "u") => msg({ sourceId: id, role: "user", text: "and the other thing?" })

const kept = (messages: ChatMessage[]): string[] =>
  withoutRedundantRestDividers(messages.map((message, i) => ({ message, messageIndex: i })), rendersNothing)
    .map((e) => e.message.sourceId!)

test("a rest above the human's reply survives — it is what tells a reply apart from a mid-turn steer", () => {
  assert.deepEqual(kept([prose(), rest(), human()]), ["a", "r", "u"])
})

test("a rest at the tail is dropped — the runtime-status slot beneath it already says the agent stopped", () => {
  assert.deepEqual(kept([prose(), rest()]), ["a"])
})

test("a rest above another divider is dropped — nothing wakes an agent that had not rested", () => {
  const wake = msg({ sourceId: "w", kind: "event", boundary: "wake", text: "Agent terminal «vite» exited 143" })
  assert.deepEqual(kept([prose(), rest(), wake]), ["a", "w"])
})

test("a rest above an ntwine wake DELIVERY is dropped too — those render as their own hairline, not a bubble", () => {
  const signoff = msg({ sourceId: "s", role: "user", wake: true, text: "…sign off with a fence…" })
  assert.deepEqual(kept([prose(), rest(), signoff]), ["a", "s"])
})

test("a rest above a sub-agent's completion is dropped — even though a child can also finish mid-turn", () => {
  const finished = (id: string) => {
    const call = { id: `t-${id}`, name: "Agent", status: "completed", detail: "Surveying prior art", agentCompletion: true }
    return msg({ sourceId: id, tools: [call], parts: [{ kind: "tools", tools: [call] }] } as Partial<ChatMessage>)
  }
  // The reported thread: a parent parked on its children, re-resting after each return.
  assert.deepEqual(
    kept([prose(), rest("r1"), finished("f1"), rest("r2"), finished("f2"), prose("a2"), rest("r3"), human()]),
    ["a", "f1", "f2", "a2", "r3", "u"],
  )
})

test("an empty thinking-only turn between the two hairlines does not rescue the rest", () => {
  const blank = msg({ sourceId: "blank" })
  const wake = msg({ sourceId: "w", kind: "event", boundary: "wake", text: "Agent «probe» finished" })
  assert.deepEqual(kept([prose(), rest(), blank, wake]), ["a", "blank", "w"])
})

test("a rest above a compaction divider is dropped; the one above the human's next turn is kept", () => {
  const compaction = msg({ sourceId: "c", kind: "event", boundary: "compaction", text: "Context compacted" })
  assert.deepEqual(kept([prose(), rest("r1"), compaction, prose("a2"), rest("r2"), human()]), ["a", "c", "a2", "r2", "u"])
})

test("nothing but rest dividers collapses to nothing", () => {
  assert.deepEqual(kept([rest("r1"), rest("r2")]), [])
})
