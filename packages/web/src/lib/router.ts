import { subscribe } from "valtio"
import { store, topRoutedSlug, closeDrawersById } from "../store.ts"
import { ownedByThisPage } from "./projectOwnership.ts"
import { innerPath, outerPath, projectHref } from "./base-path.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"

// URL ⇄ state sync, SPA-style. Paths: `/` (the unified queue — the only page), `/thread/<slug>`
// (the queue with that thread open in the drawer STACK's topmost thread layer — there is no
// standalone thread page), `/status/<status>` (URL-only lists).
//
// History contract (standard SPA): opening a thread layer PUSHES an entry so the browser Back
// button unwinds it; other transitions REPLACE so transient state never buries the back stack.
//
// (The focus machine this used to route through was deleted — the router writes store.view directly.)

function currentPath(): string {
  const top = topRoutedSlug()
  if (top) return `/thread/${encodeURIComponent(top)}`
  // A parked route still IS that thread's URL. Without this the address bar would flip to "/" for the
  // frame or two before the board settles the destination, and settling it into a drawer would then
  // push a redundant history entry for a URL the user never left.
  if (store.routeThreadSlug) return `/thread/${encodeURIComponent(store.routeThreadSlug)}`
  if (store.view.startsWith("status:")) return `/status/${encodeURIComponent(store.view.slice(7))}`
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

/**
 * An inner path put back in address-bar terms — with ONE correction `outerPath` cannot make.
 *
 * On an unprefixed page `outerPath("/")` is `"/"`, and since the singleton landed `/` is the
 * ALL-PROJECTS GRID, not a board. So closing the last thread drawer on the launching project — the
 * commonest navigation there is — navigated the maintainer straight to the project picker (verified
 * live, 2026-08-07). Every other project was unaffected: theirs is `/project/<slug>`, which is a board.
 *
 * The launching project has a `/project/<slug>` URL too; it simply had no way to say its own slug
 * until the board snapshot started carrying one. Use it for the queue and the ejection stops. With no
 * slug yet (a pre-restart server, or before the first board lands) this is exactly the old behaviour.
 */
export function queueDestination(inner: string, slug = store.board?.projectSlug): string {
  const outer = outerPath(inner)
  return outer === "/" && slug ? projectHref(slug) : outer
}

export function applyPath(path: string): void {
  const thread = path.match(/^\/thread\/([^/]+)$/)
  if (thread) {
    const slug = decodeSegment(thread[1])
    if (slug === null) {
      store.routeThreadSlug = null
      closeDrawersById(store.drawers.map((d) => d.id))
      store.view = "todos"
      return
    }
    store.view = "todos"
    // Back/forward landed on a thread path: if that thread is somewhere in the stack, unwind ABOVE
    // it and we're done — the surface it asks for is already up.
    const idx = store.drawers.findIndex((d) => (d.kind === "thread" || d.kind === "terminal") && d.slug === slug && !d.closing)
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
    store.routeThreadSlug = slug
    return
  }
  const status = path.match(/^\/status\/([^/]+)$/)
  if (status) {
    store.routeThreadSlug = null
    closeDrawersById(store.drawers.map((d) => d.id))
    const statusName = decodeSegment(status[1])
    store.view = statusName === null ? "todos" : `status:${statusName}`
    return
  }
  // Everything else is the queue; Back past the last thread layer unwinds the stack (animated).
  store.routeThreadSlug = null
  closeDrawersById(store.drawers.map((d) => d.id))
  store.view = "todos"
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
  applyPath(innerPath(path))
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

export function startRouter(navigate: (path: string, options: { replace: boolean }) => void): () => void {
  // Boot: adopt whatever the address bar says (deep link / reload restores the state).
  primeRoute()

  return subscribe(store, () => {
    // The fullscreen page is NOT the board's URL to write. Its route lives outside RootLayout, but
    // valtio delivers this notification a microtask late: StandaloneRoute clears the drawer stack on
    // its first render (it moved there from the fullscreen door's click handler for the view
    // transition — see ExpandThreadLink), so by the time this runs the address bar already says
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
    const path = queueDestination(currentPath())
    if (path === location.pathname) return
    // A NEW topmost thread pushes history; unwinding or non-thread transitions replace. `startsWith`
    // is checked against the INNER path: under a project prefix every path starts with `/project/`.
    const openingThread = currentPath().startsWith("/thread/")
    navigate(path, { replace: !openingThread })
  })
}
