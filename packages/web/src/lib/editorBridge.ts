import type { QueryClient } from "@tanstack/react-query"
import { subscribe } from "valtio"
import type { EditorComposeInput, EditorComposeItem, EditorWindowSummary, ProjectCard, Settings } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { isRemoteSession } from "../api/signOut.ts"
import { supervisorStatusQueryOptions } from "../api/supervisorStatus.ts"
import { getNtwineSupervisorStatus } from "../api/restart.ts"
import { publishMachineSettings } from "../hooks/useSettingsAutosave.tsx"
import { closeImageViewer, openThread, pushDrawer, showToast, store, topThreadSlug } from "../store.ts"
import { crossProjectHref, innerPath, projectSlug } from "./base-path.ts"
import { rememberCrossProjectFocus } from "./crossProject.ts"
import { draftKey, draftStore } from "./drafts.ts"
import { embedded } from "./embed.ts"
import { composeEdit, composeProjectsOf, composeTarget, type ComposeMove, type ComposeProject } from "./editorCompose.ts"
import type { ContextBox } from "./editorContext.ts"
import { isTerminalPath } from "./composerContext.ts"
import { codeFilesDestination, connectedOpeners, EDITOR_OPENER_LABEL, editorOffer, parseOffered, type EditorOpener } from "./editorWindows.ts"
import { splitComposerValue } from "./imagePaths.ts"
import { phoneLayout } from "./mobile.ts"
import { homeHref, projectViewHref, viewAt } from "./pageView.ts"
import { basename } from "./paths.ts"
import { projectsQueuesQuery, readProjectsQueues } from "./projectsQueuesRead.ts"
import { spaNavigate } from "./router.ts"
import { addContextItem, stagedItems } from "./stagedContext.ts"

// THE PAGE'S HALF OF THE EDITOR BRIDGE (packages/vscode; ARCHITECTURE.md § VS Code extension). Three jobs, all
// machine-wide, so this module is set up once per page (main.tsx) rather than per project:
//
//  1. WHICH EDITOR WINDOWS ARE CONNECTED — store.editorWindows, read at boot and replaced by every
//     `editors` event. The settings drawer marks the Local file links editor that has a window behind it.
//  2. THE FIRST-CONNECTION OFFER — the first time this browser sees an accepting VS Code or Cursor window
//     while its code files go elsewhere, a toast offers to send them there. Once per editor per browser.
//  3. PROMPT-BOX INSERTS — "Add to ntwine prompt" in an editor leaves an item on the server and pings every
//     page (`compose-pending`). The page the human is LOOKING AT claims it (`composeTake`, first caller
//     wins) and puts it in the box in front of them — on the ping when it has focus, else on the focus
//     that follows (the human switching from their editor to this tab), and once at boot. There is no
//     leader election and no tab id: focus is the election, and the server's claim is the lock.
//
// IN AN EDITOR'S SIDEBAR (lib/embed.ts) jobs 2 and 3 stand down. The offer asks where code files should
// go, and inside the editor's own sidebar they go to that editor already (lib/local-file-links.ts). And
// the page never claims a held item: the extension that frames it posts its selections straight in
// (`ntwine:compose`, lib/embedHost.ts → composeInto below), so a held item is one from a window WITHOUT a
// sidebar — meant for a browser tab — and a sidebar that claimed it on the human's next click into it
// would take it from that tab.

let queryClient: QueryClient | null = null
const OFFERED_KEY = "ntwine.editorOffered"

export function initEditorBridge(client: QueryClient): void {
  queryClient = client
  void refreshEditorWindows()
  // The same wake signals the live feed uses (api/socket.ts). A refresh as well as a claim: an `editors`
  // event published while the feed was re-binding to another project is one this page never heard.
  const wake = () => {
    if (!embedded()) void drainCompose()
    void refreshEditorWindows()
  }
  window.addEventListener("focus", wake)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake()
  })
  if (document.hasFocus() && !embedded()) void drainCompose()
}

