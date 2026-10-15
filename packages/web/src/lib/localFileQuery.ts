import { projectRpc, rpc } from "../api/rpc.ts"
import { renderCodeBody } from "./codeBody.ts"
import { isLocalMarkdownFile } from "./markdownTargets.ts"
import { resolveFileLanguage } from "./syntaxHighlight.ts"

// The ONE read of a local file the /full split viewer renders, shared by the panel that shows it and
// by the rail row that PREWARMS it on hover (maintainer 2026-09-01: "consider rendering optimizations
// like eager rendering when the user hovers over a given changed file"). Both must use the identical
// key and fetcher or the prefetch warms a cache entry the panel never looks in.
//
// Markdown reads through the reader gate (`.md` only, canonical path included); anything else reads
// through the text gate, which since 2026-09-03 is rooted identically — home-and-below plus the temp
// trees — so a worker's worktree file opens as readily as one in the project dir. Either way the result
// carries the CANONICAL path (symlinks resolved), which is what the panel labels, links relative to,
// and stamps on context items.
// The key alone — what the socket's `file-changed` frame invalidates (api/socket.ts), keyed by the
// path the reader subscribed with, which is the path it queried with.
//
// `project` names whose gate reads the file when that is not the page's own: a card on the everything
// page opens a file of ITS project (AllQueuesCard ProjectLinkScope), and a checkout outside home is
// readable only through that project's roots. It is the key's LAST element, so the socket's
// two-element key still invalidates it (TanStack matches a key by prefix).
export function localFileQueryKey(path: string, project?: string): readonly string[] {
  const kind = isLocalMarkdownFile(path) ? "localMarkdown" : "localFile"
  return project ? [kind, path, project] : [kind, path]
}

export function localFileQuery(path: string, project?: string) {
  const markdown = isLocalMarkdownFile(path)
  const api = project ? projectRpc(project) : rpc
  return {
    queryKey: localFileQueryKey(path, project),
    queryFn: async () => {
      if (markdown) return api.localMarkdown({ path })
      const read = await api.localFile({ path })
      return { path: read.path, markdown: read.text, truncated: read.truncated }
    },
    // Long enough that a hover followed by a click is ONE read. Freshness while the file is OPEN is
    // the live watch's job (useLiveLocalFile: the server pushes `file-changed`, the key above is
    // invalidated, and the reader re-reads), so this only decides whether a re-open re-reads.
    staleTime: 5_000,
  }
}

// The reader's poll cadence when the /ws push is not live (a pre-/ws server, or the SSE fallback):
// the same "read it again" on a clock instead of on a change, and never while the push is up.
export const LOCAL_FILE_POLL_MS = 2_000

// Highlighted source markup, memoised across mounts. hljs over a few thousand lines is a single
// blocking task, and the one moment it must not run is while the viewer is sliding in — so the hover
// prewarm pays it during the idle time before the click, and the panel then just reads the string.
const HIGHLIGHTED = new Map<string, { raw: string; html: string }>()
const HIGHLIGHTED_MAX = 12

export function highlightedSource(path: string, raw: string): string {
  const hit = HIGHLIGHTED.get(path)
  if (hit && hit.raw === raw) return hit.html
  const html = renderCodeBody(raw, resolveFileLanguage(path))
  HIGHLIGHTED.set(path, { raw, html })
  // Insertion-ordered, so the oldest key is the first one out — a plain LRU is not worth the bookkeeping
  // for a cache this small, and the reader only ever moves between a handful of files.
  if (HIGHLIGHTED.size > HIGHLIGHTED_MAX) {
    const oldest = HIGHLIGHTED.keys().next()
    if (!oldest.done) HIGHLIGHTED.delete(oldest.value)
  }
  return html
}

