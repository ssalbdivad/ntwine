// THE WORKSPACE'S FILES, FOR `@` IN THE SIDEBAR'S PROMPT — the pure half: which files there are, which
// are left out, and which a query names first. workspace-files.ts lists them and answers the page.
//
// WHICH FILES. What VS Code's own quick open (Ctrl+P) offers: the workspace's files less `files.exclude`,
// `search.exclude` and what git ignores. `workspace.findFiles` alone honours only the first — it
// disregards ignore files and search.exclude by design — and in an ntwine checkout that is ruinous: every
// thread's worktree lives under `.ntwine/worktrees/<slug>/`, gitignored, so `@App` offered twenty-six
// copies of App.tsx before the real one (26 worktrees in the maintainer's checkout, 2026-10-02). So a
// folder in a git repository is listed by git (`ls-files --cached --others --exclude-standard`), and
// both exclude settings are applied here with `globMatcher`; anywhere else, by findFiles with the same
// excludes.
//
// WHICH FIRST (`rankFiles`), the way quick open reads a query: the file's own name before its folder —
// exactly, then by its start, then anywhere in it — then the path, then the query's letters in order
// in the name (`wbo` → `web-board.ts`). Not in order along the whole path: there, three letters find
// most of a repository (`app` → `packages/…/components/Composer.tsx`). Within a rank, a file open in a
// tab first (the one the human is most likely to mean), then the shorter path.

/** One file the index holds: its absolute path, and the label the menu shows (workspace-relative). */
export interface IndexedFile {
  path: string
  label: string
}

// ── excludes ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A VS Code glob as a regular expression over a folder-relative path with `/` separators: `**` any
 * number of segments (none included), `*` and `?` within one, `{a,b}` either, `[…]` a class (`[!…]`
 * negated). The patterns `files.exclude` and `search.exclude` hold (`**\/node_modules`, `**\/*.code-search`,
 * `dist/**`) and the ones people write; not every corner of VS Code's matcher.
 */
export function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/\\/gu, "/").replace(/^\.?\//u, "")
  let re = ""
  let groups = 0
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === "*") {
      if (source[i + 1] === "*") {
        i++
        if (source[i + 1] === "/") {
          i++
          re += "(?:.*/)?"
        } else re += ".*"
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else if (c === "{") {
      groups++
      re += "(?:"
    } else if (c === "}" && groups > 0) {
      groups--
      re += ")"
    } else if (c === "," && groups > 0) re += "|"
    else if (c === "[" && source.indexOf("]", i + 2) > i) {
      const end = source.indexOf("]", i + 2)
      const body = source.slice(i + 1, end).replace(/^!/u, "^").replace(/\\/gu, "\\\\")
      re += `[${body}]`
      i = end
    } else re += c.replace(/[.+^$()|[\]\\]/gu, "\\$&")
  }
  return new RegExp(`^${re}${")".repeat(groups)}$`, "u")
}

/** The patterns a setting turns on (`{ "**\/node_modules": true }`); a `{ when }` condition is not followed, so it excludes nothing. */
export function enabledPatterns(setting: unknown): string[] {
  if (!setting || typeof setting !== "object") return []
  return Object.entries(setting as Record<string, unknown>).filter(([, on]) => on === true).map(([pattern]) => pattern)
}

/**
 * Whether a folder-relative path is excluded: a pattern matching the file, or any folder above it — a
 * folder excluded is everything in it, as the explorer and search treat it.
 */
export function globMatcher(patterns: readonly string[]): (relative: string) => boolean {
  const res = patterns.map(globToRegExp)
  if (!res.length) return () => false
  return (relative) => {
    const parts = relative.split("/")
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/")
      if (res.some((re) => re.test(prefix))) return true
    }
    return false
  }
}

// ── ranking ──────────────────────────────────────────────────────────────────────────────────────────

/** What the query is matched as: lowercase, `/` separators, no leading `./` or `/`, no spaces at its ends. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\\/gu, "/").replace(/^\.?\/+/u, "")
}

function inOrder(query: string, text: string): boolean {
  let at = 0
  for (const char of text) if (char === query[at] && ++at === query.length) return true
  return at === query.length
}

/** The files a query names, best first, at most `limit`; `open` holds the paths open in tabs. */
export function rankFiles(files: readonly IndexedFile[], query: string, open: ReadonlySet<string>, limit: number): IndexedFile[] {
  const q = normalizeQuery(query)
  if (!q) return []
  const scored: { file: IndexedFile; rank: number; open: number; length: number; label: string }[] = []
  for (const file of files) {
    const label = file.label.toLowerCase().replace(/\\/gu, "/")
    const name = label.slice(label.lastIndexOf("/") + 1)
    const rank = name === q ? 0
      : name.startsWith(q) ? 1
      : name.includes(q) ? 2
      : label.includes(q) ? 3
      : q.length >= 2 && inOrder(q, name) ? 4
      : -1
    if (rank < 0) continue
    scored.push({ file, rank, open: open.has(file.path) ? 0 : 1, length: label.length, label })
  }
  scored.sort((a, b) => a.rank - b.rank || a.open - b.open || a.length - b.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  return scored.slice(0, limit).map(({ file }) => file)
}
