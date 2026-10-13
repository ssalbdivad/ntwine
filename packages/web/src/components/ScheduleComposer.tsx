import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Repeat, X } from "lucide-react"
import {
  cutPhrase,
  hasScheduleTrigger,
  provisionalScheduleTitle,
  scheduleTriggerSpans,
  type CreateScheduleInput,
  type ScheduleView,
  type Span,
} from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { flashScheduleCount, pushScheduleDrawer, showToast } from "../store.ts"
import { invalidateSchedules } from "../lib/schedules.ts"
import {
  SCHEDULE_DRAFT_NONE,
  afterDraftCreates,
  beginDraftCreate,
  useDraftCreating,
  useScheduleDraftState,
  writeScheduleDraftState,
} from "../lib/scheduleDraftState.ts"
import { awaitReading, modelReadKey, useModelReader, useNewestAnswer, type ModelReadOk } from "../lib/scheduleModelRead.ts"
import { classifyEdit, createReadScheduler, type BoxInputEvent, type ChangeKind, type ReadScheduler } from "../lib/scheduleReadScheduler.ts"
import {
  NO_TASK_COPY,
  classifyResult,
  dismissalCovers,
  dismissedPhrase,
  knownOf,
  nextDismissal,
  phraseSpan,
  readTextOf,
  settleAct,
  stripLook,
  stripView,
  submitAct,
  type ScheduleKnown,
  type StripView,
} from "../lib/scheduleIntent.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { spanUntil } from "../lib/activityTime.ts"
import { SOON_MS, UNPHRASABLE_COPY, browserZone, describeRule, schedulePreviewModel, unphrasableRule } from "./SchedulePreview.tsx"
import type { ComposerMark } from "./Composer.tsx"

// THE PROMPT BOX'S SCHEDULE (ARCHITECTURE.md § Scheduled threads). There is no schedule button and no mode: the box
// works out from the words whether Enter should start the thread or create a schedule. A prompt with a schedule
// word in it ("every", "weekdays", "morning", a weekday's name — packages/shared/src/schedule-trigger.ts) is read
// by the model as it is typed (lib/scheduleReadScheduler.ts), and when the model says the words ask for the work
// to repeat, the box says so before Enter:
//
//   every Monday at 9am triage new issues          ← the phrase in the accent mark
//   └ ↻ Every Monday at 9am · next Mon Oct 12, in 6d                      ×   ← the STRIP
//       Each run: triage new issues
//
// and the send button wears ↻: Enter creates that schedule. × (or Esc) says "not a schedule", and Enter starts
// the thread. Text with no schedule word looks exactly as the box always has; words with one that turn out not
// to be a schedule ("fix the bug from this morning") show nothing but a faint mark on the word while the read is
// out. What each submit does is lib/scheduleIntent.ts (`submitAct`, `settleAct`), pure and tested; this file
// executes it. Enter never waits on the model: words it has not read yet leave the box at once, and a toast says
// what they became once their reading lands.

/** What the box hands in. */
export interface LiveScheduleInput {
  /** The draft's schedule key (`draftKey.dispatchSchedule`, lib/scheduleDraftState.ts): a sibling of the prompt's
   *  own, so the dismissal lives and dies with the draft, and every box on the draft reads one value. */
  draftKey: string
  /** The prose the box SHOWS (no attachment lines) — what every span indexes. */
  prose: string
  /** Runs never read for a schedule word: code, staged context tokens, mentions, commands (Composer
   *  `composerExcludeRuns`). */
  exclude: readonly Span[]
  /** The prompt a schedule would save for a CUT prose — chips serialized, user commands expanded, attachments
   *  rejoined, and never the editor block. "" when nothing is left. */
  promptOf: (cutProse: string) => string
  /** The model/effort the box would dispatch on. Undefined while the profile is loading. */
  profile: { model: string; backend: CreateScheduleInput["backend"]; effort: CreateScheduleInput["effort"] } | undefined
  /** A file is uploading into the draft: Enter waits for it. */
  uploading?: boolean
  /** Start the thread now: the box's own dispatch, exactly as it is without schedules. */
  startNow: () => void
  /** Submit words not read yet: take the draft out of the box NOW and hand back what it can become once the reading
   *  lands. Undefined when the box refused the submit (and said why), with the draft left as it was. */
  detach: () => DetachedDraft | undefined
  /** The draft became a schedule: take it out of the box (`submittedProse` is what was read; anything typed
   *  after it stays). Returns how to put it back, for Undo. The one handed in at the Enter that created it is
   *  the one called, so the words leave the draft they were created from even if the box has since been
   *  aimed at another project. */
  onCreated: (submittedProse: string) => () => void
  /** Focus the box (this one, or the page's when this one is gone), caret at the end. */
  focus: () => void
}

