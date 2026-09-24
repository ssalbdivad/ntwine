import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { createQueueClock } from "./queue-clock.ts"

// THE QUEUE CLOCK (queue-clock.ts): the queue orders by when a thread ENTERED it, and a thread keeps
// that instant for as long as it stays queued. These pin the four rules that make it a queue rather than
// a stack, plus the boot rules that keep a restart from reshuffling the line.

// "HH:MM", or "HH:MM:SS" where a test needs an instant between two assemblies.
const at = (time: string) => `2026-09-24T${time.length === 5 ? `${time}:00` : time}.000Z`
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
  // Every reading is vouched for unless its slug is in `unknown` — a row the tailer has not primed yet.
  const unknown = new Set<string>()
  const run = (nowHHMM: string, ...threads: ThreadView[]) => {
    clock.stamp(threads, ms(nowHHMM), (t) => !unknown.has(t.id))
    return Object.fromEntries(threads.map((t) => [t.id, t.queuedAt]))
  }
  return { run, saves, unknown }
}

test("a plain rest enters the queue at its rest time, so ordinary arrivals keep the order they always had", () => {
  const { run, saves } = harness()
  run("10:00", thread("a", false, "09:00"))
  assert.deepEqual(run("10:06", thread("a", true, "10:05")), { a: at("10:05") })
  assert.deepEqual(saves, [["a", at("10:05")]])
})

test("a thread that rested behind a wait enters when the wait lets go, not at its old rest time", () => {
  // The reported shape: rested at 09:00, held out of the queue (CI, a sub-agent, a snooze), let in
  // between the 12:29 sighting and the 12:30 one. It is stamped at the LATE end of that window — never
  // the 09:00 rest that sorted it ahead of everything already waiting, and not 12:29 either, which would
  // put it ahead of `quick`, a plain rest that landed inside the window and is already on screen.
  const { run } = harness()
  run("12:29", thread("held", false, "09:00"), thread("quick", false, "12:00"))
  assert.deepEqual(run("12:30", thread("held", true, "09:00"), thread("quick", true, "12:29:30")), { held: at("12:30"), quick: at("12:29:30") })
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
  assert.deepEqual(run("12:00", thread("a", true, "10:05")), { a: at("12:00") })
  assert.deepEqual(saves, [["a", at("10:05")], ["a", null], ["a", at("12:00")]])
})

test("a boot keeps every place in line while the tailer is still priming rows", () => {
  // `waiting` entered at 12:30 off a wait (its rest was 09:00). After a restart the board runs before
  // the tailer has primed it, and an unprimed headless row reads as RUNNING — out of the queue. That
  // reading is unknown, so it clears nothing; the first real reading finds the stamp where it was.
  const { run, saves, unknown } = harness({ waiting: at("12:30"), left: at("11:00") })
  unknown.add("waiting").add("left")
  for (const now of ["13:00", "13:00", "13:01"]) {
    assert.deepEqual(run(now, thread("waiting", false, "09:00"), thread("left", false, "11:00")), { waiting: undefined, left: undefined })
  }
  assert.deepEqual(saves, [])
  unknown.clear()
  // `left` left the queue while the server was down: its first KNOWN reading out of the queue clears it.
  assert.deepEqual(run("13:02", thread("waiting", true, "09:00"), thread("left", false, "11:00")), { waiting: at("12:30"), left: undefined })
  assert.deepEqual(saves, [["left", null]])
})

test("an unknown reading that happens to be queued shows the stamp it has and decides nothing", () => {
  const { run, saves, unknown } = harness({ a: at("10:00") })
  unknown.add("a").add("b")
  assert.deepEqual(run("13:00", thread("a", true, "12:45"), thread("b", true, "12:50")), { a: at("10:00"), b: undefined })
  assert.deepEqual(saves, [])
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
