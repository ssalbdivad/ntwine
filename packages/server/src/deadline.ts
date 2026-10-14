import { deadlineStageAtMs, deadlineStageDue, deadlineStageRank, preciseSpanLabel, spanLabel, type DeadlineSetter, type DeadlineStage, type ThreadDeadlineView } from "@ntwine/shared"
import type { SessionRow } from "./storage.ts"

// THE THREAD'S TIME LIMIT, as the WORKER meets it (ARCHITECTURE.md § Time limits). The shared half
// (@ntwine/shared deadline.ts) parses what the human typed and places the stages; this half is what the
// worker reads — the section of its system prompt, the check-ins, the notice when the human moves the
// clock — and the one reading of a row's deadline every server reader shares.
//
// Precedent: the background-shell budget (shell-budget.ts, scheduler SOURCE 13) — opt-in, sized by the
// party that knows, reaching the worker mid-turn. A deadline is that one level up: the subject is the
// thread instead of a shell, and the consequence is a handoff instead of a `TaskStop`. Unlike the shell
// budget there is no teeth: nothing is ever stopped (the agent completion invariant), so the whole
// mechanism is what the worker is told and what the board shows.

export interface ThreadDeadline {
  atMs: number
  setAtMs: number
  setBy: DeadlineSetter
  /** The generation, verbatim — what delivery ids and the stage ledger are keyed on. */
  setAt: string
  /** The last check-in stage queued for this generation. */
  stage: DeadlineStage | undefined
}

/** A row's deadline, or undefined when it has none (or the columns do not parse — a deadline ntwine
 *  cannot read is not one it can keep). */
export function rowDeadline(row: Pick<SessionRow, "deadline_at" | "deadline_set_at" | "deadline_set_by" | "deadline_stage"> | undefined | null): ThreadDeadline | undefined {
  if (!row?.deadline_at || !row.deadline_set_at) return undefined
  const atMs = Date.parse(row.deadline_at)
  const setAtMs = Date.parse(row.deadline_set_at)
  if (!Number.isFinite(atMs) || !Number.isFinite(setAtMs)) return undefined
  const stage = row.deadline_stage === "half" || row.deadline_stage === "converge" || row.deadline_stage === "final" || row.deadline_stage === "over"
    ? row.deadline_stage
    : undefined
  return { atMs, setAtMs, setBy: row.deadline_set_by === "worker" ? "worker" : "human", setAt: row.deadline_set_at, stage }
}

/** The board's reading of a row's deadline (ThreadView.deadline), or undefined when it has none. */
export function deadlineViewOf(row: Parameters<typeof rowDeadline>[0]): ThreadDeadlineView | undefined {
  const d = rowDeadline(row)
  return d ? { at: new Date(d.atMs).toISOString(), setAt: d.setAt, setBy: d.setBy } : undefined
}

/** Local wall clock, `15:30` — or `Oct 7 15:30` when it is not today. The worker's other clock readings
 *  (the wake header) are local too, because that is the clock the human reading the transcript is on. */
export function deadlineClock(atMs: number, nowMs: number): string {
  const at = new Date(atMs)
  const now = new Date(nowMs)
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  if (at.toDateString() === now.toDateString()) return hm
  return `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()} ${hm}`
}

/** A budget's length to the nearest minute. The instant the browser resolved "2h" to is a few hundred
 *  milliseconds ahead of the dispatch that stamps the start, and "a 1h 59m budget" is not what was asked. */
export function budgetLabel(ms: number): string {
  return spanLabel(Math.max(60_000, Math.round(ms / 60_000) * 60_000))
}

/** `15:30 (a 2h budget)` — the deadline as every worker-facing message names it. */
function named(d: Pick<ThreadDeadline, "atMs" | "setAtMs">, nowMs: number): string {
  return `${deadlineClock(d.atMs, nowMs)} (a ${budgetLabel(d.atMs - d.setAtMs)} budget)`
}

// ---- THE CHECK-INS ----------------------------------------------------------------------------------
// One per stage, each asking for a different behaviour. Written for a model that has no clock of its
// own (wakeTimeHeader), so each says the time left in absolute and relative form. Delivered mid-turn,
// headed so the worker reads it as ntwine speaking rather than as output of whatever tool it just ran.

export function deadlineCheckInMessage(stage: DeadlineStage, d: Pick<ThreadDeadline, "atMs" | "setAtMs" | "setBy">, nowMs: number): string {
  const left = preciseSpanLabel(Math.max(0, d.atMs - nowMs))
  const when = named(d, nowMs)
  const setter = d.setBy === "human" ? "the user" : "you"
  switch (stage) {
    case "half":
      return (
        `⏰ Time check: half your time is gone — ${left} left until your deadline at ${when}, set by ${setter}.\n\n` +
        "This is not a signal to wrap up: the other half is yours, so keep working. If you are still exploring, commit to an approach now: the one you can finish and hand over by the deadline, " +
        "not the one that would be best given unlimited time. Commit at each coherent checkpoint so what exists is " +
        "always something you could hand over."
      )
    case "converge":
      return (
        `⏰ Time check: ${left} left until your deadline at ${when}.\n\n` +
        "Start nothing new. Finish what is open, commit it, and make your write-up true as of now — what is done, " +
        "what is not. If you have sub-agents running, decide now which results you can still fold in."
      )
    case "final":
      return (
        `⏰ Time check: ${left} left until your deadline at ${when}.\n\n` +
        "Hand off at your next stop. Do not start another step: commit what you have and write the handoff — what " +
        "is done, what is not, and what you would do next."
      )
    case "over":
      return (
        `⏰ Your time is up: the deadline was ${when}.\n\n` +
        "Your next stop is the handoff. Finish the step you are in, commit it, and hand over: what is done, what is " +
        "not, and what you would do next. Nothing interrupts you, but the board now shows this thread as over time, " +
        `and no further reminders are coming.${d.setBy === "human" ? " Only the user can extend this deadline." : ""}`
      )
  }
}

