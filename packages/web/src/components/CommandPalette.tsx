import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { Command } from "cmdk"
import { useQuery } from "@tanstack/react-query"
import { Repeat } from "lucide-react"
import { store, openThread, openNewThread, pushDrawer, pushScheduleDrawer, topThreadSlug, closeDrawersById } from "../store.ts"
import { scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { rpc } from "../api/rpc.ts"
import { asThreads } from "../hooks.ts"
import { sortThreads, displayName, displayTitle } from "../groups.ts"
import { isCrossProjectPath } from "../lib/base-path.ts"
import { aboveDrawersZ } from "../lib/overlaySurface.ts"
import { startTour } from "../lib/tour.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import type { BoardSnapshot, ScheduleView, ThreadSearchEntry } from "@ntwine/shared"

// Cmd+K palette: fuzzy-jump to any thread (over title + slug, grouped like the sidebar) plus the
// common actions. cmdk owns the filtering; we set each item's `value` to the text we want matched.
//
// A MODAL RADIX DIALOG, from the same @radix-ui/react-dialog every drawer uses. It was a plain z-[60] div
// outside Radix's layer stack until 2026-10-01, which a thread drawer made unusable: below 800px (and at any
// width in an editor's sidebar) the thread is a modal Radix dialog, so its focus trap kept the keyboard in
// the thread — typing "pricing" left the input empty — its `body{pointer-events:none}` killed every click on
// the palette, and the first Escape closed the THREAD under the still-open palette. On a desktop the Escape
// order was the same and Tab walked out into the page. As a Radix layer it is the topmost one: its scope
// pauses the thread's trap, its content takes the pointer, Tab loops inside it, and Escape is its own.
export function CommandPalette() {
  const snap = useSnapshot(store)
  const [search, setSearch] = useState("")
  // The palette's one sub-page: "Schedules", every project's (ARCHITECTURE.md § Scheduled threads). Backspace on
  // an empty query climbs back out, cmdk's own convention for pages.
  const [page, setPage] = useState<"root" | "schedules">("root")
  const inputRef = useRef<HTMLInputElement>(null)
  const openInPlace = useOpenThreadInPlace()
  // Captured as the palette opens, so closing it can hand focus back (see onCloseAutoFocus).
  const openerRef = useRef<HTMLElement | null>(null)

  // Reset the query each time it opens so a stale filter never hides everything.
  useEffect(() => {
    if (snap.showPalette) {
      setSearch("")
      setPage("root")
    }
  }, [snap.showPalette])

  if (!snap.showPalette) return null
  // Read only once the palette is open: a closed palette that read the board by reference re-rendered on
  // every delta of every thread (see DrawerStack).
  const board = snap.board as BoardSnapshot | null

  const threads = sortThreads(asThreads(board?.threads ?? []))
  // "Current thread" = the topmost open thread drawer (there is no nav selection anymore).
  const topSlug = snap.drawers.length ? [...snap.drawers].reverse().find((d) => d.kind === "thread")?.slug : undefined
  const selected = board?.threads.find((t) => t.id === topSlug)
  // Over every open drawer (lib/overlaySurface.ts aboveDrawersZ): a fixed z-[60] lost to the fifth layer.
  const z = aboveDrawersZ(snap.drawers.length)

  function close() {
    store.showPalette = false
  }

  function run(fn: () => void) {
    fn()
    close()
  }

  function jump(slug: string) {
    openThread(slug) // side drawer: chat, or the ntwine doc for a never-spawned thread
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-scrim-50" style={{ zIndex: z }} />
        {/* A modal dialog (Radix: role="dialog", data-state="open"), so assistive tech reads it as one and the
            number keys (lib/questionKeys.ts) treat it as owning the keyboard — with the input blurred, a
            digit must not answer a card behind the palette. */}
        <RadixDialog.Content
          aria-describedby={undefined}
          // Escape closes ONLY the palette. Radix dismisses it from a document-capture listener; without
          // this the key went on to DrawerStack's window listener, which would unwind a drawer under it too.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
            inputRef.current?.focus({ preventScroll: true })
          }}
          // Back to where the palette was opened from — unless the palette's own action put focus somewhere
          // on purpose (a jump focuses the thread it opened), which this must not undo.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const active = document.activeElement
            if (active && active !== document.body) return
            if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true })
          }}
          className="fixed left-1/2 top-[12vh] w-[560px] max-w-[92vw] -translate-x-1/2 outline-none"
          style={{ zIndex: z + 1 }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <Command
            label="Command palette"
            className="w-full rounded-lg border border-border bg-panel shadow-2xl overflow-hidden"
            // cmdk defaults to matching the DOM text; we drive matching via each item's `value` instead.
            filter={(value: string, query: string, _keywords?: string[]) => (value.toLowerCase().includes(query.toLowerCase()) ? 1 : 0)}
          >
            <Command.Input
              ref={inputRef}
              value={search}
              onValueChange={setSearch}
              onKeyDown={(event) => {
                if (page !== "root" && event.key === "Backspace" && !search) {
                  event.preventDefault()
                  setPage("root")
                }
              }}
              // The whole sentence needs ~300px of box. Narrower (a 300px sidebar) it clipped mid-word, "…run a
              // comman", and no ellipsis can help: Chrome draws none on the placeholder of a FOCUSED input, and
              // this one always is. So a narrow palette says the half that names what you type. `text-ellipsis`
              // still covers a long query once focus has left the box.
              placeholder={page === "schedules" ? "Find a schedule…" : narrowPalette() ? "Jump to a thread…" : "Jump to a thread or run a command…"}
              className="w-full px-4 h-12 bg-transparent outline-none border-b border-border text-sm text-ellipsis placeholder:text-muted"
            />
            <Command.List className="max-h-[52vh] overflow-y-auto py-1.5">
              {page === "schedules" ? (
                <SchedulesPage onOpen={(schedule) => run(() => pushScheduleDrawer(schedule.id, schedule.projectId))} />
              ) : (
              <>
              <Command.Empty className="px-4 py-6 text-center text-sm text-muted">No matches.</Command.Empty>

              <Command.Group heading="Actions" className="cmdk-group">
                {/* "Home" died with the Home view (the dispatch box is always visible on the queue);
                    "New thread" opens the anywhere-modal. Queue closes every drawer, back to the page. */}
                <Item value="new thread create home" onSelect={() => run(() => openNewThread())}>
                  New thread
                </Item>
                <Item value="queue todos inbox pending" onSelect={() => run(() => closeDrawersById(store.drawers.map((d) => d.id)))}>
                  Queue
                </Item>
                <Item value="open settings preferences" onSelect={() => run(() => (store.showSettings = true))}>
                  Open settings
                </Item>
                <Item value="keyboard shortcuts keys hotkeys keybindings rebind" onSelect={() => run(() => (store.showShortcuts = true))}>
                  Keyboard shortcuts
                </Item>
                <Item value="take the tour onboarding help introduction walkthrough" onSelect={() => run(startTour)}>
                  Take the tour
                </Item>
                <Item value="time limit for running threads deadline wrap up restart reboot shutdown all remove clear lift" onSelect={() => run(() => (store.showRunningTimeLimit = true))}>
                  Time limit for running threads…
                </Item>
                <Item
                  value="schedules scheduled recurring repeat every cron routines"
                  onSelect={() => {
                    setSearch("")
                    setPage("schedules")
                  }}
                >
                  Schedules
                </Item>
                {selected && (
                  <>
                    <Item
                      value={`open details drawer doc ${displayTitle(selected)}`}
                      onSelect={() => run(() => { const t = topThreadSlug(); if (t) pushDrawer("doc", t) })}
                    >
                      {/* "Open", honestly — closing the palette-pushed layer is Esc's job, not a toggle. */}
                      Open thread details
                    </Item>
                    <Item
                      value={`mark complete done ${displayTitle(selected)}`}
                      onSelect={() => run(() => rpc.markComplete({ slug: selected.id }).catch(() => {}))}
                    >
                      Mark “{displayTitle(selected)}” complete
                    </Item>
                    <Item
                      value={`mark read ${displayTitle(selected)}`}
                      onSelect={() => run(() => rpc.markRead({ slug: selected.id }).catch(() => {}))}
                    >
                      Mark “{displayTitle(selected)}” read
                    </Item>
                  </>
                )}
              </Command.Group>

              {/* The page's board has not arrived yet (an editor's sidebar draws its rows from another feed, so
                  it can paint them first): say so, rather than listing Actions alone as if there were no threads. */}
              {!board && <Command.Loading className="px-4 py-1.5 text-[12px] text-muted">Loading threads…</Command.Loading>}

              {threads.length > 0 && (
                // On the cross-project page the palette searches the FOCUSED project only (the page project) —
                // say whose, since in All projects the page around it shows every project's.
                <Command.Group heading={isCrossProjectPath() ? `Threads in ${board?.projectName ?? board?.projectLabel ?? "this project"}` : "Threads"} className="cmdk-group">
                  {threads.map((t) => (
                    // The handle AND the stored words, so "shell bud" finds `shell-budgets` as readily as "shell-b".
                    <Item key={t.id} value={`${displayTitle(t)} ${displayName(t)} ${t.id}`} onSelect={() => run(() => jump(t.id))}>
                      {/* The title is what a reader scans for, so it keeps the room: the slug gives way first
                          (at most 40% of the row) and goes entirely under 360px, where it left a long-slugged
                          thread 0px of title in a 300px sidebar. */}
                      <span className="min-w-0 flex-1 truncate">{displayTitle(t)}</span>
                      <span className="ml-auto min-w-0 max-w-[40%] truncate text-[11px] text-muted-70 max-[360px]:hidden">{t.id}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              {/* Every OTHER project's threads, open and Done, from the server's search: the board above
                  is the page project's alone. Picked, one opens in place the way a card's title does. */}
              <EverywhereGroup
                search={search}
                exceptProject={board?.projectSlug}
                onOpen={(hit) => run(() => openInPlace({ id: hit.projectId, slug: hit.projectSlug, name: hit.projectName }, hit.thread.id, displayTitle(hit.thread)))}
              />
              </>
              )}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * EVERY SCHEDULE ON THE MACHINE, one row each — its title, its project, and when it runs next — and a pick
 * opens its drawer. Through the page's client with `allProjects`: the server answers for every open project,
 * and each row names its own, which the drawer then reads through.
 */
function SchedulesPage({ onOpen }: { onOpen: (schedule: ScheduleView) => void }) {
  const now = useNowMs()
  const list = useQuery({ queryKey: scheduleKeys.all(), queryFn: () => rpc.listSchedules({ allProjects: true }), staleTime: 5_000 })
  if (list.isLoading) return <Command.Loading className="px-4 py-1.5 text-[12px] text-muted">Loading schedules…</Command.Loading>
  const schedules = list.data ?? []
  if (schedules.length === 0) {
    return (
      <div data-palette-schedules-empty className="px-4 py-6 text-center text-sm text-muted">
        {list.isError ? "Couldn't read the schedules." : "Nothing scheduled. In the prompt box, try “every Monday at 9am triage new issues”."}
      </div>
    )
  }
  return (
    <>
      <Command.Empty className="px-4 py-6 text-center text-sm text-muted">No matches.</Command.Empty>
      <Command.Group heading="Schedules" className="cmdk-group">
        {schedules.map((schedule) => (
          <Item key={schedule.id} value={`${schedule.title} ${schedule.describe} ${schedule.projectName} ${schedule.id}`} onSelect={() => onOpen(schedule)}>
            <Repeat size={12} aria-hidden className="shrink-0 text-muted-70" />
            <span className="min-w-0 flex-1 truncate">
              {schedule.title}
              <span className="ml-1.5 text-[12px] text-muted-70">{schedule.describe}</span>
            </span>
            <span className="ml-auto min-w-0 max-w-[30%] shrink-0 truncate text-[11px] text-muted-70 max-[360px]:hidden">{schedule.projectName}</span>
            <span className={`w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums ${schedule.attention ? "text-attention-soft" : "text-muted-70"}`}>{scheduleNextLabel(schedule, now)}</span>
          </Item>
        ))}
      </Command.Group>
    </>
  )
}

/** How long the query has to hold still before the palette asks the server. */
const EVERYWHERE_DEBOUNCE_MS = 150

/**
 * THREADS IN EVERY OTHER PROJECT whose name or slug contains the query (`threadsSearch`), once it is two
 * characters long. The page project's own threads are left out — the board group above lists them, and
 * listing one twice reads as two threads. Done ones say so.
 *
 * cmdk filters every item by its `value` after we render it, and the server matched names the row does
 * not show (a former name, the worker's own title). So each value LEADS with the query as typed,
 * which keeps it through cmdk's substring filter, and ends with its project and slug, which keeps it
 * unique.
 */
function EverywhereGroup({ search, exceptProject, onOpen }: { search: string; exceptProject: string | undefined; onOpen: (hit: ThreadSearchEntry) => void }) {
  const [query, setQuery] = useState(search.trim())
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), EVERYWHERE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])
  const enabled = query.length >= 2
  const found = useQuery({ queryKey: ["threadsSearch", query, 30], queryFn: () => rpc.threadsSearch({ query, limit: 30 }), enabled, staleTime: 5_000 })
  if (!enabled || search.trim() !== query) return null
  const hits = (found.data ?? []).filter((hit) => hit.projectSlug !== exceptProject)
  if (hits.length === 0) return null
  return (
    <Command.Group heading="Other projects" className="cmdk-group">
      {hits.map((hit) => (
        <Item key={`${hit.projectId}/${hit.thread.id}`} value={`${search} ${hit.projectId}/${hit.thread.id}`} onSelect={() => onOpen(hit)}>
          <span className={`min-w-0 flex-1 truncate ${hit.done ? "text-muted-70" : ""}`}>{displayTitle(hit.thread)}</span>
          {hit.done && <span className="shrink-0 text-[11px] text-muted-60">Done</span>}
          <span className="ml-auto min-w-0 max-w-[35%] shrink-0 truncate text-[11px] text-muted-70 max-[360px]:hidden">{hit.projectName}</span>
        </Item>
      ))}
    </Command.Group>
  )
}

// The width under which the palette (92vw) is too narrow for its full placeholder — and for each row's slug
// beside its title (the slug's `max-[360px]:hidden`).
function narrowPalette(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 360
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="mx-1.5 px-2.5 py-1.5 rounded flex items-center gap-2 text-sm cursor-pointer data-[selected=true]:bg-panel-2 data-[selected=true]:text-fg text-muted"
    >
      {children}
    </Command.Item>
  )
}
