// THE TWO TEXTS NTWINE ADDS NOW THAT ANSWERS ARRIVE A QUESTION AT A TIME (2026-09-29): the answers fold,
// which puts several answer deliveries back into the ONE shape the chat reads as the human's own turn,
// and the open-questions note, which a typed message carries to a worker that still has questions open.
// Both ride the human's own words, so each is pinned against the reader that must not see ntwine in them.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  threadQuestionDefaults,
  ANSWER_CONTINUATION_INDENT,
  DEFAULTED_ANSWER_NOTE,
  DEFAULTED_FALLBACK_NOTE,
  QUESTION_DEFAULT_AFTER_MS,
  QUESTION_DEFAULT_ENGAGED_GRACE_MS,
  questionDefaultAtMs,
  recommendedDefaultAnswer,
  BURIED_ANSWERS_HEADER,
  humanGapNote,
  mergeAnswerMessages,
  openQuestionsNote,
  questionAnswerMessage,
  questionsCancelledWakeMessage,
  stripFollowUpRiders,
  stripOpenQuestionsNote,
  wakeTimeHeader,
  withAnswersNote,
  splitAnswersNote,
  ANSWERS_NOTE_HEADER,
} from "./index.ts"

const stamped = (message: string) => `${message}\n\n${wakeTimeHeader(Date.parse("2026-09-29T15:00:00.000Z"))}`

test("answer deliveries fold into ONE header with every row renumbered, and a typed numbered list cannot forge a row", () => {
  const first = stamped(questionAnswerMessage([{ questionId: "q1", question: "Which store?", chosen: ["SQLite"], text: "Do these:\n1. run x\n2. run y" }]))
  const second = stamped(questionAnswerMessage(
    [{ questionId: "q2", question: "Publish?", chosen: ["Yes"], followUps: [{ questionId: "q2", question: "Which tag?", chosen: ["next"] }] }],
    [{ question: "Rename it?" }],
  ))
  const merged = mergeAnswerMessages([first, second])!
  assert.equal(merged, [
    BURIED_ANSWERS_HEADER,
    "1. “Which store?” → - [x] SQLite",
    ANSWER_CONTINUATION_INDENT,
    `${ANSWER_CONTINUATION_INDENT}Do these:`,
    `${ANSWER_CONTINUATION_INDENT}1. run x`,
    `${ANSWER_CONTINUATION_INDENT}2. run y`,
    "2. “Publish?” → Yes",
    "3. ⤷ “Which tag?” → next",
    "4. “Rename it?” → (dismissed — decide it yourself; do not re-ask)",
  ].join("\n"))
  assert.doesNotMatch(merged, /⏱/, "the parts' clocks come off; the caller stamps one")
  // The negative control for the fold itself: a cancellation is ntwine's own voice and never merges into
  // the human's answers.
  assert.equal(mergeAnswerMessages([first, stamped(questionsCancelledWakeMessage(2))]), undefined)
})

// A part sent with the prompt box's note (withAnswersNote) ends its rows at the note header, so a fold that
// left the note in place would read the NEXT part's rows as more of the note. Every note goes after every row.
test("answer deliveries carrying a typed note fold with all the rows first and the notes under one header", () => {
  const noted = stamped(withAnswersNote(questionAnswerMessage([{ questionId: "q1", question: "Which store?", chosen: ["SQLite"] }]), "keep it small"))
  const plain = stamped(questionAnswerMessage([{ questionId: "q2", question: "Publish?", chosen: ["Yes"] }]))
  const merged = mergeAnswerMessages([noted, plain])!
  assert.equal(merged, [
    BURIED_ANSWERS_HEADER,
    "1. “Which store?” → SQLite",
    "2. “Publish?” → Yes",
    "",
    ANSWERS_NOTE_HEADER,
    "keep it small",
  ].join("\n"))
  assert.deepEqual(splitAnswersNote(merged), { answers: `${BURIED_ANSWERS_HEADER}\n1. “Which store?” → SQLite\n2. “Publish?” → Yes`, note: "keep it small" })
})

