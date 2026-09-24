import { proxy } from "valtio"
import type { BoardSnapshot, ThreadView, BoardDelta } from "@frizz/shared"
import { applyBoardDelta } from "@frizz/shared"
import type { ComposerContextItem } from "./lib/composerContext.ts"
import { disarmFullscreenMorph } from "./lib/fullscreenMorph.ts"
import { closeDrawerAnimated, focusDrawer } from "./lib/overlays.ts"
import { isPageScrollLocked, pageScrollY, requestScrollAfterUnlock } from "./lib/pageScrollLock.ts"
import { resolveThreadRoute } from "./lib/threadRouteState.ts"
import { standaloneThreadHref } from "./lib/standaloneThreadRoute.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { resetGithubCards } from "./lib/githubHovercards.ts"
import { setLocalPathBase } from "./lib/localPathBase.ts"
import { basename } from "./lib/paths.ts"
import { prefersReducedMotion, SHEET_CLOSE_MS } from "./lib/sheet.ts"
import type { RestartAttempt } from "./api/restart.ts"

// Where a scroll-to-card lands a card's outer border below the viewport top (px). Exported because the
// sidebar's reading rail watches for that same landing to know a click-to-card has arrived.
// 40px is the queue's own rhythm: the hairline rule between two cards carries `my-10` (40px) on each
// side, so a landed card sits under the viewport edge with exactly the space it has under its
// predecessor's rule. It was 12px until 2026-08-25, which read as the card being pressed against the
// top of the window (maintainer: "we should leave the full 40 px").
export const QUEUE_CARD_VIEWPORT_TOP = 40

// The BORDERED CARD ROOT inside a queue slot. The outer `[data-queue-card]` slot is the fade wrapper:
// it also spans the root's own bottom scroll-reserve margin, and it is not the element that draws the
// border, so anything visual — the scroll landing, the arrival ring — targets this root. (Until
// 2026-08-25 the slot also wrapped the inter-card hairline rule and its 40px margins; the rule is a
// sibling of the slots now, see TodosView's queue list.)
// Falls back to the slot itself for a slot that renders no root (fixtures, future card shapes).
function queueCardSlot(slug: string): HTMLElement | null {
  if (typeof document === "undefined") return null
  return document.querySelector<HTMLElement>(`[data-queue-card="${CSS.escape(slug)}"]`)
}
function queueCardRoot(slug: string): HTMLElement | null {
  const el = queueCardSlot(slug)
  if (!el) return null
  return el.querySelector<HTMLElement>(`[data-queue-card-root="${CSS.escape(slug)}"]`) ?? el
}

// Whether `slug` is the FIRST card in the queue — the topmost slot that isn't fading out. A fading
// predecessor still holds its row for the exit's duration, but it is already gone from the reader's
// point of view (and the dismissal landing runs after it unmounts), so it doesn't count.
function isFirstQueueCard(slug: string): boolean {
  const first = document.querySelector<HTMLElement>('[data-queue-card]:not([data-queue-leaving="true"])')
  return first !== null && first === queueCardSlot(slug)
}

// Absolute scrollY that lands `slug`'s bordered card root at the standard viewport-top landing.
// Shared by the sidebar's scroll-to-card and the queue's dismissal auto-scroll. Accounts for the
// narrow-layout fixed chrome the cards' sticky headers also dodge (max-[800px]:top-10 → 40px), so a
// landed card's header sits at its natural position instead of being pushed down into the body.
// null when the card isn't mounted.
// `pageScrollY()`, not `window.scrollY`: with a drawer open the page is scroll-LOCKED and window.scrollY
// reads 0 while the body sits shifted at the real offset, which would put every landing short by
// however far the reader had scrolled before opening the drawer.
//
// The FIRST card lands at the very top of the page instead. At rest its box sits 52px below the page
// top (main's py-5 plus the queue column's py-8, measured 2026-08-28), so the standard landing is
// scrollY 12: clearing a card whose successor headed the queue left the page scrollable by that sliver
// (maintainer 2026-08-28: "it scrolls me like there's like 10 pixels that I could scroll up from where
// it scrolls me to, and it's very annoying").
export function queueCardTargetY(slug: string): number | null {
  const root = queueCardRoot(slug)
  if (!root) return null
  if (isFirstQueueCard(slug)) return 0
  // matchMedia guarded: unit tests stub a minimal window without it (store.queue-navigation.test.ts).
  const navOffset = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 800px)").matches ? 40 : 0
  return Math.max(0, pageScrollY() + root.getBoundingClientRect().top - QUEUE_CARD_VIEWPORT_TOP - navOffset)
}

