import assert from "node:assert/strict"
import { test } from "node:test"
import {
  appendEditorContext,
  buildMessageWithContext,
  contextChipLabel,
  contextDisplayPath,
  contextSourceLabel,
  hasToken,
  insertTokenIntoProse,
  locateInSource,
  parseSentContext,
  parseSentEditorContext,
  previousEditorQuote,
  serializeContextItems,
  serializeEditorContext,
  withoutEditorContext,
  withoutWorktreeNote,
  worktreeNote,
  appendWorktreeNote,
  splitProseByTokens,
  tokenLabel,
  uniqueToken,
  type ComposerContextItem,
} from "./composerContext.ts"

const item = (over: Partial<ComposerContextItem>): ComposerContextItem => ({ id: 1, token: "@guide.md:3", path: "/repo/docs/guide.md", text: "some text", startLine: 3, endLine: 3, ...over })

test("a unique selection maps to its 1-based line range, whitespace-insensitively", () => {
  const source = "# Title\n\nFirst paragraph line one\ncontinues on line four.\n\nAnother paragraph.\n"
  // The rendered view joins the soft-wrapped paragraph into one line; the match must still land.
  assert.deepEqual(locateInSource(source, "line one continues on"), { startLine: 3, endLine: 4 })
  assert.deepEqual(locateInSource(source, "Another paragraph."), { startLine: 6, endLine: 6 })
})

test("an ambiguous or absent selection yields no line range", () => {
  const source = "alpha beta\ngamma\nalpha beta\n"
  assert.equal(locateInSource(source, "alpha beta"), null)
  assert.equal(locateInSource(source, "not present"), null)
  assert.equal(locateInSource(source, "   "), null)
})

test("paths under the project display relative; others stay absolute", () => {
  assert.equal(contextDisplayPath("/repo/docs/guide.md", "/repo"), "docs/guide.md")
  assert.equal(contextDisplayPath("/repo/docs/guide.md", "/repo/"), "docs/guide.md")
  assert.equal(contextDisplayPath("/elsewhere/guide.md", "/repo"), "/elsewhere/guide.md")
  assert.equal(contextDisplayPath("/repo/docs/guide.md", null), "/repo/docs/guide.md")
})

test("the chip label is basename plus a compact line range, and the token is that label behind an @", () => {
  assert.equal(contextChipLabel({ display: "docs/guide.md", startLine: 3, endLine: 4 }), "guide.md:3-4")
  assert.equal(contextChipLabel({ path: "/repo/docs/guide.md", startLine: 2, endLine: 2 }), "guide.md:2")
  assert.equal(contextChipLabel({ display: "docs/guide.md" }), "guide.md")
  assert.equal(tokenLabel("@guide.md:3#2"), "guide.md:3#2")
})

test("a token is unique against the staged set and the prose, by a #n suffix", () => {
  assert.equal(uniqueToken("guide.md:3", [], ""), "@guide.md:3")
  assert.equal(uniqueToken("guide.md:3", [{ token: "@guide.md:3" }], ""), "@guide.md:3#2")
  // A hand-typed twin in the prose must not be mistaken for the staged reference.
  assert.equal(uniqueToken("guide.md:3", [{ token: "@guide.md:3" }], "see @guide.md:3#2 too"), "@guide.md:3#3")
})

test("a token is only found as a whole reference", () => {
  assert.equal(hasToken("see @guide.md:3.", "@guide.md:3"), true)
  assert.equal(hasToken("see @guide.md:30", "@guide.md:3"), false)
  assert.equal(hasToken("see @guide.md:3-4", "@guide.md:3"), false)
  assert.equal(hasToken("see @guide.md:3#2", "@guide.md:3"), false)
})

