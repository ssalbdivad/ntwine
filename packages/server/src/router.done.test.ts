// THE COMPLETION VERB at the RPC boundary — the real router against real SQLite.
//
// `done` exists as a TOOL rather than a fence for exactly one reason: a gate can refuse a tool call,
// and a fence can only be bumped after the fact, by which time its card has already rendered
// (plans/rest-by-registration.md). So what these tests are about is the refusals, and the absence of
// any way around them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AskedQuestion, BoardSnapshot, Settings } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

function harness(tele?: Partial<SessionTelemetry>) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-done-rpc-"))
  const project: Project = { dir, id: "done", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot }, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => (tele ? (tele as SessionTelemetry) : undefined),
    foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    // addOwnPrWatch probes the PR before arming; this harness is about the registry, so every ref reads.
    probePr: async () => ({ ok: true as const }),
  } as unknown as AppContext
  return {
    storage, router: createRouter(ctx), refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-08-27T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const question: AskedQuestion = { question: "Ship it?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] }

test("done records the body and re-derives the board", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "- **Fixed** the thing" } })
    // `unwritten` too: this thread has no transcript, so nothing it wrote has reached the human.
    assert.deepEqual(result, { done: true, blockingQuestions: [], blockingWatches: [], unwritten: true })
    assert.deepEqual(h.storage.getThreadDone("t")?.body, "- **Fixed** the thing")
    assert.equal(h.refreshes() > 0, true, "the card only appears when the board re-derives")
  } finally { h.close() }
})

test("an OPEN QUESTION refuses it, and the refusal names the question by id", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const asked = await h.router.ask.handler({ input: { slug: "t", questions: [question] } })
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })
    assert.equal(result.done, false)
    assert.deepEqual(result.blockingQuestions, [{ id: asked.registered[0].id, question: "Ship it?" }])
    // NOTHING WAS RECORDED. A refusal that stored the body anyway would put the card on the board and
    // report a refusal to the worker — the two readers disagreeing about whether the thread finished.
    assert.equal(h.storage.getThreadDone("t"), undefined)

    // Withdrawing it is the escape hatch, and it is a DECISION rather than a flag: the worker is now on
    // record as having decided that question itself.
    await h.router.unask.handler({ input: { slug: "t", id: asked.registered[0].id } })
    assert.equal((await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })).done, true)
  } finally { h.close() }
})

test("an ARMED WATCH refuses it too, named by id and by what it is watching", async () => {
  // `addOwnWatch` refuses a target nothing live answers to, so the row goes in through storage — the
  // gate reads the registry, and how the row got there is not its business.
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.armThreadWatch({ id: "wch_aaa", slug: "t", kind: "shell", target: "bzvtnt3ig", createdAtMs: Date.now(), expiresAtMs: Date.now() + 7_200_000 })
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })
    assert.equal(result.done, false)
    assert.deepEqual(result.blockingWatches, [{ id: "wch_aaa", what: "shell: bzvtnt3ig" }])
    assert.equal(h.storage.getThreadDone("t"), undefined)

    await h.router.dropOwnWatch.handler({ input: { slug: "t", id: "wch_aaa" } })
    assert.equal((await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })).done, true)
  } finally { h.close() }
})

test("an armed TIMER refuses it — a thread with an alarm set has not finished", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const fireAt = new Date(Date.now() + 600_000).toISOString()
    const timer = await h.router.setOwnThreadTimer.handler({ input: { slug: "t", prompt: "check the build", fireAt } })
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })
    assert.equal(result.done, false)
    assert.deepEqual(result.blockingWatches.map((w) => w.id), [timer.id])
    assert.match(result.blockingWatches[0].what, /^timer, fires /)
  } finally { h.close() }
})

test("both kinds are reported at ONCE, so the worker clears them in one pass", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.ask.handler({ input: { slug: "t", questions: [question] } })
    h.storage.armThreadWatch({ id: "wch_bbb", slug: "t", kind: "agent", target: "agent-9", createdAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000 })
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })
    assert.equal(result.blockingQuestions.length, 1)
    assert.deepEqual(result.blockingWatches, [{ id: "wch_bbb", what: "sub-agent: agent-9" }])
  } finally { h.close() }
})

test("ANOTHER thread's open question does not block this one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    await h.router.ask.handler({ input: { slug: "other", questions: [question] } })
    assert.equal((await h.router.markOwnDone.handler({ input: { slug: "t", body: "done!" } })).done, true)
  } finally { h.close() }
})

test("calling it twice REPLACES the record — a worker done twice has not finished two things", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.markOwnDone.handler({ input: { slug: "t", body: "first" } })
    await h.router.markOwnDone.handler({ input: { slug: "t", body: "second" } })
    assert.equal(h.storage.getThreadDone("t")?.body, "second")
  } finally { h.close() }
})

test("an unregistered thread is an error, not a silently recorded completion", async () => {
  const h = harness()
  try {
    await assert.rejects(
      () => h.router.markOwnDone.handler({ input: { slug: "ghost", body: "done!" } }),
      /thread ghost is not registered/,
    )
  } finally { h.close() }
})

// A REGISTRATION TRUMPS A DONE (maintainer 2026-08-27: "done always gets trumped by a watcher or a
// question"). The gate stops a done landing on a live registration; these pin the other direction —
// a registration landing on a recorded done unmarks it, at the verb, so the board can never hold a
// finished thread that is also asking or waiting.
test("a question registered after a done clears the done", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.markOwnDone.handler({ input: { slug: "t", body: "- **Fixed** it" } })
    assert.ok(h.storage.getThreadDone("t"))
    await h.router.ask.handler({ input: { slug: "t", questions: [question] } })
    assert.equal(h.storage.getThreadDone("t"), undefined)
  } finally { h.close() }
})

test("a timer armed after a done clears the done", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.markOwnDone.handler({ input: { slug: "t", body: "- **Fixed** it" } })
    await h.router.setOwnThreadTimer.handler({ input: { slug: "t", prompt: "re-check the install", fireAt: new Date(Date.now() + 3_600_000).toISOString() } })
    assert.equal(h.storage.getThreadDone("t"), undefined)
  } finally { h.close() }
})

test("a PR watch registered after a done clears the done", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.markOwnDone.handler({ input: { slug: "t", body: "- **Fixed** it" } })
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    assert.equal(h.storage.getThreadDone("t"), undefined)
  } finally { h.close() }
})
