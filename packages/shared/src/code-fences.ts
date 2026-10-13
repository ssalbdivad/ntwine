// Where a markdown text's fenced CODE BLOCKS are, so the scanners that hunt for ntwine's own openers
// (```question, ```done, ```awaiting) can ignore the ones a message is merely QUOTING.
//
// Every one of those scanners is a line-anchored regex over raw markdown with no notion of nesting, so
// a worker that documents the protocol — the correct authoring form being a ````-wrapped example around
// a ```question sample — had its sample hoisted OUT into a live answerable card, while the enclosing
// ```` delimiters were left behind as orphan prose that opened an unterminated code block and swallowed
// the rest of the message. Same root cause for a quoted ```done/```awaiting.
//
// Shared (not mirrored by hand in each package) because the web renderer and the server's derived
// pending-question flag must agree about what is a real opener; a divergence here is a thread that
// renders one way and is CLASSIFIED another.

// The half-open character range [start, end) INSIDE one fenced code block — from the first character
// after the opening fence line to the first character of the closing fence line.
export type FenceInterior = readonly [start: number, end: number]

// A fence line: up to 3 leading spaces, then a run of 3+ backticks or tildes, then the info string.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// CommonMark, kept to the parts that matter here: a backtick fence's info string may not contain a
// backtick (that is what makes ```` ```question ```` a CLOSER-proof opener); a closing fence is a bare
// run of the SAME character, at least as long as the opener, with nothing else on the line. An
// unclosed fence runs to the end of the text — exactly how a renderer treats it.
export function fencedInteriors(text: string): FenceInterior[] {
  const out: FenceInterior[] = []
  let offset = 0
  let open: { char: string; len: number; from: number } | null = null
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1 // the +1 is the "\n" the split consumed
    const m = line.replace(/\r$/, "").match(FENCE_LINE)
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
        out.push([open.from, offset])
        open = null
      }
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { char: m[1][0], len: m[1].length, from: Math.min(next, text.length) }
    }
    offset = next
  }
  if (open) out.push([open.from, text.length])
  return out
}

// A predicate over character offsets: true when that offset sits inside a fenced code block. Built once
// per text so a scanner can test every candidate opener without rescanning.
export function insideFence(text: string): (index: number) => boolean {
  const ranges = fencedInteriors(text)
  if (ranges.length === 0) return () => false
  return (index: number) => ranges.some(([start, end]) => index >= start && index < end)
}

// The same, counting the fence LINES as well as their interiors — everything a composer paints as code
// rather than prose. A `/name` on an opener's info string is part of the fence, not an invocation.
export function insideCodeFence(text: string): (index: number) => boolean {
  const inside = insideFence(text)
  return (index: number) => {
    if (inside(index)) return true
    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const lineEnd = text.indexOf("\n", index)
    const m = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, "").match(FENCE_LINE)
    return m !== null && !(m[1]![0] === "`" && m[2]!.includes("`"))
  }
}
