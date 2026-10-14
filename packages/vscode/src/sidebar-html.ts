// THE SIDEBAR'S DOCUMENTS — the HTML VS Code serves into the ntwine view. Two kinds:
//
//  - the FRAME document: one full-bleed iframe of the ntwine page, and the relay script, which is the only
//    thing that runs in it. Its CSP names exactly one frame origin (ntwine's), loads nothing else, and lets
//    only its own nonce'd script and style run.
//  - a MESSAGE document: a line of copy and a button or two, in VS Code's own colours, for the states
//    with no page to show (ntwine not found, a port ntwine would refuse).
//
// Pure strings, no `vscode`: sidebar-html.test.ts pins the CSP, the escaping and the relay's rules.
//
// The relay. Three documents take part (embed-protocol.ts): the extension host, this document (served
// from a `vscode-webview://` origin) and the page in its iframe. Messages cross it unchanged:
//  - page → host: only from ITS iframe (`event.source === frame.contentWindow`) at ntwine's origin, sent on
//    as `{ page: <message> }`. The extension validates the message again (embed.ts parsePageMessage).
//  - host → page: VS Code's host frame delivers the extension's messages at this document's own origin
//    (pre/index.html, `contentWindow.postMessage(…, window.origin)`), and that ORIGIN is how they are
//    known: VS Code sets `window.parent = window` in a webview document (its injected API script), so
//    the source cannot be compared with the parent, and each webview's origin is its own — only VS
//    Code's frame and this document share it. A `ntwine:` message is posted on with `targetOrigin` =
//    ntwine's origin, so if the frame were ever somewhere else the browser drops it instead of handing it
//    selected code.
//  - the view's own traffic never reaches the page: `{ view: … }` from this document (its buttons, its
//    platform, `focused` when it takes the keyboard, `loaded` for each document the frame loads) and `{ view: "hint" }` from the extension, which
//    shows or hides the "hasn't loaded" bar.
// The envelope keeps the two apart, so nothing the page posts can pass for a click on Reload.
//
// THE EDITOR'S COLOURS. VS Code's API tells the extension only the theme's KIND; the colours themselves
// exist as the `--vscode-*` custom properties VS Code writes on this document's root (and the kind as a
// class on its body), rewritten in place when the human switches theme. So the relay is the one party
// that can read them: it puts the colours `EMBED_THEME_COLORS` names on every `ntwine:theme` it passes to
// the page, posts a fresh one whenever VS Code rewrites them (a MutationObserver on the root's style and
// the body's class), and puts the first one on the frame's address as a fragment, so the page's FIRST
// paint is already in them (embed-protocol.ts EMBED_THEME_FRAGMENT). While `ntwine.matchEditorTheme` is
// off (`match` false, then `{ view: "match-theme" }` from the extension) its theme messages carry no
// colours, and the page wears ntwine's own palette.

import { randomBytes } from "node:crypto"
import { EMBED_THEME_COLORS, EMBED_THEME_FRAGMENT, type EmbedSurface } from "@ntwine/shared/embed-protocol"
import { safeOrigin } from "./embed.ts"

export function nonce(): string {
  return randomBytes(18).toString("base64url")
}

/**
 * A value as a JavaScript literal inside an inline `<script>`: JSON, with `<` escaped so no `</script>`
 * (or `<!--`) can close or bend the element, and U+2028/U+2029, which JSON allows in a string and an older
 * engine's JavaScript grammar does not, escaped too.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029")
}

export function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
}

/** The policy for a document that loads nothing from anywhere, frames at most `frameOrigin`, and runs only its own nonce'd code. */
export function contentSecurityPolicy(nonceValue: string, frameOrigin?: string): string {
  return [
    "default-src 'none'",
    ...(frameOrigin ? [`frame-src ${frameOrigin}`] : []),
    `style-src 'nonce-${nonceValue}'`,
    `script-src 'nonce-${nonceValue}'`,
  ].join("; ")
}

/**
 * VS Code's own look: its font, colours and button tokens, so the message states read as part of the
 * workbench (a welcome view's copy and full-width button) and not as a web page.
 */
