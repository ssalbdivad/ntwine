import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NTWINE_DB_TABLES, ntwineDatabaseLocation, ntwineDatabasePath, openNtwineDatabase } from "./ntwine-db.ts"
import Database from "./sqlite.ts"
import { createStorage, type SessionRow } from "./storage.ts"

function row(slug: string): SessionRow {
  return {
    slug,
    session_id: `sess-${slug}`,
    thread_name: `ntwine-${slug}`,
    spawned_at: "2026-08-01T00:00:00.000Z",
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
  }
}

function seed(db: Database, projectId: string, slug: string): void {
  const storage = createStorage(db, projectId)
  storage.upsertSession(row(slug))
  storage.armThreadTimer({ id: `timer-${projectId}-${slug}`, slug, prompt: "ping", fireAtMs: 9_999_999_999_999, createdAtMs: 1 })
  storage.close()
}

test("purging a project deletes its rows in every table and nobody else's", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-purge-"))
  const opened = openNtwineDatabase({ home })
  try {
    seed(opened.db, "project-a", "one")
    seed(opened.db, "project-b", "one")
    opened.purgeProject("project-a")
    for (const table of NTWINE_DB_TABLES) {
      const count = opened.db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get("project-a")!.n
      assert.equal(count, 0, `${table} still holds project-a rows`)
    }
    const storageB = createStorage(opened.db, "project-b")
    assert.equal(storageB.allSessions().length, 1)
    assert.equal(storageB.listThreadTimers("one").length, 1)
    storageB.close()
  } finally {
    opened.close()
  }
})

// THE RULE THAT KEEPS A TEST OFF THE REAL HOME. On 2026-08-27 a startServer test with a fake project
// under the real HOME imported the maintainer's fifty-four live project files under the running
// server. The file's location is derived from the launching project's state dir, and a state dir
// that is not `<root>/projects/<id>` gets a private file.
test("the database location follows the launch project's state dir, and a non-canonical one is private", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-db-location-"))
  assert.equal(ntwineDatabaseLocation({ stateDir: join(root, "projects", "abc") }), join(root, "ui.db"))
  const stray = join(root, "some-test-state")
  assert.equal(ntwineDatabaseLocation({ stateDir: stray }), join(stray, "ui.db"))
  assert.equal(ntwineDatabaseLocation({ stateDir: stray, path: join(root, "x.db") }), join(root, "x.db"))
})

// The per-project files of the pre-2026-08-27 layout are no longer imported (2026-10-14). A machine that
// still has them — a real one, or a garbage one an old build left half-written — must boot exactly as
// if they were not there, and leave them, and the retired import ledger, byte-for-byte alone.
test("leftover per-project files and the retired import ledger are ignored and left untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-db-leftovers-"))
  const projects = join(home, ".ntwine", "projects")
  mkdirSync(join(projects, "project-old"), { recursive: true })
  mkdirSync(join(projects, "project-junk"), { recursive: true })
  const old = join(projects, "project-old", "ui.db")
  const legacy = new Database(old)
  legacy.exec("CREATE TABLE session (slug TEXT PRIMARY KEY, session_id TEXT NOT NULL, tmux_name TEXT NOT NULL, spawned_at TEXT NOT NULL)")
  legacy.prepare("INSERT INTO session VALUES ('legacy', 'sid', 'fray-legacy', '2026-08-01T00:00:00.000Z')").run()
  legacy.close()
  const junk = join(projects, "project-junk", "ui.db")
  writeFileSync(junk, "not a database")
  const before = [readFileSync(old), readFileSync(junk)]

  const path = ntwineDatabasePath(home)
  const pre = new Database(path)
  pre.exec("CREATE TABLE imported_project (project_id TEXT PRIMARY KEY, source TEXT NOT NULL, rows INTEGER NOT NULL, imported_at TEXT NOT NULL)")
  pre.prepare("INSERT INTO imported_project VALUES ('project-a', 'somewhere', 3, 'then')").run()
  pre.close()

  const opened = openNtwineDatabase({ home })
  try {
    assert.equal(opened.path, path)
    assert.deepEqual(opened.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM session").get(), { n: 0 })
    seed(opened.db, "project-a", "one")
    opened.purgeProject("project-a")
    assert.deepEqual(
      opened.db.prepare("SELECT project_id, rows FROM imported_project").all(),
      [{ project_id: "project-a", rows: 3 }],
      "an older build stepped back to still finds its ledger",
    )
  } finally {
    opened.close()
  }
  assert.ok(readFileSync(old).equals(before[0]!), "the old project file is byte-identical")
  assert.ok(readFileSync(junk).equals(before[1]!), "the junk file is byte-identical")
})
