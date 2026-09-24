// THE KEYBOARD SHORTCUTS — what each one does, what it is bound to out of the box, and the pure
// arithmetic of turning a KeyboardEvent into a binding and back into keycaps. No DOM, no store: the
// runtime that acts on a match lives in keyboardRuntime.ts, the sheet that rebinds them in
// components/KeyboardShortcuts.tsx, and the operator's overrides in prefs.ts.
//
// THE DEFAULTS BORROW FROM THE INBOXES FRIZZ'S QUEUE ALREADY IS. A queue of rested threads is triaged
// exactly the way a keyboard-first inbox is — read the top card, answer it, finish it or put it off,
// go to the next — so the letters are the ones those tools have already taught:
//
//   j / k   next / previous        Gmail, Superhuman, Linear, GitHub lists, vim
//   e       mark as done           Superhuman's Done, Gmail's archive, GitHub notifications' Done
//   h       snooze                 Superhuman's "remind me", Linear inbox's snooze — the same two tools
//                                  that pair it with E, which is exactly frizz's Done + Snooze footer
//   r       reply                  Gmail, Superhuman — here it puts the caret in the card's prompt box
//   c       new thread             Gmail's compose, Linear's create, Jira's create
//   t       new terminal thread    the prompt box's other tab, by its own initial
//   f       fullscreen             every video player on the web
//   ?       this sheet             Gmail, GitHub, Linear, X, YouTube
//   ⌘K      command palette        Linear, Slack, GitHub, Vercel, Raycast (it was already here)
//   ⌘,      settings               every native macOS app, VS Code, Slack
//   ⌘I      thread details         already here; kept so it is listed and rebindable
//
// NOT ⌘N for new thread: it is the browser's new-window chord (App.tsx has the long version), and
// snooze is not S because the two tools this row is copied from both spend H on it.
//
// SINGLE KEYS NEVER FIRE WHILE YOU TYPE. A binding with no ⌘/Ctrl is a "plain" key: it is ignored in
// any text field and while a dialog or menu is up, so `e` in a prompt box is the letter e. A ⌘/Ctrl
// chord fires from anywhere, the way ⌘K always has.

export type ActionId =
  | "queue.next"
  | "queue.prev"
  | "thread.reply"
  | "thread.done"
  | "thread.snooze"
  | "thread.fullscreen"
  | "app.newThread"
  | "app.newTerminal"
  | "app.palette"
  | "app.details"
  | "app.settings"
  | "app.shortcuts"

export type ActionGroup = "queue" | "anywhere"

export interface ActionDef {
  id: ActionId
  label: string
  group: ActionGroup
  /** Serialized chord (see serializeChord) — the out-of-the-box binding. */
  defaultChord: string
  /** Holding the key down repeats it. Only navigation: a held `e` must not finish five threads. */
  repeat?: boolean
}

// ORDER IS THE SHEET'S ORDER: the triage loop top to bottom, then the doors that work from anywhere.
export const ACTIONS: readonly ActionDef[] = [
  { id: "queue.next", label: "Next card", group: "queue", defaultChord: "j", repeat: true },
  { id: "queue.prev", label: "Previous card", group: "queue", defaultChord: "k", repeat: true },
  { id: "thread.reply", label: "Reply", group: "queue", defaultChord: "r" },
  { id: "thread.done", label: "Mark as done", group: "queue", defaultChord: "e" },
  { id: "thread.snooze", label: "Snooze", group: "queue", defaultChord: "h" },
  { id: "thread.fullscreen", label: "Fullscreen", group: "queue", defaultChord: "f" },
  { id: "app.newThread", label: "New thread", group: "anywhere", defaultChord: "c" },
  { id: "app.newTerminal", label: "New terminal thread", group: "anywhere", defaultChord: "t" },
  { id: "app.palette", label: "Jump to a thread", group: "anywhere", defaultChord: "mod+k" },
  { id: "app.details", label: "Thread details", group: "anywhere", defaultChord: "mod+i" },
  { id: "app.settings", label: "Settings", group: "anywhere", defaultChord: "mod+," },
  { id: "app.shortcuts", label: "Keyboard shortcuts", group: "anywhere", defaultChord: "?" },
]

