// SELECTED CONTEXT for a thread's composer — the ⌘I flow. A selection sent from an editor
// (lib/editorCompose.ts) becomes a staged item (file, quoted text, best-effort line range, optional comment) ANCHORED BY A
// MENTION TOKEN — `@guide.md:3`, the chip's own label behind an `@` — spliced into the draft prose at
// the caret, and on send the items serialize as definitions under the prose, keyed by that same
// token. The token IS the chip: a <textarea> cannot host a pill, so the reference is text the human
// can read as-is, and the composer paints the pill behind it (Composer's backdrop). The first cut
// used footnote markers, `[^1]`, and the maintainer read them as plumbing (2026-09-03: "rendering as
// [^1] looks a little weird … worse than just rendering the chip inline. the footnote structure is an
// INTERNAL detail") — so nothing numbered reaches the human anywhere now, and the wire carries the
// same self-describing token the composer shows. Tokens-in-the-text is the load-bearing part
// (2026-09-02): the human interleaves chip, comment, chip, comment, and the agent can only know
// which comment refers to which selection if the reference sits at its original position. Text, not
// a side-channel: the worker reads the same transcript the human does, and `@file:line` beside a
// quoted block is the shape every coding agent already uses (see the prior-art report in the
// dispatching thread's scratch directory — Zed, Copilot and Claude Code all key an inline mention
// to a grouped tail this way).

import { EMBED_PROBLEMS_PATH, EMBED_TERMINAL_PATH } from "@ntwine/shared"
import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"
import { basename, relativeTo } from "./paths.ts"

export interface ComposerContextItem {
  id: number
  /** The mention token anchoring this item in the draft prose: `@` + the chip label (+ `#n` when a duplicate). */
  token: string
  /** Absolute path of the file the selection came from (the panel's canonical path). */
  path: string
  /** The selected text, verbatim. */
  text: string
  /** 1-based line range in the file, when the selection could be located unambiguously. */
  startLine?: number
  endLine?: number
}

/** The chip label a context item wears everywhere: `basename:12` / `basename:3-9` / `basename`. */
export function contextChipLabel(item: { display?: string; path?: string; startLine?: number; endLine?: number }): string {
  const source = item.display ?? item.path ?? ""
  const base = basename(source)
  if (item.startLine === undefined || item.endLine === undefined) return base
  return item.startLine === item.endLine ? `${base}:${item.startLine}` : `${base}:${item.startLine}-${item.endLine}`
}

