// THE ALL QUEUES PAGE — the level above a project: every project's queue on one page, at `/queues`.
//
// It is the board, one level up, and it is laid out as one. The board is a floating sidebar beside a
// 720px queue; so is this. The board's sidebar lists a project's threads in bands (Queue, Running,
// Snoozed); this one lists every PROJECT, each with its own queue rows and running rows beneath it, in
// the operator's own rail order. The board's queue is a column of cards; this one is a column of LANES,
// one per project with anything in its queue, each headed by the project and holding that project's
// cards in the order its own board would show them.
//
// THE DRILL-DOWN, three steps, each one click:
//   1. the card — the handoff's opening lines, the questions, a reply box, Snooze and Mark as done;
//   2. "Show more" — the whole handoff, in place;
//   3. the card's ↗ (or its title) — the thread on its own board, with its whole transcript. Back
//      returns here.
//
// WHAT THIS PAGE MUST NEVER DO is ask the page which project anything belongs to. It names no project,
// so the address bar, the store's board and the page's socket all mean the LAUNCHING project — or
// whichever board the feed last carried. Every read here is either machine-wide (`projectsList`,
// `projectsQueues`) or carries its project explicitly, and every action goes through that project's own
// client (`projectRpc`). See AllQueuesCard.tsx for the card's half of the same rule.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, House, Inbox, TerminalSquare } from "lucide-react"
import { Link, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { isBusy, laneSummary, queuesProjects, queuesTotals, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { commandFailed, commandLive, commandStateLabel } from "../lib/commandThreads.ts"
import { prefs } from "../lib/prefs.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { MarkdownScopeContext } from "../lib/useMarkdown.ts"
import { AllQueuesCard, threadBoardHref } from "./AllQueuesCard.tsx"
import { CommandQueueCard } from "./CommandQueueCard.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { ROW_ACTION_CLASS, RestedAge, SIDEBAR_COLUMN_CLASS, ThreadIndicator, TitleWithTrailers } from "./Sidebar.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { ThreadProjectScope } from "../api/threadApi.tsx"

/** How often the page re-reads every project. The rail's badges poll at 5s; this is the page the
 *  operator is looking AT, so it runs a little faster — the read is the servers' cached snapshots. */
const POLL_MS = 3_000
/** The card's exit fade — the board's (styles.css `.frizz-card-slot`, TodosView QUEUE_EXIT_MS). */
const EXIT_MS = 200
/**
 * How long an acted-on card stays gone while the server catches up. Past this, a thread that is STILL
 * queued comes back — the action evidently did not take — rather than staying hidden on the strength of
 * a click. The board's queue keeps the same guard.
 */
const REAPPEAR_MS = 8_000

export function AllQueuesPage() {
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const queues = useQuery({
    queryKey: ["projectsQueues"],
    queryFn: () => rpc.projectsQueues(),
    refetchInterval: POLL_MS,
  })
  const direction = useSnapshot(prefs).queueOrder
  const projects = useMemo(() => queuesProjects(cards.data, queues.data, direction), [cards.data, queues.data, direction])

  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    document.title = standalone ? "Everything" : "Everything — Frizz"
  }, [])

  const leaving = useLeavingCards(projects)
  // Counted from what the page SHOWS: a card the operator just finished is gone from its lane at once, and
  // a header still counting it read "1 in the queue" over an empty page until the next poll.
  const totals = queuesTotals(projects.map((project) => ({ ...project, queued: project.queued.filter((t) => !leaving.hidden(threadKey(project.id, t.id))) })))
  // Registered projects this server has not opened (still being opened after a boot, served by another
  // Frizz, or failed to open): their queues are unknown, so "nothing in any queue" would be a claim.
  const unopened = projects.filter((project) => !project.open && !project.stale).length
  const scrollToCard = useScrollToCard()
  const activeKey = useScrollspy(projects, leaving.hidden)
  const loading = (cards.isPending || queues.isPending) && !queues.data
  const lanes = projects.filter((project) => project.queued.some((t) => !leaving.hidden(threadKey(project.id, t.id))))

  return (
    <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] bg-bg px-5 text-sm text-fg max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
      <aside aria-label="Projects" className={`${SIDEBAR_COLUMN_CLASS} max-[800px]:!pt-5`}>
        <div className="flex max-h-[calc(100vh-32px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
          <div className="mb-5 shrink-0 px-0.5">
            <HeaderRow totals={totals} projectCount={projects.length} unopened={unopened} />
          </div>
          <div data-xq-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden max-[800px]:hidden">
            <MachineRail projects={projects} activeKey={activeKey} hidden={leaving.hidden} onQueuedRow={scrollToCard} />
          </div>
        </div>
      </aside>
      <main
        id="workpane"
        aria-label="Everything"
        className="flex min-h-screen w-[720px] max-w-[62vw] min-w-0 flex-col py-5 max-[800px]:min-h-0 max-[800px]:w-full max-[800px]:max-w-none"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
          </div>
        ) : queues.error && !queues.data ? (
          <p className="my-auto text-center text-[13px] text-muted">Could not read the queues: {String(queues.error)}</p>
        ) : (
          <div className="my-auto flex w-full min-w-0 flex-col py-8 max-[800px]:pt-2">
            {lanes.map((project, index) => (
              <div key={project.id} className="min-w-0">
                {index > 0 && <hr className="my-10 border-0 border-t border-border/60" />}
                <Lane project={project} leaving={leaving} />
              </div>
            ))}
            {lanes.length === 0 && <EmptyQueues running={totals.running} runningProjects={projects.filter((p) => p.running.length > 0).length} unopened={unopened} />}
          </div>
        )}
      </main>
    </div>
  )
}

