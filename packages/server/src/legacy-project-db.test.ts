import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "./sqlite.ts"
import { openNtwineDatabase } from "./ntwine-db.ts"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"

// THE PER-PROJECT FILE'S REPAIRS, exercised the only way they run now: on a legacy file, once, as
// it is imported into the unified database (ntwine-db.ts). Each case writes the fixture where a
// pre-unification Ntwine kept it, rewinds it raw to the older shape, and "restarts" by opening the
// unified database for that home — which imports the file, renames it, and hands back the rows.
// These lived in storage.test.ts while createStorage ran the repairs itself on every open.

/** Where a pre-unification project kept its file, under a sandbox home. */
function legacyPath(home: string): string {
  mkdirSync(join(home, ".ntwine", "projects", "p"), { recursive: true })
  return join(home, ".ntwine", "projects", "p", "ui.db")
}

/** The unified file the import lands in. */
function unifiedPath(home: string): string {
  return join(home, ".ntwine", "ui.db")
}

/**
 * The fixture is written by today's createStorage, so it carries project_id — a column no real legacy
 * file ever had, and one the legacy repairs' marker INSERT (no project_id) trips over. Strip it, the
 * way `CREATE TABLE AS` does: constraints go with it, which the legacy stack's ADD COLUMN guards absorb.
 */
function rewindToLegacyShape(path: string): void {
  const db = new Database(path)
  try {
    const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)
    for (const table of tables) {
      const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
      if (!columns.includes("project_id")) continue
      const kept = columns.filter((c) => c !== "project_id").join(", ")
      db.exec(`CREATE TABLE ${table}_legacy AS SELECT ${kept} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_legacy RENAME TO ${table}`)
    }
  } finally {
    db.close()
  }
}

/** Open the unified database for `home` (importing whatever legacy file is there) as project "p". */
function openImported(home: string): Storage {
  const legacy = legacyPath(home)
  if (existsSync(legacy)) rewindToLegacyShape(legacy)
  const opened = openNtwineDatabase({ home })
  const storage = createStorage(opened.db, "p")
  return { ...storage, close: () => { storage.close(); opened.close() } }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  const result = {
    slug: "t",
    session_id: "sid",
    thread_name: "ntwine-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: null,
    meta: null,
    seen_at: null,
    transcript_id: null,
    ...over,
  }
  if (over.slug !== undefined && over.thread_name === undefined) result.thread_name = `ntwine-${result.slug}`
  return result
}

// The retired Codex TUI composer held a DURABLE 'codex-input' runtime lock across restarts, and both
// its writer (queueFollowUp) and its releaser are gone. A row still holding one would report
// runtimeControlPending forever — permanently fencing that thread's composer, model, and sandbox
// controls with nothing left in the product able to clear it. Boot releases it exactly once.
test("boot releases a stranded 'codex-input' runtime lock left by the retired Codex composer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-storage-codex-input-"))
  const path = legacyPath(dir)
  const s = createStorage(path, "p")
  s.upsertSession(row({ slug: "stranded" }))
  s.upsertSession(row({ slug: "other-owner", session_id: "sid-other" }))
  s.beginRuntimeControl("other-owner", { sessionId: "sid-other", nativeSessionId: null, generation: 0 }, "profile")
  s.close()

  // Forge the pre-upgrade state directly: 'codex-input' is no longer a RuntimeControlKind, so this is
  // exactly how a db written by a pre-cutover ntwine looks on disk.
  const sqlite = new Database(path)
  sqlite.exec("UPDATE session SET runtime_control = 'codex-input' WHERE slug = 'stranded'")
  sqlite.close()

  const reopened = openImported(dir)
  assert.equal(reopened.getSession("stranded")?.runtime_control ?? null, null, "the stranded codex-input lock is released at boot")
  assert.equal(reopened.getSession("other-owner")?.runtime_control, "profile", "a live non-codex runtime control is untouched")
  reopened.close()
})

