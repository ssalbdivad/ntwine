import { test } from "node:test"
import assert from "node:assert/strict"
import { createTodoStepsWriter, parseTodoStarters } from "./todo-steps.ts"

test("starters parse from a fenced or chatty answer, keep three, and drop malformed items", () => {
  const raw = [
    "```json",
    JSON.stringify([
      { label: "Draft the reply to Mateusz.", prompt: "Draft it." },
      { label: "", prompt: "no label" },
      { label: "Find the failing test", prompt: 3 },
      { label: "Find 10 roles", prompt: "Search." },
      { label: "Read the resume", prompt: "Read it." },
      { label: "A fourth", prompt: "Too many." },
    ]),
    "```",
  ].join("\n")
  assert.deepEqual(parseTodoStarters(raw), [
    { label: "Draft the reply to Mateusz", prompt: "Draft it." },
    { label: "Find 10 roles", prompt: "Search." },
    { label: "Read the resume", prompt: "Read it." },
  ])
})

test("an empty array, prose, or a legacy Markdown row is no starters", () => {
  assert.equal(parseTodoStarters("[]"), undefined)
  assert.equal(parseTodoStarters("NONE"), undefined)
  assert.equal(parseTodoStarters("- Open [the issue](https://x.y) first"), undefined)
})

test("the writer records starters as JSON, and a failing or absent model records nothing", async () => {
  const recorded: string[] = []
  const record = (slug: string, _sid: string, steps: string) => void recorded.push(`${slug}: ${steps}`)
  await createTodoStepsWriter({ complete: async () => '[{"label":"Draft it","prompt":"Draft the note."}]', record }).write({ slug: "a", sessionId: "s", task: "message mateusz about bug" })
  const logged: string[] = []
  await createTodoStepsWriter({ complete: async () => { throw new Error("signed out") }, record, log: (m) => void logged.push(m) }).write({ slug: "b", sessionId: "s", task: "x" })
  await createTodoStepsWriter({ record }).write({ slug: "c", sessionId: "s", task: "x" })
  assert.deepEqual(recorded, ['a: [{"label":"Draft it","prompt":"Draft the note."}]'])
  assert.deepEqual(logged, ["starters for b failed: signed out"])
})
