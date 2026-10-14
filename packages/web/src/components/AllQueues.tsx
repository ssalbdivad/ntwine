// THE PAGE — one project's list and queue, or every project's: `/project/<slug>` or `/all`, showing its
// VIEW (lib/pageView.ts).
//
// FOCUSED ON A PROJECT — its board, `/project/<slug>`, the default view since 2026-10-06 — the list on the
// left is that project and the queue on the right is its cards, and the prompt box dispatches into it. ALL
// PROJECTS — `/all`, one click away (the switcher's first entry, the board's home crumb), and the bare `/`
// from 2026-09-30 until then — is every project's list and ONE queue across all of them. The two are
// the same page drawn from the same parts, not two UIs: the list (TierList.tsx) is identical in both, and
// focus mode is All projects with one project in it and the prompt box's picker gone.
//
// It is laid out as a project's own board was, one level up — the board was a floating sidebar beside a
// 720px queue, until 2026-09-28 when this page replaced it. The list on the left is the view's THREADS by
// band, every project's together, each row wearing its project's square (TierList.tsx), under a dock of
// the projects themselves (ProjectDock.tsx). The queue on the right is a column of cards in the order each card entered it; showing
// All projects it is ONE queue across every project (David 2026-09-28: "One queue across all
// projects"), each card wearing its project's chip (AllQueuesCard.tsx ProjectChip). It was one LANE per
// project, in rail order, until then, and a project listed above the one being read put its whole lane
// on top of the card the operator was reading the moment its first thread came to rest.
//
// NOTHING HERE LEAVES THE PAGE. There is no project page to leave for (routes.tsx), and fullscreen is a
// choice in a drawer's own menu (ThreadMenu.tsx), not a door on a card. The page is BOUND to one project
// — the page project: the prompt box at the top of the column dispatches into it, and a thread of it opens
// in the page's drawer stack, in place. Focused, that is the view's project; showing All projects, it is
// the box's own choice (the PICK, chosen in its bottom strip). Opening a thread of ANOTHER project moves
// it to that project for as long as the drawer is open (`/all/<slug>/thread/<t>`, useOpenThreadInPlace),
// so every thread on the page is one click from its full transcript without leaving the page, and closing
// the drawer returns home to the view.
//
// THE DRILL-DOWN, three steps, each one click, none of them leaving:
//   1. the card — the handoff's opening lines, the questions, a reply box, Snooze and Mark as done;
//   2. "Show more" — the whole handoff, in place;
//   3. the card's title (or a rail row) — the thread's drawer, with its whole transcript and composer.
// (A card's ↗ and a project's "…" → Open board were doors to that project's board until 2026-09-28.)
//
// WHAT THE RAIL AND THE CARDS MUST NEVER DO is ask the page which project anything belongs to. The page
// project is only what the page is BOUND to, and they may show every project. Every read they make is either machine-wide
// (`projectsList`, `projectsQueues`) or carries its project explicitly, and every action goes through
// that project's own client (`projectRpc`). See AllQueuesCard.tsx for the card's half of the same rule.
// The prompt box and the drawers are the page project's, which is exactly what they should be.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, Inbox } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ProjectCard, ProjectQueue } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { projectsQueuesQuery, readStartedAt } from "../lib/projectsQueuesRead.ts"
import { liveQueue, mergedQueue, overlayQueues, projectMarkdownScope, queuesProjects, threadKey, type QueueEntry, type QueuesProject } from "../lib/allQueues.ts"
import { innerPath, projectSlug } from "../lib/base-path.ts"
import { rememberCrossProjectFocus, stepPick } from "../lib/crossProject.ts"
import { setFaviconBadge } from "../lib/faviconBadge.ts"
import { ALL_PROJECTS, homeHref, projectViewHref, usePageView, viewHref, viewKey } from "../lib/pageView.ts"
import { carryDispatchDraft, routeDispatchDraft } from "../lib/scheduleDraftState.ts"
import { QUEUE_CARD_VIEWPORT_TOP, registerRoutedLanding, resolveRoutedThread, showToast, slugsInThreadDrawers, store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { MarkdownScopeContext } from "../lib/useMarkdown.ts"
import { stableQueue, type QueueSlot } from "../lib/stableQueue.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { pinOverlayQueues, usePinOverrides } from "../lib/optimisticPin.ts"
import { glideTo, gliding, useViewportLock } from "../lib/viewportLock.ts"
import { drawCardNow } from "../lib/cardVisibility.ts"
import { holdQueueCardLanding } from "../lib/queueLandingHold.ts"
import { pageScrollY } from "../lib/pageScrollLock.ts"
import { isPageKey, registerQueueCursor, releaseAutoOpened, runThreadCommand, useShortcut } from "../lib/keyboardRuntime.ts"
import { runExternalOpen } from "../lib/externalOpen.ts"
import { PROJECT_STEP_CHORDS, detectPlatform, formatChord, parseChord } from "../lib/keybindings.ts"
import { displayTitle } from "../groups.ts"
import { AllQueuesCard, useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { HistoryView } from "./HistoryView.tsx"
import { ProjectDock } from "./ProjectDock.tsx"
import { setCenterTab, useCenterTab } from "../lib/centerTab.ts"
import { useLens } from "../lib/lens.ts"
import { QuotaAlerts } from "./QuotaAlert.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { isLimitPaused } from "../lib/limitPause.ts"
import { deliverProjectFollowUp } from "../lib/projectFollowUp.ts"
import { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"
import { ProjectSquare, warmProjectIcon } from "./ProjectSquare.tsx"
import { SIDEBAR_COLUMN_CLASS, SIDEBAR_SLOT_CLASS } from "./Sidebar.tsx"
import { BandLabel } from "./BandLabel.tsx"
import { homeOf, shortPath, useAddProject } from "./ProjectActions.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { ThreadConnector } from "./ThreadConnector.tsx"
import { DispatchForm, type DispatchDirs } from "./NewThreadModal.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { ProjectSwitcher, type SwitcherProject } from "./ProjectSwitcher.tsx"
import { TierList } from "./TierList.tsx"
import { BoardIdentity } from "./BoardIdentity.tsx"
import { isAsk } from "../lib/phonePage.ts"
import { setCrossProjectMentions } from "../lib/mentionAutolink.ts"
import { readingLine } from "../lib/readingLine.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { PhonePage } from "./PhonePage.tsx"
import { SidebarPage } from "./SidebarPage.tsx"
import { embedded, postToHost } from "../lib/embed.ts"

/** How often the page re-reads every project while it is SHOWING every project. The rail's badges poll at
 *  5s; this is the page the operator is looking AT, so it runs a little faster — the read is the servers'
 *  cached snapshots. */
const POLL_MS = 3_000
/**
 * How often a project's own board re-reads the OTHER projects (P12, plans/upstream-superset.md §2: the
 * all-projects poll runs only while All projects is showing). On a project board the page project is
 * drawn from its live board (`liveQueue`), so the poll is left with what the switcher's menu lists — every
 * other project's counts, the stand-in for upstream's project rail — and the project the page just LEFT
 * (useDepartedQueue). A slow cadence rather than a read when the switcher opens: a menu whose counts were
 * fetched on open would redraw under the pointer a beat after it appeared, and its trigger is the page's
 * title, opened often in passing. 30s is the rail's own 5s cadence relaxed for counts nobody is watching;
 * react-query also re-reads when the window regains focus, so a board left in the background is current
 * the moment it is looked at again. Everything this tab does is invalidated by its own act regardless.
 */
const OTHER_PROJECTS_POLL_MS = 30_000
/** The card's exit fade (styles.css `.ntwine-card-slot`, which must stay in step with it). */
const EXIT_MS = 200
/**
 * How long an acted-on card stays gone while the server catches up. Past this, a thread that is STILL
 * queued comes back — the action evidently did not take — rather than staying hidden on the strength of
 * a click.
 */
const REAPPEAR_MS = 8_000
/** How long the prompt box's stand-in waits for the focused project's board before saying so. */
const COMPOSER_WAIT_MS = 6_000

const entryKey = ({ project, thread }: QueueEntry): string => threadKey(project.id, thread.id)
const xqCardKey = (slot: HTMLElement): string | undefined => slot.dataset.xqCard

/** The key of the card whose text box has the keyboard, if one does. */
function typingInCard(): string | undefined {
  const focused = document.activeElement
  if (!(focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || (focused instanceof HTMLElement && focused.isContentEditable))) return undefined
  const slot = focused.closest<HTMLElement>("[data-xq-card]")
  return slot ? xqCardKey(slot) : undefined
}

/**
 * The keys of the cards the human is otherwise engaged with: the one holding the focus (a button or
 * disclosure they just clicked), the one their text selection is in, and the one under the pointer.
 */
function engagedCards(): ReadonlySet<string> {
  const keys = new Set<string>()
  const add = (node: Node | null | undefined) => {
    const element = node instanceof Element ? node : node?.parentElement
    const slot = element?.closest<HTMLElement>("[data-xq-card]")
    const key = slot && xqCardKey(slot)
    if (key) keys.add(key)
  }
  if (document.activeElement !== document.body) add(document.activeElement)
  const selection = document.getSelection()
  if (selection && !selection.isCollapsed) add(selection.anchorNode)
  // `:hover` is the browser's own record of the pointer, cleared when the pointer leaves the window.
  add(document.querySelector("[data-xq-card]:hover"))
  return keys
}

/** A HELD card (useLeavingCards `hold`) as it draws: frozen as it was last queued — the handoff the human
 *  is reading does not change under them while the worker streams — except for its questions, which are
 *  the live thread's, so one answered from the drawer or another tab leaves it and one the worker asks
 *  while it works joins it. */
function heldEntry(projects: readonly QueuesProject[], entry: QueueEntry): QueueEntry {
  const project = projects.find((p) => p.id === entry.project.id)
  const live = project && [...project.queued, ...project.running, ...project.snoozed].find((t) => t.id === entry.thread.id)
  return live && live.questions !== entry.thread.questions ? { ...entry, thread: { ...entry.thread, questions: live.questions } } : entry
}

/** A held or engaged card whose worker is at work says so, in place of the time it was ready: its entry
 *  is frozen from when it was queued, and "Ready 2m ago" over a running worker is false. */
function heldStatus(projects: readonly QueuesProject[], entry: QueueEntry, working: string): string | undefined {
  const project = projects.find((p) => p.id === entry.project.id)
  return project?.running.some((t) => t.id === entry.thread.id) ? working : undefined
}

// The human's moves that close every empty gap a ghost left (lib/stableQueue.ts): the start of a scroll
// by wheel or touch, and any key. A scrollbar drag closes none, but its gap soon scrolls off.
const GAP_CLOSERS = ["wheel", "touchmove", "keydown"] as const

export function AllQueuesPage() {
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  // THE VIEW (lib/pageView.ts): one project, or every project. Focused, the list and the queue are that
  // project's alone and the prompt box is its; showing All projects, they are every project's.
  const view = usePageView()
  const queues = useQuery({
    ...projectsQueuesQuery,
    // Only All projects polls every project every few seconds (OTHER_PROJECTS_POLL_MS says why). Another
    // observer of the same query can still ask for more: Settings' cross-project notifications keep their
    // own 3s cadence (lib/crossProjectNotify.ts), because a notification is the one reading of other
    // projects that cannot wait — and only while the human has turned them on.
    refetchInterval: view.kind === "all" ? POLL_MS : OTHER_PROJECTS_POLL_MS,
  })
  const direction = useSnapshot(prefs).queueOrder
  // The FOCUS — the page project (routes.tsx CrossProjectPage). Its board is live in the store, so it
  // is drawn from that rather than from the poll, and so is the project the focus just LEFT, until the
  // poll has caught up with what was done there (useDepartedQueue).
  const focus = projectSlug(useLocation().pathname)
  const board = useBoard()
  const snap = useSnapshot(store)
  const polled = useLastKnownQueues(queues.data, cards.data)
  const live = useMemo(() => liveQueue(polled, board, focus), [polled, board, focus])
  // When the read behind `queues.data` STARTED (lib/projectsQueuesRead.ts) — never `dataUpdatedAt`, which
  // is when it landed and can postdate an action the read never saw.
  const readAt = readStartedAt(queues.data)
  const departed = useDepartedQueue(live, readAt)
  const base = useMemo(() => queuesProjects(cards.data, polled, direction), [cards.data, polled, direction])
  // The pins this tab just set or cleared, ahead of the board that will confirm them (lib/optimisticPin.ts).
  const pinOverrides = usePinOverrides()
  const projects = useMemo(() => pinOverlayQueues(overlayQueues(base, [live, departed], direction), pinOverrides), [base, live, departed, direction, pinOverrides])
  const focusProject = projects.find((project) => project.slug === focus)
  const runningThreads = useMemo(() => projects.flatMap((project) => project.running), [projects])
  const viewed = view.kind === "project" ? projects.find((project) => project.slug === view.slug) : undefined
  // Showing All projects, an `@handle` in agent prose links to any open project's thread.
  const crossProjectMentions = view.kind === "all" ? queues.data : null
  useEffect(() => setCrossProjectMentions(crossProjectMentions), [crossProjectMentions])
  useEffect(() => () => setCrossProjectMentions(null), [])
  const focused = view.kind === "project"
  const navigate = useNavigate()
  // The directories the prompt box is keyed by — and so the ones a choice of project carries its draft
  // OUT of, which the store's board cannot say while a quick run of ⌥↓ is ahead of the feed.
  const dirs = composerDirs(focus, board, focusProject)
  const pickProject = usePickProject()
  // Set by a choice of project — in the picker, or ⌥↑/⌥↓ in the box — so the prompt box it just re-aimed
  // takes the keyboard when it lands, with the caret where it was in the box it replaced.
  const [focusComposerFor, setFocusComposerFor] = useState<{ slug: string; caret?: Caret } | null>(null)
  const clearFocusComposerFor = useCallback(() => setFocusComposerFor(null), [])
  // ⌥↓ / ⌥↑ — the next or previous project (lib/crossProject.ts stepPick). IN THE BOX it re-aims the box
  // without leaving it: the draft goes with it as it does with a pick, and the caret stays put. Heard on
  // the column head, below which both of the box's tabs sit.
  const stepProject = (step: 1 | -1, box?: HTMLTextAreaElement): boolean => {
    const next = stepPick(pickOrder(projects), focus, step)
    if (!next) return false
    if (box) {
      setFocusComposerFor({
        slug: next.slug,
        caret: { value: box.value, start: box.selectionStart ?? box.value.length, end: box.selectionEnd ?? box.value.length, direction: box.selectionDirection ?? "none" },
      })
    }
    // Focused, the box's project IS the page's, so stepping it moves the page: the next project, with
    // what was typed carried along as a pick carries it.
    if (focused) {
      carryDispatchDraft(dirs?.projectDir, next.projectDir)
      navigate(projectViewHref(next.slug))
    } else pickProject(next, dirs?.projectDir)
    return true
  }
  // A PROMPT OPENING WITH `#slug ` GOES TO THAT PROJECT (lib/projectMentions.ts leadingProjectRoute): the
  // box re-aims as a pick or a step would — focused, by moving the page — with the words, minus the token,
  // carried along even into a box that already holds a draft (routeDispatchDraft).
  const routeToProject = (slug: string, value: string): string | false => {
    const to = projects.find((project) => project.slug === slug && !project.stale)
    // A project not open yet has no directory from the poll; its registered path is the one its board
    // will key the box's drafts by once it opens.
    const toDir = to && (to.projectDir ?? to.card?.path)
    if (!to || !toDir || !routeDispatchDraft(dirs?.projectDir, toDir, value)) return false
    if (to.slug === focus) return toDir
    setFocusComposerFor({ slug: to.slug })
    if (focused) navigate(projectViewHref(to.slug))
    else pickProject(to, dirs?.projectDir)
    return toDir
  }
  const onColumnKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const box = event.target
    const step = projectStep(event.nativeEvent)
    if (!step || !(box instanceof HTMLTextAreaElement) || !box.matches(NEW_THREAD_BOXES)) return
    if (stepProject(step, box)) event.preventDefault()
  }
  // AND ANYWHERE ELSE ON THE PAGE — nothing typed into, nothing layered over it (lib/keyboardRuntime.ts
  // isPageKey): the same step, leaving the keyboard where it was, so `j` / `k` and the card keys go on
  // working after it. Focused, that is switching projects; showing All projects, re-aiming the box. In a
  // text field the keys stay the field's (macOS moves the caret a paragraph), but for the box's own.
  const stepProjectRef = useRef(stepProject)
  stepProjectRef.current = stepProject
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = projectStep(event)
      if (!step || !isPageKey(event)) return
      if (stepProjectRef.current(step)) event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  // `e` WITH NO THREAD IN FRONT OF THE HUMAN — no drawer, no card being read — opens the project's own
  // folder in the editor: the page's project, or showing All projects, the one the box would start in.
  // In an editor's sidebar that editor is the one around it, whatever Local file links says: the extension
  // shows the folder (and opens one outside the window's folders in a window of its own).
  useShortcut("thread.editor", () => {
    if (runThreadCommand("editor")) return
    if (!focusProject?.open) return false
    if (embedded()) {
      if (!focusProject.projectDir) return false
      postToHost({ type: "ntwine:open-file", path: focusProject.projectDir })
      return
    }
    const project = focusProject
    void runExternalOpen(
      `editor-project:${project.id}`,
      "Opening in editor…",
      () => projectRpc(project.id).openProjectFolder({}),
      () => {},
      (message) => `Could not open an editor: ${message}`,
    )
  })

  const leaving = useLeavingCards(projects, readAt)
  // A thread whose drawer is open is read THERE, so its card goes INERT — a second live copy of the same
  // questions and reply box under the sheet would take keys and clicks meant for the drawer (store.ts
  // slugsInThreadDrawers). Drawers belong to the page project, so only the focus's cards can be. It
  // STAYS IN THE QUEUE: drawn where it was, and counted in READY and the filter, because opening a
  // thread to read it is not taking it off the queue (David 2026-09-29: "it shouldn't move it out
  // of the queue though it should be displayed on below and non interactable and ready should still
  // include it"). It was hidden and uncounted until then.
  const focusId = focusProject?.id
  const inDrawer = new Set(focusId === undefined ? [] : [...slugsInThreadDrawers(snap.drawers)].map((slug) => threadKey(focusId, slug)))
  const hidden = (key: string) => leaving.hidden(key)
  // Registered projects this server has not opened (still being opened after a boot, served by another
  // Ntwine, or failed to open): their queues are unknown, so "nothing in any queue" would be a claim.
  const unopened = projects.filter((project) => !project.open && !project.stale).length
  // What the view shows, in the list and the queue alike: its one project, or every project. A view
  // naming a project this machine does not list is the route's to correct (routes.tsx), so for the moment
  // before it does, the page shows nothing rather than every project.
  // A LENS narrows All projects to the projects picked in the dock (lib/lens.ts); one project is its page.
  const lens = useLens()
  const shown = focused ? (viewed ? [viewed] : []) : lens ? projects.filter((project) => lens.has(project.id)) : projects
  const centerTab = useCenterTab()
  const openInPlace = useOpenThreadInPlace()
  const [, repaint] = useState(0)
  // THE VIEWPORT LOCK (lib/viewportLock.ts), and the one thing it asks back: a render once the page is
  // still, when a ghost has scrolled off screen (it can go now that nobody sees it go) or the cards on
  // screen have changed (the ones held back for them can take their places).
  const lock = useViewportLock("[data-xq-card]", xqCardKey, useCallback(() => repaint((n) => n + 1), []))
  const steeredAt = useSteeredAt()
  // The ONE queue in lib/stableQueue.ts's STABLE order: the queue's own order off screen; on screen
  // exactly as last drawn (David 2026-09-28: "it needs to be guaranteed that cards that I'm
  // currently viewing on the screen don't move in their position"). A card whose thread left the queue
  // by any hand but the human's in THIS tab (lib/humanActs.ts) — its agent woke itself, it was answered
  // from the phone, its project closed — is held there as a ghost; one the human put away from here —
  // finished, replied to, snoozed — leaves the ordinary way, held only while it fades. Re-sorting or
  // re-filtering is the human choosing a different queue, so it starts over from the queue's own order.
  const ordered = mergedQueue(shown, direction).filter(({ project, thread }) => !leaving.hidden(threadKey(project.id, thread.id)))
  const prevSlots = useRef<QueueSlot<QueueEntry>[]>([])
  const orderedAs = useRef(`${direction}|${viewKey(view)}`)
  if (orderedAs.current !== `${direction}|${viewKey(view)}`) {
    orderedAs.current = `${direction}|${viewKey(view)}`
    prevSlots.current = []
  }
  // THE CARD THE HUMAN IS ENGAGED WITH STAYS A CARD. Its thread can leave the queue on its own while the
  // human is mid-sentence or mid-read (a shell finishing, a child returning), and as a ghost the card is
  // an empty gap: the focused box unmounted under the caret, and every key after it fell through to the
  // page's shortcuts — `j`/`k` gliding between cards, others opening drawers — so the page jumped around
  // while they typed (David 2026-09-30: "scrolling jumps around and makes it hard to read/type"). Typing
  // was not the only engagement it took away: a card being read under the pointer, or one whose
  // disclosure had just been clicked, emptied the same way (David 2026-10-08: "I was interacting with the
  // card then all of a sudden it left without me interacting with it"). So any card holding the focus,
  // the text selection or the pointer is drawn as it was while that lasts, saying its worker is at work;
  // the draft is the thread's either way, and a reply still reaches it. Once the human moves off it, the
  // next render leaves a ghost like any other.
  // Never a card the human just sent away: useLeavingCards `leave` takes the caret out of it, and the
  // other engagements hold only a card that would otherwise be a ghost (`mayGhost`: not one this tab
  // acted on), or Done clicked under a resting pointer would leave the card drawn.
  const typingKey = typingInCard()
  const engaged = engagedCards()
  // Gaps the human's last move closed (below).
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const mayGhost = (key: string): boolean => {
    if (leaving.isLeaving(key)) return false
    const was = prevSlots.current.find((slot) => slot.key === key)?.item
    return was !== undefined && !closed.has(key) && steeredAt[was.thread.id] === undefined && !actedOnHere(was.thread.id)
  }
  const queue = stableQueue({
    prev: prevSlots.current,
    target: ordered,
    keyOf: entryKey,
    onScreen: lock.onScreen.current,
    mayGhost,
    keep: new Set(prevSlots.current.map((slot) => slot.key).filter((key) => (leaving.isLeaving(key) && !leaving.hidden(key)) || leaving.isHeld(key) || key === typingKey || (engaged.has(key) && mayGhost(key)))),
  })
  prevSlots.current = queue
  // A GHOST IS AN EMPTY GAP, and the human's next move closes it (David 2026-09-29, of the quiet card
  // it replaced: "maybe just make the space above empty in this scenario until you scroll"). Scrolling off
  // is how a gap otherwise ends, but the one at the top of a short page never scrolls off, so a wheel, a
  // touch or a key closes every gap on the page — the human is moving, so the lock (lib/viewportLock.ts)
  // holds the card they are engaged with while the space under it goes. A close is forgotten with the
  // ghost, so the next time that thread leaves on its own its card holds its place again.
  const ghostKeys = queue.filter((slot) => slot.ghost).map((slot) => slot.key)
  const ghostKeysId = ghostKeys.join("\n")
  useEffect(() => {
    setClosed((prev) => {
      const kept = [...prev].filter((key) => ghostKeys.includes(key))
      return kept.length === prev.size ? prev : new Set(kept)
    })
    if (!ghostKeys.length) return
    const close = () => setClosed(new Set(ghostKeys))
    const options = { capture: true, passive: true, once: true }
    for (const type of GAP_CLOSERS) window.addEventListener(type, close, options)
    return () => {
      for (const type of GAP_CLOSERS) window.removeEventListener(type, close, options)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ghosts' identity, not the array
  }, [ghostKeysId])
  // Counted from what the page SHOWS: a card the operator just finished is gone from the count at once,
  // and a header still counting it read "1 in the queue" over an empty page until the next poll. A ghost
  // is not waiting on anyone. A card whose drawer is open still is, and still counts.
  const ready = queue.filter((slot) => !slot.ghost && !leaving.isLeaving(slot.key)).length
  // THE TAB NAMES ITS VIEW. Someone who keeps one tab per project (the original design's way of
  // working, and how its one-project-per-page board titled its tabs) tells them apart by title and favicon alone, so a
  // focused tab reads "<project> — Ntwine" and its favicon counts that project's queue (lib/faviconBadge.ts);
  // All projects reads so, counting every project's. A count, not a dot, so a background tab says how
  // much is waiting rather than only that something is. Set here, not in
  // <App/>, because only this page knows its view — and an effect in App would run AFTER this child's on
  // mount and overwrite it. Cleared back to the bare mark when the page goes (the welcome page, `/full`).
  const tabName = focused ? viewed?.name : "All projects"
  useEffect(() => {
    document.title = tabName ? `${tabName} — Ntwine` : "Ntwine"
  }, [tabName])
  useEffect(() => () => { document.title = "Ntwine" }, [])
  useEffect(() => {
    setFaviconBadge(ready)
    return () => setFaviconBadge(false)
  }, [ready])
  const chooseView = useChooseView()
  const scrollToCard = useScrollToCard()
  // An editor's sidebar draws no cards, so its keys step its list instead (SidebarPage.tsx) — and only
  // one cursor may answer `j`.
  const sidebar = embedded()
  const { active: activeKey, land } = useQueueKeys(useScrollspy(queue), scrollToCard, !sidebar)
  const loading = (cards.isPending || queues.isPending) && !queues.data
  // Below the page's stacking point the columns are one above the other, so the list follows the queue
  // rather than sitting between the prompt box and the queue it indexes.
  const stacked = useStacked()
  const home = homeOf(cards.data)
  const phone = useIsMobile()
  // A cold link to one of the board's queued threads lands on its card. Not on All projects, whose
  // threads open as drawers; not on a phone or in an editor's sidebar, which draw no cards.
  useRoutedLanding(focused && !sidebar && !phone, !loading, focusId, land)
  // The list drops a row only with a card being FINISHED. A thread open in a drawer keeps its row, marked
  // open: the card steps aside because the drawer is the same thread, but the list is where the reader
  // finds their place, and a row that vanished when clicked left them nothing to find. Focused, it is the
  // one project, and adding another is the switcher's (its last item) rather than a row of this list.
  // The queue as drawn, by key: All projects' Ready rows list in this order, so a row faces its card.
  const queueKeysId = queue.filter((slot) => !slot.ghost).map((slot) => slot.key).join("\n")
  const queueKeys = useMemo(() => (queueKeysId ? queueKeysId.split("\n") : []), [queueKeysId])
  // THE LIST: the dock (every project, and the lens) over the tiers (TierList.tsx), whichever the view —
  // a project's page is the same list with one project in it.
  const dock = <ProjectDock projects={projects} hidden={leaving.hidden} home={home} onAll={(from) => chooseView.all(from)} onProject={(slug) => chooseView.project(slug)} />
  const list = (
    <>
      {dock}
      <TierList projects={shown} activeKey={activeKey} hidden={leaving.hidden} onQueuedRow={land} queueOrder={queueKeys} subAgentRows={focused} />
    </>
  )

  // AN EDITOR'S SIDEBAR IS THE DESKTOP'S LEFT COLUMN (SidebarPage.tsx): the prompt box over the list, the
  // view's switcher heading the list, a thread in its drawer. The cards have no room; a Ready row opens its
  // thread instead of landing on its card.
  if (sidebar) {
    return (
      <SidebarPage
        projects={projects}
        shown={shown}
        viewed={viewed}
        focusedSlug={view.kind === "project" ? view.slug : undefined}
        hidden={hidden}
        loading={loading}
        error={queues.error && !queues.data ? String(queues.error) : undefined}
        ready={ready}
        empty={queue.length > 0 ? null : focused ? focusedEmptyLine(viewed?.name) : allEmptyLine(unopened)}
        composer={
          <div onKeyDown={onColumnKeyDown}>
            <FocusedComposer
              onLeadingProject={routeToProject}
              focus={focus}
              project={focusProject}
              dirs={dirs}
              autoFocus={focusComposerFor !== null && focusComposerFor.slug === focus}
              caret={focusComposerFor?.caret}
              onFocused={clearFocusComposerFor}
              target={
                focused ? undefined : (
                  <ProjectPicker
                    projects={projects}
                    focus={focus}
                    onPick={(project) => {
                      setFocusComposerFor({ slug: project.slug })
                      pickProject(project, dirs?.projectDir)
                    }}
                  />
                )
              }
            />
          </div>
        }
        list={(reading) => (
          <>
            <div data-xq-switcher-row className="flex min-w-0 py-0.5 pl-5 pr-1.5">
              <Switcher projects={projects} hidden={hidden} current={viewed} row />
            </div>
            {dock}
            <TierList projects={shown} activeKey={reading} hidden={leaving.hidden} onQueuedRow={noCard} queueOrder={queueKeys} subAgentRows={focused} />
          </>
        )}
      />
    )
  }

  // A PHONE GETS ITS OWN LAYOUT of the same page (PhonePage.tsx): a header naming the view, Queue /
  // Snoozed / Done tabs of one-line rows, and a New thread button — upstream's phone board, over this
  // page's projects. The stack below is the desktop's, down to the 800px stacking point.
  if (phone) {
    return (
      <PhonePage
        projects={projects}
        shown={shown}
        viewed={viewed}
        focusedSlug={view.kind === "project" ? view.slug : undefined}
        hidden={hidden}
        loading={loading}
        error={queues.error && !queues.data ? String(queues.error) : undefined}
        homeDir={home}
        composer={(onDispatched, autoFocus) => (
          <FocusedComposer
            onLeadingProject={routeToProject}
            focus={focus}
            project={focusProject}
            dirs={dirs}
            autoFocus={autoFocus}
            caret={undefined}
            onFocused={noop}
            onDispatched={onDispatched}
            target={focused ? undefined : <ProjectPicker projects={projects} focus={focus} onPick={(project) => pickProject(project, dirs?.projectDir)} />}
          />
        )}
        // Choosing from the phone's projects list over a view replaces the list's own history entry
        // (PhonePage.tsx useProjectsListing), so Back from the view chosen returns to the one before the
        // list; from the list at `/`, the phone's home, it pushes, so Back returns to the list.
        onAll={(options) => chooseView.all(focusProject && focused ? focusProject : undefined, options)}
        onProject={(project, options) => chooseView.project(project.slug, options)}
      />
    )
  }

  return (
    <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] bg-bg px-5 text-sm text-fg max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
      {/* TOP-anchored, where the project board centred its column: a click here changes the list's height (narrowing
          folds every other project to one line), and a centred column moved the prompt box and the row just
          clicked out from under the pointer — by 110-200px with five projects. 48px sets the status row's middle
          level with the READY header's across the gutter (64 vs 59.85px at 52px). */}
      {/* Above the thread connector (ThreadConnector.tsx, z-[5]) while the prompt box's menu is open: the
          column is fixed, so the menu's own z-index cannot leave it, and the cords drew over its rows. The slot
          holds the column's place in the row; the column itself is fixed to the viewport (Sidebar.tsx). */}
      <div className={SIDEBAR_SLOT_CLASS}>
        <aside aria-label="Projects" className={`${SIDEBAR_COLUMN_CLASS} !justify-start pt-[48px] max-[800px]:!pt-5 has-[[data-mention-menu]]:z-[6] has-[[data-slash-menu]]:z-[6]`}>
          <div className="flex max-h-[calc(100vh-68px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
            {/* The column head: the status row, led by the page's title (the switcher), and the prompt box
                under it — a new thread without leaving.
                Focused, it starts in the view's project; showing All projects, in the project chosen in the
                box's own bottom strip, beside the model. */}
            <div className="mb-5 shrink-0 px-0.5" onKeyDown={onColumnKeyDown}>
              {/* On a project's board: the door home before the switcher, the project's repo and menu after it. */}
              <StatusRow
                title={<Switcher projects={projects} hidden={hidden} current={viewed} />}
                crumb={focused}
                identity={focused && viewed ? <BoardIdentity project={viewed} home={home} /> : undefined}
              />
              {/* The first-run tour's "Start a thread" points here (components/Onboarding.tsx). */}
              <div data-tour="composer">
                <FocusedComposer
                  onLeadingProject={routeToProject}
                  focus={focus}
                  project={focusProject}
                  dirs={dirs}
                  autoFocus={focusComposerFor !== null && focusComposerFor.slug === focus}
                  caret={focusComposerFor?.caret}
                  onFocused={clearFocusComposerFor}
                  target={
                    focused ? undefined : (
                      <ProjectPicker
                        projects={projects}
                        focus={focus}
                        onPick={(project) => {
                          setFocusComposerFor({ slug: project.slug })
                          pickProject(project, dirs?.projectDir)
                        }}
                      />
                    )
                  }
                />
              </div>
            </div>
            {!stacked && (
              // pb-1.5: a band header (Sidebar BAND_HEADER) is a 15px box whose 11px name, pushed down by its
              // pt-1, paints ~4.7px below it. Last in the list, that ink fell outside this scroller and was
              // cut in half (a folded Schedules header, 2026-10-07); the padding gives it room.
              <div data-xq-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden pb-1.5">
                {list}
              </div>
            )}
          </div>
        </aside>
      </div>
      <main
        id="workpane"
        aria-label="Queue"
        className="flex min-h-screen w-[720px] max-w-[62vw] min-w-0 flex-col py-5 max-[800px]:min-h-0 max-[800px]:w-full max-[800px]:max-w-none"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
          </div>
        ) : queues.error && !queues.data ? (
          <p className="my-auto text-center text-[13px] text-muted">Could not read the queues: {String(queues.error)}</p>
        ) : (
          <div className="flex w-full min-w-0 flex-col py-8 max-[800px]:pt-2">
            {/* THE INBOX, NAMED — every card below is a Ready thread. Which project's is the page's title,
                over the prompt box (StatusRow.tsx), not here: it scopes the whole page, not these cards.
                `pl-[21px]` stands the glyph over the card titles. */}
            <div data-inbox-header className="mb-3 flex min-w-0 items-center gap-3 pl-[21px] pr-[21px]">
              {/* The column's two lists: the queue, and History — every Done thread in view, by day. */}
              <h2 className="flex shrink-0">
                <button type="button" data-center-tab="queue" aria-pressed={centerTab === "queue"} onClick={() => setCenterTab("queue")} className={`flex rounded outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${centerTab === "queue" ? "" : "opacity-55 hover:opacity-90"}`}>
                  <BandLabel band="ready" count={ready} />
                </button>
              </h2>
              <button type="button" data-center-tab="history" aria-pressed={centerTab === "history"} onClick={() => setCenterTab("history")} className={`flex shrink-0 rounded outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${centerTab === "history" ? "" : "opacity-55 hover:opacity-90"}`}>
                <BandLabel band="done" label="History" />
              </button>
              <ResumePaused entries={queue.filter((slot) => !slot.ghost && !leaving.isLeaving(slot.key)).map((slot) => slot.item)} leaving={leaving} />
            </div>
            {/* Quota is account-global, so the alert counts every project's running threads even
                when the page is focused on one. */}
            <QuotaAlerts threads={runningThreads} />
            {centerTab === "history" ? (
              <HistoryView
                projectIds={focused ? (viewed ? [viewed.id] : []) : lens ? [...lens] : undefined}
                onOpen={(entry) => openInPlace({ id: entry.projectId, slug: entry.projectSlug, name: entry.projectName }, entry.thread.id, displayTitle(entry.thread))}
              />
            ) : queue.length > 0 ? (
              queue.map((slot, index) => (
                <Fragment key={slot.key}>
                  <QueueCardOf entry={leaving.isHeld(slot.key) || engaged.has(slot.key) ? heldEntry(projects, slot.item) : slot.item} ghost={slot.ghost} status={leaving.isHeld(slot.key) ? heldStatus(projects, slot.item, "Working on your answer") : engaged.has(slot.key) && !leaving.isLeaving(slot.key) ? heldStatus(projects, slot.item, "Working") : undefined} concealed={inDrawer.has(slot.key)} leaving={leaving} chip={!focused} />
                  {/* The rule between two cards: a sibling that FOLLOWS its card, so
                      styles.css fades it with the card when that one leaves. */}
                  {index < queue.length - 1 && <hr className="my-10 border-0 border-t border-border/60" />}
                </Fragment>
              ))
            ) : focused ? (
              <p data-xq-focus-empty className="mt-16 text-center text-[13px] text-muted">
                {focusedEmptyLine(viewed?.name)}
              </p>
            ) : (
              <EmptyQueues unopened={unopened} />
            )}
          </div>
        )}
        {stacked && (
          <div data-xq-rail="stacked" className="min-w-0 border-t border-border/60 pt-5">
            {list}
          </div>
        )}
      </main>
      {!stacked && <ThreadConnector activeKey={activeKey} />}
    </div>
  )
}

