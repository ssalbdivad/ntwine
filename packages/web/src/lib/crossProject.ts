import { useSyncExternalStore } from "react"
import type { ProjectCard } from "@ntwine/shared"

// ALL PROJECTS' PICK — which project the prompt box dispatches into while the page shows every project.
//
// The page is always bound to one project — the page project, for every "which project" question (see
// base-path.ts). Focused on a project (lib/pageView.ts), that is the project the page shows. Showing All
// projects — the home, and where every launch lands — it is the prompt box's own setting, like its model
// (David 2026-09-28), resolved by defaultCrossProjectFocus below: the operator's own pick in this
// browser, else the project they last focused here, else the one `ntwine` was last run in, else the one
// opened most recently.
//
// Remembered by ID, not slug: a rename changes the slug, and a remembered slug that no longer resolves
// would quietly fall back to another project.

const FOCUS_KEY = "ntwine.crossProjectFocus"

// THE PICK, as opposed to the page project. The page project moves whenever a thread of another project
// is opened (its drawer needs that project bound, and its address names it: `/all/<slug>/thread/<t>`), but
// the operator did not CHOOSE that project for their next thread by reading one of its threads. So All
// projects is bound to the last project they did choose — in the prompt box's picker, or the project they
// were focused on when they chose All projects — and closing the last drawer, which goes home, is going
// back to it. One per BROWSER, unlike the view: it is a default for a box, not a place.
let pick: string | null = null
let loaded = false
const listeners = new Set<() => void>()

export function rememberCrossProjectFocus(projectId: string): void {
  if (pick === projectId && loaded) return
  pick = projectId
  loaded = true
  try {
    localStorage.setItem(FOCUS_KEY, projectId)
  } catch {
    // Storage disabled or full: the page still works, it just forgets where it was.
  }
  for (const listener of listeners) listener()
}

export function rememberedCrossProjectFocus(): string | null {
  if (!loaded) {
    loaded = true
    try {
      pick = localStorage.getItem(FOCUS_KEY)
    } catch {
      pick = null
    }
  }
  return pick
}

export function subscribeCrossProjectFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The project the operator last CHOSE for All projects' prompt box, by id — live across the page. */
export function useCrossProjectPick(): string | null {
  return useSyncExternalStore(subscribeCrossProjectFocus, rememberedCrossProjectFocus, () => null)
}

// THE PROJECT LAST FOCUSED, in this browser — written whenever the page shows a project's board
// (routes.tsx). It aimed a bare `/` until 2026-09-30, when All projects became home; it is the prompt box's
// next-best answer after an explicit pick to "which project is this person working in", and the board a
// bare `/` opens for a browser that has a board to go back to but no view on record (lastViewHref). By ID,
// not slug: a rename changes the slug.
const LAST_FOCUSED_KEY = "ntwine.lastFocusedProject"

export function lastFocusedProject(): string | null {
  try {
    return localStorage.getItem(LAST_FOCUSED_KEY)
  } catch {
    return null
  }
}

export function rememberLastFocusedProject(projectId: string): void {
  try {
    if (localStorage.getItem(LAST_FOCUSED_KEY) !== projectId) localStorage.setItem(LAST_FOCUSED_KEY, projectId)
  } catch {
    // Storage disabled: the box falls through to the project Ntwine was launched from.
  }
}

// THE LAST VIEW THIS BROWSER SHOWED — a project's board or All projects — which is where a bare `/` goes
// (routes.tsx LastViewRedirect), and with it every launch from a project. `/` names neither view, so it goes
// back to whichever this browser had, and to All projects when it had none. Navigation memory, not a setting: it is written whenever the page shows a
// view, and nothing offers to change it. Per BROWSER (localStorage), like the pick above and unlike the
// view itself, which is each tab's path. A board is remembered by ID, so a rename still finds it. An
// editor's sidebar does not write it (routes.tsx): it is a frame in another app, and its view is the
// editor window's, not this browser's.
const LAST_VIEW_KEY = "ntwine.lastView"
const ALL_VIEW = "all"
const PROJECT_VIEW_PREFIX = "project:"

/** What this browser showed last: `all`, `project:<id>`, or null for a browser that never chose. */
export function lastView(): string | null {
  try {
    return localStorage.getItem(LAST_VIEW_KEY)
  } catch {
    return null
  }
}

