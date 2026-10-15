import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { threadCanCompact, type ThreadView } from "@ntwine/shared"
import { useThreadApi } from "../api/threadApi.tsx"
import { showToast } from "../store.ts"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"

// HOW FULL THE SESSION'S CONTEXT IS — "◔ 74% context", in a thread header's second line after "Last
// active" (queue card, drawer), rendered once here so the two cannot drift. It sat as a
// bare donut in the lifecycle footer until 2026-10-05, when the footer went and the context reading
// moved to the header with the other whole-thread facts (maintainer: "we say last active two minutes
// ago, context at 74% or something" — see ThreadLifecycle.tsx for the top/bottom split).
//
// It is a READING, never an estimate. Both halves of the fraction are measured by the provider and
// travel together on ThreadView.context; the server omits the field entirely unless it has both, so
// this component's only job is to render nothing when it is absent. There is deliberately no 0% dial,
// no empty ring, no "—" placeholder: an absent reading must occupy no space at all, the same rule the
// child row's working-duration follows. (Which threads have one, and why, is documented on
// FoldState.contextWindow — the short version is that codex always does, and a Claude thread does from
// its first assistant record, borrowing the window this ntwine process last measured for its own model
// alias until its own turn ends and names one.)
//
// THE DENOMINATOR IS THE ROOM THIS THREAD HAS, NOT THE MODEL'S SIZE, and on a Claude thread those are
// routinely different numbers. ntwine dispatches at the 1M window and then caps the worker at Settings'
// compaction window (500K by default), and Claude Code's effective window is the `min` of the two — so
// this dial read "253,862 of 1,000,000 tokens · 25% full" for a session that had used half its room and
// was heading for a summary (maintainer 2026-09-01: "it's showing this even though the auto-compaction
// threshold is currently set to 500k"). The lowering happens once, server-side, in
// ClaudeRuntimeIngest.contextWindow. Do not add a second number here to explain the first: the
// Settings drawer's "Compaction window" field is where that ceiling is named and changed.
//
// SIZE IS INHERITED, NOT SET. The svg is sized in `em` and the arc colors come from `currentColor`, so
// the header line's own text scale decides how big this is and what tone it takes — exactly the
// discipline ChildOpRow's duration reading landed on. Do not put a px size on it.
//
// THE PERCENT IS ON THE SURFACE; THE TOKEN COUNTS ARE IN THE HOVER PANEL. In the footer the dial stood
// alone — a control strip had no room for a background reading's words, and a bare "87%" beside it was
// tried and dropped. The header line is a line of facts in words ("Last active 2m ago"), so the reading
// joins it as one ("74% context") and the dial becomes its glyph. "348,950 of 1,000,000 tokens" stays in
// the panel: it is the detail, not the reading.
//
// So if you are here because a thread appears to have NO indicator: the surface is almost certainly not
// the reason. All three surfaces render this same component, and the answer is per-THREAD — the drawer
// cannot show a reading the queue card would have shown. A Claude row is blank when ntwine has no
// denominator for it at all: nothing in this process has yet measured a window for that model alias,
// and the thread has not finished a turn of its own. That was every freshly dispatched thread until
// 2026-08-26 (maintainer: "the context breakdown is often not visible in the drawer view, which I find
// quite odd") — see ClaudeRuntimeIngest.contextWindow for what closed it and why the borrow is a
// measurement rather than a guess.

// Geometry for a 16-unit viewBox donut. r + half the stroke is the OUTER edge, held at 7.5 so the ring
// sits fully inside the box — thinning the stroke therefore RAISES r rather than shrinking the glyph.
//
// STROKE IS MATCHED TO ITS NEIGHBOURS, not chosen. In the footer this dial sat between two lucide
// glyphs drawn with a 1.0px line, and the old strokeWidth 2 painted 1.575px at that 12.6px size — half
// again as heavy, which made a three-glyph status cluster read as three different families (maintainer
// 2026-08-04: "the icon brightnesses and spacing look absolutely terrible"). 1.25 painted 0.98px there.
// In the header it renders at 1.05em of 11px (11.55px), where the same 1.25 paints 0.9px — a pen the
// weight of the regular-weight words beside it rather than a bolder mark. Colour was never the whole
// story: two marks in one tone still read as mismatched when one is drawn with a fatter pen.
const STROKE = 1.25
const R = 7.5 - STROKE / 2
const CIRCUMFERENCE = 2 * Math.PI * R

