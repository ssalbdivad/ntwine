// CODE TABS: consecutive fenced blocks that each carry a LABEL are drawn as one block with a tab per
// fence, and a lone labelled fence gets its label as a title bar.
//
//   ```bash npm
//   npm install frizz
//   ```
//
//   ```bash pnpm
//   pnpm add frizz
//   ```
//
// THE LABEL IS THE WHOLE TRIGGER, and there is no wrapper. A run of fences is what the author would
// write anyway, so the same text is a stack of ordinary code blocks in a terminal, on GitHub and in any
// renderer that has never heard of this — where a `<CodeGroup>` or a `:::tabs` container prints its own
// delimiters at the reader. And a tab HIDES every block but one, so grouping has to be something the
// author asked for: two unlabelled fences in a row are routinely a command and its output, which the
// reader needs side by side. A label is also the one thing a tab cannot be drawn without.
//
// The grammar is the union of what the docs frameworks spell, because an agent writes it from memory
// and every one of these is unambiguous: Mintlify's bare tail (```` ```bash npm ````), Docusaurus's and
// Starlight's `title="…"`, Nextra's `filename="…"`, Fumadocs' `tab="…"`, VitePress's `[label]`.
//
// This file is the GRAMMAR and the grouping; lib/codeBlock.ts draws the result, as it draws every other
// fenced block. Pure string and token logic, no DOM: marked runs it during render and the tests run it
// under `node --test`. The click that switches a tab is one delegated listener
// (lib/switch-code-tab.ts), for the reason lib/copy-code.ts gives — the markup is injected as an HTML
// string.

import type { Token, Tokens } from "marked"

export const CODE_TABS_CLASS = "md-code-tabs"
export const CODE_TABLIST_CLASS = "md-code-tablist"
export const CODE_TAB_CLASS = "md-code-tab"
export const CODE_TITLE_CLASS = "md-code-title"
export const CODE_PANEL_CLASS = "md-code-panel"
export const CODE_TAB_ACTIVE_CLASS = "is-active"

export interface FenceLabel {
  label: string
  /**
   * True when the label can only be a name: `title="…"`, `[…]`, or a bare file name. Words after the
   * language that are none of those are not. Only an explicit one titles a fence standing alone — see
   * `groupCodeTabs`.
   */
  explicit: boolean
  /** The info string's language word, or "" when it opens straight into the label (```` ```title="a.ts" ````). */
  language: string
}