// ---- The page header ------------------------------------------------------------------------------

/**
 * The column's top row — the board's StatusRow, one level up: the door out on the left, and in the name's
 * slot the name of THIS level. Its line under it is the whole page at a glance.
 */
function HeaderRow({ totals, projectCount, unopened }: { totals: ReturnType<typeof queuesTotals>; projectCount: number; unopened: number }) {
  return (
    <>
      <div className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]">
        <Link to="/" title="All projects" aria-label="All projects" className={`${STATUS_ROW_ACTION} -ml-px`}>
          <House size={STATUS_ROW_ICON} aria-hidden="true" />
        </Link>
        <span className="ml-auto min-w-0 truncate font-semibold text-fg/90">Everything</span>
      </div>
      <p data-xq-summary className="text-[11.5px] leading-snug text-muted-70">
        {totals.queued > 0
          ? `${totals.queued} in the queue across ${totals.projectsWithQueue} ${totals.projectsWithQueue === 1 ? "project" : "projects"}`
          : projectCount > unopened
            ? unopened > 0 ? "Nothing in any open project's queue" : "Nothing in any queue"
            : projectCount > 0 ? "No project is open yet" : "No projects yet"}
        {totals.running > 0 ? ` · ${totals.running} running` : ""}
        {unopened > 0 ? ` · ${unopened} not open` : ""}
      </p>
    </>
  )
}

// ---- The machine rail (left column) -----------------------------------------------------------------

// The board sidebar's row geometry, verbatim (Sidebar.tsx ThreadRow), so a row here and a row there are
// the same row: the hover wash, the 20px indicator gutter, the title's 13/19 type.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"

function MachineRail({
  projects,
  activeKey,
  hidden,
  onQueuedRow,
}: {
  projects: QueuesProject[]
  activeKey: string | null
  hidden: (key: string) => boolean
  onQueuedRow: (key: string) => void
}) {
  const busy = projects.filter(isBusy)
  const quiet = projects.filter((project) => !isBusy(project))
  return (
    <>
      {busy.map((project, index) => (
        <div key={project.id}>
          {index > 0 && <hr className="my-3 border-border/50" />}
          <ProjectGroup project={project} activeKey={activeKey} hidden={hidden} onQueuedRow={onQueuedRow} />
        </div>
      ))}
      {/* Always listed, one line each, under the busy ones. They sat behind a collapsed "Quiet" fold until
          2026-09-24, which cost a click to reach a project whose row is already about as quiet as a row
          can be (maintainer: "if I want to navigate to them I shouldn't have to expand"). */}
      {quiet.length > 0 && (
        <section aria-label="Quiet projects">
          {busy.length > 0 && <hr className="my-3 border-border/50" />}
          {quiet.map((project) => <QuietRow key={project.id} project={project} />)}
        </section>
      )}
    </>
  )
}