// ── 1. the connected windows ───────────────────────────────────────────────────────────────────────

async function refreshEditorWindows(): Promise<void> {
  let windows: EditorWindowSummary[] = []
  try {
    windows = (await rpc.editorWindows()).windows
  } catch {
    // A server from before the editor bridge has no such procedure: no windows, and nothing to say.
  }
  setEditorWindows(windows)
}

/** The windows, whole — from the boot read, a refresh, or an `editors` event (api/board-stream.ts). */
export function setEditorWindows(windows: EditorWindowSummary[]): void {
  store.editorWindows = windows
  void considerEditorOffer()
}

/**
 * `editor-front` (api/board-stream.ts): what some editor window shows changed, so every browser line over a
 * prompt box (components/EditorLine.tsx) asks its project again. Only the mounted, enabled ones refetch;
 * the rest are marked stale for when they mount.
 */
export function editorFrontChanged(): void {
  void queryClient?.invalidateQueries({ queryKey: ["editorFront"] })
}

// ── 2. the first-connection offer ──────────────────────────────────────────────────────────────────

let considering = false

async function considerEditorOffer(): Promise<void> {
  // Only on a page someone is looking at — a toast nobody saw would still spend the once-per-browser
  // offer — and never over the settings drawer, whose own draft would write the old choice back.
  if (typeof document === "undefined" || considering || document.visibilityState !== "visible" || store.showSettings || store.toast?.sticky) return
  if (embedded()) return
  const phone = phoneLayout()
  // Could anything be offered at all, whatever the settings say? Asked first so an `editors` event that
  // changes nothing worth offering costs no settings or supervisor read.
  if (!editorOffer({ windows: store.editorWindows, opener: undefined, offered: readOffered(), phone, remote: false })) return
  considering = true
  try {
    const [settings, remote] = await Promise.all([readSettings(), readRemoteSession()])
    const kind = editorOffer({ windows: store.editorWindows, opener: settings.localFileOpener, offered: readOffered(), phone, remote })
    if (!kind) return
    rememberOffered(kind)
    const label = EDITOR_OPENER_LABEL[kind]
    showToast(`${label} is connected. Open code files there?`, {
      action: { label: `Use ${label}`, run: () => void sendCodeFilesTo(kind) },
      duration: 12_000,
    })
  } catch {
    // Settings unreadable right now: offer on a later event or focus rather than guess.
  } finally {
    considering = false
  }
}

function readOffered(): Set<string> {
  try {
    return parseOffered(localStorage.getItem(OFFERED_KEY))
  } catch {
    return new Set()
  }
}

function rememberOffered(kind: EditorOpener): void {
  try {
    localStorage.setItem(OFFERED_KEY, JSON.stringify([...readOffered(), kind]))
  } catch {
    // Storage disabled: the offer may come again next load, which is the lesser harm.
  }
}

// ── 2b. where a code file goes ─────────────────────────────────────────────────────────────────────

/**
 * Whether a code-file click goes to the Local file links editor (editorWindows.ts codeFilesDestination),
 * for lib/local-file-links.ts. Only asked while an editor window that takes opens is connected, so a
 * page with none never reads anything. The setting is read FRESH (fetchQuery), because the server opens
 * with its own current setting: nothing refreshes this page's cached copy when another tab or browser
 * changes it, so a click trusting the cache after it moved to Copy path copied the path instead of
 * opening the reader. Whether this is a remote session comes from the shared
 * supervisor poll's cache. A failed read is the reader, which always works.
 */
export function codeFilesMayGoToEditor(): boolean {
  return connectedOpeners(store.editorWindows).size > 0
}

export async function codeFilesGoToEditor(): Promise<boolean> {
  if (!codeFilesMayGoToEditor()) return false
  try {
    const [settings, remote] = await Promise.all([
      queryClient ? queryClient.fetchQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() }) : rpc.settingsGet(),
      queryClient ? queryClient.ensureQueryData(supervisorStatusQueryOptions).then(isRemoteSession) : getNtwineSupervisorStatus().then(isRemoteSession),
    ])
    const phone = typeof window !== "undefined" && phoneLayout()
    return codeFilesDestination({ windows: store.editorWindows, opener: settings.localFileOpener, phone, remote }) === "editor"
  } catch {
    return false
  }
}

