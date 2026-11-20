import { formatFixedDuration, formatToolDuration } from "./durationLabels.ts"
import { AGENT_OUTCOME_VERB } from "./subAgentCompletion.ts"

// WHAT A DISPATCH CARD'S RIGHT-HAND READING SAYS — the whole vocabulary and tone matrix, in one place.
//
// It was previously spread across two renderers inside AgentBlock, chosen by whether the client still
// held a live record for the child, and the two disagreed about everything a reader can see. Eight rows
// of the same kind rendered as: "3m" / "stopped 41m" / "failed 12m" in lowercase sans at three different
// alphas, then "CANCELLED" in amber petite-caps and "FAILED · 12 SEC" in red petite-caps (maintainer
// 2026-07-29: "a bizarre mix of font sizes, color saturations, and capitalization"). Two of those pairs
// were the SAME EVENT twice: a killed child reads "stopped", and a dispatch whose child record aged out
// reads "cancelled" — same interruption, different word, different colour, different typography.
//
// Whether a child record survived is an internal data-availability detail. It must never change the
// words or the tone, so both paths now resolve through this function.
//
// THREE decisions it encodes:
//
//  1. THE WORDS come from AGENT_OUTCOME_VERB, the same map the completion divider reads, and a NOMINAL
//     outcome has none: a card showing a runtime and no liveness mark already means "it ran and stopped"
//     (maintainer 2026-07-29). Only "stopped" and "failed" are things no mark can say.
//
//  2. THE DURATION is at MINUTE resolution — the form the completion divider two lines below it already
//     uses (formatFixedDuration), so the card and the divider describing one child read identically:
//     "STOPPED · 41M" on both. The resolution is the choice here, not the spelling: units come from the
//     house duration grammar (durationLabels.ts) like every other reading in the app, and the seconds
//     this rounds away are not lost — they ride the tooltip, which takes formatToolDuration's precise
//     form. Until 2026-08-31 this row spelled its units out ("41 MIN") to keep a small-capital M off a
//     petite-caps line; the grammar's own hour rung does that job now, so no reading here can be a bare
//     three-digit M.
//
//  3. THE TONE is binary. A genuine failure is the red every tool card uses; EVERYTHING else, including
//     an interruption, is the quiet muted gray. Amber is gone from this row: it was saying "caution"
//     about a dispatch someone deliberately stopped.
export type AgentReadingStatus = "pending" | "completed" | "failed" | "cancelled"

export interface AgentReadingInput {
  /** The harness's terminal verdict on the child, once the transcript records one. */
  agentStatus?: "completed" | "failed" | "killed"
  /** Dispatch→completion elapsed, from the harness. */
  agentElapsedMs?: number
  /** The client's live record for this child, while it still holds one. */
  liveState?: "running" | "stale" | "rested" | "waiting" | "stopped"
  /** Elapsed since dispatch. Passed in rather than computed so this stays pure and the live clock drives it. */
  liveElapsedMs?: number
  /** The dispatch CALL's own status — the only signal left when no child record exists. */
  status?: AgentReadingStatus
  durationMs?: number
}

export interface AgentReading {
  /** The verb, or absent when a mark (or the absence of one) already carries the state. */
  label?: string
  duration?: string
  tone: "muted" | "failed"
  /** The tooltip: a full sentence, carrying the PRECISE duration the minute-resolution reading rounds. */
  title: string
}

const precise = (ms?: number): string | undefined => (ms === undefined ? undefined : formatToolDuration(ms))
const coarse = (ms?: number): string | undefined => {
  if (ms === undefined) return undefined
  return formatFixedDuration(ms) || undefined
}

/** The reading, or null when there is genuinely nothing to report (never a fabricated one). */
export function agentReading(input: AgentReadingInput): AgentReading | null {
  const { agentStatus, agentElapsedMs, liveState, liveElapsedMs, status, durationMs } = input

  // 1. A RESOLVED child: the harness's own verdict and elapsed win over the call's.
  if (agentStatus) {
    const stopped = agentStatus === "killed"
    const failed = agentStatus === "failed"
    const exact = precise(agentElapsedMs)
    return {
      label: agentStatus === "completed" ? undefined : AGENT_OUTCOME_VERB[agentStatus],
      duration: coarse(agentElapsedMs),
      tone: failed ? "failed" : "muted",
      title: `${stopped ? "Stopped" : failed ? "Failed" : "Ran for"}${stopped || failed ? " after" : ""} ${exact ?? "an unknown time"}`,
    }
  }

  // 2. A TRACKED child: the mark on the left says running / stale / rested, so the reading is the bare
  //    runtime. Only a RUNNING child is "working" — a stale or rested one has stopped producing, and a
  //    tooltip claiming otherwise would contradict the mark beside it.
  if (liveState) {
    const exact = precise(liveElapsedMs)
    return {
      label: undefined,
      duration: coarse(liveElapsedMs),
      tone: "muted",
      title: liveState === "running" ? `Working for ${exact ?? "an unknown time"}` : `Dispatched ${exact ?? "an unknown time"} ago`,
    }
  }

  // 3. NO child record — the call's own status is all that is left. A SUCCESSFUL spawn call says only
  //    that dispatch returned; its duration is RPC latency, NOT the child runtime. Render nothing rather
  //    than claiming a 13-minute agent "ran for 533 ms". Failed/cancelled calls never launched a child,
  //    so their own terminal timing remains honest and useful.
  //
  //    A PENDING one renders nothing either, and that is the point: this reading may never claim
  //    liveness (maintainer 2026-08-01, of the spinner that used to live here — "a right-justified
  //    spinner with the 'running' label that should not show up under any circumstances"). `pending` is
  //    not evidence a child is alive — the server keeps an Agent launch pending until a task-notification
  //    correlates to it, so a dispatch whose terminal signal never arrived stays pending FOREVER and the
  //    spinner went on advertising a child that had been dead for hours. Liveness is now stated in
  //    exactly one place, the left-hand mark, which requires an OBSERVED live child record.
  if (status === "pending") return null
  if (status !== "failed" && status !== "cancelled") return null
  const failed = status === "failed"
  const stopped = status === "cancelled"
  const exact = precise(durationMs)
  return {
    label: stopped ? AGENT_OUTCOME_VERB.killed : failed ? AGENT_OUTCOME_VERB.failed : undefined,
    duration: coarse(durationMs),
    tone: failed ? "failed" : "muted",
    title: `${stopped ? "Stopped after" : failed ? "Failed after" : "Ran for"} ${exact ?? "an unknown time"}`,
  }
}
