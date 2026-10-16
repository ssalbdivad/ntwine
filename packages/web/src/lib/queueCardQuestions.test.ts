import assert from "node:assert/strict"
import test from "node:test"
import { questionAnswerMessage } from "@ntwine/shared"
import { handoffQuestionSlots } from "./queueCardQuestions.ts"

// The queue card's three places for a question while it shows the handoff (lib/queueCardQuestions.ts):
// above the human's bubble, between the answer and the newest rest, and under the newest rest. The
// positions are the drawer's readers'; these pin only how they map onto the handoff.

const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 9, min)).toISOString()
const human = (min: number, text = "Rotate the signing key.") => ({ role: "user", text, at: at(min) })
const worker = (min: number, text = "Here is where it stands.") => ({ role: "assistant", text, at: at(min) })
// An ntwine wake — a CI result, a timer — is a TURN to the anchor readers (it closes a rest) but not the
// human's: the card's bubble stays on the human's own message.
const wake = (min: number) => ({ role: "user", text: "CI finished: all checks passed.", wake: true, at: at(min) })
const question = (id: string, askedMin: number) => ({ id, askedAt: at(askedMin) })

const names = (qs: readonly { id: string }[]) => qs.map((q) => q.id)

test("a question asked two rests ago stays at its rest, and the bare rest after it is not its sign-off", () => {
  // The task, a rest that asked, a CI wake, and a bare rest that says nothing about the question.
  const messages = [human(0), worker(1), wake(2), worker(3, "CI is green; nothing else changed.")]
  const slots = handoffQuestionSlots(messages, [question("qst_old", 1)], [])
  assert.deepEqual(names(slots.between), ["qst_old"], "drawn under the rest that asked it")
  assert.deepEqual(names(slots.tail), [], "never pulled under the newest rest")
})

test("a question the newest rest asked is its sign-off, under the handoff", () => {
  const messages = [human(0), worker(1), wake(2), worker(3)]
  const slots = handoffQuestionSlots(messages, [question("qst_new", 3)], [])
  assert.deepEqual(names(slots.tail), ["qst_new"])
})

test("a later fence that names the question under `questions:` brings it to that rest", () => {
  const claim = "Still need this one.\n\n```awaiting\nquestions: [qst_old]\n---\nWaiting on your call.\n```"
  const messages = [human(0), worker(1), wake(2), worker(3, claim)]
  const slots = handoffQuestionSlots(messages, [question("qst_old", 1)], [])
  assert.deepEqual(names(slots.tail), ["qst_old"])
})

test("a question from before the human's last turn flushes above the bubble, as upstream's window flushes it", () => {
  // Asked, then a human turn, then the worker rested again. (The card passes only held questions since
  // 2026-10-14, so in the product this is one asked before an answer to another card; the slotting is the same.)
  const messages = [human(0), worker(1), human(2, "Do the other thing first."), worker(3)]
  const slots = handoffQuestionSlots(messages, [question("qst_before", 1)], [])
  assert.deepEqual(names(slots.above), ["qst_before"])
  assert.deepEqual(names(slots.tail), [])
})

test("the human's turn is THEIR turn: an answer delivered as a wake is one, a plain wake is not", () => {
  // The registered answer ntwine delivers counts as the human's turn (lastHumanTurnIndex), so a question
  // asked before it is above the bubble; the CI wake after it is not, so one asked between is BETWEEN.
  const answer = { role: "user", text: questionAnswerMessage([{ questionId: "qst_x", question: "Which key?", chosen: ["The new one"] }]), wake: true, at: at(2) }
  const messages = [human(0), worker(1), answer, worker(3), wake(4), worker(5)]
  const slots = handoffQuestionSlots(messages, [question("qst_before", 1), question("qst_mid", 3)], [])
  assert.deepEqual(names(slots.above), ["qst_before"])
  assert.deepEqual(names(slots.between), ["qst_mid"])
})

test("a placement marker decides the rest, and a marker above the bubble gives the card back to its anchor", () => {
  const marker = (id: string) => `Before you pick:\n\n\`\`\`question ${id}\n\`\`\`\n\nEither way I re-run the suite.`
  // Asked at the first rest, placed again by a marker in the NEWEST rest's handoff: it moves there.
  const moved = handoffQuestionSlots([human(0), worker(1), wake(2), worker(3, marker("qst_aaaa1111"))], [question("qst_aaaa1111", 1)], [])
  assert.deepEqual(names(moved.tail), ["qst_aaaa1111"])
  // Placed in a message ABOVE the human's last turn, which this card does not draw (placedFrom).
  const above = handoffQuestionSlots([human(0), worker(1, marker("qst_bbbb2222")), human(2, "Next."), worker(3)], [question("qst_bbbb2222", 1)], [])
  assert.deepEqual(names(above.above), ["qst_bbbb2222"], "back at its anchor, above the bubble, not lost")
})

test("several rests' questions in one place read in transcript order", () => {
  const messages = [human(0), worker(1), wake(2), worker(3), wake(4), worker(5)]
  const slots = handoffQuestionSlots(messages, [question("qst_second", 3), question("qst_first", 1)], [])
  assert.deepEqual(names(slots.between), ["qst_first", "qst_second"])
})

test("an answered question stays at its rest, and is never hoisted above the bubble", () => {
  const messages = [human(0), worker(1), wake(2), worker(3)]
  const settled = (id: string, askedMin: number, settledMin: number) => ({ id, askedAt: at(askedMin), settledAt: at(settledMin) })
  const slots = handoffQuestionSlots(messages, [], [settled("qst_mid", 1, 2), settled("qst_now", 3, 4), settled("qst_old", -2, 4)])
  assert.deepEqual(names(slots.settledBetween), ["qst_mid"])
  assert.deepEqual(names(slots.settledTail), ["qst_now"])
  assert.equal(slots.above.length + slots.between.length + slots.tail.length, 0)
})

test("with no transcript to read, every question stays under the newest rest, as the card drew it before", () => {
  const slots = handoffQuestionSlots([], [question("qst_a", 1), question("qst_b", 2)], [])
  assert.deepEqual(names(slots.tail), ["qst_a", "qst_b"])
})
