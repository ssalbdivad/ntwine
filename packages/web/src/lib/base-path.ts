import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"

// WHICH PROJECT THIS PAGE IS SHOWING, taken from its own URL.
//
// One Frizz per machine serves every project from one origin, so the URL names the project:
// `/project/nub/thread/fix-auth`. That works precisely because Frizz's own routes were moved under
// `/_frizz/` — the top-level namespace is otherwise free, so a first segment is either the SPA's own
// route or the `project` segment, and nothing else. (`/nub/thread/x` — the project at the ROOT — was
// the shape considered and rejected; see PROJECT_SEGMENT below for why it cost too much.)
//
// AN EMPTY BASE IS A SUPPORTED STATE, not a bug: the launching project is still served unprefixed at
// `/thread/<slug>` and `/status/<name>`, which is what lets the server land slug routing without a
// lockstep rewrite of this file, and what keeps every pre-singleton bookmark resolving. It is a legacy
// INBOUND alias, not a shape to MINT — see `outerPath`/`projectHref`. Note it does NOT include `/`,
// which is the cross-project page; the launching project's queue reaches its board through
// `queueDestination` (lib/router.ts) instead.
//
// TWO PREFIXES NAME A PROJECT, and they differ only in MODE. `/project/<slug>` is that project's BOARD
// (single-project mode). `/all/<slug>` is the CROSS-PROJECT page — every project's queue on one page —
// FOCUSED on `<slug>`: the project its prompt box dispatches into and whose thread drawer is open. The
// focused project IS the page project, so every helper below answers the same for both prefixes (the
// same API base, the same live feed, the same cache scope), which is what lets the board's whole drawer
// stack and composer work on the cross-project page unchanged. Only `basePath` keeps the mode, so a URL
// built on one page stays in that page's mode.

/**
 * The SPA's own top-level route names.
 *
 * Anything else in first position is a project slug. This is the single definition of that set —
 * `isFrizzRoute` in markdownTargets.ts used to keep its own copy, and under a project prefix a stale
 * copy is not a small bug: every in-app link starts looking like a FILESYSTEM path to the markdown
 * sanitizer, and renders as a disabled local-file chip.
 */
export const APP_ROUTE_SEGMENTS = new Set(["thread", "status"])

/**
 * Machine-level pages: they are in-app, but they name no project and are never re-pointed under one.
 * `/` itself is one too (the cross-project page); `queues` is its legacy address, kept as a redirect.
 */
export const MACHINE_ROUTE_SEGMENTS = new Set(["all", "projects", "queues"])

/** The project grid — every registered project, one card each, and the way to add another. */
export const PROJECTS_PATH = "/projects"

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
 * Projects live UNDER a segment of their own rather than at the root.
 *
 * `/nub` would have made every project slug a top-level route name, so every page Frizz might later
 * want — settings, docs, a machine dashboard — would have to be fought for against a directory
 * somebody happens to have. `/project/nub` costs one segment and keeps the root free.
 */
const PROJECT_SEGMENT = "project"
export const PROJECT_PREFIX = `/${PROJECT_SEGMENT}`
const CROSS_PROJECT_SEGMENT = "all"
export const CROSS_PROJECT_PREFIX = `/${CROSS_PROJECT_SEGMENT}`

/** The slug this page is showing, or `undefined` for the unprefixed launching project. */
export function projectSlug(pathname?: string): string | undefined {
  const [, first, second] = here(pathname).split("/")
  return (first === PROJECT_SEGMENT || first === CROSS_PROJECT_SEGMENT) && second ? second : undefined
}

/** Is this the cross-project page (`/all/<slug>…`) rather than a project's board? */
export function isCrossProjectPath(pathname?: string): boolean {
  const [, first, second] = here(pathname).split("/")
  return first === CROSS_PROJECT_SEGMENT && Boolean(second)
}

/** A project's BOARD — the one place that knows the shape. */
export function projectHref(slug: string): string {
  return `${PROJECT_PREFIX}/${slug}`
}

/** The cross-project page focused on a project. */
export function crossProjectHref(slug: string): string {
  return `${CROSS_PROJECT_PREFIX}/${slug}`
}

/**
 * A project's page in the MODE this page is in: its focus on the cross-project page, its board on a
 * board. For the doors that mean "go to that project" rather than "go to that project's board" — the
 * rail's squares — so choosing a project never throws the operator out of the mode they are working in.
 */
export function modeProjectHref(slug: string, pathname?: string): string {
  return isCrossProjectPath(pathname) ? crossProjectHref(slug) : projectHref(slug)
}

/** `/project/nub` or `/all/nub`, or `""` when this page is the unprefixed launching project. */
export function basePath(pathname?: string): string {
  const path = here(pathname)
  const slug = projectSlug(path)
  if (!slug) return ""
  return isCrossProjectPath(path) ? crossProjectHref(slug) : projectHref(slug)
}

/** The path with the project prefix removed — what the router reasons about. */
export function innerPath(pathname?: string): string {
  const path = here(pathname)
  const base = basePath(path)
  if (!base) return path || "/"
  return path.slice(base.length) || "/"
}

/** An inner path put back in terms the address bar uses. */
export function outerPath(inner: string, pathname?: string): string {
  const base = basePath(here(pathname))
  return base ? `${base}${inner === "/" ? "" : inner}` || "/" : inner
}

/**
 * An UNPREFIXED in-app route re-pointed at the project this page is showing, or `null` for anything
 * else (an already-prefixed link, a `/project/...` link, `/`, a filesystem path, a web URL).
 *
 * A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project, and
 * the shape its prompt still teaches. Rendered verbatim under `/project/nub`, that anchor addresses
 * whichever project LAUNCHED the server: a plain left-click is caught by the thread-link interceptor
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
 * Where THIS page's API lives: `/_frizz/nub`, or `/_frizz` unprefixed.
 *
 * Every client URL builder goes through here, so a page always addresses the project it is showing
 * rather than whichever one happens to have launched the server.
 */
export function apiBase(pathname?: string): string {
  const slug = projectSlug(pathname)
  // The API keeps the FLAT `/_frizz/<slug>/…` shape. It already sits inside a reserved namespace, so
  // it has no root to protect, and the server's split stays a two-part one.
  return slug ? `${FRIZZ_ROUTE_PREFIX}/${slug}` : FRIZZ_ROUTE_PREFIX
}