/** The label a token shows: the token without its `@`. */
export function tokenLabel(token: string): string {
  return token.startsWith("@") ? token.slice(1) : token
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A token ends where its label does: the next character may not extend it. `@a.md:3` must not
// match inside `@a.md:30`, `@a.md:3-4` or `@a.md:3#2`; ordinary punctuation after it (`@a.md:3.`,
// `@a.md:3,`) is the sentence's, not the token's.
//
// A WHOLE-FILE token has no line suffix (`@a.ts`), and it must not match inside the longer labels a
// file's other references wear either: `@a.ts:12`, `@a.tsx`, `@a.ts.map`, `@terminal-2`. Until
// 2026-10-01 only digits, `#` and `-<digit>` were excluded, which was enough while nearly every chip
// carried lines — but the sidebar's open-files menu adds whole files, so `@a.ts` beside `@a.ts:12` is
// ordinary now, and the prefix match read the whole-file chip as still present after its own text was
// deleted (never swept, serialized at the other chip's position) and gave a second whole-file chip a
// needless `#2`. So: no word character, and no `-`, `.` or `:` that a word character follows. A
// sentence's own `.` or `:` after a token (`see @a.ts.`, `@a.ts: why?`) is still the sentence's.
const TOKEN_BOUNDARY = "(?![\\w#]|[-.:]\\w)"

/** Whether the prose carries this token as a whole reference (not as the prefix of a longer one). */
export function hasToken(prose: string, token: string): boolean {
  return new RegExp(escapeRe(token) + TOKEN_BOUNDARY).test(prose)
}

/** The first position of the token in the prose as a whole reference, or -1. */
export function tokenIndex(prose: string, token: string): number {
  const match = new RegExp(escapeRe(token) + TOKEN_BOUNDARY).exec(prose)
  return match ? match.index : -1
}

/**
 * The token for a fresh selection: `@` + its chip label, made unique against the tokens already
 * staged or already in the prose (`@guide.md:3#2` for a second selection on the same line — two
 * references must never fuse, and a hand-typed twin must not be mistaken for the staged one).
 */
export function uniqueToken(label: string, staged: readonly { token: string }[], prose: string): string {
  const base = `@${label}`
  const taken = (candidate: string) => staged.some((item) => item.token === candidate) || hasToken(prose, candidate)
  if (!taken(base)) return base
  for (let n = 2; ; n++) if (!taken(`${base}#${n}`)) return `${base}#${n}`
}

/**
 * Splice a token into the prose at the caret, padding with a space on either side it would otherwise
 * glue to a word. Returns the new prose and the caret to restore — after the token but before any
 * trailing pad, so typing straight on reads `@guide.md:3 comment` without a double space.
 */
export function insertTokenIntoProse(prose: string, caret: number, token: string): { prose: string; caret: number } {
  const at = Math.max(0, Math.min(caret, prose.length))
  const before = prose.slice(0, at)
  const after = prose.slice(at)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const trail = after && !/^\s/.test(after) ? " " : ""
  return { prose: `${before}${lead}${token}${trail}${after}`, caret: at + lead.length + token.length }
}

/**
 * Cut prose into runs of plain text and whole staged tokens, in order — the ONE splitter the
 * composer's backdrop and the transcript's chips both use, so a reference is a pill in exactly the
 * same places on both surfaces. Longer tokens match first so `@a.md:3#2` is never read as
 * `@a.md:3` + `#2`. An empty token set yields the prose as one plain run.
 */
export function splitProseByTokens(prose: string, tokens: readonly string[]): { text: string; token?: string }[] {
  if (!tokens.length || !prose) return prose ? [{ text: prose }] : []
  const alternation = [...new Set(tokens)].sort((a, b) => b.length - a.length).map(escapeRe).join("|")
  const re = new RegExp(`(${alternation})${TOKEN_BOUNDARY}`, "g")
  const runs: { text: string; token?: string }[] = []
  let last = 0
  for (const match of prose.matchAll(re)) {
    if (match.index > last) runs.push({ text: prose.slice(last, match.index) })
    runs.push({ text: match[0], token: match[0] })
    last = match.index + match[0].length
  }
  if (last < prose.length) runs.push({ text: prose.slice(last) })
  return runs
}

/**
 * `packages/web/src/App.tsx` for a file under the project; the absolute path for anything else. The
 * remainder keeps the path's own separators (`packages\web\src\App.tsx` under a `C:\…` project), as
 * the panel's canonical path is the server's spelling and the worker reads the same one.
 *
 * `checkoutDir` is where the box's thread works when that is not the project root — a worktree, which
 * usually lies INSIDE the project (`.ntwine/worktrees/<slug>`). A file under it is relative to IT: the agent
 * resolves a relative path against its own working folder, and `.ntwine/worktrees/x/src/a.ts` from there
 * names nothing. A file of the main checkout stays relative to the project — the same relative path is the
 * agent's own copy, which the worktree note says (`worktreeNote`).
 */
export function contextDisplayPath(path: string, projectDir?: string | null, checkoutDir?: string | null): string {
  if (isTerminalPath(path)) return path
  return (checkoutDir && relativeTo(checkoutDir, path)) || (projectDir && relativeTo(projectDir, path)) || path
}

/**
 * A selection made in the editor's TERMINAL, which has no file (embed-protocol.ts
 * `EMBED_TERMINAL_PATH`). Its chip reads `@terminal` (`@terminal#2` for a second), its definition
 * `@terminal (terminal):` — no line numbers, which would be the terminal buffer's and mean nothing to
 * the agent, and never resolved against the project, since `terminal` is a name, not a relative path.
 */
export function isTerminalPath(path: string): boolean {
  return path === EMBED_TERMINAL_PATH
}

function lineLabel(item: { path?: string; startLine?: number; endLine?: number }): string {
  if (item.startLine === undefined || item.endLine === undefined || (item.path !== undefined && isTerminalPath(item.path))) return ""
  return item.startLine === item.endLine ? `, line ${item.startLine}` : `, lines ${item.startLine}-${item.endLine}`
}

/**
 * Where a staged chip came from, for its hover: `src/a.ts, lines 12-20` — the definition's own
 * parenthesis, so the hover and what the agent reads agree — or `Terminal` for the terminal's text, `Problems`
 * for the file's problems.
 */
export function contextSourceLabel(item: { path: string; startLine?: number; endLine?: number }, projectDir?: string | null): string {
  if (isTerminalPath(item.path)) return "Terminal"
  if (item.path === EMBED_PROBLEMS_PATH) return "Problems"
  return `${contextDisplayPath(item.path, projectDir)}${lineLabel(item)}`
}

/**
 * The agent-facing serialization: one DEFINITION per item — `@guide.md:3 (docs/guide.md, line 3):`
 * then the selection as a blockquote. The `@` tokens stay in the prose where the human put them, so
 * each definition opens with the very token the sentence used; the parenthesis spells the path and
 * line range out in full for a reader that does not want to decode the label. The human's remarks
 * on a selection are the prose around its token — there is no per-item note. Blockquotes rather
 * than a fence because the quoted text may itself contain any fence, and because the transcript
 * renders the sent message as markdown — quoted context reads as quotation.
 */
export function serializeContextItems(items: ComposerContextItem[], projectDir?: string | null, checkoutDir?: string | null): string {
  if (!items.length) return ""
  const blocks = items.map((item) => {
    const quoted = item.text.replace(/\s+$/, "").split("\n").map((line) => `> ${line}`).join("\n")
    return `${item.token} (${contextDisplayPath(item.path, projectDir, checkoutDir)}${lineLabel(item)}):\n${quoted}`
  })
  return `Selected context:\n\n${blocks.join("\n\n")}`
}

/**
 * Splice the serialized context into an outgoing composer value. Only items whose token still
 * appears in the prose serialize — deleting the token text IS the removal gesture. The value's
 * TRAILING lines may be attachment paths (see imagePaths.ts) which several surfaces detect by their
 * trailing position — context goes after the prose but BEFORE those lines so they stay trailing.
 * Definitions follow the order the references appear in the prose, not staging order.
 */
export function buildMessageWithContext(value: string, items: ComposerContextItem[], projectDir?: string | null, checkoutDir?: string | null): string {
  const { prose, attachments } = splitComposerValue(value)
  const present = items
    .filter((item) => hasToken(prose, item.token))
    .sort((a, b) => tokenIndex(prose, a.token) - tokenIndex(prose, b.token))
  const context = serializeContextItems(present, projectDir, checkoutDir)
  if (!context) return value
  const body = prose.trimEnd() ? `${prose.trimEnd()}\n\n${context}` : context
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}

// ── the receiving side: a SENT message parsed back into prose + items ────────────────────────────

/** One context item recovered from a sent message's serialized definitions. */
export interface SentContextItem {
  /** The mention token, exactly as it appears in the body. */
  token: string
  /** The path exactly as serialized (project-relative or absolute). */
  display: string
  startLine?: number
  endLine?: number
  /** The quoted selection, blockquote prefixes stripped. */
  text: string
}

const HEADER = "Selected context:\n\n"

/**
 * Recognize the serialization `buildMessageWithContext` produced inside a SENT message, so the
 * transcript can render the `@` references as chips instead of showing the raw definitions dump.
 * Strict by design: anything that does not parse back exactly — including every message from the
 * two earlier formats (`[1] path` and `[^1]: path`) — returns null and renders as the plain text it is.
 */
export function parseSentContext(prose: string): { body: string; items: SentContextItem[] } | null {
  const at = prose.lastIndexOf(HEADER)
  if (at === -1) return null
  if (at !== 0 && prose.slice(at - 2, at) !== "\n\n") return null
  const body = prose.slice(0, Math.max(0, at - 2))
  // Definition blocks are separated by a blank line followed by the next `@token (` head; split on
  // the lookahead rather than on `\n\n` so a blank line inside a quote never opens a bogus block.
  const blocks = prose.slice(at + HEADER.length).split(/\n\n(?=@\S+ \()/)
  const items: SentContextItem[] = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const head = lines[0]?.match(/^(@\S+) \((.+?)(?:, line (\d+)|, lines (\d+)-(\d+))?\):$/)
    if (!head) return null
    const display = head[2]
    const startLine = head[3] !== undefined ? Number(head[3]) : head[4] !== undefined ? Number(head[4]) : undefined
    const endLine = head[3] !== undefined ? Number(head[3]) : head[5] !== undefined ? Number(head[5]) : undefined
    let i = 1
    const quote: string[] = []
    for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^> ?/, ""))
    if (!quote.length || i < lines.length) return null
    items.push({ token: head[1], display, startLine, endLine, text: quote.join("\n") })
  }
  if (!items.length) return null
  // The references must actually be in the body — a message that merely QUOTES a serialization (an
  // agent echoing one back, a human pasting one) keeps its honest plain-text rendering.
  if (!items.every((item) => hasToken(body, item.token))) return null
  return { body, items }
}

