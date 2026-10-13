import { z } from "zod"
import { ThreadSlug } from "./thread-slug.ts"

// A THREAD'S DEADLINE — the time limit a prompt carries (ARCHITECTURE.md § Time limits).
//
// A thread may carry one absolute instant by which its worker owes the best deliverable it can hand
// over, rather than the complete one eventually. The human sets it when dispatching ("2h", "15:30") or
// later from the drawer; a worker may set one on a thread that has none. Ntwine reminds the worker at
// fixed points in the budget, mid-turn, and the board shows the countdown and then the overrun.
//
// IT IS SOFT, and that is settled, not pending: running out of time never interrupts a turn and never
// stops a sub-agent, because the agent completion invariant forbids cutting a writer off mid-edit. The
// limit is enforced by what the agent is told and by the board showing the thread over time.
//
// What lives HERE is what the browser and the server both read: parsing what the human typed, the stage
// instants, and the "42m left" reading. The worker-facing text lives in the server (deadline.ts there).

/** The shortest budget a deadline may carry. The scheduler resolves stages at its 10s tick, and a budget
 *  under a minute leaves the half-way check-in nothing to say that the deadline itself does not. */
export const DEADLINE_MIN_MS = 60_000
/** The longest. A deadline is a working session's clock; a week is already past anything that means. */
export const DEADLINE_MAX_MS = 7 * 24 * 60 * 60_000

/** Who set the current deadline. Only the human may move or clear one the human set: an agent moving
 *  its own goalposts defeats the point (ARCHITECTURE.md § Time limits). */
export type DeadlineSetter = "human" | "worker"

// ---- THE CHECK-IN STAGES ---------------------------------------------------------------------------
// Fixed points in the budget, not a steady countdown: a reminder every N minutes is noise a model learns
// to ignore, while a few stage changes each ask for a different behaviour. `start` is not a wake — it
// rides in the worker prompt.
export const DEADLINE_STAGES = ["half", "converge", "final", "over"] as const
export type DeadlineStage = (typeof DEADLINE_STAGES)[number]

/** How much warning `final` tries to leave: five minutes, where the budget can spare them. */
export const DEADLINE_FINAL_LEAD_MS = 5 * 60_000

/** The fraction of the budget at which each stage falls due.
 *
 *  `final` is "95%, or 5 minutes before the deadline if that is earlier" (the plan). Read literally that
 *  fires a 4-minute budget's final check-in a minute BEFORE it was set, so it is held between 87.5% —
 *  midway between `converge` and 95%, so the two never land together — and 95%. A 1h budget gets its
 *  final at 55m (the full five minutes); a 10h one at 9h 30m (95% is the earlier); a 4m one at 3m 30s. */
export function deadlineStageFraction(stage: DeadlineStage, budgetMs: number): number {
  switch (stage) {
    case "half": return 0.5
    case "converge": return 0.8
    case "final": return Math.min(0.95, Math.max(0.875, 1 - DEADLINE_FINAL_LEAD_MS / Math.max(1, budgetMs)))
    case "over": return 1
  }
}

/** The instant a stage falls due, for a deadline set at `setAtMs` and running out at `deadlineMs`. */
export function deadlineStageAtMs(setAtMs: number, deadlineMs: number, stage: DeadlineStage): number {
  const budget = Math.max(0, deadlineMs - setAtMs)
  return stage === "over" ? deadlineMs : Math.round(setAtMs + budget * deadlineStageFraction(stage, budget))
}

/** The LATEST stage due at `nowMs`, or undefined before half-time. Only the latest is ever sent: a
 *  server that was down across two stages, or a check-in that waited behind a busy reading, hands the
 *  worker where it stands now, not a history of where it stood. */
export function deadlineStageDue(setAtMs: number, deadlineMs: number, nowMs: number): DeadlineStage | undefined {
  let due: DeadlineStage | undefined
  for (const stage of DEADLINE_STAGES) if (nowMs >= deadlineStageAtMs(setAtMs, deadlineMs, stage)) due = stage
  return due
}

export function deadlineStageRank(stage: DeadlineStage | string | null | undefined): number {
  return stage ? DEADLINE_STAGES.indexOf(stage as DeadlineStage) : -1
}

// ---- THE READING ---------------------------------------------------------------------------------
// In the house duration grammar (`40m`, `2h 35m`; web lib/durationLabels.ts) — the same reading on the
// card, in the drawer, in the wake header and in the worker's check-ins.

/** `42m left`, `1h 12m left`, `40s left`, `over by 8m`. Seconds only under a minute, where they are
 *  the whole reading; past that they are noise on a chip that re-renders every few seconds. */
