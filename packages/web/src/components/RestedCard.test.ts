import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestedCard, showsRestedCard, type RestedCardThread } from "./RestedCard.tsx"

const stalled: RestedCardThread = { kind: "session", runtime: "exited", needsYou: true, crashed: true }

test("a stall in the queue draws the card; a bare rest draws nothing", () => {
  assert.equal(showsRestedCard(stalled), true)
  // Withheld from the queue while its wake gets a few seconds to land: still the rest it will queue with.
  assert.equal(showsRestedCard({ ...stalled, needsYou: false, queueSettling: true }), true)
  assert.equal(showsRestedCard({ ...stalled, crashed: false }), false, "the bare rest's card is gone")
  assert.equal(showsRestedCard({ ...stalled, runtime: "turn-idle", crashed: undefined }), false)
})

test("not a stall to show: running, out of the queue, foreign, or a provider error", () => {
  assert.equal(showsRestedCard({ ...stalled, runtime: "running" }), false)
  assert.equal(showsRestedCard({ ...stalled, needsYou: false }), false)
  assert.equal(showsRestedCard({ ...stalled, foreign: true }), false)
  assert.equal(showsRestedCard({ ...stalled, providerError: { code: "x", message: "x", at: "2026-10-16T00:00:00.000Z" } }), false)
  assert.equal(showsRestedCard(undefined), false)
})

test("the stall card names the retry", () => {
  const html = renderToStaticMarkup(createElement(RestedCard))
  assert.match(html, /data-rested-card="stalled"/)
  assert.match(html, />Stalled</)
})