/** A submitted draft whose reading has not landed: everything it needs to become a thread or a schedule, captured
 *  at the Enter, so neither depends on the box — which may hold other words, or be gone, by then. */
export interface DetachedDraft {
  /** Start it as a thread; `note` rides on its toast. */
  dispatch: (note?: string) => void
  /** The prompt a schedule would save for the CUT prose, as `LiveScheduleInput.promptOf`, over the captured draft. */
  promptOf: (cutProse: string) => string
  /** Put the draft back into the box (merged with anything typed since): an Undo. */
  restore: () => void
}

export interface LiveSchedule {
  marks: ComposerMark[]
  /** The strip under the box, kept a moment while it folds away; `slotOpen` is whether one is showing now. */
  slot: ReactNode | null
  slotOpen: boolean
  /** A polite live-region line when the strip appears or changes what it says. */
  announcement: string
  /** What Enter does, on the button that does it: ↻ while Enter creates a schedule. */
  sendGlyph: "send" | "schedule"
  sendTitle: string | undefined
  /** A create is in flight: the button spins, the text stays live. */
  sendPending: boolean
  /** Enter, the send button, the phone's send. */
  submit: () => void
  /** Esc in the box: takes the strip away ("not a schedule"). False when it did nothing. */
  onEscape: () => boolean
  onInputEvent: (e: BoxInputEvent) => void
}

// ---- copy -------------------------------------------------------------------------------------------------------

export const CHECKING_COPY = "Checking for a schedule…"
export const UNDONE_COPY = "Schedule undone."
/** What every line that is not a schedule ends with: what Enter does now. A phone names its send button. */
export const startsNow = (phone: boolean) => (phone ? "Send starts it now." : "Enter starts it now.")
/** The interpreter's title when the model gave none (schedule-interpreter.ts): such a schedule is created with
 *  the box's provisional title and `titleAuto`, so the thread namer names it. */
const UNNAMED_TITLE = "Scheduled run"

// ---- timing -----------------------------------------------------------------------------------------------------

/** A reading still on screen while the next is read shimmers only after this long, so a fast answer never
 *  flickers it. */
const UPDATING_DELAY_MS = 250
/** The accent mark's wash, bright and back, before the box clears. */
const WASH_MS = 220
/** How long a strip that went away stays mounted while its slot folds. */
const SLOT_LINGER_MS = 160
/** The created toast's life: the Undo window. */
const UNDO_WINDOW_MS = 8_000

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const firstLine = (s: string) => s.split("\n")[0] ?? ""

/** A reading the box cannot put on screen or save becomes a refusal: a rule with no words for it (never ask the
 *  human to confirm RRULE text), or nothing left to run once the phrase is cut. */
export function vetter(prose: string, readText: string, promptOf: (cut: string) => string) {
  return (r: ModelReadOk): string | undefined => {
    if (unphrasableRule(r.rrule, r.dtstart, r.tz)) return UNPHRASABLE_COPY
    const span = phraseSpan(prose, readText, r)
    if (!span || !promptOf(cutPhrase(prose, span))) return NO_TASK_COPY
    return undefined
  }
}

type CreateJob = {
  input: CreateScheduleInput
  prose: string
  phrase: string
  startedAt: number
  draftKey: string
  onCreated: LiveScheduleInput["onCreated"]
  landed: () => void
  /** A detached draft's words are no longer in the box: a failed create puts them back. */
  onFailed?: () => void
}

/** Where a create's words come from: the box as it is now, or a draft that left the box at its Enter. */
type CreateSource = Pick<LiveScheduleInput, "prose" | "promptOf" | "profile" | "draftKey" | "onCreated"> & { detached?: DetachedDraft }

