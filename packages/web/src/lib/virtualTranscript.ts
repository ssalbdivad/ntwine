import type { ChatMessage } from "../hooks.ts"
import { breakBetween, breakInstant, timeBreaks, type TimeBreak } from "./timeBreaks.ts"

// USER_TAIL_EXTRA lived here for one reason — ChatView imports this module, so it could not be declared
// beside STEP in ChatView — and that reason ended when the rhythm moved into components/rhythm.tsx,
// which imports nothing. It is re-exported so the row builder's callers keep one import.
export { USER_TAIL_EXTRA } from "../components/rhythm.tsx"

export interface VirtualTranscriptMessageRow {
  key: string
  message: ChatMessage
  messageIndex: number
  gap: number
}

// How close to the tail counts as "reading the tail". One constant for THREE things that must never
// drift apart: the virtualizer's own scrollEndThreshold, whether "Jump to latest" is hidden, and
// whether new content pins the reader to the bottom. The invariant the reader actually perceives is
// "if the jump button is hidden, I am attached" — two thresholds would break exactly that.
//
// This is a ROUNDING EPSILON, not a comfort band. It was 240 (a third of a pane), then 64; at both sizes
// a reader who nudged up a line or two to re-read something still counted as attached, so the next thing
// to land hauled them back to the bottom — measured at 24px above the bottom, a single append dragged the
// reader 346px (scripts/verify-full-nudge-threshold.mjs). The rule the reader expects is the literal one:
// if the bottom of the transcript is not at the bottom of the pane, nothing may move them. So the band has
// to cover only what a reader CANNOT have chosen — the sub-pixel residue that fractional layout and
// device-pixel rounding leave at the genuine bottom, which is where the `distance <= 1` write guard below
// already draws the line. A wheel notch is 40px+, so every deliberate scroll now detaches.
export const TAIL_FOLLOW_PX = 4

export interface TailFollowInput {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** The scroll height observed at the previous reconciliation (-1 before the first one). */
  previousScrollHeight: number
  /** Whether the reader was attached to the tail as of that previous reconciliation. */
  following: boolean
  /** The reader is actively driving the scroller (a wheel/touch/key gesture is in flight). */
  readerMoved: boolean
}

export interface TailFollow {
  following: boolean
  /** The scrollTop to write to stay attached, or null to leave the scroller alone. */
  scrollTop: number | null
}

// Reconcile "is the reader attached to the tail?" with the re-pin that keeps them there.
//
// The whole difficulty is telling the two causes of a growing distance-from-bottom apart, because they
// demand opposite responses: the READER scrolled up (leave them alone) versus the CONTENT grew under
// them (pull them back down). Distance alone cannot say which — so compare the scroll height. Same
// height means only the reader can have moved, so the current distance IS their intent and fully
// reclassifies attachment. A changed height means the tail moved under them, so their previous
// attachment carries over; a resize may only ADD attachment, and only by bringing the true bottom back
// to exactly where they already sit (a shrink, e.g. the Working… row retiring).
//
// This is deliberately not "recompute on scroll, follow on render": those two callbacks interleave in
// an order nothing here controls (the virtualizer's own scroll listener re-renders through React
// before our listener runs), and a follow that read a stale attachment yanked a reader who had just
// scrolled up straight back to the bottom.
export function nextTailFollow(input: TailFollowInput): TailFollow {
  const max = Math.max(input.scrollHeight - input.clientHeight, 0)
  const distance = max - input.scrollTop
  const resized = input.scrollHeight !== input.previousScrollHeight
  const following = resized && !input.readerMoved
    ? input.following || distance <= 1
    : distance <= TAIL_FOLLOW_PX
  // Only ever WRITE in response to the content moving. A reader-driven scroll reclassifies attachment
  // and nothing more: correcting one there would mean every small scroll-up inside the threshold gets
  // instantly undone — the scroller literally fighting the wheel. Fractional layout also leaves a
  // sub-pixel residue at the genuine bottom, which must not provoke a write (and a scroll event) on
  // every commit forever; only close a gap a reader could actually see.
  if (!following || !resized || max <= 0 || distance <= 1) return { following, scrollTop: null }
  return { following, scrollTop: max }
}

export interface EarlierLoadGateInput {
  armed: boolean
  scrollTop: number
  readerMoved: boolean
  hasEarlier: boolean
  loading: boolean
}

export function earlierLoadGate(input: EarlierLoadGateInput): { armed: boolean; shouldLoad: boolean } {
  const armed = input.scrollTop > 640 ? true : input.armed
  const shouldLoad = armed
    && input.readerMoved
    && input.scrollTop <= 480
    && input.hasEarlier
    && !input.loading
  return { armed: shouldLoad ? false : armed, shouldLoad }
}

function legacyMessageKey(message: ChatMessage): string {
  return `legacy:${message.role}:${message.kind ?? "message"}:${message.at ?? ""}:${message.text}`
}

