import { formatGoalFor, type ThreadRecurringPrompt } from "@ntwine/shared"
import { formatRuntimeElapsed } from "./durationLabels.ts"

// THE GOAL AS A LOOP: its run counter and limits, in the one short phrase the thread header's facts line
// shows after the goal mark (ThreadHeaderFacts; it rode in the lifecycle footer from 2026-09-29 until that
// footer went). A Goal with limits is a bounded loop, and the question an operator asks of one at a glance
// is "how far through is it, and when does it end" — so the line answers it without a click: `run 7 of 20`, `run 7`, `run 3 of 20 · 1h 12m left`, and once it has ended, why.
//
// Nothing for a Goal that is neither counting toward anything nor has anything to say: an unbounded Goal
// that has not delivered yet, or one switched off by hand. A reading with nothing in it is noise.
//
// Durations are the house grammar (`2h 35m`, durationLabels.ts); the bound itself reads back in the
// `for:` token it was written as (`2h`), because that is the value the operator typed.
export function goalLoopReading(rp: ThreadRecurringPrompt | undefined, nowMs: number): string | null {
  const parts = goalLoopParts(rp, nowMs)
  return parts ? [parts.lead, parts.tail].filter(Boolean).join(" · ") : null
}

/** The reading in its two halves — the count (or the stop) and the time left (ThreadHeaderFacts). */
export function goalLoopParts(rp: ThreadRecurringPrompt | undefined, nowMs: number): { lead: string; tail?: string } | null {
  if (!rp) return null
  const runs = rp.runs ?? 0
  if (rp.stopped) {
    return rp.stopped.reason === "runs"
      ? { lead: "stopped", tail: `${runs} of ${rp.maxRuns ?? runs} runs` }
      : { lead: "stopped", tail: `${rp.forSeconds ? `${formatGoalFor(rp.forSeconds)} ` : ""}limit reached` }
  }
  const live = rp.stopHook || rp.heartbeat || rp.postCompaction
  if (!live) return null
  // "run 7" names the run IN PROGRESS — seven deliveries have landed and the seventh is being worked. So
  // nothing delivered yet is not "run 0", it is a count still to start.
  const count = rp.maxRuns
    ? runs > 0 ? `run ${runs} of ${rp.maxRuns}` : `0 of ${rp.maxRuns} runs`
    : runs > 0 ? `run ${runs}` : null
  const endsAt = rp.endsAt ? Date.parse(rp.endsAt) : Number.NaN
  const left = Number.isFinite(endsAt)
    ? endsAt > nowMs ? `${formatRuntimeElapsed(endsAt - nowMs)} left` : "time up"
    : null
  if (count) return left ? { lead: count, tail: left } : { lead: count }
  return left ? { lead: left } : null
}

/** The same facts as a sentence, for the hover and the panel, where there is room to say what the
 *  limits ARE rather than only how far along they are. */
export function goalLimitsSentence(rp: { maxRuns?: number | null; forSeconds?: number | null } | undefined): string {
  const limits = [
    rp?.maxRuns ? `${rp.maxRuns} run${rp.maxRuns === 1 ? "" : "s"}` : null,
    rp?.forSeconds ? formatGoalFor(rp.forSeconds) : null,
  ].filter((p): p is string => p !== null)
  return limits.length ? `stops after ${limits.join(" or ")}` : "no limit"
}

/** A Goal that is armed to fire at rest but has not been sent yet under its current text — the gap
 *  between the operator pressing save and the first delivery, which on a working thread lasts until the
 *  agent stops. The transcript shows a line for exactly this window (ChatView `goal-pending`), so a
 *  Goal set mid-turn does not read as ignored. Keyed on `armedAt`, which moves only when the text or the
 *  cadence changes, so a trigger flipped off and on again over words already sent shows nothing. */
export function goalAwaitingFirstRest(rp: ThreadRecurringPrompt | undefined): boolean {
  if (!rp || !rp.stopHook || rp.stopped || !rp.prompt.trim()) return false
  const armed = Date.parse(rp.armedAt)
  return ![rp.lastRestFiredAt, rp.lastScheduleFiredAt, rp.lastCompactFiredAt]
    .some((at) => at !== undefined && Date.parse(at) >= armed)
}