export function formatDeadlineLeft(deadlineMs: number, nowMs: number, opts: { precise?: boolean } = {}): string {
  const label = opts.precise ? preciseSpanLabel : spanLabel
  const left = deadlineMs - nowMs
  return left > 0 ? `${label(left)} left` : `over by ${label(-left)}`
}

/** The WORKER's reading of a span: exact under ten minutes (`1m 20s`, `40s`), rounded DOWN, and the
 *  card's reading past that. A minute rounded up is a large share of a short budget — on the first live
 *  run a 3m sub-agent with 80s left was told "2m left" — and the worker plans by it, so it must never
 *  claim time that is not there. The card keeps rounding up: a glance at a chip is not a plan. */
export function preciseSpanLabel(ms: number): string {
  if (ms >= 10 * 60_000) return spanLabel(ms)
  const s = Math.max(0, Math.floor(ms / 1_000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/** A span in the house grammar, rounded UP to the minute past one (`59m 10s` left reads `1h` — a
 *  countdown that says "59m" for the first second of an hour reads as already short). */
export function spanLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1_000))}s`
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

// ---- WHAT THE HUMAN TYPES ---------------------------------------------------------------------------
// The prompt box's time-limit control and the drawer's take ONE input and resolve it here, so the two
// cannot read "3:30" differently. A typed "go until 3:30" in the prompt TEXT is never parsed: the
// control is the only input, so the board never disagrees with the prose.

export type DeadlineParse =
  | { ok: true; atMs: number; kind: "duration" | "clock" }
  | { ok: false; error: string }

// `30m`, `2h`, `1h30m`, `1h 30m`, `90s`, `1d` — the `for:` grammar, plus a two-unit compound.
const DURATION_PART = /(\d{1,5})\s*(s|m|h|d)/g
const DURATION_WHOLE = /^(?:\d{1,5}\s*(?:s|m|h|d)\s*){1,3}$/
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
// `15:30`, `3:30`, `3:30pm`, `3pm`, `3 pm`.
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/

/** Resolve the human's input to an absolute instant, or say what is wrong with it. `nowMs` and the
 *  local time zone of the process are the reference: the browser resolves it, so "15:30" is the human's
 *  own 15:30, and sends the instant. */
export function parseDeadlineInput(raw: string, nowMs: number): DeadlineParse {
  const text = raw.trim().toLowerCase()
  if (!text) return { ok: false, error: "Type a duration like 30m or 2h, or a time like 15:30." }
  if (DURATION_WHOLE.test(text)) {
    let ms = 0
    for (const m of text.matchAll(DURATION_PART)) ms += Number(m[1]) * UNIT_MS[m[2]!]!
    return bounded(nowMs + ms, nowMs, "duration")
  }
  const clock = CLOCK.exec(text)
  // A bare number is neither: `30` could be minutes or half past, and guessing is how a limit ends up
  // an hour off. The colon or a unit is what says which.
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    const hour = Number(clock[1])
    const minute = Number(clock[2] ?? "0")
    if (minute > 59 || hour > 23 || (clock[3] && (hour < 1 || hour > 12))) return { ok: false, error: `${raw.trim()} is not a time of day.` }
    // An unmarked 12-hour reading ("3:30") means whichever of 03:30 and 15:30 comes next — the way
    // "go until 3:30" is meant. A 24-hour one ("15:30", or "09:00" with its leading zero) and an am/pm
    // one are exact.
    const twentyFour = clock[1]!.length === 2 && clock[1]!.startsWith("0")
    const hours = clock[3] === "am" ? [hour % 12]
      : clock[3] === "pm" ? [(hour % 12) + 12]
      : hour >= 1 && hour <= 12 && !twentyFour ? [hour % 12, (hour % 12) + 12]
      : [hour]
    const atMs = Math.min(...hours.map((h) => nextClockInstant(nowMs, h, minute)))
    return bounded(atMs, nowMs, "clock")
  }
  return { ok: false, error: `Could not read ${JSON.stringify(raw.trim())}. Type a duration like 30m or 2h, or a time like 15:30.` }
}

/** The next instant (strictly after now) the local clock reads hh:mm. */
function nextClockInstant(nowMs: number, hour: number, minute: number): number {
  const at = new Date(nowMs)
  at.setHours(hour, minute, 0, 0)
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function bounded(atMs: number, nowMs: number, kind: "duration" | "clock"): DeadlineParse {
  if (atMs - nowMs < DEADLINE_MIN_MS) return { ok: false, error: "A time limit must be at least 1m." }
  if (atMs - nowMs > DEADLINE_MAX_MS) return { ok: false, error: "A time limit can be at most 7d." }
  return { ok: true, atMs, kind }
}

// ---- A SUB-AGENT'S SHARE ------------------------------------------------------------------------------
// Claude's `Agent` tool has no budget parameter, so a parent declares one with a `Time limit: 20m` line
// in the child's prompt (the dispatch hook strips it). Without one the child gets the parent's remaining
// time minus a reserve the parent needs to fold the result in. A declared limit is clamped to the same
// ceiling, so a child never outlives its parent's deadline.
//
// THE RESERVE is the larger of 20% of what remains and 5 minutes (the plan) — but never more than HALF
// of what remains, or a parent with four minutes left would hand its child none at all. A parent already
// past its deadline still gives a child the floor (DEADLINE_MIN_MS): the child is told to return at once,
// which is the most useful thing a minute can buy. This file's `cc-worker/hooks/agent-dispatch.mjs` twin
// computes the same thing in plain JS; `agent-dispatch-hook.test.ts` pins the two together.
export const CHILD_RESERVE_FRACTION = 0.2
export const CHILD_RESERVE_MIN_MS = 5 * 60_000

/** The `Time limit:` line a parent writes into a child's prompt — on a line of its own. */
export const TIME_LIMIT_LINE = /^[ \t]*time limit:[ \t]*([^\n]+?)[ \t]*$/im

export function childDeadlineMs(input: { nowMs: number; parentDeadlineMs?: number | null; declaredMs?: number | null }): number | undefined {
  const { nowMs } = input
  const declared = input.declaredMs != null && input.declaredMs > 0 ? nowMs + Math.max(DEADLINE_MIN_MS, input.declaredMs) : undefined
  if (input.parentDeadlineMs == null) return declared
  const remaining = input.parentDeadlineMs - nowMs
  const reserve = Math.min(remaining / 2, Math.max(remaining * CHILD_RESERVE_FRACTION, CHILD_RESERVE_MIN_MS))
  const ceiling = Math.max(nowMs + DEADLINE_MIN_MS, Math.round(input.parentDeadlineMs - reserve))
  return declared === undefined ? ceiling : Math.min(declared, ceiling)
}

// ---- THE RPC SHAPES -----------------------------------------------------------------------------------

const IsoInstant = z.string().refine((v) => Number.isFinite(Date.parse(v)), "must be an ISO-8601 instant")

/** The HUMAN's control — the drawer's set / extend / clear. `deadline: null` clears. Refused to a
 *  worker's shim (router.ts): a worker goes through `ownDeadline`, which keeps the human's rule. */
export const SetThreadDeadlineInput = z.object({
  slug: ThreadSlug,
  deadline: IsoInstant.nullable(),
}).strict()
export type SetThreadDeadlineInput = z.infer<typeof SetThreadDeadlineInput>

/** The human's machine-wide wrap-up (the palette's "Time limit for running threads"): one deadline on
 *  every Running thread in every open project, with an optional note each worker reads beside it —
 *  "restarting the machine in 15m, leave the work easy to resume". A thread already due sooner keeps
 *  its own deadline. Refused to a worker's shim, like `setThreadDeadline`. */
export const SetRunningDeadlinesInput = z.object({
  /** `null` removes the limit from every Running thread instead; the note is then unused. */
  deadline: IsoInstant.nullable(),
  note: z.string().trim().max(2_000).optional(),
}).strict()
export type SetRunningDeadlinesInput = z.infer<typeof SetRunningDeadlinesInput>
export const SetRunningDeadlinesResult = z.object({
  /** Running threads that now carry the deadline (or kept a sooner one), or had theirs removed, and were told. */
  threads: z.number().int(),
  /** How many distinct projects those threads are in. */
  projects: z.number().int(),
  /** Running sub-agents and Workflow agents of those threads that were reached through their mailboxes. */
  children: z.number().int(),
})
export type SetRunningDeadlinesResult = z.infer<typeof SetRunningDeadlinesResult>

/** `mcp__ntwine__deadline`: the worker's own read / set / extend / clear. */
export const OwnDeadlineInput = z.object({
  slug: ThreadSlug,
  action: z.enum(["read", "set", "extend", "clear"]),
  /** For `set` / `extend`: a DURATION from now (`30m`, `2h`, `1h 30m`). */
  for: z.string().trim().min(1).max(32).optional(),
  /** For `set` / `extend`: an exact instant instead. */
  at: IsoInstant.optional(),
}).strict()
export type OwnDeadlineInput = z.infer<typeof OwnDeadlineInput>

export const ThreadDeadlineView = z.object({
  /** The deadline, ISO8601. */
  at: z.string(),
  /** When this deadline was set — the budget runs from here. */
  setAt: z.string(),
  setBy: z.enum(["human", "worker"]),
}).strict()
export type ThreadDeadlineView = z.infer<typeof ThreadDeadlineView>

export const OwnDeadlineResult = z.object({
  deadline: ThreadDeadlineView.nullable(),
}).strict()
export type OwnDeadlineResult = z.infer<typeof OwnDeadlineResult>
