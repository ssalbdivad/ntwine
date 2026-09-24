import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultCrossProjectFocus } from "./crossProject.ts"

const card = (id: string, lastOpenedAt: string, stale = false) => ({ id, slug: `${id}-slug`, stale, lastOpenedAt })

test("/ focuses the project this browser was last focused on", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z"), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "b"), "b-slug")
})

test("without a usable memory, / focuses the most recently opened project", () => {
  const cards = [card("a", "2026-09-20T10:00:00Z"), card("b", "2026-09-24T10:00:00Z"), card("c", "2026-09-22T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, null), "b-slug")
  // A remembered project that has since been removed is not a reason to land nowhere.
  assert.equal(defaultCrossProjectFocus(cards, "gone"), "b-slug")
})

test("a project whose directory is gone is never the focus", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z", true), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "a"), "b-slug", "remembered but stale")
  assert.equal(defaultCrossProjectFocus(cards, null), "b-slug", "most recent but stale")
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-24T10:00:00Z", true)], null), undefined)
  assert.equal(defaultCrossProjectFocus([], null), undefined)
})

test("a project this server has not opened is not landed on while an open one exists", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z"), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "a", new Set(["b"])), "b-slug", "remembered but not open")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set(["b"])), "b-slug", "most recent but not open")
  // Nothing open yet (a boot still opening them): land as if the list were unknown.
  assert.equal(defaultCrossProjectFocus(cards, "b", new Set()), "b-slug")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set()), "a-slug")
})
