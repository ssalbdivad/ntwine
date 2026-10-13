import { test } from "node:test"
import assert from "node:assert/strict"
import { fencedInteriors, insideFence } from "@ntwine/shared"

// The shared fenced-interior scan (packages/shared/src/code-fences.ts) — tested from here because the
// test runner's globs cover web/server/cli, not shared. Its consumers are questionBlocks.ts,
// fenceBlocks.ts and the server's hasQuestionBlock, each with their own integration tests.

const T3 = "`".repeat(3)
const T4 = "`".repeat(4)

test("no fences → no interiors, and nothing is inside", () => {
  assert.deepEqual(fencedInteriors("just prose\n\nmore prose"), [])
  assert.equal(insideFence("just prose")(3), false)
})

test("a plain fence's interior covers its body, not its delimiters", () => {
  const text = `before\n${T3}js\nconst x = 1\n${T3}\nafter`
  const [range] = fencedInteriors(text)
  assert.equal(text.slice(range[0], range[1]), "const x = 1\n")
  const inside = insideFence(text)
  assert.equal(inside(0), false) // "before"
  assert.equal(inside(text.indexOf("const")), true)
  assert.equal(inside(text.indexOf("after")), false)
})

test("a longer fence contains a shorter one — the ```` wrapper the protocol docs need", () => {
  const text = `${T4}\n${T3}question\nShip it?\n${T3}\n${T4}\ntail`
  const inside = insideFence(text)
  assert.equal(inside(text.indexOf(`${T3}question`)), true)
  assert.equal(inside(text.indexOf("tail")), false)
  assert.equal(fencedInteriors(text).length, 1, "the inner ``` never opens its own fence")
})

test("a closer must be bare — an info-string line can only ever open", () => {
  // ```` ```question ```` cannot close the outer ``` fence, which is what makes the nesting work at all.
  const text = `${T3}\n${T3}question\nShip it?\n${T3}\ntail`
  const inside = insideFence(text)
  assert.equal(inside(text.indexOf(`${T3}question`)), true)
  assert.equal(inside(text.indexOf("tail")), false) // the bare ``` on line 4 closed it
})

test("an UNCLOSED fence runs to the end of the text, exactly as a renderer treats it", () => {
  const text = `intro\n${T3}\nnever closed\nstill going`
  const [range] = fencedInteriors(text)
  assert.equal(range[1], text.length)
  assert.equal(insideFence(text)(text.indexOf("still going")), true)
})

test("tilde fences and up-to-3-space indents count; a 4-space indent is a code block, not a fence", () => {
  const tilde = `~~~\n${T3}question\nx\n~~~\ntail`
  assert.equal(insideFence(tilde)(tilde.indexOf(`${T3}question`)), true)
  const indented = `   ${T3}\nbody\n   ${T3}\ntail`
  assert.equal(insideFence(indented)(indented.indexOf("body")), true)
  // A backtick run does NOT close a tilde fence (different characters).
  const mixed = `~~~\n${T3}\nstill inside\n~~~\ntail`
  assert.equal(insideFence(mixed)(mixed.indexOf("still inside")), true)
  assert.equal(insideFence(mixed)(mixed.indexOf("tail")), false)
})

test("CRLF text keeps its offsets aligned", () => {
  const text = `${T3}\r\ninside\r\n${T3}\r\ntail`
  const inside = insideFence(text)
  assert.equal(inside(text.indexOf("inside")), true)
  assert.equal(inside(text.indexOf("tail")), false)
})