/**
 * The page's title, the project switcher (ProjectSwitcher.tsx): the project the page is focused on, or All
 * projects. Choosing is a navigation to that view (lib/pageView.ts), so Back returns to the one before.
 * Leaving a project for All projects carries it over as the prompt box's pick, so the box there starts
 * where the operator just was.
 */
function Switcher({ projects, hidden, current, row = false }: { projects: QueuesProject[]; hidden: (key: string) => boolean; current: QueuesProject | undefined; row?: boolean }) {
  const choose = useChooseView()
  const add = useAddProject()
  // The machine-wide (drag) order; Home last, on its own — unlike the dock, where Home is dragged into
  // place like any project.
  const ordered = projects.filter((project) => !project.card?.home)
  const item = (project: QueuesProject): SwitcherProject => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    card: project.card ?? fallbackCard(project),
    ready: project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length,
    running: project.running.length,
    asks: [...project.queued, ...project.running].filter(isAsk).length,
    note: project.stale ? "Missing" : undefined,
  })
  const homeProject = projects.find((project) => project.card?.home)
  const items = ordered.map(item)
  const home = homeProject && item(homeProject)
  return (
    <ProjectSwitcher
      projects={items}
      home={home}
      homeHint={homeProject?.card && shortPath(homeProject.card.path, homeProject.homeDir)}
      current={current && (current.card?.home ? home : items.find((entry) => entry.id === current.id))}
      onAll={() => choose.all(current)}
      onProject={(project) => choose.project(project.slug)}
      onAdd={add.start}
      row={row}
    />
  )
}

