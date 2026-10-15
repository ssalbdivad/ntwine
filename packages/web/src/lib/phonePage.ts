import { activeBandThread, type ThreadView } from "@ntwine/shared"
import { inWaitingBand, isPinned, isSnoozed, orderByInteraction, orderQueue, queued, sessionIndicatorKind } from "../groups.ts"
import { threadKey, type QueuesProject } from "./allQueues.ts"
import { doneToday, loudBands, restedAt } from "./listBands.ts"

// THE PHONE PAGE'S MODEL — the desktop list's bands (components/TierList.tsx), across the projects the view
// shows, for the phone's one column (components/PhonePage.tsx). Pure, so the banding is tested without a
// browser and the component stays a layout.
//
// It is the desktop list, not a phone's own reading of it (2026-10-14, after All projects first): the same
// six bands in the same order — Pinned, Ready, Working, Waiting, Snoozed, Done today — each banded by the
// list's own `loudBands`, so a phone and a desktop can never disagree about which band a thread is in.
// Until then the phone merged Pinned, Ready, Working and Waiting into one Queue tab, asks first (upstream's
// phone board, 2026-09-30), with Snoozed and Done as tabs beside it.
//
// Ready across projects is ONE queue order (the desktop's `mergedQueue`): one server stamps every
// project's `queuedAt` on one clock, so the stamps compare — and it is the order the desktop's cards stand
// in, which its Ready rows face. Working and Waiting keep each project's rows together in the project
// order, as the desktop's runs do.

export type PhoneBand = "pinned" | "ready" | "working" | "waiting" | "snoozed" | "done"

/** One row of a band: a thread, with the project it belongs to (it may not be the page project's). */
export interface PhoneRow {
  project: QueuesProject
  thread: ThreadView
  /** `threadKey` — a slug is unique only within one project. */
  key: string
}

export type PhoneBands = Record<PhoneBand, PhoneRow[]>

/** What the operator has just done to a project's threads that the poll cannot know yet (listBands.ts listOverlay). */
export type OverlayFor = (project: QueuesProject) => (t: ThreadView) => ThreadView

const noOverlay: OverlayFor = () => (t) => t

/** A row marked "?" — waiting on the human's answer (sessionIndicatorKind's `needs-input`). */
export function isAsk(t: ThreadView): boolean {
  return sessionIndicatorKind(t) === "needs-input"
}

/**
 * EVERY BAND, across `projects`. `hidden` is a card being finished or sent away on the desktop's queue
 * (AllQueues.tsx useLeavingCards): its row moves to Working until the poll catches up, as the list's does.
 */
export function phoneBands(
  projects: readonly QueuesProject[],
  hidden: (key: string) => boolean = () => false,
  overlayFor: OverlayFor = noOverlay,
  now = Date.now(),
): PhoneBands {
  const bands: PhoneBands = { pinned: [], ready: [], working: [], waiting: [], snoozed: [], done: [] }
  const owner = new Map<ThreadView, QueuesProject>()
  const row = (project: QueuesProject) => (thread: ThreadView): PhoneRow => ({ project, thread, key: threadKey(project.id, thread.id) })
  const ready: ThreadView[] = []
  for (const project of projects) {
    const loud = loudBands(project, hidden, overlayFor(project))
    bands.pinned.push(...loud.pinned.map(row(project)))
    for (const t of loud.ready) owner.set(t, project)
    ready.push(...loud.ready)
    bands.working.push(...loud.working.map(row(project)))
    bands.waiting.push(...loud.waiting.map(row(project)))
    bands.snoozed.push(...orderByInteraction(project.snoozed.filter((t) => !isPinned(t) && isSnoozed(t))).map(row(project)))
    bands.done.push(...doneToday(project, now).map(row(project)))
  }
  bands.pinned.sort((a, b) => (a.thread.pinnedAt ?? "").localeCompare(b.thread.pinnedAt ?? "") || a.key.localeCompare(b.key))
  bands.ready = orderQueue(ready).map((t) => row(owner.get(t)!)(t))
  bands.done.sort((a, b) => restedAt(b.thread) - restedAt(a.thread))
  return bands
}

/**
 * The view line's readings: how many rows are marked "?", how many more wait in Ready without one (a
 * handoff, a stall, a limit kill — each waiting on the human all the same), and how many are spinning.
 * Working is counted with the predicate the desktop rail's badge uses, so the two cannot disagree.
 */
export function phoneCounts(bands: Pick<PhoneBands, "pinned" | "ready" | "working">): { asks: number; ready: number; working: number } {
  let asks = 0
  let ready = 0
  let working = 0
  for (const { thread } of [...bands.pinned.filter((r) => r.thread.state !== "archived"), ...bands.ready, ...bands.working]) {
    if (isAsk(thread)) asks += 1
    else if (queued(thread)) ready += 1
    if (activeBandThread(thread) && !inWaitingBand(thread)) working += 1
  }
  return { asks, ready, working }
}

/**
 * THE LINE UNDER THE VIEW'S NAME: `2 need you · 3 ready · 1 working`, the asks in the accent — the bands'
 * own words. "Nothing needs you" is said only when nothing is Ready or working: a queue of four handoffs, or
 * four stalled threads each with a Retry waiting, still needs the human. One ask is "1 needs you".
 */
export function phoneSubtitle(counts: { asks: number; ready: number; working: number }): { accent: string | null; rest: string | null } {
  const accent = counts.asks > 0 ? `${counts.asks} ${counts.asks === 1 ? "needs" : "need"} you` : null
  const parts = [counts.ready > 0 ? `${counts.ready} ready` : null, counts.working > 0 ? `${counts.working} working` : null].filter((part) => part !== null)
  const rest = parts.length > 0 ? parts.join(" · ") : accent ? null : "Nothing needs you"
  return { accent, rest }
}