export function useLiveSchedule(input: LiveScheduleInput): LiveSchedule {
  const { draftKey, prose, exclude, promptOf } = input
  const queryClient = useQueryClient()
  const [draft, setDraft] = useScheduleDraftState(draftKey)
  const tz = browserZone()
  const nowMs = useNowMs()
  // THE PHONE: the same rules; its strip is a tap row whose × has a 32px hit square, and its lines name the
  // send button rather than a key.
  const phone = useIsMobile()
  const latest = useRef(input)
  latest.current = input

  // ONE reader per draft, not per box: the `c` dialog and the page box under it share its single flight, its
  // budget and its answers.
  const reader = useModelReader({
    interpret: (text) => rpc.interpretSchedule({ text, tz }),
    keyOf: (text, at) => modelReadKey({ tz, nowMs: at, text }),
  }, { share: draftKey })
  const readerRef = useRef(reader)
  readerRef.current = reader

  const text = readTextOf(prose)
  const trigger = text !== "" && hasScheduleTrigger(prose, exclude)
  const view = reader.view(text)
  const viewResult = view.status === "answered" ? view.result : undefined
  const known: ScheduleKnown = useMemo(
    () => knownOf(view, vetter(prose, text, promptOf)),
    // `view` is a fresh object per call; what it says is its status and the answer it carries.
    [view.status, viewResult, prose],
  )

  // THE NEWEST ANSWER KNOWN BEFORE THIS TEXT'S stays on screen while this text is read (stale-while-revalidate,
  // lib/scheduleModelRead.ts `useNewestAnswer`), vetted against the words it was read from — or this text's own,
  // once it has expired, while it is read again.
  const newest = useNewestAnswer(reader, text)
  const stale = newest && !newest.current
    ? { text: newest.text, answer: classifyResult(newest.result, vetter(newest.text, newest.text, promptOf)) }
    : undefined

  // ---- when to ask ------------------------------------------------------------------------------------------

  const scheduler = useRef<ReadScheduler | null>(null)
  scheduler.current ??= createReadScheduler({
    request: (p) => readerRef.current.request(readTextOf(p)),
    cancel: () => readerRef.current.cancelQueued(),
    wanted: (p) => {
      const l = latest.current
      return readTextOf(p) !== "" && hasScheduleTrigger(p, p === l.prose ? l.exclude : [])
    },
  })
  useEffect(() => () => scheduler.current?.dispose(), [])
  const pendingInput = useRef<Extract<BoxInputEvent, { type: "edit" }> | null>(null)
  const seen = useRef<string | null>(null)
  useEffect(() => {
    const before = seen.current
    seen.current = prose
    if (before === prose) return
    const meta = pendingInput.current
    pendingInput.current = null
    // This box's own edit, as its textarea reported it; anything else (a mount with text in the box, another box
    // on the draft, an Undo, a re-aim) is someone else's change, which waits for the idle.
    const how: ChangeKind = before !== null && meta && meta.prose === prose
      ? meta.composing ? "composing" : classifyEdit(before, prose, meta.caret, meta.inputType)
      : "external"
    scheduler.current!.changed(prose, how)
    // An empty box is a new draft: its budget refills, and nothing read before it stays on screen.
    if (!prose.trim()) readerRef.current.reset()
  }, [prose])
  // AN ANSWER THAT EXPIRED under unchanged words (the 10m cache, or a new local day) is read again: the box only
  // asks when the words change, so nothing else would — and the reading stays on screen, updating, meanwhile.
  useEffect(() => {
    if (trigger && view.status === "expired") readerRef.current.request(text)
  }, [trigger, view.status, text])

  // ---- the dismissal ----------------------------------------------------------------------------------------

  const record = draft.dismissed ? { phrase: draft.dismissed, ...(draft.pending ? { pending: true } : {}) } : undefined
  // The phrase "not a schedule" holds for now (scheduleIntent.ts `dismissedPhrase`): its own, or — said over the
  // reading of earlier words — the reading of the words on screen.
  const dismissed = dismissedPhrase(record, known, stale?.answer)
  // "Not a schedule" holds until the phrase it was said about is gone: no schedule word is left, or the model
  // reads a different phrase out of the words, or none. Written back, so editing back to the old phrase reads it
  // afresh. A pending one is fixed to its words' reading the moment it lands.
  useEffect(() => {
    const next = nextDismissal({ trigger, known, dismissal: record })
    if (next === "lift") setDraft(SCHEDULE_DRAFT_NONE)
    else if (next !== "keep") setDraft((prev) => ({ v: 2, dismissed: next.adopt, ...(prev.undone ? { undone: true as const } : {}) }))
  }, [trigger, known, draft.dismissed, draft.pending])
  /** "Not a schedule", said over the strip on screen: of its phrase when it is these words' reading, else PENDING
   *  these words' own reading (they are what the human was looking at). */
  const dismiss = (on: Extract<StripView, { kind: "schedule" }>) =>
    setDraft({ v: 2, dismissed: on.result.phrase, ...(on.fresh ? {} : { pending: true as const }) })

  // ---- create ---------------------------------------------------------------------------------------------------

  // A create in flight HOLDS ITS DRAFT (lib/scheduleDraftState.ts) from Enter until its words leave the box: the
  // draft does not move to another project meanwhile, Undo of the last schedule waits for it, and every box on the
  // draft reads as creating. The job carries what it was created from (the draft, its `onCreated`) because the box
  // that pressed Enter may be gone or re-aimed by the time it lands: react-query still runs these callbacks after an
  // unmount.
  const [committing, setCommitting] = useState(false)
  const create = useMutation({
    mutationFn: (job: CreateJob) => rpc.createSchedule(job.input),
    onSuccess: (created: ScheduleView, job) => {
      setCommitting(true)
      // The mark washes bright and back first, then the box clears and the strip folds as the text leaves — the
      // words read as having become the schedule.
      setTimeout(() => {
        try {
          setCommitting(false)
          const restore = job.onCreated(job.prose)
          invalidateSchedules(queryClient)
          flashScheduleCount(created.projectId)
          showToast(`${created.title} scheduled`, {
            detail: toastDetail(created, Date.now()),
            actions: [
              { label: "Undo", run: () => undo(created, restore, job) },
              { label: "Open", run: () => pushScheduleDrawer(created.id, created.projectId) },
            ],
            duration: UNDO_WINDOW_MS,
          })
        } finally {
          job.landed()
        }
      }, Math.max(0, WASH_MS - (Date.now() - job.startedAt)))
    },
    onError: (error, job) => {
      job.landed()
      job.onFailed?.()
      showToast(`Could not create the schedule: ${(error as Error).message.slice(0, 100)}`)
    },
  })
  const draftCreating = useDraftCreating(draftKey)
  const creating = committing || draftCreating
  const creatingRef = useRef(creating)
  creatingRef.current = creating

  /** Undo: delete the schedule, put the words back — merged with anything typed since, the chips, the pick — and
   *  DISMISS the reading, so Enter now starts the thread; the strip says so, with Schedule it to take it back.
   *  Into the draft the schedule was created from — after a re-aim that is not the box on screen — and only once
   *  no create on that draft is in flight, so the next schedule's words leave first and only the undone ones come
   *  back. */
  const undo = (created: ScheduleView, restore: () => void, job: Pick<CreateJob, "draftKey" | "phrase">) => {
    void projectRpc(created.projectId).deleteSchedule({ id: created.id }).then(
      async () => {
        invalidateSchedules(queryClient, created.id)
        await afterDraftCreates(job.draftKey)
        restore()
        writeScheduleDraftState(job.draftKey, { v: 2, dismissed: job.phrase, undone: true })
        latest.current.focus()
      },
      (error: unknown) => showToast(`Could not undo: ${(error as Error).message.slice(0, 100)}`),
    )
  }

  /** Create `result`, read from exactly `src.prose` (the submit never hands it another reading). */
  const commit = (result: ModelReadOk, src: CreateSource = latest.current) => {
    if (!src.profile || (!src.detached && creatingRef.current)) return false
    const words = src.prose
    const span = phraseSpan(words, readTextOf(words), result)
    const prompt = span ? src.promptOf(cutPhrase(words, span)) : ""
    if (!prompt) return false
    const named = result.title.trim() !== "" && result.title !== UNNAMED_TITLE
    const detached = src.detached
    create.mutate({
      prose: words,
      phrase: result.phrase,
      // A detached draft has left the box already: no wash, nothing for the box to wait on.
      startedAt: detached ? 0 : Date.now(),
      draftKey: src.draftKey,
      onCreated: src.onCreated,
      landed: detached ? () => {} : beginDraftCreate(src.draftKey),
      ...(detached ? { onFailed: detached.restore } : {}),
      input: {
        // The model's title when it gave one; else the box's provisional title, which the namer replaces.
        title: named ? result.title : provisionalScheduleTitle(prompt),
        ...(named ? {} : { titleAuto: true as const }),
        prompt,
        whenText: result.whenText,
        rrule: result.rrule,
        dtstart: result.dtstart,
        tz: result.tz,
        ...(result.condition ? { condition: result.condition } : {}),
        model: src.profile.model,
        ...(src.profile.backend ? { backend: src.profile.backend } : {}),
        ...(src.profile.effort ? { effort: src.profile.effort } : {}),
      },
    })
    return true
  }

  // ---- submit -----------------------------------------------------------------------------------------------

  // Enter dispatches, creates, or — for words the model has not answered yet — DEFERS (lib/scheduleIntent.ts
  // `submitAct`): the words leave the box at once (`detach`), and their reading, when it lands, settles them
  // (`settleAct`): a schedule is created and its toast says what was detected, anything else starts the thread.
  // Until 2026-10-07 that Enter HELD in the box, spinning, until the answer landed (up to 15s).
  const facts = { trigger, known, dismissed }
  const factsRef = useRef(facts)
  factsRef.current = facts

  const defer = () => {
    const now = latest.current
    const words = now.prose
    const readText = readTextOf(words)
    // "Not a schedule" said before Enter covers what lands — a pending one, whatever lands (`dismissalCovers`).
    const covers = dismissalCovers(record)
    const reader = readerRef.current
    const detached = now.detach()
    if (!detached) return
    showToast(CHECKING_COPY, { spinner: true, sticky: true })
    const src: CreateSource = { prose: words, promptOf: detached.promptOf, profile: now.profile, draftKey: now.draftKey, onCreated: () => detached.restore, detached }
    void awaitReading(reader, readText).then((view) => {
      const answer = view.status === "answered"
        ? classifyResult(view.result, vetter(words, readText, detached.promptOf))
        : { kind: "failed" as const }
      const act = settleAct(answer, covers)
      if (act.act === "create" && commit(act.result, src)) return
      detached.dispatch(act.act === "dispatch" ? act.note : undefined)
    })
  }

  const submit = () => {
    if (creatingRef.current || latest.current.uploading) return
    const act = submitAct(factsRef.current)
    if (act.act === "dispatch") latest.current.startNow()
    else if (act.act === "create") commit(act.result)
    else defer()
  }

  // ---- what the box draws -------------------------------------------------------------------------------------

  const strip = stripView({
    trigger,
    text,
    known,
    reading: view.status === "reading",
    stale,
    dismissed: dismissed ? { phrase: dismissed, undone: draft.undone === true } : undefined,
  })
  // How it is drawn (scheduleIntent.ts `stripLook`): a reading of other words is UPDATING — shimmering, with ↻,
  // while the read for these words is out or due (once the typing rests, or again, expired); faint and still,
  // with a plain send, when no read is coming (the budget spent, the read failed): Enter checks first.
  const look = stripLook(strip, view.status === "reading" || view.status === "none" || view.status === "expired")
  const onEscape = () => {
    if (strip.kind === "schedule" && !creating) {
      dismiss(strip)
      return true
    }
    return false
  }

  const marks: ComposerMark[] = []
  if (strip.kind === "schedule") {
    const span = phraseSpan(prose, strip.readText, strip.result)
    if (span) marks.push({ ...span, tone: creating ? "wash" : "accepted", key: `p:${span.start}` })
  } else if (strip.kind === "pending") {
    // The faint cue: a read of these words is out. It fades in late (styles.css), so a quick answer never shows it.
    for (const s of scheduleTriggerSpans(prose, exclude)) marks.push({ start: s.start, end: s.end, tone: "pending", key: `t:${s.start}` })
  }

  let line: { kind: string; node: ReactNode; announce: string } | null = null
  if (strip.kind === "schedule") {
    const each = eachRun(prose, strip.readText, strip.result, promptOf)
    const describe = describeRule(strip.result.rrule, strip.result.dtstart, strip.result.tz)
    line = {
      kind: "schedule",
      announce: `${phone ? "Send" : "Enter"} schedules this: ${describe}.${phone ? "" : " Esc if it is not a schedule."}`,
      node: (
        <ScheduleSlot
          kind="schedule"
          phone={phone}
          updating={look.updating}
          line={<StripLine result={strip.result} nowMs={nowMs} tz={tz} phone={phone} updating={look.revalidating} stale={look.updating && !look.revalidating} onClose={creating ? undefined : () => dismiss(strip)} />}
          body={each ? <EachRunLine each={each} /> : undefined}
        />
      ),
    }
  } else if (strip.kind === "refused") {
    const copy = `${strip.copy} ${startsNow(phone)}`
    line = { kind: "refused", announce: copy, node: <ScheduleSlot kind="refused" phone={phone} line={<CopyLine copy={copy} />} /> }
  } else if (strip.kind === "undone") {
    const copy = `${UNDONE_COPY} ${startsNow(phone)}`
    line = {
      kind: "undone",
      announce: copy,
      node: <ScheduleSlot kind="undone" phone={phone} line={<CopyLine copy={copy} action={{ label: "Schedule it", run: () => setDraft(SCHEDULE_DRAFT_NONE) }} />} />,
    }
  }

  // One polite line when the strip appears or says something else — once per schedule shown, not per update.
  const [announcement, setAnnouncement] = useState("")
  const said = line?.announce ?? ""
  const announceKey = line ? (line.kind === "schedule" ? "schedule" : `${line.kind}:${said}`) : ""
  useEffect(() => {
    if (said) setAnnouncement(said)
  }, [announceKey])

  const current = line?.node ?? null
  const slot = useLinger(current, SLOT_LINGER_MS)
  const schedules = look.scheduleGlyph
  return {
    marks,
    slot,
    slotOpen: current !== null,
    announcement,
    sendGlyph: schedules ? "schedule" : "send",
    sendTitle: creating ? "Creating the schedule…" : schedules ? (phone ? "Create schedule" : "Create schedule (Enter)") : undefined,
    sendPending: creating,
    submit,
    onEscape,
    onInputEvent: (e) => {
      if (e.type === "edit") {
        pendingInput.current = e
        return
      }
      // A composition's commit is a wholesale change: the words it typed are whole.
      if (e.type === "compositionend") scheduler.current!.changed(e.prose, "wholesale")
    },
  }
}