const STYLE = `
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: transparent; }
  .frame { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; display: block; background: transparent; }
  .message, .hint { padding: 12px 20px 16px; }
  .hint { border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .hint[hidden] { display: none; }
  p { margin: 0 0 12px; line-height: 1.4; }
  .actions { display: flex; flex-direction: column; gap: 8px; }
  button { font: inherit; padding: 4px 8px; line-height: 18px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; width: 100%; max-width: 300px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`

export interface ViewAction {
  /** What the extension receives as `{ view: action }`. */
  action: string
  label: string
  secondary?: boolean
}

function buttons(actions: readonly ViewAction[]): string {
  return actions
    .map(({ action, label, secondary }) => `<button type="button" data-action="${escapeHtml(action)}"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button>`)
    .join("")
}

/** Posts `{ view: <action> }` for a click on any `[data-action]` button. Shared by both documents. */
const CLICKS = `
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null
    if (button) vscode.postMessage({ view: button.dataset.action })
  })`

/** A short message in the view, with buttons. */
export function messageDocument(input: { nonce: string; text: string; actions: readonly ViewAction[] }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input.nonce)}">
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<div class="message" role="status"><p>${escapeHtml(input.text)}</p><div class="actions">${buttons(input.actions)}</div></div>
<script nonce="${input.nonce}">
  const vscode = acquireVsCodeApi()${CLICKS}
