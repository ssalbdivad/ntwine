import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@ntwine/shared"
import { threadKey, type QueuesProject } from "./allQueues.ts"

// OPTIMISTIC PIN — the pin and unpin land on the list the instant the operator clicks, the same way a
// reply (lib/steering.ts) and Mark as done (lib/optimisticArchive.ts) already do.
//
// Until 2026-10-01 the row's button only dimmed and waited: setThreadPinned reads the board and
// re-assembles it before it answers, and the row moved when the board push or the poll behind it landed.
// Measured against a quiet live server that was ~200ms from click to the row changing (curl to the same
// RPC: 50–90ms); on a loaded one, where a single poll has taken 25s, it was as long as the server was
// busy — and a disabled button at 50% opacity for that long reads as a click that did not register
// (maintainer: "clicking unpin feels very slow/unresponsive").
//
// Not a second source of truth. Keyed by `threadKey(projectId, slug)`, since the list draws every
// project and two projects can share a slug; dropped when the RPC fails, and capped so a prediction the
// board never confirms cannot outlive its evidence.
const pins = proxy({ by: {} as Record<string, { pinned: boolean; at: number }> })

/** How long a prediction may stand without the board confirming it. */
export const PIN_OPTIMISM_MS = 12_000

const expiries = new Map<string, ReturnType<typeof setTimeout>>()

export function markPinned(projectId: string, slug: string, pinned: boolean, nowMs = Date.now()): void {
  const key = threadKey(projectId, slug)
  pins.by[key] = { pinned, at: nowMs }
  const prior = expiries.get(key)
  if (prior !== undefined) clearTimeout(prior)
  // The cap must REPAINT, not merely elapse (the same reason as optimisticArchive's).
  expiries.set(key, setTimeout(() => {
    expiries.delete(key)
    delete pins.by[key]
  }, PIN_OPTIMISM_MS))
}

/** The RPC failed: the row goes back to what the board says. */
export function clearPinned(projectId: string, slug: string): void {
  const key = threadKey(projectId, slug)
  const prior = expiries.get(key)
  if (prior !== undefined) { clearTimeout(prior); expiries.delete(key) }
  delete pins.by[key]
}

export function usePinOverrides(): Readonly<Record<string, { pinned: boolean; at: number }>> {
  return useSnapshot(pins).by
}

/**
 * Every project's threads with the pins this tab just set or cleared applied to `pinnedAt` — the field
 * every reader keys off (groups.ts isPinned), so the row leaves or joins the pinned band by the list's own
 * banding. Returns the SAME arrays and objects wherever nothing is overridden or the board already agrees,
 * so memoized rows skip the re-render.
 */
export function pinOverlayQueues(
  projects: QueuesProject[],
  overrides: Readonly<Record<string, { pinned: boolean; at: number }>>,
  nowMs = Date.now(),
): QueuesProject[] {
  if (Object.keys(overrides).length === 0) return projects
  let out = projects
  projects.forEach((project, index) => {
    const apply = (list: ThreadView[]) => {
      let next = list
      list.forEach((t, i) => {
        const o = overrides[threadKey(project.id, t.id)]
        if (!o || nowMs - o.at > PIN_OPTIMISM_MS || o.pinned === (typeof t.pinnedAt === "string")) return
        if (next === list) next = [...list]
        next[i] = { ...t, pinnedAt: o.pinned ? new Date(o.at).toISOString() : undefined }
      })
      return next
    }
    const queued = apply(project.queued)
    const running = apply(project.running)
    const snoozed = apply(project.snoozed)
    // A pinned Done row unpins from its hover strip like any other (lib/listBands.ts lists it).
    const pinnedDone = apply(project.pinnedDone)
    if (queued === project.queued && running === project.running && snoozed === project.snoozed && pinnedDone === project.pinnedDone) return
    if (out === projects) out = [...projects]
    out[index] = { ...project, queued, running, snoozed, pinnedDone }
  })
  return out
}
