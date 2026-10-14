// THE EDITOR BRIDGE — the wire between ntwine and an editor extension (packages/vscode) running in a
// VS Code, Cursor or Windsurf window. Design and rationale: ARCHITECTURE.md § VS Code extension.
//
// One WebSocket per editor WINDOW, opened BY the extension to the one machine-wide endpoint
// `/_ntwine/editor` (never per project: a window's folders can span several projects, and the server
// is a singleton). Over it the extension says which folders it has open, whether it has focus, and —
// for the agents to read — what its editor shows (`editor`, below);
// the server sends it files to open and folders to raise, and the projects its folders belong to with
// their queue counts. Everything else the extension does — dispatching a thread, a follow-up — goes
// through the ordinary RPC surface, like any other client.
//
// Pure types and constants, no zod: the extension bundles this module and must not drag the shared
// index in. The zod schemas the SERVER validates frames with live beside ServerEvent in index.ts, and
// are pinned assignable to these types there.

import type { FilePosition } from "./file-position.ts"

/** The machine-wide editor socket. Never project-prefixed; the server answers it before tenant routing. */
export const EDITOR_SOCKET_PATH = "/_ntwine/editor"
export const EDITOR_PROTOCOL_VERSION = 1

/**
 * What the server accepts in one frame. The extension must fit itself to these before sending: a frame
 * over any of them is refused (4401), and a hello that is refused is refused again on every redial.
 */
export const EDITOR_MAX_FOLDERS = 64
export const EDITOR_MAX_PATH = 4096
/** Characters of selected text in one `compose`. The frame itself is capped at 128 KiB of bytes. */
export const EDITOR_COMPOSE_MAX_TEXT = 64 * 1024

/**
 * What a server can do beyond v1, named in its `welcome` (`features`). The protocol stays v1 and grows by
 * these instead: the server closes a socket on ANY frame it does not know (4401), so an extension that
 * sent a new frame to an ntwine from before it would be refused on every redial, forever. A new extension
 * sends a new frame only to a server that named it; an old extension ignores the field.
 */
export const EDITOR_FEATURES = {
  /** The server takes `editor` frames (EditorSnapshot) and answers the workers' `editorState` with them. */
  editorState: "editor-state",
  /** The server takes `withheld` on an `editor` frame's selection (EditorStateSelection). */
  selectionWithheld: "editor-selection-withheld",
  /**
   * Both ways. In a server's `welcome`: it takes a `features` frame, and may send `review` to a window that
   * named this in one. In a window's `features` frame: it can show a thread's changes (`review`).
   */
  review: "review",
  /**
   * The page this server serves can live in an editor's sidebar (`?embed=vscode`, packages/web lib/
   * embed.ts). A server without it serves a page that never says `ntwine:ready` there, and the sidebar
   * says to update ntwine rather than that it is still loading. `editor-state` came after embed mode, so
   * a server naming only that one has it too.
   */
  sidebar: "sidebar",
  /**
   * The server sends `attention` (EditorAttention) when a thread of a project a window has open comes to
   * rest needing the human — to ONE window, the one the human was in last.
   */
  attention: "attention",
} as const
export type EditorFeature = (typeof EDITOR_FEATURES)[keyof typeof EDITOR_FEATURES]

/** A review's ceilings, which the server's schema holds a window's answer to and the server fits a request to. */
export const EDITOR_REVIEW_MAX_CHECKOUTS = 8
export const EDITOR_REVIEW_MAX_FILES = 512

/**
 * The `editor` frame's ceilings. The server refuses a frame past any of them, and the extension fits the
 * frame to them (packages/vscode editor-state.ts) before sending — never by being refused.
 */
