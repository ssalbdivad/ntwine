import { projectSlug } from "./base-path.ts"

// DATA CARRIES ITS PROJECT, AND WE CHECK IT AT THE DOOR.
//
// One Ntwine serves every project on the machine from one origin, and the client switches between them
// WITHOUT a document load. So at any moment there may be a response, a socket frame or a seed in flight
// that was asked for by the project you just left. Nothing about such a payload looks wrong — a board is
// a board, and thread slugs are only unique WITHIN a project — so it lands, renders, and the operator is
// looking at another project's work under this project's URL. That is not a hypothetical: it shipped
// (2026-08-11, `/project/ntwine` rendering the zod board, fixed in `0fb8574`), and the two mechanisms that
// were supposed to prevent it — re-deriving `apiBase()` per call, and re-binding on switch — are both
// bookkeeping. Bookkeeping is exactly what failed.
//
// This is the complement to bookkeeping: the SERVER stamps a board with the project it came from
// (`BoardSnapshot.projectSlug`), so the client can refuse anything that does not belong here on the
// payload's OWN evidence, without trusting any of its own state. Cheap, and it holds no matter which
// path the data took to get here.

/**
 * Does a payload stamped with project `owner` belong on the page at `pathname`?
 *
 * Deliberately permissive in exactly two cases, because refusing on a guess is worse than the stale
 * frame this exists to catch:
 *
 *   · THE PAGE NAMES NO PROJECT. `/thread/<x>/full` with no `/all/<slug>` in front of it is the
 *     launching project — a supported inbound shape (see base-path.ts) whose slug the client cannot
 *     know without a board, which is the very thing being checked. Unverifiable, so accepted.
 *   · THE PAYLOAD NAMES NO PROJECT. A pre-restart server omits `projectSlug`; so does every hand-built
 *     board in a test or fixture. Silence is not evidence of a mismatch.
 */
export function ownedByThisPage(owner: string | null | undefined, pathname?: string): boolean {
  const here = projectSlug(pathname)
  if (here === undefined) return true
  if (owner === null || owner === undefined) return true
  return owner === here
}
