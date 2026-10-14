import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Timer } from "lucide-react"
import { parseDeadlineInput, type ThreadDeadlineView, type ThreadView } from "@ntwine/shared"
import { useThreadApi } from "../api/threadApi.tsx"
import { showToast } from "../store.ts"
import { useDraft } from "../lib/drafts.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { useNowMs } from "../lib/liveClock.ts"
import {
  DEADLINE_TONE_CLASS,
  DISPATCH_LIMIT_PRESETS,
  EXTEND_PRESETS,
  deadlineEndsLabel,
  deadlineReading,
  deadlineTitle,
  deadlineTone,
  extendedDeadlineMs,
  limitPreview,
  useDeadlineNow,
} from "../lib/threadDeadline.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// A THREAD'S TIME LIMIT IN THE BROWSER (ARCHITECTURE.md § Time limits): the prompt box's control, the
// countdown on the facts line (queue card and drawer) and on the rail row, and the drawer's extend / set /
// remove. The grammar, the reading and the tones are lib/threadDeadline.ts; this file only draws them.
//
// THE CLOCK GLYPH is lucide's Timer — a stopwatch, which no other mark in the app uses (the alarm clock is a
// snooze or a timer wake, the hourglass a wait, Clock a one-off timer row). How it sits on the reading's cap
// band, and what that was measured at, is DeadlineGlyph below.

/**
 * The stopwatch beside a deadline reading, its DIAL on the reading's cap band. The eye reads the dial, not the
 * crown above it — as it reads the rail bot's face rather than its antenna (Sidebar.tsx SubAgentCount) — so the
 * term is the dial's centre, 10/24 of the box above its bottom (the circle sits at y 14 of lucide's 24), rather
 * than the box's centre a symmetric glyph would use. `self-baseline` stands the 1em box on the baseline; the
 * translate lifts the dial's centre to half the cap height, in any font at any size.
 *
 * WHOLE PIXELS, AND THE TRANSLATE ON A WRAPPER — the rail bot's structure. A `1em` box at the rail's 10.5px
 * rasterized ~0.5px lower than its own layout box said (every row, dsf 2–8): Chrome draws an svg at a
 * fractional size off the box it lays out. At a whole-pixel `size` the paint matches the geometry. So the box
 * is `size` px and the dial term `size × 10/24` px, computed here rather than written per call site.
 *
 * TRIMMED TOWARD ITS INK SIDEWAYS. The dial's stroke spans x 3–21 of 24, so 3/24 of the box is dead on each
 * side: on the facts line's `gap-1` the stopwatch stood 6.0px of ink from its reading where the band stamp's
 * bot stands 4.5px from WORKING, and 8.5px from its separator where text stands 7.5px. The trim is a WHOLE
 * pixel (`trim="both"` on the facts line; `"end"` on the rail, whose left is a ragged title) and the rest is
 * taken in the gap to the TEXT: a fractional margin moves the svg off the pixel grid, and its ink then snaps
 * by up to ~0.75px — the first try, a 1.375px trim, read 3.87px where 4.63px was due.
 *
 * READINGS, deadline-fixture, sans (DejaVu Sans, Linux), 2026-10-06. Vertical, by PIXEL ink of the dial against
 * the reading's ink (dsf 4; NEGATIVE = dial low): whole-glyph centring −1.05 (rail) / −1.41px (facts); dial
 * term on the svg itself, 1em box: rail −0.50; this structure: rail −0.12…0.00, facts −0.12 (one device pixel
 * at dsf 4; dsf 8: −0.12…+0.06). Horizontal, `scripts/ink-gaps.mjs` dsf 4: facts separator→glyph 8.5 → 7.5
 * (text: 7.5), glyph→reading 6.0 → 4.5 (the band stamp's bot→WORKING: 4.5); rail glyph→reading 4.75 → 4.0 (the
 * sub-agent count's bot→digit: 4.0). In the facts line's urgent slot the same marks read 7.0 / 4.0 — the svg's
 * subpixel x lands differently there. Re-measure rather than re-guess if the glyph, a size or a gap changes;
 * a canvas cap height taken AT 11px is hinted to a whole 9px (8.08 measured at 1100px), which alone fakes a
 * 0.46px error.
 */
