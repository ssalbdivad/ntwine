import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ProjectQueue } from "@ntwine/shared"
import { buildMessageWithContext, parseSentContext } from "./composerContext.ts"
import { draftKey } from "./drafts.ts"
import { composeEdit, composeProjectsOf, composeTarget, type ComposeProject } from "./editorCompose.ts"

const alpha: ComposeProject = { id: "p-alpha", slug: "alpha", name: "Alpha", projectDir: "/work/alpha", open: true }
const beta: ComposeProject = { id: "p-beta", slug: "beta", name: "Beta", projectDir: "/work/beta", open: true }
const gone: ComposeProject = { id: "p-gone", slug: "gone", name: "Gone", open: false }
const projects = [alpha, beta, gone]
const board = { projectDir: "/work/alpha", projectSlug: "alpha" }

test("an open thread drawer takes the item, whatever project the item names", () => {
  for (const projectId of ["p-beta", "p-unknown", undefined]) {
    assert.deepEqual(
      composeTarget({ item: { projectId }, thread: { slug: "fix-auth", sessionId: "s2" }, board, pageSlug: "alpha", view: "all", projects }),
      { kind: "thread", slug: "fix-auth", key: draftKey.followUp("/work/alpha", "fix-auth", "s2"), projectDir: "/work/alpha" },
      String(projectId),
    )
  }
  // Negative control: with no board to key the drawer's draft by, it is not a reply-box target.
  assert.equal(composeTarget({ item: { projectId: "p-alpha" }, thread: { slug: "fix-auth" }, pageSlug: "alpha", view: "all", projects }).kind, "new")
})

test("the item's own project's new-thread box, moving the page the way the page itself would", () => {
  // Already the page's project: nothing moves.
  assert.deepEqual(composeTarget({ item: { projectId: "p-alpha" }, board, pageSlug: "alpha", view: "project", projects }),
    { kind: "new", key: draftKey.dispatch("/work/alpha"), projectDir: "/work/alpha", move: { kind: "stay" } })
  // Focused on another project: focus this one.
  assert.deepEqual(composeTarget({ item: { projectId: "p-beta" }, board, pageSlug: "alpha", view: "project", projects }),
    { kind: "new", key: draftKey.dispatch("/work/beta"), projectDir: "/work/beta", move: { kind: "focus", slug: "beta" } })
  // All projects: make it the pick.
  assert.deepEqual(composeTarget({ item: { projectId: "p-beta" }, board, pageSlug: "alpha", view: "all", projects }),
    { kind: "new", key: draftKey.dispatch("/work/beta"), projectDir: "/work/beta", move: { kind: "pick", id: "p-beta", slug: "beta" } })
})

test("an item with no project goes to the page's own box", () => {
  assert.deepEqual(composeTarget({ item: {}, board, pageSlug: "alpha", view: "all", projects }),
    { kind: "new", key: draftKey.dispatch("/work/alpha"), projectDir: "/work/alpha", move: { kind: "stay" } })
  // …and when the project list could not be read, the live board still names the box.
  assert.deepEqual(composeTarget({ item: {}, board, pageSlug: "alpha", view: "all", projects: [] }),
    { kind: "new", key: draftKey.dispatch("/work/alpha"), projectDir: "/work/alpha", move: { kind: "stay" } })
  assert.equal(composeTarget({ item: {}, pageSlug: undefined, view: "all", projects: [] }).kind, "refused")
})

test("a project this server has not open, or one ntwine does not know, is refused with the reason", () => {
  assert.deepEqual(composeTarget({ item: { projectId: "p-gone" }, board, pageSlug: "alpha", view: "all", projects }),
    { kind: "refused", reason: "Gone isn't open on this server." })
  assert.deepEqual(composeTarget({ item: { projectId: "p-nobody" }, board, pageSlug: "alpha", view: "all", projects }),
    { kind: "refused", reason: "Its project isn't in ntwine." })
})

