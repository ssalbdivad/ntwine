// The ```lightbox fence: a worker lists image and video files, one per line, and ntwine renders them as
// ONE gallery the human can click through (components/Lightbox.tsx) instead of a stack of full-width
// frames — in the transcript, and on every card and reader that renders a worker's Markdown. It is THE
// way a worker shows the human a picture: a picture a tool returned folds into the collapsed tool digest
// (lib/toolActivity.isToolActivityException), and only a fence puts one in front of the human.
//
//   ```lightbox
//   /tmp/shots/before.png  Before the fix
//   /tmp/shots/after.png   After the fix
//   /tmp/shots/flow.webm   The whole flow, recorded
//   ```
//
// A line is a path and, optionally, a caption after it. The grammar is deliberately FORGIVING, because a
// worker writes it from memory and the shapes it reaches for are all unambiguous: a bare path, a
// backticked path, a list item, and the Markdown image the worker contract already teaches
// (`![caption](/abs/shot.png)`). A caption may lead with a separator (`—`, `-`, `|`, `:`) and may be
// quoted; both are stripped. Paths with spaces work — a macOS "Screen Shot … at 1.23.45 PM.png" is the
// common case — because the path ends at the first image or video extension, not at the first space.
//
// Pure string logic, no DOM: the splitter in imagePaths.ts runs it during render and the tests run it
// under `node --test`. RESOLVING a path to a file the image proxy will serve happens in
// `resolveLightboxPath`, against the project root, exactly as a Markdown link's destination does.

import { basename } from "./paths.ts"
import { isProxiedVideoPath, localImageUrlForTarget, localMarkdownTarget, resolveRelativeLocalPath } from "./markdownTargets.ts"

export interface LightboxEntry {
  /** The path as the worker wrote it: absolute, `~/…`, project-relative, a `file:` or editor URL. */
  target: string
  /** The worker's label for the picture, when the line carried one. */
  caption?: string
  /**
   * What the viewer calls an uncaptioned picture whose file name means nothing — a delivered picture is
   * a hash-named cache copy. It names the picture in the viewer only; the tile stays unlabelled.
   */
  title?: string
}

/**
 * One picture — or video (isLightboxVideo) — the overlay can show: an absolute path the image proxy
 * serves, and its label.
 */
export interface LightboxImage {
  path: string
  /** What the picture is called on screen — the caption, else the entry's title, else the file's basename. */
  label: string
  /** True when `label` is prose — a caption or a title — rather than a file name, which is set in mono. */
  captioned: boolean
}

// `- /a.png`, `* /a.png`, `1. /a.png`, `2) /a.png`.
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+/
// `![caption](dest)` or `[caption](dest)`. The destination is taken whole and cleaned below rather than
// held to CommonMark's no-spaces rule, which would reject the screenshot paths workers actually write.
const MARKDOWN_IMAGE = /^!?\[([^\]]*)\]\((.+)\)$/
// A destination's optional `"title"` tail.
const DESTINATION_TITLE = /\s+"[^"]*"$/
// Where a bare path ends: the first image or video extension followed by the end of the line, whitespace,
// or a caption separator. Extensions mirror the proxy's allowlist (markdownTargets PROXIED_IMAGE_PATH and
// PROXIED_VIDEO_PATH).
const PATH_END = /\.(?:png|jpe?g|gif|webp|mp4|m4v|webm|mov)(?=$|[\s:|,;—–])/i
const CAPTION_LEAD = /^[\s:|,;—–-]+/
const QUOTED = /^(["'“‘])(.*)(["'”’])$/

function cleanCaption(raw: string): string | undefined {
  let caption = raw.replace(CAPTION_LEAD, "").trim()
  const quoted = QUOTED.exec(caption)
  if (quoted) caption = quoted[2].trim()
  return caption || undefined
}

function parseLine(raw: string): LightboxEntry | null {
  const line = raw.trim().replace(LIST_MARKER, "")
  if (!line) return null

  const markdown = MARKDOWN_IMAGE.exec(line)
  if (markdown) {
    let target = markdown[2].trim()
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim()
    else target = target.replace(DESTINATION_TITLE, "")
    return { target, caption: cleanCaption(markdown[1]) }
  }

  const backticked = /^`([^`]+)`(.*)$/.exec(line)
  if (backticked) return { target: backticked[1].trim(), caption: cleanCaption(backticked[2]) }

  const end = PATH_END.exec(line)
  // No image or video extension at all (an `.svg`, a URL with a query, a stray note): keep the whole line as the
  // target. It will not resolve, and the gallery lists it under the pictures as plain text rather than
  // dropping it.
  if (!end) return { target: line }
  const cut = end.index + end[0].length
  return { target: line.slice(0, cut), caption: cleanCaption(line.slice(cut)) }
}

/** Every non-blank line of a ```lightbox fence body, in order. */
export function parseLightboxBody(body: string): LightboxEntry[] {
  const entries: LightboxEntry[] = []
  for (const line of body.split("\n")) {
    const entry = parseLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * The absolute path a lightbox entry names, when it is an image or a video the `/local-image` proxy can
 * serve — else null. A relative target resolves against the project root and a `~` one against the server's
 * home, the same bases a Markdown link uses (lib/localPathBase.ts), so a worker can name a screenshot
 * under `.ntwine/threads/<id>/` exactly as it typed it into the shell.
 */
export function resolveLightboxPath(target: string, base: { dir: string; home: string }): string | null {
  const absolute = resolveRelativeLocalPath(target, base.dir, base.home) ?? target
  const local = localMarkdownTarget(absolute)
  if (!local?.filePath) return null
  return localImageUrlForTarget(local) || isProxiedVideoPath(local.filePath) ? local.filePath : null
}

/** A lightbox entry that plays rather than shows: the gallery draws its first frame, the viewer plays it. */
export function isLightboxVideo(path: string): boolean {
  return isProxiedVideoPath(path)
}

/** What a tile and the overlay call a picture: the worker's caption, else its title, else the file's own name. */
export function lightboxLabel(entry: LightboxEntry, path: string | null): { label: string; captioned: boolean } {
  if (entry.caption) return { label: entry.caption, captioned: true }
  if (entry.title) return { label: entry.title, captioned: true }
  return { label: basename(path ?? entry.target), captioned: false }
}

// Text that names a file rather than describing one: what the sanitizer writes into an empty alt
// (`target.display`, the path as written), what a bare picture line carries (its basename), and what a
// tool's picture card writes (`Read: shots/board.png`).
const NAMES_A_FILE = /\.(?:png|jpe?g|gif|webp|mp4|m4v|webm|mov)$/i

/**
 * The overlay's picture for an image the transcript drew some other way — a bare path line (BlockImage),
 * a Markdown image, a tool's picture card — from its `<img>`'s path and alt text. The alt is the caption
 * when an author wrote one (`![The settings page](/abs/x.png)`); alt text that only names a file is not
 * a caption, and the picture is called by that file's name. That name is the ALT's, not the served
 * path's: a tool's picture is served from a hash-named cache copy, and its alt names the file it was.
 */
export function lightboxImageFor(path: string, alt: string | null | undefined): LightboxImage {
  const text = alt?.trim() ?? ""
  const captioned = text !== "" && !NAMES_A_FILE.test(text)
  return { path, label: captioned ? text : basename(text || path), captioned }
}
