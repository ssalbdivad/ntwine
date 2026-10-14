import { useEffect, useRef, type RefObject } from "react"
import { flushSync } from "react-dom"
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
//   · CARD NAVIGATION (j / k) goes through the QueueCursor the page registers: the Everything page
//     (AllQueues) already knows which card is being read, and how to land on one; the keys reuse
//     exactly that, so the rail's marker and the key never disagree. (The project board's sidebar
//     registered one too, until 2026-09-28 — hence a stack of cursors rather than a single slot.)
//   · A THREAD COMMAND (done, snooze, reply, open) PRESSES THE REAL CONTROL on the surface you
//     are looking at — the top drawer, the /full page, or the card being read. Each control opts in
//     with `data-command`, and the key clicks it, so every gate that control already obeys (the
//     completion confirm, the optimistic fade, a disabled state, a foreign session) applies to the key
//     for free. A key that took its own route to the RPC would be a second implementation of
//     "Mark as done" — and the queue has learned the hard way what two of those drift into. A page with
//     no cards (an editor's sidebar) reads a thread in its drawer, so there a key with no drawer open
//     opens the thread first (QueueCursor `openCurrent`).

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
  /**
   * A page with NO CARDS (an editor's sidebar, SidebarPage.tsx), where a thread is read in its drawer: open
   * the thread the reader is on, for a thread key pressed with no drawer open. False when there is none.
   * A page with cards leaves it unset, and the key then acts on the card being read.
   */
  openCurrent?(): boolean
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
  // Past either end the key wraps: `j` on the last card lands the first, `k` on the first lands the
  // last. A lone card lands itself — the same re-ring a second click on its rail row plays.
  const target = index === -1 ? keys[0] : keys[(index + step + keys.length) % keys.length]
  cursor.go(target)
  openCard(target, cursor.root(target))
  return true
}

/**
 * A card a key lands on is a card you mean to READ, so the landing presses the card's own "Show more" —
 * the real control, per the rule above. It does NOT focus the reply box: that was tried (e11f7f6d) and
 * every triage key then cost an Escape first. Triage is the common case, so it keeps the single keys,
 * and `r` is the one extra key to answer (David 2026-09-28).
 */
function openCard(key: string, root: HTMLElement | null): void {
  pendingOpen?.stop()
  const button = showMoreIn(root)
  if (button) return pressShowMore(key, button)
  if (root) awaitShowMore(key, root)
}

const showMoreIn = (root: ParentNode | null) => root?.querySelector<HTMLButtonElement>('[data-xq-show-more][aria-expanded="false"]') ?? null

function pressShowMore(key: string, button: HTMLButtonElement): void {
  button.click()
  autoOpened = { key, button }
}

/**
 * A CARD WHOSE "Show more" IS NOT THERE YET is opened when it arrives. A card far down a long queue is built
 * only as a key lands on it (lib/cardVisibility.ts), and its handoff — the text that clamps, and so the
 * button — can still be on its way: the press found nothing, and the card a key landed on stayed shut once
 * the button appeared a moment later (review 2026-10-02: `k` from the first card, wrapping to a never-built
 * last one). So the landing waits for the button, until the reader moves on (`releaseAutoOpened`, another
 * key), acts in the card themselves (a press or a key inside it is theirs to make), or OPEN_WAIT_MS passes —
 * a card that turns out short never shows one.
 */
const OPEN_WAIT_MS = 5_000
let pendingOpen: { key: string; stop: () => void } | null = null

function awaitShowMore(key: string, root: HTMLElement): void {
  const stop = () => {
    observer.disconnect()
    window.clearTimeout(timer)
    for (const type of ["pointerdown", "keydown"] as const) document.removeEventListener(type, ownAct, true)
    if (pendingOpen?.stop === stop) pendingOpen = null
  }
  const ownAct = (event: Event) => {
    if (event.isTrusted && event.target instanceof Node && root.contains(event.target)) stop()
  }
  const observer = new MutationObserver(() => {
    const button = showMoreIn(root)
    if (!button) return
    stop()
    pressShowMore(key, button)
  })
  observer.observe(root, { childList: true, subtree: true })
  const timer = window.setTimeout(stop, OPEN_WAIT_MS)
  for (const type of ["pointerdown", "keydown"] as const) document.addEventListener(type, ownAct, true)
  pendingOpen = { key, stop }
}

