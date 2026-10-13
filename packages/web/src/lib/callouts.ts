// CALLOUTS: a blockquote that opens with `[!TYPE]` is drawn as a labelled aside — GitHub's alert syntax.
//
//   > [!WARNING]
//   > This rewrites history on `main`.
//
// THE MARKER IS THE WHOLE TRIGGER, and it degrades to what it was: a renderer that has never heard of
// this prints a blockquote whose first line reads `[!WARNING]`, which still says what the author meant.
// A `:::warning` container prints its own delimiters at the reader instead.
//
// The grammar is GitHub's five types, plus the words a writer reaches for from the other dialects
// (Obsidian's `info` and `danger`, the docs frameworks' `hint` and `error`). Any other word is not a
// callout and the blockquote is left exactly as written: a quoted `[!sic]` is somebody's prose. One
// extension over GitHub: text after the marker on its own line is a title (`> [!WARNING] Before you
// merge`), which is how Obsidian spells it and what an author writes when the type alone says too little.
//
// Found on marked's TOKENS, not on the Markdown and not on the rendered HTML. A regex over the source
// would fire inside a fenced block that documents this very syntax; a pass over the HTML would have to
// tell `breaks: true`'s `[!NOTE]<br>` from a document's `[!NOTE]\n`, where the tokens say "the first
// line of the first paragraph" in both. Pure token logic, no DOM: marked runs it during render and the
// tests run it under `node --test`.

import type { Token, Tokens, TokenizerAndRendererExtension } from "marked"

export const CALLOUT_CLASS = "md-callout"
export const CALLOUT_TITLE_CLASS = "md-callout-title"

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution"

// Sentence case, like every label in the app.
const DEFAULT_TITLE: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
}

// An alias takes its type's default title as well as its look. Five words on screen for five
// treatments: `[!DANGER]` titled "Danger" beside a `[!CAUTION]` titled "Caution" would be two names for
// one thing, and the reader would look for the difference.
const ALIASES: Record<string, CalloutKind> = {
  info: "note",
  hint: "tip",
  attention: "warning",
  danger: "caution",
  error: "caution",
}

/** The callout type a marker word names, or null for a word that is not one. Case-insensitive. */
export function calloutKind(word: string): CalloutKind | null {
  const lower = word.toLowerCase()
  if (Object.hasOwn(DEFAULT_TITLE, lower)) return lower as CalloutKind
  return Object.hasOwn(ALIASES, lower) ? ALIASES[lower] : null
}

export type CalloutToken = {
  type: "callout"
  raw: string
  kind: CalloutKind
  /** The author's own title as inline tokens; empty for the type's default. */
  titleTokens: Token[]
  /** The body: every block of the quote after the marker line. */
  tokens: Token[]
}

// The marker, at the very start of the paragraph, and then nothing or a gap: `[!NOTE]suffix` is not one.
const MARKER = /^\[!([A-Za-z]+)\](?=[ \t]|\n|$)/

/**
 * Turn each blockquote in a block token list that opens with a callout marker into a `callout` token,
 * in place.
 *
 * Recurses into the block containers a blockquote can sit in — list items, a plain blockquote, and a
 * callout's own body — so a warning under a numbered step is still a warning.
 */
export function promoteCallouts(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === "list") {
      for (const item of (token as Tokens.List).items) promoteCallouts(item.tokens)
      continue
    }
    if (token.type !== "blockquote") continue
    const quote = token as Tokens.Blockquote
    const callout = readCallout(quote)
    if (callout) tokens[i] = callout as Token
    promoteCallouts(callout ? callout.tokens : quote.tokens)
  }
}

