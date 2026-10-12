import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import { renderAnsi } from "./ansi.ts"

// First-cut fenced-language set. Keep this explicit: importing highlight.js/lib/core plus only these
// grammars avoids shipping the package's ~190-language default bundle. Aliases are normalized here
// rather than guessed by highlightAuto, so unknown/user-controlled info strings always stay plaintext.
const GRAMMARS = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const

export const SUPPORTED_FENCE_LANGUAGES = Object.freeze({
  bash: ["bash", "sh", "shell", "zsh"],
  css: ["css"],
  diff: ["diff", "patch"],
  javascript: ["javascript", "js", "jsx", "mjs", "cjs"],
  json: ["json", "jsonc"],
  markdown: ["markdown", "md", "mdx"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  sql: ["sql"],
  typescript: ["typescript", "ts", "tsx", "mts", "cts"],
  xml: ["xml", "html", "svg"],
  yaml: ["yaml", "yml"],
} as const)

export type SupportedFenceLanguage = keyof typeof SUPPORTED_FENCE_LANGUAGES
// `ansi` is a fence language without an hljs grammar: terminal output whose escape sequences are drawn
// as colour (lib/ansi.ts). Fence-only — no file extension resolves to it.
export type FenceLanguage = SupportedFenceLanguage | "ansi" | "plaintext"

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)

const ALIAS_TO_LANGUAGE = new Map<string, SupportedFenceLanguage>()
for (const [language, aliases] of Object.entries(SUPPORTED_FENCE_LANGUAGES)) {
  for (const alias of aliases) ALIAS_TO_LANGUAGE.set(alias, language as SupportedFenceLanguage)
}

const PLAINTEXT_ALIASES = new Set(["", "text", "txt", "plain", "plaintext"])

// Filename → grammar, for the surfaces that highlight a FILE rather than a declared fence: a Read
// card's excerpt, a Write body. Deliberately derived from SUPPORTED_FENCE_LANGUAGES' own aliases —
// most extensions already ARE the fence alias (`ts`, `py`, `rs`, `yml`) — with only the handful that
// differ listed explicitly below. That way a grammar added to the set above reaches both surfaces at
// once and the two can never drift into disagreeing about what `.ts` is.
const EXTRA_EXTENSIONS: Readonly<Record<string, SupportedFenceLanguage>> = Object.freeze({
  htm: "xml",
  scss: "css",
  less: "css",
})

// Extensionless files whose NAME is the type. Kept short and certain: a wrong guess here paints a
// whole file in the wrong grammar, which reads worse than no colour at all.
const FILENAME_LANGUAGES: Readonly<Record<string, SupportedFenceLanguage>> = Object.freeze({
  dockerfile: "bash",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".gitignore": "bash",
  ".env": "bash",
})

// Resolve an absolute or repo-relative path to a grammar; anything unrecognized stays plaintext, for
// the same reason fences never guess. A dotfile with no other dot (`.gitignore`) has no extension —
// `lastIndexOf(".") > 0` is what keeps its leading dot from being read as one.
export function resolveFileLanguage(path?: string): FenceLanguage {
  const name = (path ?? "").split(/[/\\]/).pop()?.trim().toLowerCase() ?? ""
  if (!name) return "plaintext"
  if (FILENAME_LANGUAGES[name]) return FILENAME_LANGUAGES[name]
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return "plaintext"
  const ext = name.slice(dot + 1)
  return EXTRA_EXTENSIONS[ext] ?? ALIAS_TO_LANGUAGE.get(ext) ?? "plaintext"
}

