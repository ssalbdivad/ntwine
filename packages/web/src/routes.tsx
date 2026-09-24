import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Navigate, Outlet, createBrowserRouter, useLocation, useNavigate, useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { App } from "./App.tsx"
import { ProjectGrid } from "./components/ProjectGrid.tsx"
import { ProjectRail, RAIL_INSET_CLASS } from "./components/ProjectRail.tsx"
import { StandaloneThreadPage } from "./components/StandaloneThreadPage.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { KeyboardLayer } from "./components/KeyboardShortcuts.tsx"
import { applyPath, registerNavigate } from "./lib/router.ts"
import { PROJECTS_PATH, crossProjectHref, innerPath } from "./lib/base-path.ts"
import { CROSS_PROJECT_PICK_STATE, defaultCrossProjectFocus, isCrossProjectPick, rememberCrossProjectFocus, rememberedCrossProjectFocus } from "./lib/crossProject.ts"
import { rpc } from "./api/rpc.ts"
import { feedIsBoundTo, rebindProject } from "./api/socket.ts"
import { noteStandaloneThreadRender, primeFullscreenReturn, resetProjectState, store } from "./store.ts"
import { useProjectRailVisible } from "./lib/projectRail.ts"

// THE ROUTE TREE — and, more to the point, the LAYOUT that outlives a navigation.
//
// The rail is chrome: it draws every project on the machine and is identical on every page, so it
// must not be torn down and rebuilt when you use it. Before this it was mounted twice — once inside
// <App/> and once inside <ProjectGrid/> — because `main.tsx` chose ONE of three root shells from
// `location.pathname` at module load, which made every project switch a full document load. A layout
// route is the direct expression of "this part does not change": <RootLayout/> holds the rail and the
// tooltip provider, and the <Outlet/> below it swaps between the grid and a board.
//
// WHAT A PROJECT SWITCH ACTUALLY COSTS, and why the router alone was never the whole job. Four things
// are bound to one project, and only the first two are this hook's business:
//   · the live feed — one socket per project (api/socket.ts rebindProject)
//   · the board store, the drawer stack and the current view (store.resetProjectState)
//   · the react-query cache, which now needs NOTHING here. It used to be swept on every switch,
//     exempting the project list so the rail would not blank mid-navigation; the cache is scoped by
//     project at the hash instead (lib/queryKeyScope.ts), so one project's entries are invisible to
//     another rather than deleted in front of it. Switching back finds a warm cache, and a response
//     that arrives late has nowhere wrong to land.
//   · the API base, which needs nothing: base-path.ts derives it from the page's path on every call,
//     and the router keeps `location` synchronous with navigation.
//
// The board is KEYED by slug so it genuinely remounts per project — its state is per-project and
// reusing the instance across a switch would carry the previous board's mounted surfaces into the new
// one. The rail above it is not keyed, so it persists. That contrast is the whole design.

/** The one place that knows the URL shapes, so a route and a link cannot disagree. */
export const PROJECT_PATH = "/project/:slug"
/** The cross-project page, focused on one project (base-path.ts `crossProjectHref`). */
export const CROSS_PROJECT_PATH = "/all/:slug"

function RootLayout() {
  useRegisterNavigate()
  // ONE decision drives the column AND the space reserved for it. They were separate — the rail was
  // conditional while every page kept an unconditional `pl-[57px]` — so turning the rail off left a
  // 57px lane of nothing down the left of every board. A hidden rail has to be gone from the layout,
  // not merely invisible in it.
  const railVisible = useProjectRailVisible()
  return (
    <TooltipProvider>
      {/* Outside the <Outlet/> on purpose: this is the element that must survive the navigation.
          OPT-IN: a permanent column of every project is a standing invitation to leave the thread
          you are in, so it is off unless asked for. Hidden, the way back is the status bar's home
          crumb (StatusRow's home button), which costs a click exactly when you meant to switch. */}
      {railVisible ? <ProjectRail /> : null}
      <div className={railVisible ? RAIL_INSET_CLASS : undefined}>
        <Outlet />
      </div>
      {/* HOSTED BY THE LAYOUT, not by the board. It lived inside <App/>, so `showToast` from anywhere
          else raised a toast with nowhere to render — silently, since the store field is set either
          way. The grid is the page that needed one (it is where a bad project URL now lands), and it
          is exactly the page that could never show one. Fixed-positioned, so it is inert until a
          toast exists. */}
      <Toaster />
      {/* ALSO hosted by the layout, and for the same reason: prose carrying `#123` renders on the
          board, in a drawer and on the standalone `/thread/<slug>/full` page alike, and one delegated
          listener at the root covers all three. Inert until a pointer rests on a reference. */}
      <GithubHovercards />
      {/* The keyboard shortcuts and their sheet (`?`), for every page under the layout — the grid and
          Everything as much as a board. /full mounts its own copy, since it sits outside this layout. */}
      <KeyboardLayer />
    </TooltipProvider>
  )
}

