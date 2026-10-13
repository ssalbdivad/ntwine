import { test } from "node:test"
import assert from "node:assert/strict"
import { EDITOR_MAX_PATH } from "@ntwine/shared/editor-protocol"
import { EMBED_MAX_NOTE, EMBED_MAX_OPEN_FILES, EMBED_MAX_SELECTION_TEXT } from "@ntwine/shared/embed-protocol"
import { editorContextMessage, editorSelection, fileLabel, fixNote, fixTitle, lineSpan, openFiles, Recency, terminalText } from "./editor-context.ts"
import { QUOTE_MAX_LINES } from "./message.ts"

const at = (line: number, character: number) => ({ line, character })

test("a range's lines are 1-based and inclusive, and one that ends at column 1 ends on the line before", () => {
  assert.deepEqual(lineSpan(at(1, 0), at(3, 9)), { startLine: 2, endLine: 4 })
  // A whole-line drag over lines 2-3 leaves the caret at the start of line 4: line 4 is not in it.
  assert.deepEqual(lineSpan(at(1, 0), at(3, 0)), { startLine: 2, endLine: 3 })
  // Within one line, column 1 is just where it starts (an empty range, a zero-width problem).
  assert.deepEqual(lineSpan(at(4, 0), at(4, 0)), { startLine: 5, endLine: 5 })
  assert.deepEqual(lineSpan(at(4, 3), at(4, 7)), { startLine: 5, endLine: 5 })
})

test("the bar's selection is the primary selection's lines and every selection's characters, and nothing for a caret", () => {
  assert.equal(editorSelection([]), undefined)
  assert.equal(editorSelection([{ start: at(2, 4), end: at(2, 4), chars: 0 }]), undefined, "a caret is not a selection")
  assert.deepEqual(editorSelection([{ start: at(1, 0), end: at(3, 0), chars: 41 }]), { startLine: 2, endLine: 3, chars: 41 })
  // Multi-cursor: the lines are the primary's (index 0, where VS Code keeps it), the count is everyone's.
  assert.deepEqual(editorSelection([{ start: at(5, 2), end: at(5, 9), chars: 7 }, { start: at(0, 0), end: at(0, 3), chars: 3 }, { start: at(8, 1), end: at(8, 1), chars: 0 }]), {
    startLine: 6,
    endLine: 6,
    chars: 10,
  })
  // A secondary selection alone does not make one: the chip would carry the empty primary.
  assert.equal(editorSelection([{ start: at(5, 2), end: at(5, 2), chars: 0 }, { start: at(0, 0), end: at(0, 3), chars: 3 }]), undefined)
})

test("the selection carries the primary's text, newlines as \\n, and none past the feed's ceiling — unread", () => {
  const one = [{ start: at(1, 0), end: at(3, 0), chars: 24 }]
  assert.deepEqual(editorSelection(one, () => "  let total = 0\r\n  for\r\n"), { startLine: 2, endLine: 3, chars: 24, text: "  let total = 0\n  for\n" })
  // Multi-cursor: the primary's text only, whatever the others hold.
  assert.deepEqual(editorSelection([{ start: at(5, 2), end: at(5, 9), chars: 7 }, { start: at(0, 0), end: at(0, 3), chars: 3 }], () => "primary"), { startLine: 6, endLine: 6, chars: 10, text: "primary" })
  // At the ceiling it is read and carried; one character past it the editor is not even asked.
  const atCeiling = [{ start: at(0, 0), end: at(400, 0), chars: EMBED_MAX_SELECTION_TEXT }]
  assert.equal(editorSelection(atCeiling, () => "x".repeat(EMBED_MAX_SELECTION_TEXT))?.text?.length, EMBED_MAX_SELECTION_TEXT)
  const past = [{ start: at(0, 0), end: at(400, 0), chars: EMBED_MAX_SELECTION_TEXT + 1 }]
  assert.deepEqual(editorSelection(past, () => assert.fail("a selection past the ceiling is read")), { startLine: 1, endLine: 400, chars: EMBED_MAX_SELECTION_TEXT + 1 })
  // The secondary selections' characters do not count against it: the primary's text is what goes.
  const many = [{ start: at(0, 0), end: at(0, 5), chars: 5 }, { start: at(1, 0), end: at(900, 0), chars: EMBED_MAX_SELECTION_TEXT * 3 }]
  assert.equal(editorSelection(many, () => "first")?.text, "first")
})

