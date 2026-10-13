import type { Bus } from "./bus.ts"
import { onRegistryWrite } from "./project-registry.ts"

// TELL EVERY OPEN TAB THAT THE PROJECT LIST CHANGED.
//
// The rail and the grid draw ONE machine-wide list (`projectsList`), and a tab re-read it only after a
// change it had made itself. Dragging a square to a new slot in one tab therefore left every other tab
// on the old order until somebody reloaded it — and the same went for a rename, a new icon, and a
// project added or forgotten, which are the same list.
//
// The server is the only party that knows a write happened, and it already holds a live stream to
// every tab, so it says so there: a payload-free `projects-changed` on EVERY open project's bus,
// because a tab is subscribed to the board it is showing and the list is the same on all of them. The
// client answers by re-reading the list (web: api/board-stream.ts), which is one registry-file read.

/**
 * Publish `projects-changed` to every bus `buses()` names, after each write to `registryPath`.
 *
 * ONE EVENT PER TICK, not per write: a rename that also moves the directory writes the registry twice
 * inside one handler, and two announcements would be two refetches of the same answer. Deferring to a
 * microtask also puts the announcement after the mutation that caused it has finished its synchronous
 * work, so a tab that re-reads on it never reads a half-applied change.
 *
 * Returns the stop function.
 */
export function announceProjectListChanges(options: {
  /** The registry file this server lists its projects from. A write to any other is not its news. */
  registryPath: string
  /** Every open project's bus, read when the announcement goes out rather than when it was armed. */
  buses: () => Iterable<Pick<Bus, "publish">>
}): () => void {
  let queued = false
  let stopped = false
  const unsubscribe = onRegistryWrite((path) => {
    if (path !== options.registryPath || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (stopped) return
      for (const bus of options.buses()) bus.publish({ type: "projects-changed" })
    })
  })
  return () => {
    stopped = true
    unsubscribe()
  }
}