/**
 * CHANGE THE PAGE'S VIEW — the switcher's one verb, and the phone's projects list's (PhonePage.tsx), so the
 * two cannot drift. Choosing is a navigation (`/project/<slug>`, `/all`), so Back returns to the view before.
 * Leaving a project for All projects carries it over as the prompt box's pick, so the box there starts
 * where the operator just was. A different set of cards is a different page to read, so it is read from
 * its top.
 */
function useChooseView(): {
  all: (from: Pick<QueuesProject, "id"> | undefined, options?: { replace?: boolean }) => void
  project: (slug: string, options?: { replace?: boolean }) => void
} {
  const navigate = useNavigate()
  return useMemo(() => {
    const go = (href: string, replace = false) => {
      navigate(href, { replace })
      glideTo(() => 0)
    }
    return {
      all: (from, options) => {
        if (from) rememberCrossProjectFocus(from.id)
        go(viewHref(ALL_PROJECTS), options?.replace)
      },
      project: (slug, options) => go(projectViewHref(slug), options?.replace),
    }
  }, [navigate])
}

const noop = () => {}
/** A Ready row with no card on the page to land on: it opens its thread (TierList.tsx useRowScopes). */
const noCard = () => null

// ---- The column head --------------------------------------------------------------------------------

/**
 * WHICH PROJECT A NEW THREAD GOES TO, while the page shows All projects — the first pill in the prompt
 * box's bottom strip, beside the model (NewThreadModal.tsx DispatchForm `target`), drawn as that pill is: a
 * setting of the thread about to start, not a view. Choosing one makes it the PICK (lib/crossProject.ts),
 * which All projects is bound to and the box dispatches into — remembered, never in the address. ⌥↓ and ⌥↑
 * in the box step it down and up this menu (AllQueuesPage), which its tooltip says wherever there is
 * another to step to. Focused on a project there is no picker: the box starts in the page's project, and
 * ⌥↓/⌥↑ step the page itself.
 */
