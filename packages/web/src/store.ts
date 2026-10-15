import { proxy } from "valtio"
import type { BoardSnapshot, ThreadView, BoardDelta, ProjectEnclosed } from "@ntwine/shared"
import { applyBoardDelta } from "@ntwine/shared"
import type { EditorWindowSummary } from "@ntwine/shared"
import type { MarkdownScope } from "./lib/useMarkdown.ts"
import type { ComposerContextItem } from "./lib/composerContext.ts"
import type { LightboxImage } from "./lib/lightbox.ts"
import { closeDrawerAnimated, focusDrawer } from "./lib/overlays.ts"
import { resolveThreadRoute } from "./lib/threadRouteState.ts"
import { crossProjectHref } from "./lib/base-path.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { setMentionIndex } from "./lib/mentionAutolink.ts"
import { resetGithubCards } from "./lib/githubHovercards.ts"
import { setLocalPathBase } from "./lib/localPathBase.ts"
import { basename } from "./lib/paths.ts"
import { prefersReducedMotion, SHEET_CLOSE_MS } from "./lib/sheet.ts"
import type { RestartAttempt } from "./api/restart.ts"

// Where a scroll-to-card lands a card's outer border below the viewport top (px), when its lane has no
// sticky header to clear (AllQueues.tsx useScrollToCard).
// 40px is the queue's own rhythm: the hairline rule between two cards carries `my-10` (40px) on each
// side, so a landed card sits under the viewport edge with exactly the space it has under its
// predecessor's rule. It was 12px until 2026-08-25, which read as the card being pressed against the
// top of the window (maintainer: "we should leave the full 40 px").
export const QUEUE_CARD_VIEWPORT_TOP = 40

export type ConnectionState = "connecting" | "open" | "closed"
/** A cross-project thread open in flight — see `store.pendingOpen`. */
export interface PendingOpen {
  projectSlug: string
  projectName: string
  slug: string
  title: string
}
export interface SocketPayloadFallback {
  actualBytes: number
  maxBytes: number
}
export type SocketTranscriptFallback =
  | ({ kind: "payload-too-large" } & SocketPayloadFallback)
  | { kind: "read-budget"; scope: "origin" | "global"; retryAfterMs: number }