/** Other open files, most recent first. */
export const EDITOR_STATE_MAX_OPEN = 50
/** Errors and warnings, the file in front first and every error before any warning. */
export const EDITOR_STATE_MAX_DIAGNOSTICS = 100
/** Characters of one diagnostic's message; longer ones are clipped with an ellipsis. */
export const EDITOR_STATE_MAX_MESSAGE = 300
/** Characters of a diagnostic's source or code, and of a language id. */
export const EDITOR_STATE_MAX_TAG = 100
/** Characters of selected text carried. A longer selection carries its start, flagged `truncated`. */
export const EDITOR_STATE_MAX_SELECTION_TEXT = 32 * 1024
/**
 * Encoded bytes a whole `editor` frame is fitted into. The server refuses any frame but a compose past
 * 64 KiB (editor-bridge.ts EDITOR_MAX_FRAME_BYTES); 56 KiB leaves the JSON's own framing room and keeps a
 * frame of NUL-padded text, which encodes at six bytes a character, from ever reaching that ceiling.
 */
export const EDITOR_STATE_MAX_BYTES = 56 * 1024

/** Close codes the server uses beyond the standard ones, so the extension can say why it was dropped. */
export const EDITOR_CLOSE = {
  /** The hello's `v` is not one this server speaks. The extension should say "update ntwine or the extension". */
  unsupportedVersion: 4400,
  /** A frame failed validation. */
  invalidMessage: 4401,
  /** The first frame was not a hello. */
  helloRequired: 4402,
} as const

/** Which editor family a window is — what the "Local file links" setting's choices name. */
export type EditorKind = "vscode" | "cursor" | "windsurf" | "other"

/** `vscode.env.appName` → the family. "Visual Studio Code", "Visual Studio Code - Insiders", "Cursor", "Windsurf", "VSCodium"… */
export function editorKindOf(appName: string): EditorKind {
  if (/cursor/i.test(appName)) return "cursor"
  if (/windsurf/i.test(appName)) return "windsurf"
  if (/visual studio code/i.test(appName)) return "vscode"
  return "other"
}

/** A selection (or a whole file) the human sends to ntwine's prompt box from the editor. */
export interface EditorComposeInput {
  /** The project the file belongs to, as the extension matched it; the page's fallback target. */
  projectId?: string
  /** Absolute path, in the server's filesystem terms (the extension runs where the files are). */
  path: string
  /** The selected text. Absent: a reference to the whole file (or to `startLine` alone). */
  text?: string
  startLine?: number
  endLine?: number
}

/** A compose input the server is holding until an ntwine page claims it (`composeTake`). */
export interface EditorComposeItem extends EditorComposeInput {
  id: string
  /** The sending window's app name, for copy ("From VS Code"). */
  app: string
  /** ISO time the server accepted it. */
  at: string
}

// ── extension → server ─────────────────────────────────────────────────────────────────────────────

export interface EditorHello {
  t: "hello"
  v: typeof EDITOR_PROTOCOL_VERSION
  /** Stable for the life of the window (a uuid the extension mints at activation). */
  windowId: string
  /** `vscode.env.appName`. */
  app: string
  /** The extension's own version, for the log. */
  extensionVersion: string
  /** Absolute paths of the window's `file`-scheme workspace folders, as the extension host sees them. */
  folders: string[]
  /** Whether this window has OS focus right now (`vscode.window.state.focused`). */
  focused: boolean
  /**
   * How long ago this window last had focus, when it does not have it now. A reconnect (every window
   * redials after an ntwine restart, while the human is in the browser) would otherwise erase which
   * window was used last, and an open no folder claims would go to whichever window redialled last.
   */
  focusedAgoMs?: number
  /** Whether this window takes file opens from ntwine (the extension's `ntwine.openFileLinks` setting). */
  acceptsOpens: boolean
  /** `os.homedir()` and `process.platform` of the extension host — how the server tells a window that shares its filesystem. */
  home: string
  platform: string
}

/** Anything in the hello that can change later: sent whole, on every change. */
export interface EditorState {
  t: "state"
  folders: string[]
  focused: boolean
  acceptsOpens: boolean
}

/** The answer to an `open`, `focus` or `review` request. */
export interface EditorResult {
  t: "result"
  id: string
  ok: boolean
  /** Why it failed, in words the page can toast. */
  error?: string
}

export interface EditorCompose {
  t: "compose"
  /** The extension's own nonce; echoed in `composed`. */
  id: string
  item: EditorComposeInput
}

