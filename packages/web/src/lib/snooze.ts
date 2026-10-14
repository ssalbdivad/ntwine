export type SnoozePreset = "1h" | "tomorrow" | "1d" | "3d" | "1w"
// "Until tomorrow" is the default because it is what a human deferring a card almost always means: pick it
// up at the start of the next working day. "1d" re-surfaces at this same hour tomorrow, so a card snoozed
// at 11pm comes back at 11pm (David 2026-09-29).
export const DEFAULT_SNOOZE_PRESET: SnoozePreset = "tomorrow"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** The local hour "tomorrow" wakes at. */
const TOMORROW_WAKE_HOUR = 9

/** Before this local hour, "tomorrow" means the day that is about to START, not the calendar date after
 *  it: someone snoozing at 2am is still in last night, and "tomorrow at 9am" means seven hours from now,
 *  not thirty-one. The cutoff guesses whether the operator went to bed late or woke up early.
 *
 *  5am rather than the usual 4am (Anki's day rollover): population sleep midpoints sit around 3–4:30am
 *  (Roenneberg's chronotype data), so someone active at 4:30 is about as likely to be a night owl as an
 *  early riser — and the two wrong guesses do not cost the same. Guessing "late night" for an early riser
 *  re-surfaces the card a few hours early, which a second snooze fixes; guessing "early morning" for a
 *  night owl hides the card through their whole next day. Before 5am, the late-night reading wins. */
const DAY_ROLLOVER_HOUR = 5

/** DURATION presets park for a span ("1d"); CALENDAR ones park until a named instant ("tomorrow").
 *  The split is already real in `snoozePresetInstant` — a calendar preset does calendar arithmetic and
 *  survives DST, a duration is an exact delta — and it governs the GRAMMAR of every label built from a
 *  preset: you snooze FOR a duration but UNTIL an instant. */
type SnoozePresetKind = "duration" | "calendar"

// The DURATION labels are the house duration grammar (`web/src/lib/durationLabels.ts`): `1h`, not
// "1 hour" — the maintainer collapsed every duration reading in the app onto one spelling on
// 2026-08-31. The detail beside each restates the same span one unit down, in the same grammar.
//
// The CALENDAR preset is untouched by that, because "tomorrow" and "9am" are not durations. It stays
// lowercase — sentence case, and it reads as a phrase mid-sentence (Settings' "Until tomorrow, 9am"),
// where a capital would look like a proper noun. The desktop SnoozeMenu lists every preset with its
// wake time; the phone's swipe and ⋯ sheet use the one chosen in Settings (`prefs.snoozePreset`).
export const SNOOZE_PRESETS: readonly { value: SnoozePreset; label: string; detail: string; kind: SnoozePresetKind }[] = [
  { value: "1h", label: "1h", detail: "60m", kind: "duration" },
  { value: "tomorrow", label: "tomorrow", detail: "9am", kind: "calendar" },
  { value: "1d", label: "1d", detail: "24h", kind: "duration" },
  { value: "3d", label: "3d", detail: "72h", kind: "duration" },
  { value: "1w", label: "1w", detail: "7d", kind: "duration" },
]

const SNOOZE_PRESET_VALUES = new Set<SnoozePreset>(SNOOZE_PRESETS.map((preset) => preset.value))

export function isSnoozePreset(value: unknown): value is SnoozePreset {
  return typeof value === "string" && SNOOZE_PRESET_VALUES.has(value as SnoozePreset)
}

export function snoozePresetLabel(preset: SnoozePreset): string {
  return snoozePresetEntry(preset).label
}

function snoozePresetEntry(preset: SnoozePreset) {
  return (
    SNOOZE_PRESETS.find((candidate) => candidate.value === preset) ??
    SNOOZE_PRESETS.find((candidate) => candidate.value === DEFAULT_SNOOZE_PRESET)!
  )
}

export function snoozePresetInstant(preset: SnoozePreset, nowMs = Date.now()): string {
  if (preset === "tomorrow") {
    const now = new Date(nowMs)
    // Calendar arithmetic is intentional: tomorrow 09:00 remains 09:00 across a DST transition,
    // while 1d below means an exact 24-hour delay. The two useful semantics stay distinct.
    const dayOffset = now.getHours() < DAY_ROLLOVER_HOUR ? 0 : 1
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, TOMORROW_WAKE_HOUR, 0, 0, 0)
    return tomorrow.toISOString()
  }
  const delta = preset === "1h" ? HOUR : preset === "1d" ? DAY : preset === "3d" ? 3 * DAY : 7 * DAY
  return new Date(nowMs + delta).toISOString()
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

export function localDateTimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export type ParsedLocalSnooze = { ok: true; until: string } | { ok: false; message: string }

export function parseLocalSnooze(value: string, nowMs = Date.now()): ParsedLocalSnooze {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return { ok: false, message: "Choose a local date and time" }
  const [, y, mo, d, h, mi] = match
  const parts = [y, mo, d, h, mi].map(Number)
  const local = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], 0, 0)
  // Date normalizes impossible dates and daylight-saving gaps. Compare every local component so a
  // nonexistent 02:30 does not silently become 03:30 in time zones that spring forward.
  if (
    !Number.isFinite(local.getTime()) ||
    local.getFullYear() !== parts[0] ||
    local.getMonth() !== parts[1] - 1 ||
    local.getDate() !== parts[2] ||
    local.getHours() !== parts[3] ||
    local.getMinutes() !== parts[4]
  ) {
    return { ok: false, message: "That local time does not exist" }
  }
  if (local.getTime() <= nowMs) return { ok: false, message: "Choose a time in the future" }
  return { ok: true, until: local.toISOString() }
}