// A whole-file chip (`@a.ts`, from the sidebar's open files, or a ⌘I selection that could not be
// located) sits beside the same file's line chips. Its token is a prefix of theirs, and must not be
// found inside them — or deleting it leaves its item staged, riding the send at the other chip's place.
test("a whole-file token is not found inside a longer reference to the same file", () => {
  assert.equal(hasToken("see @a.ts:12 there", "@a.ts"), false)
  assert.equal(hasToken("see @a.ts:12-20", "@a.ts"), false)
  assert.equal(hasToken("see @a.tsx", "@a.ts"), false)
  assert.equal(hasToken("see @a.ts.map", "@a.ts"), false)
  assert.equal(hasToken("ask @terminal-fix about @terminal_2", "@terminal"), false)
  // The sentence's own punctuation after a token is still the sentence's.
  for (const prose of ["see @a.ts.", "see @a.ts, then", "@a.ts: why?", "(@a.ts)", "@a.ts's import", "@a.ts\nnext"]) {
    assert.equal(hasToken(prose, "@a.ts"), true, prose)
  }
  // So a whole-file chip added beside a line chip of the same file is not a needless `#2`…
  assert.equal(uniqueToken("a.ts", [{ token: "@a.ts:12" }], "@a.ts:12 "), "@a.ts")
  // …and with both in the prose, each serializes at its own place, and only while its own text is there.
  const both = [item({ id: 1, token: "@a.ts:12", path: "/repo/a.ts", startLine: 12, endLine: 12, text: "x" }), item({ id: 2, token: "@a.ts", path: "/repo/a.ts", startLine: undefined, endLine: undefined, text: "whole" })]
  assert.equal(buildMessageWithContext("@a.ts:12 and @a.ts", both, "/repo"), "@a.ts:12 and @a.ts\n\nSelected context:\n\n@a.ts:12 (a.ts, line 12):\n> x\n\n@a.ts (a.ts):\n> whole")
  assert.equal(buildMessageWithContext("only @a.ts:12", both, "/repo"), "only @a.ts:12\n\nSelected context:\n\n@a.ts:12 (a.ts, line 12):\n> x")
  assert.deepEqual(splitProseByTokens("@a.ts:12 @a.ts", ["@a.ts", "@a.ts:12"]), [{ text: "@a.ts:12", token: "@a.ts:12" }, { text: " " }, { text: "@a.ts", token: "@a.ts" }])
})

// A selection made in the editor's terminal (embed-protocol.ts EMBED_TERMINAL_PATH) has no file: it reads
// `@terminal`, defines as `(terminal)` — never resolved against the project, never with the terminal
// buffer's line numbers — and the transcript parses it back into the chip it was.
test("a terminal selection serializes as (terminal) and parses back", () => {
  const terminal = (over: Partial<ComposerContextItem>) => item({ path: "terminal", token: "@terminal", startLine: undefined, endLine: undefined, text: "$ npm test\nFAIL a.test.ts", ...over })
  assert.equal(contextChipLabel({ path: "terminal" }), "terminal")
  assert.equal(contextDisplayPath("terminal", "/repo"), "terminal")
  // Even handed line numbers, a terminal item does not spell them out.
  const items = [terminal({ id: 1 }), terminal({ id: 2, token: "@terminal#2", text: "second", startLine: 4, endLine: 9 })]
  const sent = buildMessageWithContext("why @terminal and @terminal#2", items, "/repo")
  assert.equal(sent, "why @terminal and @terminal#2\n\nSelected context:\n\n@terminal (terminal):\n> $ npm test\n> FAIL a.test.ts\n\n@terminal#2 (terminal):\n> second")
  assert.deepEqual(parseSentContext(sent), {
    body: "why @terminal and @terminal#2",
    items: [
      { token: "@terminal", display: "terminal", startLine: undefined, endLine: undefined, text: "$ npm test\nFAIL a.test.ts" },
      { token: "@terminal#2", display: "terminal", startLine: undefined, endLine: undefined, text: "second" },
    ],
  })
})

test("a chip's hover says where it came from, in the definition's own words", () => {
  assert.equal(contextSourceLabel({ path: "/repo/docs/guide.md", startLine: 3, endLine: 9 }, "/repo"), "docs/guide.md, lines 3-9")
  assert.equal(contextSourceLabel({ path: "/repo/docs/guide.md", startLine: 3, endLine: 3 }, "/repo"), "docs/guide.md, line 3")
  assert.equal(contextSourceLabel({ path: "/elsewhere/a.ts" }, "/repo"), "/elsewhere/a.ts")
  assert.equal(contextSourceLabel({ path: "terminal", startLine: 2, endLine: 4 }, "/repo"), "Terminal")
})

test("a token splices at the caret, padding only the sides that would glue to a word", () => {
  assert.deepEqual(insertTokenIntoProse("", 0, "@a.md:1"), { prose: "@a.md:1", caret: 7 })
  assert.deepEqual(insertTokenIntoProse("note.", 5, "@a.md:1"), { prose: "note. @a.md:1", caret: 13 })
  // Mid-word: padded on both sides, caret before the trailing pad so typing on reads `@a.md:1 x`.
  assert.deepEqual(insertTokenIntoProse("ab", 1, "@a.md:1"), { prose: "a @a.md:1 b", caret: 9 })
  // An already-spaced side takes no extra padding.
  assert.deepEqual(insertTokenIntoProse("a b", 2, "@a.md:1"), { prose: "a @a.md:1 b", caret: 9 })
  // An out-of-range caret clamps to the end.
  assert.deepEqual(insertTokenIntoProse("hi", 99, "@a.md:1"), { prose: "hi @a.md:1", caret: 10 })
})

