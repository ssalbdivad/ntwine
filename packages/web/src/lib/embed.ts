import {
  EMBED_COLOR_VALUE,
  EMBED_THEME_COLORS,
  EDITOR_COMPOSE_MAX_TEXT,
  EDITOR_MAX_PATH,
  EMBED_PARAM,
  EMBED_PROTOCOL_VERSION,
  EMBED_MAX_COMMAND,
  EMBED_MAX_NOTE,
  EMBED_MAX_OPEN_FILES,
  EMBED_MAX_PICKS,
  EMBED_MAX_SELECTION_TEXT,
  EMBED_THEME_PARAM,
  EMBED_VSCODE,
  type EmbedCommandMessage,
  type EmbedEditorExtrasMessage,
  type EmbedEditorFile,
  type EmbedHostMessage,
  type EmbedPickedFile,
  type EmbedKeyMessage,
  type EmbedPageMessage,
  type EmbedSurface,
  type EmbedTheme,
  type EmbedThemeColors,
} from "@ntwine/shared"

// THE PAGE INSIDE AN EDITOR'S SIDEBAR — embed mode's state and its wire (packages/shared/src/
// embed-protocol.ts is the contract; design in ARCHITECTURE.md § VS Code extension). The VS Code
// extension frames this very page at `/project/<slug>?embed=vscode&theme=<light|dark>`, and the page
// then behaves as a resident of that editor rather than of a browser: the desktop's left column at any
// width (components/SidebarPage.tsx; never the phone's page, lib/mobile.ts), VS Code's theme (lib/theme.ts), code files and web links handed out to the editor
// (lib/local-file-links.ts, lib/external-links.ts), and selections handed in (lib/embedHost.ts).
//
// READ ONCE, KEPT FOR THE SESSION. The query is on the frame's FIRST address only: the first in-app
// navigation (a drawer, a project) replaces it, and a reload of the frame then lands on an address with
// no `embed` in it. So the boot read writes what it found to sessionStorage — the frame's own, which is
// partitioned from every browser tab's — and every later boot of this frame reads it back from there.
// index.html's pre-paint guard reads the same record, under the same key, so the first frame is already
// in the right theme; keep the two readers in step.
//
// This module is the state and the pure halves, with no app imports, so the theme module, the layout
// hook and the link interceptors can all ask `embedded()` without an import cycle through the store.

const SESSION_KEY = "ntwine.embed"

export interface EmbedState {
  /** The host framing this page; the only one there is. */
  host: typeof EMBED_VSCODE
  /** The host's theme kind, overriding the stored preference for this session only. */
  theme?: EmbedTheme
  /** The host theme's colours, which the page wears instead of its own palette (lib/theme.ts). */
  palette?: HostPalette
}

/** The editor's colours as the page holds them: `ntwine:theme`'s `colors`, `surface` and `contrast`, checked. */
export interface HostPalette {
  colors: EmbedThemeColors
  surface?: EmbedSurface
  contrast?: true
}

function parseTheme(value: unknown): EmbedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined
}

/**
 * The colours a parent sent, kept only where the contract allows: a key `EMBED_THEME_COLORS` names, with
 * a plain colour value (`EMBED_COLOR_VALUE`). Anything else is dropped one entry at a time rather than
 * failing the message, so a newer extension's extra key costs nothing. Undefined when there is no map, or
 * no background among it — a palette with no surface colour has nothing to paint the page with.
 */
export function parsePalette(value: unknown): HostPalette | undefined {
  if (!isRecord(value) || !isRecord(value.colors)) return undefined
  const colors: EmbedThemeColors = {}
  for (const name of EMBED_THEME_COLORS) {
    const color = value.colors[name]
    if (typeof color === "string" && color.length <= 64 && EMBED_COLOR_VALUE.test(color)) colors[name] = color
  }
  const surface = value.surface === "editor" ? "editor" : value.surface === "sideBar" ? "sideBar" : undefined
  if (!colors[surface === "editor" ? "editor-background" : "sideBar-background"]) return undefined
  return { colors, ...(surface ? { surface } : {}), ...(value.contrast === true ? { contrast: true as const } : {}) }
}

