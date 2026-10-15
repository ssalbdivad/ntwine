// ALL PROJECTS' LIST, BY WHAT NEEDS YOU — every project's threads in one list of bands, not a list of projects
// (plans/all-projects-first.md, David 2026-10-14: "build all four steps"). It replaced both All projects'
// per-project groups and a project's own board: `/project/<slug>` is this list over one project, with each
// thread's sub-agents as rows under it, and a lens (lib/lens.ts) is this list over the projects in it.
//
// TOP TO BOTTOM: Pinned, Ready (in the queue's own order, so a row faces its card), Working (each project's
// threads together, the project's square on the first of them and the cord tying the rest), Waiting (an
// agent's park on something outside the thread — a review, CI, a reply — always in view, 2026-10-14),
// Snoozed (the human's own snoozes, folded), and Done today (a short tail, with History one click away). The project is
// an ATTRIBUTE of a row — its square in the gutter — never a heading: at the heavy load (17 projects, 70 open
// threads) the headings alone cost a third of the column.
//
// THE LIST NEVER SCROLLS. It measures itself and gives things up in a fixed order until it fits
// (lib/sidebarBudget.ts): the Done tail first, then Waiting down to its first rows, then Working rolls its biggest projects into a line each,
// then Ready and Working list their first rows and count the rest (Ready's are all in the queue beside it
// anyway), and last Pinned does the same.
// What the human opened by hand is never taken back. While the pointer is over the list nothing is
// re-budgeted (lib/listHold.ts), so a row never moves out from under it.
//
// What is NOT here, and where it went: External sessions and every Done thread past today are the center
// column's History (lib/centerTab.ts), and the project rows' "…" menus are the dock's (ProjectDock.tsx). The
// schedules of the projects in view are the last band, folded.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { useLocation } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { displayTitle, isPinned, isSnoozed, queued } from "../groups.ts"
import { squareCard, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { projectSlug } from "../lib/base-path.ts"
import { setCenterTab } from "../lib/centerTab.ts"
import { setTierFold, useTierFolds } from "../lib/crossProject.ts"
import { holdLayout, type HeldSection, type HeldSlot } from "../lib/heldLayout.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { doneToday, listOverlay, loudBands, restedAt } from "../lib/listBands.ts"
import { useListHold } from "../lib/listHold.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { budgetAt, maxLevel, TAIL_MAX, WAITING_FLOOR, type Budget, type BudgetInput } from "../lib/sidebarBudget.ts"
import { prefs } from "../lib/prefs.ts"
import { recentOf } from "../lib/recentThreads.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { drawerThreadSlug, store } from "../store.ts"
import { BoxSpinner } from "./BoxSpinner.tsx"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { RailRow, SectionHeader, SubAgentRows, type RowScope } from "./Sidebar.tsx"
import { ScheduleRows } from "./ScheduleRows.tsx"
import { statusElapsed } from "./ThreadStatusLine.tsx"

/** One thread of one project, as the list draws it. */
interface Entry {
  key: string
  project: QueuesProject
  t: ThreadView
}

type Tier = "pinned" | "ready" | "working" | "waiting" | "snoozed" | "done"

export function TierList({
  projects,
  activeKey,
  hidden,
  onQueuedRow,
  queueOrder,
  subAgentRows = false,
}: {
  projects: readonly QueuesProject[]
  activeKey: string | null
  hidden: (key: string) => boolean
  /** Bring a Ready card into view: its scroll offset, or null when the queue is not showing it. */
  onQueuedRow: (key: string) => number | null
  /** The queue's cards as drawn, by `threadKey` — Ready lists its rows in this order. */
  queueOrder: readonly string[]
  /** One project's page: a thread's sub-agents are rows of their own under it, as upstream's sidebar drew
   *  them (2026-10-06). All projects counts them on the thread's row instead. */
  subAgentRows?: boolean
}) {
  const snap = useSnapshot(store)
  const { showRecentThreads } = useSnapshot(prefs)
  const focus = projectSlug(useLocation().pathname)
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const folds = useTierFolds()
  const held = useListHold()
  const now = useNowMs()
  const scopes = useRowScopes(projects, onQueuedRow)
  // The page project's board is live in the store; only its rows can be up in a drawer on this page.
  const boardSlug = (snap.board as BoardSnapshot | null)?.projectSlug
  const openKey = useMemo(() => {
    const project = projects.find((p) => p.slug === focus && p.slug === boardSlug)
    const slug = project ? drawerThreadSlug(snap.drawers) : null
    return project && slug ? threadKey(project.id, slug) : null
  }, [projects, focus, boardSlug, snap.drawers])

  // ---- The live layout -------------------------------------------------------------------------------
  const live = useMemo(() => {
    const pinned: Entry[] = []
    const ready: Entry[] = []
    const working: Entry[] = []
    const waiting: Entry[] = []
    const snoozed: Entry[] = []
    const done: Entry[] = []
    for (const project of projects) {
      const onPage = project.slug === focus && project.slug === boardSlug
      const loud = loudBands(project, hidden, listOverlay(project.id, onPage, steeredAt, archivingAt))
      const entry = (t: ThreadView): Entry => ({ key: threadKey(project.id, t.id), project, t })
      pinned.push(...loud.pinned.map(entry))
      ready.push(...loud.ready.map(entry))
      // Each project's Working rows together, in the project order: the run the cord ties.
      working.push(...loud.working.map(entry))
      waiting.push(...loud.waiting.map(entry))
      snoozed.push(...project.snoozed.filter((t) => !isPinned(t) && isSnoozed(t)).map(entry))
      done.push(...doneToday(project, now).map(entry))
    }
    pinned.sort((a, b) => (a.t.pinnedAt ?? "").localeCompare(b.t.pinnedAt ?? "") || a.key.localeCompare(b.key))
    const at = new Map(queueOrder.map((key, index) => [key, index]))
    ready.sort((a, b) => (at.get(a.key) ?? Infinity) - (at.get(b.key) ?? Infinity))
    done.sort((a, b) => restedAt(b.t) - restedAt(a.t))
    return { pinned, ready, working, waiting, snoozed, done }
    // `now` moves every 30s; Done today needs no finer clock than that.
  }, [projects, focus, boardSlug, hidden, steeredAt, archivingAt, queueOrder, now])

  // ---- Held while the pointer is over the list (lib/heldLayout.ts) -------------------------------------
  const byKey = useMemo(() => new Map(Object.values(live).flat().map((entry) => [entry.key, entry])), [live])
  const drawn = useRef<HeldSection<Entry>[]>([])
  const sections = holdLayout({
    prev: drawn.current,
    target: (["pinned", "ready", "working", "waiting", "snoozed", "done"] as const).map((id) => ({ id, items: live[id] })),
    keyOf: (entry) => entry.key,
    frozen: held,
    moved: (key) => {
      const entry = byKey.get(key)
      return entry !== undefined && (actedOnHere(entry.t.id) || hidden(key) || steeredAt[key] !== undefined)
    },
    live: (key) => byKey.get(key),
  })
  drawn.current = sections
  const slots = (tier: Tier) => sections.find((section) => section.id === tier)?.slots ?? []
  // The tier each thread is in NOW: a held row is drawn in its old place but as what it is.
  const tierNow = new Map((Object.keys(live) as Tier[]).flatMap((tier) => live[tier].map((entry) => [entry.key, tier] as const)))

  // Working, as runs of one project's rows.
  const runs: Run[] = []
  for (const slot of slots("working")) {
    const last = runs.at(-1)
    if (last && last.project.id === slot.item.project.id) last.slots.push(slot)
    else runs.push({ id: `${slot.item.project.id}#${runs.filter((r) => r.project.id === slot.item.project.id).length}`, project: slot.item.project, slots: [slot] })
  }

  // ---- The budget -------------------------------------------------------------------------------------
  const open = (tier: "snoozed" | "done" | "working" | "waiting" | "pinned" | "schedules") => folds.has(tier)
  const expanded = useMemo(() => new Set([...folds].filter((key) => key.startsWith("run:")).map((key) => key.slice(4))), [folds])
  const input: BudgetInput = {
    tail: slots("done").length,
    tailOpen: open("done"),
    runs: runs.map((run) => ({ id: run.id, size: run.slots.length })),
    expanded,
    ready: slots("ready").length,
    workingOpen: open("working"),
    pinned: slots("pinned").length,
    pinnedOpen: open("pinned"),
    waiting: slots("waiting").length,
    waitingOpen: open("waiting"),
  }
  const listRef = useRef<HTMLDivElement>(null)
  const childRows = subAgentRows ? Object.values(live).flat().map((entry) => entry.t.subAgents?.length ?? 0).join(",") : ""
  const level = useBudgetLevel(listRef, input, held, childRows)
  const budget = budgetAt(level, input)
  const rest = workingRest(runs, budget, expanded)

  // ---- Drawing ------------------------------------------------------------------------------------------
  const row = (slot: HeldSlot<Entry>, tier: Tier, lead: boolean) => {
    const { project, t, key } = slot.item
    const band = tierNow.get(key)
    // Siblings, not a wrapper: the cord strings each row by its own place in the run (ThreadConnector), and
    // a thread's sub-agent rows, between two of them, cut it there.
    return (
      <ThreadProjectScope key={key} projectId={project.id} projectDir={project.projectDir}>
        <RailRow
          t={t}
          active={activeKey === key}
          open={openKey === key}
          restedAge={tier === "ready"}
          scope={scopes(project)}
          cardKey={queued(t) && (tier === "ready" || tier === "pinned") ? key : undefined}
          band={band === "pinned" || band === "ready" || band === "working" || band === "waiting" ? band : undefined}
          held={slot.held}
          leadProject={lead ? (project.card ?? squareCard(project)) : undefined}
          statusAlways
          oneLine
          subAgentRows={subAgentRows}
        />
        {subAgentRows && <SubAgentRows t={t} scope={scopes(project)} />}
      </ThreadProjectScope>
    )
  }
  // A run of one project's rows, as the cord reads it (ThreadConnector): the rows are the section's own
  // children. Its square leads the first row.
  const run = (key: string, project: QueuesProject, rows: HeldSlot<Entry>[], tier: Tier) => (
    <div key={key} data-xq-rail-project={project.id} data-xq-tier-run={tier} className="flex min-w-0 flex-col">
      {rows.map((slot, index) => row(slot, tier, index === 0))}
    </div>
  )
  // Consecutive rows of one project in a tier that is not Working: Ready keeps the queue's order, so its
  // runs are wherever two neighbours happen to share a project.
  const runsOf = (list: readonly HeldSlot<Entry>[], tier: Tier) => {
    const out: ReactNode[] = []
    let start = 0
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i]!.item.project.id === list[start]!.item.project.id) continue
      out.push(run(`${tier}:${list[start]!.key}`, list[start]!.item.project, list.slice(start, i), tier))
      start = i
    }
    return out
  }

  const pinned = slots("pinned")
  const ready = slots("ready")
  const readyShown = ready.slice(0, budget.readyShown)
  const readyRest = ready.slice(budget.readyShown)
  const snoozed = slots("snoozed")
  // The snoozed threads opened in the last half hour stay listed under the folded header (prefs
  // `showRecentThreads`); Done today already lists the finished ones.
  const recentSnoozed = showRecentThreads ? recentOf(snoozed, (slot) => slot.item.t.id, now) : []
  const done = slots("done")
  const working = runs.reduce((sum, r) => sum + r.slots.length, 0)
  const waiting = slots("waiting")
  const waitingShown = waiting.slice(0, budget.waitingShown)
  const waitingRest = waiting.slice(budget.waitingShown)
  const nothing = pinned.length + ready.length + working + waiting.length === 0
  // Every schedule of the projects in view, one band: a project's own page and a lens keep theirs too.
  const scheduled = projects.filter((project) => (project.schedules?.count ?? 0) > 0)
  const schedules = scheduled.reduce((sum, project) => sum + project.schedules!.count, 0)

  return (
    <div ref={listRef} data-xq-tiers className="flex min-w-0 flex-col">
      {pinned.length > 0 && (
        <section aria-label="Pinned" data-xq-tier="pinned" data-xq-tier-count={pinned.length}>
          <SectionHeader band="pinned" count={pinned.length} />
          {runsOf(pinned.slice(0, budget.pinnedShown), "pinned")}
          {budget.pinnedShown < pinned.length && (
            <MoreRow
              count={pinned.length - budget.pinnedShown}
              label={`${pinned.length - budget.pinnedShown} more pinned`}
              detail={[...new Set(pinned.slice(budget.pinnedShown).map((slot) => slot.item.project.name))].join(", ")}
              onClick={() => setTierFold("pinned", true)}
            />
          )}
          {open("pinned") && <ShowFewer onClick={() => setTierFold("pinned", false)} />}
        </section>
      )}
      {ready.length > 0 && (
        <section aria-label="Ready" data-xq-tier="ready" data-xq-tier-count={ready.length} className={pinned.length > 0 ? TIER_GAP : ""}>
          <SectionHeader band="ready" count={ready.length} />
          {runsOf(readyShown, "ready")}
          {readyRest.length > 0 && (
            <MoreRow
              count={readyRest.length}
              label={`${readyRest.length} more in the queue`}
              detail={[...new Set(readyRest.map((slot) => slot.item.project.name))].join(", ")}
              onClick={() => onQueuedRow(readyRest[0]!.key)}
            />
          )}
        </section>
      )}
      {working > 0 && (
        <section aria-label="Working" data-xq-tier="working" data-xq-tier-count={working} className={pinned.length + ready.length > 0 ? TIER_GAP : ""}>
          <SectionHeader band="working" count={working} />
          {workingLines(runs, budget, expanded).map((line) =>
            line.kind === "rollup" ? (
              <RunRollup key={line.run.id} project={line.run.project} threads={line.run.slots.map((slot) => slot.item.t)} onExpand={() => setTierFold(`run:${line.run.id}`, true)} />
            ) : (
              <Fragment key={line.run.id}>
                {line.rollBack && <RollBack project={line.run.project} onRoll={() => setTierFold(`run:${line.run.id}`, false)} />}
                {run(line.run.id, line.run.project, line.slots, "working")}
              </Fragment>
            ),
          )}
          {rest.length > 0 && (
            <MoreRow
              count={rest.length}
              label={`${rest.length} more working`}
              detail={[...new Set(rest.map((slot) => slot.item.project.name))].join(", ")}
              onClick={() => setTierFold("working", true)}
            />
          )}
          {open("working") && working > 0 && <ShowFewer onClick={() => setTierFold("working", false)} />}
        </section>
      )}
      {/* WAITING never folds: its header and its first rows are always in view, and the budget counts the
          rest (lib/sidebarBudget.ts). Rows run by project, as Ready's do. */}
      {waiting.length > 0 && (
        <section aria-label="Waiting" data-xq-tier="waiting" data-xq-tier-count={waiting.length} className={pinned.length + ready.length + working > 0 ? TIER_GAP : ""}>
          <SectionHeader band="waiting" count={waiting.length} />
          {runsOf(waitingShown, "waiting")}
          {waitingRest.length > 0 && (
            <MoreRow
              count={waitingRest.length}
              label={`${waitingRest.length} more waiting`}
              detail={[...new Set(waitingRest.map((slot) => slot.item.project.name))].join(", ")}
              onClick={() => setTierFold("waiting", true)}
            />
          )}
          {open("waiting") && waiting.length > WAITING_FLOOR && <ShowFewer onClick={() => setTierFold("waiting", false)} />}
        </section>
      )}
      {nothing && (
        <div data-xq-tiers-empty className="py-1 pl-[44px] pr-1.5 text-[11.5px] leading-[19px] text-muted-50">
          No open threads
        </div>
      )}
      {snoozed.length > 0 && (
        <section aria-label="Snoozed" data-xq-tier="snoozed" data-xq-tier-count={snoozed.length} className={TIER_GAP}>
          <SectionHeader band="snoozed" count={snoozed.length} collapsed={!open("snoozed")} onToggle={() => setTierFold("snoozed", !open("snoozed"))} />
          {runsOf(open("snoozed") ? snoozed : recentSnoozed, "snoozed")}
        </section>
      )}
      {done.length > 0 && (
        <section aria-label="Done today" data-xq-tier="done" data-xq-tier-count={done.length} className={TIER_GAP}>
          <SectionHeader
            band="done"
            label="Done today"
            count={done.length}
            tail={
              <button type="button" data-xq-open-history onClick={() => setCenterTab("history")} className="relative -mx-1 rounded px-1 outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                History
              </button>
            }
          />
          {runsOf(done.slice(0, budget.tailShown), "done")}
          {/* Squeezed to its header, the tail drops this line too: the count and History say the rest. */}
          {budget.tailShown > 0 && done.length > budget.tailShown && (
            <MoreRow
              count={done.length - budget.tailShown}
              label={`${done.length - budget.tailShown} more today`}
              detail={[...new Set(done.slice(budget.tailShown).map((slot) => slot.item.project.name))].join(", ")}
              onClick={() => setTierFold("done", true)}
            />
          )}
          {open("done") && done.length > TAIL_MAX && <ShowFewer onClick={() => setTierFold("done", false)} />}
        </section>
      )}
      {scheduled.length > 0 && (
        // A schedule just created from the prompt box for a project in view: the header flashes once (store.ts
        // flashScheduleCount, ARCHITECTURE.md § Scheduled threads).
        <section
          aria-label="Schedules"
          data-xq-tier="schedules"
          data-xq-tier-count={schedules}
          data-sched-flash={snap.scheduleFlash && scheduled.some((p) => p.id === snap.scheduleFlash!.projectId) ? "" : undefined}
          className={`${TIER_GAP} rounded-md`}
        >
          <SectionHeader band="schedules" count={schedules} attention={scheduled.some((p) => p.schedules?.attention)} collapsed={!open("schedules")} onToggle={() => setTierFold("schedules", !open("schedules"))} />
          {open("schedules") && scheduled.map((project) => <ScheduleRows key={project.id} project={project} count={project.schedules!.count} attention={project.schedules!.attention} />)}
        </section>
      )}
    </div>
  )
}

