import type { EmbedEditorContextMessage, EmbedHostStateMessage } from "@ntwine/shared"
import { proxy, useSnapshot } from "valtio"
import { appendEditorContext, appendWorktreeNote, buildMessageWithContext, contextChipLabel, hasToken, previousEditorQuote, serializeEditorContext, worktreeNote, type ComposerContextItem } from "./composerContext.ts"
import { embedded, postToHost } from "./embed.ts"
import { splitComposerValue } from "./imagePaths.ts"
import { formatChord, type Chord, type Platform } from "./keybindings.ts"
import { messagePresentationText } from "./messagePresentation.ts"
import { basename } from "./paths.ts"

// WHAT THE EDITOR AROUND THE SIDEBAR HAS OPEN — the latest `ntwine:editor-context` (packages/shared/src/
// embed-protocol.ts), kept for the context bar over the sidebar's composers (components/
// EditorContextBar.tsx) and for the send, which carries it (`outgoingMessage`): the file in front, its
// selection with the primary selection's text, or the caret's line. Empty outside embed mode, where
// nothing ever writes it.
//
// And the extension's own state the page shows (`ntwine:host-state`): whether the human shares the editor
// with ntwine — the one switch, `ntwine.shareEditorState`, which the bar's eye shows and flips — and whether
// Alt+K is ntwine's in this window. And the page's own one-shot exception to that switch: what is in front
// right now, left out of the messages by the bar's × until it changes (`leaveOut`).

export interface EditorContextState {
  active: EmbedEditorContextMessage["active"]
  open: EmbedEditorContextMessage["open"]
  /**
   * The human shares the editor with ntwine: sends carry the block, agents can read the editor. The
   * extension's setting, as its last `ntwine:host-state` said — or, before one arrives (an extension from
   * before the message), on, as the setting defaults, with the eye this page's alone until a reload.
   */
  share: boolean
  /** Alt+K in the editor is ntwine's here (not while Claude Code's extension holds it). */
  altK: boolean
  /**
   * What the human left out with the bar's × (`leaveOut`), by its `leaveOutKey` — kept while the editor
   * still shows THAT, and dropped the moment it shows anything else. Null: nothing is left out.
   */
  leftOut: string | null
}

export const editorContext = proxy<EditorContextState>({ active: null, open: [], share: true, altK: true, leftOut: null })

/**
 * A `ntwine:editor-context` from the host replaces the last one whole — and ends a leave-out the moment the
 * editor shows something else (`leaveOutKey`), so a new selection goes with the message again on its own.
 * Dropped rather than merely compared: selecting other lines and then the same lines again is a new choice
 * to point at them, and the human should not find them still left out from before.
 */
export function setEditorContext(message: EmbedEditorContextMessage): void {
  editorContext.active = message.active
  editorContext.open = message.open
  if (editorContext.leftOut !== null && editorContext.leftOut !== leaveOutKey(message.active)) editorContext.leftOut = null
}

// ── leaving this one out ──────────────────────────────────────────────────────────────────────────
//
// THE ONE-SHOT EXCEPTION TO THE EYE. Claude Code's VS Code extension lets the human drop the selection in
// front from the next message without turning the feature off: the indicator is clicked, the selection
// stays home, and the next selection goes as usual. The eye cannot be that — it is a VS Code setting, it
// holds in every window and across reloads, and it also keeps the agents' editor tool out — and turning it
// off for one question and remembering to turn it back on is exactly the chore that makes a privacy switch
// get left in the wrong position. So the bar's reading has a × of its own (EditorContextBar): THIS
// selection, or with nothing selected this file, is left out of every message sent from the sidebar until
// the editor shows something else. It is the page's alone and lasts no longer than the page: the agents'
// tool still reads the editor (the eye is still on, and the human can see that it is), and a click on the
// struck reading still adds it as a chip, on purpose.

/**
 * What a leave-out holds on to: the selection — its file, lines and size, so another drag over the same
 * lines that takes more or less of them is a new selection — or, with nothing selected, the file alone.
 * NOT the caret's line: with nothing selected the human moves the caret as they type and read, and a file
 * left out must not come back on every arrow key. Null with nothing in front.
 */
export function leaveOutKey(active: EditorContextState["active"]): string | null {
  if (!active) return null
  const selection = active.selection
  return selection ? `selection\n${active.path}\n${selection.startLine}-${selection.endLine}\n${selection.chars}` : `file\n${active.path}`
}

/** Whether what the editor shows now is what the human left out. Pure, for its test. */
export function isLeftOut(state: Pick<EditorContextState, "active" | "leftOut">): boolean {
  return state.leftOut !== null && state.leftOut === leaveOutKey(state.active)
}

