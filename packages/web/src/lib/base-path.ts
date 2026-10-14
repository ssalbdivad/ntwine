import { NTWINE_ROUTE_PREFIX } from "@ntwine/shared"

// WHICH PROJECT THIS PAGE IS SHOWING, taken from its own URL.
//
// One Ntwine per machine serves every project from one origin, and ONE PAGE shows them. Its PATH names its
// view (lib/pageView.ts), and with it the project the page is bound to:
//
//   /                              where this browser was last (a redirect), or a phone's projects list —
//                                  bound to the prompt box's pick (below)
//   /all                           All projects, the default — bound to the prompt box's pick (below)
//   /all/<slug>/thread/<t>         All projects with that thread's drawer open — bound to its project
//   /project/<slug>                that project's board
//   /project/<slug>/thread/<t>     the board with that thread open (its card, or its drawer)
//
// and either thread address plus `/full` is that thread's fullscreen page. That works because Ntwine's own
// routes live under `/_ntwine/`, so the top-level namespace is the SPA's.
//
// `/project/<slug>` was retired on 2026-09-28, when one page replaced the project view and focus mode moved
// into the query (`/?project=<slug>`); it came back as the project board's address on 2026-10-06 (David:
// the fork is the base, with upstream's `/project/<slug>` scheme, plans/upstream-superset.md §2), and the query
// now only redirects to it (routes.tsx).
//
// AN EMPTY BASE IS A SUPPORTED STATE, not a bug: an unprefixed `/thread/<slug>/full` is the launching
// project's fullscreen page, and a page with no project at all (the welcome) has nothing to prefix.
//
// The page is always BOUND to one project — the page project: the board's project, All projects'
// prompt-box pick, or the one whose drawer is open — and every helper below answers for it (the same API
// base, the same live feed, the same cache scope), which is what lets the whole drawer stack and composer
// work for any project on the one page.
//
// AT `/all` (AND `/`) THE PAGE PROJECT IS NOT IN THE PATH. The route resolves it — the pick
// (lib/crossProject.ts) — and hands it here with `setHomeFocus`, so `/all` answers as `/all/<slug>` does. A
// drawer's URL still names its thread's project, because that is the thread's address.

/**
 * The SPA's own top-level route names — the in-app links an agent writes unprefixed, and the ones a page
 * re-points under its project (prefixedAppRoute). This is the single definition of that set —
 * `isNtwineRoute` in markdownTargets.ts used to keep its own copy, and a stale copy is not a small bug:
 * every in-app link starts looking like a FILESYSTEM path to the markdown sanitizer, and renders as a
 * disabled local-file chip. Only `thread`: a bare `/status/<s>` is a retired address (isRetiredAppPath).
 */
export const APP_ROUTE_SEGMENTS = new Set(["thread"])

/**
 * The in-app addresses Ntwine minted before the singleton put every project under a prefix: the launching
 * project's unprefixed `/status/<s>` lists. Nothing mints them now, and the route tree sends each one home
 * untranslated (routes.tsx). (The `/project/<slug>…` shapes were on this list from 2026-09-28 to
 * 2026-10-06, while the project board was gone; they are its live addresses again — projectSlug.)
 *
 * They are still IN-APP, and that is the only thing this answers. Old handoffs and toasts carry them, and
 * read as a filesystem path the markdown sanitizer turned each into a local-file chip whose click asked
 * the server to open `/status/blocked` — an error toast, where the link as written lands on the page.
 * EXACTLY this shape, the way MACHINE_ROUTE_SEGMENTS matches its names: `/status/a/b` is somebody's file.
 */
export function isRetiredAppPath(path: string): boolean {
  return /^\/status\/[^/]+\/?$/u.test(path)
}

/**
 * Machine-level pages: they are in-app, but they name no project and are never re-pointed under one.
 * `/all` is All projects (it was the bare `/` from 2026-09-30 to 2026-10-06), and `queues` and `projects`
 * are old addresses of it (the page before it was the home, and the project grid it absorbed), which the
 * route tree sends there. `/` itself is one too.
 */
export const MACHINE_ROUTE_SEGMENTS = new Set(["all", "projects", "queues"])

