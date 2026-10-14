import assert from "node:assert/strict"
import test from "node:test"
import { composerRail, SEND_SPLIT_WIDTH } from "./iconRhythm.ts"

// The offsets every composer draws, as Tailwind classes measured with scripts/ink-gaps.mjs.
test("the rail keeps its measured offsets", () => {
  assert.deepEqual(composerRail({}), { right: { send: 8, paperclip: 44 }, reserve: 80 })
  assert.deepEqual(composerRail({ lead: true }), { right: { send: 8, paperclip: 44, lead: 71 }, reserve: 107 })
  assert.deepEqual(composerRail({ lead: true, perm: true }), { right: { send: 8, paperclip: 44, lead: 71, perm: 98 }, reserve: 134 })
})

// The thread composer's Send is the split button (word, hairline, caret). It is wider than the square
// and nothing else about the rail changes: the same gaps, measured from its left edge instead.
test("a wider Send moves every mark to its left by exactly the extra width, on whole pixels", () => {
  assert.equal(SEND_SPLIT_WIDTH, 69.5)
  const extra = Math.ceil(SEND_SPLIT_WIDTH) - 28
  for (const present of [{}, { lead: true }, { lead: true, perm: true }]) {
    const square = composerRail(present)
    const split = composerRail({ ...present, sendWidth: SEND_SPLIT_WIDTH })
    assert.equal(split.right.send, square.right.send, "Send keeps its inset from the box's right edge")
    for (const mark of ["paperclip", "lead", "perm"] as const) {
      if (square.right[mark] === undefined) continue
      assert.equal(split.right[mark], square.right[mark]! + extra, mark)
      assert.ok(Number.isInteger(split.right[mark]), `${mark} sits on a whole pixel`)
    }
    assert.equal(split.reserve, square.reserve + extra)
  }
})