// The whole app renders off this single valtio proxy. Board is a full snapshot
// pushed over SSE (no diff protocol); everything else is local UI state.
export const store = proxy({
  board: null as BoardSnapshot | null,
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
  // The typed-path "add a project" dialog, one instance for the whole app (ProjectActions.tsx
  // AddProjectHost, mounted by the root layout): the folder picker's fallback when a machine has none,
  // and the launcher's `/?add=<dir>` proposal. Not reset on a project switch — adding a project is a
  // machine action, and the dialog must survive the navigation that the proposal itself triggers.
  // `enclosed` is the other question it asks: the chosen folder sits inside another project root, so
  // open that root, or add the folder as its own project.
  addProject: null as { reason?: string; proposed?: string; enclosed?: ProjectEnclosed } | null,
  showPalette: false,
  // The keyboard-shortcuts sheet (`?`, or the keyboard icon in the status row). Rendered by
  // <KeyboardLayer/>, which every page shell mounts — so it opens on Everything and /full alike.
  showShortcuts: false,
  // The command palette's "Time limit for running threads" dialog (RunningTimeLimitDialog.tsx).
  showRunningTimeLimit: false,
  // The anywhere-modal behind the "New thread" pill (Gmail-compose style).
  showNewThread: false,
  // The PHONE layout's New thread sheet (components/PhonePage.tsx), open or not — and whether it takes
  // the caret as it opens. Its own button opens it focused; a selection an editor sends to the prompt
  // box (lib/editorBridge.ts composeInto) opens it to SHOW the chip, focused only when the human writes
  // next: "Add to ntwine prompt" from an editor's sidebar leaves the caret in the editor.
  phoneNewThread: null as { focus: boolean } | null,
  // The SIDE-DRAWER STACK — arbitrary depth. `thread` layers are full thread views (the Open-thread
  // sheet); `doc` layers are the ntwine-document markdown; `file` layers are the built-in reader for a
  // FILE on disk — a `.md` rendered, anything else as source — opened from any link to one (see
  // lib/localViewer.ts for which files it takes); `subagent` and `shell` layers are read-only
  // operation drill-ins that overlay a thread. A drill-in within one thread's family
  // (its doc, its sub-agents) stacks OVER the previous layer (higher z, slight inset); any lateral open
  // REPLACES the layers it doesn't stack over (one drawer at a time — see openOrRaiseDrawer). Esc /
  // backdrop / browser-Back unwind the TOP layer first. There is no
  // standalone thread page — this stack is the only thread surface. Operation-only fields ride the
  // same entry so App can render its sheet without a board lookup after the operation finishes.
  drawers: [] as {
    id: number
    kind: "thread" | "doc" | "subagent" | "shell" | "file" | "terminal" | "schedule"
    slug: string // schedule: the schedule's id
    routed?: boolean // URL/deep-link-created thread: visible on first paint, never an invisible animated backdrop
    subId?: string // subagent/shell: the launch tool_use id (the RPC handle + dedupe key) / terminal: its id
    label?: string // subagent: the dispatch description (header title) / file: the basename
    path?: string // file: the absolute file path
    projectId?: string // schedule: the project it belongs to, which every one of its RPCs goes through
    scope?: MarkdownScope // file: opened from ANOTHER project's card on the everything page — whose gate
    // reads it and whose repo its prose links into (pushFileReader); absent = the page's own project
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
  // A `/thread/<slug>` URL whose destination is not settled yet. The router cannot decide it alone: on
  // a cold load the board hasn't arrived, so it cannot say whether the slug is this project's thread.
  // The router parks the slug here and App resolves it the first render the board is authoritative
  // (see resolveRoutedThread). Parked slugs keep the address bar on /thread/<slug> meanwhile.
  routeThreadSlug: null as string | null,
  // Another project's thread, clicked open from the queue and not yet drawn: its drawer cannot exist until
  // the page has rebound to that project and its board has landed, which on a loaded machine took seconds
  // (2026-10-01: ~5s on WSL for "Show earlier messages"). PendingThreadSheet draws the drawer's frame for
  // it at once, and resolveRoutedThread hands over to the real drawer, already open, in the same commit.
  // Deliberately NOT reset by resetProjectState: it is set on the way OUT of one project, for the next.
  pendingOpen: null as PendingOpen | null,
  // Transient bottom-center toast (e.g. "Steer failed …" when an eager reply is rejected). `id` bumps per call so
  // repeat toasts re-trigger the fade. Rendered by <Toaster>; null when nothing is showing.
  toast: null as { id: number; text: string; detail?: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: ToastLink; actions?: readonly ToastAction[] } | null,
  // A schedule was just created from the prompt box: the project whose schedules count should flash once
  // (ARCHITECTURE.md § Scheduled threads), so the eye travels from where it was made to where it lives.
  // The list's Schedules header flashes while it names a project in view (TierList.tsx, `[data-sched-flash]` in styles.css). `seq` replays the flash for a second create; it clears itself (flashScheduleCount).
  scheduleFlash: null as { projectId: string; seq: number } | null,
  // The open image LIGHTBOX — one ```lightbox gallery's pictures and which of them is on screen. Here
  // rather than in the gallery's own state because the gallery is a transcript row: the virtualizer
  // unmounts it once it scrolls out of the window, and a worker still writing below a gallery the
  // human is looking through scrolls it there. Rendered by <LightboxHost>; null when closed.
  lightbox: null as { images: LightboxImage[]; index: number } | null,
  // (Selected-context items staged for a prompt box's next message lived here, keyed by thread slug, until
  // 2026-10-01; they are keyed by draft and persisted with it now — lib/stagedContext.ts.)
  //
  // The EDITOR WINDOWS connected over the editor bridge (packages/vscode): which app each is and whether
  // it takes file opens. MACHINE-WIDE — one ntwine, every project — so a project switch leaves it alone.
  // Read at boot (`editorWindows`) and replaced whole by every `editors` event (lib/editorBridge.ts);
  // the settings drawer marks the Local file links app that is connected, and the first connection offers it.
  editorWindows: [] as EditorWindowSummary[],
  // The in-app PICTURE VIEWER (components/ImageViewer), over every page and drawer. `paths` is what
  // ←/→ step through: the pictures rendered in the same card, drawer or page as the one clicked, in
  // reading order (imageGalleryFor in lib/local-file-links.ts), so a worker's before/after shots are
  // one keypress apart. null while closed. Not a drawer-stack layer — it is modal, it covers the
  // stack, and closing it must leave every layer beneath exactly as it was. `project` is set when the
  // pictures belong to another project's card, as a file reader's `scope` is.
  imageViewer: null as { paths: string[]; index: number; project?: string } | null,
})

export function openNewThread(): void {
  store.showNewThread = true
}

let toastSeq = 0
// A toast's "Open thread". `project` is the slug of the project the thread was started IN, captured when
// it was started: a slug names a thread only within its project, and by the time the toast is clicked
// the page may be another project's — on the cross-project page, one dispatch and one click on another
// project's card apart.
export type ToastLink = { label: string; slug: string; project?: string }
// A toast's own verb — the snooze confirmation's "Undo". A callback where `link` is data, because the
// act belongs to whoever raised the toast: its thread's project client, and the card it faded out.
export type ToastAction = { label: string; run: () => void }
// AT MOST TWO verbs, in the order given: a created schedule offers Undo, then Open
// (ARCHITECTURE.md § Scheduled threads). A toast is a strip, and a third button turns it into a menu.
// `action` is sugar for a one-verb toast and leads the list when both are passed.
export const MAX_TOAST_ACTIONS = 2
export function showToast(text: string, opts?: { detail?: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: ToastLink; action?: ToastAction; actions?: readonly ToastAction[] }) {
  const { action, actions, ...rest } = opts ?? {}
  const verbs = [...(action ? [action] : []), ...(actions ?? [])].slice(0, MAX_TOAST_ACTIONS)
  store.toast = { id: ++toastSeq, text, ...rest, ...(verbs.length ? { actions: verbs } : {}) }
}

let scheduleFlashSeq = 0
/** Flash a project's schedules count once. The flag lives long enough for the count the create just
 *  changed to arrive with the projects poll, then goes, so a later re-render never replays it. */
export function flashScheduleCount(projectId: string): void {
  const seq = ++scheduleFlashSeq
  store.scheduleFlash = { projectId, seq }
  setTimeout(() => {
    if (store.scheduleFlash?.seq === seq) store.scheduleFlash = null
  }, 2_500)
}

export function openLightbox(images: LightboxImage[], index: number): void {
  if (images.length === 0) return
  store.lightbox = { images, index: Math.min(Math.max(index, 0), images.length - 1) }
}

export function closeLightbox(): void {
  store.lightbox = null
}

// Step to a neighbouring picture. It stops at either end rather than wrapping: the overlay counts
// "3 / 3", and a wrap would make the next press read as a jump back to the start.
export function stepLightbox(delta: number): void {
  const box = store.lightbox
  if (!box) return
  box.index = Math.min(Math.max(box.index + delta, 0), box.images.length - 1)
}

// ── drawer stack ─────────────────────────────────────────────────────────────────────────────────
let drawerSeq = 0
let drawerOpenSeq = 0
type Drawer = (typeof store.drawers)[number]

// Kind is part of the identity: a chat thread and its document can deliberately stack, while a
// second request for that same chat (or document) must reuse the existing layer.
function sameDrawer(a: Drawer, b: Pick<Drawer, "kind" | "slug" | "path" | "subId">): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "file") return a.path === b.path
  if (a.kind === "subagent" || a.kind === "shell" || a.kind === "terminal") return a.subId === b.subId
  return a.slug === b.slug
}

