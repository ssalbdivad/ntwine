// A PROJECT'S BOARD — the page's left column at `/project/<slug>` (lib/pageView.ts): one project's threads,
// banded and NAMED as Colin's sidebar named them (upstream colinhacks/frizz 0a3b9139 Sidebar.tsx), top to
// bottom:
//
//   PINNED    the human's shelf, oldest pin first, whatever each thread's state — a Done one greyed.
//             Only when it has rows.
//   QUEUE     the threads at rest, in the queue's order — exactly the cards in the middle column, each
//             row with its rest time.
//   ─────     a rule, when Running follows
//   RUNNING   the ones spinning, by recency — no rest time: a row that is still working made no handoff.
//   ─────
//   ▸ SNOOZED     collapsed to start, each a header that opens its rows in place
//   ▸ DONE        (virtualized once open: the one band that grows without bound)
//   ▸ EXTERNAL    the project's own `claude`/`codex` terminals, which Ntwine reads but does not drive
//   ▸ SCHEDULES   the project's schedules
//
// Pinned, Queue and Running are never collapsible (upstream 2026-09-19: the Pinned, Queue and Running
// labels "should not be collapsible") — you cannot hide your queue or your live work — so their headers
// are static and nothing on the board folds them. The vocabulary is ARCHITECTURE.md § Board nomenclature:
// Queue is the maintainer's Rested (the cue), Running his Active.
//
// WHY IT CAME BACK (2026-10-06, plans/upstream-superset.md §2). From 2026-09-29 a project's page was All
// projects' list with one project in it — its row's counts and its threads under no name, the quiet
// bands opened from counts on that row. David took the fork as the base with Colin's board in it, so a
// project's own page reads as Colin built it again; All projects keeps its own compact list
// (ProjectList.tsx), which is this board's job one level up.
//
// WHAT IS THE FORK'S, kept on purpose: the row (Sidebar.tsx RailRow — the indicator, the rest time, the
// pin mark, a schedule's mark, the reading marker, the hover verbs), every row's click (its card when the
// queue is showing it, else its drawer, in place — useRowScope), the list held still under the pointer
// (lib/listHold.ts, lib/heldLayout.ts), the operator's own acts moving rows before the server answers
// (lib/listBands.ts listOverlay), and the cord that strings the project's rows through their glyphs
// (ThreadConnector.tsx — a band's header glyph stands in the same column, so the names cost it nothing).
// No project row heads the board: the switcher over the prompt box names the project (StatusRow.tsx),
// with its repo and its menu beside it (BoardIdentity below), so a row repeating it would only cost the
// board a line — and the capacity gate has none to spare (capacityParity.e2e.test.ts).
//
// A THREAD'S SUB-AGENTS ARE ROWS under it here (Sidebar.tsx SubAgentRows), as upstream drew them; All
// projects keeps the count on the row.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { Ellipsis } from "lucide-react"
import { useNavigate } from "react-router"
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { displayTitle, queued } from "../groups.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { bandKey, rememberCrossProjectFocus, setBoardBandOpen, useBoardOpenBands, type QuietBandKey } from "../lib/crossProject.ts"
import { holdLayout, type HeldSection, type HeldSlot } from "../lib/heldLayout.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useListHold } from "../lib/listHold.ts"
import { prefs } from "../lib/prefs.ts"
import { RECENT_MS, recentOf, touchThread } from "../lib/recentThreads.ts"
import { boardBands } from "../lib/boardBands.ts"
import { listOverlay } from "../lib/listBands.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { ALL_PROJECTS, viewHref } from "../lib/pageView.ts"
import { useProjectBoard } from "../lib/projectBoards.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { glideTo } from "../lib/viewportLock.ts"
import { STATUS_ROW_ACTION } from "../lib/statusRow.ts"
import { drawerThreadSlug, store } from "../store.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import type { BandKey } from "./BandLabel.tsx"
import { ProjectMenu } from "./ProjectActions.tsx"
import { ScheduleRows } from "./ProjectList.tsx"
import { RailRow, SectionHeader, SubAgentRows, type RowScope } from "./Sidebar.tsx"

