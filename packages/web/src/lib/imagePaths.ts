// Split a prose markdown run into ordinary markdown chunks, standalone local-IMAGE-path lines, and
// standalone local-FILE-path lines (the allowlisted documents), so the chat view can render an agent's
// (or a just-attached) screenshot path as a block <img> and a document path as an openable file chip
// instead of dead mono text. Only a line that is SOLELY an absolute path (optionally wrapped in
// backticks) is promoted — an inline path inside a sentence stays prose, and a path INSIDE a fenced
// code block stays code (see the fence tracking below). Detection happens on the raw markdown BEFORE
// the sanitizer runs, so nothing loosens the HTML allowlist.

import { ATTACHMENT_DOC_EXTENSIONS, insideFence } from "@frizz/shared"
import { parseCodexHostDirective, type CodexHostDirective } from "./codexHostDirectives.ts"
import { parseLightboxBody, type LightboxEntry } from "./lightbox.ts"

export type ProsePart =
  | { kind: "md"; text: string }
  | { kind: "image"; path: string }
  | { kind: "file"; path: string }
  | { kind: "visualization"; file: string }
  | { kind: "directive"; directive: CodexHostDirective }
  | { kind: "mermaid"; source: string }
  | { kind: "lightbox"; entries: LightboxEntry[] }

// Path characters: any non-whitespace/non-backtick, plus a literal space when NOT followed by "/".
// Paths with spaces are real and common — macOS screenshots ("Screen Shot … at 1.23.45 PM.png"),
// home/project dirs like "My Project" — and used to fall through to dead mono text / raw draft text.
// A space immediately before a "/" stays forbidden so a line holding TWO paths ("/a.png /b.png")
// remains prose instead of gluing into one bogus path. (Trade-off, accepted: a prose line that
// starts with "/" and ends in an allowed extension now promotes.)
const PATH_CHARS = String.raw`(?:[^\s\`]|[ ](?!/))+`
// Absolute path ending in an INLINE-renderable raster extension (see ATTACHMENT_IMAGE_EXTENSIONS —
// these mirror the server's /local-image content-type map, which is why svg is NOT here: svg is a
// document chip, not an inline image). The whole (trimmed) line, optional surrounding backticks.
const IMAGE_LINE = new RegExp(String.raw`^\s*\`?(/${PATH_CHARS}\.(?:png|jpe?g|gif|webp))\`?\s*$`, "i")
// The same shape for a non-image allowlisted document (pdf/svg/text/code, plus the office, data and
// archive tiers), built from the shared allowlist so the two never drift. Matched only when the line
// is NOT already an image line.
const DOC_LINE = new RegExp(String.raw`^\s*\`?(/${PATH_CHARS}\.(?:${ATTACHMENT_DOC_EXTENSIONS.join("|")}))\`?\s*$`, "i")
// A fenced-code delimiter line: ``` or ~~~ (3+), optionally indented, optionally with an info string.
// A standalone absolute path that lives INSIDE a code block (an agent pasting `ls`/`git`/`tree` output
// is common) stays ordinary code, instead of being ripped into a chip that orphans the fence markers.
// The composer's splitter finds those blocks by toggling on each such line; the prose splitter asks
// @frizz/shared's CommonMark scanner instead (see splitProseAttachments).
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/
// A fence whose language the transcript draws as something other than code: a ```mermaid diagram, or a
// ```lightbox gallery of the image paths it lists (lib/lightbox.ts). Only a CLOSED fence is taken; an
// unterminated one stays Markdown and renders as the code block it is until its closing line arrives.
const RICH_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(mermaid|lightbox)\s*$/i
// Codex's Visualize skill emits one host directive whose basename resolves inside the owning
// thread's `.codex/visualizations/YYYY/MM/DD/<session-id>/` directory. Keep the grammar exact:
// arbitrary attributes, paths, uppercase names, and inline occurrences remain ordinary prose.
const INLINE_VIS_LINE = /^\s*::codex-inline-vis\{file="([a-z0-9][a-z0-9-]{0,127}\.html)"\}\s*$/
// The tags of a collapsible section (lib/disclosure.ts). Counted per line, because sections nest.
const SECTION_OPEN = /<details(?=[\s>])/gi
const SECTION_CLOSE = /<\/details\s*>/gi

