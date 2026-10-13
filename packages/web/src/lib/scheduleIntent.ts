import { SCHEDULE_NOT_FOUND_COPY, SCHEDULE_PRESENCE_COPY, SCHEDULE_SPACING_COPY, locatePhrase, type InterpretScheduleResult, type Span } from "@ntwine/shared"
import { isFailedRead, type ModelReadOk, type ModelReadView } from "./scheduleModelRead.ts"

// WHAT THE PROMPT BOX MAKES OF ITS WORDS, AND WHAT ENTER DOES WITH THEM (ARCHITECTURE.md § Scheduled threads). There is
// one submit — Enter, the send button, the phone's send — and the model decides what it means: a prompt with a
// schedule word in it is read (lib/scheduleReadScheduler.ts), and if the model says the words ask for the work
// to REPEAT, Enter creates that schedule instead of starting the thread. Everything here is pure, so the
// decisions are tested without a DOM (scheduleIntent.test.ts) and ScheduleComposer.tsx only executes them.
//
// The rules:
//   - A reading is used at submit only for EXACTLY the text being submitted (its trimmed words), never one read
//     from an earlier text: an edit since the last read is re-read before anything is created. A reading the
//     cache holds costs nothing to re-use, so nothing relocates an old reading onto new words.
//   - Enter never waits on the model. Without a reading for the text, the words leave the box at once and their
//     reading settles them in the background (`settleAct`): a schedule is created and a toast says which, anything
//     else starts the thread. Until 2026-10-07 Enter HELD in the box until the answer landed (maintainer: "change
//     checking for a schedule so that it doesnt delay submitting the prompt").
//   - Nothing is ever dispatched silently in place of a schedule the human may have meant: a read that fails or
//     times out, or a schedule the box cannot make, starts the thread with a toast that says why.
//   - The human can say "not a schedule" (× or Esc): the draft keeps that phrase DISMISSED, and Enter starts the
//     thread, until the model reads a different phrase out of the words. Said over a strip that is still the
//     reading of EARLIER words, it is about the words on screen, and takes their reading's phrase when it lands.
//   - A reading of other words never looks current: kept on screen while its words are read again, it is marked
//     as updating, and the send wears ↻ only while that read is out or due.

/** What the model's answer means for the box. */
export type ScheduleAnswer =
  /** The words ask for a schedule, and this is it. */
  | { kind: "schedule"; result: ModelReadOk }
  /** They do not ask for one: Enter starts the thread. */
  | { kind: "none" }
  /** They ask for one the box cannot make — closer than 15m, at the keyboard, nothing left to run. */
  | { kind: "refused"; copy: string }
  /** The read itself failed; nothing is known. */
  | { kind: "failed" }

/** What is known about one text: an answer, or not yet. */
export type ScheduleKnown = ScheduleAnswer | { kind: "pending" }

/** What the box says when a reading leaves nothing for each run to do. */
export const NO_TASK_COPY = "Say what each run should do, like “every Monday at 9am triage new issues”."

/**
 * The model's answer, as the box acts on it. `refuse` vets a reading the box cannot show or save (a rule with no
 * words for it, nothing left to run) into a refusal with its copy.
 *
 * The interpreter's "couldn't find a schedule" is NONE, the ordinary answer for most words with a schedule word in
 * them ("fix the bug from this morning"). So is an interpreter that is switched off (NTWINE_THREAD_NAMER=0) or a
 * refusal this box has no words for: the box then behaves as it would with no schedules at all. Only the
 * refusals of a schedule the human evidently asked for — too frequent, while at the keyboard, no task, a rule
 * that would not check — are said on screen.
 */
export function classifyResult(result: InterpretScheduleResult, refuse?: (reading: ModelReadOk) => string | undefined): ScheduleAnswer {
  if (result.ok) {
    const copy = refuse?.(result)
    return copy ? { kind: "refused", copy } : { kind: "schedule", result }
  }
  if (isFailedRead(result)) return { kind: "failed" }
  const e = result.error
  if (e === SCHEDULE_NOT_FOUND_COPY) return { kind: "none" }
  if (e === SCHEDULE_PRESENCE_COPY || e === SCHEDULE_SPACING_COPY || e.startsWith("Couldn't turn that into a schedule") || e.startsWith("What should each run do?")) {
    return { kind: "refused", copy: e }
  }
  return { kind: "none" }
}

/** What the reader knows about a text, as the box acts on it. */
export function knownOf(view: ModelReadView, refuse?: (reading: ModelReadOk) => string | undefined): ScheduleKnown {
  if (view.status === "answered") return classifyResult(view.result, refuse)
  if (view.status === "failed") return { kind: "failed" }
  return { kind: "pending" }
}

/** The words the model reads for a prose: trimmed, as the server would read them anyway. */
export const readTextOf = (prose: string): string => prose.trim()

