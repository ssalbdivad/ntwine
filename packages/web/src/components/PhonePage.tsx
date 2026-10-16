import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import * as RadixDialog from "@radix-ui/react-dialog"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { AlarmClock, ArrowLeft, Check, ChevronRight, Hourglass, LayoutGrid, Plus, Repeat, Settings as SettingsIcon } from "lucide-react"
import type { ScheduleView } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { displayTitle, futureSnoozedUntil, lastActiveLabelAt, queued, queueLabelAt, restIsWorking, sessionIndicatorKind, type SessionIndicatorKind } from "../groups.ts"
import { ageSpan, spanUntil } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { projectSlug } from "../lib/base-path.ts"
import { sameProjectAddress, squareCard, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { setTierFold, useTierFolds } from "../lib/crossProject.ts"
import { setLens, useLens } from "../lib/lens.ts"
import { listOverlay } from "../lib/listBands.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { agentSuffix, liveAgentCount, rowSecondLine, wakeAt } from "../lib/mobileBoardRow.ts"
import { phoneBands, phoneCounts, phoneSubtitle, type OverlayFor, type PhoneBand, type PhoneRow } from "../lib/phonePage.ts"
import { scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { BANDS, type BandKey } from "./BandLabel.tsx"
import { HistoryView } from "./HistoryView.tsx"
import { ScheduleMark } from "./ScheduleMark.tsx"
import { PhoneScheduleSheet } from "./PhoneScheduleSheet.tsx"
import { ThreadActionsSheet } from "./MobileThreadActionsSheet.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"

// THE PHONE'S PAGE — the desktop's left column for one hand (2026-10-14, after All projects first): the
// DOCK as the header, then the LIST — the desktop list's bands in its order, Pinned, Ready, Working,
// Waiting, Snoozed (folded), Done today (with History at its right) and Schedules (folded) — and a "New
// thread" button. Below the phone breakpoint (lib/mobile.ts, 700px) the page renders this instead of its
// desktop columns.
//
// WHAT IS THE DESKTOP'S, deliberately: the data and the vocabulary. The bands come from the list's own
// `loudBands` (lib/phonePage.ts phoneBands, mirroring components/TierList.tsx), their names and icons from
// the one band table (BandLabel.tsx BANDS), the dock's readings from ProjectDock.tsx, the fold state from
// the desktop's (lib/crossProject.ts), and History is the desktop's center tab (HistoryView.tsx). The VIEW
// is the page's too: All projects at `/`, a project at `/project/<slug>`, switched by navigating, so Back
// works and a reload keeps it. In All projects a row wears its project's square, as the desktop's rows do.
//
// WHAT IS THE PHONE'S, each the maintainer's call from upstream's mockup reviews (2026-08-17, 2026-09-30):
//
//   · TWO-LINE ROWS, the second saying what the thread wants (lib/mobileBoardRow.ts), a live sub-agent
//     count ("· 2 agents") standing in for the child rows.
//   · A RUNNING ROW WEARS A STATIC PLAY MARK, not the rail's travelling spinner, and NOTHING IN THE CHROME
//     ANIMATES: permanent motion in the corner of the eye is noise.
//   · NO COMPOSER ON THIS SCREEN. Starting a thread is the "New thread" button, at the thumb; a reply box
//     belongs to a thread. AN ASK IS MARKED BY THE ACCENT "?" AND NOTHING ELSE.
//   · THE LIST SCROLLS. The desktop's never does (lib/sidebarBudget.ts), because a column beside the queue
//     can give rows up to it; a phone's list is the whole screen, so it lists every row.
//
// Until 2026-10-14 a phone had its own shape of the board: a Projects page at `/`, and Queue (Pinned,
// Ready, Working and Waiting merged, asks first), Snoozed, Done and Schedules as tabs. When All projects
// moved to `/`, that Projects page took its address and All projects became unreachable on a phone.
//
// A schedule can be MADE from the New thread sheet: it holds the desktop's own prompt box, so `every
// weekday at 9 …` typed on the go becomes a schedule as it does at a desk (ARCHITECTURE.md § Scheduled
// threads); ScheduleComposer.tsx draws its strip as a tap row under `useIsMobile()`.
//
// A LONG-PRESS on a row opens the thread's ⋯ sheet (upstream 7d768576; useLongPress below), so every verb
// the thread page's ⋯ offers — snooze, Goal, files, rename, Mark as done on a running one — is one hold
// away from the list, for a row of any project. Upstream's swipe-to-triage is not ported.

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
 *  are one weight family on the rail. Only a `userSnoozed` row takes it; a worker's own park stays on the
 *  hourglass (as the resting card's event-snooze did until 2026-10-14). */
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
  // Parked — a worker's own declared wait, or a wait on a TIMER (and, until 2026-10-14, the human's
  // event-snooze). The row's dim, not the mark, is what separates the human's park from the worker's.
  if (kind === "snoozed" || kind === "parked" || kind === "timer") return <HourglassMark />
  if (kind === "done" || kind === "archived") return <DoneMark />
  // Awaiting a PR: the rail draws GitHub's octocat; the phone has no mark for it yet and stays at rest.
  return <StatusBox />
}

/**
 * One thread, full width: the mark, the title with its right-hand reading, and one line under it.
 *
 * No card: a card spends side margins and then its own padding on every row, which on a 390pt screen is
 * 64pt of a 358pt measure. The hairline is INSET to the text column (16 + 18 + 12 = 46, and 24 more with
 * a project square) so the glyph column reads as a gutter rather than as the first cell of a table.
 *
 * THE RIGHT-HAND READING depends on the band. In Ready it is how long the thread has waited — the queue
 * clock the desktop's cards and rows print, which is also the order Ready lists them in — and nothing for
 * one still in motion; in Snoozed when the thread wakes (`wakes 3h`); elsewhere the rest age.
 *
 * In All projects the row wears its PROJECT'S SQUARE in the gutter, as the desktop list's rows do: the
 * project is an attribute of a row, never a heading.
 */
type ThreadRowProps = { row: PhoneRow; band: PhoneBand; last: boolean; withProject: boolean; onLongPress: (row: PhoneRow) => void }

// MEMOIZED, so a board delta re-renders the row whose thread moved and no other (2026-10-16). Every delta
// rebuilds the bands — a fresh `row` per thread, and the focus's project object rebuilt with its thread
// lists — so by identity all of them re-rendered on each one: 13 rows x 13 deltas in 10s on a phone while
// ONE thread streamed. The thread compares by identity (a board snapshot keeps an unchanged thread's
// object, and the optimistic overlays return it as is), the project by what the row reads of it
// (sameProjectAddress, as the queue cards do), and the clock is the row's own subscription (useNowMs).
const ThreadRow = memo(ThreadRowView, (a: ThreadRowProps, b: ThreadRowProps) =>
  a.row.thread === b.row.thread &&
  a.row.key === b.row.key &&
  sameProjectAddress(a.row.project, b.row.project) &&
  a.band === b.band &&
  a.last === b.last &&
  a.withProject === b.withProject &&
  a.onLongPress === b.onLongPress)

function ThreadRowView({ row, band, last, withProject, onLongPress }: ThreadRowProps) {
  const { project, thread: t } = row
  const now = useNowMs()
  const open = useOpenThreadInPlace()
  const press = useLongPress(() => onLongPress(row))
  const kind = sessionIndicatorKind(t)
  // A rest time dates a HANDOFF, so a row that is still going has nothing to date — the rail's own rule,
  // read off the MARK (upstream MobileBoard): a row that reads at-rest carries the time that goes with it.
  // A shell or PR rest is in motion only when its worker called it `working` (groups.restIsWorking,
  // 2026-10-05): the same rest elsewhere is a handoff, and carries its rest time.
  const waitMoving = (kind === "background" || kind === "pr") && restIsWorking(t)
  const inMotion = t.runtime === "running" || t.runtime === "spawning" || kind === "working" || waitMoving
  const wakes = band === "snoozed" ? spanUntil(wakeAt(t, now), now) : null
  const at = queued(t) ? queueLabelAt(t) : lastActiveLabelAt(t)
  const right = band === "snoozed" ? (wakes ? `wakes ${wakes}` : null) : inMotion ? null : ageSpan(at, now)
  const line = rowSecondLine(t, kind, inMotion, now)
  const agents = agentSuffix(liveAgentCount(t))
  return (
    <div className={kind === "snoozed" || t.state === "archived" ? "opacity-[var(--mobile-dim-opacity)]" : undefined}>
      <button
        type="button"
        data-mobile-thread-row={row.key}
        {...press}
        onClick={() => open(project, t.id)}
        // No callout and no text selection: a hold on a row is the actions gesture, not a copy.
        style={NO_CALLOUT}
        className="flex w-full items-start gap-3 px-4 py-[11px] text-left active:bg-hover"
      >
        {withProject ? (
          <span className="-mr-1 flex shrink-0 items-start gap-2 self-baseline">
            <CapSlot size={ROW_SQUARE} fontSize={TITLE_PX}>
              <span data-mobile-row-project={project.slug} className={project.stale ? "grayscale" : undefined}>
                <ProjectSquare project={project.card ?? squareCard(project)} size={ROW_SQUARE} />
              </span>
            </CapSlot>
          </span>
        ) : null}
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
              {/* A terminal reads as its desktop row does (TerminalThreadRow.tsx): a dim mono `$`, at the desktop's
                  mono-to-sans ratio, inline so it keeps the title's baseline, then its name (its `@handle`). */}
              {t.kind === "terminal" && t.terminal ? (
                <span data-mobile-terminal-title className="min-w-0 truncate" title={`$ ${t.terminal.command}`}>
                  <span aria-hidden className="font-mono-keep text-[15px] leading-none text-muted-55">{t.terminal.handle ? "$" : "$ "}</span>
                  {t.terminal.handle
                    ? <span>{` ${t.terminal.handle}`}</span>
                    : <span className="font-mono-keep text-[15px] font-normal leading-none">{t.terminal.command}</span>}
                </span>
              ) : (
                <span className="min-w-0 truncate">{displayTitle(t)}</span>
              )}
              {t.schedule ? <ScheduleMark schedule={t.schedule} size="phoneRow" className="ml-1" /> : null}
            </span>
            {/* `leading-[16px]`, not the title's 21px: baseline-aligned to the 15.5px title, a 12px reading
                on a 21px line hung 1.25px below the title's line box, so every row with an age stood 1px
                taller than one without (64 against 63px, 2026-09-30). */}
            {right ? <span data-mobile-row-right className="shrink-0 text-[12px] leading-[16px] tabular-nums text-faint">{right}</span> : null}
          </span>
          {line || agents ? (
            // The agent count sits OUTSIDE the truncating span, so a long activity line ellipsizes before it
            // and never swallows it.
            <span data-mobile-row-line className="flex min-w-0 text-[13.5px] leading-[19px] text-muted">
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
      {last ? null : <div className="h-px bg-border/70" style={{ marginLeft: withProject ? 46 + ROW_SQUARE + 8 : 46 }} />}
    </div>
  )
}

/** A row's project square, in the gutter before its mark. */
const ROW_SQUARE = 16

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
 * A BAND'S HEADER — the desktop list's own (Sidebar.tsx SectionHeader): the band's icon, its name in the
 * uppercase label face and its count, from the one band table (BandLabel.tsx BANDS), a size up for a phone.
 * Snoozed and Schedules fold, as they do on the desktop, and share its fold state (lib/crossProject.ts);
 * Done today carries History at its right, as the desktop's does.
 */
function PhoneBandHeader({ band, count, label, attention = false, folded, onToggle, tail }: {
  band: BandKey | "schedules"
  count: number
  label?: string
  attention?: boolean
  folded?: boolean
  onToggle?: () => void
  tail?: ReactNode
}) {
  const { Icon, label: own } = band === "schedules" ? { Icon: Repeat, label: "Schedules" } : BANDS[band]
  // The icon's lift onto the 12px uppercase label's cap band: 0.09em, where the desktop's 11px header takes
  // 0.16em (BandGlyph). Measured (sans, Linux Chrome, path ink centre minus cap-band centre): -0.84px at
  // 0.16em, 0.00 at 0.09em for every band's icon; the chevron sits +0.12px box-centred and is left there.
  const body = (
    <>
      <span aria-hidden className="flex w-[18px] shrink-0 -translate-y-[0.09em] justify-center">
        <Icon size={13} />
      </span>
      <span>{label ?? own}</span>
      <span className={`ml-1 tabular-nums ${attention ? "font-semibold text-attention-soft" : "text-muted-60"}`}>{count}</span>
      {onToggle ? (
        <span aria-hidden className={`-ml-1 flex -translate-y-[0.08em] text-muted-60 transition-[rotate] ${folded ? "" : "rotate-90"}`}>
          <ChevronRight size={13} />
        </span>
      ) : null}
    </>
  )
  // The chevron tucks in to the count it folds (-ml-1): lucide's chevron is mostly empty box, and on the row's 6px
  // gap it stood 13.94px of ink off the count; 7.94px now (scripts/ink-gaps.mjs, sans, open).
  const face = `flex min-h-[40px] min-w-0 items-center gap-1.5 px-4 pt-3 pb-1 text-[12px] uppercase tracking-wide text-muted-70`
  return (
    <div data-mobile-band={band} className="flex items-center">
      {onToggle ? (
        <button type="button" aria-expanded={!folded} onClick={onToggle} className={`${face} flex-1 text-left active:text-fg`}>
          {body}
        </button>
      ) : (
        <div className={`${face} flex-1`}>{body}</div>
      )}
      {tail}
    </div>
  )
}

/** The header button's 44px round hit area (←, the gear). */
const HEADER_BUTTON = "flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
/** The view's name, over the list. */
const TITLE_TYPE = "text-[16.5px] font-semibold leading-[21px] tracking-[-0.01em] text-fg"

/**
 * The line under the view's name (lib/phonePage.ts phoneSubtitle). Its parts WRAP rather than truncate,
 * onto a second line the box clips: a part that does not fit is left out whole, instead of being cut to
 * "1 w…" mid-word.
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

export interface PhonePageProps {
  /** Every project, for the dock. */
  projects: QueuesProject[]
  /** The view's projects — the focused one, the lens's, or every one. */
  shown: QueuesProject[]
  /** The focused project, or undefined for All projects. */
  viewed: QueuesProject | undefined
  /** Focused on a project, its slug, even before the project list has it. */
  focusedSlug: string | undefined
  /** A queue card being finished or sent away (AllQueues.tsx useLeavingCards). */
  hidden: (key: string) => boolean
  loading: boolean
  error: string | undefined
  /** The prompt box, aimed where a new thread from this view goes; `onDispatched` closes its sheet, and
   *  `autoFocus` is false when the sheet was opened to show a chip without taking the caret
   *  (lib/editorBridge.ts composeInto). */
  composer: (onDispatched: () => void, autoFocus: boolean) => ReactNode
  /** Show All projects. */
  onAll: () => void
  /** Focus a project. */
  onProject: (project: QueuesProject) => void
}

/**
 * THE PHONE'S PAGE — the desktop's left column, for one hand: the dock as the header, then the list. History,
 * the desktop's center tab, is a screen of its own over the list: a HISTORY ENTRY (a state flag on the
 * page's own address), so a phone's Back — the edge swipe, Android's back button — puts it away again.
 */
export function PhonePage(props: PhonePageProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const history = (location.state as { phoneHistory?: boolean } | null)?.phoneHistory === true
  if (history) return <PhoneHistory {...props} onBack={() => navigate(-1)} />
  return <PhoneThreads {...props} onHistory={() => navigate(`${location.pathname}${location.search}`, { state: { phoneHistory: true } })} />
}

/**
 * THE DOCK, a phone's: All and every project's square in the machine-wide order, the view's ringed, the
 * desktop dock's readings on each — its Ready count in the accent badge, a tick under it while something
 * works (ProjectDock.tsx). A tap is the desktop's click: a project's page, and its square again back to All
 * projects. Squares a size up and each on a 40px hit area; the row scrolls sideways when the projects
 * outnumber the width, and the view's square is scrolled into it. No lenses, reorder or menus here: those
 * are a desk's.
 */
function PhoneDock({ projects, hidden, focusedSlug, onAll, onProject }: Pick<PhonePageProps, "projects" | "hidden" | "focusedSlug" | "onAll" | "onProject">) {
  const lens = useLens()
  const strip = useRef<HTMLDivElement>(null)
  const focused = focusedSlug !== undefined ? projects.find((p) => p.slug === focusedSlug) : undefined
  const allShowing = !focused && !lens
  const inView = (project: QueuesProject) => (focused ? focused.id === project.id : lens ? lens.has(project.id) : true)
  useLayoutEffect(() => {
    const current = strip.current?.querySelector<HTMLElement>('[aria-current="page"]')
    current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [focusedSlug])
  return (
    <div ref={strip} data-mobile-dock className="flex min-w-0 flex-1 items-center overflow-x-auto pl-2 scrollbar-none">
      <button
        type="button"
        data-mobile-dock-all
        aria-pressed={allShowing}
        aria-label="All projects"
        onClick={() => { setLens(null); onAll() }}
        className={`flex size-[40px] shrink-0 items-center justify-center rounded-lg active:bg-hover-strong ${allShowing ? "text-fg" : "text-muted"}`}
      >
        <LayoutGrid size={21} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
      </button>
      {projects.map((project) => {
        const ready = project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length
        const working = project.running.length
        const current = focused?.id === project.id
        return (
          <button
            key={project.id}
            type="button"
            data-mobile-dock-square={project.slug}
            aria-current={current ? "page" : undefined}
            aria-label={`${project.name}: ${ready} ready, ${working} working`}
            onClick={() => (current ? onAll() : onProject(project))}
            className={`relative flex size-[40px] shrink-0 items-center justify-center rounded-lg active:bg-hover-strong ${inView(project) ? "" : "opacity-40"}`}
          >
            <span className={`flex rounded-[6px] ${current ? "ring-[1.5px] ring-fg/75 ring-offset-2 ring-offset-bg" : ""} ${project.stale ? "grayscale" : ""}`}>
              <ProjectSquare project={project.card ?? squareCard(project)} size={DOCK_SQUARE} />
            </span>
            {ready > 0 ? (
              <span data-mobile-dock-ready={ready} className="absolute right-[1px] top-[2px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent-fill px-[4px] text-[10px] font-semibold leading-none tabular-nums text-on-accent shadow-[0_0_0_1.5px_var(--color-bg)]">
                {ready}
              </span>
            ) : null}
            {working > 0 ? <span data-mobile-dock-working={working} aria-hidden className="absolute bottom-[2px] left-1/2 h-[2px] w-[12px] -translate-x-1/2 rounded-full bg-fg/70" /> : null}
          </button>
        )
      })}
    </div>
  )
}

/** The dock's squares: the desktop's 20px a size up, for a thumb. */
const DOCK_SQUARE = 26

/** The fixed header: the dock and the gear, under the status bar's inset. */
function PhoneHeader({ children }: { children: ReactNode }) {
  // `env(safe-area-inset-top)`: on a notched phone the status bar sits over the top of the viewport, and no
  // headless shot has that inset — so this is a defect no screenshot here can show and every real device would.
  return (
    <div className="fixed inset-x-0 top-0 z-30 border-b border-border/70 bg-bg pt-[env(safe-area-inset-top)]">
      <div className="flex h-[56px] items-center gap-0.5 pr-0.5">
        {children}
        <button type="button" aria-label="Settings" data-mobile-settings onClick={() => (store.showSettings = true)} className={HEADER_BUTTON}>
          <SettingsIcon size={21} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  )
}

function PhoneThreads({ projects, shown, viewed, focusedSlug, hidden, loading, error, composer, onAll, onProject, onHistory }: PhonePageProps & { onHistory: () => void }) {
  const focused = focusedSlug !== undefined
  // The schedule whose sheet is up (PhoneScheduleSheet) — mounted means open.
  const [sheet, setSheet] = useState<ScheduleView | null>(null)
  // The row whose ⋯ sheet a long-press opened (ThreadActionsSheet) — mounted means open.
  const [actionsFor, setActionsFor] = useState<PhoneRow | null>(null)
  // In the store, not local state: an editor's selection opens it too (lib/editorBridge.ts composeInto).
  const composing = useSnapshot(store).phoneNewThread
  const setComposing = (open: boolean) => (store.phoneNewThread = open ? { focus: true } : null)
  // …and it closes with the list under it, as local state did: the desktop layout coming back must not
  // find a sheet left open.
  useEffect(() => () => { store.phoneNewThread = null }, [])
  // A different view is a different list to read: from its top.
  const viewId = focusedSlug ?? "*"
  const lastView = useRef(viewId)
  useEffect(() => {
    if (lastView.current === viewId) return
    lastView.current = viewId
    window.scrollTo(0, 0)
  }, [viewId])

  const now = useNowMs()
  const folds = useTierFolds()
  const { onPage, overlayFor } = useJustActed()
  const bands = phoneBands(shown, hidden, overlayFor, now)
  const subtitle = phoneSubtitle(phoneCounts(bands))

  // The view's schedules: the poll's count per project names the band, and the rows are read while it is open.
  const scheduleCount = shown.reduce((sum, project) => sum + (project.schedules?.count ?? 0), 0)
  const scheduleAttention = shown.some((project) => project.schedules?.attention === true)
  const schedulesOpen = folds.has("schedules")
  const schedules = useViewSchedules(shown, focused ? viewed : undefined, focused, schedulesOpen, scheduleCount, scheduleAttention)

  const title = focused ? (viewed?.name ?? focusedSlug) : "All projects"
  const open = bands.pinned.length + bands.ready.length + bands.working.length + bands.waiting.length
  const rows = (band: PhoneBand, list: readonly PhoneRow[]) =>
    list.map((row, index) => <ThreadRow key={row.key} row={row} band={band} last={index === list.length - 1} withProject={!focused} onLongPress={setActionsFor} />)
  const loud = (band: "pinned" | "ready" | "working" | "waiting") =>
    bands[band].length > 0 ? (
      <section key={band} aria-label={BANDS[band].label} data-mobile-tier={band}>
        <PhoneBandHeader band={band} count={bands[band].length} />
        {rows(band, bands[band])}
      </section>
    ) : null

  return (
    <div data-mobile-board={focused ? "project" : "all"} className="relative min-h-dvh bg-bg">
      <PhoneHeader>
        <PhoneDock projects={projects} hidden={hidden} focusedSlug={focusedSlug} onAll={onAll} onProject={onProject} />
      </PhoneHeader>

      {/* The list: 56 + 1 of header above; below, the "New thread" button's 50 plus 16 either side, so the
          last row scrolls clear of it and its age column is never under the button. */}
      <div className="flex min-h-dvh flex-col pb-[calc(82px+env(safe-area-inset-bottom))] pt-[calc(57px+env(safe-area-inset-top))]">
        <div className="px-4 pb-1 pt-3.5">
          <h1 data-mobile-board-title className={`m-0 truncate ${TITLE_TYPE}`}>{title}</h1>
          {!loading && !error ? <Subtitle subtitle={subtitle} /> : null}
        </div>
        {error ? (
          <EmptyBand label={`Could not read the queues: ${error}`} />
        ) : loading && open === 0 ? (
          <EmptyBand label="Loading…" />
        ) : (
          <div data-mobile-tiers>
            {(["pinned", "ready", "working", "waiting"] as const).map(loud)}
            {open === 0 ? (
              <p data-mobile-tiers-empty className="m-0 px-4 pb-2 pt-4 text-[15px] text-muted">
                No open threads. Tap New thread to start one.
              </p>
            ) : null}
            {bands.snoozed.length > 0 ? (
              <section aria-label="Snoozed" data-mobile-tier="snoozed">
                <PhoneBandHeader band="snoozed" count={bands.snoozed.length} folded={!folds.has("snoozed")} onToggle={() => setTierFold("snoozed", !folds.has("snoozed"))} />
                {folds.has("snoozed") ? rows("snoozed", bands.snoozed) : null}
              </section>
            ) : null}
            {/* Done today, every row of it — a phone's list scrolls, so it gives nothing up — and History,
                every Done thread past today, one tap away at its right, as on the desktop. Shown with no rows
                too, so History is always reachable. */}
            <section aria-label="Done today" data-mobile-tier="done">
              <PhoneBandHeader
                band="done"
                label="Done today"
                count={bands.done.length}
                tail={
                  <button type="button" data-mobile-open-history onClick={onHistory} className="mr-1 mt-2 flex h-[36px] items-center rounded-md px-3 text-[13px] text-muted active:bg-hover-strong">
                    History
                  </button>
                }
              />
              {rows("done", bands.done)}
            </section>
            {scheduleCount > 0 || schedulesOpen ? (
              <section aria-label="Schedules" data-mobile-tier="schedules">
                <PhoneBandHeader band="schedules" count={scheduleCount} attention={scheduleAttention} folded={!schedulesOpen} onToggle={() => setTierFold("schedules", !schedulesOpen)} />
                {!schedulesOpen ? null : schedules.error ? (
                  <p className="m-0 px-4 py-2 text-[14px] text-muted">Could not read the schedules: {(schedules.error as Error).message.slice(0, 120)}</p>
                ) : !schedules.data ? (
                  <p className="m-0 px-4 py-2 text-[14px] text-muted">Loading…</p>
                ) : (
                  <div data-mobile-schedules>
                    {schedules.data.map((schedule, index) => (
                      <ScheduleRow key={schedule.id} schedule={schedule} last={index === schedules.data!.length - 1} withProject={!focused} onOpen={() => setSheet(schedule)} />
                    ))}
                  </div>
                )}
              </section>
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
          // undefined once the row has left every band here, which closes the sheet.
          <ThreadActionsSheet
            slug={actionsFor.thread.id}
            project={shown.find((project) => project.id === actionsFor.project.id) ?? actionsFor.project}
            thread={Object.values(bands).flat().find((row) => row.key === actionsFor.key)?.thread}
            onClose={() => setActionsFor(null)}
          />
        )
      ) : null}
      {composing ? <PhoneNewThread onClose={() => setComposing(false)}>{composer(() => setComposing(false), composing.focus)}</PhoneNewThread> : null}
    </div>
  )
}

/**
 * HISTORY, a phone's: the desktop's center tab (HistoryView.tsx) — every Done thread in the view, by day,
 * each with its done card's ledger, and the search box over them — as a screen with a ← back to the list.
 */
function PhoneHistory({ shown, focusedSlug, onBack }: PhonePageProps & { onBack: () => void }) {
  const open = useOpenThreadInPlace()
  const lens = useLens()
  const focused = focusedSlug !== undefined
  const ids = focused || lens ? shown.map((project) => project.id) : undefined
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  return (
    <div data-mobile-history className="min-h-dvh bg-bg">
      <PhoneHeader>
        <button type="button" aria-label="Back" data-mobile-history-back onClick={onBack} className={HEADER_BUTTON}>
          <ArrowLeft size={21} strokeWidth={2.1} />
        </button>
        <h1 className={`m-0 min-w-0 flex-1 truncate pl-0.5 ${TITLE_TYPE}`}>History</h1>
      </PhoneHeader>
      <div className="px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(57px+12px+env(safe-area-inset-top))]">
        <HistoryView projectIds={ids} onOpen={(entry) => open({ id: entry.projectId, slug: entry.projectSlug, name: entry.projectName }, entry.thread.id, displayTitle(entry.thread))} />
      </div>
    </div>
  )
}

/**
 * What the operator has just done that the poll cannot know yet, folded into every project's rows the way
 * the desktop list folds it (lib/listBands.ts listOverlay): a reply sent from a drawer takes its row from
 * Ready to Working before the poll says so. The page project's drawer files those by bare slug; anything
 * else, by the thread's key — so `onPage` says which project is the page's own.
 */
function useJustActed(): { onPage: (project: QueuesProject) => boolean; overlayFor: OverlayFor } {
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const onPage = (project: QueuesProject) => project.slug === focus && live?.projectSlug === project.slug
  return { onPage, overlayFor: (project) => listOverlay(project.id, onPage(project), steeredAt, archivingAt) }
}

/**
 * The view's SCHEDULES — the focused project's through its own client, or every project's for All projects
 * (the palette's read), kept to the projects the view shows. Read while the band is open, and again whenever
 * the poll's count or attention for the view moves (both ride the key, as the desktop's band does).
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
 * One schedule, in the thread row's anatomy so the band reads as more of the same list: the repeat glyph in
 * the mark column, the title with its next run at the right — `in 3h`, or `Paused` / `Proposed` when it will
 * not run on its own, warning-toned when that is ntwine's doing or a proposal waiting — and the rule under it,
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
 * in the list under it.
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