// The only layers a new drawer legitimately stacks OVER are its own thread's family: a sub-agent
// transcript, a shell's output or a terminal over its parent thread/doc, and a thread⇄doc pair sharing a
// slug. Everything else — sibling threads, sibling sub-agents — is a lateral move, not a drill-in.
function stacksOver(below: Drawer, next: Pick<Drawer, "kind" | "slug">): boolean {
  // A file reader is always a DRILL-IN: it is opened by clicking a link inside whatever is already
  // showing (a chat message, another document), so replacing that layer would close the very
  // prose the link was read from. It stacks over anything, its own kind included — following a doc's
  // link to a sibling doc and pressing Esc to come back is the whole point of a reader.
  if (next.kind === "file") return true
  if (next.kind === "subagent" || next.kind === "shell" || next.kind === "terminal") return (below.kind === "thread" || below.kind === "doc") && below.slug === next.slug
  if (next.kind === "doc") return below.kind === "thread" && below.slug === next.slug
  if (next.kind === "thread") return below.kind === "doc" && below.slug === next.slug
  return false
}

// ONE-DRAWER POLICY (maintainer 2026-07-21): opening a layer REPLACES every live layer it doesn't
// logically stack over, so lateral moves (sidebar sibling thread/sub-agent clicks) swap the
// open drawer instead of piling up; only drilling into the open thread's own child/doc stacks.
//
// Exported for the router, which applies the same displacement when Back or Forward lands on a thread
// the stack no longer holds (lib/router applyPath). That thread was REPLACED by this policy when the
// lateral move happened, so the layer that replaced it is still on top; left there, it kept the store
// saying "the other thread" while the address bar said this one, and the store→URL sync pushed the
// other thread's URL straight back — every Back press grew the history and flipped between the two.
export function closeLayersDisplacedBy(next: Pick<Drawer, "kind" | "slug" | "path" | "subId">): void {
  const displaced = store.drawers.filter((d) => !d.closing && !sameDrawer(d, next) && !stacksOver(d, next)).map((d) => d.id)
  if (displaced.length) closeDrawersById(displaced)
}

