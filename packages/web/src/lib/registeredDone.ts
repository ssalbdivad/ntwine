import type { ThreadView } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"

// Whether the thread's bottom must draw the done card ITSELF, for a completion the worker registered
// with `frizzctl done` rather than wrote as a ```done fence.
//
// A fenced done is drawn where it was written: the transcript parses the final message and puts a
// FenceCard in place of the block (ChatView renderText). A registered done is in no message at all —
// the board synthesizes the fence off a `thread_done` row and every predicate treats the two alike
// (board.registeredDoneFence) — so nothing on the page drew it, and a thread that signed off by tool
// rested with prose and no card of any kind (maintainer 2026-08-27: "I don't see anything: any
// awaiting card or any question card or anything at all"). This is the rung that draws it, at the end
// of the ladder in both transcript paths and on the queue card.
//
// `lastAssistantText` is the dedupe: a worker that wrote the fence AND called the verb (the contract
// describes the tool as "that same body") would otherwise show the same card twice, once in the message
// and once here. The message's own card wins — it is already where the eye lands — and the registration
// still does what only it can: gate the sign-off and outlive the message.
export function showsRegisteredDoneCard(
  thread: Pick<ThreadView, "lastFence"> | undefined,
  lastAssistantText: string | undefined,
): boolean {
  const fence = thread?.lastFence
  if (!fence || fence.kind !== "done" || fence.registered !== true) return false
  if (lastAssistantText && splitFenceBlocks(lastAssistantText).some((seg) => seg.kind === "fence" && seg.fenceKind === "done")) return false
  return true
}

// The body that card draws. Once the human has written past the done and the worker answered in prose,
// the done still stands but its ledger is history the human already read; redrawn in full it sat under
// every follow-up answer as the biggest thing on screen (David 2026-10-01: "don't keep showing a
// giant done message like this when I'm asking questions"). The card shrinks to its header and its
// Mark-as-done button, which is all the sign-off still has to say.
export function registeredDoneBody(fence: Pick<NonNullable<ThreadView["lastFence"]>, "body" | "spokenPast">): string {
  return fence.spokenPast ? "" : fence.body
}
