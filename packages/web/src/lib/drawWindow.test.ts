import { test } from "node:test"
import assert from "node:assert/strict"
import { drawWindowStart } from "./drawWindow.ts"

// A turn every 3 messages: user, assistant, assistant — ids m0…m(n-1), oldest first.
const thread = (n: number, from = 0) =>
  Array.from({ length: n }, (_, k) => ({ sourceId: `m${from + k}`, role: (from + k) % 3 === 0 ? "user" : "assistant" }))
const LIMIT = 10
const STEP = 5

test("a first draw of a long list takes the newest `limit`, moved back to the human turn that opens it", () => {
  const all = thread(30)
  // 30 - 10 = 20 is an assistant row; the turn opens at 18.
  assert.deepEqual(drawWindowStart(all, null, false, LIMIT, STEP), { start: 18, anchor: "m18" })
})

test("under the limit, prepended history is taken in up to it, never giving back what was drawn", () => {
  const latest = thread(6, 24)
  const first = drawWindowStart(latest, null, false, LIMIT, STEP)
  assert.deepEqual(first, { start: 0, anchor: "m24" })
  // Six older messages land above: 12 loaded, room for 10 — back to the turn at m18 (index 0).
  const paged = [...thread(6, 18), ...latest]
  assert.deepEqual(drawWindowStart(paged, first.anchor, false, LIMIT, STEP), { start: 0, anchor: "m18" })
})

test("past the limit, a prepended page leaves the window on the same message", () => {
  const all = thread(30)
  const { anchor } = drawWindowStart(all, null, false, LIMIT, STEP)
  const paged = [...thread(9, -9).map((m, k) => ({ ...m, sourceId: `p${k}` })), ...all]
  assert.deepEqual(drawWindowStart(paged, anchor, false, LIMIT, STEP), { start: 9 + 18, anchor: "m18" })
})

test("appends never move the start, so the window grows with the live tail", () => {
  const all = thread(30)
  const { anchor } = drawWindowStart(all, null, false, LIMIT, STEP)
  assert.deepEqual(drawWindowStart([...all, ...thread(20, 30)], anchor, false, LIMIT, STEP), { start: 18, anchor: "m18" })
})

test("the reader reaching the top widens by `step` to a human turn, and stops at the head", () => {
  const all = thread(30)
  // 18 - 5 = 13, an assistant row; its turn opens at 12.
  assert.deepEqual(drawWindowStart(all, "m18", true, LIMIT, STEP), { start: 12, anchor: "m12" })
  assert.deepEqual(drawWindowStart(all, "m3", true, LIMIT, STEP), { start: 0, anchor: "m0" })
  assert.deepEqual(drawWindowStart(all, "m0", true, LIMIT, STEP), { start: 0, anchor: "m0" })
})

test("an anchor no longer in the list re-derives the newest `limit`", () => {
  assert.deepEqual(drawWindowStart(thread(30), "gone", false, LIMIT, STEP), { start: 18, anchor: "m18" })
})
