import { Repeat, Timer, Signpost } from "lucide-react"
import type { RecurringPrompt } from "@frizz/shared"
import { WakeDivider } from "./WakeDivider.tsx"

// A DELIVERED recurring prompt, in the transcript: a HAIRLINE NOTIFICATION, the same one every other
// child event in this app wears.
//
// It arrives as an ordinary user turn (frizz pastes it into the worker's composer), so left alone it
// rendered as the human's own bubble — claiming the operator had typed a paragraph the
// scheduler composed, and repeating that paragraph in full every few minutes on any thread actually
// being driven by one.
//
// It briefly rendered instead as a bespoke collapsible row, which was worse for a reason worth
// recording: it was BUILT to look like a tool call rather than BEING one, so it matched nothing —
// "that is not what the rest of our tool calls look like… our tool calls have a consistent UI"
// (maintainer 2026-08-03). Inventing a third idiom to sit between two existing ones is how a transcript
// stops reading as one surface.
//
// WakeDivider is the right home and needed no argument: a beat or a bump is exactly the class it
// already serves — something outside the turn reached a notable state and re-invoked the agent — beside
// a background shell resting, a Monitor timing out, a sub-agent finishing or reporting up, and a
// PR-watcher wake. It also gets the family's centred rule, petite-caps label, icon sizing and measured
// optical nudge for free, which is the whole reason that component exists.
//
// The label is the WHOLE notification: no disclosure, no prompt body. The delivered text is the armed
// text, and the armed text is already legible and editable in the footer panel — so repeating it inline
// on every delivery adds nothing a reader cannot already get, which is the failure both earlier
// renderings shared.
export function RecurringPromptLine({ bump, sourceId, at }: { bump: RecurringPrompt; sourceId?: string; at?: string }) {
  const scheduled = bump.kind === "schedule"
  // FRIZZ'S OWN SIGN-OFF REMINDER collapses hardest of all, because it is the only delivery here whose
  // body says nothing about this thread: it is the protocol, restated. Rendered in full it sat as a card
  // ABOVE the agent's actual handoff and read as the more important of the two (maintainer 2026-08-12:
  // "We shouldn't show the stop hook message in the UI, at least not by default").
  if (bump.kind === "signoff") {
    const label = "Frizz asked for a sign-off"
    return (
      <WakeDivider icon={Signpost} sourceId={sourceId} marker="rest" ariaLabel={label} at={at}>
        {label}
      </WakeDivider>
    )
  }
  // WHICH TRIGGER FIRED is the whole label, because it is the one thing the footer panel cannot tell you
  // about THIS delivery — the text is shared, so "the agent stopped" and "an hour elapsed" are otherwise
  // indistinguishable in the transcript. The cadence rides along for the same reason: it names the
  // schedule that was in force when this one fired, not the one armed now.
  // "Goal", because that is what the panel, the footer mark and the delivered trailer all call it since
  // 2026-08-11. The divider kept the old name for a day and was the only surface still saying it.
  const label = scheduled
    ? `Goal${bump.every ? ` · every ${bump.every}` : ""}`
    : "Goal · at rest"
  return (
    <WakeDivider
      // TWO glyphs, one per TRIGGER, because a divider marks ONE delivery and the two triggers answer
      // different questions: a clock for the scheduled one, a loop for the rest one (which has no clock
      // — it fired because the thread stopped, again). They survived the merge of the two features into
      // one prompt precisely because the trigger is what a reader still cannot infer. The footer's own
      // glyph is deliberately a THIRD mark — a heart with a pulse — because it stands for both at once.
      //
      // The rest trigger's was `CircleStop`, and in a wake line that is backwards: this divider exists to
      // say the agent was RE-INVOKED, and a stop button in the transcript reads as the run ending here.
      // Same square-in-a-circle the footer shed on 2026-08-03, for a related reason.
      icon={scheduled ? Timer : Repeat}
      sourceId={sourceId}
      marker={scheduled ? "schedule" : "rest"}
      ariaLabel={label}
      at={at}
    >
      {label}
    </WakeDivider>
  )
}
