import type { ProjectCard, ProjectQueue, RegisteredQuestionView, ThreadView } from "@frizz/shared"
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

/** Anything to show beyond a name: a queue, live work, or a snoozed thread. */
export function isBusy(project: QueuesProject): boolean {
  return project.queued.length + project.running.length + project.snoozed.length > 0
}

export function queuesTotals(projects: readonly QueuesProject[]): { queued: number; running: number; projectsWithQueue: number } {
  let queuedTotal = 0
  let running = 0
  let projectsWithQueue = 0
  for (const project of projects) {
    queuedTotal += project.queued.length
    running += project.running.length
    if (project.queued.length > 0) projectsWithQueue++
  }
  return { queued: queuedTotal, running, projectsWithQueue }
}

/**
 * A thread's identity on a page showing several projects. A slug is unique only WITHIN a project, so a
 * bare one is ambiguous here — two projects can both have a `fix-auth` — and every key, DOM anchor and
 * optimistic record on the page goes through this instead.
 */
export function threadKey(projectId: string, slug: string): string {
  return `${projectId}/${slug}`
}

/** "3 in the queue · 1 running" — the lane's count line, in the board's own words for its bands. */
export function laneSummary(project: Pick<QueuesProject, "queued" | "running" | "snoozed">): string {
  const parts: string[] = []
  if (project.queued.length > 0) parts.push(`${project.queued.length} in the queue`)
  if (project.running.length > 0) parts.push(`${project.running.length} running`)
  if (project.snoozed.length > 0) parts.push(`${project.snoozed.length} snoozed`)
  return parts.join(" · ")
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