/** What the worker is told when the HUMAN sets, moves or removes its deadline after dispatch — the one
 *  change the worker did not make itself and cannot otherwise see (its system prompt states the deadline
 *  as of the last time it was composed). */
/** `note`: the human's own words, sent with a machine-wide wrap-up (router setRunningDeadlines) — quoted
 *  verbatim, because the reason ("restarting in 15m") changes what the best handoff is. */
export function deadlineNoticeMessage(change: { kind: "set"; deadline: Pick<ThreadDeadline, "atMs" | "setAtMs">; previousAtMs?: number; note?: string } | { kind: "cleared" }, nowMs: number): string {
  if (change.kind === "cleared") {
    return "⏰ The user removed your time limit. There is no deadline any more: work to the best deliverable, not to a clock."
  }
  const d = change.deadline
  const left = preciseSpanLabel(Math.max(0, d.atMs - nowMs))
  const verb = change.previousAtMs === undefined
    ? "set a time limit"
    : d.atMs > change.previousAtMs ? "extended your deadline" : d.atMs < change.previousAtMs ? "moved your deadline earlier" : "kept your deadline"
  const note = change.note?.trim()
  return (
    `⏰ The user ${verb}: your deadline is now ${deadlineClock(d.atMs, nowMs)}, ${left} from now.\n\n` +
    (note ? `${note.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "") +
    "Plan to the best deliverable you can hand over by then, not the complete one eventually. ntwine checks in " +
    "at half-time, at 80% and shortly before the deadline."
  )
}

// ---- THE WORKER PROMPT SECTION --------------------------------------------------------------------
// Present only when a deadline is set, injected beside the NTWINE.md block wherever the system prompt is
// composed — at dispatch and at every cold resume — so a worker brought back from disk still knows. It
// states the deadline as of composition; a later change reaches a live worker as a notice
// (deadlineNoticeMessage), and every check-in restates the current one.

export function deadlineSection(row: Parameters<typeof rowDeadline>[0], nowMs = Date.now()): string {
  const d = rowDeadline(row)
  if (!d) return ""
  const stageAt = (stage: DeadlineStage) => deadlineClock(deadlineStageAtMs(d.setAtMs, d.atMs, stage), nowMs)
  const left = d.atMs - nowMs
  const status = left > 0 ? `${spanLabel(left)} from now` : `already passed, ${spanLabel(-left)} ago`
  const extend = d.setBy === "human"
    ? "The user set it, and only the user can move or remove it: `ntwinectl deadline read` reads it, and `extend` refuses it."
    : "You set it yourself with `ntwinectl deadline`, which can also move (`extend`) or `clear` it."
  return (
    "## Your time limit\n\n" +
    `This thread has a DEADLINE: ${deadlineClock(d.atMs, nowMs)} (a ${budgetLabel(d.atMs - d.setAtMs)} budget; ${status}). ${extend}\n\n` +
    "**The job is the best deliverable you can hand over BY THEN, not the complete one eventually.** Nothing stops you at " +
    "the deadline: it is enforced by what you are told and by the board showing this thread as over time.\n\n" +
    "- **Plan to an anytime deliverable.** Commit at each coherent checkpoint and keep your write-up true at every stage, " +
    "so that whenever the clock runs out there is something real to hand over — never a big reveal at the end.\n" +
    `- **ntwine checks in, mid-turn, at fixed points:** half-time (${stageAt("half")}) — if you are still exploring, commit to an ` +
    `approach; 80% (${stageAt("converge")}) — start nothing new, finish and commit what is open; just before the deadline ` +
    `(${stageAt("final")}) — hand off at your next stop; and at the deadline itself — your next stop IS the handoff. Every wake ` +
    "ntwine sends you also carries the time left on its clock line.\n" +
    "- **Waiting counts.** The clock is wall time, parks and pauses included. A wait on CI or a reviewer that will outlive the " +
    "deadline is handed to the user, not waited out.\n" +
    "- **Size your sub-agents' time explicitly.** Put a line `Time limit: 20m` on a line of its own in an Agent or Workflow " +
    "agent prompt to give that child a budget; without one it gets your remaining time minus a reserve for you to fold its " +
    "result in, and it is never given more than that. Leave yourself the time to integrate what they return."
  )
}

/** The stage the scheduler should check in at now, given what was already queued — or undefined. Only the
 *  LATEST due stage is ever sent, and never one at or below the ledger's. */
export function deadlineStageToSend(d: ThreadDeadline, nowMs: number): DeadlineStage | undefined {
  const due = deadlineStageDue(d.setAtMs, d.atMs, nowMs)
  if (!due) return undefined
  if (deadlineStageRank(d.stage) >= deadlineStageRank(due)) return undefined
  return due
}