// Marked passes the whole fence info string as `lang`; highlighting uses its first whitespace-delimited
// word just as Marked's stock renderer does. The remaining metadata is intentionally left untouched for
// the upstream signal/question fence parsers, which remove their special blocks before markdown render.
export function resolveFenceLanguage(infoString?: string): FenceLanguage {
  const declared = (infoString ?? "").trim().split(/\s+/, 1)[0].toLowerCase()
  if (PLAINTEXT_ALIASES.has(declared)) return "plaintext"
  if (declared === "ansi") return "ansi"
  return ALIAS_TO_LANGUAGE.get(declared) ?? "plaintext"
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

// The copy affordance is minted HERE, in the HTML string, rather than rendered as a component: a fenced
// block leaves this pipeline as markup that every surface injects with innerHTML, so there is no React
// element to hang a button on. That is the same constraint the sanitizer's local-file link already lives
// under (markdown.ts), and the click is likewise handled by one delegated listener — lib/copy-code.ts.
//
// The WRAPPER exists because `<pre>` is the scroller (`overflow-x: auto`): a button positioned inside it
// rides the content and slides out of view the moment a long line is scrolled, so the anchor has to be an
// element that does not scroll. A SPAN rather than a div for the reason markdown.ts's frameImage gives —
// this HTML is re-parsed by the browser when a surface injects it, and a non-phrasing wrapper makes the
// parser restructure the block around it; `.md-code` supplies the display/position it needs.
//
// The button carries no inline `<svg>`: the sanitizer drops svg WITH its subtree, so both glyphs (copy,
// and the check the delegated handler swaps to) are lucide paths carried as mask-image data URIs in
// styles.css, exactly as the markdown task marks are.
export const CODE_BLOCK_CLASS = "md-code"
export const CODE_COPY_CLASS = "md-code-copy"
export const CODE_COPIED_CLASS = "is-copied"
export const COPY_CODE_LABEL = "Copy code"

// Escaped, `hljs-*`-classed markup for one code body — WITHOUT any block chrome. The fenced-block
// renderer below wraps it in its own <pre>/<code>/copy-button; the transcript's non-markdown code
// surfaces (a Bash card's command, a Read card's excerpt — components/CodeBody.tsx) drop it straight
// into the <pre> they already own, so their layout, clamping and wrapping rules stay untouched.
//
// The output is safe to inject as-is: the input is PLAIN TEXT, so every character either comes back
// escaped by hljs or by escapeHtml, and the only markup in the result is hljs's own token spans (or,
// for `ansi`, lib/ansi.ts's styled spans, whose only attributes are fixed classes and a hex colour).
// That is why this needs no sanitizer pass, unlike the markdown pipeline (which has other HTML
// sources and therefore sanitizes everything).
export function highlightToHtml(text: string, language: FenceLanguage): string {
  if (language === "plaintext") return escapeHtml(text)
  if (language === "ansi") return renderAnsi(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    // A malformed grammar input must never take down transcript rendering. The raw text remains
    // visible, escaped, and selectable; there is deliberately no automatic language guessing.
    return escapeHtml(text)
  }
}

// One fenced body as its `<code>` element: the plain block below and a tab panel (lib/codeTabs.ts) are
// the same code inside different chrome, so they mint it in one place. Match Marked's stock code
// renderer: exactly one trailing LF is present in the resulting <code>, preserving selection/copy
// behavior for both complete and still-streaming (unclosed) fences.
export function renderCodeElement(text: string, language: FenceLanguage, name: string = language): string {
  const code = `${text.replace(/\n$/, "")}\n`
  return `<code class="hljs language-${name}">${highlightToHtml(code, language)}</code>`
}

// `title` is the accessible name — `aria-label` is not in the render allowlist.
export const CODE_COPY_BUTTON = `<button type="button" class="${CODE_COPY_CLASS}" title="${COPY_CODE_LABEL}"></button>`

export function renderHighlightedCode(text: string, infoString?: string): string {
  const language = resolveFenceLanguage(infoString)
  // A ```lightbox fence is a list of picture paths (lib/lightbox.ts), not code. It is escaped as plain
  // text like any unknown language, but keeps its NAME on the block: that class is how a surface that
  // injects a whole body as one block of HTML — a signal card, a question card, the file readers — finds
  // the fence and draws a gallery in its place (components/Lightbox.tsx useLightboxIslands). Anywhere
  // that pass does not run, it stays a readable code block.
  const name = (infoString ?? "").trim().toLowerCase() === "lightbox" ? "lightbox" : language
  // No whitespace anywhere inside the <pre>: it preserves it, so a newline before the <code> would print
  // as a blank first line. The button follows the block in DOM order so a keyboard walk reaches the code
  // before its affordance.
  return `<span class="${CODE_BLOCK_CLASS}"><pre>${renderCodeElement(text, language, name)}</pre>${CODE_COPY_BUTTON}</span>\n`
}
