// THE EDITOR, AS THE SIDEBAR SEES IT — the pure half of what the extension tells the Ntwine sidebar about
// the editor around it (`ntwine:editor-context`: the file in front, its selection with the selection's text
// or else the caret's line, the other open files) and of the ways a piece of the editor gets into the
// sidebar's prompt (a problem's quick fix, a terminal selection). No `vscode` here, so every rule is a
// unit test under plain node (editor-context.test.ts); context-feed.ts and app.ts are the glue. Design:
// ARCHITECTURE.md § VS Code extension; the wire: packages/shared/src/embed-protocol.ts.

import { basename, isAbsolute } from "node:path"
import { EDITOR_MAX_PATH } from "@ntwine/shared/editor-protocol"
import { EMBED_MAX_NOTE, EMBED_MAX_OPEN_FILES, EMBED_MAX_SELECTION_TEXT, type EmbedEditorContextMessage, type EmbedEditorFile, type EmbedEditorSelection } from "@ntwine/shared/embed-protocol"
import type { EditorFront } from "./editor-front.ts"
import { composable, normalizeNewlines } from "./message.ts"

/** A position as VS Code holds one: 0-based line and character. */
export interface Position {
  line: number
  character: number
}

/**
 * The 1-based, inclusive lines a range covers, as the chip it would make reads them. A range that ends at
 * column 1 of a line — a whole-line drag, shift+down — does not include that line: the caret sits at its
 * start and nothing of it is selected. The context bar, "Add to Ntwine prompt" and the quick fix all count
 * lines with this, so the bar never promises a range the chip then disagrees with.
 */
export function lineSpan(start: Position, end: Position): { startLine: number; endLine: number } {
  const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1
  return { startLine: start.line + 1, endLine }
}

/**
 * What the context bar says is selected, and what a send from the sidebar carries: the PRIMARY selection's
 * lines — the one a chip would carry — and its text, and the characters selected across every selection
 * (multi-cursor counts each). Undefined when the primary selection is empty: a caret is not a selection,
 * and the bar then names the file alone. `chars` is the editor's own count (offset of the end less offset
 * of the start).
 *
 * `read` gives the primary selection's text, and is asked only when the primary's own count is within
 * EMBED_MAX_SELECTION_TEXT — a select-all on a large file is never read on every caret move just to be
 * thrown away. Newlines are normalized to `\n` (the page's quote splits on it); a CRLF file can therefore
 * come in under the ceiling after its count did not, and goes as its lines alone, which is the safe side.
 */
export function editorSelection(selections: readonly { start: Position; end: Position; chars: number }[], read?: () => string): EmbedEditorSelection | undefined {
  const primary = selections[0]
  if (!primary || primary.chars <= 0) return undefined
  const chars = selections.reduce((sum, selection) => sum + Math.max(0, selection.chars), 0)
  const text = read && primary.chars <= EMBED_MAX_SELECTION_TEXT ? normalizeNewlines(read()) : undefined
  return { ...lineSpan(primary.start, primary.end), chars, ...(text !== undefined && text.length <= EMBED_MAX_SELECTION_TEXT ? { text } : {}) }
}

/**
 * The label the bar shows for a file: `workspace.asRelativePath`'s answer, or the basename when that is
 * not relative — asRelativePath hands its input back unchanged for a file no workspace folder holds. Never
 * empty (the page refuses an empty label, and with it the whole message).
 */
export function fileLabel(path: string, relative: string): string {
  if (!relative || relative === path || isAbsolute(relative) || /^[A-Za-z]:[\\/]/u.test(relative)) return basename(path) || path
  return relative
}

/**
 * Which files were in front most recently. VS Code's tab model has no activation order — `tabGroups`
 * lists tabs left to right — so the extension keeps its own: every time a file becomes the active editor
 * it moves to the front. A file never seen in front (open since before activation, in a group never
 * focused) sorts after every seen one, in tab order.
 */
export class Recency {
  readonly #order: string[] = []

  constructor(readonly limit = 500) {}

