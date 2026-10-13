// THE SIDEBAR EMBED — the wire between the VS Code extension's Ntwine sidebar (packages/vscode/src/sidebar.ts)
// and the real Ntwine page it frames (packages/web/src/lib/embed.ts). Design and rationale:
// ARCHITECTURE.md § VS Code extension.
//
// Three documents take part: the extension host (Node), the webview document VS Code serves from a
// `vscode-webview://` origin (a relay script and nothing else), and the Ntwine page in an iframe of it,
// at the origin the extension discovered (`http://127.0.0.1:<port>`). The relay passes these messages
// through unchanged, in both directions, and checks where each one came from:
//
//  - page → host: the relay forwards only what arrives from ITS iframe (`event.source ===
//    frame.contentWindow`) at Ntwine's origin; the extension validates the shape again and acts only on
//    what it knows (an unknown type is ignored, a URL that is not http(s) or mailto is refused, a key
//    chord runs a command only if the extension's own allowlist names it).
//  - host → page: the relay posts with `targetOrigin` = Ntwine's origin, so selected code is never handed
//    to a document from anywhere else; the page accepts host messages only from `window.parent`.
//
// Nothing here goes through the Ntwine server: a selection reaches the sidebar's composer directly, so the
// server's held-item path (`compose` → `composeTake`, claimed by whichever page has focus) stays what it is
// for browser tabs, and the sidebar never races a tab — or the human's own typing — for an item.
//
// Pure types and constants, no zod: the extension bundles this module, and so does the page.

import type { EditorComposeInput } from "./editor-protocol.ts"

/**
 * The query the extension puts on the frame's URL — `?embed=vscode&theme=dark&project=<slug>` — read ONCE
 * by the page at boot and kept for that page's session (in-app navigation drops the query).
 */
export const EMBED_PARAM = "embed"
export const EMBED_VSCODE = "vscode"
export const EMBED_THEME_PARAM = "theme"
export const EMBED_PROTOCOL_VERSION = 1

/** VS Code's theme kind, folded to the two the page has (high contrast dark → dark, high contrast light → light). */
export type EmbedTheme = "light" | "dark"

// ── host → page ────────────────────────────────────────────────────────────────────────────────────

/**
 * VS Code's theme changed. The page applies it for this session only and never persists it.
 *
 * `colors`: the theme's own colours, so the page can wear them instead of Ntwine's palette (the page reads
 * as part of the editor rather than a foreign panel set into it). Read by the RELAY, not the extension —
 * VS Code's API names only the theme's kind; its colours exist as the `--vscode-*` custom properties VS
 * Code writes on every webview document, and the relay (packages/vscode/src/sidebar-html.ts) reads them
 * there, keyed by the names below without the `--vscode-` prefix. Absent while `ntwine.matchEditorTheme` is
 * off, and from an extension or a relay that predates it: the page then wears Ntwine's own palette.
 *
 * A HOSTILE PARENT is the threat this shape is bounded against: the page takes only the keys
 * `EMBED_THEME_COLORS` names, each only when its value is a plain hex or `rgb()`/`rgba()` colour
 * (`EMBED_COLOR_VALUE`), and sets each as a custom property on its own root — never a selector, never a
 * `url()`, never a declaration of its own.
 *
 * `surface`: which of VS Code's surfaces the frame sits on — the side bar's view ("sideBar"), or an editor
 * tab ("editor") — whose background the page's background takes. Absent means the side bar.
 *
 * `contrast`: a high-contrast theme (dark or light). The page draws its borders at full strength then.
 */
export interface EmbedThemeMessage {
  type: "ntwine:theme"
  theme: EmbedTheme
  colors?: EmbedThemeColors
  surface?: EmbedSurface
  contrast?: true
}

export type EmbedSurface = "sideBar" | "editor"

/**
 * The theme colours the page takes, in VS Code's own names (`--vscode-<name>` on a webview document; the
 * theme colour id with its dots as dashes). What each one becomes on the page: packages/web/src/theme.css
 * § The editor's colours. Measured on a real VS Code 1.140 across ten built-in themes (2026-10-02): every
 * one of these is set by every dark and light theme but `sideBar-foreground` and `input-border` (often
 * unset) and `contrastBorder` (high contrast only), and the page derives what a theme leaves out. Only
 * what theme.css reads is here: every name is one more thing a parent can set.
 */
