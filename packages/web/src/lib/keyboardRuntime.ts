import { useEffect, useRef, type RefObject } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { prefs } from "./prefs.ts"
import { actionDef, bindingLookup, detectPlatform, effectiveBindings, formatChord, isPlainChord, matchAction, type ActionId } from "./keybindings.ts"

// THE KEYBOARD RUNTIME — one window keydown listener (mounted by <KeyboardLayer/>, once per page
// shell) that turns a match from lib/keybindings.ts into an act. Three kinds of act, by who owns the
// thing being acted on:
//
//   · A PAGE-OWNED action (the palette, settings, the new-thread door, thread details) is registered
//     by the page that renders it — useShortcut() — so a key does nothing on a page without the
//     thing, rather than reaching for a store flag no component is listening to.
//   · CARD NAVIGATION (j / k) goes through the QueueCursor the page's rail registers: the board's
//     sidebar and the Everything page each already know which card is being read, and how to land on
//     one; the keys reuse exactly that, so the rail's marker and the key never disagree.
//   · A THREAD COMMAND (done, snooze, reply, fullscreen) PRESSES THE REAL CONTROL on the surface you
//     are looking at — the top drawer, the /full page, or the card being read. Each control opts in
//     with `data-command`, and the key clicks it, so every gate that control already obeys (the
//     completion confirm, the optimistic fade, a disabled state, a foreign session) applies to the key
//     for free. A key that took its own route to the RPC would be a second implementation of
//     "Mark as done" — and the queue has learned the hard way what two of those drift into.

type Handler = () => boolean | void

const handlers = new Map<ActionId, Handler[]>()

/** Register a page-owned action. Returning `false` from the handler means "not here" — the key then
 *  falls through to the browser untouched. The newest registration wins. */
export function registerShortcut(id: ActionId, handler: Handler): () => void {
  const list = handlers.get(id) ?? []
  list.push(handler)
  handlers.set(id, list)
  return () => {
    const current = handlers.get(id)
    if (!current) return
    const index = current.lastIndexOf(handler)
    if (index !== -1) current.splice(index, 1)
  }
}

export function useShortcut(id: ActionId, handler: Handler, enabled = true): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => (enabled ? registerShortcut(id, () => ref.current()) : undefined), [id, enabled])
}

// ── the card being read ───────────────────────────────────────────────────────────────────────────

export interface QueueCursor {
  /** Navigable cards in page order — excluding any mid-exit. */
  keys(): string[]
  /** The card the rail marks as being read, or null when none is on screen. */
  current(): string | null
  /** That card's bordered root — the element its controls live under. */
  root(key: string): HTMLElement | null
  /** Land on a card exactly the way clicking its rail row does. */
  go(key: string): void
}

let cursors: QueueCursor[] = []

export function registerQueueCursor(cursor: QueueCursor): () => void {
  cursors = [...cursors, cursor]
  return () => {
    cursors = cursors.filter((entry) => entry !== cursor)
  }
}

function activeCursor(): QueueCursor | null {
  return cursors.at(-1) ?? null
}

function stepCard(step: 1 | -1): boolean {
  const cursor = activeCursor()
  if (!cursor) return false
  const keys = cursor.keys()
  if (!keys.length) return true
  const index = keys.indexOf(cursor.current() ?? "")
  // Nothing marked (scrolled past every card, or none reached yet): either key starts at the top.
  const target = index === -1 ? keys[0] : keys[Math.min(keys.length - 1, Math.max(0, index + step))]
  // At either end the key lands the card it is already on — the same re-ring a second click on its
  // rail row plays — so the press is visibly received rather than silently eaten.
  cursor.go(target)
  return true
}

// ── the surface you are looking at ────────────────────────────────────────────────────────────────

/**
 * The element whose controls a thread command presses: the topmost drawer layer if one is open (it is
 * what is in front of you — a sub-agent's sheet included, where `r` steers the sub-agent), else the
 * /full page's thread column, else the queue card the rail marks as being read.
 */
export function currentThreadSurface(): HTMLElement | null {
  if (typeof document === "undefined") return null
  const top = [...store.drawers].reverse().find((drawer) => !drawer.closing)
  if (top) return document.querySelector<HTMLElement>(`[data-drawer-layer="${top.id}"]`)
  const full = document.querySelector<HTMLElement>("[data-standalone-thread]")
  if (full) return full
  const cursor = activeCursor()
  const key = cursor?.current()
  // A card already on its way out is not "the card you are reading" any more, even for the frame or
  // two before the rail catches up — acting on it again would at best be a no-op.
  if (!cursor || !key || !cursor.keys().includes(key)) return null
  return cursor.root(key)
}

/** Dispatched on a `data-command` control before the default press, so a control whose press is not
 *  a click (a Radix menu trigger opens on pointerdown/keydown) can claim it with preventDefault. */
export const COMMAND_EVENT = "frizz:command"

export type ThreadCommand = "done" | "snooze" | "fullscreen" | "reply"

// Every prompt box that answers the thing on screen. Deliberately NOT the question card's free-text
// answer box (`questionAnswer`) — `r` is a reply to the thread, and a question has its own chips.
const REPLY_BOXES = ["queueComposer", "chatComposer", "adoptComposer", "subAgentComposer", "commandFollowUp"]
  .map((surface) => `[data-surface="${surface}"]`)
  .join(",")