// The supervisor's word on whether this page came in over remote access (api/signOut.ts), through the
// one shared poll's cache when it is fresh. Strict like isRemoteSession: an unreachable supervisor reads
// "not remote", and the phone check still stands beside it.
async function readRemoteSession(): Promise<boolean> {
  const status = queryClient ? await queryClient.fetchQuery(supervisorStatusQueryOptions) : await getNtwineSupervisorStatus()
  return isRemoteSession(status)
}

async function readSettings(): Promise<Settings> {
  if (!queryClient) return rpc.settingsGet()
  return queryClient.fetchQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
}

// "Code files go to the editor" is the machine's Local file links setting naming it (while it is
// connected, codeFilesDestination). The settings write carries the WHOLE object (useSettingsAutosave), so
// it is built on a fresh read rather than whatever this page cached, and published to every project's
// cached copy the way the drawer's own save is — which is also how a Settings drawer open under the
// toast learns of it rather than writing its old value back (useSettingsAutosave adoptPublishedSettings).
// Exported for its test.
export async function sendCodeFilesTo(kind: EditorOpener): Promise<void> {
  const label = EDITOR_OPENER_LABEL[kind]
  try {
    const current = await rpc.settingsGet()
    const saved = await rpc.settingsSet({ ...current, localFileOpener: kind })
    if (queryClient) {
      queryClient.setQueryData(["settingsGet"], saved)
      publishMachineSettings(queryClient, saved)
    }
    showToast(`Code files open in ${label}`)
  } catch (error) {
    showToast(`Couldn't set local file links to ${label}`, { detail: error instanceof Error ? error.message.slice(0, 100) : undefined })
  }
}

// ── 3. prompt-box inserts ──────────────────────────────────────────────────────────────────────────

/** `compose-pending`: claim now only if this page is the one in front; else the next focus claims it. */
export function composePending(): void {
  if (typeof document !== "undefined" && document.hasFocus() && !embedded()) void drainCompose()
}

let draining: Promise<void> | null = null
let drainAgain = false

/** Claim and insert every waiting item, one at a time, in the order the editor sent them. */
export function drainCompose(): Promise<void> {
  if (draining) {
    drainAgain = true
    return draining
  }
  draining = (async () => {
    try {
      do {
        drainAgain = false
        // A cold page: the drawer the address names and the board its drafts are keyed by arrive with
        // the first board. An item inserted before then would miss a drawer that is about to open.
        await boardOrTimeout()
        for (;;) {
          let item: EditorComposeItem | null
          try {
            item = (await rpc.composeTake({})).item
          } catch {
            return // a server without the bridge, or one restarting: the next focus asks again
          }
          if (!item) break
          await insertComposeItem(item)
        }
      } while (drainAgain)
    } finally {
      draining = null
    }
  })()
  return draining
}

const THREAD_BOX = 'textarea[data-surface="chatComposer"]'
const NEW_THREAD_BOX = 'textarea[data-surface="newComposer"]'
// The New thread dialog's box: it shares the page box's draft, so only the dialog tells the two apart.
const DIALOG_NEW_THREAD_BOX = '[role="dialog"]:not([data-drawer-layer]) textarea[data-surface="newComposer"]'

async function insertComposeItem(item: EditorComposeItem): Promise<void> {
  const outcome = await composeInto(item, { target: "front", focus: true })
  if (!outcome.ok) showToast(`Couldn't add ${basename(item.path)} to the prompt box`, { detail: outcome.reason, duration: 6000 })
}

