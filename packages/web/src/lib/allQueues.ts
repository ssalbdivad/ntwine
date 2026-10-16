import type { AwaitingHint, BoardSnapshot, ProjectCard, ProjectQueue, ProjectSchedules, RegisteredQuestionView, ThreadView } from "@ntwine/shared"
import { isPinned, orderByInteraction, orderQueue, queued, sectionOf } from "../groups.ts"
import { crossProjectHref } from "./base-path.ts"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { splitQuestionBlocks, type QuestionKind } from "./questionBlocks.ts"
import { fenceStandsFor } from "./questionShadow.ts"
import type { MarkdownScope } from "./useMarkdown.ts"

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
  /** A board is open for it on this server. False: its directory is gone, another ntwine serves it, it
   *  failed to open, or the server has not reached it yet this boot. */
  open: boolean
  stale: boolean
  projectDir: string | undefined
  homeDir: string | undefined
  githubRepo: string | undefined
  queued: ThreadView[]
  running: ThreadView[]
  snoozed: ThreadView[]
  /** Its PINNED Done threads, oldest pin first: the pin outranks Done, so they row under Pinned, greyed,
   *  like the project's own board files them (groups.ts sectionThreads) — and are not in `doneCount`. */
  pinnedDone: ThreadView[]
  doneCount: number
  /** Its most recently rested Done threads, newest first, capped by the server (router.ts
   *  RECENT_DONE_THREADS) — the sidebar's Done-today tail (TierList.tsx). Pinned ones included; the
   *  tail leaves them to the Pinned band. */
  recentDone: ThreadView[]
  /** Its schedules' count, and whether one wants the human (paused by ntwine, or a proposal to turn on) —
   *  the row's fourth quiet count. Absent when it has none. */
  schedules?: ProjectSchedules
}

/**
 * Whether two readings of a project name the same project the same way — everything about it EXCEPT its
 * thread lists and counts. The poll rebuilds every project on every tick, and the focus's live board
 * rebuilds its project on every delta, so the object is new while nothing a card reads from it moved.
 * A card compares its project with this rather than by identity (AllQueuesCard.tsx sameCard): by
 * identity, every card of a project re-rendered whenever any of its threads changed — eight renders per
 * card for one drawer opening, measured 2026-09-28.
 */
export function sameProjectAddress(a: QueuesProject, b: QueuesProject): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.slug === b.slug &&
      a.name === b.name &&
      a.card === b.card &&
      a.open === b.open &&
      a.stale === b.stale &&
      a.projectDir === b.projectDir &&
      a.homeDir === b.homeDir &&
      a.githubRepo === b.githubRepo)
  )
}

/**
 * Whose prose a project's cards are (MarkdownScopeContext): the repo a `#123` links into, the root a
 * relative path resolves against, the page a thread link opens on, and whose gate reads a cited file.
 * One construction for the lane that renders the cards and for the link scope that carries a file from
 * a card into a reader or the picture viewer, so the two cannot name different projects.
 */
export function projectMarkdownScope(project: Pick<QueuesProject, "id" | "slug" | "githubRepo" | "projectDir" | "homeDir">): MarkdownScope {
  return {
    projectId: project.id,
    repo: project.githubRepo ?? null,
    appPath: crossProjectHref(encodeURIComponent(project.slug)),
    // Whose threads an `@handle` in this card's prose names: linked from the page's board only when the
    // page is showing this project (lib/mentionAutolink.ts withMentionProject).
    projectSlug: project.slug,
    baseDir: project.projectDir,
    homeDir: project.homeDir,
  }
}

const NO_CARD = {} as ProjectCard
const NO_QUEUE = {} as ProjectQueue
const buildMemo = new WeakMap<ProjectCard, WeakMap<ProjectQueue, QueuesProject>>()

