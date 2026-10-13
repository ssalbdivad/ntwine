import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NTWINE_DB_TABLES, ensureNtwineSchema, ntwineDatabasePath, openNtwineDatabase } from "./ntwine-db.ts"
import Database from "./sqlite.ts"
import { createStorage } from "./storage.ts"

// THE FAILURE-MODE MATRIX FOR THE LEGACY IMPORT (2026-08-28). ntwine-db.test.ts pins the happy path
// and the two accidents that already happened (an unreadable file, the first cut's rename). This
// file pins the ones that have NOT happened yet, on the grounds that the import runs once per project
// file over a real user's only copy of their threads: a WAL nobody checkpointed, a file another
// process still holds, a ledger row that will not write, a file that is not a database, a file that
// is nothing at all, a shape the legacy stack never wrote, a rollback that left two files, junk in
// the projects directory, a purge, a double open, and two projects that share a slug.
//
// Every home is its own mkdtemp. NEVER the real one: on 2026-08-27 a test under the real HOME
// imported the maintainer's fifty-four live files and renamed them out from under a running server.

// The pre-unification fixture, copied from ntwine-db.test.ts (that file's tests would run on import).
// The LAST per-project shape plus the two older ones the legacy stack must bring forward first: a
// `tmux_name` column, `fray-` thread names, and the retired thread_watch with no expires_at.
function writeLegacyProject(home: string, projectId: string, slugs: string[]): string {
  const dir = join(home, ".ntwine", "projects", projectId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "ui.db")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      slug TEXT PRIMARY KEY, session_id TEXT NOT NULL, tmux_name TEXT NOT NULL, spawned_at TEXT NOT NULL,
      last_read_at TEXT, unread INTEGER NOT NULL DEFAULT 0, exited INTEGER NOT NULL DEFAULT 0,
      title TEXT, heartbeat_prompt TEXT, heartbeat_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread_watch (id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER);
    CREATE TABLE thread_timer (
      id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, prompt TEXT NOT NULL, fire_at INTEGER NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
    );
    CREATE TABLE wake_delivery (
      id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, session_id TEXT NOT NULL, fence_id TEXT NOT NULL,
      hint_key TEXT NOT NULL, message TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER, terminal_at INTEGER
    );
  `)
  for (const slug of slugs) {
    db.prepare("INSERT INTO session (slug, session_id, tmux_name, spawned_at, title, heartbeat_prompt, heartbeat_enabled) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(slug, `sess-${projectId}-${slug}`, `fray-${slug}`, "2026-08-01T00:00:00.000Z", `Title of ${slug}`, "keep going")
    db.prepare("INSERT INTO thread_timer VALUES (?, ?, ?, ?, 'armed', 1, NULL)").run(`timer-${projectId}-${slug}`, slug, "ping", 9_999_999_999_999)
    db.prepare("INSERT INTO wake_delivery (id, thread_slug, session_id, fence_id, hint_key, message, reason, state, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'f', 'h', 'm', 'r', 'delivered', 1, 1, 1)")
      .run(`wake-${projectId}-${slug}`, slug, `sess-${projectId}-${slug}`)
  }
  db.prepare("INSERT INTO thread_watch VALUES ('w1', ?, 'pr', 'acme/app#1', 'fired', 1, 2)").run(slugs[0])
  db.prepare("INSERT INTO settings VALUES ('font', '\"mono\"')").run()
  db.close()
  return path
}

/** The projects directory under a sandbox home, created — `ntwinePaths` only treats `~/.ntwine` as the root once it exists. */
function projectsDir(home: string): string {
  const dir = join(home, ".ntwine", "projects")
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Every unified table's row count for one project — the shape two opens are compared by. */
function projectRowCounts(db: Database, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of [...NTWINE_DB_TABLES, "imported_project"]) {
    counts[table] = db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE project_id = ?`).get(projectId)!.n
  }
  return counts
}

function sessionCount(db: Database, projectId: string): number {
  return db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM session WHERE project_id = ?").get(projectId)!.n
}

function ledgerIds(db: Database): string[] {
  return db.prepare<[], { project_id: string }>("SELECT project_id FROM imported_project ORDER BY project_id").all().map((r) => r.project_id)
}