export function splitProseAttachments(md: string): ProsePart[] {
  const lines = md.split("\n")
  const parts: ProsePart[] = []
  let buf: string[] = []
  // How many `<details>` sections are open at this line. NOTHING IS LIFTED OUT OF ONE: a part is a block
  // of its own between two blocks of prose, so a gallery lifted out of a section cut the section in two
  // — its `<details>` closed at the end of the first half, and the pictures the author had folded away
  // stood below it, always in view. Inside a section a fence stays in the Markdown and is drawn where
  // it stands (ChatView's ProseHtml runs the same fence islands a card does), and a picture's path line
  // becomes the Markdown image it is shorthand for. A section never closed keeps everything after it,
  // which costs those blocks nothing but the lift.
  let sections = 0
  // Which lines sit INSIDE a fenced code block, by CommonMark's rules (@frizz/shared code-fences): a
  // fence closes only on a bare run of its own character at least as long as its opener. A toggle on
  // every ``` line got that wrong exactly when it mattered — a worker quoting a ```lightbox or ```mermaid
  // sample inside a ```` block had the sample's inner ``` read as the CLOSE, so its image paths were
  // peeled out as live pictures and the rest of the message was read inside out.
  const quoted = insideFence(md)
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const flush = () => {
    if (buf.length) {
      const text = buf.join("\n")
      if (text.trim()) parts.push({ kind: "md", text })
      buf = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (quoted(starts[i])) {
      buf.push(line)
      continue
    }
    const opened = line.match(SECTION_OPEN)?.length ?? 0
    const inSection = sections > 0 || opened > 0
    sections = Math.max(0, sections + opened - (line.match(SECTION_CLOSE)?.length ?? 0))
    if (inSection) {
      const picture = line.match(IMAGE_LINE)
      // An angle-bracketed destination, so a path with spaces is still one destination.
      buf.push(picture && !/[<>]/.test(picture[1]) ? `![](<${picture[1]}>)` : line)
      continue
    }
    const rich = line.match(RICH_FENCE)
    if (rich) {
      const opener = rich[1]
      const close = new RegExp(`^\\s{0,3}${opener[0] === "`" ? "`" : "~"}{${opener.length},}\\s*$`)
      let end = i + 1
      while (end < lines.length && !close.test(lines[end])) end++
      if (end < lines.length) {
        flush()
        const body = lines.slice(i + 1, end).join("\n")
        if (rich[2].toLowerCase() === "mermaid") parts.push({ kind: "mermaid", source: body })
        else {
          // An empty gallery has nothing to draw, so the fence goes with it rather than leaving an
          // empty frame (and the spacer either side of it) in the transcript.
          const entries = parseLightboxBody(body)
          if (entries.length > 0) parts.push({ kind: "lightbox", entries })
        }
        i = end
        continue
      }
    }
    // An opening or closing fence line: code-block syntax, never a path of its own.
    if (FENCE_LINE.test(line)) {
      buf.push(line)
      continue
    }
    const visualization = line.match(INLINE_VIS_LINE)
    if (visualization) {
      flush()
      parts.push({ kind: "visualization", file: visualization[1] })
      continue
    }
    const directive = parseCodexHostDirective(line)
    if (directive) {
      flush()
      parts.push({ kind: "directive", directive })
      continue
    }
    const image = line.match(IMAGE_LINE)
    if (image) {
      flush()
      parts.push({ kind: "image", path: image[1] })
      continue
    }
    const doc = line.match(DOC_LINE)
    if (doc) {
      flush()
      parts.push({ kind: "file", path: doc[1] })
      continue
    }
    buf.push(line)
  }
  flush()
  return parts
}

export type ComposerAttachment = { path: string; kind: "image" | "file" }

// The composer keeps attachment absolute paths INSIDE the draft value (trailing lines) so submit,
// draft persistence, and the worker/transcript pipeline all stay untouched — but presents them as
// chips instead of raw path text. This peels the TRAILING contiguous run of attachment-path LINES off
// the value: everything before it is the prose the textarea shows; the peeled paths render as chips.
// Only a trailing run is peeled, and a path inside an unclosed fence stays code, so a path typed
// mid-message is never yanked into a chip or reordered.
//
// split/join MUST round-trip the prose VERBATIM: the composer re-derives the textarea's contents from
// join(split(...)) on EVERY keystroke while chips exist, so any normalization here (a trim, a dropped
// whitespace-only chunk) eats the character the user just typed. That is why this walks raw lines
// directly instead of reusing splitProseAttachments, whose flush discards whitespace-only prose.
export function splitComposerValue(value: string): { prose: string; attachments: ComposerAttachment[] } {
  const lines = value.split("\n")
  // Forward fence-parity pass: delimiter lines and lines inside an open fence are never peelable.
  const fenced: boolean[] = new Array(lines.length)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) {
      inFence = !inFence
      fenced[i] = true
    } else fenced[i] = inFence
  }
  const attachments: ComposerAttachment[] = []
  let end = lines.length
  while (end > 0 && !fenced[end - 1]) {
    const line = lines[end - 1]
    const image = line.match(IMAGE_LINE)
    const doc = image ? null : line.match(DOC_LINE)
    if (image) attachments.unshift({ path: image[1], kind: "image" })
    else if (doc) attachments.unshift({ path: doc[1], kind: "file" })
    else break
    end--
  }
  return { prose: lines.slice(0, end).join("\n"), attachments }
}

// Recombine edited prose with the (possibly edited) attachment path list into the single draft value
// the parent owns — prose first, then each attachment path on its own trailing line, matching exactly
// the format takeFiles has always appended. No trimming: prose must survive verbatim (trailing spaces
// and newlines included) or the composer's per-keystroke round-trip destroys what was just typed.
export function joinComposerValue(prose: string, paths: string[]): string {
  if (!paths.length) return prose
  return `${prose}${prose ? "\n" : ""}${paths.join("\n")}`
}