function ProjectPicker({ projects, focus, onPick }: { projects: QueuesProject[]; focus: string | undefined; onPick: (project: QueuesProject) => void }) {
  const current = projects.find((project) => project.slug === focus)
  const name = current?.name ?? focus ?? "a project"
  // A project whose directory is gone cannot take a thread; it stays on the rail, saying why.
  const choices = projects.filter((project) => !project.stale && !project.card?.home)
  const steps = stepPick(pickOrder(projects), focus, 1) !== undefined
  // The Home workspace, for the work that belongs to no project yet: last, under a rule, with the folder
  // it runs in, because "Home" alone does not say that its agents start outside every project. Last is
  // also where stepping from the box reaches it (pickOrder).
  const homeChoice = projects.find((project) => !project.stale && project.card?.home)
  // Every square ⌥↑/⌥↓ can step to, fetched and decoded now, so each step draws its icon on arrival.
  useEffect(() => {
    for (const project of projects) if (!project.stale) warmProjectIcon(project.card ?? fallbackCard(project))
  }, [projects])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const alone = useAloneOnItsLine(triggerRef)
  const choice = (project: QueuesProject, hint?: string) => (
    <MenuItem key={project.id} value={project.slug} onSelect={() => onPick(project)} icon={<ProjectSquare project={project.card ?? fallbackCard(project)} size={14} />}>
      <span className={`min-w-0 flex-1 truncate ${project.slug === focus ? "text-fg" : ""}`}>{project.name}</span>
      {hint && <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-muted-55">{hint}</span>}
      {/* Choosable — opening its board may be exactly what brings it up — but not a surprise. */}
      {!project.open && <span className="shrink-0 text-[10.5px] text-muted-55">Not open</span>}
      {project.slug === focus && <Check size={12} aria-label="Current" className="shrink-0 text-fg" />}
    </MenuItem>
  )
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-xq-project-picker
          data-alone={alone || undefined}
          title={steps ? `New threads start in ${name} (${PROJECT_STEP_KEYS})` : `New threads start in ${name}`}
          aria-label={`New threads start in ${name}. Choose a project`}
          // The model pill's own chrome and type (ProfileGridSelector's trigger), so the strip reads as one
          // row of settings for the next thread. Capped beside the model pill, so it leaves that room on the
          // line; on a line of its own, the line (useAloneOnItsLine).
          className={`group inline-flex min-w-0 ${alone ? "max-w-full" : "max-w-[min(14rem,45%)]"} cursor-pointer items-center gap-[5px] rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:border-border data-[state=open]:bg-panel-2 ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
        >
          {/* Ink gaps (sans, scripts/ink-gaps.mjs): square→name 5.00px; name→chevron 6.00px against the model
              pill's own 6.12px, which `-ml-[3px]` buys back from the chevron's dead box. */}
          {current && <ProjectSquare project={current.card ?? fallbackCard(current)} size={12} />}
          <span data-xq-picker-name className="min-w-0 flex-1 truncate">{name}</span>
          <ChevronDown size={13} aria-hidden className="-ml-[3px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Start in</div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {choices.map((project) => choice(project))}
        </div>
        {homeChoice && (
          <>
            {choices.length > 0 && <MenuSeparator />}
            {/* Outside the scrolling list, so it never scrolls away — and inset by the scrollbar gutter that
                list reserves (styles.css `scrollbar-gutter: stable`), or its hint ended 7px right of the
                check marks above it. */}
            <div className="pr-[var(--sbw)]">
              {choice(homeChoice, homeChoice.card && shortPath(homeChoice.card.path, homeChoice.homeDir))}
            </div>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}

/**
 * WHETHER THE PICKER HAS ITS LINE TO ITSELF, even at its cap: the strip too narrow for it and the model pill
 * beside it, so the model pill wraps under it. The cap (45% of the strip) exists to leave the model pill
 * room on the line, and on a line of its own it only cut the name — "ACME…" in a 300px editor sidebar, at
 * the desktop's narrowest column and on a phone, with half the line empty beside it. Measured rather than
 * guessed from a width, because the model pill's width is its model's name: the pill as it would be capped
 * (its chrome plus the whole name, at most the cap) beside the model pill, against the strip. Read off the
 * capped size, not the current one, so taking the line never feeds back into the answer.
 */
function useAloneOnItsLine(ref: RefObject<HTMLElement | null>): boolean {
  const [alone, setAlone] = useState(false)
  useLayoutEffect(() => {
    const pill = ref.current
    const strip = pill?.parentElement
    if (!pill || !strip) return
    let watched: Element | null = null
    const measure = () => {
      // Read afresh: the strip swaps its placeholder for the real model pill once the models load.
      const model = pill.nextElementSibling
      if (model !== watched) {
        if (watched) observer.unobserve(watched)
        if (model) observer.observe(model)
        watched = model
      }
      const name = pill.querySelector<HTMLElement>("[data-xq-picker-name]")
      const width = strip.clientWidth
      // The pending box draws the picker alone in a corner, sized to it: nothing shares a line there.
      if (!(model instanceof HTMLElement) || !name || !width) return setAlone(false)
      const natural = pill.offsetWidth - name.clientWidth + name.scrollWidth
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const capped = Math.min(natural, 14 * rem, 0.45 * width)
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0
      setAlone(capped + gap + model.offsetWidth > width)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    observer.observe(pill)
    measure()
    return () => observer.disconnect()
  }, [ref])
  return alone
}

/**
 * CHOOSE the project a new thread goes to while the page shows All projects, in the prompt box's picker
 * or with ⌥↑/⌥↓ in the box. Remembered as the pick (lib/crossProject.ts), which All projects is bound to.
 *
 * What was typed in the prompt box goes WITH the choice. The box is one box whose target just changed,
 * and the commonest reason to change it is noticing, mid-prompt, that it pointed at the wrong project —
 * a draft left filed under the old one looked like the text had been lost. It moves only into an empty
 * box, so a draft already waiting in the chosen project is never overwritten. `from` is the directory
 * the box's draft is filed under now (composerDirs): the store's board lags a quick run of choices, and
 * reading the source there stranded the draft in whichever project the run passed through last.
 */
function usePickProject(): (project: QueuesProject, from: string | undefined) => void {
  const navigate = useNavigate()
  return useCallback(
    (project: QueuesProject, from: string | undefined) => {
      carryDispatchDraft(from, project.projectDir)
      rememberCrossProjectFocus(project.id)
      // A drawer open on the page has it bound to the drawer's project, and the box follows the binding,
      // so aiming the box closes the drawers: home, where the binding is the pick.
      if (innerPath() !== "/") navigate(homeHref(), { replace: true })
    },
    [navigate],
  )
}

/**
 * The project the focus just LEFT, drawn from its last live board until the poll has caught up.
 *
 * Its live board goes with the focus, and the poll behind it can be a few seconds old — so a card
 * marked done in its drawer a moment ago came back, from the poll, the instant the operator opened
 * something in another project. Held only until a read that STARTED after the departure lands, and
 * that read is asked for at once rather than left to the next tick.
 */
/** How long a project the server has stopped serving keeps its last queue on the page (useLastKnownQueues). */
const UNOPENED_HOLD_MS = 60_000

/**
 * The poll's queues, with a project that DROPPED OUT of it held as it last was, for up to a minute.
 *
 * The poll carries only the projects the server has open, and a restarted server opens them again one
 * by one: for those seconds every other project's cards vanished and came back, moving each card below
 * them on the reader's screen. Held here instead, they wait where they were. Only a project still
 * registered and not stale: one removed or whose directory is gone has really left. Past the minute a
 * project that has still not come back (another Ntwine serves it, it failed to open) is shown as it is.
 */
function useLastKnownQueues(queues: readonly ProjectQueue[] | undefined, cards: readonly ProjectCard[] | undefined): readonly ProjectQueue[] | undefined {
  const seen = useRef(new Map<string, { queue: ProjectQueue; at: number }>())
  return useMemo(() => {
    if (!queues) return queues
    const now = Date.now()
    for (const queue of queues) seen.current.set(queue.projectId, { queue, at: now })
    const present = new Set(queues.map((queue) => queue.projectId))
    const held: ProjectQueue[] = []
    for (const card of cards ?? []) {
      if (present.has(card.id) || card.stale) continue
      const last = seen.current.get(card.id)
      if (last && now - last.at < UNOPENED_HOLD_MS) held.push(last.queue)
    }
    return held.length > 0 ? [...queues, ...held] : queues
  }, [queues, cards])
}

function useDepartedQueue(live: ProjectQueue | undefined, readAt: number | undefined): ProjectQueue | undefined {
  const queryClient = useQueryClient()
  const last = useRef<ProjectQueue | undefined>(undefined)
  const [departed, setDeparted] = useState<{ queue: ProjectQueue; at: number } | null>(null)
  useEffect(() => {
    const previous = last.current
    last.current = live
    if (!previous || previous.projectId === live?.projectId) return
    setDeparted({ queue: previous, at: Date.now() })
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }, [live, queryClient])
  if (!departed || departed.queue.projectId === live?.projectId || (readAt ?? 0) > departed.at) return undefined
  return departed.queue
}

/**
 * The new-thread prompt box, bound to the focused project — the page project. It is the same
 * DispatchForm the new-thread modal draws, drafts, GitHub picker and agent settings included.
 *
 * Only once the box knows WHICH DIRECTORY is the focus's: its drafts are keyed by it, and without one the
 * form would file what was typed under a shared "unresolved" bucket (lib/drafts.ts), from which it jumped
 * to another box when the board landed. The focus's own board says, once it lands; before that, the poll
 * says for any project this server has open — the same snapshot's directory (router.ts projectsQueues) —
 * so a box re-aimed at an open project is that project's box AT ONCE. It waited for the feed until
 * 2026-09-28, which blanked the box on every choice of project: harmless once from the menu, but ⌥↓
 * steps through projects, and a box that blinked out on each press dropped whatever was typed in the gap.
 * The stand-in holds the box's place for the rest — a project the poll has not seen open — so the column
 * does not jump, and says so if the board never comes, which is what a project this server cannot open
 * looks like from here.
 */
function FocusedComposer({
  focus,
  project,
  dirs,
  target,
  autoFocus,
  caret,
  onFocused,
  onDispatched,
  onLeadingProject,
}: {
  focus: string | undefined
  project: QueuesProject | undefined
  /** composerDirs — undefined while neither the focus's board nor the poll can say. */
  dirs: DispatchDirs | undefined
  target: ReactNode
  autoFocus: boolean
  caret: Caret | undefined
  onFocused: () => void
  /** A thread was started — the phone's New thread sheet closes on it. */
  onDispatched?: () => void
  onLeadingProject: (slug: string, value: string) => string | false
}) {
  const ready = dirs !== undefined
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (ready) return
    const timer = window.setTimeout(() => setSlow(true), COMPOSER_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [ready, focus])
  // A LAYOUT effect, so the caret is back before the next key lands: the new box took the keyboard as it
  // mounted (autoFocus, which runs before this parent's effects).
  useLayoutEffect(() => {
    if (!ready || !autoFocus) return
    const box = document.activeElement
    if (box instanceof HTMLTextAreaElement && box.matches(NEW_THREAD_BOXES)) placeCaret(box, caret)
    onFocused()
  }, [ready, autoFocus, caret, onFocused])
  if (!ready) {
    // The form's own two rows — the tab row and the box — at the form's heights (measured in sans, the
    // prompt tab at rest: 23.42 + 6 + 130 = 159.42px), so nothing below moves when the real form replaces
    // it. The picker keeps its spot in the box's bottom strip, so the operator can always aim elsewhere.
    return (
      <div data-xq-composer-pending className="flex w-full flex-col gap-1.5">
        <div className="h-[23.42px]" />
        <div className="relative flex h-[130px] items-center justify-center rounded-xl border border-border/60 bg-bg px-6 text-center text-[12px] leading-snug text-muted-70">
          <div className="absolute bottom-1.5 left-1.5 flex min-w-0 max-w-[calc(100%-12px)]">{target}</div>
          {slow && (
            <span>
              {project && !project.open ? `${project.name} is not open on this server.` : `${project?.name ?? focus ?? "This project"} has not answered yet.`}
            </span>
          )}
        </div>
      </div>
    )
  }
  return <DispatchForm key={focus} autoFocus={autoFocus} target={target} dirs={dirs} onDispatched={onDispatched} onLeadingProject={onLeadingProject} />
}

/**
 * The picker's own order, which ⌥↓ and ⌥↑ in the box step through: every project in the list's (drag)
 * order, then Home, which the menu draws last under its own rule.
 */
function pickOrder(projects: QueuesProject[]): QueuesProject[] {
  return [...projects.filter((project) => !project.card?.home), ...projects.filter((project) => project.card?.home)]
}

/**
 * The directories the prompt box's drafts are keyed by: the focus's own board once it has landed, and
 * before that the poll's reading of the same snapshot (router.ts projectsQueues) for a project this
 * server has open. Undefined while neither knows, and the box waits (FocusedComposer).
 */
function composerDirs(focus: string | undefined, board: BoardSnapshot | null, project: QueuesProject | undefined): DispatchDirs | undefined {
  if (focus && board?.projectSlug === focus) return { projectDir: board.projectDir, homeDir: board.homeDir }
  if (project?.open && project.projectDir) return { projectDir: project.projectDir, homeDir: project.homeDir }
  return undefined
}

/** The new-thread box's textarea. */
const NEW_THREAD_BOXES = '[data-surface="newComposer"]'

const PROJECT_STEP_KEYS = [PROJECT_STEP_CHORDS.previous, PROJECT_STEP_CHORDS.next].map((chord) => formatChord(parseChord(chord)!, detectPlatform())).join("/")

/** ⌥↓ is a step down the picker, ⌥↑ one up (lib/keybindings.ts PROJECT_STEP_CHORDS); 0 for any other key. */
function projectStep(event: globalThis.KeyboardEvent): 1 | -1 | 0 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return 0
  return event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
}

/** Where the caret sat in the box a choice of project replaced, and over which text. */
interface Caret {
  value: string
  start: number
  end: number
  direction: "forward" | "backward" | "none"
}

/**
 * The caret in a box just re-aimed at another project: where it was, when the text came along with it (a
 * draft moves only into an empty box — usePickProject), else after the text the new project's box holds.
 */
function placeCaret(box: HTMLTextAreaElement, caret: Caret | undefined): void {
  if (caret && caret.value === box.value) box.setSelectionRange(caret.start, caret.end, caret.direction)
  else box.setSelectionRange(box.value.length, box.value.length)
}

// ---- The queue (the workpane) -----------------------------------------------------------------------

/**
 * One card of the queue, whichever project it is from — showing All projects, wearing that project's chip
 * on its meta line, which focuses the page on that project.
 *
 * EVERYTHING INSIDE RENDERS AS ITS PROJECT. The markdown scope points a `#123` at the card's repo, a
 * relative path at its directory and a `/thread/<slug>` link at that thread on THIS page (opened in
 * place) — never at the page's focus, which is usually another project.
 */
function QueueCardOf({ entry, ghost, status, concealed, leaving, chip }: { entry: QueueEntry; ghost: boolean; status?: string; concealed: boolean; leaving: LeavingCards; chip: boolean }) {
  const { project, thread } = entry
  // The card's project, chosen from its chip or mark: the page focused on it, read from its top.
  const navigate = useNavigate()
  const choose = useCallback((to: QueuesProject) => {
    navigate(projectViewHref(to.slug))
    glideTo(() => 0)
  }, [navigate])
  const scope = useMemo(
    () => projectMarkdownScope(project),
    [project.id, project.githubRepo, project.slug, project.projectDir, project.homeDir],
  )
  const key = threadKey(project.id, thread.id)
  return (
    <MarkdownScopeContext.Provider value={scope}>
      <AllQueuesCard
        project={project}
        thread={thread}
        leaving={leaving.isLeaving(key)}
        onLeave={leaving.leave(key)}
        onReturn={leaving.restore(key)}
        onSent={leaving.sent(key)}
        onLanded={leaving.landed(key)}
        onHold={leaving.hold(key)}
        chip={chip}
        onChoose={choose}
        ghost={ghost}
        status={status}
        concealed={concealed}
      />
    </MarkdownScopeContext.Provider>
  )
}

/**
 * The queue's empty line, focused on a project — the sidebar says it under its list too (SidebarPage), where
 * it wraps: the name is kept whole on one line (cut short only past the line's width), since a slug broken
 * at its hyphen ("docs- / portal") no longer reads as a name.
 */
const focusedEmptyLine = (name: string | undefined) => (
  <>
    Nothing in <span className="inline-block max-w-full truncate align-bottom">{name ?? "this project"}</span> is waiting on you.
  </>
)

/** …and showing All projects, admitting the projects this server has not opened, whose queues it cannot see. */
const allEmptyLine = (unopened: number) => (unopened > 0 ? "No threads awaiting human input in any open project" : "No threads awaiting human input")

/**
 * RESUME EVERY THREAD A USAGE LIMIT PAUSED, in one click — the inbox header's verb whenever any card below
 * is one (David 2026-10-02: "a builtin way to resume all threads at once that were paused because of
 * hitting a session limit"). A session limit stops every thread on the account at once, so the fleet comes
 * back as a run of identical cards, and continuing them one by one was the only way back before the window
 * reset. Each gets the very message its own card's "Continue now" and Retry send (STALLED_RETRY_MESSAGE),
 * into its own project, and leaves the queue the way a card answered by hand does.
 *
 * Counts the cards the page SHOWS, so in a focused view it resumes that project's and showing All projects
 * every project's. A pause the operator ALSO snoozed is not here — it is not in the queue, and their park
 * outranks the limit (groups.sessionIndicatorKind).
 */
function ResumePaused({ entries, leaving }: { entries: readonly QueueEntry[]; leaving: LeavingCards }) {
  const queryClient = useQueryClient()
  const paused = entries.filter((entry) => isLimitPaused(entry.thread))
  if (paused.length === 0) return null
  const resumeAll = () => {
    const sends = paused.map(({ project, thread }) => {
      const key = threadKey(project.id, thread.id)
      leaving.sent(key)()
      return deliverProjectFollowUp({ projectId: project.id, projectDir: project.projectDir, slug: thread.id, sessionId: thread.sessionId }, STALLED_RETRY_MESSAGE)
        .then(() => leaving.landed(key)(), (error: unknown) => {
          leaving.restore(key)()
          throw error
        })
    })
    showToast(paused.length === 1 ? "Continuing 1 thread…" : `Continuing ${paused.length} threads…`)
    void Promise.allSettled(sends).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length
      if (failed > 0) showToast(`${failed} of ${results.length} could not be continued`)
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    })
  }
  return (
    <Tooltip label="Continue every thread paused by a usage limit">
      <button
        type="button"
        data-resume-paused
        onClick={resumeAll}
        onMouseDown={(event) => event.preventDefault()}
        className="ml-auto shrink-0 rounded-md border border-accent/45 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent outline-none transition-colors hover:border-accent/70 hover:bg-accent/15 focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        Resume {paused.length} paused
      </button>
    </Tooltip>
  )
}

/**
 * Inbox zero, showing All projects — the queue empty in every project, admitting the ones this server has
 * not opened, whose queues it cannot see.
 */
function EmptyQueues({ unopened }: { unopened: number }) {
  return (
    <div data-xq-empty className="flex flex-col items-center gap-2 pt-2">
      <Inbox size={40} strokeWidth={1.25} className="text-muted-30" />
      <div className="text-[13px] text-muted-80">{allEmptyLine(unopened)}</div>
    </div>
  )
}

// ---- Behaviour ---------------------------------------------------------------------------------------

interface LeavingCards {
  isLeaving: (key: string) => boolean
  hidden: (key: string) => boolean
  leave: (key: string) => () => void
  restore: (key: string) => () => void
  /** A reply or Retry was sent: the card leaves, and stays gone for as long as the send is on the wire. */
  sent: (key: string) => () => void
  /** The send landed: the reappear clock starts NOW, not when the button was pressed — see `sent` below. */
  landed: (key: string) => () => void
  /** The card HOLDS: it stays where it is, live, after its thread leaves the queue — see `hold` below. */
  isHeld: (key: string) => boolean
  hold: (key: string) => () => void
}

/**
 * The optimistic exit every action on a card shares: the card fades the moment the operator commits
 * (answer, reply, snooze, done), is gone once the fade ends, and stays gone until the server's next read
 * agrees — or comes back, if REAPPEAR_MS pass and the thread is still in its queue.
 *
 * "STILL IN ITS QUEUE" MEANS ACCORDING TO A READ THAT STARTED AFTER THE ACTION. A card came back on a poll
 * that had left before Mark as done reached the server and landed after REAPPEAR_MS — one took 25s on a
 * loaded server — and it then stayed until the next read landed (David 2026-09-30: "it reopened for
 * a long time"). Such a read cannot know about the action, so it cannot overrule it: the card stays gone
 * until a read that started after the action (after it LANDED, for a send) has come back, and only that
 * read's verdict brings it back. `readAt` is when the newest read STARTED (lib/projectsQueuesRead.ts).
 *
 * A SEND'S CLOCK STARTS WHEN IT LANDS. A reply is not in when it is typed: a cold session resume, a
 * contention retry (lib/eagerComposerSubmission.ts withDeliveryRetry, ~6s of backoff on its own) or a
 * slow provider can hold the request for longer than REAPPEAR_MS, and a clock started at the click then
 * brought the card back — the handoff, with no sign of the reply — while the message was still on its
 * way, only for it to leave again seconds later once the worker picked it up (David 2026-09-30: "I
 * see the same card reappear without the response, then it goes away again a few seconds later and
 * starts working"). So a sent card stays gone while its request is open, and the reappear window opens
 * when it lands: from there, the thread still resting after REAPPEAR_MS is real news. A failed send
 * brings the card back at once (`restore`), with the text in its box.
 *
 * Keyed by `threadKey` (project + slug), never by slug: this page holds several projects' threads, and
 * a slug is unique only within one.
 */
export function useLeavingCards(projects: QueuesProject[], readAt: number | undefined): LeavingCards {
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map())
  // When each acted-on card's action was last known to have reached the server: the click, re-stamped
  // when a send lands. Only a read started after this may bring the card back (see the header). Written
  // only beside a `since` change, so it is never read stale.
  const actedAt = useRef(new Map<string, number>())
  const [, tick] = useState(0)
  const callbacks = useRef(new Map<string, { leave: () => void; restore: () => void; sent: () => void; landed: () => void; hold: () => void }>())
  // Cards whose send is still on the wire: gone whatever their age (see the header).
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set())
  const setFlying = (key: string, flying: boolean) =>
    setInFlight((prev) => {
      if (prev.has(key) === flying) return prev
      const next = new Set(prev)
      if (flying) next.add(key)
      else next.delete(key)
      return next
    })

  // A card whose thread has left its queue on the server needs no guard any more.
  const stillQueued = useMemo(() => new Set(projects.flatMap((p) => p.queued.map((t) => threadKey(p.id, t.id)))), [projects])
  useEffect(() => {
    setSince((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const key of prev.keys()) if (!stillQueued.has(key)) { next.delete(key); actedAt.current.delete(key); changed = true }
      return changed ? next : prev
    })
  }, [stillQueued])

  // A CARD STILL ASKING, WHOSE THREAD WENT TO WORK (2026-09-29). Answers go a question at a time now:
  // one answered on the card sets the worker going, and its thread leaves the queue for the turn — while
  // the card's other questions are still the human's to answer (maintainer: "the remaining questions …
  // should stay there"). Neither way a card leaves fits it: fading takes the rest of the questions away,
  // and a ghost is quiet and dimmed, for a card that waits on nobody. So it holds — drawn live in its
  // place like a card whose thread is still queued — until it is sent away (its last question answered,
  // a reply, done, snooze), it scrolls off, or its thread rests and it is simply queued again. A ref, not
  // state: the hold is read when the queue next redraws, which is exactly when the thread leaves it.
  // It lapses by itself once the thread asks nothing any more (answered from the drawer or another tab,
  // done, archived): a hold keeps a card for its questions, and a card with none is not the human's.
  const held = useRef(new Set<string>())
  const asking = useMemo(
    () => new Set(projects.flatMap((p) => [...p.queued, ...p.running, ...p.snoozed].filter((t) => (t.questions?.length ?? 0) > 0).map((t) => threadKey(p.id, t.id)))),
    [projects],
  )
  useEffect(() => {
    for (const key of held.current) if (!asking.has(key)) held.current.delete(key)
  }, [asking])

  const now = Date.now()
  const handles = (key: string) => {
    let entry = callbacks.current.get(key)
    if (!entry) {
      const leave = () => {
        held.current.delete(key)
        // THE CARET LEAVES WITH THE CARD. Sending a reply leaves it in the emptied box, and a card whose
        // box has the keyboard is kept drawn live (AllQueues `typingKey`). A check that the card was not
        // leaving did not hold: the moment the worker picks the reply up its thread leaves the queue,
        // which ends the leaving, so mid-fade the card snapped back to full opacity — the old handoff,
        // no sign of the reply — and stayed for the worker's whole turn, until a click took the focus
        // (David 2026-10-01: "it just shows up in the old state"; measured: back 170ms into the
        // fade). Blurring ends it at the source, for every way a card is put away.
        const typed = document.activeElement
        if (typed instanceof HTMLElement && typed.closest(`[data-xq-card="${CSS.escape(key)}"]`)) typed.blur()
        // Stamped HERE, not inside the updater: React runs an updater when it processes the update, which
        // a loaded page does ~100ms later — the card then measured younger than EXIT_MS when the fade tick
        // below fired, nothing re-rendered it after, and it stayed drawn until the RPC returned.
        const at = Date.now()
        actedAt.current.set(key, at)
        setSince((prev) => new Map(prev).set(key, at))
        // Re-render at the end of the fade (to unmount) and at the reappear deadline (to restore).
        window.setTimeout(() => tick((n) => n + 1), EXIT_MS + 20)
        window.setTimeout(() => tick((n) => n + 1), REAPPEAR_MS + 20)
      }
      entry = {
        leave,
        restore: () => {
          setFlying(key, false)
          actedAt.current.delete(key)
          setSince((prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          })
        },
        sent: () => {
          setFlying(key, true)
          leave()
        },
        landed: () => {
          setFlying(key, false)
          const at = Date.now()
          actedAt.current.set(key, at)
          // Re-anchored as though the fade had just ended, so the card stays gone rather than fading in
          // again, and a thread that has already left its queue is not given a guard it no longer needs.
          setSince((prev) => (prev.has(key) ? new Map(prev).set(key, at - EXIT_MS) : prev))
          window.setTimeout(() => tick((n) => n + 1), REAPPEAR_MS - EXIT_MS + 20)
        },
        hold: () => { held.current.add(key) },
      }
      callbacks.current.set(key, entry)
    }
    return entry
  }
  const age = (key: string) => {
    const at = since.get(key)
    return at === undefined ? undefined : now - at
  }
  // Gone while the window is open, while a send is on the wire, and while no read has yet started after
  // the action — the last because a read that predates it is no evidence it failed.
  const away = (key: string, elapsed: number) =>
    elapsed < REAPPEAR_MS || inFlight.has(key) || !(readAt !== undefined && readAt > (actedAt.current.get(key) ?? Infinity))
  return {
    isLeaving: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && away(key, elapsed)
    },
    hidden: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && elapsed >= EXIT_MS && away(key, elapsed)
    },
    leave: (key) => handles(key).leave,
    restore: (key) => handles(key).restore,
    sent: (key) => handles(key).sent,
    landed: (key) => handles(key).landed,
    isHeld: (key) => held.current.has(key) && asking.has(key),
    hold: (key) => handles(key).hold,
  }
}

