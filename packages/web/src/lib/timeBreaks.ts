// TIME BREAKS — the transcript's one reading of WHEN, drawn as a centred line between two messages
// where time actually passed: `Today 10:51 AM` at the top of a day, `11:24 AM` after a pause.
//
// It replaced a per-message hover reading (2026-10-09). That reading hung in the gap below its message,
// and between two consecutive bubbles that gap is 14px against a 16px line, so it drew over the next
// bubble (maintainer: "These fucking time stamps are overlapping with the message blocks"). Chosen from
// a five-variant sheet as the iMessage/Slack pattern: always on, no hover, and it takes a row of its own
// inside the message row it heads, so it can never collide with anything.
//
// A burst shares one reading on purpose. A frizz thread is read in bursts separated by long parks —
// a worker can sit on a PR watcher for days — so what a reader needs is where the stretches begin, not
// the minute of every line.

/** A pause at least this long between two messages draws a break before the second. */
export const TIME_BREAK_GAP_MS = 20 * 60_000

/** `day` — the first reading of a calendar day, so it names the day. `time` — a pause inside one day. */
export type TimeBreak = "day" | "time"

function instant(at: string | undefined): number | null {
  const ms = at ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : null
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
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
  let previousEnd: number | null = null
  return rows.map((row) => {
    const start = instant(startAt(row))
    const end = instant(endAt(row)) ?? start
    if (start === null) return null
    const brk: TimeBreak | null = previousEnd === null || !sameLocalDay(previousEnd, start)
      ? "day"
      : start - previousEnd >= TIME_BREAK_GAP_MS ? "time" : null
    previousEnd = Math.max(previousEnd ?? 0, end ?? start)
    return brk
  })
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
