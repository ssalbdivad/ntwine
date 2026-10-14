// THE EDITOR'S LIVE CONTEXT, FED TO THE SIDEBAR — `ntwine:editor-context` (packages/shared/src/
// embed-protocol.ts): the text editor in front, its selection with the primary selection's text (or the
// caret's line, with nothing selected), whether it is unsaved or untitled, and the other files open in
// tabs, posted to the sidebar's page whenever it is ready and they change. The page's context bar shows
// it, and a message sent from the sidebar carries the selection, or the file and line, while the human
// shares the editor (ntwine.shareEditorState, the bar's eye; packages/web/src/lib/editorContext.ts
// outgoingMessage). The text is in the feed rather than fetched at send so Enter sends at once.
//
// WHAT is in front is not this file's to decide: editor-watcher.ts holds the one rule (editor-front.ts),
// which the agents' feed (editor-state-feed.ts) reads too, so the bar, the block and the tool agree. What
// stays here is the page's own shape (labels, projects, the caps in editor-context.ts) and two things that
// are genuinely the page's:
//   - THE CEILING, 16 Ki characters of text (EMBED_MAX_SELECTION_TEXT), half the tool's 32 Ki: this text
//     rides EVERY send from the sidebar and is re-posted on every settled selection change whether or not
//     the human sends anything, while the tool's is read once, when an agent asks. embed-protocol.ts has
//     the full reasoning.
//   - THE CADENCE, 100ms of quiet, against the tool's 250ms: this feed drives a bar the human is watching
//     as they select, which must keep up with the hand; the tool's frame also carries the diagnostics a
//     language server re-publishes on every keystroke, and nobody watches it.
//
// When it sends: once the moment the page says it is ready (a reloaded page knows nothing), and again on
// a change of the editor in front, its selection or caret line, the selected text itself (an edit under a
// held selection: the agent working on that file), its dirty flag (the first keystroke, a save), the tab
// set, or the sharing setting. A payload identical to the last one sent is not sent again — typing on one
// line changes nothing the feed says — and nothing is sent while no page is ready.
//
// Sharing off, the selection's TEXT stays home (the lines are still named, so the bar can show them and a
// click can still add them on purpose); a withheld file's text never leaves (editor-front.ts secretFile).
//
// Only `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import type { EditorProject } from "@ntwine/shared/editor-protocol"
import type { EmbedEditorContextMessage, EmbedEditorFile } from "@ntwine/shared/embed-protocol"
import { EMBED_MAX_SELECTION_TEXT } from "@ntwine/shared/embed-protocol"
import { editorContextMessage, fileLabel, openFiles, pageActive, Recency } from "./editor-context.ts"
import { selectedText } from "./editor-front.ts"
import type { EditorWatcher } from "./editor-watcher.ts"
import { projectForPath } from "./projects.ts"

type Vscode = typeof vscode

const DEBOUNCE_MS = 100

export interface ContextFeedHost {
  ready(): boolean
  /** Fires when the sidebar's page becomes ready (true) or stops being (false). */
  onReady(listener: (ready: boolean) => void): void
  post(message: EmbedEditorContextMessage): Promise<boolean>
  projects(): readonly EditorProject[]
  /** Whether the human shares the editor with ntwine (ntwine.shareEditorState). */
  shared(): boolean
}

export interface ContextFeed {
  /** The projects or the sharing setting changed: rebuild. */
  refresh(): void
  /** The last message the page was sent, for the end-to-end suite. */
  last(): EmbedEditorContextMessage | undefined
}

export function registerContextFeed(api: Vscode, context: vscode.ExtensionContext, watcher: EditorWatcher, host: ContextFeedHost): ContextFeed {
  /** fsPath → how it is shown: matching a file to a project reads its real path, so once per file per project list. */
  const described = new Map<string, EmbedEditorFile>()
  let timer: NodeJS.Timeout | undefined
  let lastKey: string | undefined
  let last: EmbedEditorContextMessage | undefined

  function describe(path: string, untitled = false): EmbedEditorFile {
    // An untitled buffer has no file to match or relativize: its label is its name.
    if (untitled) return { path, label: path }
    let file = described.get(path)
    if (!file) {
      const match = projectForPath(path, host.projects())
      // The spelling that matched the project, as a compose item's path is: the server's own.
      file = { path: match?.path ?? path, label: fileLabel(path, api.workspace.asRelativePath(api.Uri.file(path))), ...(match ? { projectId: match.project.id } : {}) }
      described.set(path, file)
    }
    return file
  }

  function build(): EmbedEditorContextMessage {
    const reading = watcher.front()
    let active: EmbedEditorContextMessage["active"] = null
    if (reading) {
      const { editor, front } = reading
      const read = host.shared() ? () => selectedText(editor, front, EMBED_MAX_SELECTION_TEXT) ?? "" : undefined
      active = pageActive(front, describe(front.path, front.untitled), read)
    }
    // The other tabs: files on disk only — an untitled buffer cannot be added as a whole file.
    const tabs = watcher.tabs().filter((tab) => !tab.untitled).map((tab) => tab.path)
    // Already most recent first: an empty Recency keeps the order it is given (openFiles still drops the
    // file in front, dedupes and caps before anything is described).
    return editorContextMessage(active, openFiles(tabs, reading?.front.path, new Recency()).map((path) => describe(path)))
  }

  async function send(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (!host.ready()) return
    const message = build()
    const key = JSON.stringify(message)
    if (key === lastKey) return
    lastKey = key
    if (await host.post(message)) last = message
    else lastKey = undefined
  }

  function schedule(): void {
    if (!host.ready()) return
    clearTimeout(timer)
    timer = setTimeout(() => void send(), DEBOUNCE_MS)
  }

  host.onReady((ready) => {
    lastKey = undefined
    if (ready) void send()
    else clearTimeout(timer)
  })

  watcher.onChange((change) => {
    // Typing in another document changes nothing this feed says; in the one in front it can flip its
    // dirty flag or change the selected text, which the dedupe sorts from a keystroke that changes neither.
    if (change.kind === "text" && !change.front) return
    if (change.kind === "folders") described.clear()
    schedule()
  })
  context.subscriptions.push({ dispose: () => clearTimeout(timer) })

  return {
    refresh() {
      described.clear()
      schedule()
    },
    last: () => last,
  }
}

