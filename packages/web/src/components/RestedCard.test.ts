import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestedCard, showsRestedCard, type RestedCardThread } from "./RestedCard.tsx"

// The residual rung fires when NO other card does. What these pin is the exclusion list: every state
// that already has a card must keep this one off, or the bottom of a thread shows two endings.

const bare: RestedCardThread = {
  kind: "session", runtime: "turn-idle", needsYou: true, questions: [], pendingQuestion: false, lastAssistantAt: "2026-08-27T22:19:32.609Z",
}

test("a bare rest in the queue draws the card; a stall draws it whatever the message says", () => {
  assert.equal(showsRestedCard(bare, "**Fixed** — landed."), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited" }, "**Fixed** — landed."), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited", crashed: true }, undefined), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited", crashed: true, lastFence: { kind: "done", body: "x", hints: [] } }, "```done\nx\n```"), true)
  // Withheld from the queue while its wake gets a few seconds to land: still the rest it will queue with.
  assert.equal(showsRestedCard({ ...bare, needsYou: false, queueSettling: true }, "**Fixed** — landed."), true)
  assert.equal(showsRestedCard({ ...bare, needsYou: false }, "**Fixed** — landed."), false, "…where a thread merely out of the queue draws nothing")
})

test("every ending with a card of its own keeps this one off", () => {
  const text = "**Fixed** — landed."
  assert.equal(showsRestedCard({ ...bare, lastFence: { kind: "done", body: "x", hints: [], registered: true } }, text), false)
  assert.equal(showsRestedCard({ ...bare, lastFence: { kind: "awaiting", body: "x", hints: [] } }, text), false)
  assert.equal(showsRestedCard({ ...bare, questions: [{ id: "q", spec: { question: "?", kind: "question" }, askedAt: bare.lastAssistantAt! }] }, text), false)
  assert.equal(showsRestedCard({ ...bare, pendingQuestion: true }, text), false)
  // THE SECONDS AFTER AN ANSWER. The question row is settled, so `questions` is already empty, and the
  // worker has not been handed the answer yet — so every OTHER rung is false and this one caught the
  // hole: a card saying nobody signed anything off, over a human who had just answered.
  assert.equal(showsRestedCard({ ...bare, answersInFlight: "Answers to earlier questions:\n1. “Q?” → A" }, text), false)
  // …and the seconds after arming a Goal cancelled the questions: the same field carries the
  // cancellation wake on its way, and a card claiming a bare rest of a thread that had asked is the
  // exact render the maintainer reported (2026-09-02).
  assert.equal(showsRestedCard({ ...bare, answersInFlight: "1 question you registered was CANCELLED without an answer. Decide it yourself and carry on — say which way you went in your write-up. Do not re-ask." }, text), false)
  assert.equal(showsRestedCard({ ...bare, awaitingBackground: true }, text), false)
  assert.equal(showsRestedCard({ ...bare, pendingInteraction: true }, text), false)
  assert.equal(showsRestedCard({ ...bare, limitPause: { window: "session", since: bare.lastAssistantAt! } as never }, text), false)
  // The message's own copy of the same facts: a fence or a question block in the final text.
  assert.equal(showsRestedCard(bare, "Done.\n\n```done\nlanded\n```"), false)
  assert.equal(showsRestedCard(bare, "```question\nShip it?\n\n- A. Yes\n- B. No\n```"), false)
})

test("not a rest: running, spawning, excused from the queue, foreign, or nothing said yet", () => {
  assert.equal(showsRestedCard({ ...bare, runtime: "running" }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, runtime: "spawning" }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, needsYou: false }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, foreign: true }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, lastAssistantAt: undefined }, "x"), false)
  assert.equal(showsRestedCard(bare, undefined), false)
  assert.equal(showsRestedCard(undefined, "x"), false)
})

test("the two shapes render their own label", () => {
  const stalled = renderToStaticMarkup(createElement(RestedCard, { thread: { crashed: true } }))
  assert.match(stalled, /data-rested-card="stalled"/)
  assert.match(stalled, />Stalled</)
  const rested = renderToStaticMarkup(createElement(RestedCard, { thread: { crashed: false } }))
  assert.match(rested, /data-rested-card="bare"/)
  assert.match(rested, />Rested without a sign-off</)
})