/** Record the view the page shows: All projects, or the board of the project with this id. */
export function rememberLastView(view: { kind: "all" } | { kind: "project"; id: string }): void {
  const value = view.kind === "all" ? ALL_VIEW : `${PROJECT_VIEW_PREFIX}${view.id}`
  try {
    if (localStorage.getItem(LAST_VIEW_KEY) !== value) localStorage.setItem(LAST_VIEW_KEY, value)
  } catch {
    // Storage disabled: a bare `/` falls through to All projects (lastViewHref step 2).
  }
}

/**
 * Where a bare `/` goes: `/all` or `/project/<slug>`, or undefined when there is no project to show (the
 * welcome, which adds one). In order:
 *
 *   1. the view this browser showed LAST (`remembered`, lastView above) — All projects, or a board whose
 *      project is still registered and its directory still there;
 *   2. else All projects, the default.
 *
 * All projects with nothing in it but the Home workspace is the welcome; a remembered Home board is not.
 */
export function lastViewHref(cards: readonly Pick<ProjectCard, "id" | "slug" | "stale" | "home">[], remembered: string | null): string | undefined {
  const present = cards.filter((card) => !card.stale)
  if (remembered?.startsWith(PROJECT_VIEW_PREFIX)) {
    const id = remembered.slice(PROJECT_VIEW_PREFIX.length)
    const card = present.find((candidate) => candidate.id === id)
    if (card) return `/project/${encodeURIComponent(card.slug)}`
  }
  return present.some((card) => !card.home) ? "/all" : undefined
}

/**
 * Where ⌥↓ (`step` 1) or ⌥↑ (-1) in the prompt box sends the next thread: the project below or above the
 * focus in the picker's own list (AllQueues.tsx ProjectPicker — every project whose directory still
 * exists, in the rail's order), wrapping round at either end.
 *
 * Only a project this server has OPEN: the key carries the draft into the box it lands on, and a project
 * that is not open never shows one (the landing's own rule, below). Undefined when no other project
 * qualifies, so the key keeps its ordinary meaning.
 */
export function stepPick<P extends { slug: string; open: boolean; stale: boolean }>(projects: readonly P[], focus: string | undefined, step: 1 | -1): P | undefined {
  const choices = projects.filter((project) => !project.stale)
  const at = choices.findIndex((project) => project.slug === focus)
  // A focus the list does not hold sits just outside it, so either direction starts at an end.
  const from = at !== -1 ? at : step === 1 ? -1 : choices.length
  for (let distance = 1; distance <= choices.length; distance++) {
    const candidate = choices[(((from + step * distance) % choices.length) + choices.length) % choices.length]
    if (candidate.open && candidate.slug !== focus) return candidate
  }
  return undefined
}

/**
 * The project All projects is bound to — the one its prompt box dispatches into — in this order:
 *
 *   1. the operator's own PICK in this browser (`pickId`: the picker, ⌥↑/⌥↓, leaving a focused project
 *      for All projects);
 *   2. else the project they last FOCUSED in this browser (`lastFocusedId`);
 *   3. else the project `ntwine` was most recently RUN in, cold or joining (`lastLaunchedAt`, which only
 *      the launcher stamps);
 *   4. else the project opened most recently, which is also the list's own order until someone arranges it.
 *
 * Each step takes only a project that is still registered and whose directory still exists; else none (no
 * usable project — the page then shows the welcome, where one is added).
 *
 * Step 3 exists because from 2026-09-30 every launch landed on All projects at a bare `/` (97fb6c42), so
 * the address did not say where `ntwine` was run; since 2026-10-06 a launch lands on its project's board
 * again, but All projects reached any other way still has only this to go on. Without it a browser with no pick fell to step 4, and `lastOpenedAt`
 * is bumped by any registration — adding a project from the page, a stack registering its tenants after
 * boot — so a launch from `storefront` aimed the box at `billing-api` and a task landed in the wrong repo.
 *
 * `openIds`, when known, narrows every step to projects whose board this server has open: a project another
 * Ntwine serves, or one that failed to open, can be focused but never takes a thread, and landing on it
 * showed a prompt box that never arrived. It only narrows — with none open (a boot still opening them)
 * the page lands as it would without the list.
 */
