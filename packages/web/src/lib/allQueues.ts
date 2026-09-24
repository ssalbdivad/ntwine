import type { BoardSnapshot, ProjectCard, ProjectQueue, RegisteredQuestionView, ThreadView } from "@frizz/shared"
import { orderByInteraction, orderQueue, queued, sectionOf, type QueueDirection } from "../groups.ts"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { splitQuestionBlocks, type QuestionKind } from "./questionBlocks.ts"
import { fenceStandsFor } from "./questionShadow.ts"

// THE ALL QUEUES PAGE'S MODEL — every project on the machine, each with its threads already banded.
//
// Two reads meet here and neither is enough alone: `projectsList` is every REGISTERED project in the
// operator's own rail order (and carries the icon), `projectsQueues` is every project with a board OPEN
// on this server (and carries the threads). A registered project with no open board is still drawn —
// quiet, and saying why — rather than silently missing from a page that promises all of them.
//
// Banding is the rail's own, from groups.ts, so this page and a project's sidebar can never disagree
// about which band a thread is in: the queue is `queued` in the `orderQueue` order the project's cue uses
// (a pinned thread that needs you is in it, exactly as its queue card is on its own board), Running is the
// Active band minus the queue, Snoozed is the Snoozed band.

export interface QueuesProject {
  id: string
  slug: string
  name: string
  card: ProjectCard | undefined
  /** A board is open for it on this server. False: its directory is gone, another Frizz serves it, it
   *  failed to open, or the server has not reached it yet this boot. */
  open: boolean
  stale: boolean
  projectDir: string | undefined
  homeDir: string | undefined
  githubRepo: string | undefined
  queued: ThreadView[]
  running: ThreadView[]
  snoozed: ThreadView[]
  doneCount: number
}

export function queuesProjects(
  cards: readonly ProjectCard[] | undefined,
  queues: readonly ProjectQueue[] | undefined,
  direction: QueueDirection = "fifo",
): QueuesProject[] {
  const byId = new Map((queues ?? []).map((queue) => [queue.projectId, queue]))
  const out: QueuesProject[] = []
  const build = (card: ProjectCard | undefined, queue: ProjectQueue | undefined): QueuesProject => {
    const threads = queue?.threads ?? []
    return {
      id: card?.id ?? queue!.projectId,
      // The CARD's slug and name when there is one: the registry is what every other link on the machine
      // was minted from, so a project renamed a moment ago agrees with its own rail square.
      slug: card?.slug ?? queue!.projectSlug,
      name: card?.name ?? queue!.projectName,
      card,
      open: queue !== undefined,
      stale: card?.stale ?? false,
      projectDir: queue?.projectDir,
      homeDir: queue?.homeDir,
      githubRepo: queue?.githubRepo,
      queued: orderQueue(threads.filter(queued), direction),
      running: orderByInteraction(threads.filter((t) => !queued(t) && sectionOf(t) === "active")),
      snoozed: orderByInteraction(threads.filter((t) => !queued(t) && sectionOf(t) === "snoozed")),
      // The server counts archived rows itself; any that still arrive (an older server) are Done too.
      doneCount: (queue?.doneCount ?? 0) + threads.filter((t) => sectionOf(t) === "inactive").length,
    }
  }
  for (const card of cards ?? []) {
    out.push(build(card, byId.get(card.id)))
    byId.delete(card.id)
  }
  // Open but not (yet) in the list the page holds — registered a moment ago, before the list refetched.
  // Drawn last rather than dropped: its threads are real, and they are addressable by id.
  for (const queue of byId.values()) out.push(build(undefined, queue))
  return out
}

/**
 * The FOCUSED project's queue, drawn from its live board instead of the poll.
 *
 * The page polls every project every few seconds, but the focused one is also the page project, so its
 * board is already live in the store — and it is the project the operator is acting on: the one whose
 * drawer they just marked done, the one their prompt box just dispatched into. Drawing it from the poll
 * left a finished card standing, or a new thread missing from Running, for up to a poll after the act.
 *
 * Only when the store's board is PROVABLY the focused project's (its own `projectSlug` says so): during a
 * focus change the store is cleared and refilled, and a board that is not yet the new focus must not be
 * drawn under its name. The rows are filtered as the server filters them for the poll (sessions and
 * terminal commands of this project, nothing foreign); Done is left to the rail's own banding, which
 * counts what it files there, so the server's Done count is dropped rather than added to.
 */
