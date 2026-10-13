// THE EDITOR, AS AN AGENT READS IT — the pure half of the `editor` frame (packages/shared/src/
// editor-protocol.ts EditorSnapshot): the file in front with its selection and the selected text, the
// other open tabs, and the editor's errors and warnings, built from plain inputs and FITTED to what Ntwine
// takes. A worker reads it through `mcp__ntwine__editor`, the way Claude Code's own agent reads its IDE
// (getCurrentSelection, getOpenEditors, getDiagnostics). editor-state-feed.ts reads the inputs out of
// VS Code; connection.ts sends the result. No `vscode` here, so every rule is a unit test under plain
// node (editor-state.test.ts).
//
// Two rules carry the weight:
//   - NOTHING GOES OUT THAT NTWINE WILL REFUSE. A refused frame closes the socket 4401, and the same frame
//     is refused again on every redial — forever, for as long as the human keeps that selection. So every
//     count and length is capped here to the server's schema, and the whole frame is fitted into
//     EDITOR_STATE_MAX_BYTES encoded, trimming in the order that loses the least: the diagnostics from the
//     end (the other files' warnings go first), then the open tabs from the end (the least recent), and only
//     then the selected text, from its end, flagged `truncated`.
//   - THE ORDER IS THE PRIORITY. The diagnostics are every error before any warning, and within each the
//     file in front first — so a file with two hundred lint warnings cannot push an error elsewhere out of
//     the hundred that fit.

import {
  EDITOR_MAX_PATH,
  EDITOR_STATE_MAX_BYTES,
  EDITOR_STATE_MAX_DIAGNOSTICS,
  EDITOR_STATE_MAX_MESSAGE,
  EDITOR_STATE_MAX_OPEN,
  EDITOR_STATE_MAX_SELECTION_TEXT,
  EDITOR_STATE_MAX_TAG,
  type EditorActiveFile,
  type EditorDiagnostic,
  type EditorOpenFile,
  type EditorSnapshot,
} from "@ntwine/shared/editor-protocol"
import { lineSpan, type Position } from "./editor-context.ts"
import { normalizeNewlines } from "./message.ts"

/** The file in front, as the feed reads it out of VS Code. Lines are 0-based here, as VS Code's are. */
export interface ActiveInput {
  path: string
  untitled: boolean
  languageId: string
  dirty: boolean
  lineCount: number
  /** The caret: the primary selection's moving end. */
  cursor: Position
  /**
   * The primary selection, when it is not empty, with its text as the document has it — read only as far as
   * the frame can carry (editor-front.ts selectedText), so `more` says the document has more of it. No text
   * when it is withheld.
   */
  selection?: { start: Position; end: Position; text?: string; more?: boolean }
  /** The file may hold secrets (editor-front.ts secretFile, or VS Code excludes it): its selection goes without text. */
  withheld?: boolean
  /** The first and last line on screen (0-based); absent when the editor reports no visible range. */
  visible?: { start: number; end: number }
}

export interface DiagnosticInput {
  path: string
  /** 0-based, as VS Code's ranges are. */
  line: number
  severity: "error" | "warning"
  message: string
  source?: string
  code?: string | number
}

export interface SnapshotInputs {
  /** The window's `ntwine.shareEditorState`. Off: nothing but `shared: false` goes out. */
  shared: boolean
  active: ActiveInput | undefined
  /** Every file open in a tab, in the order the feed ranks them (most recently in front first). */
  open: readonly { path: string; untitled: boolean; dirty: boolean }[]
  /** Every error and warning the editor has, in any order; only file and untitled documents' ones. */
  diagnostics: readonly DiagnosticInput[]
}

/** The frame for a window that does not share its editor: it tells Ntwine to forget what it had. */
export function unsharedSnapshot(): EditorSnapshot {
  return { t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } }
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim()

/** At most `max` UTF-16 units, never ending on half a surrogate pair (which would encode as a lone escape). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = /[\uD800-\uDBFF]/u.test(text[max - 1] ?? "") ? max - 1 : max
  return text.slice(0, end)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, max - 1).trimEnd()}…`
}

const sendable = (path: string) => path.length > 0 && path.length <= EDITOR_MAX_PATH
const line1 = (line: number) => Math.min(10_000_000, Math.max(1, Math.floor(line) + 1))

function activeFile(input: ActiveInput): EditorActiveFile {
  const lineCount = Math.min(10_000_000, Math.max(0, Math.floor(input.lineCount)))
  const cursorLine = line1(input.cursor.line)
  const visibleStart = input.visible ? line1(input.visible.start) : cursorLine
  const visibleEnd = input.visible ? Math.max(visibleStart, line1(input.visible.end)) : cursorLine
  const active: EditorActiveFile = {
    path: input.path,
    ...(input.untitled ? { untitled: true as const } : {}),
    languageId: input.languageId.slice(0, EDITOR_STATE_MAX_TAG),
    dirty: input.dirty,
    lineCount,
    cursorLine,
    visible: { startLine: visibleStart, endLine: visibleEnd },
  }
  if (input.selection) {
    // The chip's line rule (a drag that ends at column 1 does not include that line), so what an agent
    // reads as "lines 12-20" is what the human's chip of the same selection would say.
    const { startLine, endLine } = lineSpan(input.selection.start, input.selection.end)
    const lines = { startLine: line1(startLine - 1), endLine: Math.max(line1(startLine - 1), line1(endLine - 1)) }
    if (input.withheld || input.selection.text === undefined) {
      // Named, never quoted: the agent learns where the human is looking, not what the file holds.
      active.selection = { ...lines, ...(input.withheld ? { withheld: true as const } : { truncated: true as const }) }
    } else {
      const text = normalizeNewlines(input.selection.text)
      const carried = cut(text, EDITOR_STATE_MAX_SELECTION_TEXT)
      active.selection = { ...lines, text: carried, ...(carried.length < text.length || input.selection.more ? { truncated: true as const } : {}) }
    }
  }
  return active
}

function diagnostic(input: DiagnosticInput): EditorDiagnostic {
  const source = input.source ? oneLine(input.source).slice(0, EDITOR_STATE_MAX_TAG) : ""
  const code = input.code === undefined ? "" : oneLine(String(input.code)).slice(0, EDITOR_STATE_MAX_TAG)
  return {
    path: input.path,
    line: line1(input.line),
    severity: input.severity,
    message: clip(oneLine(input.message), EDITOR_STATE_MAX_MESSAGE),
    ...(source ? { source } : {}),
    ...(code ? { code } : {}),
  }
}

/**
 * The frame, capped to the server's schema (but not yet fitted to its byte ceiling: fitEditorSnapshot).
 * The file in front is left out of the open tabs; a path longer than Ntwine takes is left out wherever it
 * appears — the file in front included, which then reads as no file at all rather than get the frame refused.
 */