export const EMBED_THEME_COLORS = [
  "sideBar-background",
  "sideBar-foreground",
  "editor-background",
  "foreground",
  "descriptionForeground",
  "panel-border",
  "contrastBorder",
  "input-border",
  "list-hoverBackground",
  "button-background",
  "button-foreground",
  "focusBorder",
  "textLink-foreground",
  "scrollbarSlider-background",
  "scrollbarSlider-hoverBackground",
] as const

export type EmbedThemeColor = (typeof EMBED_THEME_COLORS)[number]
export type EmbedThemeColors = Partial<Record<EmbedThemeColor, string>>

/**
 * A colour value the page accepts: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or `rgb(…)`/`rgba(…)` of
 * numbers — what VS Code writes (it serializes every theme colour as one or the other). Nothing that could
 * close a declaration, name a function, or reach the network.
 */
export const EMBED_COLOR_VALUE = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*[0-9.]+%?\s*[,\s]\s*[0-9.]+%?\s*[,\s]\s*[0-9.]+%?\s*(?:[,/]\s*[0-9.]+%?\s*)?\))$/u

/**
 * The fragment the relay puts on the frame's first address — `#ntwine-theme=<JSON of the theme message>` —
 * so the page's first paint already wears the editor's colours (packages/web/index.html's pre-paint guard
 * reads it, and drops it from the address). A message cannot do that: the page listens only once its
 * script has run, a second or more after its first paint.
 */
export const EMBED_THEME_FRAGMENT = "ntwine-theme="

/**
 * Put a selection in a composer, as the ⌘I context chip the browser's "Add to Ntwine prompt" path inserts
 * (lib/editorCompose.ts), and answer with `ntwine:composed`.
 *
 * `target`:
 *  - "front": the reply box of the thread the sidebar shows, else the new-thread box ("Add to Ntwine prompt").
 *  - "new": the new-thread box, opened if it is not ("Ask Ntwine…"). The chip's project is
 *    `item.projectId`'s when the extension matched one.
 *  - `{ thread, project }`: that thread's reply box, navigating to the thread first ("Send to Ntwine thread…").
 *    `project` is the project's SLUG, as the page's routes spell it.
 *
 * `focus`: put the caret in that composer after the insert, because the human writes next (Ask, Send).
 * False leaves focus where it is — in the editor, where "Add to Ntwine prompt" was run, so another selection
 * can follow. An insert never lands inside text being typed: it goes at a chip boundary of the box's value.
 */
export interface EmbedComposeMessage {
  type: "ntwine:compose"
  /** The extension's own nonce, echoed in `ntwine:composed`. */
  id: string
  /**
   * `path` is the file's absolute path — or `EMBED_TERMINAL_PATH` for text selected in VS Code's
   * terminal, which has no file: its chip reads `@terminal` and its definition `(terminal)`.
   */
  item: EditorComposeInput & { app: string }
  target: "front" | "new" | { thread: string; project: string }
  focus: boolean
  /**
   * Prose to put right after the chip, as if typed there — "Ask Ntwine to fix" sends the problem's own
   * message (`Fix: Cannot find name 'foo'. ts(2304)`), so the box reads as a request rather than a bare
   * reference. Plain text, one line, at most `EMBED_MAX_NOTE` characters; the human can edit it before
   * sending like anything else in the box.
   */
  note?: string
}

/** The `path` of a terminal selection's compose item (see `EmbedComposeMessage.item`). */
export const EMBED_TERMINAL_PATH = "terminal"
export const EMBED_MAX_NOTE = 2000

/** Show a thread (its drawer, full height), a project's queue, or this page's own queue view. */
export interface EmbedNavigateMessage {
  type: "ntwine:navigate"
  to: { thread: string; project: string } | { project: string } | "queue"
}

/** One file open in the editor, as the sidebar's context bar shows it. */
export interface EmbedEditorFile {
  /** Absolute path, in the server's filesystem terms. */
  path: string
  /** Workspace-relative path for display (`workspace.asRelativePath`), else the basename. */
  label: string
  /** The project it belongs to, when the extension matched one — the add's target, like a compose item's. */
  projectId?: string
}

/** A non-empty selection in the editor in front. Lines are 1-based and inclusive, as a chip's are. */
export interface EmbedEditorSelection {
  startLine: number
  /** A selection that ends at column 1 of a line ends on the line BEFORE it, as the chip it would make does. */
  endLine: number
  /** Characters selected, across every selection the editor holds (multi-cursor counts each). */
  chars: number
  /**
   * The PRIMARY selection's text, newlines as `\n` — what a message sent from the sidebar carries while the
   * human shares the editor (`ntwine.shareEditorState`; packages/web/src/lib/editorContext.ts
   * outgoingMessage). Absent past `EMBED_MAX_SELECTION_TEXT` characters, from a file whose text is withheld
   * (`withheld`), and while sharing is off; the message then names the lines without quoting them.
   * Optional for an extension from before it, whose selections then go as references too.
   */
  text?: string
}

