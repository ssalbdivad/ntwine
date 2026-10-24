import { Fragment, memo, useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AlarmClock, Bot, Check, ChevronRight, Ellipsis, Github, Hourglass, Loader2, Pin, PinOff, Repeat, RotateCcw } from "lucide-react"
import { terminalCommandCore, type ProjectCard, type ThreadView } from "@ntwine/shared"
import { pushSubAgentDrawer, showToast } from "../store.ts"
import { displayTitle, subAgentName, titleIsProvisional, isPinned, isSnoozed, sessionIndicatorKind, offersRetry, futureSnoozedUntil, queueLabelAt, waitNamesPr, prChecksRunning, restingOnSubAgents, restIsWorking, workingWithOpenQuestion } from "../groups.ts"
import { ageSpan, relativeAge } from "../lib/activityTime.ts"
import { limitPauseResume, limitPauseTitle } from "../lib/limitPause.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { humpStarts } from "../lib/threadMentions.ts"
import { BANDS, BAND_LABEL_TYPE, BandCount, type BandKey } from "./BandLabel.tsx"
import { BoxSpinner, STATUS_BOX } from "./BoxSpinner.tsx"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { STALLED_RETRY_MESSAGE, retrySession } from "../lib/retrySession.ts"
import { deliverProjectFollowUp } from "../lib/projectFollowUp.ts"
import { useThreadApi, useThreadIsForeignToPage, useThreadProjectDir, useThreadProjectId } from "../api/threadApi.tsx"
import { formatAutoSnoozedUntil, formatUserSnooze } from "../lib/snooze.ts"
import { ScheduleMark } from "./ScheduleMark.tsx"
import { formatCompactElapsed } from "../lib/durationLabels.ts"
import { statusElapsed } from "./ThreadStatusLine.tsx"
import { awaitingProse, awaitingWaitClause } from "../lib/awaitingPresentation.ts"
import { clearArchived } from "../lib/optimisticArchive.ts"
import { useAfterScopedWrite } from "../lib/scopedWrite.ts"
import { usePinToggle } from "../lib/pinThread.ts"
import type { ReactElement, ReactNode } from "react"
import { useSnapshot } from "valtio"
import { prefs } from "../lib/prefs.ts"
import { RailDeadline } from "./DeadlineControl.tsx"
import { terminalStateLabel } from "../lib/threadTerminals.ts"
import { TerminalRowTitle, RowRestartButton, terminalRowAge } from "./TerminalThreadRow.tsx"

// THE THREAD ROW — one thread as a line of a list, with its indicator, its title and trailers, and the
// verbs it offers on hover (pin, Retry, reopen). The tier list draws every project's threads with these
// (TierList.tsx), each row under its project's ThreadProjectScope.
//
// The file is named for the column it was written for: a project's own board, whose floating sidebar
// listed these rows in named bands. The board went with the project view on 2026-09-28 and came back
// on 2026-10-06 as `/project/<slug>`, banded under upstream's names. Since 2026-10-14 one list draws both
// views (TierList.tsx), with SectionHeader below over each band, and ARCHITECTURE.md § Board nomenclature
// fixes the bands' names.
//
// ENTIRELY MOUSE-DRIVEN: no arrow-walk, no selection chevron. A row CLICK opens the thread — in the list,
// through its RowScope: its card when the queue is showing it, else its drawer, in place.

// A row's hover-revealed icon action: sized to the title's FIRST line (h-[19px]; the group's top-1
// matches the row's pt-1) so it never exceeds the row height. Bare glyphs — the group draws no box
// around them (its backing is the rail's own base colour under the row's hover wash; see the strip in
// ThreadRow), and only the one under the pointer paints its own square.
// OPAQUE PAINT, TRANSLUCENT BOX — `text-muted opacity-70`, never `text-muted-70`. The unpin is a lucide
// glyph FILLED and STROKED in currentColor, and an SVG paints the stroke over the fill: with an alpha
// colour the ring lands at ~0.8 alpha where it overlaps the 0.7 fill, so the pin read as a darker
// outline around a lighter middle (maintainer 2026-09-11: "slightly dimmer in the middle. It looks
// insane"). Group opacity composites the finished glyph once, so fill and stroke read as one solid
// body. Identical for the stroke-only pin and Retry; `disabled:opacity-50` still wins, as a variant
// utility over a bare one.
export const ROW_ACTION_CLASS = "flex h-[19px] w-[19px] items-center justify-center rounded text-muted opacity-70 outline-none transition-[color,opacity] hover:bg-panel-2 hover:text-fg hover:opacity-100"

// A row's wash, painted by its `after:` pseudo ABOVE the row (see ThreadRow for why above). Lit on
// hover — and held lit, one step stronger, while the row's thread is up in the side drawer, the way a
// list keeps its selected row lit beside the detail pane it opened. That hold is the rail's half of
// saying where a thread opens: a Working row lights and the drawer beside it names the same band
// (BandLabel.tsx), while a Ready row lights nothing here because its thread is a card in the middle
// column, which the scroll marker already tracks. Stronger than hover so pointing at a neighbour
// cannot be mistaken for opening it.
function rowWashClass(open: boolean): string {
  return `after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:transition-opacity ${
    open ? "after:bg-hover-strong after:opacity-100" : "after:bg-hover after:opacity-0 hover:after:opacity-100"
  }`
}

/**
 * The page's left column — Everything's (AllQueues.tsx), which was the board's sidebar's — and the SLOT that
 * holds its place in the row. The column is `position: fixed` to the viewport, inside a slot of its own width
 * that keeps the queue beside it; its `left` is auto, so it sits wherever the slot's flow puts it.
 *
 * NOT `sticky`, which it was until 2026-10-08. Sticky is pinned by its ancestors' geometry, and the page moves
 * that geometry in more ways than anything can track: a root that declared its own overflow made a modal's
 * `body{overflow:hidden}` a scroll container that re-anchored it (2026-08-26, stickyScrollLock.e2e.test.ts);
 * a pinned page whose queue shrank under a drawer ended its container above the fold, which can never carry
 * a sticky box past its bottom (2026-10-07: the column at top -1200); and after a page-height patch for that
 * one, the maintainer still caught the column a few hundred px above the fold under an open drawer
 * (2026-10-08), by a path no seeded scenario reproduced. A fixed box answers only to the viewport (no
 * ancestor here sets a transform, filter or containment), so none of those can reach it.
 */
export const SIDEBAR_SLOT_CLASS = "w-[clamp(272px,34vw,680px)] shrink-0 max-[800px]:w-full"
export const SIDEBAR_COLUMN_CLASS =
  "fixed top-0 h-screen w-[clamp(272px,34vw,680px)] flex flex-col justify-center max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:justify-start max-[800px]:pt-16"

/**
 * Where a row's "open" leads. Every row is drawn in the tier list (TierList.tsx), where the
 * page project is the prompt box's pick and the row is usually another project's. Its verbs must not ask
 * the page: the row sits under a ThreadProjectScope, so pin, reopen and Retry go through its project's
 * own client (api/threadApi.tsx), and this says where "open" leads. Required: until 2026-09-28 a row
 * without one was a project board's, whose click scrolled to the row's card or opened a drawer by slug.
 */
export interface RowScope {
  /** "Show me this thread" — its card if the queue is showing one, else its drawer, in place. */
  open: (t: ThreadView) => void
  /** The row's project IS the page project, so a child row can open its own drawer here directly. */
  page: boolean
}

// One row of a band. A thread's live sub-agents are a count on the thread's row in All projects
// (SubAgentCount); on a project's board they are rows of their own under it (SubAgentRows), and the
// board passes `subAgentRows` so the count is not said twice. Its TERMINALS get no row and no mark
// (ThreadTerminals.tsx): the status dot, the queue and the thread's own strip already say everything one
// could (a title-trailing terminal glyph was dropped 2026-09-30 as noise).
export function RailRow({ t, active, open = false, restedAge = false, scope, cardKey, band, held = false, subAgentRows = false, leadProject, statusAlways = false, oneLine = false }: { t: ThreadView; active: boolean; open?: boolean; restedAge?: boolean; scope: RowScope; cardKey?: string; band?: BandKey; held?: boolean; subAgentRows?: boolean; leadProject?: ProjectCard; statusAlways?: boolean; oneLine?: boolean }) {
  return <ThreadRow t={t} active={active} open={open} restedAge={restedAge} scope={scope} cardKey={cardKey} band={band} held={held} subAgentRows={subAgentRows} leadProject={leadProject} statusAlways={statusAlways} oneLine={oneLine} />
}

