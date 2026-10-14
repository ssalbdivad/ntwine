import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultCrossProjectFocus, stepPick } from "./crossProject.ts"

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

// The Home workspace is on every machine and was never "opened" in a terminal. Falling back to it would
// mean an empty machine never shows the welcome page that adds its first project.
test("the Home workspace is focused only when chosen", () => {
  const home = { id: "home-id", slug: "home", stale: false, lastOpenedAt: "1970-01-01T00:00:00.000Z", home: true as const }
  assert.equal(defaultCrossProjectFocus([home], null), undefined, "an empty machine still welcomes")
  assert.equal(defaultCrossProjectFocus([home], "home-id"), "home", "chosen, it is the focus")
  // Even one opened more recently than every project — the timestamp is not what excludes it.
  const recent = { ...home, lastOpenedAt: "2026-09-28T10:00:00Z" }
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-20T10:00:00Z"), recent], null), "a-slug")
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-20T10:00:00Z"), recent], "home-id", new Set(["home-id"])), "home")
})

// THE ORDER (2026-09-30): pick, then last focused, then where `ntwine` was last run, then most recently
// opened. Every launch lands on All projects at a bare `/`, so the address no longer names the project the
// launcher ran in; the reproduction was a stack launched from `storefront` whose prompt box aimed at
// `billing-api`, registered a moment later and so "opened" more recently.
const launched = (id: string, lastOpenedAt: string, lastLaunchedAt?: string, stale = false) => ({ ...card(id, lastOpenedAt, stale), lastLaunchedAt })

test("with no pick and no focus here, the box aims at the project ntwine was last run in", () => {
  const cards = [launched("billing-api", "2026-09-30T10:00:05Z"), launched("storefront", "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, null), "storefront-slug", "a launch outranks a later registration")
  // The most recent launch wins, whichever project registered last.
  const both = [launched("a", "2026-09-30T12:00:00Z", "2026-09-29T10:00:00Z"), launched("b", "2026-09-28T10:00:00Z", "2026-09-30T09:00:00Z")]
  assert.equal(defaultCrossProjectFocus(both, null), "b-slug")
})

test("the pick, then the last-focused project, each outrank the launch", () => {
  const cards = [launched("a", "2026-09-30T10:00:00Z"), launched("b", "2026-09-30T10:00:00Z"), launched("c", "2026-09-30T10:00:00Z", "2026-09-30T11:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "a", undefined, "b"), "a-slug", "an explicit pick is first")
  assert.equal(defaultCrossProjectFocus(cards, null, undefined, "b"), "b-slug", "then the project last focused")
  assert.equal(defaultCrossProjectFocus(cards, "gone", undefined, "b"), "b-slug", "a pick since removed falls through to the focus")
  assert.equal(defaultCrossProjectFocus(cards, null, undefined, "gone"), "c-slug", "a focus since removed falls through to the launch")
  assert.equal(defaultCrossProjectFocus(cards, null, undefined, null), "c-slug")
})

test("a launch is skipped where its project is gone or not open, like every other step", () => {
  const cards = [launched("a", "2026-09-30T10:00:00Z", "2026-09-30T12:00:00Z", true), launched("b", "2026-09-30T10:00:00Z", "2026-09-30T11:00:00Z"), launched("c", "2026-09-30T11:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, null), "b-slug", "the newest launch's directory is gone")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set(["c"])), "c-slug", "the launched project is not open here")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set(["c"]), "b"), "c-slug", "nor is the focused one")
  // Home is never the fallback, even stamped (it cannot be launched from, but a stamp is no reason).
  const home = { id: "home-id", slug: "home", stale: false, lastOpenedAt: "2026-09-30T13:00:00Z", lastLaunchedAt: "2026-09-30T13:00:00Z", home: true as const }
  assert.equal(defaultCrossProjectFocus([home, launched("c", "2026-09-30T11:00:00Z")], null), "c-slug")
  assert.equal(defaultCrossProjectFocus([home, launched("c", "2026-09-30T11:00:00Z")], null, undefined, "home-id"), "home", "focused, it is the box's")
})

const project = (slug: string, open = true, stale = false) => ({ slug, open, stale })

test("⌥↓ / ⌥↑ step the box through the picker's order, wrapping round at either end", () => {
  const projects = [project("a"), project("b"), project("c")]
  assert.equal(stepPick(projects, "a", 1)?.slug, "b")
  assert.equal(stepPick(projects, "c", 1)?.slug, "a")
  assert.equal(stepPick(projects, "b", -1)?.slug, "a")
  assert.equal(stepPick(projects, "a", -1)?.slug, "c")
  // A focus the list does not hold yet (a project registered a moment ago) steps onto an end.
  assert.equal(stepPick(projects, "gone", 1)?.slug, "a")
  assert.equal(stepPick(projects, "gone", -1)?.slug, "c")
  assert.equal(stepPick(projects, undefined, 1)?.slug, "a")
})

test("a step passes over a project that cannot take the draft it carries", () => {
  const projects = [project("a"), project("b", false), project("c", true, true), project("d")]
  assert.equal(stepPick(projects, "a", 1)?.slug, "d", "not open, then a directory that is gone")
  assert.equal(stepPick(projects, "d", -1)?.slug, "a")
  assert.equal(stepPick(projects, "d", 1)?.slug, "a")
  // A focus that is not open itself (chosen from the menu) still steps on to one that is.
  assert.equal(stepPick(projects, "b", 1)?.slug, "d")
  assert.equal(stepPick(projects, "b", -1)?.slug, "a")
})

test("with nowhere else to go, the key is left to the browser", () => {
  assert.equal(stepPick([project("a")], "a", 1), undefined)
  assert.equal(stepPick([project("a"), project("b", false)], "a", -1), undefined)
  assert.equal(stepPick([], undefined, 1), undefined)
})
