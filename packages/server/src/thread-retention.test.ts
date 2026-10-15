// DELETING THREADS at the RPC boundary — the real router against real SQLite and a real project folder.
//
// What a delete has to buy is the reason it exists: the slug is free again (the next "Shell budgets"
// is `shell-budgets`, not `shell-budgets-2`), the `@handle` no longer resolves, and nothing ntwine keeps
// for the thread survives it. The bulk and automatic doors must take exactly the done threads the
// predicate names — counted from when the HUMAN last touched them, never the agent's own activity — and
// nothing open, recently touched or pinned.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import { resolveSlug } from "./dispatch.ts"
import type { Project } from "./project.ts"
import { createRouter, deleteExpiredDoneThreads } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import { resolveThreadHandle } from "./thread-mentions.ts"
import { projectThreadNames } from "./thread-names.ts"
import { DAY_MS, expiredDoneThreads } from "./thread-retention.ts"

const NOW = Date.parse("2026-09-30T12:00:00.000Z")
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString()

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-thread-delete-"))
  const project: Project = { dir, id: "del", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailerForgot: string[] = []
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: (slug: string) => { tailerForgot.push(slug) }, start: () => {}, stop: () => {}, tick: () => {},
  }
  const terminalsForgot: string[] = []
  const ctx = {
    project, storage, board, tailer,
    // No lifecycle verb on the runner: the terminal threads a deleted thread started are threads of their own.
    terminalRunner: { live: () => [], has: () => false },
    // Worktree cleanup is off here: it is its own feature, with its own tests.
    getSettings: () => ({}) as unknown as Settings,
  } as unknown as AppContext
  return {
    dir, storage, ctx, tailerForgot, terminalsForgot,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: daysAgo(60),
    last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const done = (slug: string, over: Partial<SessionRow> = {}) => row(slug, { state: "archived", archived: 1, ...over })

/** The upsert writes a dispatch's columns only; rest time and state have writers of their own. */
function seed(storage: ReturnType<typeof createStorage>, slug: string, opts: { done?: boolean; interactedAt?: string; title?: string } = {}) {
  storage.upsertSession(row(slug, opts.title ? { title: opts.title, title_locked: 1 } : {}))
  if (opts.interactedAt) storage.setInteractedAt(slug, opts.interactedAt)
  if (opts.done) storage.setState(slug, "archived")
}

test("deleting a thread frees its slug and its @handle, and removes everything ntwine kept for it", async () => {
  const h = harness()
  try {
    seed(h.storage, "shell-budgets", { done: true, title: "Shell budgets" })
    h.storage.markThreadDone("shell-budgets", "- shipped", NOW)
    const scratch = join(h.dir, ".ntwine", "threads", "sid-shell-budgets")
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, "notes.md"), "notes")
    const ntwineDir = join(h.dir, ".ntwine")
    const taken = (s: string) => h.storage.getSession(s) !== undefined
    // The control: while it exists, the next thread of that name is pushed to -2 and the handle finds it.
    assert.equal(resolveSlug(ntwineDir, "shell-budgets", taken), "shell-budgets-2")
    assert.equal(resolveThreadHandle("@shell-budgets", projectThreadNames(h.storage.allSessions()))?.slug, "shell-budgets")

    await h.router.deleteThread.handler({ input: { slug: "shell-budgets" } })

    assert.equal(h.storage.getSession("shell-budgets"), undefined)
    assert.equal(h.storage.getThreadDone("shell-budgets"), undefined)
    assert.equal(resolveSlug(ntwineDir, "shell-budgets", taken), "shell-budgets")
    assert.equal(resolveThreadHandle("@shell-budgets", projectThreadNames(h.storage.allSessions())), undefined)
    assert.equal(existsSync(scratch), false, "the scratch directory goes with the thread")
    assert.ok(h.storage.forgottenIds().has("sid-shell-budgets"), "its transcript is tombstoned so discovery cannot bring it back")
    assert.deepEqual(h.tailerForgot, ["shell-budgets"])
    assert.deepEqual(h.terminalsForgot, [], "the terminals it started stay, on their own rows")
    assert.equal(h.refreshes(), 1)

    // Idempotent: a second delete is a no-op, not an error, and rebuilds nothing.
    await h.router.deleteThread.handler({ input: { slug: "shell-budgets" } })
    assert.equal(h.refreshes(), 1)
  } finally { h.close() }
})

test("an open thread can be deleted too — the old exited-only gate is gone", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("in-flight", { exited: 0 }))
    await h.router.deleteThread.handler({ input: { slug: "in-flight" } })
    assert.equal(h.storage.getSession("in-flight"), undefined)
  } finally { h.close() }
})

test("only done, unpinned threads the human has not touched past the cutoff expire", () => {
  const rows = [
    // The agent rested yesterday, but nobody has touched it in 40 days: the agent's activity is not an interaction.
    done("untouched-busy-agent", { interacted_at: daysAgo(40), rested_at: daysAgo(1) }),
    // Dispatched and never touched again: the dispatch is the last touch.
    done("never-touched", { spawned_at: daysAgo(40) }),
    done("acted-on-recently", { interacted_at: daysAgo(2) }),
    // Rows older than `interacted_at` carry their history in the open and read stamps.
    done("opened-recently", { seen_at: daysAgo(2) }),
    done("read-recently", { last_read_at: daysAgo(2) }),
    done("old-pinned", { interacted_at: daysAgo(40), pinned_at: daysAgo(40) }),
    row("old-open", { interacted_at: daysAgo(40) }),
  ]
  assert.deepEqual(expiredDoneThreads(rows, 30, NOW).map((r) => r.slug), ["untouched-busy-agent", "never-touched"])
  assert.deepEqual(expiredDoneThreads(rows, 0, NOW), [], "0 days is never")
})

test("the retention sweep deletes exactly the expired set, with one rebuild for the whole batch", async () => {
  const h = harness()
  try {
    // spawned_at is 60 days back for every row, so the last interaction decides.
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()
    seed(h.storage, "old-done", { done: true, interactedAt: ago(40) })
    seed(h.storage, "old-done-2", { done: true, interactedAt: ago(35) })
    seed(h.storage, "recent-done", { done: true, interactedAt: ago(1) })
    seed(h.storage, "old-open", { interactedAt: ago(40) })

    assert.equal(await deleteExpiredDoneThreads(h.ctx, 30), 2)
    assert.deepEqual(h.storage.allSessions().map((r) => r.slug).sort(), ["old-open", "recent-done"])
    assert.equal(h.refreshes(), 1, "one rebuild for the whole batch")
  } finally { h.close() }
})

test("the retention sweep's delete takes the same set, and does nothing at 0", async () => {
  const h = harness()
  try {
    seed(h.storage, "old-done", { done: true, interactedAt: daysAgo(10) })
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 0, NOW), 0)
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 30, NOW), 0)
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 7, NOW), 1)
    assert.equal(h.storage.getSession("old-done"), undefined)
  } finally { h.close() }
})

test("a human verb stamps the interaction clock; a worker's own verb does not", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    assert.equal(h.storage.getSession("t")?.interacted_at ?? null, null)
    // The worker tidying its own links is the agent at work, not the human.
    await h.router.dropOwnLink.handler({ input: { slug: "t", id: "lnk_missing" } })
    assert.equal(h.storage.getSession("t")?.interacted_at ?? null, null)
    const before = Date.now()
    await h.router.threadSeen.handler({ input: { slug: "t" } })
    const at = Date.parse(h.storage.getSession("t")?.interacted_at ?? "")
    assert.ok(at >= before, "opening the thread is the human touching it")
  } finally { h.close() }
})