/**
 * Where a reading's phrase sits in `prose`. A reading OF this prose (`readText` is its trimmed words) maps its
 * offsets — which index the trimmed text — by the whitespace trimmed off the front: a prompt that opens with a
 * newline drew every mark one character late until that was added back. A reading of an earlier text, still on
 * screen while this one is read, is found by its phrase, near where it was — for the MARK only: nothing is ever
 * created from a reading of other words (`submitAct`).
 */
export function phraseSpan(prose: string, readText: string, result: ModelReadOk): Span | undefined {
  const lead = prose.length - prose.trimStart().length
  const at = { start: lead + result.phraseStart, end: lead + result.phraseEnd }
  if (readTextOf(prose) === readText && prose.slice(at.start, at.end) === result.phrase) return at
  return locatePhrase(prose, result.phrase, at.start)
}

const normal = (phrase: string) => phrase.trim().replace(/\s+/g, " ").toLowerCase()

/** Whether a reading is the one the draft dismissed: the same phrase, give or take case and spacing. */
export function isDismissed(result: ModelReadOk, dismissed: string | undefined): boolean {
  return dismissed !== undefined && normal(result.phrase) === normal(dismissed)
}

/**
 * Whether "not a schedule" stops holding. It was said about a phrase, so it lifts once that phrase is gone: the
 * words lose every schedule word (the box emptied, the phrase deleted), or the model reads them again and finds a
 * DIFFERENT phrase, or none at all. A pending or failed read lifts nothing, and neither does a refusal.
 */
export function liftsDismissal(a: { trigger: boolean; known: ScheduleKnown; dismissed: string | undefined }): boolean {
  if (a.dismissed === undefined) return false
  if (!a.trigger || a.known.kind === "none") return true
  return a.known.kind === "schedule" && !isDismissed(a.known.result, a.dismissed)
}

/** What "not a schedule" was said about, as the draft keeps it (lib/scheduleDraftState.ts). */
export type DismissalRecord = { phrase: string; pending?: boolean }

/**
 * The phrase a dismissal holds for NOW. Said over a reading of the words on screen, it is that reading's phrase.
 * Said over a strip that was still the reading of EARLIER words (updating), it is PENDING: the human said it
 * about the words they were looking at, whose own reading had not landed — so it covers whatever reading is on
 * screen meanwhile (`stale`) and, once the words' own reading lands (`known`), that one, whatever its phrase.
 *
 * Fix round 2026-10-06 (F): typed "triage new issues every Monday at 9am" with the phrase at the end, Esc 150ms
 * after the last key dismissed the strip's "every Monday" — the reading of "… every Monday at" — and the words'
 * own reading, "every Monday at 9am", was a different phrase: the dismissal lifted the moment it landed and the
 * Enter pressed after the Esc created the schedule. 3 of 3 cases, Esc and × alike.
 */
export function dismissedPhrase(d: DismissalRecord | undefined, known: ScheduleKnown, stale: ScheduleAnswer | undefined): string | undefined {
  if (!d) return undefined
  if (!d.pending) return d.phrase
  if (known.kind === "schedule") return known.result.phrase
  if (stale?.kind === "schedule") return stale.result.phrase
  return d.phrase
}

/** Which readings a dismissal covers for words submitted before their own reading landed: a pending one covers
 *  whatever reading lands (`dismissedPhrase`), a settled one its phrase. */
export function dismissalCovers(d: DismissalRecord | undefined): (result: ModelReadOk) => boolean {
  return (result) => d !== undefined && (d.pending === true || isDismissed(result, d.phrase))
}

/** What becomes of the draft's dismissal now: kept, lifted (`liftsDismissal`), or — a pending one whose words'
 *  reading landed — fixed to that reading's phrase, so later edits are judged against it as usual. */
export function nextDismissal(a: { trigger: boolean; known: ScheduleKnown; dismissal: DismissalRecord | undefined }): "keep" | "lift" | { adopt: string } {
  const d = a.dismissal
  if (!d) return "keep"
  if (d.pending && a.trigger && a.known.kind === "schedule") return { adopt: a.known.result.phrase }
  return liftsDismissal({ trigger: a.trigger, known: a.known, dismissed: d.phrase }) ? "lift" : "keep"
}

// ---- submit ---------------------------------------------------------------------------------------------------

export type SubmitAct =
  /** Start the thread now, exactly as the box always has. */
  | { act: "dispatch" }
  /** Create this schedule. */
  | { act: "create"; result: ModelReadOk }
  /** Nothing is known for this text yet: the words leave the box NOW, and their reading, once it lands, decides
   *  what they become (`settleAct`). Enter never waits on the model. */
  | { act: "defer" }

/**
 * What an Enter does with the text, given what is known about EXACTLY that text.
 *
 * - No schedule word, a dismissed reading, no schedule in the words: dispatch.
 * - A schedule: create it.
 * - A refusal: its line is already on screen, saying Enter starts it now, so it does.
 * - Nothing known yet, or a read that failed while typing: defer — submitted at once, settled in the background.
 */