// 1. HOT WAL. An old server that was killed mid-flight leaves its last commits in `ui.db-wal`, not in
// `ui.db`; the main file alone is missing them. The import must open the file with its WAL beside it
// and see every committed row. The fixture is built by copying all three files out from under a
// connection that is STILL OPEN, which is exactly what a crash leaves on disk.
test("a legacy file whose last writes sit in an un-checkpointed WAL imports every row", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-hot-wal-"))
  const source = writeLegacyProject(home, "project-source", ["before-wal"])
  const writer = new Database(source)
  writer.exec("PRAGMA journal_mode = WAL")
  const inWal = Array.from({ length: 40 }, (_, i) => `in-wal-${i}`)
  for (const slug of inWal) {
    writer.prepare("INSERT INTO session (slug, session_id, tmux_name, spawned_at) VALUES (?, ?, ?, ?)")
      .run(slug, `sess-${slug}`, `fray-${slug}`, "2026-08-02T00:00:00.000Z")
  }
  // The precondition, asserted: if the WAL were empty this cell would prove nothing.
  assert.ok(statSync(`${source}-wal`).size > 0, "the fixture's writes are in the WAL, not the main file")
  const crashedDir = join(projectsDir(home), "project-crashed")
  mkdirSync(crashedDir)
  for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${source}${suffix}`, join(crashedDir, `ui.db${suffix}`))
  // The negative control: the main file WITHOUT its WAL, kept outside the scan, holds only the first row.
  const controlPath = join(home, "control-main-only.db")
  copyFileSync(source, controlPath)
  writer.close()
  const control = new Database(controlPath)
  assert.equal(control.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM session").get()!.n, 1, "without the WAL the rows are invisible")
  control.close()

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId).sort(), ["project-crashed", "project-source"])
    const storage = createStorage(opened.db, "project-crashed")
    assert.deepEqual(storage.allSessions().map((r) => r.slug).sort(), ["before-wal", ...inWal].sort())
    storage.close()
  } finally {
    opened.close()
  }
})

// 2. LOCKED FILE. An older server still running — or a stuck one — holds a write lock on project A's
// file while the new build boots. The legacy stack's first write waits out busy_timeout (5000 ms in
// ntwine-db.ts, so this cell takes ~5 s) and throws; A must be skipped and left for the next boot,
// B must import, and the boot must not abort. Once the lock is gone A imports in full, INCLUDING the
// row the lock holder committed. `BEGIN IMMEDIATE` is the realistic lock: it lets the migration's
// reads through and blocks only its first write, which is where the failure has to be caught.
test("a legacy file another connection holds a write lock on is skipped this boot and imported next boot", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-locked-"))
  const a = writeLegacyProject(home, "project-a", ["a-one", "a-two"])
  writeLegacyProject(home, "project-b", ["b-one"])
  const holder = new Database(a)
  holder.exec("BEGIN IMMEDIATE")
  holder.prepare("INSERT INTO session (slug, session_id, tmux_name, spawned_at) VALUES (?, ?, ?, ?)")
    .run("written-under-lock", "sess-lock", "fray-written-under-lock", "2026-08-03T00:00:00.000Z")

  const started = Date.now()
  const opened = openNtwineDatabase({ home })
  const elapsed = Date.now() - started
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-b"])
    assert.deepEqual(ledgerIds(opened.db), ["project-b"], "the locked file is not recorded, so the next boot retries it")
    assert.equal(sessionCount(opened.db, "project-a"), 0, "nothing of A was copied")
    assert.ok(elapsed >= 4000, `the migration waited out busy_timeout before giving up (${elapsed} ms)`)
  } finally {
    opened.close()
  }

  holder.exec("COMMIT")
  holder.close()
  const again = openNtwineDatabase({ home })
  try {
    assert.deepEqual(again.imported.map((i) => i.projectId), ["project-a"])
    assert.deepEqual(ledgerIds(again.db), ["project-a", "project-b"])
    const storage = createStorage(again.db, "project-a")
    assert.deepEqual(storage.allSessions().map((r) => r.slug).sort(), ["a-one", "a-two", "written-under-lock"])
    storage.close()
  } finally {
    again.close()
  }
})

// 3. ATOMIC MARKER. The copy and the ledger row are promised to be ONE transaction, so a crash leaves
// both or neither — and "neither" is the case that matters, because a copy without its marker is
// re-copied next boot (idempotent on the keys) while a marker without its copy is a project that
// silently vanished. A persistent trigger that refuses the ledger INSERT stands in for the crash:
// if the rows survive it, the copy was committed on its own.
test("a ledger row that cannot be written rolls the whole copy back, and the next boot imports once", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-atomic-"))
  writeLegacyProject(home, "project-a", ["one", "two", "three"])
  const unifiedPath = ntwineDatabasePath(home)
  const pre = new Database(unifiedPath)
  ensureNtwineSchema(pre)
  pre.exec("CREATE TRIGGER block_ledger BEFORE INSERT ON imported_project BEGIN SELECT RAISE(ABORT, 'ledger blocked'); END;")
  pre.close()

  const blocked = openNtwineDatabase({ home })
  try {
    assert.deepEqual(blocked.imported, [], "the import failed, and failing is not throwing")
    assert.deepEqual(ledgerIds(blocked.db), [])
    assert.equal(sessionCount(blocked.db, "project-a"), 0, "the copied rows were rolled back with the marker")
    for (const table of NTWINE_DB_TABLES) {
      assert.equal(projectRowCounts(blocked.db, "project-a")[table], 0, `${table} kept rows from the rolled-back copy`)
    }
    blocked.db.exec("DROP TRIGGER block_ledger")
  } finally {
    blocked.close()
  }

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-a"])
    assert.deepEqual(ledgerIds(opened.db), ["project-a"])
    assert.equal(sessionCount(opened.db, "project-a"), 3)
    assert.equal(opened.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM session").get()!.n, 3, "no duplicates")
  } finally {
    opened.close()
  }
})

// 4. GARBAGE FILE. ntwine-db.test.ts already proves a text file is skipped; this one proves the skip is
// BYTE-PRESERVING on binary junk. The legacy stack opens the file for writing before it learns the
// file is not a database, and a repair that wrote a header over a user's mystery file would turn an
// unreadable file into a destroyed one.
test("a ui.db of random bytes is skipped, left byte-identical, and does not block its neighbours", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-garbage-"))
  writeLegacyProject(home, "project-good", ["fine"])
  const junkDir = join(projectsDir(home), "project-junk")
  mkdirSync(junkDir)
  const junkPath = join(junkDir, "ui.db")
  // Random bytes, with the header bytes forced to something no SQLite build would accept.
  const junk = Buffer.concat([Buffer.from("NOT A SQLITE DB\0"), randomBytes(8192)])
  writeFileSync(junkPath, junk)

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-good"])
    assert.deepEqual(ledgerIds(opened.db), ["project-good"])
    assert.ok(readFileSync(junkPath).equals(junk), "the junk file is byte-identical")
    assert.equal(existsSync(`${junkPath}-journal`), false, "no journal was left beside it")
  } finally {
    opened.close()
  }
})

// 5. EMPTY FILE. A zero-byte `ui.db` is what an old build left when it was killed between creating the
// file and writing its first page, and what `touch` leaves. SQLite treats it as a brand-new database,
// so the legacy stack lays the old schema into it — and stamps its two title-repair markers into the
// fresh `settings` table, which is why the copy finds two rows and not zero: recorded, harmless, and
// not a thread.
test("a zero-byte ui.db imports as an empty project and is recorded", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-empty-"))
  const emptyDir = join(projectsDir(home), "project-empty")
  mkdirSync(emptyDir)
  writeFileSync(join(emptyDir, "ui.db"), "")
  assert.equal(statSync(join(emptyDir, "ui.db")).size, 0)

  const opened = openNtwineDatabase({ home })
  try {
    const markers = opened.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM settings WHERE project_id = 'project-empty' AND key LIKE 'repair:%'").get()!.n
    assert.ok(markers > 0, "the legacy stack's repair markers are the only rows an empty file yields")
    assert.deepEqual(opened.imported, [{ projectId: "project-empty", rows: markers }])
    assert.deepEqual(
      opened.db.prepare<[], { project_id: string; rows: number }>("SELECT project_id, rows FROM imported_project").all(),
      [{ project_id: "project-empty", rows: markers }],
    )
    assert.equal(opened.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM session WHERE project_id = 'project-empty'").get()!.n, 0)
    const storage = createStorage(opened.db, "project-empty")
    assert.deepEqual(storage.allSessions(), [])
    storage.close()
  } finally {
    opened.close()
  }
})

// 6. FOREIGN SHAPE. A file some other build wrote: a table the unified schema has never heard of, a
// column on `session` it does not have, and two tables it expects (wake_delivery, tail_state) that
// are simply absent. The copy is the INTERSECTION of columns over the tables both sides have, so the
// known rows land, the unknown column is dropped, the unknown table is ignored, and nothing throws.
test("a legacy file with an unknown table, an unknown column and missing tables imports what both sides share", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-foreign-"))
  const path = writeLegacyProject(home, "project-odd", ["known-one", "known-two"])
  const raw = new Database(path)
  raw.exec(`
    DROP TABLE wake_delivery;
    ALTER TABLE session ADD COLUMN mystery TEXT DEFAULT 'from the future';
    CREATE TABLE from_another_build (id INTEGER PRIMARY KEY, payload TEXT);
    INSERT INTO from_another_build (payload) VALUES ('x'), ('y');
  `)
  raw.close()

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-odd"])
    const storage = createStorage(opened.db, "project-odd")
    assert.deepEqual(storage.allSessions().map((r) => r.slug).sort(), ["known-one", "known-two"])
    assert.equal(storage.getSession("known-one")!.title, "Title of known-one")
    assert.equal(storage.listThreadTimers("known-one").length, 1)
    storage.close()
    const unifiedColumns = opened.db.prepare<[], { name: string }>("PRAGMA table_info(session)").all().map((c) => c.name)
    assert.ok(!unifiedColumns.includes("mystery"), "the unknown column did not leak into the unified schema")
    const unifiedTables = opened.db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)
    assert.ok(!unifiedTables.includes("from_another_build"), "the unknown table did not leak into the unified file")
    assert.equal(projectRowCounts(opened.db, "project-odd").wake_delivery, 0)
    assert.equal(projectRowCounts(opened.db, "project-odd").tail_state, 0)
  } finally {
    opened.close()
  }
})

// 7. ROLLBACK LEFTOVER. The first cut renamed a file to `ui.db.imported` after copying it; an older
// build then created a fresh `ui.db` beside it and wrote a thread there. Both files sit in the
// directory when the ledger build boots. Only `ui.db` is a live file: it is imported and recorded,
// the backup is neither read nor touched, and the rows the first cut copied stay in the unified file.
test("a project holding both ui.db and ui.db.imported imports only ui.db and loses nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-leftover-"))
  const path = writeLegacyProject(home, "project-a", ["from-backup-one", "from-backup-two"])
  // The first cut's boot: the rows are in the unified file, but that cut kept no ledger.
  const firstCut = openNtwineDatabase({ home })
  assert.deepEqual(firstCut.imported.map((i) => i.projectId), ["project-a"])
  firstCut.db.prepare("DELETE FROM imported_project WHERE project_id = 'project-a'").run()
  firstCut.close()
  renameSync(path, `${path}.imported`)
  const backupBytes = readFileSync(`${path}.imported`)
  // The older build's rollback: a fresh file with one thread of its own.
  writeLegacyProject(home, "project-a", ["written-on-rollback"])

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-a"])
    const ledger = opened.db.prepare<[], { project_id: string; source: string }>("SELECT project_id, source FROM imported_project").all()
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]!.source, path, "the live file, never the backup, is what was recorded")
    assert.ok(existsSync(`${path}.imported`), "the backup is still there")
    assert.ok(readFileSync(`${path}.imported`).equals(backupBytes), "and byte-identical")
    const storage = createStorage(opened.db, "project-a")
    assert.deepEqual(
      storage.allSessions().map((r) => r.slug).sort(),
      ["from-backup-one", "from-backup-two", "written-on-rollback"],
      "the first cut's rows survive and the rollback's row arrives",
    )
    assert.equal(storage.listThreadTimers("from-backup-one").length, 1)
    storage.close()
  } finally {
    opened.close()
  }
})

// 8. STRAY ENTRIES. The projects directory is a user's disk, not a schema: a README somebody dropped
// there, a directory whose name is not a uuid, a `ui.db` that is a directory. Ids are opaque, so the
// odd name is a project like any other; the two that hold no file are skipped without a word.
test("junk in the projects directory is skipped and a non-uuid directory is a project like any other", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-stray-"))
  const dir = projectsDir(home)
  writeFileSync(join(dir, "README"), "projects live here\n")
  writeLegacyProject(home, "not-a-uuid", ["odd-name"])
  mkdirSync(join(dir, "project-dir-db", "ui.db"), { recursive: true })

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["not-a-uuid"])
    assert.deepEqual(ledgerIds(opened.db), ["not-a-uuid"])
    const storage = createStorage(opened.db, "not-a-uuid")
    assert.deepEqual(storage.allSessions().map((r) => r.slug), ["odd-name"])
    storage.close()
    assert.ok(statSync(join(dir, "project-dir-db", "ui.db")).isDirectory(), "the directory named ui.db is untouched")
    assert.equal(readFileSync(join(dir, "README"), "utf8"), "projects live here\n")
  } finally {
    opened.close()
  }
})

// 9. RE-IMPORT AFTER PURGE. purgeProject deletes the marker with the rows and leaves the directory to
// its caller. A caller that removes the rows but not the directory therefore gets the project BACK on
// the next boot, from the file that is still there — documented, and pinned here so the row counts
// of the second import are exactly the first's rather than a subset or a doubling.
test("a purged project whose file is still on disk is re-imported with exactly its original rows", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-purge-reimport-"))
  writeLegacyProject(home, "project-a", ["one", "two"])
  writeLegacyProject(home, "project-b", ["one"])
  const first = openNtwineDatabase({ home })
  const firstCounts = projectRowCounts(first.db, "project-a")
  const firstRows = first.imported.find((i) => i.projectId === "project-a")!.rows
  assert.ok(firstRows > 0)
  first.purgeProject("project-a")
  assert.deepEqual(ledgerIds(first.db), ["project-b"])
  assert.equal(sessionCount(first.db, "project-a"), 0)
  first.close()

  const again = openNtwineDatabase({ home })
  try {
    assert.deepEqual(again.imported, [{ projectId: "project-a", rows: firstRows }])
    assert.deepEqual(projectRowCounts(again.db, "project-a"), firstCounts)
    assert.deepEqual(ledgerIds(again.db), ["project-a", "project-b"])
    assert.equal(sessionCount(again.db, "project-b"), 1, "the neighbour was never touched")
  } finally {
    again.close()
  }
})

// 10. IDEMPOTENT DOUBLE OPEN. The server opens this file once per boot, and boots are frequent. Three
// opens in a row must leave every table's counts exactly where the first left them, with nothing
// imported after the first: the ledger, not the file's presence, is what decides.
test("three consecutive opens import once and leave every table's row counts identical", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-idempotent-"))
  writeLegacyProject(home, "project-a", ["one", "two"])
  writeLegacyProject(home, "project-b", ["one"])
  const snapshots: Record<string, Record<string, number>>[] = []
  for (let pass = 0; pass < 3; pass++) {
    const opened = openNtwineDatabase({ home })
    try {
      if (pass === 0) assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-a", "project-b"])
      else assert.deepEqual(opened.imported, [], `pass ${pass} imported again`)
      snapshots.push({
        "project-a": projectRowCounts(opened.db, "project-a"),
        "project-b": projectRowCounts(opened.db, "project-b"),
      })
    } finally {
      opened.close()
    }
  }
  assert.deepEqual(snapshots[1], snapshots[0])
  assert.deepEqual(snapshots[2], snapshots[0])
  assert.ok(snapshots[0]!["project-a"]!.session === 2 && snapshots[0]!["project-b"]!.session === 1)
})

// 11. SLUG COLLISION. Every per-project file keyed session by slug alone; the unified file keys by
// (project_id, slug). Two projects that both dispatched "fix-the-build" must each keep their own row —
// the INSERT OR IGNORE that makes the copy idempotent must never ignore the SECOND project's row as a
// duplicate of the first's.
test("two projects sharing a slug each keep their own row and title", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-slug-collision-"))
  const a = writeLegacyProject(home, "project-a", ["fix-the-build"])
  const b = writeLegacyProject(home, "project-b", ["fix-the-build"])
  for (const [path, title] of [[a, "A's build fix"], [b, "B's build fix"]] as const) {
    const raw = new Database(path)
    raw.prepare("UPDATE session SET title = ? WHERE slug = 'fix-the-build'").run(title)
    raw.close()
  }

  const opened = openNtwineDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-a", "project-b"])
    const storageA = createStorage(opened.db, "project-a")
    const storageB = createStorage(opened.db, "project-b")
    assert.equal(storageA.getSession("fix-the-build")!.title, "A's build fix")
    assert.equal(storageB.getSession("fix-the-build")!.title, "B's build fix")
    assert.equal(storageA.getSession("fix-the-build")!.session_id, "sess-project-a-fix-the-build")
    assert.equal(storageB.getSession("fix-the-build")!.session_id, "sess-project-b-fix-the-build")
    assert.deepEqual(storageA.allSessions().map((r) => r.slug), ["fix-the-build"])
    assert.deepEqual(storageB.allSessions().map((r) => r.slug), ["fix-the-build"])
    assert.equal(storageA.listThreadTimers("fix-the-build").length, 1)
    assert.equal(storageB.listThreadTimers("fix-the-build").length, 1)
    storageA.close()
    storageB.close()
    assert.equal(opened.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM session").get()!.n, 2)
  } finally {
    opened.close()
  }
})
