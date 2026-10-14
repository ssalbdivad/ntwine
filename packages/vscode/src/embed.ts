// THE SIDEBAR'S PURE HALF — what the ntwine sidebar (sidebar.ts) frames, how it checks what the page
// says, which key chords it acts on, and where an editor command's selection goes. No `vscode` here, so
// every rule below is a unit test under plain node (embed.test.ts); sidebar.ts and app.ts are the glue.
// Design: ARCHITECTURE.md § VS Code extension. The wire: packages/shared/src/embed-protocol.ts.

import { isAbsolute } from "node:path"
import {
  EMBED_MAX_DROPPED,
  EMBED_MAX_QUERY,
  EMBED_PARAM,
  EMBED_PROTOCOL_VERSION,
  EMBED_THEME_PARAM,
  EMBED_VSCODE,
  type EmbedComposeMessage,
  type EmbedComposedMessage,
  type EmbedPageMessage,
  type EmbedTheme,
} from "@ntwine/shared/embed-protocol"

// ── the frame's address ──────────────────────────────────────────────────────────────────────────────

/**
 * `vscode.ColorThemeKind` → the page's two themes. The enum's values (Light 1, Dark 2, HighContrast 3,
 * HighContrastLight 4) are stable API, spelled out here so this module needs no `vscode`.
 */
export function embedTheme(kind: number): EmbedTheme {
  return kind === 1 || kind === 4 ? "light" : "dark"
}

/**
 * `<origin>/project/<slug>?embed=vscode&theme=dark` — this window's project's board — or
 * `<origin>/all?embed=…` (All projects) when no folder maps to one. The page reads the query once at boot; the PATH names its view
 * (web lib/pageView.ts). It was `/?…&project=<slug>` until 2026-10-06, while a board was a query on `/`; a
 * ntwine that new still redirects that shape to the path, so an older extension lands on the board too.
 */
export function embedUrl(origin: string, theme: EmbedTheme, projectSlug: string | undefined): string {
  const url = new URL(projectSlug ? projectPath(projectSlug) : ALL_PROJECTS_PATH, origin)
  url.searchParams.set(EMBED_PARAM, EMBED_VSCODE)
  url.searchParams.set(EMBED_THEME_PARAM, theme)
  return url.toString()
}

/**
 * All projects on the page, for a window whose folders map to no project. It was the bare `/` until
 * 2026-10-06, when a project's board became the page's default view and `/` a redirect to the last view
 * the BROWSER showed; a sidebar asks for its view by name (web lib/pageView.ts, whose legacy redirect still
 * sends an older extension's `/?embed=vscode` here).
 */
export const ALL_PROJECTS_PATH = "/all"

/** A project's board on the page — `/project/<slug>`, the slug one encoded segment whatever it holds. */
export function projectPath(projectSlug: string): string {
  return `/project/${encodeURIComponent(projectSlug)}`
}

/**
 * A thread's page in embed mode — `<origin>/project/<project>/thread/<slug>?embed=vscode&theme=…`: the page
 * boots in embed mode from the query as the sidebar's does, and the path is the thread's own address on
 * its project's board, which the page opens as its drawer painted open on the first render the board
 * arrives (a cold deep link; web lib/router.ts) — no queue flashing under a drawer sliding in, as a
 * navigate after ready would draw. What a thread's editor tab frames (thread-panel.ts). (A tab's page
 * draws no cards, so even a queued thread opens its drawer there: web store.ts resolveRoutedThread.)
 */
export function threadEmbedUrl(origin: string, theme: EmbedTheme, project: string, thread: string): string {
  const url = new URL(threadPath(project, thread), origin)
  url.searchParams.set(EMBED_PARAM, EMBED_VSCODE)
  url.searchParams.set(EMBED_THEME_PARAM, theme)
  return url.toString()
}

/** A thread on its project's board — `/project/<project>/thread/<slug>`, each name one encoded segment. */
export function threadPath(project: string, thread: string): string {
  return `${projectPath(project)}/thread/${encodeURIComponent(thread)}`
}

/**
 * The thread a page address shows — `/project/<project>/thread/<slug>` on a board or `/all/<project>/thread/<slug>`
 * on All projects, with or without `/full` — or undefined for any other page (the queue, Settings). What a
 * route's `href` says a frame shows.
 */
