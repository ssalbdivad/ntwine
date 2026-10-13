// THE PAGE'S VIEW — which projects the one page shows: ONE project (its board, the default) or every
// project (All projects).
//
// A project's BOARD is the default (David asked for it 2026-10-06, on upstream's case in the standups of
// 2026-10-01 and 10-06: projects stay separate, as in Claude, ChatGPT and T3; one sidebar of every project
// loses the five bands and does not scale to 17 projects and ~70 threads; Ntwine's design goal is
// progressive focus). It is
// the original design's one project per page, Ntwine's original shape: the list is that project's, banded as
// its sidebar banded it (ProjectBoard.tsx), the queue shows its cards, and the prompt box dispatches into it.
// All projects — every project's list and one queue across all of them, with the prompt box's own picker
// — stays, one click away (the switcher's first entry, the board's home crumb, the rail's top door), but
// is no longer home. It was home at a bare `/` from 2026-09-30 (maintainer: "by default ntwine should open
// the all projects view") until then.
//
// THE VIEW IS THE PATH, so every tab, bookmark and launch keeps its own, and a link says what it opens:
//
//   /                           no view of its own: where this browser was last (lastViewHref below), or
//                               on a phone its projects list (PhonePage.tsx)
//   /all                        All projects
//   /all/<slug>/thread/<t>      All projects, with that thread's drawer over it
//   /project/<slug>             that project's board — the launcher opens its own project's
//   /project/<slug>/thread/<t>  the board, with that thread open (its card, or its drawer)
//   /project/<slug>/status/<s>  the board's status list
//
// `/project/<slug>` is upstream's own scheme (upstream singleton-ntwine.md: `?project=` was considered there and
// rejected), restored 2026-10-06 (David: the fork is the base, and everything upstream decided is in it —
// plans/upstream-superset.md §2). From 2026-09-29 to then the board was a QUERY on `/` (`/?project=<slug>`,
// first spelled `?focus=`), and a drawer's address could not say which view it sat on, so each tab kept
// its view in sessionStorage. The path says it now, so there is nothing left for a tab to remember; the
// old queries redirect to the path (routes.tsx, legacyViewRedirect below).

import { EMBED_PARAM } from "@ntwine/shared"
import { useLocation } from "react-router"

export type PageView = { kind: "project"; slug: string } | { kind: "all" }

export const ALL_PROJECTS: PageView = { kind: "all" }

