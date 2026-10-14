import { test } from "node:test"
import assert from "node:assert/strict"
import { stableQueue, type QueueSlot } from "./stableQueue.ts"

// Items are their own keys: the order logic never looks inside them.
const keyOf = (key: string) => key
const slots = (...keys: string[]): QueueSlot<string>[] => keys.map((key) => ({ key, item: key, ghost: false }))
const drawn = (list: QueueSlot<string>[]) => list.map((slot) => (slot.ghost ? `(${slot.key})` : slot.key)).join(" ")
const always = () => true
const never = () => false

function next(prev: QueueSlot<string>[], target: string[], onScreen: string[], opts: { mayGhost?: (key: string) => boolean; keep?: string[] } = {}) {
  return stableQueue({ prev, target, keyOf, onScreen: new Set(onScreen), mayGhost: opts.mayGhost ?? always, keep: new Set(opts.keep ?? []) })
}

test("a first draw is exactly the queue's own order", () => {
  assert.equal(drawn(next([], ["a", "b", "c"], [])), "a b c")
  assert.equal(drawn(next([], ["c", "a", "b"], [])), "c a b")
})

test("an arrival joins the bottom, and the cards drawn stay as drawn", () => {
  assert.equal(drawn(next(slots("a", "b"), ["a", "b", "c"], ["a", "b"])), "a b c")
})

test("an arrival the queue's order puts first still joins the bottom — and stays there once the reader moves on", () => {
  const arrived = next(slots("a", "b", "c"), ["n", "a", "b", "c"], ["a", "b"])
  assert.equal(drawn(arrived), "a b c n")
  assert.equal(drawn(next(arrived, ["n", "a", "b", "c"], ["c"])), "a b c n")
  assert.equal(drawn(next(arrived, ["n", "a", "b", "c"], [])), "a b c n")
})

test("an arrival stamped before the cards drawn still joins the bottom (a late poll, a restart, a card coming back)", () => {
  assert.equal(drawn(next(slots("b", "c"), ["a", "b", "c"], ["b", "c"])), "b c a")
  // A self-woken thread the server returns to its old place in line: the page puts it last.
  assert.equal(drawn(next(slots("a", "b", "c"), ["a", "x", "b", "c"], ["a", "b"])), "a b c x")
})

test("several arrivals at once join the bottom in the queue's own order among themselves", () => {
  assert.equal(drawn(next(slots("a", "b"), ["y", "a", "x", "b"], ["a"])), "a b y x")
})

test("a card on screen that leaves on its own stays as a ghost, and is the card again when it comes back", () => {
  const ghosted = next(slots("a", "b", "c"), ["b", "c"], ["a", "b"])
  assert.equal(drawn(ghosted), "(a) b c")
  // Still on screen: still held.
  assert.equal(drawn(next(ghosted, ["b", "c"], ["a", "b"])), "(a) b c")
  // Rests again while held: in the same place, a card again — even though the queue now puts it last.
  assert.equal(drawn(next(ghosted, ["b", "c", "a"], ["a", "b"])), "a b c")
  // Scrolled away while still gone: it goes, and nothing on screen moves (it was above them).
  assert.equal(drawn(next(ghosted, ["b", "c"], ["c"])), "b c")
})

test("a card off screen that leaves simply goes, and comes back as an arrival", () => {
  const gone = next(slots("a", "b", "c"), ["b", "c"], ["c"])
  assert.equal(drawn(gone), "b c")
  assert.equal(drawn(next(gone, ["a", "b", "c"], ["c"])), "b c a")
})

test("a card the human put away leaves the ordinary way, never as a ghost", () => {
  assert.equal(drawn(next(slots("a", "b", "c"), ["b", "c"], ["a", "b"], { mayGhost: never })), "b c")
})

test("a dismissed card keeps its place while it fades on screen, and goes once it is off screen", () => {
  assert.equal(drawn(next(slots("a", "b"), ["b"], ["a", "b"], { mayGhost: never, keep: ["a"] })), "a b")
  assert.equal(drawn(next(slots("a", "b"), ["b"], ["b"], { mayGhost: never, keep: ["a"] })), "b")
})

test("cards drawn never change places, on screen or off, whatever the queue's order does", () => {
  assert.equal(drawn(next(slots("a", "b", "c"), ["b", "a", "c"], ["a", "b"])), "a b c")
  assert.equal(drawn(next(slots("a", "b", "x"), ["x", "a", "b"], ["a", "b"])), "a b x")
  assert.equal(drawn(next(slots("p", "q", "a", "b", "y", "z"), ["q", "p", "a", "b", "z", "y"], ["a", "b"])), "p q a b y z")
})

test("with only ghosts on screen, a new card still goes to the bottom", () => {
  const prev: QueueSlot<string>[] = [...slots("p"), { key: "g", item: "g", ghost: true }, ...slots("z")]
  assert.equal(drawn(next(prev, ["p", "n", "z"], ["g"])), "p (g) z n")
})