/**
 * One project in the rail: its square and name, then its queue rows — each opposite its card, the way a
 * board's cue row faces its queue card — then the rows still spinning, then a folded count of what is
 * snoozed. The name is the lane's door; the ↗ beside it is the project's own board.
 */
function ProjectGroup({
  project,
  activeKey,
  hidden,
  onQueuedRow,
}: {
  project: QueuesProject
  activeKey: string | null
  hidden: (key: string) => boolean
  onQueuedRow: (key: string) => void
}) {
  const navigate = useNavigate()
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const queued = project.queued.filter((t) => !hidden(threadKey(project.id, t.id)))
  const toLane = () => {
    const lane = document.querySelector<HTMLElement>(`[data-xq-lane="${CSS.escape(project.id)}"]`)
    if (lane) lane.scrollIntoView({ behavior: prefersSmooth(), block: "start" })
    else navigate(`/project/${encodeURIComponent(project.slug)}`)
  }
  return (
    <section aria-label={project.name} data-xq-rail-project={project.id}>
      <div className={ROW_CLASS}>
        <button type="button" onClick={toLane} className={`${ROW_BUTTON_CLASS} items-center`} title={queued.length > 0 ? `Go to ${project.name}'s queue` : `Open ${project.name}`}>
          <span className={INDICATOR_SLOT}>
            <ProjectSquare project={project.card ?? fallbackCard(project)} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-[19px] text-fg/90">{project.name}</span>
          {/* The rest-time column's spot, and the rest time's manners: it gives way to the door on hover. */}
          {queued.length > 0 && (
            <span className="flex shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              <QueueBadge count={queued.length} />
            </span>
          )}
        </button>
        <RowDoor href={`/project/${encodeURIComponent(project.slug)}`} label={`Open ${project.name}'s board`} />
      </div>
      {queued.map((t) => {
        const key = threadKey(project.id, t.id)
        return <RailRow key={key} t={t} door={threadBoardHref(project, t.id)} active={activeKey === key} restedAge onClick={() => onQueuedRow(key)} />
      })}
      {project.running.map((t) => (
        <RailRow key={t.id} t={t} onClick={() => navigate(threadBoardHref(project, t.id))} />
      ))}
      {project.snoozed.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setSnoozedOpen((open) => !open)}
            aria-expanded={snoozedOpen}
            className="flex w-full min-w-0 items-center gap-2 rounded-md pb-1 pl-5 pr-1.5 pt-1 text-left text-[11.5px] leading-[19px] text-muted-60 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            <span className={INDICATOR_SLOT} aria-hidden />
            {project.snoozed.length} snoozed
          </button>
          {snoozedOpen && project.snoozed.map((t) => (
            <RailRow key={t.id} t={t} dim onClick={() => navigate(threadBoardHref(project, t.id))} />
          ))}
        </>
      )}
    </section>
  )
}

/**
 * A thread row — the board sidebar's ThreadRow anatomy, with this page's own click. A queue row's click
 * scrolls to its card, so it also wears the door to the thread's board; a running row's click IS that
 * door, so it needs no second one.
 */