export function threadOfHref(href: string | undefined): { project: string; thread: string } | undefined {
  if (!href) return undefined
  let path: string
  try {
    path = new URL(href).pathname
  } catch {
    return undefined
  }
  const match = /^\/(?:project|all)\/([^/]+)\/thread\/([^/]+)(?:\/full)?\/?$/u.exec(path)
  if (!match) return undefined
  try {
    const project = decodeURIComponent(match[1]!)
    const thread = decodeURIComponent(match[2]!)
    return SLUG.test(project) && SLUG.test(thread) ? { project, thread } : undefined
  } catch {
    return undefined
  }
}

/** A URL's port as a number, its scheme's default when it names none (`new URL` drops a default port). */
function portOf(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

export type FrameTarget =
  | { kind: "frame"; url: string; origin: string }
  /** The window would reach ntwine on another port, which every ntwine gate refuses. */
  | { kind: "remapped"; port: number; external: number }

/**
 * What the frame may load, given the URL ntwine was found at and what `env.asExternalUri` made of it.
 * Locally the two are the same; under Remote-WSL the host may come back as `localhost`, which ntwine
 * accepts (local-origin.ts). A different PORT is a tunnel ntwine does not know about: its gate requires
 * the request's port to be its own, so the page and every request it made would be refused — the view
 * says so instead of framing a page that cannot work.
 */
export function frameTarget(discovered: string, external: string): FrameTarget {
  const before = new URL(discovered)
  const after = new URL(external)
  if (portOf(before) !== portOf(after)) return { kind: "remapped", port: portOf(before), external: portOf(after) }
  return { kind: "frame", url: after.toString(), origin: after.origin }
}

/**
 * An origin fit to go verbatim into a CSP and a script: http(s), a host, maybe a port, and nothing a
 * policy or a string could be broken out of with. `URL.origin` always is; this is the belt to that.
 */
export function safeOrigin(origin: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/u.test(origin) && new URL(origin).origin === origin
}

// ── what the page says ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isLine = (value: unknown) => value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000_000)
const MAX_FIELD = 8192

/**
 * A page → host message, checked field by field — the relay already took it only from its own frame at
 * ntwine's origin, and this is the second check the contract asks for. Anything unknown, misshapen or out
 * of bounds is `undefined`, which the sidebar ignores. Only the fields the contract names are kept.
 * `origin` is the frame's: a route's `href` is kept only on it (otherwise the route is kept without it).
 */
export function parsePageMessage(value: unknown, origin?: string): EmbedPageMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "ntwine:ready":
      return value.v === EMBED_PROTOCOL_VERSION ? { type: "ntwine:ready", v: EMBED_PROTOCOL_VERSION } : undefined
    case "ntwine:composed": {
      if (typeof value.id !== "string" || !value.id || value.id.length > 200 || typeof value.ok !== "boolean") return undefined
      if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > MAX_FIELD)) return undefined
      return { type: "ntwine:composed", id: value.id, ok: value.ok, ...(typeof value.error === "string" ? { error: value.error } : {}) }
    }
    case "ntwine:open-file": {
      const { path, line, column, endLine } = value
      if (typeof path !== "string" || !path || path.length > MAX_FIELD || path.includes("\0") || !(isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path))) return undefined
      if (!isLine(line) || !isLine(column) || !isLine(endLine)) return undefined
      return {
        type: "ntwine:open-file",
        path,
        ...(line === undefined ? {} : { line: line as number }),
        ...(column === undefined ? {} : { column: column as number }),
        ...(endLine === undefined ? {} : { endLine: endLine as number }),
      }
    }
    case "ntwine:open-external": {
      if (typeof value.url !== "string" || value.url.length > MAX_FIELD) return undefined
      const url = webUrl(value.url)
      return url ? { type: "ntwine:open-external", url } : undefined
    }
    case "ntwine:key": {
      const { key, code, ctrl, meta, shift, alt } = value
      if (typeof key !== "string" || typeof code !== "string" || key.length > 64 || code.length > 64) return undefined
      if (typeof ctrl !== "boolean" || typeof meta !== "boolean" || typeof shift !== "boolean" || typeof alt !== "boolean") return undefined
      return { type: "ntwine:key", key, code, ctrl, meta, shift, alt }
    }
    case "ntwine:add-context": {
      const { what, path } = value
      if (what === "selection" || what === "problems" || what === "terminal") return path === undefined ? { type: "ntwine:add-context", what } : undefined
      if (what !== "file" || typeof path !== "string" || !path || path.length > MAX_FIELD || path.includes("\0")) return undefined
      if (!(isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path))) return undefined
      return { type: "ntwine:add-context", what, path }
    }
    case "ntwine:share-editor":
      return typeof value.on === "boolean" ? { type: "ntwine:share-editor", on: value.on } : undefined
    case "ntwine:route": {
      const { view, title, description } = value
      if (view !== "queue" && view !== "thread" && view !== "settings" && view !== "other") return undefined
      if (typeof title !== "string" || title.length > MAX_TITLE) return undefined
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_TITLE)) return undefined
      const href = pageHref(value.href, origin)
      return { type: "ntwine:route", view, title, ...(description ? { description } : {}), ...(href ? { href } : {}) }
    }
    case "ntwine:review": {
      // Two names and nothing else: the extension asks ntwine what they mean (embed-protocol.ts).
      const { thread, project, title } = value
      if (typeof thread !== "string" || typeof project !== "string" || !SLUG.test(thread) || !SLUG.test(project)) return undefined
      if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE)) return undefined
      return { type: "ntwine:review", thread, project, ...(title ? { title } : {}) }
    }
    case "ntwine:pick-context": {
      // A search (`query`) or a drop (`uris`), never both: a drop names exactly what to add.
      const { id, query, uris } = value
      if (typeof id !== "string" || !id || id.length > 200) return undefined
      if (query !== undefined) {
        if (uris !== undefined || typeof query !== "string" || query.length > EMBED_MAX_QUERY) return undefined
        return { type: "ntwine:pick-context", id, query }
      }
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > EMBED_MAX_DROPPED) return undefined
      if (!uris.every((uri) => typeof uri === "string" && uri.length > 0 && uri.length <= MAX_FIELD && !uri.includes("\0"))) return undefined
      return { type: "ntwine:pick-context", id, uris: uris as string[] }
    }
  }
  return undefined
}

