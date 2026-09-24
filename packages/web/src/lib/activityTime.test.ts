import { test } from "node:test"
import assert from "node:assert/strict"
import { activityTimestamp, ageSpan, compactAge, exactStamp, formatLastActive } from "./activityTime.ts"

const now = Date.parse("2026-07-13T12:00:00.000Z")
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString()

test("formatLastActive uses the house duration grammar with the required label", () => {
  assert.equal(formatLastActive(at(0), now), "Last active just now")
  // A reading that dates something else names itself in front of the same phrase.
  assert.equal(formatLastActive(at(5 * 60_000), now, "Ready"), "Ready 5m ago")
  assert.equal(formatLastActive(at(1_000), now), "Last active 1s ago")
  assert.equal(formatLastActive(at(32_000), now), "Last active 32s ago")
  assert.equal(formatLastActive(at(60_000), now), "Last active 1m ago")
  assert.equal(formatLastActive(at(3 * 60 * 60 * 1_000), now), "Last active 3h ago")
  assert.equal(formatLastActive(at(2 * 24 * 60 * 60 * 1_000), now), "Last active 2d ago")
})

test("formatLastActive hides absent and invalid timestamps", () => {
  assert.equal(formatLastActive(undefined, now), null)
  assert.equal(formatLastActive("not-a-date", now), null)
})

// The rail's rest-time column prints the SPAN alone — the column position carries the "ago" that a
// standalone prose reading has to spell. Same vocabulary either way: relativeAge is this plus the word.
//
// It spelled its units out ("12 minutes", "3 hours") until 2026-08-31, when the maintainer collapsed
// every duration reading in the app onto one grammar: `"40 minutes" -> "40m"`.
test("ageSpan is relativeAge without the ago, and keeps just now intact", () => {
  assert.equal(ageSpan(at(0), now), "just now")
  assert.equal(ageSpan(at(1_000), now), "1s")
  assert.equal(ageSpan(at(12 * 60_000), now), "12m")
  assert.equal(ageSpan(at(40 * 60_000), now), "40m", "the maintainer's own example")
  assert.equal(ageSpan(at(3 * 60 * 60 * 1_000), now), "3h")
  assert.equal(ageSpan(at(9 * 24 * 60 * 60 * 1_000), now), "1w")
  assert.equal(ageSpan(at(60 * 24 * 60 * 60 * 1_000), now), "2mo")
  assert.equal(ageSpan(undefined, now), null)
  assert.equal(ageSpan("not-a-date", now), null)
})

test("activityTimestamp prefers tailer activity and falls back to a valid launch timestamp", () => {
  const activity = "2026-07-13T11:00:00.000Z"
  const spawned = "2026-07-13T10:00:00.000Z"
  assert.equal(activityTimestamp(activity, spawned), activity)
  assert.equal(activityTimestamp(undefined, spawned), spawned)
  assert.equal(activityTimestamp("not-a-date", spawned), spawned)
  assert.equal(activityTimestamp("not-a-date", "also-not-a-date"), undefined)
})

test("compactAge is a compact age, and refuses to invent one", () => {
  const then = Date.parse("2026-07-29T16:00:00Z")
  const ago = (ms: number) => compactAge(new Date(then - ms).toISOString(), then)
  assert.equal(ago(0), "just now")
  assert.equal(ago(59_000), "just now")
  assert.equal(ago(60_000), "1m ago")
  assert.equal(ago(59 * 60_000), "59m ago")
  assert.equal(ago(60 * 60_000), "1h ago")
  assert.equal(ago(23 * 3_600_000), "23h ago")
  assert.equal(ago(3 * 86_400_000), "3d ago")
  assert.equal(ago(14 * 86_400_000), "2w ago")
  assert.equal(ago(60 * 86_400_000), "2mo ago")
  assert.equal(ago(400 * 86_400_000), "1y ago")
  // The month bucket ends five days short of a year; a bare floor used to report those days as "0y".
  assert.equal(ago(362 * 86_400_000), "1y ago")
  // A future timestamp (clock skew between GitHub and this machine) reads as "just now", never as a
  // negative age.
  assert.equal(compactAge(new Date(then + 60_000).toISOString(), then), "just now")
  assert.equal(compactAge(undefined, then), null)
  assert.equal(compactAge("not a date", then), null)
})

test("exactStamp is GitHub's relative-time title, field for field", () => {
  // The reference reading, copied off a real `<relative-time title>` on github.com (2026-08-29).
  assert.equal(exactStamp("2026-08-29T17:44:50Z", { locale: "en-US", timeZone: "America/Los_Angeles" }), "Aug 29, 2026, 10:44 AM PDT")
  assert.equal(exactStamp("2026-01-05T03:07:00Z", { locale: "en-US", timeZone: "America/New_York" }), "Jan 4, 2026, 10:07 PM EST")
  assert.equal(exactStamp(undefined), null)
  assert.equal(exactStamp("not a date"), null)
})
