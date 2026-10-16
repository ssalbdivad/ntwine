// WHERE A QUEUE CARD DRAWS ITS QUESTIONS WHILE IT SHOWS THE HANDOFF — the rest each was asked at, read
// off the thread's transcript with the drawer's own readers.
//
// The card opens on the handoff, not the transcript (AllQueuesCard): the human's last turn as their bubble,
// every rest after it the card could have shown (`earlier`), and the newest rest (`text`) — router.ts
// handoffOf. Until 2026-10-06 it drew every open question under that newest rest, which is the bug upstream
// fixed in e157817a: a question asked two rests ago, under a newest rest that says nothing about it, read
// as that rest's sign-off — the "pending questions supersede how the agent actually signed off" report
// (upstream 2026-10-05, e157817a) — and it hid the bare rest's own card, "Reply to continue"
// (RestedCard), which a bare rest is owed (22084580).
//
// The position is the DRAWER'S, computed by the same readers ChatView uses — questionAnchor's
// questionsByAnchor (the rest that asked it, or a later one whose fence claims it under `questions:`),
// questionShadow's placeQuestions (a placement marker) and placedFrom (a marker in a
// message the surface does not draw gives the card back to its anchor), and settledQuestions for an
// answered one — over the transcript the card reads for exactly this. This module only maps those message
// positions onto the three places a handoff has room for, the way upstream's card flushes its groups
// through a windowed transcript (TodosView flushQuestions):
//
//   • ABOVE — a rest older than the human's last turn. Upstream flushes these first, above the window, and
//     so does the card: above the human's bubble, since everything after that bubble is newer. Since
//     2026-10-14 a question the human TYPED past never reaches this module (the card passes held ones
//     only), so what lands here is a held one older than the human's last turn — asked before an answer
//     they gave on another card, which counts as their turn here (lastHumanTurnIndex).
//   • BETWEEN — a rest after the human's turn that is not the newest: one of the `earlier` rests, or one
//     the handoff skips (a quiet park). It draws under the earlier rests' prose, over the newest.
//   • TAIL — the newest rest: under the handoff, where the card's stack has always been.
//
// A MARKER PLACES A CARD AT ITS REST'S END on this view, not mid-prose. The handoff's prose is clamped
// behind "Show more" (AllQueuesCard ClampedBody), and a question drawn inside the clamp is an ask the human
// cannot see without a click; the drawer honours the marker's exact slot. The marker still decides WHICH
// rest the card belongs to, which is the part that moves it.
//
// An answered question owes nothing, so it is never hoisted ABOVE (upstream draws a settled card only
// inside its window), and the answering state's own greyed copy of a question just sent from this card is
// the caller's to subtract (RegisteredQuestionStack keepAnswered draws that one in its slot).
import type { RegisteredQuestionView } from "@ntwine/shared"
import { type AnchorMessage, questionsByAnchor, restEnd } from "./questionAnchor.ts"
import { lastHumanTurnIndex, type HumanTurnLike } from "./messagePresentation.ts"
import { placedFrom, placeQuestions, questionsAtCurrentRest } from "./questionShadow.ts"
import { settledQuestionPositions, type SettledPositionable } from "./settledQuestions.ts"

export type HandoffSlot = "above" | "between" | "tail"

export interface HandoffQuestionSlots<Q, S> {
  above: Q[]
  between: Q[]
  tail: Q[]
  settledBetween: S[]
  settledTail: S[]
  /** Does an open question render at the newest rest (questionsAtCurrentRest)? Only then is it that rest's
   *  ending — a bare rest beside an older question still draws the rested card (RestedCard). */
  here: boolean
}

type Message = AnchorMessage & HumanTurnLike

/**
 * Sort the thread's open and answered questions into the handoff's three places, by the rest each belongs
 * to. `here` is computed over the same open set the drawer reads, so the rested card agrees with the
 * drawer's (ChatView questionsHere).
 */
export function handoffQuestionSlots<Q extends Pick<RegisteredQuestionView, "id"> & { askedAt: string }, S extends SettledPositionable>(
  messages: readonly Message[],
  open: readonly Q[],
  settled: readonly S[],
): HandoffQuestionSlots<Q, S> {
  const slots: HandoffQuestionSlots<Q, S> = { above: [], between: [], tail: [], settledBetween: [], settledTail: [], here: questionsAtCurrentRest(messages, open) }
  if (messages.length === 0) {
    // No transcript to place them in: the newest rest, where the card drew them before (and never lost one).
    slots.tail.push(...open)
    return slots
  }
  const base = lastHumanTurnIndex(messages)
  const tail = messages.length - 1
  // The rest a position sits in, as a slot. `restEnd` is the last message before the next human turn, so
  // every position in the newest rest maps to the tail.
  const slotOf = (at: number): HandoffSlot => (at < base ? "above" : restEnd(messages, at) >= tail ? "tail" : "between")
  // Every group carries its position, so a slot holding several rests' groups reads them in transcript
  // order; within a group, the order the readers return (ask order).
  const placedOpen: { at: number; slot: HandoffSlot; group: Q[] }[] = []
  const placement = placedFrom(placeQuestions(messages, open), base)
  for (const [at, group] of placement.placed) placedOpen.push({ at, slot: slotOf(at), group })
  const unplaced = open.filter((q) => !placement.placedIds.has(q.id))
  // An anchor at the tail or past it is the newest rest's whatever restEnd says (questionAnchorIndex's
  // "nothing has happened since" case), and -1 — a rest older than the window — is above it.
  for (const [anchor, group] of questionsByAnchor(messages, unplaced)) placedOpen.push({ at: anchor, slot: anchor >= tail ? "tail" : slotOf(anchor), group })
  placedOpen.sort((a, b) => a.at - b.at)
  for (const { slot, group } of placedOpen) slots[slot].push(...group)

  const placedSettled: { at: number; slot: HandoffSlot; group: S[] }[] = []
  const answered = settledQuestionPositions(messages, settled)
  for (const map of [answered.placed, answered.anchored]) {
    for (const [at, group] of map) if (at >= base) placedSettled.push({ at, slot: slotOf(at), group })
  }
  placedSettled.sort((a, b) => a.at - b.at)
  for (const { slot, group } of placedSettled) (slot === "tail" ? slots.settledTail : slots.settledBetween).push(...group)
  return slots
}
