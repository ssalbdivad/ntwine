import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { createQueueClock } from "./queue-clock.ts"

// THE QUEUE CLOCK (queue-clock.ts): the queue orders by when a thread ENTERED it, and a thread keeps
// that instant for as long as it stays queued. These pin the four rules that make it a queue rather than
// a stack, plus the boot baseline that keeps a restart from reshuffling the line.

const at = (hhmm: string) => `2026-09-24T${hhmm}:00.000Z`
const ms = (hhmm: string) => Date.parse(at(hhmm))

function thread(id: string, needsYou: boolean, rested: string): ThreadView {
  return { id, kind: "session", needsYou, lastAssistantAt: at(rested) } as unknown as ThreadView
}

function harness(stored: Record<string, string> = {}) {
  const saves: [string, string | null][] = []
  const clock = createQueueClock({
    load: () => new Map(Object.entries(stored)),
    save: (t, value) => void saves.push([t.id, value]),
  })
  const run = (nowHHMM: string, ...threads: ThreadView[]) => {
    clock.stamp(threads, ms(nowHHMM))
    return Object.fromEntries(threads.map((t) => [t.id, t.queuedAt]))
  }
  return { run, saves }
}

test("a plain rest enters the queue at its rest time, so ordinary arrivals keep the order they always had", () => {
  const { run, saves } = harness()
  run("10:00", thread("a", false, "09:00"))
  assert.deepEqual(run("10:06", thread("a", true, "10:05")), { a: at("10:05") })
  assert.deepEqual(saves, [["a", at("10:05")]])
})

test("a thread that rested behind a wait enters when the wait lets go, not at its old rest time", () => {
  // The reported shape: rested at 09:00, held out of the queue (CI, a sub-agent, a snooze), let in at
  // 12:30. Its stamp is bounded below by the last assembly that saw it OUT — never the 09:00 rest that
  // would sort it ahead of everything already waiting.
  const { run } = harness()
  run("12:29", thread("held", false, "09:00"))
  assert.deepEqual(run("12:30", thread("held", true, "09:00")), { held: at("12:29") })
})

test("a queued thread keeps its place however long it waits, and saves only on the edge", () => {
  const { run, saves } = harness()
  run("10:00", thread("a", false, "09:00"))
  run("10:06", thread("a", true, "10:05"))
  // Twelve more assemblies while it waits: nothing moves and nothing is written.
  for (const now of ["10:07", "10:30", "11:00", "12:00"]) assert.deepEqual(run(now, thread("a", true, "10:05")), { a: at("10:05") })
  assert.equal(saves.length, 1)
})

test("leaving the queue forgets the stamp, so the next entry joins the back of the line", () => {
  const { run, saves } = harness()
  run("10:00", thread("a", false, "09:00"))
  run("10:06", thread("a", true, "10:05"))
  // The human snoozes it (no new output — the rest time never moves), then the snooze ends.
  assert.deepEqual(run("10:10", thread("a", false, "10:05")), { a: undefined })
  run("11:59", thread("a", false, "10:05"))
  assert.deepEqual(run("12:00", thread("a", true, "10:05")), { a: at("11:59") })
  assert.deepEqual(saves, [["a", at("10:05")], ["a", null], ["a", at("11:59")]])
})

test("the first assembly after boot is a baseline: stored stamps hold and none are cleared", () => {
  // `waiting` entered at 12:30 off a wait (its rest was 09:00) — the restart must not hand it back its
  // 09:00. `left` was stamped but is out of the queue on the first reading: a baseline clears nothing,
  // so a board still warming up cannot throw a thread's place away. The SECOND reading clears it.
  const { run, saves } = harness({ waiting: at("12:30"), left: at("11:00") })
  assert.deepEqual(run("13:00", thread("waiting", true, "09:00"), thread("left", false, "11:00")), { waiting: at("12:30"), left: undefined })
  assert.deepEqual(saves, [])
  run("13:01", thread("waiting", true, "09:00"), thread("left", false, "11:00"))
  assert.deepEqual(saves, [["left", null]])
})

test("a stored stamp the agent has since spoken past is refused at boot — it left and re-entered while the server was down", () => {
  const { run, saves } = harness({ a: at("10:00") })
  assert.deepEqual(run("13:00", thread("a", true, "12:45")), { a: at("12:45") })
  assert.deepEqual(saves, [["a", at("12:45")]])
})

test("a thread with no usable time at all enters now, never at the epoch", () => {
  const { run } = harness()
  const bare = { id: "bare", kind: "command", needsYou: true } as unknown as ThreadView
  assert.deepEqual(run("10:00", bare), { bare: at("10:00") })
})
