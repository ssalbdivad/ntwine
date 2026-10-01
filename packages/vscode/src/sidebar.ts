// SPIKE (branch vscode-sidebar-spike, never merged): a sidebar WebviewView that iframes a live Frizz
// page. The question it answers is whether the page survives being framed three deep — the workbench,
// VS Code's vscode-webview:// host frame, our HTML, then http://127.0.0.1:<port> — with its RPC, its
// SSE board channel, its app socket and its composer all working. Findings: the thread's
// sidebar-spike.md. Only `import type` from vscode, like app.ts.

import { randomBytes } from "node:crypto"
import type * as vscode from "vscode"

type Vscode = typeof vscode

export const SIDEBAR_VIEW = "frizz.sidebar"

export interface Sidebar {
  /** Point the frame at an address on the connected Frizz (resolved through asExternalUri). */
  navigate(url: string): Promise<string>
  /** The address the frame was last pointed at, after asExternalUri. */
  current(): string | undefined
}

export function registerSidebar(api: Vscode, context: vscode.ExtensionContext, initialUrl: () => string | undefined, log: (line: string) => void): Sidebar {
  let view: vscode.WebviewView | undefined
  let wanted: string | undefined
  let shown: string | undefined

  const render = async () => {
    if (!view) return
    const target = wanted ?? initialUrl()
    if (!target) {
      view.webview.html = page(undefined, undefined)
      return
    }
    // On a local window this is the identity; on Remote-WSL / SSH / Codespaces it is the forwarded
    // address the WINDOWS-side webview can reach — the frame runs on the client, the server in WSL.
    const external = (await api.env.asExternalUri(api.Uri.parse(target))).toString(true)
    shown = external
    const origin = new URL(external).origin
    log(`sidebar: framing ${target} as ${external}`)
    view.webview.html = page(external, origin)
  }

  context.subscriptions.push(
    api.window.registerWebviewViewProvider(SIDEBAR_VIEW, {
      resolveWebviewView(resolved) {
        view = resolved
        resolved.webview.options = { enableScripts: true }
        resolved.onDidDispose(() => (view = undefined))
        void render()
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
  )

  return {
    async navigate(url) {
      wanted = url
      await render()
      return shown ?? url
    },
    current: () => shown,
  }
}

function page(url: string | undefined, origin: string | undefined): string {
  const nonce = randomBytes(16).toString("base64")
  if (!url || !origin) {
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground)">Looking for Frizz…</body></html>`
  }
  // frame-src names exactly the Frizz origin. Nothing else is loaded by this document; everything the
  // page fetches is governed by ITS OWN origin's rules, not this CSP.
  const csp = [
    "default-src 'none'",
    `frame-src ${origin}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="frizz" src="${escapeAttr(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
  const frame = document.getElementById("frizz")
  frame.addEventListener("load", () => console.log("frizz-sidebar: frame load " + frame.src))
</script>
</body>
</html>`
}

function escapeAttr(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;")
}
