import assert from "node:assert/strict"
import test from "node:test"
import { allFencesShadowed, fenceRestatesRegistered, fenceStandsFor, markerIdsIn, placeQuestions, questionStacks, registeredStandingAt } from "./questionShadow.ts"
import { type MessageSegment, splitQuestionBlocks } from "./questionBlocks.ts"

// The pair from the 2026-08-28 report, verbatim: the registration (a plain string — the `ask` schema
// carries no markdown) and the fence the worker wrote sixteen seconds later, with `code`, a link and a
// trailing parenthetical the registration does not have.
const REGISTERED = {
  spec: {
    question: "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (z.config({ memoizer: z.memoizer() })) in the Zod Mini tab.",
    kind: "question" as const,
    options: [{ label: "Merge #6482, then cut 4.5.0", recommended: true }, { label: "Cut 4.5.0 without #6482" }, { label: "Hold the release" }],
  },
}
const FENCE = [
  "Cut 4.5.0 now? The memoizer opt-in PR [#6482](https://github.com/colinhacks/zod/pull/6482) is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab. (also on the board as a card)",
  "",
  "- A. Merge #6482 first, then bump to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
].join("\n")

test("the re-fenced release question restates its registration despite the markup and the trailing aside", () => {
  assert.equal(fenceRestatesRegistered(FENCE, [REGISTERED]), true)
})

test("the same question asked with different context around it still folds — the `?` head is the question", () => {
  const reworded = "Before anything is pushed: Cut 4.5.0 now? #6482 is still open.\n\n- A. Yes\n- B. No"
  assert.equal(fenceRestatesRegistered(reworded, [REGISTERED]), true)
})

test("a fence that only asks the registered question's opening is a prefix of it, and folds", () => {
  assert.equal(fenceRestatesRegistered("Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open\n\n- A. Yes\n- B. No", [REGISTERED]), true)
})

test("a different question at the same rest is NOT folded — the fold never hides an unseen question", () => {
  const other = "Which npm dist-tag should 4.5.0 publish under?\n\n- A. `latest` (recommended)\n- B. `next`"
  assert.equal(fenceRestatesRegistered(other, [REGISTERED]), false)
})

test("nothing folds against no registration, and a head too short to mean anything never matches", () => {
  assert.equal(fenceRestatesRegistered(FENCE, []), false)
  const short = { spec: { question: "Proceed?", kind: "question" as const } }
  assert.equal(fenceRestatesRegistered("Proceed?\n\n- A. Yes\n- B. No", [short]), false)
})

test("allFencesShadowed is true only when every fence in the text restates a registration", () => {
  const one = `Prose first.\n\n\`\`\`question\n${FENCE}\n\`\`\`\n`
  const two = `${one}\n\`\`\`question\nWhich npm dist-tag should 4.5.0 publish under?\n\n- A. latest\n- B. next\n\`\`\`\n`
  assert.equal(allFencesShadowed(one, [REGISTERED]), true)
  assert.equal(allFencesShadowed(two, [REGISTERED]), false)
  assert.equal(allFencesShadowed("No fence here at all.", [REGISTERED]), false)
  assert.equal(allFencesShadowed(one, []), false)
})

// The transcript shape of the report: a fence, two watcher wakes (user turns frizz wrote), the
// registration, then the final message with the fence again. The registration belongs to the rest the
// final message ended, so every message of THAT rest sees it — and the first fence, one rest up, does not.
const at = (min: number) => new Date(Date.UTC(2026, 7, 28, 17, min)).toISOString()
const MESSAGES = [
  { role: "user", at: at(0) },
  { role: "assistant", at: at(5) }, // the first fence
  { role: "user", at: at(6) }, // the PR watcher's wake
  { role: "assistant", at: at(9) }, // tool calls
  { role: "assistant", at: at(11) }, // the final message, fence restated
]
const QUESTION = { ...REGISTERED, id: "qst_6b9bdbe563fa", askedAt: at(10) }

test("registeredStandingAt maps every message of the asking rest to the registration, and none above it", () => {
  const map = registeredStandingAt(MESSAGES, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4])
  assert.deepEqual(map.get(4), [QUESTION])
  assert.equal(map.get(1), undefined, "the first fence is one rest up; the wake closed that rest")
})

test("a question the human replied past still stands at every later message of the worker's — not at the human's turn", () => {
  const replied = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16) }]
  const map = registeredStandingAt(replied, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4, 6])
})

test("a registration whose rest is above the loaded window stands at every loaded message of the worker's", () => {
  const map = registeredStandingAt(MESSAGES.slice(2), [{ ...QUESTION, askedAt: at(1) }])
  assert.deepEqual([...map.keys()].sort(), [1, 2])
})

// ---- PLACEMENT ----
// The worker writes the ask into the middle of its handoff; the registered card renders in that slot.

const fenced = (body: string, info = "") => `\`\`\`question${info ? ` ${info}` : ""}\n${body}\n\`\`\``
const questionSeg = (text: string, info = "") => {
  const segs = splitQuestionBlocks(fenced(text, info)).filter((s) => s.kind === "question")
  assert.equal(segs.length, 1, "the fixture must produce exactly one question segment")
  return segs[0] as Extract<MessageSegment, { kind: "question" }>
}

