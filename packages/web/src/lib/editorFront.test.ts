import assert from "node:assert/strict"
import { test } from "node:test"
import type { EditorFront } from "@ntwine/shared"
import { editorLineReading, editorLineWanted, editorName } from "./editorFront.ts"

const front: EditorFront = { app: "Visual Studio Code", kind: "vscode", path: "/work/alpha/src/lib/a.ts", cursorLine: 20, selection: { startLine: 12, endLine: 20 } }

test("the line names the editor and what it has selected, as the chip a click makes", () => {
  const reading = editorLineReading(front, "/work/alpha")
  assert.equal(reading.editor, "VS Code")
  assert.equal(reading.label, "a.ts:12-20")
  assert.equal(reading.title, "src/lib/a.ts, lines 12-20, is selected in VS Code. Agents can read it with their editor tool. Click to add it here.")
  assert.equal(reading.addable, true)
  assert.equal(reading.selection, true)
  assert.equal(editorLineReading({ ...front, selection: { startLine: 7, endLine: 7 } }, "/work/alpha").title.startsWith("src/lib/a.ts, line 7, is selected"), true)
})

test("with only a caret it is the file; a withheld selection says its text stays; an untitled buffer cannot be added", () => {
  const file = editorLineReading({ ...front, selection: undefined }, "/work/alpha")
  assert.equal(file.label, "a.ts")
  assert.equal(file.title, "src/lib/a.ts is open in VS Code. Agents can read it with their editor tool. Click to add the file here.")
  assert.equal(file.selection, false)
  assert.match(editorLineReading({ ...front, withheld: true }, "/work/alpha").title, /Its text stays in the editor: the file may hold secrets\./)
  const untitled = editorLineReading({ ...front, path: "Untitled-1", untitled: true }, "/work/alpha")
  assert.equal(untitled.addable, false)
  assert.equal(untitled.label, "Untitled-1:12-20")
  assert.match(untitled.title, /^Untitled-1, lines 12-20, is selected in VS Code\. It isn't saved, so it can't be added here/)
  // A file outside the project is named by its whole path.
  assert.match(editorLineReading({ ...front, path: "/elsewhere/b.ts" }, "/work/alpha").title, /^\/elsewhere\/b\.ts, lines/)
})

test("each editor by the name its users call it; an unknown one by its own app name", () => {
  assert.equal(editorName({ kind: "cursor", app: "Cursor" }), "Cursor")
  assert.equal(editorName({ kind: "windsurf", app: "Windsurf" }), "Windsurf")
  assert.equal(editorName({ kind: "other", app: "VSCodium" }), "VSCodium")
})

test("the line is asked for only in a browser tab, off a phone, with some editor window connected", () => {
  const windows = [{ app: "Visual Studio Code", kind: "vscode" as const, acceptsOpens: true }]
  assert.equal(editorLineWanted({ embedded: false, phone: false, windows }), true)
  assert.equal(editorLineWanted({ embedded: true, phone: false, windows }), false, "the sidebar has its bar")
  assert.equal(editorLineWanted({ embedded: false, phone: true, windows }), false, "no editor beside a phone")
  assert.equal(editorLineWanted({ embedded: false, phone: false, windows: [] }), false, "no window: never asks")
})
