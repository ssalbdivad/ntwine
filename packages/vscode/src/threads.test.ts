import { test } from "node:test"
import assert from "node:assert/strict"
import { threadHandle as sharedThreadHandle } from "@ntwine/shared"
// The page's originals, run beside the ports over the same rows (groups.ts loads under node).
import { displayTitle as pageDisplayTitle, threadHandleOf as pageThreadHandleOf } from "../../web/src/groups.ts"
import { bandOf, displayTitle, findThread, pickerThreads, threadHandle, threadHandleOf, threadItem, windowThread, windowThreadFirst, type PickerThread } from "./threads.ts"

const LONG_AGO = "2026-01-01T00:00:00.000Z"
const justNow = () => new Date(Date.now() - 2_000).toISOString()

function row(id: string, extra: Partial<PickerThread> = {}): PickerThread {
  return { id, title: id, kind: "session", state: "open", sessionId: `s-${id}`, runtime: "turn-idle", spawnedAt: LONG_AGO, ...extra } as PickerThread
}

// Every branch of the page's title provenance: a persisted name, a live unnamed session title, a
// human rename over a machine title, the spin-up and Codex placeholders, a legacy row, an external
// session, and names too long to be a handle.
const TITLE_ROWS: PickerThread[] = [
  row("a1", { title: "a1", titleAuto: true, aiTitle: "Shell budgets", titleNamed: true }),
  row("a2", { title: "a2", titleAuto: true, aiTitle: "fix-the-auth-flow", titleNamed: false }),
  row("a3", { title: "Human rename", titleAuto: false, titleLocked: true, aiTitle: "Machine name" }),
  row("a4", { title: "a4", titleAuto: true, spawnedAt: justNow() }),
  row("a5", { title: "a5", titleAuto: true, backend: "codex", spawnedAt: justNow() }),
  row("a6", { title: "a6", titleAuto: true, backend: "codex" }),
  row("a7", { title: "a7", titleAuto: true }),
  row("a8", { title: "Legacy title", kind: "legacy" }),
  row("a9", { title: "My terminal session", foreign: true }),
  row("b1", { title: "This title is far too long to be a handle", titleAuto: false }),
  row("b2", { title: "ArkType perf", titleAuto: false, titleNamed: true }),
  row("b3", { title: "", titleAuto: undefined }),
  row("b4", { title: "some-generated-slug", titleAuto: true, titleNamed: true }),
  row("b5", { title: "Café élan", titleAuto: false }),
  // A HELD thread (a schedule's next run, an orphan) written down seconds ago: no placeholder.
  row("b6", { title: "Audit the flaky resume test…", titleAuto: true, titleNamed: false, held: "schedules", spawnedAt: justNow() }),
  row("b7", { title: "b7", titleAuto: true, backend: "codex", held: "lazy", spawnedAt: justNow() }),
]

test("thread names and @handles match the page's displayTitle / threadHandleOf on every provenance branch", () => {
  for (const t of TITLE_ROWS) {
    const page = { ...t, status: "active" } as Parameters<typeof pageDisplayTitle>[0]
    assert.equal(displayTitle(t), pageDisplayTitle(page), `displayTitle ${t.id}`)
    assert.equal(threadHandleOf(t), pageThreadHandleOf(page), `threadHandleOf ${t.id}`)
  }
  // The matrix reaches both outcomes, so agreement above is not agreement on one constant.
  assert.ok(TITLE_ROWS.some((t) => threadHandleOf(t)) && TITLE_ROWS.some((t) => !threadHandleOf(t)))
})

test("threadHandle matches @ntwine/shared's", () => {
  for (const name of ["Shell budgets", "ArkType perf", "GitHub", "dev-ops", "Café élan", "one two three four five", "one two three four five six", "", "  ", "x_y.z"]) {
    assert.equal(threadHandle(name), sharedThreadHandle(name), name)
  }
})

