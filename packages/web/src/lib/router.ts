import { subscribe } from "valtio"
import { store, topRoutedSlug, closeDrawersById, closeLayersDisplacedBy, primeFullscreenReturn } from "../store.ts"
import { ownedByThisPage } from "./projectOwnership.ts"
import { innerPath, outerPath } from "./base-path.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"
import { homeHref } from "./pageView.ts"

// URL ⇄ state sync, SPA-style. Inner paths: `/` (the page), `/thread/<slug>` (the page with that
// thread open in the drawer STACK's topmost thread layer — or, from a cold link on a project's board, a
// queued thread landed on its card: store.resolveRoutedThread). In the address bar they sit under the page's prefix — `/project/<slug>/…`
// on a board, `/all/<project>/…` for a drawer on All projects (base-path.ts). The fullscreen page,
// `/thread/<slug>/full`, is its own route.
//
// History contract (standard SPA): opening a thread layer PUSHES an entry so the browser Back
// button unwinds it; other transitions REPLACE so transient state never buries the back stack.
//
// (The focus machine this used to route through was deleted, and so, on 2026-09-28, was the `view` it
// then wrote.)

function currentPath(): string {
  const top = topRoutedSlug()
  if (top) return `/thread/${encodeURIComponent(top)}`
  // A parked route still IS that thread's URL. Without this the address bar would flip to "/" for the
  // frame or two before the board settles the destination, and settling it into a drawer would then
  // push a redundant history entry for a URL the user never left.
  if (store.routeThreadSlug) return `/thread/${encodeURIComponent(store.routeThreadSlug)}`
  return "/"
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A hand-edited/truncated percent escape must not throw during primeRoute() and abort the entire
    // app before React mounts. Treat malformed routes like any other unknown path: return to Queue.
    return null
  }
}

export function applyPath(path: string): void {
  const thread = path.match(/^\/thread\/([^/]+)$/)
  // An address that is not the pending open's thread (Back, another thread) abandons that open.
  const pendingSlug = store.pendingOpen?.slug
  if (pendingSlug !== undefined && (!thread || decodeSegment(thread[1]) !== pendingSlug)) store.pendingOpen = null
  if (thread) {
    const slug = decodeSegment(thread[1])
    if (slug === null) {
      store.routeThreadSlug = null
      closeDrawersById(store.drawers.map((d) => d.id))
      return
    }
    // Back/forward landed on a thread path: if that thread is somewhere in the stack, unwind ABOVE
    // it and we're done — the surface it asks for is already up.
    const idx = store.drawers.findIndex((d) => d.kind === "thread" && d.slug === slug && !d.closing)
    // Unwind the layers ABOVE the matched thread through their animated closers (slide-out), not an
    // instant splice — Back/forward must play the same exit animation as backdrop/Esc.
    if (idx !== -1) {
      store.routeThreadSlug = null
      closeDrawersById(store.drawers.slice(idx + 1).map((d) => d.id))
      return
    }
    // Otherwise PARK the slug: the destination depends on whether the thread is queued, which the
    // board alone can say, and on a cold deep link no board has arrived yet. App settles it the first
    // render the board is authoritative (store.resolveRoutedThread). Deciding here instead — the old
    // unconditional pushDrawer — is what rendered a queued thread's panel twice on `/thread/<slug>`:
    // its full card in the main column, plus the identical panel in a drawer half-covering it.
    //
    // What the destination DISPLACES is already known, though, and must go now. The commonest way here
    // with a stack open is Back after a lateral move — thread A, then a link or a sidebar row to B: the
    // one-drawer policy replaced A with B, so Back to A's entry finds B still on top. Leaving B up made
    // the store→URL sync push B's URL back over A's, then resolveRoutedThread push A's over that — two
    // new entries per Back press, flipping between the threads and never reaching the board. Closing B
    // here is the same displacement opening A would do, a beat earlier, so the URL never disagrees.
    closeLayersDisplacedBy({ kind: "thread", slug })
    store.routeThreadSlug = slug
    return
  }
  // Everything else is the page; Back past the last thread layer unwinds the stack (animated).
  store.routeThreadSlug = null
  closeDrawersById(store.drawers.map((d) => d.id))
}