// ── what the EDITOR had in front: the block a sidebar send carries on its own ─────────────────────
//
// In an editor's sidebar every send carries what the editor around it has in front — the selection, or
// with nothing selected the file and the caret's line — while the human shares the editor (the context
// bar's eye, which is the extension's `ntwine.shareEditorState`; lib/editorContext.ts outgoingMessage;
// ARCHITECTURE.md § VS Code extension). Claude Code's VS Code extension and Cursor both
// work this way, and the maintainer called it "the #1 feature": an agent in the sidebar that cannot see the
// highlighted code is not beside the editor at all. Asked "can you see the highlighted code?", the first
// cut's agent said no, because the selection reached a message only when the human made a chip of it.
//
// It is a block of its OWN, after the chips' "Selected context:" block, rather than one more chip
// definition. A chip is a reference the human placed in their sentence; this is not, and the agent must
// be able to tell the two apart: what the human pointed at is the subject, what merely happened to be
// selected may be nothing to do with the question (the human scrolled away, the selection is a leftover
// from an hour ago). So the header says it was attached automatically and may be unrelated — Claude Code
// frames its own the same way ("this may or may not be related to the current task") — and no `@` token
// stands for it in the prose. Like the chips it is text in the message, never a side channel: the worker
// reads the same transcript the human does.
//
// One reading under the header, and it says what the agent can and cannot do with it — because the
// obvious next move, "read it from the file", is wrong for a buffer with unsaved changes (the copy on disk
// is not what the human sees) and impossible for an untitled one:
//
//   Selected in src/a.ts, lines 12-20:                                     (then the text, quoted)
//   Selected in src/a.ts (unsaved changes), lines 12-20:                   (quoted; line numbers are the buffer's)
//   Selected in Untitled-1 (unsaved, not a file on disk), lines 1-5:       (quoted)
//   Selected in src/a.ts, lines 12-900 (not quoted here; read it from the file)
//   Selected in src/a.ts (unsaved changes), lines 12-900 (not quoted here, and the copy on disk differs: ask the human to save it or paste it)
//   Selected in Untitled-1 (unsaved, not a file on disk), lines 1-900 (not quoted here, and there is no file to read: ask the human to paste it)
//   Selected in .env, lines 1-3 (not quoted here: the file may hold secrets)
//   Still selected in src/a.ts, lines 12-20 (quoted in an earlier message)
//   Open in the editor: src/a.ts (unsaved changes; cursor on line 40)
//
// "Not quoted" is a selection past the feed's ceiling (EMBED_MAX_SELECTION_TEXT, 16 Ki) or from a file
// whose text the extension keeps home (packages/vscode editor-front.ts secretFile).
//
// "STILL SELECTED" is the repeat-send rule. A selection held while the human talks to a thread used to be
// quoted IN FULL on every message of it — up to 16 Ki characters, about 4k tokens, each time, for code the
// agent already had. When the last block this thread was sent quoted the very same lines with the very
// same text (`previousEditorQuote`, read from its transcript), the next block names them instead. Any
// change — another selection, an edit to the selected text, a different file — quotes afresh.

