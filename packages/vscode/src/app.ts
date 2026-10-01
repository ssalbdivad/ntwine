// THE EXTENSION, wired to an editor window. `extension.ts` hands in the `vscode` module, so this file
// holds only `import type` from it — the logic it leans on (discovery, the socket, project matching,
// the message format, thread order) lives in vscode-free modules the unit tests run under plain node,
// and this is the glue the end-to-end harness (scripts/e2e.ts) drives inside a real VS Code.
//
// Copy follows the repo's rules: sentence case, what the human can do, never the machinery.

import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname } from "node:path"
import type * as vscode from "vscode"
import type { EditorComposeInput, EditorComposed, EditorOpen, EditorProject } from "@frizz/shared/editor-protocol"
import { EditorConnection, FocusRecency, type ConnectionStatus, type OpenResult } from "./connection.ts"
import { discoverFrizz, pageAddressNote, SOURCE_WORDS, type FoundFrizz } from "./discovery.ts"
import { composeInput, composeMessage, normalizeNewlines, refLabel, type FileRef, type Selected } from "./message.ts"
import { projectForPath, workspaceProjects } from "./projects.ts"
import { describeRpcError, dispatchProfile, FrizzRpc, withRetry } from "./rpc.ts"
import { notConnectedMessage, statusView } from "./status.ts"
import { findThread, pickerThreads, threadHandleOf, threadItem, displayTitle, type PickerThread } from "./threads.ts"
import { registerSidebar, SIDEBAR_VIEW, type Sidebar } from "./sidebar.ts"

type Vscode = typeof vscode

