import type { ChatMessage } from "../hooks.ts"
import { agentCompletionCall } from "./subAgentCompletion.ts"

// WHEN THE "Agent rested" HAIRLINE SAYS NOTHING THE READER CANNOT ALREADY SEE.
//
// The rule survives because of the one case where the transcript really is ambiguous: a human message
// under an agent's prose can be a REPLY to a finished agent or a STEER typed into a turn still in
// flight, and without the rule those two read identically. Measured over this repo's own 30 Claude
// sessions: 84 human bubbles, 40 of them after a rest and 11 typed mid-turn, so the rule is genuinely
// discriminating there and not a constant. The other two positions it lands in are not:
//
//   · AT THE TAIL, it restates the runtime-status slot directly beneath it. A running turn draws the
//     WorkingIndicator there; a rested one draws nothing (or the awaiting-background card). "The agent
//     is not spinning" is therefore already on screen, and the hairline is a second copy of it.
//   · ABOVE ANOTHER DIVIDER, it restates the divider. Nothing can WAKE an agent that had not come to
//     rest, so "Agent rested" / "Frizz asked for a sign-off" is one fact drawn twice — two hairlines
//     stacked with nothing between them (maintainer 2026-08-13: "we're just getting these back-to-back
//     hairlines that are kind of unnecessary").
//
// A frizz wake DELIVERY counts as a divider even though it is a `role: "user"` record: `wake: true`
// messages render as a FrizzWake or a RecurringPromptLine, never as a plain bubble, so they
// carry the seam themselves. The human's own messages are the only `user` records that do not.
//
// So does a SUB-AGENT COMPLETION, which is an assistant message carrying one flagged call
// (agentCompletionCall) rather than a `boundary` event, but draws the same wake hairline. It is the one
// divider here that can also land MID-TURN, so the rest above it does tell "woke a resting agent" apart
// from "finished while it worked" — and that distinction is not worth a hairline: a parent waiting on N
// children drew a rule above every child's return (maintainer 2026-10-12: "I don't think we need to be
// showing this rested agent hairline every time a sub-agent completes … even if it did come to rest at
// that point in time, maybe this isn't worth doing").
//
// This is presentation, not projection — the server still emits every rest boundary. Dropping them
// server-side would mean a trailing rest that vanishes and then reappears the moment a human replies,
// i.e. a mid-array insertion the live transcript push has no reason to handle.
export function isRedundantRestDivider(
  messages: readonly ChatMessage[],
  index: number,
  rendersNothing: (message: ChatMessage) => boolean,
): boolean {
  const m = messages[index]
  if (!m || m.kind !== "event" || m.boundary !== "rest") return false
  // The next message the reader actually SEES — an empty thinking-only turn between the rule and the
  // divider it duplicates must not save it.
  for (let i = index + 1; i < messages.length; i++) {
    const next = messages[i]
    if (next.queued || rendersNothing(next)) continue
    return Boolean(next.boundary) || next.wake === true || agentCompletionCall(next) !== undefined
  }
  return true // nothing below it: the runtime-status slot is the tail's own answer
}

// The filter both ChatView paths run their message list through. Entries carry their original index
// alongside the message (see coalesceToolActivityMessages), so dropping one cannot shift what
// `paired[messageIndex]` addresses.
export function withoutRedundantRestDividers<T extends { message: ChatMessage }>(
  entries: readonly T[],
  rendersNothing: (message: ChatMessage) => boolean,
): T[] {
  const messages = entries.map((entry) => entry.message)
  return entries.filter((_, i) => !isRedundantRestDivider(messages, i, rendersNothing))
}