test("the splitter cuts prose into plain runs and whole staged tokens, longest token first", () => {
  assert.deepEqual(splitProseByTokens("x @a.md:1 y @a.md:1#2.", ["@a.md:1", "@a.md:1#2"]), [
    { text: "x " },
    { text: "@a.md:1", token: "@a.md:1" },
    { text: " y " },
    { text: "@a.md:1#2", token: "@a.md:1#2" },
    { text: "." },
  ])
  // An unstaged twin and a longer sibling both stay plain.
  assert.deepEqual(splitProseByTokens("@a.md:10 and @b.md", ["@a.md:1"]), [{ text: "@a.md:10 and @b.md" }])
  assert.deepEqual(splitProseByTokens("plain", []), [{ text: "plain" }])
  assert.deepEqual(splitProseByTokens("", ["@a.md:1"]), [])
})

test("serialization defines each token and quotes every line", () => {
  const out = serializeContextItems([item({ token: "@guide.md:3-4", text: "line a\nline b", startLine: 3, endLine: 4 })], "/repo")
  assert.equal(out, "Selected context:\n\n" + "@guide.md:3-4 (docs/guide.md, lines 3-4):\n> line a\n> line b")
})

test("a single line reads as one line, and no lines reads as the bare path", () => {
  const out = serializeContextItems(
    [item({ text: "a" }), item({ id: 2, token: "@guide.md", text: "b", startLine: undefined, endLine: undefined })],
    "/repo",
  )
  assert.equal(out, "Selected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> a\n\n@guide.md (docs/guide.md):\n> b")
})

test("context is spliced after the prose but before trailing attachment paths", () => {
  const value = "Look at this @guide.md:3\n/tmp/shot.png"
  const out = buildMessageWithContext(value, [item({ text: "quoted" })], "/repo")
  assert.equal(out, "Look at this @guide.md:3\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> quoted\n/tmp/shot.png")
})

test("an item whose reference was deleted from the prose is dropped, and definitions follow prose order", () => {
  const out = buildMessageWithContext("second @guide.md:9 then first @guide.md:3", [item({}), item({ id: 2, token: "@guide.md:9", text: "other", startLine: 9, endLine: 9 })], "/repo")
  assert.equal(out, "second @guide.md:9 then first @guide.md:3\n\nSelected context:\n\n@guide.md:9 (docs/guide.md, line 9):\n> other\n\n@guide.md:3 (docs/guide.md, line 3):\n> some text")
  assert.equal(buildMessageWithContext("no references here", [item({})], "/repo"), "no references here")
})

test("with no staged items the value passes through untouched", () => {
  assert.equal(buildMessageWithContext("hello", [], "/repo"), "hello")
})

test("a sent message parses back into its body and items", () => {
  const sent = buildMessageWithContext(
    "Fix this @guide.md:3-4 and mind the note @guide.md:9 please",
    [item({ token: "@guide.md:3-4", text: "line a\nline b", startLine: 3, endLine: 4 }), item({ id: 2, token: "@guide.md:9", text: "quoted", startLine: 9, endLine: 9 })],
    "/repo",
  )
  const parsed = parseSentContext(sent)
  assert.ok(parsed)
  assert.equal(parsed.body, "Fix this @guide.md:3-4 and mind the note @guide.md:9 please")
  assert.deepEqual(parsed.items, [
    { token: "@guide.md:3-4", display: "docs/guide.md", startLine: 3, endLine: 4, text: "line a\nline b" },
    { token: "@guide.md:9", display: "docs/guide.md", startLine: 9, endLine: 9, text: "quoted" },
  ])
  // A definition with no line range parses too.
  const bare = parseSentContext("see @guide.md\n\nSelected context:\n\n@guide.md (docs/guide.md):\n> q")
  assert.deepEqual(bare?.items, [{ token: "@guide.md", display: "docs/guide.md", startLine: undefined, endLine: undefined, text: "q" }])
})

test("what is not the serialization renders as the plain text it is", () => {
  // The earlier formats must not half-parse.
  assert.equal(parseSentContext("notes\n\nSelected context:\n\n[1] docs/guide.md:\n> old style"), null)
  assert.equal(parseSentContext("notes [^1]\n\nSelected context:\n\n[^1]: docs/guide.md (line 3):\n> footnote era"), null)
  assert.equal(parseSentContext("see @guide.md:3\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> q\n\nComment: comment era"), null)
  // A definition whose reference is missing from the body is someone quoting the format, not sending it.
  assert.equal(parseSentContext("no reference\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> quoted"), null)
  // The header mid-sentence is prose.
  assert.equal(parseSentContext("about Selected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> q"), null)
  assert.equal(parseSentContext("plain message"), null)
})

test("contextDisplayPath: a Windows project shortens the same way, in the path's own separators (Windows audit 2026-09-11, finding 12)", () => {
  assert.equal(contextDisplayPath("C:\\Users\\x\\proj\\docs\\guide.md", "C:\\Users\\x\\proj"), "docs\\guide.md")
  assert.equal(contextDisplayPath("c:/Users/x/proj/docs/guide.md", "C:\\Users\\x\\proj\\"), "docs/guide.md")
  assert.equal(contextDisplayPath("D:\\elsewhere\\guide.md", "C:\\Users\\x\\proj"), "D:\\elsewhere\\guide.md")
  assert.equal(contextChipLabel({ path: "C:\\Users\\x\\proj\\docs\\guide.md", startLine: 3, endLine: 3 }), "guide.md:3")
})