/** The first line of what each run would be sent: the prompt with the phrase cut out, from the prose as it is
 *  now (the phrase found in it, for a reading of an earlier text), else from the words the model read. */
export function eachRun(prose: string, readText: string, result: ModelReadOk, promptOf: (cut: string) => string): string {
  const span = phraseSpan(prose, readText, result)
  const prompt = span ? promptOf(cutPhrase(prose, span)) : promptOf(cutPhrase(readText, { start: result.phraseStart, end: result.phraseEnd }))
  return firstLine(prompt)
}

export function toastDetail(view: ScheduleView, nowMs: number): string | undefined {
  const describe = capitalize(view.describe)
  const first = view.upcoming[0]
  if (!first) return describe
  const span = spanUntil(first, nowMs)
  if (Date.parse(first) - nowMs < SOON_MS) return span ? `${describe} · first run in ${span}` : describe
  const day = view.nextLine.replace(/^Next: /, "").split(" · ")[0]
  return `${describe} · next ${day}${span ? `, in ${span}` : ""}`
}

/** A value that went away, kept for `ms` so what showed it can fold rather than vanish. */
function useLinger<T>(value: T | null, ms: number): T | null {
  const kept = useRef<T | null>(value)
  const [, bump] = useState(0)
  if (value !== null) kept.current = value
  const gone = value === null
  useEffect(() => {
    if (!gone) return
    const t = setTimeout(() => {
      kept.current = null
      bump((n) => n + 1)
    }, ms)
    return () => clearTimeout(t)
  }, [gone, ms])
  return value ?? kept.current
}

