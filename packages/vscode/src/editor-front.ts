// THE EDITOR IN FRONT — the one reading of "what the human has in front of them" that BOTH of the
// extension's editor feeds derive from: the sidebar's page feed (context-feed.ts → the context bar, and the
// block a sidebar send carries on its own) and the agents' feed (editor-state-feed.ts → the `editor` frame
// → `mcp__ntwine__editor`). Pure: no `vscode` here, so every rule is a unit test under plain node
// (editor-front.test.ts); editor-watcher.ts is the glue that holds the window's editors to these rules.
//
// WHY ONE. Until 2026-10-02 the two feeds were two observers written by two builders, and they disagreed
// about the same moment: the page's read `file:` documents only, went blank when an output pane or the
// debug console took focus, and carried no dirty flag, while the agents' read untitled buffers too, kept
// the last file editor on screen when an output pane had focus, and knew about unsaved changes. So with
// the Output panel focused the bar said nothing was in front, the send carried nothing, and the agent's
// tool read the file the human had been pointing at — three surfaces, two answers. Now there is one front
// rule (`pickFront`), one way to read it (`editorFront`), and one privacy rule (`secretFile`); each feed
// keeps only what is genuinely its own — its text ceiling and its cadence (see the two feeds' headers).
//
// What counts as "in front":
//   - a text editor on a file on disk or an untitled buffer — never an output pane, a git revision (a
//     diff's left side), a settings UI or a webview. The modified side of a working-tree diff IS a file on
//     disk, and a selection there is code the human is pointing at (an agent's change under review), so it
//     counts, as it does for Claude Code's own getCurrentSelection.
//   - the ACTIVE text editor when it is one of those; else the last one that was, while it is still on
//     screen. Focus in an output pane or the debug console makes THAT the active text editor in VS Code;
//     without the fallback the selection the human was pointing at a moment ago would blank.

import { basename } from "node:path"
import type { Position } from "./editor-context.ts"

/** The part of a `vscode.Uri` the rules read. */
export interface UriLike {
  scheme: string
  fsPath: string
  path: string
}

/** A range as the document's own API made it — VS Code's `getText` refuses a plain `{ start, end }`. */
export interface RangeLike {
  start: Position
  end: Position
}

/**
 * The part of a `vscode.TextEditor` the rules read — structural, so the extension hands in the real one and
 * a test a plain object. `selections[0]` is the primary selection, as VS Code keeps it.
 *
 * Every range handed BACK to the document comes from VS Code's own objects (`selection`, or
 * `selection.with`), never a literal: its TextDocument checks `instanceof Range` and throws "Invalid
 * argument" on anything else. Both feeds read the selection's text through `selectedText` and so both
 * went blank in a real editor while every unit test passed; the test double now refuses a literal too.
 */
export interface EditorLike {
  document: {
    uri: UriLike
    languageId: string
    isDirty: boolean
    isClosed: boolean
    lineCount: number
    offsetAt(position: Position): number
    getText(range?: RangeLike): string
  }
  selection: RangeLike & { active: Position; isEmpty: boolean }
  selections: readonly { start: Position; end: Position }[]
  visibleRanges: readonly { start: Position; end: Position }[]
}

/** Documents the feeds read: files on disk and untitled buffers. */
export function readableUri(uri: UriLike): boolean {
  return uri.scheme === "file" || uri.scheme === "untitled"
}

/** How a document is named: its path on disk, or an untitled buffer's label (`Untitled-1`). */
export function documentPath(uri: UriLike): string {
  return uri.scheme === "untitled" ? uri.path : uri.fsPath
}

/**
 * The editor in front: `active` when it is readable; else `last` (the last readable editor that was active)
 * while it is still open and on screen; else none.
 */
export function pickFront<E extends EditorLike>(active: E | undefined, last: E | undefined, visible: readonly E[]): E | undefined {
  if (active && readableUri(active.document.uri)) return active
  if (last && !last.document.isClosed && visible.includes(last)) return last
  return undefined
}

// ── secrets ───────────────────────────────────────────────────────────────────────────────────────────
//
// A selection's TEXT goes to ntwine without the human asking in two ways: the block on every sidebar send,
// and the agents' tool. Neither should carry the contents of a file that obviously holds credentials — a
// selection left standing in `.env` while the human asks an unrelated question would put the keys into a
// transcript, and from there into a provider's logs. The path is still named (the agent may need to know
// the human is looking at their config) and the human can still add the text on purpose, as a chip (Ctrl+L
// and the bar's click are explicit, and stay so). Claude Code withholds the same way; its list is longer
// (gitignored files), but a gitignored build output is not a secret, and an agent told "not quoted" for
// every file under dist/ would be told it for nothing.
//
// By NAME, deliberately loose on the safe side: a false positive costs an agent one file read, a false
// negative costs a key. Plus whatever the human hides from VS Code itself (`files.exclude`), which the
// glue matches with VS Code's own glob engine (editor-watcher.ts), since a pattern there is the human
// saying "not this".