// A BAND'S HEADER — its glyph, its NAME and its count, over its rows. ONE source of truth for every band
// header so they can never visually drift apart again (upstream's rule, Sidebar.tsx SectionHeader).
// Pinned, Queue and Running are never collapsible (upstream 2026-09-19: the Pinned, Queue and Running
// labels "should not be collapsible") and render as a static line; Snoozed, Done, External and Schedules
// pass `onToggle`, and the whole line is the fold's button, with the disclosure chevron in the row gutter
// — where the scroll marker and a project row's own chevron sit — so the glyphs stay in one column.
//
// THE ROW'S GEOMETRY, NOT UPSTREAM'S. The glyph stands in the INDICATOR column (`data-xq-indicator`, the
// 16px slot each row's state glyph stands in) and the name on the titles' column, so a band's name is
// strung on its project's cord like a row (ThreadConnector) and reads as the head of the column under
// it. The name and icon come from the band table (BandLabel.tsx), which the queue's header and a thread
// header's stamp read too — so the board's headers are the legend for the rest of the screen.
//
// 15px TALL, MEASURED against the rows either side (sans, 2026-09-29, when the fork named its loud bands
// this way): the name's 11px capitals are 8px of ink, and a row's 13px title leaves ~7px of its own line
// box and padding clear above and below its ink, so at 15px the name stands ~10.5px off the row above and
// ~9.5px off the row below — a gap each way that reads as a break in the list, where 12px left the name
// touching the titles and 19px (a row's line) read as an empty row. It is also what lets the board carry
// a header over each band and still show upstream's 22 rows at 1440x900 (capacityParity.e2e.test.ts):
// upstream's headers were 24.5px, and the board has no room for that.
export function SectionHeader({ band, count, collapsed, onToggle, attention = false, label: named, tail, roll = false }: {
  band: BandKey | "schedules"
  count: number
  collapsed?: boolean
  onToggle?: () => void
  /** The count in the warning tone: one of the band's rows wants the human (a paused schedule). */
  attention?: boolean
  /** A name other than the band's own — the tier list's "Done today". */
  label?: string
  /** Right-aligned beside the header, outside its fold button: a reading or a link (TierList.tsx). */
  tail?: ReactNode
  /** The count rolls up as it rises (BandCount). */
  roll?: boolean
}) {
  const { Icon, label: own } = band === "schedules" ? SCHEDULES_BAND : BANDS[band]
  const label = named ?? own
  const body = (
    <>
      {onToggle && (
        // In the row gutter (x 4.5, where a project row's own chevron stands), as a flex item rather than an
        // overlay so it can sit on the label's baseline: its negative margins hand the 15.5px back, and the
        // glyph after it stays in the indicator column.
        <span aria-hidden data-band-chevron className={`${BAND_MARK} -ml-[15.5px] -mr-[3.5px] w-[11px] text-muted-60 transition-[rotate] ${collapsed ? "" : "rotate-90"}`}>
          <ChevronRight size={11} />
        </span>
      )}
      <span data-xq-indicator className={`${BAND_MARK} w-4`}>
        <Icon size={11} />
      </span>
      {/* The count rides right beside its name, as it does on the queue's header (BandLabel.tsx): `gap-1`
          and the count's own `ml-1.5`, 10px, where the line's `gap-2` would have stood it 14px off. */}
      <span className="flex min-w-0 items-baseline gap-1">
        <span>{label}</span>
        {attention ? <span className="ml-1.5 tabular-nums text-attention-soft">{count}</span> : <BandCount count={count} roll={roll} />}
      </span>
    </>
  )
  const className = `${BAND_HEADER} ${BAND_LABEL_TYPE}`
  if (!onToggle) {
    const line = (
      <div data-band-header={band} data-xq-band-label={band} className={`${className} ${tail ? "flex-1" : ""}`}>
        {body}
      </div>
    )
    return tail ? <div className="flex min-w-0 items-baseline">{line}<HeaderTail>{tail}</HeaderTail></div> : line
  }
  const verb = collapsed ? "Show" : "Hide"
  const button = (
    <button
      type="button"
      data-band-header={band}
      data-xq-band-label={band}
      // Folding a band reshapes the list by the human's own hand (lib/listHold.ts): the list follows it.
      data-xq-reshape
      aria-expanded={!collapsed}
      title={`${verb} ${label.toLowerCase()}`}
      onClick={onToggle}
      className={`${className} w-full rounded-md text-left outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
    >
      {body}
    </button>
  )
  return tail ? <div className="flex min-w-0 items-baseline">{button}<HeaderTail>{tail}</HeaderTail></div> : button
}

/** A header's right-hand reading, in the rows' reading type and on their right edge (pr-1.5), on the
 *  header's own line: the header is 15px with its name 4px down (pt-1), so the tail takes the same. */
function HeaderTail({ children }: { children: ReactNode }) {
  return <span data-band-tail className="flex h-[15px] shrink-0 items-baseline whitespace-nowrap pl-3 pr-1.5 pt-1 text-[10.5px] text-muted-55">{children}</span>
}

/** The header's line — see SectionHeader. `pl-5` and `gap-2` put the glyph in the indicator column and the
 *  name on the titles' column; `items-baseline` so each mark can sit on the name's cap band (BAND_MARK). */
const BAND_HEADER = "relative flex h-[15px] min-w-0 items-baseline gap-2 pl-5 pr-1.5 pt-1"
/**
 * A mark beside the band's name — the glyph in the indicator column, the fold's chevron in the gutter — ON
 * THE NAME'S CAP BAND, computed by the browser rather than fitted: the 1em box's bottom sits on the name's
 * baseline (`self-baseline`; a box with no baseline of its own offers its bottom edge) and the translate
 * lowers its centre from half an em to half a cap above it. Lucide draws both glyphs symmetrically in
 * their boxes, so the box centre is the ink centre. Box-centred on the 15px line instead, every glyph and
 * the chevron read 1.34px low (sans, 11px, 2026-10-06); the residual after this is in the commit.
 */
const BAND_MARK = "flex h-[1em] shrink-0 justify-center self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
/** Schedules are no band of the rail's — not threads — so their name and glyph are their own: the repeat
 *  mark every surface draws for a schedule. */
const SCHEDULES_BAND = { label: "Schedules", Icon: Repeat }

// A THREAD'S SUB-AGENTS, AS ROWS UNDER IT — on a project's board, as upstream's sidebar drew them (upstream
// Sidebar.tsx SubAgentRows): the shared ChildOpRow at "rail" density, indented to clear the parent row's
// indicator column, nested one step per depth so a fanned-out branch reads as the tree it is. A click
// opens the sub-agent's drawer over the page; the × retires it (stops a live one, clears a finished one),
// through the row's own project's client. The liveness policy is the rail's (lib/childOps.ts
// visibleChildOps). All projects keeps the COUNT on the thread's row instead (SubAgentCount): there every
// project's threads share one column, and a branch of rows under each would push the next project's work
// off the screen (David 2026-10-01: "usually people won't want to click on it from that view").
export function SubAgentRows({ t, scope }: { t: ThreadView; scope: RowScope }) {
  const api = useThreadApi()
  const subs = visibleChildOps(t.subAgents ?? [], "rail")
  if (subs.length === 0) return null
  return (
    <div data-xq-subagent-rows={t.id} className="flex flex-col">
      {subs.map((s) => (
        <ChildOpRow
          key={s.id}
          kind="AGENT"
          label={s.label}
          state={s.state}
          density="rail"
          depth={s.depth}
          startedAt={s.startedAt}
          parentSlug={t.id}
          // Its drawer is the page project's to open. A row of another project (never on a board, whose
          // rows are all the page's) opens its thread instead, where the sub-agent is one click on.
          onOpen={() => (scope.page ? pushSubAgentDrawer(t.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt }) : scope.open(t))}
          onDismiss={childOpDismisser(t.id, s, "AGENT", api)}
          // The rail has no room for the worker-profile tag the ops strip can show, so it rides the tooltip.
          title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
        />
      ))}
    </div>
  )
}

// The title's trailing adornment, the provider mark, is an ATOMIC inline box, and the line breaker is
// free to break right BEFORE it even though no whitespace separates it from the title. On a wrapping title that regularly stranded the provider
// mark ALONE on a second line, with the whole title above it (maintainer 2026-07-31: "often the only
// thing that breaks onto the new line is the agent icon"). Glue them to the title's LAST WORD in a
// nowrap group so the pair wraps together instead.
//
// The group takes the whole last word when it is short enough to fit the narrowest rail beside the
// adornments, and otherwise just its TAIL — gluing a rail-wide token whole would overflow instead of
// wrapping. Cutting a long token is safe: an element boundary mid-word adds no break opportunity of
// its own, so the head still breaks exactly where `break-words` would have broken it, and the mark
// keeps a dozen characters of company either way.
//
// A HANDLE is one token with its words joined by hyphens (`ship-the-resolver-fix`, groups.ts
// displayTitle), so its word starts (humpStarts) stand in for the spaces: the last is the word the mark
// glues to, and a `<wbr>` before every other one lets a handle wider than the rail wrap BETWEEN its
// words rather than wherever `break-words` runs out of room mid-word. A browser already breaks after a
// hyphen, so for a kebab handle the `<wbr>` restates that; it was load-bearing while handles were
// camelCase (until 2026-09-30), when one wrapped as "shipTh / eResolverFix".
const MAX_GLUED_TITLE_WORD = 16
const GLUED_TITLE_TAIL = 12
export function TitleWithTrailers({ title, children }: { title: string; children: ReactNode }) {
  const text = title.trimEnd()
  const humps = text.includes(" ") ? [] : humpStarts(text).slice(1)
  const wordStart = humps.length > 0 ? humps.at(-1)! : text.lastIndexOf(" ") + 1
  const cut = text.length - wordStart <= MAX_GLUED_TITLE_WORD ? wordStart : text.length - GLUED_TITLE_TAIL
  if (cut >= text.length) return <>{title}{children}</>
  const breaks = humps.filter((i) => i < cut)
  const head = text.slice(0, cut)
  return (
    <>
      {breaks.length === 0
        ? head
        : [0, ...breaks].map((start, i) => (
            <Fragment key={start}>
              {i > 0 && <wbr />}
              {head.slice(start, breaks[i] ?? cut)}
            </Fragment>
          ))}
      <span className="whitespace-nowrap">{text.slice(cut)}{children}</span>
    </>
  )
}

// One THREAD row: the derived session indicator, the title and the provider mark. NO Mark-as verb —
// session threads use Archive in the persistent thread footer. A click opens the thread through the
// row's scope (RowScope). A LEGACY `.ntwine` row, with a status chip and the hover-revealed Mark-as split
// button, was drawn only by the project board's Legacy shelf, and went with it on 2026-09-28.
//
// MEMOIZED: board deltas REPLACE a changed thread's whole object, so `t` keeps snapshot identity iff
// unchanged — memo skips exactly the untouched rows.
export const ThreadRow = memo(function ThreadRow({
  t,
  active = false,
  open = false,
  restedAge = false,
  scope,
  cardKey,
  band,
  held = false,
  subAgentRows = false,
  leadProject,
  statusAlways = false,
  oneLine = false,
}: {
  t: ThreadView
  active?: boolean
  /** This thread is up in the side drawer right now — see rowWashClass. */
  open?: boolean
  /** Show the right-justified rest-time column. The CUE's rows only — see RestedAge. */
  restedAge?: boolean
  /** Where a click leads — see RowScope. */
  scope: RowScope
  /** A Ready row's card on Everything (`threadKey`) — what the thread across the gutter ties it to
   *  (ThreadConnector). */
  cardKey?: string
  /** The band the list drew this row in, as `data-xq-band` — Ready and Working carry no name over their
   *  rows (TierList.tsx), so this is how a script tells them apart. */
  band?: BandKey
  /** Drawn where the list last put it, not where it now belongs: the list is held under the pointer
   *  (lib/listHold.ts). Drawn exactly like any row; `data-xq-held` is for scripts. */
  held?: boolean
  /** Its sub-agents are rows of their own under it (a project's board, SubAgentRows), so it draws no
   *  count of them. */
  subAgentRows?: boolean
  /** All projects' tier list (TierList.tsx): the project's square in the row's left gutter, on the first
   *  row of each run of one project's threads — the rows interleave projects, so the square is what says
   *  whose a row is. Beside the scroll marker, which sits at the gutter's left edge. */
  leadProject?: ProjectCard
  /** Draw a working row's status inline always, not only on hover — the tier list, which spends the width
   *  the project headings used to take on the most useful thing a working row can say. */
  statusAlways?: boolean
  /** One line: the title truncates rather than wraps, so every row is one line tall and the tier list can
   *  budget its height (lib/sidebarBudget.ts). */
  oneLine?: boolean
}) {
  const foreign = t.foreign === true
  // Snoozed rows are uniformly grayed as a whole; provisional titles retain their local dim treatment.
  // Only the human snoozes (shared isSnoozed): a worker's own park, `watching` included, stays undimmed.
  const snoozed = isSnoozed(t)
  // A DONE THREAD IS GRAYED WHEREVER IT ROWS — the Done band, and the pinned band just the same
  // (maintainer 2026-09-11: "a thread that's marked as done should always be grayed out, even if it's
  // pinned"). The pin freezes a row's PLACE, never its state, so the dim has to ride the ROW rather than
  // the band it happens to sit in; the two dims share one treatment so the rail has exactly one way of
  // saying "nothing here is moving". Read off the row's STATE, not the indicator: a Done row whose
  // worker is still draining a turn wears the spinner (groups.ts sessionIndicatorKind, shared
  // doneButRunning) and is still Done — dimmed, and still the human's to uncheck.
  const done = t.state === "archived"
  const dim = snoozed || done
  // The done CHECK is a real checkbox on a row ntwine owns: unchecking it reopens the thread. A foreign
  // row is read-only (the server has no session to write), so its check stays a plain mark.
  // A Done TERMINAL reopens by running again (its card's Restart or a `$` line), not by an uncheck.
  const terminal = t.kind === "terminal" ? t.terminal : undefined
  const uncheckable = done && !foreign && !terminal
  const dimLabel = titleIsProvisional(t)
  // A WORKING thread's status, and its task clock in the right-edge column a rested row gives its rest
  // time (ThreadStatusLine.tsx statusElapsed). The status is drawn inline in grey after the name while the
  // row is pointed at, or always with Settings → Always show status lines (prefs `alwaysShowStatusLines`).
  const nowMs = useNowMs()
  const { alwaysShowStatusLines: statusPref } = useSnapshot(prefs)
  const alwaysShowStatusLines = statusPref || statusAlways
  const elapsed = statusElapsed(t, nowMs)
  const terminalAge = terminal ? terminalRowAge(terminal, nowMs) : undefined
  // A terminal's name is its `@handle`, minted once from its FIRST command and never changed (it is an
  // address); what it runs now — a follow-up typed into its drawer replaces the command — is its status line.
  // An interactive shell's command is only the shell's name, which says nothing a status should.
  // A leading `cd <dir> &&` is set aside to a quiet `in <dir>` tail, so the line opens on what runs.
  const terminalCore = terminal?.handle && !terminal.shell ? terminalCommandCore(terminal.command) : undefined
  const terminalStatus = terminalCore ? `$ ${terminalCore.command}${terminalCore.dir ? ` · in ${terminalCore.dir}` : ""}` : ""
  const working = terminalAge ? { status: terminalStatus, elapsed: terminalAge } : elapsed && t.statusLine ? { status: t.statusLine.trim(), elapsed } : undefined
  const inlineStatus = working?.status || undefined
  // The rows with an obvious single next action carry that verb INLINE, instead of making you open the
  // thread to find it. offersRetry (groups.ts) picks them: a STALLED row (the [!] mark — process
  // exited) AND a row KILLED by a usage limit ntwine will auto-resume (the yellow hourglass — a faster
  // door to the in-drawer "Continue now" than waiting for the window). The queue card and drawer header
  // read the SAME helper, so no surface can disagree with the rail about which threads offer Retry.
  const canRestart = offersRetry(t)
  // A failed or interrupted terminal's one verb is Restart, a faster door to its card's.
  const canRestartTerminal = terminal !== undefined && !done && t.needsYou === true && terminal.state === "exited"
  // Whether the row has any hover verb at all: the pin on every row ntwine owns, Retry on a stalled one.
  // A terminal thread ntwine only reads offers neither, so it keeps its rest time under the pointer rather
  // than trading it for an empty strip.
  const hoverActions = !foreign || canRestart || canRestartTerminal
  // A pinned row wears the mark in its right-edge column AND places the unpin verb rightmost in the
  // hover strip; both read this one predicate so the two can never disagree.
  const pinned = isPinned(t)
  // A ROW IS ITS TITLE, AND NOTHING ELSE (maintainer 2026-08-19: "there should never ever be any fucking
  // thing in the sidebar except for the fucking title"). There is no subtitle line on any row, in any
  // state: not the fence's PR ref, not a snooze, not the legacy `.ntwine` activity gloss, not a sub-agent
  // count line. Every one of them was a second, competing status beside the row's own — the rail is a column
  // of NAMES you scan, and each caption added there made the next one harder to find.
  //
  // A WORKING thread's status sits ON THE SAME LINE, in grey after its name, as David had it from
  // 2026-09-29 ("it should display in grey text next to the name of the thread inline"): it costs no line,
  // only rows that are spinning carry it, and it truncates before the name gives up a character. By
  // default it is drawn only while the row is pointed at or focused, with just the task clock on the line
  // otherwise: upstream's call (standup 2026-10-01: always-visible status lines are too dense for the
  // sidebar, put them in hover states). The reveal is the same inline text, not a tooltip (David
  // 2026-10-07). Settings → Always show status lines (prefs `alwaysShowStatusLines`) keeps it drawn.
  //
  // What ntwine knows about the row still exists, one hover away: the indicator's popover composes it
  // from the AWAITING BLOCK deterministically (awaitingWaitClause) plus the worker's own handoff prose, so
  // the detail is available on demand and never spends a line of the rail. Live sub-agents are the other
  // reading that costs no line: a quiet count in the right-edge column (SubAgentCount). That is the same call that
  // hid the SNOOZED label (2026-08-03) and the worker's reason (2026-08-16), applied to the last of them.
  //
  // THE HOVER WASH IS AN `after:` PSEUDO PAINTED ABOVE THE ROW, not a background under it. The hover
  // actions overlay the title's first line and need an opaque backing (a long title's last words would
  // otherwise show through the glyphs); painting the wash on top lets that backing be the rail's plain
  // base colour and still match the lit row exactly — in every state and every frame of the fade. As a
  // `hover:bg-*` under the strip, the backing had to be a second, guessed colour, and it read as a
  // darker box around the buttons (maintainer 2026-09-03). `pointer-events-none`, so it never shadows a
  // click on the row or its actions; `rounded-md` because the row clips nothing.
  return (
    <div
      data-sidebar-item={t.id}
      data-sidebar-open={open || undefined}
      // Strung on its project's cord at its indicator, card or none (ThreadConnector).
      data-xq-thread-row
      data-xq-rail-row={cardKey}
      data-xq-band={band}
      data-xq-held={held || undefined}
      className={`group relative flex min-w-0 items-start rounded-md transition-[color,opacity] ${rowWashClass(open)} ${dim ? "sidebar-row-dim" : ""}`}
    >
      {/* The reading position owns a real, in-row rail rather than borrowing the status-icon column.
          The marker spans the row's complete visual height, including wrapped titles and subtitles,
          while the fixed rail keeps it from shifting content or relying on clipped overflow. */}
      <span aria-hidden="true" data-sidebar-marker-rail className="pointer-events-none absolute inset-y-0 left-0 w-5">
        {active && <span data-sidebar-scroll-marker className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
        {/* 12px, right of the marker and 2px clear of the indicator column (pl-5), level with the title's
            first line: pt-1 plus half of what the 19px line leaves around it. */}
        {leadProject && (
          <span data-xq-row-project className={`absolute left-[6px] flex ${oneLine ? "top-[5.5px]" : "top-[7.5px]"}`}>
            <ProjectSquare project={leadProject} size={12} />
          </span>
        )}
      </span>
      <button
        // The row cannot measure its card or open a drawer by slug — both would be the page project's,
        // and the row is usually another project's — so its scope says where it goes.
        onClick={() => scope.open(t)}
        aria-current={active ? "location" : undefined}
        // One-line rows (the tier list) are 23px, not 27: nothing in them wraps, so the 4px a side a
        // wrapped title needs to breathe is density the budget can spend on another row.
        className={`min-w-0 flex-1 flex items-start gap-2 pl-5 pr-1.5 text-left ${oneLine ? "py-0.5" : "pb-1 pt-1"}`}
      >
        {/* h-[19px] so the indicator centers on the title's FIRST line, not the middle of a wrapped row. */}
        <span data-xq-indicator className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          {/* An uncheckable row draws its check in the overlay button below instead — a button cannot
              nest inside this one — so the column is held empty here to keep the title where it is. */}
          {!uncheckable && <ThreadIndicator t={t} />}
        </span>
        <span className="min-w-0 flex-1 flex flex-col">
          {/* items-BASELINE, not items-center: the rest time is a smaller type size sitting beside the
              title, and the eye reads the two as one line only when their baselines agree. On a WRAPPED
              title flex aligns the FIRST baseline, so the label stays on the title's first line where
              the row's other right-edge affordance (RowRetryButton) also lives. */}
          {/* gap-3, not gap-2. The measured gap is usually 20–40px of ink (ragged-right titles rarely
              reach their box edge), but the case that decides the number is the line that DOES fill:
              8px is ~2 word spaces at 13px, which reads as the title running into its own timestamp.
              12px is a gutter, and it costs the title 4px it does not miss. */}
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {/* With a working status beside it the title keeps its whole width (and wraps if it must)
                  and the status truncates into what is left; without one the title fills the line. */}
              <span className={`min-w-0 ${oneLine ? "truncate" : "break-words"} text-[13px] leading-[19px] ${inlineStatus ? `max-w-full ${oneLine ? "shrink" : "shrink-0"}` : "flex-1"} ${dimLabel ? "text-provisional" : dim ? "text-fg/75" : "text-fg/90"}`}>
                {terminal ? <TerminalRowTitle terminal={terminal} /> : (
                  <TitleWithTrailers title={displayTitle(t)}>
                    {/* A schedule's run, or its next run: the repeat glyph, before the provider (ScheduleMark). */}
                    {t.schedule && <ScheduleMark schedule={t.schedule} className="ml-1" />}
                    <ProviderMark backend={t.backend} model={t.model} className="ml-1" />
                  </TitleWithTrailers>
                )}
              </span>
              {/* The same inline status either way; by default it is drawn only while the row is pointed at
                  or focused. The title keeps its width (shrink-0) in both, so the reveal moves nothing. */}
              {inlineStatus && (
                <span
                  data-rail-status
                  data-rail-status-hover={alwaysShowStatusLines ? undefined : ""}
                  className={`min-w-0 flex-1 truncate text-[12px] leading-none text-muted-70 ${alwaysShowStatusLines ? "" : "hidden group-hover:block group-focus-within:block"}`}
                  title={inlineStatus}
                >
                  <TitleStrut />
                  {inlineStatus}
                </span>
              )}
            </span>
            {/* The time limit's countdown, first in the column: over time it is the loudest thing on the row
                (DeadlineControl RailDeadline). Nothing on a Done row. */}
            <RailDeadline thread={t} yieldsToRetry={hoverActions} />
            {!subAgentRows && <SubAgentCount t={t} yieldsToRetry={hoverActions} />}
            {working && <WorkingAge elapsed={working.elapsed} yieldsToRetry={hoverActions} />}
            {/* The Retry verb is an OVERLAY pinned to this same right edge, so on the rows that offer
                it the two would collide — a 19px opaque button landing halfway across "20 seconds",
                which reads as a rendering fault rather than an affordance. The label gives way to it
                on hover instead: the button is why you pointed at the row. */}
            {restedAge && <RestedAge t={t} yieldsToRetry={hoverActions} />}
            {/* A pinned row wears the small solid pin in this same right-edge column (the cue's
                rest-time spot — the approved mockup's variant A), and yields to the hover actions the
                same way the rest time does. Never both: the pinned band passes no restedAge. A WORKING
                pinned row keeps it too, rightmost after its task clock, where the unpin appears on
                hover (David 2026-09-30: "i shouldnt have to mouse over a thread to see that it is
                pinned" — gating the mark on `!working` hid it on every spinning pinned row). */}
            {pinned && !restedAge && <PinnedMark besideClock={!!working} />}
          </span>
        </span>
      </button>
      {uncheckable && <RowUncheckDone t={t} />}
      {/* ONE-CLICK RECOVERY on a stalled OR limit-killed row (offersRetry). Hover-revealed and
          pinned to the row's right edge, over the title's first line (it OVERLAYS rather than taking
          layout, so pointing at a row never reflows its wrapped title). `group-focus-within` keeps it
          reachable from the keyboard: focus the row button and the next Tab lands here. */}
      {/* THE ROW'S HOVER ACTIONS, pinned to the right edge over the title's first line — exactly where
          the cue's rest time sits, which yields to them on hover (maintainer 2026-08-28: the expand icon
          "should replace where the current time rest duration currently is"). A row ntwine owns gets the
          pin; a stalled/held row gets Retry after it, because recovery is the verb the row is pointing
          at. A fullscreen door stood between them until 2026-09-28.

          NO BOX around the strip (maintainer 2026-09-03: "drop the background color around the icon
          buttons"). It still needs an OPAQUE backing — it overlays the title's first line, and a long
          title's last words would show through the glyphs — so the backing is the rail's base colour
          (`bg-bg`), with a short gradient off its left edge that dissolves the covered letters instead
          of slicing one in half. Both are invisible because the row's hover wash paints ABOVE them (the
          `after:` pseudo on the row), so the strip is exactly the row's colour whether hovered,
          keyboard-focused or snoozed. The old opaque `bg-panel` pill sat UNDER the wash and read as a
          darker box on the lit row. */}
      {hoverActions && (
        <div className={`absolute right-1.5 ${oneLine ? "top-0.5" : "top-1"} hidden items-center gap-0.5 bg-bg group-hover:flex group-focus-within:flex before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-r before:from-transparent before:to-bg`}>
          {/* The pin sits LEFT on a row that can be pinned (the approved mockup's order). On a PINNED row
              the same button is the unpin and goes RIGHTMOST — after Retry too —
              because it is the hover form of the mark in the row's right-edge column: the mark fades and
              the unpin appears where it was (maintainer 2026-09-03: "unpin button should be far right for
              pinned threads on hover"). Not on a foreign row: the server refuses to pin what it does not
              own, so no button rather than a throwing one. */}
          {/* MEASURED 2026-09-03 (scripts/ink-gaps.mjs on sidebar-pin-fixture, dsf 4), with the fullscreen
              door then standing between the pin and Retry: on the strip's uniform 2px gap the OUTLINE
              pin's ink sat 12px from the door where door→Retry read 10px and Retry→unpin 10.5px, because
              the pin is a narrow glyph (8×11 of ink in a 19px box, dead 6/5). The pin's box is trimmed 2px
              on its right so the strip reads ONE gap. RE-MEASURE rather than re-guess if a glyph, its size
              or the gap changes. */}
          {!foreign && !pinned && <RowPinButton t={t} className="-mr-0.5" />}
          {canRestart && <RowRetryButton t={t} />}
          {canRestartTerminal && <RowRestartButton t={t} className={ROW_ACTION_CLASS} />}
          {!foreign && pinned && <RowPinButton t={t} />}
        </div>
      )}
    </div>
  )
})

// A ROW'S SMALL READINGS SIT ON THE TITLE'S LINE, NOT ON A LINE OF THEIR OWN. A reading is set smaller than
// the title (10.5px against 13px) and baseline-aligned with it, and a smaller font on the same 19px leading
// hangs more of its line box BELOW the baseline — so the title's line and the reading's, aligned on one
// baseline, spanned 20px, and every row carrying a rest time or a clock was 28px where the rest were 27
// (measured 2026-10-06 on a project's board: every Queue row 28, every Pinned and Running row 27). That
// was a pixel a row: 15 of them at the capacity load (capacityParity.e2e.test.ts), most of a row the
// board could have shown. So a reading's own leading is none, and an empty inline box in the TITLE's
// type stands in its line (TitleStrut): the line box is the title's exactly, in any font, and the digits
// keep their baseline — the same pixel they were drawn on before.
const READING_TYPE = "text-[10.5px] leading-none text-muted-55"
function TitleStrut() {
  return <span aria-hidden className="text-[13px] leading-[19px]" />
}

// THE CUE'S RIGHT-HAND COLUMN — how long ago this thread came to REST (maintainer 2026-08-08: "a
// right-justified label on each item in the cue indicating when the thread came to rest").
//
// The instant is `queueLabelAt`, the same one the band is ORDERED by — so the column reads monotonically
// down the cue instead of disagreeing with the order it is printed in. For a plain rest that is the
// agent's own last output (`lastAssistantAt`), never the tailer's last record of any kind, so a completed
// background sub-agent cannot bump a rested row's reading to "just now". For a thread that rested behind
// a wait it is when the wait let it into the queue (2026-09-24, when the cue became a real queue): its
// old rest time would print "2h" below a row reading "5m".
//
// It carries the SPAN without "ago" (lib/activityTime ageSpan) because the column position is the
// "ago", and it is right-justified rather than trailing the title so the whole cue reads as one column
// of times — a title's length must not decide where its timestamp sits. `useNowMs` is the app's single
// 30s wall clock, so a screenful of these ticks on one timer.
export function RestedAge({ t, yieldsToRetry }: { t: ThreadView; yieldsToRetry?: boolean }) {
  const now = useNowMs()
  const at = queueLabelAt(t)
  const span = ageSpan(at, now)
  if (!at || !span) return null
  return (
    <time
      dateTime={at}
      data-rail-rested-age
      title={relativeAge(at, now) ?? undefined}
      // The row's accessible name concatenates its parts, and a bare "2 days" arriving after the title
      // says nothing about WHAT took two days. The label names the reading for that reader; the visible
      // text stays bare, because sighted readers have the column to tell them.
      aria-label={`${t.queuedAt ? "Ready" : "Rested"} ${relativeAge(at, now) ?? span}`}
      // shrink-0 + tabular-nums: the column must not compress under a long title, and the digits must
      // not jitter horizontally when the clock ticks. The title takes the remaining width and wraps.
      className={`shrink-0 tabular-nums ${READING_TYPE} ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      <TitleStrut />
      {span}
    </time>
  )
}

// The stalled row's recovery verb: a SMALL GREY icon button that restarts the exited session in ONE
// click, without opening the thread. Deliberately the SAME verb, icon, message and RPC path as the
// thread header's Retry (lib/retrySession) — the row is just a faster door to it. Named "Retry", not
// "Restart", because "restart" already means the ntwine control plane restarting itself
// (RestartNtwineButton) and the two must not blur.
function RowRetryButton({ t }: { t: ThreadView }) {
  const slug = t.id
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  // Off its own page (Everything's project list) the page's eager follow-up would address the wrong
  // server, so a scoped row sends through its project's own client — the queue card's own Retry.
  const scopedProject = useThreadProjectId()
  const scopedDir = useThreadProjectDir()
  const afterWrite = useAfterScopedWrite()
  const retry = (): Promise<void> => {
    if (!scopedProject) return retrySession(queryClient, slug)
    return deliverProjectFollowUp({ projectId: scopedProject, projectDir: scopedDir, slug, sessionId: t.sessionId }, STALLED_RETRY_MESSAGE)
      .then(() => { showToast("Retrying…"); afterWrite() })
      .catch((error: unknown) => showToast(`Retry failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 80)}`))
  }
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        data-sidebar-retry={slug}
        aria-label="Retry exited session"
        disabled={busy}
        // Keep DOM focus off the button on click so the reveal doesn't outlive the pointer, and stop
        // the press from reaching the row (which would navigate to the thread as well as retry it).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          retry().finally(() => setBusy(false))
        }}
        // One of the row's hover actions (see the group in ThreadRow): sized to the title's first line,
        // quiet grey, no border/accent — the muted-icon idiom of the header actions.
        className={`${ROW_ACTION_CLASS} disabled:opacity-50`}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
      </button>
    </Tooltip>
  )
}