/**
 * Embed mode from the frame's first address, else from this frame's session record, else none. An
 * address that names the mode WINS over the record, theme included: it is the extension's latest word
 * (a re-created webview frames the page afresh with VS Code's theme of that moment). Pure, for its test.
 */
export function readEmbedState(search: string, stored: string | null): EmbedState | null {
  let record: Record<string, unknown> | null = null
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : null
    if (isRecord(parsed) && parsed.host === EMBED_VSCODE) record = parsed
  } catch {}
  // The editor's colours come from the record whichever way the mode was found: the pre-paint guard
  // (index.html) writes the ones the address's fragment carried there before this runs, and a frame's
  // record belongs to that frame alone (a new webview is a new frame, with a session of its own).
  const palette = record ? parsePalette(record.palette) : undefined
  const params = new URLSearchParams(search)
  let theme: EmbedTheme | undefined
  if (params.get(EMBED_PARAM) === EMBED_VSCODE) theme = parseTheme(params.get(EMBED_THEME_PARAM))
  else if (record) theme = parseTheme(record.theme)
  else return null
  return { host: EMBED_VSCODE, ...(theme ? { theme } : {}), ...(palette ? { palette } : {}) }
}

let state: EmbedState | null | undefined

function load(): EmbedState | null {
  if (state !== undefined) return state
  if (typeof window === "undefined") return (state = null)
  let stored: string | null = null
  try { stored = sessionStorage.getItem(SESSION_KEY) } catch {}
  state = readEmbedState(typeof location === "undefined" ? "" : location.search, stored)
  if (state) save(state)
  return state
}

function save(next: EmbedState): void {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)) } catch {}
}

/** Is this page framed by an editor's sidebar? Fixed for the page's life. */
export function embedded(): boolean {
  return load() !== null
}

/** The host's theme for this session, when it named one. */
export function embedTheme(): EmbedTheme | undefined {
  return load()?.theme
}

/** The host theme's colours for this session, while the host sends them. */
export function embedPalette(): HostPalette | undefined {
  return load()?.palette
}

/** A `ntwine:theme` from the host: kept for a reload of this frame, never in localStorage. */
export function rememberEmbedTheme(theme: EmbedTheme, palette?: HostPalette): void {
  const current = load()
  if (!current) return
  state = { host: current.host, theme, ...(palette ? { palette } : {}) }
  save(state)
}

/**
 * Tell the host something. `"*"` as the target origin, because the parent is a `vscode-webview://`
 * document whose origin the page cannot know in advance — and nothing a page → host message carries is
 * private: a path the page already rendered, a web address, a key chord, an id the host minted.
 */
export function postToHost(message: EmbedPageMessage): void {
  if (!embedded() || typeof window === "undefined" || window.parent === window) return
  window.parent.postMessage(message, "*")
}

export const EMBED_READY: EmbedPageMessage = { type: "ntwine:ready", v: EMBED_PROTOCOL_VERSION }

/**
 * Where to run a command the page asks the human to run "in a terminal" (sign-in, `gh auth login`): in
 * the sidebar, VS Code's own, one chord away — forwarded by the page (embedKeys.ts HOST_CHORDS). Ctrl on
 * a Mac too, as VS Code binds it.
 */
export function hostTerminalHint(mac: boolean): string {
  return `${mac ? "⌃`" : "Ctrl+`"} opens VS Code's terminal.`
}

// ── host → page: each shape checked against the contract, anything else dropped ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalLine(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1)
}

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/**
 * A host message, if `data` is exactly one the contract defines, else null. The relay already checks
 * where a message came from; this checks what it says, since a frame that trusted any `type` it was
 * handed would put whatever text arrived into a prompt box. Unknown types are ignored, not answered: a
 * newer extension may speak a message this page predates.
 */
