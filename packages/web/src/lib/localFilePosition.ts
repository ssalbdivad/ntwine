import type { FilePosition } from "@ntwine/shared"

// THE PLACE IN A FILE a local-file link names, carried BESIDE its path on the element every producer
// tags — `data-local-path` holds the bare path, these hold the line. A link written `a.ts:12`,
// `a.ts#L12-L20` or `vscode://file/…:12:3` names one file and one place in it (shared
// file-position.ts), and the two travel separately so the reader is always handed the bare path while
// the external app is handed the line (openLocalFile's `line`/`column`/`endLine`). Until 2026-10-01 the
// suffix rode inside the path, where most producers dropped it and the one that kept it — the editor
// deep link — made the reader say "not found".
//
// Three attributes rather than one encoded string, so the markdown sanitizer can allowlist them by
// name (markdown.ts ALLOWED_ATTRS) and nothing ever has to parse an attribute back.

const LINE = "data-local-line"
const COLUMN = "data-local-col"
const END_LINE = "data-local-end-line"

/** The attribute names, for the sanitizer's allowlist. */
export const LOCAL_POSITION_ATTRS = [LINE, COLUMN, END_LINE] as const

/** The attributes for a position, as React props (`{...localPositionAttrs(p)}`); empty without one. */
export function localPositionAttrs(position: FilePosition | undefined): Record<string, string> {
  if (!position) return {}
  return {
    [LINE]: String(position.line),
    ...(position.column ? { [COLUMN]: String(position.column) } : {}),
    ...(position.endLine && position.endLine > position.line ? { [END_LINE]: String(position.endLine) } : {}),
  }
}

/** Stamp a position on an element a producer minted (markdown.ts, localFileCode.ts). */
export function stampLocalPosition(el: Element, position: FilePosition | undefined): void {
  for (const [name, value] of Object.entries(localPositionAttrs(position))) el.setAttribute(name, value)
}

function positive(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined
  const n = Number(value)
  return n >= 1 ? n : undefined
}

/**
 * The position a clicked element carries, or undefined. Validated rather than trusted: the attributes
 * survive the sanitizer, so an agent's raw HTML can set them, and a malformed one must read as "no
 * line" rather than reach the opener as NaN.
 */
export function localPositionOf(el: Element | null | undefined): FilePosition | undefined {
  const line = positive(el?.getAttribute(LINE) ?? null)
  if (line === undefined) return undefined
  const position: FilePosition = { line }
  const column = positive(el!.getAttribute(COLUMN))
  if (column !== undefined) position.column = column
  const endLine = positive(el!.getAttribute(END_LINE))
  if (endLine !== undefined && endLine > line) position.endLine = endLine
  return position
}