// THE PINNED ROW'S MARK — the small solid pin at the row's right edge, in the column the cue's rest
// time occupies, muted to that column's weight. An IN-FLOW flex item (like RestedAge, unlike the hover
// overlay) so a wrapping title breaks before it instead of running underneath, and it yields to the
// hover actions the same way the rest time yields to Retry. The pin stays FILLED but keeps its stroke:
// lucide's needle is a stroke-only line (`M12 17v5`) with no fill area, so strokeWidth 0 would erase it
// and leave a headless blob (measured on the pin mockup sheet, 2026-09-02).
//
// IT WEARS THE HOVER STRIP'S OWN BOX, and that is the whole point: `h-[19px] w-[19px]` centring a 12px
// glyph is exactly ROW_ACTION_CLASS's geometry, so the mark and the unpin button that replaces it on
// hover occupy the SAME 19px slot and the pin does not move — it only swaps for the slashed glyph
// (maintainer 2026-09-03: "it should be in the exact same place when you hover versus not hover").
// The two coincide BY CONSTRUCTION, in both app fonts, at every rail width:
//   HORIZONTAL — this box ends at the button's `pr-1.5` content edge and the strip is anchored
//     `right-1.5` on the same row, so both right edges land on the same x.
//   VERTICAL — `self-start` pins this box to the flex line's cross-start, which is the button's `pt-1`
//     content top; the strip's `top-1` is that same offset from the row. Neither reading depends on the
//     font's metrics, so nothing here needs re-fitting when the type scale moves.
// It replaced a hand-placed `relative top-[calc(5.5px - 0.5cap)]` that sat an 11px mark on the title's
// CAP band (0.01px residual in both fonts) — a better vertical in isolation, but its ink centre landed
// 4.00px RIGHT of the unpin's and 0.09px (sans) / 0.66px (mono) above it, so the glyph jumped every
// time the pointer arrived. This slot centres on the title's first LINE BOX instead, which is where the
// hover verbs have always sat; an absolutely positioned strip cannot reach the in-flow baseline the
// `cap` correction needs, so the whole slot agreeing beats one mark in it being sub-pixel more correct
// at rest. What that costs, measured: the resting pin's ink now ends 4.5px inside the rest time's,
// where the 11px mark ended 0.8px inside it — the hover square's own dead space, and the same inset the
// fullscreen door that stood in the strip then had.
//
// `-ml-1` is a layout trim, not spacing: this slot is 8px wider than the 11px mark it replaced, and
// without the trim the title's own box pays all of it. Giving 4px back leaves the ink gap from a filled
// title line to the pin at 14.0px, against 14.29px before this change.
//
// `besideClock` (a WORKING pinned row, whose task clock stands left of the mark) trims 10px instead:
// the row's gap-3 plus the pin's 6px of dead box drew 14.34px of ink between "12m" and the pin, which
// read as two columns; `-ml-2.5` leaves 8.34px (scripts/ink-gaps.mjs on sidebar-pin-fixture, sans, dsf 4,
// 2026-09-30). The mark stays the flex line's last box, so the unpin still lands exactly on it.
function PinnedMark({ besideClock = false }: { besideClock?: boolean }) {
  return (
    <span
      aria-hidden
      data-rail-pin-mark
      // `text-muted opacity-55`, not `text-muted-55`: the mark is filled AND stroked, and an alpha colour
      // compounds where the stroke overlaps the fill — see ROW_ACTION_CLASS. The hover hide is the same
      // opacity axis, and the variant wins over the bare 55.
      className={`${besideClock ? "-ml-2.5" : "-ml-1"} flex h-[19px] w-[19px] shrink-0 items-center justify-center self-start text-muted opacity-55 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0`}
    >
      <Pin size={12} fill="currentColor" />
    </span>
  )
}