export function liveQueue(
  queues: readonly ProjectQueue[] | undefined,
  board: Pick<BoardSnapshot, "projectSlug" | "threads"> | null,
  focusSlug: string | undefined,
): ProjectQueue | undefined {
  if (!queues || !board || !focusSlug || board.projectSlug !== focusSlug) return undefined
  const polled = queues.find((queue) => queue.projectSlug === focusSlug)
  if (!polled) return undefined
  const threads = board.threads.filter((thread) => (thread.kind === "session" || thread.kind === "command") && !thread.foreign)
  return { ...polled, threads, doneCount: 0 }
}

/**
 * `projects` with the given queues rebuilt in place. Every other project keeps its IDENTITY, so a live
 * board ticking — which it does on every delta — re-derives one project, not the page.
 */
export function overlayQueues(
  projects: QueuesProject[],
  overlays: readonly (ProjectQueue | undefined)[],
  direction: QueueDirection = "fifo",
): QueuesProject[] {
  let out = projects
  for (const queue of overlays) {
    if (!queue) continue
    const index = out.findIndex((project) => project.id === queue.projectId)
    if (index < 0) continue
    const card = out[index]!.card
    const [rebuilt] = queuesProjects(card ? [card] : [], [queue], direction)
    if (out === projects) out = [...projects]
    out[index] = rebuilt!
  }
  return out
}

/**
 * Anything to show beyond a name: a queue, or live work. Parked work does not count — a project whose only
 * threads are snoozed is waiting on nobody, and its board is where they are kept.
 */
export function isBusy(project: QueuesProject): boolean {
  return project.queued.length + project.running.length > 0
}

/**
 * A thread's identity on a page showing several projects. A slug is unique only WITHIN a project, so a
 * bare one is ambiguous here — two projects can both have a `fix-auth` — and every key, DOM anchor and
 * optimistic record on the page goes through this instead.
 */
export function threadKey(projectId: string, slug: string): string {
  return `${projectId}/${slug}`
}

export interface HandoffParts {
  prose: string
  /** ```question fences with a body that no registered card draws — drawn read-only. */
  questions: { raw: string; questionKind: QuestionKind; danger: boolean }[]
  fences: { kind: "done" | "awaiting"; body: string }[]
}

/**
 * A handoff, split the way the board's card draws it: the prose, the ```question fences, and each
 * ```done / ```awaiting fence as its own card.
 *
 * A ```question fence goes one of three ways. An EMPTY `qst_…` marker only PLACES a registered card, and
 * this card draws every open question at its tail, so the marker is dropped (left in, it renders as an
 * empty code block mid-prose). A fence that STANDS FOR a registered question — names its id, or restates
 * it — is dropped for the same reason: its registered card is the one that can be answered. Anything else
 * is a question the worker wrote as a fence, which on a legacy thread is its live ask, so it is KEPT, and
 * drawn read-only — answering it is one level down, on the thread's own board.
 */
export function handoffParts(text: string, registered: readonly Pick<RegisteredQuestionView, "id" | "spec">[] = []): HandoffParts {
  const questions: HandoffParts["questions"] = []
  let unquestioned = text
  if (text.includes("```question")) {
    const prose: string[] = []
    for (const seg of splitQuestionBlocks(text)) {
      if (seg.kind === "prose") prose.push(seg.text)
      else if (seg.text.trim() && !fenceStandsFor(seg, registered)) questions.push({ raw: seg.text, questionKind: seg.questionKind, danger: seg.danger })
    }
    unquestioned = prose.join("\n")
  }
  let prose = ""
  const fences: HandoffParts["fences"] = []
  for (const segment of splitFenceBlocks(unquestioned)) {
    if (segment.kind === "prose") prose += segment.text
    else fences.push({ kind: segment.fenceKind, body: segment.body })
  }
  return { prose: prose.trim(), questions, fences }
}