export type ConnectionState = "connecting" | "open" | "closed"
export interface SocketPayloadFallback {
  actualBytes: number
  maxBytes: number
}
export type SocketTranscriptFallback =
  | ({ kind: "payload-too-large" } & SocketPayloadFallback)
  | { kind: "read-budget"; scope: "origin" | "global"; retryAfterMs: number }

// What the workpane (the centered main column) shows: "todos" (the queue — cards + dispatch box, the
// resting page) or "status:<s>" (URL-only per-status lists). THREADS render in the side-drawer stack
// over the queue; there is no main-view thread surface and no nav selection (the focus machine and
// the sidebar arrow-walk were deleted — the sidebar is mouse-driven). The router is the writer.
export type View = "todos" | `status:${string}`

// The whole app renders off this single valtio proxy. Board is a full snapshot
// pushed over SSE (no diff protocol); everything else is local UI state.
export const store = proxy({
  board: null as BoardSnapshot | null,
  view: "todos" as View,
  connection: "connecting" as ConnectionState,
  // The durable supervisor, rather than a disposable board child, owns this truth. While it is
  // restarting, all text remains in the session-backed draft store but write RPCs are held locally.
  // This prevents a successful-looking old UI from racing a successor artifact.
  controlPlaneState: "ready" as "ready" | "restarting" | "failed",
  controlPlaneMessage: null as string | null,
  // A user-initiated update+restart flips the overlay on OPTIMISTICALLY (before the POST is acked) so
  // the block is instant. While an attempt is recorded here, the status poll must not apply a "ready"
  // it reads — that would tear the overlay down and could reload onto the old child — and it must not
  // believe ANY answer whose request started before the ack, whichever state it names: a "failed" that
  // was already in flight when the operator clicked retry used to clear this guard for the new attempt
  // (pullfrog on #35, 2026-09-11). `ackedAt` is set when the supervisor accepts the transition; the
  // record is cleared by App's poll effect once an answer requested after that ack observes it
  // (nextControlPlane in api/restart.ts), or by the button when the POST is rejected.
  controlPlaneRestartAttempt: null as RestartAttempt | null,
  showSettings: false,
  showPalette: false,
  // The anywhere-modal behind the "New thread" pill (Gmail-compose style).
  showNewThread: false,
  // The GitHub picker modal (Issues/PRs tabs → multi-select → batch dispatch). Its trigger appears
  // only when gh is authed AND the project is a GitHub repo; see GithubTrigger + openGithubPicker.
  // The modal reads the durable new-thread profile live and carries its own selector for it, so
  // nothing about the dispatch tuple is captured here.
  showGithubPicker: false,
  // Left-sidebar section collapse (true = collapsed). Only Active leads expanded — it is the live
  // work and has no header to collapse from. Snoozed and Done start collapsed: each is a band
  // whose header count already says how much is parked there, so the rail opens on what is running.
  // Session-scoped UI state (deliberately not persisted).
  // `external` is the External band — the human's own terminals. Collapsed by default like
  // Snoozed/Done: nothing in it is frizz's work or waiting on the rail's reader, so the count is
  // the glance.
  sidebarCollapsed: { active: false, snoozed: true, inactive: true, external: true } as Record<"active" | "snoozed" | "inactive" | "external", boolean>,
  // The SIDE-DRAWER STACK — arbitrary depth. `thread` layers are full thread views (the Open-thread
  // sheet); `doc` layers are the frizz-document markdown; `markdown` layers are the built-in reader for
  // a `.md` FILE on disk, opened from any link to one; `subagent` and `shell` layers are read-only
  // operation drill-ins that overlay a thread. A drill-in within one thread's family
  // (its doc, its sub-agents) stacks OVER the previous layer (higher z, slight inset); any lateral open
  // REPLACES the layers it doesn't stack over (one drawer at a time — see openOrRaiseDrawer). Esc /
  // backdrop / browser-Back unwind the TOP layer first. There is no
  // standalone thread page — this stack is the only thread surface. Operation-only fields ride the
  // same entry so App can render its sheet without a board lookup after the operation finishes.
  drawers: [] as {
    id: number
    kind: "thread" | "doc" | "subagent" | "shell" | "markdown" | "terminal"
    slug: string
    routed?: boolean // URL/deep-link-created thread: visible on first paint, never an invisible animated backdrop
    subId?: string // subagent/shell: the launch tool_use id (the RPC handle + dedupe key)
    label?: string // subagent: the dispatch description (header title) / markdown: the basename
    path?: string // markdown: the absolute file path
    subagentType?: string // subagent: the model+effort cell tag
    startedAt?: string // subagent: ISO8601 dispatch time (drives the header's running elapsed)
    openedAt?: number // bumped when an existing logical layer is focused/reopened
    closing?: boolean // set the instant this layer's slide-OUT begins, so URL/topThreadSlug stop
    // counting it before its 210ms removal (prevents a phantom /thread history push when a view
    // change races the close — see markDrawerClosing).
  }[],
  // Mirrors settings.notifications so the (React-free) SSE handler can gate desktop
  // notifications without reaching into TanStack Query. Kept in sync from App.
  notificationsEnabled: false,
  // True once the /ws multiplex confirms it's live (server pushes transcript updates into the query
  // cache). useTranscript reads this to DROP its 1.5s poll + subscribe instead; false before the socket
  // confirms and on SSE fallback (a pre-restart server without /ws), where polling stays exactly as today.
  socketTranscripts: false,
  // Explicit transport downgrades reported by the multiplex server. A board overflow switches the whole
  // board channel to SSE once; a transcript overflow/read-budget rejection pauses only that slug's live
  // subscription while the last complete copy remains visible and manually refreshable. All reset on reload.
  socketBoardFallback: null as SocketPayloadFallback | null,
  socketTranscriptFallbacks: {} as Record<string, SocketTranscriptFallback>,
  // A `/thread/<slug>` URL whose destination is not settled yet. The router cannot decide it alone:
  // a QUEUED thread already has its full card in the main column, so the URL belongs to that card,
  // not to a drawer over it — and on a cold load the board hasn't arrived, so `needsYou` is unknown.
  // The router parks the slug here and App resolves it the first render the board is authoritative
  // (see resolveRoutedThread). Snoozed slugs keep the address bar on /thread/<slug> meanwhile.
  routeThreadSlug: null as string | null,
  // The slug whose BOARD surface (thread drawer or queue card) is currently wearing
  // `view-transition-name: thread-chat`, so the /full page's thread column has somewhere to morph
  // back into when the fullscreen page is left for the board (browser Back, or the collapse icon).
  // Set render-phase by primeFullscreenReturn and cleared on a timer just past the animation — a
  // surface that KEPT the name would collide with the next door click's imperative tag, and duplicate
  // view-transition-names abort the whole transition.
  vtReturnTarget: null as string | null,
  // Transient bottom-center toast (e.g. "Steer failed …" when an eager reply is rejected). `id` bumps per call so
  // repeat toasts re-trigger the fade. Rendered by <Toaster>; null when nothing is showing.
  toast: null as { id: number; text: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string; drawer?: "thread" | "terminal" } } | null,
  // The /full page's SPLIT file viewer. True only while StandaloneThreadPage is mounted; while it is,
  // a `.md` click renders BESIDE the thread (the thread column slides left) instead of as an overlay
  // drawer — the whole point of /full is seeing the transcript, and a sheet over it defeated that.
  // The queue page keeps the drawer: its main column is the queue, not the thread being read.
  splitFileViewer: false,
  // Keep each reader mounted under the next so following a link preserves its scroll and view mode.
  // Instance ids (not paths) also let A → B → A unwind through both visits independently.
  filePanels: [] as { id: number; path: string; closing?: boolean }[],
  // SELECTED-CONTEXT items staged for a thread's next message (⌘I over a selection in the file
  // viewer). Rendered as chips above the thread's composer — every surface showing that composer shows
  // them — and serialized into the outgoing text on send. Session-scoped on purpose: unlike the typed
  // draft these are quotes of files on disk, re-creatable in two keystrokes.
  composerContext: {} as Record<string, ComposerContextItem[]>,
})

