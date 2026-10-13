// THE STEPS on a resting card whose ```awaiting fence hands the human `steps:` (2026-10-03) — things
// only they can perform: a sign-in, an approval, a merge the worker may not make. They ride the fence
// itself rather than a registered row (maintainer 2026-10-03: "I don't think this requires persistently
// registering it. Is there a way to do this just inside of the awaiting card?"), so this is a stratum
// of AwaitingBackgroundCard, not a card of its own.
//
// ONE VERB, AND IT SENDS AN ORDINARY REPLY. "Done" sends the human's own message — the word itself —
// through the same eager follow-up the composer uses, so it lands as their bubble, wakes the worker
// exactly as anything they type would, and rolls back the same way if the send fails. There is no
// second verb and no note box: anything else the human has to say — a step that failed, what account
// they signed in with — goes through the prompt box under the card like any other steer (maintainer
// 2026-10-03: "The user can just send a new steer message in the prompt box if they want."). Nothing
// is stored and nothing settles: the fence lives as long as the message carrying it, and the reply is
// what ends it.
import { useState } from "react"
import { Check } from "lucide-react"
import { STEPS_DONE } from "../lib/awaitingPresentation.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { useTickedSteps } from "../lib/stepsTicked.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CardActions, QUEUE_WRAP } from "./TranscriptCard.tsx"

/** The steps as a TO-DO STEPPER — what the human reads, and ticks off, before pressing Done.
 *
 *  A STEPPER, NOT A MARKDOWN LIST (2026-10-12, maintainer: "if this is supposed to be rendering like a
 *  classic to-do stepper, it's not doing that"). Until then the steps were an `<ol>` with decimal
 *  markers, which reads as one more paragraph of the handoff rather than a sequence of acts: nothing
 *  separated one step from the next, and a five-step card gave the reader no way to keep their place.
 *  Now each step is a numbered marker on a rail the reader can tick, the marker turning into a check and
 *  the step dimming. The colours follow TodoBlock's ruling for the transcript's own checklist: exactly one
 *  marker takes the accent — the first step not yet ticked, the one to do next — and done is monochrome.
 *
 *  `live` is whether the thread is resting on THESE steps (AwaitingBackgroundCard `stepsLive`). Only then
 *  are the markers controls and is there a step to do next; a card drawn after the reply is a record of
 *  what was asked, and shows the ticks it was left with, inert. */
export function StepsList({ steps, live }: { steps: readonly string[]; live: boolean }) {
  const [ticked, toggle] = useTickedSteps(steps)
  const next = live ? steps.findIndex((_, i) => !ticked.has(i)) : -1
  return (
    // One markdown block PER STEP, rather than the steps joined into one markdown string: a step carries
    // its own code span or link, and joined steps would each need re-indenting to stay inside their item.
    //
    // THE SAME PROSE AS THE PARAGRAPH ABOVE IT, in strength and in rhythm. The list sat at full strength
    // under a paragraph at the card's 75% until 2026-10-05, and the maintainer read it as a defect
    // ("the paragraphs looks like they're a slightly lighter color than the text in the ol"): one body
    // is one colour, which is the card's (CardContent). And the gap above the list is the paragraph
    // break the prose itself uses (`--md-step`, which `.card-md .md-body` sets on this very element), not
    // a tighter 8px of its own — the two blocks are one handoff rendered in two pieces.
    <div data-awaiting-steps className={`md-body ${QUEUE_WRAP} mt-[var(--md-step)] first:mt-0`}>
      <ol className="frizz-steps">
        {steps.map((step, i) => (
          <Step key={i} n={i + 1} md={step} done={ticked.has(i)} next={i === next} onToggle={live ? () => toggle(i) : undefined} />
        ))}
      </ol>
    </div>
  )
}

function Step({ n, md, done, next, onToggle }: { n: number; md: string; done: boolean; next: boolean; onToggle?: () => void }) {
  const html = useMarkdownHtml(md)
  // The check is the task family's own (`.md-task-checked`): lucide `Check` at strokeWidth 3, its viewBox
  // shifted −0.5 in y because the path's ink centres half a unit above the box's.
  const glyph = done ? <Check aria-hidden="true" size="0.62em" strokeWidth={3} viewBox="0 -0.5 24 24" /> : <span className="frizz-step-num" aria-hidden="true">{n}</span>
  const state = done ? "done" : next ? "next" : "todo"
  return (
    <li className="frizz-step" data-step-state={state}>
      <span className="frizz-step-gutter">
        <span className="frizz-step-line">
          {/* The RING is a span and the control sits inside it, never the other way round: Chrome puts a
              `<button>`'s baseline at its CONTENT box, a border-width above the bottom edge the cap-band
              rule assumes, and a button ring rode exactly 1.00px low (measured 2026-10-12). */}
          <span data-step-mark className="frizz-step-mark">
            {onToggle ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                aria-label={`Step ${n}`}
                className="frizz-step-face"
                onClick={onToggle}
                onMouseDown={(e) => e.preventDefault()}
              >
                {glyph}
              </button>
            ) : (
              <span className="frizz-step-face">{glyph}</span>
            )}
          </span>
        </span>
        <span className="frizz-step-rail" aria-hidden="true" />
      </span>
      <LinkedHtml className="md-body frizz-step-text" html={html} />
    </li>
  )
}

/** The card's one verb — drawn only while the thread is resting on THESE steps, which is the caller's
 *  test (AwaitingBackgroundCard `stepsLive`). */
export function StepsDone({ slug, onReplied, onReplyFailed, send }: {
  slug: string
  /** The queue's optimistic card exit, as for its Snooze; absent off the queue. */
  onReplied?: () => void
  onReplyFailed?: () => void
  /** Deliver the reply some other way than the page's eager follow-up — the queue card's, which sends
   *  into the CARD's project (lib/projectFollowUp.ts): `useEagerFollowUp` addresses the page's project,
   *  and on All projects that is usually not the card's, so its "Done" would have reached the page
   *  project's thread of the same slug. Rejects when the send failed. Absent everywhere else. */
  send?: (message: string) => Promise<void>
}) {
  const followUp = useEagerFollowUp(slug)
  // Latched on the click and released only by a rollback: between the send and the worker's turn
  // starting the card is still on screen, and a second click would send "Done" twice.
  const [sent, setSent] = useState(false)
  const reply = () => {
    setSent(true)
    if (send) {
      // The same order the eager send keeps: the card leaves first, then the network, and a failure puts
      // both back.
      onReplied?.()
      send(STEPS_DONE).catch(() => {
        setSent(false)
        onReplyFailed?.()
      })
      return
    }
    const started = followUp.submit(STEPS_DONE, {
      onOptimistic: () => onReplied?.(),
      onRollback: () => {
        setSent(false)
        onReplyFailed?.()
      },
    })
    if (!started) setSent(false)
  }
  return (
    <CardActions data-awaiting-steps-reply>
      <button
        type="button"
        data-steps-done
        disabled={sent}
        onClick={reply}
        onMouseDown={(e) => e.preventDefault()}
        className={`${CARD_PRIMARY_ACTION} disabled:opacity-60`}
      >
        {STEPS_DONE}
      </button>
    </CardActions>
  )
}