// Cold-load adoption is initial application state, so establish it BEFORE React's first render.
// main.tsx primes synchronously; startRouter repeats this safely (both paths are idempotent) so
// tests/non-main entry points retain the old self-contained contract.
//
// A thread path only PARKS its slug here — the destination needs the board (see applyPath). That is
// not a regression of the old opacity-0-phantom bug: the layer that bug produced was one animated in
// AFTER mount, whereas resolveRoutedThread still pushes `routed: true` (painted open, no animation),
// and it fires on the very render the board lands — the same render that replaces App's boot spinner
// with the queue, so the sheet and the page behind it appear together.
export function primeRoute(path = location.pathname): void {
  applyLocation(path)
}

// THE ADDRESS THE STORE LAST TOOK ITS STATE FROM. react-router writes history BEFORE the new route's
// effects run, and the store only learns the new URL in those effects (routes.tsx useRouteToStore). In
// between, the store still describes the PREVIOUS URL — and any notification in that window (a socket
// status, a toast timer) ran the store → URL writer, which "corrected" the address bar back to the old
// state. For a thread of the focused project that window is empty, because `openThread` opens its
// drawer store-first; a thread of another project opens URL-first (AllQueuesCard
// useOpenThreadInPlace), so there it put the previous project's parked thread under the new project's
// prefix, or wrote the new project's bare page over the thread
// just clicked. So the writer only writes a URL the store has absorbed, and runs once more when it has.
let absorbed: string | null = null
let skippedWrite = false
let activeWriter: (() => void) | null = null
// AN ADDRESS THE WRITER WROTE THAT THE STORE HAS SINCE MOVED PAST. The guard above holds a write back
// while the route catches up, and the route then APPLIED the address it caught up to — undoing whatever
// the store did meanwhile. A drawer opened store-first (a row of the page's own project, which in focus
// mode is every row) and closed before the route had committed its address was re-opened by that
// address, so Escape did nothing: 6 of 6 tries at a load average of ~10-40, where the commit trailed
// the push by over 800ms (2026-09-29). So an address the writer wrote (`written`) that arrives while a
// write is held back (`skippedWrite`: the store has moved since) is `stale` — absorbed, not applied —
// and the held-back write then says what the store says now.
//
// Stale until that write has run, not for one application: each commit applies its address TWICE — App
// re-registering this writer (its `navigate` changes on the same commit, and startRouter primes again)
// and the route's own effect — and the second was enough to re-open the drawer on its own. Everywhere
// else the writer's address is applied like any other, which is what resets a parked slug on the way
// back from /full; skipping it there too left the address on a drawer the reader had closed.
let written: string | null = null
let stale: string | null = null
// AN ADDRESS THE PAGE OPENED ON BEFORE ANY ROUTE EFFECT HAD RUN — the way back from /full, whose drawer
// the page pushes in its FIRST render (store.ts primeFullscreenReturn) so the reverse morph has something
// to land on. The store has taken that address in, but nothing here knows it yet: the page's writer and
// its route effect are passive effects, and the return is a view transition whose update callback held
// them back — 1.0-1.3s after the drawer was in the DOM at a load average of ~6 (2026-09-29, probed with
// the browser's own `startViewTransition` promises). The previous page's writer is gone with it, so an
// Escape in that window closed the drawer and wrote nothing; the route then applied the drawer's address,
// which PARKED the slug, and the board settled it straight back into a drawer — Escape undone in 15 of 25
// tries on that machine, and the address never left the drawer.
//
// So when the route applies an adopted address the store no longer says (`currentPath()` — closed, or
// another thread opened on top), it is stale exactly as a written one is: absorbed, not applied, and the
// writer runs to say what the store says now — once the transition is over (`routerTransitioning`).
// When the store still says it, it is applied as ever.
let adopted: string | null = null

