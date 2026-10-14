import assert from "node:assert/strict"
import { test } from "node:test"
import { edgeScrollVelocity, listDropIndex, listPitch, moveItem, placeAmong, shiftFor } from "./railReorder.ts"

const STEP = 48

test("moveItem moves in both directions, and `to` is read against the post-removal list", () => {
  const list = ["a", "b", "c", "d"]
  assert.deepEqual(moveItem(list, 0, 2), ["b", "c", "a", "d"])
  assert.deepEqual(moveItem(list, 3, 1), ["a", "d", "b", "c"])
  assert.deepEqual(moveItem(list, 0, 3), ["b", "c", "d", "a"])
  // Non-moves and out-of-range are the identity, never a throw: a drop can land where it started.
  assert.deepEqual(moveItem(list, 1, 1), list)
  assert.deepEqual(moveItem(list, -1, 2), list)
  assert.deepEqual(moveItem(list, 0, 9), list)
  assert.deepEqual(list, ["a", "b", "c", "d"], "the input is not mutated")
})

test("only the squares between the two slots move, and they move exactly one step", () => {
  // Dragging index 1 down to 3: 2 and 3 slide UP into the gap, 0 and 4 do not move at all.
  assert.equal(shiftFor(0, 1, 3, STEP), 0)
  assert.equal(shiftFor(1, 1, 3, STEP), 0, "the held square is positioned by its own delta, not shifted")
  assert.equal(shiftFor(2, 1, 3, STEP), -STEP)
  assert.equal(shiftFor(3, 1, 3, STEP), -STEP)
  assert.equal(shiftFor(4, 1, 3, STEP), 0)

  // Dragging 3 up to 1: 1 and 2 slide DOWN.
  assert.equal(shiftFor(0, 3, 1, STEP), 0)
  assert.equal(shiftFor(1, 3, 1, STEP), STEP)
  assert.equal(shiftFor(2, 3, 1, STEP), STEP)
  assert.equal(shiftFor(3, 3, 1, STEP), 0)

  // A drag that has not changed slots moves nothing.
  for (const i of [0, 1, 2, 3]) assert.equal(shiftFor(i, 2, 2, STEP), 0)
})

test("edge auto-scroll engages only inside the zone, ramps with depth, and is signed", () => {
  const bounds = { top: 100, bottom: 500 }
  assert.equal(edgeScrollVelocity(300, bounds), 0, "the middle of the band does not scroll")
  assert.equal(edgeScrollVelocity(150, bounds), 0, "just outside the zone does not scroll")
  assert.ok(edgeScrollVelocity(110, bounds) < 0, "near the top scrolls up")
  assert.ok(edgeScrollVelocity(490, bounds) > 0, "near the bottom scrolls down")
  // Deeper into the zone is faster, and it is capped.
  assert.ok(Math.abs(edgeScrollVelocity(102, bounds)) > Math.abs(edgeScrollVelocity(130, bounds)))
  assert.ok(Math.abs(edgeScrollVelocity(-500, bounds)) <= 14)
})

test("the list swaps on the held group's leading edge passing a neighbour's middle, whatever their heights", () => {
  // A one-line row, a tall group, a one-line row: 28px lines with 12px between groups.
  const boxes = [
    { top: 0, height: 28 },
    { top: 40, height: 200 },
    { top: 252, height: 28 },
  ]
  // The first row, dragged down: its bottom (28 + delta) must pass the tall group's middle (140).
  assert.equal(listDropIndex(boxes, 0, 111), 0)
  assert.equal(listDropIndex(boxes, 0, 113), 1)
  assert.equal(listDropIndex(boxes, 0, 239), 2)
  // The tall group, dragged up: its TOP must pass the first row's middle (14) — 27px, not half its height.
  assert.equal(listDropIndex(boxes, 1, -25), 1)
  assert.equal(listDropIndex(boxes, 1, -27), 0)
  // Far past either end lands at the end.
  assert.equal(listDropIndex(boxes, 1, -5000), 0)
  assert.equal(listDropIndex(boxes, 1, 5000), 2)
})

test("the list's neighbours slide by the held group's height plus the gap it leaves", () => {
  const boxes = [
    { top: 0, height: 28 },
    { top: 40, height: 200 },
    { top: 252, height: 28 },
  ]
  assert.equal(listPitch(boxes, 0), 40)
  assert.equal(listPitch(boxes, 1), 212)
  assert.equal(listPitch(boxes, 2), 40, "the last group reads the gap above it")
  assert.equal(listPitch([{ top: 0, height: 28 }], 0), 28)
})

test("a move within a visible run lands beside the same neighbour in the whole order", () => {
  // The whole order, and the run the list showed: b, d and e are busy, the rest quiet.
  const order = ["a", "b", "c", "d", "e", "f"]
  const busy = ["b", "d", "e"]
  // e dragged to the top of the run: it goes just before b, and a stays ahead of both.
  assert.deepEqual(placeAmong(order, busy, 2, 0), ["a", "e", "b", "c", "d", "f"])
  // b dragged to the end of the run: just after e, and f keeps its place after that.
  assert.deepEqual(placeAmong(order, busy, 0, 2), ["a", "c", "d", "e", "b", "f"])
  // b dragged one down: just before e — after d, and c is untouched.
  assert.deepEqual(placeAmong(order, busy, 0, 1), ["a", "c", "d", "b", "e", "f"])
  // Non-moves and an id the order does not know are the identity.
  assert.deepEqual(placeAmong(order, busy, 1, 1), order)
  assert.deepEqual(placeAmong(order, ["x", "b"], 0, 1), order)
})
