import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent as DragEvent_, type KeyboardEvent as KeyboardEvent_, type MouseEvent as MouseEvent_, type PointerEvent as PointerEvent_ } from "react"
import { Layers, Plus } from "lucide-react"
import { Link } from "react-router"
import { useSnapshot } from "valtio"
import type { ProjectCard, ProjectRailCounts } from "@ntwine/shared"
import { activeBandThread, boardAskThread } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { queued } from "../groups.ts"
import { asThreads } from "../hooks.ts"
import { store } from "../store.ts"
import { projectSlug } from "../lib/base-path.ts"
import { ALL_PROJECTS_HREF, projectViewHref, usePageView } from "../lib/pageView.ts"
import { optimisticallyArchived, useArchivingAt } from "../lib/optimisticArchive.ts"
import { optimisticallySteered, useSteeredAt } from "../lib/steering.ts"
import { dropIndex, edgeScrollVelocity, moveItem, shiftFor } from "../lib/railReorder.ts"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { glideTo } from "../lib/viewportLock.ts"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { useAddProject, warmProjectPicker } from "./ProjectActions.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE PROJECT RAIL — every project on this machine as one icon square, always on screen.
//
// Slack's and Discord's rail, and for their reason: once a person is working across a dozen
// workspaces, "which one am I in" and "take me to another" are constant questions, and a home page
// answers neither without a round trip. Ntwine reached the same point when one server started serving
// every project — upstream's project grid at `/` (this fork's All projects, `/all`) is a fine front door
// and a poor switcher.
//
// It is FIXED to the viewport's left edge, outside App's centered sidebar+workpane pair, so it holds
// still while the page scrolls and never enters the measure of anything else. App reserves its width
// with a padding-left on the container rather than a margin on the pair, so the pair still centers in
// whatever space is left.
//
// HIDDEN BELOW 800px, where the sidebar already stacks above the workpane and a permanent 56px column
// would be a tenth of the viewport spent on navigation. The switcher is the way there (a phone's own
// projects list, at `/`).

/**
 * The column's total painted width, and the inset every surface beside it reserves.
 *
 * 57 and not 56 because the rail is border-box and carries a 1px right border: at 56 the CONTENT box
 * is 55, and a 40px square centred in 55 sits half a pixel left of centre — measured at 7.5px on the
 * left against 8.5px on the right. 57 gives it a 56px content box and a true 8/8.
 *
 * Exported as a pair so the reserved space and the painted width cannot drift apart.
 */
export const RAIL_WIDTH_CLASS = "w-[57px]"
export const RAIL_INSET_CLASS = "max-[800px]:pl-0 pl-[57px]"
/** What a fixed-position surface must clear to sit beside the rail rather than under it. */
export const RAIL_WIDTH_PX = 57
//
// UPSTREAM'S RAIL (upstream Frizz 0a3b9139), restored 2026-10-06 when a project's board became the
// default view again. The fork had its own copy until 2026-09-30, when All projects was the home and the
// rail a third door onto it; with the board back as home, the rail is upstream's way between boards, and
// OPT-IN as upstream has it (Settings → Project sidebar, `projectRail`, off by default). It shows on a
// board and on All projects alike, in the layout (routes.tsx RootLayout), and never in an editor's frame.
// Where the fork's names differ it follows the fork:
//
//   · a square opens its project's BOARD, `/project/<slug>` (lib/pageView.ts), and the pill marks the
//     board the page is showing — on All projects, none;
//   · the top door goes to All projects, `/all`, and wears All projects' own mark, the switcher's layers
//     glyph: upstream's house is this fork's Home workspace square (ProjectSquare.tsx), which the rail
//     pins under the band, and two houses on one column would be two different places with one sign;
//   · the + is the fork's one way of adding a project (ProjectActions.tsx useAddProject: the native
//     picker, else the typed-path dialog the layout hosts), not upstream's navigate-to-the-grid fallback.

const SQUARE = 40

/**
 * The tail of a square's tooltip: `1 running, 2 in the queue`. The two words are the sidebar's own band
 * headings (RUNNING, QUEUE), so the rail names what it counts the way the rows it counts are labelled.
 * The badge draws the queue alone (see RailLink), so this is where the rail still says that a project
 * has work in flight.
 */
