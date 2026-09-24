import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const queue = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")

// A ```question fence restating or naming a question REGISTERED at that rest or an earlier one is folded
// into the registered card (lib/questionShadow) — the 2026-08-28 "same question showing up twice in a row". The fold is a
// prop on Message, so it works only where the transcript hands it over: these pin that every surface
// that renders an answerable message does, and that the queue card's card-level Send answers stands
// down when the standing ask has no card left of its own.

test("every answerable Message site hands the registered questions at its rest to the fold", () => {
  // Thread page: the plain path (keyed by `messageIndex`) and the virtualized path (`row.messageIndex`).
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
  // Queue card: the text-only first/last message and the ordinary message, both keyed by `globalIdx`.
  assert.equal((queue.match(/shadowedBy=\{shadowedByMessage\.get\(globalIdx\)\}/g) ?? []).length, 2, "both queue-card message sites")
})

test("the map is built off the same messages and questions the anchors use, on all three surfaces", () => {
  const build = /registeredStandingAt\(messages, thread\?\.questions \?\? \[\]\), \[messages, thread\?\.questions\]\)/g
  assert.equal((chat.match(build) ?? []).length, 2, "one per ChatView transcript path")
  assert.equal((queue.match(build) ?? []).length, 1, "the queue card")
})

test("a folded fence leaves no Send button behind it", () => {
  // Message's own bottom button needs a block that actually rendered…
  assert.match(chat, /else if \(showSendButton && answering && askBlocks\.length > 0\)/)
  // …and the queue card's card-level button stands down for a standing ask folded whole.
  // (Gated on `fencesLive` since 2026-09-11: a thread dispatched after the free-form fence was retired
  // has no fence chrome at all — shared QUESTION_FENCE_RETIRED_AT.)
  assert.match(queue, /const showSendAnswers = fencesLive && \(\(answerable && !tailAskShadowed\) \|\| anyAnswered\)/)
  assert.match(queue, /allFencesShadowed\(messages\[idx\]\.text, shadowedByMessage\.get\(idx\) \?\? \[\]\)/)
})

// ---- PER-QUESTION PLACEMENT (2026-09-11) ----

test("every Message site hands the message its placed questions, and every question stack takes its Send from questionStacks", () => {
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
  assert.equal((queue.match(/placed=\{placement\.placed\.get\(globalIdx\)\}/g) ?? []).length, 2, "both queue-card message sites")
  // The Send rides the rest the placing marker sits in (lib/questionShadow questionStacks), so both the
  // tail mount and the anchored mount take it from the stack rather than from "anything placed anywhere".
  assert.equal((chat.match(/showSend=\{(questionGroups\.tail|row)\.showSend\}/g) ?? []).length, 2, "the thread page's tail and anchored stacks")
  assert.equal((queue.match(/showSend=\{(questionAnchors\.tail|stack)\.showSend\}/g) ?? []).length, 2, "the queue card's tail and anchored stacks")
})

test("a placed question leaves its anchor group on both surfaces, and each surface mounts ONE answering provider", () => {
  assert.match(chat, /questionStacks\(messages, thread\?\.questions \?\? \[\], placement\)/)
  assert.match(queue, /questionStacks\(messages, thread\?\.questions \?\? \[\], placement\)/)
  assert.equal((chat.match(/<RegisteredAnsweringProvider thread=\{thread\}>/g) ?? []).length, 1)
  assert.equal((queue.match(/<RegisteredAnsweringProvider thread=\{thread\}>/g) ?? []).length, 1)
})

test("a free-form fence in a post-retirement thread gets no answering controller on any site", () => {
  assert.equal((chat.match(/answering=\{fencesLive \? answeringForMessage\((m|row\.message)\) : undefined\}/g) ?? []).length, 2)
  assert.equal((queue.match(/answering=\{fencesLive \? answeringForMessage\(m\) : undefined\}/g) ?? []).length, 2)
})