/** The bar's ×: leave what is in front out of the messages (`on`), or put it back. */
export function leaveOut(on: boolean): void {
  editorContext.leftOut = on ? leaveOutKey(editorContext.active) : null
}

/** A `ntwine:host-state`: what the extension's settings say now — the truth, over anything the eye assumed. */
export function setHostState(message: EmbedHostStateMessage): void {
  editorContext.share = message.shareEditor
  editorContext.altK = message.altK
}

/**
 * The eye, flipped: shown at once, and asked of the extension, which writes its setting and answers with
 * `ntwine:host-state` — so a write that did not take (a workspace value that wins) puts the eye back.
 */
export function setShareEditor(on: boolean): void {
  editorContext.share = on
  postToHost({ type: "ntwine:share-editor", on })
}

export function useEditorContext(): EditorContextState {
  return useSnapshot(editorContext) as EditorContextState
}

// ── what the bar reads ────────────────────────────────────────────────────────────────────────────

export interface ContextBarReading {
  /** A selection is "highlighted code", drawn in the accent; a file alone is the dimmer suggestion. */
  kind: "selection" | "file"
  /** The basename, which truncates first at a narrow width. */
  name: string
  /** `:91-116` or `:91` — kept whole when the name truncates, since it is what makes the reading a range. */
  range: string
  /** `26 lines`, for a selection. */
  count?: string
  /** The workspace-relative path, for the hover. */
  where: string
}

/**
 * What the bar shows for the editor in front: its file, and the selection's range and size when there
 * is one. The label is the chip the click will make (`contextChipLabel`, the ⌘I token's label), split so
 * a long name can truncate without losing its range. Null when no text editor is in front.
 */
export function contextBarReading(active: EditorContextState["active"]): ContextBarReading | null {
  if (!active) return null
  const name = basename(active.label)
  const selection = active.selection
  if (!selection) return { kind: "file", name, range: "", where: active.label }
  const label = contextChipLabel({ display: active.label, startLine: selection.startLine, endLine: selection.endLine })
  const lines = selection.endLine - selection.startLine + 1
  return { kind: "selection", name, range: label.slice(name.length), count: `${lines} ${lines === 1 ? "line" : "lines"}`, where: active.label }
}

/**
 * The editor's chord for the sidebar's prompt, as the page advertises it: ⌘L on a Mac, Ctrl+L elsewhere —
 * Cursor's, both halves of it (David 2026-10-02: "take the best parts of [Cursor and the Claude Code
 * VS Code extension]"). In the editor WITH a selection it adds the selection as a chip at the prompt box's
 * caret; with NOTHING selected it moves to the prompt box; pressed in the sidebar it goes back to the
 * editor (lib/embedHost.ts forwards it; packages/vscode embed.ts CHORDS runs it). The extension binds it
 * beside the app's own ⌘I (FileViewerPanel's staging chord) and, while Claude Code's extension does not
 * hold it, Claude Code's ⌥K. One chord is named, the one most people know; the `?` sheet lists them all
 * (lib/embedKeys.ts EDITOR_CHORDS). Spelled by the app's keycap formatter so it reads like every other
 * shortcut.
 */
export const EDITOR_ADD_CHORD: Chord = { key: "l", mod: true, alt: false, shift: false }

export function editorAddChord(platform: Platform): string {
  return formatChord(EDITOR_ADD_CHORD, platform)
}

/**
 * What the bar says beside its reading, longest first (the bar shows the longest that fits, or none). It
 * used to say "Select code and press Ctrl+L" — the step a plain question no longer needs, since whatever is
 * selected goes with the message on its own. So it says THAT first, and then what the chord is still for:
 * a chip at the caret, to point at code in the middle of a sentence. With sharing off it says that nothing
 * goes on its own (the chord still adds, on purpose); with a file whose text stays home, that only its lines
 * go. Plain words, sentence case, no machinery.
 *
 * The SHORTEST rung is sized for the default sidebar: at 300px, beside the eye and `sample.ts ⌄`, the slot
 * holds about 110px of 11px text — "Select + Ctrl+L" (15 characters) and nothing longer, so the run's c3
 * read an empty hint until it was the last rung ("Ctrl+L: selection at caret" fits only beside a name as
 * short as `a.ts`). The chord is the editor's; pressed in the page it goes back to the editor, and the
 * reading's own tooltip says "in the editor" for the human who wonders.
 */
