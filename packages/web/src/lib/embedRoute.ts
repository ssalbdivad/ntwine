import { EMBED_PARAM, EMBED_THEME_PARAM, type EmbedRouteMessage } from "@ntwine/shared"
import { embedded, postToHost } from "./embed.ts"

// WHERE THE SIDEBAR IS, said to VS Code's title row (`ntwine:route`, packages/shared/src/embed-protocol.ts).
// An editor's sidebar draws no header of its own (ARCHITECTURE.md § VS Code extension):
// the row VS Code already draws above the frame is the header, so the page tells it the view's name and
// the reading beside it, and the row's buttons come back as `ntwine:command` (lib/embedCommand.ts).
//
// The page's own surfaces decide the reading (AllQueues.tsx SidebarPage, StandaloneThreadPage.tsx); this
// module is what they share — the pure choice of what the row says, and a poster that says it only when
// it changed, since the page re-renders on every poll.

export type EmbedRoute = Omit<EmbedRouteMessage, "type">

/**
 * What the title row says, from what is in front of the human, most specific first: Settings over
 * everything, then the thread a drawer shows, then any other drawer (a file opened on its own), and
 * otherwise the queue — named by its scope ("All projects", a project's name), with its counts beside it.
 * Overlays that come and go in a moment (the palette, the shortcuts sheet, a menu) change nothing.
 */
export function sidebarRoute(input: {
  settings: boolean
  /** The title of the thread a drawer shows, else null. */
  thread: string | null
  /** The label of another drawer on top when no thread is open (a file's name), else null. */
  other: string | null
  /** The queue's scope: "All projects" or the focused project's name. */
  scope: string
  /** The queue's counts line (queueReading), or null while the queues are still loading. */
  reading: string | null
}): EmbedRoute {
  if (input.settings) return { view: "settings", title: "Settings" }
  if (input.thread !== null) return { view: "thread", title: input.thread }
  if (input.other !== null) return { view: "other", title: input.other }
  return input.reading ? { view: "queue", title: input.scope, description: input.reading } : { view: "queue", title: input.scope }
}

/**
 * The queue's counts as one line: `7 queued · 2 running`, or `Nothing needs you` — the bands' names,
 * Queue and Running (BandLabel.tsx; `ready · working` until 2026-10-06). "Queued" is the desktop's
 * QUEUE count (AllQueues.tsx `ready`, the header over the cards) — every card, a question included — so the
 * sidebar and a browser tab never disagree about how many there are. It read the phone header's line until
 * 2026-10-01 (`1 needs you · 6 ready`), whose "ready" leaves the questions out: beside a desktop saying 7,
 * the sidebar said 6. The rows' own glyphs show which ones ask.
 */
export function queueReading(counts: { ready: number; working: number }): string {
  const parts = [counts.ready > 0 ? `${counts.ready} queued` : null, counts.working > 0 ? `${counts.working} running` : null].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(" · ") : "Nothing needs you"
}

/**
 * The page's own address for what it shows, as a browser tab would open it: the frame's address less the
 * embed switch and the theme (lib/embed.ts read those once, at boot), and any fragment. ⋯ Open in browser
 * opens it (packages/vscode/src/app.ts), so a thread up in the sidebar opens as that thread.
 */
export function pageHref(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(EMBED_PARAM)
  url.searchParams.delete(EMBED_THEME_PARAM)
  url.hash = ""
  return url.toString()
}

let last: EmbedRouteMessage | null = null

/**
 * Tell the title row, if this page is in an editor's sidebar and the reading — or the address, when the
 * caller names one (pageHref) — moved.
 */
export function reportRoute(route: EmbedRoute): void {
  if (!embedded()) return
  const message: EmbedRouteMessage = {
    type: "ntwine:route",
    view: route.view,
    title: route.title,
    ...(route.description ? { description: route.description } : {}),
    ...(route.href ? { href: route.href } : {}),
  }
  if (last && JSON.stringify(last) === JSON.stringify(message)) return
  last = message
  postToHost(message)
}

/**
 * Say the last reading again — right after `ntwine:ready` (lib/embedHost.ts): the page renders its first
 * view before the board it waits on for ready has come, and an extension that listens only once the page
 * is ready would otherwise keep its default title until the reading next moved.
 */
export function repostRoute(): void {
  if (last) postToHost(last)
}
