import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

// A ```question fence restating or naming a question REGISTERED at that rest or an earlier one is folded
// into the registered card (lib/questionShadow) — the 2026-08-28 "same question showing up twice in a row". The fold is a
// prop on Message, so it works only where the transcript hands it over: these pin that every surface
// that renders an answerable message does, and that a folded fence leaves no Send behind it.

test("every answerable Message site hands the registered questions at its rest to the fold", () => {
  // Thread page: the plain path (keyed by `messageIndex`) and the virtualized path (`row.messageIndex`).
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
})

test("the map is built off the same messages and questions the anchors use, on both transcript paths", () => {
  // `openQuestions` is the board's open list minus the ids already drawn settled (openQuestionsOf) — the
  // same list the placement and the anchors read on each surface.
  const build = /registeredStandingAt\(messages, openQuestions\), \[messages, openQuestions\]\)/g
  assert.equal((chat.match(build) ?? []).length, 2, "one per ChatView transcript path")
})

test("a folded fence leaves no Send button behind it", () => {
  // Message's own bottom button needs a block that actually rendered…
  // (…and, since 2026-10-11, a surface with no prompt box to send them: where one is mounted its Send
  // button carries every staged answer, and this one is not drawn — lib/sendScope.)
  assert.match(chat, /else if \(showSendButton && answering && askBlocks\.length > 0 && !promptBoxSends\)/)
})

// ---- PER-QUESTION PLACEMENT (2026-09-11) ----

// The fork draws no batch "Send answers" (each answer is sent on its own — RegisteredQuestionCards), so the
// Send-per-placed-rest half of upstream's pin is gone; the placement half stays.
test("every Message site hands the message its placed questions, and the thread page groups placed rests", () => {
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
  assert.equal((chat.match(/placedRestEnds\(messages, placement\)/g) ?? []).length, 1, "the thread page groups its Sends by rest")
})

test("a placed question leaves its anchor group, and the thread page mounts ONE answering provider", () => {
  assert.match(chat, /filter\(\(q\) => !placement\.placedIds\.has\(q\.id\)\)/)
  assert.equal((chat.match(/<RegisteredAnsweringProvider thread=\{thread\}>/g) ?? []).length, 1)
})

test("a free-form fence in a post-retirement thread gets no answering controller on any site", () => {
  assert.equal((chat.match(/answering=\{fencesLive \? answeringForMessage\((m|row\.message)\) : undefined\}/g) ?? []).length, 2)
})
