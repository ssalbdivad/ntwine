import { test } from "node:test"
import assert from "node:assert/strict"
import { projectClaudeTranscript, projectCodexTranscript } from "./transcript.ts"
import type { TranscriptToolCall } from "@ntwine/shared"

// The built-in TO-DO LIST projection. The line this file defends: a checklist is built ONLY from a call
// that carries the whole list — `TaskList`'s result, a codex `update_plan`, a legacy `TodoWrite`. Claude's
// per-task deltas (`TaskCreate`/`TaskUpdate`) get an honest title and nothing more, because reconstructing
// a list from them would mean the projector accumulating state across the transcript, which it does not do
// (maintainer 2026-07-29). The record shapes are copied from real session logs.

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
function result(id: string, content: string): unknown {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  }
}
function allTools(messages: { tools: TranscriptToolCall[] }[]): TranscriptToolCall[] {
  return messages.flatMap((m) => m.tools)
}
function rows(t: TranscriptToolCall): string[] {
  return (t.todos ?? []).map((r) => `${r.status === "completed" ? "x" : r.status === "in_progress" ? ">" : " "} ${r.text}`)
}

const RULING = "MAINTAINER RULING: \"Unconfined reads are not acceptable for this.\" So the low-IL fallback is disqualified."

test("a TaskList's RESULT is the checklist — the one to-do call that enumerates", () => {
  const [list] = allTools(projectClaudeTranscript(claudeLog([
    call("TaskList", {}, "tu1"),
    result("tu1", "#1 [pending] Confine reads on Windows\n#2 [completed] Fix the coarse network grant\n#3 [in_progress] Drop per-host on macOS"),
  ])))
  assert.deepEqual(rows(list), ["  Confine reads on Windows", "x Fix the coarse network grant", "> Drop per-host on macOS"])
  assert.equal(list.detail, undefined, "the card's headline is the client's read of the list, not a server string")
  assert.equal(list.input, undefined, "and there is no input pane — the call had no payload")
})

test("an EMPTY task list projects an empty checklist, not a missing one", () => {
  const [list] = allTools(projectClaudeTranscript(claudeLog([
    call("TaskList", {}, "tu1"),
    result("tu1", "No tasks found"),
  ])))
  assert.deepEqual(list.todos, [], "an empty array is the card saying 'empty'; undefined would demote it to a generic card")
})

test("a TaskList whose result has not landed yet carries no list, and never a fabricated one", () => {
  const [pending] = allTools(projectClaudeTranscript(claudeLog([call("TaskList", {}, "tu1")])))
  assert.equal(pending.todos, undefined)
  assert.equal(pending.status, "pending")
})

test("a TaskCreate is titled by its SUBJECT, and its description is the body — never the title", () => {
  // THE REPORTED DEFECT: `toolDetail`'s first-string-field fallback picked `description`, so a
  // paragraph-long ruling became the card's one-line title.
  const [created] = allTools(projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "Confine reads on Windows", description: RULING, activeForm: "Confining reads" }, "tu1"),
  ])))
  assert.equal(created.detail, "Confine reads on Windows")
  assert.equal(created.input, RULING, "the description moves to the expandable body")
  assert.equal(created.todos, undefined, "a create carries no list, and none is invented for it")
})

test("a TaskUpdate is titled by the CHANGE it makes, with no list reconstructed", () => {
  const tools = allTools(projectClaudeTranscript(claudeLog([
    call("TaskUpdate", { taskId: "1", status: "completed" }, "tu1"),
    call("TaskUpdate", { taskId: "8", subject: "Implement the linker union", status: "in_progress", description: RULING }, "tu2"),
    call("TaskUpdate", { taskId: "7", description: "Revisit after the merge." }, "tu3"),
    call("TaskGet", { taskId: "3" }, "tu4"),
  ])))
  // The id is the only identity these calls carry. The SUBJECT would need the list — which is exactly
  // what is no longer accumulated — so the title says what changed instead of guessing at what.
  assert.equal(tools[0].detail, "#1 → completed")
  assert.equal(tools[1].detail, "#8 Implement the linker union → in progress", "the wire value in_progress is not copy")
  assert.equal(tools[2].detail, "#7 · description", "a fields-only update names the fields it rewrote")
  assert.equal(tools[3].detail, "#3")
  assert.equal(tools[1].input, RULING)
  assert.equal(tools[2].input, "Revisit after the merge.")
  for (const t of tools) assert.equal(t.todos, undefined, `${t.name} must not carry a list`)
})

