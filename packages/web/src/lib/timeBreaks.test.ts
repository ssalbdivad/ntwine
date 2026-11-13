import { test } from "node:test"
import assert from "node:assert/strict"
import { messageStampLabel, timeBreakLabel, timeBreaks } from "./timeBreaks.ts"

// Local wall-clock instants, so the day boundary is the test machine's own midnight.
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
type Row = { start?: string; end?: string }
const run = (rows: Row[]) => timeBreaks(rows, (r) => r.start, (r) => r.end ?? r.start)

test("the first dated row names its day, and a burst shares that one reading", () => {
  assert.deepEqual(run([{ start: at(9, 10, 51) }, { start: at(9, 10, 51) }, { start: at(9, 10, 52) }]), ["day", null, null])
})

test("a pause of 20m or more draws a time break; 19m does not", () => {
  assert.deepEqual(run([{ start: at(9, 10, 0) }, { start: at(9, 10, 19) }, { start: at(9, 10, 39) }]), ["day", null, "time"])
})

test("a stretch with no pause still draws a time break every 30m, counted from the last one drawn", () => {
  // Rows every 10m from 10:00: the 10:30 row is 30m after the day break, 11:00 30m after that.
  const steady = [0, 10, 20, 30, 40, 50, 60].map((m) => ({ start: at(9, 10 + Math.floor(m / 60), m % 60) }))
  assert.deepEqual(run(steady), ["day", null, null, "time", null, null, "time"])
  // A pause break resets the count: 10:25 breaks on the pause, so 10:50 (25m after it) does not, 10:55 does.
  assert.deepEqual(run([{ start: at(9, 10, 0) }, { start: at(9, 10, 25) }, { start: at(9, 10, 40) }, { start: at(9, 10, 50) }, { start: at(9, 10, 55) }]), ["day", "time", null, null, "time"])
})

test("a new calendar day draws a day break even after a short pause", () => {
  assert.deepEqual(run([{ start: at(8, 23, 55) }, { start: at(9, 0, 5) }]), ["day", "day"])
})

test("the pause runs from the previous row's END, so a long tool run is not read as a pause", () => {
  // A run opened 10:00 and folded batches through 10:25; the prose after it at 10:26 is one minute on.
  assert.deepEqual(run([{ start: at(9, 10, 0), end: at(9, 10, 25) }, { start: at(9, 10, 26) }]), ["day", null])
})

test("an undated row draws nothing and does not reset the clock", () => {
  assert.deepEqual(run([{ start: at(9, 10, 0) }, {}, { start: at(9, 10, 5) }, { start: "nope" }, { start: at(9, 11, 0) }]), ["day", null, null, null, "time"])
  assert.deepEqual(run([{}, { start: at(9, 10, 0) }]), [null, "day"])
})

test("labels: Today and Yesterday by name, a weekday inside the week, then a date", () => {
  const now = new Date(2026, 9, 9, 12, 0)
  assert.deepEqual(timeBreakLabel(at(9, 10, 51), "day", now, "en-US"), { day: "Today", time: "10:51 AM" })
  assert.deepEqual(timeBreakLabel(at(8, 15, 2), "day", now, "en-US"), { day: "Yesterday", time: "3:02 PM" })
  assert.equal(timeBreakLabel(at(6, 9, 0), "day", now, "en-US").day, "Tuesday")
  assert.equal(timeBreakLabel(at(1, 9, 0), "day", now, "en-US").day, "Oct 1")
  assert.equal(timeBreakLabel(new Date(2025, 11, 30, 9, 0).toISOString(), "day", now, "en-US").day, "Dec 30, 2025")
  assert.deepEqual(timeBreakLabel(at(9, 11, 24), "time", now, "en-US"), { day: null, time: "11:24 AM" })
})

test("a message's hover stamp names its day, clock and age; an unparseable instant draws none", () => {
  const now = new Date(2026, 9, 9, 13, 0)
  assert.deepEqual(messageStampLabel(at(9, 10, 51), now, "en-US"), { when: "Today 10:51 AM", age: "2h ago" })
  assert.deepEqual(messageStampLabel(at(6, 9, 0), now, "en-US"), { when: "Tuesday 9:00 AM", age: "3d ago" })
  assert.equal(messageStampLabel("nope", now), null)
})
