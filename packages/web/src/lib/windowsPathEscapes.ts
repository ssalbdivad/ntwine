import { Lexer } from "marked"
import type { Token, Tokens } from "marked"
import { childArrays } from "./githubAutolink.ts"

// A Windows path is written with backslashes, and CommonMark reads a backslash before punctuation as
// an ESCAPE. `D:\Development\CloudIPMSjb\.ntwine\threads\x.md` therefore renders as
// `D:\Development\CloudIPMSjb.ntwine\threads\x.md`: `\D`, `\t` and `\x` survive because a letter is
// not punctuation, while `\.` collapses to `.` — one directory silently fused with the next. marked
// applies the rule in prose (an `escape` token) and in a link or image DESTINATION (the tokenizer
// unescapes `href`), so both the label the reader sees and the path the click opens were wrong, and
// the opener was handed a file that does not exist. Every scratch directory is `.ntwine`, every
// settings directory is `.claude`, so on Windows the mangled shape was the common case, not an edge.
//
// Inside a Windows path a backslash is a separator, never an escape, so this pass puts the byte back.
// It runs on TOKENS rather than the source for the same reason the GitHub autolinker does: a fenced
// block and a code span are literal by construction and never see it, and nothing here can change
// what marked chose to tokenize — only the text an escape renders as and the href a link carries.

// A destination that is a Windows drive path as the author wrote it. `x://host/p` is a one-letter URL
// scheme, not a drive: only a BACKSLASH after the colon makes a drive path. A doubled `X:\\` is an
// author escaping on purpose — marked's unescape already turns it into the right path — so it is left alone.
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\\(?!\\)/

// Where a drive path starts in prose: a letter at a word boundary, then `:` and `\`. Everything after it up
// to the next whitespace is the path. A path with spaces cannot be told from prose in a text token, so
// the run stops at whitespace — the same convention the bare-URL autolinker relies on, and the shape
// agents actually write.
const DRIVE = /(?<![A-Za-z0-9])[A-Za-z]:\\/

// marked's own link grammar, re-applied to a link token's `raw` to read the destination back BEFORE
// the tokenizer's unescape. The token carries only the unescaped href; the raw source still has the
// author's bytes.
const LINK_RULE = Lexer.rules.inline.normal.link

// The walk's view of the current whitespace-free run of prose: whether a drive has opened a path in it,
// and its last three characters — enough for a drive whose letter, colon and backslash straddle tokens
// (marked ends a text token before every backslash, and `C:\.ntwine`'s only backslash IS the escape),
// plus the character the letter must not follow. Constant-size on purpose: carrying the whole run and
// re-scanning it per token made one long unbroken word quadratic (80k characters took 13s to render).
type Run = { inPath: boolean; tail: string }

function extendRun(run: Run, raw: string): void {
  let start = raw.length
  while (start > 0 && !/\s/.test(raw[start - 1])) start--
  if (start > 0) {
    run.inPath = false
    run.tail = ""
  }
  const text = run.tail + raw.slice(start)
  run.inPath ||= DRIVE.test(text)
  run.tail = text.slice(-3)
}

// A link or image whose destination is a Windows drive path: restore the destination as written. The
// href is tested only for its drive letter, because the unescape it went through may have eaten the
// backslash after the colon (`C:\.ntwine\x` arrives as `C:.ntwine\x`).
function restoreDestination(token: Tokens.Link | Tokens.Image): void {
  if (!/^[a-zA-Z]:/.test(token.href)) return
  const cap = LINK_RULE.exec(token.raw)
  if (!cap) return
  let dest = cap[2].trim()
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1)
  if (WINDOWS_ABSOLUTE_PATH.test(dest)) token.href = dest
}

/**
 * Put the separator back into every Windows path marked read an escape out of. Mutates in place.
 *
 * Prose: an `escape` token inside an unbroken `X:\…` run becomes the two literal characters it was
 * written as. `\\` is left alone — an author who doubles every backslash is writing Markdown
 * deliberately, and that form already renders correctly. Destinations: a link or image whose href is a
 * drive path takes the destination exactly as written in its raw source.
 */
export function restoreWindowsPathEscapes(tokens: Token[]): void {
  const run: Run = { inPath: false, tail: "" }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === "link" || token.type === "image") restoreDestination(token as Tokens.Link)
    const children = childArrays(token)
    for (const array of children) restoreWindowsPathEscapes(array)
    if (token.type === "text" && children.length === 0) {
      extendRun(run, token.raw)
      continue
    }
    if (token.type === "escape") {
      extendRun(run, token.raw)
      if (token.raw !== "\\\\" && run.inPath) {
        tokens[i] = { type: "text", raw: token.raw, text: token.raw } satisfies Tokens.Text
      }
      continue
    }
    run.inPath = false
    run.tail = ""
  }
}