export const GROUP_LABELS: Record<ActionGroup, string> = {
  queue: "The card you're reading",
  anywhere: "Anywhere",
}

// The keys the prompt boxes own. Listed on the sheet so it is the whole keyboard in one place, but not
// rebindable: composerKeyboard.ts is the contract for the first group, every box in the app shares it,
// and the second is Claude Code's own bash-mode convention (NewThreadModal.tsx DispatchForm).
export const FIXED_SHORTCUTS: readonly { heading: string; keys: readonly { label: string; chord: string }[] }[] = [
  {
    heading: "In a prompt box",
    keys: [
      { label: "Send", chord: "enter" },
      { label: "New line", chord: "shift+enter" },
      { label: "Send now, interrupting the worker", chord: "mod+enter" },
      { label: "Leave the box, or close the top drawer", chord: "escape" },
    ],
  },
  {
    heading: "In the new-thread box",
    keys: [
      { label: "Switch to Terminal, typed first", chord: "!" },
      { label: "Back to Prompt, in an empty box", chord: "backspace" },
    ],
  },
]

const ACTION_IDS = new Set<string>(ACTIONS.map((action) => action.id))

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && ACTION_IDS.has(value)
}

export function actionDef(id: ActionId): ActionDef {
  return ACTIONS.find((action) => action.id === id)!
}

// ── chords ────────────────────────────────────────────────────────────────────────────────────────

/**
 * One binding. `mod` is ⌘ on a Mac and Ctrl everywhere else — and, as throughout the app (⌘K / Ctrl-K,
 * ⌘-Enter / Ctrl-Enter), EITHER modifier satisfies it when matching.
 */
export interface Chord {
  key: string
  mod: boolean
  alt: boolean
  shift: boolean
}

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "OS", "Hyper", "Super", "Fn", "FnLock", "NumLock", "ScrollLock", "Dead"])

// Punctuation by PHYSICAL key, for the two cases where `event.key` stops naming the key that was
// pressed: Option on a Mac composes a glyph (⌥E is "´"), and a non-Latin layout types its own letter.
const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_PUNCTUATION[code] ?? null
}

/**
 * The chord a keydown means, or null for a lone modifier (the sheet previews those live instead).
 *
 * THE SHIFT RULE. A letter keeps Shift as a modifier — `E` and `⇧E` are different bindings. A symbol
 * does NOT: `?` is what Shift-/ types on a US board and a different key elsewhere, so the binding is
 * the character the person typed and Shift is part of how they typed it. That is what makes `?` open
 * the sheet on every layout. Named keys (Enter, arrows) keep Shift like letters do.
 */
export function chordFromEvent(event: KeyLike): Chord | null {
  if (!event.key || MODIFIER_KEYS.has(event.key)) return null
  const mod = event.metaKey || event.ctrlKey
  const alt = event.altKey
  if (event.key === " " || event.key === "Spacebar") return { key: "space", mod, alt, shift: event.shiftKey }
  if (event.key.length > 1) return { key: event.key.toLowerCase(), mod, alt, shift: event.shiftKey }
  const typed = event.key
  // Option-composed glyphs and non-Latin letters: bind the physical key, and keep Shift, because the
  // character no longer carries it.
  if (alt || !/^[\x21-\x7e]$/.test(typed)) {
    const physical = event.code ? keyFromCode(event.code) : null
    if (physical) return { key: physical, mod, alt, shift: event.shiftKey }
  }
  if (/^[a-z]$/i.test(typed)) return { key: typed.toLowerCase(), mod, alt, shift: event.shiftKey }
  return { key: typed, mod, alt, shift: false }
}

