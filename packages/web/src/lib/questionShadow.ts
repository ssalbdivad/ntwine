// ONE QUESTION, ONE CARD — folding a ```question fence into the registered question it restates, and
// taking its POSITION while doing it (see PLACEMENT at the foot of this file: the fence's slot is where
// the registered card renders, so a worker can write the ask into the middle of its own handoff).
//
// A worker can ask the same question twice at one rest: register it with `ask` (a row, the durable
// form) and then, at sign-off, write it again as a ```question fence because the contract says the
// fence is the handback. Both producers reach QuestionBlockCard, so the transcript drew the question
// twice, back to back, on the thread page and the queue card (maintainer 2026-08-28: "Same question
// showing up twice in a row" — a release go/no-go registered at 10:11 and re-fenced at 10:11 with
// "(also on the board as a card)" appended, after two PR-watcher wakes had buried the first fence).
//
// The REGISTERED card is the one that survives, and it is not a coin toss: answering it settles the
// row, which is what un-gates `done` and dequeues the thread; answering the fence sends a plain
// follow-up and leaves the row open behind it, so the worker wakes to an answer it cannot `done` past.
// (lib/registeredDone.ts folds the other way — a fenced done beside a registered one keeps the message's
// card — because there the two are the same bytes and nothing is settled by which one is drawn.)
//
// A fence is folded only when it demonstrably RESTATES a registration standing at the SAME REST. A
// different question fenced beside a registered one still renders — the fold never hides a question
// the human has not seen elsewhere on the page. The text rule is deliberately loose about markup (the
// fence wraps `code` and [links](…) that the registration's plain string cannot carry) and about
// trailing prose (the worker appends a parenthetical), and strict about the question itself.
import type { RegisteredQuestionView } from "@ntwine/shared"
import { type AnchorMessage, questionsByAnchor, restEnd } from "./questionAnchor.ts"
import { type MessageSegment, parseQuestionBlock, splitQuestionBlocks } from "./questionBlocks.ts"

/** The rest a question's anchor closes: the index of its first message — the one after the previous
 *  human turn — or 0 for an anchor above the loaded window, whose rest is off the page entirely. */
function restStart(messages: readonly AnchorMessage[], anchor: number): number {
  for (let i = anchor; i >= 0; i--) {
    if (isTurn(messages[i])) return i + 1
  }
  return 0
}

/** Same turn test as questionAnchorIndex: a human turn closes a rest; punctuation does not. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The registered questions STANDING at each message, keyed by message index: every message of the
 *  rest a question was asked at AND of every rest after it, so a fence anywhere from the ask onward can
 *  be checked against it. A question stands until it is answered or withdrawn, and the human can reply
 *  past one without answering it (the composer is right there) — the worker's NEXT handoff then names
 *  it again, and that fence must fold and place exactly as one at the asking rest does. Until
 *  2026-08-28 only the asking rest saw it, so a placement marker in a later handoff drew nothing and the
 *  card fell back to its anchor — a rest above the queue card's window, which pinned it at the very top
 *  of the card while the handoff below spoke of it as if it sat right there (maintainer: "why is the
 *  question showing up above my last message?"). A group anchored above the loaded window (-1) stands at
 *  every loaded message: its rest is off the page, and everything on the page is later. Human turns map
 *  to nothing — a wake carries no fence of the worker's. */
export function registeredStandingAt<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byMessage = new Map<number, Q[]>()
  // The ASKING rest, not a later claim: a fence restating the question folds from where it was asked on.
  for (const [anchor, group] of questionsByAnchor(messages, questions, { claims: false })) {
    for (let i = restStart(messages, anchor); i < messages.length; i++) {
      if (isTurn(messages[i])) continue
      const at = byMessage.get(i)
      if (at) at.push(...group)
      else byMessage.set(i, [...group])
    }
  }
  return byMessage
}

// Shorter than this and a match says nothing — "Proceed?" restates every go/no-go ever asked.
const MIN_MATCH = 12

/** Markup-blind, whitespace-blind, case-blind text: what the two producers have in common once the
 *  fence's markdown is gone. */
function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** The question proper: everything up to and including the first `?`, or nothing when there is none. */
function head(text: string): string | undefined {
  const at = text.indexOf("?")
  return at === -1 ? undefined : text.slice(0, at + 1)
}

/** Does this ```question fence body restate one of `registered`? The fence's context (its prose above
 *  the option run) either contains the registered question, is a prefix of it, or asks the same thing —
 *  carries its `?`-terminated head, or opens with one the registration carries — with different context
 *  around it. */
