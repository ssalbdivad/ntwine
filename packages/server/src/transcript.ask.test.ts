import { test } from "node:test"
import assert from "node:assert/strict"
import { projectClaudeTranscript } from "./transcript.ts"
import type { TranscriptToolCall } from "@ntwine/shared"

// The NATIVE QUESTION projection. The line this file defends: an `AskUserQuestion` tool_use carries its
// structured questions onto the transcript card (`ask`), and its result — answered or withdrawn — only
// changes the card's settled state, never erases the question. This is the durable record behind the
// interaction card: a follow-up sent instead of an answer retires the pending card (the broker denies
// the parked call), and before this the transcript then held only a generic tool line, so the question
// vanished (maintainer 2026-08-30: "the questions should continue to render as they were from earlier
// in the transcript, even if they weren't answered"). Record shapes are copied from real session logs.

let seq = 0
function claudeLog(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n"
}
function call(name: string, input: unknown, id = `toolu_${++seq}`): unknown {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: `m${seq}`, content: [{ type: "tool_use", id, name, input }] },
  }
}
function result(id: string, content: string, extra: Record<string, unknown> = {}, isError?: boolean): unknown {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    ...extra,
  }
}
function allTools(messages: { tools: TranscriptToolCall[] }[]): TranscriptToolCall[] {
  return messages.flatMap((m) => m.tools)
}

const BANNER_INPUT = {
  questions: [{
    question: "Which colour should the banner be?",
    header: "Banner colour",
    multiSelect: false,
    options: [
      { label: "Red", description: "warm and loud" },
      { label: "Blue", description: "calm and cool" },
    ],
  }],
}

const WITHDRAWN =
  "This question was withdrawn before anyone answered it — most likely because the operator sent a message instead. " +
  "Read their next message and follow it."

test("an AskUserQuestion tool_use carries its structured questions onto the card", () => {
  const [ask] = allTools(projectClaudeTranscript(claudeLog([call("AskUserQuestion", BANNER_INPUT, "tu1")])))
  assert.equal(ask.status, "pending")
  assert.equal(ask.ask?.length, 1)
  assert.equal(ask.ask?.[0].question, "Which colour should the banner be?")
  assert.deepEqual(ask.ask?.[0].options.map((o) => o.label), ["Red", "Blue"])
  assert.equal(ask.detail, "Banner colour", "the header is the one-line detail")
  assert.equal(ask.askAnswers, undefined, "no result yet, no answers")
})

test("a WITHDRAWN ask keeps its questions and settles unanswered — no answers, no output pane", () => {
  const [ask] = allTools(projectClaudeTranscript(claudeLog([
    call("AskUserQuestion", BANNER_INPUT, "tu1"),
    result("tu1", WITHDRAWN, {}, true),
  ])))
  assert.equal(ask.status, "failed")
  assert.equal(ask.ask?.length, 1, "the question survives the withdrawal — that is the whole point")
  assert.equal(ask.askAnswers, undefined, "withdrawn means nobody answered")
  assert.equal(ask.output, undefined, "the withdrawal boilerplate restates what the card already says")
})

test("an ANSWERED ask lifts the structured answers, parallel to its questions", () => {
  const [ask] = allTools(projectClaudeTranscript(claudeLog([
    call("AskUserQuestion", BANNER_INPUT, "tu1"),
    result(
      "tu1",
      'Your questions have been answered: "Which colour should the banner be?"="Red". You can now continue with these answers in mind.',
      { toolUseResult: { questions: BANNER_INPUT.questions, answers: { "Which colour should the banner be?": "Red" } } },
    ),
  ])))
  assert.equal(ask.status, "completed")
  assert.deepEqual(ask.askAnswers, ["Red"])
  assert.equal(ask.output, undefined, "the prose result restates what the card already draws")
})

test("a multi-select answer arriving as an array normalizes to a joined list", () => {
  const input = {
    questions: [{
      question: "Which platforms should CI cover?",
      multiSelect: true,
      options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
    }],
  }
  const [ask] = allTools(projectClaudeTranscript(claudeLog([
    call("AskUserQuestion", input, "tu1"),
    result("tu1", "answered", {
      toolUseResult: { questions: input.questions, answers: { "Which platforms should CI cover?": ["macOS", "Windows"] } },
    }),
  ])))
  assert.deepEqual(ask.askAnswers, ["macOS, Windows"])
})

test("a misshaped ask input falls back to the generic card rather than an empty question stack", () => {
  const [generic] = allTools(projectClaudeTranscript(claudeLog([call("AskUserQuestion", { nonsense: true }, "tu1")])))
  assert.equal(generic.ask, undefined)
  assert.equal(generic.name, "AskUserQuestion")
})