// ── the editor block ─────────────────────────────────────────────────────────────────────────────

const HEADER = "Editor context (attached automatically: what the user had in front of them in their editor when they sent this; it may or may not be related):"
const editorFile = { path: "/repo/src/a.ts" }

test("the editor block quotes a selection under a header that says it was automatic and may be unrelated", () => {
  const block = serializeEditorContext({ ...editorFile, selection: { startLine: 12, endLine: 14, text: "for (const x of xs) {\n\n  total += x\n" } }, [], "/repo")
  assert.equal(block, `${HEADER}\n\nSelected in src/a.ts, lines 12-14:\n> for (const x of xs) {\n> \n>   total += x`)
  assert.equal(serializeEditorContext({ ...editorFile, selection: { startLine: 7, endLine: 7, text: "x" } }, [], "/repo"), `${HEADER}\n\nSelected in src/a.ts, line 7:\n> x`)
  // Outside the project: the absolute path, which the agent can still open.
  assert.match(serializeEditorContext({ path: "/elsewhere/b.ts", selection: { startLine: 1, endLine: 1, text: "y" } }, [], "/repo"), /Selected in \/elsewhere\/b\.ts, line 1:/)
})

test("a selection without its text names its lines; a caret names the file and its line; nothing is nothing", () => {
  assert.equal(serializeEditorContext({ ...editorFile, selection: { startLine: 1, endLine: 900 } }, [], "/repo"), `${HEADER}\n\nSelected in src/a.ts, lines 1-900 (not quoted here; read it from the file)`)
  assert.equal(serializeEditorContext({ ...editorFile, cursorLine: 40 }, [], "/repo"), `${HEADER}\n\nOpen in the editor: src/a.ts (cursor on line 40)`)
  assert.equal(serializeEditorContext(editorFile, [], "/repo"), `${HEADER}\n\nOpen in the editor: src/a.ts`)
  // Whitespace selected is nothing to quote: the file, the caret where the selection starts.
  assert.equal(serializeEditorContext({ ...editorFile, selection: { startLine: 3, endLine: 4, text: "  \n " } }, [], "/repo"), `${HEADER}\n\nOpen in the editor: src/a.ts (cursor on line 3)`)
  assert.equal(serializeEditorContext(null, [], "/repo"), "")
})

test("a chip that already carries the selection, or names the file, leaves the block out", () => {
  const selection = { startLine: 12, endLine: 14, text: "  total += x" }
  const chip = (over: Partial<ComposerContextItem>) => item({ path: editorFile.path, token: "@a.ts:12-14", startLine: 12, endLine: 14, text: "for…\n  total += x\n}", ...over })
  // ⌘I on the selection, sent with the selection still up: the chip says it.
  assert.equal(serializeEditorContext({ ...editorFile, selection }, [chip({})], "/repo"), "")
  // A wider chip takes it in; a chip whose quote holds the text does too, located or not.
  assert.equal(serializeEditorContext({ ...editorFile, selection }, [chip({ startLine: 1, endLine: 30 })], "/repo"), "")
  assert.equal(serializeEditorContext({ ...editorFile, selection }, [chip({ startLine: undefined, endLine: undefined })], "/repo"), "")
  // A chip on other lines of the file, or the same lines of another file, does not.
  assert.notEqual(serializeEditorContext({ ...editorFile, selection }, [chip({ startLine: 13, endLine: 20, text: "other" })], "/repo"), "")
  assert.notEqual(serializeEditorContext({ ...editorFile, selection }, [chip({ path: "/repo/src/b.ts" })], "/repo"), "")
  // With nothing selected, any chip on the file covers it.
  assert.equal(serializeEditorContext({ ...editorFile, cursorLine: 3 }, [chip({ startLine: 90, endLine: 91, text: "z" })], "/repo"), "")
})