// ── what the human has in front of them, for the agents (`editor`) ─────────────────────────────────
//
// The editor as a worker reads it through `mcp__ntwine__editor` (cc-worker/bin/ntwine-mcp.mjs → the
// `editorState` RPC): the file in front with its selection and the selected text, the other open tabs,
// and the editor's errors and warnings. Claude Code's IDE integration gives its agent the same picture
// (getCurrentSelection, getOpenEditors, getDiagnostics); without it an agent asked about "the selected
// code" had to say it could not see the editor. The extension sends it whole on every change (debounced)
// and once on every connect, ONLY to a server whose welcome names EDITOR_FEATURES.editorState, and the
// server keeps the latest per window and forgets it with the window.

/** A selection in the file in front: the primary one, which is the one a chip would carry. */
export interface EditorStateSelection {
  /** 1-based, inclusive; a selection ending at column 1 of a line does not include that line (the chip's rule). */
  startLine: number
  endLine: number
  /** The selected text. Absent only when the frame could not carry any of it. */
  text?: string
  /** `text` is only the start of the selection (or absent): it was too large to carry whole. */
  truncated?: true
  /**
   * No `text`, on purpose: the file may hold secrets (`.env`, a key, a file VS Code hides). Sent only to a
   * server whose welcome names EDITOR_FEATURES.selectionWithheld; an older one gets `truncated` instead,
   * which its schema takes.
   */
  withheld?: true
}

/** The text editor in front. */
export interface EditorActiveFile {
  /** Absolute path as the extension host sees it; for an untitled buffer, its label (`Untitled-1`). */
  path: string
  /** An unsaved buffer that is not a file on disk. */
  untitled?: true
  /** VS Code's language id: `typescript`, `python`, `plaintext`… */
  languageId: string
  /** Edited and not saved: what is on disk is not what the human sees. */
  dirty: boolean
  lineCount: number
  /** 1-based line of the caret (the primary selection's moving end). */
  cursorLine: number
  /** Absent: nothing selected, only a caret. */
  selection?: EditorStateSelection
  /** The lines on screen, 1-based and inclusive. */
  visible: { startLine: number; endLine: number }
}

/** Another file open in a tab. */
export interface EditorOpenFile {
  path: string
  untitled?: true
  dirty?: true
}

export interface EditorDiagnostic {
  path: string
  /** 1-based. */
  line: number
  severity: "error" | "warning"
  message: string
  /** What reported it (`ts`, `eslint`) and its code (`2304`), as the Problems panel shows them. */
  source?: string
  code?: string
}

/**
 * The `editor` frame: everything a worker may read about this window's editor, whole. `shared: false` is
 * the human's `ntwine.shareEditorState` turned off — sent once, with everything else empty, so the server
 * forgets what it had and can tell a worker WHY it has nothing.
 */
export interface EditorSnapshot {
  t: "editor"
  shared: boolean
  active: EditorActiveFile | null
  open: EditorOpenFile[]
  diagnostics: EditorDiagnostic[]
  /** Every error and warning the editor has, before `diagnostics` was capped and fitted. */
  problems: { errors: number; warnings: number }
}

/**
 * What this window can do beyond v1 (EDITOR_FEATURES), sent once after a `welcome` that names
 * EDITOR_FEATURES.review — never to a server that does not, which would refuse the frame (4401) on every
 * redial. Not in the hello, for the same reason: a server's schema is strict, and the hello reaches every
 * server, old ones included.
 */
export interface EditorFeatures {
  t: "features"
  features: string[]
}

/**
 * What this window wants to be told beyond v1 — sent only to a server whose welcome names
 * EDITOR_FEATURES.attention, once after the welcome and again when it changes. `attention`: this window
 * shows a notification when a thread needs the human. Only older extensions send it: the toast and its
 * `ntwine.notify` setting were removed on 2026-10-05, so the current extension never listens. A window that
 * never says so is never the one a thread's notification goes to, so it cannot swallow one another window
 * would have shown.
 */
export interface EditorListen {
  t: "listen"
  attention: boolean
}

export type EditorClientMessage = EditorHello | EditorState | EditorResult | EditorCompose | EditorSnapshot | EditorFeatures | EditorListen