/** A thread's or project's slug as ntwine spells them in a route: no slash, no space, nothing to escape. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u

/** A thread's or project's slug, as `SLUG` admits one — for a name that came back from anywhere (a tab's saved state). */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value)
}

/** A title or its reading longer than this is not one the title row could show anyway. */
const MAX_TITLE = 500

/**
 * A route's address for ⋯ Open in browser: a page on the frame's own origin, normalized, or undefined — the
 * page cannot make that menu item open anywhere else. Optional on the wire: a page from before it sends none.
 */
function pageHref(value: unknown, origin: string | undefined): string | undefined {
  if (typeof value !== "string" || !origin || value.length > MAX_FIELD) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  return url.origin === origin ? url.toString() : undefined
}

/**
 * An http(s) URL with a host, or a `mailto:` with an address, normalized, or undefined: `javascript:`,
 * `file:`, `command:` and the like never reach `openExternal`. A mailto is the one scheme past the web's,
 * because a mail link in a transcript is a link the human clicked, and the sandboxed frame cannot open
 * the mail app itself.
 */
export function webUrl(text: string): string | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol === "mailto:") return url.pathname ? url.toString() : undefined
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined
  return url.toString()
}

// ── key chords ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The chords the sidebar runs for the human while the frame has focus — where no VS Code keybinding can
 * see a key. Each is VS Code's own DEFAULT chord for the command, matched by `KeyboardEvent.code` (the
 * physical key, as VS Code dispatches on Linux and Windows), with exactly the modifiers listed. Kept to
 * getting around the workbench: the palette, quick open, the side bar, the panel and terminal, back to
 * the editor, and the built-in views. Nothing that edits, closes or runs anything is here.
 *
 * `primary` is Cmd on a Mac and Ctrl elsewhere; the terminal and source control are Ctrl on every
 * platform, as VS Code binds them.
 *
 * One is ntwine's own rather than VS Code's default: ⌘L / Ctrl+L, Cursor's chord to its chat and back. In the
 * editor it comes to the sidebar's prompt box (package.json binds it: with a selection the selection comes
 * along as a chip); pressed here it goes back to the editor the human came from.
 */