export function serializeChord(chord: Chord): string {
  return `${chord.mod ? "mod+" : ""}${chord.alt ? "alt+" : ""}${chord.shift ? "shift+" : ""}${chord.key}`
}

export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || !text) return null
  let rest = text
  const chord: Chord = { key: "", mod: false, alt: false, shift: false }
  for (const modifier of ["mod", "alt", "shift"] as const) {
    if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
      chord[modifier] = true
      rest = rest.slice(modifier.length + 1)
    }
  }
  if (!rest || (rest.length > 1 && !/^[a-z0-9]+$/.test(rest))) return null
  chord.key = rest
  return chord
}

/** Plain keys fire only when nothing is being typed; a ⌘/Ctrl chord fires from anywhere. */
export function isPlainChord(chord: Chord): boolean {
  return !chord.mod
}

// ── display ───────────────────────────────────────────────────────────────────────────────────────

export type Platform = "mac" | "other"

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other"
  const hint = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? navigator.userAgent
  return /mac|iphone|ipad|ipod/i.test(hint ?? "") ? "mac" : "other"
}

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter", escape: "Esc", space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", home: "Home", end: "End",
  pageup: "PgUp", pagedown: "PgDn", insert: "Ins",
}

// A Mac keyboard labels these two by glyph (and calls Backspace "delete").
const MAC_NAMED_KEYS: Record<string, string> = { backspace: "⌫", delete: "⌦" }

/**
 * Keycaps, one string per cap, in each platform's own modifier order — Apple's ⌥⇧⌘ (the ⌃ slot is
 * unused: Control is folded into `mod`), and Windows/Linux's Ctrl, Alt, Shift.
 */