/**
 * Re-bind everything that belongs to one project, whenever the project changes.
 *
 * THE CONDITION IS ASKED OF THE FEED, and that is the whole point. This hook used to keep its own note
 * of the project it had bound, in a `useRef` — a second copy of a fact it did not own. Every switch
 * that changes which ROUTE matched (the grid to a board, a board to a thread page) unmounts one element
 * and mounts another, so the ref was born fresh, initialised to the slug it was looking at, and
 * therefore always answered "already bound". The feed stayed on the previous project while the URL, the
 * `<App/>` key and the board header all said the new one, and nothing short of a document load recovered
 * it (2026-08-11: every board on the machine rendered the launching project's threads).
 *
 * `feedIsBoundTo` asks the module that HOLDS the connection. It has nothing to remember and therefore
 * nothing to get wrong on a remount, and being called redundantly is free — which is what lets this stay
 * an ordinary effect instead of something that has to fire exactly once.
 */
function useProjectBinding(slug: string | undefined) {
  useEffect(() => {
    if (feedIsBoundTo(slug)) return
    resetProjectState()
    rebindProject()
  }, [slug])
}

/**
 * A board, for the project the URL names.
 *
 * `slug` is undefined on the unprefixed routes, which remain a supported state: the launching project
 * is still served at `/thread/<slug>` and `/status/<name>` with no `/project/<slug>` in front of it,
 * and `apiBase()` answers `/_frizz` for exactly that case.
 */
function BoardRoute() {
  const { slug, thread } = useParams()
  useProjectBinding(slug)
  useRouteToStore()
  // Returning from /full plays the fullscreen door's view transition in REVERSE (react-router re-arms
  // it for the POP; the collapse icon opts in). The reverse morph needs the thread's board surface
  // mounted and named in THIS first commit — the one the transition's new-state snapshot reads — so
  // the priming is render-phase, the mirror of StandaloneRoute's render-phase drawer clear. A no-op
  // unless the previous render really was a /full page (see primeFullscreenReturn).
  useState(() => primeFullscreenReturn(thread))
  return <App key={slug ?? "__launching__"} />
}

/**
 * The all-projects grid, which shows no project's feed and therefore must not disturb the binding.
 *
 * It reads only the machine-wide project list, so leaving the feed where it is costs nothing and buys
 * something: going home and back into the SAME project is free, instead of a teardown plus a
 * reconnect. (It used to call `useProjectBinding(undefined)`, which meant "the launching project" —
 * never "no project" — so the grid would have swapped one live feed for another. With the ref bug it
 * was a no-op in every case, so removing it changes nothing that ever ran.)
 */
function GridRoute() {
  return <ProjectGrid />
}

/**
 * THE CROSS-PROJECT PAGE — every project's queue on one page, and the default mode — FOCUSED on the
 * project the URL names (`/all/<slug>`).
 *
 * The focus IS the page project: it binds the live feed, the store and every page-relative helper
 * exactly as a board does (base-path.ts answers `/all/<slug>` like `/project/<slug>`), so the prompt box
 * dispatches into it and a thread drawer of it opens in place with the board's whole drawer stack. The
 * page's rail and lanes are the other projects' — they read machine-wide data and name their project on
 * every call, as they always have (AllQueues.tsx).
 *
 * `<App/>` is keyed by a CONSTANT here, not by slug as a board is: moving the focus — opening another
 * project's thread, choosing another project for a new one — must not remount the page under the
 * operator. What is per-project (the store's board and drawer stack) is reset by the binding instead.
 */
