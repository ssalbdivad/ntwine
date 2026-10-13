import { useEffect, useReducer, useRef, useState } from "react"
import {
  SCHEDULE_NOT_FOUND_COPY,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_SPACING_COPY,
  zonedWall,
  type InterpretScheduleResult,
} from "@ntwine/shared"

// THE MODEL READS OF A SCHEDULE (ARCHITECTURE.md § Scheduled threads), shared by the prompt box and the drawer's
// Change when. The server's interpreter (`interpretSchedule`, schedule-interpreter.ts) decides whether the
// words ask for a schedule and reads it out of them. Each read costs the human's quota and holds the
// interpreter's per-project `concurrency: 1` queue, so it is spent carefully:
//
// - SINGLE FLIGHT PER READER. At most one request is out. A text that changes while one is out waits as the one
//   queued follow-up — only the LATEST text, so a burst of edits during a read costs exactly one more read,
//   and a stale request sits at most one deep in the server's queue. The stale answer is still cached. The
//   prompt box's reader is per DRAFT (`sharedModelReader`), so the `c` dialog and the page box under it, which
//   edit one draft, share one flight; a drawer's Change when has its own.
// - A 10m CACHE across every box, keyed `context \0 tz \0 local date \0 text`. The date is in the key because
//   "tomorrow at 8" read yesterday is not today's reading; `context` names what else the read depended on (a
//   Change when reads against its schedule's stored rule and condition, so its answers are not the box's).
//   Only the model's VERDICTS are cached — a reading or a refusal it would give again. A transport failure
//   or a switched-off interpreter is kept for its text this session but never cached, so a submit asks again.
// - A BUDGET of 40 automatic reads per reader — per draft in the box, per edit in the drawer. Past it only an
//   explicit read (a submit, Enter in the drawer) goes out; explicit reads are single-flight but never
//   budgeted. `reset` refills it when the draft starts over.
// - A CALL THAT HANGS is given up after READ_TIMEOUT_MS: its text reads as failed and the queued text goes out.
//   A verdict that arrives later is still cached.
// - WHAT STAYS ON SCREEN while the words are read again (stale-while-revalidate) is the answer for the newest
//   text the box itself showed before them, in the order they were typed (`useNewestAnswer`) — never simply
//   the last answer to land, which can be an older text's, queued behind a newer one.
// - AN ANSWER PAST ITS 10m (or read on another local day) is EXPIRED, not gone: it is no longer the answer for
//   its words (`view` says `expired`, and a submit reads them again), but it is still the reading the box has
//   for them (`known`), shown as not current while they are read again. Dropping it took the strip and ↻ away
//   under unchanged words, with no read going out, while Enter would still create (fix round, G).
//
// The text is read as given. Callers send it TRIMMED: the server trims it anyway (`InterpretScheduleInput`),
// and the answer's offsets index what it read, so a caller maps them onto its own text by adding the
// whitespace it trimmed off the front (lib/scheduleIntent.ts `phraseSpan`). Cancellation is client-side
// discard only; `interpretSchedule`'s contract is unchanged.

/** How long a cached model answer stays good. */
export const MODEL_CACHE_TTL_MS = 10 * 60_000
/** The most model answers the cache holds; the oldest go first. */
export const MODEL_CACHE_MAX = 50
/** Automatic model reads per reader (per draft); a submit still reads after this. */
export const MODEL_READ_BUDGET = 40
/** A read that has not answered after this long is a failed read. */
export const READ_TIMEOUT_MS = 15_000

export type ModelReadOk = Extract<InterpretScheduleResult, { ok: true }>

// ---- the cache ------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; result: InterpretScheduleResult }>()

/** The cache key for a read of `text` at `nowMs`: `context \0 tz \0 local date \0 text`. */
export function modelReadKey(input: { context?: string; tz: string; nowMs: number; text: string }): string {
  let date = ""
  try {
    const w = zonedWall(input.nowMs, input.tz)
    date = `${w.y}-${w.mo}-${w.d}`
  } catch {
    date = new Date(input.nowMs).toISOString().slice(0, 10)
  }
  return [input.context ?? "", input.tz, date, input.text].join("\0")
}