export function formatSnoozeWake(until: string, nowMs = Date.now()): string {
  const date = new Date(until)
  if (!Number.isFinite(date.getTime())) return ""
  const now = new Date(nowMs)
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const calendarDays = Math.round((startTarget - startToday) / DAY)
  // Leave both locale and time zone to the browser. A snooze is a local-calendar promise, so a
  // server-formatted UTC timestamp would be misleading as soon as the operator travels.
  const time = wakeFormat("time").format(date)
  if (calendarDays === 0) return `Today at ${time}`
  if (calendarDays === 1) return `Tomorrow at ${time}`
  if (calendarDays > 1 && calendarDays < 7) return `${wakeFormat("weekday").format(date)} at ${time}`
  return `${wakeFormat(date.getFullYear() !== now.getFullYear() ? "dateYear" : "date").format(date)} at ${time}`
}

// Built once each: constructing an Intl.DateTimeFormat costs far more than formatting with one, and the
// wake phrase is read on renders that list several (the time limit's presets, every snoozed row).
const WAKE_FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  weekday: { weekday: "long" },
  date: { month: "short", day: "numeric" },
  dateYear: { month: "short", day: "numeric", year: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>
const wakeFormats = new Map<keyof typeof WAKE_FORMATS, Intl.DateTimeFormat>()
function wakeFormat(kind: keyof typeof WAKE_FORMATS): Intl.DateTimeFormat {
  let format = wakeFormats.get(kind)
  if (!format) wakeFormats.set(kind, (format = new Intl.DateTimeFormat(undefined, WAKE_FORMATS[kind])))
  return format
}

/** The lowercased wake phrase ("today at 11:09 PM") that folds into a full held-status sentence. Null
 *  when the instant is not a valid scheduler timer, so a malformed park has no display value. */
function wakePhrase(until: string, nowMs: number): string | null {
  // The fence-timer grammar is gone; a durable snooze instant is validated by Date.parse alone, which
  // is what every other reader of this value already relies on.
  if (!Number.isFinite(Date.parse(until))) return null
  const wake = formatSnoozeWake(until, nowMs)
  if (!wake) return null
  return wake.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

/** A complete HUMAN-snooze sentence — the operator deferred the card's presentation until this instant.
 *  The agent is NOT resumed at the deadline; the card merely re-surfaces in the queue. */
export function formatSnoozedUntil(until: string, nowMs = Date.now()): string | null {
  const wake = wakePhrase(until, nowMs)
  return wake ? `Snoozed until ${wake}` : null
}

/** The toast a snooze raises. It has a second job besides naming the wake: saying WHERE the thread
 *  went. A snoozed thread leaves the queue it was read from, and a toast naming only the deadline left
 *  the operator hunting for it (2026-09-28: "I accidentally snoozed a thread, I don't know where it
 *  went"). It waits under its project in the list, so the toast's second line says so whenever the
 *  project is known. */
export function formatSnoozeConfirmation(until: string, prompt: string | null, projectName: string | undefined, nowMs = Date.now()): { text: string; detail: string | undefined } {
  const wake = wakePhrase(until, nowMs)
  const what = prompt ? "Bump scheduled" : "Snoozed"
  return {
    text: wake ? `${what} ${prompt ? "for" : "until"} ${wake}` : what,
    detail: projectName ? `Under ${projectName} in the list` : undefined,
  }
}

/** How long a scheduled follow-up may run in a one-line tooltip before it stops being a hint. */
const PROMPT_PREVIEW_MAX = 120

/** A snooze prompt collapsed to one readable line. */
export function snoozePromptPreview(prompt: string, max = PROMPT_PREVIEW_MAX): string {
  const flat = prompt.trim().replace(/\s+/g, " ")
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The held-row sentence for a USER snooze, which now comes in two shapes. A snooze carrying a prompt
 *  resolves itself by resuming the agent with that text, so it is an AUTO-snooze in the exact sense
 *  below — and naming the follow-up is the whole point of having armed one. A plain snooze is still
 *  the reminder it always was. */
export function formatUserSnooze(until: string, prompt: string | undefined, nowMs = Date.now()): string | null {
  const follow = prompt?.trim()
  if (!follow) return formatSnoozedUntil(until, nowMs)
  const auto = formatAutoSnoozedUntil(until, nowMs)
  return auto ? `${auto} — then: ${snoozePromptPreview(follow)}` : null
}

/** A complete AUTO-SNOOZE sentence. Same concept as a human snooze — park until a wall-clock instant —
 *  differing only in WHO resolves it at the deadline: a human snooze re-surfaces the card for you to act
 *  on, while this one (a worker `awaiting timer:` park or the canonical blocked+timer status) auto-
 *  resolves by resuming the agent. Hence "auto-snoozed": one concept with an `auto` variant, not a
 *  separate idea. */
export function formatAutoSnoozedUntil(until: string, nowMs = Date.now()): string | null {
  const wake = wakePhrase(until, nowMs)
  return wake ? `Auto-snoozed until ${wake}` : null
}