/**
 * The card a key opened, until the reader leaves it. Opening it was the KEY's doing, so leaving it undoes
 * it: stepping on with `j` / `k`, a rail row, or a click in another card closes it again (maintainer
 * 2026-09-28). A card the reader opened or closed with their OWN press is theirs and is left as it is —
 * that press is a trusted click, and a key's press never is.
 */
let autoOpened: { key: string; button: HTMLButtonElement } | null = null

if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted && autoOpened && event.target instanceof Node && autoOpened.button.contains(event.target)) autoOpened = null
    },
    true,
  )
}

/**
 * Close the card a key opened, unless `key` is that card. Scrolling alone does not call this: shrinking a
 * card the reader is scrolling past would yank the page under them. The page stays put across the collapse
 * on its own — the viewport lock (lib/viewportLock.ts) holds what is on screen when a card above it shrinks.
 */
export function releaseAutoOpened(key: string | null): void {
  if (pendingOpen && pendingOpen.key !== key) pendingOpen.stop()
  const held = autoOpened
  if (!held || held.key === key) return
  autoOpened = null
  if (!held.button.isConnected || held.button.getAttribute("aria-expanded") !== "true") return
  // Synchronously, so whoever measures next (the glide to the next card) measures the page without it.
  flushSync(() => held.button.click())
}

function focusReplyBox(surface: HTMLElement): boolean {
  const box = surface.querySelector<HTMLTextAreaElement | HTMLInputElement>(REPLY_BOXES)
  if (!box) return false
  box.focus()
  // Land after whatever is already drafted, not in front of it.
  const end = box.value.length
  box.setSelectionRange?.(end, end)
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

/**
 * A thread key with nothing in front of it, on a page whose cursor reads threads in their drawers (QueueCursor
 * `openCurrent`): the FIRST press opens the thread you're on, and only that — Mark as done, Snooze and the
 * rest act on a thread the human has seen, as they do on the desktop's card, so the second press is the one
 * that acts. `r` goes on into the drawer's reply box, which is all the desktop's `r` does to a card.
 */
function openForCommand(command: ThreadCommand): boolean {
  const cursor = activeCursor()
  if (!cursor?.openCurrent?.()) return false
  if (command === "reply") focusReplyBoxOnceOpen()
  return true
}

/** How long `r` waits for the drawer it opened — a thread of another project is a navigation first. */
const REPLY_OPEN_WAIT_MS = 5_000

/**
 * The caret into the reply box of a drawer that is still opening. The box mounts with the thread's body, a
 * frame or more after the open, and the sheet then focuses its own first control (ThreadSheet.tsx, once the
 * body is ready): so wait for the box, then two frames more, or the sheet takes the focus straight back.
 * Never over the human's own move: a field they are typing in by then keeps the caret.
 */
function focusReplyBoxOnceOpen(): void {
  const deadline = performance.now() + REPLY_OPEN_WAIT_MS
  const poll = () => {
    const surface = currentThreadSurface()
    if (!surface?.querySelector(REPLY_BOXES)) {
      if (performance.now() < deadline) requestAnimationFrame(poll)
      return
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const typing = isTypingTarget(document.activeElement) && !surface.contains(document.activeElement)
        if (surface.isConnected && !typing) focusReplyBox(surface)
      }),
    )
  }
  requestAnimationFrame(poll)
}

/** Dispatched on a `data-command` control before the default press, so a control whose press is not
 *  a click (a Radix menu trigger opens on pointerdown/keydown) can claim it with preventDefault. */
export const COMMAND_EVENT = "ntwine:command"

export type ThreadCommand = "done" | "snooze" | "open" | "terminal" | "editor" | "menu" | "spinoff" | "reply"

// Every prompt box that answers the thing on screen. Deliberately NOT the question card's free-text
// answer box (`questionAnswer`) — `r` is a reply to the thread, and a question has its own chips.
const REPLY_BOXES = ["queueComposer", "chatComposer", "adoptComposer", "subAgentComposer", "terminalFollowUp"]
  .map((surface) => `[data-surface="${surface}"]`)
  .join(",")

/** Press `command` on the surface in front of the human; false when there is no such surface or control,
 *  which lets a page fall back to its own reading of the key (AllQueues.tsx: `e` with no card). */
