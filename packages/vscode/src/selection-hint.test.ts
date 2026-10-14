import { test } from "node:test"
import assert from "node:assert/strict"
import { hintLine, hintText, ownHintApp, selectionKey, wholeDocument } from "./selection-hint.ts"

const at = (line: number, character: number) => ({ line, character })
/** A selection made from `anchor` to `active`, as VS Code orders its start and end. */
function sel(anchor: { line: number; character: number }, active: { line: number; character: number }) {
  const before = anchor.line < active.line || (anchor.line === active.line && anchor.character <= active.character)
  const [start, end] = before ? [anchor, active] : [active, anchor]
  return { start, end, active, isEmpty: start.line === end.line && start.character === end.character }
}

test("the hint names the chord in effect: Ctrl+L, or ⌘L where the UI is a Mac", () => {
  assert.equal(hintText(false), "Ctrl+L to add to ntwine")
  assert.equal(hintText(true), "⌘L to add to ntwine")
})

test("the hint goes on the selection's line nearest the caret, by the chip's own line count", () => {
  // Made downward: the last line.
  assert.equal(hintLine(sel(at(2, 4), at(5, 9))), 5)
  // Made upward: the caret is at the start, so the first line.
  assert.equal(hintLine(sel(at(5, 9), at(2, 4))), 2)
  // A whole-line drag (or Shift+Down) ends at column 1 of the next line, which the chip does not include:
  // the hint sits on the last line the chip reads, not on the line the caret happens to be at the start of.
  assert.equal(hintLine(sel(at(2, 0), at(6, 0))), 5)
  // Within one line, that line, either way.
  assert.equal(hintLine(sel(at(3, 2), at(3, 8))), 3)
  assert.equal(hintLine(sel(at(3, 8), at(3, 2))), 3)
})

test("a select-all spans the whole document; anything short of it does not", () => {
  // A 10-line document whose last line is 4 characters long.
  assert.equal(wholeDocument(sel(at(0, 0), at(9, 4)), 10, 4), true)
  assert.equal(wholeDocument(sel(at(9, 4), at(0, 0)), 10, 4), true, "made backward too")
  assert.equal(wholeDocument(sel(at(0, 0), at(9, 3)), 10, 4), false, "one character short")
  assert.equal(wholeDocument(sel(at(0, 1), at(9, 4)), 10, 4), false)
  assert.equal(wholeDocument(sel(at(0, 0), at(8, 0)), 10, 4), false)
  // A file ending in a newline: the last line is empty, and a select-all ends at its column 0.
  assert.equal(wholeDocument(sel(at(0, 0), at(9, 0)), 10, 0), true)
  // A one-line file.
  assert.equal(wholeDocument(sel(at(0, 0), at(0, 12)), 1, 12), true)
})

test("Cursor and Windsurf draw their own selection hint, so ntwine draws none there", () => {
  assert.equal(ownHintApp("Cursor"), true)
  assert.equal(ownHintApp("Windsurf"), true)
  assert.equal(ownHintApp("Visual Studio Code"), false)
  assert.equal(ownHintApp("Visual Studio Code - Insiders"), false)
  assert.equal(ownHintApp("VSCodium"), false)
})

test("a selection's key changes with its file and either end, and not with its direction", () => {
  const down = selectionKey("/a.ts", sel(at(1, 0), at(3, 2)))
  assert.equal(down, selectionKey("/a.ts", sel(at(3, 2), at(1, 0))))
  assert.notEqual(down, selectionKey("/b.ts", sel(at(1, 0), at(3, 2))))
  assert.notEqual(down, selectionKey("/a.ts", sel(at(1, 0), at(3, 3))))
})