test("a file's label is its workspace-relative path, else its name, never empty", () => {
  assert.equal(fileLabel("/r/app/src/a.ts", "src/a.ts"), "src/a.ts")
  assert.equal(fileLabel("/r/app/src/a.ts", "app/src/a.ts"), "app/src/a.ts", "a multi-root window prefixes the folder")
  // asRelativePath returns the input when no workspace folder holds the file.
  assert.equal(fileLabel("/etc/hosts", "/etc/hosts"), "hosts")
  assert.equal(fileLabel("/etc/hosts", ""), "hosts")
  assert.equal(fileLabel("/", "/"), "/")
})

test("open files: once each, never the one in front, most recently in front first, then tab order, capped", () => {
  const recency = new Recency()
  recency.touch("/r/a.ts")
  recency.touch("/r/b.ts")
  recency.touch("/r/c.ts")
  recency.touch("/r/a.ts")
  // Tabs left to right across two groups; c.ts is open in both; a.ts is in front.
  const tabs = ["/r/b.ts", "/r/never-1.ts", "/r/c.ts", "/r/a.ts", "/r/never-2.ts", "/r/c.ts"]
  assert.deepEqual(openFiles(tabs, "/r/a.ts", recency), ["/r/c.ts", "/r/b.ts", "/r/never-1.ts", "/r/never-2.ts"])
  assert.deepEqual(openFiles(tabs, undefined, recency), ["/r/a.ts", "/r/c.ts", "/r/b.ts", "/r/never-1.ts", "/r/never-2.ts"])

  const many = Array.from({ length: EMBED_MAX_OPEN_FILES + 20 }, (_, i) => `/r/f${i}.ts`)
  recency.touch(many.at(-1)!)
  const capped = openFiles(many, undefined, recency)
  assert.equal(capped.length, EMBED_MAX_OPEN_FILES)
  assert.equal(capped[0], many.at(-1), "the cap keeps the most recent, not the leftmost")
  // A path the wire's ceiling refuses would make the page drop the whole message; it is left out instead.
  assert.deepEqual(openFiles([`/${"x".repeat(EDITOR_MAX_PATH)}`, "/r/b.ts"], undefined, new Recency()), ["/r/b.ts"])
})

test("recency forgets past its limit and moves a file to the front each time it is in front", () => {
  const recency = new Recency(2)
  for (const path of ["/a", "/b", "/c", "/b"]) recency.touch(path)
  assert.deepEqual(recency.sort(["/a", "/c", "/b"]), ["/b", "/c", "/a"])
})

test("the message carries paths, labels, projects and lines, in the contract's shape, and no field it does not name", () => {
  const message = editorContextMessage(
    { path: "/r/src/a.ts", label: "src/a.ts", projectId: "p1", selection: { startLine: 2, endLine: 4, chars: 30 } },
    [{ path: "/r/b.ts", label: "b.ts" }, { path: "/r/c.ts", label: "c.ts", projectId: "" }],
  )
  assert.deepEqual(message, {
    type: "ntwine:editor-context",
    active: { path: "/r/src/a.ts", label: "src/a.ts", projectId: "p1", selection: { startLine: 2, endLine: 4, chars: 30 } },
    open: [{ path: "/r/b.ts", label: "b.ts" }, { path: "/r/c.ts", label: "c.ts" }],
  })
  assert.deepEqual(editorContextMessage(null, []), { type: "ntwine:editor-context", active: null, open: [] })
  assert.deepEqual(editorContextMessage({ path: "", label: "x" }, []).active, null)
  // Extra fields a caller had on hand do not ride along — on the file, or on its selection.
  const leaky = editorContextMessage({ path: "/r/a.ts", label: "a.ts", text: "secret" } as never, [])
  assert.equal(JSON.stringify(leaky).includes("secret"), false)
  const leakySelection = editorContextMessage({ path: "/r/a.ts", label: "a.ts", selection: { startLine: 1, endLine: 1, chars: 2, extra: "secret" } } as never, [])
  assert.deepEqual(leakySelection.active, { path: "/r/a.ts", label: "a.ts", selection: { startLine: 1, endLine: 1, chars: 2 } })
})

