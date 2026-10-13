import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
import { PIN_OPTIMISM_MS, pinOverlayQueues } from "./optimisticPin.ts"
import { loudBands } from "./listBands.ts"
import { threadKey, type QueuesProject } from "./allQueues.ts"

const row = (id: string, over: Partial<ThreadView> = {}) =>
  ({ id, kind: "session", state: "open", runtime: "turn-idle", needsYou: false, subAgents: [], bgShells: [], ...over }) as unknown as ThreadView

const project = (running: ThreadView[], pinnedDone: ThreadView[] = []): QueuesProject =>
  ({ id: "p1", slug: "p", name: "p", open: true, stale: false, queued: [], running, snoozed: [], pinnedDone, doneCount: 0 }) as QueuesProject

test("an unpin moves the row out of the pinned band on the click, before the board says so", () => {
  const clicked = 1_000_000
  const projects = [project([row("a", { pinnedAt: "2026-10-01T00:00:00.000Z" }), row("b")])]
  assert.deepEqual(loudBands(projects[0]!, () => false).pinned.map((t) => t.id), ["a"])

  const out = pinOverlayQueues(projects, { [threadKey("p1", "a")]: { pinned: false, at: clicked } }, clicked + 5)
  const bands = loudBands(out[0]!, () => false)
  assert.deepEqual(bands.pinned.map((t) => t.id), [])
  assert.deepEqual(bands.working.map((t) => t.id).sort(), ["a", "b"])
})

test("a pin joins the pinned band on the click", () => {
  const clicked = 1_000_000
  const out = pinOverlayQueues([project([row("a")])], { [threadKey("p1", "a")]: { pinned: true, at: clicked } }, clicked + 5)
  assert.deepEqual(loudBands(out[0]!, () => false).pinned.map((t) => t.id), ["a"])
})

test("the overlay keeps identity once the board agrees, and lets go after its cap", () => {
  const clicked = 1_000_000
  const projects = [project([row("a")])]
  // Truth already unpinned: nothing to predict, so memoized rows see the same objects.
  assert.equal(pinOverlayQueues(projects, { [threadKey("p1", "a")]: { pinned: false, at: clicked } }, clicked + 5), projects)
  // A pin the board never confirmed stops being drawn once it outlives the cap.
  assert.equal(pinOverlayQueues(projects, { [threadKey("p1", "a")]: { pinned: true, at: clicked } }, clicked + PIN_OPTIMISM_MS + 1), projects)
  // Another project's same-named thread is not touched.
  assert.equal(pinOverlayQueues(projects, { [threadKey("p2", "a")]: { pinned: true, at: clicked } }, clicked + 5), projects)
})

test("an unpin reaches a pinned Done row too: it leaves the shelf on the click", () => {
  // The poll carries pinned Done threads apart (allQueues.ts `pinnedDone`), and their rows unpin from the
  // same hover strip as any other.
  const clicked = 1_000_000
  const shelved = row("done", { state: "archived", pinnedAt: "2026-10-01T00:00:00.000Z" })
  const projects = [project([], [shelved])]
  assert.deepEqual(loudBands(projects[0]!, () => false).pinned.map((t) => t.id), ["done"])
  const out = pinOverlayQueues(projects, { [threadKey("p1", "done")]: { pinned: false, at: clicked } }, clicked + 5)
  assert.deepEqual(loudBands(out[0]!, () => false).pinned.map((t) => t.id), [])
  assert.equal(out[0]!.queued, projects[0]!.queued, "the lists nothing touched keep their identity")
})