function railCountsLabel(queued: number, running: number): string {
  const parts: string[] = []
  if (running) parts.push(`${running} running`)
  if (queued) parts.push(`${queued} in the queue`)
  return parts.join(", ")
}

/**
 * The badge's width, a WHOLE pixel per digit count rather than sized to its text.
 *
 * Content-sized, a two-digit badge came out ~20.4px wide, and Chrome paints that box on whole pixels
 * (measured 2026-09-24, when a ring drawn round the badge sat 0.48px off a "12" because of it). A
 * whole-pixel width has the face painted where layout put it. 16 is the circle; 22 and 28 hold the
 * widest two and three digits ("88", "888") with the same side room a single digit gets.
 */
function badgeWidth(count: number): string {
  return count < 10 ? "w-[16px]" : count < 100 ? "w-[22px]" : "w-[28px]"
}

/**
 * A queue count on the bottom-right corner of a project's square on the rail.
 *
 * Proportional figures, not tabular: a badge centres ONE number, it aligns no column, and a tabular "1"
 * carries a fixed cell's worth of side-bearing that put the ink of "12" 1.02px left of the pill's centre.
 * Measured 2026-08-24 at 10px/600 in the sans UI font. The width is fixed per digit count (badgeWidth),
 * so the pill centres the digits itself.
 *
 * The cut-out is a WHOLE 1px. It was `border-[1.5px]`, and Chrome floors a fractional border to whole
 * CSS pixels at every scale (computed `1px` at dsf 1, 2 and 3, 2026-09-24), so the face painted 14px
 * where the numbers said 13. 1px is what Chrome was already drawing, so nothing moved there; it makes
 * every browser draw the same.
 */
function QueueBadge({ count, className, ...data }: { count: number; className: string; "data-rail-queue-count"?: number }) {
  return (
    <span
      aria-label={`${count} in the queue`}
      {...data}
      className={`pointer-events-none absolute flex h-[16px] ${badgeWidth(count)} items-center justify-center rounded-full border border-bg bg-accent-fill text-[10px] font-semibold leading-none proportional-nums text-on-accent ${className}`}
    >
      {/* The cap band, not the line box — the same fix the monogram uses (ProjectSquare.tsx), for the same reason:
          `items-center` centred the digits' LINE BOX and their ink rode 0.4–0.5px low in the sans
          UI font (measured 2026-08-24). Trimming the box to baseline→cap height makes the box the
          ink, so the browser centres it with nothing to re-measure when the type scale moves. */}
      <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
    </span>
  )
}

/**
 * The current project's square grows a pill on the rail's left edge.
 *
 * Discord's indicator, because the alternative — marking the square itself — competes with the icon
 * it is drawn on top of. The pill lives in the gutter, where nothing else does.
 */