export function parseHostMessage(data: unknown): EmbedHostMessage | null {
  if (!isRecord(data)) return null
  if (data.type === "ntwine:theme") {
    const theme = parseTheme(data.theme)
    if (!theme) return null
    const palette = parsePalette(data)
    return palette ? { type: "ntwine:theme", theme, ...palette } : { type: "ntwine:theme", theme }
  }
  if (data.type === "ntwine:navigate") {
    const to = data.to
    if (to === "queue") return { type: "ntwine:navigate", to }
    if (!isRecord(to) || !nonEmpty(to.project, 200)) return null
    if (to.thread === undefined) return { type: "ntwine:navigate", to: { project: to.project } }
    return nonEmpty(to.thread, 200) ? { type: "ntwine:navigate", to: { thread: to.thread, project: to.project } } : null
  }
  if (data.type === "ntwine:compose") {
    const { id, item, target, focus } = data
    if (!nonEmpty(id, 200) || typeof focus !== "boolean" || !isRecord(item)) return null
    if (!nonEmpty(item.path, EDITOR_MAX_PATH) || typeof item.app !== "string") return null
    if (item.text !== undefined && (typeof item.text !== "string" || item.text.length > EDITOR_COMPOSE_MAX_TEXT)) return null
    if (item.projectId !== undefined && !nonEmpty(item.projectId, 200)) return null
    if (!optionalLine(item.startLine) || !optionalLine(item.endLine)) return null
    const { note } = data
    if (note !== undefined && (typeof note !== "string" || note.length > EMBED_MAX_NOTE)) return null
    let to: Extract<EmbedHostMessage, { type: "ntwine:compose" }>["target"]
    if (target === "front" || target === "new") to = target
    else if (isRecord(target) && nonEmpty(target.thread, 200) && nonEmpty(target.project, 200)) to = { thread: target.thread, project: target.project }
    else return null
    return {
      type: "ntwine:compose",
      id,
      item: {
        path: item.path,
        app: item.app,
        ...(item.text !== undefined ? { text: item.text as string } : {}),
        ...(item.projectId !== undefined ? { projectId: item.projectId as string } : {}),
        ...(item.startLine !== undefined ? { startLine: item.startLine as number } : {}),
        ...(item.endLine !== undefined ? { endLine: item.endLine as number } : {}),
      },
      target: to,
      focus,
      ...(note ? { note: note.replace(/\s+/g, " ") } : {}),
    }
  }
  if (data.type === "ntwine:editor-context") {
    const { active, open } = data
    if (!Array.isArray(open) || open.length > EMBED_MAX_OPEN_FILES) return null
    const files: EmbedEditorFile[] = []
    for (const entry of open) {
      const file = editorFile(entry)
      if (!file) return null
      files.push(file)
    }
    if (active === null) return { type: "ntwine:editor-context", active: null, open: files }
    const base = editorFile(active)
    if (!base || !isRecord(active)) return null
    // The flags the block reads (an untitled buffer, unsaved changes, text withheld): `true` or absent, as
    // the contract has them; anything else is not this extension.
    const flags: { untitled?: true; dirty?: true; withheld?: true } = {}
    for (const flag of ["untitled", "dirty", "withheld"] as const) {
      if (active[flag] === undefined) continue
      if (active[flag] !== true) return null
      flags[flag] = true
    }
    const file = { ...base, ...flags }
    const { selection, cursorLine } = active
    if (selection === undefined) {
      // The caret's line rides only a file with nothing selected; a bad one is dropped with the message,
      // like any other field that is not the contract's.
      if (!optionalLine(cursorLine)) return null
      return { type: "ntwine:editor-context", active: { ...file, ...(cursorLine !== undefined ? { cursorLine: cursorLine as number } : {}) }, open: files }
    }
    if (!isRecord(selection)) return null
    const { startLine, endLine, chars, text } = selection
    if (startLine === undefined || endLine === undefined || !optionalLine(startLine) || !optionalLine(endLine) || (endLine as number) < (startLine as number)) return null
    if (!Number.isSafeInteger(chars) || (chars as number) < 1) return null
    // The selection's text goes into a message the human sends, so it is held to the feed's own ceiling:
    // a host that sends more is not the extension this page speaks to. And a withheld file's text is not
    // there to be sent, whatever arrived.
    if (text !== undefined && (typeof text !== "string" || text.length > EMBED_MAX_SELECTION_TEXT)) return null
    if (flags.withheld && text !== undefined) return null
    return {
      type: "ntwine:editor-context",
      active: { ...file, selection: { startLine: startLine as number, endLine: endLine as number, chars: chars as number, ...(text !== undefined ? { text: text as string } : {}) } },
      open: files,
    }
  }
  if (data.type === "ntwine:host-state") {
    const { shareEditor, altK } = data
    return typeof shareEditor === "boolean" && typeof altK === "boolean" ? { type: "ntwine:host-state", shareEditor, altK } : null
  }
  if (data.type === "ntwine:command") {
    const { command } = data
    return HOST_COMMANDS.has(command as EmbedCommandMessage["command"]) ? { type: "ntwine:command", command: command as EmbedCommandMessage["command"] } : null
  }
  if (data.type === "ntwine:context-picks") {
    const { id, files } = data
    if (!nonEmpty(id, 200) || !Array.isArray(files) || files.length > EMBED_MAX_PICKS) return null
    const picked: EmbedPickedFile[] = []
    for (const entry of files) {
      const file = editorFile(entry)
      if (!file || !isRecord(entry) || (entry.folder !== undefined && entry.folder !== true)) return null
      picked.push(entry.folder ? { ...file, folder: true } : file)
    }
    return { type: "ntwine:context-picks", id, files: picked }
  }
  if (data.type === "ntwine:editor-extras") {
    const { problems, terminal } = data
    const out: EmbedEditorExtrasMessage = { type: "ntwine:editor-extras" }
    if (problems !== undefined) {
      if (!isRecord(problems) || !nonEmpty(problems.label, EDITOR_MAX_PATH)) return null
      const counts = [problems.errors, problems.warnings, problems.infos]
      if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return null
      out.problems = { label: problems.label, errors: problems.errors as number, warnings: problems.warnings as number, infos: problems.infos as number }
    }
    if (terminal !== undefined) {
      if (!isRecord(terminal)) return null
      const { command, exitCode } = terminal
      if (command !== undefined && !nonEmpty(command, EMBED_MAX_COMMAND)) return null
      if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) return null
      out.terminal = { ...(command !== undefined ? { command: command as string } : {}), ...(exitCode !== undefined ? { exitCode: exitCode as number } : {}) }
    }
    return out
  }
  return null
}

