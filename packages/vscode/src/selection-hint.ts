// THE SELECTION HINT — Cursor's quiet "⌘L to chat" beside a fresh selection, for ntwine: a line of faded
// text after the selection, `Ctrl+L to add to ntwine` (`⌘L` on a Mac), so the chord is discoverable where the
// human is already looking instead of only in a README and the `?` sheet. It is a text-editor decoration
// (`after.contentText`), not a widget: nothing to click, nothing that takes focus, nothing a screen reader
// announces on every selection, and it cannot cover code — it sits past the end of a line.
//
// WHEN it shows — every rule is a reason a hint there would lie, nag or flicker:
//   - a NON-EMPTY primary selection, in the ACTIVE text editor, on a file on disk, in a plain text tab:
//     `Ctrl+L` adds the primary selection of a file editor (app.ts addToPrompt) and refuses anything else
//     (an untitled buffer, a git revision), so the hint is only where the chord works.
//   - NOT in a diff (side-by-side, inline or the multi-file "Changes" view) — the tab in the editor's group
//     must be a plain `TabInputText` of that very file. A diff is where the human reviews, often an agent's
//     change ntwine itself opened; a line of ghost text after every selection there competes with the diff's
//     own inline decorations and reads as part of the change. The chord still works in a diff; it is only
//     not advertised there. Output panes, the debug console, settings JSON and notebooks fall out of the
//     file-on-disk rule already.
//   - NOT a select-all (the selection spans the whole document): Ctrl+A is a step toward copy, cut, format
//     or replace far more often than toward a question, the caret then sits on the file's last line where
//     the hint would land off screen anyway, and the human who means the whole file has Alt+K and Add file
//     to ntwine prompt.
//   - NOT a selection an extension set, or a jump made: VS Code reports both as `kind` Command (its
//     extension host maps the sources "api", "code.jump" and "code.navigation" to it, and nothing else).
//     ntwine's own file links select the lines they name (app.ts openFromNtwine), and a hint on a selection
//     the human did not make is noise. Keyboard, mouse, and the editor's own commands — expand selection,
//     Ctrl+D, a find match, which VS Code reports with no kind at all — all count.
//   - NOT a selection already added: after Ctrl+L (or any add of that selection) the hint has done its job,
//     until the selection changes.
//   - SETTLED: 250ms after the last change, cleared AT ONCE on any change, so a drag or a held Shift+Arrow
//     shows nothing until the hand stops, and nothing lags behind the caret.
//   - only while this window is CONNECTED to ntwine (the chord says "ntwine isn't running" otherwise), and
//     while `ntwine.selectionHint` is on. The window losing focus clears it; the next selection brings it.
//   - NOT in Cursor or Windsurf: each draws its own selection hint naming its own chat's chord, and in
//     Cursor that chord is the same Ctrl+L / ⌘L — two hints for one chord would leave the human guessing
//     which answers (README § Where the sidebar differs).
//
// WHERE: past the end of the selection's line nearest the caret — its last line when it was made
// downward, its first when made upward — where the eye already is. "Last line" follows the chip's own
// count (editor-context.ts lineSpan): a whole-line drag that ends at column 1 of the next line ends on the
// line BEFORE it, as the chip reads, so the hint never sits on a line that is not part of what it adds.
//
// WHICH chord: the one bound by default, Ctrl+L, or ⌘L where the window's UI runs on a Mac — which under a
// remote window is not the extension host's platform, so the sidebar's relay (which runs in the UI) says
// it when it can, and the extension host's own platform stands in until then.
//
// Pure rules first (selection-hint.test.ts runs them under plain node); the VS Code glue after, with only
// `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import { lineSpan, type Position } from "./editor-context.ts"

type Vscode = typeof vscode

/** How long a selection must hold still before the hint shows — a drag settles, a held Shift+Arrow stops. */
export const HINT_SETTLE_MS = 250

