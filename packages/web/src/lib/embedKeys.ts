import type { ActionId, Chord, Platform } from "./keybindings.ts"

// THE KEYBOARD IN AN EDITOR'S SIDEBAR — what the shortcuts sheet (components/KeyboardShortcuts.tsx) says
// where the sidebar differs from the browser. Every key the sheet lists works there; these are the
// differences, said where the key is listed (ARCHITECTURE.md § VS Code extension).
//
// WHERE A KEY GOES. While the frame has focus no VS Code keybinding sees a key (the sidebar spike,
// 2026-10-01), so every key reaches Ntwine — and Ntwine's chords that VS Code also binds (⌘K, its chord
// prefix; ⌘, its settings; ⌘I, its inline chat) are Ntwine's there and VS Code's from the editor. The page
// forwards each Ctrl/Cmd chord it leaves alone (lib/embedHost.ts `ntwine:key`), and the extension runs the
// ones its allowlist names: HOST_CHORDS below, which must stay the list in packages/vscode/src/embed.ts
// CHORDS (embedKeys.test.ts runs every one through the extension's own matcher).

/** What a key does in the sidebar, where that is not what its name in the sheet says. Shown under the name. */
export const SIDEBAR_KEY_HINTS: Partial<Record<ActionId, string>> = {
  // No cards: the next card is the next thread in the queue, opened in its drawer (SidebarPage.tsx).
  "queue.next": "Opens the next queued thread",
  "queue.prev": "Opens the previous one",
  // The drawer is the frame's width already; the door opens the thread in the browser (ExpandThreadLink.tsx).
  "thread.fullscreen": "Opens it in your browser",
  // Every thread opens in its drawer here, so there is no card to open one from.
  "thread.open": "Every thread opens in one here",
  // `e` on a thread: the sidebar is inside the editor already, so its folder shows there (the extension
  // reveals it, or opens a folder outside the workspace in a new window) rather than in the Local file links app.
  "thread.editor": "Shows its folder in VS Code",
  // ⌘I adds the editor's selection to the prompt box — bound by the extension in the editor, and pressed in
  // a sidebar prompt box too, the way Cursor's ⌘L works from its chat.
  "app.details": "In a prompt box or the editor, adds the selection",
}

/**
 * The sheet's names for the keys whose sidebar meaning is not their name, where a SENTENCE uses the name —
 * the line a rebind writes ("Next queued thread is now ⇧Z"). The rows keep the desktop's names, with the
 * hint under them.
 */
export const SIDEBAR_KEY_NAMES: Partial<Record<ActionId, string>> = {
  "queue.next": "Next queued thread",
  "queue.prev": "Previous queued thread",
}

/**
 * The sheet's note over the keys, in the sidebar. The second sentence because a rebind is kept in the
 * frame's own storage, which the browser partitions from a tab's: a key changed here is not changed in a
 * browser tab, and the reverse (ARCHITECTURE.md § VS Code extension).
 */
export const SIDEBAR_KEYS_NOTE = "Keys reach Ntwine while the sidebar has focus. Changes here stay in the sidebar."

/** The Queue group's note in the sidebar, where the drawer is the card (lib/keyboardRuntime.ts openCurrent). */
export const SIDEBAR_QUEUE_NOTE = "In the open thread. With none open, a key opens the one you're on."

/**
 * A chord the extension binds IN THE EDITOR to reach the sidebar's prompt box — the reason the sidebar
 * exists, so the sheet leads with them there. Cursor's ⌘L first, both its halves (the chord the context bar
 * names, lib/editorContext.ts editorAddChord): with a selection, add it; with none, go to the prompt box.
 * Claude Code's ⌥K last, and only while Claude Code's own extension does not hold it (`altK`: the sheet
 * drops the row then, since the key is not Ntwine's in that editor). The app's own ⌘I is bound there too, and
 * listed where it always is, under Thread details with its sidebar hint. `command` and `when` are the
 * extension's keybinding, which embedKeys.test.ts finds in packages/vscode/package.json, so the sheet can
 * never teach a chord the editor does not have.
 */
export interface EditorChord {
  label: string
  chord: Chord
  command: string
  when: string
  /** Shown only while Alt+K is Ntwine's in this editor (the extension's `ntwine:host-state`). */
  altK?: true
}

