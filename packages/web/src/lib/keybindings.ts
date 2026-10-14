// THE KEYBOARD SHORTCUTS — what each one does, what it is bound to out of the box, and the pure
// arithmetic of turning a KeyboardEvent into a binding and back into keycaps. No DOM, no store: the
// runtime that acts on a match lives in keyboardRuntime.ts, the sheet that rebinds them in
// components/KeyboardShortcuts.tsx, and the operator's overrides in prefs.ts.
//
// A LETTER IS ITS ACTION'S INITIAL: `r` reply, `d` mark as done, `s` snooze, `o` open in a drawer,
// `t` a terminal on the thread, `n` new project. One rule is worth more than any single well-chosen key, because it predicts the
// keys nobody has looked up yet, including ones added later (David 2026-09-28: "establish the
// convention in general that each action is associated with its first letter"). Until then Done and
// Snooze were `e` and `h`, borrowed from keyboard-first inboxes: `e` is Gmail's archive and
// Superhuman's and GitHub notifications' Done, `h` is Superhuman's and Linear's snooze. Those help only
// the few who arrive with those tools in their fingers (Gmail ships its shortcuts switched off, and
// its own snooze is `b`), and neither letter says what it does.
//
// Four keys break the rule, each for a reason the rule cannot beat:
//
//   j / k   next / previous        MOVEMENT is placed by position, not by name, like arrows, WASD and
//                                  vi's hjkl: it is pressed fast and by feel, so the pair sits side by
//                                  side under one hand, where the initials n and p are a row apart. It
//                                  is also the most shared single-key pair on the web (Gmail, Linear,
//                                  Superhuman, vim), and ↑/↓ are taken: they scroll the card.
//   c       new thread             Gmail's compose, and create in GitHub, Linear and Jira: kept over
//                                  `n` by the maintainer's call
//   ?       this sheet             a symbol, not a letter: Gmail, GitHub, Linear, X, YouTube
//   →       spinoff                a direction, not a letter: the thread branches off to the side
//
// ⌘/Ctrl CHORDS CANNOT FOLLOW IT. The browser owns ⌘ plus most initials (⌘D bookmarks, ⌘S saves, ⌘J
// opens downloads: BROWSER_CHORDS below), so a chord keeps its platform's convention instead:
//
//   ⌘K      jump to a thread       Linear, Slack, GitHub, Vercel, Raycast (it was already here)
//   ⌘,      settings               every native macOS app, VS Code, Slack
//   ⌘I      thread details         Finder's Get Info; in an editor's sidebar only (sidebarOnly)
//
// NOT ⌘N for new thread: it is the browser's new-window chord (App.tsx has the long version).
//
// A NEW ACTION TAKES ITS INITIAL. When two want one letter, the rarer of the two, or the one that undoes
// the other (the way Superhuman's ⇧E marks not done), takes Shift and that letter, so the letter still
// guesses right. keybindings.test.ts fails any single-letter default that is not an initial of its
// label unless it is listed there as one of the exceptions above.
//
// SINGLE KEYS NEVER FIRE WHILE YOU TYPE. A binding with no ⌘/Ctrl is a "plain" key: it is ignored in
// any text field and while a dialog or menu is up, so `d` in a prompt box is the letter d. A ⌘/Ctrl
// chord fires from anywhere, the way ⌘K always has.

export type ActionId =
  | "queue.next"
  | "queue.prev"
  | "thread.reply"
  | "thread.done"
  | "thread.snooze"
  | "thread.open"
  | "thread.terminal"
  | "thread.editor"
  | "thread.menu"
  | "thread.spinoff"
  | "app.newThread"
  | "app.newProject"
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
  /** Holding the key down repeats it. Only navigation: a held `d` must not finish five threads. */
  repeat?: boolean
  /** Bound only in an editor's sidebar (lib/embed.ts): the browser's sheet leaves it out and the key goes
   *  on to the browser. */
  sidebarOnly?: boolean
}