/** A cached answer still inside its TTL, or undefined. A hit is refreshed to the newest end of the LRU. */
export function cachedModelRead(key: string, nowMs: number): InterpretScheduleResult | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (nowMs - hit.at > MODEL_CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.result
}

function remember(key: string, result: InterpretScheduleResult, nowMs: number): void {
  cache.delete(key)
  cache.set(key, { at: nowMs, result })
  while (cache.size > MODEL_CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/** Tests only: start from an empty cache. */
export function clearModelReadCache(): void {
  cache.clear()
}

/** An answer the model would give again for the same words — a reading, or a refusal of the words
 *  themselves. Not: a failed call, a timeout, an interpreter that is switched off. */
export function isModelVerdict(result: InterpretScheduleResult): boolean {
  if (result.ok) return true
  const e = result.error
  return e === SCHEDULE_NOT_FOUND_COPY || e === SCHEDULE_PRESENCE_COPY || e === SCHEDULE_SPACING_COPY
    || e.startsWith("Couldn't turn that into a schedule") || e.startsWith("What should each run do?")
}

/** The interpreter's own words for a call that failed on its side ("Couldn't read that just now: …"). */
export function isFailedRead(result: InterpretScheduleResult): boolean {
  return !result.ok && /^Couldn't read that just now\b/.test(result.error)
}

// ---- the reader: single flight, budget ------------------------------------------------------------------

export type ModelReadView =
  /** Nothing asked for this text yet. */
  | { status: "none" }
  /** Out now, or queued behind the read that is. */
  | { status: "reading" }
  /** The model's answer for exactly this text (cached, or this session's non-verdict answer). */
  | { status: "answered"; result: InterpretScheduleResult }
  /** The request failed or timed out; an explicit read asks again. */
  | { status: "failed"; message: string }
  /** The automatic reads are spent; only an explicit read goes out. */
  | { status: "budget" }
  /** The model answered these words, but past the cache's 10m (or on another local day): no longer the answer,
   *  still the reading the box has for them (`known`) until they are read again. */
  | { status: "expired" }

export interface ModelReader {
  /** Ask for a model reading of `text`. A cached answer costs nothing; a text already out is not sent
   *  twice; with a read out, `text` becomes the one queued follow-up. An automatic request past the budget
   *  is refused (`view` says `budget`); an `explicit` one is never budgeted, and asks again after a failure. */
  request(text: string, opts?: { explicit?: boolean }): void
  /** Drop the queued follow-up: the text no longer needs the model. */
  cancelQueued(): void
  view(text: string): ModelReadView
  /** The newest answer this reader has for `text` and whether it is still CURRENT (cached: inside the 10m, read
   *  today) — an expired one is what stays on screen while the words are read again. Includes this session's
   *  non-verdict answers (current); undefined when it has none. */
  known(text: string): { result: InterpretScheduleResult; fresh: boolean } | undefined
  /** Automatic reads spent since the last reset. */
  spent(): number
  /** Start over (the draft was cleared): the budget refills, and this session's failures and non-verdict
   *  answers are forgotten. A read still out lands in the cache as usual. */
  reset(): void
  subscribe(listener: () => void): () => void
}

export interface ModelReaderDeps {
  interpret: (text: string) => Promise<InterpretScheduleResult>
  /** The cache key for `text` read now (`modelReadKey` with the box's context and zone). */
  keyOf: (text: string, nowMs: number) => string
  now?: () => number
  budget?: number
  timeoutMs?: number
  /** Tests: the timer the timeout runs on. */
  timers?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

export function createModelReader(deps: ModelReaderDeps): ModelReader {
  const now = deps.now ?? Date.now
  const budget = deps.budget ?? MODEL_READ_BUDGET
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS
  const timers = deps.timers ?? {
    set: (run: () => void, ms: number) => {
      const handle = setTimeout(run, ms)
      // Under node (the tests) a read's give-up timer must not hold the process open; a browser has no unref.
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const listeners = new Set<() => void>()
  let flight: string | undefined
  let queued: { text: string; explicit: boolean } | undefined
  let spent = 0
  let refusedForBudget: string | undefined
  /** This session's answers that are not cached (non-verdicts), by text; bounded. */
  const answers = new Map<string, InterpretScheduleResult>()
  const failures = new Map<string, string>()
  /** Every verdict this reader has seen, by text, past the cache's TTL and its day: what an expired answer
   *  still shows. Bounded like the cache. */
  const verdicts = new Map<string, InterpretScheduleResult>()
  const keep = (text: string, result: InterpretScheduleResult) => {
    verdicts.delete(text)
    verdicts.set(text, result)
    while (verdicts.size > MODEL_CACHE_MAX) verdicts.delete(verdicts.keys().next().value!)
  }

  const notify = () => { for (const l of [...listeners]) l() }
  const cached = (text: string) => {
    const hit = cachedModelRead(deps.keyOf(text, now()), now())
    // Another reader's answer (the cache is the tab's) is this reader's to keep too, once seen.
    if (hit && verdicts.get(text) !== hit) keep(text, hit)
    return hit
  }

  function launch(text: string, explicit: boolean): void {
    if (!explicit) spent++
    failures.delete(text)
    answers.delete(text)
    if (refusedForBudget === text) refusedForBudget = undefined
    flight = text
    const key = deps.keyOf(text, now())
    let done = false
    const finish = () => {
      done = true
      timers.clear(timer)
      flight = undefined
      const next = queued
      queued = undefined
      if (next && !cached(next.text)) start(next.text, next.explicit)
      notify()
    }
    const timer = timers.set(() => {
      if (done) return
      failures.set(text, "timed out")
      finish()
    }, timeoutMs)
    let call: Promise<InterpretScheduleResult>
    try {
      call = deps.interpret(text)
    } catch (error) {
      call = Promise.reject(error)
    }
    call.then(
      (result) => {
        // A verdict is a verdict even after the wait was given up on: cached for the next ask.
        if (isModelVerdict(result)) {
          remember(key, result, now())
          keep(text, result)
        }
        if (done) {
          if (isModelVerdict(result)) notify()
          return
        }
        if (!isModelVerdict(result)) {
          answers.set(text, result)
          while (answers.size > 20) answers.delete(answers.keys().next().value!)
        }
        finish()
      },
      (error: unknown) => {
        if (done) return
        failures.set(text, error instanceof Error ? error.message : String(error))
        finish()
      },
    )
  }

  function start(text: string, explicit: boolean): void {
    if (!explicit && spent >= budget) {
      refusedForBudget = text
      return
    }
    launch(text, explicit)
  }

  return {
    request(text, opts) {
      const explicit = opts?.explicit === true
      if (cached(text) !== undefined) return
      if (flight === text) {
        // Asked again for the text that is out: nothing to send, but a queued older text is moot now.
        queued = undefined
        return
      }
      // A non-verdict answer or a failure stays as it is until an explicit read asks again.
      if (!explicit && (answers.has(text) || failures.has(text))) return
      if (flight !== undefined) {
        queued = { text, explicit: explicit || (queued?.text === text && queued.explicit) }
        notify()
        return
      }
      start(text, explicit)
      notify()
    },
    cancelQueued() {
      if (!queued) return
      queued = undefined
      notify()
    },
    view(text) {
      const hit = cached(text)
      if (hit) return { status: "answered", result: hit }
      if (flight === text || queued?.text === text) return { status: "reading" }
      const answer = answers.get(text)
      if (answer) return { status: "answered", result: answer }
      const failure = failures.get(text)
      if (failure !== undefined) return { status: "failed", message: failure }
      if (refusedForBudget === text) return { status: "budget" }
      if (verdicts.has(text)) return { status: "expired" }
      return { status: "none" }
    },
    known(text) {
      const hit = cached(text)
      if (hit) return { result: hit, fresh: true }
      const answer = answers.get(text)
      if (answer) return { result: answer, fresh: true }
      const kept = verdicts.get(text)
      return kept ? { result: kept, fresh: false } : undefined
    },
    spent: () => spent,
    reset() {
      spent = 0
      refusedForBudget = undefined
      failures.clear()
      answers.clear()
      verdicts.clear()
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The readers boxes share, by draft (`useModelReader`'s `share`). One per draft key the tab has opened — a
 *  handful — each holding at most 20 answers; kept for the tab, like the cache. */
const sharedReaders = new Map<string, { deps: { current: ModelReaderDeps }; reader: ModelReader }>()

function readerOver(deps: { current: ModelReaderDeps }): ModelReader {
  const first = deps.current
  return createModelReader({
    interpret: (text) => deps.current.interpret(text),
    keyOf: (text, nowMs) => deps.current.keyOf(text, nowMs),
    ...(first.now ? { now: () => deps.current.now!() } : {}),
    ...(first.budget !== undefined ? { budget: first.budget } : {}),
    ...(first.timeoutMs !== undefined ? { timeoutMs: first.timeoutMs } : {}),
  })
}

/**
 * The reader for every box on one draft. The `c` dialog and the page box under it edit ONE draft, so they share
 * one flight and one budget: with a reader each, both boxes sent the same text, two model calls for one edit
 * (fix round 1, X2). With one, the second box's request finds that text already out and sends nothing, and the
 * answer lands in both. The latest box to render supplies `interpret` and `keyOf`.
 */
export function sharedModelReader(key: string, deps: ModelReaderDeps): ModelReader {
  let entry = sharedReaders.get(key)
  if (!entry) {
    const holder = { current: deps }
    entry = { deps: holder, reader: readerOver(holder) }
    sharedReaders.set(key, entry)
  }
  entry.deps.current = deps
  return entry.reader
}

/** Tests only: forget the shared readers. */
export function clearSharedModelReaders(): void {
  sharedReaders.clear()
}

/** At most this many earlier texts are remembered — a backstop: the history holds only texts that can still answer
 *  (`typedHistory`), which single flight keeps to a handful. */
export const TYPED_HISTORY_MAX = 24

/** What a box's history asks of its reader. */
export type HistoryReader = Pick<ModelReader, "view" | "known">

/** A usable answer: one the model gave, not a read that failed on its side. */
const answerOf = (known: ReturnType<ModelReader["known"]>) => (known && !isFailedRead(known.result) ? known : undefined)

/**
 * `history` with `text` moved to its newest end (it is the text on screen now). Empty text starts over.
 *
 * With its `reader`, the history keeps only the texts that can still be SHOWN: every text a read is out or queued
 * for, or that has an answer, from the newest one with an answer on. A text nothing was ever asked about (typed
 * inside a word, gone before the idle) never will be, and an answer older than a newer one is never shown again,
 * so both go. It held the last 24 texts typed instead until 2026-10-06 (fix round, F1): typed at 172ms a key
 * with reads of 4–6s, 24 and 29 texts went by between a read going out and its answer landing, so the answer was
 * never drawn, and the reading on screen fell out of the history too — the strip closed for 48ms until the next
 * answer reopened it.
 */
export function typedHistory(history: readonly string[], text: string, reader?: HistoryReader): readonly string[] {
  if (!text) return []
  if (history[history.length - 1] === text) return history
  const earlier = history.filter((t) => t !== text && (!reader || reader.view(t).status !== "none"))
  let answered = -1
  if (reader) {
    for (let i = earlier.length - 1; i >= 0 && answered < 0; i--) if (answerOf(reader.known(earlier[i]!))) answered = i
  }
  const kept = earlier.slice(Math.max(answered, 0))
  // The backstop never drops the newest answer, however many texts are waiting after it.
  const cap = TYPED_HISTORY_MAX - 1
  return [...(answered >= 0 && kept.length > cap ? [kept[0]!, ...kept.slice(-(cap - 1))] : kept.slice(-cap)), text]
}

/**
 * What stays on screen while `text` is read (stale-while-revalidate): `text`'s own answer when there is one, else
 * the answer for the newest text typed BEFORE it that has one. "Newest" is the typing order (`history`, oldest
 * first), not the order the answers landed: with one read out and the latest text queued behind it, an older
 * text's answer routinely lands after a newer one's was shown, and taking "the last to land" put the older
 * reading back on screen. A failed read is no answer, so what was shown before it stays. `current`: the answer is
 * for exactly `text`, and still good (not expired).
 */
export function newestAnswer(
  history: readonly string[],
  text: string,
  known: ModelReader["known"],
): { text: string; result: InterpretScheduleResult; current: boolean } | undefined {
  if (!text) return undefined
  const own = answerOf(known(text))
  if (own) return { text, result: own.result, current: own.fresh }
  for (let i = history.length - 1; i >= 0; i--) {
    const before = history[i]!
    if (before === text) continue
    const answer = answerOf(known(before))
    if (answer) return { text: before, result: answer.result, current: false }
  }
  return undefined
}

/** `newestAnswer` for a box: it keeps the box's own typing history. Cleared with the text. */
export function useNewestAnswer(reader: ModelReader, text: string): ReturnType<typeof newestAnswer> {
  const history = useRef<readonly string[]>([])
  history.current = typedHistory(history.current, text, reader)
  return newestAnswer(history.current, text, (t) => reader.known(t))
}

/** A reader for the component's lifetime — or, with `share`, the one every box on that draft uses — and a
 *  re-render whenever what it knows changes. The latest `interpret` and `keyOf` are always the ones called, so
 *  a reader never reads with a stale schedule. */
export function useModelReader(deps: ModelReaderDeps, opts: { share?: string } = {}): ModelReader {
  const latest = useRef(deps)
  latest.current = deps
  const [own] = useState(() => (opts.share === undefined ? readerOver(latest) : null))
  const reader = opts.share === undefined ? own! : sharedModelReader(opts.share, deps)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => reader.subscribe(bump), [reader])
  return reader
}

/**
 * The reader's answer for exactly `text`, once it lands: what a submit that did not wait for it settles on
 * (lib/scheduleIntent.ts `settleAct`). Asks explicitly — past the budget, and again after a failure — and asks
 * again if the ask is dropped from under it: the box the words left empties, which cancels the queued read
 * (lib/scheduleReadScheduler.ts) — and every edit of the next draft does that again. A read that never answers
 * resolves `failed` after `timeoutMs`.
 */
export function awaitReading(reader: ModelReader, text: string, timeoutMs = READ_TIMEOUT_MS): Promise<Extract<ModelReadView, { status: "answered" | "failed" }>> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (view: Extract<ModelReadView, { status: "answered" | "failed" }>) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      unsubscribe()
      resolve(view)
    }
    const check = (first: boolean) => {
      if (finished) return
      const view = reader.view(text)
      if (view.status === "answered" || (view.status === "failed" && !first)) return finish(view)
      if (view.status === "reading") return
      // Nothing out for the words (a failure from before this submit, a dropped ask, an expired answer): ask. The
      // box drops a queued ask at every edit of the next draft, so this re-asks as often as it takes; the timeout is
      // the bound.
      reader.request(text, { explicit: true })
    }
    const timer = setTimeout(() => finish({ status: "failed", message: "timed out" }), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    const unsubscribe = reader.subscribe(() => check(false))
    check(true)
  })
}
