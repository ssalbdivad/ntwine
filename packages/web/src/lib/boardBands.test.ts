import assert from "node:assert/strict"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import type { QueuesProject } from "./allQueues.ts"
import { boardBands } from "./boardBands.ts"

// A project's board lists upstream's bands (components/ProjectBoard.tsx): the shelf of pins, oldest first
// whatever each thread's state; Queue and Running from the poll, as the queue's cards are; Snoozed with no
// pinned thread in it; Done and External from the board, unknown until it is read.

const NOW = Date.now()
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const thread = (id: string, over: Partial<ThreadView> = {}) =>
  ({ id, kind: "session", state: "open", status: "active", runtime: "turn-idle", needsYou: true, spawnedAt: at(60), lastUserAt: at(60), lastActivityAt: at(30), ...over }) as unknown as ThreadView
const running = (id: string, over: Partial<ThreadView> = {}) => thread(id, { runtime: "running", needsYou: false, lastUserAt: at(2), ...over })
const snoozed = (id: string, over: Partial<ThreadView> = {}) => thread(id, { needsYou: false, snoozedUntil: new Date(NOW + 3_600_000).toISOString(), ...over })
const done = (id: string, over: Partial<ThreadView> = {}) => thread(id, { state: "archived", needsYou: false, ...over })
const project = (over: Partial<QueuesProject> = {}) =>
  ({ id: "p", slug: "p", name: "p", open: true, stale: false, queued: [], running: [], snoozed: [], pinnedDone: [], doneCount: 0, ...over }) as unknown as QueuesProject
const board = (threads: ThreadView[]) => ({ projectSlug: "p", threads }) as unknown as BoardSnapshot
const ids = (threads: readonly ThreadView[] | undefined) => threads?.map((t) => t.id)
const shown = () => false

test("the shelf is every pin, oldest first, whatever the state — a Done pin from the board among the open ones", () => {
  // The poll carries Done pins too since 2026-10-06 (`pinnedDone`); a board read ahead of it still adds its own.
  const p = project({
    queued: [thread("ready-pin", { pinnedAt: at(30) }), thread("q")],
    running: [running("running-pin", { pinnedAt: at(10) })],
    snoozed: [snoozed("snoozed-pin", { pinnedAt: at(20) }), snoozed("z")],
  })
  const bands = boardBands(p, board([done("done-pin", { pinnedAt: at(40) }), done("d")]), shown)
  assert.deepEqual(ids(bands.pinned), ["done-pin", "ready-pin", "snoozed-pin", "running-pin"])
  assert.deepEqual(ids(bands.ready), ["q"])
  assert.deepEqual(ids(bands.working), [])
  assert.deepEqual(ids(bands.snoozed), ["z"], "a pinned thread is on the shelf, not in Snoozed")
  assert.deepEqual(ids(bands.done), ["d"], "a Done pin is on the shelf, not in Done")
})

test("before the board is read, Done is unknown and the shelf is the poll's pins", () => {
  const bands = boardBands(project({ queued: [thread("ready-pin", { pinnedAt: at(5) })] }), undefined, shown)
  assert.equal(bands.done, undefined)
  assert.deepEqual(bands.external, [])
  assert.deepEqual(ids(bands.pinned), ["ready-pin"])
})

test("External is the board's foreign sessions, most recently touched first", () => {
  const ext = (id: string, minutes: number) => thread(id, { foreign: true, needsYou: false, lastActivityAt: at(minutes), lastAssistantAt: at(minutes), lastUserAt: at(minutes) } as Partial<ThreadView>)
  const bands = boardBands(project(), board([ext("older", 50), ext("newer", 5)]), shown)
  assert.deepEqual(ids(bands.external), ["newer", "older"])
})

test("a card being finished keeps its row, under Running, until the poll agrees (lib/listBands.ts)", () => {
  const bands = boardBands(project({ queued: [thread("q1"), thread("q2")] }), undefined, (key) => key === "p/q1")
  assert.deepEqual(ids(bands.ready), ["q2"])
  assert.deepEqual(ids(bands.working), ["q1"])
})

test("a Done pin the poll and the board both carry is on the shelf once", () => {
  const pin = done("done-pin", { pinnedAt: at(40) })
  const bands = boardBands(project({ pinnedDone: [pin] }), board([pin]), shown)
  assert.deepEqual(ids(bands.pinned), ["done-pin"])
})
