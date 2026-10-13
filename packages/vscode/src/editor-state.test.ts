import { test } from "node:test"
import assert from "node:assert/strict"
import {
  EDITOR_MAX_PATH,
  EDITOR_STATE_MAX_BYTES,
  EDITOR_STATE_MAX_DIAGNOSTICS,
  EDITOR_STATE_MAX_MESSAGE,
  EDITOR_STATE_MAX_OPEN,
  EDITOR_STATE_MAX_SELECTION_TEXT,
  type EditorSnapshot,
} from "@ntwine/shared/editor-protocol"
// The server's OWN frame rules (the extension never bundles these): every frame built here must be one
// the server takes, or the socket is refused on every redial for as long as the human keeps the selection.
import { EditorClientMessageSchema } from "@ntwine/shared"
import { EDITOR_MAX_FRAME_BYTES } from "../../server/src/editor-bridge.ts"
import { buildEditorSnapshot, encodedBytes, fitEditorSnapshot, unsharedSnapshot, type ActiveInput, type DiagnosticInput, type SnapshotInputs } from "./editor-state.ts"

const at = (line: number, character: number) => ({ line, character })

/** What the server does with a frame: refuse it past its byte ceiling or its schema. */
function serverTakes(frame: EditorSnapshot): void {
  const text = JSON.stringify(frame)
  assert.ok(Buffer.byteLength(text, "utf8") <= EDITOR_MAX_FRAME_BYTES, `frame is ${Buffer.byteLength(text, "utf8")} bytes`)
  const parsed = EditorClientMessageSchema.safeParse(JSON.parse(text))
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message)
}

const sample: ActiveInput = {
  path: "/home/me/repo/src/a.ts",
  untitled: false,
  languageId: "typescript",
  dirty: true,
  lineCount: 40,
  cursor: at(13, 2),
  selection: { start: at(11, 0), end: at(14, 0), text: "  let total = 0\r\n  for (const x of xs) {\r\n    total += x\r\n" },
  visible: { start: 0, end: 29 },
}

function inputs(over: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return { shared: true, active: sample, open: [], diagnostics: [], ...over }
}

test("the file in front: 1-based lines, the chip's line rule, the text with \\n line endings", () => {
  const frame = buildEditorSnapshot(inputs())
  serverTakes(frame)
  assert.deepEqual(frame.active, {
    path: "/home/me/repo/src/a.ts",
    languageId: "typescript",
    dirty: true,
    lineCount: 40,
    cursorLine: 14,
    // A drag that ends at column 1 of line 15 does not include line 15 — what the human's chip would say.
    selection: { startLine: 12, endLine: 14, text: "  let total = 0\n  for (const x of xs) {\n    total += x\n" },
    visible: { startLine: 1, endLine: 30 },
  })
  // A caret is not a selection; an untitled buffer says so; no visible range reads as the caret's line.
  const caret = buildEditorSnapshot(inputs({ active: { ...sample, path: "Untitled-1", untitled: true, selection: undefined, visible: undefined } })).active
  assert.deepEqual(caret, { path: "Untitled-1", untitled: true, languageId: "typescript", dirty: true, lineCount: 40, cursorLine: 14, visible: { startLine: 14, endLine: 14 } })
  assert.equal(buildEditorSnapshot(inputs({ active: undefined })).active, null)
})

test("sharing off sends that it is off and nothing else, whatever the editor shows", () => {
  const off = buildEditorSnapshot(inputs({ shared: false, open: [{ path: "/b.ts", untitled: false, dirty: false }], diagnostics: [{ path: "/b.ts", line: 0, severity: "error", message: "x" }] }))
  assert.deepEqual(off, unsharedSnapshot())
  assert.deepEqual(off, { t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } })
  serverTakes(off)
})

