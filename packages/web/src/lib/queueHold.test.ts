import assert from "node:assert/strict"
import test from "node:test"
import { placeHeld } from "./queueHold.ts"

// A fresh draw's queue: [key, live stamp]. The stamp is the thread's queueKeyAt now.
type Entry = readonly [string, number]
const keyOf = (entry: Entry) => entry[0]
const stampOf = (entry: Entry) => entry[1]
const draw = (entries: Entry[], holds: [string, number][]) => placeHeld(entries, new Map(holds), keyOf, stampOf).map(keyOf)

test("a held thread still at work goes back between the cards it was held between", () => {
  // Not queued, so the page lists it after the queue; held at 20, between a (10) and c (30).
  assert.deepEqual(draw([["a", 10], ["c", 30], ["b", 0]], [["b", 20]]), ["a", "b", "c"])
})

test("a held thread that rested again keeps its old place, not its new stamp", () => {
  // It re-entered the queue at 50, which sorts it last; it was held at 20.
  assert.deepEqual(draw([["a", 10], ["c", 30], ["b", 50]], [["b", 20]]), ["a", "b", "c"])
})

test("held ahead of everything, and a hold with no place, land at the ends", () => {
  assert.deepEqual(draw([["a", 10], ["c", 30], ["b", 0], ["d", 0]], [["b", 5], ["d", Number.POSITIVE_INFINITY]]), ["b", "a", "c", "d"])
})

test("several holds keep the order they were held in", () => {
  assert.deepEqual(draw([["a", 10], ["y", 99], ["x", 98]], [["x", 15], ["y", 15]]), ["a", "y", "x"])
  assert.deepEqual(draw([["a", 10], ["y", 99], ["x", 98]], [["x", 12], ["y", 15]]), ["a", "x", "y"])
})
