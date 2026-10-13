// THE PROJECT LIST — the page's left column under the prompt box: the VIEW's projects (lib/pageView.ts) —
// the one project the page is focused on, or every project on the machine — each with its work in flight
// listed under its name, and the rest of it one click away, in place.
//
// It is the project view's rail, folded into the one page (David 2026-09-28: "does there need to be a
// project specific view at all or can we do enough with the main project view to just focus on what
// people are currently working on and make things expandable?", and then "ensure detailed drill down like
// `done` or other statuses for each project is still visible somehow just deemphasize it creatively all
// functionality must still be available without a project-specific view"). So every band that rail had is
// here, for each project, at two volumes:
//
//   LOUD  — Pinned, Ready and Working: the work in flight, listed under its project unless it is folded,
//           with no name over any of them. Upstream's sidebar named all three ("sidebar labels for pinned,
//           queue, and running … should not be collapsible"); here each row says its band itself — a pin,
//           a rest time, a spinner — so the names were dropped (David 2026-09-29).
//   QUIET — Snoozed, Done and External: a muted count per band under the work in flight, in the band's own
//           glyph (the rail's legend, BandLabel.tsx), never louder than the names. Each count is its own
//           toggle on the project's row, collapsed to start (upstream's sidebar had the same three as
//           separate collapsible sections), and an open band lists its rows under the work in flight,
//           with no name or caret of its own (David 2026-10-01, of a caret row closing every project:
//           "find some way to have it expand just from the title bar so we don't need anything at the
//           bottom of the list"). The same day the counts alone proved too hidden ("the click done on the
//           top being the only way to view is too confusing"), so an unfolded project also says "N more" in
//           words, which lists the rest in place (MoreToggle) — one unnamed affordance, not a caret per
//           band. It ENDED the project's list, on a row of its own, until 2026-10-06; it now sits on the
//           project's own line beside its name, because that row cost every project a line, and at
//           the heavy load (17 projects, 70 open threads) the project frames ate a third of the screen —
//           see ProjectGroup.
//
// ONE PRESENTATION, BOTH VIEWS. Focus mode is this list with one project in it; All projects is the same
// groups, one per project. So the density is what a busy project costs beyond its own rows, and it is
// measured, not guessed — see the header of ProjectGroup.
//
// And the row itself FOLDS its project: one click and everything under it goes, work in flight included,
// so the list shows only the projects being looked at (lib/crossProject.ts has the folds).
//
// EVERY ROW IS ITS PROJECT'S. The page project is only what the page is bound to — showing All projects,
// the prompt box's pick, which is usually another project — so each group sits in a ThreadProjectScope: pin, reopen, Retry and a sub-agent's × go through the row's
// own project's client, and a click opens its card or its drawer in place (RowScope). The row itself is
// the rail's (Sidebar.tsx RailRow) — the same anatomy, hover strip and marks the project view drew,
// measured once, not a second copy of them.
//
// AND THE PROJECTS DRAG. A project's row is its grip: press, travel a few pixels, and the whole group —
// row and threads — lifts and follows the pointer while the groups it passes slide aside; drop it and the
// machine-wide order is rewritten (`projectsReorder`), so every surface that reads it moves as one.
// The list IS that order: busy projects are not lifted above quiet ones, because a split by busy-ness
// made a drag across it spring back with no feedback, and a project jump to the bottom when its last
// thread finished (David 2026-10-09, "the drag randomly seems to fail"). Alt+Arrow on a focused row moves it one place, for anyone not using a mouse.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as KeyboardEvent_, type PointerEvent as PointerEvent_, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, Pin, Plus, Repeat } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { prefs } from "../lib/prefs.ts"
import { recentOf } from "../lib/recentThreads.ts"
import type { BoardSnapshot, ProjectCard, ScheduleView, ThreadView } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { displayTitle, externalThreads, isPinned, queued, sectionThreads } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { projectSlug } from "../lib/base-path.ts"
import { bandKey, rememberCrossProjectFocus, setBandOpen, setBandsOpen, setProjectCollapsed, useCollapsedProjects, useOpenBands, type QuietBandKey } from "../lib/crossProject.ts"
import { ALL_PROJECTS, projectViewHref, usePageView, viewHref, viewKey } from "../lib/pageView.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { holdLayout, type HeldSection, type HeldSlot } from "../lib/heldLayout.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useListHold } from "../lib/listHold.ts"
import { listOverlay, loudBands, type LoudBands } from "../lib/listBands.ts"
import { prefetchProjectBoard, projectBoardKey, useProjectBoard } from "../lib/projectBoards.ts"
import { edgeScrollVelocity, listDropIndex, listPitch, placeAmong, shiftFor, type ListBox } from "../lib/railReorder.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { drawerThreadSlug, pushScheduleDrawer, store } from "../store.ts"
import { scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { BANDS, type BandKey } from "./BandLabel.tsx"
import { ProjectMenu, projectFacts, shortPath, useAddProject, warmProjectPicker } from "./ProjectActions.tsx"
import { ProjectBoard } from "./ProjectBoard.tsx"
import { QueueBadge } from "./ProjectSwitcher.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { ROW_ACTION_CLASS, RailRow, type RowScope } from "./Sidebar.tsx"
import { glideTo } from "../lib/viewportLock.ts"

// The board sidebar's row geometry, verbatim (Sidebar.tsx ThreadRow), so a project's row and its threads'
// rows are one list: the hover wash, the 20px indicator gutter, the title's 13/19 type.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"
/** A project's own row: the thread row's 19px line, 2px of padding a side rather than 4 — see ProjectGroup. */
const HEAD_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 py-0.5 pl-5 pr-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
/**
 * THE SPACE ABOVE EVERY PROJECT BUT THE FIRST — the only thing between two projects. Beside any busy
 * project (two quiet ones, single rows, need nothing between them), and above the add
 * row.
 *
 * It was a hairline in a 13px gap from 2026-10-01 (David: "needs slightly more visual separation between
 * projects now maybe thin divider? pick something elegant") until 2026-10-06, when capacity parity with
 * upstream's board took it (plans/upstream-superset.md §2: the default view must show at least the 22 / 28
 * lines upstream's own board shows at 1440x900 / 1920x1080). What parts the projects now is the project's
 * row itself — a 16px square and a semibold name over a column of 13px regular titles — standing on this
 * gap. Measured as ink (sans, dsf 2, descenders included): 19px of air from a group's last title to the
 * next project's name, against 14px between two threads' titles and 12px from a name to its first
 * thread, so each name reads as heading what is under it, not as closing what is over it. At the heavy
 * load 6px fits 23 / 29 lines at 1440x900 / 1920x1080, 7px and 8px 22 / 29 (21px of air at 8): the
 * smaller gap is the one that clears the 1440 bar by a line rather than meeting it exactly. It is a
 * margin on the group, so it rides a dragged group's transform with it.
 */
const GROUP_GAP = "mt-1.5"
/** A row whose "…" menu is open wears the rail's hover wash, held. */
const SELECTED_ROW = "after:!opacity-100"
/** Done rows listed per page: the band grows without bound, and a project opens on its most recent. */
const DONE_PAGE = 10
/** How long the page must be idle before the list reads every project's board ahead of a click. */
const PREFETCH_IDLE_MS = 1_500

/**
 * Every project on the machine — the page's navigator, and the only place a project is managed from.
 *
 * Projects with work in flight come first, in the machine-wide order, each followed by its threads; every other
 * project is one line under them. They are separated by space, not rules: the project's own square already
 * starts each group, and a rule would say it twice.
 */
export function ProjectList({
  projects,
  home,
  activeKey,
  hidden,
  onQueuedRow,
  switcher,
}: {
  projects: QueuesProject[]
  home: string | undefined
  activeKey: string | null
  hidden: (key: string) => boolean
  /** Bring a Ready card into view: its scroll offset, or null when the queue is not showing it. */
  onQueuedRow: (key: string) => number | null
  /**
   * THE VIEW'S SWITCHER, as the list's head — in an editor's sidebar, which has no status row to carry it
   * (AllQueues.tsx SidebarPage). Focused on a project it takes the left of that project's own row, the
   * slot the status row's title leaves empty on the desktop (ProjectRow); showing All projects, a row of
   * its own above the first project.
   */
  switcher?: ReactNode
}) {
  const collapsed = useCollapsedProjects()
  const openBands = useOpenBands()
  const view = usePageView()
  useReadAhead(projects, view.kind === "all")
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const reorder = useListReorder(projects)
  const held = useListHold()
  const groups = reorder.ordered.map((project) => {
    const onPage = project.slug === focus && live?.projectSlug === project.slug
    // What THIS TAB just did to one of the project's threads: a row the human moved goes where it now
    // belongs even while the list is held (lib/heldLayout.ts) — the act's own record (lib/humanActs.ts),
    // the card being finished, and the optimistic steer and archive that move the row before the RPC does.
    const moved = (slug: string) =>
      actedOnHere(slug) ||
      hidden(threadKey(project.id, slug)) ||
      steeredAt[threadKey(project.id, slug)] !== undefined ||
      (onPage && (steeredAt[slug] !== undefined || archivingAt[slug] !== undefined))
    return { project, bands: loudBands(project, hidden, listOverlay(project.id, onPage, steeredAt, archivingAt)), moved }
  })
  // While the list is held, a project keeps the place it was drawn in (lib/listHold.ts).
  //
  // NEVER ACROSS A CHANGE OF VIEW. The hold keeps the projects as last drawn, so with the pointer parked
  // over the list a switch from All projects to one project kept every other project's rows on the
  // focused page, and the switch back drew only the project it came from — until the pointer left (driven
  // 2026-10-01, desktop and sidebar alike: build2-shell.md). Switching the view is the human reshaping the
  // list by their own hand, the case lib/listHold.ts releases for, and it happens wherever the switch was
  // made (the switcher's menu, the palette, Back) — so the list draws the new view live on its first
  // render and holds from there.
  const drawnRuns = useRef<HeldSection<(typeof groups)[number]>[]>([])
  const drawnView = useRef(viewKey(view))
  const runs = holdLayout({
    prev: drawnRuns.current,
    target: [{ id: "projects", items: groups }],
    keyOf: (entry) => entry.project.id,
    frozen: held && drawnView.current === viewKey(view),
    moved: () => false,
  })
  drawnRuns.current = runs
  drawnView.current = viewKey(view)
  const run = (id: string) => (runs.find((section) => section.id === id)?.slots ?? []).map((slot) => slot.item)
  const listed = run("projects")
  const grip = reorder.grips([listed.map((entry) => entry.project)])
  // A PROJECT'S BOARD is its own component (ProjectBoard.tsx): upstream's banded sidebar, not this list with
  // one project in it. After every hook above, so a change of view keeps this component's hook order.
  const boarded = view.kind === "project" ? reorder.ordered.find((project) => project.slug === view.slug) : undefined
  if (boarded) return <ProjectBoard project={boarded} activeKey={activeKey} hidden={hidden} onQueuedRow={onQueuedRow} switcher={switcher} />
  const group = (entry: (typeof groups)[number], spaced: boolean) => (
    <ProjectGroup
      key={entry.project.id}
      project={entry.project}
      grip={grip(entry.project.id)}
      loud={entry.bands}
      moved={entry.moved}
      // A FOCUSED project never folds, whatever the list remembers: its row there has no fold button
      // (ProjectRow), so a fold set from All projects hid every thread on the project's own page with
      // nothing to bring them back but the yellow count (David 2026-09-30).
      collapsed={collapsed.has(entry.project.id) && !(view.kind === "project" && view.slug === entry.project.slug)}
      open={openBands}
      spaced={spaced}
      home={home}
      activeKey={activeKey}
      onQueuedRow={onQueuedRow}
      switcher={view.kind === "project" && view.slug === entry.project.slug ? switcher : undefined}
    />
  )
  return (
    <>
      {switcher && view.kind === "all" && (
        <div data-xq-switcher-row className={`${ROW_CLASS} after:hidden`}>
          <div className={`${HEAD_BUTTON_CLASS} !gap-0`}>{switcher}</div>
        </div>
      )}
      {/* A quiet project is one line, and two of them need nothing between them; anything beside a busy
          project gets the group gap. */}
      {listed.map((entry, index) =>
        group(
          entry,
          index > 0 ? entry.bands.rows > 0 || listed[index - 1]!.bands.rows > 0 : switcher !== undefined && view.kind === "all",
        ),
      )}
    </>
  )
}


/** What a group needs to be dragged: its element, its displacement, and its row's handlers. */
interface Grip {
  ref: (element: HTMLElement | null) => void
  /** Px to translate the group by: the pointer's travel when held, a slide aside when passed over. */
  offset: number
  held: boolean
  /** Whether ANY group is held — the others animate only then, so a re-sort after a drop does not glide. */
  dragging: boolean
  onPointerDown: (event: PointerEvent_<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent_<HTMLButtonElement>) => void
}

/** A drag in flight, within one run. `toIndex` is derived from `deltaY` every move (lib/railReorder.ts). */
interface ListDrag {
  run: readonly string[]
  fromIndex: number
  toIndex: number
  deltaY: number
  pitch: number
}

/** The row is a fold first, so a drag starts only past a press. */
const DRAG_THRESHOLD_PX = 4

/**
 * The click a drag ends with is swallowed, and nothing later — a module-scoped stamp rather than state,
 * so it survives the re-render the drop causes without adding one of its own.
 */
let lastDragEndedAt = 0
function justDragged(): boolean {
  return Date.now() - lastDragEndedAt < 250
}

/** A project that can hold a place in the order: one the server has a card for, Home included. */
function orderable(project: QueuesProject): boolean {
  return project.card !== undefined
}

/**
 * The list's drag and keyboard reorder, writing the machine-wide order.
 *
 * TWO COPIES OF THE NEW ORDER, for two readers. The list holds its own (`pending`) from the drop until
 * the projects it is handed agree with it: it is set in the same React batch that lets go of the drag,
 * so the group lands where it was dropped with no frame back in its old slot. And the `projectsList`
 * cache is rewritten at once, so every reader moves with it before the server answers; the server's answer
 * replaces that, and a failure puts back what was there.
 */
function useListReorder(projects: readonly QueuesProject[]) {
  const queryClient = useQueryClient()
  const [drag, setDrag] = useState<ListDrag | null>(null)
  const [pending, setPending] = useState<string[] | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const reorder = useMutation({
    mutationFn: ({ ids }: { ids: string[]; before: ProjectCard[] | undefined }) => rpc.projectsReorder({ ids }),
    onSuccess: (cards) => queryClient.setQueryData(["projectsList"], cards),
    onSettled: () => setPending(null),
    onError: (_error, { before }) => {
      if (before) queryClient.setQueryData(["projectsList"], before)
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
    },
  })
  const ordered = useMemo(() => (pending ? byOrder(projects, pending, (project) => project.id) : projects), [projects, pending])
  const order = ordered.filter(orderable).map((project) => project.id)
  const handed = projects.filter(orderable).map((project) => project.id).join()
  // Let go of the list's copy once the projects it is handed say the same thing — which is at once, since
  // the cache was rewritten with it. `onSettled` lets go regardless, for a list that moved on meanwhile.
  useEffect(() => {
    if (pending && handed === pending.join()) setPending(null)
  }, [handed, pending])

  const commit = (run: readonly string[], fromIndex: number, toIndex: number) => {
    const next = placeAmong(order, run, fromIndex, toIndex)
    if (next.join() === order.join()) return
    setPending(next)
    void queryClient.cancelQueries({ queryKey: ["projectsList"] })
    const before = queryClient.getQueryData<ProjectCard[]>(["projectsList"])
    if (before) queryClient.setQueryData(["projectsList"], byOrder(before, next, (card) => card.id))
    reorder.mutate({ ids: next, before })
  }

  const ref = (id: string) => {
    let bound = refs.current.get(id)
    if (!bound) {
      bound = (element) => {
        if (element) elements.current.set(id, element)
        else elements.current.delete(id)
      }
      refs.current.set(id, bound)
    }
    return bound
  }

  // THE HANDLERS ARE ONE FUNCTION PER PROJECT FOR THE PAGE'S LIFE, reading this render's runs and
  // `commit` through `current` when they fire. A grip whose handlers were fresh closures every render made
  // every ProjectGroup's props differ on every poll, so the group's memo could never hold (see ProjectGroup).
  const current = useRef<{ runOf: (id: string) => string[] | undefined; commit: typeof commit }>({ runOf: () => undefined, commit })
  const handlers = useRef(new Map<string, Pick<Grip, "onPointerDown" | "onKeyDown">>())
  const handlersOf = (id: string) => {
    let bound = handlers.current.get(id)
    if (!bound) {
      bound = { onPointerDown: (event) => onPointerDown(id, event), onKeyDown: (event) => onKeyDown(id, event) }
      handlers.current.set(id, bound)
    }
    return bound
  }

  const onPointerDown = (id: string, event: PointerEvent_<HTMLButtonElement>) => {
    const { runOf, commit } = current.current
    // Left button only, never modified: those clicks are someone else's.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const run = runOf(id)
    if (!run || run.length < 2) return
    const fromIndex = run.indexOf(id)
    const button = event.currentTarget
    // The list's own scroll box when it has one; stacked under the queue, the page scrolls instead.
    const scroller = button.closest<HTMLElement>("[data-xq-rail]")
    const scrollTop = () => scroller?.scrollTop ?? window.scrollY
    const startY = event.clientY
    const startScroll = scrollTop()
    let boxes: ListBox[] = []
    let started = false
    let latest: ListDrag | null = null
    let frame = 0

    const apply = (clientY: number) => {
      // Auto-scroll near the scroll box's edges, folding the scroll into the delta — a list longer than
      // its column is otherwise reorderable only within one screen of itself.
      if (scroller) {
        const velocity = edgeScrollVelocity(clientY, scroller.getBoundingClientRect())
        if (velocity) scroller.scrollTop += velocity
      }
      const deltaY = clientY - startY + scrollTop() - startScroll
      latest = { run, fromIndex, toIndex: listDropIndex(boxes, fromIndex, deltaY), deltaY, pitch: listPitch(boxes, fromIndex) }
      setDrag(latest)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
        button.setPointerCapture(moveEvent.pointerId)
        // Measured ONCE, as laid out before anything moved: the transforms that follow would skew any
        // later reading, and this snapshot is what every hit-test is against.
        boxes = run.map((runId) => {
          const box = elements.current.get(runId)?.getBoundingClientRect()
          return { top: box?.top ?? 0, height: box?.height ?? 0 }
        })
      }
      moveEvent.preventDefault()
      const clientY = moveEvent.clientY
      // One update per frame, and the loop keeps running while the pointer is HELD STILL in the edge
      // zone, which a move-driven update alone never would.
      cancelAnimationFrame(frame)
      const tick = () => {
        apply(clientY)
        if (scroller && edgeScrollVelocity(clientY, scroller.getBoundingClientRect())) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }

    const onUp = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      setDrag(null)
      if (!started || !latest) return
      lastDragEndedAt = Date.now()
      commit(run, latest.fromIndex, latest.toIndex)
    }

    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  // Alt+Arrow, not bare arrows: a bare arrow on a focused button is how the page scrolls. The row's
  // button is the same element after the move (keyed by project), so focus rides along with it.
  const onKeyDown = (id: string, event: KeyboardEvent_<HTMLButtonElement>) => {
    const { runOf, commit } = current.current
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    const run = runOf(id)
    if (!run) return
    const fromIndex = run.indexOf(id)
    const toIndex = fromIndex + (event.key === "ArrowUp" ? -1 : 1)
    // Claimed even at either end, where it moves nothing: unclaimed, the page would hear ⌥↑/⌥↓ as a
    // step to another project (AllQueues.tsx) on a row that is being reordered.
    event.preventDefault()
    if (toIndex < 0 || toIndex >= run.length) return
    commit(run, fromIndex, toIndex)
  }

  /** The grip for each project, given the run(s) the list drew, in its order. */
  const grips = (groups: readonly (readonly QueuesProject[])[]) => {
    const runs = groups.map((group) => group.filter(orderable).map((project) => project.id))
    const runOf = (id: string) => runs.find((run) => run.includes(id))
    current.current = { runOf, commit }
    return (id: string): Grip | undefined => {
      if (!runOf(id)) return undefined
      const index = drag ? drag.run.indexOf(id) : -1
      const held = drag !== null && index === drag.fromIndex
      // The held group follows the pointer; the ones it has passed slide one pitch towards its old slot.
      const offset = !drag || index < 0 ? 0 : held ? drag.deltaY : shiftFor(index, drag.fromIndex, drag.toIndex, drag.pitch)
      return { ref: ref(id), offset, held, dragging: drag !== null, ...handlersOf(id) }
    }
  }

  return { ordered, grips }
}

/** `list` in `ids`' order; anything `ids` does not name keeps its relative place, after them. */
function byOrder<T>(list: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]))
  const at = (item: T) => rank.get(idOf(item)) ?? ids.length
  return [...list].sort((a, b) => at(a) - at(b))
}