/** Percent for the tooltip: floored, so it only reads 100% when the context genuinely is full. */
function displayPercent(tokens: number, window: number): number {
  return Math.max(0, Math.min(100, Math.floor((tokens / window) * 100)))
}

// How long the panel survives the pointer leaving the dial. The panel opens on hover but carries a
// button, so the pointer has to cross the 5px between dial and panel without the panel closing under
// it; the same grace applies leaving the panel back toward the dial.
const HOVER_CLOSE_DELAY_MS = 150

/** Whether ContextMeter draws anything for this thread — for the header line, which sets a `·` before it. */
export function hasContextReading(thread: Pick<ThreadView, "context">): boolean {
  return !!thread.context && thread.context.window > 0
}

export function ContextMeter({ thread }: { thread: ThreadView }) {
  // A HOVER PANEL, not a tooltip: the reading used to sit in a Radix tooltip, which cannot hold a
  // control (the app's provider sets `disableHoverableContent`). "Compact now" needed one (maintainer
  // 2026-09-26: "when you hover over the context pie chart … you should also see a button there that
  // requests compaction"), so the dial anchors a popover that opens on hover and focus, stays open
  // while the pointer is over either half, and opens on a tap for a touch screen with no hover.
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dial = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const context = thread.context
  // Absent ⇒ nothing. Also guards a window of 0, which would make the fraction meaningless rather
  // than merely unknown.
  if (!context || !hasContextReading(thread)) return null
  const openNow = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }
  // A press on the dial is the dial's own gesture. Without this, Radix reads the pointerdown as a click
  // OUTSIDE the panel and shuts it, and the click that follows would have to reopen it.
  const keepDialInteractions = (event: { target: EventTarget | null; preventDefault: () => void }) => {
    if (dial.current?.contains(event.target as Node)) event.preventDefault()
  }
  const compacting = compactionPending(thread, context.tokens)
  const percent = displayPercent(context.tokens, context.window)
  // The arc's own fraction is NOT the floored percent: a 0.4%-full context should still show a hairline
  // of arc rather than a bare ring, and clamping keeps a reading that overshoots its window (a provider
  // counting a request ntwine has not seen the window change for) from wrapping past 12 o'clock.
  const fraction = Math.max(0, Math.min(1, context.tokens / context.window))
  const headline = `Context ${percent}% full`
  const detail = `${context.tokens.toLocaleString()} of ${context.window.toLocaleString()} tokens`
  const label = `${headline}\n${detail}`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-context-meter
          data-context-percent={percent}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          onFocus={openNow}
          ref={dial}
          onClick={(event) => {
            // The dial sits inside a queue card; the click is this control's, not the card's.
            event.stopPropagation()
            // A click OPENS, it never toggles: with a mouse the hover already opened the panel, and a
            // click that shut it again would hide the very button the pointer is heading for. A tap on
            // a touch screen opens it the same way; a tap anywhere else closes it.
            openNow()
            // Enter or Space on the focused dial (a click with no pointer, detail 0) carries focus into
            // the panel, which is portaled to <body> and so is not next in the tab order.
            if (event.detail === 0) requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus())
          }}
          // The line's own tone (the header's muted grey), brightening while the panel is open or the
          // pointer is on it — the way a link in a line of facts answers a hover.
          className={`flex shrink-0 items-baseline gap-1 rounded-sm outline-none transition-colors hover:text-fg/85 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${open ? "text-fg/85" : ""}`}
        >
          {/* ON THE CAP BAND, computed by the browser: `self-baseline` sits the svg's bottom on the
              text's baseline, then the translate lifts its centre to half the cap height — exact in any
              font at any size, because the digits it sits beside are cap-height ink. 0.525em is half of
              the svg's own 1.05em; the shared 0.5em form assumes a 1em glyph. `-mt-[1em]` keeps the
              svg's box out of the line's height arithmetic (it is taller than the text's ascent), so the
              reading's line box is the text's and it lines up with "Last active" beside it; nothing
              painted moves (the ThreadLinks icon idiom). */}
          <svg
            viewBox="0 0 16 16"
            className="-mt-[1em] h-[1.05em] w-[1.05em] shrink-0 self-baseline translate-y-[calc(0.525em_-_0.5cap)]"
            aria-hidden
          >
            {/* The track: the same ink at low opacity, so the empty part of the dial reads as unfilled
                rather than as a border of some other element. */}
            <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={STROKE} />
            {/* Start the arc at 12 o'clock and fill clockwise — the direction every dial is read in. The
                rotation rides the arc, not the svg, so it cannot fight the svg's own alignment translate. */}
            <circle
              cx="8"
              cy="8"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span>{percent}% context</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={5}
        ref={panel}
        data-context-panel
        aria-label={headline}
        onInteractOutside={(event) => keepDialInteractions({ target: event.detail.originalEvent.target, preventDefault: () => event.preventDefault() })}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        // Hover opened it, so focus stays where the operator left it: pulling focus into the panel
        // would steal the caret from a composer the pointer merely passed over.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
        className="flex w-max max-w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 px-3 py-2 text-[11px] leading-relaxed text-fg"
      >
        <div className="flex flex-col">
          <span>{headline}</span>
          <span className="text-muted">{detail}</span>
        </div>
        {threadCanCompact(thread) && <CompactNowButton thread={thread} compacting={compacting} onRequested={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  )
}