/**
 * The longest selection the feed carries as text, in UTF-16 characters: 16 Ki, a quarter of what an
 * explicit add carries (EDITOR_COMPOSE_MAX_TEXT, 64 Ki). The feed is not an explicit add: it is re-sent
 * on every settled selection change, through two postMessage hops and a JSON dedupe key, whether or not
 * the human sends anything, so its ceiling is set by what is cheap to repeat. And what it carries rides
 * a message the human did not assemble by hand: 16 Ki is about 400 lines of code (the quote ceiling of
 * the extension's own messages, message.ts QUOTE_MAX_LINES) and ~4k tokens — context, not a payload. A
 * select-all on a large file goes as its file and lines, which the agent can read itself; ⌘I still
 * quotes up to 64 Ki for the human who means it.
 */
export const EMBED_MAX_SELECTION_TEXT = 16 * 1024

/**
 * THE EDITOR'S LIVE CONTEXT — what the sidebar's context bar shows, and what a message sent from the
 * sidebar carries unless the human turns that off (the bar's eye): the file in front, its selection WITH
 * the primary selection's text (or its caret's line, with nothing selected), and the other files open in
 * tabs. Sent after `ntwine:ready` and again on every change (active editor, selection or caret line —
 * debounced, so a drag is not a message per pixel — and the tab set). The text crosses to the page so the
 * page can attach it at send time without asking the host, which would put a round trip between Enter and
 * the send; it reaches the agent only inside a message the human sends from the box that shows it.
 */
export interface EmbedEditorContextMessage {
  type: "ntwine:editor-context"
  /**
   * The text editor in front, or null when none is (a terminal has focus with no editor beside it, nothing
   * open). The same editor the agents' tool reads (packages/vscode editor-front.ts): a file on disk or an
   * untitled buffer — the modified side of a diff included — and, while an output pane or the debug console
   * has focus, the last such editor still on screen.
   */
  active: (EmbedEditorFile & {
    selection?: EmbedEditorSelection
    /**
     * The caret's line, 1-based, when NOTHING is selected — a message with no selection says where in the
     * file the human was ("cursor on line 40"). Absent beside a selection, whose own lines say it.
     */
    cursorLine?: number
    /** An untitled buffer: `path` and `label` are its label (`Untitled-1`), and there is no file to read. */
    untitled?: true
    /** Unsaved changes: the copy on disk is not what the human sees, so a selection not quoted cannot be read from it. */
    dirty?: true
    /**
     * The selection's text is not carried, whatever its size: the file may hold secrets (`.env`, a key, a
     * file VS Code is told to hide). The block names the lines and says why it does not quote them.
     */
    withheld?: true
  }) | null
  /** Every OTHER file open in a tab, most recently active first, at most `EMBED_MAX_OPEN_FILES`. */
  open: EmbedEditorFile[]
}

export const EMBED_MAX_OPEN_FILES = 50

/**
 * A button in VS Code's own title row above the frame — the sidebar has no Ntwine header of its own, so
 * the header's doors live there: a new thread, back to the queue, jump to a thread (⌘K), settings, and,
 * under the row's ⋯, the keyboard shortcuts sheet (`?`), whose ⌨ button the page's status row drops in
 * the sidebar, where it stood alone on a row of its own.
 *
 * And `prompt`: the caret into the prompt box in front — the open thread's reply box, else the new-thread
 * box — from Ctrl+L / ⌘L pressed in the editor with nothing selected (Cursor's chord for moving to its
 * chat). Ctrl+L pressed in the page goes back to the editor (a forwarded `ntwine:key`).
 */
export interface EmbedCommandMessage {
  type: "ntwine:command"
  command: "new-thread" | "queue" | "jump" | "settings" | "shortcuts" | "prompt"
}

/**
 * What the extension holds that the page shows — sent once the page is ready and again on every change.
 *
 * `shareEditor` is THE switch for the editor reaching Ntwine on its own (`ntwine.shareEditorState`, a VS Code
 * setting, so it survives a window reload and is the same in every window): on, a send from the sidebar
 * carries the editor block and Ntwine's agents can read the editor (`mcp__ntwine__editor`); off, neither — only
 * what the human adds as a chip. The context bar's eye shows it and changes it (`ntwine:share-editor`).
 * Until 2026-10-02 the eye was the page's own preference, kept in the frame's storage, and the setting
 * governed the agents' tool alone: with the eye off an agent could still read the selection through the tool.
 *
 * `altK`: Alt+K (⌥K) in the editor is Ntwine's in this window. False while Claude Code's extension is
 * installed, which binds the same chord with the same `when`, so which one answered depended on load order;
 * Ntwine steps aside, and the page stops teaching a chord that is not its own here.
 */
