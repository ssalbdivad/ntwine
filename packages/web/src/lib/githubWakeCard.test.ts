import { test } from "node:test"
import assert from "node:assert/strict"
import { wakeCardTitle } from "./githubWakeCard.ts"

test("wakeCardTitle says the whole single event, and counts several", () => {
  assert.equal(wakeCardTitle(1, "comment", "pullfrog[bot]"), "New comment from @pullfrog[bot]")
  assert.equal(wakeCardTitle(1, "change request", "dana"), "New change request from @dana")
  // No actor to name (a burst collapsed to one row, or a shape surprise) still reads as a sentence.
  assert.equal(wakeCardTitle(1, "comment"), "New comment")
  // A count never names an actor, even when one is passed: the burst has several.
  assert.equal(wakeCardTitle(3, "comment", "pullfrog[bot]"), "3 new items")
})