// Whether a turn is in flight, in the board's own vocabulary: "running" and "spawning" are a turn
// under way, and "perm-prompt" is one parked on an approval. The server refuses a compaction in each of
// these (router.compactThread), so the button says why rather than failing on click.
function turnInFlight(thread: ThreadView): boolean {
  return thread.runtime === "running" || thread.runtime === "spawning" || thread.runtime === "perm-prompt"
}

// A compaction the operator asked for that has not visibly finished, keyed by session. The board keeps
// reading the thread as resting for the ~10s the summary takes (Claude writes nothing to the transcript
// until it is done), so without this the button came straight back enabled and a second click queued a
// second `/compact`. Module-level rather than component state because the dial unmounts and remounts
// around the compaction — a queue card leaves the queue while the command's turn runs — which is
// exactly when it must survive.
//
// It ends once the thread is at rest again with evidence the command ran — the reading moved (the
// boundary's post-compaction size landed), or the activity stamp did (a `/compact` the harness
// declined — "Not enough messages to compact." — moves no reading, but its records still move the
// stamp) — or on age. The stamp is compared with the one seen at the request rather than with the browser's clock, so
// a skewed client clock cannot settle it early or hold it forever.
const pendingCompactions = new Map<string, { tokens: number; activity: string | undefined; at: number }>()
const PENDING_COMPACTION_MAX_MS = 2 * 60_000

function compactionPending(thread: ThreadView, tokens: number): boolean {
  const key = thread.sessionId
  if (!key) return false
  const pending = pendingCompactions.get(key)
  if (!pending) return false
  // At rest in both cases: the reading moves the moment the boundary lands, while the CLI is still
  // finishing the command, and a second `/compact` sent into that tail is not one to invite.
  const settled = !turnInFlight(thread) && (pending.tokens !== tokens || thread.lastActivityAt !== pending.activity)
  if (settled || Date.now() - pending.at > PENDING_COMPACTION_MAX_MS) {
    pendingCompactions.delete(key)
    return false
  }
  return true
}

function CompactNowButton({ thread, compacting, onRequested }: { thread: ThreadView; compacting: boolean; onRequested: () => void }) {
  const [sending, setSending] = useState(false)
  const tokens = thread.context?.tokens ?? 0
  const busy = turnInFlight(thread) && !compacting
  // Through the thread's own project (api/threadApi.tsx): a cross-project queue card renders this too.
  const api = useThreadApi()
  const compact = () => {
    const sessionId = thread.sessionId
    if (!sessionId) return
    setSending(true)
    api
      .compactThread({ slug: thread.id, sessionId })
      .then(() => {
        pendingCompactions.set(sessionId, { tokens, activity: thread.lastActivityAt, at: Date.now() })
        // The dial itself is the receipt: it drops when the summary lands, and the transcript draws its
        // compaction divider. The toast only covers the seconds in between.
        showToast("Compacting context")
        onRequested()
      })
      .catch((error) => showToast(`Couldn’t compact: ${(error as Error).message.slice(0, 80)}`))
      .finally(() => setSending(false))
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-compact-now
        disabled={busy || sending || compacting || !thread.sessionId}
        onClick={compact}
        onMouseDown={(event) => event.preventDefault()}
        className="flex items-center justify-center gap-1 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45 disabled:hover:bg-panel-2/60 disabled:hover:text-fg/80"
      >
        {(sending || compacting) && <Loader2 size={12} className="animate-spin" />}
        {compacting ? "Compacting…" : "Compact now"}
      </button>
      {busy && <span className="text-muted">Available once the current turn ends</span>}
    </div>
  )
}