function runThreadCommand(command: ThreadCommand): boolean {
  const surface = currentThreadSurface()
  if (!surface) return false
  if (command === "reply") {
    const box = surface.querySelector<HTMLTextAreaElement | HTMLInputElement>(REPLY_BOXES)
    if (!box) return false
    box.focus()
    // Land after whatever is already drafted, not in front of it.
    const end = box.value.length
    box.setSelectionRange?.(end, end)
    return true
  }
  const control = surface.querySelector<HTMLElement>(`[data-command="${command}"]`)
  if (!control) return false
  if (!control.dispatchEvent(new CustomEvent(COMMAND_EVENT, { cancelable: true, detail: command }))) return true
  if (control instanceof HTMLButtonElement && control.disabled) return true
  control.click()
  return true
}

/**
 * Claim a command for a control that must open rather than be clicked — see COMMAND_EVENT. The element
 * still needs its `data-command` attribute; this only replaces what the press does.
 */
export function useCommandHandler(ref: RefObject<HTMLElement | null>, handler: () => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const listener = (event: Event) => {
      event.preventDefault()
      latest.current()
    }
    el.addEventListener(COMMAND_EVENT, listener)
    return () => el.removeEventListener(COMMAND_EVENT, listener)
  }, [ref])
}

// ── the listener ──────────────────────────────────────────────────────────────────────────────────

const BUILT_INS: Partial<Record<ActionId, Handler>> = {
  "queue.next": () => stepCard(1),
  "queue.prev": () => stepCard(-1),
  "thread.reply": () => runThreadCommand("reply"),
  "thread.done": () => runThreadCommand("done"),
  "thread.snooze": () => runThreadCommand("snooze"),
  "thread.fullscreen": () => runThreadCommand("fullscreen"),
  "app.shortcuts": () => {
    store.showShortcuts = !store.showShortcuts
  },
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type)
  return false
}

// A plain key is for the page, so anything layered over the page takes it away: the app's own
// overlays by their store flags, and any open Radix dialog, menu or listbox by its DOM (a modal Radix
// layer also pins `pointer-events: none` on the body, which is the catch-all). Thread drawers are
// NOT in this list: they are the page you are reading, and `e` in one finishes its thread.
function overlayOpen(): boolean {
  if (store.showPalette || store.showNewThread || store.showGithubPicker || store.showSettings || store.showShortcuts) return true
  if (typeof document === "undefined") return false
  if (document.body.style.pointerEvents === "none") return true
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]') !== null
}

let cachedOverrides: unknown = null
let cachedLookup = bindingLookup(effectiveBindings({}))

function lookup() {
  // prefs.keybindings is replaced wholesale on every change (the sheet assigns a new object), so its
  // identity is a sound cache key and the map is rebuilt only when a binding actually moved.
  if (prefs.keybindings !== cachedOverrides) {
    cachedOverrides = prefs.keybindings
    cachedLookup = bindingLookup(effectiveBindings(prefs.keybindings))
  }
  return cachedLookup
}

export function handleShortcutKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  // The terminal is a native TUI surface: every key in it belongs to xterm.
  if (event.target instanceof Element && event.target.closest(".xterm")) return
  const match = matchAction(event, lookup())
  if (!match) return
  const { action, chord } = match
  if (isPlainChord(chord)) {
    // A plain key some control already handled is that control's. NOT asked of a chord: the palette's
    // input handles Ctrl-K itself (cmdk's vim-style "previous item") and prevents it, and Ctrl-K must
    // still close the palette on Windows and Linux the way ⌘K does on a Mac.
    if (event.defaultPrevented) return
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
    // The sheet's own key closes it; every other plain key waits for the overlay to go.
    if (overlayOpen() && !(action === "app.shortcuts" && store.showShortcuts)) return
  }
  if (event.repeat && !actionDef(action).repeat) {
    event.preventDefault()
    return
  }
  const registered = handlers.get(action)?.at(-1)
  const run = registered ?? BUILT_INS[action]
  if (!run) return
  if (run() === false) return
  event.preventDefault()
}

/** The runtime's window listener. Bubble phase, so a text box or a menu that handles a key itself and
 *  stops it keeps it. */
export function useShortcutListener(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleShortcutKeydown)
    return () => window.removeEventListener("keydown", handleShortcutKeydown)
  }, [])
}

// ── naming the key where the mouse already is ─────────────────────────────────────────────────────

const platform = detectPlatform()

/** An action's current keys as one string ("⌘K", "Ctrl+K", "E"), or null when it has none. Follows a
 *  rebind live, so a tooltip never teaches a key that no longer does the thing. */
export function useShortcutLabel(id: ActionId): string | null {
  const overrides = useSnapshot(prefs).keybindings
  const chord = effectiveBindings(overrides as typeof prefs.keybindings)[id]
  return chord ? formatChord(chord, platform) : null
}

/** "Mark as done (E)" — the control's own words, then its key. */
export function withShortcut(label: string, keys: string | null): string {
  return keys ? `${label} (${keys})` : label
}
