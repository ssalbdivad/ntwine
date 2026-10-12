// RENDERED DIFFS: a ```diff fence is drawn as rows — a tinted line per addition and deletion, the sign
// in its own column, line numbers when the diff carries hunk headers — instead of as coloured text.
// The code on each row is highlighted in the language of the file being changed:
//
//   ```ts-diff                    ```diff title="src/retry.ts"          ```diff
//   -const retries = 3            -const retries = 3                    --- a/src/retry.ts
//   +const retries = 5            +const retries = 5                    +++ b/src/retry.ts
//   ```                           ```                                   @@ -1,3 +1,3 @@
//                                                                       …
//
// THE LANGUAGE comes from the first of: the fence's name (`ts-diff`, `diff-ts`, or `diff lang="ts"`),
// the label's file name, the file the diff's own `+++` header names. `diff` alone, with none of those,
// is rows with uncoloured code — which is still the point of the block.
//
// highlight.js colours it, not the Edit card's tokenizer (lib/diff/highlight.ts): this is a Markdown
// fence, and the same source in a ```ts fence one paragraph up must come out in the same colours.
//
// Pure string logic, no DOM: marked runs it during render and the tests run it under `node --test`.
// The text content of the result is the fence's source byte for byte, because that is what the copy
// button reads — so every character of the diff is in a row, including the ones CSS hides.

import { splitHighlightedLines } from "./codeBody.ts"
import {
  escapeHtml,
  highlightToHtml,
  resolveFenceLanguage,
  resolveFileLanguage,
  type FenceLanguage,
} from "./syntaxHighlight.ts"

export const DIFF_ROW_CLASS = "md-diff-row"

export interface DiffFence {
  /** The language word the fence's name or `lang=` carries, or null when it names none. */
  declared: string | null
}

const LANG_KEY = /(?:^|\s)lang(?:uage)?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/i

/** Whether an info string asks for a diff, and in which language. Null for any other fence. */
export function parseDiffFence(infoString?: string): DiffFence | null {
  const info = (infoString ?? "").trim()
  const name = info.split(/\s+/, 1)[0].toLowerCase()
  const keyed = LANG_KEY.exec(info.slice(name.length))
  const key = keyed ? (keyed[1] ?? keyed[2] ?? keyed[3]).trim().toLowerCase() || null : null
  if (name === "diff" || name === "patch") return { declared: key }
  const named = /^(.+)-diff$/.exec(name) ?? /^diff-(.+)$/.exec(name)
  return named ? { declared: named[1] } : null
}

type RowKind = "add" | "del" | "ctx" | "hunk" | "file" | "meta"

interface DiffRow {
  kind: RowKind
  /** The line as written. */
  raw: string
  /** The number drawn in the gutter: the OLD file's for a deletion, the new file's otherwise. */
  line?: number
}

// `@@ -12,7 +12,9 @@ function retry()` — a count left out is 1.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// The lines git writes between `diff --git` and the first hunk. Read ONLY there (see `inHeader`): any
// of them is also a plausible line of somebody's code.
const EXTENDED_HEADER = /^(?:index [0-9a-f]+\.\.[0-9a-f]+|(?:new|deleted) file mode |(?:old|new) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |Binary files )/

function classify(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = []
  // Between a `diff --git` line and that file's first hunk.
  let inHeader = false
  // Lines the current hunk still owes each side, from its header. While the old side is owed one, a
  // line starting `--- ` is a deleted line whose text starts `-- `, not a file header.
  let oldLeft = 0
  let newLeft = 0
  let oldLine: number | null = null
  let newLine: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/^diff (?:--git|--cc|--combined|-\S+) /.test(raw) || /^Index: /.test(raw)) {
      rows.push({ kind: "file", raw })
      inHeader = true
      oldLeft = newLeft = 0
      oldLine = newLine = null
      continue
    }
    if (raw.startsWith("@@")) {
      const hunk = HUNK.exec(raw)
      rows.push({ kind: "hunk", raw })
      inHeader = false
      // A header that does not parse (`@@ … @@`, written by hand) still divides the diff; it just
      // cannot number what follows.
      oldLine = hunk ? Number(hunk[1]) : null
      newLine = hunk ? Number(hunk[3]) : null
      oldLeft = hunk ? Number(hunk[2] ?? 1) : 0
      newLeft = hunk ? Number(hunk[4] ?? 1) : 0
      continue
    }
    if (inHeader && EXTENDED_HEADER.test(raw)) {
      rows.push({ kind: /^index /.test(raw) ? "file" : "meta", raw })
      continue
    }
    if (oldLeft === 0 && newLeft === 0) {
      if (raw.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
        rows.push({ kind: "file", raw }, { kind: "file", raw: lines[i + 1] })
        i++
        inHeader = true
        oldLine = newLine = null
        continue
      }
    }
    inHeader = false
    if (raw.startsWith("\\ ")) {
      // `\ No newline at end of file`
      rows.push({ kind: "meta", raw })
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "add", raw, line: newLine ?? undefined })
      if (newLine !== null) newLine++
      if (newLeft > 0) newLeft--
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", raw, line: oldLine ?? undefined })
      if (oldLine !== null) oldLine++
      if (oldLeft > 0) oldLeft--
    } else {
      rows.push({ kind: "ctx", raw, line: newLine ?? undefined })
      if (oldLine !== null) oldLine++
      if (newLine !== null) newLine++
      if (oldLeft > 0) oldLeft--
      if (newLeft > 0) newLeft--
    }
  }
  return rows
}

