import { useContext, useEffect, useLayoutEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { Navigate, Outlet, UNSAFE_ViewTransitionContext, createBrowserRouter, useLocation, useNavigate, useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { App } from "./App.tsx"
import { StandaloneThreadPage } from "./components/StandaloneThreadPage.tsx"
import { AddProjectHost, Welcome } from "./components/ProjectActions.tsx"
import { Tour } from "./components/Onboarding.tsx"
import { startTourOnFirstRun } from "./lib/tour.ts"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { KeyboardLayer } from "./components/KeyboardShortcuts.tsx"
import { applyLocation, noteRouterTransition, primeReturnFromFullscreen, registerNavigate } from "./lib/router.ts"
import { setHomeFocus } from "./lib/base-path.ts"
import { defaultCrossProjectFocus, lastFocusedProject, rememberLastFocusedProject, useCrossProjectPick } from "./lib/crossProject.ts"
import { ALL_PROJECTS, ALL_PROJECTS_HREF, legacyViewRedirect, resolveView, viewAt, type PageView } from "./lib/pageView.ts"
import { embedded } from "./lib/embed.ts"
import type { ProjectCard } from "@ntwine/shared"
import { rpc } from "./api/rpc.ts"
import { projectsQueuesQuery } from "./lib/projectsQueuesRead.ts"
import { LightboxHost } from "./components/Lightbox.tsx"
import { feedIsBoundTo, rebindProject } from "./api/socket.ts"
import { noteStandaloneThreadRender, resetProjectState, showToast, store } from "./store.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"

// THE ROUTE TREE — and, more to the point, the LAYOUT that outlives a navigation.
//
// The layout's hosts (tooltips, toasts, the add-project dialog, hovercards, keys) must
// not be torn down and rebuilt on a navigation. `main.tsx` once chose ONE of three root shells from `location.pathname`
// at module load, which made every project switch a full document load. A layout route is the direct
// expression of "this part does not change": <RootLayout/> holds them, and the <Outlet/> below it holds
// the one page — a project's board or All projects — or a redirect into it.
//
// WHAT A PROJECT SWITCH ACTUALLY COSTS, and why the router alone was never the whole job. Four things
// are bound to one project, and only the first two are this hook's business:
//   · the live feed — one socket per project (api/socket.ts rebindProject)
//   · the board store, the drawer stack and the current view (store.resetProjectState)
//   · the react-query cache, which now needs NOTHING here. It used to be swept on every switch,
//     exempting the project list so it would not blank mid-navigation; the cache is scoped by
//     project at the hash instead (lib/queryKeyScope.ts), so one project's entries are invisible to
//     another rather than deleted in front of it. Switching back finds a warm cache, and a response
//     that arrives late has nowhere wrong to land.
//   · the API base, which needs nothing: base-path.ts derives it from the page's path on every call,
//     and the router keeps `location` synchronous with navigation.
//
// A project switch on the page never remounts it: the page is keyed by a constant (CrossProjectPage), and
// what is per-project — the store's board and drawer stack — is reset by the binding instead.

/** The one place that knows the URL shapes, so a route and a link cannot disagree. */
/** A thread drawer's prefix on All projects (base-path.ts `crossProjectHref`); the page itself is `/all`. */
export const CROSS_PROJECT_PATH = "/all/:slug"
/** A project's board (base-path.ts `crossProjectHref` on a board, pageView.ts `projectViewHref`). */
export const PROJECT_PATH = "/project/:slug"

function RootLayout() {
  useRegisterNavigate()
  return (
    <TooltipProvider>
      <Outlet />
      {/* HOSTED BY THE LAYOUT, not by the board. It lived inside <App/>, so `showToast` from anywhere
          else raised a toast with nowhere to render — silently, since the store field is set either
          way. The home page needs one (a bad project URL lands there, and says so), and it was exactly
          the kind of page that could never show one. Fixed-positioned, so it is inert until a toast
          exists. */}
      <Toaster />
      {/* The one add-project dialog (store.addProject): the folder picker's fallback from any door that
          adds a project, and the launcher's `/?add=<dir>` proposal. The layout's, because the proposal is
          read on `/` and then survives the redirect to the page it lands on. */}
      <AddProjectHost />
      {/* The image viewer a ```lightbox gallery opens (components/Lightbox.tsx). Hosted here rather
          than by the gallery, which is a virtualized transcript row that can unmount under it. */}
      <LightboxHost />
      {/* ALSO hosted by the layout, and for the same reason: prose carrying `#123` renders on the
          page, in a drawer and on the standalone `/thread/<slug>/full` page alike, and one delegated
          listener at the root covers all three. Inert until a pointer rests on a reference. */}
      <GithubHovercards />
      {/* The keyboard shortcuts and their sheet (`?`), for every page under the layout — the page and the
          welcome alike. /full mounts its own copy, since it sits outside this layout. */}
      <KeyboardLayer />
      {/* The first-run tour (components/Onboarding.tsx), over whichever view the page shows. */}
      <Tour />
    </TooltipProvider>
  )
}

/**
 * Re-bind everything that belongs to one project, whenever the project changes — and say whether the
 * tree below may render yet.
 *
 * THE CONDITION IS ASKED OF THE FEED, and that is the whole point. This hook used to keep its own note
 * of the project it had bound, in a `useRef` — a second copy of a fact it did not own. Every switch
 * that changes which ROUTE matched (the home page to a board, a board to a thread page) unmounts one element
 * and mounts another, so the ref was born fresh, initialised to the slug it was looking at, and
 * therefore always answered "already bound". The feed stayed on the previous project while the URL, the
 * `<App/>` key and the board header all said the new one, and nothing short of a document load recovered
 * it (2026-08-11: every board on the machine rendered the launching project's threads).
 *
 * `feedIsBoundTo` asks the module that HOLDS the connection. It has nothing to remember and therefore
 * nothing to get wrong on a remount, and being called redundantly is free.
 *
 * THE RETURN VALUE IS A GATE, and the caller renders nothing project-scoped until it is true. The reset
 * cannot happen before the first render under the new URL — it is a side effect, and a render must not
 * have one — so for one commit the store still holds the project you left: its board, its drawer stack,
 * its composer drafts. Rendering the remounted `<App/>` in that commit was the bug: every per-thread
 * hook in it ran against the NEW project's API with the OLD project's slugs. Most were wasted reads
 * (`threadTranscript`, `threadSettledQuestions`); one was a 500 (`threadProfileOptions`, which #50 gated
 * on its own until this made that redundant); and one was a WRITE — a thread drawer left open across
 * the switch sent `threadSeen` for its slug to the new project, marking that project's same-slug thread
 * read when nobody had opened it (2026-10-08). Gating each hook covers the hooks someone has noticed;
 * gating the tree covers the class.
 *
 * Two conditions open it:
 *   · BOUND — the feed is on this project, or this hook has just reset and rebound for this slug.
 *     `settled` is the second half rather than a second `feedIsBoundTo` read because the feed records
 *     the project from the PATH while `slug` comes from the route's params: a catch-all match can make
 *     the two disagree for good, and a gate waiting on that would be a blank page forever.
 *   · OWNED — the board in the store is stamped with this page's project (lib/projectOwnership.ts), on
 *     the payload's own evidence. Once bound this holds by construction (the reset nulled the board, and
 *     setBoard / seedBoard refuse a foreign one), so on a correct path it never closes the gate. It is
 *     here because the binding is bookkeeping, and bookkeeping is what has failed before; a closed gate
 *     re-runs the reset rather than waiting, so a bookkeeping miss costs a reconnect, not a blank page.
 *
 * The reset is a LAYOUT effect so the gated commit and the one that reopens it land in the same task.
 * Frame-sampled across a rail switch (2026-10-08, headless): the ordinary effect painted the old board
 * under the new URL for 2–3 frames, then an empty board area for 2; the gate paints no stale frame and 1
 * empty one.
 */
function useProjectBinding(slug: string | undefined): boolean {
  const owned = ownedByThisPage(useSnapshot(store).board?.projectSlug)
  const [settled, setSettled] = useState<{ slug: string | undefined } | null>(null)
  const bound = feedIsBoundTo(slug) || (settled !== null && settled.slug === slug)
  const ready = bound && owned
  useLayoutEffect(() => {
    if (ready) return
    resetProjectState()
    rebindProject()
    setSettled({ slug })
  }, [slug, ready])
  return ready
}

// ONE PAGE, AND ITS PATH NAMES ITS VIEW (lib/pageView.ts): every project at `/`, the home page, or one
// project's board at `/project/<slug>` (the query `/?project=<slug>` from 2026-09-29 to 2026-10-06, which
// now redirects here). On a phone `/` is the projects list. Anything unknown lands on `/`, keeping the
// query a launcher may have sent (`?add=`).

/**
 * THE PAGE — one project's board, or every project's list and queue, and the only page there is: `/`
 * and its `/all/<slug>/thread/<t>`, `/project/<slug>` with its `/thread/<t>` (on a phone, `/` is the
 * projects list over All projects' binding).
 *
 * It is always BOUND to one project, the page project: the live feed, the store and every page-relative
 * helper (base-path.ts answers `/` through `setHomeFocus`, and every other address from its path) follow
 * it, so the prompt box dispatches into it and a thread drawer of it opens in place with the whole drawer
 * stack. On a board the page project IS the board's project; showing All projects, it is the prompt box's
 * PICK (lib/crossProject.ts); under an All-projects drawer, the drawer's project. The list and the queue
 * read machine-wide data and name their project on every call (AllQueues.tsx, TierList.tsx).
 *
 * ONE component for every address, at the same depth, so react-router keeps the one instance mounted
 * across a drawer opening or closing, and across a change of view — the page must not remount under the
 * operator. `<App/>` is keyed by a CONSTANT for the same reason: what is per-project (the store's board
 * and drawer stack) is reset by the binding instead.
 *
 * With nothing to show — All projects on an empty machine, or one whose every directory is gone — there
 * is no page, so it renders the welcome instead (ProjectActions.tsx), the one place a project is added from.
 */
function PageRoute() {
  const { pathname, search } = useLocation()
  // An address from when the view was a query (`/?project=<slug>`, `?focus=`, `?all`) says where it
  // lands now before anything renders under it, so nothing paints for a view the page is about to leave.
  const legacy = legacyViewRedirect(pathname, search)
  if (legacy !== undefined) return <Navigate to={legacy} replace />
  return <CrossProjectPage />
}

/** `?add=<dir>` opens the add-project dialog, pre-filled; `?unknown=<slug>` says a page was sent away. */
function answerArrival(search: string): void {
  const asked = new URLSearchParams(search)
  const proposed = asked.get("add")
  if (proposed) store.addProject = { proposed }
  const unknown = asked.get("unknown")
  if (unknown) showToast(`No project named ${unknown}`, { duration: 7000 })
}

function RegistryError({ error }: { error: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-center text-[13px] text-muted">
      Could not read the project registry: {error}
    </div>
  )
}

function PageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
    </div>
  )
}