const CHORDS: readonly { chord: string; command: string }[] = [
  { chord: "primary+shift+KeyP", command: "workbench.action.showCommands" },
  { chord: "primary+KeyP", command: "workbench.action.quickOpen" },
  { chord: "primary+KeyB", command: "workbench.action.toggleSidebarVisibility" },
  { chord: "primary+KeyJ", command: "workbench.action.togglePanel" },
  { chord: "ctrl+Backquote", command: "workbench.action.terminal.toggleTerminal" },
  { chord: "primary+KeyL", command: "workbench.action.focusActiveEditorGroup" },
  { chord: "primary+Digit1", command: "workbench.action.focusFirstEditorGroup" },
  { chord: "primary+shift+KeyE", command: "workbench.view.explorer" },
  { chord: "primary+shift+KeyF", command: "workbench.view.search" },
  { chord: "ctrl+shift+KeyG", command: "workbench.view.scm" },
  { chord: "primary+shift+KeyD", command: "workbench.view.debug" },
  { chord: "primary+shift+KeyX", command: "workbench.view.extensions" },
]

export interface KeyChord {
  code: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** The VS Code command a forwarded chord runs, or undefined for any chord the allowlist does not name. */
export function chordCommand(key: KeyChord, mac: boolean): string | undefined {
  for (const { chord, command } of CHORDS) {
    const parts = chord.split("+")
    const code = parts.pop()!
    const wants = { ctrl: false, meta: false, shift: false, alt: false }
    for (const part of parts) {
      if (part === "primary") wants[mac ? "meta" : "ctrl"] = true
      else wants[part as keyof typeof wants] = true
    }
    if (key.code === code && key.ctrl === wants.ctrl && key.meta === wants.meta && key.shift === wants.shift && key.alt === wants.alt) return command
  }
  return undefined
}

// ── where an editor command's selection goes ─────────────────────────────────────────────────────────

export interface SidebarReadiness {
  /** The `ntwine.useSidebar` setting. */
  enabled: boolean
  /** There is an ntwine for the sidebar to frame: connected, or found by discovery. */
  ntwine: boolean
}

/**
 * "Add to ntwine prompt", and every other way a piece of the editor gets into a prompt (a file from a tab
 * or the explorer, a problem's quick fix, a terminal selection): into the sidebar's front composer, with
 * the view revealed — opened, the first time in a window — and the caret after the chip. The sidebar is
 * where the human looks now (David, 2026-10-01: a Cursor-style shortcut that inlines the highlighted
 * code into the current prompt), so the first cut's rule — the browser until the sidebar had been opened
 * in this window — is gone. Off, or with no ntwine to frame, the server holds the item for a browser page,
 * as before the sidebar; a sidebar that never loads or refuses falls back to the same (app.ts).
 */
export function addRoute(sidebar: SidebarReadiness): "sidebar" | "server" {
  return sidebar.enabled && sidebar.ntwine ? "sidebar" : "server"
}

/**
 * "Ask ntwine…" and "Send to ntwine thread…": with the setting on, the sidebar's composer — it is revealed
 * (which opens it) and waited for — instead of a one-line input box. Text a caller passed as an argument
 * (a keybinding, another extension, a test) is a message to SEND, not a draft to write, so it keeps the
 * direct path that sends it.
 */
export function promptRoute(enabled: boolean, text: unknown): "sidebar" | "server" {
  return enabled && typeof text !== "string" ? "sidebar" : "server"
}

/** What `composeInSidebar` needs of the sidebar (sidebar.ts implements it). */
export interface ComposeSidebar {
  reveal(preserveFocus: boolean): Promise<void>
  waitReady(ms: number): Promise<boolean>
  compose(input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined>
}

/**
 * Put a selection into a composer of the sidebar's page: bring the view into sight (opening it, the first
 * time), wait for its page, post the item and wait for the page's answer. Anything short of the page
 * saying it took the item — it never got ready, never answered, or refused — is `ok: false` with the
 * reason for the log, and the command then takes its path from before the sidebar, so a selection is
 * never simply lost.
 */
export async function composeInSidebar(
  sidebar: ComposeSidebar,
  input: Omit<EmbedComposeMessage, "type" | "id">,
  options: { preserveFocus: boolean; readyMs: number; composeMs: number },
): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  await sidebar.reveal(options.preserveFocus)
  if (!(await sidebar.waitReady(options.readyMs))) return { ok: false, why: "The ntwine sidebar didn't load in time." }
  const answer = await sidebar.compose(input, options.composeMs)
  if (!answer) return { ok: false, why: "The ntwine sidebar didn't answer." }
  if (!answer.ok) return { ok: false, why: `The ntwine sidebar couldn't take it: ${answer.error ?? "no reason given"}` }
  return { ok: true, id: answer.id }
}