const HOST_COMMANDS = new Set<EmbedCommandMessage["command"]>(["new-thread", "queue", "jump", "settings", "shortcuts", "prompt"])

/** One open file of a `ntwine:editor-context`, with only the contract's fields, or null. */
function editorFile(value: unknown): EmbedEditorFile | null {
  if (!isRecord(value) || !nonEmpty(value.path, EDITOR_MAX_PATH) || !nonEmpty(value.label, EDITOR_MAX_PATH)) return null
  if (value.projectId !== undefined && !nonEmpty(value.projectId, 200)) return null
  return { path: value.path, label: value.label, ...(value.projectId !== undefined ? { projectId: value.projectId as string } : {}) }
}

// ── page → host: the key chords ─────────────────────────────────────────────────────────────────────

/**
 * The chords a text box handles natively, as EXACT chords: copy, cut, paste, undo, redo, select all and
 * Ctrl+Insert (copy) without Shift; with it, only redo (⌘⇧Z) and paste as plain text (⌘⇧V). Exact,
 * because the key alone cannot tell them from VS Code's: Extensions is ⌘⇧X, whose `key` is "X", and a
 * filter that case-folded every key read it as cut and never forwarded it (sweep 2026-10-01).
 */
const EDITING_KEYS = new Set(["c", "x", "v", "z", "y", "a", "insert"])
const SHIFTED_EDITING_KEYS = new Set(["z", "v"])
const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "Fn", "OS"])

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented" | "repeat" | "isComposing">

function editingChord(event: KeyLike): boolean {
  const key = event.key.toLowerCase()
  return event.shiftKey ? SHIFTED_EDITING_KEYS.has(key) : EDITING_KEYS.has(key)
}

/**
 * The `ntwine:key` for a keydown, or null when it is not the host's: no Ctrl or Cmd held, a page handler
 * already took it, a bare modifier, an auto-repeat (holding ⌘⇧P must not open the palette forty times),
 * mid-IME composition, or an editing chord (above). Nothing is prevented here: a chord the host ignores
 * (Ctrl+← in a text box, Ctrl+Shift+C) must still do what it does natively.
 */
export function hostKeyChord(event: KeyLike): EmbedKeyMessage | null {
  if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented || event.repeat || event.isComposing) return null
  if (MODIFIER_KEYS.has(event.key) || editingChord(event)) return null
  return { type: "ntwine:key", key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey }
}