test("the legacy Claude TodoWrite ships the whole list in its INPUT, so it is a checklist", () => {
  const [write] = allTools(projectClaudeTranscript(claudeLog([
    call("TodoWrite", { todos: [
      { content: "Read the config parser", status: "completed", activeForm: "Reading" },
      { content: "Add the envFile field", status: "in_progress", activeForm: "Adding" },
      { content: "Update the docs", status: "pending", activeForm: "Updating" },
    ] }, "tu1"),
  ])))
  assert.deepEqual(rows(write), ["x Read the config parser", "> Add the envFile field", "  Update the docs"])
})

test("two consecutive lists never fold into a ×2 repeat count", () => {
  // They are two different list states; collapsing them would erase one.
  const tools = allTools(projectClaudeTranscript(claudeLog([
    call("TaskList", {}, "tu1"),
    result("tu1", "#1 [pending] Alpha"),
    call("TaskList", {}, "tu2"),
    result("tu2", "#1 [completed] Alpha"),
  ]))).filter((t) => t.todos)
  assert.equal(tools.length, 2)
  assert.deepEqual(rows(tools[0]), ["  Alpha"])
  assert.deepEqual(rows(tools[1]), ["x Alpha"])
})

// ---- codex `update_plan`: the whole plan, both protocols ----

function codexLog(payloads: unknown[]): string {
  return payloads.map((p) => JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z", type: "response_item", payload: p })).join("\n") + "\n"
}

test("a codex update_plan function_call is a checklist, with its explanation as the note", () => {
  const [plan] = allTools(projectCodexTranscript(codexLog([
    {
      type: "function_call",
      name: "update_plan",
      call_id: "call_1",
      arguments: JSON.stringify({
        explanation: "Instructions and PR context are loaded.",
        plan: [
          { step: "Read the review instructions", status: "completed" },
          { step: "Inspect the full diff", status: "in_progress" },
          { step: "Deliver ranked findings", status: "pending" },
        ],
      }),
    },
  ])))
  assert.equal(plan.name, "Todos")
  assert.deepEqual(rows(plan), ["x Read the review instructions", "> Inspect the full diff", "  Deliver ranked findings"])
  assert.equal(plan.input, "Instructions and PR context are loaded.")
})

test("a codex JS-WRAPPER update_plan is scanned out of the object literal, mixed quoting and all", () => {
  // Verbatim shape from a real rollout: a bare `step` key beside a quoted `"status"` key, so the args are
  // JavaScript and not JSON — JSON.parse cannot read them.
  const source = 'const r = await tools.update_plan({plan:[{step:"Inspect the patch","status":"completed"},{step:"Trace the lifecycle",status:"in_progress"},{step:"Report findings","status":"pending"}]});text(String(r));'
  const [plan] = allTools(projectCodexTranscript(codexLog([
    { type: "custom_tool_call", name: "exec", call_id: "call_2", input: source },
  ])))
  assert.deepEqual(rows(plan), ["x Inspect the patch", "> Trace the lifecycle", "  Report findings"])
})

test("an all-complete plan is still a checklist — the client's counter is the reading", () => {
  const [plan] = allTools(projectCodexTranscript(codexLog([
    {
      type: "function_call",
      name: "update_plan",
      call_id: "call_3",
      arguments: JSON.stringify({ plan: [{ step: "One", status: "completed" }, { step: "Two", status: "completed" }] }),
    },
  ])))
  assert.deepEqual(rows(plan), ["x One", "x Two"])
  assert.equal(plan.detail, undefined)
})
