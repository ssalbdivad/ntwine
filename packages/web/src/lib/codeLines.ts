// HIGHLIGHTED LINES: a `{4,7-9}` group on a fence's info string marks those lines of the block.
//
//   ```ts {2,4-5}
//   const a = 1
//   const b = 2        ← marked
//   ```
//
// The braces are the spelling Docusaurus, Nextra, Fumadocs, VitePress and Starlight share, and the one
// Mintlify writes after `highlight=`; any numeric brace group counts, so `highlight={2}` and `mark={2}`
// are read too. Numbers are 1-based, and a number past the end of the block marks nothing.
//
// Pure string logic, no DOM: marked runs it during render and the tests run it under `node --test`.

import { splitHighlightedLines } from "./codeBody.ts"

export const CODE_LINE_CLASS = "md-line"
export const CODE_LINE_MARKED_CLASS = "is-marked"

/** Inclusive 1-based line ranges, as written. */
export type LineMarks = ReadonlyArray<readonly [number, number]>

// Digits, commas, hyphens (or the en dash an editor swaps in) and spaces — nothing else, so a brace
// group that is somebody's option (`{title: "x"}`) is not half-read as a range.
const MARK_GROUP = /\{\s*(\d[\d\s,–-]*)\}/

/** The lines a fence's info string marks, or null when it marks none. */
export function parseLineMarks(infoString?: string): LineMarks | null {
  const group = MARK_GROUP.exec(infoString ?? "")
  if (!group) return null
  const marks: Array<readonly [number, number]> = []
  for (const part of group[1].split(/[\s,]+/)) {
    const range = /^(\d{1,7})(?:[–-](\d{1,7}))?$/.exec(part)
    if (!range) continue
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from >= 1 && to >= from) marks.push([from, to])
  }
  return marks.length > 0 ? marks : null
}

export function isMarkedLine(marks: LineMarks, line: number): boolean {
  return marks.some(([from, to]) => line >= from && line <= to)
}

/**
 * One block-level span per line of highlighted code, the marked ones classed.
 *
 * `html` is `highlightToHtml`'s output for a body ending in exactly one LF. Each line keeps its own LF
 * INSIDE its span, so the `<code>`'s text content is still the source byte for byte — that is what the
 * copy button reads — and a token that spans lines (a block comment, a template literal) is closed and
 * re-opened at each break by `splitHighlightedLines`.
 */
export function renderLinedCode(html: string, marks: LineMarks): string {
  const lines = splitHighlightedLines(html)
  // The body's closing LF leaves one empty line after the last real one — empty of TEXT, though it can
  // still hold the tags of a token left open at the end of the input (an unterminated string).
  if (lines.at(-1)?.replace(/<[^>]*>/g, "") === "") lines.pop()
  return lines
    .map((line, i) =>
      `<span class="${CODE_LINE_CLASS}${isMarkedLine(marks, i + 1) ? ` ${CODE_LINE_MARKED_CLASS}` : ""}">${line}\n</span>`)
    .join("")
}
