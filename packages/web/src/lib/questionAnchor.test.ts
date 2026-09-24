import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { questionAnchorIndex, questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"

const at = (n: number) => new Date(Date.UTC(2026, 7, 27, 20, n)).toISOString()
const msg = (role: string, minute: number, kind?: string): AnchorMessage => ({ role, at: at(minute), ...(kind ? { kind } : {}) })

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
test("frizz's own delivery ends the rest just as a typed reply does", () => {
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
  for (const file of ["ChatView.tsx", "TodosView.tsx"]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    const mounts = [...source.matchAll(/<RegisteredQuestionStack[^>]*>/g)].map((m) => m[0])
    const tail = mounts.filter((m) => /questions=\{[^}]*[Tt]ail(\.questions)?\}/.test(m))
    // An ANCHORED mount is one handed a group that is not the tail. The eager fallback passes no
    // `questions` at all — it only renders with an empty transcript, where every rest IS the tail.
    const anchored = mounts.filter((m) => /questions=\{/.test(m) && !/[Tt]ail(\.questions)?\}/.test(m))
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

// ---- A LATER REST DOES NOT DRAG THE ASK DOWN (2026-09-24) -----------------------------------------
//
// The human replied past an open question — obviating it — and the worker answered and rested again
// with the row still open. The newest handoff is about something else; the card belongs to the rest
// that asked it, not under a write-up it has nothing to do with (maintainer 2026-09-24: "it should move
// up in the chat appropriately"). This reverses the 2026-08-31 current-rest rule, which pulled it down.
test("a question the human replied past stays at its own rest after the worker rests again", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering
    msg("assistant", 4),   // 4 the worker answers and rests again
  ]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "a", askedAt: at(2) }]).keys()], [2])
})

// Two questions asked at two different rests render at their two rests — the older one is not pulled
// into the newer one's stack.
test("questions from several rests each stay at their own rest", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), msg("assistant", 5)]
  const grouped = questionsByAnchor(messages, [{ id: "a", askedAt: at(1) }, { id: "b", askedAt: at(3) }])
  assert.deepEqual([...grouped.entries()].map(([k, qs]) => [k, qs.map((q) => q.id)]), [[0, ["a"]], [2, ["b"]]])
})

// No questions ⇒ no groups; the tail entry must not be minted for an empty set.
test("no open questions produces no groups", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionsByAnchor(messages, []).size, 0)
})