// The pin/unpin verb — one of the row's hover actions (ThreadRow places it: leftmost to pin, rightmost to
// unpin), on every row the server can pin: sessions ntwine owns, in any state,
// because the pin deliberately outranks Done and Snoozed alike. THE FILL IS THE STATE: an outline pin
// offers to pin, and the solid body with the slash — the same solid pin the pinned row's mark wears —
// offers to unpin, so a filled pin anywhere on the rail means "pinned" and nothing else (maintainer
// 2026-09-02: "use the solid pin icon to make sure that the icons are consistent everywhere";
// 2026-09-03: "the pin icon should be unfilled for unpinned threads").
//
// OPTIMISTIC (lib/optimisticPin.ts): the row moves on the click, not on the server's answer, and the
// button is never disabled meanwhile — a dimmed button waiting on a round trip is what read as an
// unresponsive click. A fixture's row (no project scope) has no list to move, so it just waits.
function RowPinButton({ t, className = "" }: { t: ThreadView; className?: string }) {
  const { pinned, toggle } = usePinToggle(t)
  return (
    <Tooltip label={pinned ? "Unpin — return this thread to the rail's bands" : "Pin — keep this thread at the very top"}>
      <button
        data-sidebar-pin={t.id}
        aria-label={pinned ? "Unpin thread" : "Pin thread"}
        // Same two guards as Retry: keep DOM focus off the button so the hover reveal doesn't outlive
        // the pointer, and stop the press from reaching the row (which would also open the thread).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        // `className` carries a layout trim the strip decides per position (see ThreadRow's readings).
        className={`${ROW_ACTION_CLASS} ${className}`}
      >
        {pinned ? <PinOff size={12} fill="currentColor" /> : <Pin size={12} />}
      </button>
    </Tooltip>
  )
}