/**
 * The page's first render on the way back from /full (routes.tsx CrossProjectPage): prime the drawer the
 * address names, and — when it did — mark that address as one the store has already taken in.
 */
export function primeReturnFromFullscreen(thread: string | undefined): void {
  if (!primeFullscreenReturn(thread)) return
  if (typeof location !== "undefined" && typeof location.pathname === "string") adopted = location.pathname
}

/** URL → store for the page's current address (routes.tsx useRouteToStore, and boot). */
export function applyLocation(pathname: string): void {
  absorbed = typeof location !== "undefined" && typeof location.pathname === "string" ? location.pathname : pathname
  if (skippedWrite && pathname === written) stale = pathname
  if (pathname === adopted && currentPath() !== innerPath(pathname)) {
    stale = pathname
    skippedWrite = true
  }
  adopted = null
  written = null
  if (pathname !== stale) {
    stale = null
    applyPath(innerPath(pathname))
  }
  if (skippedWrite) {
    skippedWrite = false
    queueMicrotask(() => activeWriter?.())
  }
}

/**
 * STORE → URL. The other direction now belongs to the route tree (routes.tsx `useRouteToStore`).
 *
 * `navigate` rather than `history.pushState`: with a real router the history stack is the router's,
 * and writing to it behind its back leaves react-router rendering the previous match — the drawer
 * would open with the address bar agreeing and the page not.
 *
 * Back/forward needs no listener any more either. The router owns popstate and re-renders the match,
 * which drives `useRouteToStore`, which calls `applyPath` — the same function the old popstate
 * handler called, reached the same way every other navigation reaches it.
 */
// THE APP'S NAVIGATOR, reachable without router context. react-router's `useNavigate` is a hook, and
// the components that need to change the URL in place — the fullscreen door on a sidebar row, the
// back arrow on the fullscreen page — render in unit tests and fixtures with no <Router> above them,
// where the hook throws. The route tree registers its navigate here (routes.tsx, both shells) and
// leaves call there; with nothing registered (a bare test render) it falls back to a document load,
// which is what the underlying <a href> would have done anyway.
// `viewTransition` rides through to react-router's navigate, which wraps the route swap in
// `document.startViewTransition` where the browser has it and falls back to an instant swap where it
// doesn't. Both halves of the fullscreen door pass it today; react-router re-arms
// it on its own for the browser-Back POP of a pair that transitioned.
export type SpaNavigateOptions = { replace?: boolean; viewTransition?: boolean }

let registeredNavigate: ((path: string, options?: SpaNavigateOptions) => void) | null = null

export function registerNavigate(navigate: ((path: string, options?: SpaNavigateOptions) => void) | null): void {
  registeredNavigate = navigate
}

export function spaNavigate(path: string, options?: SpaNavigateOptions): void {
  if (registeredNavigate) registeredNavigate(path, options)
  else if (typeof location !== "undefined") location.assign(path)
}

// REACT-ROUTER'S VIEW TRANSITION, from the navigation that starts one until its `finished` settles —
// its own `isTransitioning` (routes.tsx useRouterTransition reports it from a layout effect, which runs
// at commit, not a second later with the passive ones). Not the browser's `:active-view-transition`: a
// transition whose update outran the browser's DOM-update timeout (4s, at a load average of 30+) stops
// matching that at the timeout while react-router is still rendering into it, and a write issued in
// between was lost exactly as one issued earlier.
let routerTransitioning = false
let heldForTransition = false

/** react-router's view transition started or finished (routes.tsx useRouterTransition). */
export function noteRouterTransition(on: boolean): void {
  routerTransitioning = on
  if (on || !heldForTransition) return
  heldForTransition = false
  // After the commit that ended it has finished its layout effects — react-router's own included, which
  // re-subscribe its router to the post-transition state.
  queueMicrotask(() => activeWriter?.())
}

