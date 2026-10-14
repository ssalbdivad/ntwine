import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import * as RadixDialog from "@radix-ui/react-dialog"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { AlarmClock, ArrowLeft, Check, Hourglass, Layers, Plus, Repeat, Settings as SettingsIcon } from "lucide-react"
import type { ScheduleView, ThreadView } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { displayTitle, futureSnoozedUntil, lastActiveLabelAt, queued, queueLabelAt, restIsWorking, sessionIndicatorKind, type SessionIndicatorKind } from "../groups.ts"
import { ageSpan, spanUntil } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { projectSlug } from "../lib/base-path.ts"
import { squareCard, type QueuesProject } from "../lib/allQueues.ts"
import { listOverlay } from "../lib/listBands.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { useProjectBoards } from "../lib/projectBoards.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { agentSuffix, liveAgentCount, rowSecondLine, wakeAt } from "../lib/mobileBoardRow.ts"
import { phoneCounts, phoneDone, phoneSubtitle, phoneProjects, phoneQueue, phoneSnoozed, type OverlayFor, type PhoneProjectEntry, type PhoneRow, type PhoneTab } from "../lib/phonePage.ts"
import { scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { ScheduleMark } from "./ScheduleMark.tsx"
import { PhoneScheduleSheet } from "./PhoneScheduleSheet.tsx"
import { ThreadActionsSheet } from "./MobileThreadActionsSheet.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { shortPath } from "./ProjectActions.tsx"

// THE PHONE'S PAGE — a header, three text tabs, ONE list, and a "New thread" button. A fourth tab,
// Schedules, joins the three while the view has any (ARCHITECTURE.md § Scheduled threads): the desktop's project
// row lists them as its fourth quiet count, and here they are the list's fourth band, where the phone reads,
// runs, pauses, turns on and deletes them (PhoneScheduleSheet.tsx). A schedule can also be MADE here: the New
// thread sheet (PhoneNewThread, below) holds the desktop's own prompt box, so `every weekday at 9 …` typed on the
// go becomes a schedule the same way it does at a desk (ARCHITECTURE.md § Scheduled threads): the model reads words
// with a schedule word in them, a schedule shows as a strip under the box, and the send button wears the repeat
// glyph while sending creates it. What a phone draws differently is ScheduleComposer.tsx's under
// `useIsMobile()`: the strip is a TAP ROW (`↻ Every Monday at 9am · in 6d   ×`, the × a 32px hit square) and its
// lines name the send button, never a key. Its Escape goes through `handleDialogEscape`, so a hardware
// keyboard's first Escape dismisses the strip before it closes the sheet. Only the thread reply bar
// (ThreadComposerBox, `layout: "bar"`) has no schedules.
//
// Upstream's phone board (upstream MobileBoard.tsx, its 2026-09-30 redesign: 6754e72a "the phone
// board gets a header, text tabs and one line per row", 39db08a6 "the projects page is a plain list on a
// phone") brought onto the fork's ONE page (AllQueues.tsx). Below the phone breakpoint (lib/mobile.ts,
// 700px) the page renders this instead of its desktop stack, which on a phone was the prompt box, then
// every Ready card at full height, then the list ~9,400px down with six cards (2026-09-30).
//
// It is not a narrower desktop page. The desktop's two columns and its drawers beside them assume a
// viewport that can hold more than one thing at once; 390pt cannot, so the phone gets a drill-down: the
// projects, a view's list of threads, and a thread (its drawer, which a phone draws full-screen —
// styles.css `.ntwine-sheet-panel`).
//
// WHAT IS THE SAME, deliberately: the data. The page hands this its projects exactly as the desktop list
// and queue draw them (lib/allQueues.ts), the tabs band them with the list's own `loudBands`
// (lib/phonePage.ts), and every row reading comes from the rail's helpers — `sessionIndicatorKind` for
// the mark, the queue clock for the age. The VIEW is the page's too: focused on one project
// (`/project/<slug>`) or All projects (`/all`), switched by navigating, so Back works and a reload keeps
// it. A phone's bare `/` is neither: it is the projects list (PhonePage below), upstream's phone home.
//
// WHAT IS UPSTREAM'S, each the maintainer's call from its mockup reviews (2026-08-17, 2026-09-30):
//
//   · READY AND WORKING ARE ONE TAB, called QUEUE, asks first ("something is active until it's marked
//     done"); Snoozed and Done are the other two. UNDERLINE TABS UNDER THE HEADER, not a bottom tab bar:
//     the bottom edge belongs to the thumb's primary verb.
//   · A RUNNING ROW WEARS A STATIC PLAY MARK, not the rail's travelling spinner, and NOTHING IN THE CHROME
//     ANIMATES: permanent motion in the corner of the eye is noise.
//   · NO COMPOSER ON THIS SCREEN. Starting a thread is the "New thread" button; a reply box belongs to a
//     thread. AN ASK IS MARKED BY THE ACCENT "?" AND NOTHING ELSE.
//   · ONE SECOND LINE PER ROW says what the thread wants (lib/mobileBoardRow.ts); a live sub-agent count
//     ("· 2 agents") stands in for the child rows. THE SNOOZED TAB'S RIGHT COLUMN SAYS WHEN IT WAKES.
//   · THE HEADER'S ← LEADS TO THE PROJECTS, a plain list, and its gear to Settings.
//
// WHAT IS THE FORK'S: All projects. Its rows come from every project, so each one names its project at
// the head of its second line, and the projects list leads with All projects as the one view that is not a
// project. Its New thread starts in the prompt box's PICK, with the pick's own picker in the box.
//
// NOT PORTED: swipe-to-triage. Its two RPCs were the page project's; on a page whose rows belong to any
// project they would have to go through each project's own client, with the card's optimistic exit, and
// a thread's drawer already has Snooze and Mark as done one tap away. What upstream added beside the
// swipe IS here: a LONG-PRESS on a row opens the thread's ⋯ sheet (7d768576; useLongPress below), so
// every verb the thread page's ⋯ offers — snooze, Goal, files, rename, Mark as done on a running one — is
// one hold away from the list, for a row of any project.

/** The row title's size, which its mark's slot reads `cap` at. */
const TITLE_PX = 15.5

/** The rail's checkbox geometry (BoxSpinner's STATUS_BOX) as a ratio, so a mark keeps its SHAPE at any size. */
const BOX_RADIUS_RATIO = 4 / 15

function StatusBox({ children, tone = "border-muted/45", size = 18 }: { children?: ReactNode; tone?: string; size?: number }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border ${tone}`}
      style={{ width: size, height: size, borderRadius: size * BOX_RADIUS_RATIO }}
    >
      {children}
    </span>
  )
}

/** ▶ — in flight. Static, and optically centred: a triangle centred on its BOX always reads left-heavy. */
function PlayMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size}>
      <svg width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} viewBox="0 0 10 10" aria-hidden className="translate-x-[8%] text-muted-85">
        <path d="M2.5 1.4 8.2 5 2.5 8.6Z" fill="currentColor" />
      </svg>
    </StatusBox>
  )
}

/** ? — awaiting you, and the only mark on the page that spends the accent. */
function AskMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-accent/90">
      <span className="font-sans font-bold leading-none text-accent" style={{ fontSize: (size * 10) / 15 }}>?</span>
    </StatusBox>
  )
}

function DoneMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-muted/40">
      <Check size={Math.round((size * 10) / 15)} strokeWidth={3} className="text-muted-85" />
    </StatusBox>
  )
}

function HourglassMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size}>
      <Hourglass size={Math.round((size * 10) / 15)} className="text-muted-75" />
    </StatusBox>
  )
}

/** The human's own wall-clock park: the rail's muted alarm clock, at the hourglass's 10/15 ratio — the two
 *  are one weight family on the rail. Only a `userSnoozed` row takes it; a worker's own park and the
 *  resting card's event-snooze stay on the hourglass and the dim. */
function AlarmMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size}>
      <AlarmClock size={Math.round((size * 10) / 15)} className="text-muted/75" />
    </StatusBox>
  )
}

/** One kind → one mark. The kinds are the rail's; only the drawing is the phone's. `moving` is the rail's
 *  spinner question for an at-rest wait (inMotion below): a shell or PR rest plays only while its worker
 *  called it `working`, and stays at rest in the queue and the Snoozed tab. */
function ThreadMark({ kind, userSnoozed, moving }: { kind: SessionIndicatorKind; userSnoozed?: boolean; moving?: boolean }) {
  if (kind === "needs-input") return <AskMark />
  if (kind === "stalled") {
    return (
      <StatusBox tone="border-accent/90">
        <span className="font-sans text-[12px] font-bold leading-none text-accent">!</span>
      </StatusBox>
    )
  }
  if (kind === "working" || moving) return <PlayMark />
  // Killed by a usage limit, auto-resume promised: the rail's yellow hourglass — accent like the stalled
  // [!] above, an hourglass because a wake is coming.
  if (kind === "limit") {
    return (
      <StatusBox tone="border-accent/90">
        <Hourglass size={12} className="text-accent" />
      </StatusBox>
    )
  }
  if (kind === "snoozed" && userSnoozed) return <AlarmMark />
  // Parked — the human's event-snooze, a worker's own declared wait, or a wait on a TIMER. The row's dim,
  // not the mark, is what separates the human's park from the worker's.
  if (kind === "snoozed" || kind === "parked" || kind === "timer") return <HourglassMark />
  if (kind === "done" || kind === "archived") return <DoneMark />
  // Awaiting a PR: the rail draws GitHub's octocat; the phone has no mark for it yet and stays at rest.
  return <StatusBox />
}

/**
 * One thread, full width: the mark, the title with its right-hand reading, and one line under it.
 *
 * No card: a card spends side margins and then its own padding on every row, which on a 390pt screen is
 * 64pt of a 358pt measure. The hairline is INSET to the text column (16 + 18 + 12 = 46) so the glyph
 * column reads as a gutter rather than as the first cell of a table.
 *
 * THE RIGHT-HAND READING depends on the tab. In Queue it is how long a Ready thread has waited — the
 * queue clock the desktop's cards and rows print, which is also the order the tab lists them in — and
 * nothing for one still in motion; in Done the rest age; in Snoozed when the thread wakes (`wakes 3h`),
 * and nothing for a park with no clock behind it (a PR watch, the resting card's event-snooze).
 *
 * In All projects the second line opens with the row's PROJECT, since the list mixes them.
 */
function ThreadRow({ row, tab, last, withProject, onLongPress }: { row: PhoneRow; tab: PhoneTab; last: boolean; withProject: boolean; onLongPress: () => void }) {
  const { project, thread: t } = row
  const now = useNowMs()
  const open = useOpenThreadInPlace()
  const press = useLongPress(onLongPress)
  const kind = sessionIndicatorKind(t)
  // A rest time dates a HANDOFF, so a row that is still going has nothing to date — the rail's own rule,
  // read off the MARK (upstream MobileBoard): a row that reads at-rest carries the time that goes with it.
  // A shell or PR rest is in motion only when its worker called it `working` (groups.restIsWorking,
  // 2026-10-05): the same rest in the queue or the Snoozed tab is a handoff, and carries its rest time.
  const waitMoving = (kind === "background" || kind === "pr") && restIsWorking(t)
  const inMotion = t.runtime === "running" || t.runtime === "spawning" || kind === "working" || waitMoving
  const wakes = tab === "snoozed" ? spanUntil(wakeAt(t, now), now) : null
  const at = tab === "queue" && queued(t) ? queueLabelAt(t) : lastActiveLabelAt(t)
  const right = tab === "snoozed" ? (wakes ? `wakes ${wakes}` : null) : inMotion ? null : ageSpan(at, now)
  const line = rowSecondLine(t, kind, inMotion, now)
  const agents = agentSuffix(liveAgentCount(t))
  return (
    <div className={kind === "snoozed" ? "opacity-[var(--mobile-dim-opacity)]" : undefined}>
      <button
        type="button"
        data-mobile-thread-row={row.key}
        {...press}
        onClick={() => open(project, t.id)}
        // No callout and no text selection: a hold on a row is the actions gesture, not a copy.
        style={NO_CALLOUT}
        className="flex w-full items-start gap-3 px-4 py-[11px] text-left active:bg-hover"
      >
        <CapSlot size={18} fontSize={TITLE_PX}>
          <ThreadMark kind={kind} userSnoozed={futureSnoozedUntil(t) !== undefined} moving={waitMoving} />
        </CapSlot>
        <span className="flex min-w-0 flex-1 flex-col gap-px self-baseline">
          <span className="flex min-w-0 items-baseline gap-2.5">
            {/* The title truncates and the schedule's repeat mark stays after it, outside the ellipsis — a
                run whose title fills the line still says where it came from (ScheduleMark). */}
            {/* The type is on the wrapper so the mark's `cap` is the title's. Measured (sans, dsf 2, ink centre
                minus cap-band centre): -0.35px, ink high, in Chrome on Linux, where `1cap` resolves to 12.00px
                for this title against an H that inks 11.30px (DejaVu Sans; the same probe reads 11.30 for a
                bare 15.5px span, and 12.03 / 12.10 on the 16.5px header). A browser metric, not a geometry
                error, so no constant is fitted over it. */}
            <span className="flex min-w-0 flex-1 items-baseline text-[15.5px] font-medium leading-[21px] tracking-[-0.005em] text-fg">
              <span className="min-w-0 truncate">{displayTitle(t)}</span>
              {t.schedule ? <ScheduleMark schedule={t.schedule} size="phoneRow" className="ml-1" /> : null}
            </span>
            {/* `leading-[16px]`, not the title's 21px: baseline-aligned to the 15.5px title, a 12px reading
                on a 21px line hung 1.25px below the title's line box, so every row with an age stood 1px
                taller than one without (64 against 63px, 2026-09-30). */}
            {right ? <span data-mobile-row-right className="shrink-0 text-[12px] leading-[16px] tabular-nums text-faint">{right}</span> : null}
          </span>
          {withProject || line || agents ? (
            // The project and the agent count sit OUTSIDE the truncating span, so a long activity line
            // ellipsizes between them and never swallows either.
            <span data-mobile-row-line className="flex min-w-0 text-[13.5px] leading-[19px] text-muted">
              {withProject ? (
                <span data-mobile-row-project className="max-w-[45%] shrink-0 truncate">
                  {project.name}
                </span>
              ) : null}
              {withProject && (line || agents) ? <span className="shrink-0 whitespace-pre"> · </span> : null}
              {line ? (
                <span className="min-w-0 truncate">
                  {line.lead ? <span className="font-semibold text-fg">{line.lead} </span> : null}
                  {line.text}
                </span>
              ) : null}
              {agents ? <span className="shrink-0 whitespace-pre">{line ? ` · ${agents}` : agents}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

/**
 * LONG-PRESS A ROW FOR ITS ACTIONS — the thread's own ⋯ sheet, opened from the list (upstream 7d768576,
 * "no action is reachable only by a gesture": upstream's swipe offered Snooze and Done, and the hold
 * reached the rest). Here, with no swipe, the hold is the ONLY way to a row's verbs short of opening the
 * thread, which is why it exists at all.
 *
 * Upstream's timing and its cancels, unchanged: 500ms, given up on anything that says the finger meant
 * something else — a move past the 8px slop (a scroll starting; the browser also cancels the pointer
 * when it takes the pan), the finger lifting first, the pointer leaving or being cancelled. When it DOES
 * fire, any click the lift delivers (a mouse held down for the same 500ms delivers one) is swallowed, or
 * the row would open the thread under the sheet. The flag is cleared at the next press, so a swallowed
 * click can never outlive the gesture that earned it.
 */
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 8

/** The platform's own hold gesture (iOS's callout, a text selection) would race the sheet. */
const NO_CALLOUT = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } as const

function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  // The latest callback, so a timer armed on one render calls the current one.
  const callback = useRef(onLongPress)
  callback.current = onLongPress
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        // A short tick where the platform offers one (Android); iOS Safari has no vibration API.
        navigator.vibrate?.(10)
        callback.current()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const o = origin.current
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: ReactMouseEvent) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  }
}

/**
 * A MARK ON ITS TEXT'S CAP BAND, computed by the browser, so it holds in any font and at any size.
 *
 * The slot is a ZERO-HEIGHT box on the text's BASELINE (`self-baseline`, beside an item that is baseline-
 * aligned too): it has no in-flow content, so its baseline is synthesized from its edge — never taken from
 * a "?" inside some marks and not others — and at no height it cannot push the text down. The mark stands
 * on that baseline and drops by half its own height less half a cap, which puts its centre on the cap
 * band's; the slot carries the text's font-size, so `cap` is the text's.
 *
 * Upstream centred both marks in their boxes instead: the row's 18px box in the title's 21px line, and
 * the + in the pill. In sans that left the box's ink centre 1.50px below the title's cap band on every
 * row and the +'s 1.22px below its label's (the visual-review ink routine, 390px, 2026-09-30).
 */
function CapSlot({ size, fontSize, children }: { size: number; fontSize: number; children: ReactNode }) {
  return (
    <span className="relative h-0 shrink-0 self-baseline" style={{ width: size, fontSize }}>
      <span className="absolute bottom-0 left-0 flex" style={{ width: size, height: size, transform: `translateY(calc(${size / 2}px - 0.5cap))` }}>
        {children}
      </span>
    </span>
  )
}

function EmptyBand({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-10 pb-24 text-center">
      <p className="m-0 text-[15px] text-muted">{label}</p>
    </div>
  )
}

/**
 * One band's tab: a text label with an underline, and its count after it on the same baseline.
 *
 * The tab reserves its SEMIBOLD width whichever state it is in (an invisible bold copy shares its grid
 * cell), so selecting a tab never nudges the tabs after it sideways. 44px tall: the whole strip under the
 * header is the hit area, not the 20px of text in it.
 *
 * The copy is the label AND its count, where upstream reserved the label alone: the slack a regular-weight
 * label leaves then fell BETWEEN the label and its count, which stood 11.10px of ink off an unselected
 * "Snoozed" against 7.14px off the selected "Queue" (scripts/ink-gaps.mjs, sans, dsf 4, 2026-09-30) — the
 * count drifting off the word it counts whenever its tab was not the one open. Reserved together and
 * centred, the count holds at 7.1-7.9px in both states and the slack splits into the gaps either side,
 * which stay within 3px of each other — 26.85 and 29.69px with Queue open (left-aligned instead, it all landed after the count and the two
 * gaps read 23.4 and 31.2px).
 */
function BandTab({ band, label, active, onClick, children }: { band: PageTab; label: string; active: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-mobile-tab={band}
      onClick={onClick}
      className={`flex h-[44px] shrink-0 items-center whitespace-nowrap border-b-2 ${active ? "border-fg text-fg" : "border-transparent text-muted"}`}
    >
      <span className="grid">
        <span aria-hidden className={`invisible ${TAB_FACE}`}>
          <span className="font-semibold">{label}</span>
          {children}
        </span>
        <span className={`${TAB_FACE} justify-self-center`}>
          <span className={active ? "font-semibold" : undefined}>{label}</span>
          {children}
        </span>
      </span>
    </button>
  )
}

/**
 * THE BAND TABS: Queue, Snoozed, Done, and Schedules while the view has any, on ONE line that never wraps.
 *
 * A tab never shrinks (BandTab: `shrink-0`, `whitespace-nowrap`) — its label and count are one reading, and
 * squeezing the tab is what broke "Queue 1 · 15" across two lines, the "15" under the "·", with the strip
 * running 4px off a 390px screen (a question waiting, 14 queued and a schedule: QA 2026-10-06; 29px off at
 * 360 with two-digit counts everywhere).
 *
 * THE GAPS GIVE WAY FIRST, from 22px down to 10, and they are measured, not estimated: each is a spacer
 * that starts at 22px and shrinks, the tabs do not, so flexbox takes the overflow out of the three gaps
 * equally and stops each at its 10px floor. This replaces a `clamp(10px, (100vw - 326px) / 3, 22px)` gap,
 * which assumed the four tabs drew 290px — true at the counts it was tuned on (11.3px gaps at 360, 21.3 at
 * 390), and wrong the moment a count grew a digit. With spacers the same counts land on the same gaps, and
 * other counts land on theirs.
 *
 * ONLY WHEN 10px GAPS ARE NOT ENOUGH does the strip scroll sideways — no scrollbar, as the phone's effort
 * row (MobileModelSheet.tsx) — with the cut-off tab at the edge as the cue there is more. The worst
 * realistic counts get there on a 390px phone: asks, queue, snoozed and schedules all in two digits draw
 * 345px of tabs, 411 with margins and 10px gaps, which a 430px phone still holds on 16.5px gaps; QA's case
 * (1 ask of 15 queued, a schedule) fits 390 on 11.3px gaps and scrolls at 360 (2026-10-06, Linux Chrome,
 * sans; components/phoneBandTabs.e2e.test.ts pins the contract, not these widths).
 *
 * The SELECTED tab is scrolled fully into view, its 18px margin with it, whenever the selection changes;
 * nothing else moves the strip, so a poll re-rendering it never yanks back a strip the reader has scrolled.
 *
 * The scroller sits INSIDE the bordered box rather than being it: the underline overlaps the strip's
 * bottom border by its own 1px (`-mb-px`), and a scroll container clips its children on both axes, so on
 * the scroller itself that pixel would have been cut off (or made it scroll vertically by one).
 */
export function BandTabs({ tab, onTab, asks, queue, snoozed, schedules }: {
  tab: PageTab
  onTab: (tab: PageTab) => void
  asks: number
  queue: number
  snoozed: number
  /** The Schedules tab's count and tone, or null while the tab is not shown. */
  schedules: { count: number; attention: boolean } | null
}) {
  const strip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = strip.current
    const selected = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el || !selected) return
    // offsetLeft is from the scroller's padding edge (it is `relative`) and ignores its scroll.
    const left = selected.offsetLeft - TAB_MARGIN
    const right = selected.offsetLeft + selected.offsetWidth + TAB_MARGIN - el.clientWidth
    if (el.scrollLeft > left) el.scrollLeft = left
    else if (el.scrollLeft < right) el.scrollLeft = right
  }, [tab])
  const gap = <span aria-hidden className="w-[22px] min-w-[10px] shrink" />
  return (
    <div className="border-b border-border/70">
      <div ref={strip} role="tablist" aria-label="Bands" className="relative -mb-px flex overflow-x-auto px-[18px] scrollbar-none">
        <BandTab band="queue" label="Queue" active={tab === "queue"} onClick={() => onTab("queue")}>
          {asks > 0 ? <span className="text-[12.5px] font-bold tabular-nums text-accent">{asks}</span> : null}
          {queue > 0 ? <span className={TAB_COUNT}>{asks > 0 ? `· ${queue}` : queue}</span> : null}
        </BandTab>
        {gap}
        <BandTab band="snoozed" label="Snoozed" active={tab === "snoozed"} onClick={() => onTab("snoozed")}>
          {snoozed > 0 ? <span className={TAB_COUNT}>{snoozed}</span> : null}
        </BandTab>
        {gap}
        <BandTab band="done" label="Done" active={tab === "done"} onClick={() => onTab("done")} />
        {/* SCHEDULES, after the bands, only while the view has any (or the tab is open, so deleting the
            last one does not pull the tab out from under the reader). Its count turns warning-toned
            when one was paused by Ntwine or a proposal waits — the desktop project row's fourth count. */}
        {schedules ? (
          <>
            {gap}
            <BandTab band="schedules" label="Schedules" active={tab === "schedules"} onClick={() => onTab("schedules")}>
              {schedules.count > 0 ? (
                <span data-mobile-schedules-count className={schedules.attention ? "text-[12.5px] font-bold tabular-nums text-attention-soft" : TAB_COUNT}>
                  {schedules.count}
                </span>
              ) : null}
            </BandTab>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** The band tabs' side margin, which the selected tab keeps when it is scrolled into view. */
const TAB_MARGIN = 18

/** The view's name in the header. */
const TITLE_TYPE = "text-[16.5px] font-semibold leading-[21px] tracking-[-0.01em] text-fg"

/**
 * The line under the view's name (lib/phonePage.ts phoneSubtitle). Its parts WRAP rather than truncate,
 * onto a second line the box clips: a part that does not fit is left out whole — the Queue tab counts the
 * same rows — instead of being cut to "1 w…" mid-word, which a 300px column did to the last one.
 */
function Subtitle({ subtitle }: { subtitle: { accent: string | null; rest: string | null } }) {
  const parts = [
    subtitle.accent ? <span key="accent" className="font-semibold text-accent">{subtitle.accent}</span> : null,
    ...(subtitle.rest ?? "").split(" · ").filter(Boolean).map((part) => <span key={part}>{part}</span>),
  ].filter((part) => part !== null)
  return (
    <div data-mobile-board-subtitle className="flex h-[17px] flex-wrap overflow-hidden text-[13px] leading-[17px] text-muted">
      {parts.map((part, index) => (
        <span key={index} className="shrink-0 whitespace-pre">
          {index > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </div>
  )
}

const TAB_COUNT = "text-[12.5px] font-medium tabular-nums text-muted"
/** A tab's label and count on one baseline, in the grid cell its bold copy reserves. */
const TAB_FACE = "col-start-1 row-start-1 flex items-baseline gap-1.5 text-[14.5px] leading-[20px]"
/** The header's 44px round buttons (←, the gear). */
const HEADER_BUTTON = "flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
/** Done rows drawn at once, then this many more per "Show more": the band grows without bound. */
const DONE_PAGE = 30
/** How often an open Done tab re-reads the boards it lists — no project list is mounted here to drop them
 *  when the poll's Done count moves (ProjectList.tsx useReadAhead). */
const DONE_REFETCH_MS = 10_000

export interface PhonePageProps {
  /** Every project, for the projects list. */
  projects: QueuesProject[]
  /** The view's projects — the focused one, or every one. */
  shown: QueuesProject[]
  /** The focused project, or undefined for All projects. */
  viewed: QueuesProject | undefined
  /** Focused on a project, its slug, even before the project list has it. */
  focusedSlug: string | undefined
  /** A queue card being finished or sent away (AllQueues.tsx useLeavingCards). */
  hidden: (key: string) => boolean
  loading: boolean
  error: string | undefined
  /** The home folder, to shorten paths with. */
  homeDir: string | undefined
  /** The prompt box, aimed where a new thread from this view goes; `onDispatched` closes its sheet, and
   *  `autoFocus` is false when the sheet was opened to show a chip without taking the caret
   *  (lib/editorBridge.ts composeInto). */
  composer: (onDispatched: () => void, autoFocus: boolean) => ReactNode
  /** Show All projects; `replace` swaps out the list's own history entry rather than adding one. */
  onAll: (options: { replace: boolean }) => void
  /** Focus a project, the same way. */
  onProject: (project: QueuesProject, options: { replace: boolean }) => void
}

export function PhonePage(props: PhonePageProps) {
  const { listing, home, openListing, closeListing } = useProjectsListing()
  if (listing) return <PhoneProjects {...props} home={home} onChoose={closeListing} />
  return <PhoneThreads {...props} onProjects={openListing} />
}

/**
 * THE PROJECTS LIST — the phone's HOME at `/` (upstream's phone home, kept when the desktop's `/` became a
 * redirect to the last view, 2026-10-06), and over a view a HISTORY ENTRY, so a phone's Back — the edge
 * swipe, Android's back button — puts it away again.
 *
 * At `/` it is the page: choosing a view pushes it, so Back returns to the list. Over a view, the header's
 * Projects button pushes the page's own address with a state flag (nothing in the URL: the view is the
 * path's, and a list is not a view); choosing replaces that entry with the view chosen, so Back from there
 * returns to the view before the list, as the desktop switcher's Back does.
 */
function useProjectsListing() {
  const location = useLocation()
  const navigate = useNavigate()
  const home = location.pathname === "/"
  const listing = home || (location.state as { phoneProjects?: boolean } | null)?.phoneProjects === true
  return {
    listing,
    home,
    openListing: () => navigate(`${location.pathname}${location.search}`, { state: { phoneProjects: true } }),
    /** Back off the list, when the choice is the view it was opened from. */
    closeListing: () => navigate(-1),
  }
}

function PhoneThreads({ shown, viewed, focusedSlug, hidden, loading, error, composer, onProjects }: PhonePageProps & { onProjects: () => void }) {
  const focused = focusedSlug !== undefined
  const [tab, setTab] = useState<PageTab>("queue")
  // The schedule whose sheet is up (PhoneScheduleSheet) — mounted means open.
  const [sheet, setSheet] = useState<ScheduleView | null>(null)
  // The row whose ⋯ sheet a long-press opened (ThreadActionsSheet) — mounted means open.
  const [actionsFor, setActionsFor] = useState<PhoneRow | null>(null)
  // In the store, not local state: an editor's selection opens it too (lib/editorBridge.ts composeInto).
  const composing = useSnapshot(store).phoneNewThread
  const setComposing = (open: boolean) => (store.phoneNewThread = open ? { focus: true } : null)
  // …and it closes with the list under it, as local state did: the projects list or the desktop layout
  // coming back must not find a sheet left open.
  useEffect(() => () => { store.phoneNewThread = null }, [])
  const [donePage, setDonePage] = useState(DONE_PAGE)
  // A different view is a different list to read: from its Queue, at its top.
  const viewId = focusedSlug ?? "*"
  const lastView = useRef(viewId)
  useEffect(() => {
    if (lastView.current === viewId) return
    lastView.current = viewId
    setTab("queue")
    setDonePage(DONE_PAGE)
    window.scrollTo(0, 0)
  }, [viewId])

  const direction = useSnapshot(prefs).queueOrder
  const { live, onPage, overlayFor } = useJustActed()
  const queue = phoneQueue(shown, hidden, overlayFor, direction)
  const counts = phoneCounts(queue)
  const subtitle = phoneSubtitle(counts)
  const snoozed = phoneSnoozed(shown)
  // Done's rows are each project's own board — the page project's live one, every other's read through
  // the cache, fetched while the tab is open.
  const others = shown.filter((project) => project.open && !project.stale && !onPage(project))
  const boards = useProjectBoards(others.map((project) => project.id), tab === "done", DONE_REFETCH_MS)
  const boardById = new Map(others.map((project, index) => [project.id, boards[index]]))
  const done = tab === "done" ? phoneDone(shown, (project) => (onPage(project) ? live : boardById.get(project.id))) : []
  const doneLoading = tab === "done" && others.some((project) => boardById.get(project.id) === undefined)

  // The view's schedules: the poll's count per project names the tab, and the rows are read while it is open.
  const scheduleCount = shown.reduce((sum, project) => sum + (project.schedules?.count ?? 0), 0)
  const scheduleAttention = shown.some((project) => project.schedules?.attention === true)
  const schedules = useViewSchedules(shown, focused ? viewed : undefined, focused, tab === "schedules", scheduleCount, scheduleAttention)

  const rows = tab === "queue" ? queue : tab === "snoozed" ? snoozed : tab === "done" ? done.slice(0, donePage) : []
  const title = focused ? (viewed?.name ?? focusedSlug) : "All projects"

  return (
    <div data-mobile-board={focused ? "project" : "all"} className="relative min-h-dvh bg-bg">
      {/* The header and the band tabs, fixed together. `env(safe-area-inset-top)`: on a notched phone the
          status bar sits over the top of the viewport, and no headless shot has that inset — so this is a
          defect no screenshot here can show and every real device would. */}
      <div className="fixed inset-x-0 top-0 z-30 bg-bg pt-[env(safe-area-inset-top)]">
        <div className="flex h-[56px] items-center gap-0.5 pr-0.5">
          <button type="button" aria-label="Projects" data-mobile-projects onClick={onProjects} className={HEADER_BUTTON}>
            <ArrowLeft size={21} strokeWidth={2.1} />
          </button>
          <div className="min-w-0 flex-1 pl-0.5">
            <div data-mobile-board-title className={`truncate ${TITLE_TYPE}`}>
              {title}
            </div>
            {!loading ? <Subtitle subtitle={subtitle} /> : null}
          </div>
          <button type="button" aria-label="Settings" data-mobile-settings onClick={() => (store.showSettings = true)} className={HEADER_BUTTON}>
            <SettingsIcon size={21} strokeWidth={1.9} />
          </button>
        </div>
        <BandTabs
          tab={tab}
          onTab={setTab}
          asks={counts.asks}
          queue={queue.length}
          snoozed={snoozed.length}
          schedules={scheduleCount > 0 || tab === "schedules" ? { count: scheduleCount, attention: scheduleAttention } : null}
        />
      </div>

      {/* The list: 56 + 45 of header and tabs above; below, the "New thread" button's 50 plus 16 either
          side, so the last row scrolls clear of it and its age column is never under the button. */}
      <div className="flex min-h-dvh flex-col pb-[calc(82px+env(safe-area-inset-bottom))] pt-[calc(101px+env(safe-area-inset-top))]">
        {error ? (
          <EmptyBand label={`Could not read the queues: ${error}`} />
        ) : tab === "schedules" ? (
          schedules.error ? (
            <EmptyBand label={`Could not read the schedules: ${(schedules.error as Error).message.slice(0, 120)}`} />
          ) : !schedules.data ? (
            <EmptyBand label="Loading…" />
          ) : schedules.data.length === 0 ? (
            <EmptyBand label="No schedules." />
          ) : (
            <div role="tabpanel" data-mobile-schedules>
              {schedules.data.map((schedule, index) => (
                <ScheduleRow key={schedule.id} schedule={schedule} last={index === schedules.data!.length - 1} withProject={!focused} onOpen={() => setSheet(schedule)} />
              ))}
            </div>
          )
        ) : rows.length === 0 ? (
          <EmptyBand
            label={
              loading || (tab === "done" && doneLoading)
                ? "Loading…"
                : tab === "queue"
                  ? "Nothing in the queue. Tap New thread to start one."
                  : tab === "snoozed"
                    ? "Nothing snoozed."
                    : "Nothing finished yet."
            }
          />
        ) : (
          <div role="tabpanel">
            {rows.map((row, index) => (
              <ThreadRow key={row.key} row={row} tab={tab} last={index === rows.length - 1} withProject={!focused} onLongPress={() => setActionsFor(row)} />
            ))}
            {tab === "done" && done.length > donePage ? (
              <button
                type="button"
                data-mobile-done-more
                onClick={() => setDonePage((page) => page + DONE_PAGE)}
                className="w-full border-t border-border/70 px-4 py-3.5 text-left text-[14px] text-muted active:bg-hover"
              >
                Show {Math.min(DONE_PAGE, done.length - donePage)} more
              </button>
            ) : null}
          </div>
        )}
      </div>

      <button
        type="button"
        data-mobile-new-thread
        onClick={() => setComposing(true)}
        // NOT the accent: a permanent yellow pill would out-shout every ask in the list under it, and the
        // accent means exactly one thing in this product. This is the app's own primary-button fill.
        // Labelled, not a bare +: the verb is the one thing on this screen that is not a thread.
        className="button-outline fixed bottom-[calc(16px+env(safe-area-inset-bottom))] right-4 z-30 flex h-[50px] items-center rounded-full bg-fg pl-4 pr-5 text-[15px] font-semibold text-bg shadow-lg shadow-shadow-ink/50 active:opacity-85"
      >
        {/* The + on the label's cap band (CapSlot): lucide's plus is symmetric in its box, so the box's
            centre is the ink's. */}
        <span className="flex items-baseline gap-1.5">
          <CapSlot size={20} fontSize={15}>
            <Plus size={20} strokeWidth={2.4} />
          </CapSlot>
          <span className="self-baseline">New thread</span>
        </span>
      </button>
      {sheet ? <PhoneScheduleSheet scheduleId={sheet.id} projectId={sheet.projectId} onClose={() => setSheet(null)} /> : null}
      {actionsFor ? (
        onPage(actionsFor.project) ? (
          // The page's own project: the sheet reads its live board, as the thread page's ⋯ does.
          <ThreadActionsSheet slug={actionsFor.thread.id} onClose={() => setActionsFor(null)} />
        ) : (
          // Any other project's: through that project's client, on this list's live reading of the row —
          // undefined once the row has left every list here, which closes the sheet.
          <ThreadActionsSheet
            slug={actionsFor.thread.id}
            project={shown.find((project) => project.id === actionsFor.project.id) ?? actionsFor.project}
            thread={[...queue, ...snoozed, ...done].find((row) => row.key === actionsFor.key)?.thread}
            onClose={() => setActionsFor(null)}
          />
        )
      ) : null}
      {composing ? <PhoneNewThread onClose={() => setComposing(false)}>{composer(() => setComposing(false), composing.focus)}</PhoneNewThread> : null}
    </div>
  )
}

/**
 * What the operator has just done that the poll cannot know yet, folded into every project's rows the way
 * the desktop list folds it (lib/listBands.ts listOverlay): a reply sent from a drawer takes its row from
 * Ready to Working before the poll says so. The page project's drawer files those by bare slug; anything
 * else, by the thread's key — so `onPage` says which project is the page's own, whose board is `live`.
 */
function useJustActed(): { live: ReturnType<typeof useBoard>; onPage: (project: QueuesProject) => boolean; overlayFor: OverlayFor } {
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const onPage = (project: QueuesProject) => project.slug === focus && live?.projectSlug === project.slug
  return { live, onPage, overlayFor: (project) => listOverlay(project.id, onPage(project), steeredAt, archivingAt) }
}

/** The page's tabs: the three bands, and the view's schedules. */
export type PageTab = PhoneTab | "schedules"

/**
 * The view's SCHEDULES — the focused project's through its own client, or every project's for All projects
 * (the palette's read), kept to the projects the view shows. Read while the tab is open, and again whenever
 * the poll's count or attention for the view moves (both ride the key, as the desktop project row's do).
 */
function useViewSchedules(shown: QueuesProject[], viewed: QueuesProject | undefined, focused: boolean, open: boolean, count: number, attention: boolean) {
  const ids = new Set(shown.map((project) => project.id))
  const query = useQuery({
    queryKey: focused ? [...scheduleKeys.list(viewed?.id ?? ""), count, attention] : [...scheduleKeys.all(), count, attention],
    queryFn: () => (focused ? projectRpc(viewed!.id).listSchedules({}) : rpc.listSchedules({ allProjects: true })),
    enabled: open && (!focused || viewed?.open === true),
    // The right column counts down on the shared clock; the instants move only when a run starts, which
    // the poll's count does not see.
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
  return { error: query.error, data: query.data?.filter((schedule) => ids.has(schedule.projectId)) }
}

/**
 * One schedule, in the thread row's anatomy so the tab reads as more of the same list: the repeat glyph in
 * the mark column, the title with its next run at the right — `in 3h`, or `Paused` / `Proposed` when it will
 * not run on its own, warning-toned when that is Ntwine's doing or a proposal waiting — and the rule under it,
 * after its project in All projects. Dimmed like a Snoozed row when it will not run on its own, unless that
 * wants the human. A tap opens its sheet.
 */
function ScheduleRow({ schedule, last, withProject, onOpen }: { schedule: ScheduleView; last: boolean; withProject: boolean; onOpen: () => void }) {
  const now = useNowMs()
  const dim = schedule.state !== "active" && !schedule.attention
  return (
    <div className={dim ? "opacity-[var(--mobile-dim-opacity)]" : undefined}>
      <button
        type="button"
        data-mobile-schedule-row={schedule.id}
        data-mobile-schedule-state={schedule.state}
        onClick={onOpen}
        className="flex w-full items-start gap-3 px-4 py-[11px] text-left active:bg-hover"
      >
        <CapSlot size={18} fontSize={TITLE_PX}>
          <span className="flex size-full items-center justify-center text-muted-75">
            <Repeat size={15} strokeWidth={2} aria-hidden />
          </span>
        </CapSlot>
        <span className="flex min-w-0 flex-1 flex-col gap-px self-baseline">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 flex-1 truncate text-[15.5px] font-medium leading-[21px] tracking-[-0.005em] text-fg">{schedule.title}</span>
            <span data-mobile-row-right className={`shrink-0 text-[12px] leading-[16px] tabular-nums ${schedule.attention ? "font-medium text-attention-soft" : "text-faint"}`}>
              {scheduleNextLabel(schedule, now)}
            </span>
          </span>
          <span data-mobile-row-line className="flex min-w-0 text-[13.5px] leading-[19px] text-muted">
            {withProject ? (
              <>
                <span data-mobile-row-project className="max-w-[45%] shrink-0 truncate">{schedule.projectName}</span>
                <span className="shrink-0 whitespace-pre"> · </span>
              </>
            ) : null}
            <span className="min-w-0 truncate">{schedule.describe}</span>
          </span>
        </span>
      </button>
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

/**
 * The New thread sheet: the page's own prompt box in a dialog pinned near the top, where the keyboard
 * cannot cover it. The box is aimed by the page — focused, at the view's project; in All projects at the
 * prompt box's PICK, with the pick's own picker in the box's bottom strip (AllQueues.tsx ProjectPicker),
 * so the project is chosen where the desktop chooses it. A dispatch closes it; the new thread then shows
 * in the queue under it.
 */
function PhoneNewThread({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim-30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-mobile-new-thread-sheet
          onEscapeKeyDown={handleDialogEscape}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+56px)] z-50 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">New thread</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * THE PHONE'S PROJECTS — a plain list, the way to change the view (upstream's projects page on a phone,
 * 39db08a6, here the switcher's menu as a page). All projects first, as the one view that is not a
 * project; then each project with its square, its name, its path, and at the right its ASKS in the
 * accent (lib/phonePage.ts phoneProjects: the "N need you" its own header shows) and its spinning band
 * in muted; Home last. The view showing now wears a check.
 *
 * Choosing NAVIGATES, as the switcher does, replacing the list's history entry; choosing the view it was
 * opened from goes Back. At `/` (`home`) the list is the page and was opened over no view, so nothing
 * wears the check and every choice pushes. No add, rename or remove here: they stay on the desktop.
 */
function PhoneProjects({ projects, focusedSlug: viewSlug, hidden, homeDir, onAll, onProject, onChoose, home }: PhonePageProps & { onChoose: () => void; home: boolean }) {
  // The threads view's own overlay, so a reply just sent takes its ask off this count as it takes it off
  // that header — the two read the same rows.
  const list = phoneProjects(projects, hidden, useJustActed().overlayFor)
  const total = [...list.projects, ...(list.home ? [list.home] : [])].reduce((sum, entry) => sum + entry.asks, 0)
  const allWorking = [...list.projects, ...(list.home ? [list.home] : [])].reduce((sum, entry) => sum + entry.working, 0)
  // At `/` the binding is All projects', but the list is not showing it.
  const focusedSlug = home ? null : viewSlug
  const isAll = focusedSlug === undefined
  const replace = !home
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  const choose = (project: QueuesProject) => (project.slug === focusedSlug ? onChoose() : onProject(project, { replace }))
  const row = (entry: PhoneProjectEntry) => {
    const { project } = entry
    const card = squareCard(project)
    return (
      <li key={project.id}>
        <button
          type="button"
          data-mobile-project-row={project.slug}
          aria-current={project.slug === focusedSlug ? "page" : undefined}
          onClick={() => choose(project)}
          className={`flex min-h-[62px] w-full items-center gap-3 border-b border-border/70 px-[18px] py-2 text-left active:bg-hover ${project.stale ? "opacity-60" : ""}`}
        >
          <span className={`shrink-0 ${project.stale ? "grayscale" : ""}`}>
            <ProjectSquare project={card} size={PROJECT_SQUARE} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15.5px] font-medium leading-[20px] text-fg">{project.name}</span>
            <span className="truncate font-mono-keep text-[12.5px] leading-[17px] text-muted" title={card.path}>
              {project.stale ? "Directory is missing" : !project.open ? "Not open" : shortPath(card.path, project.homeDir ?? homeDir)}
            </span>
          </span>
          <Counts asks={entry.asks} working={entry.working} />
          <Current on={project.slug === focusedSlug} />
        </button>
      </li>
    )
  }
  return (
    <div data-mobile-projects-page className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-bg pt-[env(safe-area-inset-top)]">
        <div className="flex h-[56px] items-center pl-[18px] pr-[5px]">
          <h1 className="m-0 min-w-0 flex-1 truncate text-[16.5px] font-semibold tracking-[-0.01em] text-fg">Projects</h1>
          <button type="button" aria-label="Settings" data-mobile-settings onClick={() => (store.showSettings = true)} className={HEADER_BUTTON}>
            <SettingsIcon size={21} strokeWidth={1.9} />
          </button>
        </div>
      </header>
      <ul className="m-0 list-none p-0 pb-[env(safe-area-inset-bottom)]">
        <li>
          <button
            type="button"
            data-mobile-project-row="*"
            aria-current={isAll ? "page" : undefined}
            onClick={() => (isAll ? onChoose() : onAll({ replace }))}
            className="flex min-h-[62px] w-full items-center gap-3 border-b border-border/70 px-[18px] py-2 text-left active:bg-hover"
          >
            <AllProjectsSquare size={PROJECT_SQUARE} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15.5px] font-medium leading-[20px] text-fg">All projects</span>
              <span className="truncate text-[12.5px] leading-[17px] text-muted">
                {list.projects.length === 1 ? "1 project" : `${list.projects.length} projects`}
              </span>
            </span>
            <Counts asks={total} working={allWorking} />
            <Current on={isAll} />
          </button>
        </li>
        {list.projects.map(row)}
        {list.home ? row(list.home) : null}
      </ul>
    </div>
  )
}

/** The squares' size: upstream's card icon, legible as a mark. */
const PROJECT_SQUARE = 34

/** All projects' square: the switcher's layers glyph on Home's neutral tile — the views that are Ntwine's, not a project's. */
function AllProjectsSquare({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[30%]"
      style={{ width: size, height: size, background: "hsl(0 0% 24%)", color: "hsl(0 0% 80%)" }}
    >
      <Layers size={Math.round(size * 0.55)} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  )
}

/** A project's asks in the accent and its spinning band in muted — upstream's projects row (ef6f7f23). */
function Counts({ asks, working }: { asks: number; working: number }) {
  if (asks === 0 && working === 0) return null
  return (
    <span data-mobile-project-counts className="flex shrink-0 items-baseline gap-2.5 whitespace-nowrap text-[13px] text-muted">
      {asks > 0 ? <span data-mobile-project-asks className="font-bold tabular-nums text-accent">{asks}</span> : null}
      {working > 0 ? <span className="tabular-nums">{working} working</span> : null}
    </span>
  )
}

/** The view showing now: a check in a fixed column, so the counts stand in one column whichever row has it. */
function Current({ on }: { on: boolean }) {
  return (
    <span className="flex w-4 shrink-0 justify-center" aria-hidden={!on}>
      {on ? <Check size={16} strokeWidth={2.2} aria-label="Showing" className="text-fg/80" /> : null}
    </span>
  )
}