export function openNewThread(): void {
  store.showNewThread = true
}

// Open the GitHub picker modal (batch-dispatch from issues/PRs). The trigger that calls this is
// itself gated on gh being authed + in a GitHub repo, so the modal only opens when the RPCs can serve.
export function openGithubPicker(): void {
  store.showGithubPicker = true
}

export function closeGithubPicker(): void {
  store.showGithubPicker = false
}

let toastSeq = 0
export function showToast(text: string, opts?: { spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string; drawer?: "thread" | "terminal" } }) {
  store.toast = { id: ++toastSeq, text, ...opts }
}

// ── drawer stack ─────────────────────────────────────────────────────────────────────────────────
let drawerSeq = 0
let drawerOpenSeq = 0
type Drawer = (typeof store.drawers)[number]

// Kind is part of the identity: a chat thread and its document can deliberately stack, while a
// second request for that same chat (or document) must reuse the existing layer.
function sameDrawer(a: Drawer, b: Pick<Drawer, "kind" | "slug" | "path" | "subId">): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "markdown") return a.path === b.path
  if (a.kind === "subagent" || a.kind === "shell") return a.subId === b.subId
  return a.slug === b.slug
}

// The only layers a new drawer legitimately stacks OVER are its own thread's family: a sub-agent
// transcript over its parent thread/doc, and a thread⇄doc pair sharing a slug. Everything else —
// sibling threads, sibling sub-agents — is a lateral move, not a drill-in.
function stacksOver(below: Drawer, next: Pick<Drawer, "kind" | "slug">): boolean {
  // A `.md` reader is always a DRILL-IN: it is opened by clicking a link inside whatever is already
  // showing (a chat message, another document), so replacing that layer would close the very
  // prose the link was read from. It stacks over anything, its own kind included — following a doc's
  // link to a sibling doc and pressing Esc to come back is the whole point of a reader.
  if (next.kind === "markdown") return true
  if (next.kind === "subagent" || next.kind === "shell") return (below.kind === "thread" || below.kind === "doc") && below.slug === next.slug
  if (next.kind === "doc") return below.kind === "thread" && below.slug === next.slug
  if (next.kind === "thread") return below.kind === "doc" && below.slug === next.slug
  return false
}