// The path a `--- a/src/x.ts` / `+++ b/src/x.ts` line names: without git's `a/` `b/` prefix, and
// without the tab and timestamp plain `diff -u` appends. `/dev/null` is the missing side of an added
// or deleted file, not a name.
function headerPath(raw: string): string | null {
  const path = raw.slice(4).split("\t", 1)[0].trim().replace(/^[ab]\//, "")
  return path && path !== "/dev/null" ? path : null
}

/** The files a diff's own headers name, in order — one entry per `---`/`+++` pair. */
function filesOf(rows: readonly DiffRow[]): string[] {
  const files: string[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "file" || !rows[i].raw.startsWith("--- ")) continue
    const next = rows[i + 1]
    const path = (next?.raw.startsWith("+++ ") ? headerPath(next.raw) : null) ?? headerPath(rows[i].raw)
    if (path) files.push(path)
  }
  return files
}

export interface RenderedDiffFence {
  /** One element per line, for the inside of the fence's `<code>`. */
  html: string
  additions: number
  deletions: number
  /** The file the diff is of, when its own headers name exactly one. */
  file: string | null
  /** Digits in the widest line number, or 0 when the diff carries no hunk header to number from. */
  digits: number
  lines: number
}

const plainLines = (lines: readonly string[]) => lines.map(escapeHtml)

// Highlight one side of a run of rows AS ONE TEXT, which is what keeps a template literal or a block
// comment correct across lines, then hand back a line each.
function highlightSide(lines: readonly string[], language: FenceLanguage): string[] {
  if (lines.length === 0) return []
  if (language === "plaintext" || language === "ansi") return plainLines(lines)
  return splitHighlightedLines(highlightToHtml(lines.join("\n"), language))
}

/**
 * A diff's rows as markup.
 *
 * `declared` is the fence's own language word and `label` its title, if it has one; see the header for
 * the order they are consulted in.
 */
export function renderDiffFence(text: string, opts: { declared?: string | null; label?: string } = {}): RenderedDiffFence {
  const lines = text.replace(/\n$/, "").split("\n")
  const rows = classify(lines)
  const files = filesOf(rows)
  // A label that is not a file name ("Before") resolves to plaintext, which is no answer: ask the diff.
  const labelled = resolveFileLanguage(opts.label)
  const language: FenceLanguage = opts.declared
    ? resolveFenceLanguage(opts.declared)
    : labelled !== "plaintext" ? labelled : resolveFileLanguage(files[0])

  // A unified diff prefixes EVERY line, context included, with one column: a space, `+` or `-`. A diff
  // written by hand usually prefixes only the lines that changed and leaves context flush left. Taking
  // a column off those would eat the first character of each, so the context of a diff with no hunk
  // header and any flush-left context line is read as unprefixed throughout.
  const strict = rows.some((row) => row.kind === "hunk")
    || !rows.some((row) => row.kind === "ctx" && row.raw !== "" && !row.raw.startsWith(" "))
  const split = (row: DiffRow): [sign: string, body: string] =>
    row.kind === "ctx" && !(strict && row.raw.startsWith(" ")) ? ["", row.raw] : [row.raw[0], row.raw.slice(1)]

  const numbered = rows.some((row) => row.line !== undefined)
  const out: string[] = []
  let additions = 0
  let deletions = 0
  let widest = 0

  // Each RUN of changed and context rows is highlighted on its own, old side and new side separately:
  // a hunk is a window onto a file, and a string opened in one must not swallow the next.
  for (let start = 0; start < rows.length;) {
    const row = rows[start]
    if (row.kind === "hunk" || row.kind === "file" || row.kind === "meta") {
      out.push(`<span class="${DIFF_ROW_CLASS} md-diff-${row.kind}">${escapeHtml(row.raw)}\n</span>`)
      start++
      continue
    }
    let end = start
    while (end < rows.length && (rows[end].kind === "add" || rows[end].kind === "del" || rows[end].kind === "ctx")) end++
    const run = rows.slice(start, end).map((each) => ({ row: each, parts: split(each) }))
    const before = highlightSide(run.filter(({ row: r }) => r.kind !== "add").map(({ parts }) => parts[1]), language)
    const after = highlightSide(run.filter(({ row: r }) => r.kind !== "del").map(({ parts }) => parts[1]), language)
    let b = 0
    let a = 0
    for (const { row: each, parts: [sign] } of run) {
      // Context is in both sides; draw it from the new one, the side the reader is being shown.
      const body = each.kind === "del" ? before[b] : after[a]
      if (each.kind !== "add") b++
      if (each.kind !== "del") a++
      if (each.kind === "add") additions++
      if (each.kind === "del") deletions++
      if (each.line !== undefined) widest = Math.max(widest, each.line)
      const gutter = numbered
        ? `<span class="md-diff-num"${each.line === undefined ? "" : ` data-line="${each.line}"`}></span>`
        : ""
      out.push(`<span class="${DIFF_ROW_CLASS} md-diff-${each.kind}">${gutter}`
        + `<span class="md-diff-sign">${escapeHtml(sign)}</span>`
        + `<span class="md-diff-text">${body ?? ""}\n</span></span>`)
    }
    start = end
  }

  return {
    html: out.join(""),
    additions,
    deletions,
    file: files.length === 1 ? files[0] : null,
    digits: numbered ? String(widest).length : 0,
    lines: lines.length,
  }
}