export function fenceRestatesRegistered(
  body: string,
  registered: readonly Pick<RegisteredQuestionView, "spec">[],
): boolean {
  if (registered.length === 0) return false
  const context = normalize(parseQuestionBlock(body, "question").contextMd)
  if (context.length < MIN_MATCH) return false
  const contextHead = head(context)
  return registered.some(({ spec }) => {
    const asked = normalize(spec.question)
    if (asked.length < MIN_MATCH) return false
    if (context.includes(asked) || asked.startsWith(context)) return true
    const askedHead = head(asked)
    if (askedHead !== undefined && askedHead.length >= MIN_MATCH && context.includes(askedHead)) return true
    return contextHead !== undefined && contextHead.length >= MIN_MATCH && asked.includes(contextHead)
  })
}

/** Does every ```question fence in this message text restate a registration? False for a text with no
 *  fence at all — there is nothing to fold — so a caller gating chrome on the fenced ask can drop it
 *  exactly when the fold leaves that ask with no card of its own. */
export function allFencesShadowed(
  text: string,
  registered: readonly Pick<RegisteredQuestionView, "id" | "spec">[],
): boolean {
  if (registered.length === 0 || !text.includes("```question")) return false
  const fences = splitQuestionBlocks(text).filter((seg) => seg.kind === "question")
  return fences.length > 0 && fences.every((seg) => seg.kind === "question" && fenceStandsFor(seg, registered) !== undefined)
}

// ---- PLACEMENT: the marker says WHERE the registered card renders ----
//
// An empty ```question qst_… fence is a PLACEMENT MARKER: the registered card whose id it names renders
// in its slot, so a worker can couch a question inside its own handoff — the setup above it, the card,
// then what happens either way — instead of every card landing at the tail of the rest.
//
// It has been in and out once. Built 2026-08-28 (maintainer: "it's kind of nice that they can couch a
// registered question within some copy"), it placed the rest's WHOLE group at the first standing fence,
// with a text-match fallback for a worker that re-fenced the question in prose. Retired 2026-08-30 on
// usage data (15 of 17 real markers sat at the tail, where the card lands with no marker at all). Back
// on 2026-09-11 for a different reason than couching: the free-form ```question fence — a question
// written INTO a fence body — is retired from the contract outright (shared QUESTION_FENCE_RETIRED_AT),
// because a fence's answer is bytes in a later message that nothing tracks, and settling one means
// guessing (PR #33, declined). The marker is the ONE fence a worker still writes, and it is safe
// precisely because it names a ROW: the row is open or answered, and nothing about the fence is ever
// inferred (maintainer 2026-09-11: "a version of the question fence that just contains a reference to
// a specific registered question. Any question identifier that doesn't show up inside one of these
// question reference fences can just show up at the end").
//
// PLACEMENT IS PER QUESTION, BY ID, AND NOTHING ELSE. One marker places exactly the question it names;
// a rest's other questions render at the anchor as they always did; a marker naming an id that is not
// standing at its message draws nothing (the fold below). The 2026-08-28 text-match placement is NOT
// back: prose that restates a registration still FOLDS (draws nothing, so an old-contract worker's
// re-fenced question is never a second card) but never places, because a fuzzy match is exactly the
// guess the marker exists to remove.
//
// THE ANSWERS STILL SEND AS ONE UNIT. The `answerQuestions` RPC takes every staged answer in one call
// (a per-question send would half-wake the worker), so scattering the cards through the prose cannot
// scatter the Send: the cards share ONE answering state (RegisteredQuestionCards' provider) and the
// rest's stack at the anchor carries the one "Send answers" for all of them, placed or not.
//
// NOTHING IS EVER LOST BY OMISSION. A rest whose message names none of its registrations renders them
// at the anchor exactly as before — the worker chooses the position, never whether the human sees it.
// And the placement is NOT confined to the asking rest: a worker that rests again after the human
// replied past the question writes its marker into THAT handoff, and the marker takes there.
//
// THE SCAN STARTS AT THE NEWEST REST THAT CLAIMS THE QUESTION (2026-10-05) — lib/questionAnchor: the
// rest that asked it, or a later one whose ```awaiting fence names it under `questions:`. A marker in the
// asking handoff therefore keeps the card in that prose for as long as no later rest claims it, which is
// the point: a question stays embedded where the worker couched it, and a later rest that says nothing
// about it leaves it there. A later fence that names it moves it to that rest — into its prose if a
// marker there places it, otherwise under the fence. (From 2026-09-13 the scan instead started at the
// CURRENT rest whenever the thread was at rest, so every marker but the newest handoff's stopped placing
// and every open card fell to the tail — the stacking the maintainer reported on 2026-10-01.)

