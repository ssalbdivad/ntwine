import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
import { threadKey, type QueuesProject } from "./allQueues.ts"
import { listOverlay, loudBands } from "./listBands.ts"

// The project list's rows move the moment the operator acts, not a poll later: a reply, an answer or a
// Retry sets the thread to work (lib/steering.ts), a drawer's Mark as done files it (lib/optimisticArchive.ts).
// The rail did this until 2026-09-28; the list that replaced it showed the row vanish with its card and
// come back under Working when the poll caught up.

const NOW = 1_000_000
const ready = (id: string, over: Partial<ThreadView> = {}) =>
  ({
    id,
    kind: "session",
    state: "open",
    status: "active",
    runtime: "turn-idle",
    needsYou: true,
    spawnedAt: new Date(NOW - 600_000).toISOString(),
    lastUserAt: new Date(NOW - 600_000).toISOString(),
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  }) as unknown as ThreadView
const running = (id: string) => ready(id, { runtime: "running", needsYou: false, lastUserAt: new Date(NOW - 120_000).toISOString() })

const project = (id: string, queued: ThreadView[], working: ThreadView[] = [], pinnedDone: ThreadView[] = []) =>
  ({ id, slug: id, name: id, queued, running: working, snoozed: [], pinnedDone, doneCount: 0 }) as unknown as QueuesProject
const shown = () => false
const ids = (threads: readonly ThreadView[]) => threads.map((t) => t.id)

test("a thread replied to from its card leaves Ready for Working at once", () => {
  const p = project("alpha", [ready("fix-auth"), ready("docs")], [running("build")])
  const steered = { [threadKey("alpha", "fix-auth")]: NOW - 100 }
  const bands = loudBands(p, shown, listOverlay("alpha", false, steered, {}, NOW))
  assert.deepEqual(ids(bands.ready), ["docs"])
  // At the TOP of Working: the band orders by user recency, and the steer is the newest interaction.
  assert.deepEqual(ids(bands.working), ["fix-auth", "build"])
  assert.equal(bands.working[0]!.runtime, "running")
  // Its card is on its way out, so the cord no longer ties the row to it.
  assert.deepEqual([...bands.carded], ["docs"])
  assert.equal(bands.rows, 3)
})

test("another project's thread of the same name is untouched by that steer", () => {
  const steered = { [threadKey("alpha", "fix-auth")]: NOW - 100 }
  const bands = loudBands(project("beta", [ready("fix-auth")]), shown, listOverlay("beta", false, steered, {}, NOW))
  assert.deepEqual(ids(bands.ready), ["fix-auth"])
  assert.deepEqual(ids(bands.working), [])
})

test("a bare-slug steer is the page project's drawer, read for the page project alone", () => {
  const steered = { "fix-auth": NOW - 100 }
  const onPage = loudBands(project("alpha", [ready("fix-auth")]), shown, listOverlay("alpha", true, steered, {}, NOW))
  assert.deepEqual(ids(onPage.working), ["fix-auth"])
  const elsewhere = loudBands(project("beta", [ready("fix-auth")]), shown, listOverlay("beta", false, steered, {}, NOW))
  assert.deepEqual(ids(elsewhere.ready), ["fix-auth"])
})

test("server truth newer than the steer takes the row back", () => {
  // The tailer has looked since the send and says the thread is at rest again: that beats the guess.
  const answered = ready("fix-auth", { lastActivityAt: new Date(NOW - 50).toISOString() })
  const steered = { [threadKey("alpha", "fix-auth")]: NOW - 100 }
  const bands = loudBands(project("alpha", [answered]), shown, listOverlay("alpha", false, steered, {}, NOW))
  assert.deepEqual(ids(bands.ready), ["fix-auth"])
})

test("a drawer's Mark as done takes the page project's row out of its work in flight", () => {
  const bands = loudBands(project("alpha", [ready("fix-auth")], [running("build")]), shown, listOverlay("alpha", true, {}, { "fix-auth": NOW - 100 }, NOW))
  assert.deepEqual(ids(bands.ready), [])
  assert.deepEqual(ids(bands.working), ["build"])
  assert.equal(bands.rows, 1)
})

test("a Ready card hidden after the operator acted keeps its row, under Working", () => {
  const p = project("alpha", [ready("fix-auth"), ready("docs")], [running("build")])
  const hidden = (key: string) => key === threadKey("alpha", "fix-auth")
  const bands = loudBands(p, hidden, listOverlay("alpha", false, {}, {}, NOW))
  assert.deepEqual(ids(bands.ready), ["docs"])
  assert.deepEqual(ids(bands.working).sort(), ["build", "fix-auth"])
  assert.equal(bands.carded.has("fix-auth"), false)
})

test("every open thread lands in some band", () => {
  const p = project("alpha", [ready("a"), ready("b"), ready("c")], [running("d")])
  for (const hide of [[], ["a"], ["a", "b", "c"]]) {
    const bands = loudBands(p, (key) => hide.some((id) => key === threadKey("alpha", id)), listOverlay("alpha", false, {}, {}, NOW))
    assert.deepEqual([...ids(bands.pinned), ...ids(bands.ready), ...ids(bands.working)].sort(), ["a", "b", "c", "d"])
  }
})

test("with nothing recorded, the bands are the poll's", () => {
  const p = project("alpha", [ready("fix-auth")], [running("build")])
  const bands = loudBands(p, shown, listOverlay("alpha", true, {}, {}, NOW))
  assert.equal(bands.ready[0], p.queued[0])
  assert.equal(bands.working[0], p.running[0])
})

test("a pinned thread that is Done is still a Pinned row — the pin outranks Done, in every project", () => {
  // The pinned-Done hole: pins were read from the open lists alone, so a pinned thread finished in a
  // project the page was not on had no row on All projects.
  const shelved = ready("shelved", { state: "archived", needsYou: false, pinnedAt: new Date(NOW - 900_000).toISOString() })
  const open = ready("open-pin", { pinnedAt: new Date(NOW - 300_000).toISOString() })
  const bands = loudBands(project("beta", [open], [running("build")], [shelved]), shown, listOverlay("beta", false, {}, {}, NOW))
  assert.deepEqual(ids(bands.pinned), ["shelved", "open-pin"], "oldest pin first, whatever the state")
  assert.equal(bands.pinned[0]!.state, "archived", "drawn as Done (greyed by its row), not reopened")
  assert.deepEqual(ids(bands.ready), [])
  assert.deepEqual([...bands.carded], ["open-pin"], "a Done pin has no card to tie to")
  assert.equal(bands.rows, 3, "it counts as a row, so a project whose only pin is Done still lists it")
})
