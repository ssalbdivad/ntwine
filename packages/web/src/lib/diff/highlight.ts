// A tiny, dependency-free syntax highlighter — the "custom highlighter" ntwine uses instead of a
// WASM grammar engine (Shiki) or a server round-trip (Pierre). It is deliberately approximate: a
// single stateful character scan driven by a per-language config (comments / strings / keywords),
// classifying each run into a coarse token kind. Not grammar-accurate, but O(n) over the text with
// no async, no bundle weight, and good-enough color for a diff preview.
//
// It returns one token array PER LINE (aligned 1:1 with text.split("\n")), because the diff aligner
// needs to pull the tokens for a specific old/new line number.

// Colour buckets, not grammar categories. `key` is the newest and exists to MATCH highlight.js: hljs
// classes a yaml key, a toml key and an html attribute alike as `hljs-attr`, and reusing `type` here
// painted the same `timeout-minutes:` orange in an Edit diff and blue in the Read card above it —
// measured in the running app, which is the only place the two engines are ever seen side by side.
export type TokenKind = "kw" | "type" | "str" | "com" | "num" | "fn" | "key" | "punct" | "op" | "plain"

export interface DiffToken {
  text: string
  kind: TokenKind
}

interface LangConfig {
  line: string | null // line-comment marker, e.g. "//" or "#"
  block: [string, string] | null // block-comment delimiters, e.g. ["/*", "*/"]
  quotes: string[] // string delimiters; a backtick, when present, allows multi-line strings
  keywords: Set<string>
  types: Set<string>
  // Rules tried in order at the START of every line, before the character scan resumes. The
  // config-driven languages above are all statement-oriented, where position in the line carries no
  // meaning; the DATA formats are the opposite — what makes `retries:` a key in yaml is that it opens
  // its line, and nothing about the identifier itself says so. Each capture group becomes one token
  // with the kind at the same index; an unmatched optional group is skipped.
  lineStart?: Array<{ re: RegExp; kinds: TokenKind[] }>
  // An identifier followed (across spaces and tabs) by one of these characters reads as a KEY —
  // a toml `key = …`, an html `attr="…"`.
  keyChars?: string
  // An identifier sitting immediately after `<` or `</` reads as a markup element name.
  tagNames?: boolean
}

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const C_FAMILY_KW = set(`
  break case catch class const continue debugger default delete do else enum export extends
  false finally for function if import in instanceof new null return super switch this throw
  true try typeof var void while with yield async await let static get set of as from
  interface type namespace declare readonly public private protected implements abstract
  package struct func go defer chan map fn impl trait mut pub use mod match loop where
  int long short float double char boolean byte final synchronized volatile transient native
`)

const C_FAMILY_TYPES = set(`
  string number boolean object symbol bigint unknown any never void undefined
  String Number Boolean Object Array Promise Map Set Record Partial
  i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 str Vec Option Result Box
  int8 int16 int32 int64 uint float32 float64 error rune
`)

const LANGS: Record<string, LangConfig> = {
  typescript: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  javascript: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  go: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  rust: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  java: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  c: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  cpp: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  css: { line: null, block: ["/*", "*/"], quotes: ['"', "'"], keywords: set("important media supports keyframes import from to"), types: new Set() },
  json: { line: null, block: null, quotes: ['"'], keywords: set("true false null"), types: new Set() },
  python: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set(`
      def class return if elif else for while break continue pass import from as with try except
      finally raise lambda yield global nonlocal del assert async await and or not in is None True
      False self lambda`),
    types: set("int float str bool list dict set tuple bytes object"),
  },
  shell: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set("if then else elif fi for while do done case esac in function return export local echo cd exit set unset source"),
    types: new Set(),
  },
  // The DATA formats below exist because lang.ts was mapping .yaml / .toml / .html to language ids
  // this table had no entry for. `highlightLines` falls through to one plain token per line for an
  // unknown id, so every yaml, toml and html diff in the app rendered completely uncoloured — and
  // silently, since nothing distinguishes "no grammar" from "nothing to colour".
  yaml: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set("true false null yes no on off ~"),
    types: new Set(),
    // A key is the run that OPENS a line (optionally after a `- ` sequence marker) and ends at a
    // colon. Quoted keys are matched too, so a key holding a space or a colon still reads as one.
    lineStart: [{
      re: /^([ \t]*)(- +)?("[^"\n]*"|'[^'\n]*'|[A-Za-z_][\w.\-/]*)([ \t]*)(:)/,
      kinds: ["plain", "punct", "key", "plain", "punct"],
    }],
  },
  toml: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set("true false"),
    types: new Set(),
    keyChars: "=",
    // `[table]` / `[[array.of.tables]]` — a header, not an array literal, so it takes the section
    // colour rather than being scanned as brackets around identifiers.
    lineStart: [{ re: /^([ \t]*)(\[\[?[^\]\n]*\]\]?)/, kinds: ["plain", "fn"] }],
  },
  html: {
    line: null, block: ["<!--", "-->"], quotes: ['"', "'"],
    keywords: new Set(),
    types: new Set(),
    keyChars: "=",
    tagNames: true,
  },
}

// End of the line containing index `i` — the window a lineStart rule is matched against, so an
// unanchored `.` in one of those regexes can never run past its own line.
const lineEnd = (text: string, i: number) => {
  const at = text.indexOf("\n", i)
  return at === -1 ? text.length : at
}