/** The hint's words, with the chord in effect on the platform the window's UI runs on. */
export function hintText(mac: boolean): string {
  return `${mac ? "⌘L" : "Ctrl+L"} to add to ntwine`
}

/** Editors that draw their own selection hint for their own chat — on the same chord, in Cursor's case. */
export function ownHintApp(appName: string): boolean {
  return /\b(cursor|windsurf)\b/iu.test(appName)
}

export interface SelectionLike {
  start: Position
  end: Position
  active: Position
  isEmpty: boolean
}

/**
 * The 0-based line the hint goes after: the line of the selection nearest the caret. Made downward, the
 * caret is the selection's end, and the line is the selection's last line by the chip's count (a selection
 * ending at column 1 ends on the line before); made upward, the caret is its start, on its first line.
 */
export function hintLine(selection: SelectionLike): number {
  const atEnd = selection.active.line === selection.end.line && selection.active.character === selection.end.character
  if (!atEnd) return selection.start.line
  return lineSpan(selection.start, selection.end).endLine - 1
}

/** The selection spans the whole document: a select-all, which gets no hint. */
export function wholeDocument(selection: SelectionLike, lineCount: number, lastLineLength: number): boolean {
  return selection.start.line === 0 && selection.start.character === 0 && selection.end.line >= lineCount - 1 && (selection.end.line > lineCount - 1 || selection.end.character >= lastLineLength)
}

/** A selection's identity, to tell "the one just added" from a new one. */
export function selectionKey(path: string, selection: Pick<SelectionLike, "start" | "end">): string {
  return `${path}\0${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}`
}

// ── the glue ─────────────────────────────────────────────────────────────────────────────────────────

export interface SelectionHintHost {
  /** The window is connected to an ntwine that can take the selection. */
  connected(): boolean
  /** The UI's platform when something running in it said so (the sidebar's relay), else undefined. */
  mac(): boolean | undefined
}

/** What the hint shows now, for the end-to-end suite: there is no API that reads a decoration back. */
export interface SelectionHintShown {
  path: string
  /** 1-based, as the editor's gutter numbers it. */
  line: number
  text: string
}

export interface SelectionHint {
  /** Something it depends on changed (the connection, the platform): look again. */
  refresh(): void
  /** The selection in front was just added to ntwine: hide the hint until the selection changes. */
  added(): void
  shown(): SelectionHintShown | undefined
}

export const HINT_SETTING = "selectionHint"

