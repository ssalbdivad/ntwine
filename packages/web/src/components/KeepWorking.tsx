// KEEP WORKING — the human's "I've looked, nothing needed" to a worker parked `status: needs_input` while
// the work it named is still running (lib/keepWorking.ts says when it is offered). Two surfaces:
//
//   · KeepWorkingButton — the resting card's verb. It SENDS A MESSAGE (shared KEEP_WORKING_MESSAGE) by the
//     very path the steps' Done takes (AwaitingSteps.StepsDone): the page's eager follow-up, or the queue
//     card's own project send. The worker re-parks `working` on it; ntwine moves nothing itself.
//   · KeepWorkingMarker — that message in the transcript. Its words are for the worker, so the chat draws
//     the human's side of it as one line, the way "Asked for an update" is drawn (NtwineWake
//     UpdateRequestedMarker): right-justified on the bubble's surface, with a glyph and fixed wording so it
//     never reads as something they typed.
import { useState, type ReactNode } from "react"
import { Play } from "lucide-react"
import { KEEP_WORKING_MESSAGE } from "@ntwine/shared"
import { KEEP_WORKING_LABEL, KEEP_WORKING_MARKER } from "../lib/keepWorking.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { BLOCK_RADIUS, CARD_PRIMARY_ACTION } from "./TranscriptCard.tsx"

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

/** The click, in the transcript. `dimmed` is a send not yet read, or one that failed, as the bubble it
 *  stands in for would be; `children` is what that bubble would carry under it (a failed send's row). */
export function KeepWorkingMarker({ sourceId, dimmed, children }: { sourceId?: string; dimmed?: boolean; children?: ReactNode }) {
  return (
    <div data-ntwine-msg={sourceId} data-keep-working-marker className="flex max-w-[85%] flex-col items-end self-end">
      <div className={`flex items-baseline gap-1.5 ${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-2.5 text-[13px] leading-5 text-user-bubble-fg ${dimmed ? "opacity-50" : ""}`}>
        {/* Vertical: the cap-band centring every glyph-beside-text here uses; measured 0.26px off the cap
            centre (sans, 13px, 2026-10-14). Horizontal: lucide's Play paints only 6–20 of its 24 units, so
            on `gap-1.5` its tip sat 8.17px from the T — a gap and a half beside the 5–6px word space the
            label reads in. `-mr-[0.2em]` takes the dead box back, as the spinoff header's mark does. */}
        <Play aria-hidden="true" className="size-[1em] shrink-0 self-baseline -mr-[0.2em] translate-y-[calc(0.5em_-_0.5cap)] opacity-70" />
        <span>{KEEP_WORKING_MARKER}</span>
      </div>
      {children}
    </div>
  )
}