const EDITOR_HEADER = "Editor context (attached automatically: what the user had in front of them in their editor when they sent this; it may or may not be related):"
const NOT_QUOTED = "not quoted here; read it from the file"
const NOT_QUOTED_UNSAVED = "not quoted here, and the copy on disk differs: ask the user to save it or paste it"
const NOT_QUOTED_UNTITLED = "not quoted here, and there is no file to read: ask the user to paste it"
const NOT_QUOTED_SECRET = "not quoted here: the file may hold secrets"
const QUOTED_EARLIER = "quoted in an earlier message"
// These said "the human" until 2026-10-08. Messages already sent carry that spelling, and the parsers below
// still read them: the old header and tails, rebuilt from the new ones so the two cannot drift.
const legacyHumanWording = (text: string): string => text.replaceAll("the user", "the human")
const EDITOR_HEADERS = [EDITOR_HEADER, legacyHumanWording(EDITOR_HEADER)]
const UNSAVED = "unsaved changes"
const UNTITLED = "unsaved, not a file on disk"

/** What the editor had in front, as the feed has it (embed-protocol.ts `EmbedEditorContextMessage.active`). */
export interface EditorContextInput {
  path: string
  selection?: { startLine: number; endLine: number; text?: string }
  cursorLine?: number
  untitled?: boolean
  dirty?: boolean
  withheld?: boolean
}