/**
 * This page’s path, or `/` where there is no page.
 *
 * These helpers are imported by modules that also run under node — the markdown sanitizer and the
 * socket transport both have unit tests with no DOM — so reading `location` unguarded turns a pure
 * function into one that throws depending on who imported it. A STUBBED location counts too: the
 * socket tests install one carrying only `origin`, so a present `location` is not a promise of a
 * present `pathname`.
 */
function here(pathname?: string): string {
  if (typeof pathname === "string") return pathname
  const current = typeof location === "undefined" ? undefined : location.pathname
  return typeof current === "string" ? current : "/"
}

/**
 * A project lives UNDER a segment of its own rather than at the root — `/all/<slug>/…` for a drawer on All
 * projects, `/project/<slug>…` for its board.
 *
 * `/nub/thread/x` would have made every project slug a top-level route name, so every page Ntwine might
 * later want — settings, docs, a machine dashboard — would have to be fought for against a directory
 * somebody happens to have. A segment in front costs one segment and keeps the root free.
 */
const CROSS_PROJECT_SEGMENT = "all"
export const CROSS_PROJECT_PREFIX = `/${CROSS_PROJECT_SEGMENT}`
export const PROJECT_PREFIX = "/project"

/**
 * A project board's address, EXACTLY: `/project/<slug>`, its thread `…/thread/<t>` and that thread's
 * `…/full`, and its retired status list `…/status/<s>` (gone 2026-10-14; old links still land in the app),
 * each with an optional trailing slash. Nothing else under
 * `/project/` is a page: `/project` is a real directory on plenty of machines, and the markdown sanitizer
 * asks this (through projectSlug) whether a link is in-app — `/project/acme/src/main.rs` is somebody's file.
 * Query and fragment are not part of a path; a caller handing an href is answered for its path.
 */