function CrossProjectPage() {
  const { slug: routeSlug, thread } = useParams()
  const page = usePageResolution(routeSlug)
  const slug = routeSlug ?? (page.kind === "page" ? page.slug : undefined)
  // Render-phase, before anything below asks base-path which project `/` is.
  if (routeSlug === undefined) setHomeFocus(slug)
  // The gate useProjectBinding returns is NOT applied here, unlike /full below. Upstream's board is keyed
  // by its slug and remounts on every switch anyway, so rendering nothing for one commit costs it nothing;
  // this page is keyed by a constant precisely so a switch never remounts it, and the cross-project open
  // keeps its drawer frame (PendingThreadSheet, inside <App/>) on screen through the rebind. Returning
  // null would unmount that frame mid-slide. The layout-effect reset still lands before the first paint.
  useProjectBinding(slug)
  useRouteToStore()
  useRouterTransition()
  useState(() => primeReturnFromFullscreen(thread))
  // A browser's first page starts the tour (lib/tour.ts), on All projects or a board alike.
  const pageShown = page.kind === "page"
  useEffect(() => {
    if (pageShown && !embedded()) startTourOnFirstRun()
  }, [pageShown])
  if (page.kind === "error") return <RegistryError error={page.error} />
  if (page.kind === "loading") return <PageSpinner />
  if (page.kind === "welcome") return <Welcome projects={page.projects} />
  return <App key="cross-project" />
}