function RailRow({ t, door, active = false, restedAge = false, dim = false, onClick }: { t: ThreadView; door?: string; active?: boolean; restedAge?: boolean; dim?: boolean; onClick: () => void }) {
  return (
    <div className={`${ROW_CLASS} ${dim ? "sidebar-row-dim" : ""}`}>
      {/* The board's scroll marker: the card this row faces is the one being read. */}
      {active && <span aria-hidden className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
      <button type="button" onClick={onClick} className={ROW_BUTTON_CLASS} aria-current={active || undefined}>
        {t.kind === "command" && t.command ? (
          <CommandRowBody command={t.command} />
        ) : (
          <>
            <span className={INDICATOR_SLOT}>
              <ThreadIndicator t={t} />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-3">
              <span className={`min-w-0 flex-1 break-words text-[13px] leading-[19px] ${dim ? "text-fg/75" : "text-fg/90"}`}>
                <TitleWithTrailers title={displayTitle(t)}>
                  <ProviderMark backend={t.backend} model={t.model} className="ml-1" />
                </TitleWithTrailers>
              </span>
              {restedAge && <RestedAge t={t} yieldsToRetry />}
            </span>
          </>
        )}
      </button>
      {door && <RowDoor href={door} label="Open on its board" />}
    </div>
  )
}

/**
 * A terminal command's row, as the board's rail draws it (Sidebar.tsx CommandRow): the terminal mark or
 * the live dot, the command in mono, and how the run stands where an agent row keeps its rest time.
 */
function CommandRowBody({ command }: { command: NonNullable<ThreadView["command"]> }) {
  const running = commandLive(command)
  const failed = commandFailed(command)
  return (
    <>
      <span className={INDICATOR_SLOT}>
        {running ? (
          <span aria-label="Running" className="frizz-live-dot frizz-live-dot--shell" />
        ) : (
          <TerminalSquare aria-label={commandStateLabel(command)} size={13} className={failed ? "text-danger-soft" : "text-muted-60"} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="font-mono-keep min-w-0 flex-1 truncate text-[12px] leading-[19px] text-fg/90" title={command.command}>
          {command.command}
        </span>
        {!running && (
          <span className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] ${failed ? "text-danger-soft" : "text-muted-55"}`}>
            {commandStateLabel(command)}
          </span>
        )}
      </span>
    </>
  )
}

/**
 * The row's hover door, where the board's rail puts its own (Sidebar.tsx, the hover strip): pinned to
 * the right edge over the title's first line, backed by the rail's colour so a long title's last words
 * do not show through the glyph, and revealed on hover or keyboard focus.
 */
function RowDoor({ href, label }: { href: string; label: string }) {
  return (
    <div className="absolute right-1.5 top-1 hidden items-center bg-bg group-hover:flex group-focus-within:flex before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-r before:from-transparent before:to-bg">
      <Tooltip label={label} side="right">
        <Link to={href} aria-label={label} className={ROW_ACTION_CLASS}>
          <ArrowUpRight size={13} />
        </Link>
      </Tooltip>
    </div>
  )
}

/** A project with nothing to show: its name, why, and the way to its board. */
function QuietRow({ project }: { project: QueuesProject }) {
  const note = project.stale
    ? "Directory is missing"
    : !project.open
      ? "Not open"
      : project.doneCount > 0
        ? `${project.doneCount} done`
        : "No threads"
  return (
    <div className={`${ROW_CLASS} ${project.stale ? "opacity-60" : ""}`}>
      <Link to={`/project/${encodeURIComponent(project.slug)}`} className={`${ROW_BUTTON_CLASS} items-center`}>
        <span className={`${INDICATOR_SLOT} ${project.stale ? "grayscale" : ""}`}>
          <ProjectSquare project={project.card ?? fallbackCard(project)} size={16} />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-fg/75">{project.name}</span>
          <span className="shrink-0 text-[10.5px] leading-[19px] text-muted-55">{note}</span>
        </span>
      </Link>
    </div>
  )
}

/**
 * The rail badge's count (ProjectRail.tsx), laid inline. Accent, and only accent, because the accent
 * means exactly one thing in this product: this many want you.
 */
function QueueBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} in the queue`}
      data-xq-queue-count={count}
      className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-accent-fill px-[4px] text-[10px] font-semibold leading-none proportional-nums text-on-accent"
    >
      {/* The cap band, not the line box — the rail badge's own fix (ProjectRail.tsx). */}
      <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
    </span>
  )
}

// ---- The lanes (the workpane) -----------------------------------------------------------------------

/**
 * One project's queue: its header — sticky, so a long lane never loses whose cards these are — and its
 * cards in its board's queue order.
 *
 * EVERYTHING INSIDE RENDERS AS THIS PROJECT. The markdown scope points a `#123` at this project's repo, a
 * relative path at its directory and a `/thread/<slug>` link at its board — never at the page's.
 */
function Lane({ project, leaving }: { project: QueuesProject; leaving: LeavingCards }) {
  const navigate = useNavigate()
  const scope = useMemo(
    () => ({
      projectId: project.id,
      repo: project.githubRepo ?? null,
      appPath: `/project/${encodeURIComponent(project.slug)}`,
      baseDir: project.projectDir,
      homeDir: project.homeDir,
    }),
    [project.id, project.githubRepo, project.slug, project.projectDir, project.homeDir],
  )
  const boardHref = `/project/${encodeURIComponent(project.slug)}`
  return (
    <section data-xq-lane={project.id} aria-label={`${project.name} queue`} className="flex min-w-0 scroll-mt-4 flex-col gap-6">
      <header className="sticky top-0 z-10 -mx-1 flex min-w-0 items-center gap-2.5 bg-bg/90 px-1 py-2.5 backdrop-blur-sm">
        <ProjectSquare project={project.card ?? fallbackCard(project)} size={22} />
        {/* The NAME keeps its room and the count line gives way: on a phone "marketing-site" beside
            "4 in the queue · 1 snoozed" truncated the name to "marketin…", the one word that says whose
            cards these are. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="max-w-full shrink-0 truncate text-[14px] font-semibold text-fg">{project.name}</h2>
          <span className="min-w-0 truncate text-[11.5px] text-muted-70">{laneSummary(project)}</span>
        </div>
        <Link
          to={boardHref}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          Open board
          <ArrowUpRight size={13} />
        </Link>
      </header>
      <MarkdownScopeContext.Provider value={scope}>
        {project.queued.map((t) => {
          const key = threadKey(project.id, t.id)
          if (leaving.hidden(key)) return null
          // A finished terminal command takes the board's own command card, scoped to its project: its
          // pty, its Restart and its Mark as done all belong to this lane's project, not the page's.
          if (t.kind === "command") {
            return (
              <div key={key} data-xq-card={key} data-queue-leaving={leaving.isLeaving(key)} className="frizz-card-slot min-w-0">
                <div className="frizz-card-clip min-h-0 min-w-0">
                  <div className="frizz-card-body min-w-0">
                    <ThreadProjectScope projectId={project.id}>
                      <CommandQueueCard
                        thread={t}
                        leaving={leaving.isLeaving(key)}
                        onResolve={leaving.leave(key)}
                        onUnresolve={leaving.restore(key)}
                        onOpen={() => navigate(threadBoardHref(project, t.id))}
                      />
                    </ThreadProjectScope>
                  </div>
                </div>
              </div>
            )
          }
          return (
            <AllQueuesCard
              key={key}
              project={project}
              thread={t}
              leaving={leaving.isLeaving(key)}
              onLeave={leaving.leave(key)}
              onReturn={leaving.restore(key)}
            />
          )
        })}
      </MarkdownScopeContext.Provider>
    </section>
  )
}

/** Inbox zero — the board's own empty queue, with what is still running across the machine. */
function EmptyQueues({ running, runningProjects, unopened }: { running: number; runningProjects: number; unopened: number }) {
  return (
    <div data-xq-empty className="flex flex-col items-center gap-2 pt-2">
      <Inbox size={40} strokeWidth={1.25} className="text-muted-30" />
      <div className="text-[13px] text-muted-80">
        {unopened > 0 ? "No threads awaiting human input in any open project" : "No threads awaiting human input in any project"}
      </div>
      {unopened > 0 && (
        <div className="text-[11.5px] text-muted-60">
          {unopened} {unopened === 1 ? "project is" : "projects are"} not open on this server
        </div>
      )}
      {running > 0 && (
        <div className="text-[11.5px] text-muted-60">
          {running} running across {runningProjects} {runningProjects === 1 ? "project" : "projects"}
        </div>
      )}
    </div>
  )
}

// ---- Behaviour ---------------------------------------------------------------------------------------

interface LeavingCards {
  isLeaving: (key: string) => boolean
  hidden: (key: string) => boolean
  leave: (key: string) => () => void
  restore: (key: string) => () => void
}

/**
 * The optimistic exit every action on a card shares: the card fades the moment the operator commits
 * (answer, reply, snooze, done), is gone once the fade ends, and stays gone until the server's next read
 * agrees — or comes back, if REAPPEAR_MS pass and the thread is still in its queue.
 *
 * Keyed by `threadKey` (project + slug), never by slug: this page holds several projects' threads, and
 * a slug is unique only within one.
 */
function useLeavingCards(projects: QueuesProject[]): LeavingCards {
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [, tick] = useState(0)
  const callbacks = useRef(new Map<string, { leave: () => void; restore: () => void }>())

  // A card whose thread has left its queue on the server needs no guard any more.
  const stillQueued = useMemo(() => new Set(projects.flatMap((p) => p.queued.map((t) => threadKey(p.id, t.id)))), [projects])
  useEffect(() => {
    setSince((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const key of prev.keys()) if (!stillQueued.has(key)) { next.delete(key); changed = true }
      return changed ? next : prev
    })
  }, [stillQueued])

  const now = Date.now()
  const handles = (key: string) => {
    let entry = callbacks.current.get(key)
    if (!entry) {
      entry = {
        leave: () => {
          setSince((prev) => new Map(prev).set(key, Date.now()))
          // Re-render at the end of the fade (to unmount) and at the reappear deadline (to restore).
          window.setTimeout(() => tick((n) => n + 1), EXIT_MS + 20)
          window.setTimeout(() => tick((n) => n + 1), REAPPEAR_MS + 20)
        },
        restore: () =>
          setSince((prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          }),
      }
      callbacks.current.set(key, entry)
    }
    return entry
  }
  const age = (key: string) => {
    const at = since.get(key)
    return at === undefined ? undefined : now - at
  }
  return {
    isLeaving: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && elapsed < REAPPEAR_MS
    },
    hidden: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && elapsed >= EXIT_MS && elapsed < REAPPEAR_MS
    },
    leave: (key) => handles(key).leave,
    restore: (key) => handles(key).restore,
  }
}

function prefersSmooth(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
}

/**
 * A queue row's click: bring its card to the top of the lane and ring it — the board's own
 * scroll-to-card (store.ts scrollToQueueCard), for a page whose cards are keyed by project.
 */
function useScrollToCard(): (key: string) => void {
  return useCallback((key: string) => {
    const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
    if (!slot) return
    // Below the lane's sticky header, which is ~44px tall.
    const top = slot.getBoundingClientRect().top + window.scrollY - 56
    window.scrollTo({ top: Math.max(0, top), behavior: prefersSmooth() })
    const root = slot.querySelector<HTMLElement>("[data-xq-card-root]")
    if (!root) return
    root.removeAttribute("data-queue-flash")
    // Re-arm on the next frame so a second click on the same row replays the ring.
    requestAnimationFrame(() => {
      root.setAttribute("data-queue-flash", "")
      window.setTimeout(() => root.removeAttribute("data-queue-flash"), 1100)
    })
  }, [])
}

/**
 * Which card is being read — the one crossing the reading line a third of the way down the window — so
 * its row in the rail wears the board's scroll marker.
 */
function useScrollspy(projects: QueuesProject[], hidden: (key: string) => boolean): string | null {
  const [active, setActive] = useState<string | null>(null)
  const signature = projects.map((p) => p.queued.map((t) => threadKey(p.id, t.id)).filter((k) => !hidden(k)).join(",")).join("|")
  useEffect(() => {
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const line = window.innerHeight / 3
        let found: string | null = null
        for (const slot of document.querySelectorAll<HTMLElement>("[data-xq-card]")) {
          const { top, bottom } = slot.getBoundingClientRect()
          if (top <= line && bottom >= line) { found = slot.dataset.xqCard ?? null; break }
          if (top > line) { found ??= slot.dataset.xqCard ?? null; break }
          found = slot.dataset.xqCard ?? null
        }
        setActive(found)
      })
    }
    sync()
    window.addEventListener("scroll", sync, { passive: true })
    window.addEventListener("resize", sync)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", sync)
      window.removeEventListener("resize", sync)
    }
  }, [signature])
  return active
}

/** A card-shaped stand-in for a project the registry list has not caught up with, for its square. */
function fallbackCard(project: QueuesProject) {
  return { id: project.id, slug: project.slug, name: project.name, path: project.projectDir ?? "", lastOpenedAt: "", stale: false, iconStatus: "unknown" as const }
}
