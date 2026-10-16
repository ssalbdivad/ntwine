import assert from "node:assert/strict"
import { test } from "node:test"
import { budgetAt, maxLevel, type BudgetInput } from "./sidebarBudget.ts"

const input = (over: Partial<BudgetInput> = {}): BudgetInput => ({
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
  return { rolled: [...budget.rolled], ready: budget.readyShown, working: budget.workingShown, pinned: budget.pinnedShown, ...(budget.waitingShown ? { waiting: budget.waitingShown } : {}) }
}

test("the biggest runs go first, then Ready and Working a line at a time, then Pinned", () => {
  assert.deepEqual(at(0), { rolled: [], ready: 6, working: 11, pinned: 3 })
  // b and d tie at 4: the one drawn first rolls first. c (one row) never rolls.
  assert.deepEqual(at(1), { rolled: ["b"], ready: 6, working: 8, pinned: 3 })
  assert.deepEqual(at(3), { rolled: ["b", "d", "a"], ready: 6, working: 4, pinned: 3 })
  // Ready lists more than Working's four lines, so it gives until they tie; at a tie Ready gives first.
  assert.deepEqual(at(5), { rolled: ["b", "d", "a"], ready: 4, working: 4, pinned: 3 })
  assert.deepEqual(at(6), { rolled: ["b", "d", "a"], ready: 3, working: 4, pinned: 3 })
  assert.deepEqual(at(8), { rolled: ["b", "d", "a"], ready: 3, working: 2, pinned: 3 })
  // Both at their floors: only now does Pinned give.
  assert.deepEqual(at(9), { rolled: ["b", "d", "a"], ready: 3, working: 2, pinned: 2 })
  assert.equal(maxLevel(input()), 3 + 3 + 2 + 1)
  assert.deepEqual(at(50), at(maxLevel(input())), "past the last level nothing more is taken")
})

test("what the human opened is never compressed", () => {
  // An expanded run is passed over.
  assert.deepEqual(at(1, { expanded: new Set(["b"]) }), { rolled: ["d"], ready: 6, working: 8, pinned: 3 })
  // Working opened: rolled but never shortened, so Ready gives every step down to its floor.
  assert.deepEqual(at(20, { workingOpen: true }), { rolled: ["b", "d", "a"], ready: 3, working: 4, pinned: 2 })
  // Pinned opened: it keeps every row however far the level goes.
  assert.deepEqual(at(50, { pinnedOpen: true }).pinned, 3)
})

test("a tier at or under its floor never shortens", () => {
  const small = { ready: 3, runs: [{ id: "a", size: 1 }, { id: "b", size: 1 }], pinned: 1 }
  assert.equal(maxLevel(input(small)), 0)
  assert.deepEqual(at(9, small), { rolled: [], ready: 3, working: 2, pinned: 1 })
})

test("a lone run never rolls: it shortens line by line like Ready", () => {
  const page = { runs: [{ id: "a", size: 21 }], ready: 28, pinned: 0 }
  assert.deepEqual(at(25, page), { rolled: [], ready: 12, working: 12, pinned: 0 })
})

test("Waiting gives first, down to its floor, then last of all to one row", () => {
  const five = { waiting: 5 }
  assert.deepEqual(at(0, five), { rolled: [], ready: 6, working: 11, pinned: 3, waiting: 5 })
  assert.deepEqual(at(3, five), { rolled: [], ready: 6, working: 11, pinned: 3, waiting: 2 }, "then Waiting, a row a level, to its floor")
  assert.deepEqual(at(4, five), { rolled: ["b"], ready: 6, working: 8, pinned: 3, waiting: 2 }, "and only then does Working roll")
  const last = maxLevel(input(five))
  assert.equal(last, 3 + 3 + 3 + 2 + 1 + 1)
  assert.equal(at(last - 1, five).waiting, 2, "the floor holds through every other step, Pinned's included")
  assert.equal(at(last - 1, five).pinned, 2)
  assert.equal(at(last, five).waiting, 1, "the very last step leaves one row, never none")
  assert.equal(at(last + 10, five).waiting, 1)
  // Opened by hand, it keeps every row and its steps leave the order.
  assert.deepEqual(at(1, { ...five, waitingOpen: true }), { rolled: ["b"], ready: 6, working: 8, pinned: 3, waiting: 5 })
  // A single row has no step at all.
  assert.equal(maxLevel(input({ waiting: 1 })), maxLevel(input()))
})
