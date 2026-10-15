/**
 * The screens this app draws itself: while it looks for the board, while no board is up, and when the
 * page crashes. Everything else in the window is the server's own page. Plain HTML in a data: URL, so
 * there is nothing to bundle, and colours that follow the OS theme like the board's own first paint does.
 */

const STYLE = `
  :root { color-scheme: dark light; --bg: #0d0e10; --fg: #e6e6e6; --dim: #8b8d91; --line: #2a2c30; --accent: #e6e6e6; }
  @media (prefers-color-scheme: light) { :root { --bg: #f7f7f7; --fg: #1d1e20; --dim: #6b6d71; --line: #d9dadc; --accent: #1d1e20; } }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); }
  body { display: grid; place-items: center; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-user-select: text; }
  main { max-width: 560px; padding: 32px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 10px; color: var(--dim); overflow-wrap: anywhere; }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .actions { display: flex; gap: 8px; margin-top: 18px; }
  button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button.primary { border-color: var(--accent); }
`

function page(title: string, body: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`)
}

export function loadingPage(): string {
  return page("ntwine", `<h1>Connecting…</h1>`)
}

/** No board is up yet. The app keeps looking and opens it the moment one answers. */
export function waitingPage(url?: string): string {
  const where = url ? `<p>Waiting for <code>${escapeHtml(url)}</code> to answer.</p>` : `<p>Start one with <code>nub run dev</code>. It opens here as soon as it is up.</p>`
  return page("ntwine", `<h1>No board is running</h1>${where}`)
}

/** This app started ntwine, and it is not answering yet — a first launch builds the board first. */
export function startingPage(): string {
  return page("ntwine", `<h1>Starting ntwine…</h1><p>It opens here as soon as it is up.</p>`)
}

/** The server this app started stopped before a board answered. The app keeps looking regardless. */
export function startFailedPage(log: string): string {
  return page(
    "ntwine",
    `<h1>ntwine couldn't start</h1><p>Its output is in <code>${escapeHtml(log)}</code>.</p>` +
      `<div class="actions"><button class="primary" onclick="ntwineDesktop.retry()">Try again</button></div>`,
  )
}

export function errorPage(options: { title: string; message: string }): string {
  return page(
    "ntwine",
    `<h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p>` +
      `<div class="actions"><button class="primary" onclick="ntwineDesktop.retry()">Try again</button></div>`,
  )
}