test("the block goes after the prose and the chips' definitions, before the attachment lines, and parses back", () => {
  const staged = [item({ token: "@guide.md:3", path: "/repo/docs/guide.md", text: "a quote" })]
  const withChips = buildMessageWithContext("look at @guide.md:3 please\n/tmp/shot.png", staged, "/repo")
  const block = serializeEditorContext({ ...editorFile, selection: { startLine: 2, endLine: 3, text: "let a = 1\nlet b = 2" } }, [], "/repo")
  const sent = appendEditorContext(withChips, block)
  assert.equal(sent, `look at @guide.md:3 please\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> a quote\n\n${HEADER}\n\nSelected in src/a.ts, lines 2-3:\n> let a = 1\n> let b = 2\n/tmp/shot.png`)
  // Back: the attachment line peels off, the block comes off the end, and the chips parse from what is left.
  const prose = sent.slice(0, sent.lastIndexOf("\n/tmp/shot.png"))
  const parsed = parseSentEditorContext(prose)
  assert.deepEqual(parsed?.editor, { kind: "selection", display: "src/a.ts", startLine: 2, endLine: 3, text: "let a = 1\nlet b = 2" })
  assert.deepEqual(parseSentContext(parsed!.body)?.items.map((each) => each.token), ["@guide.md:3"])
  assert.equal(parseSentContext(parsed!.body)?.body, "look at @guide.md:3 please")
  // The human's prose alone, with the block: never touched.
  assert.equal(appendEditorContext("why is this slow?  ", block), `why is this slow?\n\n${block}`)
  assert.equal(appendEditorContext("unchanged", ""), "unchanged")
})

test("each reading parses back to what the chip shows", () => {
  const back = (active: Parameters<typeof serializeEditorContext>[0]) => parseSentEditorContext(appendEditorContext("hi", serializeEditorContext(active, [], "/repo")))
  assert.deepEqual(back({ ...editorFile, selection: { startLine: 7, endLine: 7, text: "x" } }), { body: "hi", editor: { kind: "selection", display: "src/a.ts", startLine: 7, endLine: 7, text: "x" } })
  assert.deepEqual(back({ ...editorFile, selection: { startLine: 1, endLine: 900 } }), { body: "hi", editor: { kind: "selection", display: "src/a.ts", startLine: 1, endLine: 900, unquoted: "long" } })
  assert.deepEqual(back({ ...editorFile, cursorLine: 40 }), { body: "hi", editor: { kind: "file", display: "src/a.ts", cursorLine: 40 } })
  assert.deepEqual(back(editorFile), { body: "hi", editor: { kind: "file", display: "src/a.ts" } })
  // A path with a comma and spaces, and code that quotes the header and a blank line, still round trip.
  const odd = back({ path: "/repo/my dir/a, b.ts", selection: { startLine: 3, endLine: 5, text: `${HEADER}\n\nOpen in the editor: x` } })
  assert.deepEqual(odd?.editor, { kind: "selection", display: "my dir/a, b.ts", startLine: 3, endLine: 5, text: `${HEADER}\n\nOpen in the editor: x` })
  // A trailing newline from the transport is not the block's.
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nOpen in the editor: src/a.ts\n`)?.editor.display, "src/a.ts")
  // A message sent before 2026-10-08 said "the human", and still parses: header, unquoted tails and note.
  const OLD_HEADER = "Editor context (attached automatically: what the human had in front of them in their editor when they sent this; it may or may not be related):"
  assert.notEqual(OLD_HEADER, HEADER)
  assert.deepEqual(parseSentEditorContext(`hi\n\n${OLD_HEADER}\n\nOpen in the editor: src/a.ts`), { body: "hi", editor: { kind: "file", display: "src/a.ts" } })
  assert.equal(parseSentEditorContext(`hi\n\n${OLD_HEADER}\n\nSelected in src/a.ts (unsaved changes), lines 1-900 (not quoted here, and the copy on disk differs: ask the human to save it or paste it)`)?.editor.unquoted, "long")
  assert.equal(parseSentEditorContext(`hi\n\n${OLD_HEADER}\n\nSelected in Untitled-1 (unsaved, not a file on disk), lines 1-900 (not quoted here, and there is no file to read: ask the human to paste it)`)?.editor.unquoted, "long")
  const oldNote = "The context above is from the human's editor, which shows the project's main checkout (/repo). You are working in your own worktree (/repo/.ntwine/worktrees/tidy): the same relative path there is your copy, and it may differ from what they see."
  assert.equal(withoutWorktreeNote(`fix it\n\n${oldNote}`), "fix it")
})

test("a message that only quotes an editor block, or garbles one, stays plain text", () => {
  const block = serializeEditorContext({ ...editorFile, cursorLine: 2 }, [], "/repo")
  // Not at the end: the human (or an agent's words pasted back) went on after it.
  assert.equal(parseSentEditorContext(`see this:\n\n${block}\n\nwhat does it mean?`), null)
  // Not its own paragraph.
  assert.equal(parseSentEditorContext(`see this: ${block}`), null)
  // Anything after the reading, or a reading that is not one of the three.
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nOpen in the editor: src/a.ts\nmore`), null)
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nSelected in src/a.ts, lines 2-3:`), null)
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nSelected in src/a.ts, lines 2-3:\nnot a quote`), null)
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nSomething else`), null)
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\nOpen in the editor: src/a.ts`), null)
  assert.equal(parseSentEditorContext("no block at all"), null)
})