// `gapBetween` is ChatView's messageGap — the single expression of the between-message rhythm, injected
// rather than imported because ChatView imports this module. A row's `gap` renders ABOVE it, so the gap
// is charged to the row that FOLLOWS: that is what puts the extra air under whatever the previous
// message ended with (an inlined screenshot included) rather than under its text.
export function buildVirtualTranscriptMessageRows(
  messages: readonly ChatMessage[],
  rendersNothing: (message: ChatMessage) => boolean,
  gapBetween: (previous: ChatMessage, next: ChatMessage) => number,
): VirtualTranscriptMessageRow[] {
  const rows: VirtualTranscriptMessageRow[] = []
  const keyCounts = new Map<string, number>()
  let previous: ChatMessage | null = null

  messages.forEach((message, messageIndex) => {
    if (message.queued || rendersNothing(message)) return
    const baseKey = message.sourceId ?? legacyMessageKey(message)
    const duplicate = keyCounts.get(baseKey) ?? 0
    keyCounts.set(baseKey, duplicate + 1)
    rows.push({
      key: duplicate === 0 ? baseKey : `${baseKey}:${duplicate}`,
      message,
      messageIndex,
      gap: previous === null ? 0 : gapBetween(previous, message),
    })
    previous = message
  })

  return rows
}

// ── The transcript's message rows, kept incrementally ──────────────────────────────────────────────────
//
// The virtualized thread view's message rows: the entries a row builder would walk (the coalesced activity
// list), minus the queued and the ones that draw nothing, each with its render key, its gap to the previous
// RENDERED row and its time break. `transcriptMessageRowsFull` is the definition; it is what the drawer ran
// on every update until 2026-10-16. `transcriptMessageRows` gives the identical answer while walking only
// what changed: on a streaming thread the whole history but the tail.
//
// What a row of the prefix depends on: its entry (message object and transcript index), whether the entry
// is drawn — `rendersNothing` of the message and its two positional flags, stale (below `awaitingCut`) and
// owned (AT the cut while the resting card shows) — and, through the gap and the time break, the rows
// before it. So the previous answer holds for every entry up to the first that differs from last time in
// any of those, and the walk resumes there from a checkpoint (how many rows, and the time-break clock).
//
// Two things the prefix CANNOT see are what a later entry adds to it: a render key already used above
// (the next one is suffixed) and a message object already listed above (the stale/owned sets key on the
// object, ChatView rendersNothingIn). Both are legacy-transcript corners, so the walk keeps only enough to
// notice one, and falls back to a full pass when it does. Equivalence is pinned in
// virtualTranscript.incremental.test.ts.

export interface TranscriptRowEntry {
  message: ChatMessage
  /** The entry's index in the transcript (ToolActivityMessage.messageIndex). */
  messageIndex: number
  /** When the coalesced tool run the entry stands for began (ToolActivityMessage.runStartedAt). */
  runStartedAt?: string
}

export interface TimedTranscriptRow extends VirtualTranscriptMessageRow {
  timeBreak: TimeBreak | null
  timeBreakAt: string | undefined
}

export interface TranscriptRowRules {
  /** The index a fence goes stale below — ChatView's `awaitingCut`. */
  awaitingCut: number
  /** The resting card states the message AT the cut, so its fence draws nothing (showsRestingCard). */
  restingShown: boolean
  rendersNothing: (message: ChatMessage, stale: boolean, owned: boolean) => boolean
  gapBetween: (previous: ChatMessage, next: ChatMessage) => number
}

/** The definition, as one pass from scratch. */
export function transcriptMessageRowsFull(entries: readonly TranscriptRowEntry[], rules: TranscriptRowRules): TimedTranscriptRow[] {
  const { awaitingCut, restingShown } = rules
  const stale = new WeakSet<ChatMessage>()
  const owned = new WeakSet<ChatMessage>()
  if (awaitingCut >= 0) for (const entry of entries) if (entry.messageIndex < awaitingCut) stale.add(entry.message)
  if (awaitingCut >= 0 && restingShown) for (const entry of entries) if (entry.messageIndex === awaitingCut) owned.add(entry.message)
  const rows = buildVirtualTranscriptMessageRows(
    entries.map((entry) => entry.message),
    (message) => rules.rendersNothing(message, stale.has(message), owned.has(message)),
    rules.gapBetween,
  )
  const startAt = (row: VirtualTranscriptMessageRow) => entries[row.messageIndex]!.runStartedAt ?? row.message.at
  const breaks = timeBreaks(rows, startAt, (row) => row.message.at)
  return rows.map((row, i) => ({
    ...row,
    messageIndex: entries[row.messageIndex]!.messageIndex,
    timeBreak: breaks[i]!,
    timeBreakAt: startAt(row),
  }))
}