// UNCHECKING DONE — the rail's [✓] is a checkbox, and clearing it reopens the thread. The server's
// `setThreadState(open)` flips ONLY the lifecycle column; everything the board derives the row from
// (fence, open questions, runtime, watches) is untouched, so the row lands back in whatever band and
// wears whatever mark it would have had without the archive — a pending question reads "?" and queues
// again, a bare rest returns to the cue. Two things the archive did are NOT undone, because they cannot
// be: Mark as done STOPPED a resting worker (so a reopened bare rest reads as stalled, with Retry), and
// it cleared any snooze.
//
// Overlaid on the row's indicator column (same `pl-5`/`pt-1` offsets as the row button), not nested
// in it, for the same reason the hover actions are overlays: a button inside the row's button is
// invalid markup and swallows the row's own click.
function RowUncheckDone({ t }: { t: ThreadView }) {
  const [busy, setBusy] = useState(false)
  const api = useThreadApi()
  const afterWrite = useAfterScopedWrite()
  // The page's optimistic overlays are keyed by bare slug for the PAGE project's rail; a row of another
  // project must not touch them (api/threadApi.tsx useThreadIsForeignToPage).
  const scoped = useThreadIsForeignToPage()
  // A Done row still moving draws the SPINNER here, not the check (doneButRunning): the box is still the
  // uncheck, and the label says both halves so the glyph under the pointer is not a mystery.
  const mark = sessionIndicatorKind(t)
  const label = mark === "working" ? "Done, still working — uncheck to reopen" : "Done — uncheck to reopen"
  return (
    <Tooltip label={label} side="left">
      <button
        type="button"
        role="checkbox"
        aria-checked
        aria-label={label}
        data-sidebar-uncheck-done={t.id}
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          // A Mark-as-done from the last few seconds may still have its optimistic hint up, and that hint
          // would hold the row under Done over the server's reopen until it expired.
          if (!scoped) clearArchived(t.id)
          api
            .setThreadState({ slug: t.id, state: "open" })
            .then(afterWrite)
            .catch((error: unknown) => showToast(`Reopen failed: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`))
            .finally(() => setBusy(false))
        }}
        className="absolute left-5 top-1 flex h-[19px] w-4 items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
      >
        {/* The indicator's NODE, not ThreadIndicator: that wraps its own "Done" tooltip, and this
            button's tooltip already says it — nested, the two would open together. */}
        <span data-rail-glyph={mark} className="flex items-center justify-center">{sessionIndicatorFor(t).node}</span>
      </button>
    </Tooltip>
  )
}

/** THE ROW'S POPOVER — ONE SENTENCE about the wait, then the worker's own sentence under it.
 *
 *  The rail's rows are TITLE-ONLY (see ThreadRow), so this is the only place the wait is legible, which
 *  means it has to READ rather than merely be complete. The first cut stacked one fragment per hint
 *  kind and the reason under that — four lines of record, no sentence anywhere in it (maintainer
 *  2026-08-19: "that popover text looks fucking terrible"). Now the state and what it is waiting on are
 *  joined into one clause, exactly the shape every other tooltip on this rail already has ("Stalled —
 *  the agent's process exited"):
 *
 *      Snoozed until tomorrow at 11:11 AM — waiting on acme/app#391 and a background shell
 *
 *      the tap submission is queued behind their CI backlog
 *
 *  The STATE leads because it is what the glyph you pointed at is claiming; the fence's clause follows
 *  because it says what that glyph means on THIS row; the worker's own prose takes a PARAGRAPH of its
 *  own, because it is the one line ntwine did not write. The blank line is load-bearing: the sentence
 *  above it wraps, and a reason set directly under a wrapped line reads as its third line — which is
 *  exactly how it looked when they were merely stacked. Nulls and blanks drop out, so a row with no
 *  fence is just its state. */
// `tail` is one more clause AFTER the fence's own — the timer arm's countdown — so the sentence still
// reads state, then what is waited on, then when: "At rest — waiting on a timer — fires in 34m".
function popover(t: Pick<ThreadView, "lastFence">, state: string | null, tail: string | null = null): string {
  const hints = t.lastFence?.kind === "awaiting" ? t.lastFence.hints : []
  const wait = awaitingWaitClause(hints)
  const head = [state, wait, tail].filter((part) => Boolean(part)).join(" — ")
  return [head, awaitingReason(t)].filter((line) => Boolean(line)).join("\n\n")
}

/** The worker's own prose for this row's POPOVER — the fence's Markdown body, else the `reason:` line a
 *  fence written before 2026-08-24 may still carry, as one sentence. awaitingProse owns both halves of
 *  that; see it for why reading only `reason:` silently dropped the handoff of every fence written in the
 *  current frontmatter shape. Null when the fence carries neither, which is an ordinary park. */
export function awaitingReason(t: Pick<ThreadView, "lastFence">): string | null {
  if (t.lastFence?.kind !== "awaiting") return null
  return awaitingProse(t.lastFence)
}

// ── the working clock (one per working row) ──────────────────────────────────────────────────────

