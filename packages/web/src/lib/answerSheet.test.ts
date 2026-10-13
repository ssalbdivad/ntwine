import { test } from "node:test"
import assert from "node:assert/strict"
import type { RegisteredQuestionView } from "@ntwine/shared"
import type { BlockAnswer } from "./questionBlocks.ts"
import { ROOT_PATH, childPath } from "./registeredQuestion.ts"
import { SECRET_MASK, answerSteps, answerSummary, firstOpenStep, oneLineDescription, stepAfter, stepAfterPick, stepKey } from "./answerSheet.ts"

const blank: BlockAnswer = { chosen: null, chosenSet: [], text: "" }
const pick = (i: number): BlockAnswer => ({ chosen: i, chosenSet: [], text: "" })

const view = (id: string, spec: RegisteredQuestionView["spec"]): RegisteredQuestionView =>
  ({ id, spec, askedAt: "2026-09-30T00:00:00.000Z" }) as RegisteredQuestionView

const STORE = view("q1", {
  question: "Where should the settings live?",
  kind: "question",
  options: [
    { label: "SQLite", recommended: true, followUps: [{ question: "Which driver?", kind: "question", options: [{ label: "better-sqlite3" }, { label: "node:sqlite" }] }] },
    { label: "A JSON file" },
  ],
})
const POST = view("q2", { question: "Post the reply?", kind: "question", options: [{ label: "Post it" }, { label: "Leave it a draft" }] })

const staged = (entries: Record<string, Record<string, BlockAnswer>>) => (q: RegisteredQuestionView) =>
  new Map(Object.entries(entries[q.id] ?? {}))

test("one step per root until a pick opens a branch", () => {
  const steps = answerSteps([STORE, POST], staged({}))
  assert.deepEqual(steps.map((s) => s.key), [stepKey("q1", ROOT_PATH), stepKey("q2", ROOT_PATH)])
})

test("the follow-up a pick opens is the very next step, and leaves again with the pick", () => {
  const withSqlite = answerSteps([STORE, POST], staged({ q1: { [ROOT_PATH]: pick(0) } }))
  assert.deepEqual(withSqlite.map((s) => s.key), [stepKey("q1", ROOT_PATH), stepKey("q1", childPath(ROOT_PATH, 0, 0)), stepKey("q2", ROOT_PATH)])
  assert.equal(withSqlite[1].depth, 2)
  const withJson = answerSteps([STORE, POST], staged({ q1: { [ROOT_PATH]: pick(1) } }))
  assert.deepEqual(withJson.map((s) => s.key), [stepKey("q1", ROOT_PATH), stepKey("q2", ROOT_PATH)])
})

test("stepAfterPick reads the list the pick is ABOUT to produce, not the one on screen", () => {
  const nothing = staged({})
  const root = answerSteps([STORE, POST], nothing)[0]
  // SQLite opens its follow-up, so the tap lands there even though the current list has no such step.
  assert.equal(stepAfterPick([STORE, POST], nothing, root, 0), stepKey("q1", childPath(ROOT_PATH, 0, 0)))
  // A JSON file opens nothing: straight on to the second question.
  assert.equal(stepAfterPick([STORE, POST], nothing, root, 1), stepKey("q2", ROOT_PATH))
  // The last question's pick goes to the review.
  const last = answerSteps([STORE, POST], nothing)[1]
  assert.equal(stepAfterPick([STORE, POST], nothing, last, 0), null)
})

test("stepAfter lands on the review for the last step and for a key whose branch closed", () => {
  const steps = answerSteps([POST], staged({}))
  assert.equal(stepAfter(steps, steps[0].key), null)
  assert.equal(stepAfter(steps, "gone|root"), null)
})

test("the sheet reopens on the first unanswered step, or on the review when every step is answered", () => {
  const answers = staged({ q1: { [ROOT_PATH]: pick(1) } })
  const steps = answerSteps([STORE, POST], answers)
  assert.equal(firstOpenStep(steps, answers), stepKey("q2", ROOT_PATH))
  const all = staged({ q1: { [ROOT_PATH]: pick(1) }, q2: { [ROOT_PATH]: pick(0) } })
  assert.equal(firstOpenStep(answerSteps([STORE, POST], all), all), null)
})

test("the review row says what the payload will carry", () => {
  const single = STORE.spec
  assert.equal(answerSummary(single, blank), null)
  assert.equal(answerSummary(single, pick(1)), "A JSON file")
  // A chip wins over text left beside it (registeredAnswer drops that text too).
  assert.equal(answerSummary(single, { chosen: 0, chosenSet: [], text: "draft" }), "SQLite")
  assert.equal(answerSummary(single, { chosen: null, chosenSet: [], text: "  Postgres " }), "Postgres")
  const multi = { question: "Which gates?", kind: "multi" as const, options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }] }
  assert.equal(answerSummary(multi, { chosen: null, chosenSet: [2, 0], text: "" }), "Lint, Tests")
  assert.equal(answerSummary(multi, { chosen: null, chosenSet: [1], text: "and e2e" }), "Types — and e2e")
  const free = { question: "What should the note say?", kind: "question" as const }
  assert.equal(answerSummary(free, { chosen: null, chosenSet: [], text: "Ship it" }), "Ship it")
})

test("only a one-line description is a muted line; a multi-line one is the option's body", () => {
  assert.equal(oneLineDescription(" Round half to even. "), "Round half to even.")
  assert.equal(oneLineDescription("- one\n- two"), undefined)
  assert.equal(oneLineDescription(undefined), undefined)
})

test("a SECRET's review row says it is filled and never what it is", () => {
  const spec = { question: "The npm one-time code.", kind: "question" as const, secret: true }
  assert.equal(answerSummary(spec, { ...blank, text: "493817" }), SECRET_MASK)
  assert.equal(answerSummary(spec, blank), null, "an empty secret is still Skipped")
})
