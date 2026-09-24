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

export function rememberCrossProjectFocus(projectId: string): void {
  try {
    localStorage.setItem(FOCUS_KEY, projectId)
  } catch {
    // Storage disabled or full: the page still works, it just forgets where it was.
  }
}

export function rememberedCrossProjectFocus(): string | null {
  try {
    return localStorage.getItem(FOCUS_KEY)
  } catch {
    return null
  }
}

/**
 * The project `/` focuses: the remembered one if it is still registered and its directory still exists,
 * else the most recently opened such project, else none (no usable project — the grid is the only page
 * that can help, since it is where a project is added).
 */
export function defaultCrossProjectFocus(
  cards: readonly Pick<ProjectCard, "id" | "slug" | "stale" | "lastOpenedAt">[],
  rememberedId: string | null,
): string | undefined {
  const usable = cards.filter((card) => !card.stale)
  const remembered = rememberedId ? usable.find((card) => card.id === rememberedId) : undefined
  if (remembered) return remembered.slug
  let latest: (typeof usable)[number] | undefined
  for (const card of usable) {
    if (!latest || Date.parse(card.lastOpenedAt || "") > Date.parse(latest.lastOpenedAt || "")) latest = card
  }
  return latest?.slug
}