test("the message carries the selection's text within the ceiling, and the caret's line only with nothing selected", () => {
  const selection = { startLine: 2, endLine: 3, chars: 9, text: "let a = 1" }
  assert.deepEqual(editorContextMessage({ path: "/r/a.ts", label: "a.ts", selection }, []).active, { path: "/r/a.ts", label: "a.ts", selection })
  const huge = { startLine: 1, endLine: 900, chars: EMBED_MAX_SELECTION_TEXT + 1, text: "x".repeat(EMBED_MAX_SELECTION_TEXT + 1) }
  assert.deepEqual(editorContextMessage({ path: "/r/a.ts", label: "a.ts", selection: huge }, []).active?.selection, { startLine: 1, endLine: 900, chars: EMBED_MAX_SELECTION_TEXT + 1 })
  assert.deepEqual(editorContextMessage({ path: "/r/a.ts", label: "a.ts", cursorLine: 40 }, []).active, { path: "/r/a.ts", label: "a.ts", cursorLine: 40 })
  // Beside a selection the caret's line is not sent: the selection's lines say where the human is.
  assert.deepEqual(editorContextMessage({ path: "/r/a.ts", label: "a.ts", cursorLine: 40, selection }, []).active, { path: "/r/a.ts", label: "a.ts", selection })
  assert.deepEqual(editorContextMessage({ path: "/r/a.ts", label: "a.ts", cursorLine: 0 }, []).active, { path: "/r/a.ts", label: "a.ts" })
})

test("the fix note reads as the Problems panel spells the problem, one line, bounded", () => {
  assert.equal(fixNote({ message: "Cannot find name 'foo'.", source: "ts", code: 2304 }), "Fix: Cannot find name 'foo'. ts(2304)")
  assert.equal(fixNote({ message: "Missing semicolon.", source: "eslint", code: { value: "semi" } }), "Fix: Missing semicolon. eslint(semi)")
  assert.equal(fixNote({ message: "Unknown word.", source: "cSpell" }), "Fix: Unknown word. cSpell")
  assert.equal(fixNote({ message: "Unreachable code.", code: "E1" }), "Fix: Unreachable code. (E1)")
  assert.equal(fixNote({ message: "Bad." }), "Fix: Bad.")
  assert.equal(fixNote({ message: "Type 'A' is not assignable\n  to type 'B'.\n\tTypes differ.", source: "ts", code: 2322 }), "Fix: Type 'A' is not assignable to type 'B'. Types differ. ts(2322)")
  const long = fixNote({ message: "x".repeat(EMBED_MAX_NOTE * 2), source: "ts" })
  assert.equal(long.length, EMBED_MAX_NOTE)
  assert.ok(long.endsWith("…"))
})

test("one problem is 'Ask Ntwine to fix'; several are told apart by their messages", () => {
  assert.equal(fixTitle({ message: "Cannot find name 'foo'." }, false), "Ask Ntwine to fix")
  assert.equal(fixTitle({ message: "Cannot find name 'foo'." }, true), "Ask Ntwine to fix: Cannot find name 'foo'.")
  const title = fixTitle({ message: `A very long message that goes on\nand on ${"and on ".repeat(20)}` }, true)
  assert.ok(title.length <= "Ask Ntwine to fix: ".length + 60 && title.endsWith("…"), title)
})

test("a terminal selection is taken as its text, trimmed, or refused with what to do", () => {
  assert.deepEqual(terminalText("$ npm test\r\nFAIL a.test.ts  \r\n\r\n"), { ok: true, text: "$ npm test\r\nFAIL a.test.ts".replace(/\r\n/gu, "\n") })
  assert.equal(terminalText("   \n ").ok, false)
  const tooLong = terminalText(Array.from({ length: QUOTE_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n"))
  assert.deepEqual(tooLong, { ok: false, why: "That terminal selection is too long to add. Select less of it." })
})