/** The block, parsed back out of a sent message, for the transcript's chip and for the repeat-send rule. */
export interface SentEditorContext {
  kind: "selection" | "file"
  /** The path as serialized (project-relative, or absolute outside the project; an untitled buffer's label). */
  display: string
  /** A selection's lines. */
  startLine?: number
  endLine?: number
  /** A file's caret line, when the editor said it. */
  cursorLine?: number
  /** The quoted selection; absent for a file, and for a selection that was not quoted. */
  text?: string
  /** What the copy on disk is: absent for a saved file. */
  state?: "unsaved" | "untitled"
  /** "Still selected": the same lines and text as the quote before it in this thread. */
  repeat?: true
  /** Why a selection was not quoted: too long, or a file that may hold secrets. */
  unquoted?: "long" | "secret"
}

function linesPhrase(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
}

/** The quoted text as the block writes it and the parse gives it back: no trailing whitespace. */
const quotable = (text: string) => text.replace(/\s+$/, "")

/**
 * Whether a chip the message already carries says what the editor block would: one on the same file whose
 * lines take in the whole selection, or whose quote holds its text — ⌘I on the selection, then send, with
 * the selection still up. A file with nothing selected is covered by any chip on that file: the human
 * pointed at it already, and "the editor shows this file too" beside it is noise. Only chips whose token is
 * still in the prose count — `present`, the ones that serialize.
 */
export function editorContextCovered(active: EditorContextInput, present: readonly ComposerContextItem[]): boolean {
  const same = present.filter((item) => item.path === active.path)
  const selection = active.selection
  if (!selection) return same.length > 0
  const text = selection.text?.trim()
  return same.some((item) =>
    (item.startLine !== undefined && item.endLine !== undefined && item.startLine <= selection.startLine && item.endLine >= selection.endLine)
    || (!!text && item.text.includes(text)))
}

/** The last quote of a selection this thread was sent, as `previousEditorQuote` finds it. */
export interface EditorQuote {
  display: string
  startLine: number
  endLine: number
  text: string
}