/** Every band the board draws rows in — the sections lib/heldLayout.ts holds. */
type BoardBand = "pinned" | "ready" | "working" | "snoozed" | "done" | "external"

/** The quiet bands, in the board's order. Schedules last: the one band that is not threads, so it reads
 *  as the project's future rather than part of its past. */
const QUIET: readonly QuietBandKey[] = ["snoozed", "done", "external", "schedules"]
const QUIET_LABEL: Record<QuietBandKey, string> = { snoozed: "Snoozed", done: "Done", external: "External", schedules: "Schedules" }

export function ProjectBoard({
  project,
  activeKey,
  hidden,
  onQueuedRow,
  switcher,
}: {
  project: QueuesProject
  /** The card being read (AllQueues.tsx useScrollspy): its row wears the reading marker. */
  activeKey: string | null
  /** A card being finished: its row waits under Running until the poll agrees (lib/listBands.ts). */
  hidden: (key: string) => boolean
  /** Bring a Queue card into view: its scroll offset, or null when the queue is not showing it. */
  onQueuedRow: (key: string) => number | null
  /** The view's switcher as the board's head row — in an editor's sidebar, which has no status row. */
  switcher?: ReactNode
}) {
  const snap = useSnapshot(store)
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  // The board's project IS the page project, so its live board is in the store — once it has landed. A
  // switch from another project draws from the cache until then.
  const onPage = snap.board?.projectSlug === project.slug
  const live = onPage ? (snap.board as BoardSnapshot) : null
  const cached = useProjectBoard(project.id, !onPage && project.open)
  const board = live ?? cached
  const openSlug = onPage ? drawerThreadSlug(snap.drawers) : null
  const scope = useRowScope(project, onPage, onQueuedRow)
  const open = useBoardOpenBands()
  const isOpen = (band: QuietBandKey) => open.has(bandKey(project.id, band))

  // ONE SHELF, OLDEST PIN FIRST whatever each pinned thread's state, then the work in flight from the poll
  // with the operator's own acts folded in, then what only the board knows (lib/boardBands.ts).
  const bandsNow = boardBands(project, board, hidden, listOverlay(project.id, onPage, steeredAt, archivingAt))
  const schedules = project.schedules?.count ?? 0
  const schedulesAttention = project.schedules?.attention ?? false

  // THE BANDS AS DRAWN — live, or held as they were while the pointer is over the list (lib/listHold.ts,
  // lib/heldLayout.ts), exactly as All projects holds its groups. Listed fresher-first, so a thread a
  // cached board still lists elsewhere is drawn once, where the poll puts it.
  const held = useListHold()
  const target = [
    { id: "pinned", items: bandsNow.pinned },
    { id: "ready", items: bandsNow.ready },
    { id: "working", items: bandsNow.working },
    { id: "snoozed", items: bandsNow.snoozed },
    { id: "done", items: bandsNow.done ?? [] },
    { id: "external", items: bandsNow.external },
  ] satisfies { id: BoardBand; items: ThreadView[] }[]
  // What THIS TAB just did to one of the project's threads: a row the human moved goes where it now belongs
  // even while the list is held (ProjectList.tsx, the same test).
  const moved = (slug: string) =>
    actedOnHere(slug) ||
    hidden(threadKey(project.id, slug)) ||
    steeredAt[threadKey(project.id, slug)] !== undefined ||
    (onPage && (steeredAt[slug] !== undefined || archivingAt[slug] !== undefined))
  const drawn = useRef<HeldSection<ThreadView>[]>([])
  const bands = holdLayout({
    prev: drawn.current,
    target,
    keyOf: (t) => t.id,
    frozen: held,
    moved,
    live: (slug) => [...project.queued, ...project.running, ...project.snoozed, ...(board?.threads ?? [])].find((t) => t.id === slug),
  })
  drawn.current = bands
  // The band each thread is in NOW: a held row is drawn in its old place but as what it is — a rest time if
  // it is queued, a spinner if it is working — since only the layout is held, never what a row says.
  // THE THREADS OPENED LATELY, kept under a folded Snoozed or Done header (prefs `showRecentThreads`). An open
  // thread is touched on arrival and again on leaving, so the half hour runs from when the human last had it.
  const { showRecentThreads } = useSnapshot(prefs)
  useEffect(() => {
    if (!openSlug) return
    touchThread(openSlug)
    return () => touchThread(openSlug)
  }, [openSlug])
  const [, tick] = useState(0)
  useEffect(() => {
    if (!showRecentThreads) return
    const timer = setInterval(() => tick((n) => n + 1), RECENT_MS / 30)
    return () => clearInterval(timer)
  }, [showRecentThreads])
  const recentSlots = (band: "snoozed" | "done") =>
    showRecentThreads ? recentOf(slots(band), (slot) => slot.item.id) : []

  const bandNow = new Map(target.flatMap((band) => band.items.map((t) => [t.id, band.id] as const)))
  const slots = (band: BoardBand) => bands.find((section) => section.id === band)?.slots ?? []

  const row = (slot: HeldSlot<ThreadView>) => {
    const t = slot.item
    const band = bandNow.get(t.id)
    return (
      // Siblings, not a wrapper: the cord strings each row by its own place in the board (ThreadConnector),
      // and a thread's sub-agent rows, between two of them, cut it there.
      <Fragment key={t.id}>
        <RailRow
          t={t}
          active={activeKey === threadKey(project.id, t.id)}
          open={openSlug === t.id}
          // The rest time dates a HANDOFF: a Queue row's, and an External session's, every one of which is
          // at rest by definition — "how long ago" is what tells two terminals apart.
          restedAge={band === "ready" || band === "external"}
          scope={scope}
          cardKey={bandsNow.carded.has(t.id) ? threadKey(project.id, t.id) : undefined}
          band={band as BandKey | undefined}
          held={slot.held}
          subAgentRows
        />
        {band !== "external" && <SubAgentRows t={t} scope={scope} />}
      </Fragment>
    )
  }

  const pinnedRows = slots("pinned")
  const readyRows = slots("ready")
  const workingRows = slots("working")
  const quietCount = (band: QuietBandKey): number =>
    band === "snoozed" ? slots("snoozed").length
      : band === "done" ? (bandsNow.done ? slots("done").length : project.doneCount)
        : band === "external" ? slots("external").length
          : schedules
  const quietShown = QUIET.filter((band) => quietCount(band) > 0)

  return (
    <section
      aria-label={project.name}
      data-xq-board={project.id}
      // The cord reads a project's rows as this section's own children (ThreadConnector readRail).
      data-xq-rail-project={project.id}
      className="flex min-w-0 flex-col"
    >
      {switcher && (
        <div data-xq-switcher-row className="mb-1 flex min-w-0 py-0.5 pl-5 pr-1.5">
          {switcher}
        </div>
      )}
      <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
        {pinnedRows.length > 0 && <SectionHeader band="pinned" count={pinnedRows.length} />}
        {pinnedRows.map(row)}
        {readyRows.length > 0 && <SectionHeader band="ready" count={readyRows.length} />}
        {readyRows.map(row)}
        {/* Between the two always-open bands that most often both have rows: Queue above it is yours,
            Running below it the agents'. Pinned needs none — its own header under Queue's says it. */}
        {readyRows.length > 0 && workingRows.length > 0 && <BandRule />}
        {workingRows.length > 0 && <SectionHeader band="working" count={workingRows.length} />}
        {workingRows.map(row)}
        {pinnedRows.length + readyRows.length + workingRows.length === 0 && (
          // "Open", not "active": it stands in for Queue AND Running, and only when both are empty — and
          // not under a Pinned band, whose rows are open threads too (upstream's rule).
          <div data-xq-board-empty className="py-1 pl-[44px] pr-1.5 text-[11.5px] leading-[19px] text-muted-50">
            No open threads
          </div>
        )}
        {/* THE QUIET BANDS, each under its own collapsible header, in a container of their own: the cord is
            the work in flight, so it never reaches down here (ThreadConnector reads only the board's own
            children). One rule parts them from the work in flight, and one follows each band that is OPEN,
            under its last row; between two closed headers a rule would only stripe the column — upstream
            drew one over each band, with 24px of margin a band, for headers that were 24px apart anyway. */}
        {quietShown.length > 0 && (
          <div data-xq-board-quiet className="flex min-w-0 flex-col">
            {quietShown.map((band, index) => {
              const opened = isOpen(band)
              const ruled = index === 0 || isOpen(quietShown[index - 1]!)
              return (
                <section key={band} aria-label={QUIET_LABEL[band]} data-xq-board-band={band} data-xq-board-band-open={opened || undefined}>
                  {ruled && <BandRule />}
                  <SectionHeader
                    band={band}
                    count={quietCount(band)}
                    collapsed={!opened}
                    attention={band === "schedules" && schedulesAttention}
                    onToggle={() => setBoardBandOpen(project.id, band, !opened)}
                  />
                  {opened && band === "schedules" && <ScheduleRows project={project} count={schedules} attention={schedulesAttention} />}
                  {opened && band === "done" && (bandsNow.done ? <DoneBand slots={slots("done")} row={row} /> : <Loading />)}
                  {opened && (band === "snoozed" || band === "external") && slots(band).map(row)}
                  {!opened && (band === "snoozed" || band === "done") && recentSlots(band).map(row)}
                </section>
              )
            })}
          </div>
        )}
      </ThreadProjectScope>
    </section>
  )
}

