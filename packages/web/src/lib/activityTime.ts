export function activityTimestamp(lastActivityAt: string | undefined, spawnedAt?: string): string | undefined {
  for (const at of [lastActivityAt, spawnedAt]) {
    if (at && Number.isFinite(Date.parse(at))) return at
  }
  return undefined
}

/** `Last active 5m ago`, or another reading's own word in front of the same phrase (`Ready 5m ago`). */
export function formatLastActive(at: string | undefined, nowMs = Date.now(), label = "Last active"): string | null {
  const age = relativeAge(at, nowMs)
  return age && `${label} ${age}`
}

/** `just now` / `3d ago` — the phrase without a label, so a caller can supply its own. */
export function relativeAge(at: string | undefined, nowMs = Date.now()): string | null {
  const span = ageSpan(at, nowMs)
  return span === null || span === JUST_NOW ? span : `${span} ago`
}

const JUST_NOW = "just now"

/**
 * THE AGE LADDER, in the house duration grammar (`lib/durationLabels.ts`): `12s` · `40m` · `3h` ·
 * `3d` · `1w` · `4mo` · `2y`. Shared by every reading below so the rail's rest column and a hairline's
 * tail cannot spell the same span two ways.
 *
 * It climbs past weeks where the duration formatters stop, because an AGE has no upper bound — a
 * project's `lastOpenedAt` is routinely months old — while a duration times a stretch of live work.
 */
function ageLadder(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  // `Math.max(1, …)` because the month bucket ends at 360 days, five short of a year: a bare floor
  // reported those five days as `0y`.
  return `${Math.max(1, Math.floor(days / 365))}y`
}

/** Where `ageLadder` stops counting months and starts counting years. A reading that needs to bail out
 *  to an absolute date rather than say `1y` (the GitHub cards' `coarseAgo`) switches here. */
export const AGE_LADDER_YEARS_FROM_DAYS = 360

/**
 * The bare SPAN — `just now` / `12m` / `3d` — with no "ago" on the end.
 *
 * The rail's rest-time column is a COLUMN: every row in it carries one, right-justified, so the
 * position already says "ago" and repeating the word on every row spends the rail's scarcest axis
 * (its width) on three characters that add nothing. Everywhere a reading stands ALONE in prose, use
 * relativeAge above — which is this function plus that word, so the two vocabularies cannot drift.
 *
 * It spelled its units out (`12 minutes`, `3 hours`) until 2026-08-31, when the maintainer collapsed
 * every duration reading in the app onto one grammar: `"40 minutes" -> "40m"`.
 */
export function ageSpan(at: string | undefined, nowMs = Date.now()): string | null {
  const activityMs = at ? Date.parse(at) : NaN
  if (!Number.isFinite(activityMs) || !Number.isFinite(nowMs)) return null
  const seconds = Math.max(0, Math.floor((nowMs - activityMs) / 1_000))
  return seconds === 0 ? JUST_NOW : ageLadder(seconds)
}

/**
 * A message's own instant, for the transcript's hover reveal: `Aug 25, 10:31 AM`.
 *
 * The DATE is unconditional, and that is the point of the reading. A frizz thread is not a chat you
 * read in one sitting — a worker can be parked on a PR watcher for days, so two adjacent messages
 * routinely sit on different dates and a bare `10:31 AM` cannot tell you which (maintainer 2026-08-25:
 * "it should also include the date, not just the time, because some of these runs can go for a very,
 * very long time"). Showing the date only when the message is NOT from today would be terser, but it
 * encodes the day in an ABSENCE — `10:31 AM` means today only if you know the rule — and this reading
 * is one the reader deliberately went and got, so it can afford six characters to have no rule at all.
 *
 * The YEAR is conditional, because that one really is safe to omit: a thread crossing a new year is
 * rare enough that spending four characters on every reading to cover it is the wrong trade, and its
 * absence is not ambiguous the way a missing date is — `Aug 25` in August 2026 is this August.
 *
 * Deliberately NOT relative ("3h ago"). The board already speaks in relative ages everywhere —
 * the rail's rest column, `LastActive`, the child-op rows — and this exists precisely because those
 * cannot answer "when exactly did this come out". An absolute reading also never needs to tick, so it
 * does not join `useNowMs`.
 */
export function messageStamp(at: string | undefined, now: Date = new Date()): string | null {
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return null
  const when = new Date(ms)
  const date = when.toLocaleDateString([], when.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" })
  return `${date}, ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
}

/**
 * The COMPACT age a hairline's tail carries: `just now` / `21m ago` / `3d ago`. It sits at the end of
 * a dense one-line petite-caps label, not on its own line, and at queue-rail width it is the one field
 * that must survive the label's truncation. Moved here from githubWakeCard.ts on 2026-08-29, when every
 * divider grew one (it was the GitHub review line's alone for a month) and the compact grammar stopped
 * being about GitHub.
 *
 * It differs from relativeAge in exactly one place — the sub-minute reading, which is "just now" here
 * and `12s ago` there. The rail's column is watched while a thread rests and the seconds are the point;
 * a hairline is scanned once, where they are noise.
 */
export function compactAge(at: string | undefined, nowMs = Date.now()): string | null {
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1_000))
  return seconds < 60 ? JUST_NOW : `${ageLadder(seconds)} ago`
}

/**
 * The EXACT instant behind a compact age, for its hover: `Aug 29, 2026, 10:44 AM PDT`.
 *
 * This is GitHub's own `<relative-time>` title, field for field — read off the real element on a real
 * PR page (2026-08-29) rather than designed: day, short month, year, hour, two-digit minute, short zone.
 * Mirrored because the compact age it explains is GitHub's grammar too (`21m ago`), and the reader
 * hovering a review-comment hairline has just come from the page that taught them what to expect.
 *
 * It is NOT messageStamp. That reading (`Aug 25, 10:31 AM`) is a per-message reveal drawn on every
 * row, and it drops the year and the zone because a transcript's rows share both and its width is
 * scarce. A tooltip is read alone, cold, and has room — and a hairline is where a thread crosses a day
 * or a machine (a PR watcher fires on GitHub's clock, a timer on this one), so the zone earns its place.
 *
 * `locale`/`timeZone` exist for the test; production passes neither and takes the browser's.
 */
export function exactStamp(at: string | undefined, opts: { locale?: string; timeZone?: string } = {}): string | null {
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat(opts.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: opts.timeZone,
  }).format(ms)
}

/** Format a unix-seconds instant as a bare local wall clock ("5:50 PM"), or with the weekday when it
 *  is not today — a limit that resets tomorrow afternoon must not read as if it comes back this hour.
 *  Shared by the drawer's LimitPauseCard and the rail's limit mark, so the two name one instant alike. */
export function limitResumeClock(unixSeconds: number): string {
  const when = new Date(unixSeconds * 1000)
  const sameDay = when.toDateString() === new Date().toDateString()
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return sameDay ? time : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`
}