test("a message taken back loses its editor block and keeps everything the human put in it", () => {
  const block = serializeEditorContext({ ...editorFile, cursorLine: 2 }, [], "/repo")
  const withChips = buildMessageWithContext("fix @guide.md:3\n/tmp/shot.png", [item({})], "/repo")
  const sent = appendEditorContext(withChips, block)
  assert.equal(withoutEditorContext(sent), withChips)
  assert.equal(withoutEditorContext("plain"), "plain")
})

test("an unsaved buffer says the copy on disk differs, an untitled one that there is none, and each says what to do instead", () => {
  const dirty = { ...editorFile, dirty: true }
  assert.equal(serializeEditorContext({ ...dirty, selection: { startLine: 2, endLine: 3, text: "a\nb" } }, [], "/repo"), `${HEADER}\n\nSelected in src/a.ts (unsaved changes), lines 2-3:\n> a\n> b`)
  assert.equal(serializeEditorContext({ ...dirty, selection: { startLine: 1, endLine: 900 } }, [], "/repo"),
    `${HEADER}\n\nSelected in src/a.ts (unsaved changes), lines 1-900 (not quoted here, and the copy on disk differs: ask the user to save it or paste it)`)
  assert.equal(serializeEditorContext({ ...dirty, cursorLine: 40 }, [], "/repo"), `${HEADER}\n\nOpen in the editor: src/a.ts (unsaved changes; cursor on line 40)`)
  assert.equal(serializeEditorContext(dirty, [], "/repo"), `${HEADER}\n\nOpen in the editor: src/a.ts (unsaved changes)`)
  const scratch = { path: "Untitled-1", untitled: true }
  assert.equal(serializeEditorContext({ ...scratch, selection: { startLine: 1, endLine: 2, text: "TODO\nlater" } }, [], "/repo"), `${HEADER}\n\nSelected in Untitled-1 (unsaved, not a file on disk), lines 1-2:\n> TODO\n> later`)
  assert.equal(serializeEditorContext({ ...scratch, selection: { startLine: 1, endLine: 900 } }, [], "/repo"),
    `${HEADER}\n\nSelected in Untitled-1 (unsaved, not a file on disk), lines 1-900 (not quoted here, and there is no file to read: ask the user to paste it)`)
  // A file that may hold secrets: named, never quoted, whatever its size.
  assert.equal(serializeEditorContext({ path: "/repo/.env", withheld: true, selection: { startLine: 1, endLine: 3 } }, [], "/repo"), `${HEADER}\n\nSelected in .env, lines 1-3 (not quoted here: the file may hold secrets)`)
})