export function chordKeycaps(chord: Chord, platform: Platform): string[] {
  const key = (platform === "mac" ? MAC_NAMED_KEYS[chord.key] : undefined) ?? NAMED_KEYS[chord.key] ?? (/^f[0-9]{1,2}$/.test(chord.key) ? chord.key.toUpperCase() : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  if (platform === "mac") {
    return [...(chord.alt ? ["⌥"] : []), ...(chord.shift ? ["⇧"] : []), ...(chord.mod ? ["⌘"] : []), key]
  }
  return [...(chord.mod ? ["Ctrl"] : []), ...(chord.alt ? ["Alt"] : []), ...(chord.shift ? ["Shift"] : []), key]
}

export function formatChord(chord: Chord, platform: Platform): string {
  return chordKeycaps(chord, platform).join(platform === "mac" ? "" : "+")
}

// ── what can be bound ─────────────────────────────────────────────────────────────────────────────

// The chords a page cannot win or must not take: the browser keeps some for itself outright (a tab
// never even delivers ⌘W), and the rest are editing or navigation muscle memory nobody expects a web
// page to steal. Letters are listed bare; the check below adds the `mod+`.
const BROWSER_CHORDS = new Set(["w", "t", "n", "q", "l", "r", "f", "p", "s", "d", "o", "h", "m", "g", "j", "u", "y", "e", "tab", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "=", "-", "`", "[", "]", "arrowleft", "arrowright"])
const EDITING_CHORDS = new Set(["a", "c", "v", "x", "z", "b", "backspace", "delete", "arrowup", "arrowdown", "home", "end"])

/**
 * Why a chord cannot be bound, or null when it can. Worded for the sheet, which shows it under the row
 * the operator is recording on.
 */
export function chordProblem(chord: Chord, platform: Platform): string | null {
  const name = formatChord(chord, platform)
  if (chord.key === "escape") return "Esc closes things — it can't be rebound"
  if (chord.key === "enter") return `${name} belongs to the prompt box`
  if (chord.key === "tab") return "Tab moves between controls"
  if (!chord.mod && !chord.alt && chord.key === "space") return "Space scrolls the page"
  if (chord.mod) {
    if (EDITING_CHORDS.has(chord.key) && !chord.alt) return `${name} is a text-editing shortcut`
    if (BROWSER_CHORDS.has(chord.key) && !chord.alt) return `${name} belongs to the browser`
  }
  return null
}

// ── the effective map ─────────────────────────────────────────────────────────────────────────────

/** The operator's changes from the defaults: a chord string, or null for "no key at all". */
export type Overrides = Partial<Record<ActionId, string | null>>

export type Bindings = Record<ActionId, Chord | null>

export function effectiveBindings(overrides: Overrides): Bindings {
  const out = {} as Bindings
  for (const action of ACTIONS) {
    const override = overrides[action.id]
    out[action.id] = override === undefined ? parseChord(action.defaultChord) : override === null ? null : parseChord(override)
  }
  return out
}

/** chord string → action, for the keydown path. A duplicate cannot be produced through assign(); if
 *  hand-edited storage ever holds one, the earlier action in ACTIONS keeps the key. */
export function bindingLookup(bindings: Bindings): Map<string, ActionId> {
  const map = new Map<string, ActionId>()
  for (const action of ACTIONS) {
    const chord = bindings[action.id]
    if (chord && !map.has(serializeChord(chord))) map.set(serializeChord(chord), action.id)
  }
  return map
}

export function matchAction(event: KeyLike, lookup: Map<string, ActionId>): { action: ActionId; chord: Chord } | null {
  const chord = chordFromEvent(event)
  if (!chord) return null
  const action = lookup.get(serializeChord(chord))
  return action ? { action, chord } : null
}

/**
 * Bind `id` to `chord` (null unbinds it). A chord another action already holds is SWAPPED rather than
 * refused or silently stolen: the other action takes over `id`'s old key, so nothing ends up unbound
 * behind the operator's back and the sheet can show both rows moving. Returns the minimal overrides —
 * an action back on its default carries no entry, so a later change to a default still reaches it.
 */
export function assignChord(overrides: Overrides, id: ActionId, chord: Chord | null): { overrides: Overrides; swappedWith: ActionId | null } {
  const current = effectiveBindings(overrides)
  const next: Bindings = { ...current, [id]: chord }
  let swappedWith: ActionId | null = null
  if (chord) {
    const wanted = serializeChord(chord)
    for (const action of ACTIONS) {
      const held = current[action.id]
      if (action.id !== id && held && serializeChord(held) === wanted) {
        next[action.id] = current[id]
        swappedWith = action.id
      }
    }
  }
  return { overrides: minimalOverrides(next), swappedWith }
}

export function minimalOverrides(bindings: Bindings): Overrides {
  const out: Overrides = {}
  for (const action of ACTIONS) {
    const chord = bindings[action.id]
    const text = chord ? serializeChord(chord) : null
    if (text !== action.defaultChord) out[action.id] = text
  }
  return out
}

export function isDefault(overrides: Overrides, id: ActionId): boolean {
  return overrides[id] === undefined
}

/**
 * Stored overrides, validated. Unknown actions (a shortcut that was removed), malformed chords and
 * chords that can no longer be bound are dropped — each falls back to its default rather than
 * poisoning the whole map.
 */
export function sanitizeOverrides(raw: unknown): Overrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Overrides = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isActionId(id)) continue
    if (value === null) {
      out[id] = null
      continue
    }
    const chord = typeof value === "string" ? parseChord(value) : null
    if (chord && !chordProblem(chord, "other") && !chordProblem(chord, "mac")) out[id] = serializeChord(chord)
  }
  // Two actions landing on one chord would make one of them dead; re-run the minimisation through
  // the effective map so a hand-edited duplicate settles to the first claimant.
  const bindings = effectiveBindings(out)
  const seen = new Set<string>()
  for (const action of ACTIONS) {
    const chord = bindings[action.id]
    if (!chord) continue
    const text = serializeChord(chord)
    if (seen.has(text)) bindings[action.id] = null
    seen.add(text)
  }
  return minimalOverrides(bindings)
}