function DeadlineGlyph({ size, trim, className = "" }: { size: number; trim: "both" | "end"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 self-baseline ${trim === "both" ? "-mx-px" : "-mr-px"} ${className}`}
      style={{ translate: `0 calc(${+(size * 10 / 24).toFixed(3)}px - 0.5cap)` }}
    >
      <Timer data-deadline-glyph size={size} />
    </span>
  )
}

// ---- THE PANEL: presets, a typed limit with its preview, and a way back to none ------------------------

type Preset = { label: string; title?: string; pick: () => void; current?: boolean }

/**
 * The one editor every door opens: the prompt box's limit, the drawer chip's extend / set / remove, the ⋯
 * menu's "Time limit…" on a thread with none. A row of presets, then a field in the shared grammar with a
 * live "Ends 5:12 PM" under it, then — when there is one — the way back to no limit.
 */
export function TimeLimitPanel({
  heading,
  presets,
  presetsLabel,
  initialText = "",
  onSubmitText,
  clear,
  autoFocus = true,
}: {
  heading: ReactNode
  presets: readonly Preset[]
  presetsLabel: string
  initialText?: string
  /** Called only with text that parses now. */
  onSubmitText: (raw: string) => void
  clear?: { label: string; run: () => void }
  autoFocus?: boolean
}) {
  const [text, setText] = useState(initialText)
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  // The preview reads its own clock: "Ends 5:12 PM" for "2h" moves on while the panel is open.
  const nowMs = useNowMs()
  const preview = limitPreview(text, Math.max(nowMs, Date.now()))
  useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])
  return (
    <div data-time-limit-panel className="flex w-[15.5rem] max-w-full flex-col gap-2 p-2.5 text-[12px]">
      <div data-time-limit-heading className="text-[11px] leading-snug text-muted-70">{heading}</div>
      <div role="group" aria-label={presetsLabel} className="flex flex-wrap gap-1">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            data-time-limit-preset={preset.label}
            title={preset.title}
            aria-pressed={preset.current === undefined ? undefined : preset.current}
            onClick={preset.pick}
            className="rounded-md border border-border/70 px-2 py-0.5 tabular-nums text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 aria-pressed:border-border aria-pressed:bg-panel-2 aria-pressed:text-fg"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (preview?.ok) onSubmitText(text.trim())
        }}
      >
        <label htmlFor={inputId} className="sr-only">Time limit</label>
        <input
          ref={inputRef}
          id={inputId}
          data-time-limit-input
          data-1p-ignore
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="30m, 2h, 15:30…"
          aria-invalid={preview && !preview.ok ? true : undefined}
          aria-describedby={`${inputId}-preview`}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-muted-40 focus:border-accent"
        />
        {/* Empty until something is typed: a blank line under the field read as a gap before Remove. */}
        <p
          id={`${inputId}-preview`}
          data-time-limit-preview={preview ? (preview.ok ? "ok" : "error") : undefined}
          aria-live="polite"
          className={`text-[10.5px] leading-snug empty:hidden ${preview && !preview.ok ? "text-danger" : "text-muted-60"}`}
        >
          {preview?.text}
        </p>
      </form>
      {clear && (
        <button
          type="button"
          data-time-limit-clear
          onClick={clear.run}
          className="-mx-1 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {clear.label}
        </button>
      )}
    </div>
  )
}

// ---- THE PROMPT BOX'S CONTROL ----------------------------------------------------------------------

/**
 * The time limit of the thread the prompt box is about to start, in the box's bottom strip beside the
 * model. It wears the profile pill's resting box (faint border, petite caps, px-2 py-1) so the strip reads
 * as one set of settings for the next thread. With no limit it is the clock alone — a quiet affordance,
 * not an empty field; with one, the clock and what was typed (`2h`, `15:30`).
 *
 * The text lives in the draft (`draftKey.dispatchDeadline`) and is resolved to an instant only at the Enter
 * that starts the thread (NewThreadModal startNow), so it clears with the dispatch and comes back on a
 * failed one, the way the profile pick does.
 */
export function DispatchTimeLimit({ draftKey: key }: { draftKey: string }) {
  const [raw, setRaw, clearRaw] = useDraft(key)
  const [open, setOpen] = useState(false)
  const nowMs = useNowMs()
  const text = raw.trim()
  const preview = limitPreview(text, nowMs)
  const choose = (next: string) => {
    setRaw(next)
    setOpen(false)
  }
  const label = text ? `Time limit ${text}${preview?.ok ? `. ${preview.text}` : ""}` : "No time limit"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-dispatch-time-limit={text ? "set" : "none"}
          aria-label={label}
          title={text ? (preview?.ok ? `Time limit · ${preview.text}` : preview?.text) : "No time limit"}
          // The pill's box exactly: py-1 around one 16px line (prompt-control-type), so it stands as tall as
          // the profile pill beside it whether or not it holds text. Empty, `px-[5px]` makes it a 26px square.
          className={`inline-flex shrink-0 ${text ? "items-baseline gap-1 pt-[5px] pb-[3px]" : "items-center py-1"} rounded-md border border-border/50 bg-transparent text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:border-border data-[state=open]:bg-panel-2 ${text ? "px-2" : "px-[6px]"} ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
        >
          {/* With no limit the stopwatch stands alone, box-centred on the 16px line as the profile pill's chevron
              is. With one it sits beside a READING, and a reading is a duration in the house grammar — `2h`, never
              the small-cap "2H" the strip's petite caps made of it — at the facts line's 11px, so the prompt box
              and the drawer show one value one way. Its dial then rides the reading's cap band exactly as it does
              there (DeadlineGlyph): box-centred beside lowercase ink it sat 1.56px low (pixel ink, dsf 8); this way,
              +0.19px. The pixel moved from bottom padding to top puts the 11px reading on the profile pill's baseline
              (it stood 1.00px above it on `py-1`), and the 26px box is unchanged. 4.75px of ink, dial to reading. */}
          {text ? (
            <>
              <DeadlineGlyph size={12} trim="end" className="-mt-[1em]" />
              <span data-time-limit-text className={`text-[11px] tabular-nums tracking-normal [font-variant-caps:normal] ${preview && !preview.ok ? "text-danger" : ""}`}>{text}</span>
            </>
          ) : (
            <span aria-hidden="true" className="flex h-4 shrink-0 items-center">
              <Timer data-time-limit-glyph size={12} strokeWidth={2} className="text-muted-70" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start">
        <TimeLimitPanel
          // The field below says when the typed limit ends; the heading only names the control.
          heading="Time limit"
          presetsLabel="Time limit presets"
          presets={DISPATCH_LIMIT_PRESETS.map((value) => ({
            label: value,
            title: deadlineEndsLabel(parseOk(value, nowMs), nowMs),
            pick: () => choose(value),
            current: text === value,
          }))}
          initialText={text}
          onSubmitText={choose}
          clear={text ? { label: "No time limit", run: () => { clearRaw(); setOpen(false) } } : undefined}
        />
      </PopoverContent>
    </Popover>
  )
}

function parseOk(raw: string, nowMs: number): number {
  const parsed = parseDeadlineInput(raw, nowMs)
  return parsed.ok ? parsed.atMs : nowMs
}

// ---- THE COUNTDOWN ---------------------------------------------------------------------------------

/** A thread whose limit is worth reading: one set, and not Done — a finished thread's clock is history. */
export function liveDeadline(thread: Pick<ThreadView, "deadline" | "state" | "held">): ThreadDeadlineView | undefined {
  if (!thread.deadline || thread.state === "archived" || thread.held !== undefined) return undefined
  return Number.isFinite(Date.parse(thread.deadline.at)) ? thread.deadline : undefined
}

/**
 * The countdown on a header FACTS LINE (ThreadHeaderFacts — the drawer and the queue card): the stopwatch
 * and `42m left`, in the line's own grey while there is plenty of time, amber in the last stretch, red once
 * over (`over by 8m`). It is the door to the drawer's extend / set / remove: a press opens the panel.
 *
 * TWO SLOTS, BY URGENCY. The facts line drops whatever does not fit from its END, so a reading placed after
 * the time was the first thing a 420px queue card lost — over time included, where it is the one fact that
 * matters (measured 2026-10-06: "Last active 4m ago" alone on a card 9m over). A line places this twice:
 * `slot="urgent"` ahead of the time, drawn only in the last stretch or over; `slot="quiet"` after it, drawn
 * only while there is plenty of time. Exactly one of the two draws at any moment.
 */
// `keepOverrun`: the DRAWER's line keeps the overrun of a thread that has handed off. A limit that ran out is
// still in force — every child the thread dispatches next gets a minute — and this chip is the door to removing
// it; hidden everywhere, the limit read as already removed (2026-10-14: a 5m limit stayed on @precompile-design
// for hours while its sub-agents were each told their time was up). The queue card and the rail stay quiet.
export function DeadlineFact({ thread, lead, slot, keepOverrun }: { thread: ThreadView; lead?: ReactNode; slot: "urgent" | "quiet"; keepOverrun?: boolean }) {
  const deadline = liveDeadline(thread)
  if (!deadline) return null
  return <DeadlineSlot slug={thread.id} deadline={deadline} lead={lead} slot={slot} handedOff={!keepOverrun && thread.needsYou === true} />
}

function DeadlineSlot({ slug, deadline, lead, slot, handedOff }: { slug: string; deadline: ThreadDeadlineView; lead?: ReactNode; slot: "urgent" | "quiet"; handedOff: boolean }) {
  const nowMs = useDeadlineNow(Date.parse(deadline.at))
  const tone = deadlineTone(deadline, nowMs)
  if (handedOff && tone === "over") return null
  if ((tone === "plenty") !== (slot === "quiet")) return null
  return (
    <>
      {lead}
      <DeadlineChip slug={slug} deadline={deadline} />
    </>
  )
}

function DeadlineChip({ slug, deadline }: { slug: string; deadline: ThreadDeadlineView }) {
  const atMs = Date.parse(deadline.at)
  const nowMs = useDeadlineNow(atMs)
  const [open, setOpen] = useState(false)
  const tone = deadlineTone(deadline, nowMs)
  const reading = deadlineReading(deadline, nowMs)
  const setDeadline = useSetThreadDeadline(slug, () => setOpen(false))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-deadline-chip={tone}
          title={deadlineTitle(deadline, nowMs)}
          aria-label={`Time limit: ${reading}. ${deadlineEndsLabel(atMs, nowMs)}`}
          // Focus must not leave the composer under the header: the strip's own discipline.
          onMouseDown={(event) => event.preventDefault()}
          // `gap-[3.75px]` with the glyph's whole-pixel trim: 4.5px of ink to the reading, the band stamp's bot
          // to WORKING (DeadlineGlyph says why the trim is whole and the gap fractional).
          className={`flex min-w-0 shrink-0 items-baseline gap-[3.75px] whitespace-nowrap rounded-sm tabular-nums outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${DEADLINE_TONE_CLASS[tone]} ${tone === "over" ? "font-medium" : ""}`}
        >
          <DeadlineGlyph size={11} trim="both" className="-mt-[1em]" />
          <span>{reading}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start">
        <ThreadTimeLimitPanel deadline={deadline} nowMs={nowMs} apply={setDeadline} />
      </PopoverContent>
    </Popover>
  )
}

/** The rail row's reading, in its right-edge column beside the rest time and the sub-agent count
 *  (Sidebar.tsx ThreadRow): the stopwatch and the span alone (`42m`, `−8m` once over), at the column's
 *  10.5px. The column already reads as times; the glyph says which. Same tones as the facts line. */
export function RailDeadline({ thread, yieldsToRetry }: { thread: ThreadView; yieldsToRetry?: boolean }) {
  const deadline = liveDeadline(thread)
  if (!deadline) return null
  return <RailDeadlineReading deadline={deadline} yieldsToRetry={yieldsToRetry} handedOff={thread.needsYou === true} />
}

function RailDeadlineReading({ deadline, yieldsToRetry, handedOff }: { deadline: ThreadDeadlineView; yieldsToRetry?: boolean; handedOff: boolean }) {
  const atMs = Date.parse(deadline.at)
  const nowMs = useDeadlineNow(atMs)
  const tone = deadlineTone(deadline, nowMs)
  // A thread that has handed off is not running over: nothing of its own is working, so its turn ended inside
  // the limit as far as the human is concerned. The overrun reading is for a thread still spinning past it
  // (a rested queue card read `−2m` beside a finished orchestration, 2026-10-14). Same rule on the facts line.
  if (handedOff && tone === "over") return null
  const reading = deadlineReading(deadline, nowMs) ?? ""
  // `42m left` → `42m`; `over by 8m` → `−8m` (a true minus): the column has no room for the words, and a
  // countdown past zero reads negative everywhere a countdown is read.
  const span = reading.replace(/ left$/, "").replace(/^over by /, "−")
  return (
    <span
      data-rail-deadline={tone}
      title={deadlineTitle(deadline, nowMs)}
      aria-label={`Time limit: ${reading}`}
      // `gap-[3.25px]` with the glyph's trimmed end: 4.0px of ink to the reading, the sub-agent count's own.
      className={`flex shrink-0 items-baseline gap-[3.25px] text-[10.5px] leading-[19px] tabular-nums ${tone === "plenty" ? "text-muted-55" : DEADLINE_TONE_CLASS[tone]} ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      <DeadlineGlyph size={10} trim="end" />
      <span>{span}</span>
    </span>
  )
}

// ---- EXTEND / SET / REMOVE ----------------------------------------------------------------------------

function useSetThreadDeadline(slug: string, done: () => void): (deadline: string | null) => void {
  const api = useThreadApi()
  return (deadline) => {
    done()
    api.setThreadDeadline({ slug, deadline }).catch((error: unknown) => {
      showToast(`Could not ${deadline ? "set" : "remove"} the time limit: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
    })
  }
}