/** What `activate` returns — read by the end-to-end suite, since a status bar item's text cannot be queried. */
export interface FrizzExtensionApi {
  windowId: string
  status(): ConnectionStatus
  statusBar(): { text: string; tooltip: string; command: string }
  origin(): string | undefined
  /** Where the last discovery found Frizz, and how — set even when the editor connection was refused. */
  discovered(): FoundFrizz | undefined
  projects(): EditorProject[]
  /** SPIKE: the sidebar frame. */
  sidebar: Sidebar
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

/** What Ask gives for a selection it cannot place; Send to thread says the same rather than dropping it. */
const OPEN_A_FILE = "Open a file to ask Frizz about it."

export function activateFrizz(api: Vscode, context: vscode.ExtensionContext): FrizzExtensionApi {
  const log = api.window.createOutputChannel("Frizz", { log: true })
  context.subscriptions.push(log)
  const windowId = randomUUID()
  const extensionVersion = String((context.extension.packageJSON as { version?: unknown }).version ?? "")
  let projects: EditorProject[] = []
  let status: ConnectionStatus = { kind: "connecting" }

  const config = () => api.workspace.getConfiguration("frizz")
  const folders = () => (api.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath)
  const windowState = () => ({ folders: folders(), focused: api.window.state.focused, acceptsOpens: config().get<boolean>("openFileLinks", true) })
  const focus = new FocusRecency()
  focus.observe(api.window.state.focused)

  // ── status bar ───────────────────────────────────────────────────────────────────────────────────
  const item = api.window.createStatusBarItem("frizz.status", api.StatusBarAlignment.Right, 100)
  item.name = "Frizz"
  context.subscriptions.push(item)
  let shown = statusView(status, [])
  const renderStatus = () => {
    shown = statusView(status, workspaceProjects(folders(), projects))
    item.text = shown.text
    item.tooltip = shown.tooltip
    item.command = shown.command
    item.show()
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
  // Frizz falls back to the editor's own command line, which raises the window holding the folder.
  let raiseMissing = false
  const focusWindow = async (): Promise<boolean> => {
    try {
      await api.commands.executeCommand("workbench.action.focusWindow")
      return true
    } catch (error) {
      if (!raiseMissing) log.info(`${api.env.appName} ${api.version} can't bring its own window to the front (${(error as Error).message}); Frizz's file links still open here.`)
      raiseMissing = true
      return false
    }
  }

  let lastNotes: string | undefined
  /** The last discovery's answer: the origin a page opens on even when the editor connection was refused. */
  let found: FoundFrizz | undefined
  const connection = new EditorConnection({
    async discover() {
      const result = await discoverFrizz({ serverUrl: config().get<string>("serverUrl", "") })
      // Where it looked, in full the first time and whenever the answer changes; the same misses on
      // every retry are only for the debug level.
      const notes = result.notes.join("\n")
      for (const note of result.notes) (notes === lastNotes ? log.debug : log.info).call(log, `Looked for Frizz: ${note}`)
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
    open: (message) => openFromFrizz(message),
    async focus() {
      return (await focusWindow()) ? { ok: true } : { ok: false, error: `${api.env.appName} can't bring its window to the front.` }
    },
    projects(next) {
      projects = next
      renderStatus()
    },
    status(next) {
      status = next
      renderStatus()
    },
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line), error: (line) => log.error(line) },
  })
  context.subscriptions.push({ dispose: () => connection.stop() })

  async function openFromFrizz(message: EditorOpen): Promise<OpenResult> {
    let entry
    try {
      entry = await stat(message.path)
    } catch {
      return { ok: false, error: `${message.path} doesn't exist.` }
    }
    const uri = api.Uri.file(message.path)
    if (entry.isDirectory()) {
      await api.commands.executeCommand("revealInExplorer", uri)
      await focusWindow()
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

  // ── the window's own changes ─────────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    api.window.onDidChangeWindowState((state) => {
      focus.observe(state.focused)
      connection.sendState()
    }),
    api.workspace.onDidChangeWorkspaceFolders(() => {
      connection.sendState()
      renderStatus()
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("frizz.serverUrl")) connection.reconnect()
      else if (event.affectsConfiguration("frizz.openFileLinks")) connection.sendState()
    }),
  )

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
    return project ? `${origin}/?project=${encodeURIComponent(project.slug)}` : `${origin}/`
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

  /** The file a command is about: the resource it was invoked on, else the active editor's. */
  function targetOf(uri: vscode.Uri | undefined): Target | undefined {
    const editor = api.window.activeTextEditor
    const fromEditor = editor && (!uri || editor.document.uri.toString() === uri.toString()) ? editor : undefined
    if (fromEditor) {
      const document = fromEditor.document
      if (document.uri.scheme !== "file") return undefined
      const selection = fromEditor.selection
      if (selection.isEmpty) return { path: document.uri.fsPath, uri: document.uri, cursorLine: selection.active.line + 1 }
      const startLine = selection.start.line + 1
      // A selection that ends at column 0 of a line (a whole-line drag, shift+down) does not include it.
      const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1
      return { path: document.uri.fsPath, uri: document.uri, selection: { text: normalizeNewlines(document.getText(selection)), startLine, endLine } }
    }
    if (uri && uri.scheme === "file") return { path: uri.fsPath, uri }
    return undefined
  }

  /**
   * The project a file belongs to and how to show its path. A file no project's folder holds offers
   * Home instead (labelled for the command at hand), or opening Frizz's add-folder dialog on it.
   */
  async function place(target: Target, origin: string, homeLabel: string): Promise<{ project: EditorProject; ref: FileRef } | undefined> {
    const match = projectForPath(target.path, projects)
    const ref = (path: string, display: string): FileRef => ({ path, display, selection: target.selection, cursorLine: target.cursorLine })
    if (match) return { project: match.project, ref: ref(match.path, match.relative || match.path) }
    const home = projects.find((project) => project.home)
    const add = "Add folder to Frizz"
    const choice = await api.window.showWarningMessage(`${basename(target.path)} isn't in a Frizz project.`, ...(home ? [homeLabel] : []), add)
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

  const threadUrl = (origin: string, project: EditorProject, slug: string) =>
    `${origin}/all/${encodeURIComponent(project.slug)}/thread/${encodeURIComponent(slug)}`

  // ── commands ─────────────────────────────────────────────────────────────────────────────────────

  async function ask(...args: unknown[]): Promise<{ slug: string } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    const { uri, options } = splitArgs(args)
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage(OPEN_A_FILE)
      return undefined
    }
    const placed = await place(target, origin, "Ask in Home")
    if (!placed) return undefined
    const { project, ref } = placed
    const question = typeof options.question === "string"
      ? options.question
      : await api.window.showInputBox({
          title: "Ask Frizz",
          prompt: `Ask Frizz about ${refLabel(ref)}`,
          placeHolder: "What do you want to know or change?",
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : "Type a question for Frizz."),
        })
    if (question === undefined || !question.trim()) return undefined
    const rpc = new FrizzRpc(origin)
    try {
      const result = await api.window.withProgress({ location: api.ProgressLocation.Notification, title: "Asking Frizz…" }, async () => {
        // The operator's saved backend, model and effort, as the page's prompt box sends them: a
        // dispatch with no backend means Claude whatever the preference says.
        const preferences = await rpc.query(project.id, "dispatchPreferencesGet")
        // No retry: a dispatch that timed out may still have started its thread.
        return rpc.mutation(project.id, "dispatch", { prompt: composeMessage(question, ref), ...dispatchProfile(preferences) }, 60_000)
      })
      log.info(`Asked Frizz in ${project.name}: thread ${result.slug}.`)
      void api.window.showInformationMessage("Asked Frizz.", "Open thread").then((choice) => {
        if (choice) openUrl(threadUrl(origin, project, result.slug))
      })
      return { slug: result.slug }
    } catch (error) {
      log.error(`Asking Frizz failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(describeRpcError(error, "ask"))
      return undefined
    }
  }

  async function sendToThread(...args: unknown[]): Promise<{ slug: string; deliveryId: string } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
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
      void api.window.showInformationMessage("Open a file in a Frizz project to send it to a thread.")
      return undefined
    }
    const rpc = new FrizzRpc(origin)
    let threads: (PickerThread & { sessionId: string })[]
    try {
      threads = pickerThreads((await rpc.query(project.id, "board")).threads)
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
        void api.window.showInformationMessage(`${project.name} has no open threads. Ask Frizz to start one.`)
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

  async function addToPrompt(...args: unknown[]): Promise<EditorComposed | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    const { uri } = splitArgs(args)
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage("Open a file to add it to Frizz's prompt box.")
      return undefined
    }
    const match = projectForPath(target.path, projects)
    const item: EditorComposeInput = composeInput({ ...target, path: match?.path ?? target.path, projectId: match?.project.id })
    const composed = await connection.compose(item)
    if (composed.ok) {
      api.window.setStatusBarMessage("Added to Frizz's prompt box", 4_000)
      void api.window.showInformationMessage("Added to Frizz's prompt box.", "Open Frizz").then((choice) => {
        if (choice) openUrl(projectUrl(origin, match?.project ?? windowProject()))
      })
    } else {
      log.warn(`Adding to the prompt box failed: ${composed.error ?? "no reason given"}`)
      void api.window.showErrorMessage(`Couldn't add to Frizz's prompt box: ${composed.error ?? "Frizz refused it."}`)
    }
    return composed
  }

  function openFrizz(): void {
    // The page needs no editor connection: a Frizz that answered discovery but refused the socket (an
    // older Frizz, a version mismatch) still serves its page.
    const origin = connection.origin ?? found?.origin
    if (origin) openUrl(projectUrl(origin, windowProject()))
    else showNotConnected()
  }

  context.subscriptions.push(
    api.commands.registerCommand("frizz.ask", ask),
    api.commands.registerCommand("frizz.sendToThread", sendToThread),
    api.commands.registerCommand("frizz.addToPrompt", addToPrompt),
    api.commands.registerCommand("frizz.open", openFrizz),
    api.commands.registerCommand("frizz.showLog", () => log.show()),
    api.commands.registerCommand("frizz.reconnect", () => {
      log.info("Reconnecting.")
      connection.reconnect()
    }),
  )

  // SPIKE: the sidebar frame, on the window's project once the connection knows it.
  const sidebar = registerSidebar(api, context, () => {
    const origin = connection.origin ?? found?.origin
    return origin ? projectUrl(origin, windowProject()) : undefined
  }, (line) => log.info(line))
  context.subscriptions.push(
    api.commands.registerCommand("frizz.sidebar.navigate", (url: string) => sidebar.navigate(url)),
    api.commands.registerCommand("frizz.sidebar.show", () => api.commands.executeCommand(`${SIDEBAR_VIEW}.focus`)),
  )

  log.info(`Frizz extension ${extensionVersion} in ${api.env.appName}, window ${windowId}.`)
  connection.start()

  return {
    windowId,
    status: () => status,
    statusBar: () => ({ ...shown }),
    origin: () => connection.origin,
    discovered: () => found,
    projects: () => projects,
    sidebar,
  }
}