// The OTHER purely in-process lock. resume.ts holds 'follow-up' for the ~300-800ms an injection needs
// and releases it in a `finally`, so no process can still hold one after a restart — but a hard kill
// inside that window leaves it, and every later send then fails "Another runtime control is in
// progress" forever. Unlike 'codex-input' this kind is still LIVE, so the sweep has to be a boot-time
// one (a stale lock is unrepresentable at boot) and must not touch the durable 'profile' handoff.
test("boot releases a 'follow-up' lock a hard kill stranded, and never the durable profile handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-storage-followup-lock-"))
  const path = legacyPath(dir)
  const s = createStorage(path, "p")
  s.upsertSession(row({ slug: "killed-mid-send" }))
  s.upsertSession(row({ slug: "profile-armed", session_id: "sid-profile" }))
  s.beginRuntimeControl("killed-mid-send", { sessionId: "sid", nativeSessionId: null, generation: 0 }, "follow-up")
  s.beginRuntimeControl("profile-armed", { sessionId: "sid-profile", nativeSessionId: null, generation: 0 }, "profile")
  assert.equal(s.getSession("killed-mid-send")?.runtime_control, "follow-up", "the lock is real before the crash")
  s.close() // ← the hard kill: nothing ran the `finally`

  const reopened = openImported(dir)
  assert.equal(reopened.getSession("killed-mid-send")?.runtime_control ?? null, null, "the thread's composer is not fenced forever")
  assert.equal(reopened.getSession("profile-armed")?.runtime_control, "profile", "the durable handoff still awaits its recovery")
  reopened.close()
})

// Same class as above: a CODEX row can also still hold the PRE-CUTOVER profile handoff from a crash on
// the retired composer path. It can never complete (recovery reads the pane with the Claude composer parser), and the
// recovery loop would re-block the thread on every tick. Boot abandons it and explains why.
test("boot abandons a codex row still holding the retired Codex profile handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-storage-codex-profile-"))
  const path = legacyPath(dir)
  const s = createStorage(path, "p")
  s.upsertSession(row({ slug: "codex-stuck" }))
  s.upsertSession(row({ slug: "claude-stuck", session_id: "sid-claude" }))
  s.setBackend("codex-stuck", "codex")
  s.setBackend("claude-stuck", "claude")
  s.close()

  const sqlite = new Database(path)
  sqlite.exec(`
    UPDATE session
    SET runtime_control = 'profile', profile_pending_model = 'gpt-5.6-sol',
        profile_pending_effort = 'high', profile_handoff = '{"version":1,"phase":"armed"}'
  `)
  sqlite.close()

  const reopened = openImported(dir)
  const codex = reopened.getSession("codex-stuck")!
  assert.equal(codex.runtime_control ?? null, null, "the codex row is released")
  assert.equal(codex.profile_pending_model ?? null, null, "its unreachable pending pair is abandoned")
  assert.equal(codex.profile_pending_effort ?? null, null)
  assert.equal(codex.profile_handoff ?? null, null, "and so is its journal")
  assert.match(codex.control_error ?? "", /armed on the retired Codex interactive path/, "the operator is told why it vanished")

  const claude = reopened.getSession("claude-stuck")!
  assert.equal(claude.runtime_control, "profile", "a CLAUDE handoff still recovers normally")
  assert.equal(claude.profile_pending_model, "gpt-5.6-sol", "and keeps its pending pair")
  reopened.close()
})

test("the title_agent backfill marks worker-written codex titles and leaves untouched chops alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-title-agent-"))
  const dbPath = legacyPath(dir)
  const first = createStorage(dbPath, "p")
  // What the auto-title CAS has been leaving behind since the codex app-server path landed: a row
  // still flagged as a machine guess (title_auto 1) whose TEXT is the worker's own name, so its slug —
  // minted from the dispatch chop — no longer reads as one this title could have produced.
  first.upsertSession(row({ slug: "i-want-to-start-working", session_id: "sid-a", title: "Build minimal tool renderer", title_auto: 1, title_locked: 0 }))
  first.setBackend("i-want-to-start-working", "codex")
  // The counter-case: a worker that never emitted a title signal, so the row still holds its chop.
  first.upsertSession(row({ slug: "fix-the-parser-bug", session_id: "sid-b", title: "Fix the parser bug", title_auto: 1, title_locked: 0 }))
  first.setBackend("fix-the-parser-bug", "codex")
  // Claude rows are not in scope: nothing persists their aiTitle, so a replaced title there is a
  // rename, and the repair must not claim it as a worker's.
  first.upsertSession(row({ slug: "some-old-prompt", session_id: "sid-c", title: "Resolver cache bug", title_auto: 1, title_locked: 0 }))
  first.close()

  // Rewind to the pre-column shape and clear the marker, exactly as a server upgrade finds it. A file
  // from before title_agent also predates the session_former_titles trigger (2026-09-30), which reads
  // the column — and SQLite refuses to drop a column a trigger still names — so the rewind drops it too.
  const raw = new Database(dbPath)
  raw.exec("DROP TRIGGER IF EXISTS session_former_titles")
  raw.exec("ALTER TABLE session DROP COLUMN title_agent")
  raw.exec("DELETE FROM settings WHERE key = 'repair:mark-agent-written-titles'")
  raw.close()

  const upgraded = openImported(dir)
  assert.equal(upgraded.getSession("i-want-to-start-working")?.title_agent, 1, "the slug proves this title is NOT the one the thread was dispatched with")
  assert.equal(upgraded.getSession("fix-the-parser-bug")?.title_agent, 0, "a title that still mints its own slug is the dispatch chop")
  assert.equal(upgraded.getSession("some-old-prompt")?.title_agent, 0, "claude rows never persist a worker title, so nothing to recover")

  // ONE time only: the predicate is a heuristic, and every title written from here on records its own
  // provenance. A restart must not re-decide a row the flag already answers for.
  const rewritten = new Database(unifiedPath(dir))
  rewritten.exec("UPDATE session SET title_agent = 0 WHERE slug = 'i-want-to-start-working'")
  rewritten.close()
  upgraded.close()
  const restarted = openImported(dir)
  assert.equal(restarted.getSession("i-want-to-start-working")?.title_agent, 0, "the marker keeps the repair from re-running")
  restarted.close()
})

