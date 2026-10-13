import type { ProjectQueue } from "@ntwine/shared"
import { queryOptions, replaceEqualDeep } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"

// THE ONE READ of every project's queue, shared by every `["projectsQueues"]` query so the cache entry
// always says when the read it holds STARTED. react-query's `dataUpdatedAt` is when a read LANDED, and on
// a loaded server the two are far apart: one poll took 25s while workers were starting. A read that
// started before Mark as done reached the server and landed after it describes the queue BEFORE the done,
// however new its arrival stamp — and the page brought the card back on it, for as long as the next read
// took (David 2026-09-30: "I mark a thread as done and it suddenly pops back up … it reopened for a
// long time"). Only a read that started after an action was acknowledged can speak to that action.
const startedAt = new WeakMap<readonly ProjectQueue[], number>()

export async function readProjectsQueues(): Promise<ProjectQueue[]> {
  const at = Date.now()
  const queues = await rpc.projectsQueues()
  startedAt.set(queues, at)
  return queues
}

/** When the read that produced `queues` started; undefined for data that did not come through it. */
export function readStartedAt(queues: readonly ProjectQueue[] | undefined): number | undefined {
  return queues && startedAt.get(queues)
}

/**
 * react-query's STRUCTURAL SHARING, carrying the read's start across it. The cache never holds the array
 * a read returned: it holds `replaceEqualDeep(previous, next)` — the PREVIOUS array when nothing changed,
 * and a fresh copy when anything did. Neither is the array `readProjectsQueues` stamped, so from the
 * second read that changed anything on, `readStartedAt(queues.data)` answered undefined, for good. Both
 * of its readers then waited forever for a read they could never see (AllQueues.tsx): a project's queue
 * the page left — a drawer opened in place on another project's thread, then closed — stayed frozen at
 * that moment (useDepartedQueue), so a thread woken from anywhere else never drew its card again until a
 * reload (found 2026-10-06 by scripts/verify-all-queues.mjs, on main too); and a card acted on whose
 * thread stayed queued stayed hidden instead of coming back after REAPPEAR_MS (useLeavingCards). The
 * shared result is stamped with the read that produced it. When nothing changed that is the previous
 * array, re-stamped with the newer start, which is right: the cache now holds what a read that started
 * then saw.
 */
function shareRead(previous: unknown, next: unknown): unknown {
  const shared = replaceEqualDeep(previous, next)
  const at = startedAt.get(next as readonly ProjectQueue[])
  if (at !== undefined && shared !== null && typeof shared === "object") startedAt.set(shared as readonly ProjectQueue[], at)
  return shared
}

/**
 * The options every `["projectsQueues"]` observer and fetch spreads, so the cache entry is always written
 * through `shareRead`. react-query takes the structural-sharing function from whichever observer's fetch
 * lands, so one site left on the default would drop the stamp again for everyone.
 */
export const projectsQueuesQuery = queryOptions({
  queryKey: ["projectsQueues"],
  queryFn: readProjectsQueues,
  structuralSharing: shareRead,
})
