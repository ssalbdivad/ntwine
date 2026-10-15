import { test } from "node:test"
import assert from "node:assert/strict"
import { composerTodoLine } from "./todoLine.ts"

test("a /todo opening the draft is a to-do, its task the rest, lines and all", () => {
  assert.deepEqual(composerTodoLine("  /todo fix the flaky resume test  "), { task: "fix the flaky resume test" })
  assert.deepEqual(composerTodoLine("/todo look into:\n- the resume test\n- the reaper"), { task: "look into:\n- the resume test\n- the reaper" })
  assert.deepEqual(composerTodoLine("/todo"), { task: "" }, "to-do mode with nothing written yet")
})

test("anything else is a prompt", () => {
  assert.equal(composerTodoLine("/todos are piling up"), undefined)
  assert.equal(composerTodoLine("add a /todo command"), undefined)
  assert.equal(composerTodoLine("/todo-list"), undefined)
})
