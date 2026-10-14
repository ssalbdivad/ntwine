// MOUNTING: the center column's History tab body. Render `<HistoryView projectIds={lens} onOpen={open} />`
// inside a scrolling parent (it does not scroll itself; its load-more sentinel watches the viewport),
// with `projectIds` the page's project lens (undefined = every project) and `onOpen` opening the entry's
// thread in place, e.g. `(e) => openInPlace({ id: e.projectId, slug: e.projectSlug, name: e.projectName }, e.thread.id, displayTitle(e.thread))`.
//
// HISTORY — every Done thread in the lens, newest rest first, grouped by day, each entry carrying its
// done card's ledger (plans/all-projects-first.md § Done, easily) so the list answers "what shipped this
// week" without opening a thread. Server side: `projectsDone` (paged by rest time, cursor in
// `nextBefore`) and `threadsSearch` for the search box (packages/server/src/router.ts).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import type { ProjectCard, ProjectQueue, ProjectThreadEntry, ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle, lastActiveLabelAt } from "../groups.ts"
import { ageSpan, relativeAge } from "../lib/activityTime.ts"
import { timeBreakLabel } from "../lib/timeBreaks.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useMarkdownHtml, MarkdownScopeContext, type MarkdownScope } from "../lib/useMarkdown.ts"
import { crossProjectHref } from "../lib/base-path.ts"
import { projectsQueuesQuery } from "../lib/projectsQueuesRead.ts"
import { registeredDoneBody } from "../lib/registeredDone.ts"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QUEUE_WRAP } from "./TranscriptCard.tsx"

export type HistoryEntry = ProjectThreadEntry

const PAGE_SIZE = 50
/** Search asks for more than a page shows: it is filtered to Done (and the lens) after it lands. */
const SEARCH_LIMIT = 200
const SEARCH_DEBOUNCE_MS = 150