test("the title_locked migration backfills conservatively and its boot repair is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-title-lock-"))
  const dbPath = legacyPath(dir)
  const first = createStorage(dbPath, "p")
  first.upsertSession(row({ slug: "named", session_id: "sid-a", title: "Human name", title_auto: 0, title_locked: 1 }))
  first.upsertSession(row({ slug: "guessed", session_id: "sid-b", title: "raw prompt chop", title_auto: 1, title_locked: 0 }))
  first.upsertSession(row({ slug: "caller", session_id: "sid-c", title: "Investigate acme/app#391", title_auto: 0, title_locked: 0 }))
  first.close()

  // Rewind to the real pre-split shape — a DB whose session table has no title_locked at all.
  const raw = new Database(dbPath)
  raw.exec("ALTER TABLE session DROP COLUMN title_locked")
  raw.close()

  // Reopening runs the ADD COLUMN + repair exactly as a server upgrade does. Both titles a human owns
  // (explicit and legacy) come back LOCKED from the conservative DEFAULT; only the machine guess is
  // unlocked by the flag-keyed repair. The caller-titled row stays locked here because this fixture's
  // slug ("caller") is not one its title could have minted — the dispatch-minted repair below is the
  // one that reaches rows whose slug still proves where the title came from.
  const upgraded = openImported(dir)
  assert.equal(upgraded.getSession("named")?.title_locked, 1)
  assert.equal(upgraded.getSession("guessed")?.title_locked, 0)
  assert.equal(upgraded.getSession("caller")?.title_locked, 1)
  // A fresh dispatch under the new schema, then another restart: the repair must NOT re-lock it. A
  // repair written the other way round (`SET title_locked = 1 WHERE title_auto = 0`) would silently
  // undo this feature on every server restart, which is why it keys on the guess flag instead.
  upgraded.upsertSession(row({ slug: "fresh", session_id: "sid-d", title: "Review acme/app#12", title_auto: 0, title_locked: 0 }))
  upgraded.close()

  const restarted = openImported(dir)
  assert.equal(restarted.getSession("fresh")?.title_locked, 0, "a restart never re-locks a caller's dispatch title")
  assert.equal(restarted.getSession("named")?.title_locked, 1)
  restarted.close()
})

test("the one-time repair unlocks titles a dispatch minted, and never a human's rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-title-repair-"))
  const dbPath = legacyPath(dir)
  const first = createStorage(dbPath, "p")
  // Slugs as the dispatcher mints them: slugify(title), plus the -2 suffix resolveSlug adds on a
  // collision. `renamed` is the counter-case — a thread the human renamed, so its slug still reads as
  // the ORIGINAL dispatch title and no longer as the stored one.
  first.upsertSession(row({ slug: "investigate-acme-app-391", session_id: "sid-a", title: "Investigate acme/app#391", title_auto: 0 }))
  first.upsertSession(row({ slug: "investigate-acme-app-391-2", session_id: "sid-b", title: "Investigate acme/app#391", title_auto: 0 }))
  first.upsertSession(row({ slug: "i-m-seeing-a-stale-cache", session_id: "sid-c", title: "Resolver cache bug", title_auto: 0 }))
  first.upsertSession(row({ slug: "raw-prompt-chop", session_id: "sid-d", title: "raw prompt chop", title_auto: 1 }))
  first.close()

  // Rewind to the state the broker bug left behind: caller-titled rows locked, and no record that the
  // repair has run. (A server old enough to write those rows is old enough not to know the marker.)
  const raw = new Database(dbPath)
  raw.exec("UPDATE session SET title_locked = 1 WHERE title_auto = 0")
  raw.exec("DELETE FROM settings WHERE key = 'repair:unlock-dispatch-minted-titles'")
  raw.close()

  const upgraded = openImported(dir)
  assert.equal(upgraded.getSession("investigate-acme-app-391")?.title_locked, 0, "the slug proves the title came from a dispatch")
  assert.equal(upgraded.getSession("investigate-acme-app-391-2")?.title_locked, 0, "…including through a collision suffix")
  assert.equal(upgraded.getSession("i-m-seeing-a-stale-cache")?.title_locked, 1, "a renamed thread's slug no longer matches its title — untouched")
  assert.equal(upgraded.getSession("raw-prompt-chop")?.title_auto, 1, "a machine guess is unlocked by the flag repair, not this one")

  // ONE time only: the predicate is a heuristic, so a human who re-locks a repaired row by renaming it
  // keeps that name even if their new title happens to mint the slug again.
  upgraded.setTitle("investigate-acme-app-391", "Investigate acme/app#391")
  assert.equal(upgraded.getSession("investigate-acme-app-391")?.title_locked, 1)
  upgraded.close()

  const restarted = openImported(dir)
  assert.equal(restarted.getSession("investigate-acme-app-391")?.title_locked, 1, "the repair never runs a second time")
  restarted.close()
})

