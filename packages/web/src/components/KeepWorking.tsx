// KEEP WORKING — the human's "I've looked, nothing needed" to a worker parked `status: needs_input` while
// the work it named is still running (lib/keepWorking.ts says when it is offered). Two surfaces:
//
//   · KeepWorkingButton — the resting card's verb. It SENDS A MESSAGE (shared KEEP_WORKING_MESSAGE) by the
//     very path the steps' Done takes (AwaitingSteps.StepsDone): the page's eager follow-up, or the queue
//     card's own project send. The worker re-parks `working` on it; ntwine moves nothing itself.
//   · CardActionMarker (CardActionMarker.tsx) — that message in the transcript, drawn as the human's
//     one-line marker like every other button's send.
import { useState } from "react"
import { KEEP_WORKING_MESSAGE } from "@ntwine/shared"
import { KEEP_WORKING_LABEL } from "../lib/keepWorking.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { CARD_PRIMARY_ACTION } from "./TranscriptCard.tsx"

export function KeepWorkingButton({ slug, onReplied, onReplyFailed, send }: {
  slug: string
  /** The queue's optimistic card exit; absent off the queue. */
  onReplied?: () => void
  onReplyFailed?: () => void
  /** The queue card's send into its own project (AwaitingBackgroundCard `reply`); rejects on failure. */
  send?: (message: string) => Promise<void>
}) {
  const followUp = useEagerFollowUp(slug)
  // Latched until a rollback: the card stays up between the send and the worker's turn starting, and a
  // second click would send the message twice.
  const [sent, setSent] = useState(false)
  const reply = () => {
    setSent(true)
    if (send) {
      onReplied?.()
      send(KEEP_WORKING_MESSAGE).catch(() => {
        setSent(false)
        onReplyFailed?.()
      })
      return
    }
    const started = followUp.submit(KEEP_WORKING_MESSAGE, {
      onOptimistic: () => onReplied?.(),
      onRollback: () => {
        setSent(false)
        onReplyFailed?.()
      },
    })
    if (!started) setSent(false)
  }
  return (
    <button
      type="button"
      data-keep-working
      disabled={sent}
      onClick={reply}
      onMouseDown={(e) => e.preventDefault()}
      title="Tell the agent nothing is needed now, and it goes back to its work"
      className={`${CARD_PRIMARY_ACTION} disabled:opacity-60`}
    >
      {KEEP_WORKING_LABEL}
    </button>
  )
}
