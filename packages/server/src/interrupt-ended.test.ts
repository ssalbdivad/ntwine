import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isInterruptEndedWake } from "@ntwine/shared"
import { createStorage, type Storage } from "./storage.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import type { RetiredSubAgentView, SessionTelemetry, SubAgentView } from "./tailer.ts"
import { noteSubAgentsEndedByInterrupt, runningSubAgentsOf } from "./interrupt-ended.ts"

function tmpStorage(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-intr-")), "ui.db"), "p")
}

const child = (id: string, over: Partial<SubAgentView> = {}): SubAgentView => ({
  id, label: `child ${id}`, startedAt: "2026-09-24T03:00:00.000Z", state: "running", taskId: `a-${id}`, ...over,
})
const tele = (subAgents: SubAgentView[], retiredSubAgents: RetiredSubAgentView[] = []): SessionTelemetry =>
  ({ turn: "in-flight", permPrompt: false, subAgents, bgShells: [], retiredSubAgents, pendingQuestion: false }) as SessionTelemetry
const retired = (id: string, status: RetiredSubAgentView["status"]): RetiredSubAgentView =>
  ({ id, taskId: `a-${id}`, label: `child ${id}`, status, finishedAt: "2026-09-24T03:11:32.528Z" })

// The snapshot is the set the interrupt can kill: running children only, by the dispatch id the tailer
// keys on, carrying the runtime id the WORKER knows them by (the one it writes in an `agents:` line).
test("runningSubAgentsOf keeps running children only, with the runtime id the worker was shown", () => {
  const got = runningSubAgentsOf(tele([child("t1"), child("t2", { state: "rested" }), child("t3", { state: "stale" }), child("t4", { taskId: undefined })]))
  assert.deepEqual(got, [{ id: "t1", taskId: "a-t1", label: "child t1" }, { id: "t4", label: "child t4" }])
  assert.deepEqual(runningSubAgentsOf(undefined), [])
})

// THE CASE FROM THE NUB THREAD: the child is listed the instant before the interrupt, the tailer retires
// it KILLED a moment later, and the worker is handed one note naming that child by the id it would have
// parked on.
test("a child the tailer retires as killed after the interrupt is named in one queued note", async () => {
  const storage = tmpStorage()
  const reads: SessionTelemetry[] = [tele([child("t1")]), tele([child("t1")]), tele([], [retired("t1", "killed")])]
  const tailer = { get: () => reads.length > 1 ? reads.shift()! : reads[0] }
  const before = runningSubAgentsOf(tele([child("t1")]))
  await noteSubAgentsEndedByInterrupt({ tailer, storage, pollMs: 1 }, { slug: "s", sessionId: "sid", before, interruptedAtMs: 1_000 })
  const rows = createWakeDeliveryStore(storage.scope).list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fenceId, "interrupt-ended:1000")
  assert.ok(isInterruptEndedWake(rows[0].message))
  assert.match(rows[0].message, /- `a-t1` — child t1/)
  assert.match(rows[0].message, /refused as NOT RUNNING/)
  storage.close()
})

// A child the tailer has NOT retired when the wait runs out is not reported: the note names what ntwine
// saw killed, never what it presumed. The one that was killed is still reported.
test("only the children that were actually killed are named; a survivor is left out", async () => {
  const storage = tmpStorage()
  let ms = 0
  const tailer = { get: () => tele([child("survivor")], [retired("victim", "killed")]) }
  const before = runningSubAgentsOf(tele([child("survivor"), child("victim")]))
  await noteSubAgentsEndedByInterrupt(
    { tailer, storage, pollMs: 1, maxWaitMs: 5, now: () => (ms += 3) },
    { slug: "s", sessionId: "sid", before, interruptedAtMs: 7 },
  )
  const rows = createWakeDeliveryStore(storage.scope).list()
  assert.equal(rows.length, 1)
  assert.match(rows[0].message, /- `a-victim` — child victim/)
  assert.doesNotMatch(rows[0].message, /survivor/)
  storage.close()
})

// SINCE ff71234e an interrupt spares the children, so the common case is every child surviving — and a
// child that FINISHES on its own inside the window is not the interrupt's doing: its report reaches the
// worker by the ordinary path, and naming it here would tell the worker to re-dispatch finished work.
test("a child that completed on its own in the window is not blamed on the interrupt", async () => {
  const storage = tmpStorage()
  const tailer = { get: () => tele([], [retired("t1", "completed"), retired("t2", "failed")]) }
  const before = runningSubAgentsOf(tele([child("t1"), child("t2")]))
  await noteSubAgentsEndedByInterrupt({ tailer, storage, pollMs: 1 }, { slug: "s", sessionId: "sid", before, interruptedAtMs: 9 })
  assert.deepEqual(createWakeDeliveryStore(storage.scope).list(), [])
  storage.close()
})

test("nothing is queued when no child was running, or when every child survived", async () => {
  const storage = tmpStorage()
  let ms = 0
  const tailer = { get: () => tele([child("t1")]) }
  await noteSubAgentsEndedByInterrupt({ tailer, storage }, { slug: "s", sessionId: "sid", before: [], interruptedAtMs: 1 })
  await noteSubAgentsEndedByInterrupt(
    { tailer, storage, pollMs: 1, maxWaitMs: 2, now: () => (ms += 5) },
    { slug: "s", sessionId: "sid", before: runningSubAgentsOf(tele([child("t1")])), interruptedAtMs: 2 },
  )
  assert.deepEqual(createWakeDeliveryStore(storage.scope).list(), [])
  storage.close()
})

// One interrupt, one note: the fence id is the interrupt's instant, so a second enqueue for the same
// interrupt (a retry, a double call) lands on the existing row.
test("the same interrupt never queues two notes", async () => {
  const storage = tmpStorage()
  const tailer = { get: () => tele([], [retired("t1", "killed")]) }
  const before = runningSubAgentsOf(tele([child("t1")]))
  for (let i = 0; i < 2; i++) {
    await noteSubAgentsEndedByInterrupt({ tailer, storage }, { slug: "s", sessionId: "sid", before, interruptedAtMs: 42 })
  }
  assert.equal(createWakeDeliveryStore(storage.scope).list().length, 1)
  storage.close()
})
