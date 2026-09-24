import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { optimisticallyArchived, ARCHIVE_OPTIMISM_MS } from "./optimisticArchive.ts"
import { needsAction, sectionOf } from "../groups.ts"

// A resting session thread the server still lists as open and queued — the exact row that sat in
// Rested for the whole completeThread round-trip after the operator clicked Mark as done.
const resting = (over: Partial<ThreadView> = {}) => ({
  id: "t",
  kind: "session",
  state: "open",
  runtime: "turn-idle",
  needsYou: true,
  subAgents: [],
  bgShells: [],
  ...over,
} as unknown as ThreadView)

test("a clicked Mark-as-done lands the row under Done immediately, not after the round-trip", () => {
  const clicked = 1_000_000
  const row = resting()
  assert.equal(sectionOf(row), "active", "before the click it is in the Active/Rested section")

  const optimistic = optimisticallyArchived(row, clicked, clicked + 5)
  assert.equal(optimistic.state, "archived")
  assert.equal(sectionOf(optimistic), "inactive", "the rail puts it under Done on the click alone")
  assert.equal(needsAction(optimistic), false, "and it stops counting as something the human owes")
})

test("a still-running thread is left where it is — that completion asks first", () => {
  const clicked = 1_000_000
  // The overlay does not predict a live session: the server asks before completing one, so the row
  // stays where it is until the human's answer lands.
  const running = resting({ runtime: "running" })
  assert.equal(optimisticallyArchived(running, clicked, clicked + 5), running)
  assert.equal(sectionOf(optimisticallyArchived(running, clicked, clicked + 5)), "active")
})

test("server truth reclaims the row by identity once the board agrees", () => {
  const clicked = 1_000_000
  const confirmed = resting({ state: "archived" })
  assert.equal(optimisticallyArchived(confirmed, clicked, clicked + 5), confirmed)
})

test("the hint expires rather than hiding a thread whose completion never landed", () => {
  const clicked = 1_000_000
  assert.equal(optimisticallyArchived(resting(), clicked, clicked + ARCHIVE_OPTIMISM_MS - 1).state, "archived")
  assert.equal(optimisticallyArchived(resting(), clicked, clicked + ARCHIVE_OPTIMISM_MS + 1).state, "open")
})

test("a thread nobody completed is returned untouched", () => {
  const row = resting()
  assert.equal(optimisticallyArchived(row, undefined, 1_000_000), row)
})