export function RailLink({
  project,
  current,
  counts,
  index,
  drag,
  onPointerDown,
  onKeyDown,
}: {
  project: ProjectCard
  current: boolean
  /** This project's queue and Active band, or undefined when this server has not opened the project. */
  counts: ProjectRailCounts | undefined
  index: number
  drag: DragState | null
  onPointerDown: (event: PointerEvent_<HTMLAnchorElement>, index: number) => void
  onKeyDown: (event: KeyboardEvent_<HTMLAnchorElement>, index: number) => void
}) {
  const held = drag?.fromIndex === index
  const queued = counts?.queued ?? 0
  const inPlay = railCountsLabel(queued, counts?.running ?? 0)
  // The held square follows the pointer; everything between its old slot and its new one slides one
  // step to open the gap. `shiftFor` owns which is which — see lib/railReorder.ts.
  const offset = drag
    ? held
      ? drag.deltaY
      : shiftFor(index, drag.fromIndex, drag.toIndex)
    : 0
  return (
    // Suppressed while ANY square is held: the pointer is necessarily inside the square it is
    // dragging, so a delayDuration-0 tooltip would open on grab and then chase the square down the
    // rail. Passing a prop rather than unmounting the wrapper — remounting mid-drag would destroy the
    // element holding pointer capture.
    <Tooltip
      side="right"
      disabled={drag !== null}
      label={
        project.stale
          ? `${project.name} — directory is missing`
          : inPlay ? `${project.name} — ${inPlay}` : project.name
      }
    >
      <Link
        to={projectViewHref(project.slug)}
        aria-current={current ? "page" : undefined}
        // The rail is a reorderable list, and a link is not one. `listitem` + `aria-grabbed` is the
        // most a native anchor can say about it; the keyboard path below is what makes it true.
        aria-grabbed={held || undefined}
        onPointerDown={(event: PointerEvent_<HTMLAnchorElement>) => onPointerDown(event, index)}
        onKeyDown={(event: KeyboardEvent_<HTMLAnchorElement>) => onKeyDown(event, index)}
        onClick={(event: MouseEvent_<HTMLAnchorElement>) => {
          // A drag ENDS over a link, so the browser fires a click on release. Without this, every
          // reorder also navigated to whatever square you dropped on — and under a real router that
          // navigation is instant, so the wrong board would already be mounting.
          if (drag || justDragged()) { event.preventDefault(); return }
          // Another project's board is read from its top, as the switcher's choice is (AllQueues.tsx).
          if (!current) glideTo(() => 0)
        }}
        // Native image-drag would fight the pointer drag.
        onDragStart={(event: DragEvent_<HTMLAnchorElement>) => event.preventDefault()}
        className={`group relative flex h-10 w-full items-center justify-center outline-none ${
          held ? "z-10 cursor-grabbing" : ""
        }`}
        style={{
          transform: offset ? `translateY(${offset}px)` : undefined,
          // The held square must track the pointer exactly; its neighbours are the ones that animate.
          transition: held ? "none" : "transform 160ms ease",
        }}
      >
        {/* 28 of the square's 40px — 70%. Discord runs 40 of 48 (83%) and 24 of 40 read as a stub
            against the square beside it; 28 is the same confident mark at this size. The hover stub
            is deliberately short: it says "this one" without pretending to be the current page. */}
        <span
          aria-hidden
          className={`absolute left-0 w-[3px] rounded-r-full bg-fg transition-all duration-150 ${
            current ? "h-7 opacity-100" : "h-2.5 opacity-0 group-hover:opacity-60"
          }`}
        />
        <span
          className={`rounded-[30%] transition-[transform,opacity,box-shadow] duration-150 group-focus-visible:ring-1 group-focus-visible:ring-focus-ink-60 ${
            held
              ? "scale-[1.12] opacity-100 shadow-lg shadow-shadow-ink/50"
              : `group-hover:scale-[1.06] ${current ? "" : "opacity-75 group-hover:opacity-100"}`
          } ${project.stale ? "grayscale" : ""}`}
        >
          <ProjectSquare project={project} size={SQUARE} />
        </span>
        {queued ? (
          // THE QUEUE BADGE — how many threads in this project are waiting on the human, and nothing
          // else. From 2026-09-24 the number was the queue PLUS the threads in flight, with a spinner
          // lapping the badge while any were (issue #41); the maintainer took both back out on
          // 2026-10-11 ("showing just the number of threads in the queue is probably more useful for
          // what the average person needs"). Work in flight is named in the square's tooltip instead.
          //
          // THE PLACEMENT is Discord's: on the square's bottom-right corner, overlapping it, with a cut-out
          // border in the rail's own colour so it reads as sitting ON the square rather than beside it.
          // Accent, because the badge answers the queue's question: "go there". A SIBLING of the opacity
          // wrapper, not a child: a non-current square is dimmed to 75%, and a signal must not dim with
          // the surface it is reporting on. Positioned against the LINK (56px wide, the 40px square
          // centred in it), so `right-[3px]` puts the badge 5px past the square's right edge and
          // `-bottom-[5px]` 5px past its bottom — into the 8px gap, clear of the next square, and
          // inside the band's bottom padding for the last one.
          <QueueBadge count={queued} className="-bottom-[5px] right-[3px]" data-rail-queue-count={queued} />
        ) : null}
      </Link>
    </Tooltip>
  )
}

/** A drag in flight. `toIndex` is derived from `deltaY` every move — see lib/railReorder.ts. */
interface DragState {
  id: string
  fromIndex: number
  toIndex: number
  deltaY: number
  /**
   * The list the drag STARTED on, which the rail draws for as long as the square is held.
   *
   * `fromIndex` and `toIndex` are positions in this list and no other. The server now pushes a new
   * order the moment another tab makes one (api/board-stream.ts `refreshProjectList`), and drawing
   * that under a live drag would put a different project in the held slot and slide the wrong
   * neighbours aside. The drop still writes this list with the one move applied — the last
   * arrangement anyone made wins, which is what a whole-list write already means.
   */
  list: readonly ProjectCard[]
}