function openOrRaiseDrawer(next: Omit<Drawer, "id" | "closing" | "openedAt">): void {
  // ONE-DRAWER POLICY (maintainer 2026-07-21): opening a layer REPLACES every live layer it doesn't
  // logically stack over, so lateral moves (sidebar sibling thread/sub-agent clicks) swap the
  // open drawer instead of piling up; only drilling into the open thread's own child/doc stacks.
  const displaced = store.drawers.filter((d) => !d.closing && !sameDrawer(d, next) && !stacksOver(d, next)).map((d) => d.id)
  if (displaced.length) closeDrawersById(displaced)

  const matches = store.drawers.filter((drawer) => sameDrawer(drawer, next))
  if (!matches.length) {
    store.drawers.push({ ...next, id: ++drawerSeq, openedAt: ++drawerOpenSeq })
    return
  }

  // Keep the newest non-closing instance. This heals old duplicate state too: one logical layer
  // remains, so closing a drawer can never reveal an identical one beneath it.
  const existing = [...matches].reverse().find((drawer) => !drawer.closing) ?? matches[matches.length - 1]!
  const { closing: _closing, ...liveExisting } = existing
  const reopened = { ...liveExisting, ...next, openedAt: ++drawerOpenSeq }
  store.drawers = [...store.drawers.filter((drawer) => !sameDrawer(drawer, next)), reopened]
  // Existing layers are already mounted. Let their local focus manager restore focus after Valtio
  // publishes the reordered/reopened stack without manufacturing another component instance.
  queueMicrotask(() => focusDrawer(existing.id))
}

// Slugs whose FULL panel is up in a live drawer — the chat sheet, or a command thread's terminal. The
// queue hides these threads' cards: the open paths never stack a drawer over a queued card (see
// openThread / scrollToQueueCard), but a thread whose drawer is ALREADY open can rest INTO the queue,
// and its card then mounted behind the drawer showing the identical panel twice (maintainer
// 2026-09-23). Hiding the card rather than closing the drawer is deliberate: the reader is usually in
// that drawer's composer at exactly that moment. A closing layer does not count, so the card is back in
// place as the drawer slides off it. A doc drawer shows different content and does not hide the card.
export function slugsInThreadDrawers(drawers: readonly Pick<Drawer, "kind" | "slug" | "closing">[]): Set<string> {
  return new Set(drawers.filter((d) => !d.closing && (d.kind === "thread" || d.kind === "terminal")).map((d) => d.slug))
}

export function pushDrawer(kind: "thread" | "doc" | "terminal", slug: string, opts?: { routed?: boolean }): void {
  openOrRaiseDrawer({ kind, slug, routed: opts?.routed })
}

