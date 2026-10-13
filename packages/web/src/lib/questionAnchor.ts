// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the newest rest that CLAIMS it — the rest it
// was asked at, or a later rest whose ```awaiting fence names it under `questions:`. Never at a rest that
// says nothing about it.
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it has been the wrong one three times:
//
// - Until 2026-08-27 the card was pinned above the composer. The moment the human replied past it, it
//   sat UNDER their own newest message and under everything the worker had done since, claiming to be
//   the current ask (maintainer 2026-08-27: "The questions should show up in the chat wherever the
//   session came to rest").
// - 2026-08-27 froze it at the rest that asked it — and then a worker that rested AGAIN with the
//   question open left the newest rest reading as a bare stop (maintainer 2026-08-31: "Why was this able
//   to come to rest without a proper handoff?").
// - 2026-08-31 therefore pulled every open question to the CURRENT rest. That took each card out of the
//   prose it was placed in and stacked them all under whatever the worker said last — a CI wake, an
//   unrelated reply — where they superseded the worker's own sign-off (maintainer 2026-10-01: "the
//   questions are taken out of the place where they were sort of embedded in the transcript and all
//   just show up in a bunch at the bottom of the chat"; 2026-10-05: "the pending questions that may or
//   may not be relevant kind of supersede how the agent actually signed off"). Measured over the 867
//   questions asked here since 2026-09-11, 38% outlived a later rest, and 72% of those resumes were
//   wakes, not the human.
//
// The fix for the 2026-08-31 report now lives in the CONTRACT, not here: a question is a sign-off only at
// the rest that asked it, and at every later rest the worker names each one it still needs under
// `questions:` or withdraws it (server scheduler.evalSignoffNudges / evalParkIntegrity). So the newest
// rest never reads as a bare stop with an ask hidden above it, and this file only has to honour what the
// worker said: a card stays where it was asked until a later rest claims it, and a claim moves it to the
// end of that rest — under the fence that named it.

import { awaitingQuestions } from "@ntwine/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
  /** The message's markdown, read only for an ```awaiting fence's `questions:` claim. */
  text?: string
}

/** A real human turn — a typed reply or one of ntwine's own deliveries, which land as user records and
 *  count deliberately (the thread moved on, whoever moved it). Punctuation with a nominal role (an event
 *  line, a reasoning summary) is not a turn. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The last message of the rest message `i` belongs to: the one before the next human turn, or the tail
 *  when no turn follows. */
export function restEnd(messages: readonly AnchorMessage[], i: number): number {
  for (let j = i + 1; j < messages.length; j++) {
    if (isTurn(messages[j])) return j - 1
  }
  return messages.length - 1
}

/** The index of the message closing the rest this question was ASKED at — the card renders after it.
 *  `messages.length - 1` when nothing has happened since (the common case — the worker asked and rested,
 *  and the card is still the tail), and `-1` when the rest it belongs to is older than the loaded window,
 *  which puts it at the top of what is loaded rather than back at the bottom where it would lie about
 *  being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isTurn(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  return tail
}

/** The newest worker message whose ```awaiting fence names each question under `questions:`, keyed by
 *  lowercased id. A message with no awaiting fence costs one substring test. */
export function questionClaims(messages: readonly AnchorMessage[]): Map<string, number> {
  const claims = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.text || !m.text.includes("```awaiting")) return
    for (const seg of splitFenceBlocks(m.text)) {
      if (seg.kind !== "fence" || seg.fenceKind !== "awaiting") continue
      for (const id of awaitingQuestions(seg.hints)) claims.set(id, i)
    }
  })
  return claims
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack — and a fence naming several questions
 *  gathers them into one group at its own rest the same way.
 *
 *  `claims: false` reads the ASKING rest alone, ignoring any later fence — the reading lib/questionShadow's
 *  fold needs, because a fence restating a question must fold from the rest that asked it onward. */
export function questionsByAnchor<Q extends { askedAt: string; id?: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
  opts: { claims?: boolean } = {},
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  const claims = opts.claims === false || questions.length === 0 ? undefined : questionClaims(messages)
  for (const q of questions) {
    let anchor = questionAnchorIndex(messages, q.askedAt)
    const claimedAt = q.id ? claims?.get(q.id.toLowerCase()) : undefined
    if (claimedAt !== undefined && claimedAt > anchor) anchor = restEnd(messages, claimedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