const PROJECT_BOARD = /^\/project\/([^/?#]+)(?:\/thread\/[^/?#]+(?:\/full)?|\/status\/[^/?#]+)?\/?(?:[?#].*)?$/u

/** The slug a project board's address names (still encoded, as projectSlug answers), or undefined. */
function boardSlug(path: string): string | undefined {
  return PROJECT_BOARD.exec(path)?.[1]
}

/** Is this a project's board (`/project/<slug>…`) — the page focused on one project — rather than All projects? */
export function isProjectBoardPath(pathname?: string): boolean {
  return boardSlug(here(pathname)) !== undefined
}

let homeFocus: string | undefined

/**
 * The project All projects (`/all`, and a phone's `/`) is bound to — set by its route (routes.tsx
 * CrossProjectPage) during render, before anything below it asks, and cleared when it has none to show.
 */
export function setHomeFocus(slug: string | undefined): void {
  homeFocus = slug
}

/** A page whose path names no project: All projects at `/all`, and `/`. */
function isHome(path: string): boolean {
  return path === "/" || path === "" || path === CROSS_PROJECT_PREFIX || path === `${CROSS_PROJECT_PREFIX}/`
}

/**
 * Is this a page that only its ROUTE binds to a project — All projects at `/all`, a phone's `/` — with none
 * bound? It names no project, and `apiBase()` there answers the unprefixed `/_ntwine`: the project that
 * LAUNCHED the server, a stranger to this page. A call that needs a project is refused there rather than
 * sent to it (api/rpc.ts `routeCall`).
 */
export function isUnboundHome(pathname?: string): boolean {
  return isHome(here(pathname)) && homeFocus === undefined
}

/** The slug this page is showing, or `undefined` for the unprefixed launching project. */
export function projectSlug(pathname?: string): string | undefined {
  const path = here(pathname)
  if (isHome(path)) return homeFocus
  const board = boardSlug(path)
  if (board !== undefined) return board
  const [, first, second] = path.split("/")
  return first === CROSS_PROJECT_SEGMENT && second ? second.replace(/[?#].*$/u, "") || undefined : undefined
}

/**
 * Is this the one page (`/all` or `/` with a focus, `/all/<slug>…`, or a project's board `/project/<slug>…`)
 * — rather than a page with no project in it: the welcome, or the launching project's unprefixed /full?
 */
export function isCrossProjectPath(pathname?: string): boolean {
  const path = here(pathname)
  if (isHome(path)) return homeFocus !== undefined
  return projectSlug(path) !== undefined
}

/**
 * A project's prefix ON THE VIEW THIS PAGE SHOWS — the one place that knows the shape, and only ever with a
 * path after it, a thread's: `/project/<slug>/thread/<t>` on a project's board, `/all/<slug>/thread/<t>` on
 * All projects (and on any page that names neither, such as the welcome). So a thread opened in place —
 * from a card, a row, a link, a toast, a notification or the editor — keeps the page's view: All projects
 * stays All projects with that thread's drawer over it, and a board moves to the thread's project's board,
 * the way upstream's `/project/<slug>/thread/<t>` links always did. Every caller that spells a thread's
 * address goes through here, which is what let the view move into the path without touching them.
 */
export function crossProjectHref(slug: string, pathname?: string): string {
  return isProjectBoardPath(pathname) ? `${PROJECT_PREFIX}/${slug}` : `${CROSS_PROJECT_PREFIX}/${slug}`
}

/** `/project/nub` or `/all/nub`, or `""` when this page names no project (the launching project's unprefixed /full). */
export function basePath(pathname?: string): string {
  const path = here(pathname)
  const board = boardSlug(path)
  if (board !== undefined) return `${PROJECT_PREFIX}/${board}`
  const slug = projectSlug(path)
  return slug ? `${CROSS_PROJECT_PREFIX}/${slug}` : ""
}

/** The path with the project prefix removed — what the router reasons about. */
export function innerPath(pathname?: string): string {
  const path = here(pathname)
  // A page that names no project is its own root, with or without a binding (`/all` before its pick).
  if (isHome(path)) return "/"
  const base = basePath(path)
  if (!base) return path || "/"
  return path.slice(base.length).replace(/^\/$/u, "") || "/"
}

/**
 * An inner path put back in terms the address bar uses. A board's own root is the board,
 * `/project/<slug>`. All projects' root is `/all` whichever project a drawer had it bound to: closing the
 * last drawer goes home, where the binding is the pick again. `/` is its own root (a phone's projects list).
 */
export function outerPath(inner: string, pathname?: string): string {
  const path = here(pathname)
  if (inner !== "/") return `${basePath(path)}${inner}`
  if (isProjectBoardPath(path)) return basePath(path)
  return path === "/" || path === "" ? "/" : CROSS_PROJECT_PREFIX
}

/**
 * An UNPREFIXED in-app route re-pointed at the project this page is showing, or `null` for anything
 * else (an already-prefixed link, `/`, a filesystem path, a web URL).
 *
 * A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project, and
 * the shape its prompt still teaches. Rendered verbatim on a page focused on `nub`, that anchor
 * addresses whichever project LAUNCHED the server: a plain left-click is caught by the thread-link interceptor
 * and opens the right thread, but ⌘-click, middle-click and "open link in new tab" hand the raw href
 * to the browser and land on a stranger's board (or on <MissingThread>). Rewriting the href at
 * sanitize time fixes every one of those without the author having to know which project they are in.
 *
 * `/` is deliberately NOT rewritten: it is the cross-project page, which is the same page everywhere.
 */
export function prefixedAppRoute(href: string | null | undefined, pathname?: string): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null
  const bare = href.replace(/[?#].*$/u, "")
  if (projectSlug(bare)) return null // already names its project
  const first = bare.split("/")[1] ?? ""
  if (!APP_ROUTE_SEGMENTS.has(first)) return null
  const outer = outerPath(href, pathname)
  return outer === href ? null : outer
}

/**
 * Where THIS page's API lives: `/_ntwine/nub`, or `/_ntwine` unprefixed.
 *
 * Every client URL builder goes through here, so a page always addresses the project it is showing
 * rather than whichever one happens to have launched the server.
 */
export function apiBase(pathname?: string): string {
  const slug = projectSlug(pathname)
  // The API keeps the FLAT `/_ntwine/<slug>/…` shape. It already sits inside a reserved namespace, so
  // it has no root to protect, and the server's split stays a two-part one.
  return slug ? `${NTWINE_ROUTE_PREFIX}/${slug}` : NTWINE_ROUTE_PREFIX
}