// Open a sub-agent's transcript as a new drawer layer OVER whatever's on top (typically the thread it
// was dispatched from). `slug` is the PARENT thread; `subId` is the dispatch tool_use id (the RPC
// handle). Deduped on subId so a double-click / re-click doesn't stack duplicates.
export function pushSubAgentDrawer(slug: string, subId: string, opts: { label: string; subagentType?: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "subagent", slug, subId, label: opts.label, subagentType: opts.subagentType, startedAt: opts.startedAt })
}

export function pushBackgroundShellDrawer(slug: string, id: string, opts: { label: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "shell", slug, subId: id, label: opts.label, startedAt: opts.startedAt })
}

// Open a thread from a listing/notification click-through. A QUEUED thread short-circuits to its own
// card (see scrollToQueueCard below) — every affordance that asks to "show me this thread" obeys the
// one rule, so nothing can stack a drawer on top of the identical panel. Otherwise routing is by
// runtime: a thread with NO session ever spawned (runtime "none" — no transcript, the chat drawer
// would be an empty placeholder) opens its frizz DOCUMENT drawer instead — there
// the doc IS the substance. Anything with a session (live or exited — exited transcripts are worth
// seeing) opens the chat drawer. The doc drawer carries the adopt ("Start a session") affordance.
export function openThread(slug: string): void {
  const t = store.board?.threads.find((x) => x.id === slug)
  // A terminal command thread has no chat and no document: its drawer IS the live terminal.
  if (t?.kind === "command") return pushDrawer("terminal", slug)
  if (t?.needsYou && scrollToQueueCard(slug)) return
  pushDrawer(t && t.runtime === "none" ? "doc" : "thread", slug)
}

// Settle a parked `/thread/<slug>` URL, now that the board can say whether the thread is queued.
// A deep link deliberately asks for the CHAT surface even for a session-less thread (unlike
// openThread's doc-routing), so this pushes the thread layer rather than delegating — but it obeys
// the same queue-card rule: a needsYou thread renders its whole panel inline in the main column, and
// opening the routed drawer over it painted that panel TWICE, one half-occluding the other.
// `routed` so a cold page paints the sheet already open instead of animating a phantom backdrop in.
export function resolveRoutedThread(): void {
  const slug = store.routeThreadSlug
  if (!slug || !store.board) return
  store.routeThreadSlug = null
  const route = resolveThreadRoute(store.board, slug)
  // A slug THIS project does not have. Since one server started serving every project that is usually
  // a thread another project has — and `/thread/<slug>` is the exact shape every pre-singleton
  // bookmark and every agent-written cross-reference uses, so it is not a rare typo. Pushing the
  // drawer anyway opened an empty sheet over the board that said nothing and offered nothing.
  // The `/full` page already knows how to recover: <MissingThread> asks `threadLocate` which project
  // owns the slug and relocates there. Hand it over rather than growing a second copy of that.
  if (route.kind === "missing") {
    if (typeof location !== "undefined") location.replace(standaloneThreadHref(slug))
    return
  }
  if (route.kind === "found" && route.thread.needsYou && scrollToQueueCard(slug)) return
  pushDrawer(route.kind === "found" && route.thread.kind === "command" ? "terminal" : "thread", slug, { routed: true })
}

// THE FULLSCREEN DOOR, PLAYED BACKWARDS. react-router re-arms the door's view transition for the POP
// back out of /full (it remembers which path pairs transitioned), and the collapse icon opts in
// explicitly — but the transition can only morph the /full thread column into a board surface that
// EXISTS and IS NAMED in the board's FIRST commit, the one the new-state snapshot reads. Left to the
// ordinary flow, the drawer arrives two effects later (applyPath parks the slug, resolveRoutedThread
// settles it) and no board surface ever wears the name, so Back played as a bare crossfade
// (maintainer 2026-09-02: "when I hit the back button on full-screen view, it doesn't undo the
// animation"). StandaloneRoute records its slug on every render; BoardRoute consumes it in a
// render-phase initializer — the mirror of StandaloneRoute's own render-phase drawer clear.
let lastStandaloneSlug: string | null = null
export function noteStandaloneThreadRender(slug: string): void {
  lastStandaloneSlug = slug
}

