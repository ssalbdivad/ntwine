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

function harness(stored: Record<string, string> = {}, alive?: string) {
  const saves: [string, string | null][] = []
  const alives: string[] = []
  const clock = createQueueClock({
    load: () => ({ stamps: new Map(Object.entries(stored)), ...(alive ? { alive } : {}) }),
    // Sessions and command threads persist in production; anything else stands in for a non-durable kind.
    persists: (t) => t.kind === "session" || t.kind === "command",
    save: (t, value) => void saves.push([t.id, value]),
    saveAlive: (value) => void alives.push(value),
  })
  // Every reading is vouched for unless its slug is in `unknown` — a row the tailer has not primed yet.
  const unknown = new Set<string>()
  // Out of the queue behind a hold a wake follows (`parked`), and a reading that must surface at once.
  const parked = new Set<string>()
  const urgent = new Set<string>()
  const run = (nowHHMM: string, ...threads: ThreadView[]) => {
    clock.stamp(threads, ms(nowHHMM), { known: (t) => !unknown.has(t.id), parked: (t) => parked.has(t.id), urgent: (t) => urgent.has(t.id) })
    return Object.fromEntries(threads.map((t) => [t.id, t.queuedAt]))
  }
  return { run, saves, unknown, alives, parked, urgent, clock }
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

test("a restart bridges its gap with the last instant the old server was watching", () => {
  // The old server last wrote `alive` at 12:00, then went down. Neither thread had a stamp: both were
  // out of the queue as of 12:00. `snoozed` rested at 09:00 and its snooze ran out while nobody watched —
  // a release, so it joins the BACK. `fresh` rested at 12:30, after the old server's last sighting — a
  // plain rest, so it keeps its rest time and stays ahead of `snoozed`.
  const { run } = harness({}, at("12:00"))
  assert.deepEqual(run("13:00", thread("snoozed", true, "09:00"), thread("fresh", true, "12:30")), { snoozed: at("13:00"), fresh: at("12:30") })
})

test("a thread whose stamp is not durable ignores the bridge, and nothing is written for it", () => {
  const { run, saves } = harness({}, at("12:00"))
  const ephemeral = { id: "e-1", kind: "ephemeral", needsYou: true, lastActivityAt: at("11:40") } as unknown as ThreadView
  assert.deepEqual(run("13:00", ephemeral), { "e-1": at("11:40") })
  assert.deepEqual(saves, [])
})

test("a boot's unknown readings are not sightings out: a thread that rested while no server watched keeps its rest", () => {
  // It was running when the old server last watched (12:00) and its detached worker rested at 12:30 with
  // no server up. Until the tailer primes it, the new board reads it RUNNING — out of the queue — but
  // that reading is unknown. Taken as a sighting, it would push the entry to the boot's prime time.
  const { run, unknown } = harness({}, at("12:00"))
  unknown.add("z")
  for (const now of ["13:00", "13:00:05"]) run(now, thread("z", false, "12:30"))
  unknown.clear()
  assert.deepEqual(run("13:00:10", thread("z", true, "12:30")), { z: at("12:30") })
})

test("a stored stamp is checked ONCE: whatever its agent writes while it stays queued never re-dates it", () => {
  const { run, saves } = harness({ a: at("10:00") })
  assert.deepEqual(run("13:00", thread("a", true, "10:00")), { a: at("10:00") })
  // Queued mid-turn (a permission prompt, a silent turn): the agent writes on, and the stamp holds.
  assert.deepEqual(run("13:01", thread("a", true, "13:00:30")), { a: at("10:00") })
  assert.deepEqual(saves, [])
})

test("a stamp refused as stale falls back to its own rest, not the bridge — it was queued, not out", () => {
  const { run } = harness({ a: at("10:00"), b: at("10:30") }, at("12:59:45"))
  assert.deepEqual(run("13:00", thread("a", true, "11:00"), thread("b", true, "10:30")), { a: at("11:00"), b: at("10:30") })
})

test("the clock records that it is watching only once every durable thread has a known reading", () => {
  // A boot that dies before it has read `slow` must not leave an instant claiming it was seen out.
  const { run, unknown, alives } = harness()
  unknown.add("slow")
  run("10:00:00", thread("fast", true, "09:00"), thread("slow", false, "09:30"))
  run("10:00:20", thread("fast", true, "09:00"), thread("slow", false, "09:30"))
  assert.deepEqual(alives, [])
  unknown.clear()
  run("10:00:40", thread("fast", true, "09:00"), thread("slow", false, "09:30"))
  assert.deepEqual(alives, [at("10:00:40")])
})

test("the first boot after the clock landed has no such instant, and keeps the order the queue always had", () => {
  const { run } = harness()
  assert.deepEqual(run("13:00", thread("snoozed", true, "09:00"), thread("fresh", true, "12:30")), { snoozed: at("09:00"), fresh: at("12:30") })
})

test("the clock records that it is watching at most every 15s, starting with its first assembly", () => {
  const { run, alives } = harness()
  for (const now of ["10:00:00", "10:00:05", "10:00:14", "10:00:15", "10:00:29", "10:00:31"]) run(now, thread("a", false, "09:00"))
  assert.deepEqual(alives, [at("10:00:00"), at("10:00:15"), at("10:00:31")])
})

test("a thread with no usable time at all enters now, never at the epoch", () => {
  const { run } = harness()
  const bare = { id: "bare", kind: "command", needsYou: true } as unknown as ThreadView
  assert.deepEqual(run("10:00", bare), { bare: at("10:00") })
})

test("an entry off a park is withheld for 12s, then joins the back at the instant it goes in", () => {
  // `parked` rested at 09:00 behind a sub-agent; the child returns at 10:00:01, and the parent's wake is
  // due any second. Meanwhile `quick` rests plainly at 10:00:05 and enters at once, as it always has.
  const { run, parked, saves, clock } = harness()
  parked.add("parked")
  run("10:00:00", thread("parked", false, "09:00"), thread("quick", false, "09:30"))
  const released = thread("parked", true, "09:00")
  assert.deepEqual(run("10:00:01", released), { parked: undefined })
  assert.equal(released.needsYou, false, "withheld: the board neither queues nor notifies it")
  assert.equal(released.queueSettling, true, "…and the client is told no park stands")
  assert.equal(clock.nextEntryAt(ms("10:00:01")), ms("10:00:13"))
  assert.deepEqual(run("10:00:06", thread("parked", true, "09:00"), thread("quick", true, "10:00:05")), { parked: undefined, quick: at("10:00:05") })
  // No wake came. It goes in when the window closes — behind `quick`, not at its 09:00 rest.
  const entered = thread("parked", true, "09:00")
  assert.deepEqual(run("10:00:13", entered, thread("quick", true, "10:00:05")), { parked: at("10:00:13"), quick: at("10:00:05") })
  assert.equal(entered.needsYou, true)
  assert.equal(entered.queueSettling, undefined)
  assert.equal(clock.nextEntryAt(ms("10:00:13")), undefined)
  assert.deepEqual(saves, [["quick", at("10:00:05")], ["parked", at("10:00:13")]])
})

test("a worker woken inside the window never reaches the queue, and its next rest is an ordinary one", () => {
  const { run, parked, saves, clock } = harness()
  parked.add("p")
  run("10:00:00", thread("p", false, "09:00"))
  run("10:00:01", thread("p", true, "09:00"))
  // The wake lands: running, out of the queue on a reading that is not a park.
  parked.delete("p")
  assert.deepEqual(run("10:00:04", thread("p", false, "09:00")), { p: undefined })
  assert.equal(clock.nextEntryAt(ms("10:00:04")), undefined)
  assert.deepEqual(run("10:00:31", thread("p", true, "10:00:30")), { p: at("10:00:30") })
  assert.deepEqual(saves, [["p", at("10:00:30")]])
})

test("an urgent entry off a park goes in at once", () => {
  // A permission prompt, a question, a crash, a limit pause: nothing about it is a flash.
  const { run, parked, urgent } = harness()
  parked.add("p")
  run("10:00:00", thread("p", false, "09:00"))
  urgent.add("p")
  assert.deepEqual(run("10:00:01", thread("p", true, "09:00")), { p: at("10:00:01") })
})

test("only an entry off a park is withheld: an ordinary rest, or a park the worker has since spoken past, goes in at once", () => {
  const { run, parked } = harness()
  // `turn` was last seen out RUNNING, so its rest is its own turn ending.
  run("10:00:00", thread("turn", false, "09:00"))
  assert.deepEqual(run("10:00:06", thread("turn", true, "10:00:05")), { turn: at("10:00:05") })
  // `spoke` was last seen parked at its 09:00 rest, but the rest it enters with is a new one: it was woken
  // and rested again between two assemblies.
  parked.add("spoke")
  run("10:00:00", thread("spoke", false, "09:00"))
  assert.deepEqual(run("10:00:06", thread("spoke", true, "10:00:05")), { spoke: at("10:00:05") })
})

test("a snooze lifted before its deadline goes in at once — only one that ran out is waiting on its bump", () => {
  const { run, parked } = harness()
  const snoozed = (id: string, until: string) => ({ ...thread(id, false, "09:00"), snoozedUntil: at(until) }) as ThreadView
  // Both snoozes carry a prompt to deliver at 10:05, so both are parks.
  parked.add("woken").add("ran-out")
  run("10:00", snoozed("woken", "10:05"), snoozed("ran-out", "10:05"))
  // The human presses Wake now on `woken` at 10:02: its card comes straight back.
  assert.deepEqual(run("10:02", thread("woken", true, "09:00"), snoozed("ran-out", "10:05")), { woken: at("10:02"), "ran-out": undefined })
  // `ran-out` reaches its deadline, and its bump is about to land: withheld.
  assert.deepEqual(run("10:05", thread("woken", true, "09:00"), thread("ran-out", true, "09:00")), { woken: at("10:02"), "ran-out": undefined })
})

test("a withheld entry whose reading turns unknown stays withheld, and its passed deadline never masks the next", () => {
  // The tailer can re-prime a row (a relocated transcript) and read it unknown for a moment.
  const { run, parked, unknown, clock } = harness()
  parked.add("a").add("b")
  run("10:00:00", thread("a", false, "09:00"), thread("b", false, "09:00"))
  run("10:00:01", thread("a", true, "09:00"), thread("b", false, "09:00"))
  unknown.add("a")
  const unknownQueued = thread("a", true, "09:00")
  run("10:00:05", unknownQueued, thread("b", true, "09:00"))
  assert.equal(unknownQueued.needsYou, false, "still inside its window")
  // `a`'s 10:00:13 passes while it reads unknown; `b`'s 10:00:17 must still be the next thing to wake for.
  run("10:00:14", thread("a", true, "09:00"), thread("b", true, "09:00"))
  assert.equal(clock.nextEntryAt(ms("10:00:14")), ms("10:00:17"))
})