test("fenceStandsFor matches by the info-string id, whatever the prose says", () => {
  const seg = questionSeg("Something else entirely?\n\n- A. Yes\n- B. No", QUESTION.id)
  assert.equal(fenceStandsFor(seg, [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(seg, [{ ...QUESTION, id: "qst_000000000000" }]), undefined, "a different id names a different row")
})

test("fenceStandsFor falls back to the prose when the worker wrote no id", () => {
  assert.equal(fenceStandsFor(questionSeg(FENCE), [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(questionSeg("Which npm dist-tag?\n\n- A. latest\n- B. next"), [QUESTION]), undefined)
})


// ---- PER-QUESTION PLACEMENT (2026-09-11) ----
// An EMPTY marker naming a registered id places THAT question in its slot. Nothing else places.

const MARKER = (id: string) => `**Fixed** — nothing further to do.\n\nThe one card still open is yours to decide:\n\n${fenced("", id)}\n\nAnswer it either way and this thread is finished.`
const SECOND = { ...QUESTION, id: "qst_2222bbbb2222", askedAt: at(10) }

test("markerIdsIn reads only the EMPTY id-bearing fences, lowercased, in order", () => {
  const text = `${fenced("", "QST_AAAA")}\n\n${fenced("A real body?\n\n- A. Yes", "qst_bbbb")}\n\n${fenced("", "qst_cccc")}`
  assert.deepEqual(markerIdsIn(text), ["qst_aaaa", "qst_cccc"])
  assert.deepEqual(markerIdsIn("no fence"), [])
  assert.deepEqual(markerIdsIn(fenced(FENCE)), [], "a legacy free-form fence is not a marker")
})

test("placeQuestions puts a question in the message whose marker names it, and only that question", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? MARKER(QUESTION.id) : "prose" }))
  const { placed, placedIds } = placeQuestions(messages, [QUESTION, SECOND])
  assert.deepEqual([...placed.keys()], [4])
  assert.deepEqual(placed.get(4), [QUESTION])
  assert.deepEqual([...placedIds], [QUESTION.id], "the unnamed sibling stays at the anchor")
})

test("two markers in one message place two questions there, in registration order", () => {
  const both = `${MARKER(SECOND.id)}\n\n${fenced("", QUESTION.id)}`
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? both : "prose" }))
  const { placed } = placeQuestions(messages, [QUESTION, SECOND])
  assert.deepEqual(placed.get(4), [QUESTION, SECOND])
})

test("a handoff that names none of its registrations places nothing — the anchor still draws them", () => {
  const messages = MESSAGES.map((m) => ({ ...m, text: "Landed it. Nothing else to say." }))
  const { placed, placedIds } = placeQuestions(messages, [QUESTION])
  assert.equal(placed.size, 0)
  assert.equal(placedIds.size, 0)
})

test("a fence that RESTATES the question in prose folds but never places — placement is by id only", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? `Prose.\n\n${fenced(FENCE)}` : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

test("a marker one rest ABOVE the registration never places it", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 1 ? MARKER(QUESTION.id) : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

test("a marker in a LATER rest places the question there — the newest handoff is the one the human reads", () => {
  const later = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }]
    .map((m, i) => ("text" in m ? m : { ...m, text: i === 4 ? MARKER(QUESTION.id) : "prose" }))
  const { placed } = placeQuestions(later, [QUESTION])
  assert.deepEqual([...placed.keys()], [6])
})

test("a registration whose rest is above the loaded window is placed by a marker inside the window", () => {
  const windowed = [{ role: "user", at: at(15), text: "Well done" }, { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }]
  const { placed } = placeQuestions(windowed, [{ ...QUESTION, askedAt: at(10) }])
  assert.deepEqual([...placed.keys()], [1])
})

test("a marker in a HUMAN turn places nothing", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 2 ? MARKER(QUESTION.id) : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

// ---- THE OLDER REST'S MARKER (2026-09-13, reversed 2026-09-24) ----
// The worker asked, wrote its marker into THAT handoff, the human replied past the question without
// answering, and the worker worked on and rested again with the question still open. The card stays in
// the handoff that asked it — the later rest is about something else — and a worker that still owes the
// ask in its new handoff re-writes the marker there.

const STALE = [
  { role: "user", at: at(0), text: "Do the thing." },
  { role: "assistant", at: at(5), text: MARKER(QUESTION.id) }, // the asking rest, marker written
  { role: "user", at: at(20), text: "Here's my answer to the OTHER question." },
  { role: "assistant", at: at(25), text: "Done. The first question is still open." },
]

test("a marker from an older rest keeps placing after the thread rests again", () => {
  const { placed } = placeQuestions(STALE, [QUESTION])
  assert.deepEqual([...placed.keys()], [1])
})

test("a marker the worker re-wrote into the NEW handoff places there", () => {
  const rewritten = STALE.map((m, i) => (i === 3 ? { ...m, text: MARKER(QUESTION.id) } : m))
  const { placed } = placeQuestions(rewritten, [QUESTION])
  assert.deepEqual([...placed.keys()], [3])
})

// THE SEND FOLLOWS THE MARKER. A rest whose every card a marker placed still mounts a Send-only stack,
// and it mounts at the rest the marker sits in — never at the tail, where it would be a bare button
// under a handoff with nothing to answer.
test("questionStacks mounts the Send at the placing marker's rest, not the tail", () => {
  const stacks = questionStacks(STALE, [QUESTION], placeQuestions(STALE, [QUESTION]))
  assert.deepEqual([...stacks.entries()], [[1, { questions: [], showSend: true }]])
})

test("questionStacks folds a placed card's Send into its rest's unplaced stack", () => {
  const later = { ...QUESTION, id: "qst_later000", askedAt: at(25) }
  const messages = STALE.map((m, i) => (i === 3 ? { ...m, text: MARKER(QUESTION.id) } : m))
  const stacks = questionStacks(messages, [QUESTION, later], placeQuestions(messages, [QUESTION, later]))
  assert.deepEqual([...stacks.entries()], [[3, { questions: [later], showSend: true }]])
})