test("composeProjectsOf: open means a board is open AND the folder is there", () => {
  const card = (id: string, slug: string, stale = false) => ({ id, slug, name: slug.toUpperCase(), path: `/work/${slug}`, lastOpenedAt: "", stale, iconStatus: "none" }) as ProjectCard
  const queue = (projectId: string, projectDir: string) => ({ projectId, projectSlug: "", projectName: "", projectDir, threads: [], doneCount: 0 }) as ProjectQueue
  assert.deepEqual(composeProjectsOf([card("a", "a"), card("b", "b"), card("c", "c", true)], [queue("a", "/work/a"), queue("c", "/work/c")]), [
    { id: "a", slug: "a", name: "A", open: true, projectDir: "/work/a" },
    { id: "b", slug: "b", name: "B", open: false },
    { id: "c", slug: "c", name: "C", open: false, projectDir: "/work/c" },
  ])
})

const selection = { path: "/work/alpha/src/a.ts", text: "const a = 1\nconst b = 2", startLine: 12, endLine: 20 }

test("a selection becomes a ⌘I chip at the end of the prose, staged under the same draft", () => {
  assert.deepEqual(composeEdit({ value: "", staged: [], item: selection, projectDir: "/work/alpha" }), {
    value: "@a.ts:12-20 ",
    caret: 12,
    stage: { token: "@a.ts:12-20", path: "/work/alpha/src/a.ts", text: "const a = 1\nconst b = 2", startLine: 12, endLine: 20 },
  })
  const next = composeEdit({ value: "Why does this fail", staged: [], item: selection, projectDir: "/work/alpha" })
  assert.equal(next.value, "Why does this fail @a.ts:12-20 ")
  assert.equal(next.caret, next.value.length)
  // One line, and a selection with no line at all.
  assert.equal(composeEdit({ value: "", staged: [], item: { ...selection, endLine: undefined }, projectDir: undefined }).stage?.token, "@a.ts:12")
  assert.equal(composeEdit({ value: "", staged: [], item: { path: "/x/a.ts", text: "whole file" }, projectDir: undefined }).stage?.token, "@a.ts")
})

test("a second selection on the same lines never fuses with the first", () => {
  const first = composeEdit({ value: "", staged: [], item: selection, projectDir: "/work/alpha" })
  const second = composeEdit({ value: first.value, staged: [first.stage!], item: selection, projectDir: "/work/alpha" })
  assert.equal(second.stage?.token, "@a.ts:12-20#2")
  assert.equal(second.value, "@a.ts:12-20 @a.ts:12-20#2 ")
})

test("the insert goes into the prose: a draft's trailing attachment lines stay trailing", () => {
  const edit = composeEdit({ value: "see the shot\n/work/alpha/shot.png", staged: [], item: selection, projectDir: "/work/alpha" })
  assert.equal(edit.value, "see the shot @a.ts:12-20 \n/work/alpha/shot.png")
  assert.equal(edit.caret, "see the shot @a.ts:12-20 ".length)
})

test("a reference with no text is inline code, relative to the project when inside it", () => {
  const ref = (item: Parameters<typeof composeEdit>[0]["item"], projectDir = "/work/alpha") => composeEdit({ value: "", staged: [], item, projectDir }).value
  assert.equal(ref({ path: "/work/alpha/src/a.ts", startLine: 12 }), "`src/a.ts:12` ")
  assert.equal(ref({ path: "/work/alpha/src/a.ts", startLine: 12, endLine: 20 }), "`src/a.ts:12-20` ")
  assert.equal(ref({ path: "/work/alpha/src/a.ts" }), "`src/a.ts` ")
  assert.equal(ref({ path: "/elsewhere/b.ts", startLine: 3 }), "`/elsewhere/b.ts:3` ")
  assert.equal(ref({ path: "C:\\work\\alpha\\src\\a.ts", startLine: 4 }, "C:\\work\\alpha"), "`src\\a.ts:4` ")
  // Whitespace is no selection: it is a reference, not an empty chip.
  const blank = composeEdit({ value: "", staged: [], item: { path: "/work/alpha/src/a.ts", text: "  \n", startLine: 7 }, projectDir: "/work/alpha" })
  assert.equal(blank.stage, undefined)
  assert.equal(blank.value, "`src/a.ts:7` ")
  // An inverted range reads as its start line.
  assert.equal(ref({ path: "/work/alpha/src/a.ts", startLine: 9, endLine: 3 }), "`src/a.ts:9` ")
})

