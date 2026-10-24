import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { questionAnchorIndex, questionClaims, questionsAboveNewestRest, questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"

const at = (n: number) => new Date(Date.UTC(2026, 7, 27, 20, n)).toISOString()
const msg = (role: string, minute: number, kind?: string): AnchorMessage => ({ role, at: at(minute), ...(kind ? { kind } : {}) })
const said = (minute: number, text: string): AnchorMessage => ({ role: "assistant", at: at(minute), text })
const fence = (frontmatter: string) => `Still on it.\n\n\`\`\`awaiting\n${frontmatter}\n---\nThe answer decides the next step.\n\`\`\``

// THE ORDINARY CASE, and the one that must not move: the worker asked and rested, nothing has happened
// since, so the card is the tail exactly as it was before there was an anchor at all.
test("a question asked at the last rest anchors to the tail", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2)]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// THE REPORT. The human replied past the question without answering it — the composer is right there —
// and the worker has worked since. Pinned to the tail the card sat UNDER their own newest message and
// under everything after it, claiming to be the current ask.
test("a question the human replied past sits at ITS rest, above their reply", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering
    msg("assistant", 4),   // 4 the worker gets on with it
  ]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// A wake is recorded as a USER turn, and it counts: the thread moved on, whoever moved it.
test("ntwine's own delivery ends the rest just as a typed reply does", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 0)
})

test("punctuation is not a turn", () => {
  // An event line and a reasoning summary carry a nominal role; neither ends a rest.
  const messages = [msg("assistant", 1), msg("user", 2, "event"), msg("user", 2, "reasoning"), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 3)
})

test("a rest older than the loaded window goes above everything, never back to the tail", () => {
  // -1 rather than the tail: at the bottom the card would be lying about being the current ask, which is
  // the whole defect. At the top it is merely as high as this window can put it.
  const messages = [msg("user", 5), msg("assistant", 6)]
  assert.equal(questionAnchorIndex(messages, at(1)), -1)
})

test("an unreadable instant degrades to the tail rather than to the top", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionAnchorIndex(messages, "not a date"), 1)
  assert.equal(questionAnchorIndex([], at(1)), -1)
})

test("a message with no instant cannot end a rest", () => {
  const messages: AnchorMessage[] = [{ role: "assistant", at: at(1) }, { role: "user" }, { role: "assistant", at: at(3) }]
  assert.equal(questionAnchorIndex(messages, at(1)), 2)
})

// One `ask` call registers several questions at ONE instant, and they must stay one stack.
test("questions from one call group together; questions from two rests do not", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  const grouped = questionsByAnchor(messages, [
    { id: "a", askedAt: at(1) },
    { id: "b", askedAt: at(1) },
    { id: "c", askedAt: at(3) },
  ])
  assert.deepEqual([...grouped.keys()].sort(), [0, 2])
  assert.deepEqual(grouped.get(0)?.map((q) => q.id), ["a", "b"])
  assert.deepEqual(grouped.get(2)?.map((q) => q.id), ["c"])
})

// THE ONE THING THE PURE FUNCTION CANNOT PIN: that both surfaces split the stack the same way. The
// in-flight ANSWER belongs to the TAIL wherever the questions sit — it is the human's newest turn, and
// the delivered copy of it lands at the tail a second later — so a mount placed at an older rest must
// not draw it. Two drawing it would render the answer twice, in two places, seconds apart.
//
// The prop is OPT-IN (`inFlight`, the rows the transcript is not already drawing — see
// unrenderedAnswers) rather than the opt-out `showInFlight` it was until 2026-09-01, so an anchored
// mount draws nothing by simply not passing it, and this reads the same guarantee off the new spelling.
test("a mount placed at an older rest never draws the in-flight answer", () => {
  for (const file of ["ChatView.tsx"]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    const mounts = [...source.matchAll(/<RegisteredQuestionStack[^>]*>/g)].map((m) => m[0])
    const tail = mounts.filter((m) => /questions=\{[^}]*[Tt]ail\}/.test(m))
    // An ANCHORED mount is one handed a group that is not the tail. The eager fallback passes no
    // `questions` at all — it only renders with an empty transcript, where every rest IS the tail.
    const anchored = mounts.filter((m) => /questions=\{/.test(m) && !/[Tt]ail\}/.test(m))
    assert.equal(tail.length, 1, `${file}: exactly one tail mount`)
    assert.ok(anchored.length >= 1, `${file}: at least one anchored mount`)
    assert.match(tail[0], /inFlight=\{/, `${file}: the tail mount draws the in-flight answer`)
    for (const m of anchored) assert.ok(!/inFlight=\{/.test(m), `${file}: an anchored mount must not`)
    // …and the mount with no `questions` at all (the empty-transcript fallback) is a tail too.
    for (const m of mounts.filter((x) => !/questions=\{/.test(x))) {
      assert.match(m, /inFlight=\{/, `${file}: the fallback mount is a tail mount`)
    }
  }
})

// ---- A CARD STAYS WHERE IT WAS ASKED UNTIL A LATER REST CLAIMS IT (2026-10-05) ------------------
//
// From 2026-08-31 every open question moved to the CURRENT rest whenever the thread was at rest, so a
// question the human had replied past, or one a wake had buried, was pulled out of the prose that set it
// up and stacked under whatever the worker said last — superseding its own sign-off (maintainer
// 2026-10-05). Now a rest that says nothing about a question leaves its card alone, and a fence that names
// it under `questions:` (taught 2026-10-05 to 2026-10-24, still read) moves it to that rest. ChatView's
// tail pointer is what shows a held card left a rest up.

test("a later rest that says nothing about a question leaves its card at the rest that asked it", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering (or a CI wake lands)
    msg("assistant", 4),   // 4 the worker answers and rests again
  ]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [2])
})

