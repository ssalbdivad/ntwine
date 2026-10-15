// SOURCE 14 — background shells left running behind a QUESTION rest, whose card hides them.
//
// The case it was written for (2026-09-29): a worker `TaskStop`ped the Workflow a 6-hour poller shell
// was waiting on, never stopped the poller, and rested on a commit question. The question card drew
// nothing about the shell; the human learned of it only from "Mark as done"'s end-session warning.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

const POLLER = { id: "toolu_poller", taskId: "b7hi00yp4", label: "Waiting for the example-building workflow to finish", startedAt: "2026-09-29T14:06:22.000Z", state: "running" as const }

function harness(tele: Partial<SessionTelemetry>, opts: { question?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-stray-shells-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // This file pins SOURCE 14 alone; SOURCE 9 would otherwise nudge the question-less control case.
  storage.setSetting("signoffNudge", "off")
  if (opts.question !== false) {
    storage.askThreadQuestion({ id: "qst_commit", slug, spec: JSON.stringify({ question: "Commit them?", kind: "question" }), askedAtMs: Date.parse("2026-09-29T14:42:35.000Z") })
  }
  const live: Partial<SessionTelemetry> = {
    turn: "idle", lastActivityAt: "2026-09-29T14:42:36.000Z", lastAssistantAt: "2026-09-29T14:42:36.000Z",
    lastHumanAt: "2026-09-29T14:38:20.000Z", subAgents: [], bgShells: [POLLER], pendingQuestion: false, permPrompt: false,
    ...tele,
  }
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer: { get: () => live } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  const rows = () => storage.db
    .prepare("SELECT fence_id, state FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'stray-shells:%' ORDER BY created_at, id")
    .all(slug) as { fence_id: string; state: string }[]
  return { s, storage, slug, live, delivered, rows, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a question rest with a live shell is told to stop it, by the id the runtime showed it, once", async () => {
  const h = harness({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /`b7hi00yp4` — Waiting for the example-building workflow to finish/)
    assert.match(h.delivered[0], /TaskStop/)
    assert.match(h.delivered[0], /question stays open/)
    // Same set on the next rest: a shell the worker kept on purpose is asked about once, not every rest.
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    // A NEW shell is a new set, and is asked about in turn.
    h.live.bgShells = [POLLER, { ...POLLER, id: "toolu_dev", taskId: "bdev00001", label: "Serving the dev server" }]
    await h.s.tick()
    assert.equal(h.delivered.length, 2)
    assert.match(h.delivered[1], /2 background shells/)
  } finally { h.close() }
})

test("no question, no message — a bare rest lists its shells in SOURCE 9, and a park draws them itself", async () => {
  const h = harness({}, { question: false })
  try {
    await h.s.tick()
    assert.deepEqual(h.rows(), [])
  } finally { h.close() }
})

// A question the human typed past holds nothing (board.heldQuestionRows): still open, but no sign-off for
// the rest after their message, so no card hides the shell and this stays quiet.
test("a question the human typed past is not the rest's sign-off, so it does not trigger this", async () => {
  const h = harness({ lastHumanAt: "2026-09-29T14:50:00.000Z", lastUserAt: "2026-09-29T14:50:00.000Z", lastAssistantAt: "2026-09-29T14:51:00.000Z" })
  try {
    await h.s.tick()
    assert.deepEqual(h.rows(), [])
  } finally { h.close() }
})

test("a shell under an armed watch is kept on purpose and is not listed", async () => {
  const h = harness({})
  try {
    h.storage.armThreadWatch({ id: "wch_poller", slug: h.slug, kind: "shell", target: "b7hi00yp4", createdAtMs: Date.now(), expiresAtMs: Date.now() + 3600_000 })
    await h.s.tick()
    assert.deepEqual(h.rows(), [])
  } finally { h.close() }
})

test("a shell stopped before the message goes out supersedes it", async () => {
  const h = harness({ bgShells: [] })
  try {
    createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 }).enqueue({
      id: "stray", slug: h.slug, sessionId: "sid", fenceId: `stray-shells:${JSON.stringify(["toolu_poller"])}`,
      hintKey: "stray", message: "Do not deliver", reason: "queued before the worker stopped the shell",
    }, Date.parse("2026-09-29T14:42:40.000Z"))
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.rows().map((r) => r.state), ["superseded"])
  } finally { h.close() }
})