export function barHints(state: { sending: boolean; selection: boolean; withheld: boolean; chord: string; leftOut?: boolean }): string[] {
  const { sending, selection, withheld, chord, leftOut } = state
  if (!sending) return selection ? [`Not shared · ${chord} still adds it`, "Not shared"] : ["Not shared with ntwine", "Not shared"]
  // Left out with the ×: what brings it back is the editor moving on, which is what the human will do next
  // anyway — so that is what the hint says, and the ×'s own hover says a click puts it back.
  if (leftOut) return selection ? ["Left out until you select something else", "Left out"] : ["Left out until you switch files", "Left out"]
  if (selection && withheld) return ["Lines only: the file may hold secrets", "Lines only"]
  if (selection) return [`Goes with your message · ${chord} puts it at the caret`, "Goes with your message"]
  return [`Selections go with your message · ${chord} puts one at the caret`, `${chord} puts a selection at the caret`, `Select + ${chord}`]
}

// ── adding: a click on the bar, answered by the host's compose ────────────────────────────────────

/**
 * The prompt box a bar sits on — what its draft is keyed by (lib/drafts.ts), the directory its chips'
 * paths are shown relative to, and the textarea's `data-surface`, so the caret can be put back in it.
 */
export interface ContextBox {
  key: string
  projectDir: string | undefined
  surface: "chatComposer" | "newComposer"
}

/**
 * How long a click on a bar waits for the host's answer. The extension reads the selection and answers
 * at once; the window only has to outlast a busy extension host, and must not be so long that a ⌘I made
 * in the editor much later lands in a box the human clicked a while ago.
 */
export const ADD_CONTEXT_WINDOW_MS = 5_000

export interface PendingAdd {
  box: ContextBox
  at: number
}

let pending: PendingAdd | null = null

/**
 * Ask the host for the editor's selection, or a whole file, for THIS box. The host cannot say which box
 * — it answers every add with a compose aimed at "front" — so the page remembers which box asked, and
 * the answer goes there (`takePendingAdd`, lib/embedHost.ts). "Front" alone would usually agree, but not
 * always: the New thread sheet can be open over a thread's drawer, and a chip the human asked for in
 * one box must never land in another.
 */
export function requestEditorContext(box: ContextBox, what: { what: "selection" } | { what: "file"; path: string } | { what: "problems" } | { what: "terminal" }): void {
  pending = { box, at: Date.now() }
  postToHost({ type: "ntwine:add-context", ...what })
}

/** The box a "front" compose arriving now belongs to, if a bar asked within the window. Pure, for its test. */
export function pendingBox(record: PendingAdd | null, now: number): ContextBox | null {
  if (!record || now - record.at < 0 || now - record.at > ADD_CONTEXT_WINDOW_MS) return null
  return record.box
}

/** Claim the box a bar asked for — once: a later ⌘I in the editor goes to "front" as it always did. */
export function takePendingAdd(now = Date.now()): ContextBox | null {
  const box = pendingBox(pending, now)
  pending = null
  return box
}

/**
 * What a press of the bar adds, from what the editor has in front: its selection, else the whole file. An
 * untitled buffer has no file a chip could name; what is in it goes with the message, but cannot be added.
 */
export function barAdd(active: EditorContextState["active"]): { what: "selection" } | { what: "file"; path: string } | null {
  if (!active || active.untitled) return null
  return active.selection ? { what: "selection" } : { what: "file", path: active.path }
}

// ── ⌘I in the sidebar: the bar's press, from the keyboard ─────────────────────────────────────────

// The bars on screen, each by its strip (EditorContextBar.tsx registers it), so a key can find the bar of
// the box it was typed in. The strip sits in its composer's own box (Composer `header`), so the composer
// is the strip's parent.
const bars = new Map<HTMLElement, ContextBox>()

export function registerContextBar(strip: HTMLElement, box: ContextBox): () => void {
  bars.set(strip, box)
  return () => {
    if (bars.get(strip) === box) bars.delete(strip)
  }
}

/**
 * ⌘I / Ctrl+I IN THE SIDEBAR does what the editor's ⌘I does — puts the code in front into the prompt — so
 * one chord means one thing on both sides of the frame, as in Cursor (ARCHITECTURE.md § VS Code
 * extension). Typed in a prompt box that shows a context bar it is a press of that bar: the
 * selection, else the file in front, as a chip in THAT box. With no drawer up, and the caret in no such
 * box, it goes into the page's new-thread box (the New thread dialog's, while that is up). Anywhere else —
 * a thread open and the caret outside its reply box — it is not this key's, and Thread details keeps it
 * (App.tsx), as in the browser.
 *
 * "added" when a request went to the editor; "nothing" when the key was this one's but the editor has no
 * file in front to add; null when it is not this key's.
 */