/**
 * THE RULE BETWEEN BANDS — upstream's bare hairline (`<hr>` in border/50), on the rows' own inset so it heads
 * the column the indicators hang from. 13px, the hairline 5px down it: 14.5px under the last row's
 * baseline and 12px over the next header's capitals (sans, measured 2026-10-06) — a touch nearer the band
 * it opens, as upstream's sat (21 / 18.5px), in about two-thirds of upstream's 24px of margin. It never
 * costs the capacity gate a row: it parts Queue from Running and the quiet bands from the work in flight,
 * and at that load both breaks are below the fold; Pinned and Queue are parted by Queue's header alone.
 */
function BandRule() {
  return <div aria-hidden data-xq-board-rule className="relative h-[13px] shrink-0 before:absolute before:left-5 before:right-1.5 before:top-[5px] before:h-px before:bg-border/50 before:content-['']" />
}

function Loading() {
  return (
    <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">
      Loading…
    </div>
  )
}

/**
 * Where a row leads — ONE object per project, so the memoized rows are not handed a new scope on every
 * poll. A Queue row brings its card into view when the queue is showing it, and every other click opens
 * the thread's drawer in place (useOpenThreadInPlace). The same as All projects' (ProjectList.tsx).
 */
function useRowScope(project: QueuesProject, page: boolean, onQueuedRow: (key: string) => number | null): RowScope {
  const openInPlace = useOpenThreadInPlace()
  const { slug, id, name } = project
  const open = useCallback(
    (t: ThreadView) => {
      if (queued(t) && onQueuedRow(threadKey(id, t.id)) !== null) return
      openInPlace({ slug, id, name }, t.id, displayTitle(t))
    },
    [id, slug, name, onQueuedRow, openInPlace],
  )
  return useMemo(() => ({ open, page }), [open, page])
}