// ── server → extension ─────────────────────────────────────────────────────────────────────────────

export interface EditorWelcome {
  t: "welcome"
  v: typeof EDITOR_PROTOCOL_VERSION
  bootId: string
  /** What this server takes beyond v1 (EDITOR_FEATURES). Absent from a server older than the field: nothing. */
  features?: string[]
}

/** Open a file and reveal the position; raise the window. Answer with `result`. */
export interface EditorOpen extends Partial<FilePosition> {
  t: "open"
  id: string
  path: string
}

/** Raise this window — it has `path` open as a workspace folder. Answer with `result`. */
export interface EditorFocus {
  t: "focus"
  id: string
  path: string
}

// ── a thread's changes, as VS Code's multi-file diff (`review`) ──────────────────────────────────────
//
// Claude Code and Cursor show an agent's edits as native diffs. An ntwine worker edits files directly, often
// in a worktree of its own, so the ntwine form is to open everything a thread changed as one multi-file
// diff against where it started. The SERVER names what to show — the checkouts the thread's edits are in,
// read off its transcript (review-target.ts) — and the EXTENSION, which runs where the files are, asks git
// for the base and the changed files and opens the diff (packages/vscode review.ts). The same target
// reaches the extension two ways: pushed in a `review` frame when the human asks from a browser tab, and
// fetched with the `reviewTarget` RPC when they ask from the sidebar (`ntwine:review`, embed-protocol.ts).

/** One checkout a thread changed files in. */
export interface EditorReviewCheckout {
  /** The checkout's root: a worktree of the project's repository, or the project folder. */
  dir: string
  /**
   * "branch": every change in it since its branch left the one it came from, committed or not — the
   * checkout is the thread's own (a worktree). "files": only `files`, against the last commit — the
   * checkout is the project folder, which other agents share, so anything else changed there is theirs.
   */
  scope: "branch" | "files"
  /** Absolute paths of the files the thread edited in it, the most recent first. */
  files: string[]
}

export interface EditorReviewTarget {
  /** The thread's title, for the diff's tab: "Changes in <title>". */
  title: string
  /** The checkout the thread edited in last first. Empty: it has edited nothing ntwine can see. */
  checkouts: EditorReviewCheckout[]
}

/** Open a thread's changes as a multi-file diff and raise the window. Answer with `result`. */
export interface EditorReview extends EditorReviewTarget {
  t: "review"
  id: string
}

export interface EditorComposed {
  t: "composed"
  id: string
  ok: boolean
  error?: string
}

/** One ntwine project, for the extension to map files to and to show counts for. */
export interface EditorProject {
  id: string
  slug: string
  name: string
  /** The folder its agents run in (`workDirOf`): the project folder, or Home's folder. */
  dir: string
  home?: true
  /** Present only while the project is open on the server: its queue (Ready) and spinning (Working) counts. */
  ready?: number
  working?: number
}

/** Every registered project (and Home), pushed on connect and whenever any of it changes. */
export interface EditorProjects {
  t: "projects"
  projects: EditorProject[]
}

export interface EditorHeartbeat {
  t: "hb"
}

/** What a thread that came to rest needs from the human, most pressing first (shared queueUrgency's reasons). */
export type EditorAttentionNeeds = "terminal" | "approval" | "question" | "stopped" | "limit" | "ready"

/**
 * A thread of a project this window has open came to rest needing the human — it entered the queue
 * (board.ts notifyNeedsYou's `needs-decision`, the edge the page's own notifications use). Sent to ONE
 * window: of those that said `listen {attention: true}` and have the project open, the one the human was
 * in last. The extension shows it unless the ntwine sidebar is in sight (it shows the card already).
 */
export interface EditorAttention {
  t: "attention"
  projectId: string
  /** The fields the page names a thread by (groups.ts displayTitle), so the notification says what the board says. */
  thread: EditorAttentionThread
  needs: EditorAttentionNeeds
  /** One line of what it asks or said last, as the page's own notification reads. */
  body?: string
}

