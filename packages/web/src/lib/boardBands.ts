import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { externalThreads, isPinned, orderByInteraction, sectionThreads } from "../groups.ts"
import type { QueuesProject } from "./allQueues.ts"
import { loudBands, type LoudBands } from "./listBands.ts"

// A PROJECT BOARD'S BANDS — what components/ProjectBoard.tsx lists under each header, from the poll (the
// work in flight, the same reading the queue's cards come from) and the project's board (what the poll
// does not carry: Done, External, a Done thread still pinned). Pure, so the banding is tested without a
// component around it.

export interface BoardBands {
  /** The shelf: every pinned thread whatever its state, OLDEST PIN FIRST — an arrangement the human made,
   *  which nothing the threads do may reorder (groups.ts sectionThreads). */
  pinned: ThreadView[]
  ready: ThreadView[]
  working: ThreadView[]
  snoozed: ThreadView[]
  /** Undefined until the board has been read — the poll knows the count (`doneCount`), not the rows. */
  done: ThreadView[] | undefined
  /** The project's own `claude`/`codex` terminals, most recently touched first. Empty until the board is read. */
  external: ThreadView[]
  /** The threads whose card is in the queue, which the cord ties to it (lib/listBands.ts). */
  carded: LoudBands["carded"]
}

export function boardBands(
  project: QueuesProject,
  board: BoardSnapshot | null | undefined,
  hidden: (key: string) => boolean,
  overlay?: (t: ThreadView) => ThreadView,
): BoardBands {
  const loud = loudBands(project, hidden, overlay)
  const snoozed = orderByInteraction(project.snoozed.filter((t) => !isPinned(t)))
  if (!board) return { pinned: loud.pinned, ready: loud.ready, working: loud.working, snoozed, done: undefined, external: [], carded: loud.carded }
  const sections = sectionThreads(board.threads)
  // A Done pin the board knows and the poll does not yet (`pinnedDone` rides the poll since 2026-10-06, a
  // beat behind the live board) joins the shelf; one both carry is drawn once.
  const pinnedDone = sections.pinned.filter((t) => t.state === "archived" && !loud.pinned.some((p) => p.id === t.id))
  const pinned = [...loud.pinned, ...pinnedDone].sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  return {
    pinned,
    ready: loud.ready,
    working: loud.working,
    snoozed,
    done: sections.inactive,
    external: orderByInteraction(externalThreads(board.threads)),
    carded: loud.carded,
  }
}
