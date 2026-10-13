import assert from "node:assert/strict"
import test from "node:test"
import type { TranscriptToolCall } from "@ntwine/shared"
import { AGENT_OUTCOME_VERB, agentCompletionCall, subAgentCompletionOutcome, type CompletionMessageLike } from "./subAgentCompletion.ts"

// The routing decision behind "an agent finishing looks like a background shell terminating". Getting
// it wrong in EITHER direction is a visible regression: too loose and the launch card (or a silent
// single-Task turn) loses its expandable prompt to a divider; too tight and the completion point goes
// back to drawing a duplicate card nobody can pick out of a tool band.

const dispatch: TranscriptToolCall = {
  name: "Agent",
  detail: "Audit the pricing parser for edge cases",
  prompt: "Audit it.",
  subagentType: "ntwine:opus-high",
  agentId: "toolu_a",
  status: "completed",
}
// What the server back-fills onto the LAUNCH card once the notification lands — same outcome fields,
// deliberately NO marker flag.
const backfilledLaunch: TranscriptToolCall = { ...dispatch, agentStatus: "completed", agentElapsedMs: 35 * 60_000 }
const marker: TranscriptToolCall = { ...backfilledLaunch, agentCompletion: true }

const msg = (tools: TranscriptToolCall[], extra: Partial<CompletionMessageLike> = {}): CompletionMessageLike => ({
  role: "assistant",
  text: "",
  tools,
  parts: [{ kind: "tools", tools }],
  ...extra,
})

test("a lone marker call in a text-less assistant message IS the completion", () => {
  assert.equal(agentCompletionCall(msg([marker])), marker)
})

test("the back-filled LAUNCH card is not a completion — it keeps its expandable prompt card", () => {
  // The only difference between these two calls is the flag. Without it the launch position would turn
  // into a divider and the dispatch prompt would become unreachable.
  assert.equal(agentCompletionCall(msg([backfilledLaunch])), undefined)
})

test("a batched tool band is never a completion, even when it contains the marker", () => {
  assert.equal(agentCompletionCall(msg([marker, dispatch])), undefined)
  assert.equal(agentCompletionCall(msg([dispatch, marker])), undefined)
})

test("prose, a user role, or an existing punctuation kind all disqualify the message", () => {
  assert.equal(agentCompletionCall(msg([marker], { text: "and here is what it found" })), undefined)
  assert.equal(agentCompletionCall(msg([marker], { role: "user" })), undefined)
  assert.equal(agentCompletionCall(msg([marker], { kind: "event" })), undefined)
  assert.equal(agentCompletionCall(msg([marker], { kind: "reasoning" })), undefined)
})

test("a message whose single part is TEXT is not a completion even with a stray marker in `tools`", () => {
  // `tools` is the legacy mirror of the parts walk; when parts exist they are the authority.
  assert.equal(agentCompletionCall({ role: "assistant", text: "", tools: [marker], parts: [{ kind: "text", text: "hi" }] }), undefined)
})

test("the legacy transport (no parts) resolves through the flat tools array", () => {
  assert.equal(agentCompletionCall({ role: "assistant", text: "", tools: [marker], parts: [] }), marker)
  assert.equal(agentCompletionCall({ role: "assistant", text: "", tools: [marker, dispatch], parts: [] }), undefined)
})

// ---- the label vocabulary, which must not drift from the shell's ----

test("outcome words mirror the background-shell wake label", () => {
  assert.equal(subAgentCompletionOutcome({ agentStatus: "completed" }).outcome, "finished")
  assert.equal(subAgentCompletionOutcome({ agentStatus: "failed" }).outcome, "failed")
  assert.equal(subAgentCompletionOutcome({ agentStatus: "killed" }).outcome, "stopped")
})

// The map is what the AgentBlock header reads too, so this is the guard against a SECOND surface
// re-deriving the words and leaking the raw enum (the header shipped a red "killed 10m" doing exactly
// that). No `agentStatus` value may ever render as itself.
test("no raw agentStatus value is ever a user-visible word", () => {
  assert.deepEqual(AGENT_OUTCOME_VERB, { completed: "finished", killed: "stopped", failed: "failed" })
  for (const [status, verb] of Object.entries(AGENT_OUTCOME_VERB)) {
    if (status === "failed") continue // the one status whose enum value IS the right English word
    assert.notEqual(verb, status, `"${status}" is a process enum, not copy`)
  }
})

test("a marker with no status degrades to the neutral outcome rather than inventing one", () => {
  assert.equal(subAgentCompletionOutcome({}).outcome, "finished")
  assert.equal(subAgentCompletionOutcome({}).tail, "finished", "and no fabricated duration")
})

test("the elapsed rides the label in the coarse fixed-duration form", () => {
  assert.equal(subAgentCompletionOutcome({ agentStatus: "completed", agentElapsedMs: 35 * 60_000 }).tail, "finished · 35m")
  assert.equal(subAgentCompletionOutcome({ agentStatus: "failed", agentElapsedMs: 12 * 60_000 }).tail, "failed · 12m")
})