</script>
</body>
</html>`
}

/** The text and buttons of the bar shown over a page that has not said it is ready. */
export const HINT = {
  text: "ntwine hasn't finished loading here.",
  actions: [{ action: "reload", label: "Reload" }, { action: "browser", label: "Open in browser", secondary: true }],
} as const

/**
 * The bar's words when the ntwine the frame reached is one from before the sidebar (its editor connection
 * says so — sidebar.ts SidebarHost.pageSupport): its page will never say it is ready, and "hasn't finished
 * loading" sent the human to wait, or to Reload, for something that was never coming.
 */
export const HINT_OLD_NTWINE = "This ntwine is older than the sidebar. Update ntwine to use it here, or open it in your browser."

/**
 * The iframe of ntwine at `url` (whose origin is `origin`), and the relay. `hint`: the bar's words, shown
 * from the first paint — for an ntwine already known to predate the sidebar, rather than a message posted
 * at a document whose relay may not be listening yet. `state`: kept with VS Code's webview state
 * (`setState`), which is what a thread's editor tab is restored from after a window reload
 * (thread-panel.ts); JSON, and only names — never anything the page showed.
 */
export function frameDocument(input: {
  nonce: string
  url: string
  origin: string
  hint?: string
  /** Hand the page the editor's colours (`ntwine.matchEditorTheme`). Default on. */
  match?: boolean
  /** The surface this view sits on, whose background the page takes: the side bar's (default) or an editor tab's. */
  surface?: EmbedSurface
  /** Kept as the webview's state (`setState`), for a thread's tab restored after a reload: names only. */
  state?: Record<string, string>
}): string {
  const { url, origin } = input
  if (!safeOrigin(origin) || new URL(url).origin !== origin) throw new Error(`refusing to frame ${url} as ${origin}`)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input.nonce, origin)}">
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<div class="frame">
<div class="hint" id="hint" role="status"${input.hint ? "" : " hidden"}><p id="hint-text">${escapeHtml(input.hint ?? HINT.text)}</p><div class="actions">${buttons(HINT.actions)}</div></div>
<iframe id="ntwine" title="ntwine" allow="clipboard-read; clipboard-write; local-network-access"></iframe>
</div>
<script nonce="${input.nonce}">
  const vscode = acquireVsCodeApi()${input.state ? `
  vscode.setState(${scriptJson(input.state)})` : ""}
  const NTWINE = ${scriptJson(origin)}
  const frame = document.getElementById("ntwine")
  const hint = document.getElementById("hint")
  const hintText = document.getElementById("hint-text")
  const COLORS = ${scriptJson(EMBED_THEME_COLORS)}
  const SURFACE = ${scriptJson(input.surface ?? "sideBar")}
  let match = ${input.match === false ? "false" : "true"}
  let posted = ""
  // The theme as VS Code has drawn this document: its kind from the body's class (vscode-light,
  // vscode-dark, vscode-high-contrast, and vscode-high-contrast-light beside the last), else the
  // extension's word; its colours from the root's custom properties, while matching is on.
  const themeMessage = (theme) => {
    const classes = document.body.classList
    const light = classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light")
    const known = light || classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")
    const message = { type: "ntwine:theme", theme: known ? (light ? "light" : "dark") : theme === "light" ? "light" : "dark" }
    if (!match) return message
    const style = getComputedStyle(document.documentElement)
    const colors = {}
    for (const name of COLORS) {
      const value = style.getPropertyValue("--vscode-" + name).trim()
      if (value && value.length <= 64) colors[name] = value
    }
    message.colors = colors
    message.surface = SURFACE
    if (classes.contains("vscode-high-contrast")) message.contrast = true
    return message
  }
  const postTheme = (message) => {
    posted = JSON.stringify(message)
    frame.contentWindow.postMessage(message, NTWINE)
  }
  // VS Code rewrites the properties one by one in a single task; the observer hears them as one batch.
  const restyled = new MutationObserver(() => {
    const message = themeMessage(undefined)
    if (JSON.stringify(message) !== posted) postTheme(message)
  })
  restyled.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] })
  restyled.observe(document.body, { attributes: true, attributeFilter: ["class"] })
  posted = JSON.stringify(themeMessage(undefined))
  // Every document the frame loads — the first, and any the page loads itself (a reload after ntwine
  // restarts) — including the browser's error page for a reload that reached no server. The extension
  // counts them: a page that reloaded and never says it is ready is gone (sidebar.ts).
  frame.addEventListener("load", () => vscode.postMessage({ view: "loaded" }))
  frame.src = ${scriptJson(url)} + (match ? ${scriptJson(`#${EMBED_THEME_FRAGMENT}`)} + encodeURIComponent(posted) : "")
  window.addEventListener("message", (event) => {
    const data = event.data
    if (event.source === frame.contentWindow) {
      if (event.origin === NTWINE) vscode.postMessage({ page: data })
      return
    }
    if (event.origin !== window.origin) return
    if (!data || typeof data !== "object") return
    if (data.view === "hint") {
      hint.hidden = !data.show
      if (typeof data.text === "string") hintText.textContent = data.text
      return
    }
    if (data.view === "match-theme") {
      match = data.on === true
      postTheme(themeMessage(undefined))
      return
    }
    if (typeof data.type !== "string" || !data.type.startsWith("ntwine:")) return
    if (data.type === "ntwine:theme") {
      postTheme(themeMessage(data.theme))
      return
    }
    // The page puts the caret in its composer, or opens the door a title-row button names (New thread's
    // caret, the palette's search box, Settings); the frame has to hold the focus for either to take the
    // keyboard. Without it a button left the keyboard in this document, where no key reaches the page.
    if (data.focus === true || data.type === "ntwine:command") frame.focus()
    frame.contentWindow.postMessage(data, NTWINE)
  })
  // Focus that lands on this document (the view revealed, a click on its edge) belongs to the page. Also
  // when this document's focused element is ALREADY the frame: VS Code's webview host focuses this WINDOW
  // (its active frame's contentWindow.focus()) as it settles a view's focus, and a focused window is the
  // focused frame — the page under it loses the keyboard though nothing here moved. Focusing the frame
  // element again would be a no-op (it is the active element), so the page's window is focused instead.
  //
  // And the extension hears of it: which ntwine the human used last — the sidebar or a thread's tab — is
  // where Ctrl+L in the editor takes the selection (app.ts frontFrame).
  window.addEventListener("focus", () => {
    vscode.postMessage({ view: "focused" })
    setTimeout(() => {
      if (document.activeElement === document.body) frame.focus()
      else if (document.activeElement === frame) frame.contentWindow.focus()
    })
  })${CLICKS}
  vscode.postMessage({ view: "platform", mac: /Mac/.test(navigator.platform) })
</script>
</body>
</html>`
}