export interface EmbedHostStateMessage {
  type: "ntwine:host-state"
  shareEditor: boolean
  altK: boolean
}

export type EmbedHostMessage =
  | EmbedThemeMessage
  | EmbedComposeMessage
  | EmbedNavigateMessage
  | EmbedEditorContextMessage
  | EmbedCommandMessage
  | EmbedEditorExtrasMessage
  | EmbedContextPicksMessage
  | EmbedHostStateMessage

// ── page → host ────────────────────────────────────────────────────────────────────────────────────

/** The page booted in embed mode and listens. Until this arrives the extension does not post compose items to it. */
export interface EmbedReadyMessage {
  type: "ntwine:ready"
  v: typeof EMBED_PROTOCOL_VERSION
}

/** The answer to `ntwine:compose`. `error` is copy the extension can show as is. */
export interface EmbedComposedMessage {
  type: "ntwine:composed"
  id: string
  ok: boolean
  error?: string
}

/**
 * A code file the human clicked in the sidebar (anything Ntwine's reader would show as source — not
 * Markdown, not a picture, which still open in Ntwine). It opens in THIS editor window, at the position,
 * whatever the Local file links setting says: the sidebar is inside the editor the human wants it in. The
 * path is absolute in the server's filesystem terms, which are the extension's (it runs where the files
 * are). The extension says so itself when the file is not there; the page shows nothing.
 */
export interface EmbedOpenFileMessage {
  type: "ntwine:open-file"
  path: string
  line?: number
  column?: number
  endLine?: number
}

/**
 * A link to a web page (http or https), or a `mailto:` address — a VS Code webview cannot open a window,
 * so the extension does (`env.openExternal`, which hands a mailto to the mail app).
 */
export interface EmbedOpenExternalMessage {
  type: "ntwine:open-external"
  url: string
}

/**
 * A key chord the page's own handlers left alone (not `defaultPrevented`), with Ctrl or Cmd held. While the
 * frame has focus VS Code's keybindings cannot see a key at all, so the page forwards these and the extension
 * runs the VS Code command its ALLOWLIST maps the chord to (the command palette, quick open, the sidebar and
 * panel toggles, focusing the editor); anything else is ignored. The page never forwards the editing chords
 * a text box handles natively — copy, cut, paste, undo, redo, select all.
 */
export interface EmbedKeyMessage {
  type: "ntwine:key"
  /** `KeyboardEvent.key` and `.code`, as the page saw them. */
  key: string
  code: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * Put the editor's context in the composer in front — a click on the context bar (the selection, or the
 * file in front when nothing is selected) or a pick from its open files. The page asks rather than using
 * the feed's copy: a whole file is never in the feed, a selection may be past the feed's ceiling, and a
 * chip is the editor's text at the moment of the click. The host answers with a `ntwine:compose` (target
 * "front", focus true) carrying the text as the editor has it then, or with nothing when the file or
 * selection is gone.
 */
export interface EmbedAddContextMessage {
  type: "ntwine:add-context"
  /**
   * "selection": the editor in front's selection. "file": `path`, as a whole-file reference. "problems":
   * the file in front's errors and warnings, as an `@problems` chip. "terminal": the terminal's last
   * command and its output, as an `@terminal` chip. (The last two only from a host whose
   * `ntwine:editor-extras` offered them.)
   */
  what: "selection" | "file" | "problems" | "terminal"
  path?: string
}

/**
 * Where the page is — VS Code's title row above the frame carries it, since the sidebar draws no header
 * of its own. Sent on every change of view, and when the readings in it change.
 */
export interface EmbedRouteMessage {
  type: "ntwine:route"
  /** Which title-row buttons apply: "thread" shows Back to queue, the others New thread. */
  view: "queue" | "thread" | "settings" | "other"
  /** The view's name, short: the thread's title, the queue's scope ("All projects", a project's name), "Settings". */
  title: string
  /** The reading beside it, e.g. `7 ready · 2 working`; absent says nothing. */
  description?: string
  /**
   * The page's address for what it shows, as a browser tab would open it — the frame's own address less
   * the embed switch and the theme (`http://127.0.0.1:9393/all/acme-api/thread/x`). ⋯ Open in browser opens
   * it, so a thread up in the sidebar opens as that thread. The extension keeps it only when it is on the
   * frame's own origin. Optional, so a page and an extension from before it work together: without it the
   * extension opens the window's project.
   */
  href?: string
}