export function registerSelectionHint(api: Vscode, context: vscode.ExtensionContext, host: SelectionHintHost): SelectionHint {
  // One decoration type, created once, drawn as VS Code draws its OWN end-of-line annotation — the git
  // extension's inline blame (extensions/git, 1.140: `after` in `git.blame.editorDecorationForeground`,
  // which defaults to `editorInlayHint.foreground`, `margin: "0 0 0 50px"`): the same colour and the same
  // distance from the code, so the hint reads as the editor's kind of note and not as code. NOT
  // `editorGhostText`, which is an inline completion's colour — a hint drawn in it reads as a suggestion
  // Tab would accept. (The first cut used CodeLens's colour and 2.5em, about 35px; mirrored 2026-10-02.)
  // The text varies by platform, so it rides each decoration's own render options.
  const decoration = api.window.createTextEditorDecorationType({
    after: { color: new api.ThemeColor("editorInlayHint.foreground"), margin: "0 0 0 50px" },
    rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
  })
  context.subscriptions.push(decoration)
  const enabled = () => api.workspace.getConfiguration("ntwine").get<boolean>(HINT_SETTING, true)
  const suppressedApp = ownHintApp(api.env.appName)

  let timer: NodeJS.Timeout | undefined
  /** The editor the hint is drawn in, and what it says, while one is. */
  let on: { editor: vscode.TextEditor; shown: SelectionHintShown } | undefined
  /** The selection the human just added: no hint on it again. */
  let addedKey: string | undefined
  /**
   * Documents whose current selection an extension or a jump set (`kind` Command), not the human's hand —
   * per document, since a link opening a file fires the editor change and the selection in either order.
   */
  const byApi = new Set<string>()

  function clear(): void {
    clearTimeout(timer)
    timer = undefined
    if (!on) return
    on.editor.setDecorations(decoration, [])
    on = undefined
  }

  /** The plain text tab of this editor's document in its own group — not a diff, not a multi-file diff. */
  function plainTab(editor: vscode.TextEditor): boolean {
    const group = api.window.tabGroups.all.find((candidate) => candidate.viewColumn === editor.viewColumn) ?? api.window.tabGroups.activeTabGroup
    const input = group.activeTab?.input
    return input instanceof api.TabInputText && input.uri.toString() === editor.document.uri.toString()
  }

  function wanted(): { editor: vscode.TextEditor; line: number } | undefined {
    // Not `window.state.focused`: a selection made by hand is made in a focused window, and the window
    // losing focus clears the hint below; asking here only hid it where VS Code's own reading lags (a
    // window with no window manager, as under Xvfb, never says it is focused).
    if (suppressedApp || !enabled() || !host.connected()) return undefined
    const editor = api.window.activeTextEditor
    if (!editor || editor.document.uri.scheme !== "file" || byApi.has(editor.document.uri.toString())) return undefined
    const selection = editor.selection
    if (selection.isEmpty) return undefined
    if (selectionKey(editor.document.uri.fsPath, selection) === addedKey) return undefined
    const document = editor.document
    if (wholeDocument(selection, document.lineCount, document.lineAt(document.lineCount - 1).text.length)) return undefined
    if (!plainTab(editor)) return undefined
    return { editor, line: hintLine(selection) }
  }

  function show(): void {
    timer = undefined
    const want = wanted()
    if (!want) return clear()
    const { editor, line } = want
    const text = hintText(host.mac() ?? process.platform === "darwin")
    const end = editor.document.lineAt(line).range.end
    if (on && on.editor !== editor) on.editor.setDecorations(decoration, [])
    editor.setDecorations(decoration, [{ range: new api.Range(end, end), renderOptions: { after: { contentText: text } } }])
    on = { editor, shown: { path: editor.document.uri.fsPath, line: line + 1, text } }
  }

  /** Hide now, and show again once things hold still. */
  function settle(): void {
    clear()
    timer = setTimeout(show, HINT_SETTLE_MS)
  }

  context.subscriptions.push(
    api.window.onDidChangeTextEditorSelection((event) => {
      const uri = event.textEditor.document.uri.toString()
      if (event.kind === api.TextEditorSelectionChangeKind.Command) byApi.add(uri)
      else byApi.delete(uri)
      if (event.textEditor !== api.window.activeTextEditor) return
      const key = selectionKey(event.textEditor.document.uri.fsPath, event.textEditor.selection)
      if (key !== addedKey) addedKey = undefined
      settle()
    }),
    api.window.onDidChangeActiveTextEditor(() => settle()),
    api.workspace.onDidCloseTextDocument((document) => byApi.delete(document.uri.toString())),
    api.window.onDidChangeWindowState((state) => {
      if (!state.focused) clear()
    }),
    // A tab turned into a diff or back (the same file opened in "Open changes") without a selection change.
    api.window.tabGroups.onDidChangeTabs(() => {
      if (on) settle()
    }),
    // An edit under the selection replaces or moves it; the selection event that follows settles it again.
    api.workspace.onDidChangeTextDocument((event) => {
      if (on && event.document === on.editor.document) clear()
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`ntwine.${HINT_SETTING}`)) settle()
    }),
    { dispose: () => clearTimeout(timer) },
  )

  return {
    refresh() {
      if (on || wanted()) settle()
    },
    added() {
      const editor = api.window.activeTextEditor
      if (editor && !editor.selection.isEmpty) addedKey = selectionKey(editor.document.uri.fsPath, editor.selection)
      clear()
    },
    shown: () => on?.shown,
  }
}