interface RowsRun {
  entries: readonly TranscriptRowEntry[]
  awaitingCut: number
  restingShown: boolean
  rendersNothing: TranscriptRowRules["rendersNothing"]
  gapBetween: TranscriptRowRules["gapBetween"]
  rows: TimedTranscriptRow[]
  /** After entries[i]: how many rows, and the time-break clock (timeBreaks's `previousEnd`). */
  rowCount: number[]
  clock: (number | null)[]
  /** Where each render key and each message object sits (row index; entry position). Carried forward
   *  from run to run and never pruned: a recorded position that no longer holds its key or object is left
   *  over from a suffix an older run discarded, and is told apart by looking (see rowsFrom). */
  keyAt: Map<string, number>
  objectAt: WeakMap<ChatMessage, number>
}
const rowRuns = new WeakMap<ChatMessage, RowsRun>()

/** `transcriptMessageRowsFull`'s answer, resumed from the last call over the same transcript. */
export function transcriptMessageRows(entries: readonly TranscriptRowEntry[], rules: TranscriptRowRules): TimedTranscriptRow[] {
  const head = entries[0]?.message
  const previous = head ? rowRuns.get(head) : undefined
  const run = (previous && rowsFrom(previous, entries, rules)) ?? rowsFrom(undefined, entries, rules)
  if (run) {
    if (head) rowRuns.set(head, run)
    return run.rows
  }
  // A repeated key or message object from scratch: the definition, and nothing to resume from next time.
  if (head) rowRuns.delete(head)
  return transcriptMessageRowsFull(entries, rules)
}

const flagsAt = (messageIndex: number, awaitingCut: number, restingShown: boolean): number =>
  awaitingCut < 0 ? 0 : (messageIndex < awaitingCut ? 1 : 0) | (restingShown && messageIndex === awaitingCut ? 2 : 0)

// Undefined when the walk met something only a full pass gets right (see the header).
function rowsFrom(previous: RowsRun | undefined, entries: readonly TranscriptRowEntry[], rules: TranscriptRowRules): RowsRun | undefined {
  const { awaitingCut, restingShown, rendersNothing, gapBetween } = rules
  let shared = 0
  if (previous && previous.rendersNothing === rendersNothing && previous.gapBetween === gapBetween) {
    const limit = Math.min(previous.entries.length, entries.length)
    while (shared < limit) {
      const was = previous.entries[shared]!, now = entries[shared]!
      if (was.message !== now.message || was.messageIndex !== now.messageIndex || was.runStartedAt !== now.runStartedAt) break
      if (flagsAt(was.messageIndex, previous.awaitingCut, previous.restingShown) !== flagsAt(now.messageIndex, awaitingCut, restingShown)) break
      shared++
    }
  }
  const prefixRows = shared > 0 ? previous!.rowCount[shared - 1]! : 0
  const rows = shared > 0 ? previous!.rows.slice(0, prefixRows) : []
  const rowCount = shared > 0 ? previous!.rowCount.slice(0, shared) : []
  const clock = shared > 0 ? previous!.clock.slice(0, shared) : []
  const keyAt = shared > 0 ? previous!.keyAt : new Map<string, number>()
  const objectAt = shared > 0 ? previous!.objectAt : new WeakMap<ChatMessage, number>()
  let previousEnd = shared > 0 ? clock[shared - 1]! : null
  let previousMessage = rows.length > 0 ? rows[rows.length - 1]!.message : null
  for (let i = shared; i < entries.length; i++) {
    const entry = entries[i]!
    const message = entry.message
    // A position recorded for this object that still holds it is a genuine repeat; one that does not is
    // left over from a suffix an older run discarded. A successful run lists every object once, so the map
    // is exact for its own entries, and the prefix inherits that.
    const seenAt = objectAt.get(message)
    if (seenAt !== undefined && seenAt < i && entries[seenAt]?.message === message) return undefined
    objectAt.set(message, i)
    const flags = flagsAt(entry.messageIndex, awaitingCut, restingShown)
    if (!message.queued && !rendersNothing(message, (flags & 1) === 1, (flags & 2) === 2)) {
      const key = message.sourceId ?? legacyMessageKey(message)
      const keySeen = keyAt.get(key)
      if (keySeen !== undefined && keySeen < rows.length && rows[keySeen]!.key === key) return undefined
      keyAt.set(key, rows.length)
      const startAt = entry.runStartedAt ?? message.at
      const start = breakInstant(startAt)
      let timeBreak: TimeBreak | null = null
      if (start !== null) {
        timeBreak = breakBetween(previousEnd, start)
        previousEnd = Math.max(previousEnd ?? 0, breakInstant(message.at) ?? start)
      }
      rows.push({ key, message, messageIndex: entry.messageIndex, gap: previousMessage === null ? 0 : gapBetween(previousMessage, message), timeBreak, timeBreakAt: startAt })
      previousMessage = message
    }
    rowCount.push(rows.length)
    clock.push(previousEnd)
  }
  return { entries, awaitingCut, restingShown, rendersNothing, gapBetween, rows, rowCount, clock, keyAt, objectAt }
}