/**
 * The human flipped the context bar's eye: share the editor with Ntwine, or stop. The extension writes
 * `ntwine.shareEditorState` (where it is set: the workspace's value when the workspace has one, else the
 * user's) and answers with `ntwine:host-state` — which is also how a page learns its write did not take.
 */
export interface EmbedShareEditorMessage {
  type: "ntwine:share-editor"
  on: boolean
}

/**
 * Show a thread's changes in this window as VS Code's multi-file diff — the thread's ⋯ Review changes.
 * It names the thread and nothing else: the extension asks Ntwine which checkouts the thread changed
 * (`reviewTarget`, the same answer a browser tab's request pushes to a window), and git for the rest, so
 * the page cannot point it at any folder. `project` is the project's SLUG, as the page's routes spell it,
 * or its id when the control is scoped to another project than the page's (a card of the cross-project
 * page); the extension matches either against the projects it knows.
 */
export interface EmbedReviewMessage {
  type: "ntwine:review"
  thread: string
  project: string
  /** The thread's name as the page shows it in words, for the diff's tab; Ntwine's own record without it. */
  title?: string
}

export type EmbedPageMessage =
  | EmbedShareEditorMessage
  | EmbedReadyMessage
  | EmbedComposedMessage
  | EmbedOpenFileMessage
  | EmbedOpenExternalMessage
  | EmbedKeyMessage
  | EmbedAddContextMessage
  | EmbedRouteMessage
  | EmbedReviewMessage
  | EmbedPickContextMessage

// ── more ways in: files by name or dropped, the file's problems, the terminal's last command ─────────
//
// Cursor and Claude Code's VS Code extension both let the human name a file with `@`, drag one in from
// the explorer, and pull in the file's lint errors or the terminal's last output; the sidebar's prompt
// boxes do the same (ARCHITECTURE.md § VS Code extension). The page has no file index of its own and
// no access to the editor's diagnostics or terminal, so it asks the host for each — the host answers from
// the workspace as VS Code sees it (files.exclude, search.exclude and .gitignore honoured), and nothing
// here goes through the Ntwine server.

/**
 * Files for the prompt box's `@` menu (`query`: what follows the `@`, possibly empty), or the resources
 * the human dropped from VS Code's explorer resolved to files and folders on disk (`uris`, as the drag
 * carried them: `file:` or the window's own `vscode-remote:` URIs). The host answers with
 * `ntwine:context-picks` under the same id — always, with no files when it has none to offer — so a page
 * can tell an extension that does not know the question (no answer) from an empty one.
 */
export interface EmbedPickContextMessage {
  type: "ntwine:pick-context"
  /** The page's own nonce, echoed in the answer. */
  id: string
  query?: string
  uris?: string[]
}

export const EMBED_MAX_QUERY = 200
export const EMBED_MAX_DROPPED = 50
/** Files one `@` answer offers at most: the menu shows a handful, and the rest are a narrower query away. */
export const EMBED_MAX_PICKS = 30

/** A file (or, dropped, a folder) a pick resolved to. */
export interface EmbedPickedFile extends EmbedEditorFile {
  folder?: true
}

/** The answer to `ntwine:pick-context`: best matches first. */
export interface EmbedContextPicksMessage {
  type: "ntwine:context-picks"
  id: string
  files: EmbedPickedFile[]
}

/** The `path` of a compose item carrying the file in front's problems (embed-protocol EmbedComposeMessage): its chip reads `@problems`. */
export const EMBED_PROBLEMS_PATH = "problems"
/** Characters of a terminal command line the page is told, for the menu entry that offers it. */
export const EMBED_MAX_COMMAND = 200

/**
 * What else the editor can put in the prompt, for the context bar's menu, beside the open files: the
 * file in front's problems (with their counts) and the terminal's last command (its command line and
 * how it exited, when the editor knows — VS Code 1.93 and later; on an older one, `{}` while a terminal
 * is open). Absent means there is none to offer. Sent after `ntwine:ready` and on every change, like
 * `ntwine:editor-context`; never the problems' text or the command's output, which cross only when the
 * human adds them (`ntwine:add-context` "problems" / "terminal").
 */
export interface EmbedEditorExtrasMessage {
  type: "ntwine:editor-extras"
  problems?: { label: string; errors: number; warnings: number; infos: number }
  terminal?: { command?: string; exitCode?: number }
}