export function runThreadCommand(command: ThreadCommand): boolean {
  const surface = currentThreadSurface()
  if (!surface) return openForCommand(command)
  if (command === "reply") return focusReplyBox(surface)
  // `~=`: one control can carry several commands, space-separated — the ⋯ trigger answers for its menu
  // and for the items inside it, which exist only while it is open.
  const control = surface.querySelector<HTMLElement>(`[data-command~="${command}"]`)
  if (!control) return false
  if (!control.dispatchEvent(new CustomEvent(COMMAND_EVENT, { cancelable: true, detail: command }))) return true
  if (control instanceof HTMLButtonElement && control.disabled) return true
  control.click()
  return true
}

/**
 * Claim a command for a control that must open rather than be clicked — see COMMAND_EVENT. The element
 * still needs its `data-command` attribute; this only replaces what the press does. On a control that
 * carries several commands, name the one this handler answers.
 */
export function useCommandHandler(ref: RefObject<HTMLElement | null>, handler: () => void, command?: ThreadCommand): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const listener = (event: Event) => {
      if (command && (event as CustomEvent<ThreadCommand>).detail !== command) return
      event.preventDefault()
      latest.current()
    }
    el.addEventListener(COMMAND_EVENT, listener)
    return () => el.removeEventListener(COMMAND_EVENT, listener)
  }, [ref, command])
}

// ── the listener ──────────────────────────────────────────────────────────────────────────────────

const BUILT_INS: Partial<Record<ActionId, Handler>> = {
  "queue.next": () => stepCard(1),
  "queue.prev": () => stepCard(-1),
  "thread.reply": () => runThreadCommand("reply"),
  "thread.done": () => runThreadCommand("done"),
  "thread.snooze": () => runThreadCommand("snooze"),
  "thread.open": () => runThreadCommand("open"),
  "thread.terminal": () => runThreadCommand("terminal"),
  "thread.editor": () => runThreadCommand("editor"),
  "thread.menu": () => runThreadCommand("menu"),
  "thread.spinoff": () => runThreadCommand("spinoff"),
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
// overlays by their store flags, and any open modal dialog, menu or listbox by its DOM (a modal Radix
// layer also pins `pointer-events: none` on the body, which is the catch-all). Thread drawers are
// NOT in this list: they are the page you are reading, and `d` in one finishes its thread.
//
// That includes a NARROW drawer. Below 800px ThreadSheet renders a modal Radix dialog (it covers the
// screen, so it takes the scroll lock and the focus trap), which wears `aria-modal` AND pins the body's
// pointer events — both of this test's tells at once. Read literally, every plain key died the moment a
// half-width laptop window opened a thread (found 2026-09-29: `f` fullscreened a drawer at 1200px and
// did nothing at 700px). So a drawer layer is excluded from the selector, and a body lock counts only
// when no drawer is modal: with one open the lock is the drawer's own, and anything genuinely on top
// of it — a confirm, the picture viewer, a menu — still matches the selector by itself.
const OVERLAY_SELECTOR = ':is([role="dialog"], [role="alertdialog"])[aria-modal="true"]:not([data-drawer-layer]), [role="menu"], [role="listbox"]'

function overlayOpen(): boolean {
  if (store.showPalette || store.showNewThread || store.showSettings || store.showShortcuts) return true
  if (typeof document === "undefined") return false
  if (document.querySelector(OVERLAY_SELECTOR) !== null) return true
  return document.body.style.pointerEvents === "none" && document.querySelector('[data-drawer-layer][aria-modal="true"]') === null
}

/**
 * Whether a key nobody has claimed is the PAGE's: not typed into a field, not under an overlay, not
 * already handled. The same gate a plain binding passes, for the fixed keys a page hears on the window
 * itself (AllQueues.tsx: ⌥↑/⌥↓ with no prompt box focused).
 */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
  if (event.target instanceof Element && event.target.closest(".xterm")) return false
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return false
  return !overlayOpen()
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

/** An action's current keys as one string ("⌘K", "Ctrl+K", "D"), or null when it has none. Follows a
 *  rebind live, so a tooltip never teaches a key that no longer does the thing. */
export function useShortcutLabel(id: ActionId): string | null {
  const overrides = useSnapshot(prefs).keybindings
  const chord = effectiveBindings(overrides as typeof prefs.keybindings)[id]
  return chord ? formatChord(chord, platform) : null
}

/** "Mark as done (D)" — the control's own words, then its key. */
export function withShortcut(label: string, keys: string | null): string {
  return keys ? `${label} (${keys})` : label
}
