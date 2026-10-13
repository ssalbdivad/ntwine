import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
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
    // Sessions persist in production; anything else stands in for a non-durable kind.
    persists: (t) => t.kind === "session",
    save: (t, value) => void saves.push([t.id, value]),
    saveAlive: (value) => void alives.push(value),
  })
  // Every reading is vouched for unless its slug is in `unknown` — a row the tailer has not primed yet.
  const unknown = new Set<string>()
  // …of which these were drawn from a stand-in for the telemetry (board.ts boardTelemetry).
  const standIn = new Set<string>()
  // Out of the queue behind a hold a wake follows (`parked`), and a reading that must surface at once.
  const parked = new Set<string>()
  const urgent = new Set<string>()
  // Out of the queue because a person acted (a snooze, done, a follow-up), and queued on a gate only a
  // person's reply clears (a permission prompt).
  const humanOut = new Set<string>()
  const humanGate = new Set<string>()
  const run = (nowHHMM: string, ...threads: ThreadView[]) => {
    clock.stamp(threads, ms(nowHHMM), {
      known: (t) => !unknown.has(t.id),
      standIn: (t) => standIn.has(t.id),
      parked: (t) => parked.has(t.id),
      urgent: (t) => urgent.has(t.id),
      humanOut: (t) => humanOut.has(t.id),
      humanGate: (t) => humanGate.has(t.id),
    })
    return Object.fromEntries(threads.map((t) => [t.id, t.queuedAt]))
  }
  return { run, saves, unknown, standIn, alives, parked, urgent, humanOut, humanGate, clock }
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

test("leaving the queue because a person acted forgets the stamp, so the next entry joins the back of the line", () => {
  const { run, saves, humanOut } = harness()
  run("10:00", thread("a", false, "09:00"))
  run("10:06", thread("a", true, "10:05"))
  // The human snoozes it (no new output — the rest time never moves), then the snooze ends.
  humanOut.add("a")
  assert.deepEqual(run("10:10", thread("a", false, "10:05")), { a: undefined })
  run("11:59", thread("a", false, "10:05"))
  humanOut.delete("a")
  assert.deepEqual(run("12:00", thread("a", true, "10:05")), { a: at("12:00") })
  assert.deepEqual(saves, [["a", at("10:05")], ["a", null], ["a", at("12:00")]])
})

test("a boot keeps every place in line while the tailer is still priming rows", () => {
  // `waiting` entered at 12:30 off a wait (its rest was 09:00). After a restart the board runs before
  // the tailer has primed it, and an unprimed headless row reads as RUNNING — out of the queue. That
  // reading is unknown, so it clears nothing, and the thread keeps showing queued at its stamp; the first
  // real reading finds the stamp where it was.
  const { run, saves, unknown } = harness({ waiting: at("12:30"), left: at("11:00") })
  unknown.add("waiting").add("left")
  for (const now of ["13:00", "13:00", "13:01"]) {
    const waiting = thread("waiting", false, "09:00")
    const left = thread("left", false, "11:00")
    assert.deepEqual(run(now, waiting, left), { waiting: at("12:30"), left: at("11:00") })
    assert.equal(waiting.needsYou, true)
    assert.equal(left.needsYou, true)
  }
  assert.deepEqual(saves, [])
  unknown.clear()
  // `left` left the queue while the server was down: its first KNOWN reading out of the queue clears it.
  const left = thread("left", false, "11:00")
  assert.deepEqual(run("13:02", thread("waiting", true, "09:00"), left), { waiting: at("12:30"), left: undefined })
  assert.equal(left.needsYou, false)
  assert.deepEqual(saves, [["left", null]])
})

test("an unknown reading out of the queue with no stamp stays out: only a place in line is carried across a boot", () => {
  const { run, unknown } = harness()
  unknown.add("fresh")
  const fresh = thread("fresh", false, "12:00")
  assert.deepEqual(run("13:00", fresh), { fresh: undefined })
  assert.equal(fresh.needsYou, false)
})

test("an unknown reading that happens to be queued shows the stamp it has and decides nothing", () => {
  const { run, saves, unknown } = harness({ a: at("10:00") })
  unknown.add("a").add("b")
  assert.deepEqual(run("13:00", thread("a", true, "12:45"), thread("b", true, "12:50")), { a: at("10:00"), b: undefined })
  assert.deepEqual(saves, [])
})

test("a STAND-IN reading with no stamp does not enter the queue: no card for the seconds of a prime", () => {
  // board.ts boardTelemetry draws an unprimed row from the tail cache's pre-restart state; one that says
  // queued with no stamp behind it is an account the real reading may take straight back.
  const { run, saves, unknown, standIn } = harness({ a: at("10:00") })
  unknown.add("a").add("b")
  standIn.add("a").add("b")
  const a = thread("a", false, "12:45")
  const b = thread("b", true, "12:50")
  assert.deepEqual(run("13:00", a, b), { a: at("10:00"), b: undefined })
  assert.equal(a.needsYou, true, "a stamp still holds its place")
  assert.equal(b.needsYou, false)
  assert.equal(b.queueSettling, undefined, "not withheld: nothing says a park ended")
  assert.deepEqual(saves, [])
})