type PageResolution =
  | { kind: "page"; view: PageView; slug: string | undefined }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "welcome"; projects: ProjectCard[] }

/**
 * What the page at this address shows, and which project it is bound to.
 *
 * Every address but `/` names its project in the path — a board's, or an
 * All-projects drawer's — and is bound to it at once. A board for a slug the registry does not have
 * (renamed, removed, a typo) is said and left for `/`; the
 * server answers a cold load of one before the app is even served (index.ts `unknownProjectPage`), so this
 * catches the ones reached inside the page.
 *
 * At `/` — All projects — the page is bound to the prompt box's pick, resolved against the registry, and
 * the address is put back to a bare `/` before anything paints, so a reload, a bookmark or a copied link
 * of this tab reopens exactly what it shows. A bare board (`/project/<slug>`) is put back to its bare path
 * the same way; a drawer's address is left alone.
 *
 * Two more arrive from outside, usually at `/`:
 *  - `?add=<dir>` is the LAUNCHER asking: running `ntwine` in an unknown folder does not adopt it, it
 *    sends the operator here to say yes. It opens the one add-project dialog, pre-filled.
 *  - `?unknown=<slug>` is the SERVER saying it sent a page here rather than let it hang: a board or a
 *    drawer for a project nobody has would render the app, 404 every call and sit on its boot spinner
 *    forever (index.ts `unknownProjectPage`). A URL that silently became the home page reads as ntwine
 *    having swallowed it.
 */