/** True once `on` has held for `ms` — a wait long enough to be worth showing. */
function useDelayedTrue(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) {
      setLate(false)
      return
    }
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && late
}

// ---- the strip ------------------------------------------------------------------------------------------------

/**
 * THE STRIP'S RHYTHM, in one place. `gap` spaces boxes and the eye spaces ink, so every mark's box is collapsed
 * onto its own ink (iconRhythm.ts's method) and the gaps below are the distances the eye reads. Dead space is
 * GEOMETRY, not a fit: a lucide glyph's stroke (2 units) reaches 1 unit past its outermost path, so `Repeat`
 * (paths x 3–21) leaves 2 of 24 units a side and `X` (x 6–18) leaves 5.
 *
 * Measured with scripts/ink-gaps.mjs (pixels, dsf 6, 12px sans) on schedule-live-fixture's ledge, at 1440 (514px
 * wide) and on the phone's tap row at 360 (290px), 2026-10-06 — the same at both widths:
 *   border → ↻ 10.83 (the left inset)    ↻ → reading 8.00    × → border 10.83 (the left inset)
 *   `Each run:` starts 0.00px off the reading's first letter; ↻ and × centre 0.13px under the cap band (geometry,
 *   sub-pixel: left alone).
 * Before the trims, the glyph floated halfway between the border and its words (9.67 to them) and the × hung
 * 6.5px further out than the gap it shared: 4px of button padding plus 2.5px of its viewBox.
 */
