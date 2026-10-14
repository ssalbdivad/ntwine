import type { QueryClient } from "@tanstack/react-query"
import { openThread } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { openSubAgentMention } from "../hooks/useSubAgentDirectory.ts"
import { crossProjectHref, innerPath, projectSlug } from "./base-path.ts"
import { spaNavigate } from "./router.ts"

// A worker can emit a markdown link to another ntwine thread — `[label](/thread/<slug>)` — e.g. after
// spawning one via the ntwinectl spawn-thread command. `/thread/<slug>` is a RESERVED SPA route
// (markdownTargets.ts isNtwineRoute), so markdown.ts leaves it a normal anchor rather than a local-file
// button. This one delegated listener intercepts a plain left-click on any such anchor and opens the
// thread IN THE DRAWER (openThread — dedupes/raises if already open) instead of letting the browser
// navigate a new tab. A modified click (⌘/ctrl/shift/alt) is left alone so the same href still works
// as a real deep-link opened in a new tab. Covers every sanitized markdown surface (chat, the doc
// drawer, drawers) since it delegates from document.
//
// Matched against the INNER path, because markdown.ts now stamps this page's project prefix onto an
// unprefixed in-app link (see prefixedAppRoute — the raw href had to become navigable in its own
// right, for the modified clicks this handler deliberately does not take). Opening in the drawer is
// only right for a thread of the project already in focus; a link naming a DIFFERENT project goes to
// that thread's drawer address through the router, which opens it in place (the focus moves), where
// leaving it to the browser reloaded the whole page.
//
// A SUB-AGENT MENTION in agent prose (`@port-the-parser.cache-keys`, lib/mentionAutolink.ts) is the same
// link with the child's address in the fragment — `/thread/<slug>#port-the-parser.cache-keys` — so a
// modified click still lands on the thread, and a plain one here resolves the address against the
// thread's sub-agent directory and opens the child (openSubAgentMention, the path a human's mention
// takes too). Across projects the fragment is dropped: the directory is asked of the page's project.
const THREAD_HREF = /^\/thread\/([a-z0-9][a-z0-9-]*)\/?(?:#([\p{L}\p{N}_.-]+))?$/u

/** The thread an in-app href (its INNER path) opens, and the sub-agent address in its fragment. */
export function threadLinkTarget(inner: string): { slug: string; address?: string } | null {
  const match = THREAD_HREF.exec(inner)
  if (!match) return null
  return match[2] ? { slug: match[1]!, address: match[2] } : { slug: match[1]! }
}

// A PROJECT MENTION in agent prose (`#arktype`, lib/mentionAutolink.ts) links to that project's board,
// `/project/<slug>`. A plain click moves the page there in place through the router, as the dock does,
// where the browser would reload the whole app; a modified click is left to it. The board's address was
// `/?project=<slug>` until 2026-10-06, and prose written then still carries it; the router redirects it.
const PROJECT_VIEW_HREF = /^\/(?:project\/[^/?#\s]+\/?|\?project=[^&#\s]+)$/u

export function installThreadLinkInterceptor(queryClient: QueryClient): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const projectLink = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="/project/"], a[href^="/?project="]') : null
    const projectHref = projectLink?.getAttribute("href")
    if (projectHref && PROJECT_VIEW_HREF.test(projectHref)) {
      event.preventDefault()
      event.stopPropagation()
      spaNavigate(projectHref)
      return
    }
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href*="/thread/"]') : null
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || !href.startsWith("/")) return
    const linked = projectSlug(href)
    const inner = innerPath(href)
    const target = threadLinkTarget(inner)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (linked && linked !== projectSlug()) {
      spaNavigate(`${crossProjectHref(linked)}/thread/${target.slug}`)
      return
    }
    if (target.address) void openSubAgentMention(queryClient, rpc, undefined, target.slug, target.address)
    else openThread(target.slug)
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}
