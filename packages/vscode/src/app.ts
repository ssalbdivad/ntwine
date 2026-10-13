// THE EXTENSION, wired to an editor window. `extension.ts` hands in the `vscode` module, so this file
// holds only `import type` from it — the logic it leans on (discovery, the socket, project matching,
// the message format, thread order) lives in vscode-free modules the unit tests run under plain node,
// and this is the glue the end-to-end harness (scripts/e2e.ts) drives inside a real VS Code.
//
// Copy follows the repo's rules: sentence case, what the human can do, never the machinery.

import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import type * as vscode from "vscode"
import { EDITOR_FEATURES, type EditorComposeInput, type EditorComposed, type EditorOpen, type EditorProject } from "@ntwine/shared/editor-protocol"
import { EMBED_PROBLEMS_PATH, EMBED_TERMINAL_PATH, type EmbedAddContextMessage, type EmbedCommandMessage, type EmbedComposeMessage, type EmbedEditorContextMessage, type EmbedEditorExtrasMessage, type EmbedReviewMessage } from "@ntwine/shared/embed-protocol"
import { BUILD, buildLabel, builtAtLabel, installedBuild } from "./build-info.ts"
import { EditorConnection, FocusRecency, type ConnectionStatus, type OpenResult } from "./connection.ts"
import { registerContextFeed } from "./context-feed.ts"
import { discoverNtwine, pageAddressNote, SOURCE_WORDS, type FoundNtwine } from "./discovery.ts"
import { fixNote, fixTitle, lineSpan, terminalText, type Problem } from "./editor-context.ts"
import { registerEditorStateFeed, SHARE_SETTING } from "./editor-state-feed.ts"
import { registerEditorWatcher } from "./editor-watcher.ts"
import { registerExtrasFeed } from "./extras-feed.ts"
import { addRoute, composeInSidebar as composeVia, projectPath, promptRoute, threadOfHref, threadPath } from "./embed.ts"
import { composeInput, composeMessage, normalizeNewlines, refLabel, type FileRef, type Selected } from "./message.ts"
import { projectForPath, workspaceProjects } from "./projects.ts"
import { registerReviews, type ReviewSnapshot } from "./review-view.ts"
import { registerSelectionHint, type SelectionHintShown } from "./selection-hint.ts"
import type { PageComposer } from "./framed-page.ts"
import { registerThreadPanels, type ThreadPanelSnapshot, type ThreadTab } from "./thread-panel.ts"
import { describeRpcError, dispatchProfile, NtwineRpc, withRetry } from "./rpc.ts"
import { registerSidebar, type SidebarSnapshot } from "./sidebar.ts"
import { notConnectedMessage, statusView } from "./status.ts"
import { findThread, pickerThreads, threadHandleOf, threadItem, displayName, displayTitle, windowThread, windowThreadFirst, type PickerThread } from "./threads.ts"
import { registerWorkspaceFiles } from "./workspace-files.ts"

type Vscode = typeof vscode

/** What `activate` returns — read by the end-to-end suite, since a status bar item's text cannot be queried. */
export interface NtwineExtensionApi {
  windowId: string
  status(): ConnectionStatus
  statusBar(): { text: string; tooltip: string; command: string }
  origin(): string | undefined
  /** Where the last discovery found Ntwine, and how — set even when the editor connection was refused. */
  discovered(): FoundNtwine | undefined
  projects(): EditorProject[]
  /** What the Ntwine sidebar shows and what its page asked of it. */
  sidebar(): SidebarSnapshot
  /** The editor's context as the sidebar's page was last told it. */
  editorContext(): EmbedEditorContextMessage | undefined
  /** The last thread's changes this window opened as a multi-file diff. */
  review(): ReviewSnapshot | undefined
  /** The file's problems and the terminal's last command as the sidebar's page was last told them. */
  editorExtras(): EmbedEditorExtrasMessage | undefined
  /** This build's label (`0.1.0+1a2b3c4d`), as the hello, the log and the status bar's tooltip say it. */
  build: string
  /** A different build found installed under this window, which it offered to reload into. */
  reloadOffered(): string | undefined
  /** The hint beside the selection (`Ctrl+L to add to Ntwine`), as it is drawn now; undefined when none is. */
  selectionHint(): SelectionHintShown | undefined
  /** Every thread open in an editor tab, as it is now. */
  threadTabs(): ThreadPanelSnapshot[]
}

/** A file the command is about, with what was selected in it. */
interface Target {
  path: string
  uri: vscode.Uri
  selection?: Selected
  cursorLine?: number
}

/** Command arguments a keybinding, another extension or a test can pass to skip the prompts. */
interface CommandOptions {
  question?: string
  thread?: string
  message?: string
}

const FLASH_MS = 1_500
/** How often a window looks for a new build of the extension installed under it. */
const INSTALL_POLL_MS = 4_000

/** What Ask gives for a selection it cannot place; Send to thread says the same rather than dropping it. */
const OPEN_A_FILE = "Open a file to ask Ntwine about it."

/**
 * How long Ask and Send to thread wait for the sidebar's page to be ready — a cold open of the view boots
 * the whole app — before falling back to the input box; and how long any command waits for the page to
 * answer a compose before handing the selection to the server instead.
 */
const SIDEBAR_READY_MS = 15_000
const SIDEBAR_COMPOSE_MS = 5_000

/** The quick fix's command: it carries the problem it was offered for, so it is never in the palette. */
const FIX_COMMAND = "ntwine.askToFix"
/** Quick fixes offered per request, at most: one per problem under the caret, and a line of them is noise. */
const MAX_FIXES = 5