/**
 * Which box an editor's item goes into (embed-protocol.ts `ntwine:compose`): "front" is the box in front
 * of the human — the open thread's reply box, else the new-thread box; "new" the new-thread box, whatever
 * is open; `{ thread, project }` that thread's reply box, its drawer opened first. `focus` puts the caret
 * there; false leaves focus where it is (in the editor, for "Add to ntwine prompt" from its sidebar).
 *
 * `{ box }` is the page's own: the box whose context bar asked for this item (lib/editorContext.ts
 * `requestEditorContext`), which the host's answer — aimed at "front" — is routed back to. `note` is
 * prose to put after the chip (embed-protocol.ts `EmbedComposeMessage.note`).
 */
export interface ComposeRequest {
  target: "front" | "new" | { thread: string; project: string } | { box: ContextBox }
  focus: boolean
  note?: string
}

export type ComposeOutcome = { ok: true } | { ok: false; reason: string }

/**
 * PUT ONE EDITOR ITEM INTO A PROMPT BOX — the one insertion both ways in share: a held item this page
 * claimed (`drainCompose`, always "front" and focused, because the human just came to this tab to write)
 * and one the sidebar's extension posted (lib/embedHost.ts). The chip is the ⌘I token composeEdit
 * builds, spliced at the END of the box's prose — a chip boundary, never inside a word being typed — and
 * staged under the same draft key, so the box renders and sends it exactly as a selection made in
 * ntwine's own viewer.
 *
 * On the phone layout — which is also every sidebar's — the new-thread box lives in a sheet that is
 * closed until opened, so an item for it opens the sheet: an insert nobody can see reads as one that
 * never arrived.
 */
export async function composeInto(item: EditorComposeInput, request: ComposeRequest): Promise<ComposeOutcome> {
  // A cold page: the drawer the address names and the board its drafts are keyed by arrive with the
  // first board. An item inserted before then would miss a drawer that is about to open.
  await boardOrTimeout()
  // A terminal has no file to fall back to: with no text, there is nothing to reference.
  if (isTerminalPath(item.path) && !item.text?.trim()) return { ok: false, reason: "Nothing is selected in the terminal." }
  if (typeof request.target === "object" && "box" in request.target) return composeIntoBox(item, request.target.box, request)
  const named = typeof request.target === "object" ? request.target : undefined
  if (named) {
    const shown = () => threadInFront()?.slug === named.thread && projectSlug() === named.project
    if (!shown()) {
      if (!(await threadIsThere(named.thread, named.project))) return { ok: false, reason: "That thread isn't in ntwine." }
      store.showSettings = false
      store.phoneNewThread = null
      // The thread's drawer is about to be what the human sees, so nothing may sit over it.
      store.showNewThread = false
      closeImageViewer()
      openNamedThread(named.thread, named.project, "chat")
      await until(shown, 5_000)
      // The thread is there — the server just said so — so a drawer that did not come up is the page's
      // failure to open it, and must not read as the thread being gone.
      if (!shown()) return { ok: false, reason: "Couldn't open that thread." }
    }
  }
  // THE NEW THREAD DIALOG IS IN FRONT when it is up, whatever drawer it was opened over: "front" is the
  // box the human is looking at, and the drawer's reply box is behind the dialog's scrim. It was read off
  // the drawer alone until the sweep (2026-10-01), so an editor's ⌘I with the dialog up went into the
  // reply box behind it and the dialog's box stayed empty. Its box is the page board's new-thread draft
  // (NewThreadModal DispatchForm, given no other folder); the drawer stays where it is, under the dialog.
  if (request.target === "front" && store.showNewThread && store.board) {
    const box: ContextBox = { key: draftKey.dispatch(store.board.projectDir), projectDir: store.board.projectDir, surface: "newComposer" }
    return composeIntoBox(item, box, request, DIALOG_NEW_THREAD_BOX)
  }
  const thread = request.target === "new" ? undefined : threadInFront()
  const board = store.board ? { projectDir: store.board.projectDir, projectSlug: store.board.projectSlug } : undefined
  const projects = thread && board ? [] : await readComposeProjects()
  const target = composeTarget({
    // The project list could not be read: the item goes to the box in front of the human rather than
    // nowhere — the server has already handed it over, and a refusal would lose it.
    item: projects ? item : {},
    thread,
    board,
    pageSlug: projectSlug(),
    view: viewAt(location.pathname).kind,
    projects: projects ?? [],
  })
  if (target.kind === "refused") return { ok: false, reason: target.reason }
  // A HELD THREAD's box (HeldThreadBox.tsx) is kept on the server, with no draft and no chips: a chip
  // written to its follow-up draft was answered "added", never appeared, and turned up in the reply box
  // once the thread had started (sweep 2026-10-01). So it is refused, saying what to do instead.
  // (Putting the chip into the note itself needs staged context that survives the thread's start.)
  if (target.kind === "thread" && store.board?.threads.some((candidate) => candidate.id === target.slug && candidate.held !== undefined)) {
    return { ok: false, reason: "Start the thread to add code to it." }
  }
  const edit = composeEdit({ value: draftStore.get(target.key), staged: stagedItems(target.key), item, projectDir: target.projectDir, note: request.note })
  // The draft first, then the chip: a mounted box sweeps any staged item whose token its draft lacks.
  draftStore.set(target.key, edit.value)
  if (edit.stage) addContextItem(target.key, edit.stage)
  if (target.kind === "new") {
    // "new" over an open drawer: back to the page under it, where the new-thread box is.
    if (target.move.kind === "stay" && topThreadSlug()) spaNavigate(homeHref())
    await movePage(target.move)
    if (phoneLayout()) store.phoneNewThread = { focus: request.focus || store.phoneNewThread?.focus === true }
  }
  if (request.focus) {
    // The Electron window does not come forward on `focus()` (api/board-stream.ts notify does the same).
    ;(window as { ntwineDesktop?: { focusWindow?(): void } }).ntwineDesktop?.focusWindow?.()
  }
  await placeCaret(target.kind === "thread" ? THREAD_BOX : NEW_THREAD_BOX, splitComposerValue(edit.value).prose, edit.caret, request.focus)
  return { ok: true }
}

