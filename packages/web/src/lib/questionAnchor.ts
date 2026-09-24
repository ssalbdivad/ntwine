// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the rest it was asked at — the last message
// before the next human turn — however far the thread has moved on since.
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it was the wrong one until 2026-08-27: the card was pinned above the composer with the
// pending-interaction stack, on the reasoning that neither may scroll out of reach. That holds only
// while the question is the newest thing on the thread. The moment the human replies past it without
// answering — which they may, the composer is right there — the card sits UNDER their own newest
// message and under everything the worker has done since, claiming to be the current ask (maintainer
// 2026-08-27: "Questions are still showing up for me between my most recent message and the agent
// outputs that have happened since that message. That doesn't make any sense. The questions should show
// up in the chat wherever the session came to rest").
//
// The 2026-08-27 fix froze the card at the rest that ended the turn it was asked in — and that reading
// broke on the OTHER half of the same scenario. The human replies past the card, the worker answers the
// follow-up and rests AGAIN with the question still open: the new rest is now the handoff the human
// reads, and it shows no ask at all. The card sits stranded above their own reply, the tail reads as a
// bare stop, and the sign-off nudge rightly stands down because the open row IS the thread's sign-off
// (maintainer 2026-08-31, on exactly that transcript: "Why was this able to come to rest without a
// proper handoff?"). "Wherever the session came to rest" means the CURRENT rest, not the historical one.
//
// And that reading was reversed in turn on 2026-09-24. Dragging every open question to the newest rest
// assumes the ask is still CURRENT, and the case that actually produces a later rest with a question
// still open is the one where it is not: the human sent more messages that obviated it, or the worker
// did something that made it moot, and the newest handoff is about something else. The card then sat
// under that handoff claiming to be its ask — a placeholder-package question from the first round of
// names, drawn beneath the write-up of the second round (maintainer 2026-09-24: "it should move up in
// the chat appropriately"). A question belongs to the rest that asked it, always; the worker contract
// already says to pause on an open question, so a later rest past one is the exception, not the norm.
//
// A worker whose newer handoff genuinely still owes the ask brings it forward itself: an empty
// ```question qst_… marker in that handoff places the card there (lib/questionShadow placeQuestions),
// and that choice is the worker's to make — frizz cannot tell a still-live ask from an obviated one.

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
}

/** A real human turn — a typed reply or one of frizz's own deliveries, which land as user records and
 *  count deliberately (the thread moved on, whoever moved it). Punctuation with a nominal role (an event
 *  line, a reasoning summary) is not a turn. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The index of the message this question renders AFTER. `messages.length - 1` when nothing has happened
 *  since (the common case — the worker asked and rested, and the card is still the tail), and `-1` when
 *  the rest it belongs to is older than the loaded window, which puts it at the top of what is loaded
 *  rather than back at the bottom where it would lie about being current. */
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

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack. */
export function questionsByAnchor<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  for (const q of questions) {
    const anchor = questionAnchorIndex(messages, q.askedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
