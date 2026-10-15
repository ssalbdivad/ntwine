import { useEffect, useRef, type ReactNode } from "react"
import { useLocation } from "react-router"
import { useSnapshot } from "valtio"
import { displayTitle } from "../groups.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { pageHref, reportRoute, queueReading, sidebarRoute } from "../lib/embedRoute.ts"
import { registerQueueCursor } from "../lib/keyboardRuntime.ts"
import { phoneBands, phoneCounts } from "../lib/phonePage.ts"
import { store } from "../store.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { ThreadConnector } from "./ThreadConnector.tsx"

// THE PAGE IN AN EDITOR'S SIDEBAR — the desktop app's left column, alone (ARCHITECTURE.md § VS Code extension
// § The editor in the sidebar, and the app's own feel). The VS Code extension frames this page at any
// width from ~250px up (lib/embed.ts), and it is the DESKTOP app narrowed, not the phone app: someone who
// uses ntwine in the browser must recognize every surface in it.
//
// The desktop page is two columns: on the left the prompt box over the project list, on the right the
// queue's cards, with a thread's drawer sliding over them. The left column is already a sidebar — it is
// 272px at its narrowest (Sidebar.tsx SIDEBAR_COLUMN_CLASS) — so it is what this page draws, with the
// desktop's own parts at the desktop's own sizes: the prompt box (AllQueues.tsx FocusedComposer, the
// picker in its bottom strip on All projects), and the list (TierList.tsx), its 13px rows, rest times,
// spinners, hover verbs and quiet bands unchanged. The right column has no room, so a thread opens in its
// DRAWER, full width (styles.css `html[data-embed] .ntwine-sheet-panel`), with the same header, transcript,
// reply box, Snooze and Mark as done the card and the drawer carry on the desktop; ✕ or Esc comes back here.
//
// Rejected, each drawn at 300 and 450px before choosing (build2-shell.md): the desktop's stacked page
// (the prompt box, then every Ready card at full height, the list below them all), which put the list
// thousands of pixels down; and the phone's page, which the first cut used — its own rows at a 15.5px
// title, tabs no desktop has, and touch targets.
//
// NO HEADER. VS Code's title row above the frame is the header (lib/embedRoute.ts): the view's name and
// its counts go there, and its buttons come back as `ntwine:command` (lib/embedCommand.ts). What the
// desktop's status row carried that the title row cannot is kept in the page: the dock heads
// the list, in the slot the status row's title leaves empty on the desktop.
//
// THE COLUMN IS THE DESKTOP'S, scroll box and all: the prompt box stays put at the top and the list scrolls
// in its own box under it, with the app's 7px inner scrollbar, `mb-5 px-0.5` between them — the desktop's
// column head (AllQueues.tsx), so the box sits 2px inside the list's edges and 20px above it. Until
// 2026-10-01 the whole page scrolled: a wheel over the list took the prompt box with it, the page's
// zero-width scrollbar said nothing about there being more below, and a project dragged to the frame's
// edge never scrolled the list (the project list's drag scrolled the `[data-xq-rail]` it was in, which
// was a box that did not scroll). The project cords are drawn here too (ThreadConnector.tsx): with no
// cards, only the cords, which are the desktop list's look as much as its rows are.
//
// THE KEYS ARE THE DESKTOP'S. `j` / `k` step the card being read on the desktop; here, with no cards,
// they open the next or previous queued thread in its drawer, in the list's order — pinned ones included,
// as the desktop's first card is often a pinned one — which is the reading a card gives in the sidebar.
// The thread keys (`r`, `d`, `s` …) then press the drawer's own controls, as they do on the desktop with a
// drawer open (lib/keyboardRuntime.ts). With no drawer open there is no card for them to act on, so a
// thread key OPENS the thread you're on — the row the marker holds, else the first queued one — and stops
// there, so nothing acts on a thread the human has not seen; `r` also puts the caret in its reply box,
// which is all the desktop's `r` does to a card.