function openOrRaiseDrawer(next: Omit<Drawer, "id" | "closing" | "openedAt">, opts?: { drillIn?: boolean }): void {
  // `drillIn` is a caller that KNOWS it is opening from inside the top layer — a schedule's history row
  // opening its run, a run's transcript opening its schedule — so nothing is displaced and Esc goes back.
  if (!opts?.drillIn) closeLayersDisplacedBy(next)

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

// Slugs whose panel is up in a live drawer — the chat sheet, or one of the thread's terminals (a terminal
// layer's slug is its thread's). The queue makes these threads' cards inert (AllQueues.tsx): a card is a
// second copy of the same questions and reply box — and, for a terminal waiting at a prompt, of the same
// live screen — so a second live copy under the sheet would take keys meant for the drawer (maintainer
// 2026-09-23). A closing layer does not count, so the card wakes as the drawer slides off it. A doc
// drawer shows different content and leaves the card alone.
export function slugsInThreadDrawers(drawers: readonly Pick<Drawer, "kind" | "slug" | "closing">[]): Set<string> {
  return new Set(drawers.filter((d) => !d.closing && (d.kind === "thread" || d.kind === "terminal")).map((d) => d.slug))
}

// The THREAD the drawer stack is showing: the topmost live layer that belongs to one — its chat, its
// doc, its terminal, or a sub-agent / shell drill-in (whose slug is the parent thread's). A reader
// layer names a FILE, so the walk passes under it to the thread it was opened from. A closing layer
// does not count: its row lets go the moment the slide-out starts, as the URL does. The project list
// lights this thread's row (Sidebar.tsx rowWashClass).
export function drawerThreadSlug(drawers: readonly Pick<Drawer, "kind" | "slug" | "closing">[]): string | null {
  for (let i = drawers.length - 1; i >= 0; i--) {
    const d = drawers[i]
    if (d.closing || d.kind === "file" || d.kind === "schedule") continue
    return d.slug
  }
  return null
}

export function pushDrawer(kind: "thread" | "doc", slug: string, opts?: { routed?: boolean; drillIn?: boolean }): void {
  // A TERMINAL THREAD's drawer is its terminal (TerminalSheet), whichever way it was asked for — a row, a card's
  // title, a cold `/thread/<slug>` link. Its own slug is both the layer's thread and its terminal.
  const t = kind === "thread" ? store.board?.threads.find((x) => x.id === slug) : undefined
  if (t?.kind === "terminal") {
    openOrRaiseDrawer({ kind: "terminal", slug, subId: slug, label: t.title, routed: opts?.routed }, { drillIn: opts?.drillIn })
    return
  }
  openOrRaiseDrawer({ kind, slug, routed: opts?.routed }, { drillIn: opts?.drillIn })
}

// Open a SCHEDULE's drawer (ARCHITECTURE.md § Scheduled threads, ScheduleDrawer.tsx). `projectId` is the
// schedule's own project, which may not be the page's — the palette lists every project's — so the drawer
// reads and writes through that project's client and never asks the page.
export function pushScheduleDrawer(id: string, projectId: string | undefined, opts?: { drillIn?: boolean }): void {
  openOrRaiseDrawer({ kind: "schedule", slug: id, ...(projectId ? { projectId } : {}) }, { drillIn: opts?.drillIn })
}

// Open a TERMINAL THREAD's drawer (lib/threadTerminals.ts). `slug` is the thread the layer belongs to: the
// terminal's own slug when it is opened as itself (its row, its card), or the thread it was started from when
// opened from that thread's strip — then it stacks over that thread's drawer, as a sub-agent or a shell does.
// `id` is the terminal's /term handle and dedupe key.
export function pushTerminalDrawer(slug: string, id: string, opts?: { label?: string }): void {
  openOrRaiseDrawer({ kind: "terminal", slug, subId: id, label: opts?.label })
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

// Open a thread from a listing/notification click-through, always as a drawer. Until 2026-09-28 a
// QUEUED thread short-circuited to its card on a project's board, where the card was the whole panel;
// on Everything a card is a summary and the thread itself is one level down, so there is no such card
// to land on. Routing is by runtime: a thread with NO session ever spawned (runtime "none" — no
// transcript, the chat drawer would be an empty placeholder) opens its ntwine DOCUMENT drawer instead —
// there the doc IS the substance. Anything with a session (live or exited — exited transcripts are
// worth seeing) opens the chat drawer.
export function openThread(slug: string): void {
  const t = store.board?.threads.find((x) => x.id === slug)
  pushDrawer(t && t.runtime === "none" && t.kind !== "terminal" ? "doc" : "thread", slug)
}

// A COLD LINK TO A QUEUED THREAD LANDS ON ITS CARD (plans/upstream-superset.md §3, upstream's store.ts
// resolveRoutedThread). A project's board draws the queue's cards and registers how to land on one
// (AllQueues.tsx useRoutedLanding); nothing else does — All projects keeps its drawers, a phone and an
// editor's sidebar draw no cards — so there, and before the board has mounted, the route opens a drawer.
// "pending": the board cannot say yet whether the thread has a card (its queue is still loading), so the
// slug stays parked and the board resolves it again once it can.
export type RoutedLanding = (slug: string) => "landed" | "absent" | "pending"
let routedLanding: RoutedLanding | null = null
export function registerRoutedLanding(land: RoutedLanding): () => void {
  routedLanding = land
  return () => {
    if (routedLanding === land) routedLanding = null
  }
}

// Whether the page is on an address it arrived at from OUTSIDE this tab's own navigation — a bookmark, a
// pasted URL, another page's link, a reload of one of those. react-router numbers the entries it writes
// (`idx` in history.state, lib/router.ts appPushedCurrentEntry): a document loads on 0, and every push
// counts up from there. A drawer this tab opened was a push, so its entry is above 0 — a reload or a Back
// onto it reopens the drawer it was, and so does a thread another project's link or a notification opened
// in place. Only an arrival lands on the card. (Inline rather than imported: lib/router.ts imports this.)
function arrivedFromOutside(): boolean {
  if (typeof history === "undefined") return false
  const idx = (history.state as { idx?: unknown } | null)?.idx
  return typeof idx !== "number" || idx === 0
}

// Settle a parked `/thread/<slug>` URL, now that the board can say whose thread it is. A deep link
// deliberately asks for the CHAT surface even for a session-less thread (unlike openThread's
// doc-routing), so this pushes the thread layer rather than delegating — unless it is a cold link to a
// QUEUED thread on a project's board, which lands on the thread's card instead (registerRoutedLanding),
// as upstream's board did: the queue is where a waiting thread is read. Every other way of asking for a
// thread opens its drawer (openThread). `routed` so a cold page paints the sheet already open instead of
// animating a phantom backdrop in.
export function resolveRoutedThread(): void {
  const slug = store.routeThreadSlug
  if (!slug || !store.board) return
  const route = resolveThreadRoute(store.board, slug)
  const opening = store.pendingOpen?.slug === slug && store.pendingOpen.projectSlug === store.board.projectSlug
  if (route.kind === "found" && routedLanding && !opening && arrivedFromOutside() && !openedInPlace() && store.drawers.every((d) => d.closing)) {
    const landed = routedLanding(slug)
    if (landed === "pending") return
    if (landed === "landed") {
      // Off the thread's address, back to the board's: the card is the page, not a layer over it.
      store.routeThreadSlug = null
      return
    }
  }
  store.routeThreadSlug = null
  // A slug THIS project does not have. Since one server started serving every project that is usually
  // a thread another project has — and `/thread/<slug>` is the exact shape every pre-singleton
  // bookmark and every agent-written cross-reference uses, so it is not a rare typo. Pushing the
  // drawer anyway opened an empty sheet over the page that said nothing and offered nothing, so ask
  // `threadLocate` which project owns the slug and open its drawer there.
  // The frame PendingThreadSheet has been showing for this thread gives way to the real drawer in this
  // same store write, so the real one must paint already open (`routed`) rather than slide in a second time.
  if (opening || route.kind === "missing") store.pendingOpen = null
  if (route.kind === "missing") {
    void relocateMissingThread(slug)
    return
  }
  pushDrawer("thread", slug, { routed: opening || !openedInPlace() })
}

// The recovery the retired /full page's <MissingThread> made: one owner (the overwhelmingly common
// case) is opened at once; several have nothing to choose between them by, so the first is; none is said.
// `rpc` is imported lazily because the API layer imports this store.
async function relocateMissingThread(slug: string): Promise<void> {
  if (typeof location === "undefined") return
  const { rpc } = await import("./api/rpc.ts")
  const owners = await rpc.threadLocate({ slug }).catch(() => [])
  const owner = owners[0]
  if (!owner) {
    showToast(`No thread named ${slug}`, { duration: 7000 })
    return
  }
  location.replace(`${crossProjectHref(encodeURIComponent(owner.projectSlug), "/")}/thread/${encodeURIComponent(slug)}`)
}

// Navigation state for a thread opened IN PLACE by a click on the page — the cross-project page opening
// another project's thread, which has to change the URL (the focus moves) where a store-first open of
// the focus's own thread does not. Its drawer slides in like any clicked one; `routed` is for a URL that ARRIVED (a cold deep link,
// Back), where the sheet must already be open on the first paint.
export const IN_PLACE_OPEN_STATE = { inPlace: true } as const

function openedInPlace(): boolean {
  if (typeof history === "undefined") return false
  const usr = (history.state as { usr?: unknown } | null)?.usr
  return typeof usr === "object" && usr !== null && (usr as { inPlace?: unknown }).inPlace === true
}

// Open a file that lives on disk in ntwine's OWN reader — a `.md` rendered, anything else as source —
// rather than handing the path to the desktop opener. Every link to one routes here
// (lib/local-file-links.ts): agent prose citing a repo doc, an inline-code path that resolved to a
// file, an attached log. `path` is the absolute path the server will re-gate; the basename is the
// header title. Queue drawers are deduped on path. `scope` is the card's project when the link was
// clicked on another project's card (AllQueuesCard ProjectLinkScope): the drawer then reads through that
// project's gate and renders against its repo, as the card itself does.
export function pushFileReader(path: string, scope?: MarkdownScope | null): void {
  openOrRaiseDrawer({ kind: "file", slug: path, path, label: basename(path), ...(scope ? { scope } : {}) })
}

// ── the picture viewer ───────────────────────────────────────────────────────────────────────────

// Show `path` in the picture viewer. `gallery` is the set ←/→ step through; a path that is not in it
// (a Markdown link TO a picture, which is text rather than a rendered one) opens on its own. `project`
// as for pushFileReader: the pictures are another project's card's.
export function openImageViewer(path: string, gallery: readonly string[] = [], project?: string): void {
  const paths = gallery.includes(path) ? [...gallery] : [path]
  store.imageViewer = { paths, index: paths.indexOf(path), ...(project ? { project } : {}) }
}

export function closeImageViewer(): void {
  store.imageViewer = null
}

// Clamped, not wrapped: the ends are where the rendered pictures end, and a viewer that silently
// jumps from the last shot back to the first reads as having shown a new one.
export function stepImageViewer(step: 1 | -1): void {
  const viewer = store.imageViewer
  if (!viewer) return
  viewer.index = Math.min(viewer.paths.length - 1, Math.max(0, viewer.index + step))
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

// The thread a layer IS, when the address bar can name it: a chat layer, or a TERMINAL THREAD opened as
// itself (pushDrawer: its row, its card, a `/thread/term-…` link), whose layer's slug and terminal are both
// its own. A terminal opened from a thread's strip (pushTerminalDrawer, slug = that thread) is a drill-in,
// like a sub-agent or a shell: it stacks over the thread the address already names, and names nothing.
//
// Leaving terminal threads out is what closed one the instant it opened by its address (maintainer
// 2026-10-15, a `nub run dev` terminal clicked from All projects): the route opened its drawer, the
// store→URL writer found no layer to name and wrote the page's bare address, and applying that closed it.
export function routedLayerSlug(d: Pick<Drawer, "kind" | "slug" | "subId" | "closing">): string | null {
  if (d.closing) return null
  if (d.kind === "thread") return d.slug
  if (d.kind === "terminal" && d.subId === d.slug) return d.slug
  return null
}

// The slug the ADDRESS BAR names: the topmost layer that is a thread (routedLayerSlug).
export function topRoutedSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const slug = routedLayerSlug(store.drawers[i])
    if (slug !== null) return slug
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
  setMentionIndex(board.projectSlug, board.threads)
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
  setMentionIndex(null, null)
  resetGithubCards()
  store.board = null
  store.connection = "connecting"
  store.drawers = []
  store.imageViewer = null
  store.routeThreadSlug = null
  store.socketBoardFallback = null
  store.socketTranscriptFallbacks = {}
  store.showSettings = false
  store.showNewThread = false
  store.lightbox = null
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
  setMentionIndex(board.projectSlug, board.threads)
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