// How long a working thread has been on the task its inline status names — the rested row's rest-time
// column and type, so a rail's right edge always reads as "time", whichever band the row is in.
// A THREAD'S LIVE SUB-AGENTS, AS A COUNT IN THE RIGHT-EDGE COLUMN — a robot and `5`, left of the clock.
// They were rows of their own under the thread until 2026-10-01, then one folded "5 sub-agents" line;
// either way every busy thread took two lines of a rail that is meant to be a column of names, for a
// list nobody opened from there (David 2026-10-01: "usually people won't want to click on it from
// that view"). The count is every child the drawer would list, at every depth — a workflow and each
// agent it fanned out — under the rail's liveness policy (lib/childOps.ts visibleChildOps). The names
// ride the tooltip; the children themselves are one click away on the card and in the drawer, which is
// where the row's own click already goes.
//
// SPOKEN AS A COUNT: glyph first, then digits, a 10px glyph 3px from them, in the column's type and grey. It yields to the hover actions as the clock does.
//
// THE BOT'S FACE SITS ON THE DIGITS' CAP BAND, NOT ITS INK BOX: the antenna is a hairline and the eye
// reads the face, so centring the whole ink (antenna included) left the face riding low beside the
// number (David 2026-10-01: "alignment super needs to be fixed"). In lucide's 24-unit box the
// face's ink (rect y 8–20 plus its stroke) centres at y 14, which is 4.17px above the bottom of a 10px
// box; `self-baseline` puts that bottom on the baseline, and the translate lifts the face's centre to
// half the cap height. Measured residual ~0 (sans, 10.5px); `cap` keeps it right in any font.
function SubAgentCount({ t, yieldsToRetry }: { t: ThreadView; yieldsToRetry?: boolean }) {
  const subs = visibleChildOps(t.subAgents ?? [], "rail")
  if (subs.length === 0) return null
  const names = subs.map((s) => subAgentName(s.label)).join(", ")
  return (
    <span
      data-rail-subagents={t.id}
      title={names}
      aria-label={`${subs.length} ${subs.length === 1 ? "sub-agent" : "sub-agents"}`}
      className={`flex shrink-0 items-baseline gap-[3px] ${READING_TYPE} ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      <span aria-hidden className="flex self-baseline translate-y-[calc(4.17px_-_0.5cap)]">
        <Bot size={10} />
      </span>
      <span className="tabular-nums">
        <TitleStrut />
        {subs.length}
      </span>
    </span>
  )
}

function WorkingAge({ elapsed, yieldsToRetry }: { elapsed: string; yieldsToRetry?: boolean }) {
  return (
    <span
      data-rail-working-age
      aria-label={`On this task for ${elapsed}`}
      className={`shrink-0 tabular-nums ${READING_TYPE} ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      <TitleStrut />
      {elapsed}
    </span>
  )
}

// ── the indicator (one per row) ──────────────────────────────────────────────────────────────────

// Each indicator carries a terse hover tooltip naming the state it signals. A plain wrapper <span> is
// the tooltip trigger (a real DOM node Radix can ref).
export function ThreadIndicator({ t, status }: { t: ThreadView; status?: string }) {
  // No steer special-case here: the glyph is derived from `t` alone, by the same decision that bands the
  // row. The project list overlays a just-sent steer onto the thread before it gets here (lib/listBands.ts
  // listOverlay), so `t` already reads as running and the ordinary derivation returns the spinner. When this
  // hook consulted the steer hint on its own, the glyph and the placement were two rules and drifted apart
  // on every steer.
  const { node, tip: stateTip } = sessionIndicatorFor(t)
  // A caller may add a thread's STATUS under the state, as the 2026-09-29 version had it. The rail's rows
  // do not: theirs is inline (ThreadRow).
  const tip = status ? (stateTip ? `${stateTip}\n${status}` : status) : stateTip
  // The resolved kind, on the shipped markup. Cheap, and it is what lets the rail's own glyphs be
  // measured where they actually render (scripts/verify-rail-status-glyphs.mjs holds the family to one
  // weight band) instead of against a reconstruction that can drift from the real thing.
  const mark = sessionIndicatorKind(t)
  if (!tip) return <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span>
  return (
    // A live row that is ALSO snoozed stacks its park under its state ("Working" / "Snoozed until …"),
    // so the tooltip has to keep that newline rather than reflowing the two into one sentence.
    <Tooltip label={tip} side="left" multiline={tip.includes("\n")}>
      <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span>
    </Tooltip>
  )
}

// The SESSION-first row indicator (kind === "session"). A "?" is reserved for a concrete unresolved
// input state: question/ask, typed interaction, native selector, permission prompt, or explicit human
// block. Queue membership by itself is only a handoff: a bare rested thread keeps the ordinary
// ellipsis. Everything the human is not on the hook for remains quieter: a spinner (in motion), a
// muted hourglass (intentional hold), a quiet check (done/archived), or the at-rest ellipsis.
// STATUS = a markdown-task CHECKBOX family (maintainer 2026-07-10, Obsidian-flavored): every state is
// the SAME rounded-rect outer box with a glyph inside, so the rail reads like a to-do list.
//   [ ] idle        — at rest, nothing pending (empty box)
//   [/] in progress — the rounded-RECT spinner (a segment travels the box perimeter): this thread's own
//                     turn. SINCE 2026-09-20 THE SPINNER IS ALSO THE FRAME for every row something will
//                     wake, and the mark inside says what (maintainer: "everything in the running rail
//                     should always have this spinner animation going"): empty for an own turn, the
//                     ellipsis for a parent at rest with a live SUB-AGENT out (restingOnSubAgents — the
//                     children spin on their own rows), the blue dot below for a shell, the octocat for
//                     a PR. SINCE 2026-10-05 A REST SPINS ONLY WHEN ITS WORKER CALLED IT `working`
//                     (groups.restIsWorking): a queued rest and a `watching` one draw the same glyph in
//                     the static box, because the Running band is the only band that moves.
//   [•] background  — at rest with only a detached background SHELL still running (never a sub-agent —
//                     maintainer 2026-08-01): a SOLID blue dot. It was a pulsing dot in a static box until
//                     2026-09-20; the motion moved to the frame and the dot went solid ("a solid,
//                     non-pulsing blue dot"). Inside the spinner on a `working` rest, in the static box
//                     everywhere else — the queue, and the Snoozed band (see shellDot).
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent's PROCESS EXITED with the work unfinished (accent box + "!"), whether
//                     it died mid-turn or exited after resting without a done fence. Same mark either
//                     way, because the next action is the same: Retry. Exactly the rows that carry the
//                     inline Retry verb (offersRetry === this kind — one decision, two surfaces).
//   [⧗] on the clock — awaiting a TIMER (muted hourglass), in the queue or parked in Snoozed alike; the
//                     Snoozed band's other parks wear the mark of what they wait on (the octocat for a
//                     PR, the dot for a shell). See hourglassMark.
//   [⏰] snoozed     — the human's OWN wall-clock park (muted alarm clock): the one wait the operator
//                     set rather than the worker, and the one that rings for THEM. See alarmMark.
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   […] at rest     — an ordinary rest with no concrete ask, INCLUDING a queued thread whose own
//                     dispatched sub-agents are still running (they spin on their own child rows)
// Attention (needs-input / stalled) wears the accent; everything else is muted.
/** Shared mark and state description: desktop uses a hover tooltip, mobile speaks the state as its
 *  accessible label. Tests can also pin the text directly without opening a tooltip. */
export function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const base = sessionStateIndicatorFor(t)
  // The tooltip is now the ONLY place a snooze is legible on the rail (the subtitle no longer names it),
  // so it has to say so on every parked row — not just the ones the park actually quiets. The alarm-clock
  // arm below already tells that story for a Snoozed row. These are the rows a snooze does NOT silence:
  // one whose own turn is running, and one still waiting on a sub-agent it dispatched. Each keeps its
  // live glyph — MOTION is a fact about the process that a park does not change — and gains a second
  // line saying when the park takes effect.
  // A CONCRETE ASK USED TO BE THE THIRD such row, and it was the one case where the rail lied: the
  // server dequeues a user-snoozed thread before it ever reaches its ask gates (deriveNeedsYou), so the
  // [?] pointed at a card that did not exist on any surface (2026-08-31 — see sessionIndicatorKind). It
  // takes the alarm clock now, and that arm names the ask the park is holding.
  if (sessionIndicatorKind(t) === "snoozed") return base
  const snoozedUntil = futureSnoozedUntil(t)
  const parked = snoozedUntil ? formatUserSnooze(snoozedUntil, t.snoozePrompt) : null
  if (!parked) return base
  return { node: base.node, tip: stackParked(base.tip, parked) }
}

/** A snooze stacks under the row's STATE, never under the worker's own prose.
 *
 *  That prose is a PARAGRAPH — see `popover`, which sets it off with a blank line precisely so a wrapped
 *  state sentence and a human one cannot be read as one run of lines. Appending the park to the end
 *  would land it inside that paragraph and undo exactly that. */
function stackParked(tip: string | null, parked: string): string {
  if (!tip) return parked
  const [state, ...reason] = tip.split("\n\n")
  return [`${state}\n${parked}`, ...reason].join("\n\n")
}

// THE ONE MARK FOR "A BACKGROUND SHELL IS ALIVE BEHIND THIS ROW" — the same blue and the same pulse as
// the transcript's live-shell dot, sized to this box (styles.css .ntwine-rail-dot), so both surfaces say
// it in one language. It is drawn by BOTH background arms below, and that is the whole point: the
// Active one (`kind === "background"` — resting on a live shell, undimmed) and the parked one (the same
// thread after the human snoozed its resting card) are ONE fact about the process, and a park does not
// change it. The parked arm wore lucide's CircleDashed until 2026-08-31, which said only "waiting on
// something" — a generic mark for the one state the rail already had a specific one for (maintainer:
// "we use blue dots to represent background shells … if we're not using a blue dot for a thread that's
// awaiting a background shell, then what do we use it for?"). What separates the two is the BAND, which
// dims a snoozed row, and the tooltip, which names the park; the mark itself stays the shell's.
//
// THE DOT MUST NEVER CLAIM LIFE THAT IS NOT THERE (see restingOnLiveBackgroundWork's long note in
// groups.ts, where a green PR wearing this dot was the bug). It cannot here: every arm that draws it is
// already gated on the server's own `awaitingBackground` verdict — an honoured park, checked against
// telemetry the browser cannot see — so by the time either arm runs, the work behind it is live. The
// `agent` hint rides along on the shell's blue rather than the accent-yellow a sub-agent pulses
// elsewhere: in the Snoozed band it marks a sub-agent its worker called a WATCHER (`status: watching`,
// 2026-10-05) — the only shape that parks with a live child — and the child spins on its own row.
//
// SINCE 2026-09-20 THE DOT SITS INSIDE THE SPINNER AND NO LONGER PULSES. The maintainer's rule for the
// Running band is that every row spins and the mark inside says what is alive ("an empty square if the
// thread is actively running … a blue dot if there's a background shell, a solid, non-pulsing blue
// dot"). The motion moved from the dot to the frame: the spinner says "something will wake this", the
// solid dot says "it is a shell". The pulse was the dot's way of saying alive-not-moving while the box
// stood still; with the box tracing, a pulsing dot inside it would be two animations for one fact.
//
// AND SINCE 2026-10-05 THE FRAME SPINS ONLY IN THE RUNNING BAND. The same dot sits in the static box on a
// queued shell rest and in the Snoozed band (`restingShellDot`): a spinner there claimed the thread was
// working when its worker had stopped for the human or parked on a watcher (maintainer 2026-10-03:
// "it looks like it's actively working on stuff, but it's obviously not"). StatusBox and the spinner's
// children slot share one 13px content box, so the dot lands on the same pixels in both frames.
const shellDot = <BoxSpinner><span aria-hidden className="ntwine-rail-dot" data-running-indicator="thread-background" /></BoxSpinner>
const restingShellDot = <StatusBox><span aria-hidden className="ntwine-rail-dot" /></StatusBox>

