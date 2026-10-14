import { formatFileReference, splitFilePosition, type FilePosition } from "@ntwine/shared"
import { apiBase, isRetiredAppPath, projectSlug, APP_ROUTE_SEGMENTS, MACHINE_ROUTE_SEGMENTS } from "./base-path.ts"
import { dirnameLike, isRooted, joinLike } from "./paths.ts"
// Markdown is often written by tools that report local artifacts as links. A browser interprets a
// POSIX absolute path as a same-origin URL path, which both navigates away from ntwine and produces a
// deceptive localhost URL. Identify those targets before DOM sanitization so they can never become
// navigable anchors. This module deliberately does not decide filesystem authorization: the server's
// origin-gated `/local-image` route serves any absolute path that realpath-resolves to a regular image
// file (packages/server/src/local-image.ts, deliberately path-unconfined).

export interface LocalMarkdownTarget {
  // Metadata for a local-looking destination. The renderer keeps this out of normal prose unless
  // it needs to expose it as an accessible title for a disabled local link.
  display: string
  // Present only for an absolute path the server can act on — its gated image endpoint, its Markdown
  // reader, or the desktop opener. POSIX (`/a/b`) and Windows (`C:\a\b`) alike; see localMarkdownTarget.
  // Always the BARE path: a place in the file is `position`, never a suffix left on the path.
  filePath?: string
  // The place in the file the link names — `a.ts:12:3`, `a.ts#L12-L20`, `vscode://file/…:12` — split
  // off the path so the reader gets the file and the external app gets the line (lib/localFilePosition.ts).
  position?: FilePosition
}

// Keep one-letter URL schemes such as x://host/p out of the drive-path branch.
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/](?![\\/])/

// Editor deep-link schemes that all share VS Code's URL grammar: `<scheme>://file/<path>[:line[:col]]`.
// Agents under user-level "link every file" instructions write these (`[plan.md](cursor://file/<abs>)`)
// because in a terminal that is the only clickable form. Left as an anchor, the OS resolves the scheme
// and the named editor opens no matter what the "Local file links" setting says — and a `.md` file
// never reaches ntwine's own reader. Classify the path the link names instead, so it routes exactly
// like a plain path link. The path may carry its own leading slash (`cursor://file//Users/…`) or lean
// on the route's (`cursor://file/Users/…`); both forms occur in the wild and both editors accept both.
const EDITOR_FILE_URL = /^(?:cursor|vscode|vscode-insiders|windsurf):\/\/file\/(.*)$/i

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // An invalid escape is still a local-looking value, but must never make sanitization throw.
    return value
  }
}