/** The registration a ```question fence STANDS FOR, if any: the one its info-string id names, else the
 *  one its prose restates. The id is exact and the prose is not, so a worker that writes
 *  ```question qst_ab12cd34 never depends on the text rule below. */
export function fenceStandsFor<Q extends Pick<RegisteredQuestionView, "id" | "spec">>(
  seg: Extract<MessageSegment, { kind: "question" }>,
  registered: readonly Q[],
): Q | undefined {
  if (seg.registeredId) return registered.find((q) => q.id.toLowerCase() === seg.registeredId)
  return registered.find((q) => fenceRestatesRegistered(seg.text, [q]))
}

export interface QuestionPlacement<Q> {
  /** The questions placed INTO each message, keyed by the index of the message whose marker places
   *  them, in registration order. */
  placed: Map<number, Q[]>
  /** Every placed question's id — what the anchor path subtracts, so a placed card is drawn once. */
  placedIds: Set<string>
}

/** The ids a message's markers name, lowercased, in order — the empty-bodied ```question qst_… fences
 *  only. A fence WITH a body is a legacy question (or, under the new contract, prose), never a marker. */
export function markerIdsIn(text: string): string[] {
  if (!text.includes("```question")) return []
  return splitQuestionBlocks(text).flatMap((seg) => seg.kind === "question" && seg.registeredId && seg.text.trim() === "" ? [seg.registeredId] : [])
}

/** Where each registered question renders, given what the messages from its claiming rest onward
 *  actually wrote: the LAST message (the newest handoff — an older placement is history) from that rest
 *  onward whose empty marker names its id. A question no loaded message names is absent from `placed`
 *  and renders at its anchor. Human turns never place anything — a wake carries no marker of the
 *  worker's. */
export function placeQuestions<Q extends Pick<RegisteredQuestionView, "id"> & { askedAt: string; passedOver?: true }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): QuestionPlacement<Q> {
  const placed = new Map<number, Q[]>()
  const placedIds = new Set<string>()
  if (questions.length === 0) return { placed, placedIds }
  // One parse per marker-bearing message, however many questions are open.
  const markersAt = new Map<number, string[]>()
  const markersOf = (i: number): string[] => {
    let ids = markersAt.get(i)
    if (ids === undefined) {
      const m = messages[i]
      ids = m.role === "assistant" && m.text ? markerIdsIn(m.text) : []
      markersAt.set(i, ids)
    }
    return ids
  }
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    for (const q of group) {
      const id = q.id.toLowerCase()
      let placedAt = -1
      // A question the human typed past places only within the rest that asked it: a marker in a later
      // handoff would move it down under their newest message (questionAnchor, 2026-10-14).
      const end = q.passedOver ? restEnd(messages, anchor) + 1 : messages.length
      for (let i = restStart(messages, anchor); i < end; i++) {
        if (isTurn(messages[i])) continue
        if (markersOf(i).includes(id)) placedAt = i
      }
      if (placedAt < 0) continue
      const at = placed.get(placedAt)
      if (at) at.push(q)
      else placed.set(placedAt, [q])
      placedIds.add(q.id)
    }
  }
  return { placed, placedIds }
}

/** The placement as a surface that draws messages from `start` onward can honour it: a card placed by a
 *  marker in a message ABOVE `start` has no message to render in, so it leaves `placed` and goes back to
 *  its anchor group, which that surface draws at the top of what it shows — card and Send together. The
 *  queue card is the surface: its window is cut at the previous rest, and since 2026-10-05 a marker in an
 *  older rest keeps placing until a later fence claims the question. Left in, the card vanished and its
 *  rest's Send flushed alone above the window, with nothing to answer. */
export function placedFrom<Q extends Pick<RegisteredQuestionView, "id">>(placement: QuestionPlacement<Q>, start: number): QuestionPlacement<Q> {
  if (start <= 0) return placement
  const placed = new Map<number, Q[]>()
  const placedIds = new Set<string>()
  for (const [at, group] of placement.placed) {
    if (at < start) continue
    placed.set(at, group)
    for (const q of group) placedIds.add(q.id)
  }
  return { placed, placedIds }
}

/** The rest each PLACED question sits in, as the index of the message closing it. A rest whose every
 *  card is inside its prose has no stack of its own, so this is where the surface draws that rest's Send
 *  — and only there: a Send-only stack at the transcript's tail with nothing above it to answer is the
 *  2026-09-13 report ("How did this thread pause without a sign-off?"). */
export function placedRestEnds<Q>(messages: readonly AnchorMessage[], placement: QuestionPlacement<Q>): Set<number> {
  const ends = new Set<number>()
  for (const at of placement.placed.keys()) ends.add(restEnd(messages, at))
  return ends
}