const GLYPH_TO_TEXT_TRIM = "-mr-0.5" // ↻: gap-2 (8) + 1px of viewBox − 2, + the first letter's side bearing = 8.00
const BODY_INSET = "pl-[28px]" // px-2.5 + the 12px glyph + gap-2 − 2: the body's rows start under the reading
const CLOSE_TRIM = "-ml-[6.5px] -mr-[5.5px]" // ×: 4px padding + 2.5px of viewBox in, and out to the left inset
// THE PHONE'S TAP ROW (StripLine on a phone), the same law: the × is a 32px hit square (10px a side around its
// 12px box, plus 2.5px of viewBox), collapsed onto its ink at both ends, and 4px of it taken off the LAYOUT top
// and bottom (`-my-1`), so the 20px line, not the invisible square, sets the row's height.
const TAP_CLOSE_TRIM = "-ml-[8.5px] -mr-[11.5px]" // reading → ×: gap-2 + 12.5 − 8.5 = 12; × → border: 12.5 + 10 − 11.5 = 11

/** The strip's glyph, on its line's cap band (the house lift: the box's bottom on the baseline, then half the
 *  box less half the cap height). `cap` resolves against the line's own font. */
function SlotGlyph() {
  return (
    <span aria-hidden className={`flex shrink-0 self-baseline translate-y-[calc(6px_-_0.5cap)] text-muted ${GLYPH_TO_TEXT_TRIM}`}>
      <Repeat size={12} strokeWidth={2} />
    </span>
  )
}