/**
 * A pointer-down that has not yet travelled far enough to BE a drag.
 *
 * The threshold is the whole reason this is separate state: a rail square is a link first, and
 * starting a drag on contact would mean every click landed a reorder before it navigated.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * A click fires on the element a drag ENDED over, after pointerup. This flag swallows exactly that
 * one, and nothing later — a module-scoped stamp rather than state, so it survives the re-render the
 * drop causes without adding one of its own.
 */
let lastDragEndedAt = 0
function justDragged(): boolean {
  return Date.now() - lastDragEndedAt < 250
}

/**
 * The rail's counts: each project's queue (its badge) and Active band (its tooltip), keyed by project id.
 *
 * TWO SOURCES, one per kind of project. The project on screen has a live board in the store — the
 * same rows the sidebar is drawing a few hundred pixels to the right — so its badge is counted from
 * that, with the same two predicates, and can never lag the rail it sits beside. Every OTHER project is
 * a poll of the server's cached snapshots (`projectsRailCounts`, machine-wide, see
 * lib/queryKeyScope.ts), because the live feed is one socket per project and a rail that opened a
 * socket per square would be forty boards' worth of push for a number. Five seconds: a badge for a
 * project you are not looking at is a "go there" cue, not a live readout. A project with no board on the
 * server has no count — it draws no badge, which is honest, rather than a zero, which is not. That is
 * now a transient state: the server opens every registered project within about a second of boot
 * (server/tenant-prime.ts), which is what ended having to click into each square before its badge
 * would appear.
 */
function useRailCounts(currentSlug: string | undefined, projects: readonly ProjectCard[]): (project: ProjectCard) => ProjectRailCounts | undefined {
  const polled = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  // valtio tracks the property read, so this re-renders on board changes and nothing else.
  const board = useSnapshot(store).board
  // THE SAME TWO OVERLAYS THE LIST FOLDS IN (lib/listBands.ts, BandLabel.tsx), so the square's counts and
  // the rows beside it change on the same click: a just-sent steer leaves Queue for Running, a
  // just-clicked Mark as done leaves both. Read off the raw board instead, the badge kept the old split
  // for the whole round-trip while the list had already moved. (Upstream folds them with a hook pair this
  // fork does not have; the maps and the pure overlays are the same.)
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  // Only a board that IS the current project's: during a switch the store still holds the one being left
  // (the fork's own guard, from its rail before 2026-09-30).
  const threads = currentSlug !== undefined && board && board.projectSlug === currentSlug
    ? asThreads(board.threads).map((t) => optimisticallyArchived(optimisticallySteered(t, steeredAt[t.id]), archivingAt[t.id]))
    : undefined
  const live = threads && { queued: threads.filter(queued).length, running: threads.filter(activeBandThread).length, asks: threads.filter(boardAskThread).length }
  const currentId = currentSlug === undefined ? undefined : projects.find((project) => project.slug === currentSlug)?.id
  return (project) => (project.id === currentId && live ? live : polled.data?.[project.id])
}

