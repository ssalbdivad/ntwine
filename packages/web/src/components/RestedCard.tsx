// THE STALL CARD: the process exited mid-turn (`crashed`), which is not a rest at all, and the bottom of
// the thread says so and points at the header's Retry. Its final record is often a tool call with no
// prose, so the card is about the process, not the message, and it wins over any fence that message
// carries. It is last in ChatView's chain: every rung above is a harder reading of the same slot.
//
// A BARE REST — the worker spoke last, signed nothing off, registered nothing — drew a card here too,
// "Reply to continue", from 2026-08-27 until 2026-10-16, when the maintainer asked for it gone. The
// sign-off nudge (scheduler.evalSignoffNudges) still covers that rest; the transcript simply ends on
// the worker's message, which is all the card ever added.
import { TriangleAlert } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

export type RestedCardThread = Pick<ThreadView, "kind" | "foreign" | "runtime" | "needsYou" | "queueSettling" | "crashed" | "providerError">

/** Does the chat show the stall card at the bottom of this thread? Only for a thread in the human's
 *  queue whose process exited mid-turn, and never over a provider error, which has its own card. */
export function showsRestedCard(thread: RestedCardThread | undefined): boolean {
  if (!thread || thread.kind !== "session" || thread.foreign) return false
  if (thread.runtime !== "turn-idle" && thread.runtime !== "exited") return false
  // Withheld from the queue for the seconds its wake gets to land (queue-clock.ts) is still a rest.
  if (thread.needsYou !== true && thread.queueSettling !== true) return false
  if (thread.providerError) return false
  return thread.crashed === true
}

export function RestedCard() {
  return (
    <TranscriptCard data-rested-card="stalled" icon={TriangleAlert} label="Stalled">
      <p className={CARD_BODY}>The agent stopped unexpectedly. Retry in the header to resend the last message.</p>
    </TranscriptCard>
  )
}
