import { test } from "node:test"
import assert from "node:assert/strict"
import { applyRecord, newTailState } from "./tailer.ts"

// A completion report is only THIS session's to repair if THIS session launched the op.
//
// The runtime writes the `queue-operation` bookkeeping for every background op into the ROOT
// transcript — a sub-agent's included — and the record names no owner. A descendant's op is delivered
// into the DESCENDANT's transcript, which this TailState never reads, so from here it looks queued and
// never delivered: byte-for-byte the signature of the runtime drop the repair exists to fix. Without an
// owner test ntwine injected other agents' completions into this one, telling it that work it never
// started was lost. Measured over four real threads, 66% of the completed background-op notifications
// in a parent transcript belong to a descendant, and on the one thread where the repair was live all
// 283 of its relays were for ops that session never launched.

const AT = "2026-08-06T00:00:00.000Z"

function launch(toolUseId: string, name = "Bash") {
  return {
    type: "assistant",
    timestamp: AT,
    message: { id: `m-${toolUseId}`, content: [{ type: "tool_use", id: toolUseId, name, input: { command: "sleep 60", run_in_background: true, description: "a long op" } }] },
  }
}

function completion(taskId: string, toolUseId?: string, summary = `Background command "a long op" completed (exit code 0)`) {
  const tu = toolUseId ? `\n<tool-use-id>${toolUseId}</tool-use-id>` : ""
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: AT,
    content: `<task-notification>\n<task-id>${taskId}</task-id>${tu}\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
  }
}

function fold(records: object[]) {
  const state = newTailState("t", "sid", "/x")
  for (const rec of records) applyRecord(state, rec as never)
  return state
}

test("a completion for an op THIS session launched is still parked for repair", () => {
  const state = fold([launch("toolu_mine"), completion("bmine01", "toolu_mine")])
  assert.deepEqual([...state.queuedReports.keys()], ["bmine01"], "the genuine dropped report must survive the gate")
})

test("a completion for a SUB-AGENT's background op is not this session's to repair", () => {
  // No dispatch record: the child's `Bash` tool_use lives in the child's own transcript, which this
  // TailState never reads. Only the runtime's root-level bookkeeping reaches us.
  const state = fold([launch("toolu_mine"), completion("bchild01", "toolu_inside_the_child")])
  assert.deepEqual([...state.queuedReports.keys()], [], "a descendant's completion must never be parked here")
})

test("a foreign report parked by an earlier build is dropped the next time it is seen", () => {
  const state = fold([launch("toolu_mine")])
  state.queuedReports.set("bchild01", { taskId: "bchild01", kind: "shell", chars: 0 })
  applyRecord(state, completion("bchild01", "toolu_inside_the_child") as never)
  assert.equal(state.queuedReports.has("bchild01"), false, "the gate self-heals rather than waiting for a re-fold")
})

test("a notification with NO tool-use-id is treated as ours — that is the orphan-recovery shape", () => {
  const state = fold([completion("brecovered", undefined, `Background command "an orphan" completed (exit code 0)`)])
  assert.deepEqual([...state.queuedReports.keys()], ["brecovered"], "a session's own orphan recovery carries no per-op tool call")
})

test("ownership is recorded for the ops that can notify, whatever the dispatch branch decided to show", () => {
  // A foreground Agent is skipped by the dispatch tracker (it shows as a spinner, not a row) and an
  // auto-backgrounded Bash arrives with no `run_in_background` at all — both are still OURS.
  const fg = { type: "assistant", timestamp: AT, message: { id: "m1", content: [{ type: "tool_use", id: "toolu_fg_agent", name: "Agent", input: { run_in_background: false, description: "blocking child" } }] } }
  const auto = { type: "assistant", timestamp: AT, message: { id: "m2", content: [{ type: "tool_use", id: "toolu_auto", name: "Bash", input: { command: "slow" } }] } }
  const state = fold([fg, auto, completion("bfg", "toolu_fg_agent", `Agent "blocking child" finished`), completion("bauto", "toolu_auto")])
  assert.deepEqual([...state.queuedReports.keys()].sort(), ["bauto", "bfg"])
})