test("the open-questions note names each question by text and id, and comes back off the human's bubble", () => {
  assert.equal(openQuestionsNote([]), undefined, "nothing open, nothing said")
  const note = openQuestionsNote([
    { id: "qst_aaaaaaaaaaaa", question: "Should the settings store use\nSQLite or a JSON file?" },
    { id: "qst_bbbbbbbbbbbb", question: "x".repeat(140) },
  ])!
  assert.doesNotMatch(note, /\n/, "one line, so the stripper can anchor on it")
  assert.match(note, /^❓ ntwine: 2 questions you registered are still open: “Should the settings store use SQLite or a JSON file\?” \(qst_aaaaaaaaaaaa\), “x{99}…” \(qst_bbbbbbbbbbbb\)\./)
  // A typed message leaves them open, and the next rest names each one still needed or withdraws it.
  // One the message moved past is withdrawn at once, not at the next rest: a stale card otherwise sits
  // open above the new work, holding the thread as waiting on the human (2026-10-13).
  assert.match(note, /If it moves past one — a new direction, a different priority — `unask` that one NOW, before any other work/)
  assert.match(note, /Name each one still needed under `questions:` when you rest\.$/)
  assert.doesNotMatch(note, /set aside|`keep`/)
  assert.match(openQuestionsNote([{ id: "qst_1", question: "Merge it?" }])!, /^❓ ntwine: 1 question you registered is still open: “Merge it\?” \(qst_1\)\./)

  // ROUND TRIP, as the router appends it — after the gap note, so "the message above" stays the human's.
  const gap = humanGapNote(Date.parse("2026-09-29T15:00:00.000Z"), "2026-09-29T11:00:00.000Z")!
  assert.equal(stripOpenQuestionsNote(`should we use this thread or the other one?\n\n${note}`), "should we use this thread or the other one?")
  assert.equal(stripFollowUpRiders(`one\n\ntwo\n\n${gap}\n\n${note}`), "one\n\ntwo")
  // AND NOTHING ELSE: prose quoting the note keeps it.
  const quoting = `why does "${note}" show up here?`
  assert.equal(stripOpenQuestionsNote(quoting), quoting)
  assert.equal(stripOpenQuestionsNote("ship it"), "ship it")
  // A transcript written under the 2026-09-29 wording keeps coming back off the bubble too.
  const tenThirteen = "❓ ntwine: 1 question you registered is still open: “Merge it?” (qst_1). The message above leaves them open. When you next rest, name each one you still need under `questions:` in your ```awaiting fence, and withdraw the rest with `unask`."
  assert.equal(stripOpenQuestionsNote(`ok\n\n${tenThirteen}`), "ok")
  const older = "❓ ntwine: 1 question you registered is still open: “Merge it?” (qst_1). If the message above made any of them moot, `unask` exactly those and say so; leave the rest open — they are still the human's to answer, and still your sign-off."
  assert.equal(stripOpenQuestionsNote(`ship it\n\n${older}`), "ship it")
  // …and the two set-aside wordings: 2026-10-02 (withdrawn at the next rest unless kept)…
  const oct02 = "❓ ntwine: 1 question you registered is now set aside by this message: “Merge it?” (qst_1). They no longer hold this thread, and ntwine WITHDRAWS every one still set aside when you next come to rest. `keep` one only if it is directly relevant to the message above — reworded with `question` if the direction changed — and it rides to the bottom of your next handoff; let the rest go. If the work later needs one of them, ask a new question then."
  assert.equal(stripOpenQuestionsNote(`ship it\n\n${oct02}`), "ship it")
  // …and 2026-09-30, when a set-aside card stayed answerable indefinitely.
  const sept30 = "❓ ntwine: 1 question you registered is now set aside by this message: “Merge it?” (qst_1). Their cards stay answerable where they were asked, but no longer hold this thread. If the message above did not move past one, `keep` it — reworded with `question` if the direction changed — and it rides to the bottom of your next handoff; otherwise leave it."
  assert.equal(stripOpenQuestionsNote(`ship it\n\n${sept30}`), "ship it")
})

// THE DEFAULT (2026-10-05): one deadline reading, shared by the scheduler that acts on it and the board
// that counts down to it.
test("questionDefaultAtMs: starts at the later of ask and rest; engagement extends it; the x and a working thread clear it", () => {
  const q = { asked_at: 1_000, engaged_at: null, default_off: 0 }
  assert.equal(questionDefaultAtMs(q, undefined), undefined, "no countdown while the thread works")
  assert.equal(questionDefaultAtMs(q, 5_000), 5_000 + QUESTION_DEFAULT_AFTER_MS)
  assert.equal(questionDefaultAtMs({ ...q, asked_at: 9_000 }, 5_000), 9_000 + QUESTION_DEFAULT_AFTER_MS, "asked after the rest: from the ask")
  const late = 5_000 + QUESTION_DEFAULT_AFTER_MS - 1
  assert.equal(questionDefaultAtMs({ ...q, engaged_at: late }, 5_000), late + QUESTION_DEFAULT_ENGAGED_GRACE_MS)
  assert.equal(questionDefaultAtMs({ ...q, engaged_at: 2_000 }, 5_000), 5_000 + QUESTION_DEFAULT_AFTER_MS, "an early touch never shortens it")
  assert.equal(questionDefaultAtMs({ ...q, default_off: 1 }, 5_000), undefined)
})