export function buildEditorSnapshot(inputs: SnapshotInputs): EditorSnapshot {
  if (!inputs.shared) return unsharedSnapshot()
  const active = inputs.active && sendable(inputs.active.path) ? activeFile(inputs.active) : null
  const seen = new Set<string>(active ? [active.path] : [])
  const open: EditorOpenFile[] = []
  for (const file of inputs.open) {
    if (open.length >= EDITOR_STATE_MAX_OPEN) break
    if (seen.has(file.path) || !sendable(file.path)) continue
    seen.add(file.path)
    open.push({ path: file.path, ...(file.untitled ? { untitled: true as const } : {}), ...(file.dirty ? { dirty: true as const } : {}) })
  }
  let errors = 0
  let warnings = 0
  for (const each of inputs.diagnostics) each.severity === "error" ? errors++ : warnings++
  // Errors before warnings, the file in front first within each, and otherwise the editor's own order.
  const rank = (each: DiagnosticInput) => (each.severity === "error" ? 0 : 2) + (active && each.path === active.path ? 0 : 1)
  const diagnostics = inputs.diagnostics
    .map((each, index) => ({ each, index, rank: rank(each) }))
    .filter(({ each }) => sendable(each.path))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, EDITOR_STATE_MAX_DIAGNOSTICS)
    .map(({ each }) => diagnostic(each))
  return { t: "editor", shared: true, active, open, diagnostics, problems: { errors, warnings } }
}

/** Bytes `value` takes JSON-encoded, as the socket carries it. */
export const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

/** The longest leading run of `items` whose encoded sizes (and a separator each) fit `room` bytes. */
function prefixWithin<T>(items: readonly T[], room: number): T[] {
  let used = 0
  let count = 0
  for (const item of items) {
    used += encodedBytes(item) + 1
    if (used > room) break
    count++
  }
  return items.slice(0, count)
}

/**
 * The frame within `maxBytes` encoded (EDITOR_STATE_MAX_BYTES, below the server's 64 KiB frame ceiling).
 * Trims the diagnostics from the end, then the open tabs from the end, then the selected text from its end
 * (flagged `truncated`; dropped entirely only if not one character fits), and as a last resort — a frame
 * that still does not fit, which only absurd paths could make — sends the problem counts alone. A frame
 * already within the ceiling comes back as it is.
 */
export function fitEditorSnapshot(snapshot: EditorSnapshot, maxBytes = EDITOR_STATE_MAX_BYTES): EditorSnapshot {
  if (encodedBytes(snapshot) <= maxBytes) return snapshot
  let fitted: EditorSnapshot = { ...snapshot, diagnostics: prefixWithin(snapshot.diagnostics, maxBytes - encodedBytes({ ...snapshot, diagnostics: [] })) }
  if (encodedBytes(fitted) <= maxBytes) return fitted
  fitted = { ...fitted, open: prefixWithin(snapshot.open, maxBytes - encodedBytes({ ...fitted, open: [] })) }
  if (encodedBytes(fitted) <= maxBytes) return fitted
  const active = fitted.active
  const selection = active?.selection
  if (active && selection?.text !== undefined) {
    const { text } = selection
    const shell: EditorSnapshot = { ...fitted, active: { ...active, selection: { ...selection, text: "", truncated: true } } }
    // The room the text's own characters may take: the frame with an empty text already counts its quotes.
    const room = maxBytes - encodedBytes(shell)
    if (room >= 0) {
      // The longest prefix that fits, by bisection on its length: an encoded size is not a character count
      // (a CJK character is three bytes, a NUL six).
      let low = 0
      let high = text.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (encodedBytes(cut(text, mid)) - 2 <= room) low = mid
        else high = mid - 1
      }
      const kept = cut(text, low)
      if (kept.length > 0) return { ...fitted, active: { ...active, selection: { ...selection, text: kept, truncated: true } } }
    }
    const { text: _dropped, ...withoutText } = selection
    fitted = { ...fitted, active: { ...active, selection: { ...withoutText, truncated: true } } }
    if (encodedBytes(fitted) <= maxBytes) return fitted
  }
  return { t: "editor", shared: snapshot.shared, active: null, open: [], diagnostics: [], problems: snapshot.problems }
}
