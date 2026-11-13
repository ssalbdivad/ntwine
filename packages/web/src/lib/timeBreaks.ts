import { relativeAge } from "./activityTime.ts"

// TIME BREAKS — the transcript's one reading of WHEN, drawn as a centred line between two messages
// where time actually passed: `Today 10:51 AM` at the top of a day, `11:24 AM` after a pause.
//
// It replaced a per-message hover reading (2026-10-09). That reading hung in the gap below its message,
// and between two consecutive bubbles that gap is 14px against a 16px line, so it drew over the next
// bubble (maintainer: "These fucking time stamps are overlapping with the message blocks"). Chosen from
// a five-variant sheet as the iMessage/Slack pattern: always on, no hover, and it takes a row of its own
// inside the message row it heads, so it can never collide with anything.
//
// A burst shares one reading on purpose. An ntwine thread is read in bursts separated by long parks —
// a worker can sit on a PR watcher for days — so what a reader needs is where the stretches begin, not
// the minute of every line.
//
// But a burst that never pauses — a worker busy for three hours straight — used to read as ONE stamp at
// its top, so nothing below said how old it was (maintainer 2026-11-12: "add subtle timestamps
// periodically … so i know approximately how old stuff is"). So a stamp also falls at the first row
// TIME_BREAK_EVERY_MS after the last one drawn: a busy stretch reads its clock every half hour or so,
// and a quiet one draws no more than before.

/** A pause at least this long between two messages draws a break before the second. */
export const TIME_BREAK_GAP_MS = 20 * 60_000
/** With no pause, the first row this long after the last drawn break draws another. */
export const TIME_BREAK_EVERY_MS = 30 * 60_000

/** The fold's state between rows: when the rows so far last moved, and when the last break was drawn. */
export interface BreakClock {
  end: number | null
  mark: number | null
}
export const START_CLOCK: BreakClock = { end: null, mark: null }

/** `day` — the first reading of a calendar day, so it names the day. `time` — a pause inside one day. */
export type TimeBreak = "day" | "time"

// BOTH READINGS ARE CACHED, by the string and by the instant (2026-10-16). The breaks are re-derived over
// the whole loaded transcript on every update, and a parse plus two `toDateString` per row was the largest
// single cost of a streaming update on a long thread: ~20ms of each at 4x CPU on 2,450 messages, the
// first item in its profile. A transcript's timestamps repeat across every update, so after the first
// pass each row is two map reads. The caches are bounded by clearing, which only costs a re-parse.
const CACHE_LIMIT = 50_000
const instants = new Map<string, number | null>()
const days = new Map<number, string>()

/** The instant `at` names, or null for none / an unparseable one. */
export function breakInstant(at: string | undefined): number | null {
  if (!at) return null
  const hit = instants.get(at)
  if (hit !== undefined) return hit
  const ms = Date.parse(at)
  const value = Number.isFinite(ms) ? ms : null
  if (instants.size >= CACHE_LIMIT) instants.clear()
  instants.set(at, value)
  return value
}

function localDay(ms: number): string {
  let day = days.get(ms)
  if (day === undefined) {
    day = new Date(ms).toDateString()
    if (days.size >= CACHE_LIMIT) days.clear()
    days.set(ms, day)
  }
  return day
}

function sameLocalDay(a: number, b: number): boolean {
  return localDay(a) === localDay(b)
}

/**
 * The break, if any, that heads each row. `startAt` is when a row BEGAN and `endAt` when it last moved —
 * they differ only for a coalesced tool run, whose `message.at` walks forward to its newest batch while
 * `runStartedAt` keeps the first. The pause that matters is from the previous row's end to this row's
 * start, so a ten-minute run of tool calls does not read as a ten-minute pause before the prose after it.
 *
 * A row with no instant (a legacy transcript recorded before `at` was on the wire) draws nothing and
 * does not reset the clock: the next dated row is measured against the last dated one. The first dated
 * row always draws a `day` break, so the top of what is loaded says when it is from.
 */
export function timeBreaks<T>(rows: readonly T[], startAt: (row: T) => string | undefined, endAt: (row: T) => string | undefined): (TimeBreak | null)[] {
  let clock = START_CLOCK
  return rows.map((row) => {
    const start = breakInstant(startAt(row))
    if (start === null) return null
    const step = breakStep(clock, start, breakInstant(endAt(row)) ?? start)
    clock = step.clock
    return step.timeBreak
  })
}

/** One step of timeBreaks — the break before a row that starts at `start` and last moved at `end`, and
 *  the clock after it — for a caller that keeps the fold's clock itself (lib/virtualTranscript). */
export function breakStep(clock: BreakClock, start: number, end: number): { timeBreak: TimeBreak | null; clock: BreakClock } {
  const { end: previousEnd, mark } = clock
  const timeBreak: TimeBreak | null = previousEnd === null || !sameLocalDay(previousEnd, start)
    ? "day"
    : start - previousEnd >= TIME_BREAK_GAP_MS || (mark !== null && start - mark >= TIME_BREAK_EVERY_MS) ? "time" : null
  return { timeBreak, clock: { end: Math.max(previousEnd ?? 0, end), mark: timeBreak ? start : mark } }
}

/**
 * The words a break draws: `{ day: "Today", time: "10:51 AM" }`, `day` only on a `day` break.
 *
 * Today and Yesterday by name, a weekday inside the last week, then a short date — with the year only
 * when it is not this year, the same rule the rest of the app's dates follow. `now` and `locale` exist
 * for the test; production passes neither.
 */
export function timeBreakLabel(at: string, kind: TimeBreak, now: Date = new Date(), locale?: string): { day: string | null; time: string } {
  const when = new Date(Date.parse(at))
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  if (kind === "time") return { day: null, time }
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const daysAgo = Math.round((startOf(now) - startOf(when)) / 86_400_000)
  const day = daysAgo === 0 ? "Today"
    : daysAgo === 1 ? "Yesterday"
    : daysAgo > 1 && daysAgo < 7 ? when.toLocaleDateString(locale, { weekday: "long" })
    : when.toLocaleDateString(locale, when.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" })
  return { day, time }
}

/**
 * One message's own reading, for the hover stamp (components/MessageHoverStamp): the break's day and
 * clock words in one phrase, and its age — `{ when: "Today 10:51 AM", age: "2h ago" }`. The age is the
 * part that answers "how old is this", which the day/clock alone leaves to arithmetic.
 */
export function messageStampLabel(at: string, now: Date = new Date(), locale?: string): { when: string; age: string } | null {
  if (breakInstant(at) === null) return null
  const { day, time } = timeBreakLabel(at, "day", now, locale)
  return { when: `${day} ${time}`, age: relativeAge(at, now.getTime()) ?? "" }
}
