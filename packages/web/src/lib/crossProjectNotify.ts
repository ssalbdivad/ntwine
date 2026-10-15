import { useEffect, useRef, useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"
import { queueUrgency, queuedThread, type ProjectQueue, type ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { projectsQueuesQuery } from "./projectsQueuesRead.ts"
import { notify } from "../api/board-stream.ts"
import { store } from "../store.ts"

// DESKTOP NOTIFICATIONS FOR EVERY PROJECT, not only the one the page is bound to.
//
// A `notify` event is published on its PROJECT's bus (server board.ts notifyNeedsYou) and reaches a page
// only over that project's socket. Until 2026-09-28 every project had its own tab, so an operator with
// one tab per project heard from all of them. The one page binds ONE feed (routes.tsx useProjectBinding)
// and reads every other project through the `projectsQueues` poll — which raised nothing, so a thread
// that queued in any project but the focused one queued silently.
//
// This watches that same poll and raises the notification the other project's own tab would have: a
// session thread that newly ENTERS a queue (the server's edge, needsYou false → true, read as queued
// false → true), for every project except the bound one, whose socket already carries its own. Titled and
// bodied as the server titles it, and TAGGED by the thread's own address (`/all/<project>/<slug>`) exactly
// as the socket path tags it — the tag is the browser's replace key, so a second tab, or the socket of a
// tab bound to that project, raising the same thread replaces this notification instead of adding one.
//
// The first read is a baseline, and so is a project's first appearance in a read: a page that opens onto
// a full queue, or a project that has just been opened, is not news.

/** One session thread as the last read saw it: whether it was queued, and the place (`queuedAt`), rest
 *  (`lastAssistantAt`) and urgent reasons (shared queueUrgency) it last held IN the queue — kept after it
 *  leaves, which is what lets a return to the same card be told from a new entry (see queueArrivals). */
export interface QueueSighting {
  queued: boolean
  lastInQueue?: { queuedAt?: string; rest?: string; urgency?: string }
}

/** Each project's SESSION threads by id, as of the last read. */
export type QueueSightings = ReadonlyMap<string, ReadonlyMap<string, QueueSighting>>

export interface QueueArrival {
  project: Pick<ProjectQueue, "projectId" | "projectSlug">
  thread: ThreadView
}


/**
 * The threads that entered a queue since `prev`, and the sightings to compare the next read against.
 * `prev` null is the first read: everything is baseline. A thread that leaves the board and comes back
 * arrives again, as the server forgets a vanished thread so its reappearance re-notifies.
 *
 * EXCEPT ONE THAT COMES BACK TO THE PLACE IT LEFT WITH THE REST IT LEFT WITH (2026-09-30), the server's own
 * rule (board.ts notifyNeedsYou, `resumed`) mirrored here so the two notifiers agree. Nobody acted on the
 * thread (the queue clock gave it its old place back, which only an unbroken claim does) and its worker
 * said nothing new, so a notification would announce a card the human was already told about. A re-entry that
 * comes back with a NEW urgent reason — a permission prompt, a question, a crash it did not leave with —
 * still notifies whatever its place and rest: the queue clock gives the old place back to an urgent entry
 * too, and a Codex approval moves no rest, so "same place, same rest" cannot tell a new blocking ask from
 * nothing happening. The reasons are compared whole (queueUrgency), the server's own rule: a thread resting
 * on a question that keeps that question through a departure must stay as quiet as a plain handoff — the
 * first cut exempted anything urgent, and announced exactly that thread while the server stayed silent.
 */
export function queueArrivals(prev: QueueSightings | null, queues: readonly ProjectQueue[]): { next: Map<string, Map<string, QueueSighting>>; arrivals: QueueArrival[] } {
  const next = new Map<string, Map<string, QueueSighting>>()
  const arrivals: QueueArrival[] = []
  for (const project of queues) {
    const seen = prev?.get(project.projectId)
    const sightings = new Map<string, QueueSighting>()
    next.set(project.projectId, sightings)
    // Sessions and terminal threads: the server notifies for either entering the queue.
    for (const thread of project.threads) {
      if (thread.kind !== "session" && thread.kind !== "terminal") continue
      const queued = queuedThread(thread)
      const before = seen?.get(thread.id)
      const left = before?.lastInQueue
      const urgency = queueUrgency(thread)
      const resumed = left !== undefined && thread.queuedAt !== undefined && left.queuedAt === thread.queuedAt &&
        thread.lastAssistantAt !== undefined && left.rest === thread.lastAssistantAt && left.urgency === urgency
      // A project's first appearance is a baseline, like the first read.
      if (seen && queued && !before?.queued && !resumed) arrivals.push({ project, thread })
      sightings.set(thread.id, { queued, lastInQueue: queued ? { queuedAt: thread.queuedAt, rest: thread.lastAssistantAt, urgency } : left })
    }
  }
  return { next, arrivals }
}

/** The server's cap on a notification's line (board.ts LINE_CAP). */
const LINE_CAP = 240
const capLine = (text: string | undefined): string | undefined =>
  text ? (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP - 1)}…` : text) : undefined

/** The page's poll cadence (AllQueues.tsx POLL_MS). This observer shares its query and cache. */
const POLL_MS = 3_000

/** Whether the tab is hidden, as React state — a hidden tab is the only one `notify` raises in. */
function useTabHidden(): boolean {
  return useSyncExternalStore(
    (changed) => {
      document.addEventListener("visibilitychange", changed)
      return () => document.removeEventListener("visibilitychange", changed)
    },
    () => document.hidden,
  )
}

/**
 * Mounted once, for the whole app. Shares the `projectsQueues` query the page draws from, and keeps it
 * polling while the tab is HIDDEN when notifications are on — react-query pauses an interval in a hidden
 * tab by default, and a hidden tab is the only one a notification is ever raised in.
 *
 * ONLY while hidden. Notifications are on by default, and this observer polled every project every 3s
 * in a VISIBLE tab too, where `notify` raises nothing — so on a project's own board, which reads the
 * other projects only every 30s (AllQueues.tsx OTHER_PROJECTS_POLL_MS), the all-projects poll kept its
 * full cadence through this one observer (P12, plans/upstream-superset.md §2; found 2026-10-06 by
 * counting the requests). While the tab is visible the page's own poll feeds the cache this reads, so the
 * sightings stay current; the moment it is hidden this takes over at the page's cadence.
 */
export function useCrossProjectNotifications(enabled: boolean): void {
  const hidden = useTabHidden()
  const queues = useQuery({
    ...projectsQueuesQuery,
    refetchInterval: hidden ? POLL_MS : false,
    refetchIntervalInBackground: enabled,
    enabled,
  })
  const sightings = useRef<QueueSightings | null>(null)
  useEffect(() => {
    if (!queues.data) return
    const { next, arrivals } = queueArrivals(sightings.current, queues.data)
    sightings.current = next
    // The bound project's arrivals come over its socket (api/board-stream.ts), already tagged the same.
    const bound = store.board?.projectSlug
    for (const { project, thread } of arrivals) {
      if (project.projectSlug === bound) continue
      notify(
        { type: "notify", slug: thread.id, kind: "needs-decision", title: thread.aiTitle || thread.title || thread.id, body: capLine(thread.lastAssistant) },
        project.projectSlug,
      )
    }
  }, [queues.data])
}
