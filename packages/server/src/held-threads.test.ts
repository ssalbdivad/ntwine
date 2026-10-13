// HELD THREADS (SessionRow.held_by): base's one primitive for a thread written down with no agent behind it,
// and the migration that moved "unstarted" off `lazy_prompt` onto it.
//
// Real SQLite throughout. The migration cases build the database a PREVIOUS build left — the session table
// with no `held_by` column at all — rather than asserting on the statements, because what has to hold is
// that the operator's existing rows come through: none lost, none stranded, `lazy_prompt` untouched.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadView } from "@ntwine/shared"
import Database from "./sqlite.ts"
import { createStorage, isHeldRow, isScheduleHeldRow, type SessionRow } from "./storage.ts"
import { heldThreadView } from "./board.ts"

const row = (slug: string, patch: Partial<SessionRow> = {}): SessionRow => ({
  slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-10-01T00:00:00.000Z",
  last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title: slug,
  state: "open", meta: null, seen_at: null, transcript_id: null, ...patch,
})

/** A database as the build before held rows left it: same rows, no `held_by` column. */
function legacyDatabase(rows: SessionRow[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-held-migrate-"))
  const file = join(dir, "ui.db")
  const storage = createStorage(file, "p")
  for (const r of rows) storage.upsertSession(r)
  storage.close()
  const raw = new Database(file)
  raw.exec("ALTER TABLE session DROP COLUMN held_by")
  raw.close()
  return { dir, file }
}

function columns(file: string, legacy = false): { slug: string; lazy_prompt: string | null; held_by?: string | null; schedule_id: string | null }[] {
  const raw = new Database(file)
  try {
    return raw.prepare(`SELECT slug, lazy_prompt, ${legacy ? "" : "held_by, "}schedule_id FROM session ORDER BY slug`).all() as never
  } finally { raw.close() }
}

test("the migration holds every legacy unstarted row, leaves its note where it was, and is idempotent", () => {
  const { dir, file } = legacyDatabase([
    row("a-note", { lazy_prompt: "Look into the flaky resume test" }),
    row("b-empty-note", { lazy_prompt: "" }),
    row("c-next-run", { lazy_prompt: "triage new issues", schedule_id: "sch_aaaaaaaaaaaa", snoozed_until: "2026-10-12T09:00:00.000Z" }),
    row("d-started", { lazy_prompt: null, exited: 0 }),
    row("e-started-run", { lazy_prompt: null, schedule_id: "sch_aaaaaaaaaaaa" }),
    row("f-archived-note", { lazy_prompt: "an old note", state: "archived", archived: 1 }),
  ])
  try {
    const before = columns(file, true)
    assert.equal(before.length, 6)
    // `lazy` is legacy data: the holder id the migration gives a plain unstarted row, from lazy threads
    // (removed 2026-10-07). Nothing answers to it now, so those rows wait unstarted until a message.
    const expected = [
      { slug: "a-note", lazy_prompt: "Look into the flaky resume test", held_by: "lazy", schedule_id: null },
      { slug: "b-empty-note", lazy_prompt: "", held_by: "lazy", schedule_id: null },
      { slug: "c-next-run", lazy_prompt: "triage new issues", held_by: "schedules", schedule_id: "sch_aaaaaaaaaaaa" },
      { slug: "d-started", lazy_prompt: null, held_by: null, schedule_id: null },
      { slug: "e-started-run", lazy_prompt: null, held_by: null, schedule_id: "sch_aaaaaaaaaaaa" },
      { slug: "f-archived-note", lazy_prompt: "an old note", held_by: "lazy", schedule_id: null },
    ]
    for (let open = 0; open < 3; open++) {
      const storage = createStorage(file, "p")
      assert.equal(storage.allSessions().length, 6, "no row is lost")
      assert.equal(isHeldRow(storage.getSession("a-note")), true)
      assert.equal(isScheduleHeldRow(storage.getSession("c-next-run")), true)
      assert.equal(isHeldRow(storage.getSession("d-started")), false)
      storage.close()
      assert.deepEqual(columns(file), expected, `open #${open + 1}`)
    }
    // `lazy_prompt` and `schedule_id` are exactly what they were: the migration only ever writes held_by.
    assert.deepEqual(columns(file).map(({ slug, lazy_prompt, schedule_id }) => ({ slug, lazy_prompt, schedule_id })), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a held row an OLDER server started after a rollback reads as started on the next open", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-held-rollback-"))
  try {
    const file = join(dir, "ui.db")
    const storage = createStorage(file, "p")
    storage.upsertSession(row("note", { lazy_prompt: "draft", held_by: "lazy" }))
    storage.upsertSession(row("still-held", { lazy_prompt: "draft two", held_by: "lazy" }))
    storage.close()
    // The older build's dispatch upsert names only the column it knows: it clears lazy_prompt and never
    // touches held_by, which it has never heard of.
    const raw = new Database(file)
    raw.exec("UPDATE session SET lazy_prompt = NULL, exited = 0 WHERE slug = 'note'")
    raw.close()
    const reopened = createStorage(file, "p")
    assert.equal(reopened.getSession("note")?.held_by, null, "started, so no longer held")
    assert.equal(isHeldRow(reopened.getSession("note")), false)
    assert.equal(reopened.getSession("still-held")?.held_by, "lazy", "an untouched held row stays held")
    assert.equal(reopened.getSession("still-held")?.lazy_prompt, "draft two")
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("setHeldPrompt rewrites only a held row's prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-held-prompt-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  try {
    storage.upsertSession(row("held", { lazy_prompt: "first", held_by: "lazy" }))
    storage.upsertSession(row("live"))
    assert.equal(storage.setHeldPrompt("held", "sid-held", "second"), true)
    assert.equal(storage.getSession("held")?.lazy_prompt, "second")
    assert.equal(storage.setHeldPrompt("held", "another-session", "third"), false, "guarded on the session id")
    assert.equal(storage.setHeldPrompt("live", "sid-live", "nope"), false, "a started thread has no held prompt")
    assert.equal(storage.getSession("live")?.lazy_prompt, null)
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("base never queues a held thread whose holder has not said so", () => {
  const base = {
    id: "t", title: "t", status: "active", hasPlan: false, mechanism: null, humanBlocked: false, ready: false,
    dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "exited", sessionId: "s",
    unread: false, archived: false, subAgents: [], bgShells: [], watches: [], pendingQuestion: false, questions: [],
    needsYou: false, awaitingBackground: false, crashed: true, kind: "session",
  } as unknown as ThreadView
  const view = heldThreadView(base, row("orphan", { lazy_prompt: "", held_by: "some-removed-holder" }))
  assert.equal(view.held, "some-removed-holder")
  assert.equal(view.needsYou, false)
  assert.equal(view.runtime, "turn-idle", "never reads as a dispatch still spinning up")
  assert.equal(view.crashed, false, "never reads as a worker that died")
})

// Legacy data, kept with the migration it feeds: the build that called the column `todo` (2026-10-01) left
// its unstarted threads there, ensureStorageSchema moves them to `lazy_prompt`, and the held migration then
// holds each under `lazy`, the id of the lazy-threads feature removed on 2026-10-07.
test("a database from the build that named the column `todo` keeps its unstarted threads", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-lazy-migrate-"))
  try {
    const file = join(dir, "ui.db")
    const first = createStorage(file, "p")
    first.upsertSession(row("renew"))
    first.close()
    // What that build left behind: its own column, holding the prompt, and nothing in the new one.
    const raw = new Database(file)
    raw.exec("ALTER TABLE session ADD COLUMN todo TEXT")
    raw.exec("UPDATE session SET todo = 'Renew the domain', lazy_prompt = NULL")
    raw.close()
    const reopened = createStorage(file, "p")
    assert.equal(reopened.getSession("renew")?.lazy_prompt, "Renew the domain")
    assert.equal(isHeldRow(reopened.getSession("renew")), true)
    assert.equal(reopened.getSession("renew")?.held_by, "lazy")
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