/** Below the page's stacking point (`max-[800px]`), where the columns stack. */
const STACKED_QUERY = "(max-width: 800px)"
function useStacked(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia?.(STACKED_QUERY)
      media?.addEventListener("change", onChange)
      return () => media?.removeEventListener("change", onChange)
    },
    () => Boolean(window.matchMedia?.(STACKED_QUERY).matches),
    () => false,
  )
}

/**
 * A queue row's click: bring its card to the top of the window and ring it, for a page whose cards are
 * keyed by project. (The project board had its own, store.ts scrollToQueueCard, until 2026-09-28.) Returns
 * the scroll offset it landed on (null when the card is gone), which the keyboard's cursor holds on to.
 */
function useScrollToCard(): (key: string, cold?: boolean) => number | null {
  return useCallback((key: string, cold = false) => {
    // Before measuring: a card a key opened, and this row leaves, closes first, and the glide lands on
    // where the card is once it has.
    releaseAutoOpened(key)
    const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
    if (!slot) return null
    // A card far down the page may not be built yet (lib/cardVisibility.ts): build and draw it first, so
    // what lands is the card, with a root to ring and its real height.
    drawCardNow(slot)
    // A COLD LINK lands at once, and is held there while the cards above it build and fetch
    // (lib/queueLandingHold.ts). A row or a key glides, read again when the glide ends: a card that
    // arrived or left above it meanwhile moved it.
    const top = cold ? holdCard(key) : glideTo(() => slot.getBoundingClientRect().top + window.scrollY - QUEUE_CARD_VIEWPORT_TOP)
    const root = slot.querySelector<HTMLElement>("[data-xq-card-root]")
    if (!root) return top
    root.removeAttribute("data-queue-flash")
    // Re-arm on the next frame so a second click on the same row replays the ring.
    requestAnimationFrame(() => {
      root.setAttribute("data-queue-flash", "")
      window.setTimeout(() => root.removeAttribute("data-queue-flash"), 1100)
    })
    return top
  }, [])
}