  touch(path: string): void {
    const at = this.#order.indexOf(path)
    if (at === 0) return
    if (at > 0) this.#order.splice(at, 1)
    this.#order.unshift(path)
    if (this.#order.length > this.limit) this.#order.length = this.limit
  }

  /** `paths` most recently in front first; stable among the never-seen. */
  sort(paths: readonly string[]): string[] {
    const rank = (path: string) => {
      const at = this.#order.indexOf(path)
      return at === -1 ? Number.MAX_SAFE_INTEGER : at
    }
    return paths.map((path, index) => ({ path, index, rank: rank(path) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ path }) => path)
  }
}

/** A path the page can take: present, and within the editor wire's ceiling (the page refuses the whole message over one that is not). */
const sendable = (path: string) => path.length > 0 && path.length <= EDITOR_MAX_PATH

/**
 * The OTHER files open in tabs, as the bar lists them: each file once however many groups show it, never
 * the file in front, most recently in front first, at most EMBED_MAX_OPEN_FILES — chosen BEFORE each is
 * described (matched to a project, labelled), which is the expensive part with fifty tabs open.
 */
export function openFiles(tabs: readonly string[], active: string | undefined, recency: Recency): string[] {
  const seen = new Set<string>(active === undefined ? [] : [active])
  const unique: string[] = []
  for (const path of tabs) {
    if (seen.has(path) || !sendable(path)) continue
    seen.add(path)
    unique.push(path)
  }
  return recency.sort(unique).slice(0, EMBED_MAX_OPEN_FILES)
}

/**
 * The file in front as the page is told it (editor-front.ts reads it; this shapes it): the selection's
 * lines, every selection's characters and — when `read` is given, the primary's characters are within the
 * feed's ceiling and the text is not withheld — its text; else the caret's line. Plus what the block must
 * say about the copy on disk: an untitled buffer has none, a dirty one differs. `read` is the glue's to
 * withhold: it passes none while the human does not share the editor (ntwine.shareEditorState).
 */
export function pageActive(front: EditorFront, file: EmbedEditorFile, read: (() => string) | undefined): NonNullable<EmbedEditorContextMessage["active"]> {
  const flags = { ...(front.untitled ? { untitled: true as const } : {}), ...(front.dirty ? { dirty: true as const } : {}), ...(front.withheld ? { withheld: true as const } : {}) }
  const sel = front.selection
  const selection = sel ? editorSelection([{ start: sel.start, end: sel.end, chars: sel.primaryChars }], front.withheld ? undefined : read) : undefined
  if (!sel || !selection) return { ...file, cursorLine: front.cursor.line + 1, ...flags }
  return { ...file, selection: { ...selection, chars: sel.chars }, ...flags }
}

/**
 * The message, with every file in the contract's shape: a label clipped to the ceiling, a projectId only
 * when one matched, the selection's own fields and no others (its text only within the ceiling, and never
 * from a withheld file), the caret's line only where nothing is selected, and the flags only when set.
 */
export function editorContextMessage(active: EmbedEditorContextMessage["active"], open: readonly EmbedEditorFile[]): EmbedEditorContextMessage {
  const file = ({ path, label, projectId }: EmbedEditorFile): EmbedEditorFile => ({ path, label: label.slice(0, EDITOR_MAX_PATH), ...(projectId ? { projectId } : {}) })
  const selection = ({ startLine, endLine, chars, text }: EmbedEditorSelection, withheld: boolean): EmbedEditorSelection =>
    ({ startLine, endLine, chars, ...(text !== undefined && !withheld && text.length <= EMBED_MAX_SELECTION_TEXT ? { text } : {}) })
  const where = (entry: NonNullable<EmbedEditorContextMessage["active"]>) =>
    entry.selection ? { selection: selection(entry.selection, entry.withheld === true) } : entry.cursorLine !== undefined && entry.cursorLine >= 1 ? { cursorLine: entry.cursorLine } : {}
  const flags = (entry: NonNullable<EmbedEditorContextMessage["active"]>) =>
    ({ ...(entry.untitled ? { untitled: true as const } : {}), ...(entry.dirty ? { dirty: true as const } : {}), ...(entry.withheld ? { withheld: true as const } : {}) })
  return {
    type: "ntwine:editor-context",
    active: active && sendable(active.path) ? { ...file(active), ...where(active), ...flags(active) } : null,
    open: open.filter((entry) => sendable(entry.path)).slice(0, EMBED_MAX_OPEN_FILES).map(file),
  }
}

// ── "Ask Ntwine to fix" ─────────────────────────────────────────────────────────────────────────────

/** What a quick fix knows of a problem (vscode.Diagnostic, with `code` as the API spells it). */
export interface Problem {
  message: string
  source?: string
  code?: string | number | { value: string | number }
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim()

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * The prose after the chip: `Fix: Cannot find name 'foo'. ts(2304)` — the problem as the Problems panel
 * spells it (message, then `source(code)`), so the box reads as a request the human can send as is or
 * edit. A missing source or code is left out rather than written empty; one line, at most EMBED_MAX_NOTE.
 */
export function fixNote(problem: Problem): string {
  const code = typeof problem.code === "object" ? problem.code.value : problem.code
  const source = problem.source ? oneLine(problem.source) : ""
  const tag = code === undefined || code === "" ? source : `${source}(${oneLine(String(code))})`
  return clip(oneLine(["Fix:", oneLine(problem.message), tag].filter(Boolean).join(" ")), EMBED_MAX_NOTE)
}

/**
 * The quick fix's title. One problem under the caret is "Ask Ntwine to fix"; several each get their own
 * entry, told apart by the start of their message — a list of identical titles would make the human
 * guess which problem each one sends.
 */
export function fixTitle(problem: Problem, several: boolean): string {
  return several ? `Ask Ntwine to fix: ${clip(oneLine(problem.message), 60)}` : "Ask Ntwine to fix"
}

// ── the terminal ───────────────────────────────────────────────────────────────────────────────────

/**
 * A terminal selection as a compose item's text, or why it cannot be one. A file selection too large to
 * carry still has a place to point at (a range reference); a terminal's has nowhere, so past the same
 * ceilings as a file's quote — QUOTE_MAX_LINES, QUOTE_MAX_BYTES, the frame — it is refused, with copy
 * that says what to do.
 */
export function terminalText(raw: string): { ok: true; text: string } | { ok: false; why: string } {
  const text = normalizeNewlines(raw).replace(/\s+$/u, "")
  if (!text.trim()) return { ok: false, why: "Select text in the terminal to add it to Ntwine's prompt box." }
  const lines = text.split("\n").length
  if (!composable({ text, startLine: 1, endLine: lines })) return { ok: false, why: "That terminal selection is too long to add. Select less of it." }
  return { ok: true, text }
}