// ORDER IS THE SHEET'S ORDER: the triage loop top to bottom, then the doors that work from anywhere.
export const ACTIONS: readonly ActionDef[] = [
  { id: "queue.next", label: "Next card", group: "queue", defaultChord: "j", repeat: true },
  { id: "queue.prev", label: "Previous card", group: "queue", defaultChord: "k", repeat: true },
  { id: "thread.reply", label: "Reply", group: "queue", defaultChord: "r" },
  { id: "thread.done", label: "Mark as done", group: "queue", defaultChord: "d" },
  { id: "thread.snooze", label: "Snooze", group: "queue", defaultChord: "s" },
  { id: "thread.open", label: "Open in a drawer", group: "queue", defaultChord: "o" },
  // A terminal belongs to a thread (ThreadTerminals.tsx), so `t` opens one on the thread being read. It
  // was "New terminal thread", from anywhere, until the Terminal tab went on 2026-09-29.
  { id: "thread.terminal", label: "Open terminal", group: "queue", defaultChord: "t" },
  // The same folder in the Local file links app — the step `t` then `code .` took (ThreadMenu.tsx openInEditor).
  // With no thread in front of the human, the project's own folder (AllQueues.tsx).
  { id: "thread.editor", label: "Open in editor", group: "queue", defaultChord: "e" },
  // The ⋯ menu itself, so its rarer verbs (Restart worker, Thread info, …) are ↓ and Enter away
  // without each needing a letter of its own.
  { id: "thread.menu", label: "More actions", group: "queue", defaultChord: "m" },
  // → sends the thread off to the side, the way its dialog's footer reads "from → into". Not `s`, which
  // is Snooze, and not ⇧S, which the rule below would have given it (David 2026-09-30: "i dont like
  // shift"). Free on a card: ↑/↓ scroll it, and the browser claims → only with a modifier held.
  { id: "thread.spinoff", label: "Spinoff", group: "queue", defaultChord: "arrowright" },
  { id: "app.newThread", label: "New thread", group: "anywhere", defaultChord: "c" },
  { id: "app.newProject", label: "New project", group: "anywhere", defaultChord: "n" },
  { id: "app.palette", label: "Jump to a thread", group: "anywhere", defaultChord: "mod+k" },
  // Sidebar only since 2026-10-14: there ⌘I adds the editor's selection first (App.tsx); in a browser
  // Thread details is too rare for a chord and stays in the ⋯ menu (maintainer).
  { id: "app.details", label: "Thread details", group: "anywhere", defaultChord: "mod+i", sidebarOnly: true },
  { id: "app.settings", label: "Settings", group: "anywhere", defaultChord: "mod+," },
  { id: "app.shortcuts", label: "Keyboard shortcuts", group: "anywhere", defaultChord: "?" },
]

export const GROUP_LABELS: Record<ActionGroup, string> = {
  queue: "The card you're reading",
  anywhere: "Anywhere",
}

/**
 * The project the thread about to start goes to, stepped from inside the page's new-thread box, whose
 * project is a choice (AllQueues.tsx): Option/Alt with ↓ for the next one in its picker, ↑ for the one
 * before. Slack's and Discord's key for switching the conversation you are typing into, and bound by no
 * browser on any platform — Alt-←/→ are Back and Forward, Ctrl-Tab and ⌘⇧[/] switch tabs, and ⇧Tab
 * (the first choice, 2026-09-28) steps focus back through the page (maintainer: "conflicts with the
 * common shortcut for cycling tabs on browser"). What it displaces is macOS's own ⌥↑/⌥↓ inside that one
 * box, which moves the caret a paragraph. Not rebindable: a binding with no ⌘/Ctrl never fires in a
 * text box (see above).
 *
 * Outside any text field the same keys step the PAGE's project (AllQueues.tsx): focused on one project,
 * that is switching to the next; showing All projects, re-aiming the box without focusing it.
 */
export const PROJECT_STEP_CHORDS = { next: "alt+arrowdown", previous: "alt+arrowup" } as const

/**
 * The effort of the box's model, stepped from inside a prompt box that carries the model picker — the
 * new-thread box, a queue card's reply box, a drawer's (Composer `onEffortStep`): the project chord with
 * Shift, ↑ for the next effort up the model's ladder, ↓ for the one below, stopping at either end rather
 * than wrapping (a wrap would turn "one more" into the cheapest). Bound by no browser; what it displaces
 * is macOS's own ⌥⇧↑/↓ inside that box, which extends the selection a paragraph. Not rebindable, for the
 * reason the project chord is not.
 */
export const EFFORT_STEP_CHORDS = { up: "alt+shift+arrowup", down: "alt+shift+arrowdown" } as const

/** ⌥⇧↑ is a step up the effort ladder, ⌥⇧↓ one down (EFFORT_STEP_CHORDS); 0 for any other key. */
export function effortStepOf(event: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing">): 1 | -1 | 0 {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing) return 0
  return event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0
}

// The keys the prompt boxes own. Listed on the sheet so it is the whole keyboard in one place, but not
// rebindable: composerKeyboard.ts is the contract for the first group, every box in the app shares it;
// the thread box's `$` line is lib/threadTerminals.ts composerTerminalLine; the last group is the page's
// own new-thread box (AllQueues.tsx).
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
    heading: "In a thread's prompt box",
    keys: [
      { label: "Run a command in a terminal on the thread, typed first", chord: "$" },
      { label: "Send the queued message now, from an empty box", chord: "mod+enter" },
    ],
  },
  {
    heading: "Projects — anywhere, in the new-thread box, or the Spinoff dialog",
    keys: [
      { label: "Next project", chord: PROJECT_STEP_CHORDS.next },
      { label: "Previous project", chord: PROJECT_STEP_CHORDS.previous },
    ],
  },
  {
    heading: "Effort — in a prompt box with a model picker",
    keys: [
      { label: "More effort", chord: EFFORT_STEP_CHORDS.up },
      { label: "Less effort", chord: EFFORT_STEP_CHORDS.down },
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
