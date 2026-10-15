import assert from "node:assert/strict"
import { test } from "node:test"
import { budgetAt, maxLevel, type BudgetInput } from "./sidebarBudget.ts"

const input = (over: Partial<BudgetInput> = {}): BudgetInput => ({
  tail: 3,
  tailOpen: false,
  runs: [{ id: "a", size: 2 }, { id: "b", size: 4 }, { id: "c", size: 1 }, { id: "d", size: 4 }],
  expanded: new Set(),
  ready: 6,
  workingOpen: false,
  pinned: 3,
  pinnedOpen: false,
  waiting: 0,
  waitingOpen: false,
  ...over,
})
const at = (level: number, over?: Partial<BudgetInput>) => {
  const budget = budgetAt(level, input(over))
  return { tail: budget.tailShown, rolled: [...budget.rolled], ready: budget.readyShown, working: budget.workingShown, pinned: budget.pinnedShown, ...(budget.waitingShown ? { waiting: budget.waitingShown } : {}) }
}

test("the tail goes first, then the biggest runs, then Ready and Working a line at a time, then Pinned", () => {
  assert.deepEqual(at(0), { tail: 3, rolled: [], ready: 6, working: 11, pinned: 3 })
  assert.deepEqual(at(3), { tail: 0, rolled: [], ready: 6, working: 11, pinned: 3 })
  // b and d tie at 4: the one drawn first rolls first. c (one row) never rolls.
  assert.deepEqual(at(4), { tail: 0, rolled: ["b"], ready: 6, working: 8, pinned: 3 })
  assert.deepEqual(at(6), { tail: 0, rolled: ["b", "d", "a"], ready: 6, working: 4, pinned: 3 })
  // Ready lists more than Working's four lines, so it gives until they tie; at a tie Ready gives first.
  assert.deepEqual(at(8), { tail: 0, rolled: ["b", "d", "a"], ready: 4, working: 4, pinned: 3 })
  assert.deepEqual(at(9), { tail: 0, rolled: ["b", "d", "a"], ready: 3, working: 4, pinned: 3 })
  assert.deepEqual(at(11), { tail: 0, rolled: ["b", "d", "a"], ready: 3, working: 2, pinned: 3 })
  // Both at their floors: only now does Pinned give.
  assert.deepEqual(at(12), { tail: 0, rolled: ["b", "d", "a"], ready: 3, working: 2, pinned: 2 })
  assert.equal(maxLevel(input()), 3 + 3 + 3 + 2 + 1)
  assert.deepEqual(at(50), at(maxLevel(input())), "past the last level nothing more is taken")
})

test("Done opened lists every row, and still gives every one before anything else does", () => {
  const open = { tailOpen: true, tail: 12 }
  assert.deepEqual(at(0, open), { tail: 12, rolled: [], ready: 6, working: 11, pinned: 3 })
  assert.deepEqual(at(7, open), { tail: 5, rolled: [], ready: 6, working: 11, pinned: 3 }, "past five rows, not stopping at five")
  assert.deepEqual(at(12, open), { tail: 0, rolled: [], ready: 6, working: 11, pinned: 3 })
  assert.deepEqual(at(13, open), { tail: 0, rolled: ["b"], ready: 6, working: 8, pinned: 3 }, "only then does Working roll")
  assert.deepEqual(at(16, open), { tail: 0, rolled: ["b", "d", "a"], ready: 5, working: 4, pinned: 3 }, "and Ready shorten")
})

test("what the human opened is never compressed", () => {
  // An expanded run is passed over.
  assert.deepEqual(at(4, { expanded: new Set(["b"]) }), { tail: 0, rolled: ["d"], ready: 6, working: 8, pinned: 3 })
  // Working opened: rolled but never shortened, so Ready gives every step down to its floor.
  assert.deepEqual(at(20, { workingOpen: true }), { tail: 0, rolled: ["b", "d", "a"], ready: 3, working: 4, pinned: 2 })
  // Pinned opened: it keeps every row however far the level goes.
  assert.deepEqual(at(50, { pinnedOpen: true }).pinned, 3)
})

test("a tier at or under its floor never shortens", () => {
  const small = { ready: 3, runs: [{ id: "a", size: 1 }, { id: "b", size: 1 }], tail: 0, pinned: 1 }
  assert.equal(maxLevel(input(small)), 0)
  assert.deepEqual(at(9, small), { tail: 0, rolled: [], ready: 3, working: 2, pinned: 1 })
})

test("a lone run never rolls: it shortens line by line like Ready", () => {
  const page = { runs: [{ id: "a", size: 21 }], ready: 28, tail: 0, pinned: 0 }
  assert.deepEqual(at(25, page), { tail: 0, rolled: [], ready: 12, working: 12, pinned: 0 })
})

test("Waiting gives right after the Done tail, down to its floor, then last of all to one row", () => {
  const five = { waiting: 5 }
  assert.deepEqual(at(3, five), { tail: 0, rolled: [], ready: 6, working: 11, pinned: 3, waiting: 5 }, "the tail goes first")
  assert.deepEqual(at(6, five), { tail: 0, rolled: [], ready: 6, working: 11, pinned: 3, waiting: 2 }, "then Waiting, a row a level, to its floor")
  assert.deepEqual(at(7, five), { tail: 0, rolled: ["b"], ready: 6, working: 8, pinned: 3, waiting: 2 }, "and only then does Working roll")
  const last = maxLevel(input(five))
  assert.equal(last, 3 + 3 + 3 + 3 + 2 + 1 + 1)
  assert.equal(at(last - 1, five).waiting, 2, "the floor holds through every other step, Pinned's included")
  assert.equal(at(last - 1, five).pinned, 2)
  assert.equal(at(last, five).waiting, 1, "the very last step leaves one row, never none")
  assert.equal(at(last + 10, five).waiting, 1)
  // Opened by hand, it keeps every row and its steps leave the order.
  assert.deepEqual(at(4, { ...five, waitingOpen: true }), { tail: 0, rolled: ["b"], ready: 6, working: 8, pinned: 3, waiting: 5 })
  // A single row has no step at all.
  assert.equal(maxLevel(input({ waiting: 1 })), maxLevel(input()))
})
