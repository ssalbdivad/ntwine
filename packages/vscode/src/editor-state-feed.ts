// THE EDITOR, REPORTED TO NTWINE FOR ITS AGENTS — reads what this window shows (the file in front, its
// selection and text, the tabs, the errors and warnings) and has the connection send it as the `editor`
// frame whenever it changes, so a worker's `mcp__ntwine__editor` always reads the current picture. The
// rules — what is carried, the caps, the order, the fitting — are pure, in editor-state.ts; this is the
// glue. Only `import type` from vscode, like app.ts.
//
// WHAT is in front, and whether its text may go, is editor-watcher.ts's (one rule, editor-front.ts), the
// same answer the sidebar's page feed gets — so the agent's tool, the context bar and the block a send
// carries cannot disagree. What stays here is the tool's own:
//   - THE CEILING, 32 Ki characters (EDITOR_STATE_MAX_SELECTION_TEXT), twice the page feed's: read once,
//     when an agent asks, rather than riding every message. A longer selection carries its start, flagged.
//   - THE CADENCE, 250ms of quiet: the frame also carries the diagnostics, which a language server
//     re-publishes on every keystroke, and what is on screen, which moves with every scroll; nobody watches
//     it change, so a drag or a burst of typing is one frame, not forty.
//
// When it sends: after DEBOUNCE_MS of quiet following any change of the editor in front, its selection,
// what is on screen, the tabs, a document's text or dirty state, or the diagnostics — and at once on a
// change of `ntwine.shareEditorState`. The connection sends it once more on every connect and drops a frame
// identical to the last it sent (connection.ts sendEditor).

import type * as vscode from "vscode"
import { EDITOR_STATE_MAX_SELECTION_TEXT, type EditorSnapshot } from "@ntwine/shared/editor-protocol"
import { documentPath, readableUri, selectedText } from "./editor-front.ts"
import { buildEditorSnapshot, unsharedSnapshot, type ActiveInput, type DiagnosticInput } from "./editor-state.ts"
import type { EditorWatcher } from "./editor-watcher.ts"

type Vscode = typeof vscode

const DEBOUNCE_MS = 250

export const SHARE_SETTING = "shareEditorState"

export interface EditorStateFeedHost {
  /** Send the current snapshot now (the connection pulls it through `snapshot()`). */
  send(): void
  /** Whether the human shares the editor with Ntwine (ntwine.shareEditorState). */
  shared(): boolean
}

export interface EditorStateFeed {
  /** What this window shows right now, as the `editor` frame (unfitted; the connection fits it). */
  snapshot(): EditorSnapshot
  /** The sharing setting changed: send at once. */
  sharingChanged(): void
}

export function registerEditorStateFeed(api: Vscode, context: vscode.ExtensionContext, watcher: EditorWatcher, host: EditorStateFeedHost): EditorStateFeed {
  let timer: NodeJS.Timeout | undefined

  function activeInput(): ActiveInput | undefined {
    const reading = watcher.front()
    if (!reading) return undefined
    const { editor, front } = reading
    const text = selectedText(editor, front, EDITOR_STATE_MAX_SELECTION_TEXT)
    return {
      path: front.path,
      untitled: front.untitled,
      languageId: front.languageId,
      dirty: front.dirty,
      lineCount: front.lineCount,
      cursor: front.cursor,
      ...(front.selection
        ? { selection: { start: front.selection.start, end: front.selection.end, ...(text === undefined ? {} : { text }), ...(front.selection.primaryChars > EDITOR_STATE_MAX_SELECTION_TEXT ? { more: true } : {}) } }
        : {}),
      ...(front.withheld ? { withheld: true } : {}),
      ...(front.visible ? { visible: front.visible } : {}),
    }
  }

  function diagnostics(): DiagnosticInput[] {
    const out: DiagnosticInput[] = []
    for (const [uri, list] of api.languages.getDiagnostics()) {
      if (!readableUri(uri)) continue
      const path = documentPath(uri)
      for (const each of list) {
        const severity = each.severity === api.DiagnosticSeverity.Error ? "error" : each.severity === api.DiagnosticSeverity.Warning ? "warning" : undefined
        if (!severity) continue
        const code = typeof each.code === "object" ? each.code.value : each.code
        out.push({ path, line: each.range.start.line, severity, message: each.message, ...(each.source ? { source: each.source } : {}), ...(code === undefined ? {} : { code }) })
      }
    }
    return out
  }

  function snapshot(): EditorSnapshot {
    if (!host.shared()) return unsharedSnapshot()
    return buildEditorSnapshot({ shared: true, active: activeInput(), open: watcher.tabs(), diagnostics: diagnostics() })
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      host.send()
    }, DEBOUNCE_MS)
  }

  // Every change the watcher reports is one the frame may show: a keystroke anywhere changes a tab's dirty
  // flag. What is on screen and the problems are this feed's alone.
  watcher.onChange(() => schedule())
  context.subscriptions.push(
    api.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (event.textEditor === watcher.frontEditor()) schedule()
    }),
    api.languages.onDidChangeDiagnostics(() => schedule()),
    { dispose: () => clearTimeout(timer) },
  )

  return {
    snapshot,
    sharingChanged() {
      clearTimeout(timer)
      timer = undefined
      host.send()
    },
  }
}