/**
 * The hanging strip under the box: inset 10px a side and pulled up under the box's bottom edge, with no top border
 * of its own — the box's bottom border is its top — so it reads as a tab hanging off the box, not a new card. One
 * 28px line, and for a schedule a second, `Each run`, under the reading. One element whatever it says, so a reading
 * that updates does so IN PLACE.
 */
function ScheduleSlot({ kind, phone, line, body, updating = false }: { kind: string; phone: boolean; line: ReactNode; body?: ReactNode; updating?: boolean }) {
  return (
    <div
      data-schedule-slot={kind}
      data-schedule-updating={updating || undefined}
      className="sched-ledge-in mx-2.5 rounded-b-lg border border-t-0 border-border bg-panel-2/60"
    >
      {/* The phone's line never wraps: its reading gives way (StripLine) and its × keeps its size. The desktop's
          line wraps an action under copy too long to sit beside it. */}
      <div data-schedule-line className={`flex min-w-0 items-baseline gap-x-2 px-2.5 text-[12px] leading-5 text-muted ${body ? "pt-1" : "py-1"} ${phone ? "flex-nowrap" : "flex-wrap"}`}>
        <SlotGlyph />
        {line}
      </div>
      {body && <div className={`flex flex-col pb-1 ${BODY_INSET} pr-2.5`}>{body}</div>}
    </div>
  )
}

/** What a reading says on the strip: the rule (its zone, its condition), the next day it runs and how far off
 *  that is — the parts that give way first when the row is narrow. */
function readingParts(result: ModelReadOk, nowMs: number, tz: string): { reading: ReactNode; title: string; next?: string; span: string | null; soon: boolean } | null {
  const model = schedulePreviewModel({ title: result.title, rrule: result.rrule, dtstart: result.dtstart, tz: result.tz, condition: result.condition ?? null }, nowMs, tz)
  if (!model.ok) return null
  const words = `${capitalize(model.describe)}${model.zone}${model.tail.map((t) => ` · ${t}`).join("")}`
  return {
    reading: words,
    title: words,
    ...(model.next[0] ? { next: model.next[0] } : {}),
    span: model.firstAt ? spanUntil(model.firstAt, nowMs) : null,
    soon: model.firstAt !== undefined && Date.parse(model.firstAt) - nowMs < SOON_MS,
  }
}

/**
 * The schedule's line: `↻ Every Monday at 9am · next Mon Oct 12, in 6d   ×`.
 *
 * THE NARROWING ORDER on a desktop is `, in 6d` first, then `· next Mon Oct 12`, and only then does the rule
 * itself ellipsize — as a one-line WRAPPING row clipped to its first line: a segment that no longer fits wraps
 * onto the clipped second line and is gone whole, everything after it with it, and the rule, alone on the line,
 * shrinks and truncates. A fixed container width cannot do this (readings differ in length): the All-projects
 * column at 1440px showed `Every Monday at 9am · next Mon Oct…` under a 400px rule, a date cut in half.
 *
 * ON A PHONE the order is `next {day}` first, then `in 6d`, then an ellipsis on the rule — the reverse of the order
 * they read in for the first step, which the wrapping trick (it always drops the LAST segment) cannot do. The row
 * measures instead: the rule and the two tails it could wear are laid out invisibly beside it, and it shows the
 * longest that fits. A ResizeObserver re-fits it as the sheet turns.
 *
 * `updating`: a newer read of the words is out, and this is the last one's answer — it shimmers until the new one
 * lands, which replaces it in place, or takes the strip away. `stale`: it is the answer for other words and no
 * read is coming for these (the budget spent, the read failed) — drawn faint and still, never as these words'.
 */
