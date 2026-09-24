import { useSyncExternalStore } from "react"
import type { ProjectCard } from "@frizz/shared"

// THE CROSS-PROJECT PAGE'S FOCUS — which project `/` opens on.
//
// The cross-project page is always focused on one project (`/all/<slug>`): the one its prompt box
// dispatches into and whose thread drawer is open, and the page project for every "which project"
// question (see base-path.ts). `/` names none, so it has to pick one before it can render a prompt box
// at all. It picks the project the operator was last focused on in this browser, and failing that the
// one opened most recently on the machine — which is the project a `frizz` run in a repo has just
// opened, so a fresh launch lands where the operator is standing.
//
// Remembered by ID, not slug: a rename changes the slug, and a remembered slug that no longer resolves
// would quietly fall back to another project.

const FOCUS_KEY = "frizz.crossProjectFocus"

// THE PICK, as opposed to the focus. The focus moves whenever a thread of another project is opened (its
// drawer needs that project bound — see routes.tsx CrossProjectRoute), but the operator did not CHOOSE
// that project for their next thread by reading one of its threads. So the page remembers the last
// project they did choose — with the prompt box's picker, a project's name in the rail, a quiet row —
// and goes back to it when the last drawer closes (AllQueues.tsx useReturnToPick). Without it, reading
// a card of project Y and closing it quietly retargeted a half-written prompt meant for X.
let pick: string | null = null
let loaded = false
const listeners = new Set<() => void>()

/** Navigation state an EXPLICIT choice of project carries, so the route can tell it from a drawer's. */
export const CROSS_PROJECT_PICK_STATE = { crossProjectPick: true } as const

export function isCrossProjectPick(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { crossProjectPick?: unknown }).crossProjectPick === true
}

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

/** The project the operator last CHOSE on the cross-project page, by id — live across the page. */
export function useCrossProjectPick(): string | null {
  return useSyncExternalStore(subscribeCrossProjectFocus, rememberedCrossProjectFocus, () => null)
}

/**
 * The project `/` focuses: the remembered one if it is still registered and its directory still exists,
 * else the most recently opened such project, else none (no usable project — the grid is the only page
 * that can help, since it is where a project is added).
 *
 * `openIds`, when known, narrows that to projects whose board this server has open: a project another
 * Frizz serves, or one that failed to open, can be focused but never takes a thread, and landing on it
 * showed a prompt box that never arrived. It only narrows — with none open (a boot still opening them)
 * the page lands as it would without the list.
 */
export function defaultCrossProjectFocus(
  cards: readonly Pick<ProjectCard, "id" | "slug" | "stale" | "lastOpenedAt">[],
  rememberedId: string | null,
  openIds?: ReadonlySet<string>,
): string | undefined {
  const present = cards.filter((card) => !card.stale)
  const open = openIds ? present.filter((card) => openIds.has(card.id)) : present
  const usable = open.length > 0 ? open : present
  const remembered = rememberedId ? usable.find((card) => card.id === rememberedId) : undefined
  if (remembered) return remembered.slug
  let latest: (typeof usable)[number] | undefined
  for (const card of usable) {
    if (!latest || Date.parse(card.lastOpenedAt || "") > Date.parse(latest.lastOpenedAt || "")) latest = card
  }
  return latest?.slug
}