type Run = { id: string; project: QueuesProject; slots: HeldSlot<Entry>[] }
type WorkingLine = { kind: "rollup"; run: Run } | { kind: "rows"; run: Run; slots: HeldSlot<Entry>[]; rollBack: boolean }

/** Working as the budget draws it: each run a rollup line or its rows, cut at `workingShown` lines. */
function workingLines(runs: readonly Run[], budget: Budget, expanded: ReadonlySet<string>): WorkingLine[] {
  const out: WorkingLine[] = []
  let left = budget.workingShown
  for (const run of runs) {
    if (left <= 0) break
    if (budget.rolled.has(run.id)) {
      out.push({ kind: "rollup", run })
      left--
      continue
    }
    const slots = run.slots.slice(0, left)
    out.push({ kind: "rows", run, slots, rollBack: expanded.has(run.id) && run.slots.length > 1 && slots.length === run.slots.length })
    left -= slots.length
  }
  return out
}

/** Working's threads the budget left off the list. */
function workingRest(runs: readonly Run[], budget: Budget, expanded: ReadonlySet<string>): HeldSlot<Entry>[] {
  const shown = new Set(workingLines(runs, budget, expanded).flatMap((line) => (line.kind === "rollup" ? line.run.slots : line.slots)).map((slot) => slot.key))
  return runs.flatMap((run) => run.slots).filter((slot) => !shown.has(slot.key))
}

