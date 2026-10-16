import type { ThreadView } from "@ntwine/shared"
import { inWaitingBand, isPinned, orderByInteraction, queued, sectionOf } from "../groups.ts"
import { threadKey, type QueuesProject } from "./allQueues.ts"
import { optimisticallyArchived } from "./optimisticArchive.ts"
import { optimisticallySteered } from "./steering.ts"
import { timeBreakLabel } from "./timeBreaks.ts"

// THE LIST'S LOUD BANDS — a project's work in flight, as the tier list lists it (components/TierList.tsx).
// Pure, so the banding and the optimism over it are tested without a component around them.

export interface LoudBands {
  /** Every pinned thread, whatever its state: the pin is the human's shelf, and it outranks Done — a
   *  pinned Done thread is listed here, greyed by its row (Sidebar.tsx ThreadRow), from the poll's own
   *  `pinnedDone` rather than only once the project's board has been read. */
  pinned: ThreadView[]
  ready: ThreadView[]
  working: ThreadView[]
  /** At rest on something outside the thread (shared inWaitingBand), under Working and never folded. */
  waiting: ThreadView[]
  /** The threads whose card is in the queue — a Ready row, or a pinned one that is Ready — which the cord
   *  across the gutter ties to that card (ThreadConnector). */
  carded: ReadonlySet<string>
  rows: number
}

/**
 * What the operator has just done to a project's threads that the poll cannot know yet, as one overlay
 * for its rows. The page project's drawer files its records by bare slug; a card or a row files them under
 * the thread's key, whatever the project (lib/steering.ts markSteeredIn) — so a bare slug is read for the
 * page project alone, where it cannot name another project's thread of the same name. Done is only ever
 * predicted from the drawer (a card's Mark as done takes its row with the card), so it is the page's alone.
 */
export function listOverlay(
  projectId: string,
  onPage: boolean,
  steeredAt: Readonly<Record<string, number>>,
  archivingAt: Readonly<Record<string, number>>,
  nowMs = Date.now(),
): (t: ThreadView) => ThreadView {
  return (t) => {
    const keyed = steeredAt[threadKey(projectId, t.id)]
    const bare = onPage ? steeredAt[t.id] : undefined
    const steered = optimisticallySteered(t, keyed === undefined || (bare !== undefined && bare > keyed) ? bare : keyed, nowMs)
    return onPage ? optimisticallyArchived(steered, archivingAt[t.id], nowMs) : steered
  }
}

/**
 * A project's work in flight, as its rail banded it: Pinned first (the pin diverts a thread out of every
 * other band, groups.ts sectionThreads), then Ready in queue order, then Working, then Waiting. A Ready card being
 * finished (`hidden`) moves its row to Working until the poll catches up — never off the list; one open
 * in a drawer keeps its row, marked open.
 *
 * `overlay` is what the operator has just done that the poll cannot know yet (lib/steering.ts,
 * lib/optimisticArchive.ts): a reply, an answer or a Retry sets the thread to work, so its row leaves
 * Ready for Working the moment it is sent — the rail did this until 2026-09-28, and the list replacing it
 * showed the row vanish with its card and come back under Working a poll later. The bands are re-derived
 * from the overlaid threads by the rail's own predicates, so the row lands where the server will put it.
 */