export function primeFullscreenReturn(routedSlug: string | undefined): void {
  // The forward door started its morph from the visible part of the board surface; this render is
  // inside the REVERSE transition's update callback, so dropping that here — before the browser builds
  // the reverse leg's pseudo-elements — is what hands the return morph back to the browser's own
  // keyframes. Unconditional: any way back to the board retires it (lib/fullscreenMorph).
  disarmFullscreenMorph()
  const slug = lastStandaloneSlug
  lastStandaloneSlug = null
  if (!slug) return
  // Name whichever surface this slug renders as — ThreadSheet and the queue card both check this.
  // Cleared well past the 200ms animation: clearing in an effect could beat the new-state capture
  // and un-name the element mid-transition.
  store.vtReturnTarget = slug
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      if (store.vtReturnTarget === slug) store.vtReturnTarget = null
    }, 600)
  }
  // The drawer itself, only when the return URL names this thread and the board can already say it
  // is NOT queued (a queued thread's surface is its card, which the queue mounts in this same pass).
  // The same painted-open push resolveRoutedThread would make — just in the commit the snapshot
  // actually reads; applyPath then finds the layer already present and leaves it be.
  if (routedSlug !== slug || !store.board) return
  const route = resolveThreadRoute(store.board, slug)
  if (route.kind !== "found" || route.thread.needsYou) return
  if (store.drawers.some((d) => d.kind === "thread" && d.slug === slug && !d.closing)) return
  pushDrawer("thread", slug, { routed: true })
}

// A thread that's ALREADY in the queue (needsYou) has its full card in the main column — clicking its
// sidebar row SCROLLS to that card and stops there; it does NOT open a redundant drawer over it
// (maintainer 2026-07-09: "the queue is how you know"; 2026-07-15: "just auto-scroll to the item in the
// queue"). Returns false if no card is mounted (not queued / not rendered), so the caller falls back to
// opening the drawer instead.
//
// Any drawer already on screen is DISMISSED here (maintainer 2026-08-11: "clicking a queued item in the
// sidebar should both DISMISS the current drawer and autoscroll"). It has to happen in this one place
// rather than at the sidebar's call site: a drawer over the queue is precisely what stops you seeing the
// card, so every "show me this card" door — the rail, the palette, a deep link, a notification
// click-through — wants it gone. The plain sheets also spread a full-screen scrim, which the click
// would otherwise land on instead of the row.
export function scrollToQueueCard(slug: string): boolean {
  const root = queueCardRoot(slug)
  if (!root) return false
  const targetY = queueCardTargetY(slug)
  const open = store.drawers.filter((drawer) => !drawer.closing).map((drawer) => drawer.id)
  if (open.length) closeDrawersById(open)
  // Absolute scroll is intentional. A narrow layout may have just changed document geometry while a
  // drawer finished closing; a relative scroll in that transition can be applied to the old root and
  // strand the reader midway through a tall card. Land the bordered root atomically.
  //
  // But the scroll LOCK outlives this click: a dismissed drawer keeps its stack slot for the ~210ms
  // slide-out, so the body is still pinned and `window.scrollTo` would be clamped to a no-op — and the
  // unlock would then restore the pre-click offset over the top of it. Park the landing instead and let
  // the unlock apply it, which is also what makes the scroll land in ONE step rather than visibly
  // jumping back to where the reader was first.
  if (targetY !== null) {
    if (isPageScrollLocked()) requestScrollAfterUnlock(targetY)
    else if (Math.abs(window.scrollY - targetY) > 0.5) window.scrollTo({ top: targetY, left: 0, behavior: "auto" })
  }
  flashQueueCard(slug, root)
  return true
}

// Pending ring teardowns, keyed by slug. A RE-CLICK inside the window must replay the ring and own the
// single removal; without this the first click's timer would cut the second ring short.
const queueFlashTimers = new Map<string, number>()

// The arrival ring. It goes on the bordered card ROOT, never the outer `[data-queue-card]` slot: the
// slot is the fade wrapper, not the bordered box — and while it still wrapped the inter-card hairline
// rule and its margins, ringing it drew the card AND ~80px of gutter plus that rule as one highlighted
// box (maintainer, 2026-07-21).
// An ATTRIBUTE rather than a class, because the root's className is REACT-OWNED (it flips on the card's
// `resolving` state) — a re-render rewrites className wholesale and would silently wipe an imperatively
// added class mid-flash. React never touches an attribute absent from its props.
function flashQueueCard(slug: string, root: HTMLElement): void {
  const pending = queueFlashTimers.get(slug)
  if (pending !== undefined) window.clearTimeout(pending)
  // Re-setting an attribute that is already present does NOT restart a CSS animation, so clicking the
  // same sidebar row twice would produce no visible response at all (the scroll is already at the
  // landing, and the caller deliberately doesn't fall through to a drawer). Drop it and force a reflow.
  root.removeAttribute("data-queue-flash")
  void root.offsetWidth
  root.setAttribute("data-queue-flash", "")
  queueFlashTimers.set(slug, window.setTimeout(() => {
    queueFlashTimers.delete(slug)
    root.removeAttribute("data-queue-flash")
  }, 1100))
}

