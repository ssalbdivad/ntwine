import { proxy, useSnapshot } from "valtio"
import { EMBED_MAX_DROPPED, EMBED_MAX_QUERY, type EmbedContextPicksMessage, type EmbedEditorExtrasMessage, type EmbedPickedFile } from "@ntwine/shared"
import { contextDisplayPath } from "./composerContext.ts"
import { embedded, postToHost } from "./embed.ts"

// MORE WAYS INTO A PROMPT BOX IN AN EDITOR'S SIDEBAR — the page's half (packages/shared/src/
// embed-protocol.ts § more ways in; the extension's half is packages/vscode/src/workspace-files.ts and
// extras-feed.ts):
//
//  - `@` in a prompt box offers the workspace's files beside the threads it always offered. The page has
//    no index of the editor's workspace, so it asks the host (`ntwine:pick-context` with the query) and
//    the host answers with the best matches (`ntwine:context-picks`). Choosing one writes the file as a
//    whole-file reference — `` `src/a.ts` `` — the same text Add file to ntwine prompt and the context
//    bar's open files write (lib/editorCompose.ts composeEdit), so an agent reads one shape for "this
//    file" whichever way it came in.
//  - files dragged in from VS Code's explorer: the drag carries URIs, not File objects, which the box's
//    attachment intake cannot take — so the host resolves the URIs to paths on its side (the same ask,
//    with `uris`) and each becomes the same reference, at the caret.
//  - the file's problems and the terminal's last command: the host says which there are
//    (`ntwine:editor-extras`), and the context bar's menu offers them (EditorContextBar.tsx).
//
// Embed mode only: in a browser tab nothing answers, and none of it is offered.

// ── what else the editor can add (the context bar's menu) ───────────────────────────────────────────

export interface EditorExtrasState {
  problems?: EmbedEditorExtrasMessage["problems"]
  terminal?: EmbedEditorExtrasMessage["terminal"]
}

export const editorExtras = proxy<EditorExtrasState>({})

/** A `ntwine:editor-extras` replaces the last one whole: an entry it leaves out is no longer offered. */
export function setEditorExtras(message: EmbedEditorExtrasMessage): void {
  editorExtras.problems = message.problems
  editorExtras.terminal = message.terminal
}

export function useEditorExtras(): EditorExtrasState {
  return useSnapshot(editorExtras) as EditorExtrasState
}

/** `2 errors, 1 warning` — what the menu's problems entry says beside its name. */
export function problemCountsLabel(problems: NonNullable<EditorExtrasState["problems"]>): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  return [
    problems.errors ? plural(problems.errors, "error") : "",
    problems.warnings ? plural(problems.warnings, "warning") : "",
    problems.infos ? plural(problems.infos, "info") : "",
  ].filter(Boolean).join(", ")
}

// ── asking the host for files ───────────────────────────────────────────────────────────────────────

/** How long an ask waits: the first `@` in a large workspace lists it (git, a few hundred ms) before answering. */
const ASK_MS = 8_000

const waiting = new Map<string, (files: EmbedPickedFile[]) => void>()
/**
 * Whether the host answers at all. An extension from before this asks nothing back; once one ask has gone
 * unanswered the page stops asking on every keystroke, until an answer arrives after all (a slow first
 * index), which turns it back on.
 */
let hostAnswers = true

function nonce(): string {
  // Not crypto.randomUUID: an `http:` origin that is not localhost (a LAN host, a tunnel) is not a secure
  // context, and has none. The id only pairs an answer with its ask.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function ask(request: { query: string } | { uris: string[] }): Promise<EmbedPickedFile[] | null> {
  if (!embedded() || !hostAnswers) return Promise.resolve(null)
  const id = nonce()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      hostAnswers = false
      resolve(null)
    }, ASK_MS)
    waiting.set(id, (files) => {
      clearTimeout(timer)
      resolve(files)
    })
    postToHost({ type: "ntwine:pick-context", id, ...request })
  })
}

/** The host's answer, to the ask that is waiting on its id. */
export function takeContextPicks(message: EmbedContextPicksMessage): void {
  hostAnswers = true
  const resolve = waiting.get(message.id)
  waiting.delete(message.id)
  resolve?.(message.files)
}

/** The files a prompt box's `@` query names, best first; null when no host answers. */
export function searchFiles(query: string): Promise<EmbedPickedFile[] | null> {
  return ask({ query: query.slice(0, EMBED_MAX_QUERY) })
}

/** Dropped resources as files and folders on disk; null when no host answers. */
export function resolveDropped(uris: readonly string[]): Promise<EmbedPickedFile[] | null> {
  return uris.length ? ask({ uris: uris.slice(0, EMBED_MAX_DROPPED) }) : Promise.resolve([])
}

// ── the source a prompt box is handed ───────────────────────────────────────────────────────────────