function CrossProjectRoute() {
  const { slug, thread } = useParams()
  const location = useLocation()
  useProjectBinding(slug)
  useRouteToStore()
  useState(() => primeFullscreenReturn(thread))
  useRememberPick(slug, thread, location.state, location.key)
  return <App mode="cross-project" key="cross-project" />
}

/**
 * Remember the focus as the operator's PICK (lib/crossProject.ts) — only when they chose it: arriving on
 * the page focused there with no thread open, or a navigation that says it was a choice. Opening another
 * project's thread moves the focus too, and must not be remembered as one.
 *
 * A LAYOUT effect so it lands before the page's own effects in the same commit: the page returns the
 * focus to the pick when nothing is open (AllQueues.tsx useReturnToPick), and on a landing that asked
 * for a project, reading the previous pick would bounce straight off it.
 */
function useRememberPick(slug: string | undefined, thread: string | undefined, state: unknown, key: string) {
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const focusId = cards.data?.find((card) => card.slug === slug)?.id
  const landing = useRef(thread ? null : slug)
  useLayoutEffect(() => {
    if (!focusId) return
    if (landing.current !== slug && !isCrossProjectPick(state)) return
    landing.current = null
    rememberCrossProjectFocus(focusId)
    // `key`, not `state`: a second pick of the same project is a new navigation with an equal state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, key])
}

/**
 * `/` — the cross-project page, which is always focused on SOME project, so this only picks one and
 * goes there (lib/crossProject.ts). The grid's own query parameters are the grid's: the launcher's
 * `?add=<dir>` offer and the server's `?unknown=<slug>` notice were both minted when `/` was the grid,
 * and a launcher that predates the move still mints them.
 *
 * `?focus=<slug>` is how the launcher names the project it was run in. It is a query on `/` rather than
 * `/all/<slug>` so a new launcher that joins an OLDER server — one whose page has no `/all` route —
 * still lands somewhere real (that page's `/`) instead of on the launching project's board.
 */
function HomeRoute() {
  const { search } = useLocation()
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  // Which projects this server has open, so the landing prefers one that can take a thread. Shared with
  // the page itself (same key), so the page it lands on paints from this read.
  const queues = useQuery({ queryKey: ["projectsQueues"], queryFn: () => rpc.projectsQueues() })
  const params = new URLSearchParams(search)
  if (params.has("add") || params.has("unknown")) return <Navigate to={`${PROJECTS_PATH}${search}`} replace />
  if (cards.error) return <Navigate to={PROJECTS_PATH} replace />
  if (!cards.data || queues.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
      </div>
    )
  }
  const asked = cards.data.find((card) => card.slug === params.get("focus") && !card.stale)
  if (asked) return <Navigate to={crossProjectHref(encodeURIComponent(asked.slug))} state={CROSS_PROJECT_PICK_STATE} replace />
  const openIds = queues.data ? new Set(queues.data.map((queue) => queue.projectId)) : undefined
  const focus = defaultCrossProjectFocus(cards.data, rememberedCrossProjectFocus(), openIds)
  return <Navigate to={focus ? crossProjectHref(encodeURIComponent(focus)) : PROJECTS_PATH} replace />
}

/** A path under a focus that names nothing the page has (`/all/<slug>/status/x`, a typo): the page itself. */
function CrossProjectFallback() {
  const { slug } = useParams()
  return <Navigate to={crossProjectHref(encodeURIComponent(slug!))} replace />
}

/**
 * URL → store, for the routes INSIDE a board.
 *
 * The drawer stack is valtio state, not route state, because a drawer is a stack with its own
 * animated unwind and several ways to open — so the URL is one input to it rather than its owner.
 * This is the direction react-router does not do for us: it resolves the path, and `applyPath` turns
 * that into "which thread is open, and is it a drawer or a queue card". The other direction (store →
 * URL) lives in lib/router.ts, which now navigates rather than calling history directly.
 */
function useRouteToStore() {
  const location = useLocation()
  useEffect(() => {
    applyPath(innerPath(location.pathname))
  }, [location.pathname])
}

// Hands react-router's navigate to lib/router's module-level `spaNavigate`, for the leaves that must
// change the URL without router context (see registerNavigate). Both shells call it: each is the root
// of its own tree, and the fullscreen page has no RootLayout above it.
function useRegisterNavigate(): void {
  const navigate = useNavigate()
  useEffect(() => {
    registerNavigate((path, options) => navigate(path, options))
    return () => registerNavigate(null)
  }, [navigate])
}

/** The focused single-thread page. Deliberately OUTSIDE the layout: it has no rail, and should not. */
function StandaloneRoute() {
  const { thread, slug } = useParams()
  useRegisterNavigate()
  useProjectBinding(slug)
  // Any drawer stack left by the page we came from is cleared HERE, on this route's first render —
  // deliberately NOT in the fullscreen door's click handler, and deliberately not in an effect. The
  // door's navigation runs inside a view transition, which snapshots the OLD page two renders after
  // the click — a click-time clear removed the very sheet the transition slides into place. And the
  // NEW page is snapshotted at this render's commit, so an effect would be one paint too late: this
  // page's own DrawerStack would be captured painting the thread's sheet over itself mid-transition.
  // A render-phase write (the useState initializer runs exactly once, before the children render)
  // means DrawerStack below already sees the empty stack in the same pass.
  useState(() => { if (store.drawers.length > 0) store.drawers = [] })
  // Recorded every render, consumed by BoardRoute's mount: this is how the board knows its first
  // render is the return leg of the fullscreen door and should prime the reverse morph's target.
  noteStandaloneThreadRender(thread!)
  return (
    <>
      <StandaloneThreadPage slug={thread!} />
      {/* Its own, since it is outside the layout. This page renders a full transcript, so it has the
          copy-a-code-block control — whose only feedback is a toast, which until now had nowhere to
          go here. Skipping the rail does not mean skipping the feedback. */}
      <Toaster />
      {/* Its own for the same reason: `e`, `h`, `r` and `f` (which leaves) work on this thread too. */}
      <KeyboardLayer />
    </>
  )
}

const boardChildren = [
  { index: true, element: <BoardRoute /> },
  { path: "thread/:thread", element: <BoardRoute /> },
  { path: "status/:status", element: <BoardRoute /> },
]

// The SAME element at the same depth for every cross-project URL, so react-router keeps the one
// instance mounted across a focus change or a drawer opening — the page must not remount under you.
const crossProjectChildren = [
  { index: true, element: <CrossProjectRoute /> },
  { path: "thread/:thread", element: <CrossProjectRoute /> },
  { path: "*", element: <CrossProjectFallback /> },
]

export const router = createBrowserRouter([
  // The focused single-thread pages sit OUTSIDE the layout — they have no rail, and should not. They
  // are listed first for readability only; react-router ranks by specificity, so `/thread/x/full`
  // beats `/thread/:thread` regardless of order.
  { path: "/thread/:thread/full", element: <StandaloneRoute /> },
  { path: `${PROJECT_PATH}/thread/:thread/full`, element: <StandaloneRoute /> },
  { path: `${CROSS_PROJECT_PATH}/thread/:thread/full`, element: <StandaloneRoute /> },
  {
    element: <RootLayout />,
    children: [
      { path: "/", element: <HomeRoute /> },
      { path: PROJECTS_PATH, element: <GridRoute /> },
      { path: CROSS_PROJECT_PATH, children: crossProjectChildren },
      // Declared, not left to the catch-all below — which would draw the launching project's board.
      // `/queues` was the cross-project page's address before it became the default at `/`.
      { path: "/queues", element: <Navigate to="/" replace /> },
      { path: "/all", element: <Navigate to="/" replace /> },
      // The launching project, unprefixed. `/` itself belongs to the grid, so this project reaches its
      // board through a thread or status path — see base-path.ts on why an empty base is supported.
      { path: "/thread/:thread", element: <BoardRoute /> },
      { path: "/status/:status", element: <BoardRoute /> },
      { path: PROJECT_PATH, children: boardChildren },
      // Anything else is a board for the launching project, which is what the old shell did with an
      // unknown path: applyPath falls through to the queue.
      { path: "*", element: <BoardRoute /> },
    ],
  },
])
