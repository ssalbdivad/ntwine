// PATHS THE BROWSER NEVER STATS, IN BOTH SPELLINGS. Every path the web client shows or resolves comes
// off the wire as text: a tool's `file_path`, a worker's cwd, the board's `projectDir` and `homeDir`,
// a link in rendered Markdown. Claude Code and Codex on Windows report all of those as
// `C:\Users\…` with backslashes, and the server passes `project.dir` and `homedir()` through unchanged
// (board.ts) — so a client that split on `/` alone showed the whole `C:\…` path as a title, drew the
// edited-files tree as one flat node per file, and could not resolve a single relative link inside a
// rendered local Markdown file (Windows audit 2026-09-11, finding 12: one root cause, six surfaces).
//
// This module is that root cause fixed once. It is LEXICAL — no `node:path`, no platform switch: the
// browser does not know which OS the server runs on, and a page can show a Linux server's paths from
// a Windows laptop. A path answers for itself: `pathSeparatorOf` reads the separator it already uses,
// `joinLike` keeps that separator and the drive when it builds a sibling, and `relativeTo` compares a
// drive letter case-insensitively because Windows does (`c:\proj` and `C:\proj` are one directory) while
// leaving every other segment's case alone. POSIX behaviour is byte-identical to the per-site helpers
// this replaced (pinned by each site's own tests, unchanged); the Windows cases sit beside them in
// paths.test.ts.

/** One or more separators of either kind — the split every helper here shares. */
const SEPARATORS = /[\\/]+/

/** The root a path starts with: a drive (`C:` + separator), a POSIX/UNC leading separator, or nothing. */
const ROOT = /^(?:([A-Za-z]:)([\\/]+)|([\\/]+))/

/** A `\`-rooted or `/`-rooted path, or a drive-rooted one. `C:` alone is drive-RELATIVE and is not rooted. */
const ROOTED = /^(?:[\\/]|[A-Za-z]:[\\/])/

/** The path's segments, in order. A drive letter is a segment (`C:`); a POSIX root is not — it has no text. */
export function splitPath(path: string): string[] {
  return path.split(SEPARATORS).filter(Boolean)
}

/** `/`-rooted (or `\`-rooted) or drive-rooted (`C:\`, `C:/`). A bare `C:` is drive-relative and is not. */
export function isRooted(path: string): boolean {
  return ROOTED.test(path)
}

/** The separator the path already uses — the first one it contains — defaulting to `/` when it has none. */
export function pathSeparatorOf(path: string): "/" | "\\" {
  const cut = path.search(/[\\/]/)
  return cut !== -1 && path[cut] === "\\" ? "\\" : "/"
}

// The root prefix, spelled in the path's own separator, and the rest of the path after it. A run of
// leading separators collapses to one (`//x` and `/x` name the same POSIX file, and marked already
// hands the resolver a `//`-free href) EXCEPT the two-backslash UNC prefix, which is load-bearing:
// `\\server\share` is a different name from `\server\share`.
function splitRoot(path: string): { root: string; rest: string } {
  const m = ROOT.exec(path)
  if (!m) return { root: "", rest: path }
  const sep = pathSeparatorOf(path)
  if (m[1]) return { root: `${m[1]}${sep}`, rest: path.slice(m[0].length) }
  const unc = sep === "\\" && m[3].length >= 2
  return { root: unc ? "\\\\" : sep, rest: path.slice(m[0].length) }
}

function resolveSegments(stack: string[], segments: readonly string[]): string[] {
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    // `..` may climb above the base; the server's openable-root gate is what actually confines the
    // result, exactly as it does for an absolute path an author wrote by hand.
    if (segment === "..") stack.pop()
    else stack.push(segment)
  }
  return stack
}

/**
 * `rel` resolved against `base`, with `.` and `..` folded, in the BASE's separator and under its drive:
 * `joinLike("C:\\proj\\docs", "../a.md")` is `C:\proj\a.md`, `joinLike("/repo/docs", "../a.md")` is
 * `/repo/a.md`. A rooted `rel` ignores the base and is only normalised. Relative Markdown links are
 * written with `/` whatever the platform, which is why the base's separator wins, not the link's.
 */