/** The page offset that lands `key`'s card at the top of the window, or null when it is not on the page. */
function cardLanding(key: string): number | null {
  const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
  return slot ? Math.max(0, slot.getBoundingClientRect().top + pageScrollY() - QUEUE_CARD_VIEWPORT_TOP) : null
}

/** Land `key`'s card at once and hold it there (lib/queueLandingHold.ts). Returns the offset it landed on. */
function holdCard(key: string): number {
  holdQueueCardLanding(() => document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`), () => cardLanding(key))
  return pageScrollY()
}

/**
 * A COLD LINK TO A QUEUED THREAD lands on its card (store.ts resolveRoutedThread, upstream's deep link):
 * `/project/<slug>/thread/<t>` from a bookmark, a pasted URL, another page. The board registers how,
 * and answers "pending" until its cards are drawn — `known`, the queues read at least once (the project
 * list alone, which can land first, draws no card) — then settles the slug that waited. A thread with no card here (not queued, or no such card drawn) is
 * "absent", and the route opens its drawer.
 */
function useRoutedLanding(enabled: boolean, known: boolean, projectId: string | undefined, land: (key: string, cold?: boolean) => number | null): void {
  const latest = useRef({ known, projectId, land })
  latest.current = { known, projectId, land }
  useEffect(() => {
    if (!enabled) return
    const unregister = registerRoutedLanding((slug) => {
      const { known, projectId, land } = latest.current
      if (!known) return "pending"
      if (projectId === undefined) return "absent"
      const key = threadKey(projectId, slug)
      if (!document.querySelector(`[data-xq-card="${CSS.escape(key)}"][data-queue-leaving="false"]:not([data-queue-ghost])`)) return "absent"
      return land(key, true) === null ? "absent" : "landed"
    })
    // The slug that waited while the queue was loading.
    resolveRoutedThread()
    return unregister
  }, [enabled, known])
}

/**
 * `j` / `k` and the card commands on this page (lib/keyboardRuntime.ts): the card being read is the one
 * the rail marks, and a key lands on a card exactly as a rail row does. The landing is SMOOTH here, so
 * for the length of the glide — and for as long as the page then stays where it put it — the target is
 * held as the card being read; otherwise a quick `j j` would step twice from the card the glide was
 * leaving and land on the same card again.
 *
 * That card also wears an accent border (`data-queue-current`), for as long as it is the one a `d` or `s`
 * would act on — the flash alone faded after a second and left no sign of which card the next key would
 * finish. An open drawer takes the keys (currentThreadSurface), so the border steps off while one is.
 *
 * A CLICK in a card makes it the card being read, held like a key's landing for as long as the page stays
 * put: the scrollspy's line is a third of the way down, so the last card or two — which the page cannot
 * scroll that far — could otherwise never be picked at all. Returns the card being read, which the rail
 * and its connector mark, so they agree with the ring.
 */
function useQueueKeys(activeKey: string | null, scrollToCard: (key: string, cold?: boolean) => number | null, enabled = true): { active: string | null; land: (key: string, cold?: boolean) => number | null } {
  const reading = useRef(activeKey)
  reading.current = activeKey
  // `y` is where the landing put the page. A cold landing's is wherever its card stands now: the hold moves
  // the page with the card while the queue above it builds (lib/queueLandingHold.ts).
  const landing = useRef<{ key: string; y: () => number; until: number } | null>(null)
  const current = useCallback(() => {
    const held = landing.current
    // A held card that has since been finished or snoozed is not being read any more.
    if (held && document.querySelector(`[data-xq-card="${CSS.escape(held.key)}"][data-queue-leaving="false"]`)) {
      const reachable = Math.min(held.y(), Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
      // UNTIL THE GLIDE LANDS, however long it takes. `until` alone (700ms) ran out mid-glide on a long
      // jump — a rail click from the top of the queue to its last card, measured 2026-09-29 — and the
      // failed check below then DROPPED the hold, so the card being read fell back to the scrollspy
      // before the page had even arrived, and after it landed the reading line sat on the card above.
      if (performance.now() < held.until || gliding() || Math.abs(window.scrollY - reachable) <= 2) return held.key
    }
    landing.current = null
    return reading.current
  }, [])
  const root = useCallback((key: string) => {
    const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
    return slot?.querySelector<HTMLElement>("[data-xq-card-root], [data-queue-card-root]") ?? slot
  }, [])
  const [ringed, setRinged] = useState<string | null>(null)
  // THE ONE LANDING, for a key AND a rail row. The rail used to get the bare scrollToCard, so a row click
  // glided with no hold and the card being read fell to the scrollspy's reading line. A card that cannot
  // reach the landing spot — the last one, when the page bottoms out first — then left the line on the
  // card ABOVE it: clicking "Rotate the signing key", last in the queue, marked and ringed "Pick the key
  // rollout", and `d`/`s` would have finished or snoozed that one (driven 2026-09-29 on a real
  // two-project stack, 1440×900 and 1440×1600). Held here, the clicked card is the one being read until
  // the reader scrolls away, exactly as after `j`/`k`. Returns the glide's target (null: no such card),
  // which the row reads to fall back to opening the thread.
  const land = useCallback((key: string, cold = false) => {
    const y = scrollToCard(key, cold)
    if (y !== null) {
      landing.current = { key, y: cold ? () => cardLanding(key) ?? y : () => y, until: performance.now() + 700 }
      setRinged(key)
    }
    return y
  }, [scrollToCard])
  useEffect(() => enabled ? registerQueueCursor({
    // Not a ghost (lib/stableQueue.ts), whose thread is no longer waiting, nor a card whose drawer is open.
    keys: () => [...document.querySelectorAll<HTMLElement>('[data-xq-card][data-queue-leaving="false"]:not([data-queue-ghost]):not([data-queue-concealed])')]
      .map((slot) => slot.dataset.xqCard ?? "")
      .filter(Boolean),
    current,
    root,
    go: (key) => void land(key),
  }) : undefined, [land, current, root, enabled])

  // Re-read on every render (a card leaving re-renders the page) and on scroll (which can end a hold);
  // an unchanged key is a bail-out, not a render.
  useEffect(() => setRinged(current()))
  useEffect(() => {
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setRinged(current()))
    }
    window.addEventListener("scroll", sync, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", sync)
    }
  }, [current])

  useEffect(() => {
    const pick = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      const slot = event.target.closest<HTMLElement>(
        '[data-xq-card][data-queue-leaving="false"]:not([data-queue-ghost]):not([data-queue-concealed])',
      )
      const key = slot?.dataset.xqCard
      if (!key) return
      releaseAutoOpened(key)
      const y = window.scrollY
      landing.current = { key, y: () => y, until: 0 }
      setRinged(key)
    }
    document.addEventListener("pointerdown", pick)
    return () => document.removeEventListener("pointerdown", pick)
  }, [])

  // An ATTRIBUTE set imperatively, like the flash: the roots are two different card components, and React
  // never touches an attribute absent from its props.
  const drawerOpen = useSnapshot(store).drawers.some((drawer) => !drawer.closing)
  const target = drawerOpen ? null : ringed
  useEffect(() => {
    const el = target ? root(target) : null
    el?.setAttribute("data-queue-current", "")
    return () => el?.removeAttribute("data-queue-current")
  }, [target, root])
  return { active: ringed, land }
}

/**
 * Which card is being read — the one crossing the reading line (lib/readingLine.ts: a third of the way
 * down the window, sliding to its bottom as the page bottoms out) — so its row in the list wears the scroll marker (Sidebar.tsx ThreadRow `active`).
 */
function useScrollspy(cards: readonly { key: string; ghost: boolean }[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  // A card turning into a gap re-reads the line too: it is skipped, so the card being read changes.
  const signature = cards.map((card) => `${card.key}${card.ghost ? "~" : ""}`).join(",")
  useEffect(() => {
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const line = readingLine(window.innerHeight, window.scrollY, document.documentElement.scrollHeight)
        let found: string | null = null
        // Never a ghost's empty gap (lib/stableQueue.ts): there is nothing there to read.
        for (const slot of document.querySelectorAll<HTMLElement>("[data-xq-card]:not([data-queue-ghost])")) {
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
