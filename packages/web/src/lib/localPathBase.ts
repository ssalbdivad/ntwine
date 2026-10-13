// Where a relative path written in prose points. Agents name files the way they typed them into a
// shell — `packages/web/src/App.tsx`, `.ntwine/threads/<id>/HANDOFF.md`, `~/.claude/CLAUDE.md` — and the
// server has always resolved those against the project directory for a path in INLINE CODE
// (local-file.ts `resolveOpenableFile`, behind rpc.resolveLocalPaths). A path written as a Markdown
// LINK had no such base in chat, so it stayed a relative href and the browser resolved it against the
// PAGE: clicking one navigated to a path under the page's own address and out of the app.
//
// Module-level rather than an argument threaded through every `mdToHtml` call, for exactly the reason
// githubAutolink.ts holds its repo that way: a page is FOCUSED on one project at a time, there are a
// dozen render sites each memoizing on its own markdown string, and a focus change tears every one of
// them down (resetProjectState). Set from the board — the one payload that carries both values. This is
// the focus's base, which is right for its drawers; Everything's lanes render other projects' prose on
// the same page, and name each one's own base through MarkdownScopeContext (lib/useMarkdown.ts).
//
// It NOTIFIES, and that is load-bearing, not defensive: a thread's transcript is its own query and it
// resolves BEFORE the board keyframe, so HTML memoized on the markdown string alone would be built
// while this was still empty and nothing would ever invalidate it. useMarkdownHtml subscribes so the
// base is a real render input. (Measured for the repo autolinker in exactly that shape — see
// githubAutolink.ts `setGithubRepo`.)

export interface LocalPathBase {
  /** The project root a relative path resolves against, or "" before the board has arrived. */
  dir: string
  /** The server's home directory, for a `~`-anchored path. "" when the server did not supply one. */
  home: string
}

const EMPTY: LocalPathBase = { dir: "", home: "" }

let base: LocalPathBase = EMPTY
const listeners = new Set<() => void>()

/** Point relative-path resolution at this page's project. Called from the board's own door (store.ts). */
export function setLocalPathBase(dir: string | null | undefined, home?: string | null): void {
  const next: LocalPathBase = { dir: dir ?? "", home: home ?? "" }
  if (next.dir === base.dir && next.home === base.home) return
  // A STABLE IDENTITY when nothing changed is the whole reason for the guard above: useSyncExternalStore
  // compares snapshots by reference and re-renders forever on a fresh object per read.
  base = next.dir || next.home ? next : EMPTY
  for (const listener of listeners) listener()
}

/** The base relative paths resolve against — the `getSnapshot` half of the subscription. */
export function localPathBase(): LocalPathBase {
  return base
}

export function subscribeLocalPathBase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