test("every new reading parses back, with what the chip needs to say it", () => {
  const back = (active: Parameters<typeof serializeEditorContext>[0], previous?: Parameters<typeof serializeEditorContext>[4]) =>
    parseSentEditorContext(appendEditorContext("hi", serializeEditorContext(active, [], "/repo", null, previous)))?.editor
  assert.deepEqual(back({ ...editorFile, dirty: true, selection: { startLine: 2, endLine: 3, text: "a\nb" } }), { kind: "selection", display: "src/a.ts", startLine: 2, endLine: 3, state: "unsaved", text: "a\nb" })
  assert.deepEqual(back({ ...editorFile, dirty: true, selection: { startLine: 1, endLine: 900 } }), { kind: "selection", display: "src/a.ts", startLine: 1, endLine: 900, state: "unsaved", unquoted: "long" })
  assert.deepEqual(back({ path: "Untitled-1", untitled: true, selection: { startLine: 1, endLine: 900 } }), { kind: "selection", display: "Untitled-1", startLine: 1, endLine: 900, state: "untitled", unquoted: "long" })
  assert.deepEqual(back({ path: "/repo/.env", withheld: true, selection: { startLine: 1, endLine: 3 } }), { kind: "selection", display: ".env", startLine: 1, endLine: 3, unquoted: "secret" })
  assert.deepEqual(back({ ...editorFile, dirty: true, cursorLine: 40 }), { kind: "file", display: "src/a.ts", cursorLine: 40, state: "unsaved" })
  assert.deepEqual(back({ path: "Untitled-2", untitled: true }), { kind: "file", display: "Untitled-2", state: "untitled" })
  const previous = { display: "src/a.ts", startLine: 2, endLine: 3, text: "a\nb" }
  assert.deepEqual(back({ ...editorFile, selection: { startLine: 2, endLine: 3, text: "a\nb" } }, previous), { kind: "selection", display: "src/a.ts", startLine: 2, endLine: 3, repeat: true })
  // A path with parentheses of its own is still the path.
  assert.deepEqual(back({ path: "/repo/notes (draft).md", cursorLine: 4 }), { kind: "file", display: "notes (draft).md", cursorLine: 4 })
  // A reason the grammar does not have is not a block.
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nSelected in src/a.ts, lines 1-9 (because)`), null)
  assert.equal(parseSentEditorContext(`hi\n\n${HEADER}\n\nStill selected in src/a.ts, lines 1-9:\n> x`), null)
})

// ── the repeat-send rule ──────────────────────────────────────────────────────────────────────────

const sentWith = (active: Parameters<typeof serializeEditorContext>[0], words = "q", previous?: Parameters<typeof serializeEditorContext>[4]) =>
  ({ role: "user", text: appendEditorContext(words, serializeEditorContext(active, [], "/repo", null, previous)) })

test("a selection the thread was just sent is named, not quoted again; any change quotes afresh", () => {
  const held = { ...editorFile, selection: { startLine: 12, endLine: 20, text: "const a = 1\nconst b = 2\n" } }
  const first = sentWith(held)
  const quote = previousEditorQuote([first, { role: "assistant", text: "It sets a and b." }])
  assert.deepEqual(quote, { display: "src/a.ts", startLine: 12, endLine: 20, text: "const a = 1\nconst b = 2" })
  // The same lines and text: a one-line reference.
  assert.equal(serializeEditorContext(held, [], "/repo", null, quote), `${HEADER}\n\nStill selected in src/a.ts, lines 12-20 (quoted in an earlier message)`)
  // …and again after that reference: the chain leads back to the quote.
  const second = sentWith(held, "and then?", quote)
  assert.deepEqual(previousEditorQuote([first, second]), quote)
  // The text edited under the selection, other lines, another file: quoted in full.
  for (const changed of [
    { ...held, selection: { ...held.selection, text: "const a = 2\nconst b = 2\n" } },
    { ...held, selection: { ...held.selection, endLine: 21 } },
    { ...held, path: "/repo/src/b.ts" },
  ]) assert.match(serializeEditorContext(changed, [], "/repo", null, quote), /\n\nSelected in .*:\n> /)
  // Messages without a block (sharing off, a browser tab) are passed over; the agent still has the quote.
  assert.deepEqual(previousEditorQuote([first, { role: "user", text: "no block here" }]), quote)
})

test("the last block decides: a different reading after the quote, or none quoted, means quote again", () => {
  const held = { ...editorFile, selection: { startLine: 12, endLine: 20, text: "x" } }
  const first = sentWith(held)
  assert.equal(previousEditorQuote([first, sentWith({ ...editorFile, cursorLine: 3 })]), null, "the file with nothing selected came after")
  assert.equal(previousEditorQuote([first, sentWith({ ...editorFile, selection: { startLine: 1, endLine: 900 } })]), null, "a selection too long to quote came after")
  assert.equal(previousEditorQuote([first, sentWith({ path: "/repo/src/b.ts", selection: { startLine: 1, endLine: 1, text: "y" } })])?.display, "src/b.ts", "another quote is the last one")
  // A "still selected" that names other lines than the quote before it cannot lean on it.
  const stray = { role: "user", text: appendEditorContext("q", `${HEADER}\n\nStill selected in src/a.ts, lines 1-2 (quoted in an earlier message)`) }
  assert.equal(previousEditorQuote([first, stray]), null)
  assert.equal(previousEditorQuote([]), null)
  // Attachment lines after the block do not hide it.
  assert.deepEqual(previousEditorQuote([{ role: "user", text: `${first.text}\n/tmp/shot.png` }])?.startLine, 12)
})

// ── a thread in a worktree ──────────────────────────────────────────────────────────────────────────

const WT = "/repo/.ntwine/worktrees/tidy"

test("a file in the thread's own worktree is relative to the worktree; a main-checkout file to the project", () => {
  // The agent resolves a relative path against its own working folder: from the worktree,
  // `.ntwine/worktrees/tidy/src/a.ts` names nothing.
  assert.equal(contextDisplayPath(`${WT}/src/a.ts`, "/repo", WT), "src/a.ts")
  assert.equal(contextDisplayPath("/repo/src/a.ts", "/repo", WT), "src/a.ts")
  assert.equal(contextDisplayPath("/elsewhere/a.ts", "/repo", WT), "/elsewhere/a.ts")
  assert.equal(contextDisplayPath("terminal", "/repo", WT), "terminal")
  // A sibling worktree outside the project.
  assert.equal(contextDisplayPath("/repo-perf/src/a.ts", "/repo", "/repo-perf"), "src/a.ts")
  // Without a checkout, exactly as before.
  assert.equal(contextDisplayPath(`${WT}/src/a.ts`, "/repo"), ".ntwine/worktrees/tidy/src/a.ts")
  assert.equal(serializeContextItems([item({ path: `${WT}/docs/guide.md` })], "/repo", WT), "Selected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> some text")
  assert.equal(serializeEditorContext({ path: `${WT}/src/a.ts`, cursorLine: 4 }, [], "/repo", WT).endsWith("Open in the editor: src/a.ts (cursor on line 4)"), true)
})

test("the worktree note: only for context from the main checkout, sent to a thread working elsewhere", () => {
  const note = worktreeNote(["/repo/src/a.ts"], "/repo", { dir: WT, kind: "worktree" })
  assert.equal(note, "The context above is from the user's editor, which shows the project's main checkout (/repo). You are working in your own worktree (/repo/.ntwine/worktrees/tidy): the same relative path there is your copy, and it may differ from what they see.")
  assert.match(worktreeNote(["/repo/src/a.ts"], "/repo", { dir: "/repo-perf", kind: "folder" }), /You are working in your own checkout \(\/repo-perf\)/)
  // Nothing to say: the thread is at the root, the file is the worktree's own, outside the project, the
  // terminal, or there is no context at all.
  assert.equal(worktreeNote(["/repo/src/a.ts"], "/repo", null), "")
  assert.equal(worktreeNote(["/repo/src/a.ts"], "/repo", { dir: "/repo" }), "")
  assert.equal(worktreeNote([`${WT}/src/a.ts`], "/repo", { dir: WT }), "")
  assert.equal(worktreeNote(["/etc/hosts", "terminal"], "/repo", { dir: WT }), "")
  assert.equal(worktreeNote([], "/repo", { dir: WT }), "")
  assert.equal(worktreeNote(["/repo/src/a.ts"], null, { dir: WT }), "")
})

test("the note goes last, before the attachment lines, and the transcript and a take-back peel it off", () => {
  const note = worktreeNote(["/repo/docs/guide.md"], "/repo", { dir: WT })
  const block = serializeEditorContext({ path: "/repo/src/a.ts", selection: { startLine: 2, endLine: 3, text: "x\ny" } }, [], "/repo", WT)
  const withChips = buildMessageWithContext("fix @guide.md:3\n/tmp/shot.png", [item({})], "/repo", WT)
  const sent = appendWorktreeNote(appendEditorContext(withChips, block), note)
  assert.equal(sent.endsWith(`\n\n${note}\n/tmp/shot.png`), true, sent)
  // The transcript: the note comes off, then the editor block and the chips parse exactly as before.
  const prose = withoutWorktreeNote(sent.slice(0, sent.lastIndexOf("\n/tmp/shot.png")))
  const parsed = parseSentEditorContext(prose)
  assert.deepEqual(parsed?.editor, { kind: "selection", display: "src/a.ts", startLine: 2, endLine: 3, text: "x\ny" })
  assert.equal(parseSentContext(parsed!.body)?.body, "fix @guide.md:3")
  // Taken back: the human's words, chips and attachment, with neither the block nor the note.
  assert.equal(withoutEditorContext(sent), withChips)
  // A note with no editor block (chips only) also comes off a take-back.
  assert.equal(withoutEditorContext(appendWorktreeNote(withChips, note)), withChips)
  // Only at the very end, and only the exact sentence: a human quoting it mid-message keeps it.
  assert.equal(withoutWorktreeNote(`${note}\n\nand then?`), `${note}\n\nand then?`)
  assert.equal(withoutWorktreeNote(`hi\n\n${note}`), "hi")
  assert.equal(withoutWorktreeNote("hi"), "hi")
  assert.equal(appendWorktreeNote("hi", ""), "hi")
})

test("a worktree thread's repeat-send: the note after the block does not hide the quote, and the reference keeps the worktree's path", () => {
  // Merge of vscode-r4-context (the repeat-send rule) and vscode-r4-worktrees (the note after the block):
  // the note is the prose's LAST paragraph, so the block parser alone would never find the quote under it.
  const note = worktreeNote(["/repo/src/a.ts"], "/repo", { dir: WT })
  const held = { path: "/repo/src/a.ts", selection: { startLine: 4, endLine: 5, text: "x\ny" } }
  const first = { role: "user", text: appendWorktreeNote(appendEditorContext("q", serializeEditorContext(held, [], "/repo", WT)), note) }
  const quote = previousEditorQuote([first])
  assert.deepEqual(quote, { display: "src/a.ts", startLine: 4, endLine: 5, text: "x\ny" })
  assert.equal(serializeEditorContext(held, [], "/repo", WT, quote), `${HEADER}\n\nStill selected in src/a.ts, lines 4-5 (quoted in an earlier message)`)
  // The worktree's own copy, relative to the worktree, dedupes against itself too.
  const own = { path: `${WT}/src/a.ts`, selection: { startLine: 4, endLine: 5, text: "x\ny" } }
  const ownQuote = previousEditorQuote([{ role: "user", text: appendEditorContext("q", serializeEditorContext(own, [], "/repo", WT)) }])
  assert.match(serializeEditorContext(own, [], "/repo", WT, ownQuote), /^.*\n\nStill selected in src\/a\.ts/)
})
