import type { ThreadView } from "@ntwine/shared"
import { agentParked, lastActiveLabelAt, sectionOf, sessionIndicatorKind } from "../groups.ts"
import { ageSpan } from "./activityTime.ts"
import { formatRuntimeElapsed } from "./durationLabels.ts"
import { EFFORT_LABEL } from "./options.ts"

// THE PHONE THREAD HEADER'S SUBTITLE, as data: what the thread is doing, then how long it has been
// doing it, then what it runs on — `Needs you · 13h · Opus 5 · high`. The state word comes FIRST
// because it is the question a phone reader opens a thread to answer, and the accent on it means what
// the accent means everywhere else in the app: this is waiting on you, and nothing else earns it.
//
// "Needs you" is the board's own [?] — `sessionIndicatorKind(t) === "needs-input"` — and deliberately
// NOT the server's `needsYou` flag. That flag is queue MEMBERSHIP, and every ordinary rest joins the
// queue now, so keying on it would have spelled every rested thread "Needs you" and emptied the word
// of meaning. The header says what the board's mark says, one screen later.
export type MobileThreadState = "needs-you" | "working" | "rested" | "snoozed" | "done"

export function mobileThreadState(t: ThreadView): MobileThreadState {
  const kind = sessionIndicatorKind(t)
  if (kind === "needs-input") return "needs-you"
  if (t.runtime === "running" || t.runtime === "spawning") return "working"
  if (kind === "archived") return "done"
  // THE WORD NAMES THE BAND the desktop board files the row in, so every park in Snoozed says "Snoozed":
  // the operator's wall-clock snooze, the resting card's event-snooze, and a done the human parked on
  // "Watch #N" (server doneParkedOnWatch → waitStatus `watching` over the event-snooze). A worker's own
  // park — a `status: watching` rest — sits in Working since 2026-10-14, and says so. Until 2026-10-07 this read only the wall-clock park — the split the board's AlarmMark
  // draws, which is a GLYPH choice — so a thread the human had just watched from its done card sat in
  // the Snoozed band on desktop while the phone header still called it "Rested".
  if (sectionOf(t) === "snoozed") return "snoozed"
  if (agentParked(t)) return "working"
  return "rested"
}

export const MOBILE_STATE_WORD: Record<MobileThreadState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  rested: "Rested",
  snoozed: "Snoozed",
  done: "Done",
}

/**
 * The age that follows the state word, in the house grammar.
 *
 * At rest it is the board row's own rest time (`lastActiveLabelAt` through `ageSpan`), so the header
 * and the row the reader tapped say the same number. While a turn runs it is how long THIS TURN has
 * been going — counted from the turn's opening message, which the caller reads off the transcript —
 * because the rest-time ladder would read "just now" for as long as the worker keeps writing.
 */
export function mobileThreadAge(t: ThreadView, state: MobileThreadState, turnStartedAt: string | undefined, nowMs: number): string | null {
  if (state === "working") {
    const start = Date.parse(turnStartedAt ?? t.lastUserAt ?? t.spawnedAt ?? "")
    if (!Number.isFinite(start)) return null
    return formatRuntimeElapsed(Math.max(0, nowMs - start)) || null
  }
  return ageSpan(lastActiveLabelAt(t), nowMs)
}

/** `high` → `high`, `xhigh` → `x-high`: the composer's effort names, in running-text case. */
export function effortWord(effort: string | undefined): string | undefined {
  const e = effort?.trim()
  if (!e) return undefined
  return (EFFORT_LABEL[e] ?? e).toLowerCase()
}

/** Token counts the way a phone footer can hold them: `118k`, `1M`, `1.2M`. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = Math.round(n / 100_000) / 10
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** `Context 41% · 118k of 288k` — the header's context meter as one line of text. Null without a reading
 *  (the meter renders nothing then, and so does this). Floored like the meter's own tooltip. */
export function contextLine(context: ThreadView["context"]): string | null {
  if (!context || context.window <= 0) return null
  const percent = Math.max(0, Math.min(100, Math.floor((context.tokens / context.window) * 100)))
  return `Context ${percent}% · ${compactTokens(context.tokens)} of ${compactTokens(context.window)}`
}

/** The start of the running turn: the newest message the human (or ntwine on their behalf — a wake, a
 *  timer, a Goal bump) put into the conversation. Queued sends have not started anything yet. */
export function turnStartedAt(messages: readonly { role?: string; queued?: boolean; at?: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && m.at) return m.at
  }
  return undefined
}

/** A link a phone cannot follow: it names the machine ntwine runs on, which from the phone is itself. */
export function isLoopbackUrl(target: string): boolean {
  try {
    const host = new URL(target).hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "0.0.0.0"
  } catch {
    return false
  }
}

/** `http://localhost:5175/x` → `localhost:5175/x`: the part of a URL a reader identifies it by. */
export function displayUrl(target: string): string {
  try {
    const url = new URL(target)
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`
    return `${url.host}${rest}`
  } catch {
    return target
  }
}
