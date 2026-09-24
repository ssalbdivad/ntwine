/**
 * Where a URL the page tries to open belongs.
 *
 * A browser tab gets this for free: a link to GitHub opens another tab of the operator's own browser,
 * signed in and with their extensions. A bare BrowserWindow has no tabs, so without a policy every
 * `target=_blank` link — and Frizz sets one on every link in rendered Markdown — opens a chromeless
 * Electron window on an anonymous profile. So the window only ever shows the Frizz server's own
 * origin, and everything else is handed to the OS.
 *
 * Link targets are untrusted: workers write the Markdown they come from. Only http(s) and mailto are
 * handed to the OS opener, the same allowlist `open-external.ts` holds the server's opener to; a
 * `file:`, `javascript:` or custom-scheme link is dropped rather than launched.
 */
export type NavigationTarget = "app" | "external" | "blocked"

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export function classifyNavigation(rawUrl: string, appOrigin: string | undefined): NavigationTarget {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return "blocked"
  }
  if (appOrigin !== undefined && url.origin === appOrigin) return "app"
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "blocked"
}

/**
 * The in-app part of an address — what is remembered across launches. Only a path on the server's
 * own origin is kept, because the port can differ next time (the launcher falls back off its default
 * when that is taken) and the origin is whatever server this launch finds.
 */
export function appPath(rawUrl: string, appOrigin: string): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.origin !== appOrigin) return undefined
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Where a launch opens: the remembered in-app path on this launch's server, or the server's root.
 * The path is resolved AGAINST the origin and then checked, because a remembered `//host/…` would
 * otherwise resolve to another host entirely.
 */
export function startAddress(savedPath: string | undefined, serverOrigin: string): string {
  const root = `${serverOrigin}/`
  if (!savedPath) return root
  try {
    const url = new URL(savedPath, serverOrigin)
    return url.origin === serverOrigin ? url.toString() : root
  } catch {
    return root
  }
}
