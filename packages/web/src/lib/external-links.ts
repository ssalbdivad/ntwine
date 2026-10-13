// Ntwine normally runs in an ordinary browser tab. External http(s) anchors should therefore stay in
// the browser's native click path: target=_blank opens a normal tab synchronously from the user
// gesture, preserves modifier-key behavior, and cannot be stranded behind an async RPC. Internal
// links and non-http schemes are left untouched so local navigation remains local.
//
// IN AN EDITOR'S SIDEBAR (lib/embed.ts) there is no new tab to open: a VS Code webview cannot open a
// window, so a `target=_blank` click and a `window.open` both do nothing at all. There the same external
// anchors are cancelled and handed to the editor (`ntwine:open-external`), which opens them in the
// system browser. Still decided in the CAPTURE phase, before any component sees the click: several of
// these anchors stop the click's propagation in their own onClick (ThreadLinks, the GitHub picker's
// rows), so a listener that waited for the bubble would never hear them.

import { innerPath } from "./base-path.ts"
import { embedded, postToHost } from "./embed.ts"
import { spaNavigate } from "./router.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"

type AnchorLike = Pick<HTMLAnchorElement, "getAttribute" | "setAttribute" | "hasAttribute">

/** Resolve an untrusted href, accepting only http(s). Useful for explicit link-like controls too. */
export function safeHttpUrl(raw: string, baseHref: string): string | null {
  try {
    const url = new URL(raw, baseHref)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Give an external http(s) anchor safe native new-tab attributes. Returns true only when the anchor
 * is external. No navigation is prevented or synthesized here; the browser completes the click.
 */
export function prepareExternalAnchor(anchor: AnchorLike, currentHref: string): boolean {
  const href = anchor.getAttribute("href")
  if (!href) return false
  const targetUrl = safeHttpUrl(href, currentHref)
  if (!targetUrl) return false

  let currentUrl: URL
  try {
    currentUrl = new URL(currentHref)
  } catch {
    return false
  }
  if (new URL(targetUrl).origin === currentUrl.origin) return false

  anchor.setAttribute("target", "_blank")
  const rel = new Set((anchor.getAttribute("rel") ?? "").split(/\s+/u).filter(Boolean))
  rel.add("noopener")
  rel.add("noreferrer")
  anchor.setAttribute("rel", [...rel].join(" "))
  return true
}

/**
 * Exported for focused node tests; the installed listener delegates to this exact handler. `toHost` is
 * set in embed mode: an external anchor's click is cancelled and its URL handed there instead — a middle
 * click too, whose new tab a webview cannot open either.
 */
export function createExternalLinkClickHandler(
  currentHref: () => string = () => location.href,
  toHost?: (url: string) => void,
): (event: MouseEvent) => void {
  return (event) => {
    if (event.defaultPrevented) return
    if (event.button !== 0 && !(toHost && event.button === 1)) return
    const anchor = findAnchor(event)
    if (!anchor || !prepareExternalAnchor(anchor, currentHref())) return
    const url = toHost ? safeHttpUrl(anchor.getAttribute("href") ?? "", currentHref()) : null
    if (!toHost || !url) return
    event.preventDefault()
    toHost(url)
  }
}

function hostOpens(url: string): void {
  postToHost({ type: "ntwine:open-external", url })
}

/** What a sidebar does with a click on an anchor the browser would otherwise have opened in a tab. */
export type EmbedLinkAction = { kind: "navigate"; path: string } | { kind: "external"; url: string }

/**
 * IN AN EDITOR'S SIDEBAR, THE ANCHORS THAT WOULD OPEN A TAB — which a webview cannot, so a click on one
 * did nothing at all (sweep 2026-10-01): agent prose's in-app links (markdown.ts stamps `target=_blank` on
 * every anchor), `mailto:`, and the modified or middle click a thread link or @mention leaves to the
 * browser on purpose (lib/thread-links.ts, MentionLinks.tsx). Each gets the destination the browser gives
 * it, in the editor's terms:
 *
 *   mailto:                                  the mail client, through the editor — its `openExternal`
 *   ⌘/Ctrl/Shift/Alt or middle click, in-app the browser, with the address — the "open in a new tab" it asked for
 *   a thread's /full page                    the browser, as `f` does: the frame is the drawer's width already
 *   any other in-app page (`/`, `/project/…`) here, in the frame — the tab it would have opened
 *
 * A plain click on a thread's address is not here: lib/thread-links.ts opens its drawer. Same-origin
 * paths under `/_ntwine/` are Ntwine's API, not the app, and are left alone, as is everything cross-origin
 * (createExternalLinkClickHandler). Null when the click is not one of these. Pure, for its test.
 */
export function embedLinkAction(
  href: string,
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; blank: boolean },
  currentHref: string,
): EmbedLinkAction | null {
  let url: URL
  let current: URL
  try {
    url = new URL(href, currentHref)
    current = new URL(currentHref)
  } catch {
    return null
  }
  if (url.protocol === "mailto:") return click.button === 0 || click.button === 1 ? { kind: "external", url: url.toString() } : null
  if (url.origin !== current.origin || url.pathname.startsWith("/_ntwine/")) return null
  if (click.button === 1 || (click.button === 0 && (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey))) return { kind: "external", url: url.toString() }
  if (click.button !== 0 || !click.blank) return null
  const inner = innerPath(url.pathname)
  if (parseStandaloneThreadPath(inner) !== null) return { kind: "external", url: url.toString() }
  if (/^\/thread\//u.test(inner)) return null
  return { kind: "navigate", path: `${url.pathname}${url.search}${url.hash}` }
}

function createEmbedLinkClickHandler(currentHref: () => string = () => location.href): (event: MouseEvent) => void {
  return (event) => {
    if (event.defaultPrevented) return
    const anchor = findAnchor(event)
    const href = anchor?.getAttribute("href")
    if (!anchor || !href) return
    const action = embedLinkAction(href, { button: event.button, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, blank: anchor.getAttribute("target") === "_blank" }, currentHref())
    if (!action) return
    event.preventDefault()
    // Nothing under it acts on the click either: the thread-link and @mention handlers would open the
    // drawer here as well as the address in the browser.
    event.stopPropagation()
    if (action.kind === "external") hostOpens(action.url)
    else spaNavigate(action.path)
  }
}

export function installExternalLinkInterceptor(): () => void {
  const host = embedded()
  const handler = createExternalLinkClickHandler(undefined, host ? hostOpens : undefined)
  const inApp = host ? createEmbedLinkClickHandler() : null
  document.addEventListener("click", handler, true)
  if (host) document.addEventListener("auxclick", handler, true)
  if (inApp) {
    document.addEventListener("click", inApp, true)
    document.addEventListener("auxclick", inApp, true)
  }
  return () => {
    document.removeEventListener("click", handler, true)
    document.removeEventListener("auxclick", handler, true)
    if (inApp) {
      document.removeEventListener("click", inApp, true)
      document.removeEventListener("auxclick", inApp, true)
    }
  }
}

/**
 * Open a web page from code — a control that is not an anchor. A new tab in a browser; in an editor's
 * sidebar, the editor's `openExternal`. Only http(s) ever leaves.
 */
export function openExternalUrl(raw: string): void {
  const url = safeHttpUrl(raw, location.href)
  if (!url) return
  if (embedded()) hostOpens(url)
  else window.open(url, "_blank", "noreferrer,noopener")
}

// Nearest enclosing anchor with an href — via composedPath (crosses shadow boundaries) with a
// closest() fallback. Structural detection keeps this helper testable without a synthetic DOM.
function findAnchor(event: MouseEvent): HTMLAnchorElement | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : []
  for (const value of path) {
    if (isAnchor(value)) return value
  }
  const target = event.target as { closest?: (selector: string) => unknown } | null
  const closest = target?.closest?.("a[href]")
  return isAnchor(closest) ? closest : null
}

function isAnchor(value: unknown): value is HTMLAnchorElement {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HTMLAnchorElement>
  return candidate.tagName?.toLowerCase() === "a"
    && typeof candidate.getAttribute === "function"
    && typeof candidate.setAttribute === "function"
    && typeof candidate.hasAttribute === "function"
    && candidate.hasAttribute("href")
}