export function submitAct(a: { trigger: boolean; known: ScheduleKnown; dismissed: string | undefined }): SubmitAct {
  if (!a.trigger) return { act: "dispatch" }
  const k = a.known
  switch (k.kind) {
    case "schedule":
      return isDismissed(k.result, a.dismissed) ? { act: "dispatch" } : { act: "create", result: k.result }
    case "none":
    case "refused":
      return { act: "dispatch" }
    case "failed":
    case "pending":
      return { act: "defer" }
  }
}

/** What a deferred submit becomes once its reading lands. `note`: the toast says why a schedule word did not make
 *  a schedule, so a thread never starts silently in place of one the human may have meant. */
export type SettleAct = { act: "dispatch"; note?: string } | { act: "create"; result: ModelReadOk }

/** The note on a thread started because its words could not be checked. */
export const UNCHECKED_NOTE = "Couldn't check for a schedule, so it started as a thread."

/**
 * A deferred submit's words, settled by their reading. `off`: "not a schedule" was said for these words before
 * Enter (a pending dismissal covers whatever reading lands — `dismissedPhrase`).
 */
export function settleAct(answer: ScheduleAnswer, off: (result: ModelReadOk) => boolean): SettleAct {
  switch (answer.kind) {
    case "schedule":
      return off(answer.result) ? { act: "dispatch" } : { act: "create", result: answer.result }
    case "none":
      return { act: "dispatch" }
    case "refused":
      return { act: "dispatch", note: answer.copy }
    case "failed":
      return { act: "dispatch", note: UNCHECKED_NOTE }
  }
}

// ---- what the strip under the box shows ------------------------------------------------------------------------

export type StripView =
  | { kind: "none" }
  /** A read of this text is out and nothing is on screen: only the faint cue on the schedule words. */
  | { kind: "pending" }
  /** The schedule Enter creates: `fresh` for this very text, else the last one read while this one is read
   *  (stale-while-revalidate), from `readText`. */
  | { kind: "schedule"; result: ModelReadOk; readText: string; fresh: boolean }
  /** A schedule the box cannot make, and why. */
  | { kind: "refused"; copy: string }
  /** Undo dismissed this reading: the line that says Enter starts it now, with a way to schedule it after all. */
  | { kind: "undone" }

export type Dismissal = { phrase: string; undone: boolean }

/**
 * The strip, given what is known about the text, the read out for it, and the newest answer known before it.
 *
 * Text with no schedule word shows nothing, whatever was read before: the box looks exactly as it does without
 * schedules. A schedule read from an earlier text STAYS while this one is read and updates in place when the
 * answer lands; an answer of no schedule takes it away. A refusal is said only for the text it was given for:
 * read from an earlier text it is usually a schedule half typed ("every Monday at" has no task yet).
 */
export function stripView(a: {
  trigger: boolean
  /** The words the model reads for the text on screen (`readTextOf`). */
  text: string
  known: ScheduleKnown
  /** A read of exactly this text is out, or queued behind the one that is. */
  reading: boolean
  stale: { text: string; answer: ScheduleAnswer } | undefined
  dismissed: Dismissal | undefined
}): StripView {
  if (!a.trigger) return { kind: "none" }
  const d = a.dismissed
  const k = a.known
  if (k.kind === "schedule") {
    if (isDismissed(k.result, d?.phrase)) return d!.undone ? { kind: "undone" } : { kind: "none" }
    return { kind: "schedule", result: k.result, readText: a.text, fresh: true }
  }
  if (k.kind === "refused") return { kind: "refused", copy: k.copy }
  if (k.kind === "none") return { kind: "none" }
  // Pending or failed: what was read before stays, if it was a schedule.
  const s = a.stale?.answer
  if (s?.kind === "schedule") {
    if (!isDismissed(s.result, d?.phrase)) return { kind: "schedule", result: s.result, readText: a.stale!.text, fresh: false }
    if (d!.undone) return { kind: "undone" }
  } else if (d?.undone) return { kind: "undone" }
  return a.reading ? { kind: "pending" } : { kind: "none" }
}

/**
 * How a strip is drawn, and whether the send wears ↻. `readDue`: a read of exactly the words on screen is out, or
 * due once the typing rests (or due again, its answer expired).
 *
 * - The words' own reading is CURRENT: drawn plainly, and Enter creates it.
 * - A reading of other words while the words are read is UPDATING: it shimmers and keeps ↻, so a word typed into
 *   a schedule does not flicker the send between glyphs (stale-while-revalidate, D4).
 * - A reading of other words with no read coming — the budget spent, the read failed — is updating too, but
 *   still, and the send is plain: Enter will check the words before it does anything. Until the fix round
 *   (2026-10-06, B) it was drawn as current, ↻ and all, over an Enter that held, read, and started a thread.
 */
export function stripLook(strip: StripView, readDue: boolean): { updating: boolean; revalidating: boolean; scheduleGlyph: boolean } {
  if (strip.kind !== "schedule") return { updating: false, revalidating: false, scheduleGlyph: false }
  if (strip.fresh) return { updating: false, revalidating: false, scheduleGlyph: true }
  return { updating: true, revalidating: readDue, scheduleGlyph: readDue }
}