test("the open tabs: in the order given, once each, never the file in front, at most the cap, flags only when true", () => {
  const open = [
    { path: "/home/me/repo/src/b.ts", untitled: false, dirty: true },
    { path: sample.path, untitled: false, dirty: true },
    { path: "/home/me/repo/src/b.ts", untitled: false, dirty: true },
    { path: "Untitled-2", untitled: true, dirty: true },
    { path: "/c.ts", untitled: false, dirty: false },
    { path: `/${"x".repeat(EDITOR_MAX_PATH)}`, untitled: false, dirty: false },
  ]
  assert.deepEqual(buildEditorSnapshot(inputs({ open })).open, [
    { path: "/home/me/repo/src/b.ts", dirty: true },
    { path: "Untitled-2", untitled: true, dirty: true },
    { path: "/c.ts" },
  ])
  const many = Array.from({ length: EDITOR_STATE_MAX_OPEN + 10 }, (_, i) => ({ path: `/f${i}.ts`, untitled: false, dirty: false }))
  const capped = buildEditorSnapshot(inputs({ open: many }))
  assert.equal(capped.open.length, EDITOR_STATE_MAX_OPEN)
  assert.equal(capped.open[0]!.path, "/f0.ts", "the most recent stay")
  serverTakes(capped)
})

test("diagnostics: every error before any warning, the file in front first within each, capped, counted in full", () => {
  const d = (path: string, line: number, severity: "error" | "warning", message: string, extra: Partial<DiagnosticInput> = {}): DiagnosticInput => ({ path, line, severity, message, ...extra })
  const diagnostics = [
    d("/other.ts", 0, "warning", "unused"),
    d("/other.ts", 4, "error", "bad type"),
    d(sample.path, 9, "warning", "prefer const"),
    d(sample.path, 2, "error", "Cannot find name 'foo'.\n  more detail", { source: "ts", code: 2304 }),
  ]
  const frame = buildEditorSnapshot(inputs({ diagnostics }))
  assert.deepEqual(frame.diagnostics, [
    { path: sample.path, line: 3, severity: "error", message: "Cannot find name 'foo'. more detail", source: "ts", code: "2304" },
    { path: "/other.ts", line: 5, severity: "error", message: "bad type" },
    { path: sample.path, line: 10, severity: "warning", message: "prefer const" },
    { path: "/other.ts", line: 1, severity: "warning", message: "unused" },
  ])
  assert.deepEqual(frame.problems, { errors: 2, warnings: 2 })

  // Two hundred lint warnings in the file in front cannot push out an error elsewhere.
  const noisy = [...Array.from({ length: 200 }, (_, i) => d(sample.path, i, "warning", `w${i}`)), d("/far.ts", 7, "error", "the one that matters")]
  const capped = buildEditorSnapshot(inputs({ diagnostics: noisy }))
  assert.equal(capped.diagnostics.length, EDITOR_STATE_MAX_DIAGNOSTICS)
  assert.deepEqual(capped.diagnostics[0], { path: "/far.ts", line: 8, severity: "error", message: "the one that matters" })
  assert.deepEqual(capped.problems, { errors: 1, warnings: 200 })

  // A long message is clipped with an ellipsis; a code object's value and a long source are capped too.
  const long = buildEditorSnapshot(inputs({ diagnostics: [d("/x.ts", 0, "error", "y".repeat(5000), { source: "s".repeat(500), code: "c".repeat(500) })] })).diagnostics[0]!
  assert.equal(long.message.length, EDITOR_STATE_MAX_MESSAGE)
  assert.ok(long.message.endsWith("…"))
  serverTakes(buildEditorSnapshot(inputs({ diagnostics: [d("/x.ts", 0, "error", "y".repeat(5000), { source: "s".repeat(500), code: "c".repeat(500) })] })))
})

test("a selection past the character cap carries its start, flagged truncated, and never half a surrogate pair", () => {
  const text = `${"a".repeat(EDITOR_STATE_MAX_SELECTION_TEXT - 1)}😀tail`
  const frame = buildEditorSnapshot(inputs({ active: { ...sample, selection: { start: at(0, 0), end: at(900, 3), text } } }))
  const selection = frame.active!.selection!
  assert.equal(selection.truncated, true)
  // The emoji straddles the cap: cut before it rather than leave a lone high surrogate.
  assert.equal(selection.text, "a".repeat(EDITOR_STATE_MAX_SELECTION_TEXT - 1))
  assert.deepEqual([selection.startLine, selection.endLine], [1, 901])
  serverTakes(fitEditorSnapshot(frame))
})