// The point of the chip being the ⌘I token: what the human sends is what the transcript renders as chips.
test("the inserted chip sends as the ⌘I serialization the transcript parses back", () => {
  const edit = composeEdit({ value: "Why does this fail", staged: [], item: selection, projectDir: "/work/alpha" })
  const sent = buildMessageWithContext(edit.value.trim(), [{ id: 1, ...edit.stage! }], "/work/alpha")
  assert.equal(sent, "Why does this fail @a.ts:12-20\n\nSelected context:\n\n@a.ts:12-20 (src/a.ts, lines 12-20):\n> const a = 1\n> const b = 2")
  assert.deepEqual(parseSentContext(sent), {
    body: "Why does this fail @a.ts:12-20",
    items: [{ token: "@a.ts:12-20", display: "src/a.ts", startLine: 12, endLine: 20, text: "const a = 1\nconst b = 2" }],
  })
})

// "Ask ntwine to fix" sends the problem's own message as `note` (embed-protocol.ts): the box reads as a
// request rather than a bare reference, and the human types straight on after it.
test("a note goes right after the chip, one space either side, and the caret after it", () => {
  const fix = composeEdit({ value: "", staged: [], item: { ...selection, startLine: 12, endLine: 12 }, projectDir: "/work/alpha", note: "Fix: Cannot find name 'foo'. ts(2304)" })
  assert.equal(fix.value, "@a.ts:12 Fix: Cannot find name 'foo'. ts(2304) ")
  assert.equal(fix.caret, fix.value.length)
  assert.equal(fix.stage?.token, "@a.ts:12")
  // After what is already in the box, and before its trailing attachment lines.
  const after = composeEdit({ value: "First this.\n/work/alpha/shot.png", staged: [], item: selection, projectDir: "/work/alpha", note: "  Fix: it  " })
  assert.equal(after.value, "First this. @a.ts:12-20 Fix: it \n/work/alpha/shot.png")
  assert.equal(after.caret, "First this. @a.ts:12-20 Fix: it ".length)
  // A reference with no text takes it the same way; an empty note is no note.
  assert.equal(composeEdit({ value: "", staged: [], item: { path: "/work/alpha/src/a.ts", startLine: 3 }, projectDir: "/work/alpha", note: "Fix: x" }).value, "`src/a.ts:3` Fix: x ")
  assert.equal(composeEdit({ value: "", staged: [], item: selection, projectDir: "/work/alpha", note: "   " }).value, "@a.ts:12-20 ")
  // The note is prose: it rides the send in the body, before the definitions.
  const sent = buildMessageWithContext(fix.value.trim(), [{ id: 1, ...fix.stage! }], "/work/alpha")
  assert.equal(parseSentContext(sent)?.body, "@a.ts:12 Fix: Cannot find name 'foo'. ts(2304)")
})

test("a terminal selection is an @terminal chip with no lines, and a second one is @terminal#2", () => {
  const term = { path: "terminal", text: "$ npm test\nFAIL", startLine: 40, endLine: 41 }
  const first = composeEdit({ value: "Why", staged: [], item: term, projectDir: "/work/alpha" })
  assert.deepEqual(first, { value: "Why @terminal ", caret: 14, stage: { token: "@terminal", path: "terminal", text: "$ npm test\nFAIL" } })
  const second = composeEdit({ value: first.value, staged: [first.stage!], item: term, projectDir: "/work/alpha" })
  assert.equal(second.value, "Why @terminal @terminal#2 ")
  const sent = buildMessageWithContext(second.value.trim(), [{ id: 1, ...first.stage! }, { id: 2, ...second.stage! }], "/work/alpha")
  assert.equal(sent, "Why @terminal @terminal#2\n\nSelected context:\n\n@terminal (terminal):\n> $ npm test\n> FAIL\n\n@terminal#2 (terminal):\n> $ npm test\n> FAIL")
  assert.equal(parseSentContext(sent)?.items.length, 2)
})