const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/iu, // .env, .env.local, .env.production
  /\.env$/iu, // prod.env
  /^\.envrc$/iu, // direnv
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/iu, // keys and keystores
  /^id_(rsa|dsa|ecdsa|ed25519)/iu, // ssh keys, .pub included
  /credential/iu, // credentials, credentials.json, aws/credentials
  /secret/iu, // secrets.yaml, client_secret.json
  /^\.(netrc|npmrc|pypirc|pgpass|git-credentials|htpasswd)$/iu, // tokens and passwords in dotfiles
  /^\.?kubeconfig$/iu,
]

/** Whether a file's NAME says it holds secrets. An untitled buffer's label never does. */
export function secretFile(path: string): boolean {
  const name = basename(path.replace(/\\/gu, "/"))
  return SECRET_NAMES.some((pattern) => pattern.test(name))
}

// ── the reading ───────────────────────────────────────────────────────────────────────────────────────

/** The file in front, read now — what both feeds build their messages from. Lines are 0-based, as VS Code's are. */
export interface EditorFront {
  /** The path on disk, or an untitled buffer's label. */
  path: string
  untitled: boolean
  /** Edited and not saved: what is on disk is not what the human sees. */
  dirty: boolean
  languageId: string
  lineCount: number
  /** The caret: the primary selection's moving end. */
  cursor: Position
  /** The PRIMARY selection, when it is not empty — the one a chip would carry. */
  selection?: {
    start: Position
    end: Position
    /** Characters selected across EVERY selection (multi-cursor counts each). */
    chars: number
    /** The primary's own characters. */
    primaryChars: number
  }
  /** The first and last line on screen; absent when the editor reports no visible range. */
  visible?: { start: number; end: number }
  /** The selection's text stays home: the file may hold secrets (`secretFile`, or VS Code excludes it). */
  withheld: boolean
}

/**
 * The editor, read: its document's name and state, the caret, the primary selection with the characters
 * selected, the lines on screen, and whether its text is withheld. `excluded` is the glue's answer for
 * `files.exclude`. The text itself is read separately (`selectedText`), and only as far as a feed carries it.
 */
export function editorFront(editor: EditorLike, excluded = false): EditorFront {
  const { document, selection, visibleRanges } = editor
  const untitled = document.uri.scheme === "untitled"
  const path = documentPath(document.uri)
  const chars = (range: { start: Position; end: Position }) => Math.max(0, document.offsetAt(range.end) - document.offsetAt(range.start))
  const primaryChars = selection.isEmpty ? 0 : chars(selection)
  return {
    path,
    untitled,
    dirty: document.isDirty,
    languageId: document.languageId,
    lineCount: document.lineCount,
    cursor: selection.active,
    ...(primaryChars > 0
      ? { selection: { start: selection.start, end: selection.end, primaryChars, chars: editor.selections.reduce((sum, each) => sum + chars(each), 0) } }
      : {}),
    ...(visibleRanges.length ? { visible: { start: visibleRanges[0]!.start.line, end: visibleRanges[visibleRanges.length - 1]!.end.line } } : {}),
    withheld: !untitled && (excluded || secretFile(path)),
  }
}

/**
 * The primary selection's text, at most `max` characters of it from its start — read only that far, so a
 * select-all on a large file is not copied whole on every caret move to be cut. Undefined when nothing is
 * selected or the text is withheld. Newlines as the document has them; each feed normalizes its own.
 */
/**
 * What reading the text takes beyond the rules: a position the document made (`positionAt`) handed to the
 * selection's own `with`, so the range given back to `getText` is one VS Code made. Generic over the
 * position type because VS Code's is a class the rules' plain `Position` is not.
 */
export type ReadableEditor<P extends Position> = EditorLike & {
  document: { positionAt(offset: number): P }
  selection: { with(start: undefined, end: P): RangeLike }
}

export function selectedText<P extends Position>(editor: ReadableEditor<P>, front: EditorFront, max: number): string | undefined {
  if (!front.selection || front.withheld) return undefined
  const { document, selection } = editor
  if (front.selection.primaryChars <= max) return document.getText(selection)
  return document.getText(selection.with(undefined, document.positionAt(document.offsetAt(selection.start) + max)))
}