test("fitting a frame to the ceiling trims the diagnostics, then the tabs, then the selection's text — in that order", () => {
  const path = (i: number) => `/home/me/a-rather-long-workspace-folder-name/packages/some-package/src/deeply/nested/file-${i}.ts`
  const diagnostics = Array.from({ length: 100 }, (_, i): DiagnosticInput => ({ path: path(i), line: i, severity: i < 50 ? "error" : "warning", message: "m".repeat(290) }))
  const open = Array.from({ length: 50 }, (_, i) => ({ path: path(1000 + i), untitled: false, dirty: false }))

  // Everything within the ceiling comes back untouched.
  const small = buildEditorSnapshot(inputs({ open: open.slice(0, 3), diagnostics: diagnostics.slice(0, 3) }))
  assert.equal(fitEditorSnapshot(small), small)

  // A full frame of diagnostics and tabs with a 30 KiB selection: diagnostics go first, from the end.
  const big = buildEditorSnapshot(inputs({ open, diagnostics, active: { ...sample, selection: { start: at(0, 0), end: at(800, 0), text: "x".repeat(30 * 1024) } } }))
  assert.ok(encodedBytes(big) > EDITOR_STATE_MAX_BYTES, "the fixture must start over the ceiling")
  const fitted = fitEditorSnapshot(big)
  serverTakes(fitted)
  assert.ok(encodedBytes(fitted) <= EDITOR_STATE_MAX_BYTES)
  assert.ok(fitted.diagnostics.length > 0 && fitted.diagnostics.length < big.diagnostics.length, `${fitted.diagnostics.length} diagnostics kept`)
  assert.deepEqual(fitted.diagnostics, big.diagnostics.slice(0, fitted.diagnostics.length), "a leading run: the errors stay")
  assert.deepEqual(fitted.open, big.open, "the tabs are untouched while the diagnostics can give")
  assert.equal(fitted.active!.selection!.text, big.active!.selection!.text, "the selection is the last thing trimmed")
  assert.deepEqual(fitted.problems, big.problems, "the counts still say how many there are")

  // NUL-padded text encodes at six bytes a character: 32 Ki of it is ~192 KiB. Everything else gives,
  // then the text is cut to what fits and flagged — and the server takes the frame.
  const nul = buildEditorSnapshot(inputs({ open, diagnostics, active: { ...sample, selection: { start: at(0, 0), end: at(5, 0), text: "\u0000".repeat(EDITOR_STATE_MAX_SELECTION_TEXT) } } }))
  const cut = fitEditorSnapshot(nul)
  serverTakes(cut)
  assert.deepEqual([cut.diagnostics.length, cut.open.length], [0, 0])
  const kept = cut.active!.selection!
  assert.equal(kept.truncated, true)
  assert.ok(kept.text!.length > 9_000 && kept.text!.length < EDITOR_STATE_MAX_SELECTION_TEXT, `${kept.text!.length} characters kept`)
  assert.ok(EDITOR_STATE_MAX_BYTES - encodedBytes(cut) < 6, "as much as fits: one more character would not")

  // Multi-byte text is fitted by its encoded size, not its length.
  const cjk = fitEditorSnapshot(buildEditorSnapshot(inputs({ active: { ...sample, selection: { start: at(0, 0), end: at(5, 0), text: "漢".repeat(EDITOR_STATE_MAX_SELECTION_TEXT) } } })))
  serverTakes(cjk)
  assert.equal(cjk.active!.selection!.truncated, true)
  assert.ok(cjk.active!.selection!.text!.length > 15_000, "three bytes a character: about 18 Ki of them fit")
})
