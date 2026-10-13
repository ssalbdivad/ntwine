import { useEffect, useState } from "react"
import { deadlineStageAtMs, formatDeadlineLeft, parseDeadlineInput, type ThreadDeadlineView } from "@ntwine/shared"
import { formatSnoozeWake } from "./snooze.ts"
import { useNowMs } from "./liveClock.ts"

// A THREAD'S TIME LIMIT, AS THE BROWSER READS AND WRITES IT (ARCHITECTURE.md § Time limits).
//
// The grammar and the reading are shared with the server (@ntwine/shared deadline.ts): `parseDeadlineInput`
// is the one parser of what the human types, `formatDeadlineLeft` the one "42m left" / "over by 8m". This
// file holds only what is the browser's: how loud the reading is, how often it ticks, the "Ends 3:30 PM"
// preview, and the arithmetic of the drawer's extend presets.

/** The prompt box's presets: a working session's usual shapes. Each is typed into the same grammar. */
export const DISPATCH_LIMIT_PRESETS = ["30m", "1h", "2h", "4h"] as const

/** The drawer's extend presets: added to the CURRENT deadline, or to now once it has passed. */
export const EXTEND_PRESETS = [
  { label: "+15m", ms: 15 * 60_000 },
  { label: "+30m", ms: 30 * 60_000 },
  { label: "+1h", ms: 60 * 60_000 },
] as const

/**
 * HOW LOUD THE READING IS. Quiet while there is plenty of time, the attention tone in the last stretch,
 * the danger tone once it has run out.
 *
 * The last stretch starts at the budget's 80% — the instant the worker's own `converge` check-in tells it
 * to start nothing new (deadline.ts DEADLINE_STAGES). So the card turns amber exactly when the agent is told
 * to wind down, and the human reading the board and the agent reading its check-in are never at different
 * stages of the same clock. A 1h limit goes amber with 12m left, a 30m one with 6m, a 4h one with 48m.
 */
export type DeadlineTone = "plenty" | "closing" | "over"
export function deadlineTone(deadline: Pick<ThreadDeadlineView, "at" | "setAt">, nowMs: number): DeadlineTone {
  const atMs = Date.parse(deadline.at)
  if (!Number.isFinite(atMs)) return "plenty"
  if (nowMs >= atMs) return "over"
  const setAtMs = Date.parse(deadline.setAt)
  // A deadline with no readable start has no budget to take a fraction of: it is quiet until it runs out.
  if (!Number.isFinite(setAtMs)) return "plenty"
  return nowMs >= deadlineStageAtMs(setAtMs, atMs, "converge") ? "closing" : "plenty"
}

/** The text tone class for each — the app's existing attention (amber) and danger (red) tokens. */
export const DEADLINE_TONE_CLASS: Record<DeadlineTone, string> = {
  plenty: "",
  closing: "text-attention",
  over: "text-danger",
}

/** The window either side of the deadline in which the reading counts SECONDS (`40s left`, `over by 12s`),
 *  and so ticks every second. Wider than the shared clock's 30s step, so the 30s tick always lands inside
 *  it before the seconds begin. Past it, minutes are the reading and the shared 30s clock is plenty. */
export const DEADLINE_FAST_WINDOW_MS = 90_000

export function deadlineNeedsFastTick(atMs: number, nowMs: number): boolean {
  return Number.isFinite(atMs) && Math.abs(atMs - nowMs) < DEADLINE_FAST_WINDOW_MS
}

/**
 * The wall clock a deadline reading renders against: the app's one 30s clock (lib/liveClock.ts), which a
 * screenful of chips shares, and a 1s interval of this reading's own only while it counts seconds. A
 * reading in minutes on a 30s clock is at most 30s stale, and `spanLabel` rounds UP, so it never claims
 * less time than there is.
 *
 * NEVER OLDER THAN THE DEADLINE IT READS. The shared clock is only as fresh as its last tick, so a limit set
 * just now — "45m" — read "46m left" for up to half a minute: 45m against a clock 20s behind, rounded up.
 * The reading takes the wall clock afresh when it mounts and whenever its deadline moves.
 */
