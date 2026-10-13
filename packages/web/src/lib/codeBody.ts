import { highlightToHtml, type FenceLanguage } from "./syntaxHighlight.ts"

// Highlighted markup for the transcript's NON-markdown code surfaces: a Bash card's command, a Read
// card's file excerpt, a background shell's command. Markdown fences have their own renderer
// (syntaxHighlight.ts `renderHighlightedCode`) because they also mint block chrome and a copy button;
// these surfaces already own their `<pre>`, so all they need is the inner markup.
//
// Everything here is layout-NEUTRAL by design. The text content of the result is byte-identical to the
// plain string it replaces, so each surface keeps exactly the wrapping, clamping, selection and copy
// behaviour it has today — only colour is added.

// hljs emits a fragment of nested `<span class="hljs-…">` around already-escaped text, and a token may
// span a newline (a block comment, a template literal). Splitting that fragment on "\n" therefore has
// to close every span still open at the break and re-open it on the next line, or the first multi-line
// comment in a file swallows the rest of the block. Text can never contain a bare "<" — hljs escapes it
// — so a "<" only ever starts a tag.
const TOKEN = /<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g

export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let line = ""
  for (const [token] of html.matchAll(TOKEN)) {
    if (token === "\n") {
      lines.push(line + "</span>".repeat(open.length))
      line = open.join("")
    } else if (token === "</span>") {
      open.pop()
      line += token
    } else if (token.startsWith("<span")) {
      open.push(token)
      line += token
    } else {
      line += token
    }
  }
  lines.push(line + "</span>".repeat(open.length))
  return lines
}

// Claude's Read tool returns its excerpt in `cat -n` form — a right-aligned line number, a TAB, then the
// source. Highlighting that verbatim would feed a stray integer to the grammar at the head of every
// line, so the gutter is split off, the source is highlighted AS ONE TEXT (which is what keeps a block
// comment or a template literal correct across lines), and the numbers are re-attached as their own
// muted spans. A blank source line still carries its number, so the prefix is matched without requiring
// anything after the tab.
const CAT_N_LINE = /^(\s*\d+\t)([\s\S]*)$/

// A numbered line for a BLANK source line, whose tab has been trimmed off the end. Seen on the real
// wire, not theorised: a seeded excerpt ending in an empty line arrived as "    14" with no tab, and
// because the check below demands every line match, that one line turned the highlighting off for the
// whole card. Trailing whitespace is normalised at enough points between a tool result and this
// renderer that requiring the tab is simply the wrong contract.
const CAT_N_BARE = /^\s*\d+$/

// A file excerpt is only treated as numbered when ALL of its non-empty lines carry a prefix AND at
// least one carries a real tabbed one. Both halves matter: without the first, a prose tool result that
// merely opens with "1\t" has its whole body eaten as gutters; without the second, a data file whose
// every line IS a bare number would be rendered as nothing but line numbers.
function isLineNumbered(lines: string[]): boolean {
  let candidates = 0
  let numbered = 0
  let tabbed = 0
  for (const line of lines) {
    if (!line.trim()) continue
    candidates++
    if (CAT_N_LINE.test(line)) { numbered++; tabbed++ } else if (CAT_N_BARE.test(line)) numbered++
  }
  return candidates > 0 && numbered === candidates && tabbed > 0
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;")
}

export const CODE_GUTTER_CLASS = "ntwine-code-gutter"

// The markup for one code body. `language` is the grammar to use; "plaintext" escapes and returns the
// text unchanged, which is the honest result for anything we have no grammar for.
export function renderCodeBody(text: string, language: FenceLanguage): string {
  const lines = text.split("\n")
  if (!isLineNumbered(lines)) return highlightToHtml(text, language)

  const gutters: string[] = []
  const sources: string[] = []
  for (const line of lines) {
    const match = CAT_N_LINE.exec(line)
    if (match) {
      gutters.push(match[1])
      sources.push(match[2])
    } else if (line.trim() && CAT_N_BARE.test(line)) {
      gutters.push(line)
      sources.push("")
    } else {
      gutters.push("")
      sources.push(line)
    }
  }
  const highlighted = splitHighlightedLines(highlightToHtml(sources.join("\n"), language))
  return gutters
    .map((gutter, i) => (gutter ? `<span class="${CODE_GUTTER_CLASS}">${escapeHtml(gutter)}</span>` : "") + (highlighted[i] ?? ""))
    .join("\n")
}