/**
 * The block for what the editor has in front, or "" when there is nothing to say — no editor in front, or
 * a chip already says it (`editorContextCovered`). A selection whose text is blank (whitespace selected)
 * reads as the file with the caret on its first line: there is nothing in it to quote. `previous` is the
 * last quote this thread was sent (`previousEditorQuote`): the same lines and text again are named, not
 * re-quoted. `checkoutDir` is the thread's own checkout when that is not the project root
 * (`contextDisplayPath`).
 */
export function serializeEditorContext(
  active: EditorContextInput | null | undefined,
  present: readonly ComposerContextItem[],
  projectDir?: string | null,
  checkoutDir?: string | null,
  previous?: EditorQuote | null,
): string {
  if (!active || editorContextCovered(active, present)) return ""
  const display = active.untitled ? active.path : contextDisplayPath(active.path, projectDir, checkoutDir)
  const state = active.untitled ? UNTITLED : active.dirty ? UNSAVED : ""
  const named = `${display}${state ? ` (${state})` : ""}`
  const selection = active.selection
  let reading: string
  if (selection && selection.text !== undefined && !selection.text.trim()) {
    reading = `Open in the editor: ${display} (${state ? `${state}; ` : ""}cursor on line ${selection.startLine})`
  } else if (selection) {
    const lines = linesPhrase(selection.startLine, selection.endLine)
    if (selection.text === undefined) {
      const why = active.withheld ? NOT_QUOTED_SECRET : active.untitled ? NOT_QUOTED_UNTITLED : active.dirty ? NOT_QUOTED_UNSAVED : NOT_QUOTED
      reading = `Selected in ${named}, ${lines} (${why})`
    } else if (previous && previous.display === display && previous.startLine === selection.startLine && previous.endLine === selection.endLine && previous.text === quotable(selection.text)) {
      reading = `Still selected in ${named}, ${lines} (${QUOTED_EARLIER})`
    } else {
      reading = `Selected in ${named}, ${lines}:\n${quotable(selection.text).split("\n").map((line) => `> ${line}`).join("\n")}`
    }
  } else {
    const where = [state, active.cursorLine ? `cursor on line ${active.cursorLine}` : ""].filter(Boolean).join("; ")
    reading = `Open in the editor: ${display}${where ? ` (${where})` : ""}`
  }
  return `${EDITOR_HEADER}\n\n${reading}`
}

/**
 * Put the block at the END of an outgoing value — after the prose and any "Selected context:" block, and
 * BEFORE the trailing attachment-path lines, which several surfaces find by their trailing position
 * (imagePaths.ts). The human's prose is never touched: the block goes after it, a blank line between.
 */
export function appendEditorContext(value: string, block: string): string {
  if (!block) return value
  const { prose, attachments } = splitComposerValue(value)
  const body = prose.trimEnd() ? `${prose.trimEnd()}\n\n${block}` : block
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}

const STATES = `${UNSAVED}|${UNTITLED}`
const SELECTED_LINE = new RegExp(`^(Still selected|Selected) in (.+?)(?: \\((${STATES})\\))?, (?:line (\\d+)|lines (\\d+)-(\\d+))(:| \\((.+)\\))$`)
const OPEN_LINE = new RegExp(`^Open in the editor: (.+?)(?: \\((?:(${STATES}); cursor on line (\\d+)|(${STATES})|cursor on line (\\d+))\\))?$`)
const UNQUOTED: Record<string, SentEditorContext["unquoted"]> = {
  [NOT_QUOTED]: "long",
  [NOT_QUOTED_UNSAVED]: "long",
  [NOT_QUOTED_UNTITLED]: "long",
  [legacyHumanWording(NOT_QUOTED_UNSAVED)]: "long",
  [legacyHumanWording(NOT_QUOTED_UNTITLED)]: "long",
  [NOT_QUOTED_SECRET]: "secret",
}
const stateOf = (phrase: string | undefined): SentEditorContext["state"] => (phrase === UNSAVED ? "unsaved" : phrase === UNTITLED ? "untitled" : undefined)