// THE DONE BAND, VIRTUALIZED once open — the only band that is, because it is the only one that grows
// without bound: every thread the human ever finished. Upstream measured it on a copy of the maintainer's
// board (553 rows, 2026-09-04, scripts/verify-done-band-virtualization.mjs): expanded and mounted whole,
// 15,085 rail nodes and a 21.5ms style recalculation on every overlay open (the body scroll lock forces
// one), against 884 nodes and 4ms virtualized. It shares the list's own scroller rather than growing a
// nested one — the `[data-xq-rail]` column on the desktop and in an editor's sidebar, the window where the
// page stacks — which is what `scrollMargin` is for: the band's offset in that scroller, re-measured after
// every commit (a band above it may have changed height) and on any resize of the scroller.
//
// 27px is STRUCTURAL: a row is pt-1 + a 19px line + pb-1. A wrapped title, or a Done thread's sub-agent
// rows, is measured as it mounts (measureElement). The cost, as upstream noted: ⌘F and Tab reach only
// the mounted rows; ⌘K searches every thread.
const DONE_ROW_ESTIMATE = 27
const DONE_OVERSCAN = 8

function DoneBand({ slots, row }: { slots: HeldSlot<ThreadView>[]; row: (slot: HeldSlot<ThreadView>) => ReactNode }) {
  const probe = useRef<HTMLDivElement>(null)
  // undefined until mounted: which scroller the band is in is a fact of the layout, not of the props.
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined)
  useLayoutEffect(() => {
    const rail = probe.current?.closest<HTMLElement>("[data-xq-rail]") ?? null
    setScroller(rail && /(auto|scroll)/u.test(getComputedStyle(rail).overflowY) ? rail : null)
  }, [])
  return (
    <div ref={probe} data-done-band>
      {scroller === undefined ? null : scroller ? <ScrollerDone scroller={scroller} slots={slots} row={row} /> : <WindowDone slots={slots} row={row} />}
    </div>
  )
}