export function addEditorContextByKey(focused: Element | null, drawerOpen: boolean, dialogOpen: boolean): "added" | "nothing" | null {
  const typedIn = focused instanceof HTMLTextAreaElement ? [...bars].find(([strip]) => strip.parentElement?.contains(focused)) : undefined
  let box = typedIn?.[1]
  if (!box) {
    if (drawerOpen && !dialogOpen) return null
    const inDialog = (strip: HTMLElement) => strip.closest('[role="dialog"]:not([data-drawer-layer])') !== null
    box = [...bars].find(([strip, candidate]) => candidate.surface === "newComposer" && inDialog(strip) === dialogOpen)?.[1]
    // No bar on the box: the editor has nothing open to offer it (the bar draws nothing then).
    if (!box) return "nothing"
  }
  const what = barAdd(editorContext.active)
  if (!what) return "nothing"
  requestEditorContext(box, what)
  return "added"
}

// ── sending: what the editor has in front goes with the message ───────────────────────────────────

/**
 * What a send from this page carries of the editor: what is in front, in an editor's sidebar, while the
 * human shares the editor (the bar's eye — the extension's `ntwine.shareEditorState`, a VS Code setting, so
 * it holds across reloads and windows, and the same switch keeps the agents' tool out of the editor), and
 * unless what is in front now is what the human left out with the bar's × (`leaveOut`). Null: nothing of
 * the editor goes. Pure — `inSidebar` is `embedded()` — for its test.
 */
export function sentEditorFront(state: Pick<EditorContextState, "active" | "share" | "leftOut">, inSidebar: boolean): EditorContextState["active"] {
  return inSidebar && state.share && !isLeftOut(state) ? state.active : null
}

/**
 * THE message a box with a context bar sends — the one helper behind both of the sidebar's send paths, a
 * thread's reply box (ThreadComposerBox) and the new-thread box (NewThreadModal: dispatch and a dispatch held
 * for sign-in): the chips' definitions (`buildMessageWithContext`), then, when `editor`
 * says this box shows the bar and the human has not turned it off, the editor block
 * (composerContext.ts `serializeEditorContext`) — read NOW, at send, which is the moment its header
 * describes. Nothing is taken from any store, so a send the server refuses loses nothing: the draft
 * comes back as the human typed it, and the next send reads the editor afresh.
 *
 * `editor` is the caller's to say because only a box that SHOWS the bar may carry what it reads — a
 * thread's reply box on a queue card has no bar, and context the human could not see go out is context
 * they could not turn off.
 *
 * `thread` is what the box knows of its thread, for a reply. `history`, its transcript: a selection whose
 * lines and text the thread's last block already quoted is named, not quoted again (composerContext.ts
 * previousEditorQuote). `checkout`, where it works when that is not the project root: paths are written
 * for that checkout, with a word on whose copy the context is (composerContext.ts worktreeNote).
 */
export function outgoingMessage(
  value: string,
  staged: readonly ComposerContextItem[],
  projectDir: string | null | undefined,
  editor: boolean,
  thread: { history?: readonly { role: string; text: string; displayText?: string }[]; checkout?: ThreadCheckout | null } = {},
): string {
  const active = editor ? sentEditorFront(editorContext, embedded()) : null
  const { history, checkout } = thread
  const previous = active && history ? previousEditorQuote(history.map((message) => ({ role: message.role, text: messagePresentationText(message).replace(/\r\n?/g, "\n") }))) : null
  return outgoingMessageWith(value, staged, projectDir, active, checkout, previous)
}

/** Where the box's thread works when that is not the project root (ThreadView.checkout). */
export type ThreadCheckout = { dir: string; kind?: string }

/**
 * `outgoingMessage` with the editor's context (and the thread's last quote of it) passed in, for its test.
 * `checkout` is the thread's own checkout: a file in it is written relative to it, and context from the
 * main checkout gets the sentence that says whose copy it is (composerContext.ts worktreeNote).
 */
export function outgoingMessageWith(
  value: string,
  staged: readonly ComposerContextItem[],
  projectDir: string | null | undefined,
  active: EditorContextState["active"],
  checkout?: ThreadCheckout | null,
  previous?: ReturnType<typeof previousEditorQuote>,
): string {
  const checkoutDir = checkout?.dir
  const withChips = buildMessageWithContext(value, [...staged], projectDir, checkoutDir)
  // The chips that serialize — the ones whose token is still in the prose — are the ones that can say
  // what the editor block would (composerContext.ts editorContextCovered).
  const { prose } = splitComposerValue(value)
  const present = staged.filter((item) => hasToken(prose, item.token))
  const block = active ? serializeEditorContext(active, present, projectDir, checkoutDir, previous) : ""
  const named = [...present.map((item) => item.path), ...(block && active ? [active.path] : [])]
  return appendWorktreeNote(appendEditorContext(withChips, block), worktreeNote(named, projectDir, checkout))
}