function readCallout(quote: Tokens.Blockquote): CalloutToken | null {
  // The marker opens the quote's FIRST paragraph. Blank `>` lines above it are marked's `space` tokens.
  const at = quote.tokens.findIndex((token) => token.type !== "space")
  const first = quote.tokens[at]
  if (first?.type !== "paragraph") return null
  const paragraph = first as Tokens.Paragraph
  const inline = paragraph.tokens
  // A marker is plain text. Anything else in first position — an escape (`\[!NOTE]`), a link made by a
  // `[!note]: …` definition — is the author saying it is not one.
  const head = inline[0]
  if (head?.type !== "text") return null
  const marker = MARKER.exec((head as Tokens.Text).text)
  if (!marker || !head.raw.startsWith(marker[0])) return null
  const kind = calloutKind(marker[1])
  if (!kind) return null

  // The marker's LINE is the title; the rest of the paragraph is body. Where that line ends is the one
  // thing the two `breaks` settings spell differently: a `br` token under `breaks: true` (and for a
  // hard break under either), a newline inside a text token otherwise.
  const titleTokens: Token[] = []
  const rest = inline.slice()
  rest[0] = sliceText(head as Tokens.Text, marker[0].length)
  while (rest.length > 0) {
    const token = rest[0]
    if (token.type === "br") {
      rest.shift()
      break
    }
    if (token.type === "text") {
      const newline = (token as Tokens.Text).text.indexOf("\n")
      if (newline < 0) {
        titleTokens.push(rest.shift()!)
        continue
      }
      titleTokens.push(sliceText(token as Tokens.Text, 0, newline))
      rest[0] = sliceText(token as Tokens.Text, newline + 1)
      break
    }
    // Emphasis or a code span that runs past the end of the line belongs to neither side cleanly; it
    // goes to the body whole, so nothing the author wrote is cut in two.
    if (token.raw.includes("\n")) break
    titleTokens.push(rest.shift()!)
  }
  trimEdges(titleTokens)
  trimEdges(rest)

  const body = quote.tokens.slice(at + 1)
  if (rest.length > 0) {
    const text = rest.map((token) => token.raw).join("")
    body.unshift({ ...paragraph, raw: text, text, tokens: rest } as Token)
  }
  return { type: "callout", raw: quote.raw, kind, titleTokens: literalHtml(titleTokens), tokens: body }
}

function sliceText(token: Tokens.Text, start: number, end?: number): Tokens.Text {
  return { ...token, raw: token.raw.slice(start, end), text: token.text.slice(start, end) }
}

// Drop the whitespace a split leaves on the outside of a run, and any text token that empties.
function trimEdges(tokens: Token[]): void {
  for (const [index, edge] of [[0, "trimStart"], [-1, "trimEnd"]] as const) {
    for (let token = tokens.at(index); token?.type === "text"; token = tokens.at(index)) {
      const text = token as Tokens.Text
      const trimmed = { ...text, raw: text.raw[edge](), text: text.text[edge]() }
      tokens.splice(index, 1, ...(trimmed.raw ? [trimmed] : []))
      if (trimmed.raw) break
    }
  }
}

// A title is a LABEL: inline Markdown in it is honoured (`code`, emphasis, a link), raw HTML is shown as
// the characters the author typed. marked passes an inline tag through verbatim, and a `<details>` or an
// unclosed `<b>` minted inside the title's `<p>` would restructure the block around it once the browser
// re-parses the string — so a tag here becomes text, and marked's text renderer escapes it.
function literalHtml(tokens: Token[]): Token[] {
  return tokens.map((token) => {
    if (token.type === "html") return { type: "text", raw: token.raw, text: token.raw, escaped: false } as Token
    const children = (token as { tokens?: Token[] }).tokens
    return Array.isArray(children) ? { ...token, tokens: literalHtml(children) } as Token : token
  })
}

// The token is only ever minted by `promoteCallouts`, which reads a blockquote marked has ALREADY
// tokenized. So this tokenizer claims nothing, exactly as the code-tabs extension does, and the
// extension exists for its renderer. `childTokens` is what lets marked's `walkTokens` reach a task
// list inside the body.
//
// Still a `<blockquote>`: it is one, the sanitizer already admits the tag with its class, and a surface
// that has no callout styles draws a quote with a bold first line.
export const calloutExtension: TokenizerAndRendererExtension = {
  name: "callout",
  level: "block",
  childTokens: ["titleTokens", "tokens"],
  tokenizer() {
    return undefined
  },
  renderer(this: { parser: { parse: (tokens: Token[]) => string; parseInline: (tokens: Token[]) => string } }, token) {
    const { kind, titleTokens, tokens } = token as CalloutToken
    const title = titleTokens.length > 0 ? this.parser.parseInline(titleTokens) : DEFAULT_TITLE[kind]
    return `<blockquote class="${CALLOUT_CLASS} ${CALLOUT_CLASS}-${kind}">`
      + `<p class="${CALLOUT_TITLE_CLASS}">${title}</p>\n${this.parser.parse(tokens)}</blockquote>\n`
  },
}