/**
 * The box a context bar asked for, as it is: no target to resolve and nothing to navigate, since the
 * human just clicked in it. Its draft and chips are keyed as the box keys them, so if it has gone in the
 * moment since (a drawer closed), the chip waits in its draft like any other.
 */
async function composeIntoBox(item: EditorComposeInput, box: ContextBox, request: ComposeRequest, selector = `textarea[data-surface="${box.surface}"]`): Promise<ComposeOutcome> {
  const edit = composeEdit({ value: draftStore.get(box.key), staged: stagedItems(box.key), item, projectDir: box.projectDir, note: request.note })
  draftStore.set(box.key, edit.value)
  if (edit.stage) addContextItem(box.key, edit.stage)
  await placeCaret(selector, splitComposerValue(edit.value).prose, edit.caret, request.focus)
  return { ok: true }
}

/**
 * Open a thread an editor named, the way the page opens its own: STORE-FIRST for a thread of the board
 * this page holds — the drawer pushed, and the address written after it, as a row or a thread link does
 * (lib/thread-links.ts) — and by its address for another project's, whose board the page has to switch
 * to first. `surface` is what opens: "open" is a row's click (a session-less thread opens its document,
 * store.ts openThread); "chat" is the thread's own drawer, which is where its reply box is.
 *
 * By address alone, a thread of the page's own project often opened nothing: closed a moment before, its
 * drawer address was the one the router had just written, and the router took the host's navigation for
 * its own earlier write coming back (lib/router.ts `stale`) — 19 of 38 navigations at a load average of
 * 40-80, 0 of 16 when they alternated between two threads (sweep 2026-10-01).
 */
export function openNamedThread(slug: string, project: string, surface: "open" | "chat"): void {
  if (!holdsBoardOf(project)) {
    spaNavigate(`${crossProjectHref(project)}/thread/${encodeURIComponent(slug)}`)
    return
  }
  if (surface === "open") openThread(slug)
  else pushDrawer("thread", slug)
}