function usePageResolution(routeSlug: string | undefined): PageResolution {
  const atHome = routeSlug === undefined
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const view = viewAt(pathname)
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  // Which projects this server has open, so All projects binds one that can take a thread. Shared with
  // the page itself (same key), so the page it lands on paints from this read.
  const queues = useQuery(projectsQueuesQuery)
  const pickId = useCrossProjectPick()
  useState(() => {
    if (atHome) answerArrival(search)
  })
  const unknown = cards.data ? resolveView(cards.data, view).unknown : undefined
  useEffect(() => {
    if (unknown === undefined) return
    showToast(`No project named ${unknown}`, { duration: 7000 })
    navigate("/", { replace: true })
  }, [unknown, navigate])
  // The project this browser last showed on its own — All projects' prompt box falls back to it when
  // nothing was picked there (lib/crossProject.ts).
  const focusedId = view.kind === "project" ? cards.data?.find((card) => card.slug === view.slug)?.id : undefined
  useEffect(() => {
    if (focusedId) rememberLastFocusedProject(focusedId)
  }, [focusedId])
  // A LAYOUT effect, so the address says what the page shows before anything paints under it.
  const bare = atHome || pathname === `/project/${encodeURIComponent(routeSlug)}` || pathname === `/project/${encodeURIComponent(routeSlug)}/`
  const canonical = atHome ? ALL_PROJECTS_HREF : view.kind === "project" ? `/project/${encodeURIComponent(view.slug)}` : null
  useLayoutEffect(() => {
    if (bare && canonical !== null && (search !== "" || pathname !== canonical)) navigate(canonical, { replace: true })
  }, [bare, canonical, search, pathname, navigate])
  if (!atHome) return { kind: "page", view, slug: routeSlug }
  if (cards.error) return { kind: "error", error: String(cards.error) }
  if (!cards.data || queues.isPending) return { kind: "loading" }
  const openIds = queues.data ? new Set(queues.data.map((queue) => queue.projectId)) : undefined
  const pick = defaultCrossProjectFocus(cards.data, pickId, openIds, lastFocusedProject())
  return pick ? { kind: "page", view: ALL_PROJECTS, slug: pick } : { kind: "welcome", projects: cards.data }
}

/**
 * Any address the page does not have — a typo, an old `/status/<s>` — lands on `/`, keeping the query
 * (`?add=`, `?unknown=`) it carries. The old names of All projects (`/queues`, `/projects`) and an
 * All-projects drawer's address cut short (`/all`, `/all/<slug>`) land on All projects, at `/`.
 */