export function ProjectRail() {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  // The square that wears the pill is the board the page SHOWS — none on All projects, whose door at the
  // top wears it instead. (What All projects is bound to, the prompt box's pick, the box says itself.)
  const view = usePageView()
  const current = view.kind === "project" ? view.slug : undefined
  const add = useAddProject()
  const addKeys = useShortcutLabel("app.newProject")
  const [drag, setDrag] = useState<DragState | null>(null)
  /** The order the operator is looking at, which leads the server for the whole round trip. */
  const [optimistic, setOptimistic] = useState<ProjectCard[] | null>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const reorder = useMutation({
    mutationFn: (ids: string[]) => rpc.projectsReorder({ ids }),
    // Hold the operator's arrangement on screen until the refetch that CONFIRMS it has landed.
    // Clearing on success instead would drop back to the previous server order for the frame between
    // the mutation resolving and the query settling — a visible snap-back on every drop.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      setOptimistic(null)
    },
    onError: () => setOptimistic(null), // the server order is the truth if we could not write ours
  })

  // HOME IS NOT IN THE ORDER (the fork's Home workspace; upstream has none). It has no registry entry to
  // hold a position — the server lists it last and `projectsReorder` skips its id — so it cannot be
  // dragged and nothing can be dropped below it: it is drawn under the band, the last square above the +
  // and always on screen however long the list grows.
  // A held square outranks both: its indices are positions in the list it was picked up from
  // (upstream 4a210c63 — another tab's reorder now arrives mid-drag).
  const listed = drag?.list ?? optimistic ?? data ?? []
  const projects = listed.filter((project) => !project.home)
  const homeCard = (data ?? []).find((project) => project.home)
  // The LIVE count belongs to the project whose board the store holds — the page project, which on All
  // projects is the prompt box's pick, not a square the pill is on.
  const countsFor = useRailCounts(projectSlug(), listed)

  /**
   * Fade the band's bottom edge ONLY while something is actually below it.
   *
   * An unconditional mask dims the LAST square once you have scrolled to the end — which is the same
   * artifact, at the other end, as the top fade that was mistaken for a shadow falling on the first
   * icon. A fade means "there is more"; against the true end of the list it is just a dimmed square.
   */
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const band = bandRef.current
    if (!band) return
    const sync = () => setOverflowing(band.scrollTop + band.clientHeight < band.scrollHeight - 1)
    sync()
    band.addEventListener("scroll", sync, { passive: true })
    // The list itself changes height as projects arrive, and the band changes with the window.
    const observer = new ResizeObserver(sync)
    observer.observe(band)
    window.addEventListener("resize", sync)
    return () => {
      band.removeEventListener("scroll", sync)
      observer.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [projects.length])

  const startDrag = useCallback((event: PointerEvent_<HTMLAnchorElement>, index: number) => {
    // Left button only, and never on a modified click — ⌘/ctrl-click opens a new tab and must not be
    // hijacked into a reorder.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.currentTarget
    const startY = event.clientY
    const list = projects
    let started = false
    let latest: DragState | null = null
    let frame = 0

    const apply = (clientY: number) => {
      const band = bandRef.current
      // Auto-scroll near the band's edges, and FOLD the scroll into the delta: without it, dragging
      // to the top of a 29-project rail is impossible, because the slot you want is never on screen
      // at the same time as the square you are holding.
      let scrolled = 0
      if (band) {
        const bounds = band.getBoundingClientRect()
        const velocity = edgeScrollVelocity(clientY, bounds)
        if (velocity) {
          const before = band.scrollTop
          band.scrollTop += velocity
          scrolled = band.scrollTop - before
        }
      }
      scrollAccumulated += scrolled
      const deltaY = clientY - startY + scrollAccumulated
      latest = { id: list[index]!.id, fromIndex: index, toIndex: dropIndex(index, deltaY, list.length), deltaY, list }
      setDrag(latest)
    }

    let scrollAccumulated = 0
    const onMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
        anchor.setPointerCapture(moveEvent.pointerId)
      }
      moveEvent.preventDefault()
      const clientY = moveEvent.clientY
      // Coalesce to one update per frame: the edge auto-scroll must also keep running while the
      // pointer is HELD STILL inside the zone, which a move-driven loop alone would never do.
      cancelAnimationFrame(frame)
      const tick = () => {
        apply(clientY)
        if (bandRef.current && edgeScrollVelocity(clientY, bandRef.current.getBoundingClientRect())) {
          frame = requestAnimationFrame(tick)
        }
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
      const next = moveItem(list, latest.fromIndex, latest.toIndex)
      if (latest.fromIndex === latest.toIndex) return
      setOptimistic(next)
      reorder.mutate(next.map((project) => project.id))
    }

    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [projects, reorder])

  /**
   * The keyboard path, because a drag-only reorder is no reorder at all for anyone not using a mouse.
   *
   * Alt+Arrow rather than bare arrows: a bare ArrowUp on a focused link is how you SCROLL, and taking
   * it would make the rail a trap to tab through.
   */
  const onKeyDown = useCallback((event: KeyboardEvent_<HTMLAnchorElement>, index: number) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    const to = index + (event.key === "ArrowUp" ? -1 : 1)
    if (to < 0 || to >= projects.length) return
    event.preventDefault()
    const next = moveItem(projects, index, to)
    setOptimistic(next)
    reorder.mutate(next.map((project) => project.id))
    // Focus follows the square, not the slot — otherwise a second press moves whatever landed here.
    requestAnimationFrame(() => {
      bandRef.current?.querySelectorAll("a")[to]?.focus()
    })
  }, [projects, reorder])

  return (
    <nav
      aria-label="Projects"
      className={`fixed inset-y-0 left-0 z-[60] flex flex-col items-center border-r border-border bg-panel/60 py-3 max-[800px]:hidden ${RAIL_WIDTH_CLASS}`}
    >
      {/* A STROKE GLYPH, not the Ntwine mark. Two reasons, and the second is why it stopped being the
          mark: this slot is a destination ("all projects"), and the wordmark said whose app you are
          in — which the rail's own presence already says. And `favicon.svg` carries an feDropShadow
          inside a 512 viewBox with 16px of bleed around a 480 tile, so at 26px it cast a soft shadow
          DOWN onto the first project square. A stroke glyph paints only its own strokes. Upstream's is a
          house; this fork's is All projects' own layers glyph (see the header).
          The hover fill is the project squares' own shape — 40px at `rounded-[30%]`, like the add slot
          at the bottom. It was 36px with an 8px corner (22%) until 2026-10-11 (upstream 87e8650f), a
          visibly different rounded rect at the head of a column of identical ones. */}
      <Tooltip side="right" label="All projects">
        <Link
          to={ALL_PROJECTS_HREF}
          aria-label="All projects"
          data-rail-all
          aria-current={view.kind === "all" ? "page" : undefined}
          onClick={() => { if (view.kind !== "all") glideTo(() => 0) }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 aria-[current=page]:text-fg"
        >
          <Layers size={17} />
        </Link>
      </Tooltip>
      <hr className="my-2.5 w-6 shrink-0 border-0 border-t border-border" />

      {/* The scrolling band. `min-h-0` is what lets it actually scroll inside a flex column, and the
          hidden scrollbar keeps a 57px column from spending 8px of itself on a track (the bottom fade
          in styles.css says "there is more" in its place). 8px between squares mirrors what Discord
          runs at 48px and Slack at 36px; 6 read tight at 40.
          `overflow-x` stays visible-ish via the mask rather than a clip so the held square's shadow
          and the current-page pill are not shaved off at the column's edge. */}
      <div
        ref={bandRef}
        data-overflowing={overflowing || undefined}
        // `pb-1.5` absorbs the last square's queue badge (5px below its square): without it the badge
        // extends the scroll height, which the bottom fade reads as "there is more" and dims the square.
        className="ntwine-rail-scroll flex w-full min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pb-1.5"
      >
        {projects.map((project, index) => (
          <RailLink
            key={project.id}
            project={project}
            index={index}
            current={project.slug === current}
            counts={countsFor(project)}
            drag={drag}
            onPointerDown={startDrag}
            onKeyDown={onKeyDown}
          />
        ))}
      </div>

      {homeCard && (
        <div className="w-full shrink-0 pt-2">
          <RailLink
            project={homeCard}
            index={-1}
            current={homeCard.slug === current}
            counts={countsFor(homeCard)}
            drag={null}
            onPointerDown={() => {}}
            onKeyDown={() => {}}
          />
        </div>
      )}

      <Tooltip side="right" label={withShortcut("Add a project", addKeys)}>
        <button
          type="button"
          disabled={add.pending}
          onPointerEnter={warmProjectPicker}
          onFocus={warmProjectPicker}
          onClick={add.start}
          aria-label="Add a project"
          // A DOTTED squircle, matching the project squares' own `rounded-[30%]` so it reads as an empty
          // slot in the same list rather than a control bolted under it. Dotted and not dashed: at 40px
          // a dashed border resolves into four long strokes that read as a frame, where dots read as
          // "nothing here yet" — which is what it is. Under the Home square it keeps the list's own 8px
          // rhythm, the next slot after Home; under the band it stands off by 12.
          className={`${homeCard ? "mt-2" : "mt-3"} flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] border-[1.5px] border-dotted border-border-strong text-muted-80 outline-none transition-colors hover:border-accent hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50`}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </nav>
  )
}