export function useDeadlineNow(atMs: number | undefined): number {
  const shared = useNowMs()
  const [own, setOwn] = useState(() => Date.now())
  const [readFor, setReadFor] = useState(atMs)
  if (readFor !== atMs) {
    setReadFor(atMs)
    setOwn(Date.now())
  }
  const now = Math.max(shared, own)
  const near = atMs !== undefined && deadlineNeedsFastTick(atMs, now)
  useEffect(() => {
    if (!near) return
    setOwn(Date.now())
    const id = setInterval(() => setOwn(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [near])
  return now
}

/** "Ends 3:30 PM" today, "Ends tomorrow at 9:00 AM", "Ends Friday at 3:30 PM"; "Ended 3:30 PM" once past.
 *  The local clock and locale, as the snooze menu's wake times are: a limit is a promise about the human's day. */
export function deadlineEndsLabel(atMs: number, nowMs: number): string {
  const wake = formatSnoozeWake(new Date(atMs).toISOString(), nowMs)
  const phrase = wake.startsWith("Today at ") ? wake.slice("Today at ".length) : wake.replace(/^Tomorrow/, "tomorrow")
  return `${atMs > nowMs ? "Ends" : "Ended"} ${phrase}`
}

/** The chip's tooltip: when it ends, and who set it when that was the agent. */
export function deadlineTitle(deadline: ThreadDeadlineView, nowMs: number): string {
  const atMs = Date.parse(deadline.at)
  const lines = [`Time limit · ${deadlineEndsLabel(atMs, nowMs)}`]
  if (deadline.setBy === "worker") lines.push("Set by the agent")
  return lines.join("\n")
}

/** The reading itself, `42m left` / `over by 8m` (the shared formatter), for a view off the board. */
export function deadlineReading(deadline: Pick<ThreadDeadlineView, "at">, nowMs: number): string | undefined {
  const atMs = Date.parse(deadline.at)
  return Number.isFinite(atMs) ? formatDeadlineLeft(atMs, nowMs) : undefined
}

/** An extend preset's new instant: from the current deadline while it is ahead, from NOW once it has
 *  passed — "+30m" on a thread 8m over means thirty more minutes of work, not twenty-two. */
export function extendedDeadlineMs(atMs: number, nowMs: number, byMs: number): number {
  return Math.max(Number.isFinite(atMs) ? atMs : nowMs, nowMs) + byMs
}

// ---- THE PROMPT BOX'S LIMIT -------------------------------------------------------------------------
// Kept in the draft as the human's RAW TEXT (`2h`, `15:30`), beside the prompt, and resolved to an instant
// only at the Enter that starts the thread — so "2h" means two hours from when the thread starts, not
// from when it was typed into the box an hour ago.

export type DraftDeadline = { ok: true; deadline?: string } | { ok: false; error: string }

/** The raw text resolved at submit: nothing typed is no limit; text that no longer parses — a clock time
 *  now under a minute away, a limit typed before midnight that is now over a week out — says why. */
export function resolveDraftDeadline(raw: string, nowMs: number): DraftDeadline {
  if (!raw.trim()) return { ok: true }
  const parsed = parseDeadlineInput(raw, nowMs)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, deadline: new Date(parsed.atMs).toISOString() }
}

/** The prompt box's preview of what is typed: "Ends 5:12 PM", or what is wrong with it. */
export function limitPreview(raw: string, nowMs: number): { ok: true; text: string } | { ok: false; text: string } | undefined {
  if (!raw.trim()) return undefined
  const parsed = parseDeadlineInput(raw, nowMs)
  return parsed.ok ? { ok: true, text: deadlineEndsLabel(parsed.atMs, nowMs) } : { ok: false, text: parsed.error }
}