// `title="a b.ts"`, `filename='x.ts'`, `tab=npm`. The key list is every spelling a framework uses for
// "what this block is called"; anything else with an `=` is somebody's option and is dropped below.
const KEYED_LABEL = /(?:^|\s)(?:title|filename|file|name|label|tab)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']\S*))/i
const BRACKETED_LABEL = /(?:^|\s)\[([^\]]+)\]/
// What other renderers hang on a fence and nobody means as a name: a `{1,3-5}` line range, a
// `key=value` option, and the bare switches below. Stripped before the bare tail is read, so
// ```` ```ts {2} showLineNumbers ```` is still an unlabelled block.
const META_GROUP = /\{[^}]*\}|[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g
const META_FLAGS = new Set([
  "showlinenumbers", "linenumbers", "lines", "wrap", "nowrap", "copy", "nocopy", "expandable",
  "collapse", "collapsed", "twoslash", "live", "noinline", "frame",
])
// Past this a tail is a sentence, not a name. Long enough for a repo-relative path; the tab truncates.
const LABEL_MAX = 80
const QUOTED = /^(["'`])(.*)\1$/
// One word ending in a file extension: ```` ```ts src/server.ts ````. A bare tail of that shape names
// the file as surely as `title=` would, so it counts as explicit.
const FILE_LIKE = /^[^\s]*\.[A-Za-z][A-Za-z0-9]{0,7}$/

function cleanLabel(raw: string | undefined): string {
  let label = (raw ?? "").trim()
  const quoted = QUOTED.exec(label)
  if (quoted) label = quoted[2].trim()
  return label.length > LABEL_MAX ? "" : label
}

/** The label a fence's info string carries, or null for an ordinary block. */
export function parseFenceLabel(infoString?: string): FenceLabel | null {
  const info = (infoString ?? "").trim()
  if (!info) return null
  // A first word shaped like an option is not a language: the whole string is the tail.
  const first = info.split(/\s+/, 1)[0]
  const headless = /[=[{]/.test(first)
  const language = headless ? "" : first
  const tail = headless ? info : info.slice(first.length)
  // The fences Frizz draws as something other than code are never tabs, whatever follows the name.
  if (/^(?:lightbox|mermaid|question|done|awaiting)$/i.test(language)) return null

  const keyed = KEYED_LABEL.exec(tail)
  const explicit = keyed ? keyed[1] ?? keyed[2] ?? keyed[3] : BRACKETED_LABEL.exec(tail)?.[1]
  if (explicit !== undefined) {
    const label = cleanLabel(explicit)
    return label ? { label, explicit: true, language } : null
  }
  const bare = tail
    .replace(META_GROUP, " ")
    .split(/\s+/)
    .filter((word) => word && !META_FLAGS.has(word.toLowerCase()))
    .join(" ")
  const label = cleanLabel(bare)
  return label ? { label, explicit: FILE_LIKE.test(label), language } : null
}

export interface CodeTab {
  label: string
  /** The fence's info string as written — the language is still resolved from it. */
  info: string
  text: string
  /** False for a fence still being written (`isClosedFence`). */
  closed: boolean
}

export type CodeTabsToken = { type: "codeTabs"; raw: string; tabs: CodeTab[] }

/**
 * Whether a code token's fence has its closing line yet.
 *
 * A message arrives a delta at a time, and until the closing fence lands marked reports the block as
 * running to the end of the input. Nothing that hides part of a block may act on one in that state —
 * the reader is watching it be written. An indented block has no closing line to wait for, so it never
 * counts as closed.
 */
export function isClosedFence(code: Tokens.Code): boolean {
  if (code.codeBlockStyle === "indented") return false
  const lines = code.raw.replace(/\s+$/, "").split("\n")
  const open = /^\s*(`{3,}|~{3,})/.exec(lines[0])
  if (!open || lines.length < 2) return false
  const last = lines[lines.length - 1].trim()
  // The same character as the opening fence, at least as many of them, and nothing else on the line.
  return last.length >= open[1].length && last.split(open[1][0]).join("") === ""
}

function labelledFence(token: Token): (CodeTab & { explicit: boolean }) | null {
  if (token.type !== "code") return null
  const code = token as Tokens.Code
  // An indented block has no info string to label it with.
  if (code.codeBlockStyle === "indented") return null
  const parsed = parseFenceLabel(code.lang)
  if (!parsed) return null
  return { label: parsed.label, explicit: parsed.explicit, info: code.lang ?? "", text: code.text, closed: isClosedFence(code) }
}

/**
 * Fold each run of labelled fences in a block token list into ONE `codeTabs` token, in place.
 *
 * Only blank lines may stand between the fences of a run — marked reports them as `space` tokens — so a
 * line of prose between two blocks keeps them apart, which is how an author says "read both". A run is
 * every CONSECUTIVE labelled fence: an unlabelled block ends it, and stays the plain block it was.
 *
 * A fence alone becomes a titled block only when its label is EXPLICIT. Words after a language on a
 * single fence are too often something else (```` ```bash (run from the repo root) ````), and a title
 * bar minted from one is chrome nobody asked for; in a run, every block carrying one is the signal.
 *
 * Recurses into list items and blockquotes, the two block containers a fence can sit in — an install
 * step inside a numbered list is where tabs are most wanted.
 */
export function groupCodeTabs(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === "list") {
      for (const item of (token as Tokens.List).items) groupCodeTabs(item.tokens)
      continue
    }
    if (token.type === "blockquote") {
      groupCodeTabs((token as Tokens.Blockquote).tokens)
      continue
    }
    const first = labelledFence(token)
    if (!first) continue
    const tabs = [first]
    let end = i
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === "space") continue
      const next = labelledFence(tokens[j])
      if (!next) break
      tabs.push(next)
      end = j
    }
    if (tabs.length === 1 && !first.explicit) continue
    const raw = tokens.slice(i, end + 1).map((member) => member.raw).join("")
    const group: CodeTabsToken = {
      type: "codeTabs",
      raw,
      tabs: tabs.map(({ label, info, text, closed }) => ({ label, info, text, closed })),
    }
    tokens.splice(i, end - i + 1, group as Token)
  }
}

// WHICH TAB IS OPEN is remembered per SET OF LABELS, for the life of the page. It has to live outside
// the DOM: a streaming message re-renders its whole block on every delta and the transcript unmounts
// rows as it virtualizes, and either would snap a group back to its first tab under the reader. Keyed
// by the labels because that is the only identity a group has in an HTML string — and it is the useful
// one: having chosen `pnpm` once, the next npm/pnpm/yarn group opens on it.
//
// Read at render and written by the click (lib/switch-code-tab.ts), which also moves the live DOM
// itself, so nothing has to re-render for a click to show.
const chosenTab = new Map<string, string>()
const signatureOf = (labels: readonly string[]) => labels.join("\n")

export function rememberCodeTab(labels: readonly string[], label: string): void {
  chosenTab.set(signatureOf(labels), label)
}

export function forgetCodeTabs(): void {
  chosenTab.clear()
}

/** The index of the tab a group with these labels opens on. */
export function openTabIndex(labels: readonly string[]): number {
  const chosen = chosenTab.get(signatureOf(labels))
  const index = chosen === undefined ? -1 : labels.indexOf(chosen)
  return index < 0 ? 0 : index
}