/**
 * Did this app push the history entry the page is on, in this session?
 *
 * react-router numbers the entries it writes (`idx` in history.state): the entry a document loaded on
 * is 0, and every push counts up from there — including a push lib/router made when a thread opened.
 * So a thread page on an entry above 0 has an entry BELOW it that is ours (the board it was opened
 * from, or whatever the app showed before), and the platform's Back returns there. On 0 it arrived by
 * a cold link — a bookmark, a notification, a pasted URL — and what sits below it, if anything, is some
 * other site.
 *
 * The phone thread header's ← asks this to behave exactly like Back: pop when there is an entry of
 * ours to pop to, and only otherwise fall back to replacing the thread's entry with the board (the
 * desktop ×'s close). Replacing it always had left TWO board entries behind every ← — the board the
 * thread was opened from, and the thread's entry rewritten to it — so the next Back did nothing.
 * The same-URL entries lib/backDismiss pushes carry the router's state over, so they read the same.
 * That includes one a reload left behind with no sheet to own it, which made ← pop onto the very same
 * thread; main.tsx steps off such an entry at boot (backDismiss `stepOffStaleLayerEntries`), so the
 * entry a page sits on is the router's own and this index stays truthful across a reload.
 */
export function appPushedCurrentEntry(state: unknown = typeof history === "undefined" ? null : history.state): boolean {
  const idx = state && typeof state === "object" ? (state as { idx?: unknown }).idx : undefined
  return typeof idx === "number" && idx > 0
}

export function startRouter(navigate: (path: string, options: { replace: boolean }) => void): () => void {
  // Boot: adopt whatever the address bar says (deep link / reload restores the state).
  primeRoute()

  const write = () => {
    // The fullscreen page is NOT the board's URL to write. Its route lives outside RootLayout, but
    // valtio delivers this notification a microtask late: StandaloneRoute clears the drawer stack on
    // its first render (it moved there from the fullscreen door's click handler for the view
    // transition — see ThreadMenu.tsx openFullscreen), so by the time this runs the address bar already says
    // `/thread/<slug>/full` and the board shell is on its way out — and without this guard the
    // "unwind" below navigated straight back to the board (caught live, 2026-08-28: a plain click
    // on the door left the URL exactly where it was).
    if (parseStandaloneThreadPath(innerPath()) !== null) return
    // The store still holds the project the page is LEAVING. react-router writes history before the new
    // route's effects reset the store (routes.tsx useProjectBinding), so a notification in between would
    // put the old project's drawer under the new project's prefix — on the cross-project page, where
    // opening another project's thread is exactly such a switch, that URL named a thread the new project
    // does not have. The reset that follows notifies again, and this runs then.
    if (store.board && !ownedByThisPage(store.board.projectSlug)) return
    // The address bar has moved on and the store has not caught up yet (see `absorbed`).
    if (location.pathname !== absorbed) {
      skippedWrite = true
      return
    }
    // Not while a view transition is running — the way back from /full is one. react-router renders its
    // destination inside the transition, and a navigation issued before the transition has finished
    // moves history and the router but was not rendered: the page stayed on the address it was leaving
    // while the address bar said another, so its route effect never ran for the new one, and a later
    // click that navigated back to the old one landed on nothing — the router saw no change (8 of 8
    // navigations issued inside that window on the return from /full, 2026-09-29). So the write waits
    // for the transition to finish, and `stale` stays until it has run.
    if (routerTransitioning) {
      heldForTransition = true
      return
    }
    // The held-back write is running: whatever address was stale, the store says its piece now.
    stale = null
    const path = outerPath(currentPath())
    if (path === location.pathname) return
    // A NEW topmost thread pushes history; unwinding or non-thread transitions replace. `startsWith`
    // is checked against the INNER path: under a project prefix every path starts with its prefix.
    const openingThread = currentPath().startsWith("/thread/")
    // Home is the page showing its view (lib/pageView.ts): closing the last drawer goes back to the board
    // it is on, `/project/<slug>`, else to `/all`, All projects (and a phone's `/` stays `/`).
    written = path
    navigate(path === "/" ? homeHref() : path, { replace: !openingThread })
  }
  activeWriter = write
  const unsubscribe = subscribe(store, write)
  return () => {
    unsubscribe()
    if (activeWriter === write) activeWriter = null
  }
}
