import assert from "node:assert/strict"
import test from "node:test"
import { chordCommand } from "../../../vscode/src/embed.ts"
import { readFileSync } from "node:fs"
import { EDITOR_ADD_CHORD } from "./editorContext.ts"
import { EDITOR_CHORDS, HOST_CHORDS, SIDEBAR_KEY_HINTS, SIDEBAR_KEY_NAMES, hostChordEvent, hostChordKeycaps, hostChordProblem } from "./embedKeys.ts"
import { ACTIONS, chordProblem, formatChord, type Chord, type Platform } from "./keybindings.ts"

// The sidebar's half of the keyboard (lib/embedKeys.ts). The shortcuts sheet tells the human which chords
// go to VS Code from the sidebar; the EXTENSION decides which do (packages/vscode/src/embed.ts CHORDS). So
// every chord the sheet lists is run through the extension's own matcher, on both platforms — a chord
// dropped from its allowlist, or rebound there, fails here instead of being promised in the sheet.

test("every VS Code chord the sheet lists is one the extension runs, on a Mac and elsewhere", () => {
  for (const chord of HOST_CHORDS) {
    for (const platform of ["mac", "other"] as const) {
      assert.ok(chordCommand({ ...hostChordEvent(chord, platform), alt: false }, platform === "mac"), `${chord.label} on ${platform}`)
    }
  }
  // …and the matcher is the real thing: a chord it does not list maps to nothing (negative control).
  assert.equal(chordCommand({ code: "KeyW", ctrl: true, meta: false, shift: false, alt: false }, false), undefined)
})

test("caps in each platform's order", () => {
  const palette = HOST_CHORDS.find((chord) => chord.label === "Command palette")!
  assert.deepEqual(hostChordKeycaps(palette, "mac"), ["⇧", "⌘", "P"])
  assert.deepEqual(hostChordKeycaps(palette, "other"), ["Ctrl", "Shift", "P"])
  // Ctrl on a Mac too, as VS Code binds it.
  const terminal = HOST_CHORDS.find((chord) => chord.label === "Toggle the terminal")!
  assert.deepEqual(hostChordKeycaps(terminal, "mac"), ["⌃", "`"])
  const scm = HOST_CHORDS.find((chord) => chord.label === "Source control")!
  assert.deepEqual(hostChordKeycaps(scm, "mac"), ["⌃", "⇧", "G"])
  assert.deepEqual(hostChordKeycaps(scm, "other"), ["Ctrl", "Shift", "G"])
})

// Sentence case, with the proper nouns a hint may name.
const sentenceCase = (text: string) => /^[A-Z][^A-Z]*$/u.test(text.replace(/\b(VS Code|Ntwine)\b/gu, "x"))

test("the sheet's sidebar hints and names are for real shortcuts, short, in sentence case", () => {
  const ids = new Set(ACTIONS.map((action) => action.id))
  for (const [id, hint] of Object.entries(SIDEBAR_KEY_HINTS)) {
    assert.ok(ids.has(id as never), id)
    // A line under the key's name, which may wrap once at 300px — no more.
    assert.ok(hint.split(" ").length <= 10, `${id}: "${hint}" is not a few words`)
    assert.ok(sentenceCase(hint), `${id}: "${hint}" is not sentence case`)
  }
  for (const [id, name] of Object.entries(SIDEBAR_KEY_NAMES)) {
    assert.ok(ids.has(id as never), id)
    assert.ok(sentenceCase(name), `${id}: "${name}" is not sentence case`)
  }
  assert.equal(sentenceCase("Shows its folder in VS Code"), true)
  assert.equal(sentenceCase("Shows Its Folder"), false, "negative control")
})

/** A keydown as the sheet's recorder sees it, for a host chord on a platform. */
const pressed = (label: string, platform: Platform) => {
  const event = hostChordEvent(HOST_CHORDS.find((chord) => chord.label === label)!, platform)
  return { code: event.code, ctrlKey: event.ctrl, metaKey: event.meta, shiftKey: event.shift, altKey: event.alt }
}

test("in the sidebar, rebinding to a VS Code chord is refused as VS Code's, in each platform's spelling", () => {
  assert.equal(hostChordProblem(pressed("Command palette", "other"), "other"), "Ctrl+Shift+P goes to VS Code")
  assert.equal(hostChordProblem(pressed("Command palette", "mac"), "mac"), "⇧⌘P goes to VS Code")
  assert.equal(hostChordProblem(pressed("Toggle the terminal", "other"), "other"), "Ctrl+` goes to VS Code")
  assert.equal(hostChordProblem(pressed("Toggle the terminal", "mac"), "mac"), "⌃` goes to VS Code")
  // Every chord the sheet lists is refused so.
  for (const chord of HOST_CHORDS) for (const platform of ["mac", "other"] as const) assert.ok(hostChordProblem(pressed(chord.label, platform), platform), `${chord.label} on ${platform}`)
  // Not VS Code's: a chord the extension does not run, or ⌘ where VS Code binds Ctrl on a Mac.
  assert.equal(hostChordProblem({ code: "KeyW", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, "other"), null)
  assert.equal(hostChordProblem({ code: "Backquote", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, "mac"), null)
  // The browser's reason stays the desktop's.
  assert.equal(chordProblem({ key: "p", mod: true, alt: false, shift: true }, "other"), "Ctrl+Shift+P belongs to the browser")
})

// The Editor group teaches chords the EXTENSION binds in the editor (packages/vscode/package.json
// contributes.keybindings). Each one the sheet lists must be a keybinding there, on both platforms, for
// the command and `when` the sheet says — or the sidebar would promise a key the editor does not have.
const keybindings = (JSON.parse(readFileSync(new URL("../../../vscode/package.json", import.meta.url), "utf8")) as {
  contributes: { keybindings: { command: string; key: string; mac?: string; when?: string }[] }
}).contributes.keybindings

/** A chord as VS Code's manifest spells it: `ctrl+l` / `cmd+l`, `alt+k`. */
const vscodeSpelling = (chord: Chord, platform: Platform) =>
  [...(chord.mod ? [platform === "mac" ? "cmd" : "ctrl"] : []), ...(chord.alt ? ["alt"] : []), ...(chord.shift ? ["shift"] : []), chord.key].join("+")

test("every editor chord the sheet lists is the extension's keybinding, on a Mac and elsewhere", () => {
  for (const { label, chord, command, when } of EDITOR_CHORDS) {
    const bound = keybindings.find((binding) => binding.command === command && binding.key === vscodeSpelling(chord, "other"))
    assert.ok(bound, `${label}: no ${vscodeSpelling(chord, "other")} for ${command}`)
    assert.equal(bound.mac ?? bound.key, vscodeSpelling(chord, "mac"), `${label} on a Mac`)
    assert.equal(bound.when, when, label)
    assert.ok(sentenceCase(label), label)
  }
  // The chord the context bar names is the sheet's first.
  assert.deepEqual(EDITOR_CHORDS[0]!.chord, EDITOR_ADD_CHORD)
  assert.deepEqual([formatChord(EDITOR_ADD_CHORD, "mac"), formatChord(EDITOR_ADD_CHORD, "other")], ["⌘L", "Ctrl+L"])
  // Negative control: a chord the extension does not bind is not found.
  assert.equal(keybindings.find((binding) => binding.key === vscodeSpelling({ key: "w", mod: true, alt: false, shift: false }, "other")), undefined)
})