export function queuesProjects(
  cards: readonly ProjectCard[] | undefined,
  queues: readonly ProjectQueue[] | undefined,
): QueuesProject[] {
  const byId = new Map((queues ?? []).map((queue) => [queue.projectId, queue]))
  const out: QueuesProject[] = []
  const build = (card: ProjectCard | undefined, queue: ProjectQueue | undefined): QueuesProject => {
    // SAME INPUTS, SAME OBJECT. The poll's cache shares every project the server answered unchanged
    // (react-query's structural sharing), and handing that on as the same QueuesProject is what lets the
    // list keep its per-project row scopes (TierList.tsx useRowScopes) and memoized rows (Sidebar.tsx
    // ThreadRow). Rebuilt fresh, every 3s poll re-rendered every project's group whenever ANY one of them
    // had changed — ~85ms of main thread per
    // poll on an 8-project dev page (measured 2026-10-01 with react-scan).
    const memo = buildMemo.get(card ?? NO_CARD)?.get(queue ?? NO_QUEUE)
    if (memo) return memo
    const project = buildProject(card, queue)
    let byQueue = buildMemo.get(card ?? NO_CARD)
    if (!byQueue) buildMemo.set(card ?? NO_CARD, (byQueue = new WeakMap()))
    byQueue.set(queue ?? NO_QUEUE, project)
    return project
  }
  const buildProject = (card: ProjectCard | undefined, queue: ProjectQueue | undefined): QueuesProject => {
    const threads = queue?.threads ?? []
    return {
      id: card?.id ?? queue!.projectId,
      // The CARD's slug and name when there is one: the registry is what every other link on the machine
      // was minted from, so a project renamed a moment ago agrees with itself everywhere it is drawn.
      slug: card?.slug ?? queue!.projectSlug,
      name: card?.name ?? queue!.projectName,
      card,
      open: queue !== undefined,
      stale: card?.stale ?? false,
      projectDir: queue?.projectDir,
      homeDir: queue?.homeDir,
      githubRepo: queue?.githubRepo,
      queued: orderQueue(threads.filter(queued)),
      running: orderByInteraction(threads.filter((t) => !queued(t) && sectionOf(t) === "active")),
      snoozed: orderByInteraction(threads.filter((t) => !queued(t) && sectionOf(t) === "snoozed")),
      // THE PINNED-DONE HOLE, closed on both of the reads that reach here. The poll sends a pinned Done
      // thread whole, apart from its Done count (server router.ts `projectsQueues`); the focused project's
      // live board (`liveQueue`) sends every thread, archived ones included. Either way it is a Pinned
      // row, never a number in Done — read off the threads alone, it was counted as Done and drawn nowhere.
      pinnedDone: [...(queue?.pinnedDone ?? []), ...threads.filter((t) => isPinned(t) && sectionOf(t) === "inactive")]
        .sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id)),
      // The server counts archived rows itself; any that still arrive (an older server, the live board)
      // are Done too — all but the pinned ones, which are rows above.
      doneCount: (queue?.doneCount ?? 0) + threads.filter((t) => !isPinned(t) && sectionOf(t) === "inactive").length,
      recentDone: queue?.recentDone ?? [],
      ...(queue?.schedules && queue.schedules.count > 0 ? { schedules: queue.schedules } : {}),
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
 * drawn under its name. The rows are filtered as the server filters them for the poll (sessions of this
 * project, nothing foreign); Done is left to the rail's own banding, which
 * counts what it files there, so the server's Done count is dropped rather than added to — and so is the
 * poll's `pinnedDone`, for the same reason: the board's threads already carry every pinned Done thread
 * (queuesProjects files it from them), and keeping the poll's copy as well drew each one twice. The
 * focused project's folded header counted 4 pins for 3 (found in QA of upstream-superset, 2026-10-06).
 */
export function liveQueue(
  queues: readonly ProjectQueue[] | undefined,
  board: Pick<BoardSnapshot, "projectSlug" | "threads"> | null,
  focusSlug: string | undefined,
): ProjectQueue | undefined {
  if (!queues || !board || !focusSlug || board.projectSlug !== focusSlug) return undefined
  const polled = queues.find((queue) => queue.projectSlug === focusSlug)
  if (!polled) return undefined
  const threads = board.threads.filter((thread) => (thread.kind === "session" || thread.kind === "terminal") && !thread.foreign)
  return { ...polled, threads, doneCount: 0, pinnedDone: [] }
}

/**
 * `projects` with the given queues rebuilt in place. Every other project keeps its IDENTITY, so a live
 * board ticking — which it does on every delta — re-derives one project, not the page.
 */
export function overlayQueues(
  projects: QueuesProject[],
  overlays: readonly (ProjectQueue | undefined)[],
): QueuesProject[] {
  let out = projects
  for (const queue of overlays) {
    if (!queue) continue
    const index = out.findIndex((project) => project.id === queue.projectId)
    if (index < 0) continue
    const card = out[index]!.card
    const [rebuilt] = queuesProjects(card ? [card] : [], [queue])
    if (out === projects) out = [...projects]
    out[index] = rebuilt!
  }
  return out
}

/** One card of the page's queue, with the project it belongs to. */
export interface QueueEntry {
  project: QueuesProject
  thread: ThreadView
}

/**
 * THE PAGE'S ONE QUEUE — every project's ready threads merged into a single line, in the order the board's
 * own queue uses (`orderQueue`: when each ENTERED the queue, oldest first).
 * That is the order a FRESH draw takes; once drawn, lib/stableQueue.ts keeps every card where it is and
 * appends whatever arrives at the bottom.
 *
 * It was one lane per project in rail order, and that is what made the page a stack (maintainer
 * 2026-09-28, choosing it: "One queue across all projects"): a project listed above the one being read
 * that got its first ready thread inserted a whole lane ABOVE the card being read. Merged, an arrival from
 * any project joins the bottom like any other. The stamps compare across projects because one server
 * stamps them all on one clock (the server's queue-clock.ts).
 */
export function mergedQueue(projects: readonly QueuesProject[]): QueueEntry[] {
  const owner = new Map<ThreadView, QueuesProject>()
  for (const project of projects) for (const thread of project.queued) owner.set(thread, project)
  return orderQueue([...owner.keys()]).map((thread) => ({ project: owner.get(thread)!, thread }))
}

/** A card-shaped stand-in for a project the registry list has not caught up with, for its square. */
export function squareCard(project: QueuesProject): ProjectCard {
  return project.card ?? { id: project.id, slug: project.slug, name: project.name, path: project.projectDir ?? "", lastOpenedAt: "", stale: false, iconStatus: "unknown" }
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
  /** Each signal fence's prose and its parsed frontmatter. The HINTS ride along for an ```awaiting fence's
   *  card, which states its `steps:`, `title:` and waits from them (AwaitingBackgroundCard) — the card
   *  dropped them until 2026-10-06, so a rest that handed the human steps showed none on the queue. */
  fences: { kind: "done" | "awaiting"; body: string; hints: AwaitingHint[] }[]
}

/**
 * A handoff, split the way the board's card draws it: the prose, the ```question fences, and each
 * ```done / ```awaiting fence as its own card.
 *
 * A ```question fence goes one of three ways. An EMPTY `qst_…` marker is dropped from the prose: it
 * places its registered card, which the drawer and this card's transcript view draw where the marker
 * sits, but the handoff view's prose is clamped, so there the marker only decides WHICH rest the card is
 * drawn at the end of (lib/queueCardQuestions.ts handoffQuestionSlots). Left in, it would render as an
 * empty code block mid-prose. A fence that STANDS FOR a registered question — names its id, or restates
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
    else fences.push({ kind: segment.fenceKind, body: segment.body, hints: segment.hints })
  }
  return { prose: prose.trim(), questions, fences }
}

/**
 * The prose of every rest before the newest (router handoffOf `earlier`), each keyed by when it was
 * written so its block keeps its place — and whether the human opened it — as newer rests land below.
 * ALL of it, whatever the newest rest says: a later done or status line never takes back prose the card
 * already showed (@precompile-design, 2026-10-16: the examples the human was reading vanished when the
 * worker signed off done). Only their fences go, since the newest rest's state supersedes theirs.
 */
export function earlierProse(earlier: readonly { text: string; at?: string }[] | undefined, registered: readonly Pick<RegisteredQuestionView, "id" | "spec">[] = []): { key: string; prose: string }[] {
  return (earlier ?? []).flatMap((rest, index) => {
    const prose = handoffParts(rest.text, registered).prose
    return prose ? [{ key: rest.at ?? `earlier-${index}`, prose }] : []
  })
}