test("a later fence naming the question claims it: the card moves to the end of that rest", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [3])
})

test("the claim lands at the END of its rest, even when the fence sits in an earlier message of it", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]")), msg("assistant", 5), msg("user", 6), msg("assistant", 7)]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [4])
})

test("only the questions a fence names move; the rest stay where they were asked", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), said(5, fence("questions: [qst_b]"))]
  const grouped = questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }, { id: "qst_b", askedAt: at(3) }])
  assert.deepEqual(grouped.get(0)?.map((q) => q.id), ["qst_a"])
  assert.deepEqual(grouped.get(4)?.map((q) => q.id), ["qst_b"])
})

test("a fence naming questions from several rests gathers them into one stack at its rest", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), said(5, fence("questions: [qst_a, qst_b]"))]
  const grouped = questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }, { id: "qst_b", askedAt: at(3) }])
  assert.deepEqual([...grouped.keys()], [4])
  assert.deepEqual(grouped.get(4)?.map((q) => q.id), ["qst_a", "qst_b"])
})

test("the newest claim wins, and a claim at the asking rest itself changes nothing", () => {
  const messages = [said(1, fence("questions: [qst_a]")), msg("user", 2), said(3, fence("questions: [qst_a]")), msg("user", 4), msg("assistant", 5)]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }]).keys()], [2])
  assert.deepEqual([...questionsByAnchor(messages.slice(0, 1), [{ id: "qst_a", askedAt: at(1) }]).keys()], [0])
})

test("a claim brings a question asked above the loaded window into it", () => {
  const messages = [msg("user", 5), said(6, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }]).keys()], [1])
})

// A QUESTION THE HUMAN TYPED PAST NEVER MOVES (2026-10-14): it stays at the rest that asked it, and a later
// fence naming it is ignored.
test("a claim on a question the human typed past is ignored: the card stays at the rest that asked it", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2), passedOver: true as const }]).keys()], [1])
})

test("claims: false reads the asking rest alone — the fold's reading", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }], { claims: false }).keys()], [1])
})

test("a claim is read case-blind and down from a gloss, and only off a worker's own fence", () => {
  const claims = questionClaims([
    said(1, fence("questions:\n  - QST_A — the cache call")),
    { role: "user", at: at(2), text: fence("questions: [qst_b]") },
    said(3, "Quoting the grammar:\n\n````md\n" + fence("questions: [qst_c]") + "\n````"),
  ])
  assert.deepEqual([...claims.entries()], [["qst_a", 0]])
})

// No questions ⇒ no groups; the tail entry must not be minted for an empty set.
test("no open questions produces no groups", () => {
  const messages = [msg("user", 0), said(1, fence("questions: [qst_a]"))]
  assert.equal(questionsByAnchor(messages, []).size, 0)
})

// ---- THE TAIL'S LINK TO A QUESTION ABOVE THE NEWEST REST (2026-10-20, held ones since 2026-10-24) ------
// A held question signs off every rest, but its card stays at the rest that asked it, so after a wake the
// newest handoff's ask is a rest up. The link counts what the reader must scroll up to: a card row, a
// placed card in an older rest, and anything the human typed past — never a card already in the newest rest.
const WOKEN = [msg("user", 0), msg("assistant", 2), msg("user", 3), msg("assistant", 4)] // asked at 1, a wake at 2
const held = { id: "qst_held" }
const typedPast = { id: "qst_past", passedOver: true as const }

test("a held card left at an older rest, and a placed one in an older message, are both above", () => {
  const groups = [undefined, { questions: [held] }, undefined, { questions: [{ id: "qst_placed" }], messageIndex: 1 }, undefined]
  assert.deepEqual(questionsAboveNewestRest(WOKEN, groups), { count: 2, target: 3 })
})

test("a held card placed in the newest rest is that rest's own, but a typed-past one there still counts", () => {
  const groups = [{ questions: [held, typedPast], messageIndex: 3 }]
  assert.deepEqual(questionsAboveNewestRest(WOKEN, groups), { count: 1, target: 0 })
  assert.deepEqual(questionsAboveNewestRest(WOKEN, [{ questions: [held], messageIndex: 3 }]), { count: 0, target: -1 })
})