// Open a `.md` file that lives on disk in Frizz's OWN reader, rather than handing the path to the
// desktop opener. Every link to one routes here (lib/local-file-links.ts): agent prose citing a repo
// doc, an inline-code path that resolved to one, an attached `.md`. `path` is the absolute POSIX path
// the server will re-gate; the basename is the header title. Queue drawers are deduped on path.
export function pushMarkdownDrawer(path: string): void {
  // On /full the reader is a SPLIT PANEL beside the thread, not a sheet over it — route every
  // markdown open there while that page is mounted, stacking links from the transcript AND reader.
  if (store.splitFileViewer) {
    openFilePanel(path)
    return
  }
  openOrRaiseDrawer({ kind: "markdown", slug: path, path, label: basename(path) })
}

// ── the /full split file viewer ──────────────────────────────────────────────────────────────────
let filePanelSeq = 0

export function openFilePanel(path: string): void {
  store.filePanels.push({ path, id: ++filePanelSeq })
}

export function closeFilePanel(): void {
  const top = store.filePanels.at(-1)
  // A closing layer still owns the top until its slide finishes, like the drawer stack.
  if (!top || top.closing) return
  top.closing = true
  const id = top.id
  window.setTimeout(() => {
    store.filePanels = store.filePanels.filter((panel) => panel.id !== id)
  }, prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
}

// ── selected-context items (⌘I in the file viewer) ───────────────────────────────────────────────
let contextSeq = 0

export function addContextItem(slug: string, item: Omit<ComposerContextItem, "id">): void {
  const items = store.composerContext[slug] ?? (store.composerContext[slug] = [])
  items.push({ ...item, id: ++contextSeq })
}

// There is no remove-by-id: an item leaves the roster when its `@` token leaves the draft prose
// (ThreadComposerBox's token sweep) — the token in the text is the only handle the human has on it.

// Take (and clear) a thread's staged items at send time. Returns plain copies so the caller can
// restore them on a rejected send — the proxy entries themselves are gone from the store by then.
export function takeContextItems(slug: string): ComposerContextItem[] {
  const items = (store.composerContext[slug] ?? []).map((item) => ({ ...item }))
  delete store.composerContext[slug]
  return items
}

export function restoreContextItems(slug: string, items: ComposerContextItem[]): void {
  if (!items.length) return
  // Never clobber items staged while the failed send was in flight — put the old ones first.
  store.composerContext[slug] = [...items, ...(store.composerContext[slug] ?? [])]
}

export function popDrawer(): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top) closeDrawersById([top.id])
}

export function topDrawer() {
  return store.drawers[store.drawers.length - 1]
}

// Mark a drawer-stack entry as animating-OUT the instant its slide begins, so the URL sync and
// topThreadSlug stop counting it BEFORE the ~210ms removal lands. Without this, a synchronous view
// change during the close window (e.g. browser-Back into a status list, or the palette's Queue
// action) would still see the present-but-closing layer and push a phantom /thread history entry.
export function markDrawerClosing(id: number): void {
  const d = store.drawers.find((x) => x.id === id)
  if (d) d.closing = true
}

// Exit timers are intentionally conditional. If the same logical drawer is reopened before its
// transition finishes, `openOrRaiseDrawer` clears closing and this old timer becomes a no-op.
export function removeDrawerAfterExit(id: number): void {
  const drawer = store.drawers.find((entry) => entry.id === id)
  if (drawer?.closing) store.drawers = store.drawers.filter((entry) => entry.id !== id)
}