/** What a prompt box needs to offer files: the asks, and how a file is written into its prose. */
export interface FileMentionSource {
  search(query: string): Promise<EmbedPickedFile[] | null>
  resolve(uris: readonly string[]): Promise<EmbedPickedFile[] | null>
  /** The inline reference for a file, as this box's project spells it: `` `src/a.ts` ``, `` `src/` `` for a folder. */
  reference(file: EmbedPickedFile): string
}

const sources = new Map<string, FileMentionSource>()

/**
 * The file source for a prompt box whose project lives at `projectDir`, in embed mode; undefined in a
 * browser tab. One object per project directory, so a box re-rendering hands the composer the same one.
 */
export function embedFileMentions(projectDir: string | undefined): FileMentionSource | undefined {
  if (!embedded()) return undefined
  const key = projectDir ?? ""
  let source = sources.get(key)
  if (!source) {
    source = {
      search: searchFiles,
      resolve: resolveDropped,
      reference: (file) => fileReference(file, projectDir),
    }
    sources.set(key, source)
  }
  return source
}

/** `` `src/a.ts` `` — project-relative under the project, absolute anywhere else; a folder ends in its separator. */
export function fileReference(file: Pick<EmbedPickedFile, "path" | "folder">, projectDir?: string | null): string {
  const shown = contextDisplayPath(file.path, projectDir)
  const separator = file.path.includes("\\") && !file.path.includes("/") ? "\\" : "/"
  return `\`${file.folder && !shown.endsWith(separator) ? `${shown}${separator}` : shown}\``
}

// ── the `@` being typed, and what replaces it ────────────────────────────────────────────────────────

// A file query runs over a path's characters — `@src/web/App.tsx`, `@App.t` — where a thread query stops
// at the first `/` (lib/threadMentions.ts mentionQueryAt). It opens after whitespace, an opening bracket
// or a quote, or at the start: never inside a word (an email address), and never after a `/` or `.`
// (`@types/node` written in a sentence is a package, not this).
const FILE_QUERY_BEFORE_CARET = /(?:^|[\s([{"'])@([^\s@`]*)$/u

/** The file query at the caret: where its `@` sits and what follows it so far. */
export function fileQueryAt(prose: string, caret: number | null): { start: number; query: string } | undefined {
  if (caret === null || caret > prose.length) return undefined
  const match = FILE_QUERY_BEFORE_CARET.exec(prose.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[1]!.length - 1, query: match[1]! }
}

/**
 * The prose with the `@query` at `start` (running on past the caret over the rest of its token) replaced
 * by `reference` and a space, and the caret after that space.
 */
export function insertFileReference(prose: string, start: number, caret: number, reference: string): { prose: string; caret: number } {
  let end = caret
  while (end < prose.length && !/[\s@`]/u.test(prose[end]!)) end++
  const after = prose.slice(end)
  const sep = /^\s/u.test(after) ? "" : " "
  const next = `${prose.slice(0, start)}${reference}${sep}${after}`
  return { prose: next, caret: start + reference.length + 1 }
}

/**
 * References spliced in at `at` (a caret, or the prose's end), each separated by a space, with a space
 * before where it would glue to a word and one after, and the caret after it all.
 */
export function insertReferencesAt(prose: string, at: number, references: readonly string[]): { prose: string; caret: number } {
  const before = prose.slice(0, at)
  const after = prose.slice(at)
  const lead = before && !/\s$/u.test(before) ? " " : ""
  const text = `${lead}${references.join(" ")}`
  const trail = /^\s/u.test(after) ? "" : " "
  return { prose: `${before}${text}${trail}${after}`, caret: before.length + text.length + 1 }
}

// ── what a drag from VS Code carries ─────────────────────────────────────────────────────────────────

/**
 * The drag types that say a drag came from VS Code's own workbench (its explorer, an editor tab, the
 * open editors list), lowercased as `DataTransfer.types` reports them. A plain `text/uri-list` is not
 * one: Chromium adds it to a file dragged from the desktop too, and that one is an attachment (a
 * screenshot), which the box's upload intake takes as it always did.
 */
const VSCODE_DRAG_TYPES = ["application/vnd.code.uri-list", "resourceurls", "codeeditors"]
/** Where the dropped resources are read from, in order. */
export const DROPPED_URI_TYPES = ["application/vnd.code.uri-list", "text/uri-list", "resourceurls"]

export function isVscodeDrag(types: readonly string[]): boolean {
  return types.some((type) => VSCODE_DRAG_TYPES.includes(type.toLowerCase()))
}

/**
 * The resources a drop names, as URI strings: a uri-list (one per line, `#` lines are comments) or VS
 * Code's `ResourceURLs` (a JSON array of them). Each once, in the order the drag listed them.
 */
export function droppedUris(lists: readonly (string | undefined)[]): string[] {
  const out: string[] = []
  for (const list of lists) {
    const trimmed = list?.trim()
    if (!trimmed) continue
    let entries: string[]
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        entries = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
      } catch {
        entries = []
      }
    } else entries = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    for (const entry of entries) if (!out.includes(entry)) out.push(entry)
  }
  return out
}