export function SidebarPage({
  projects,
  shown,
  viewed,
  focusedSlug,
  hidden,
  loading,
  error,
  ready,
  empty,
  composer,
  list,
}: {
  /** Every project — what a row's key is looked up in. */
  projects: QueuesProject[]
  /** The view's projects: the focused one, or every one. */
  shown: QueuesProject[]
  viewed: QueuesProject | undefined
  focusedSlug: string | undefined
  hidden: (key: string) => boolean
  loading: boolean
  error: string | undefined
  /** The desktop's READY count (AllQueues.tsx `ready`): every card the view has, questions included. */
  ready: number
  /** The desktop's own words for an empty queue, when the view has nothing queued; else null. */
  empty: ReactNode | null
  /** The page's prompt box. */
  composer: ReactNode
  /** The project list, handed the row the human is reading. */
  list: (activeKey: string | null) => ReactNode
}) {
  const snap = useSnapshot(store)
  const active = useReadingRow(projects)
  const location = useLocation()

  // The title row's reading. The thread's title is the page project's board's — a drawer only ever shows
  // a thread of the page project (useOpenThreadInPlace moves the page to it).
  const top = [...snap.drawers].reverse().find((drawer) => !drawer.closing)
  const threadSlug = [...snap.drawers].reverse().find((drawer) => !drawer.closing && drawer.kind !== "file")?.slug ?? null
  const thread = threadSlug ? snap.board?.threads.find((t) => t.id === threadSlug) : undefined
  // A file's reader over the thread (a README a link opened) is what is in front: the row names it, and
  // stays a thread's row, so Back to queue is still there to take.
  const threadTitle = top?.kind === "file" ? (top.label ?? top.slug) : thread ? displayTitle(thread) : threadSlug
  // A project this machine does not list is no scope: the page shows All projects (the toast says why),
  // and so does the row. Its slug is named only while the queues are still loading, when it is not yet
  // known to be missing.
  const scope = focusedSlug === undefined ? "All projects" : (viewed?.name ?? (loading ? focusedSlug : "All projects"))
  // The desktop's READY count, so the two never disagree on what "ready" means (a question is a card, and
  // counts), and what is spinning beside it — the rows' own glyphs say which ones ask.
  const working = phoneCounts(phoneBands(shown, hidden)).working
  const reading = loading || error ? null : queueReading({ ready, working })
  const route = sidebarRoute({
    settings: snap.showSettings,
    thread: threadSlug ? threadTitle : null,
    other: !threadSlug && top ? (top.label ?? top.slug) : null,
    scope,
    reading,
  })
  // The address too, so ⋯ Open in browser opens what is shown (a thread as that thread).
  useEffect(() => reportRoute({ ...route, href: pageHref(window.location.href) }), [route.view, route.title, route.description, location.pathname, location.search])

  // Back on the list, the row just read is in sight: `j` / `k` read on in the drawer, and the row they
  // left the marker on can be anywhere in a list this box scrolls.
  const listOpen = !top
  useEffect(() => {
    if (!listOpen || !active) return
    document.querySelector('[data-xq-rail="sidebar"] [data-sidebar-scroll-marker]')?.closest("[data-xq-thread-row]")?.scrollIntoView({ block: "nearest" })
  }, [listOpen, active])

  return (
    <div data-sidebar-page className="flex h-screen flex-col bg-bg px-3 pt-3 text-sm text-fg">
      {/* The column head, as the desktop's: the status row (restart, quota) over the prompt box — none,
          when it has neither (StatusRow.tsx). Settings and the shortcuts sheet are in VS Code's title row.
          Above the cords (ThreadConnector.tsx, z-[5]) while the box's own menu is open over the list. */}
      <div className="relative mb-5 shrink-0 px-0.5 has-[[data-mention-menu]]:z-[6] has-[[data-slash-menu]]:z-[6]">
        <StatusRow settings={false} shortcuts={false} />
        {composer}
      </div>
      {error ? (
        <p className="mt-1 text-center text-[13px] text-muted">Could not read the queues: {error}</p>
      ) : loading ? (
        <div className="flex justify-center pt-5">
          <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
        </div>
      ) : (
        // The list in the box's own column, as on the desktop: its rows' 20px marker gutter starts 2px
        // outside the box's border, and the scrollbar is the inner surfaces' 7px one, in its own gutter.
        <div data-xq-rail="sidebar" className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-8">
          {list(active)}
          {empty !== null && <p data-xq-sidebar-empty className="mt-6 text-balance px-2 text-center text-[13px] text-muted">{empty}</p>}
        </div>
      )}
      <ThreadConnector activeKey={active} />
    </div>
  )
}

/**
 * THE ROW BEING READ, and `j` / `k` over the list. The thread up in the drawer is the one being read; with
 * the drawer closed the last one read stays marked (the rail's reading marker, Sidebar.tsx RailRow), so the
 * next `j` goes on from it — the desktop's reading line, held where the reader left it.
 */
function useReadingRow(projects: QueuesProject[]): string | null {
  const snap = useSnapshot(store)
  const openInPlace = useOpenThreadInPlace()
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const page = snap.board?.projectSlug
  const pageProject = projects.find((project) => project.slug === page)
  const slug = [...snap.drawers].reverse().find((drawer) => !drawer.closing && drawer.kind === "thread")?.slug
  const open = pageProject && slug ? threadKey(pageProject.id, slug) : null
  const last = useRef<string | null>(null)
  if (open) last.current = open
  const reading = open ?? last.current
  const readingRef = useRef(reading)
  readingRef.current = reading

  useEffect(() => {
    // The queued rows, in the list's own order — what the eye sees, top to bottom: the rows carrying a card
    // key, which are exactly the desktop's cards, pinned ones included.
    const keys = () =>
      [...document.querySelectorAll<HTMLElement>('[data-xq-rail="sidebar"] [data-xq-thread-row][data-xq-rail-row]')]
        .map((row) => row.dataset.xqRailRow ?? "")
        .filter(Boolean)
    const go = (key: string) => {
      const project = projectsRef.current.find((candidate) => key.startsWith(`${candidate.id}/`))
      if (project) openInPlace(project, key.slice(project.id.length + 1))
    }
    return registerQueueCursor({
      keys,
      current: () => readingRef.current,
      // The drawer is the card: the thread keys press its controls (keyboardRuntime currentThreadSurface).
      root: () => null,
      go,
      // With no drawer open: the thread you're on, in its drawer — the row the marker holds while it is in
      // the list, else the first queued row, which is where `j` would start.
      openCurrent: () => {
        const held = readingRef.current
        const marked = held !== null && document.querySelector('[data-xq-rail="sidebar"] [data-sidebar-scroll-marker]') !== null
        const key = marked ? held : keys()[0]
        if (!key) return false
        go(key)
        return true
      },
    })
  }, [openInPlace])
  return reading
}
