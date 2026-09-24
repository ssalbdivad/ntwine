import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTIONS,
  assignChord,
  bindingLookup,
  chordFromEvent,
  chordKeycaps,
  chordProblem,
  effectiveBindings,
  formatChord,
  matchAction,
  parseChord,
  sanitizeOverrides,
  serializeChord,
  type KeyLike,
} from "./keybindings.ts"

function key(init: Partial<KeyLike> & { key: string }): KeyLike {
  return { code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }
}

const defaults = bindingLookup(effectiveBindings({}))

test("the default triage keys match the inbox conventions they borrow", () => {
  const cases: [KeyLike, string][] = [
    [key({ key: "j", code: "KeyJ" }), "queue.next"],
    [key({ key: "k", code: "KeyK" }), "queue.prev"],
    [key({ key: "e", code: "KeyE" }), "thread.done"],
    [key({ key: "h", code: "KeyH" }), "thread.snooze"],
    [key({ key: "r", code: "KeyR" }), "thread.reply"],
    [key({ key: "c", code: "KeyC" }), "app.newThread"],
    [key({ key: "t", code: "KeyT" }), "app.newTerminal"],
    [key({ key: "f", code: "KeyF" }), "thread.fullscreen"],
    [key({ key: "?", code: "Slash", shiftKey: true }), "app.shortcuts"],
    [key({ key: "k", code: "KeyK", metaKey: true }), "app.palette"],
    [key({ key: "k", code: "KeyK", ctrlKey: true }), "app.palette"],
    [key({ key: ",", code: "Comma", metaKey: true }), "app.settings"],
    [key({ key: "i", code: "KeyI", ctrlKey: true }), "app.details"],
  ]
  for (const [event, action] of cases) assert.equal(matchAction(event, defaults)?.action, action, JSON.stringify(event))
})

test("Shift distinguishes letters but is part of how a symbol is typed", () => {
  // ⇧E is its own binding, so a plain `e` binding must not fire on it (and vice versa).
  assert.equal(matchAction(key({ key: "E", code: "KeyE", shiftKey: true }), defaults), null)
  assert.deepEqual(chordFromEvent(key({ key: "E", code: "KeyE", shiftKey: true })), { key: "e", mod: false, alt: false, shift: true })
  // Caps Lock types "E" with no Shift held: still the plain letter.
  assert.equal(matchAction(key({ key: "E", code: "KeyE" }), defaults)?.action, "thread.done")
  // `?` is whatever key types it on this layout; the binding is the character.
  assert.deepEqual(chordFromEvent(key({ key: "?", code: "Minus", shiftKey: true })), { key: "?", mod: false, alt: false, shift: false })
})

test("a lone modifier is not a chord, and a modified key is not its bare letter", () => {
  assert.equal(chordFromEvent(key({ key: "Meta", metaKey: true })), null)
  assert.equal(chordFromEvent(key({ key: "Shift", shiftKey: true })), null)
  assert.equal(matchAction(key({ key: "e", code: "KeyE", metaKey: true }), defaults), null)
  assert.equal(matchAction(key({ key: "j", code: "KeyJ", altKey: true }), defaults), null)
})

test("Option-composed glyphs and non-Latin layouts bind the physical key", () => {
  // ⌥E on a Mac types a dead-key accent; ⌥J types ∆.
  assert.deepEqual(chordFromEvent(key({ key: "∆", code: "KeyJ", altKey: true })), { key: "j", mod: false, alt: true, shift: false })
  // A Cyrillic layout's KeyE types "у"; the default `e` still finishes the card.
  assert.equal(matchAction(key({ key: "у", code: "KeyE" }), defaults)?.action, "thread.done")
})

test("chords round-trip through their stored form", () => {
  for (const text of ["j", "?", "mod+k", "mod+,", "shift+e", "mod+alt+shift+x", "arrowdown", "f2", "mod++", "space"]) {
    const chord = parseChord(text)
    assert.ok(chord, text)
    assert.equal(serializeChord(chord), text)
  }
  assert.equal(parseChord(""), null)
  assert.equal(parseChord("mod+"), null)
  assert.equal(parseChord("mod+Arrow-Down"), null)
  for (const action of ACTIONS) assert.equal(serializeChord(parseChord(action.defaultChord)!), action.defaultChord)
})