/**
 * READ EVERY PROJECT'S BOARD AHEAD, once the page is idle, so opening one never waits on a round trip
 * (lib/projectBoards.ts). And when a project's Done count moves in the poll — a thread finished or reopened
 * anywhere — its cached board is stale, so it is dropped; an open project's live query refetches at once.
 *
 * ONLY WHILE ALL PROJECTS IS SHOWING (`showingAll`), P12 in plans/upstream-superset.md: upstream's server
 * opens a project lazily because reading forty boards to draw forty cards is the cost lazy activation
 * exists to avoid, and a project's own board lists only that project, whose board is already live. Its
 * rows there need nothing read ahead; a click on another project's row still reads its board under the
 * pointer (ProjectGroup's `onPointerEnter`).
 */
function useReadAhead(projects: QueuesProject[], showingAll: boolean) {
  const queryClient = useQueryClient()
  const ids = projects.filter((project) => project.open && !project.stale).map((project) => project.id)
  const signature = showingAll ? ids.join(",") : ""
  useEffect(() => {
    if (!signature) return
    const timer = window.setTimeout(() => {
      for (const id of signature.split(",")) prefetchProjectBoard(queryClient, id)
    }, PREFETCH_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [signature, queryClient])
  const counts = useRef(new Map<string, number>())
  useEffect(() => {
    for (const project of projects) {
      const before = counts.current.get(project.id)
      counts.current.set(project.id, project.doneCount)
      if (before !== undefined && before !== project.doneCount) {
        void queryClient.invalidateQueries({ queryKey: projectBoardKey(project.id) })
      }
    }
  }, [projects, queryClient])
}

/**
 * One project: its row, its work in flight in its named bands, the counts of the rest, and whichever of
 * the rest is open; folded away, only its row.
 *
 * ITS COST BEYOND ITS OWN ROWS is what upstream's sidebar was tuned for and what this group is held to — the
 * whole group has to read as its threads, with a name over them, and not as a frame the threads sit in.
 * Measured on a seeded stack (sans, the heavy load: 17 projects, 70 open threads; the planning thread's
 * sidebar/seed-scale.ts, gated by capacityParity.e2e.test.ts):
 *
 *   the project's row          23px  (27 until 2026-09-29: 2px of padding a side, not 4 — the 16px square
 *                                     still has 3.5px around it, and nothing wraps in it)
 *   a band's name, per band     0px  (none since 2026-10-01: the count on the project's row is its only
 *                                     handle; 15px before, and upstream's was a 23.7px header under a 25px rule)
 *   "N more"                    0px  (on the project's row since 2026-10-06, MoreToggle; a 23px row of its
 *                                     own under the threads from 2026-10-01)
 *   the space before the next   6px  (GROUP_GAP; a 13px gap with a hairline in it 2026-10-01 to 10-06)
 *
 * so a busy project costs 23 + 6 = 29px beyond its rows — about one thread row (27.5px) — measured 28.3px
 * a project across the heavy load, against 55px with the "N more" row and the rule (59 by the table). That
 * is the difference between 17 lines and 23 on a 1440x900 screen, and 22 and 29 on a 1920x1080 one,
 * where upstream's board, one project, shows 22 / 28. Earlier: 59px while both loud bands
 * were named, 80 while the quiet counts sat on a 21px line of their own (2026-09-29 only), 66 before the
 * bands had names — and the same project in upstream's sidebar, one project per page, cost 267px for its six
 * headers and five rules.
 *
 * Its FOCUS project (the page project, whose board is live in the store) reads the rest from that board;
 * every other reads its board through the cache, which the list read ahead.
 */
type ProjectGroupProps = Parameters<typeof ProjectGroupRows>[0]

/**
 * MEMOIZED, because the page above it re-renders on every poll and every board push, and without this
 * every project's group — its row, its "…" menu, every one of its rows' props — re-rendered with it:
 * ~85ms of main thread per poll on an 8-project dev page, when one project had changed (measured
 * 2026-10-01 with react-scan; it is what made an unpin feel slow after its own fix). An unchanged
 * project now keeps its object across polls (allQueues.ts queuesProjects), its grip keeps its handlers
 * (useListReorder), and this compares the rest by what it draws.
 *
 * `moved` is not compared: it is a fresh closure every render, consulted only while the list is held, and
 * everything that changes its answer — a hidden card, a steer, an archive, an act from this tab — also
 * changes the bands it is handed. What the group reads for itself (the live board, the list hold, the
 * drawers, the route) it subscribes to directly, so those re-render it without its props changing.
 */
const ProjectGroup = memo(ProjectGroupRows, (a: ProjectGroupProps, b: ProjectGroupProps) =>
  a.project === b.project &&
  sameLoud(a.loud, b.loud) &&
  sameGrip(a.grip, b.grip) &&
  a.collapsed === b.collapsed &&
  a.open === b.open &&
  a.spaced === b.spaced &&
  a.home === b.home &&
  a.onQueuedRow === b.onQueuedRow &&
  // Only the focused project's group is handed one (ProjectList `switcher`), so this re-renders that one.
  a.switcher === b.switcher &&
  // The scrollspy's card moves on every scroll; it lights a row only in its own project.
  (a.activeKey === b.activeKey || (!ownKey(a.project.id, a.activeKey) && !ownKey(b.project.id, b.activeKey))))

function ownKey(projectId: string, key: string | null): boolean {
  return key !== null && key.startsWith(`${projectId}/`)
}

function sameRows(a: readonly ThreadView[], b: readonly ThreadView[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

function sameLoud(a: LoudBands, b: LoudBands): boolean {
  return sameRows(a.pinned, b.pinned) && sameRows(a.ready, b.ready) && sameRows(a.working, b.working) &&
    a.carded.size === b.carded.size && [...a.carded].every((id) => b.carded.has(id))
}

function sameGrip(a: Grip | undefined, b: Grip | undefined): boolean {
  if (!a || !b) return a === b
  return a.ref === b.ref && a.offset === b.offset && a.held === b.held && a.dragging === b.dragging && a.onPointerDown === b.onPointerDown
}

function ProjectGroupRows({
  project,
  grip,
  loud,
  collapsed,
  open,
  spaced,
  home,
  activeKey,
  onQueuedRow,
  moved,
  switcher,
}: {
  project: QueuesProject
  grip: Grip | undefined
  loud: LoudBands
  /** Whether this tab just moved the thread — its row is not held (lib/heldLayout.ts). */
  moved: (slug: string) => boolean
  collapsed: boolean
  /** Every project's open quiet bands, as crossProject.ts `bandKey`s. */
  open: ReadonlySet<string>
  spaced: boolean
  home: string | undefined
  activeKey: string | null
  onQueuedRow: (key: string) => number | null
  /** The view's switcher, on the focused project's row (ProjectList `switcher`). */
  switcher?: ReactNode
}) {
  const focus = projectSlug(useLocation().pathname)
  const snap = useSnapshot(store)
  // The live board's SLUG first, unconditionally, and the board itself only for the page's own project.
  // valtio re-renders on the fields a render READ: a group that read `snap.board` and then short-circuited
  // before touching any field of it (every group but the focus's, on All projects) re-rendered on every
  // board push, memo or not (measured 2026-10-01: all 8 groups on each push).
  const onPage = snap.board?.projectSlug === project.slug && project.slug === focus
  const live = onPage ? (snap.board as BoardSnapshot) : null
  const opened = collapsed ? [] : QUIET_BANDS.filter((band) => open.has(bandKey(project.id, band)))
  // Recent rows under folded quiet bands (prefs `showRecentThreads`) need the Done rows, so the board is read then too.
  const { showRecentThreads } = useSnapshot(prefs)
  const cached = useProjectBoard(project.id, (opened.length > 0 || (showRecentThreads && !collapsed)) && !onPage && project.open)
  const [donePage, setDonePage] = useState(DONE_PAGE)
  const board = onPage ? live : cached
  const quiet = useMemo(() => quietBands(project, board), [project, board])
  // Only the page project's drawers can be open on this page, so only its rows can be the one up in one.
  const openSlug = onPage ? drawerThreadSlug(snap.drawers) : null
  const scope = useRowScope(project, onPage, onQueuedRow)
  const queryClient = useQueryClient()
  const carded = loud.carded
  // THE BANDS AS DRAWN — live, or held as they were while the pointer is over the list (lib/listHold.ts,
  // lib/heldLayout.ts). Listed fresher-first, so a thread a cached board still lists elsewhere is drawn
  // once, where the poll puts it.
  const held = useListHold()
  const target = [
    { id: "pinned", items: loud.pinned },
    { id: "ready", items: loud.ready },
    { id: "working", items: loud.working },
    { id: "snoozed", items: quiet.snoozed },
    { id: "done", items: quiet.done ?? [] },
    { id: "external", items: quiet.external },
  ] satisfies { id: ListBand; items: ThreadView[] }[]
  const drawnBands = useRef<HeldSection<ThreadView>[]>([])
  const bands = holdLayout({
    prev: drawnBands.current,
    target,
    keyOf: (t) => t.id,
    frozen: held,
    moved,
    live: (slug) => [...project.queued, ...project.running, ...project.snoozed, ...project.pinnedDone, ...(board?.threads ?? [])].find((t) => t.id === slug),
  })
  drawnBands.current = bands
  // The band each thread is in NOW: a held row is drawn in its old place but as what it is — a rest time if
  // it is Ready, a spinner if it is working — since only the layout is held, never what a row says.
  const bandNow = new Map(target.flatMap((band) => band.items.map((t) => [t.id, band.id] as const)))
  const slots = (band: ListBand) => bands.find((section) => section.id === band)?.slots ?? []
  const row = (slot: HeldSlot<ThreadView>) => {
    const t = slot.item
    const band = bandNow.get(t.id)
    return (
      <RailRow
        key={t.id}
        t={t}
        active={activeKey === threadKey(project.id, t.id)}
        open={openSlug === t.id}
        restedAge={band === "ready"}
        scope={scope}
        cardKey={carded.has(t.id) ? threadKey(project.id, t.id) : undefined}
        band={band === "pinned" || band === "ready" || band === "working" ? band : undefined}
        held={slot.held}
      />
    )
  }
  return (
    <section
      ref={grip?.ref}
      aria-label={project.name}
      data-xq-rail-project={project.id}
      data-xq-project-collapsed={collapsed || undefined}
      data-xq-project-drilled={opened.length > 0 || undefined}
      data-xq-project-held={grip?.held || undefined}
      // Lifted while held: the page's own colour under it, so the rows it slides over do not show through,
      // and a shadow that says it is off the list. `relative` so the lift stacks above its neighbours.
      className={`${spaced ? GROUP_GAP : ""} ${grip?.held ? "relative z-10 cursor-grabbing rounded-md bg-bg shadow-lg shadow-shadow-ink/50" : ""}`}
      style={{
        transform: grip?.offset ? `translateY(${grip.offset}px)` : undefined,
        // The held group tracks the pointer exactly; the ones it passes are what animate.
        transition: grip?.dragging && !grip.held ? "transform 160ms ease" : undefined,
      }}
      // The rows are in the cache before the click lands (lib/projectBoards.ts).
      onPointerEnter={() => {
        if (!onPage && project.open && !project.stale) prefetchProjectBoard(queryClient, project.id)
      }}
    >
      <ProjectRow
        project={project}
        grip={grip}
        busy={loud.rows > 0}
        pinned={loud.pinned.length}
        working={loud.working.length}
        count={loud.ready.length}
        quiet={quiet}
        opened={opened}
        collapsed={collapsed}
        home={home}
        switcher={switcher}
        more={
          // The rest of the project, in words, on its own line — while its list is showing at all.
          !collapsed && (loud.rows > 0 || opened.length > 0) ? (
            <MoreToggle
              project={project}
              quiet={quiet}
              opened={opened}
              doneDrawn={Math.min(donePage, slots("done").length)}
              onMore={() => setDonePage((page) => page + DONE_PAGE * 2)}
              onLess={() => setDonePage(DONE_PAGE)}
            />
          ) : undefined
        }
      />
      {!collapsed && (
        <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
          {/* The loud bands, UNNAMED: a pinned row wears its pin, a Ready row its rest time and a Working
              row its spinner, so a name over any of them said what the rows already did (maintainer
              2026-09-29: "let the icons show what is working", then Ready, then "just a pin icon next to
              the threads that are pinned"). */}
          {slots("pinned").map(row)}
          {slots("ready").map(row)}
          {slots("working").map(row)}
          {showRecentThreads &&
            (["snoozed", "done"] as const).filter((band) => !opened.includes(band)).flatMap((band) => recentOf(slots(band), (slot) => slot.item.id)).map(row)}
          {opened.length > 0 && <QuietBands project={project} quiet={quiet} slots={slots} opened={opened} row={row} donePage={donePage} />}
        </ThreadProjectScope>
      )}
    </section>
  )
}

/** The quiet bands, in the order the list gives them. Schedules last: the one band of the four that is not
 *  threads, so it reads as the project's future rather than part of its past. */
const QUIET_BANDS: readonly QuietBandKey[] = ["snoozed", "done", "external", "schedules"]

/** Every band a project's rows are drawn in, loud then quiet — the sections lib/heldLayout.ts holds. */
type ListBand = "pinned" | "ready" | "working" | QuietBandKey

interface QuietBands {
  snoozed: ThreadView[]
  /** Undefined until the project's board has been read — the COUNT is the poll's, and known at once. */
  done: ThreadView[] | undefined
  doneCount: number
  external: ThreadView[]
  /** The project's schedules — the poll's count; the rows are read when the band opens (ScheduleRows). */
  schedules: number
  /** One of them wants the human: paused by Ntwine, or a proposal waiting for Turn on. */
  schedulesAttention: boolean
}

/**
 * What the project row keeps quiet: its Snoozed rows (from the poll, so always current), its Done rows and
 * its External sessions (from its board). Pinned rows are listed loud whatever their state — a pinned Done
 * one included, which the poll carries (lib/listBands.ts) — so none of them is counted twice.
 */
function quietBands(project: QueuesProject, board: BoardSnapshot | null | undefined): QuietBands {
  const snoozed = project.snoozed.filter((t) => !isPinned(t))
  const schedules = { schedules: project.schedules?.count ?? 0, schedulesAttention: project.schedules?.attention ?? false }
  if (!board) return { snoozed, done: undefined, doneCount: project.doneCount, external: [], ...schedules }
  const done = sectionThreads(board.threads).inactive
  return { snoozed, done, doneCount: done.length, external: externalThreads(board.threads), ...schedules }
}

/** How many rows a quiet band holds. */
function quietCount(quiet: QuietBands, band: QuietBandKey): number {
  return band === "snoozed" ? quiet.snoozed.length : band === "done" ? quiet.doneCount : band === "schedules" ? quiet.schedules : quiet.external.length
}

/**
 * Where a row of this project leads — ONE object per project, so the rail's memoized rows are not handed
 * a new scope on every poll. A Ready row brings its card into view when the queue is showing it, and every
 * other click opens the thread's drawer in place, which moves the page to its project for as long as the
 * drawer is open (useOpenThreadInPlace).
 */
function useRowScope(project: QueuesProject, page: boolean, onQueuedRow: (key: string) => number | null): RowScope {
  const openInPlace = useOpenThreadInPlace()
  const slug = project.slug
  const id = project.id
  const name = project.name
  const open = useCallback(
    (t: ThreadView) => {
      if (queued(t) && onQueuedRow(threadKey(id, t.id)) !== null) return
      openInPlace({ slug, id, name }, t.id, displayTitle(t))
    },
    [id, slug, name, onQueuedRow, openInPlace],
  )
  return useMemo(() => ({ open, page }), [open, page])
}

/**
 * A project's own row — the same for a busy project heading its threads and a quiet one alone.
 *
 * ITS CLICK FOLDS THE PROJECT (David 2026-09-28: "we need a primary collapse button that would easily
 * allow you to visually filter which projects you're looking at"). A busy project folds away EVERYTHING
 * under its row — its work in flight and, if any is open, the rest — and a second click brings it all
 * back; each quiet band opens from its own count on the row (QuietToggles). Unfolding a project with nothing Ready opens the rest too (David 2026-10-01: "if a project has
 * nothing ready, clicking expand should probably expand done/snoozed etc. as well") — its work in flight is
 * all it would show, and none of it wants you. A quiet project has nothing under it but the rest, so its
 * click opens every quiet band it has, and folds them away again.
 * Nothing navigates. The whole row is the fold's target; only its own controls sit above it.
 *
 * BESIDE ITS NAME, "N more" (MoreToggle) while its list is showing — the rest of the project, said in words
 * on the line the project already spends, rather than on a row of its own under its threads.
 *
 * ON HOVER, WHAT UPSTREAM'S PROJECT CARD SAID (U:ProjectGrid.tsx, the grid the fork's home replaced): its
 * folder, its `/slug` when that is not just its name, and when it was last opened — or that its directory
 * is missing. A tooltip over the whole row, with the fold it performs on the last line, and the same facts
 * head its "…" menu (ProjectActions.tsx ProjectMenu). A row is one line of 13px type and has no room for
 * three more; the card's facts are reference, read when wanted, never chrome on a busy list.
 *
 * Its right edge carries, in order: the quiet bands' counts — each ITS OWN toggle, always here, folded or
 * not, so opening one never moves the rest (David 2026-09-29, reversing a morning's move of them under
 * the threads: "don't move the done/snooze/external buttons when expanding just always leave them at the
 * top") — then its Ready count: the accent
 * badge, the one number in the list that wants you, which stays when the project is folded so a folded
 * project still says it is waiting. Or, in their place, a note, only when something is wrong: its directory
 * is gone, or this server has not opened it. On hover the badge gives way to the "…" (ProjectActions.tsx
 * ProjectMenu): the page's view, its repo, its icon, rename and delete. The badge's slot is held even when
 * empty, so the counts never slide under the menu.
 */
function ProjectRow({
  project,
  grip,
  busy,
  count,
  quiet,
  opened,
  collapsed,
  pinned,
  working,
  home,
  switcher,
  more,
}: {
  project: QueuesProject
  grip: Grip | undefined
  busy: boolean
  count: number
  quiet: QuietBands
  opened: readonly QuietBandKey[]
  collapsed: boolean
  /** Its Pinned and Running rows — counted on the row while it is folded, the one state that hides them. */
  pinned: number
  working: number
  home: string | undefined
  switcher?: ReactNode
  /** "N more" / "Show less" (MoreToggle), beside the name — while the project's list is showing. */
  more?: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()
  const view = usePageView()
  const focused = view.kind === "project" && view.slug === project.slug
  const note = project.stale ? "Directory is missing" : !project.open ? "Not open" : null
  const quietBandsHere = QUIET_BANDS.filter((band) => quietCount(quiet, band) > 0)
  // A project with nothing Ready and nothing Working — at most its pins — opens the rest like a quiet one
  // rather than folding its pins away (David 2026-10-01: "if a project has no ready/working threads,
  // the expand button should open done"). Its pins stay listed either way.
  const folds = busy && count + working > 0
  // Whether anything is listed under the row: the fold's own state, on either kind of project.
  const unfolded = folds ? !collapsed : opened.length > 0
  const fold = () => {
    if (folds) {
      setProjectCollapsed(project.id)
      if (collapsed && count === 0) setBandsOpen(project.id, quietBandsHere, true)
      return
    }
    // A quiet project folds only the rest. A fold left over from when it was busy is lifted, so the click
    // always shows what it says it will.
    setProjectCollapsed(project.id, false)
    setBandsOpen(project.id, quietBandsHere, opened.length === 0)
  }
  const foldTitle = folds
    ? `${collapsed ? "Show" : "Collapse"} ${project.name}'s threads`
    : `${opened.length > 0 ? "Hide" : "Show"} everything in ${project.name}`
  // The card's facts over the fold it performs: native, so it waits for a pause of the pointer rather than
  // flashing open as the pointer crosses the list (the app's Tooltip opens at once, by design).
  const facts = project.card ? projectFacts(project.card) : undefined
  const path = project.card?.path || project.projectDir
  const hoverTitle = [path && shortPath(path, home), facts, foldTitle].filter(Boolean).join("\n")
  return (
    <div
      data-xq-project-row={project.id}
      className={`${ROW_CLASS} ${project.stale ? "opacity-60" : ""} ${menuOpen ? SELECTED_ROW : ""}`}
    >
      {/* FOCUSED, THE PAGE'S TITLE NAMES THE PROJECT (StatusRow.tsx, the switcher), so its row here keeps
          only its counts and "…": the name drawn twice, 180px apart, was the page's one duplicate
          (David 2026-09-29). Nor does it fold — putting away every thread of the only project on the
          page leaves nothing to look at. With no square the cord starts at the first band name instead
          (ThreadConnector ties only rows that carry an indicator). */}
      {focused ? (
        // …unless there is no such title (an editor's sidebar): the switcher takes the slot, in the head
        // button's own geometry, so its square stands in the rows' indicator column.
        switcher ? (
          <div className={`${HEAD_BUTTON_CLASS} !gap-0`}>{switcher}</div>
        ) : more ? (
          // With no name to sit beside, "N more" takes the thread titles' column, where its row was — in
          // the 19px this row already had from its counts, not the 23 a named row takes: grown to 23, it
          // cost the project board its 29th row at 1920x1080 (capacityParity.e2e.test.ts, 29 → 28).
          <span className="flex h-[19px] min-w-0 flex-1 items-baseline pl-[42px] pr-2">{more}</span>
        ) : (
          <span className="flex-1" />
        )
      ) : (
        <button
          type="button"
          data-xq-project-fold
          // Folding a project, or dragging it by this row, reshapes the list by the human's own hand
          // (lib/listHold.ts): the list follows it rather than holding what they asked for.
          data-xq-reshape
          onClick={() => {
            // A drag ENDS over the row it lifted, so the browser fires a click on release; that one is not
            // a fold.
            if (justDragged()) return
            fold()
          }}
          onPointerDown={grip?.onPointerDown}
          onKeyDown={grip?.onKeyDown}
          aria-expanded={unfolded}
          aria-label={foldTitle}
          title={hoverTitle}
          // The whole row is the target (the `before:` layer), not just the square: the name, the badge and
          // the space around them fold too. "N more", the counts and the "…" sit above it. The ring is the
          // layer's, so a keyboard focus outlines the row it folds rather than the square alone.
          className={`${HEAD_BUTTON_CLASS} !flex-initial shrink-0 !pr-0 items-center before:absolute before:inset-0 before:rounded-md before:content-[''] focus-visible:!ring-0 focus-visible:before:ring-1 focus-visible:before:ring-focus-ink-60`}
        >
          {/* THE DISCLOSURE, in the gutter the rail's scroll marker uses — where the rail's own collapsible
              band headers kept theirs, so the list folds the way the rail did. Only while it means
              something: on hover (and always on touch), and HELD whenever the project is not as it starts —
              a busy project folded away (pointing right), a quiet one showing the rest (turned down). A busy
              project open, the usual case, draws none, so the list is not a column of chevrons. */}
          <span
            aria-hidden
            data-xq-project-chevron
            className={`pointer-events-none absolute left-[4.5px] top-0.5 flex h-[19px] items-center text-muted-60 transition-[opacity,transform] ${unfolded ? "rotate-90" : ""} ${
              (folds ? collapsed : opened.length > 0) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"
            }`}
          >
            <ChevronRight size={11} />
          </span>
          {/* The top of the project's cord, which hangs from this square behind every band name's glyph and
              thread row's indicator under it (ThreadConnector). */}
          <span data-xq-indicator className={`${INDICATOR_SLOT} ${project.stale ? "grayscale" : ""}`}>
            <ProjectSquare project={project.card ?? squareCard(project)} size={16} />
          </span>
        </button>
      )}
      {/* THE NAME AND "N MORE", OUTSIDE THE FOLD BUTTON, so the two sit on one BASELINE the browser
          computes (`items-baseline`) — a 13px name and its 11px aside, each centred in its own box, read
          ~0.7px apart — and so "N more" can be a button of its own; a button cannot nest in the fold.
          Clicks on the name still fold: the fold's `before:` layer is positioned, so it paints, and hits,
          above this unpositioned line; only `relative` controls (MoreToggle) rise above it. `pl-2` is the
          head button's own 8px gap after the square, `pr-2` the gap to the counts. `gap-[5px]` puts the
          chevron's ink 8px off the name's, the square's own 8.25 on the other side: at `gap-2` it measured
          10.98 (the chevron paints 5.5 of its 11px box; scripts/ink-gaps.mjs, sans, dsf 4, 2026-10-06) and
          the aside floated off the name it qualifies. Held at the row's 23px: baseline-aligned, the 11px
          aside drops ~0.7px below the name's line box, and the line grew to 24. */}
      {!focused && (
        <span className="flex h-[23px] min-w-0 flex-1 items-baseline gap-[5px] py-0.5 pl-2 pr-2">
          <span className={`min-w-0 truncate text-[13px] leading-[19px] font-semibold ${busy ? "text-fg" : "text-fg/70"}`}>{project.name}</span>
          {more}
        </span>
      )}
      {focused && switcher && more && <span className="flex h-[23px] shrink-0 items-baseline py-0.5 pr-2">{more}</span>}
      {/* THE RIGHT EDGE, flush with every thread row's readings under it, and filled from the right: the
          Ready badge when there is one, then the counts, then — on hover — the "…". Each mark that
          appears takes its place on the LEFT of the ones already there, so nothing already drawn moves
          and the column lines up down the whole list (David 2026-10-01: "everything has to be right
          aligned so it all lines up and new icons appear as needed moving left"). It used to hold a
          19px slot for the badge on every row, so a project with no badge stood its counts 27px in from
          the thread clocks beneath it, and the "…" overlaid that slot on hover. Beside the fold rather
          than inside it: the counts are buttons of their own. */}
      <div className="flex shrink-0 items-center gap-2 self-stretch pr-1.5">
        {project.card && (
          <div className={`items-center group-hover:flex group-has-[:focus-visible]:flex [@media(hover:none)]:flex ${menuOpen ? "flex" : "hidden"}`}>
            <ProjectMenu
              project={project.card}
              home={home}
              githubRepo={project.githubRepo}
              focused={focused}
              onFocus={() => {
                // Leaving a project for All projects carries it over as the prompt box's pick, as the
                // switcher does (AllQueues.tsx Switcher).
                if (focused) rememberCrossProjectFocus(project.id)
                navigate(focused ? viewHref(ALL_PROJECTS) : projectViewHref(project.slug))
                glideTo(() => 0)
              }}
              onOpenChange={setMenuOpen}
            >
              <button type="button" aria-label={`More actions for ${project.name}`} className={`${ROW_ACTION_CLASS} data-[state=open]:bg-panel-2 data-[state=open]:text-fg data-[state=open]:opacity-100`}>
                <Ellipsis size={13} />
              </button>
            </ProjectMenu>
          </div>
        )}
        {note ? (
          <span className="text-[10.5px] leading-[19px] text-muted-55">{note}</span>
        ) : (
          <>
            <QuietToggles project={project} quiet={quiet} opened={opened} pinned={collapsed && folds ? pinned : 0} working={collapsed && folds ? working : 0} />
            {count > 0 && <span className="flex shrink-0"><QueueBadge count={count} /></span>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The rest of a project, before it is shown: one muted count per quiet band, in that band's glyph — the
 * rail's legend (BandLabel.tsx), so "zz 2 · ☑ 43" reads as the Snoozed and Done names they open onto.
 * Quieter than the name and never the accent, which in this product means only "this many want you".
 *
 * A FOLDED project counts its work in flight the same way, first: its Pinned rows by the pin, then its
 * Running rows by the bot (David 2026-09-29: "when collapsed ... it should also show the number of
 * running/ready threads"); its Queue rows are the accent badge beside these, which already stays through
 * a fold, so they are not counted twice. Pinned joined them on 2026-10-06 — every thread belongs to one of
 * five rails and that status must never leave view (upstream standup S1, plans/upstream-superset.md §1), and a fold
 * that hid a project's pins said nothing at all of them.
 *
 * EACH COUNT IS ITS OWN TOGGLE — Snoozed, Done and External open and close one at a time, all collapsed to
 * start. An open one is a step brighter, and its band lists under the project's threads, named. On a folded
 * project a click unfolds it too, so it always shows what it says; the Pinned and Running counts only unfold. Each
 * wash hangs 4px past its count's ink (`-mx-1 px-1`), so the ink stays exactly where it sat before the
 * counts were buttons; `relative`, to sit above the fold's whole-row target.
 */
function QuietToggles({ project, quiet, opened, pinned = 0, working = 0 }: { project: QueuesProject; quiet: QuietBands; opened: readonly QuietBandKey[]; pinned?: number; working?: number }) {
  const entries: { band: BandKey | "schedules"; count: number; noun: string }[] = [
    { band: "pinned", count: pinned, noun: "pinned" },
    { band: "working", count: working, noun: "running" },
    ...QUIET_BANDS.map((band) => ({ band, count: quietCount(quiet, band), noun: band === "schedules" && quietCount(quiet, band) === 1 ? "schedule" : band })),
  ]
  const shown = entries.filter((entry) => entry.count > 0)
  // A schedule just created from the prompt box for THIS project: its count flashes once (store.ts
  // flashScheduleCount, ARCHITECTURE.md § Scheduled threads).
  const scheduleFlash = useSnapshot(store).scheduleFlash
  if (shown.length === 0) return null
  return (
    <span data-xq-quiet-toggles className="flex shrink-0 items-center gap-2">
      {shown.map(({ band, count, noun }) => {
        // Schedules are no band of the rail's, so their glyph is their own: the repeat mark every surface
        // draws for a schedule (the prompt box's button, a run's title, the drawer).
        const Icon = band === "schedules" ? ScheduleCountGlyph : band === "pinned" ? PinCountGlyph : BANDS[band].Icon
        // The work in flight's counts only unfold: their rows are the project's own list, not a band to open.
        const inFlight = band === "pinned" || band === "working"
        const isOpen = !inFlight && opened.includes(band as QuietBandKey)
        // THE WARNING TONE, on the schedules count alone: one was paused by Ntwine, or a worker's proposal is
        // waiting for Turn on — the "it stopped two weeks ago and I never noticed" failure, said on the row.
        const attention = band === "schedules" && quiet.schedulesAttention
        const label = inFlight
          ? `Show ${count} ${noun}`
          : `${isOpen ? "Hide" : "Show"} ${count} ${noun}${attention ? " — one is waiting on you" : ""}`
        return (
          <button
            key={band}
            type="button"
            data-xq-quiet-count={band}
            data-xq-reshape
            aria-expanded={inFlight ? undefined : isOpen}
            aria-label={label}
            title={label}
            onClick={() => {
              setProjectCollapsed(project.id, false)
              // To the state the click SAW, not a toggle of whatever the store holds by now: two clicks
              // landing before a render (the row's fold and a count, from a script) must agree.
              if (!inFlight) setBandOpen(project.id, band as QuietBandKey, !isOpen)
            }}
            // The glyph sits on its DIGIT's cap band, not beside its box: box-centred, all three glyphs read
            // 1.5px low (sans, 10.5px). The pair shares one font size, set on the pair, so `cap` resolves
            // against the digit's font; `self-baseline` lands the 10px glyph's bottom on the digit's
            // baseline and the translate lifts its centre to the band's. Every band glyph's ink spans y 3–21
            // of its 24-unit box (SquareCheck, ExternalLink, BandLabel's SnoozeMark, Bot), so the box centre
            // is the ink centre for each.
            data-xq-quiet-attention={attention || undefined}
            data-sched-flash={band === "schedules" && scheduleFlash?.projectId === project.id ? "" : undefined}
            className={`relative -mx-1 flex h-[19px] shrink-0 items-baseline gap-[3px] rounded px-1 text-[10.5px] leading-[19px] outline-none transition-colors hover:bg-hover-strong focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
              attention ? "text-attention-soft hover:text-attention" : `hover:text-fg/80 ${isOpen ? "text-muted-80" : "text-muted-50"}`
            }`}
          >
            <span aria-hidden className="flex self-baseline translate-y-[calc(5px_-_0.5cap)]">
              <Icon size={10} />
            </span>
            <span aria-hidden className="tabular-nums">{count}</span>
          </button>
        )
      })}
    </span>
  )
}

/**
 * The quiet bands that are open, in the rail's own order — Snoozed, then Done (its most recent first, a
 * page at a time), then External, the project's own terminals, which a message takes over — their rows
 * alone, under the work in flight: each band's handle is its count on the project's row, and a Done or
 * Snoozed row wears its band in its own glyph. Off the cord: the cord is the work in flight
 * (ThreadConnector reads only the group's own children, and these sit in a container of their own).
 */
function QuietBands({
  project,
  quiet,
  slots,
  opened,
  row,
  donePage,
}: {
  project: QueuesProject
  quiet: QuietBands
  /** The rows each band DRAWS — held while the pointer is over the list, so a band whose last row left on
   *  its own keeps that row until the hold ends. */
  slots: (band: ListBand) => HeldSlot<ThreadView>[]
  opened: readonly QuietBandKey[]
  row: (slot: HeldSlot<ThreadView>) => ReactNode
  /** How many Done rows are listed — the rest are paged in by the group's MoreRow. */
  donePage: number
}) {
  const bands = opened.filter((band) =>
    band === "schedules" ? quiet.schedules > 0 : slots(band).length > 0 || (band === "done" && quiet.done === undefined && quiet.doneCount > 0))
  if (bands.length === 0) return null
  return (
    <div data-xq-drill={project.id} className="flex min-w-0 flex-col">
      {bands.map((band) => (
        <div key={band} data-xq-drill-band={band} data-xq-drill-open>
          {band === "schedules" && <ScheduleRows project={project} count={quiet.schedules} attention={quiet.schedulesAttention} />}
          {band !== "done" && band !== "schedules" && slots(band).map(row)}
          {band === "done" &&
            (slots("done").length > 0 ? (
              slots("done").slice(0, donePage).map(row)
            ) : (
              <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">
                Loading…
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

/** The schedules count's glyph, at the size every band glyph takes on the row (QuietToggles). */
// The schedules count's glyph, in the band glyphs' 10px box. `Repeat` inks y 1–23 of its 24 units where
// every band glyph inks 3–21, so at the shared 10px it drew 9.38px tall against their 8.38–8.50 and read
// as the biggest mark on the row (scripts/ink-gaps.mjs, dsf 8). Drawn at 90% inside the same 10px box —
// a viewBox padded by 1/18 of itself a side, not a 9px svg in a 10px wrapper: a wrapper's baseline is
// its svg's bottom, which dropped the glyph 0.5px under the band's lift (read +0.36px low against the
// others' -0.14). Now 7.75 x 8.38 ink against 8.5 x 8.38-8.5, 4.5px from its digit against 4.75.
function ScheduleCountGlyph({ size = 10 }: { size?: number }) {
  return <Repeat size={size} viewBox="-1.333 -1.333 26.667 26.667" />
}

// The folded Pinned count's glyph, by the same correction: lucide's Pin inks y 2–22 of its 24 units, so at
// the shared 10px its paths stood 8.33px tall against Done's and Snoozed's 7.5 — the loudest mark in the
// folded strip, on the band that is the human's own shelf and needs no extra weight. At 90% it is 7.5,
// centred on its digit's cap band with a 0.00px residual like the rest (geometry, sans, dsf 8, 2026-10-06).
function PinCountGlyph({ size = 10 }: { size?: number }) {
  return <Pin size={size} viewBox="-1.333 -1.333 26.667 26.667" />
}

/**
 * A project's SCHEDULES, listed in place under its row when its fourth count is open (plans/scheduled-
 * threads.md §8) — not a dialog: every count on the row opens its rows here, and this one does too. Read
 * when the band opens, through the project's own client, and again whenever the poll's count for it moves.
 *
 * A row is the thread row's anatomy (Sidebar.tsx ThreadRow) so the band reads as more of the same list: the
 * repeat glyph in the indicator column, the title, the rule inline in grey after it the way a working
 * thread's status sits, and the next run in the rest-time column — `in 3h`, or `Paused` / `Proposed` when it
 * will not run on its own, warning-toned when that is Ntwine's doing or a proposal's. A click opens the
 * schedule's drawer.
 */
export function ScheduleRows({ project, count, attention }: { project: QueuesProject; count: number; attention: boolean }) {
  const list = useQuery({
    // The poll's count and attention ride the key, so the list is read again the moment either moves.
    queryKey: [...scheduleKeys.list(project.id), count, attention],
    queryFn: () => projectRpc(project.id).listSchedules({}),
    enabled: project.open,
    // The next-run column counts down on the shared clock; the instants themselves move only when a run
    // starts, which the poll's count does not see.
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
  if (!list.data) {
    return <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">Loading…</div>
  }
  return <>{list.data.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />)}</>
}

function ScheduleRow({ schedule }: { schedule: ScheduleView }) {
  const now = useNowMs()
  const next = scheduleNextLabel(schedule, now)
  // Dimmed like a Snoozed row when it will not run on its own — unless that wants the human, which is the
  // one reading on this band that must not recede.
  const dim = schedule.state !== "active" && !schedule.attention
  return (
    <div data-xq-schedule-row={schedule.id} data-xq-schedule-state={schedule.state} className={`${ROW_CLASS} ${dim ? "sidebar-row-dim" : ""}`}>
      <button
        type="button"
        onClick={() => pushScheduleDrawer(schedule.id, schedule.projectId)}
        title={schedule.pausedText ?? schedule.echo}
        className={ROW_BUTTON_CLASS}
      >
        <span className={`${INDICATOR_SLOT} text-muted-60`}>
          <Repeat size={11} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className={`min-w-0 max-w-full shrink-0 break-words text-[13px] leading-[19px] ${dim ? "text-fg/75" : "text-fg/90"}`}>{schedule.title}</span>
            <span data-xq-schedule-rule className="min-w-0 flex-1 truncate text-[12px] leading-[19px] text-muted-70">{schedule.describe}</span>
          </span>
          <span data-xq-schedule-next className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] ${schedule.attention ? "text-attention-soft" : "text-muted-55"}`}>
            {next}
          </span>
        </span>
      </button>
    </div>
  )
}

/**
 * "⌄ N more" while any of a project's rest is not listed — a quiet band still closed, or Done rows past the
 * page — and "⌃ Show less" beside it once any of the rest is. It names no band (David 2026-10-01: "a little
 * expand button … at the bottom of each list … without the word done"): the rest is one continuation of
 * the list, and the counts on the project's row stay the way to open a single band. "More" opens every
 * closed band first, then pages Done; "less" closes them all. The rows it opens list under the project's
 * threads, in place.
 *
 * ON THE PROJECT'S OWN LINE, beside its name (ProjectRow), in the muted tone the quiet counts use — an aside
 * to the name, never a heading of its own. It was the last row of every unfolded project, at the titles'
 * column, until 2026-10-06: kept for David's "the counts alone proved too hidden", it cost each project a
 * 23px line, and at the heavy load (17 projects, 70 open threads) the "N more" rows, rules and headers took
 * ~55px a project and left 17 lines on a 1440x900 screen, where upstream's own board shows 22. The words stayed
 * and the row went (plans/upstream-superset.md §2). `relative`, so it stands above the fold's whole-row
 * target: a click here opens the rest, never folds the project.
 */
function MoreToggle({
  project,
  quiet,
  opened,
  doneDrawn,
  onMore,
  onLess,
}: {
  project: QueuesProject
  quiet: QuietBands
  opened: readonly QuietBandKey[]
  /** How many Done rows the open Done band lists right now. */
  doneDrawn: number
  onMore: () => void
  onLess: () => void
}) {
  const closed = QUIET_BANDS.filter((band) => quietCount(quiet, band) > 0 && !opened.includes(band))
  const unpaged = opened.includes("done") && quiet.done !== undefined ? Math.max(0, quiet.done.length - doneDrawn) : 0
  const more = closed.reduce((sum, band) => sum + quietCount(quiet, band), 0) + unpaged
  const less = opened.length > 0
  if (more === 0 && !less) return null
  // The chevron paints 5.5 of its 11 box px and sits 1px from its words, for a ~4px ink gap; gap-1 drew
  // 7px. Vertically it sits on its words' cap band the way the row's counts do (QuietToggles): box-centred,
  // it read 1px low (sans, 11px). Both chevrons' ink is symmetric in the box, so the box centre is the ink's.
  const action = "flex h-[19px] items-baseline gap-px rounded px-1 -mx-1 outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
  return (
    <span data-xq-more={project.id} className="relative flex shrink-0 items-baseline gap-3 text-[11px] leading-[19px] text-muted-55">
      {more > 0 && (
        <button
          type="button"
          data-xq-reshape
          data-xq-more-open
          className={action}
          onClick={() => {
            setProjectCollapsed(project.id, false)
            if (closed.length > 0) setBandsOpen(project.id, closed, true)
            else onMore()
          }}
        >
          <span aria-hidden className="flex self-baseline translate-y-[calc(5.5px_-_0.5cap)]">
            <ChevronDown size={11} />
          </span>
          <span className="tabular-nums">{more} more</span>
        </button>
      )}
      {less && (
        <button
          type="button"
          data-xq-reshape
          data-xq-more-close
          className={action}
          onClick={() => {
            setBandsOpen(project.id, QUIET_BANDS, false)
            onLess()
          }}
        >
          <span aria-hidden className="flex self-baseline translate-y-[calc(5.5px_-_0.5cap)]">
            <ChevronUp size={11} />
          </span>
          Show less
        </button>
      )}
    </span>
  )
}

/**
 * The last row of the list: a project the machine does not have yet. A dotted squircle, "nothing here yet" — at the row's scale, so it reads as an empty place in the same list rather
 * than a button bolted under it. Muted, and never accent: accent means only "this many want you".
 */
export function AddProjectRow() {
  const add = useAddProject()
  return (
    <div className={`${ROW_CLASS} ${GROUP_GAP}`}>
      <button type="button" data-xq-reshape onPointerEnter={warmProjectPicker} onFocus={warmProjectPicker} onClick={add.start} disabled={add.pending} className={`${ROW_BUTTON_CLASS} group/add items-center disabled:opacity-60`}>
        <span className={INDICATOR_SLOT}>
          <span className="flex h-4 w-4 items-center justify-center rounded-[30%] border border-dotted border-border-strong text-muted-70 transition-colors group-hover/add:border-fg/40 group-hover/add:text-fg">
            <Plus size={10} strokeWidth={2.25} />
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-muted-70 transition-colors group-hover/add:text-fg">
          {add.pending ? "Choosing a folder…" : "Add a project"}
        </span>
      </button>
    </div>
  )
}

/** A card-shaped stand-in for a project the registry list has not caught up with, for its square. */
function squareCard(project: QueuesProject) {
  return { id: project.id, slug: project.slug, name: project.name, path: project.projectDir ?? "", lastOpenedAt: "", stale: false, iconStatus: "unknown" as const }
}