export function loudBands(project: QueuesProject, hidden: (key: string) => boolean, overlay: (t: ThreadView) => ThreadView = (t) => t): LoudBands {
  // Pins from EVERY list the poll carries, Done included: read from the open ones alone, a pinned thread
  // that was Done in any project but the page's had no row anywhere on All projects (the pinned-Done hole,
  // plans/upstream-superset.md §2) — invisible exactly where the pin promised it would stay in view.
  const pinned = [...project.queued, ...project.running, ...project.snoozed, ...project.pinnedDone].filter(isPinned).map(overlay)
  pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  const flight = [...project.queued, ...project.running].filter((t) => !isPinned(t)).map(overlay)
  const ready = flight.filter((t) => queued(t) && !hidden(threadKey(project.id, t.id)))
  // NO OPEN THREAD IS EVER ROWLESS (David 2026-10-06: "it should never be the case that a thread
  // should be totally invisible for any circumstances"). A Ready card the operator just acted on is hidden
  // until the server agrees, and its row used to leave with it — so a card whose hide outlived the act
  // (a permission approved on a resting thread's card left @3-0 queued server-side, cardless and rowless)
  // took the thread off the list entirely. The row waits under Working instead: the human's act is in
  // flight, which is what that band says, and the next poll puts it wherever the server does.
  const out = flight.filter((t) => (queued(t) ? hidden(threadKey(project.id, t.id)) : sectionOf(t) === "active"))
  const working = orderByInteraction(out.filter((t) => queued(t) || !inWaitingBand(t)))
  const waiting = orderByInteraction(out.filter((t) => !queued(t) && inWaitingBand(t)))
  const carded = new Set([...pinned.filter(queued), ...ready].map((t) => t.id))
  return { pinned, ready, working, waiting, carded, rows: pinned.length + ready.length + working.length + waiting.length }
}

/** Where Done today starts: the local midnight before `now`. */
export function startOfToday(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** When a Done thread came to rest — the instant the server orders `recentDone` by (router.ts). */
export function restedAt(t: ThreadView): number {
  return Date.parse(t.lastAssistantAt ?? t.lastActivityAt ?? t.spawnedAt ?? "") || 0
}

/** A project's Done today: the poll's `recentDone` that rested since local midnight, pins aside (a pinned
 *  Done thread is the Pinned band's). The tier list's tail and the phone's Done today both read this. */
export function doneToday(project: QueuesProject, now: number): ThreadView[] {
  const today = startOfToday(now)
  return project.recentDone.filter((t) => !isPinned(t) && restedAt(t) >= today)
}


/** How many days the Done tier names before the rest are Older: today and the six before it, a weekday each. */
export const DONE_DAYS = 7
/** Opened by default, newest first, until this many rows are open: a short today brings yesterday with it. */
export const DONE_OPEN_ROWS = 5

export interface DoneDay<T> {
  /** The local day (`Date#toDateString`), or `"older"`. */
  key: string
  /** Today, Yesterday, a weekday, or Older — History's own day names (lib/timeBreaks.ts). */
  label: string
  rows: T[]
}

/**
 * THE DONE TIER'S DAYS (maintainer 2026-10-16: "display each recent day but they're collapsible … an older at
 * the bottom"). `rows` newest rest first; each of the last `DONE_DAYS` local days that finished anything is
 * a group, and everything before them is one Older group at the end.
 */
export function doneDays<T>(rows: readonly T[], thread: (row: T) => ThreadView, now: number): DoneDay<T>[] {
  const first = doneDaysStart(now)
  const days: DoneDay<T>[] = []
  const older: T[] = []
  for (const row of rows) {
    const at = restedAt(thread(row))
    if (at < first) {
      older.push(row)
      continue
    }
    const key = new Date(at).toDateString()
    const last = days.at(-1)
    if (last?.key === key) last.rows.push(row)
    else days.push({ key, label: timeBreakLabel(new Date(at).toISOString(), "day", new Date(now)).day ?? key, rows: [row] })
  }
  if (older.length > 0) days.push({ key: "older", label: "Older", rows: older })
  return days
}

/** Where the Done tier's named days start: local midnight `DONE_DAYS - 1` days back. Older is before it. */
export function doneDaysStart(now: number): number {
  const first = new Date(startOfToday(now))
  first.setDate(first.getDate() - (DONE_DAYS - 1))
  return first.getTime()
}

/** The days open before the human folds any: the newest, and the next ones while fewer than
 *  `DONE_OPEN_ROWS` rows are open. Older never opens by itself. */
export function doneOpenByDefault(days: readonly DoneDay<unknown>[]): Set<string> {
  const open = new Set<string>()
  let rows = 0
  for (const day of days) {
    if (day.key === "older" || (open.size > 0 && rows >= DONE_OPEN_ROWS)) break
    open.add(day.key)
    rows += day.rows.length
  }
  return open
}