test("keycaps follow each platform's modifier order and spelling", () => {
  assert.deepEqual(chordKeycaps(parseChord("mod+k")!, "mac"), ["⌘", "K"])
  assert.deepEqual(chordKeycaps(parseChord("mod+k")!, "other"), ["Ctrl", "K"])
  assert.deepEqual(chordKeycaps(parseChord("mod+alt+shift+x")!, "mac"), ["⌥", "⇧", "⌘", "X"])
  assert.deepEqual(chordKeycaps(parseChord("mod+alt+shift+x")!, "other"), ["Ctrl", "Alt", "Shift", "X"])
  assert.equal(formatChord(parseChord("mod+,")!, "other"), "Ctrl+,")
  assert.equal(formatChord(parseChord("shift+enter")!, "mac"), "⇧Enter")
  assert.deepEqual(chordKeycaps(parseChord("arrowdown")!, "mac"), ["↓"])
  assert.deepEqual(chordKeycaps(parseChord("f2")!, "other"), ["F2"])
})

test("the browser's, the editor's and the prompt box's chords cannot be taken", () => {
  for (const text of ["mod+w", "mod+t", "mod+n", "mod+q", "mod+shift+t", "mod+1", "mod+l", "mod+r", "mod+f"]) {
    assert.match(chordProblem(parseChord(text)!, "mac") ?? "", /browser/, text)
  }
  for (const text of ["mod+c", "mod+v", "mod+a", "mod+z", "mod+shift+z"]) {
    assert.match(chordProblem(parseChord(text)!, "other") ?? "", /text-editing/, text)
  }
  assert.match(chordProblem(parseChord("enter")!, "mac") ?? "", /prompt box/)
  assert.match(chordProblem(parseChord("mod+enter")!, "mac") ?? "", /prompt box/)
  assert.ok(chordProblem(parseChord("escape")!, "mac"))
  assert.ok(chordProblem(parseChord("tab")!, "mac"))
  assert.ok(chordProblem(parseChord("space")!, "mac"))
  // Every default must itself be bindable, or the sheet could never put it back.
  for (const action of ACTIONS) assert.equal(chordProblem(parseChord(action.defaultChord)!, "mac"), null, action.id)
  for (const text of ["x", "shift+d", "mod+k", "mod+/", "mod+alt+w", "arrowdown", "1"]) assert.equal(chordProblem(parseChord(text)!, "mac"), null, text)
})

test("binding a key another action holds swaps the two rather than stranding one", () => {
  const { overrides, swappedWith } = assignChord({}, "thread.done", parseChord("j"))
  assert.equal(swappedWith, "queue.next")
  assert.deepEqual(overrides, { "thread.done": "j", "queue.next": "e" })
  const lookup = bindingLookup(effectiveBindings(overrides))
  assert.equal(lookup.get("j"), "thread.done")
  assert.equal(lookup.get("e"), "queue.next")
  // Swapping back lands both on their defaults, which leaves no overrides at all.
  assert.deepEqual(assignChord(overrides, "thread.done", parseChord("e")).overrides, {})
})

test("a free key simply moves, and unbinding records an explicit null", () => {
  const moved = assignChord({}, "thread.snooze", parseChord("s"))
  assert.equal(moved.swappedWith, null)
  assert.deepEqual(moved.overrides, { "thread.snooze": "s" })
  const cleared = assignChord(moved.overrides, "thread.snooze", null)
  assert.deepEqual(cleared.overrides, { "thread.snooze": null })
  assert.equal(effectiveBindings(cleared.overrides)["thread.snooze"], null)
  // Taking an unbound action's old key from someone gives them its (empty) slot: nothing is invented.
  const took = assignChord(cleared.overrides, "thread.snooze", parseChord("e"))
  assert.equal(took.swappedWith, "thread.done")
  assert.equal(effectiveBindings(took.overrides)["thread.done"], null)
})

test("stored overrides are validated one entry at a time", () => {
  assert.deepEqual(sanitizeOverrides(null), {})
  assert.deepEqual(sanitizeOverrides("mod+k"), {})
  assert.deepEqual(sanitizeOverrides([]), {})
  assert.deepEqual(
    sanitizeOverrides({ "thread.snooze": "s", "thread.gone": "x", "thread.done": "mod+w", "queue.next": 7, "thread.reply": null }),
    { "thread.snooze": "s", "thread.reply": null },
  )
  // A hand-edited duplicate settles to the first claimant instead of leaving one dead.
  const duped = sanitizeOverrides({ "thread.fullscreen": "j" })
  assert.equal(bindingLookup(effectiveBindings(duped)).get("j"), "queue.next")
  assert.equal(effectiveBindings(duped)["thread.fullscreen"], null)
  // An override equal to the default is not an override.
  assert.deepEqual(sanitizeOverrides({ "queue.next": "j" }), {})
})

test("no two defaults share a chord", () => {
  const seen = new Set<string>()
  for (const action of ACTIONS) {
    assert.ok(!seen.has(action.defaultChord), action.defaultChord)
    seen.add(action.defaultChord)
  }
})