export function HistoryView({ projectIds, onOpen }: { projectIds?: readonly string[]; onOpen: (entry: HistoryEntry) => void }) {
  const [search, setSearch] = useState("")
  const query = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS)
  const [external, setExternal] = useState(false)
  // Keyed by contents: a caller that rebuilds the array each render must not refetch or re-filter.
  const lensKey = projectIds ? projectIds.join("\n") : null
  const lens = useMemo(() => (lensKey === null ? undefined : lensKey ? lensKey.split("\n") : []), [lensKey])

  const pages = useInfiniteQuery({
    queryKey: ["projectsDone", lensKey, external],
    queryFn: ({ pageParam }) => rpc.projectsDone({ limit: PAGE_SIZE, external, ...(lens ? { projectIds: lens } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore,
    enabled: !query,
  })
  const found = useQuery({
    queryKey: ["threadsSearch", query, SEARCH_LIMIT],
    queryFn: () => rpc.threadsSearch({ query, limit: SEARCH_LIMIT }),
    enabled: query.length > 0,
    staleTime: 5_000,
  })

  const entries: HistoryEntry[] = useMemo(() => {
    if (query) {
      const inLens = lens ? new Set(lens) : undefined
      return (found.data ?? []).filter((hit) => hit.done && (!inLens || inLens.has(hit.projectId)))
    }
    return pages.data?.pages.flatMap((page) => page.entries) ?? []
  }, [query, found.data, pages.data, lens])

  const cards = useProjectCards()
  const scopes = useProjectScopes()
  const now = useNowMs()
  const groups = useMemo(() => groupByDay(entries, new Date(now)), [entries, now])

  const loading = query ? found.isLoading : pages.isLoading
  const failed = query ? found.isError : pages.isError
  const more = !query && pages.hasNextPage
  const sentinel = useLoadMore(more && !pages.isFetchingNextPage, () => void pages.fetchNextPage())

  return (
    <div data-history className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-3">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-control-border bg-panel px-2.5 focus-within:border-border-strong">
          <Search size={13} aria-hidden className="shrink-0 text-muted-60" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search done threads"
            aria-label="Search done threads"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted-60"
          />
        </label>
        <button
          type="button"
          role="checkbox"
          aria-checked={external}
          onClick={() => setExternal((on) => !on)}
          title="Include sessions ntwine did not start"
          className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-muted-70 hover:bg-hover hover:text-fg"
        >
          <span aria-hidden className={`flex size-3 items-center justify-center rounded-[3px] border ${external ? "border-accent bg-accent" : "border-control-border"}`}>
            {external && <svg viewBox="0 0 10 10" className="size-2.5 text-bg"><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </span>
          External
        </button>
      </div>

      {loading && <div className="px-2 py-4 text-[12px] text-muted-60">Loading…</div>}
      {failed && !loading && <div className="px-2 py-4 text-[12px] text-muted-70">Couldn't load history.</div>}
      {!loading && !failed && entries.length === 0 && (
        <div className="px-2 py-6 text-center text-[13px] text-muted-70">{query ? "No done threads match." : "Nothing done yet."}</div>
      )}

      {groups.map((group) => (
        <section key={group.key} data-history-day={group.key} className="flex flex-col">
          <h3 className="sticky top-0 z-[1] bg-bg px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-70">{group.label}</h3>
          {group.entries.map((entry) => (
            <MarkdownScopeContext.Provider key={`${entry.projectId}/${entry.thread.id}`} value={scopes.get(entry.projectId) ?? fallbackScope(entry, cards.get(entry.projectId))}>
              <HistoryRow entry={entry} card={cards.get(entry.projectId)} now={now} onOpen={onOpen} />
            </MarkdownScopeContext.Provider>
          ))}
        </section>
      ))}

      {more && <div ref={sentinel} aria-hidden className="h-px" />}
      {pages.isFetchingNextPage && <div className="px-2 py-2 text-[12px] text-muted-60">Loading…</div>}
    </div>
  )
}

/** One Done thread: its project's square, title, project name and rest age, then its done card's ledger. */
function HistoryRow({ entry, card, now, onOpen }: { entry: HistoryEntry; card: ProjectCard | undefined; now: number; onOpen: (entry: HistoryEntry) => void }) {
  const { thread } = entry
  const title = displayTitle(thread)
  const at = lastActiveLabelAt(thread)
  const span = ageSpan(at, now)
  const ledger = ledgerOf(thread)
  // The whole row opens the thread, except a click that lands on a link or the ledger's own toggle.
  const open = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("a, button:not([data-history-open])")) return
    onOpen(entry)
  }
  return (
    <div data-history-entry={`${entry.projectId}/${thread.id}`} onClick={open} className="group cursor-pointer rounded-md px-2 py-1.5 hover:bg-hover">
      <div className="flex min-w-0 items-baseline gap-2">
        {/* On the title's cap band, the way ProjectChip seats its square: lowered by half its height less half a cap. */}
        <span className="flex shrink-0 self-baseline translate-y-[calc(7px_-_0.5cap)]">
          <ProjectSquare project={card ?? cardOf(entry)} size={14} />
        </span>
        <button type="button" data-history-open onClick={() => onOpen(entry)} className="min-w-0 truncate text-left text-[13px] leading-[19px] text-fg/90 outline-none focus-visible:underline">
          {title}
        </button>
        <span className="min-w-0 shrink truncate text-[12px] text-muted-60">{entry.projectName}</span>
        {thread.foreign && <span className="shrink-0 text-[11px] text-muted-55">External</span>}
        {span && at && (
          <time dateTime={at} title={relativeAge(at, now) ?? undefined} className="ml-auto shrink-0 pl-2 text-[10.5px] leading-none tabular-nums text-muted-55">
            {span}
          </time>
        )}
      </div>
      {ledger && <Ledger body={ledger} />}
    </div>
  )
}

/** The done card's body, clamped to three lines with a toggle when it runs longer. */
function Ledger({ body }: { body: string }) {
  const html = useMarkdownHtml(body)
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [html, open])
  if (!html) return null
  return (
    // 22px: the title's left edge (the 14px square plus the row's 8px gap), so the ledger hangs under the title.
    <div className="card-md pl-[22px] text-fg/75">
      {/* About three lines: three bullets of the card scale (20px lines, 26px apart as list items) end near
          76px; prose runs 20px a line, so its fourth line starts there and the fade takes it. */}
      <div ref={box} className={open ? "" : `max-h-[76px] overflow-hidden ${overflows ? "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
        <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />
      </div>
      {(overflows || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 text-[12px] text-muted-60 hover:text-fg">
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  )
}

/** The ledger a Done thread signed off with, or nothing: only a done card has one, and one the human has
 *  written past since is old news (lib/registeredDone.ts registeredDoneBody). */
function ledgerOf(thread: ThreadView): string | null {
  const fence = thread.lastFence
  if (!fence || fence.kind !== "done") return null
  const body = registeredDoneBody(fence).trim()
  return body || null
}

export interface HistoryDay {
  key: string
  label: string
  entries: HistoryEntry[]
}

/** Consecutive entries on one local calendar day, named the way the transcript's time breaks name a day:
 *  Today, Yesterday, a weekday this week, then a date. Entries arrive newest first, so a day is one run. */
export function groupByDay(entries: readonly HistoryEntry[], now: Date): HistoryDay[] {
  const out: HistoryDay[] = []
  for (const entry of entries) {
    const at = lastActiveLabelAt(entry.thread)
    const ms = at ? Date.parse(at) : NaN
    const key = Number.isFinite(ms) ? new Date(ms).toDateString() : "undated"
    const last = out.at(-1)
    if (last?.key === key) {
      last.entries.push(entry)
      continue
    }
    out.push({ key, label: key === "undated" ? "Undated" : timeBreakLabel(at!, "day", now).day ?? key, entries: [entry] })
  }
  return out
}

/** Every registered project's card by id, for its square. */
function useProjectCards(): Map<string, ProjectCard> {
  const list = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  return useMemo(() => new Map((list.data ?? []).map((card) => [card.id, card])), [list.data])
}

/** Each open project's markdown scope (its repo for `#123`, its folder for relative paths), read from the
 *  queues poll the page already runs. Never fetched from here: a project the poll has not answered for
 *  falls back to its card's folder and no repo. */
function useProjectScopes(): Map<string, MarkdownScope> {
  const queues = useQuery({ ...projectsQueuesQuery, enabled: false })
  return useMemo(() => new Map((queues.data ?? []).map((queue: ProjectQueue) => [queue.projectId, {
    projectId: queue.projectId,
    repo: queue.githubRepo ?? null,
    appPath: crossProjectHref(encodeURIComponent(queue.projectSlug)),
    projectSlug: queue.projectSlug,
    baseDir: queue.projectDir,
    homeDir: queue.homeDir,
  }])), [queues.data])
}

function fallbackScope(entry: HistoryEntry, card: ProjectCard | undefined): MarkdownScope {
  return {
    projectId: entry.projectId,
    repo: null,
    appPath: crossProjectHref(encodeURIComponent(entry.projectSlug)),
    projectSlug: entry.projectSlug,
    ...(card?.path ? { baseDir: card.path } : {}),
  }
}

/** A square for a project the list has not answered for (lib/allQueues.ts squareCard's fallback). */
function cardOf(entry: HistoryEntry): ProjectCard {
  return { id: entry.projectId, slug: entry.projectSlug, name: entry.projectName, path: "", lastOpenedAt: "", stale: false, iconStatus: "unknown" }
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** A sentinel that calls `load` whenever it scrolls within 400px of view while `armed`. */
function useLoadMore(armed: boolean, load: () => void): (el: HTMLDivElement | null) => void {
  const latest = useRef(load)
  latest.current = load
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el || !armed) return
    const observer = new IntersectionObserver((seen) => { if (seen.some((s) => s.isIntersecting)) latest.current() }, { rootMargin: "400px 0px" })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el, armed])
  return setEl
}