function StripLine({ result, nowMs, tz, phone, updating, stale, onClose }: {
  result: ModelReadOk
  nowMs: number
  tz: string
  phone: boolean
  updating: boolean
  stale: boolean
  onClose: (() => void) | undefined
}) {
  const parts = readingParts(result, nowMs, tz)
  const shimmer = useDelayedTrue(updating, UPDATING_DELAY_MS)
  const tone = shimmer ? "shimmer-text" : stale ? "text-muted-70" : ""
  // The tails, longest first: `· next Mon Oct 12, in 6d`, then `· in 6d` (the phone's choice of what to keep).
  const spanTone = parts?.soon && !stale ? "text-attention" : ""
  const tails: ReactNode[] = []
  if (parts?.next) tails.push(<>{` · next ${parts.next}`}{parts.span && <span className={spanTone}>{`, in ${parts.span}`}</span>}</>)
  if (parts?.next && parts.span) tails.push(<span className={spanTone}>{` · in ${parts.span}`}</span>)
  const fit = useTailFit(phone ? tails.length : 0)
  const close = onClose && <DismissButton phone={phone} title="Not a schedule (Esc)" onClick={onClose} />
  if (!parts) return <span data-schedule-reading className="min-w-0 flex-1 truncate">{describeRule(result.rrule, result.dtstart, result.tz)}</span>
  if (phone) {
    const tail = fit.index < tails.length ? tails[fit.index] : null
    return (
      <>
        <span ref={fit.box} data-schedule-reading title={parts.title} className={`relative flex min-w-0 flex-1 overflow-hidden whitespace-nowrap ${tone}`}>
          <span className="min-w-0 truncate">{parts.reading}</span>
          {tail && <span data-schedule-tail className="shrink-0">{tail}</span>}
          <span aria-hidden className="invisible absolute left-0 top-0 whitespace-nowrap">
            <span ref={fit.rule}>{parts.reading}</span>
            {tails.map((t, i) => <span key={i} ref={(el) => void (fit.tails.current[i] = el)}>{t}</span>)}
          </span>
        </span>
        {close}
      </>
    )
  }
  return (
    <>
      <span data-schedule-reading title={parts.title} className={`flex h-5 min-w-36 flex-1 basis-0 flex-wrap overflow-hidden ${tone}`}>
        <span className="min-w-0 truncate">{parts.reading}</span>
        {parts.next && <span data-schedule-next className="shrink-0 whitespace-nowrap">{` · next ${parts.next}`}</span>}
        {parts.next && parts.span && <span data-schedule-span className={`shrink-0 whitespace-nowrap ${shimmer ? "" : spanTone}`}>{`, in ${parts.span}`}</span>}
      </span>
      {close}
    </>
  )
}

/** The strip's ×: "not a schedule". The phone's has a 32px hit square. */
function DismissButton({ phone, title, onClick }: { phone: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-schedule-dismiss
      aria-label="Not a schedule"
      title={phone ? undefined : title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={phone
        ? `${TAP_CLOSE_TRIM} -my-1 flex size-8 shrink-0 translate-y-[calc(6px_-_0.5cap)] items-center justify-center self-baseline rounded-md text-muted outline-none active:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`
        : `${CLOSE_TRIM} ml-auto flex size-5 shrink-0 translate-y-[calc(6px_-_0.5cap)] items-center justify-center self-baseline rounded-sm text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
    >
      <X size={12} strokeWidth={2} />
    </button>
  )
}

/** Which of `count` tails (longest first) fits beside the rule: the index of the first that does, or `count`
 *  for none. Measured from invisible copies laid out beside the row (StripLine on a phone). */
function useTailFit(count: number) {
  const box = useRef<HTMLSpanElement>(null)
  const rule = useRef<HTMLSpanElement>(null)
  const tails = useRef<(HTMLSpanElement | null)[]>([])
  const [index, setIndex] = useState(0)
  const measure = () => {
    const el = box.current
    if (!el || !rule.current) return
    const room = el.getBoundingClientRect().width
    const ruleW = rule.current.getBoundingClientRect().width
    let i = 0
    // Half a pixel of slack: subpixel layout rounds the two sides differently.
    while (i < count && ruleW + (tails.current[i]?.getBoundingClientRect().width ?? Infinity) > room + 0.5) i++
    setIndex(i)
  }
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [count > 0])
  return { box, rule, tails, index }
}

function EachRunLine({ each }: { each: string }) {
  return (
    <p data-schedule-each title={each} className="truncate text-[12px] leading-5 text-muted">
      <span className="text-muted-70">Each run:</span> {each}
    </p>
  )
}

/** A line of copy — what is true and what Enter does now — with at most one action at its right. It wraps
 *  rather than lose the part that says what to do; the action wraps under it, right-aligned, when it cannot
 *  sit beside it. */
function CopyLine({ copy, action }: { copy: string; action?: { label: string; run: () => void } }) {
  return (
    <>
      <span data-schedule-copy className="min-w-36 flex-1 basis-0 text-pretty">{copy}</span>
      {action && (
        <button
          type="button"
          data-schedule-action={action.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={action.run}
          className="ml-auto shrink-0 rounded-sm text-fg/80 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {action.label}
        </button>
      )}
    </>
  )
}