/** The panel for a thread's own limit: extend it, type a new one, or remove it; or, with none, set one. */
function ThreadTimeLimitPanel({ deadline, nowMs, apply }: { deadline?: ThreadDeadlineView; nowMs: number; apply: (deadline: string | null) => void }) {
  const iso = (ms: number) => new Date(ms).toISOString()
  if (!deadline) {
    return (
      <TimeLimitPanel
        heading="No time limit"
        presetsLabel="Time limit presets"
        presets={DISPATCH_LIMIT_PRESETS.map((value) => ({
          label: value,
          title: deadlineEndsLabel(parseOk(value, nowMs), nowMs),
          pick: () => apply(iso(parseOk(value, Date.now()))),
        }))}
        onSubmitText={(raw) => apply(iso(parseOk(raw, Date.now())))}
      />
    )
  }
  const atMs = Date.parse(deadline.at)
  const reading = deadlineReading(deadline, nowMs)
  return (
    <TimeLimitPanel
      heading={
        <>
          {deadlineEndsLabel(atMs, nowMs)} · {reading}
          {deadline.setBy === "worker" && <span className="block text-muted-55">Set by the agent</span>}
        </>
      }
      presetsLabel="Extend the time limit"
      presets={EXTEND_PRESETS.map((preset) => ({
        label: preset.label,
        title: deadlineEndsLabel(extendedDeadlineMs(atMs, nowMs, preset.ms), nowMs),
        pick: () => apply(iso(extendedDeadlineMs(atMs, Date.now(), preset.ms))),
      }))}
      onSubmitText={(raw) => apply(iso(parseOk(raw, Date.now())))}
      clear={{ label: "Remove time limit", run: () => apply(null) }}
    />
  )
}

/** The ⋯ menu's "Time limit…": the same panel in a small dialog, for a thread with no chip to press. */
export function TimeLimitDialog({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  const nowMs = useNowMs()
  const setDeadline = useSetThreadDeadline(thread.id, onClose)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title="Time limit" className="w-[18rem] max-w-[92vw]">
      <ThreadTimeLimitPanel deadline={liveDeadline(thread)} nowMs={nowMs} apply={setDeadline} />
    </Dialog>
  )
}