/** The space between two tiers: the header's own 4px of top padding plus this reads as a break, where the
 *  rows of one tier sit flush. Measured with the rest of the column on the seeded stack. */
const TIER_GAP = "mt-2"

/**
 * THE COMPRESSION LEVEL the list fits at (lib/sidebarBudget.ts): raised one step per layout pass, before the
 * browser paints, until the list's scroll box stops overflowing or there is nothing left to give up — and
 * started over from nothing whenever what the list holds or the room it has changes, so a list that
 * shrank gets its rows back. Never while the list is held: a re-budget would move rows under the pointer.
 */
/** `extra` is anything else that changes the list's height without changing the input: a project's page's
 *  sub-agent rows. A change re-runs the search. */
function useBudgetLevel(listRef: RefObject<HTMLDivElement | null>, input: BudgetInput, held: boolean, extra: string): number {
  const [level, setLevel] = useState(0)
  const [room, setRoom] = useState(0)
  const signature = `${input.tail}|${input.tailOpen}|${input.ready}|${input.workingOpen}|${input.pinned}|${input.pinnedOpen}|${input.waiting}|${input.waitingOpen}|${input.runs.map((r) => `${r.id}:${r.size}`).join(",")}|${[...input.expanded].join(",")}|${room}|${extra}`
  const settled = useRef<string | null>(null)
  const max = maxLevel(input)
  // The scroll box's height moves with the window and with the prompt box above the list growing a line.
  useEffect(() => {
    const scroller = listRef.current?.closest("[data-xq-rail]")
    if (!scroller) return
    const observer = new ResizeObserver(() => setRoom(Math.round(scroller.clientHeight)))
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [listRef])
  // A BINARY SEARCH for the lowest level that fits, each probe one commit before paint. Levels only ever
  // take lines away, so "fits" is monotonic in the level. It stepped one level a commit until 2026-10-14,
  // and at the heavy load on a 720px screen that was more than React's 50 nested updates: the page threw.
  const search = useRef<{ signature: string; lo: number; hi: number } | null>(null)
  useLayoutEffect(() => {
    if (held) return
    const scroller = listRef.current?.closest("[data-xq-rail]")
    if (!scroller) return
    if (settled.current === signature) return
    // Every level under `lo` overflows; `hi` fits, or is the last level there is.
    if (search.current?.signature !== signature) search.current = { signature, lo: 0, hi: max }
    const range = search.current
    const probe = Math.min(level, max)
    if (scroller.scrollHeight > scroller.clientHeight + 1) range.lo = Math.max(range.lo, probe + 1)
    else range.hi = Math.min(range.hi, probe)
    if (range.lo >= range.hi) {
      settled.current = signature
      if (level !== range.hi) setLevel(range.hi)
      return
    }
    setLevel(Math.floor((range.lo + range.hi) / 2))
  })
  return Math.min(level, max)
}

/**
 * One function from project to its row scope, each scope ONE object per project for the page's life, so the
 * memoized rows are not handed a new one on every poll. A Ready row brings its card into view when the
 * queue is showing it; every other click opens the thread's drawer in place (useOpenThreadInPlace).
 */
function useRowScopes(projects: readonly QueuesProject[], onQueuedRow: (key: string) => number | null): (project: QueuesProject) => RowScope {
  const openInPlace = useOpenThreadInPlace()
  const latest = useRef({ openInPlace, onQueuedRow })
  latest.current = { openInPlace, onQueuedRow }
  const cache = useRef(new Map<string, { signature: string; scope: RowScope }>())
  const focus = projectSlug(useLocation().pathname)
  return useCallback(
    (project: QueuesProject) => {
      const page = project.slug === focus
      const signature = `${project.slug}|${project.name}|${page}`
      const hit = cache.current.get(project.id)
      if (hit && hit.signature === signature) return hit.scope
      const { id, slug, name } = project
      const scope: RowScope = {
        page,
        open: (t) => {
          if (queued(t) && latest.current.onQueuedRow(threadKey(id, t.id)) !== null) return
          latest.current.openInPlace({ slug, id, name }, t.id, displayTitle(t))
        },
      }
      cache.current.set(project.id, { signature, scope })
      return scope
    },
    // `projects` is not read: a scope is keyed on the project it is asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focus, projects.length],
  )
}

/** The row geometry of a thread row (Sidebar.tsx ThreadRow), for the rows this list draws itself. */
const ROW = "group relative flex min-w-0 items-start rounded-md after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON = "flex min-w-0 flex-1 items-start gap-2 rounded-md pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"

/**
 * A PROJECT'S WORKING THREADS AS ONE LINE, when the list has no room for them (lib/sidebarBudget.ts): the
 * project's square, a spinner with how many are working, its name, the titles in grey, and the longest
 * task clock. A click lists them again, and the list keeps them listed until the human rolls them back.
 */
function RunRollup({ project, threads, onExpand }: { project: QueuesProject; threads: readonly ThreadView[]; onExpand: () => void }) {
  const now = useNowMs()
  const clock = threads.map((t) => ({ t, at: Date.parse(t.statusSince ?? "") })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at)[0]
  const elapsed = clock ? statusElapsed(clock.t, now) : undefined
  const agents = threads.reduce((sum, t) => sum + (t.subAgents ?? []).filter((s) => s.state === "running").length, 0)
  const label = `${threads.length} working in ${project.name}${agents ? `, ${agents} sub-agents` : ""}. Show them`
  return (
    <div data-xq-rollup={project.id} data-xq-rollup-count={threads.length} data-xq-thread-row className={ROW}>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-5">
        <span className="absolute left-[6px] top-[7.5px] flex">
          <ProjectSquare project={project.card ?? squareCard(project)} size={12} />
        </span>
      </span>
      <button type="button" data-xq-reshape onClick={onExpand} aria-label={label} title={threads.map(displayTitle).join("\n")} className={ROW_BUTTON}>
        <span data-xq-indicator className="flex h-[19px] w-4 shrink-0 items-center justify-center">
          <BoxSpinner>
            <span className="text-[9px] font-semibold tabular-nums leading-none text-fg/80">{threads.length}</span>
          </BoxSpinner>
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 text-[13px] font-semibold leading-[19px] text-fg/90">{project.name}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] leading-[19px] text-muted-70">{threads.map(displayTitle).join(", ")}</span>
          </span>
          {elapsed && <span className="shrink-0 text-[10.5px] tabular-nums leading-[19px] text-muted-55">{elapsed}</span>}
        </span>
      </button>
    </div>
  )
}

/** Over a run the human expanded out of a rollup: the way back to one line. */
function RollBack({ project, onRoll }: { project: QueuesProject; onRoll: () => void }) {
  return (
    <div className="flex justify-end pr-1.5">
      <button type="button" data-xq-reshape data-xq-rollback={project.id} onClick={onRoll} className="rounded px-1 text-[10.5px] leading-[15px] text-muted-50 outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
        Show {project.name} as one line
      </button>
    </div>
  )
}

/** Under a tier the human opened past its budget: the way back to the budget's list. */
function ShowFewer({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex justify-end pr-1.5">
      <button type="button" data-xq-reshape data-xq-show-fewer onClick={onClick} className="rounded px-1 text-[10.5px] leading-[15px] text-muted-50 outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
        Show fewer
      </button>
    </div>
  )
}

/** The rest of a tier the budget took, in words: what is not listed and whose it is. */
function MoreRow({ count, label, detail, onClick }: { count: number; label: string; detail: string; onClick: () => void }) {
  return (
    <div data-xq-tier-more data-xq-more-count={count} className={ROW}>
      <button type="button" onClick={onClick} className={ROW_BUTTON}>
        <span className="flex h-[19px] w-4 shrink-0 items-center justify-center text-[11px] text-muted-50">…</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[12px] leading-[19px] text-muted">{label}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] leading-[19px] text-muted-50">{detail}</span>
        </span>
      </button>
    </div>
  )
}