export function joinLike(base: string, rel: string): string {
  const { root, rest } = isRooted(rel) ? splitRoot(rel) : splitRoot(base)
  const sep = pathSeparatorOf(isRooted(rel) ? rel : base)
  const stack = resolveSegments([], splitPath(rest))
  if (!isRooted(rel)) resolveSegments(stack, splitPath(rel))
  return root + stack.join(sep)
}

/** The last segment, or the path itself when it has none (`/`, `C:\`, ``). */
export function basename(path: string): string {
  return splitPath(path).pop() || path
}

/**
 * The directory part, in the path's own separator: `/repo/docs` for `/repo/docs/guide.md`, `C:\proj`
 * for `C:\proj\a.ts`, the root itself for a file directly under it (`/`, `C:\`). A relative path with
 * no directory part yields "" — callers choose their own stand-in for "nowhere".
 */
export function dirnameLike(path: string): string {
  const { root, rest } = splitRoot(path)
  const segments = splitPath(rest)
  segments.pop()
  return root + segments.join(pathSeparatorOf(path))
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A pattern for `root` followed by a separator, at every position in a string (`g`), that reads either
 * separator between the root's segments and either letter case for its drive. Null for a root that
 * would eat every leading separator (``, `/`, `C:\`). The trailing separator is part of the needle so a
 * sibling checkout (`…/ntwine-old/a.ts`) never matches.
 */
export function pathPrefixPattern(root: string, flags = "g"): RegExp | null {
  const trimmed = root.trim().replace(/[\\/]+$/, "")
  if (!trimmed || !isRooted(trimmed)) return null
  const { root: head, rest } = splitRoot(trimmed)
  const drive = /^[A-Za-z]:/.exec(head)?.[0]
  const segments = splitPath(rest)
  if (!segments.length) return null
  const lead = drive ? `[${drive[0].toLowerCase()}${drive[0].toUpperCase()}]:[\\\\/]` : head === "\\\\" ? "\\\\\\\\" : "[\\\\/]"
  return new RegExp(`${lead}${segments.map(escapeRe).join("[\\\\/]")}[\\\\/]`, flags)
}

/**
 * `path` under `root`, as the remainder in the path's OWN separators (`src\a.ts` for a `C:\…` path,
 * `src/a.ts` for a POSIX one); null when it is not under the root, including when it IS the root.
 * The drive letter compares case-insensitively; every other segment is exact, as the filesystem the
 * server actually resolves on may well be.
 */
export function relativeTo(root: string, path: string): string | null {
  const pattern = pathPrefixPattern(root, "")
  if (!pattern) return null
  const m = new RegExp(`^${pattern.source}`).exec(path)
  if (!m) return null
  const rest = path.slice(m[0].length)
  return rest ? rest : null
}

/**
 * Every occurrence of `homeDir` as a path prefix in `text` collapsed to `~`, keeping the separator that
 * followed it (`~/.claude/CLAUDE.md`, `~\.claude\CLAUDE.md`). Global over the string on purpose: the
 * live tool label is one string that can name several paths. `homeDir` is the board's own — the
 * server's `homedir()` (board.ts) — not a guess from the path's shape.
 */
export function abbreviateHome(text: string, homeDir: string | undefined): string {
  const pattern = homeDir ? pathPrefixPattern(homeDir) : null
  return pattern ? text.replace(pattern, (hit) => `~${hit[hit.length - 1]}`) : text
}

/**
 * ONE path with a LEADING `homeDir` written as `~`, keeping the separator that followed it
 * (`~/.claude/CLAUDE.md`, `~\.claude\CLAUDE.md`); the path unchanged when it is not under the home.
 * Anchored, unlike abbreviateHome: a single path names one place, so a home-shaped run further along
 * it (`/Volumes/Backup/Users/me/…`) is some other directory, not the home.
 */
export function tildePath(path: string, homeDir: string | undefined): string {
  const rest = homeDir ? relativeTo(homeDir, path) : null
  // relativeTo's match ends on the separator that followed the home, which sits just before `rest`.
  return rest === null ? path : `~${path[path.length - rest.length - 1]}${rest}`
}
