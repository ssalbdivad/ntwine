import assert from "node:assert/strict"
import test from "node:test"
import type { AskedQuestion } from "@frizz/shared"
import { DraftStore, draftKey } from "./drafts.ts"
import { decodeQuestionPick, encodeQuestionPick, questionSpecAt } from "./registeredPicks.ts"
import { registeredAnswer, liveQuestionNodes } from "./registeredQuestion.ts"

const spec: AskedQuestion = {
  kind: "question", question: "Land the fix?",
  options: [
    { label: "Land it", followUps: [{ kind: "multi", question: "Which gates?", options: [{ label: "Tests" }, { label: "Browser" }] }] },
    { label: "Hold it" },
  ],
}

test("picks hydrate by registration identity, separate from display numbers, text and other projects", () => {
  let raw: string | null = null
  const storage = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } }
  const first = new DraftStore(storage)
  const key = draftKey.question("/one", "same-thread", "qst_one", "root")
  const picks = draftKey.questionPick("/one", "same-thread", "qst_one", "root")
  first.set(picks, encodeQuestionPick(spec, { chosen: 1, chosenSet: [] }))
  first.set(key, "an unselected typed draft")
  const remount = new DraftStore(storage)
  assert.deepEqual(decodeQuestionPick(spec, remount.get(picks)), { chosen: 1, chosenSet: [] })
  assert.equal(remount.get(key), "an unselected typed draft")
  assert.equal(remount.get(draftKey.questionPick("/two", "same-thread", "qst_one", "root")), "")
  assert.equal(remount.get(draftKey.questionPick("/one", "same-thread", "qst_two", "root")), "")
  assert.deepEqual(JSON.parse(remount.get(picks)).chosen, { index: 1, label: "Hold it" }, "persist the immutable option slot, not a keycap")
  assert.deepEqual(decodeQuestionPick({ ...spec, options: [...spec.options!].reverse() }, remount.get(picks)), { chosen: null, chosenSet: [] })
  remount.clear(picks)
  assert.equal(new DraftStore(storage).get(picks), "")
})

test("a restored branch and multi picks build the same payload; inactive branches stay out", () => {
  const child = questionSpecAt(spec, "root/0.0")!
  const rootPick = decodeQuestionPick(spec, encodeQuestionPick(spec, { chosen: 0, chosenSet: [] }))
  const childPick = decodeQuestionPick(child, encodeQuestionPick(child, { chosen: null, chosenSet: [1, 0] }))
  const answers = new Map([
    ["root", { ...rootPick, text: "" }],
    ["root/0.0", { ...childPick, text: "and typecheck" }],
  ])
  const q = { id: "qst_one", askedAt: "2026-10-09T00:00:00Z", spec }
  assert.deepEqual(liveQuestionNodes(spec, answers).map((node) => node.path), ["root", "root/0.0"])
  assert.deepEqual(registeredAnswer(q, answers)?.followUps?.[0].chosen, ["Tests", "Browser"])
  answers.set("root", { chosen: 1, chosenSet: [], text: "" })
  assert.equal(registeredAnswer(q, answers)?.followUps, undefined)
  assert.equal(questionSpecAt(spec, "root/0.9"), undefined)
  assert.equal(questionSpecAt(spec, "wrong"), undefined)
})

test("empty, stale and corrupt saved picks never choose an unrelated option", () => {
  for (const raw of ["", "{", "null", "[]", '{"chosen":3,"chosenSet":[]}', '{"chosen":null,"chosenSet":[1]}', '{"chosen":"Gone","chosenSet":[]}',
    ...[-1, 0.5, 99].map((index) => JSON.stringify({ chosen: { index, label: "Land it" }, chosenSet: [] })),
    JSON.stringify({ chosen: { index: 0, label: "Gone" }, chosenSet: [] }),
  ]) {
    assert.deepEqual(decodeQuestionPick(spec, raw), { chosen: null, chosenSet: [] })
  }
  assert.equal(encodeQuestionPick(spec, { chosen: null, chosenSet: [] }), "")
})

test("duplicate option labels retain separate single, multi and follow-up identities", () => {
  const duplicate: AskedQuestion = { kind: "question", question: "Which branch?", options: [
    { label: "Yes", followUps: [{ kind: "question", question: "First branch" }] },
    { label: "Yes", followUps: [{ kind: "question", question: "Second branch" }] },
  ] }
  const restore = (q: AskedQuestion, chosen: number | null, chosenSet: number[]) =>
    decodeQuestionPick(q, encodeQuestionPick(q, { chosen, chosenSet }))
  const second = restore(duplicate, 1, [])
  assert.deepEqual(second, { chosen: 1, chosenSet: [] })
  assert.deepEqual(liveQuestionNodes(duplicate, new Map([["root", { ...second, text: "" }]])).map(n => n.path), ["root", "root/1.0"])
  assert.deepEqual(restore(duplicate, null, []), { chosen: null, chosenSet: [] }, "a repeated click can toggle the second off")
  const multi = { ...duplicate, kind: "multi" as const }
  for (const indices of [[0], [1], [0, 1], []]) {
    assert.deepEqual(restore(multi, null, indices), { chosen: null, chosenSet: indices })
  }
})
