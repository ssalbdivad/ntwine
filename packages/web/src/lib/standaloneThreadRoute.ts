import { outerPath } from "./base-path.ts"

/**
 * The href for a thread's standalone `/full` page — an OUTER path, because it goes straight into an
 * `<a href>` and the browser resolves it against the origin, not against the router.
 *
 * It MUST carry the project prefix. One Ntwine serves every project on the machine now, so the
 * unprefixed `/thread/<slug>/full` resolves against whichever project happened to launch the server:
 * the ↗ button on a thread in any OTHER project opened a page that either showed the wrong project's
 * thread of the same name or dead-ended in <MissingThread> (maintainer 2026-08-07, on the ↗ button:
 * "this is an old url"). Unprefixed output is still correct — and still what this returns — for the
 * launching project, which is served at the root.
 */
export function standaloneThreadHref(slug: string, pathname?: string): string {
  return outerPath(`/thread/${encodeURIComponent(slug)}/full`, pathname)
}

/** The slug in an INNER `/thread/<slug>/full` path (main.tsx feeds it `innerPath()`), or null. */
export function parseStandaloneThreadPath(path: string): string | null {
  const match = path.match(/^\/thread\/([^/]+)\/full$/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * Is this click one the SPA should handle itself? The fullscreen affordance is a real `<a href>` so the
 * browser owns every "open elsewhere" gesture — ⌘/Ctrl-click, middle-click, shift-click, right-click
 * → Open in new tab — and only an unmodified primary click is intercepted to navigate in place
 * (maintainer 2026-08-28: "if you click it normally, it just happens in the same tab; right-click or
 * command-click opens a new tab").
 */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
}