// Unwind drawer-stack entries by id THROUGH their registered animated closers (the slide-out plays)
// instead of an instant `store.drawers = …` splice — the fix for "drawers animate in but not out"
// on the non-component close paths (router back/forward unwind, palette Queue). Any id whose drawer
// isn't mounted (no registered closer — e.g. at boot before components mount) is raw-filtered so the
// stack still settles correctly.
export function closeDrawersById(ids: number[]): void {
  const orphans: number[] = []
  for (const id of ids) if (!closeDrawerAnimated(id)) orphans.push(id)
  if (orphans.length) {
    const drop = new Set(orphans)
    store.drawers = store.drawers.filter((d) => !drop.has(d.id))
  }
}

// The slug of the topmost THREAD layer (for ⌘I, the URL, and other "current thread" consumers).
// Layers mid-close are skipped: they're sliding out and must not keep the URL pinned to /thread.
export function topThreadSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const d = store.drawers[i]
    if (d.kind === "thread" && !d.closing) return d.slug
  }
  return null
}

// THE DOOR. Every board that reaches the UI comes through one of these two functions, so this is where
// "is this even our project's board?" is asked — on the board's OWN evidence (the server stamps it with
// `projectSlug`), not on any client bookkeeping. Bookkeeping is what failed in `0fb8574`; a payload that
// names its own project cannot be talked into belonging here by a stale ref, a missed effect or a
// transport nobody re-pointed. See lib/projectOwnership.ts.
//
// Dropping is silent on purpose: the commonest way to arrive here foreign is a perfectly healthy race —
// a keyframe or an `rpc.board()` seed already on the wire when the operator switched projects — and a
// console warning per switch would be noise about the system working.

// A full board KEYFRAME arrives from SSE (React-free) — on connect and on resync. Just store it;
// every surface derives its own view of the thread list per render (there is no selection state to
// reconcile — the focus machine that needed one is gone).
export function setBoard(board: BoardSnapshot) {
  if (!ownedByThisPage(board.projectSlug)) return
  setGithubRepo(board.githubRepo)
  setLocalPathBase(board.projectDir, board.homeDir)
  store.board = board
}

/**
 * Forget everything that belonged to the project we are leaving.
 *
 * The rail switches projects WITHOUT a document load, which used to do this for free. Every field
 * here is per-project, and carrying any of it across is a visible bug rather than stale data: a
 * drawer would stay open over a board that has never heard of its thread, and the row above the
 * prompt box would name — and link to — the repo you just left.
 *
 * Machine-wide state (the settings/notification mirror, the control-plane status, whether the palette
 * is open) is deliberately NOT touched — none of it changes when the project does.
 */
export function resetProjectState() {
  setGithubRepo(null)
  setLocalPathBase(null)
  resetGithubCards()
  store.board = null
  store.view = "todos"
  store.connection = "connecting"
  store.drawers = []
  store.filePanels = []
  store.composerContext = {}
  store.routeThreadSlug = null
  store.socketBoardFallback = null
  store.socketTranscriptFallbacks = {}
  store.showSettings = false
  store.showNewThread = false
  store.showGithubPicker = false
}

// STARTUP seed only (App fires an rpc.board() to paint before SSE connects). Unlike setBoard this must
// NOT clobber a board the SSE stream has already established + advanced with deltas — a late-resolving
// seed would otherwise revert applied deltas (the seq keeps advancing but the content rolls back). So
// it lands only when nothing is there yet; once the SSE keyframe has set the board, the seed is a no-op.
//
// "Nothing is there yet" is ALSO the state a project switch leaves behind (resetProjectState nulls the
// board), which is what made the ownership check load-bearing here rather than belt-and-braces: the
// previous project's in-flight seed lands into the emptied store and paints its threads under the new
// project's URL. The guard is the only thing standing between that race and the operator.
export function seedBoard(board: BoardSnapshot) {
  if (!ownedByThisPage(board.projectSlug)) return
  if (store.board !== null) return
  setGithubRepo(board.githubRepo)
  setLocalPathBase(board.projectDir, board.homeDir)
  store.board = board
}

// Apply a per-thread delta IN PLACE (upsert/remove threads, patch board-level meta) — valtio's
// fine-grained reactivity means only the changed rows re-render (the audit's S2 fix), vs. setBoard's
// wholesale replace. Returns false when there's no base board to apply onto (caller must resync).
export function applyDelta(delta: BoardDelta): boolean {
  if (store.board === null) return false
  applyBoardDelta(store.board, delta)
  return true
}

export function threadBySlug(board: BoardSnapshot | null, slug: string | null): ThreadView | undefined {
  if (!board || !slug) return undefined
  return board.threads.find((t) => t.id === slug)
}