export const EDITOR_CHORDS: readonly EditorChord[] = [
  { label: "Add the selection", chord: { key: "l", mod: true, alt: false, shift: false }, command: "ntwine.addToPrompt", when: "editorTextFocus && editorHasSelection" },
  { label: "No selection: go to the prompt box", chord: { key: "l", mod: true, alt: false, shift: false }, command: "ntwine.focusPrompt", when: "editorTextFocus && !editorHasSelection && config.ntwine.useSidebar" },
  { label: "Add the selection or file", chord: { key: "k", mod: false, alt: true, shift: false }, command: "ntwine.addSelectionOrFile", when: "editorTextFocus && !ntwine.claudeCodeInstalled", altK: true },
]

/** The note under the Editor group: where these are pressed, and the way back. */
export function editorChordsNote(chord: string): string {
  return `Pressed in the editor. ${chord} here goes back to it.`
}

/**
 * A VS Code chord the sidebar passes on. `primary` is ⌘ on a Mac and Ctrl elsewhere, as VS Code spells it;
 * `ctrl` is Ctrl on every platform (VS Code binds the terminal and source control to Ctrl on a Mac too).
 * `code` is the physical key the extension matches (`KeyboardEvent.code`), `key` its cap.
 */
export interface HostChord {
  label: string
  primary: boolean
  ctrl: boolean
  shift: boolean
  code: string
  key: string
}

const chord = (label: string, spec: string): HostChord => {
  const parts = spec.split("+")
  const code = parts.pop()!
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code === "Backquote" ? "`" : code
  return { label, primary: parts.includes("primary"), ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), code, key }
}

/** VS Code's own names, in VS Code's own default chords. */
export const HOST_CHORDS: readonly HostChord[] = [
  chord("Command palette", "primary+shift+KeyP"),
  chord("Go to file", "primary+KeyP"),
  chord("Toggle the side bar", "primary+KeyB"),
  chord("Toggle the panel", "primary+KeyJ"),
  chord("Toggle the terminal", "ctrl+Backquote"),
  chord("Back to the editor", "primary+KeyL"),
  chord("First editor group", "primary+Digit1"),
  chord("Explorer", "primary+shift+KeyE"),
  chord("Search", "primary+shift+KeyF"),
  chord("Source control", "ctrl+shift+KeyG"),
  chord("Run and debug", "primary+shift+KeyD"),
  chord("Extensions", "primary+shift+KeyX"),
]

/** The note under the VS Code group. */
export const HOST_CHORDS_NOTE = "Pressed in the sidebar, these go to VS Code. Its other keys work from the editor."

/** A chord's keycaps in each platform's order: Apple's ⌃⇧⌘, and Ctrl, Shift elsewhere. */
export function hostChordKeycaps(chord: HostChord, platform: Platform): string[] {
  if (platform === "mac") return [...(chord.ctrl ? ["⌃"] : []), ...(chord.shift ? ["⇧"] : []), ...(chord.primary ? ["⌘"] : []), chord.key]
  return ["Ctrl", ...(chord.shift ? ["Shift"] : []), chord.key]
}

/**
 * A VS Code chord the human just pressed to rebind a Ntwine key to, in the sidebar: that key is VS Code's
 * there (the page forwards it, HOST_CHORDS), so the sheet refuses it saying so — not that it belongs to the
 * browser, which is the desktop's reason for most of them. Matched on the event as the page forwards it, so
 * Ctrl and ⌘ are told apart on a Mac the way the extension tells them apart.
 */
export function hostChordProblem(event: { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, platform: Platform): string | null {
  const chord = HOST_CHORDS.find((candidate) => {
    const wants = hostChordEvent(candidate, platform)
    return wants.code === event.code && wants.ctrl === event.ctrlKey && wants.meta === event.metaKey && wants.shift === event.shiftKey && wants.alt === event.altKey
  })
  if (!chord) return null
  return `${hostChordKeycaps(chord, platform).join(platform === "mac" ? "" : "+")} goes to VS Code`
}

/** The keydown a chord is on a platform, as the page forwards it (`ntwine:key`) — for the pin test. */
export function hostChordEvent(chord: HostChord, platform: Platform): { code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean } {
  const mac = platform === "mac"
  return { code: chord.code, ctrl: chord.ctrl || (!mac && chord.primary), meta: mac && chord.primary, shift: chord.shift, alt: false }
}