export interface EditorAttentionThread {
  id: string
  title: string
  aiTitle?: string
  titleAuto?: boolean
  titleLocked?: boolean
  titleNamed?: boolean
  spawnedAt?: string
  backend?: string
  runtime?: string
}

export type EditorServerMessage = EditorWelcome | EditorOpen | EditorFocus | EditorReview | EditorComposed | EditorProjects | EditorHeartbeat | EditorAttention

/** What an ntwine page knows about connected editor windows (`editorWindows`, and the `editors` event). */
export interface EditorWindowSummary {
  app: string
  kind: EditorKind
  /** False when the window turned file opens off. */
  acceptsOpens: boolean
  /** The window can show a thread's changes (`review`); absent from an extension from before it. */
  reviews?: true
  /** The ntwine extension's build in that window (its hello's `extensionVersion`: `0.1.0+1a2b3c4d`). */
  extensionVersion?: string
}

/**
 * WHAT A BROWSER TAB SHOWS OF THE EDITOR BESIDE IT (`editorFront`). In the sidebar the context bar reads the
 * editor live and every send carries it; a human talking to a thread from a browser tab beside VS Code has
 * neither, and an agent there reads the editor only when it decides to call its `editor` tool. So the
 * tab's prompt boxes show one quiet line — `VS Code: a.ts:12-20` — naming what that tool would read: the
 * file in front of the window the human used last that has the project open, and its selection's lines,
 * only while that window shares its editor (`ntwine.shareEditorState`). Never the text: a click asks for
 * it (`editorFront({ text: true })`'s `item`), so what crosses is what the human chose to add.
 */
export interface EditorFront {
  /** `vscode.env.appName`, and its family, for the line's words ("VS Code"). */
  app: string
  kind: EditorKind
  /** Absolute, as the extension sees it; for an untitled buffer, its label (`Untitled-1`). */
  path: string
  untitled?: true
  /** Unsaved changes: the copy on disk is not what the human sees. */
  dirty?: true
  /** 1-based line of the caret. */
  cursorLine: number
  /** The selection's lines, 1-based and inclusive; absent with only a caret. */
  selection?: { startLine: number; endLine: number }
  /** The selection's text stays in the editor: the file may hold secrets. */
  withheld?: true
}

/** One editor window as a worker reads it (`editorState`). */
export interface EditorStateWindow {
  app: string
  kind: EditorKind
  /** Whether this window has OS focus right now. */
  focused: boolean
  /** How long ago it last had focus, when it does not now; absent when it never has. */
  focusedAgoMs?: number
  folders: string[]
  /**
   * What its editor showed at its last report, and how long ago that was. The extension reports every
   * change, so an old report is a quiet editor, not a stale one. Absent: this window has reported nothing
   * — an extension from before the report, or one that has not sent it yet.
   */
  editor?: Omit<EditorSnapshot, "t"> & { reportedAgoMs: number }
}

/**
 * Where the CALLING thread works when that is not the project's own checkout — a worktree, most often
 * (`.ntwine/worktrees/<slug>`, about one thread in seven). The human's editor usually shows the main
 * checkout, so the file they have selected there is THEIR copy; the same relative path under `dir` is the
 * worker's, and the two can differ. Absent: the thread works at the project root, or the caller named no
 * thread.
 */
export interface EditorStateCheckout {
  /** The thread's checkout, spelled through the project folder when it lies inside it. */
  dir: string
  /** The project's own folder (`workDirOf`), which a main-checkout window shows. */
  root: string
  /** "worktree": a linked git worktree. "folder": another folder entirely. */
  kind: "worktree" | "folder"
}

/** The `editorState` RPC: the editor windows that have this project open, the one the human was in last first. */
export interface EditorStateResult {
  windows: EditorStateWindow[]
  /**
   * Every editor window connected to ntwine, these included. The others are counted and NOT described: their
   * folders are other projects, which a worker of this one has no business learning (until 2026-10-02 they
   * were listed, folders and all, to any worker of any project).
   */
  connected: number
  /** The calling thread's own checkout, when it is not the project root (EditorStateCheckout). */
  checkout?: EditorStateCheckout
}