test("recommendedDefaultAnswer: takes the single recommendation, its follow-ups' too, and nothing on danger, unmarked, multi or free text", () => {
  const spec = { question: "Q", kind: "question" as const, mayDefault: true, options: [{ label: "A" }, { label: "B", recommended: true, followUps: [
    { question: "F1", kind: "question" as const, options: [{ label: "x", recommended: true }] },
    { question: "F2", kind: "question" as const },
  ] }] }
  assert.deepEqual(recommendedDefaultAnswer("qst_1", spec), {
    questionId: "qst_1", question: "Q", chosen: ["B"], text: DEFAULTED_ANSWER_NOTE,
    followUps: [{ questionId: "qst_1", question: "F1", chosen: ["x"] }, { questionId: "qst_1", question: "F2", chosen: [] }],
  })
  assert.equal(recommendedDefaultAnswer("q", { ...spec, danger: true }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { ...spec, mayDefault: undefined }), undefined, "a question waits unless the worker opts in")
  assert.equal(recommendedDefaultAnswer("q", { ...spec, kind: "multi" }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { question: "Q", kind: "question" }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { question: "Q", kind: "question", options: [{ label: "A" }] }), undefined)
})

test("recommendedDefaultAnswer: never takes an external option — falls back to the first local one, or waits", () => {
  const spec = { question: "File the repro upstream?", kind: "question" as const, mayDefault: true, options: [
    { label: "File it", recommended: true, external: true },
    { label: "Post a comment instead", external: true },
    { label: "Keep it in the handoff" },
    { label: "Drop it" },
  ] }
  assert.deepEqual(recommendedDefaultAnswer("q", spec), {
    questionId: "q", question: spec.question, chosen: ["Keep it in the handoff"], text: DEFAULTED_FALLBACK_NOTE,
  })
  const allExternal = { ...spec, options: spec.options.slice(0, 2) }
  assert.equal(recommendedDefaultAnswer("q", allExternal), undefined, "nothing local to take: it waits for the human")
  // A follow-up under the taken option follows the same rule, and goes out blank when all of it is external.
  const nested = { question: "Q", kind: "question" as const, mayDefault: true, options: [{ label: "A", recommended: true, followUps: [
    { question: "F1", kind: "question" as const, options: [{ label: "push", recommended: true, external: true }, { label: "local" }] },
    { question: "F2", kind: "question" as const, options: [{ label: "publish", recommended: true, external: true }] },
  ] }] }
  assert.deepEqual(recommendedDefaultAnswer("q", nested)?.followUps, [
    { questionId: "q", question: "F1", chosen: ["local"] },
    { questionId: "q", question: "F2", chosen: [] },
  ])
})

test("threadQuestionDefaults: a thread's questions default together on the latest deadline, or not at all", () => {
  const rec = (label: string) => ({ question: label, kind: "question" as const, mayDefault: true, options: [{ label: "yes", recommended: true }, { label: "no" }] })
  const a = { id: "a", asked_at: 1_000, spec: rec("A") }
  const b = { id: "b", asked_at: 1_000, engaged_at: 9_000_000, spec: rec("B") }
  const free = { id: "f", asked_at: 1_000, spec: { question: "Name?", kind: "question" as const } }
  const both = threadQuestionDefaults([a, b, free], 5_000, undefined)
  assert.deepEqual([...both!.answers.keys()], ["a", "b"], "free text has nothing to take and holds nobody")
  assert.equal(both!.atMs, 9_000_000 + QUESTION_DEFAULT_ENGAGED_GRACE_MS, "touching one card holds the group")
  assert.equal(threadQuestionDefaults([a, { ...b, spec: { ...b.spec, mayDefault: undefined } }], 5_000, undefined), undefined)
  assert.equal(threadQuestionDefaults([a, { ...b, spec: { ...b.spec, danger: true } }], 5_000, undefined), undefined)
  assert.equal(threadQuestionDefaults([a, { ...b, default_off: 1 }], 5_000, undefined), undefined, "one × turns off the group")
  assert.equal(threadQuestionDefaults([a, b], undefined, undefined), undefined, "a working thread defaults nothing")
  assert.equal(threadQuestionDefaults([a], 5_000, new Date(2_000).toISOString()), undefined, "typed past: waits for the human")
})

test("questionAnswerMessage: a question skipped beside its group's answers tells the worker it may ask again", () => {
  const message = questionAnswerMessage([
    { questionId: "a", question: "Which store?", chosen: [], text: "SQLite" },
    { questionId: "b", question: "Which key format?", chosen: [], skipped: true },
  ])
  assert.match(message, /^2\. “Which key format\?” → \(skipped for now — ask again if it still matters\)$/m)
})
