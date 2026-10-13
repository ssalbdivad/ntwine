// A PLACE IN A FILE, as people and agents write it after a path. One grammar for the page (which reads
// it off links and inline code), the server (which hands it to an editor) and the VS Code extension
// (which writes it), so a reference one side writes is a reference the other side opens.
//
// Two spellings are recognised, both only at the very end of the string:
//
//   editor/compiler   `a.ts:12`  `a.ts:12:3`  `a.ts:12-20`  `a.ts:12:3-20`
//   GitHub fragment   `a.ts#L12` `a.ts#L12C3` `a.ts#L12-L20` `a.ts#L12-20`
//
// Pure and dependency-free on purpose: the extension bundles it, and pulling `@ntwine/shared`'s index
// (zod, yaml) into an editor extension for one regex would be absurd.

export interface FilePosition {
  /** 1-based line. */
  line: number
  /** 1-based column on `line`. */
  column?: number
  /** 1-based last line of a range; always >= `line` when present. */
  endLine?: number
}

const COLON_SUFFIX = /:(\d+)(?::(\d+))?(?:-(\d+))?$/
const FRAGMENT_SUFFIX = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/

function positionOf(line: string, column: string | undefined, endLine: string | undefined): FilePosition | undefined {
  const start = Number(line)
  if (!Number.isSafeInteger(start) || start < 1) return undefined
  const position: FilePosition = { line: start }
  const col = column === undefined ? NaN : Number(column)
  if (Number.isSafeInteger(col) && col >= 1) position.column = col
  const end = endLine === undefined ? NaN : Number(endLine)
  if (Number.isSafeInteger(end) && end > start) position.endLine = end
  return position
}

/**
 * Split a trailing position off a path. `{ path }` alone when there is none, so the caller can always
 * use `path`. A Windows drive colon is never mistaken for one: the suffix needs digits after its colon
 * and must end the string. A FILE whose name genuinely ends in `:12` is ambiguous by construction —
 * callers that can stat (the server) try the whole string first.
 */
export function splitFilePosition(raw: string): { path: string; position?: FilePosition } {
  const fragment = FRAGMENT_SUFFIX.exec(raw)
  if (fragment && fragment.index > 0) {
    const position = positionOf(fragment[1]!, fragment[2], fragment[3])
    if (position) return { path: raw.slice(0, fragment.index), position }
  }
  const colon = COLON_SUFFIX.exec(raw)
  if (colon && colon.index > 0) {
    const position = positionOf(colon[1]!, colon[2], colon[3])
    if (position) return { path: raw.slice(0, colon.index), position }
  }
  return { path: raw }
}

/** `a.ts:12:3` — the form `code -g`, `cursor -g`, `zed` and `subl` all take. The range end is dropped. */
export function goToArgument(path: string, position?: FilePosition): string {
  if (!position) return path
  return position.column ? `${path}:${position.line}:${position.column}` : `${path}:${position.line}`
}

/** `a.ts:12` / `a.ts:12-20` — how a reference reads in prose. */
export function formatFileReference(path: string, position?: Pick<FilePosition, "line" | "endLine">): string {
  if (!position) return path
  return position.endLine && position.endLine > position.line ? `${path}:${position.line}-${position.endLine}` : `${path}:${position.line}`
}
