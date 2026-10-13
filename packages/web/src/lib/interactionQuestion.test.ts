import { test } from "node:test"
import assert from "node:assert/strict"
import { settledAskView } from "./interactionQuestion.ts"
import type { AskQuestion } from "@ntwine/shared"

// PRODUCER 4 — the settled native ask. The mapping this file defends: the recorded answer names its
// option by LABEL (single-select verbatim, multi-select joined ", "), an answer that names none is
// free text, and no answer at all is the unanswered state the card renders as "Not answered".

const BANNER: AskQuestion = {
  question: "Which colour should the banner be?",
  header: "Banner colour",
  options: [
    { label: "Red", description: "warm and loud" },
    { label: "Blue", description: "calm and cool" },
  ],
}

const PLATFORMS: AskQuestion = {
  question: "Which platforms should CI cover?",
  multiSelect: true,
  options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
}

test("options render numbered, with the description riding the line as a fence trade-off does", () => {
  const view = settledAskView(BANNER, null)
  assert.equal(view.question.kind, "question")
  assert.equal(view.question.contextMd, "Which colour should the banner be?")
  assert.deepEqual(view.question.options, ["1. Red — warm and loud", "2. Blue — calm and cool"])
})

test("a single-select answer matches its option by label", () => {
  const view = settledAskView(BANNER, "Red")
  assert.deepEqual(view.chosenIdxs, [0])
  assert.equal(view.text, undefined)
})

test("a multi-select answer (joined ', ') marks every named option", () => {
  const view = settledAskView(PLATFORMS, "macOS, Windows")
  assert.equal(view.question.kind, "multi")
  assert.deepEqual(view.chosenIdxs, [0, 2])
  assert.equal(view.text, undefined)
})

test("an answer that names no option is free text, never silently dropped", () => {
  const view = settledAskView(BANNER, "Make it green instead")
  assert.deepEqual(view.chosenIdxs, [])
  assert.equal(view.text, "Make it green instead")
})

test("no answer at all is the unanswered state — no picks, no text", () => {
  const view = settledAskView(BANNER, null)
  assert.deepEqual(view.chosenIdxs, [])
  assert.equal(view.text, undefined)
})