function ScrollerDone({ scroller, slots, row }: { scroller: HTMLElement; slots: HeldSlot<ThreadView>[]; row: (slot: HeldSlot<ThreadView>) => ReactNode }) {
  const list = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualizer = useVirtualizer({
    count: slots.length,
    getScrollElement: () => scroller,
    // Keyed by THREAD, not index: a Done row is reopened at any position, and an index key would hand the
    // next row the vanished one's measured height.
    getItemKey: (index) => slots[index]?.key ?? index,
    estimateSize: () => DONE_ROW_ESTIMATE,
    overscan: DONE_OVERSCAN,
    scrollMargin,
  })
  // NO DEPENDENCY ARRAY: after every commit, because a commit is when the bands above may have moved.
  useLayoutEffect(() => {
    const measure = () => {
      if (!list.current) return
      // CONTENT coordinates, not offsetTop, which would answer against the nearest positioned ancestor.
      const next = list.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  })
  return <VirtualRows list={list} total={virtualizer.getTotalSize()} items={virtualizer.getVirtualItems()} measure={virtualizer.measureElement} scrollMargin={scrollMargin} slots={slots} row={row} />
}

function WindowDone({ slots, row }: { slots: HeldSlot<ThreadView>[]; row: (slot: HeldSlot<ThreadView>) => ReactNode }) {
  const list = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualizer = useWindowVirtualizer({
    count: slots.length,
    getItemKey: (index) => slots[index]?.key ?? index,
    estimateSize: () => DONE_ROW_ESTIMATE,
    overscan: DONE_OVERSCAN,
    scrollMargin,
  })
  useLayoutEffect(() => {
    const measure = () => {
      if (!list.current) return
      const next = list.current.getBoundingClientRect().top + window.scrollY
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  })
  return <VirtualRows list={list} total={virtualizer.getTotalSize()} items={virtualizer.getVirtualItems()} measure={virtualizer.measureElement} scrollMargin={scrollMargin} slots={slots} row={row} />
}

function VirtualRows({
  list,
  total,
  items,
  measure,
  scrollMargin,
  slots,
  row,
}: {
  list: RefObject<HTMLDivElement | null>
  total: number
  items: { index: number; key: string | number | bigint; start: number }[]
  measure: (element: Element | null) => void
  scrollMargin: number
  slots: HeldSlot<ThreadView>[]
  row: (slot: HeldSlot<ThreadView>) => ReactNode
}) {
  return (
    // The band's full height, so the scrollbar is the length the whole archive deserves — the reader must
    // not be able to tell which rows are mounted.
    <div ref={list} className="relative w-full" style={{ height: total }}>
      {items.map((item) => {
        const slot = slots[item.index]
        if (!slot) return null
        return (
          <div
            key={String(item.key)}
            ref={measure}
            data-index={item.index}
            className="absolute left-0 top-0 w-full"
            // `start` is in the scroller's coordinates (it includes scrollMargin); this box is positioned
            // inside the band, so the offset comes back off.
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {row(slot)}
          </div>
        )
      })}
    </div>
  )
}

/**
 * THE BOARD'S IDENTITY, beside the switcher in the status row (StatusRow.tsx `identity`): the project's
 * `owner/repo`, a link to it on GitHub when its origin is there (upstream's StatusRow, maintainer
 * 2026-08-28: "Perhaps it should actually be showing owner/repo if a repo is detected"), and the project's
 * "…" menu — its icon, rename, delete and the way back to All projects — which in All projects rides the
 * project's row (ProjectList.tsx ProjectRow), a row the board does not draw. The menu shows on hover and
 * focus, as it does on that row.
 */
export function BoardIdentity({ project, home }: { project: QueuesProject; home: string | undefined }) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const repo = project.githubRepo
  return (
    // `-ml-[5px]`: the status row's rhythm is 12px of INK (StatusRow.tsx), and the title's 8px gap after the
    // switcher's own 6px of padding and its chevron's dead space stood the repo 17px off the chevron's ink
    // (scripts/ink-gaps.mjs, sans 12px, 2026-10-06).
    <span data-xq-board-identity className="group/identity -ml-[5px] flex min-w-0 items-center gap-3">
      {repo && (
        <a
          href={`https://github.com/${repo}`}
          target="_blank"
          rel="noopener"
          data-xq-board-repo
          title={`Open ${repo} on GitHub`}
          aria-label={`Open ${repo} on GitHub`}
          // Muted beside the switcher's name: the name is the page's title, the repo its address.
          className="block min-w-0 rounded-sm text-[12px] text-muted-70 underline-offset-2 outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <StartTruncated text={repo} />
        </a>
      )}
      {project.card && (
        <span className={`shrink-0 items-center group-hover/identity:flex group-has-[:focus-visible]/identity:flex [@media(hover:none)]:flex ${menuOpen ? "flex" : "hidden"}`}>
          <ProjectMenu
            project={project.card}
            home={home}
            githubRepo={repo}
            focused
            onFocus={() => {
              // Leaving a project for All projects carries it over as the prompt box's pick, as the
              // switcher does (AllQueues.tsx Switcher).
              rememberCrossProjectFocus(project.id)
              navigate(viewHref(ALL_PROJECTS))
              glideTo(() => 0)
            }}
            onOpenChange={setMenuOpen}
          >
            <button type="button" aria-label={`More actions for ${project.name}`} className={`${STATUS_ROW_ACTION} data-[state=open]:text-fg`}>
              <Ellipsis size={13} />
            </button>
          </ProjectMenu>
        </span>
      )}
    </span>
  )
}

/**
 * `owner/repo` clipped from the START, so it is the owner that gives way — "…hacks/ntwine", never
 * "colinhacks/f…" (upstream StatusRow.tsx StartTruncated): `direction: rtl` moves the overflow and its
 * ellipsis to the left, and the text is re-isolated LTR so its letters and slash keep their order. A repo
 * name ends in a strong LTR character, which this needs.
 */
function StartTruncated({ text }: { text: string }) {
  return (
    <span dir="rtl" className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
      <span dir="ltr" className="[unicode-bidi:isolate]">{text}</span>
    </span>
  )
}