export function activateNtwine(api: Vscode, context: vscode.ExtensionContext): NtwineExtensionApi {
  const log = api.window.createOutputChannel("Ntwine", { log: true })
  context.subscriptions.push(log)
  const windowId = randomUUID()
  // This build's label — the version, the commit and whether its sources were dirty (build-info.ts). Run
  // from source with no build record, the manifest's version, which is all there is to say.
  const extensionVersion = BUILD.id === "source" ? String((context.extension.packageJSON as { version?: unknown }).version ?? "") : buildLabel(BUILD)
  const builtAt = builtAtLabel(BUILD)
  let projects: EditorProject[] = []
  let status: ConnectionStatus = { kind: "connecting" }

  const config = () => api.workspace.getConfiguration("ntwine")
  const folders = () => (api.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath)
  const windowState = () => ({ folders: folders(), focused: api.window.state.focused, acceptsOpens: config().get<boolean>("openFileLinks", true) })
  const focus = new FocusRecency()
  focus.observe(api.window.state.focused)

  // ── the sidebar ──────────────────────────────────────────────────────────────────────────────────
  // Its host reads the connection, the discovery and the openers below only when the view asks, which
  // is never before activation returns.
  const sidebar = registerSidebar(api, context, {
    // Like the browser page, the sidebar needs no editor connection: an Ntwine discovery found serves its page.
    origin: () => connection.origin ?? found?.origin,
    projectSlug: () => workspaceProjects(folders(), projects)[0]?.slug,
    notFound: () => (status.kind === "offline" || status.kind === "incompatible" ? status.reason : undefined),
    // An Ntwine whose welcome names neither the sidebar nor the editor's picture (which came after the
    // sidebar), or that answered the editor socket with a 404, serves a page from before the sidebar.
    pageSupport: () => {
      const features = connection.features
      if (features) return features.has(EDITOR_FEATURES.sidebar) || features.has(EDITOR_FEATURES.editorState) ? "yes" : "no"
      return connection.predatesBridge ? "no" : "unknown"
    },
    openFile: (message) => openFromNtwine(message),
    openInBrowser: () => openNtwine(),
    reconnect: () => connection.reconnect(),
    addContext: (message, into) => addContextFromPage(message, into),
    hostState: () => ({ shareEditor: shared(), altK: !claudeCode }),
    setShareEditor: (on) => setShareEditor(on),
    review: (message) => reviewFromPage(message),
    pickContext: (message) => workspaceFiles.pick(message),
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line) },
  })
  // A thread in an editor tab (thread-panel.ts): the same page on one thread, answering the page the way
  // the sidebar does, for a conversation that wants the editor's width.
  const panels = registerThreadPanels(api, context, {
    origin: () => connection.origin ?? found?.origin,
    openFile: (message) => openFromNtwine(message),
    addContext: (message, into) => addContextFromPage(message, into),
    hostState: () => ({ shareEditor: shared(), altK: !claudeCode }),
    setShareEditor: (on) => setShareEditor(on),
    review: (message) => reviewFromPage(message),
    pickContext: (message) => workspaceFiles.pick(message),
    backToEditor: () => backToEditor(),
    openInBrowser: (url) => openUrl(url),
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line) },
  })

  // WHICH NTWINE THE HUMAN USED LAST — the sidebar or a thread's tab, by which one's page last took the
  // keyboard (the relay says so). The editor's Ctrl+L (and every add, and Ctrl+L with nothing selected)
  // goes to that one's prompt box while it is on screen: a human reading a thread in a tab beside the code
  // means that thread's reply box, not a sidebar that may be hidden. Ask and Send keep the sidebar — they
  // name their own box (the new-thread box, a picked thread).
  let lastFrame: "sidebar" | ThreadTab | undefined
  sidebar.onFocus(() => (lastFrame = "sidebar"))
  panels.onFocus((tab) => (lastFrame = tab))
  /** The tab the editor's adds go to, when one does: the Ntwine used last, still on screen. */
  const frontTab = (): ThreadTab | undefined => (lastFrame && lastFrame !== "sidebar" && lastFrame.visible() ? lastFrame : undefined)

  /**
   * Every framed page the editor's feeds go to — the sidebar and each thread's tab — as one target: ready
   * while any page is, told "not ready" only when none is, posting to each ready one.
   */
  const pages = {
    ready: () => sidebar.ready() || panels.anyReady(),
    onReady(listener: (ready: boolean) => void) {
      const relay = (ready: boolean) => (ready ? listener(true) : !pages.ready() && listener(false))
      sidebar.onReady(relay)
      panels.onReady(relay)
    },
    async post(message: Parameters<typeof sidebar.post>[0]): Promise<boolean> {
      const [inSidebar, inTabs] = await Promise.all([sidebar.post(message), panels.post(message)])
      return inSidebar || inTabs
    },
  }
  const useSidebar = () => config().get<boolean>("useSidebar", true)
  // Whether the human shares the editor with Ntwine — THE switch: the page's feed carries the selection's
  // text and a send attaches the block only while it is on, and the agents' frame says only `shared: false`
  // while it is off. The bar's eye reads and writes it (`ntwine:host-state` / `ntwine:share-editor`).
  const shared = () => config().get<boolean>(SHARE_SETTING, true)

  /**
   * The eye, flipped: write the setting where it takes effect — the workspace's value when this workspace
   * sets one (a user-level write under it would change nothing), else the user's, which every window reads.
   * The configuration listener below then tells the feeds and the page.
   */
  async function setShareEditor(on: boolean): Promise<string> {
    if (shared() === on) return on ? "on" : "off"
    const where = config().inspect<boolean>(SHARE_SETTING)?.workspaceValue !== undefined ? api.ConfigurationTarget.Workspace : api.ConfigurationTarget.Global
    try {
      await config().update(SHARE_SETTING, on, where)
    } catch (error) {
      log.warn(`Couldn't ${on ? "turn on" : "turn off"} sharing the editor with Ntwine: ${(error as Error).message}`)
      return "refused"
    }
    log.info(on ? "Sharing the editor with Ntwine." : "Not sharing the editor with Ntwine: sends carry no editor context, and agents can't read it.")
    return shared() === on ? (on ? "on" : "off") : "overridden"
  }

  // CLAUDE CODE'S CHORD. Its VS Code extension (anthropic.claude-code) binds Alt+K with the same `when` as
  // Ntwine's ("editorTextFocus"), so with both installed which one answered depended on the order the
  // extensions loaded — on the maintainer's own machine (review-final.md, 2026-10-02). Ntwine steps aside:
  // its Alt+K binding is gated on this context key, set now and whenever the extension set changes, and
  // the page stops naming the chord. Ctrl+L, the chord the page teaches, is not Claude Code's.
  const CLAUDE_CODE = "anthropic.claude-code"
  let claudeCode = api.extensions.getExtension(CLAUDE_CODE) !== undefined
  const applyClaudeCode = () => void api.commands.executeCommand("setContext", "ntwine.claudeCodeInstalled", claudeCode)
  applyClaudeCode()
  context.subscriptions.push(api.extensions.onDidChange(() => {
    const next = api.extensions.getExtension(CLAUDE_CODE) !== undefined
    if (next === claudeCode) return
    claudeCode = next
    log.info(next ? "Claude Code's extension is installed: Alt+K is its, not Ntwine's." : "Claude Code's extension is gone: Alt+K adds to Ntwine's prompt again.")
    applyClaudeCode()
    sidebar.pushState()
    panels.pushState()
  }))
  // One observer of the window's editors, which both feeds read (editor-front.ts says why there is one).
  const watcher = registerEditorWatcher(api, context)
  const feed = registerContextFeed(api, context, watcher, {
    ready: pages.ready,
    onReady: (listener) => pages.onReady(listener),
    post: (message) => pages.post(message),
    projects: () => projects,
    shared,
  })
  const extras = registerExtrasFeed(api, context, {
    ready: pages.ready,
    onReady: (listener) => pages.onReady(listener),
    post: (message) => pages.post(message),
  })
  const workspaceFiles = registerWorkspaceFiles(api, context, { projects: () => projects })
  // Cursor's "⌘L to chat" beside a fresh selection, for Ntwine's chord (selection-hint.ts says when, where
  // and why not). Only while connected: the chord says Ntwine isn't running otherwise.
  const hint = registerSelectionHint(api, context, { connected: () => status.kind === "connected", mac: () => sidebar.mac() })

  // ── status bar ───────────────────────────────────────────────────────────────────────────────────
  const item = api.window.createStatusBarItem("ntwine.status", api.StatusBarAlignment.Right, 100)
  item.name = "Ntwine"
  context.subscriptions.push(item)
  let shown = statusView(status, [])
  const renderStatus = () => {
    shown = statusView(status, workspaceProjects(folders(), projects), extensionVersion)
    item.text = shown.text
    item.tooltip = shown.tooltip
    item.command = shown.command
    item.show()
    sidebar.setBadge(shown.ready)
  }
  renderStatus()

  // ── the socket ───────────────────────────────────────────────────────────────────────────────────
  const highlight = api.window.createTextEditorDecorationType({
    backgroundColor: new api.ThemeColor("editor.rangeHighlightBackground"),
    isWholeLine: true,
  })
  context.subscriptions.push(highlight)

  // Raising the window is best-effort. `workbench.action.focusWindow` arrived in VS Code 1.128, so the
  // VS Codes the manifest's ^1.90 admits before it — and Cursor and Windsurf, which build on older
  // bases (Cursor 3.11 is 1.125) — have no such command. After an OPEN the file has already opened by
  // the time the window is raised, so the answer is still ok: refusing would toast an error over a file
  // that opened. A FOCUS request is nothing but the raise, though, so it answers that it could not, and
  // Ntwine falls back to the editor's own command line, which raises the window holding the folder.
  let raiseMissing = false
  const focusWindow = async (): Promise<boolean> => {
    try {
      await api.commands.executeCommand("workbench.action.focusWindow")
      return true
    } catch (error) {
      if (!raiseMissing) log.info(`${api.env.appName} ${api.version} can't bring its own window to the front (${(error as Error).message}); Ntwine's file links still open here.`)
      raiseMissing = true
      return false
    }
  }

  // What this window shows — file, selection, tabs, problems — for Ntwine's agents to read
  // (`mcp__ntwine__editor`), sent on every change to an Ntwine that takes it. `ntwine.shareEditorState` off
  // sends that it is off, and nothing else.
  const editorState = registerEditorStateFeed(api, context, watcher, { send: () => connection.sendEditor(), shared })

  // A thread's changes as a multi-file diff (review-view.ts): pushed by Ntwine when the human asks from a
  // browser tab (the window then comes to the front), asked for by the sidebar's page, or picked here.
  const reviews = registerReviews(api, context, { info: (line) => log.info(line), warn: (line) => log.warn(line) })

  let lastNotes: string | undefined
  /** The last discovery's answer: the origin a page opens on even when the editor connection was refused. */
  let found: FoundNtwine | undefined
  const connection = new EditorConnection({
    async discover() {
      const result = await discoverNtwine({ serverUrl: config().get<string>("serverUrl", "") })
      // Where it looked, in full the first time and whenever the answer changes; the same misses on
      // every retry are only for the debug level.
      const notes = result.notes.join("\n")
      for (const note of result.notes) (notes === lastNotes ? log.debug : log.info).call(log, `Looked for Ntwine: ${note}`)
      lastNotes = notes
      found = result.found
      return result.found ? { origin: result.found.origin, detail: `found through ${SOURCE_WORDS[result.found.source]}` } : undefined
    },
    hello() {
      const state = windowState()
      const ago = focus.agoMs(state.focused)
      return { windowId, app: api.env.appName, extensionVersion, ...state, ...(ago === undefined ? {} : { focusedAgoMs: ago }), home: homedir(), platform: process.platform }
    },
    state: windowState,
    editor: () => editorState.snapshot(),
    open: (message) => openFromNtwine(message),
    async focus() {
      return (await focusWindow()) ? { ok: true } : { ok: false, error: `${api.env.appName} can't bring its window to the front.` }
    },
    async review(message) {
      const result = await reviews.open(message)
      // The ask came from a browser: the diff is no use behind it. Best-effort, as after an open.
      if (result.ok) await focusWindow()
      return result
    },
    projects(next) {
      projects = next
      renderStatus()
      sidebar.refresh()
      panels.refresh()
      feed.refresh()
      if (sidebar.ready() && !windowThreadCheck) windowThreadCheck = openWindowThread()
    },
    status(next) {
      status = next
      renderStatus()
      sidebar.refresh()
      panels.refresh()
      hint.refresh()
    },
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line), error: (line) => log.error(line) },
  })
  context.subscriptions.push({ dispose: () => connection.stop() })


  async function openFromNtwine(message: EditorOpen): Promise<OpenResult> {
    let path = message.path
    let entry = await stat(path).catch(() => undefined)
    if (!entry) {
      // A link into a thread's worktree that Done has since removed: Ntwine names the main checkout's copy,
      // which the work was merged into (settleMissing). Asked only for a path that is not there, so an
      // ordinary open never waits on the server.
      const settled = await settleMissing(path)
      entry = settled ? await stat(settled).catch(() => undefined) : undefined
      if (!entry || !settled) return { ok: false, error: `${message.path} doesn't exist.` }
      log.info(`${message.path} is gone; opening the main checkout's copy, ${settled}.`)
      path = settled
    }
    const uri = api.Uri.file(path)
    if (entry.isDirectory()) {
      // In the explorer when the window has it; a folder outside every one of its folders (a thread's
      // worktree elsewhere, another project) has nothing to reveal it in, and revealing it did nothing
      // visible — so it opens in a window of its own, as `code <folder>` would.
      if (api.workspace.getWorkspaceFolder(uri)) {
        await api.commands.executeCommand("revealInExplorer", uri)
        await focusWindow()
      } else await api.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true })
      return { ok: true }
    }
    await api.commands.executeCommand("vscode.open", uri)
    const editor = [api.window.activeTextEditor, ...api.window.visibleTextEditors].find((candidate) => candidate?.document.uri.fsPath === uri.fsPath)
    if (editor && message.line) {
      const document = editor.document
      const last = document.lineCount - 1
      const startLine = Math.min(message.line - 1, last)
      let selection: vscode.Selection
      if (message.endLine && message.endLine > message.line) {
        // A range selects its whole lines, as GitHub's #L12-L20 highlights them.
        const endLine = Math.min(message.endLine - 1, last)
        selection = new api.Selection(startLine, 0, endLine, document.lineAt(endLine).range.end.character)
      } else {
        const at = document.validatePosition(new api.Position(startLine, Math.max(0, (message.column ?? 1) - 1)))
        selection = new api.Selection(at, at)
      }
      editor.selection = selection
      editor.revealRange(selection, api.TextEditorRevealType.InCenterIfOutsideViewport)
      // A beat of highlight on the lines, so the eye lands where the link pointed.
      editor.setDecorations(highlight, [new api.Range(selection.start.line, 0, selection.end.line, 0)])
      setTimeout(() => editor.setDecorations(highlight, []), FLASH_MS)
    }
    await focusWindow()
    return { ok: true }
  }

  // ── the window's own thread ──────────────────────────────────────────────────────────────────────
  // A window whose workspace folder IS a thread's worktree opens the sidebar on that thread (threads.ts
  // windowThread says why, and why here rather than in the frame's address). Once per page load — a page
  // the human has moved about in stays where they put it — and BEFORE anything else this extension posts
  // to a page that just came up: every wait for the page (`waitSidebarReady`) waits for this too, or a
  // chip added by the very command that opened the sidebar would land in the queue's box and then vanish
  // under the thread opening over it.
  let windowThreadCheck: Promise<void> | undefined
  sidebar.onReady((ready) => {
    if (!ready) windowThreadCheck = undefined
    else windowThreadCheck ??= openWindowThread()
  })

  /** Two folders are one when their real paths are (a symlinked spelling of a worktree is that worktree). */
  function sameFolder(a: string, b: string): boolean {
    const real = (path: string) => {
      try { return realpathSync.native(path) } catch { return resolve(path) }
    }
    return real(a) === real(b)
  }

  async function openWindowThread(): Promise<void> {
    const origin = connection.origin ?? found?.origin
    const project = workspaceProjects(folders(), projects)[0]
    // Ntwine's project list has not arrived yet: try again when it does (the `projects` callback).
    if (!origin || !project) {
      windowThreadCheck = undefined
      return
    }
    let thread: PickerThread | undefined
    try {
      thread = windowThread((await new NtwineRpc(origin).query(project.id, "board", undefined, 5_000)).threads, folders(), sameFolder)
    } catch (error) {
      log.info(`Could not read the board to find this window's thread: ${(error as Error).message}`)
      return
    }
    if (!thread || !sidebar.ready()) return
    log.info(`This window is the worktree of thread ${thread.id}; the sidebar opens on it.`)
    await sidebar.navigate({ thread: thread.id, project: project.slug })
  }

  /** The sidebar's page is ready, and has been taken to this window's thread when it has one. */
  async function waitSidebarReady(ms: number): Promise<boolean> {
    if (!(await sidebar.waitReady(ms))) return false
    const check = windowThreadCheck
    if (check) await Promise.race([check, new Promise((settle) => setTimeout(settle, SIDEBAR_COMPOSE_MS))])
    return true
  }

  /**
   * The main checkout's copy of a file in a worktree that is gone (the server's `settleLocalPath`), or
   * undefined. A file link the sidebar's page hands over (`ntwine:open-file`) comes straight here, not
   * through Ntwine's opener, which settles its own; an agent that worked in `.ntwine/worktrees/<slug>` wrote
   * its links there, and Done removes the worktree. Asked of the project the path lies in, else the
   * window's; an Ntwine too old for the procedure, or no answer within a moment, leaves the path missing.
   */
  async function settleMissing(path: string): Promise<string | undefined> {
    const origin = connection.origin ?? found?.origin
    const project = projectForPath(path, projects)?.project ?? windowProject()
    if (!origin || !project) return undefined
    try {
      const settled = (await new NtwineRpc(origin).query(project.id, "settleLocalPath", { path }, 3_000)).path
      return settled && settled !== path ? settled : undefined
    } catch {
      return undefined
    }
  }

  // ── the window's own changes ─────────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    api.window.onDidChangeWindowState((state) => {
      focus.observe(state.focused)
      connection.sendState()
    }),
    api.workspace.onDidChangeWorkspaceFolders(() => {
      connection.sendState()
      renderStatus()
      sidebar.refresh()
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ntwine.serverUrl")) connection.reconnect()
      else if (event.affectsConfiguration("ntwine.openFileLinks")) connection.sendState()
      if (event.affectsConfiguration(`ntwine.${SHARE_SETTING}`)) {
        editorState.sharingChanged()
        feed.refresh()
        sidebar.pushState()
        panels.pushState()
      }
    }),
  )

  // ── a new build installed under this window (build-info.ts) ──────────────────────────────────────
  // A window keeps running the code it loaded. `nub run vscode:install` (or any install of the .vsix)
  // puts a new build on disk, and until the window reloads it runs the old one — which is how a fix got
  // "verified" in a window that never had it. So the window looks, every few seconds, at what is
  // installed where it loaded from, and offers to reload once per new build.
  let offered: { id: string; label: string } | undefined
  const watchInstall = setInterval(() => {
    const next = installedBuild(context.extensionPath, context.extension.id)
    if (!next || next.id === offered?.id) return
    const label = buildLabel(next)
    offered = { id: next.id, label }
    log.info(`A different build of the extension is installed: ${label}. Reload the window to run it; this one runs ${extensionVersion}.`)
    void api.window.showInformationMessage(`Ntwine's extension was updated to ${label}. Reload the window to use it.`, "Reload window").then((choice) => {
      if (choice === "Reload window") void api.commands.executeCommand("workbench.action.reloadWindow")
    })
  }, INSTALL_POLL_MS)
  watchInstall.unref?.()
  context.subscriptions.push({ dispose: () => clearInterval(watchInstall) })

  // ── helpers the commands share ───────────────────────────────────────────────────────────────────

  /** Say why the connection is down — its own reason, not a guess — with a way to try again. */
  function showNotConnected(): void {
    void api.window.showErrorMessage(notConnectedMessage(status), "Try again", "Show log").then((choice) => {
      if (choice === "Try again") connection.reconnect()
      else if (choice === "Show log") log.show()
    })
  }

  /** The connected origin, or undefined after telling the human why there is none. */
  function requireOrigin(): string | undefined {
    const origin = connection.origin
    if (origin) return origin
    showNotConnected()
    return undefined
  }

  function openUrl(url: string): void {
    // Which kind of address this page lands on: almost always the public one, but not when discovery
    // fell through to the server's lock file (discovery.ts, step 5).
    const source = found && url.startsWith(`${found.origin}/`) ? found.source : undefined
    if (source) {
      const { level, note } = pageAddressNote(source)
      log[level](`Opening ${url} on ${note}.`)
    }
    void api.env.openExternal(api.Uri.parse(url))
  }

  function projectUrl(origin: string, project: EditorProject | undefined): string {
    return project ? `${origin}${projectPath(project.slug)}` : `${origin}/`
  }

  /** Split a command's arguments: a resource (explorer, editor menu) and/or an options object. */
  function splitArgs(args: unknown[]): { uri?: vscode.Uri; options: CommandOptions } {
    let uri: vscode.Uri | undefined
    let options: CommandOptions = {}
    for (const arg of args) {
      if (arg instanceof api.Uri) uri ??= arg
      else if (arg && typeof arg === "object" && !Array.isArray(arg)) options = { ...options, ...(arg as CommandOptions) }
    }
    return { uri, options }
  }

  /**
   * Text selected where no command can place it: an editor that is not a file on disk — an untitled
   * buffer, the git side of a diff. A command that would otherwise carry the selection must refuse
   * rather than send without it.
   */
  function unplaceableSelection(uri: vscode.Uri | undefined): boolean {
    const editor = api.window.activeTextEditor
    if (!editor || (uri && editor.document.uri.toString() !== uri.toString())) return false
    return editor.document.uri.scheme !== "file" && !editor.selection.isEmpty
  }

  /**
   * The file a command is about: the resource it was invoked on, else the editor's — the active one, unless
   * the caller names the editor (the context bar names the one it showed, which with an output pane focused
   * is the file editor still on screen, not the active one).
   */
  function targetOf(uri: vscode.Uri | undefined, editor = api.window.activeTextEditor): Target | undefined {
    const fromEditor = editor && (!uri || editor.document.uri.toString() === uri.toString()) ? editor : undefined
    if (fromEditor) {
      const document = fromEditor.document
      if (document.uri.scheme !== "file") return undefined
      const selection = fromEditor.selection
      if (selection.isEmpty) return { path: document.uri.fsPath, uri: document.uri, cursorLine: selection.active.line + 1 }
      // A selection that ends at column 0 of a line (a whole-line drag, shift+down) does not include it —
      // the same count the sidebar's context bar shows for it (editor-context.ts).
      const { startLine, endLine } = lineSpan(selection.start, selection.end)
      return { path: document.uri.fsPath, uri: document.uri, selection: { text: normalizeNewlines(document.getText(selection)), startLine, endLine } }
    }
    if (uri && uri.scheme === "file") return { path: uri.fsPath, uri }
    return undefined
  }

  /**
   * The project a file belongs to and how to show its path. A file no project's folder holds offers
   * Home instead (labelled for the command at hand), or opening Ntwine's add-folder dialog on it.
   */
  async function place(target: Target, origin: string, homeLabel: string): Promise<{ project: EditorProject; ref: FileRef } | undefined> {
    const match = projectForPath(target.path, projects)
    const ref = (path: string, display: string): FileRef => ({ path, display, selection: target.selection, cursorLine: target.cursorLine })
    if (match) return { project: match.project, ref: ref(match.path, match.relative || match.path) }
    const home = projects.find((project) => project.home)
    const add = "Add folder to Ntwine"
    const choice = await api.window.showWarningMessage(`${basename(target.path)} isn't in an Ntwine project.`, ...(home ? [homeLabel] : []), add)
    if (choice === homeLabel && home) return { project: home, ref: ref(target.path, target.path) }
    if (choice === add) {
      const folder = api.workspace.getWorkspaceFolder(target.uri)?.uri.fsPath ?? dirname(target.path)
      openUrl(`${origin}/?add=${encodeURIComponent(folder)}`)
    }
    return undefined
  }

  /** The project this window is about when no file says: the active file's, else the workspace's first. */
  function windowProject(): EditorProject | undefined {
    const active = api.window.activeTextEditor?.document.uri
    const fromFile = active?.scheme === "file" ? projectForPath(active.fsPath, projects)?.project : undefined
    return fromFile ?? workspaceProjects(folders(), projects)[0]
  }

  const threadUrl = (origin: string, project: EditorProject, slug: string) => `${origin}${threadPath(project.slug, slug)}`

  /** Why the last compose into the sidebar did not land, for a command with nowhere else to send it. */
  let sidebarWhy = ""

  /** A selection into the sidebar's page (embed.ts composeInSidebar), as the server path's answer; undefined to fall back. */
  async function composeInSidebar(input: Omit<EmbedComposeMessage, "type" | "id">, preserveFocus: boolean): Promise<EditorComposed | undefined> {
    const result = await composeVia({ reveal: (keep) => sidebar.reveal(keep), waitReady: waitSidebarReady, compose: (item, ms) => sidebar.compose(item, ms) }, input, { preserveFocus, readyMs: SIDEBAR_READY_MS, composeMs: SIDEBAR_COMPOSE_MS })
    if (result.ok) return { t: "composed", id: result.id, ok: true }
    log.warn(result.why)
    sidebarWhy = result.why
    return undefined
  }

  /** A selection into a thread's tab, revealed and focused, as composeInSidebar puts one into the sidebar. */
  async function composeInTab(tab: ThreadTab, input: Omit<EmbedComposeMessage, "type" | "id">): Promise<EditorComposed | undefined> {
    const result = await composeVia(tab, input, { preserveFocus: false, readyMs: SIDEBAR_READY_MS, composeMs: SIDEBAR_COMPOSE_MS })
    if (result.ok) return { t: "composed", id: result.id, ok: true }
    log.warn(result.why.replace("The Ntwine sidebar", "The thread's tab"))
    sidebarWhy = result.why
    return undefined
  }

  /**
   * Ctrl+L / ⌘L pressed in a thread's tab: back to the code. The text editor the human was last in — the
   * one in front by the watcher's rule, which with a tab focused is the last file editor still on screen —
   * else the first one on screen; with none, the group beside the tab.
   */
  async function backToEditor(): Promise<void> {
    const editor = watcher.frontEditor() ?? api.window.visibleTextEditors[0]
    if (editor) await api.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
    else await api.commands.executeCommand("workbench.action.focusPreviousGroup")
  }

  /**
   * Open thread in editor tab — the sidebar's title row (its ⋯, while a thread shows) or the palette: the
   * thread the sidebar shows, when it is in sight and shows one; else one of this window's project's
   * threads, picked (or named by a caller, `{ thread, project? }`).
   */
  async function openThreadInTab(...args: unknown[]): Promise<ThreadPanelSnapshot | undefined> {
    const origin = connection.origin ?? found?.origin
    if (!origin) {
      showNotConnected()
      return undefined
    }
    const { options } = splitArgs(args)
    const named = options as CommandOptions & { project?: string }
    let target: { thread: string; project: string; title?: string } | undefined
    if (typeof named.thread === "string") {
      const project = typeof named.project === "string" ? named.project : windowProject()?.slug
      if (!project) {
        void api.window.showInformationMessage("Open a folder that's an Ntwine project to open its threads here.")
        return undefined
      }
      target = { thread: named.thread, project }
    } else {
      const shown = sidebar.visible() && sidebar.snapshot().view === "thread" ? threadOfHref(sidebar.snapshot().href) : undefined
      if (shown) target = shown
      else {
        const project = windowProject()
        if (!project) {
          void api.window.showInformationMessage("Open a folder that's an Ntwine project to open its threads here.")
          return undefined
        }
        let threads: PickerThread[]
        try {
          const open = pickerThreads((await new NtwineRpc(origin).query(project.id, "board")).threads)
          // A window on a thread's worktree offers that thread first (threads.ts windowThread).
          threads = windowThreadFirst(open, windowThread(open, folders(), sameFolder))
        } catch (error) {
          void api.window.showErrorMessage(describeRpcError(error))
          return undefined
        }
        if (!threads.length) {
          void api.window.showInformationMessage(`${project.name} has no open threads.`)
          return undefined
        }
        const picked = (await api.window.showQuickPick(threads.map((candidate) => ({ ...threadItem(candidate), thread: candidate })), {
          title: "Open a thread in an editor tab",
          placeHolder: `Pick a thread in ${project.name}`,
          matchOnDescription: true,
          matchOnDetail: true,
        }))?.thread
        if (!picked) return undefined
        target = { thread: picked.id, project: project.slug, title: displayName(picked) }
      }
    }
    await panels.open(target)
    return panels.snapshot().find((tab) => tab.thread === target.thread && tab.project === target.project)
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────────

  async function ask(...args: unknown[]): Promise<{ slug: string } | { composed: EditorComposed } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    hint.added()
    const { uri, options } = splitArgs(args)
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage(OPEN_A_FILE)
      return undefined
    }
    const placed = await place(target, origin, "Ask in Home")
    if (!placed) return undefined
    const { project, ref } = placed
    if (promptRoute(useSidebar(), options.question) === "sidebar") {
      // The sidebar's new-thread box, with the chip and the caret: the question is written there.
      const item = { ...composeInput({ ...ref, projectId: project.id }), app: api.env.appName }
      const composed = await composeInSidebar({ item, target: "new", focus: true }, false)
      if (composed) return { composed }
      log.info("Asking in an input box instead.")
    }
    const question = typeof options.question === "string"
      ? options.question
      : await api.window.showInputBox({
          title: "Ask Ntwine",
          prompt: `Ask Ntwine about ${refLabel(ref)}`,
          placeHolder: "What do you want to know or change?",
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : "Type a question for Ntwine."),
        })
    if (question === undefined || !question.trim()) return undefined
    const rpc = new NtwineRpc(origin)
    try {
      const result = await api.window.withProgress({ location: api.ProgressLocation.Notification, title: "Asking Ntwine…" }, async () => {
        // The operator's saved backend, model and effort, as the page's prompt box sends them: a
        // dispatch with no backend means Claude whatever the preference says.
        const preferences = await rpc.query(project.id, "dispatchPreferencesGet")
        // No retry: a dispatch that timed out may still have started its thread.
        return rpc.mutation(project.id, "dispatch", { prompt: composeMessage(question, ref), ...dispatchProfile(preferences) }, 60_000)
      })
      log.info(`Asked Ntwine in ${project.name}: thread ${result.slug}.`)
      void api.window.showInformationMessage("Asked Ntwine.", "Open thread").then((choice) => {
        if (choice) openUrl(threadUrl(origin, project, result.slug))
      })
      return { slug: result.slug }
    } catch (error) {
      log.error(`Asking Ntwine failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(describeRpcError(error, "ask"))
      return undefined
    }
  }

  async function sendToThread(...args: unknown[]): Promise<{ slug: string; deliveryId?: string; composed?: EditorComposed } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    hint.added()
    const { uri, options } = splitArgs(args)
    const target = targetOf(uri)
    if (!target && unplaceableSelection(uri)) {
      void api.window.showInformationMessage(OPEN_A_FILE)
      return undefined
    }
    let project: EditorProject | undefined
    let ref: FileRef | undefined
    if (target) {
      const placed = await place(target, origin, "Use Home")
      if (!placed) return undefined
      ;({ project, ref } = placed)
    } else {
      project = windowProject()
    }
    if (!project) {
      void api.window.showInformationMessage("Open a file in an Ntwine project to send it to a thread.")
      return undefined
    }
    const rpc = new NtwineRpc(origin)
    let threads: (PickerThread & { sessionId: string })[]
    try {
      threads = pickerThreads((await rpc.query(project.id, "board")).threads)
      // A window on a thread's worktree offers that thread first (threads.ts windowThread).
      threads = windowThreadFirst(threads, windowThread(threads, folders(), sameFolder))
    } catch (error) {
      void api.window.showErrorMessage(describeRpcError(error))
      return undefined
    }
    let thread: (PickerThread & { sessionId: string }) | undefined
    if (typeof options.thread === "string") {
      thread = findThread(threads, options.thread)
      if (!thread) {
        void api.window.showErrorMessage(`No open thread named ${options.thread} in ${project.name}.`)
        return undefined
      }
    } else {
      if (!threads.length) {
        void api.window.showInformationMessage(`${project.name} has no open threads. Ask Ntwine to start one.`)
        return undefined
      }
      const picked = await api.window.showQuickPick(
        threads.map((candidate) => ({ ...threadItem(candidate), thread: candidate })),
        {
          title: ref ? `Send ${refLabel(ref)} to a thread` : "Send to a thread",
          placeHolder: `Pick a thread in ${project.name}`,
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true,
        },
      )
      thread = picked?.thread
    }
    if (!thread) return undefined
    if (promptRoute(useSidebar(), options.message) === "sidebar") {
      // The thread in the sidebar, the chip in its reply box and the caret after it. With no file to
      // carry, the thread alone, to write in.
      const to = { thread: thread.id, project: project.slug }
      if (ref) {
        const item = { ...composeInput({ ...ref, projectId: project.id }), app: api.env.appName }
        const composed = await composeInSidebar({ item, target: to, focus: true }, false)
        if (composed) return { slug: thread.id, composed }
      } else {
        await sidebar.reveal(false)
        if ((await waitSidebarReady(SIDEBAR_READY_MS)) && (await sidebar.navigate(to))) return { slug: thread.id }
      }
      log.info("Sending from an input box instead.")
    }
    const name = threadHandleOf(thread) ? `@${threadHandleOf(thread)}` : displayTitle(thread)
    const message = typeof options.message === "string"
      ? options.message
      : await api.window.showInputBox({
          title: `Message ${name}`,
          prompt: ref ? `About ${refLabel(ref)}` : undefined,
          placeHolder: "Your message",
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : "Type a message."),
        })
    if (message === undefined || !message.trim()) return undefined
    const text = ref ? composeMessage(message, ref) : normalizeNewlines(message).trim()
    // One id for every attempt: the server drops a resend of a delivery it already took.
    const deliveryId = randomUUID()
    const chosen = thread
    try {
      await api.window.withProgress({ location: api.ProgressLocation.Notification, title: `Sending to ${name}…` }, () =>
        withRetry(() => rpc.mutation(project.id, "followUp", { slug: chosen.id, sessionId: chosen.sessionId, message: text, deliveryId }, 120_000)))
      log.info(`Sent a message to ${chosen.id} in ${project.name}.`)
      void api.window.showInformationMessage(`Sent to ${name}.`, "Open thread").then((choice) => {
        if (choice) openUrl(threadUrl(origin, project, chosen.id))
      })
      return { slug: chosen.id, deliveryId }
    } catch (error) {
      log.error(`Sending to ${chosen.id} failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(describeRpcError(error, "send"))
      return undefined
    }
  }

  /**
   * Put items into the prompt box the human looks at — the one way in for Add to Ntwine prompt, a file, a
   * problem's quick fix and a terminal selection. With the sidebar (embed.ts addRoute): its FRONT composer
   * (the reply box of the thread it shows, else its new-thread box), the view revealed — opened, the first
   * time in a window — and the caret after the last chip, with `note` written after it. Otherwise, and for
   * whatever the sidebar did not take (it never loaded, or refused), Ntwine holds each item for a browser
   * page to claim, the path from before the sidebar, so a selection is never simply lost — unless the item
   * means nothing outside the sidebar (`sidebarOnly`: a terminal selection). The note rides the sidebar
   * only; a held item has no place for one.
   */
  async function deliver(items: readonly EditorComposeInput[], options: { note?: string; sidebarOnly?: boolean } = {}): Promise<EditorComposed | undefined> {
    let left = items
    const ntwine = (connection.origin ?? found?.origin) !== undefined
    if (addRoute({ enabled: useSidebar(), ntwine }) === "sidebar") {
      let composed: EditorComposed | undefined
      // The thread's tab when that is the Ntwine used last and it is on screen (frontTab), else the sidebar.
      const tab = frontTab()
      while (left.length) {
        const [item, ...rest] = left
        const note = rest.length === 0 && options.note ? { note: options.note } : {}
        const input = { item: { ...item!, app: api.env.appName }, target: "front" as const, focus: true, ...note }
        const next = tab ? await composeInTab(tab, input) : await composeInSidebar(input, false)
        if (!next) break
        composed = next
        left = rest
      }
      if (!left.length && composed) {
        api.window.setStatusBarMessage("Added to Ntwine's prompt box", 4_000)
        return composed
      }
      if (!options.sidebarOnly) log.info("Handing it to Ntwine for its page instead.")
    }
    if (options.sidebarOnly) {
      if (!useSidebar()) void api.window.showInformationMessage("Turn on the Ntwine sidebar (ntwine.useSidebar) to add this to Ntwine's prompt box.")
      else if (!ntwine) showNotConnected()
      else void api.window.showErrorMessage(sidebarWhy || "The Ntwine sidebar couldn't take it.")
      return undefined
    }
    const origin = requireOrigin()
    if (!origin) return undefined
    let composed: EditorComposed | undefined
    for (const item of left) {
      composed = await connection.compose(item)
      if (!composed.ok) {
        log.warn(`Adding to the prompt box failed: ${composed.error ?? "no reason given"}`)
        void api.window.showErrorMessage(`Couldn't add to Ntwine's prompt box: ${composed.error ?? "Ntwine refused it."}`)
        return composed
      }
    }
    api.window.setStatusBarMessage("Added to Ntwine's prompt box", 4_000)
    const project = left[0]?.projectId ? projects.find((candidate) => candidate.id === left[0]!.projectId) : undefined
    void api.window.showInformationMessage("Added to Ntwine's prompt box.", "Open Ntwine").then((choice) => {
      if (choice) openUrl(projectUrl(origin, project ?? windowProject()))
    })
    return composed
  }

  /** A compose item for a place in a file, with the project it belongs to and that project's spelling of its path. */
  function itemFor(target: { path: string; selection?: Selected; cursorLine?: number }): EditorComposeInput {
    const match = projectForPath(target.path, projects)
    return composeInput({ ...target, path: match?.path ?? target.path, projectId: match?.project.id })
  }

  /**
   * Add to Ntwine prompt — Ctrl+L / ⌘L (Cursor's chord) or Ctrl+I / ⌘I with a selection, the editor's Ntwine
   * menu, the palette: the selection, else the caret's line.
   */
  async function addToPrompt(...args: unknown[]): Promise<EditorComposed | undefined> {
    const { uri } = splitArgs(args)
    hint.added()
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage("Open a file to add it to Ntwine's prompt box.")
      return undefined
    }
    return deliver([itemFor(target)])
  }

  /**
   * Add file to Ntwine prompt — an editor tab's menu, the explorer (every file selected there), the palette
   * (the file in front): a reference to each whole file. Folders are left out; a prompt names files.
   */
  async function addFileToPrompt(...args: unknown[]): Promise<EditorComposed | undefined> {
    const many = args.find((arg): arg is vscode.Uri[] => Array.isArray(arg) && arg.length > 0 && arg.every((each) => each instanceof api.Uri))
    const one = args.find((arg): arg is vscode.Uri => arg instanceof api.Uri) ?? api.window.activeTextEditor?.document.uri
    const items: EditorComposeInput[] = []
    for (const uri of many ?? (one ? [one] : [])) {
      if (uri.scheme !== "file") continue
      try {
        if (!(await stat(uri.fsPath)).isFile()) continue
      } catch {
        continue
      }
      items.push(itemFor({ path: uri.fsPath }))
    }
    if (!items.length) {
      void api.window.showInformationMessage("Pick a file on disk to add it to Ntwine's prompt box.")
      return undefined
    }
    return deliver(items)
  }

  /**
   * Alt+K (Option+K on a Mac) — Claude Code's chord for an @-mention of the code in front: the selection
   * when there is one, as Add to Ntwine prompt adds it; with only a caret, the whole file, as Add file to
   * Ntwine prompt adds it. Not the caret's line, which is what the palette's Add to Ntwine prompt falls back
   * to: a mention with nothing selected names the file, which is what the human is looking at.
   */
  async function addSelectionOrFile(...args: unknown[]): Promise<EditorComposed | undefined> {
    const editor = api.window.activeTextEditor
    return editor && !editor.selection.isEmpty ? addToPrompt(...args) : addFileToPrompt(...args)
  }

  /**
   * Ask Ntwine to fix — the quick fix on a problem: the problem's lines with their text, and the problem
   * itself written after the chip (`Fix: Cannot find name 'foo'. ts(2304)`), so the box reads as a request
   * the human can send as it is.
   */
  async function askToFix(uri: unknown, range: unknown, problem: unknown): Promise<EditorComposed | undefined> {
    if (!(uri instanceof api.Uri) || !(range instanceof api.Range) || !problem || typeof problem !== "object") return undefined
    const document = await api.workspace.openTextDocument(uri)
    const { startLine, endLine } = lineSpan(range.start, range.end)
    const last = Math.min(endLine, document.lineCount) - 1
    const text = normalizeNewlines(document.getText(new api.Range(startLine - 1, 0, last, document.lineAt(last).text.length)))
    return deliver([itemFor({ path: uri.fsPath, selection: { text, startLine, endLine: last + 1 } })], { note: fixNote(problem as Problem) })
  }

  /**
   * The terminal's selection, read without keeping the human's clipboard: VS Code has no stable API for
   * it (`Terminal.selection` is a proposal only Copilot may use), so the terminal's own Copy runs between
   * a unique marker and the clipboard's previous text, which is put back whatever happens. The marker
   * still there afterwards means nothing was copied. Lost on the way: a clipboard holding something other
   * than text (an image) comes back empty, and a clipboard history records the selection.
   */
  async function readTerminalSelection(): Promise<string | undefined> {
    const before = await api.env.clipboard.readText()
    const marker = `ntwine-terminal-${randomUUID()}`
    await api.env.clipboard.writeText(marker)
    try {
      await api.commands.executeCommand("workbench.action.terminal.copySelection")
      const copied = await api.env.clipboard.readText()
      return copied === marker ? undefined : copied
    } finally {
      await api.env.clipboard.writeText(before)
    }
  }

  /** Add to Ntwine prompt from the terminal's menu: its selection as an `@terminal` chip. Sidebar only; see deliver. */
  async function addTerminalSelection(): Promise<EditorComposed | undefined> {
    const checked = terminalText((await readTerminalSelection()) ?? "")
    if (!checked.ok) {
      void api.window.showInformationMessage(checked.why)
      return undefined
    }
    const project = windowProject()
    return deliver([{ path: EMBED_TERMINAL_PATH, text: checked.text, ...(project ? { projectId: project.id } : {}) }], { sidebarOnly: true })
  }

  /**
   * Add problems in this file — the palette, the editor's Ntwine menu: the file in front's errors and
   * warnings, each with its line, as one `@problems` chip (extras.ts problemsText). Sidebar only, like a
   * terminal selection: the chip's text has no file to fall back to as a reference.
   */
  async function addProblems(): Promise<EditorComposed | undefined> {
    const found = extras.problems()
    if (!found.ok) {
      void api.window.showInformationMessage(found.why)
      return undefined
    }
    const project = windowProject()
    return deliver([{ path: EMBED_PROBLEMS_PATH, text: found.text, ...(project ? { projectId: project.id } : {}) }], { sidebarOnly: true })
  }

  /**
   * Add the terminal's last command — the palette, the terminal's menu: the command, its output (the end
   * of it, when it is long) and how it exited, as one `@terminal` chip (extras.ts terminalCommandText).
   */
  async function addTerminalOutput(): Promise<EditorComposed | undefined> {
    const found = await extras.terminal()
    if (!found.ok) {
      void api.window.showInformationMessage(found.why)
      return undefined
    }
    const project = windowProject()
    return deliver([{ path: EMBED_TERMINAL_PATH, text: found.text, ...(project ? { projectId: project.id } : {}) }], { sidebarOnly: true })
  }

  /**
   * The page's context bar asked for the editor's context (`ntwine:add-context`): the selection of the file
   * in front, or a whole file, into the composer it shows. It came from the sidebar, so it goes back there
   * or nowhere; and it carries the text as the editor has it NOW — nothing when the selection or the file
   * is gone by the time the click arrives.
   */
  async function addContextFromPage(message: EmbedAddContextMessage, into?: PageComposer): Promise<string> {
    let item: EditorComposeInput
    if (message.what === "problems" || message.what === "terminal") {
      const found = message.what === "problems" ? extras.problems() : await extras.terminal()
      if (!found.ok) {
        void api.window.showInformationMessage(found.why)
        return "nothing to add"
      }
      const project = windowProject()
      item = { path: message.what === "problems" ? EMBED_PROBLEMS_PATH : EMBED_TERMINAL_PATH, text: found.text, ...(project ? { projectId: project.id } : {}) }
    } else if (message.what === "selection") {
      // The editor the bar showed (the one in front, by the watcher's rule); a chip needs a file on disk.
      const editor = watcher.frontEditor()
      if (!editor || editor.document.uri.scheme !== "file" || editor.selection.isEmpty) return "nothing selected"
      const target = targetOf(editor.document.uri, editor)
      if (!target?.selection) return "nothing selected"
      hint.added()
      item = itemFor(target)
    } else {
      try {
        if (!(await stat(message.path!)).isFile()) return "missing"
      } catch {
        return "missing"
      }
      item = itemFor({ path: message.path! })
    }
    const input = { item: { ...item, app: api.env.appName }, target: "front" as const, focus: true }
    // A thread's tab asked: the chip goes back to its own page, which is in sight and focused already.
    if (into) {
      const answer = await into(input, SIDEBAR_COMPOSE_MS)
      return answer?.ok ? "composed" : "not taken"
    }
    // `preserveFocus`: the human clicked the bar, so the view is in sight and focused already; revealing it
    // again re-focused the view after the page had put the caret in its box, and the caret was lost
    // (scripts/e2e-sidebar.ts, 1 run in 3).
    const composed = await composeInSidebar(input, true)
    return composed ? "composed" : "not taken"
  }

  /**
   * A thread's changes, by name: Ntwine says which checkouts it wrote in (`reviewTarget`), this window opens
   * them. What went wrong is said here — the human is in the editor — and returned for the record.
   */
  async function reviewThread(project: EditorProject, slug: string, title?: string): Promise<string> {
    const origin = connection.origin ?? found?.origin
    if (!origin) {
      showNotConnected()
      return "not connected"
    }
    let target
    try {
      target = await new NtwineRpc(origin).query(project.id, "reviewTarget", { slug, ...(title ? { title } : {}) })
    } catch (error) {
      log.warn(`Reading ${slug}'s changes failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(`Couldn't review the changes: ${describeRpcError(error)}`)
      return "refused"
    }
    const result = await reviews.open(target)
    if (!result.ok) void api.window.showInformationMessage(result.error ?? "There are no changes to review.")
    return result.ok ? "opened" : `nothing: ${result.error ?? ""}`
  }

  /** The sidebar's ⋯ Review changes (`ntwine:review`): the thread its page names, in this window. */
  async function reviewFromPage(message: EmbedReviewMessage): Promise<string> {
    const project = projects.find((candidate) => candidate.slug === message.project) ?? projects.find((candidate) => candidate.id === message.project)
    if (!project) {
      void api.window.showErrorMessage(`Ntwine has no project ${message.project}.`)
      return "unknown project"
    }
    return reviewThread(project, message.thread, message.title)
  }

  /**
   * Review a thread's changes… — from the palette: one of this window's project's threads, picked, or the
   * one a caller names (`{ thread }`, a keybinding or a test).
   */
  async function reviewCommand(...args: unknown[]): Promise<string | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    const { options } = splitArgs(args)
    const project = windowProject()
    if (!project) {
      void api.window.showInformationMessage("Open a folder that's an Ntwine project to review its threads' changes.")
      return undefined
    }
    let threads: PickerThread[]
    try {
      threads = pickerThreads((await new NtwineRpc(origin).query(project.id, "board")).threads)
    } catch (error) {
      void api.window.showErrorMessage(describeRpcError(error))
      return undefined
    }
    let thread: PickerThread | undefined
    if (typeof options.thread === "string") {
      thread = findThread(threads, options.thread)
      if (!thread) {
        void api.window.showErrorMessage(`No open thread named ${options.thread} in ${project.name}.`)
        return undefined
      }
    } else {
      if (!threads.length) {
        void api.window.showInformationMessage(`${project.name} has no open threads.`)
        return undefined
      }
      thread = (await api.window.showQuickPick(threads.map((candidate) => ({ ...threadItem(candidate), thread: candidate })), {
        title: "Review a thread's changes",
        placeHolder: `Pick a thread in ${project.name}`,
        matchOnDescription: true,
        matchOnDetail: true,
      }))?.thread
    }
    if (!thread) return undefined
    return reviewThread(project, thread.id, displayName(thread))
  }

  /**
   * A title-row button (or its ⋯ menu), or the same command from the palette: the view brought into sight
   * (opened, the first time) and focused, then the door posted to its page — New thread puts the caret in
   * the box, Jump opens the page's own ⌘K palette, Keyboard shortcuts the page's `?` sheet.
   */
  async function sidebarCommand(command: EmbedCommandMessage["command"]): Promise<boolean> {
    await sidebar.reveal(false)
    if ((await waitSidebarReady(SIDEBAR_READY_MS)) && (await sidebar.post({ type: "ntwine:command", command }))) return true
    log.warn(`The sidebar's page isn't ready, so ${command} did nothing.`)
    return false
  }

  /** Ctrl+L with nothing selected: the prompt box of the Ntwine used last (frontTab), else the sidebar's. */
  async function focusPrompt(): Promise<boolean> {
    const tab = frontTab()
    if (!tab) return sidebarCommand("prompt")
    await tab.reveal(false)
    if ((await tab.waitReady(SIDEBAR_READY_MS)) && (await tab.post({ type: "ntwine:command", command: "prompt" }))) return true
    log.warn("The thread's tab isn't ready, so going to its prompt box did nothing.")
    return false
  }

  function openNtwine(): void {
    // The page needs no editor connection: an Ntwine that answered discovery but refused the socket (an
    // older Ntwine, a version mismatch) still serves its page.
    const origin = connection.origin ?? found?.origin
    if (!origin) return showNotConnected()
    // What the sidebar shows, when it is in sight — a thread up in it opens as that thread — on this
    // window's own address for Ntwine (under a remote window the frame's is the forwarded one); else this
    // window's project.
    const shown = sidebar.href()
    const page = shown ? new URL(shown) : undefined
    openUrl(page ? new URL(`${page.pathname}${page.search}`, origin).toString() : projectUrl(origin, windowProject()))
  }

  context.subscriptions.push(
    api.commands.registerCommand("ntwine.ask", ask),
    api.commands.registerCommand("ntwine.sendToThread", sendToThread),
    api.commands.registerCommand("ntwine.addToPrompt", addToPrompt),
    api.commands.registerCommand("ntwine.addFileToPrompt", addFileToPrompt),
    api.commands.registerCommand("ntwine.addSelectionOrFile", addSelectionOrFile),
    api.commands.registerCommand("ntwine.addTerminalSelection", addTerminalSelection),
    api.commands.registerCommand("ntwine.addProblems", addProblems),
    api.commands.registerCommand("ntwine.addTerminalOutput", addTerminalOutput),
    api.commands.registerCommand(FIX_COMMAND, askToFix),
    api.commands.registerCommand("ntwine.sidebar.newThread", () => sidebarCommand("new-thread")),
    api.commands.registerCommand("ntwine.sidebar.queue", () => sidebarCommand("queue")),
    api.commands.registerCommand("ntwine.sidebar.jump", () => sidebarCommand("jump")),
    api.commands.registerCommand("ntwine.sidebar.settings", () => sidebarCommand("settings")),
    api.commands.registerCommand("ntwine.sidebar.shortcuts", () => sidebarCommand("shortcuts")),
    // Ctrl+L / ⌘L in the editor with nothing selected: Cursor's chord to its chat, here the prompt box of the
    // Ntwine used last — a thread's tab on screen, else the sidebar — revealed and focused, the caret at the
    // end of what it holds. Ctrl+L there comes back (embed.ts, thread-panel.ts).
    api.commands.registerCommand("ntwine.focusPrompt", () => focusPrompt()),
    api.commands.registerCommand("ntwine.openThreadInTab", openThreadInTab),
    // "Ask Ntwine to fix" on any problem in a file on disk, in every language. Offered only with the sidebar
    // on: without it the problem's message has nowhere to go, and a bare chip is Add to Ntwine prompt.
    api.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions(document, _range, codeContext) {
        if (!codeContext.diagnostics.length || !useSidebar()) return []
        if (codeContext.only && !codeContext.only.intersects(api.CodeActionKind.QuickFix)) return []
        const problems = codeContext.diagnostics.slice(0, MAX_FIXES)
        return problems.map((diagnostic) => {
          const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
          const problem: Problem = { message: diagnostic.message, ...(diagnostic.source ? { source: diagnostic.source } : {}), ...(code === undefined ? {} : { code }) }
          const action = new api.CodeAction(fixTitle(problem, problems.length > 1), api.CodeActionKind.QuickFix)
          action.diagnostics = [diagnostic]
          action.command = { command: FIX_COMMAND, title: action.title, arguments: [document.uri, diagnostic.range, problem] }
          return action
        })
      },
    }, { providedCodeActionKinds: [api.CodeActionKind.QuickFix] }),
    api.commands.registerCommand("ntwine.reviewThread", reviewCommand),
    api.commands.registerCommand("ntwine.open", openNtwine),
    api.commands.registerCommand("ntwine.showLog", () => log.show()),
    api.commands.registerCommand("ntwine.sidebar.reload", () => sidebar.reload()),
    api.commands.registerCommand("ntwine.reconnect", () => {
      log.info("Reconnecting.")
      connection.reconnect()
    }),
  )

  log.info(`Ntwine extension ${extensionVersion}${builtAt ? ` (built ${builtAt})` : ""} in ${api.env.appName} ${api.version}, window ${windowId}.`)
  connection.start()

  return {
    windowId,
    status: () => status,
    statusBar: () => ({ ...shown }),
    origin: () => connection.origin,
    discovered: () => found,
    projects: () => projects,
    sidebar: () => sidebar.snapshot(),
    editorContext: () => feed.last(),
    review: () => reviews.last(),
    editorExtras: () => extras.last(),
    build: extensionVersion,
    reloadOffered: () => offered?.label,
    selectionHint: () => hint.shown(),
    threadTabs: () => panels.snapshot(),
  }
}