function HomeRedirect() {
  const { pathname, search } = useLocation()
  const first = pathname.split("/")[1] ?? ""
  return <Navigate to={`/${search}`} replace />
}

/**
 * URL → store, for the routes INSIDE the page.
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
    applyLocation(location.pathname)
  }, [location.pathname])
}

// Tells lib/router's store → URL writer when react-router's view transition starts and finishes, so it
// holds its write until the transition is over (router.ts `routerTransitioning`). A LAYOUT effect: the
// way back from /full runs its page's passive effects a second or more after the page is on screen, and
// the writer has to know before that. Both shells report it — the transition starts on the page being
// left, which on the way back is /full.
function useRouterTransition(): void {
  const { isTransitioning } = useContext(UNSAFE_ViewTransitionContext)
  useLayoutEffect(() => noteRouterTransition(isTransitioning), [isTransitioning])
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
/** A drawer's fullscreen page on All projects — or, carrying a query-era view (`?project=`), its board's. */
function FullRoute() {
  const { pathname, search } = useLocation()
  const legacy = legacyViewRedirect(pathname, search)
  if (legacy !== undefined) return <Navigate to={legacy} replace />
  return <StandaloneRoute />
}

function StandaloneRoute() {
  const { thread, slug } = useParams()
  useRegisterNavigate()
  useRouterTransition()
  const ready = useProjectBinding(slug)
  // Any drawer stack left by the page we came from is cleared HERE, on this route's first render —
  // deliberately NOT in the fullscreen door's click handler, and deliberately not in an effect. The
  // door's navigation runs inside a view transition, which snapshots the OLD page two renders after
  // the click — a click-time clear removed the very sheet the transition slides into place. And the
  // NEW page is snapshotted at this render's commit, so an effect would be one paint too late: this
  // page's own DrawerStack would be captured painting the thread's sheet over itself mid-transition.
  // A render-phase write (the useState initializer runs exactly once, before the children render)
  // means DrawerStack below already sees the empty stack in the same pass.
  useState(() => { if (store.drawers.length > 0) store.drawers = [] })
  // Recorded every render, consumed by CrossProjectPage's mount (primeFullscreenReturn): this is how the
  // page knows its first render is the return leg of the fullscreen door and should prime the reverse
  // morph's target.
  noteStandaloneThreadRender(thread!)
  // Reached from another project, this page must not read that project's board for its first commit
  // (useProjectBinding's gate).
  if (!ready) return null
  return (
    <>
      <StandaloneThreadPage slug={thread!} />
      {/* Its own, since it is outside the layout. This page renders a full transcript, so it has the
          copy-a-code-block control — whose only feedback is a toast, which until now had nowhere to
          go here. Skipping the layout does not mean skipping the feedback. */}
      <Toaster />
      {/* Its own for the same reason: `e`, `h`, `r` and `f` (which leaves) work on this thread too. */}
      <KeyboardLayer />
      <LightboxHost />
    </>
  )
}

export const router = createBrowserRouter([
  // The focused single-thread pages sit OUTSIDE the layout — they have no rail, and should not.
  { path: "/thread/:thread/full", element: <StandaloneRoute /> },
  { path: `${CROSS_PROJECT_PATH}/thread/:thread/full`, element: <FullRoute /> },
  { path: `${PROJECT_PATH}/thread/:thread/full`, element: <StandaloneRoute /> },
  {
    element: <RootLayout />,
    children: [
      // The SAME element at the same depth for every address of the page, so react-router keeps the one
      // instance mounted across a drawer opening or closing and across a change of view — the page must
      // not remount under you.
      { path: "/", element: <PageRoute /> },
      { path: `${CROSS_PROJECT_PATH}/thread/:thread`, element: <PageRoute /> },
      { path: PROJECT_PATH, element: <PageRoute /> },
      { path: `${PROJECT_PATH}/thread/:thread`, element: <PageRoute /> },
      // Anything else is the page — never a blank route (see "ONE PAGE" above).
      { path: "*", element: <HomeRedirect /> },
    ],
  },
])