test("the picker offers open Ntwine sessions only: Ready first, then working, then the rest, newest first in each", () => {
  const threads = [
    row("rest-old", { lastActivityAt: "2026-09-01T00:00:00Z" }),
    row("ready-old", { needsYou: true, lastActivityAt: "2026-09-02T00:00:00Z" }),
    row("working", { runtime: "running", lastActivityAt: "2026-09-03T00:00:00Z" }),
    row("rest-new", { lastActivityAt: "2026-09-05T00:00:00Z" }),
    row("ready-new", { needsYou: true, lastActivityAt: "2026-09-04T00:00:00Z" }),
    row("spawning", { runtime: "spawning", spawnedAt: "2026-09-06T00:00:00Z" }),
    row("done", { state: "archived", needsYou: true }),
    row("external", { foreign: true, needsYou: true }),
    row("legacy", { kind: "legacy" }),
    row("no-session", { sessionId: undefined }),
  ]
  assert.deepEqual(pickerThreads(threads).map((t) => t.id), ["ready-new", "ready-old", "spawning", "working", "rest-new", "rest-old"])
  assert.equal(bandOf({ needsYou: true, runtime: "running" }), "ready", "the queue outranks a spinner")
})

test("a command argument names a thread by its slug or its handle, with or without the @", () => {
  const threads = [row("abc-123", { title: "Shell budgets", titleAuto: false }), row("shell-budgets", { title: "Other", titleAuto: false })]
  assert.equal(findThread(threads, "abc-123")?.id, "abc-123")
  assert.equal(findThread(threads, "shell-budgets")?.id, "shell-budgets", "an exact slug wins over another thread's handle")
  assert.equal(findThread(threads, "@Shell-Budgets")?.id, "abc-123")
  assert.equal(findThread(threads, "@other")?.id, "shell-budgets")
  assert.equal(findThread(threads, "nope"), undefined)
})

test("a picker row shows the @handle, where the thread stands, and what it is doing", () => {
  assert.deepEqual(threadItem(row("t1", { title: "Shell budgets", titleAuto: false, needsYou: true, statusLine: "Waiting on your answer" })), {
    label: "@shell-budgets",
    description: "Ready",
    detail: "Waiting on your answer",
  })
  assert.deepEqual(threadItem(row("t2", { title: "t2", titleAuto: true, runtime: "running", lastAssistant: "Reading\n  the  file" })), {
    label: "Untitled thread",
    description: "Working",
    detail: "Reading the file",
  })
  assert.equal(threadItem(row("t3", { title: "x", titleAuto: false, lastAssistant: "y".repeat(300) })).detail?.length, 140)
})

// A window opened on a thread's worktree is about that thread: the sidebar opens on it and Send offers it
// first. Matched by folder identity (the extension passes a realpath comparison), never by name.
test("a window whose folder is a thread's worktree finds that thread; a window on the root finds none", () => {
  const tree = "/repo/.ntwine/worktrees/tidy"
  const same = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")
  const threads = [
    row("root-thread", { needsYou: true }),
    row("tidy", { checkout: { dir: tree, kind: "worktree" }, lastActivityAt: "2026-09-01T00:00:00Z" }),
    // A spinoff child working on in its parent's worktree, waiting on the human: listed first, so chosen.
    row("tidy-child", { checkout: { dir: tree, kind: "worktree" }, needsYou: true, lastActivityAt: "2026-08-01T00:00:00Z" }),
    row("tidy-done", { checkout: { dir: tree, kind: "worktree" }, state: "archived", needsYou: true }),
    row("other", { checkout: { dir: "/repo/.ntwine/worktrees/other", kind: "worktree" } }),
  ]
  assert.equal(windowThread(threads, [`${tree}/`], same)?.id, "tidy-child")
  assert.equal(windowThread(threads.filter((t) => t.id !== "tidy-child"), [tree], same)?.id, "tidy")
  assert.equal(windowThread(threads, ["/repo"], same), undefined, "the project root is no thread's own")
  assert.equal(windowThread(threads, [`${tree}/packages/web`], same), undefined, "a folder inside the worktree is not the worktree")
  assert.equal(windowThread(threads.filter((t) => t.id.startsWith("tidy-done")), [tree], same), undefined, "a thread marked done is not offered")
  assert.equal(windowThread(threads, [], same), undefined)

  const listed = pickerThreads(threads)
  assert.deepEqual(windowThreadFirst(listed, listed.find((t) => t.id === "other")).map((t) => t.id), ["other", "tidy-child", "root-thread", "tidy"])
  assert.deepEqual(windowThreadFirst(listed, undefined).map((t) => t.id), listed.map((t) => t.id))
})