/** Whether this page shows `project`'s board with a drawer stack of its own. */
export function holdsBoardOf(project: string): boolean {
  return projectSlug() === project && store.board?.projectSlug === project
}

/**
 * Does `project` have a thread `slug`? Asked before opening one an editor named: a drawer address for a
 * thread its project lacks is not an empty drawer but a DOCUMENT load (store.ts resolveRoutedThread
 * relocates it to the project that has it), which in a sidebar would reload the frame and drop the answer
 * the extension is waiting for. A server that cannot say is taken at its word.
 */
export async function threadIsThere(slug: string, project: string): Promise<boolean> {
  if (store.board?.projectSlug === project && store.board.threads.some((thread) => thread.id === slug)) return true
  try {
    return (await rpc.threadLocate({ slug })).some((location) => location.projectSlug === project)
  } catch {
    return true
  }
}

/**
 * The thread the human is reading: the topmost thread drawer. Exported for its test.
 */
export function threadInFront(): { slug: string; sessionId?: string } | undefined {
  const slug = topThreadSlug()
  if (!slug) return undefined
  const thread = store.board?.threads.find((candidate) => candidate.id === slug)
  return thread ? { slug, sessionId: thread.sessionId } : undefined
}

async function readComposeProjects(): Promise<ComposeProject[] | null> {
  try {
    // The page's own reads, through its cache when they are fresh (AllQueues.tsx and routes.tsx share these keys).
    const [cards, queues] = await Promise.all([
      queryClient
        ? queryClient.fetchQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), staleTime: 5_000 })
        : rpc.projectsList(),
      queryClient
        ? queryClient.fetchQuery({ ...projectsQueuesQuery, staleTime: 5_000 })
        : readProjectsQueues(),
    ])
    return composeProjectsOf(cards as ProjectCard[], queues)
  } catch {
    return null
  }
}

/**
 * Show the box the item went into, with the page's own verbs: focused elsewhere, focus its project (the
 * dock's navigation, so Back undoes it); showing All projects, make it the pick (the picker's — a
 * drawer open on the page binds it to the drawer's project, so aiming the box goes home). Resolves once
 * the page shows that project, so the next item in the same claim sees where the page now is.
 */
async function movePage(move: ComposeMove): Promise<void> {
  if (move.kind === "stay") return
  if (move.kind === "focus") spaNavigate(projectViewHref(move.slug))
  else {
    rememberCrossProjectFocus(move.id)
    if (innerPath() !== "/") spaNavigate(homeHref(), { replace: true })
  }
  await until(() => projectSlug() === move.slug, 3_000)
}

/**
 * Focus the box once it shows the new draft — it may be remounting under a project switch — and put the
 * caret after the insert. Unfocused, it waits for the same box and only brings it into view: moving the
 * selection of a box that is not focused would take the caret from wherever the human left it in that box.
 */
async function placeCaret(selector: string, prose: string, caret: number, focus: boolean): Promise<void> {
  let box: HTMLTextAreaElement | undefined
  await until(() => {
    box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find((el) => el.value === prose && el.getClientRects().length > 0)
    return box !== undefined
  }, 3_000)
  if (!box) return
  if (!focus) {
    box.scrollIntoView({ block: "nearest" })
    return
  }
  box.focus({ preventScroll: false })
  box.setSelectionRange(caret, caret)
}

/** The first board, or 5s — whichever comes first. */
export function boardOrTimeout(): Promise<void> {
  if (store.board) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      stop()
      window.clearTimeout(timer)
      resolve()
    }
    const stop = subscribe(store, () => {
      if (store.board) done()
    })
    const timer = window.setTimeout(done, 5_000)
  })
}

/** Poll a condition until it holds or `ms` passes — a timer, not a frame, so a hidden tab still gets there. */
function until(holds: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const check = () => {
      if (holds() || Date.now() > deadline) resolve()
      else window.setTimeout(check, 30)
    }
    check()
  })
}