// The next character at or after `j` that is not a space or tab; "" at end of text. Used to decide
// whether an identifier is a KEY, which stays true across the padding in `key   = value`.
const nextNonSpace = (text: string, j: number) => {
  let k = j
  while (k < text.length && (text[k] === " " || text[k] === "\t")) k++
  return text[k] ?? ""
}

// The language ids this tokenizer can actually colour. lang.ts checks its filename map against this
// rather than trusting it, so a map entry for a grammar that was never written degrades to "text"
// (visibly unhighlighted) instead of silently reaching `highlightLines` and falling out as plain.
export const HIGHLIGHTED_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(LANGS))

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c)
const isDigit = (c: string) => c >= "0" && c <= "9"
const PUNCT = new Set("{}()[];,.")
const OP = new Set("+-*/%=<>!&|^~?:@")

// Scan the whole text into a flat token stream (tokens may embed "\n" for multi-line comments,
// strings, and whitespace runs). splitLines then slices it back into per-line arrays.
function scan(text: string, cfg: LangConfig): DiffToken[] {
  const toks: DiffToken[] = []
  const n = text.length
  const push = (t: string, kind: TokenKind) => t && toks.push({ text: t, kind })
  let i = 0

  while (i < n) {
    const c = text[i]

    // Line-start rules run before everything else, and only at a real line start, so a colon inside a
    // yaml VALUE (`url: https://x`) can never be mistaken for a second key.
    if (cfg.lineStart && (i === 0 || text[i - 1] === "\n")) {
      let matched = false
      for (const rule of cfg.lineStart) {
        const m = rule.re.exec(text.slice(i, lineEnd(text, i)))
        if (!m) continue
        for (let g = 1; g < m.length; g++) push(m[g] ?? "", rule.kinds[g - 1] ?? "plain")
        i += m[0].length
        matched = true
        break
      }
      if (matched) continue
    }

    if (cfg.block && text.startsWith(cfg.block[0], i)) {
      const at = text.indexOf(cfg.block[1], i + cfg.block[0].length)
      const stop = at === -1 ? n : at + cfg.block[1].length
      push(text.slice(i, stop), "com")
      i = stop
      continue
    }

    if (cfg.line && text.startsWith(cfg.line, i)) {
      let end = text.indexOf("\n", i)
      if (end === -1) end = n
      push(text.slice(i, end), "com")
      i = end
      continue
    }

    if (cfg.quotes.includes(c)) {
      const multiline = c === "`"
      let j = i + 1
      while (j < n) {
        if (text[j] === "\\") {
          j += 2
          continue
        }
        if (text[j] === c) {
          j++
          break
        }
        if (text[j] === "\n" && !multiline) break // unterminated single/double string stops at EOL
        j++
      }
      push(text.slice(i, j), "str")
      i = j
      continue
    }

    if (isDigit(c)) {
      let j = i + 1
      while (j < n && /[0-9a-fA-FxXbBoO_.]/.test(text[j])) j++
      push(text.slice(i, j), "num")
      i = j
      continue
    }

    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdent(text[j])) j++
      const word = text.slice(i, j)
      const kind: TokenKind = cfg.keywords.has(word)
        ? "kw"
        : cfg.types.has(word)
          ? "type"
          : cfg.tagNames && (text[i - 1] === "<" || (text[i - 1] === "/" && text[i - 2] === "<"))
            ? "kw" // a markup element name, opening or closing
            : cfg.keyChars && cfg.keyChars.includes(nextNonSpace(text, j))
              ? "key" // `key = value`, `attr="value"`
              : text[j] === "(" // an identifier immediately followed by "(" reads as a call/definition
                ? "fn"
                : "plain"
      push(word, kind)
      i = j
      continue
    }

    if (PUNCT.has(c)) {
      push(c, "punct")
      i++
      continue
    }

    if (OP.has(c)) {
      let j = i + 1
      while (j < n && OP.has(text[j])) j++
      push(text.slice(i, j), "op")
      i = j
      continue
    }

    // Everything else (whitespace, unknown chars) — group into a plain run, but never past a char a
    // real branch above would claim, so nothing gets mis-swallowed.
    let j = i + 1
    while (
      j < n &&
      !isIdentStart(text[j]) &&
      !isDigit(text[j]) &&
      !cfg.quotes.includes(text[j]) &&
      !PUNCT.has(text[j]) &&
      !OP.has(text[j]) &&
      !(cfg.line && text.startsWith(cfg.line, j))
    ) {
      j++
    }
    push(text.slice(i, j), "plain")
    i = j
  }

  return toks
}

// Slice a flat token stream (whose tokens may contain "\n") into one array per source line.
function splitLines(toks: DiffToken[]): DiffToken[][] {
  const lines: DiffToken[][] = [[]]
  for (const tok of toks) {
    const parts = tok.text.split("\n")
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push([])
      if (parts[p]) lines[lines.length - 1].push({ text: parts[p], kind: tok.kind })
    }
  }
  return lines
}

// Public: one DiffToken[] per line of `text`, length === text.split("\n").length. Empty text → [].
// Unknown language → each line is a single "plain" token (no highlighting, still line-aligned).
export function highlightLines(text: string, lang: string): DiffToken[][] {
  if (text === "") return []
  const cfg = LANGS[lang]
  if (!cfg) return text.split("\n").map((l) => (l ? [{ text: l, kind: "plain" as const }] : []))
  return splitLines(scan(text, cfg))
}