/** `/project/<slug>…` — a board's address — and its (still encoded) slug. */
const BOARD = /^\/project\/([^/?#]+)(?:\/|$)/u

/** The view a page at this path shows: a project's board for `/project/<slug>…`, else All projects (`/` too,
 *  which is a redirect to a view or, on a phone, the projects list over All projects' binding). */
export function viewAt(pathname: string): PageView {
  const match = BOARD.exec(pathname)
  return match ? { kind: "project", slug: decodeSafely(match[1]!) } : ALL_PROJECTS
}

/** All projects' address. */
export const ALL_PROJECTS_HREF = "/all"

/** The page showing a view: `/project/<slug>` or `/all`. */
export function viewHref(view: PageView): string {
  return view.kind === "all" ? ALL_PROJECTS_HREF : `/project/${encodeURIComponent(view.slug)}`
}

/** A project's board. */
export function projectViewHref(slug: string): string {
  return viewHref({ kind: "project", slug })
}

export function sameView(a: PageView | undefined, b: PageView | undefined): boolean {
  if (!a || !b) return a === b
  return a.kind === "all" ? b.kind === "all" : b.kind === "project" && a.slug === b.slug
}

/** A string that changes exactly when the view does — for keying state that belongs to one view. */
export function viewKey(view: PageView): string {
  return view.kind === "all" ? "*" : `project:${view.slug}`
}

/** The address bar's path, or `/` where there is none (a unit test under node, a stubbed location). */
function currentPath(): string {
  const path = typeof location === "undefined" ? undefined : location.pathname
  return typeof path === "string" ? path : "/"
}

/** The view the page is showing right now, read off the address — for a handler, which has no hook. */
export function currentView(): PageView {
  return viewAt(currentPath())
}

/**
 * Where "home" is for this page — the page with no drawer open, showing its view: the board it is on, or
 * `/all`. A drawer goes home to the view it was opened over. The store → URL writer closes the last drawer
 * to this (lib/router.ts), and so does anything else that means "back to the page". `/` is its own home: on
 * a phone it is the projects list, and nowhere else does a page stay on it.
 */
export function homeHref(pathname: string = currentPath()): string {
  return pathname === "/" ? "/" : viewHref(viewAt(pathname))
}

/** The view the page is showing, live. */
export function usePageView(): PageView {
  return viewAt(useLocation().pathname)
}

/**
 * Whether the view names a project this machine has. `unknown` is a board's slug no project has — renamed,
 * removed, a typo — which the page says rather than silently showing something else; the server answers a
 * cold load of one the same way (packages/server index.ts unknownProjectPage), so this catches the ones
 * reached inside the page (a stale link, Back past a rename).
 */
export function resolveView(
  cards: readonly { slug: string }[],
  asked: PageView | undefined,
): { view: PageView; unknown?: string } {
  if (asked?.kind !== "project") return { view: ALL_PROJECTS }
  if (cards.some((card) => card.slug === asked.slug)) return { view: asked }
  return { view: ALL_PROJECTS, unknown: asked.slug }
}

// ---- The views' old addresses --------------------------------------------------------------------------

const PROJECT_PARAM = "project"
/** The board's query until 2026-09-29, when a launcher of that age sent it; it reads as `project`. */
const LEGACY_FOCUS_PARAM = "focus"
/** All projects' address until 2026-09-30, when it became the bare `/`; it is `/all` since 2026-10-06. */
const ALL_PARAM = "all"

/**
 * Where an address that names its view in the QUERY lands now, or undefined for one that does not.
 *
 *   /?project=<slug>, /?focus=<slug>   → /project/<slug>
 *   /all/<s>/thread/<t>?project=…      → /project/<s>/thread/<t>   (and its /full)
 *   /?all                              → /all
 *   /?embed=vscode                     → /all?embed=vscode
 *
 * A drawer's old address named its thread in the path and the tab's board in the query; the thread is what
 * it opens, so its own project's board is where it lands. An editor's sidebar framed a bare `/` for All
 * projects until 2026-10-06 (packages/vscode embed.ts embedUrl, with no folder mapped to a project), and an
 * extension of that age still does: `/` is a redirect to the last view now, and a sidebar asked for All
 * projects. Everything else the query carries (an editor's `embed` and `theme`, a launcher's `add`) rides
 * along.
 */
export function legacyViewRedirect(pathname: string, search: string): string | undefined {
  const params = new URLSearchParams(search)
  const slug = params.get(PROJECT_PARAM) || params.get(LEGACY_FOCUS_PARAM) || undefined
  const framedHome = pathname === "/" && params.has(EMBED_PARAM)
  if (!slug && !framedHome && !params.has(ALL_PARAM) && !params.has(PROJECT_PARAM) && !params.has(LEGACY_FOCUS_PARAM)) return undefined
  params.delete(PROJECT_PARAM)
  params.delete(LEGACY_FOCUS_PARAM)
  params.delete(ALL_PARAM)
  const rest = params.toString()
  const query = rest ? `?${rest}` : ""
  const drawer = /^\/all\/([^/]+)\/thread\/([^/]+)(\/full)?\/?$/u.exec(pathname)
  if (slug && drawer) return `/project/${drawer[1]}/thread/${drawer[2]}${drawer[3] ?? ""}${query}`
  if (slug && (pathname === "/" || pathname === "/all" || pathname === "/all/")) return `${projectViewHref(slug)}${query}`
  if (!slug && pathname === "/") return `${ALL_PROJECTS_HREF}${query}`
  return `${pathname}${query}`
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