test("a stand-in reading that is URGENT still enters at once", () => {
  const { run, unknown, standIn, urgent, saves } = harness()
  unknown.add("asks")
  standIn.add("asks")
  urgent.add("asks")
  const asks = thread("asks", true, "12:50")
  run("13:00", asks)
  assert.equal(asks.needsYou, true)
  assert.deepEqual(saves, [], "but nothing is decided off it")
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
  // Queued mid-turn (a permission prompt, a terminal at a prompt): the agent writes on, and the stamp holds.
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
  const bare = { id: "bare", kind: "session", needsYou: true } as unknown as ThreadView
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

// ---- A THREAD ONLY LOSES ITS PLACE WHEN A PERSON ACTS ON IT (David 2026-09-28: "Keep its place") ----

const asking = (id: string, queued: boolean, rested: string, ...questionIds: string[]) =>
  ({ ...thread(id, queued, rested), questions: questionIds.map((qid) => ({ id: qid })) }) as unknown as ThreadView

test("a thread woken by its own work, resting again untouched, takes back its place in line", () => {
  // `reading` entered at 10:00 and is the card being read; `later` entered behind it at 10:05. A shell of
  // `reading`'s finishes at 10:10 and wakes it; it rests again at 10:12 — nobody did anything.
  const { run, saves } = harness()
  run("09:59", thread("reading", false, "09:00"), thread("later", false, "09:00"))
  run("10:00", thread("reading", true, "10:00"), thread("later", false, "09:00"))
  run("10:05", thread("reading", true, "10:00"), thread("later", true, "10:05"))
  assert.deepEqual(run("10:10", thread("reading", false, "10:00"), thread("later", true, "10:05")), { reading: undefined, later: at("10:05") })
  assert.deepEqual(run("10:12", thread("reading", true, "10:12"), thread("later", true, "10:05")), { reading: at("10:00"), later: at("10:05") })
  assert.deepEqual(saves.at(-1), ["reading", at("10:00")], "the place it took back is the one persisted")
})

test("a person acting on it while it was out — a follow-up, a snooze, done — costs the place", () => {
  const { run, humanOut } = harness()
  run("09:59", thread("a", false, "09:00"))
  run("10:00", thread("a", true, "10:00"))
  // Woken by its own work first; the human then sends it a follow-up while it runs.
  run("10:10", thread("a", false, "10:00"))
  humanOut.add("a")
  run("10:11", thread("a", false, "10:00"))
  humanOut.delete("a")
  assert.deepEqual(run("10:15", thread("a", true, "10:15")), { a: at("10:15") })
})

test("a gate the person answered while it waited — a permission prompt — costs the place", () => {
  const { run, humanGate } = harness()
  run("09:59", thread("a", false, "09:00"))
  humanGate.add("a")
  run("10:00", thread("a", true, "09:59"))
  humanGate.delete("a")
  // Approved: the turn goes on, and ends in an ordinary rest.
  run("10:01", thread("a", false, "09:59"))
  assert.deepEqual(run("10:05", thread("a", true, "10:05")), { a: at("10:05") })
})

test("a question answered costs the place, whether it was answered in the queue or out of it; a new question does not", () => {
  const { run } = harness()
  run("09:59", asking("inq", false, "09:00"), asking("outq", false, "09:00"), asking("newq", false, "09:00"))
  run("10:00", asking("inq", true, "10:00", "q1"), asking("outq", true, "10:00", "q2"), asking("newq", true, "10:00"))
  // `inq`'s question is answered while it is still queued; the answer's delivery then wakes it.
  run("10:01", asking("inq", true, "10:00"), asking("outq", true, "10:00", "q2"), asking("newq", true, "10:00"))
  // All three are woken. `outq`'s question is answered while it runs; `newq` asks a new one of its own.
  run("10:02", asking("inq", false, "10:00"), asking("outq", false, "10:00", "q2"), asking("newq", false, "10:00"))
  run("10:03", asking("inq", false, "10:00"), asking("outq", false, "10:00"), asking("newq", false, "10:00"))
  assert.deepEqual(
    run("10:04", asking("inq", true, "10:04"), asking("outq", true, "10:04"), asking("newq", true, "10:04", "q3")),
    { inq: at("10:04"), outq: at("10:04"), newq: at("10:00") },
  )
})

test("a claim survives a release it waits out, and returns with the place once the window closes", () => {
  // Queued at 10:00; woken by its own work; rests behind a sub-agent (parked); the child returns and no
  // wake follows — the withheld entry goes in at the place it left, not at the back.
  const { run, parked } = harness()
  run("09:59", thread("a", false, "09:00"))
  run("10:00", thread("a", true, "10:00"))
  run("10:01", thread("a", false, "10:00"))
  parked.add("a")
  run("10:02", thread("a", false, "10:02"))
  const released = thread("a", true, "10:02")
  run("10:03", released)
  assert.equal(released.needsYou, false, "withheld while its wake gets its seconds")
  assert.deepEqual(run("10:03:12", thread("a", true, "10:02")), { a: at("10:00") })
})

