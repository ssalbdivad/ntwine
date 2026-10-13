// WHERE AN ANSWERED REGISTERED QUESTION STAYS: in the slot its open card filled at the moment the human
// answered it. Until 2026-09-25 an answered card simply vanished — the row left `thread.questions`, and
// nothing drew the ask again — so a rest that had asked something read, afterwards, as a handoff that
// asked nothing (maintainer: "after a question is answered, it should continue showing up in a
// grayed-out way in the chat transcript, in the exact position where it was previously rendering").
//
// "Where it was rendering" is not stored anywhere, and it does not need to be: it is a pure function of
// the transcript AS IT STOOD when the answer was sent. The open card's position comes from two readers —
// a marker placement (lib/questionShadow placeQuestions) and the rest anchor (lib/questionAnchor
// questionsByAnchor) — and both read only the messages. So each answer batch replays exactly those two
// readers over the PREFIX of the transcript that existed before its `settledAt`: the card stood at the
// newest rest in that prefix that claimed it (the asking rest, or a later fence naming it), in the slot
// of the newest marker there. What the worker wrote after the answer (the answer itself, the turn it
// woke) is outside the prefix, so it can neither move the card nor bury it.
//
// A question whose rest is older than the loaded window (anchor -1) draws nothing here. An OPEN one
// renders at the top of the window in that case, because it is still owed an answer and must not be out
// of reach; a settled one owes nothing, and it renders in its real slot once the earlier page is loaded.
import { questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"
import { placeQuestions } from "./questionShadow.ts"

export interface SettledPositionable {
  id: string
  askedAt: string
  settledAt: string
  /** Sent from THIS tab and not yet read back from the server. Its `settledAt` is the browser's clock,
   *  which need not agree with the transcript's; the answer was sent against the whole loaded
   *  transcript, so the prefix is all of it. */
  pending?: true
}

export interface SettledPlacement<S> {
  /** Settled questions drawn INSIDE a message, in the slot of the marker that placed the open card. */
  placed: Map<number, S[]>
  /** Settled questions drawn AFTER a message — the anchor the open card had. */
  anchored: Map<number, S[]>
}

/** How many leading messages existed before `settledAt`: the index of the first message stamped after
 *  it. An unstamped message (an optimistic send) is not evidence either way and never ends the prefix. */
function prefixLength(messages: readonly AnchorMessage[], settledAtMs: number): number {
  for (let i = 0; i < messages.length; i++) {
    const at = messages[i].at ? Date.parse(messages[i].at!) : Number.NaN
    if (Number.isFinite(at) && at > settledAtMs) return i
  }
  return messages.length
}

/** The anchor moved up past the ntwine event rows that close its rest ("Agent rested" above all). While
 *  the card was open that row was the transcript's tail and drew nothing, so the card sat directly under
 *  the handoff; once the human's answer lands after it the divider draws, and a card anchored ON it
 *  would fall below the divider — outside the rest it was asked at. */
function aboveTrailingEvents(messages: readonly AnchorMessage[], anchor: number): number {
  let at = anchor
  while (at > 0 && messages[at].kind === "event") at--
  return at
}

export function settledQuestionPositions<S extends SettledPositionable>(
  messages: readonly AnchorMessage[],
  settled: readonly S[],
): SettledPlacement<S> {
  const placed = new Map<number, S[]>()
  const anchored = new Map<number, S[]>()
  if (settled.length === 0 || messages.length === 0) return { placed, anchored }
  // ONE Send settles its whole batch at one instant (router.answerQuestions stamps a single `now`), and
  // the batch's cards stood together, so each batch is replayed against its own prefix once.
  const batches = new Map<string, S[]>()
  for (const s of settled) {
    const key = s.pending ? "pending" : s.settledAt
    const batch = batches.get(key)
    if (batch) batch.push(s)
    else batches.set(key, [s])
  }
  const add = (into: Map<number, S[]>, at: number, group: readonly S[]) => {
    const existing = into.get(at)
    if (existing) existing.push(...group)
    else into.set(at, [...group])
  }
  for (const [key, batch] of batches) {
    const settledAtMs = key === "pending" ? Number.POSITIVE_INFINITY : Date.parse(key)
    const cut = Number.isFinite(settledAtMs) ? prefixLength(messages, settledAtMs) : messages.length
    if (cut === 0) continue
    const prefix = messages.slice(0, cut)
    const placement = placeQuestions(prefix, batch)
    for (const [at, group] of placement.placed) add(placed, at, group)
    const unplaced = batch.filter((s) => !placement.placedIds.has(s.id))
    for (const [anchor, group] of questionsByAnchor(prefix, unplaced)) {
      if (anchor < 0) continue
      add(anchored, aboveTrailingEvents(prefix, anchor), group)
    }
  }
  // Batches were walked in settle order; within one slot the cards read in the order they were ASKED,
  // the order the open stack drew them in.
  const byAsked = (a: S, b: S) => Date.parse(a.askedAt) - Date.parse(b.askedAt)
  for (const group of placed.values()) group.sort(byAsked)
  for (const group of anchored.values()) group.sort(byAsked)
  return { placed, anchored }
}