// THE OCTOCAT IS THE ONE MARK IN THIS FAMILY WHOSE INK IS NOT CENTRED IN ITS OWN VIEWBOX, so it is the
// one that needs a correction rather than just an odd size. `items-center justify-center` centres the
// glyph's BOX in the 13px content box — which it does correctly — and the mark still reads left, because
// lucide's github path is asymmetric inside its 24-unit grid: the head/body/legs path is centred, but the
// TAIL sweeps out to x=1 while nothing balances it on the right, so the ink ends at 21.01 instead of 23.
//
// MEASURED as the four CLEARANCES between the ink and the box's inner edge, which is the reading that
// matches the complaint ("icon spacing is broken"). At the shipped 9px:
//
//   nudge              L      R      T      B     L−R     T−B
//   none             2.75   3.50   2.75   2.75   -0.75   0.00   ← the mark hugs the left wall
//   x only  (ships)  3.13   3.12   2.75   2.75   +0.01   0.00
//   x and y          3.13   3.12   3.13   2.38   +0.01  +0.75   ← rejected; see below
//
// ONE LUCIDE GRID UNIT, sideways only — `size / 24`, not a hand-fitted decimal. One unit is exactly what
// the geometry asks for (the ink bbox centre sits 0.99 units left of the box's 12), and deriving it from
// `size` means it survives a resize of the mark, which a pinned 0.375px would not.
//
// NO VERTICAL NUDGE, and this is the part worth keeping, because the obvious instrument argues for one.
// An intensity-weighted centroid reads the glyph 0.33px HIGH — the head is a thick closed loop while the
// legs beneath it are single strokes, so the mark's MASS genuinely sits above its middle. Correcting to
// that centroid moves the whole glyph down and turns a vertical clearance that was exactly balanced
// (2.75 / 2.75) into 3.13 / 2.38: the legs then crowd the bottom wall while the ears gain a gap, which
// is the same defect being fixed sideways, recreated on the other axis. The top-heaviness is intrinsic
// to the LOGO and cannot be translated away — only redistributed — so the bbox stays balanced and the
// residual mass offset stands. Rendered side by side at dsf 8 the untouched vertical is plainly better.
const PR_MARK_SIZE = 9
const PR_MARK_NUDGE = PR_MARK_SIZE / 24

// THE ONE MARK FOR "THIS THREAD IS WAITING ON A PULL REQUEST", drawn by both arms that can reach that
// state — the parked one in the Snoozed band and the queued one below it — for the same reason shellDot
// is shared: the PR is the fact, and which band the row happens to sit in is only how it is presented
// (maintainer 2026-09-04: "the GitHub icon should show up anytime that an agent is awaiting a PR").
//
// The glyph alone, so the same octocat can sit inside the static box (settled checks) and inside the
// spinner (checks running) — one glyph, two frames; see the `pr` arm.
const githubGlyph = <Github size={PR_MARK_SIZE} className="text-muted-70" style={{ transform: `translateX(${PR_MARK_NUDGE}px)` }} />
const githubMark = <StatusBox>{githubGlyph}</StatusBox>

// The at-rest ellipsis, alone, for the same reason: the bare-rest arm draws it in the static box, and
// since 2026-09-20 the `working` arm draws it inside the spinner for a parent resting on its sub-agents.
const ellipsisGlyph = <Ellipsis size={11} className="text-muted-70" />

// THE ONE MARK FOR "THIS THREAD IS PARKED ON THE CLOCK" — the muted hourglass, drawn by every arm whose
// row is waiting for an instant the WORKER set: a park with no fence to read, and since 2026-09-07 a
// wait on a TIMER in whichever band it sits. (A user snooze wore it too until 2026-09-19; it is the
// alarm clock below now.) A timer park QUEUES (board.deriveNeedsYou
// keeps it a visible handoff), so most timer waits live below the rule in the Rested band, and there the
// row wore the shell's blue dot — groups.restingOnLiveBackgroundWork counted an armed timer as motion —
// while the SAME wait parked in Snoozed drew lucide's Clock. Three readings of one fact (maintainer:
// "an item in the queue that's awaiting a timer should show up with the hourglass icon in the sidebar,
// not with the flashing blue dot"). The clock is gone with it: the rail already had a word for "on the
// clock", and the limit kill's accent hourglass is this same glyph in the attention colour, so the
// family stays one glyph in two tones rather than two glyphs for one idea.
const hourglassMark = <StatusBox><Hourglass size={9} className="text-muted-70" /></StatusBox>

// THE ONE MARK FOR "THE HUMAN SNOOZED THIS" — the muted alarm clock, on the row whose park the OPERATOR
// set on a wall clock (futureSnoozedUntil), whether it re-surfaces the card or resumes the worker with a
// prompt. Until 2026-09-19 it wore the hourglass above, which made the operator's own park read as one
// more of the worker's timer waits (maintainer: "something that's snoozed … switch it over to some kind of
// icon that's like Zs, or an alarm clock"). An alarm is the snooze metaphor everyone already carries, and
// lucide has no Zs. Size 9, like the hourglass: the box's content is 13px, so only an ODD size centres
// on a whole pixel, and 11 would put the clock's bells and feet — which reach its viewBox edge — over
// the 0.62 extent ceiling the family holds to. The verify script has the readings
// (scripts/verify-rail-status-glyphs.mjs, the `user-snoozed` slot).
const alarmMark = <StatusBox><AlarmClock size={9} className="text-muted/70" /></StatusBox>

/** "fires in 34m" for the SOONEST armed timer — the resting card's TimerRow countdown, so the rail's
 *  hover and the card never count down in two vocabularies. The row drops the verb its "Timers" heading
 *  implies ("in 34m"); this tooltip is a sentence with no heading, so it keeps it. A due-but-undelivered
 *  timer (the scheduler's tick runs seconds behind the instant) says "firing…" rather than a negative
 *  countdown. Null when no armed row carries an instant, which today is never — the board only
 *  synthesizes armed rows, each with one. */
function timerWake(t: Pick<ThreadView, "watches">, nowMs = Date.now()): string | null {
  const soonest = (t.watches ?? [])
    .filter((w) => w.kind === "timer" && w.state === "armed")
    .map((w) => Date.parse(w.timer?.fireAt ?? ""))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)[0]
  if (soonest === undefined) return null
  return soonest > nowMs ? `fires in ${formatCompactElapsed(soonest - nowMs)}` : "firing…"
}

function sessionStateIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const kind = sessionIndicatorKind(t)
  // A TERMINAL THREAD wears the same family, read off its process (groups.ts sessionIndicatorKind): the
  // spinner while it runs, "?" at a prompt, "!" when it failed or was interrupted, the check once Done.
  if (t.kind === "terminal" && t.terminal) {
    const said = terminalStateLabel(t.terminal)
    const tip = said.charAt(0).toUpperCase() + said.slice(1)
    if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>, tip: `Done — ${said}` }
    if (kind === "needs-input") return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip }
    if (kind === "stalled") return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip: `${tip} — restart it, or run another command` }
    if (kind === "working") return { node: <BoxSpinner />, tip }
  }
  // A HELD THREAD (ThreadView.held) is an EMPTY box: the same box Done fills with its check, so an unstarted thread reads
  // as an unchecked box. Done and a snooze keep their own marks; only an open, unparked held thread wears it.
  if (t.held !== undefined && kind !== "archived" && kind !== "done" && !t.snoozedUntil) return { node: <StatusBox />, tip: "Not started" }
  if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>, tip: "Done" }
  if (kind === "needs-input") {
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (kind === "working") {
    // A PARENT AT REST WITH ITS SUB-AGENTS OUT spins with the ellipsis inside (2026-09-20): the spinner
    // says a child's return will re-invoke it, the ellipsis says the parent itself has stopped. Same
    // kind, same band — only the mark inside changes — because the motion is real either way and the
    // kind is what offersRetry and the band read. A thread whose own turn is running keeps the empty box.
    // A REGISTERED QUESTION STILL OPEN puts the "?" in that frame instead (groups.workingWithOpenQuestion,
    // 2026-10-08): the worker kept going after it asked, and the answer would steer what it does next.
    if (workingWithOpenQuestion(t)) return { node: <BoxSpinner><Glyph ch="?" muted /></BoxSpinner>, tip: "Working — a question is waiting on your answer" }
    if (restingOnSubAgents(t)) return { node: <BoxSpinner>{ellipsisGlyph}</BoxSpinner>, tip: "At rest — waiting on its sub-agents" }
    return { node: <BoxSpinner />, tip: "Working" }
  }
  // The thread has stopped and only a shell it launched is still running. The mark is the solid blue dot
  // — inside the spinner when its worker called the rest `working`, in the static box when the row is in
  // the queue; see shellDot for why one dot serves every band.
  if (kind === "background") {
    // The fence, when there is one, names the shell itself (and any PR riding beside it), so the lead
    // drops to a bare "At rest" rather than saying "an agent terminal" twice in one sentence.
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return {
      node: restIsWorking(t) ? shellDot : restingShellDot,
      tip: popover(t, fenced ? "At rest" : "At rest — an agent terminal is still running"),
    }
  }
  if (kind === "done") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>, tip: "Done" }
  if (kind === "stalled") {
    // ONE mark for "the process is gone". The server's `crashed` bit (exited AND turn-in-flight/live
    // background work) no longer gates the mark — it only picks the wording, so the tooltip still tells
    // you HOW it stopped while the glyph and the Retry verb treat both stops identically.
    const tip = t.crashed === true ? "Stalled — the agent exited mid-turn" : "Stalled — the agent's process exited"
    return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip }
  }
  if (kind === "limit") {
    // KILLED BY A USAGE LIMIT, auto-resume promised — the rail's OTHER yellow mark (2026-08-31). Accent
    // like the stalled [!] because both are dead threads carrying the same one-click Retry (offersRetry;
    // maintainer: every yellow row gets the hover Retry), but the glyph stays the hourglass because this
    // one has a wake ntwine itself delivers. Until 2026-08-31 it wore the MUTED hourglass in the Snoozed
    // band, which read as a calm intentional park over a whole limit-killed fleet (maintainer: "they
    // showed up and fucking snoozed"). The words are lib/limitPause's, shared with the drawer's and the
    // queue card's pause card, so no two surfaces can tell two stories about one thread. The kind is only
    // ever "limit" with a pause present.
    const p = t.limitPause!
    const resume = limitPauseResume(p).replace(/\.$/, "")
    return {
      node: <StatusBox accent><Hourglass size={9} className="text-accent" /></StatusBox>,
      tip: `${limitPauseTitle(p)} — ${resume[0]!.toLowerCase()}${resume.slice(1)}`,
    }
  }
  // AWAITING A PR, IN THE QUEUE — the same octocat the Snoozed arm draws, on the rows that never park.
  // A PR wait deliberately stays a visible queue handoff (parkedAwaitingHint excludes it), so this is
  // where MOST PR waits actually live, and until 2026-09-04 every one of them wore either the shell's
  // blue dot (checks still running) or the bare-rest ellipsis (checks settled). The tooltip is the
  // fence's own clause, which names the ref — "waiting on acme/app#391" — so the hover reaches the PR.
  // THE OCTOCAT SPINS ON A `working` REST (2026-09-20 for running checks; 2026-10-05 for the rule). CI
  // running is the PR reading that is motion with a known end, so the server reads it as `working` and
  // holds such a thread in the Running band (board.deriveWaitStatus); the row wears the spinner around
  // GitHub's mark there, and the static octocat in the queue — checks or no checks, a queued row never
  // spins. A gated PR is not motion (the server's ciInMotion refuses it), so an approval gate never spins.
  if (kind === "pr") {
    const tip = popover(t, prChecksRunning(t) ? "At rest — checks are running" : "At rest")
    return restIsWorking(t) ? { node: <BoxSpinner>{githubGlyph}</BoxSpinner>, tip } : { node: githubMark, tip }
  }
  // AWAITING A TIMER, IN THE QUEUE — the same hourglass the Snoozed arm draws, on the rows that never
  // park. A timer park queues (board.deriveNeedsYou), so this is where MOST timer waits actually live,
  // and until 2026-09-07 every one of them wore the shell's blue dot (groups.awaitingTimerWatch carries
  // the report). The tooltip says what is waited on and WHEN: the fence's own clause where there is one
  // ("waiting on a timer and a background shell"), a synthesized one for a worker that registered the
  // timer and rested without fencing, and the countdown either way — the one thing about this row the
  // rail cannot show, and what the operator most wants on hover.
  if (kind === "timer") {
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return { node: hourglassMark, tip: popover(t, fenced ? "At rest" : "At rest — waiting on a timer", timerWake(t)) }
  }
  // AT REST ON THE WORKER'S OWN WAIT, in Working (groups.sessionIndicatorKind). The mark is the wait's
  // shape, as the Snoozed arm drew it before Snoozed became the human's band: the shell's dot for a shell
  // it left running, the hourglass for anything else. The tooltip is the fence's own clause where there
  // is one ("waiting on a reply from @x").
  if (kind === "parked") {
    const hk = t.lastFence?.kind === "awaiting" ? t.lastFence.hints.find((h) => h.kind === "shell" || h.kind === "agent" || h.kind === "timer")?.kind : undefined
    const ownWork = hk === "shell" || hk === "agent" || (hk === undefined && (t.bgShells ?? []).some((s) => s.state === "running"))
    // A wait GitHub resolves wears GitHub's mark, as the Snoozed arm below always drew it: a Waiting row on
    // a PR, and a done the human chose to watch from its card.
    return { node: waitNamesPr(t) ? githubMark : ownWork ? restingShellDot : hourglassMark, tip: popover(t, "At rest", hk === "timer" ? timerWake(t) : null) }
  }
  if (kind === "snoozed") {
    const hourglass = hourglassMark
    const github = githubMark
    // A snoozed row whose fence names a PR (`prs:` since the 2026-08-24 YAML cutover; `pr:` and `pr-watch:`
    // before it, both retired) is snoozed FOR A PR, and the rail says so with GitHub's mark instead of the
    // clock. The alarm clock means "the human parked this until an instant", and for a watch the clock is only the
    // backstop: the scheduler polls the PR and CLEARS the park the moment new activity lands
    // (scheduler.ts, the clear-snooze-on-PR-wake), so what actually wakes this row is GitHub. A PR wait
    // never parks itself — parkedAwaitingHint excludes it so a watch stays a visible queue handoff — so
    // the rows that reach here are the ones parked ANYWAY: one the human snoozed on a wall clock, and,
    // until the 2026-08-15 grammar deleted the kind, one whose worker co-declared a `human:` gate
    // beside the watch — and, from 2026-08-28 to 2026-10-14, one the human snoozed off the RESTING card
    // (the event-snooze that replaced the awaiting card's own "PR watcher armed" Snooze on 2026-08-13,
    // removed 2026-10-14). All were previously indistinguishable from a plain timer park.
    // ONE answer to "does this wait name a PR", shared with the queued arm below (groups.waitNamesPr).
    // It reads the REGISTERED watch as well as the fence, so a row parked on a watch it never fenced
    // stops wearing the clock — the fence-only reading was why the mark looked like a property of the
    // Snoozed band rather than of the wait.
    const parkMark = waitNamesPr(t) ? github : alarmMark
    // A snoozed row carries its whole "what it is waiting for" story HERE, in the popover — the rail row itself
    // is a title and nothing else. The two time-based holds are ONE concept — a snooze (park until a wall-clock instant) — sharing the same
    // parkMark + single-line layout. They differ only in WHO resolves the park at the deadline, which
    // the tooltip wording marks as an `auto` variant of the same word rather than a separate idea:
    //   • a user snooze re-surfaces the CARD for you  → "Snoozed until <wake>"       (you act next)
    //   • an ```awaiting park naming a timer / blocked+timer status auto-resumes the agent → "Auto-snoozed until <wake>"
    // A user snooze that carries a PROMPT crosses that line by design — ntwine resumes the agent with it —
    // so formatUserSnooze reads it as the auto variant and names the follow-up it will send.
    const snoozedUntil = futureSnoozedUntil(t)
    if (snoozedUntil) {
      const parked = formatUserSnooze(snoozedUntil, t.snoozePrompt) ?? "Snoozed until a scheduled check"
      // …AND WHAT THE PARK IS HOLDING, when it is holding an ask. A user snooze takes this row out of the
      // queue server-side, so its card — the only surface that renders a question — is gone until the
      // wake. The mark can no longer say [?] (it would advertise a card nobody can open), so the tooltip
      // is where the unanswered ask stays legible until then.
      const asking = (t.questions?.length ?? 0) > 0 || t.pendingQuestion === true || Boolean(t.pendingAsk)
      return { node: parkMark, tip: popover(t, asking ? `${parked}\nA question is waiting for you` : parked) }
    }
    // A usage-limit park is NOT in this family any more (2026-08-31): a limit kill queues as a failed
    // thread and wears the yellow "limit" mark above. What still reaches this arm with a limitPause set
    // is only a row the OPERATOR also snoozed, and their park is the story the row tells.
    // Canonical blocked+timer status can arrive from an older/pre-session snapshot without a fence.
    if (t.lastFence?.kind !== "awaiting") {
      const timed = typeof t.revalidate === "string" ? formatAutoSnoozedUntil(t.revalidate) : null
      return { node: hourglass, tip: timed ?? "Auto-snoozed until a scheduled check" }
    }
    // Reserve the park mark (hourglass, or GitHub when a watch is riding along) for intentional park
    // states: a durable GitHub review cursor, the thread's own live work, or a VALID scheduled instant.
    // NO HINT KIND PARKS ON ITS OWN. `human:` and `timer: <instant>` each drew the Snoozed mark from the
    // worker's assertion alone; both are deleted (2026-08-15) and the server now decides Snoozed from a
    // checked declaration. What is left to draw is the SHAPE of the wait.
    const hk = t.lastFence.hints.find((h) => h.kind === "pr" || h.kind === "shell" || h.kind === "agent" || h.kind === "timer")?.kind
    // The tooltip's WORDS come from the fence itself (popover → awaitingWaitClause), which names the
    // things it parked on; the arms below only pick the GLYPH that matches the leading kind. They used
    // to say the shape in prose too — "Waiting on its own background work" — which restated vaguely
    // what the clause says exactly ("waiting on 2 background shells and a timer"), and was the only
    // place the popover's text was hand-written per arm instead of derived.
    // A PR IN THE WAIT WINS THE GLYPH OUTRIGHT — it is no longer one of the leading-kind arms. `hk`
    // reads the FIRST hint the worker happened to write, so a fence naming a shell before its PR drew
    // the shell's dot for a wait GitHub resolves; the same wait written the other way round drew the
    // octocat. One state, two marks, decided by fence order. The kinds below still rank among
    // themselves, because none of them is the subject of the wait the way a PR is.
    // A TIMER — or a fence naming nothing the rail draws a shape for — is "parked on the clock", and
    // wears the hourglass. It drew lucide's Clock until 2026-09-07, when the queued timer wait two arms
    // up took the hourglass and the parked one had to match it: one wait, one mark (see hourglassMark).
    const mark = waitNamesPr(t)
      ? github
      : hk === "shell" || hk === "agent"
        ? restingShellDot
        : hourglass
    return { node: mark, tip: popover(t, "Snoozed", hk === "timer" ? timerWake(t) : null) }
  }
  // At rest (no fence, nothing pending) with the process still ALIVE — a worker that came to rest
  // WITHOUT declaring done or a machine-wait, and with NOTHING it launched still running (that is the
  // pulsing dot above). (An exited one is `stalled` above; this ellipsis is now honestly reserved for a
  // session you can still just type at.) Read it as WAITING
  // (maintainer 2026-07-10: a rested-not-done thread "should be blocked or waiting", never a stark
  // empty box and never a false check). We don't know the reason — the worker didn't fence — so: no
  // hint gloss (vs an ```awaiting fence, which names what it waits on AND dims + sinks the row). The
  // honest fix is the worker emitting ` ```awaiting ` when it's blocked on a machine.
  // RESTED AND AWAITING lands here whenever the park is not Snoozed — the fence declared a wait but ntwine
  // could not honour it (an item that is not running, no `for:`), so the row stays in the queue wearing
  // the ordinary at-rest mark. That row is exactly where the worker's own prose earns its place: the
  // glyph says "at rest" and the popover says what it thinks it is waiting for, which is the one thing
  // the rail cannot show and the operator most wants on hover (maintainer 2026-08-16).
  return {
    node: <StatusBox>{ellipsisGlyph}</StatusBox>,
    tip: popover(t, "At rest"),
  }
}

// THE shared rounded-rect checkbox — the ONE outer shape every status glyph sits in. Its size and the
// spinner that traces it live in ./BoxSpinner.tsx, because the indented child rows (ChildOpRow, "rail"
// density) draw the same spinner and must not import their own parent module to get it.
function StatusBox({ accent, children }: { accent?: boolean; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[4px] border ${accent ? "border-accent/90" : "border-muted/45"}`}
      style={{ width: STATUS_BOX, height: STATUS_BOX }}
    >
      {children}
    </span>
  )
}
// A bold single-char glyph (?, !) centered in the box. Accent by default; `muted` renders it the same
// gray as every other rail glyph (the "?" needs-you mark — the ⚖ queue already carries the emphasis).
function Glyph({ ch, muted }: { ch: string; muted?: boolean }) {
  return (
    <span
      aria-hidden
      // `ntwine-rail-glyph` trims the span to the glyph's own cap band, so the box centres its INK rather
      // than its em box — the correction is the BROWSER's, holds in both of this app's fonts, and lives
      // with its readings in styles.css. It replaced `translateY(0.09em)`, a constant fitted on a fixture
      // that silently rendered mono while the app runs sans, which left both marks ~1.4px low on screen.
      className={`ntwine-rail-glyph font-bold leading-none ${muted ? "text-muted-70" : "text-accent"}`}
      style={{ fontSize: 10 }}
    >
      {ch}
    </span>
  )
}