// A destination's path and the place in it, from either spelling (shared file-position.ts): an editor
// suffix on the path itself (`/a.ts:12:3`), or a GitHub fragment (`/a.ts#L12-L20`, which is also what
// a `?plain=1#L3` link copied off GitHub carries). Any other `?query`/`#section` tail names nothing in
// the file and is dropped, before decoding — an ENCODED `#` is a character in the name, not a fragment.
// The fragment wins when both are present: it is the more deliberate of the two.
function pathAndPosition(href: string): { path: string; position?: FilePosition } {
  const hash = href.indexOf("#")
  // `splitFilePosition` reads a fragment only AFTER a path (it refuses a bare `#L12`), so give it one.
  const fromFragment = hash === -1 ? undefined : splitFilePosition(`_${href.slice(hash)}`).position
  const split = splitFilePosition(decodePath(href.replace(/[?#].*$/u, "")))
  const position = fromFragment ?? split.position
  return position ? { path: split.path, position } : { path: split.path }
}

/** The target for a bare local path and the place in it; `display` reads as the reference does (`/a.ts:12`). */
function fileTarget(path: string, position: FilePosition | undefined): LocalMarkdownTarget {
  return position ? { display: formatFileReference(path, position), filePath: path, position } : { display: path, filePath: path }
}

// The SPA's intentionally supported root-relative routes. All other single-slash absolute targets
// are treated as filesystem paths; ordinary relative links (`docs/foo`), fragments, mailto, and
// http(s) never reach this classifier.
//
// The answer does not depend on the page: `/`, a drawer's `/all/<slug>/thread/<t>` and a fullscreen
// `/thread/<t>/full` all classify a link the same way, because every shape below is matched on the
// link alone. (It stripped the page's own `/project/<slug>` prefix first until 2026-09-28, when the
// project page went.)
function isNtwineRoute(href: string): boolean {
  if (href === "/" || href.startsWith("/?") || href.startsWith("/#")) return true
  const bare = href.replace(/[?#].*$/u, "")
  // A link that names its project — a drawer, `/all/nub/thread/x`, or its `/full` — is in-app whichever
  // page it is read on.
  if (projectSlug(bare)) return true
  // So is an address ntwine itself minted before 2026-09-28 (`/project/nub/thread/x`): it lands on the
  // page, where a local-file chip would ask the server to open a file that is not there.
  if (isRetiredAppPath(bare)) return true
  const first = bare.split("/")[1] ?? ""
  // `/projects` and the cross-project page's other machine routes name no project of their own. EXACTLY
  // those paths: `/projects/acme/README.md` is somebody's directory, not a page.
  return APP_ROUTE_SEGMENTS.has(first) || (MACHINE_ROUTE_SEGMENTS.has(first) && bare.replace(/\/$/u, "") === `/${first}`)
}

/**
 * Classify an anchor/image destination that denotes a filesystem path. A `file:` value with a REMOTE
 * host is retained as local text but deliberately has no `filePath`: a UNC share is not a file this
 * machine's server can resolve. Protocol-relative URLs (`//cdn.example/...`) remain web URLs.
 *
 * Both POSIX and Windows paths carry an actionable filePath. The server decides whether it can
 * resolve the path; dropping Windows paths here creates inert buttons and removes inline images.
 * Leave /C:/... intact: it may be a POSIX path, and only a Windows server may shed that first slash.
 */
export function localMarkdownTarget(raw: string | null | undefined): LocalMarkdownTarget | null {
  const href = raw?.trim()
  if (!href) return null
  // marked HTML-escapes backslashes in a Windows Markdown destination (`C:%5CUsers…`), so classify
  // the decoded value before checking its drive-prefix form.
  const decodedHref = decodePath(href)

  // A Windows path keeps any `#`/`?` it has — both are legal in a Windows file name — and sheds only a
  // position at its very end.
  if (WINDOWS_ABSOLUTE_PATH.test(decodedHref)) {
    const { path, position } = splitFilePosition(decodedHref)
    return fileTarget(path, position)
  }

  if (decodedHref.startsWith("/") && !decodedHref.startsWith("//") && !isNtwineRoute(decodedHref)) {
    // A `#section` or `?query` tail is not part of the path — kept, it made `/repo/AGENTS.md#setup` fail
    // the Markdown test and go to the desktop opener instead of the reader, which on a phone meant a
    // tap that opened the file on the server machine and showed nothing where the tap was. A `#L12`
    // tail, or a `:12` suffix, is the place in the file, and comes off as `position`.
    const { path, position } = pathAndPosition(href)
    return fileTarget(path, position)
  }

  const editor = EDITOR_FILE_URL.exec(href)
  if (editor) {
    // A query tail (`?windowId=_blank`) is the editor's, not the file's. The cursor suffix (`:12:3`) is
    // the place the link opens at: it comes off the path as `position`. Kept on the path until
    // 2026-10-01 — on the belief that the reader and the server's opener stripped it, which neither did,
    // so `[x](vscode://file/repo/a.ts:12)` opened a reader that said the file was not found.
    const { path: named, position } = pathAndPosition(editor[1])
    const rest = named.replace(/^\/+/, "")
    if (!rest) return null
    return fileTarget(WINDOWS_ABSOLUTE_PATH.test(rest) ? rest : `/${rest}`, position)
  }

  if (!/^file:/i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.protocol !== "file:") return null
    // A UNC/remote file URL is not a local file the server can safely proxy. It remains a
    // non-navigating chip, while an empty or localhost authority can use the existing gated route.
    if (url.hostname && url.hostname !== "localhost") return { display: href }
    // `file:///repo/a.ts#L12` names a line the way a web link does.
    const { path, position } = pathAndPosition(`${url.pathname}${url.hash}`)
    return fileTarget(path, position)
  } catch {
    return { display: href }
  }
}

/**
 * The place in the file a link's LABEL names when its destination names none: `[a.ts:12](/repo/a.ts)`.
 * Agents write the line into the text and forget the href, and the click then opened the file at its
 * top. Taken only when the label's own path is the target's path or a trailing piece of it (`a.ts`,
 * `src/a.ts`), so a label that merely mentions a number never moves the cursor.
 */
export function labelPosition(target: LocalMarkdownTarget, label: string): LocalMarkdownTarget {
  if (!target.filePath || target.position) return target
  const { path, position } = splitFilePosition(label.trim())
  if (!position || !path) return target
  const named = path.replace(/\\/g, "/")
  const full = target.filePath.replace(/\\/g, "/")
  if (full !== named && !full.endsWith(`/${named.replace(/^\.?\//, "")}`)) return target
  return fileTarget(target.filePath, position)
}

export function localImageUrl(path: string): string {
  return `${apiBase()}/local-image?path=${encodeURIComponent(path)}`
}

// Must match the server's image-content-type allowlist. The server still decides whether a path is
// actually eligible by resolving it to a regular image behind the HTTP origin gate.
const PROXIED_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i

export function localImageUrlForTarget(target: LocalMarkdownTarget): string | null {
  return target.filePath && PROXIED_IMAGE_PATH.test(target.filePath)
    ? localImageUrl(target.filePath)
    : null
}

// The VIDEOS the same route serves (server/local-image.ts, which must match). Only a ```lightbox gallery
// draws one (lib/lightbox.ts): a Markdown `![](demo.mp4)` keeps its link, because an `<img>` cannot play
// a video and the sanitizer mints no `<video>`.
const PROXIED_VIDEO_PATH = /\.(?:mp4|m4v|webm|mov)$/i

export function isProxiedVideoPath(path: string): boolean {
  return PROXIED_VIDEO_PATH.test(path)
}

// Must match the server's `MARKDOWN_FILE_EXT`. A local path with this extension is rendered by ntwine's
// own reader drawer instead of being handed to the desktop opener — the one local file kind the app
// knows how to show. The strip mirrors an editor cursor suffix (`README.md:12`) the way
// resolveOpenableFile does, so a line-anchored reference still reads as Markdown. `.mdx` counts: an MDX
// doc is Markdown prose first (its imports and JSX render as inert text), and until 2026-08-25 it was
// the one Markdown flavour that slipped past the reader to the OS opener — which on a Mac whose
// Markdown handler is Cursor meant a blog post in `content/blog/*.mdx` opened an editor, whatever
// the "Local file links" setting said.
const MARKDOWN_FILE_PATH = /\.(?:md|mdx|markdown)$/i

export function isLocalMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATH.test(path.trim().replace(/:\d+(?::\d+)?$/, ""))
}

// Resolve a RELATIVE Markdown destination against the directory the prose belongs to. Repo docs link
// to each other relatively on purpose (`./ARCHITECTURE.md`, `../scripts/shot.mjs`) and so does chat
// prose — a worker writing up its own scratch file names it `.ntwine/threads/<id>/HANDOFF.md`, exactly
// as it typed it into the shell. With no base, none of those is a local path OR a working URL: the
// anchor stayed relative and the browser resolved it against the PAGE, so clicking a handoff link in a
// drawer navigated to a path under the drawer's own address (`/all/nub/thread/.ntwine/threads/<id>/…`)
// and out of ntwine entirely.
//
// The base is the rendering document's own directory for the file reader, and the PROJECT DIRECTORY
// for every other surface — the same root the server resolves a bare inline-code path against
// (local-file.ts `resolveOpenableFile`), so a path written in backticks and the same path written as a
// link now land on the same file. `~`/`~/` expands against `home` when the board supplied one, which
// is the other half of that parity. Returns null for anything already absolute, a fragment, a query,
// or a scheme; the query/fragment tail of a resolved path is dropped, since a filesystem path has
// neither.
//
// The base may be a Windows path — `C:\Users\…` is what the board's `projectDir` and `homeDir` and the
// reader's own file path all are when the server runs there — and until the Windows audit
// (2026-09-11, finding 12) that returned null unconditionally, so NO relative link in a rendered local
// Markdown file ever opened on Windows. joinLike keeps the base's separator and drive; the link itself
// is always written with `/`, whatever the platform (a `..` climb is bounded by the drive the same way
// it is bounded by `/`).
//
// A place in the file (`src/a.ts:12`, `guide.md#L3-L9`) is split off as `position`, exactly as for an
// absolute link, so a relative link opens at its line too (resolveRelativeLocalTarget).
export function resolveRelativeLocalPath(
  raw: string | null | undefined,
  baseDir: string,
  home?: string,
): string | null {
  return resolveRelativeLocalTarget(raw, baseDir, home)?.path ?? null
}

// `App.tsx:42`, `README.md:3`, `a.ts:12-20`: a file at the root of the base, named with its line. It
// passes the scheme test in resolveRelativeLocalTarget (a dot is legal in a scheme, so `app.tsx:` reads
// as one), and was left a dead anchor to an unknown scheme while `src/a.ts:12` resolved. Told apart by
// shape: a position suffix, and before it one name with an extension and no `:`, `/` or `\`. The
// extension keeps a REAL scheme whose payload is digits (`tel:5551234`, `localhost:3000`) a link; the
// single bare name keeps `mailto:x`, `http://h:80` and a drive path (`C:\a.ts:3`) out. A file with no
// extension (`Makefile:3`) stays unreachable this way; `./Makefile:3` resolves.
function isBareFileAtPosition(href: string): boolean {
  const { path, position } = splitFilePosition(href.replace(/[?#].*$/u, ""))
  return position !== undefined && /^[^:/\\]+\.[\w-]+$/u.test(path)
}

/** resolveRelativeLocalPath, with the place in the file the link names kept beside the path. */
export function resolveRelativeLocalTarget(
  raw: string | null | undefined,
  baseDir: string,
  home?: string,
): { path: string; position?: FilePosition } | null {
  const href = raw?.trim()
  if (!href) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !isBareFileAtPosition(href)) return null // http(s):, file:, mailto:, cursor:, C:\…, …
  if (/^[\\/#?]/.test(href)) return null
  const { path: relative, position } = pathAndPosition(href)
  if (!relative) return null
  // A home-anchored path carries its own root, so it needs no base at all — and must never be glued
  // onto one, which is what turned `~/.claude/CLAUDE.md` into `<baseDir>/~/.claude/CLAUDE.md`.
  const homeAnchored = relative === "~" || /^~[\\/]/.test(relative)
  if (homeAnchored && !(home && isRooted(home))) return null
  const root = homeAnchored ? home! : baseDir
  if (!isRooted(root)) return null
  const path = joinLike(root, homeAnchored ? relative.slice(2) : relative)
  return position ? { path, position } : { path }
}

/**
 * A position as the `#L` fragment `pathAndPosition` reads back — how the sanitizer's relative-link
 * rebase hands a link's line on to localMarkdownTarget through the rewritten href (markdown.ts
 * rebaseRelative). `#L12C3-L20`; the empty string for no position.
 */
export function positionFragment(position: FilePosition | undefined): string {
  if (!position) return ""
  const end = position.endLine && position.endLine > position.line ? `-L${position.endLine}` : ""
  return `#L${position.line}${position.column ? `C${position.column}` : ""}${end}`
}

/**
 * The directory a document at `path` lives in — the base for its relative links, in the path's own
 * separator (`C:\proj\docs` for a Windows reader path). `/` for a path with no directory part, as it
 * always was: the reader only ever holds a rooted, server-canonical path, so that arm is a stand-in.
 */
export function localFileDir(path: string): string {
  return dirnameLike(path) || "/"
}