/**
 * The editor block at the END of a sent message's prose (attachment lines already peeled), and the prose
 * before it — on which `parseSentContext` then runs, so a message with both renders both. Strict, like
 * `parseSentContext`: the header must open its own paragraph and everything after it must be exactly one
 * reading in the grammar above, so a message that QUOTES a block somewhere in its middle (an agent's words
 * pasted back, this comment) keeps its plain-text rendering. A blockquote line can never be blank (`> ` at
 * least), so a blank line inside the quoted code cannot end the block early. Every reading an earlier page
 * wrote still parses: the grammar only grew.
 */
export function parseSentEditorContext(prose: string): { body: string; editor: SentEditorContext } | null {
  // The LAST header that opens a paragraph. One inside the quoted code cannot: every quoted line opens with
  // `>`, so no blank line precedes it.
  let at = -1
  let header = EDITOR_HEADER
  for (const candidate of EDITOR_HEADERS) {
    const opens = prose.lastIndexOf(`\n\n${candidate}`)
    const found = opens !== -1 ? opens + 2 : prose.startsWith(candidate) ? 0 : -1
    if (found > at) [at, header] = [found, candidate]
  }
  if (at === -1) return null
  // Trailing whitespace is the transport's, never the block's: the serializer trims the quote's end.
  const rest = prose.slice(at + header.length).trimEnd()
  if (!rest.startsWith("\n\n")) return null
  const [head, ...quote] = rest.slice(2).split("\n")
  const body = prose.slice(0, Math.max(0, at - 2))
  const selected = head?.match(SELECTED_LINE)
  if (selected) {
    const repeat = selected[1] === "Still selected"
    const state = stateOf(selected[3])
    const startLine = Number(selected[4] ?? selected[5])
    const endLine = Number(selected[4] ?? selected[6])
    const quoted = selected[7] === ":"
    const tail = selected[8]
    const base: SentEditorContext = { kind: "selection", display: selected[2]!, startLine, endLine, ...(state ? { state } : {}) }
    if (repeat) return tail === QUOTED_EARLIER && !quote.length ? { body, editor: { ...base, repeat: true } } : null
    if (quoted) {
      if (!quote.length || !quote.every((line) => line.startsWith(">"))) return null
      return { body, editor: { ...base, text: quote.map((line) => line.replace(/^> ?/, "")).join("\n") } }
    }
    const unquoted = tail === undefined ? undefined : UNQUOTED[tail]
    return unquoted && !quote.length ? { body, editor: { ...base, unquoted } } : null
  }
  const open = head?.match(OPEN_LINE)
  if (!open || quote.length) return null
  const state = stateOf(open[2] ?? open[4])
  const cursor = open[3] ?? open[5]
  return { body, editor: { kind: "file", display: open[1]!, ...(cursor !== undefined ? { cursorLine: Number(cursor) } : {}), ...(state ? { state } : {}) } }
}

/**
 * The quote of a selection the thread's agent already has, for the repeat-send rule: walking the thread's
 * messages from the newest back, the most recent editor block — passing over "still selected" references to
 * the same lines, which are themselves repeats of it — if that block quoted a selection. Anything else most
 * recently (another file, a selection too long to quote, the file with nothing selected) means the next
 * selection is news, and is quoted. Messages with no block (sent from a browser tab, or with sharing off)
 * are passed over: the agent still has what came before them.
 *
 * `text` is each message as the transcript shows it (its presentation text, newlines as `\n`).
 */
export function previousEditorQuote(messages: readonly { role: string; text: string }[]): EditorQuote | null {
  let reference: SentEditorContext | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== "user") continue
    // A worktree thread's block is followed by the note on whose copy it is; the block is under it.
    const parsed = parseSentEditorContext(withoutWorktreeNote(splitComposerValue(message.text).prose))
    if (!parsed) continue
    const { editor } = parsed
    if (editor.kind !== "selection" || editor.startLine === undefined || editor.endLine === undefined) return null
    if (reference && (reference.display !== editor.display || reference.startLine !== editor.startLine || reference.endLine !== editor.endLine)) return null
    if (editor.repeat) {
      reference = editor
      continue
    }
    return editor.text === undefined ? null : { display: editor.display, startLine: editor.startLine, endLine: editor.endLine, text: editor.text }
  }
  return null
}

