import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"
import { mdToHtml, mdInlineToHtml, type MarkdownScopeOptions } from "./markdown.ts"
import { githubRepoForLinks, subscribeGithubRepo } from "./githubAutolink.ts"
import { githubRefsInHtml, noteGithubRefs } from "./githubHovercards.ts"
import { localPathBase, subscribeLocalPathBase, type LocalPathBase } from "./localPathBase.ts"

// Memoized markdown rendering, for every surface that drops agent prose into `dangerouslySetInnerHTML`.
//
// It exists because `mdToHtml` is not a pure function of its argument: the GitHub autolinker
// (githubAutolink.ts) reads the project's repo from module state, and that state arrives from the board a
// beat after a thread's own transcript query resolves. Every call site used to memoize on the markdown
// STRING alone, so the HTML built during that beat — with no repo, hence no links — was the HTML the
// reader kept for the life of the page. Making the repo a subscribed render input is what fixes it, and
// putting it in one hook is what stops the next markdown surface from reintroducing the bug.
//
// useSyncExternalStore over a SCALAR rather than useSnapshot, matching lib/deliverQueuedNow.ts: this
// runs in every prose block on screen, and the value changes at most once per page.

/**
 * WHOSE PROSE THIS IS, for a subtree rendering a project other than the page's own.
 *
 * Every hook below reads the page's project out of module state (the repo a `#123` links into, the root
 * a relative path resolves against) — right on a board, which shows one project, and wrong on the All
 * queues page, which shows every project on a page that names none. That page wraps each project's
 * cards in one of these, and every markdown surface inside — its own prose AND the shared question
 * cards it reuses — renders against that project without knowing the page is different.
 */
export const MarkdownScopeContext = createContext<Required<Pick<MarkdownScopeOptions, "repo" | "appPath">> & Pick<MarkdownScopeOptions, "baseDir" | "homeDir"> | null>(null)

/** The repo GitHub-style references link to, as a render input. */
export function useGithubRepoForLinks(): string | null {
  return useSyncExternalStore(subscribeGithubRepo, githubRepoForLinks, githubRepoForLinks)
}

/**
 * The project root a relative path in prose resolves against, as a render input.
 *
 * Same subscription shape, and the same reason, as the repo above: the board arrives after a thread's
 * own transcript query, so prose memoized on its markdown string alone renders its file links while
 * this is still empty and never rebuilds them.
 */
export function useLocalPathBase(): LocalPathBase {
  return useSyncExternalStore(subscribeLocalPathBase, localPathBase, localPathBase)
}

/**
 * Block prose → sanitized HTML. `asDocument` is the built-in file reader's (see mdToHtml), and so is an
 * explicit `baseDir` — the DOCUMENT's own directory, which outranks the project root a relative link
 * resolves against on every other surface.
 */
export function useMarkdownHtml(md: string, opts?: { baseDir?: string; asDocument?: boolean }): string {
  const pageRepo = useGithubRepoForLinks()
  const pageBase = useLocalPathBase()
  const scope = useContext(MarkdownScopeContext)
  const { baseDir, asDocument } = opts ?? {}
  const dir = baseDir ?? (scope ? scope.baseDir : pageBase.dir)
  const home = scope ? scope.homeDir : pageBase.home
  // `pageRepo` is deliberately a dependency even where it is not passed: without a scope it is an input
  // to mdToHtml through githubAutolink.ts's module state, not through this argument list.
  const html = useMemo(
    () => mdToHtml(md, { baseDir: dir, homeDir: home, document: asDocument, repo: scope?.repo, appPath: scope?.appPath }),
    [md, dir, home, asDocument, pageRepo, scope?.repo, scope?.appPath],
  )
  useGithubHovercardRefs(html)
  return html
}

/**
 * Queue every GitHub reference this prose contains for the batched hovercard fetch.
 *
 * IT LIVES IN THE RENDER HOOK, not in a component, so a hovercard is available on EVERY surface that
 * renders agent prose — the transcript, the signal cards, the question blocks, the plan and file
 * drawers — without each of them remembering to opt in. The scan is a string match guarded by an
 * `includes` (lib/githubHovercards.ts), and registration is idempotent, so prose with no references
 * costs one substring search per render.
 */
function useGithubHovercardRefs(html: string): void {
  const refs = useMemo(() => githubRefsInHtml(html), [html])
  useEffect(() => {
    if (refs.length > 0) noteGithubRefs(refs)
  }, [refs])
}

/** Inline-only prose → sanitized HTML, for hosts that are one line tall (see mdInlineToHtml). */
export function useInlineMarkdownHtml(md: string): string {
  const pageRepo = useGithubRepoForLinks()
  const pageBase = useLocalPathBase()
  const scope = useContext(MarkdownScopeContext)
  const dir = scope ? scope.baseDir : pageBase.dir
  const home = scope ? scope.homeDir : pageBase.home
  const html = useMemo(
    () => mdInlineToHtml(md, { baseDir: dir, homeDir: home, repo: scope?.repo, appPath: scope?.appPath }),
    [md, dir, home, pageRepo, scope?.repo, scope?.appPath],
  )
  useGithubHovercardRefs(html)
  return html
}