// The rebrand's one-time migration was deleted once the projects in use had been converted — but ten
// project databases on this machine had simply not been opened since, and `thread_name` is re-derived
// and checked on every write, so the next write to one of those rows would have been rejected.
test("opening a database adopts a pre-rebrand thread_name, and leaves a current one alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-rebrand-rows-"))
  const path = legacyPath(dir)
  try {
    const first = createStorage(path, "p")
    first.upsertSession(row({ slug: "old-thread" }))
    first.upsertSession(row({ slug: "new-thread" }))
    first.close()

    // Put one row back exactly the way the pre-rebrand code wrote it.
    const raw = new Database(path)
    raw.exec("UPDATE session SET thread_name = 'fray-old-thread' WHERE slug = 'old-thread'")
    raw.close()

    // Opening IS the migration — there is nothing else to run.
    const reopened = openImported(dir)
    try {
      assert.equal(reopened.getSession("old-thread")?.thread_name, "ntwine-old-thread")
      assert.equal(reopened.getSession("new-thread")?.thread_name, "ntwine-new-thread")
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A database that ran the RETIRED thread_watch build (2026-08-14) carries an orphan table of that
// shape. CREATE TABLE IF NOT EXISTS does not reshape it, so the index on (state, expires_at) threw
// "no such column: expires_at" and createStorage never returned -- seven of the fifty-four project
// databases on the maintainer's machine could not open at all. Opening IS the migration.
test("opening a database drops a pre-retirement thread_watch, and leaves a current one alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-legacy-watch-"))
  const path = legacyPath(dir)
  try {
    // The retired table, byte-for-byte as the 2026-08-14 build wrote it: different kinds, different
    // states, a foreground column, and no expiry.
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE thread_watch (
        id          TEXT PRIMARY KEY,
        thread_slug TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('pr', 'ci', 'shell')),
        target      TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('armed', 'fired', 'dropped')),
        created_at  INTEGER NOT NULL,
        settled_at  INTEGER,
        cursor      TEXT,
        foreground  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX thread_watch_armed ON thread_watch(state, kind);
      CREATE INDEX thread_watch_slug ON thread_watch(thread_slug, state, created_at);
      INSERT INTO thread_watch (id, thread_slug, kind, target, state, created_at)
        VALUES ('old_1', 't', 'pr', 'owner/repo#1', 'fired', 1),
               ('old_2', 't', 'shell', 'abc', 'dropped', 2);
    `)
    raw.close()

    // Before the migration this threw rather than returning a store.
    const upgraded = openImported(dir)
    try {
      const at = 1_700_000_000_000
      const armed = upgraded.armThreadWatch({ id: "wch_1", slug: "t", kind: "agent", target: "abc", createdAtMs: at, expiresAtMs: at + 3600_000 })
      assert.equal(armed.expires_at, at + 3600_000, "the returned table's required expiry is writable")
      // 'agent' is a kind the retired CHECK constraint rejected, so this also proves the table is the
      // new one rather than an orphan that merely gained a column.
      assert.deepEqual(upgraded.listThreadWatches("t", { armedOnly: true }).map((w) => w.id), ["wch_1"])
    } finally {
      upgraded.close()
    }

    // Idempotent: the second open finds the current shape and leaves its rows alone.
    const restarted = openImported(dir)
    try {
      assert.deepEqual(restarted.listThreadWatches("t", { armedOnly: true }).map((w) => w.id), ["wch_1"])
    } finally {
      restarted.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