/**
 * A sent message as the human wrote it, the editor block taken off — what goes back into the prompt box
 * when a queued message is taken back, so the re-send attaches the editor's context of THAT moment rather
 * than carrying the old one as prose under a new one. Attachment lines stay. Unchanged when there is none.
 */
export function withoutEditorContext(value: string): string {
  const { prose: sent, attachments } = splitComposerValue(value)
  // The worktree note goes with the block: it describes the context of THAT moment, and the re-send
  // writes its own when its own context needs one.
  const prose = withoutWorktreeNote(sent)
  const parsed = parseSentEditorContext(prose)
  if (parsed) return joinComposerValue(parsed.body, attachments.map((attachment) => attachment.path))
  return prose === sent ? value : joinComposerValue(prose, attachments.map((attachment) => attachment.path))
}

// ── a thread in a WORKTREE: whose copy the context is ─────────────────────────────────────────────
//
// About one thread in seven works in a worktree of its own (`.ntwine/worktrees/<slug>`, 22 of 144
// substantial sessions in a week), while the human's editor shows the project's main checkout. A chip or
// the editor block names `src/a.ts` relative to the project, and the agent resolves that against its OWN
// working folder — its worktree's copy, which is the right file to edit but may not hold the text the
// human quoted from theirs. Nothing said so: a worktree worker read its own copy as the one the human had
// selected and answered about code that was not in front of them.
//
// So when the context a message carries names a file of the main checkout and the thread works elsewhere,
// ONE sentence after it says whose copy the context is and where the agent's own is. It is the last
// paragraph of the message's prose (before any attachment lines), which keeps every parser above exactly
// as strict as it was: the transcript takes it off first (`withoutWorktreeNote`), and the bubble shows what
// the human wrote. A file in the worktree itself is the agent's own copy, relative to the worktree
// (`contextDisplayPath`), and needs no sentence.

const WORKTREE_NOTE_RE = /\n\nThe context above is from the (?:user|human)'s editor, which shows the project's main checkout \([^\n]*\)\. You are working in your own (?:worktree|checkout) \([^\n]*\): the same relative path there is your copy, and it may differ from what they see\.$/

/**
 * The sentence for a message whose context names `paths`, sent to a thread working in `checkout`: "" when
 * the thread works at the project root, or none of the paths is a file of the main checkout (the project,
 * outside the thread's own checkout).
 */
export function worktreeNote(paths: readonly string[], projectDir: string | null | undefined, checkout: { dir: string; kind?: string } | null | undefined): string {
  if (!projectDir || !checkout?.dir || checkout.dir === projectDir) return ""
  const theirs = paths.some((path) => !isTerminalPath(path) && relativeTo(projectDir, path) !== null && relativeTo(checkout.dir, path) === null && path !== checkout.dir)
  if (!theirs) return ""
  const where = checkout.kind === "folder" ? "checkout" : "worktree"
  return `The context above is from the user's editor, which shows the project's main checkout (${projectDir}). You are working in your own ${where} (${checkout.dir}): the same relative path there is your copy, and it may differ from what they see.`
}

/** Put the note at the end of an outgoing value's prose, before its attachment lines. */
export function appendWorktreeNote(value: string, note: string): string {
  if (!note) return value
  const { prose, attachments } = splitComposerValue(value)
  return joinComposerValue(`${prose.trimEnd()}\n\n${note}`, attachments.map((attachment) => attachment.path))
}

/** A sent message's prose without the note at its end; unchanged when there is none. */
export function withoutWorktreeNote(prose: string): string {
  const match = WORKTREE_NOTE_RE.exec(prose.trimEnd())
  return match ? prose.slice(0, match.index) : prose
}