export function defaultCrossProjectFocus(
  cards: readonly Pick<ProjectCard, "id" | "slug" | "stale" | "lastOpenedAt" | "lastLaunchedAt" | "home">[],
  pickId: string | null,
  openIds?: ReadonlySet<string>,
  lastFocusedId: string | null = null,
): string | undefined {
  const present = cards.filter((card) => !card.stale)
  const open = openIds ? present.filter((card) => openIds.has(card.id)) : present
  const usable = open.length > 0 ? open : present
  for (const id of [pickId, lastFocusedId]) {
    const remembered = id ? usable.find((card) => card.id === id) : undefined
    if (remembered) return remembered.slug
  }
  // The Home workspace is focused only when CHOSEN. It exists on every machine, so falling back to it
  // would mean an empty machine never shows the welcome page that adds its first project — and nobody
  // runs `ntwine` in it, which is what both fallbacks are reading.
  const latest = (stamp: (card: (typeof usable)[number]) => string | undefined) => {
    let best: (typeof usable)[number] | undefined
    for (const card of usable) {
      if (card.home) continue
      const at = Date.parse(stamp(card) || "")
      if (Number.isNaN(at)) continue
      if (!best || at > Date.parse(stamp(best) || "")) best = card
    }
    return best
  }
  const launched = latest((card) => card.lastLaunchedAt)
  if (launched) return launched.slug
  return (latest((card) => card.lastOpenedAt) ?? usable.find((card) => !card.home))?.slug
}

// HOW MUCH OF EACH PROJECT THE LIST SHOWS — the list's own folds, in both views. Two of them (maintainer
// 2026-09-28: "the collapse button associated with each project should actually collapse all threads
// associated with that project, including open threads. There needs to be perhaps a sub button that
// expands or collapses other categories like done or snoozed … But again, we need a primary collapse
// button that would easily allow you to visually filter which projects you're looking at"):
//
//   COLLAPSED — the primary fold: the project is its one row and nothing under it, not even its work in
//               flight. Every project starts open, so this set names the ones folded away.
//   OPEN BANDS — a project's quiet bands, EACH ON ITS OWN: Snoozed, Done and External open and close
//               independently, and every one starts collapsed (upstream's sidebar did the same — each its own
//               collapsible section, collapsed by default). This set names the ones open, as
//               `<projectId>:<band>`. It was one "drill" per project, opening all three at once, until
//               2026-09-29.
//
// Per BROWSER (localStorage), like the rail's own band folds: which projects you keep open is how you
// arrange your desk, not how you are reading one window.

/** A set of ids kept in localStorage, read once and live after that. */
function persistedSet(key: string) {
  let ids: ReadonlySet<string> | null = null
  const listeners = new Set<() => void>()
  const read = (): ReadonlySet<string> => {
    if (!ids) {
      let stored: unknown = []
      try {
        stored = JSON.parse(localStorage.getItem(key) ?? "[]")
      } catch {
        stored = []
      }
      ids = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [])
    }
    return ids
  }
  const write = (next: Set<string>): void => {
    ids = next
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // Storage disabled or full: the list still folds, it just forgets on reload.
    }
    for (const listener of listeners) listener()
  }
  const set = (id: string, on = !read().has(id)): void => {
    const current = read()
    if (current.has(id) === on) return
    const next = new Set(current)
    if (on) next.add(id)
    else next.delete(id)
    write(next)
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { read, set, subscribe }
}

const NONE: ReadonlySet<string> = new Set()
// ---- All projects' tiers -------------------------------------------------------------------------------
//
// THE TIER LIST'S FOLDS (TierList.tsx), per browser like every fold here. A key is present when the human
// FLIPPED that tier from how it starts — Snoozed and Done start folded, the rest open — so a new tier's
// default needs no migration. `run:<projectId>` is a Working rollup the human expanded (lib/sidebarBudget.ts):
// an expanded run is never rolled up again until they fold it.
const tierFolds = persistedSet("ntwine.tierFolds")

/** Flip one tier fold, or set it; `on` means "flipped from its default". */
export function setTierFold(key: string, on?: boolean): void {
  tierFolds.set(key, on)
}

/** The flipped tier folds — live, and a stable Set between changes. */
export function useTierFolds(): ReadonlySet<string> {
  return useSyncExternalStore(tierFolds.subscribe, tierFolds.read, () => NONE)
}
