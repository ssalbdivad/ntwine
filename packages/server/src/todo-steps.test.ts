import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanTodoSteps, createTodoStepsWriter, TODO_STEPS_MAX_CHARS } from "./todo-steps.ts"

test("NONE, or nothing, is no steps; a long answer is cut at a line", () => {
  assert.equal(cleanTodoSteps(" NONE. "), undefined)
  assert.equal(cleanTodoSteps(""), undefined)
  assert.equal(cleanTodoSteps("- Open the issue first\n"), "- Open the issue first")
  const long = Array.from({ length: 80 }, (_, i) => `- step ${i} ${"x".repeat(20)}`).join("\n")
  const cut = cleanTodoSteps(long)!
  assert.ok(cut.length <= TODO_STEPS_MAX_CHARS + 2)
  assert.match(cut, /x\n…$/u, "ends on a whole line")
})

test("the writer records what it gets, and a failing or absent model records nothing", async () => {
  const recorded: string[] = []
  const record = (slug: string, _sid: string, steps: string) => void recorded.push(`${slug}: ${steps}`)
  await createTodoStepsWriter({ complete: async () => "> Hi Mateusz, the resume bug is back.", record }).write({ slug: "a", sessionId: "s", task: "message mateusz about bug" })
  const logged: string[] = []
  await createTodoStepsWriter({ complete: async () => { throw new Error("signed out") }, record, log: (m) => void logged.push(m) }).write({ slug: "b", sessionId: "s", task: "x" })
  await createTodoStepsWriter({ record }).write({ slug: "c", sessionId: "s", task: "x" })
  assert.deepEqual(recorded, ["a: > Hi Mateusz, the resume bug is back."])
  assert.deepEqual(logged, ["first steps for b failed: signed out"])
})
