import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import Database from "./sqlite.ts"
import { CODEX_APP_SERVER_TABLES, ensureCodexAppServerSchema } from "./backend/codex-app-server.ts"
import { ntwinePaths, ntwineRoots } from "./ntwine-paths.ts"
import { INTERACTION_TABLES, ensureInteractionSchema } from "./interaction-store.ts"
import { migrateLegacyProjectDatabase } from "./legacy-project-db.ts"
import { log as ntwineLog } from "./logging.ts"
import { STORAGE_TABLES, ensureStorageSchema } from "./storage.ts"
import { TAIL_STATE_TABLES, ensureTailStateSchema } from "./tail-cache.ts"
import { WAKE_DELIVERY_TABLES, ensureWakeDeliverySchema } from "./wake-store.ts"

// ONE DATABASE FOR THE MACHINE — `<data>/ui.db` (2026-08-27).
//
// Ntwine kept one SQLite file per project, `<data>/projects/<id>/ui.db`, from the day it stored
// anything: each server served one repo and owned that repo's file. The singleton (one server, every
// project — see ARCHITECTURE.md) kept the files and opened all of them, which is how a bad migration
// on 2026-08-27 could leave seven of fifty-four unopenable at once, with the launch project among
// them and the restart aborted. The maintainer's call was that the per-project file was a vestige of
// the one-server-per-repo era and should go. This module is the one file that replaced them: opened
// ONCE per process at boot, handed to every tenant, and closed after the last tenant.
//
// THE IMPORT. On every open, each `<data>/projects/<id>/ui.db` still on disk and not yet recorded in
// `imported_project` is brought up to the legacy stack's final shape (legacy-project-db.ts),
// ATTACHed, copied table by table into this file under that project's id, and recorded — in the
// SAME transaction as the copy, so a crash leaves either both or neither. The file itself is LEFT
// EXACTLY WHERE IT WAS, untouched beyond the legacy stack's own idempotent repairs. That is the
// rollback story: an operator who steps back to an older build finds every project's file where that
// build expects it, with every thread it had at the moment of the import, instead of an empty board.
// (It was renamed `ui.db.imported` for a few hours on 2026-08-27; an older build would then have
// created a fresh EMPTY file beside the backup, and the next upgrade would have imported the empty
// one over the real one's name.) Writes made on the older build after the import are not merged
// back — the marker keeps the copy one-shot, and a merge would resurrect threads forgotten here.
// Deleting a project removes its marker with its rows; deleting the marker row by hand re-imports.
// A file that will not import is logged and LEFT ALONE, to be retried next boot; it never aborts
// the open, because the other fifty-three projects were fine.
//
// The column list is the INTERSECTION of the two tables' columns, minus project_id, which the copy
// supplies. A column the legacy stack never grew is left at the unified default; a column the unified
// schema retired (the codex meta `singleton`, the pre-merge heartbeat_* pair) is simply not copied.

export interface NtwineDatabase {
  readonly db: Database
  readonly path: string
  /** Every legacy file imported on THIS open, by project id, with the rows copied. */
  readonly imported: { projectId: string; rows: number }[]
  /** Delete every row a project has in every table — the database half of removing a project. */
  purgeProject(projectId: string): void
  close(): void
}

export interface OpenNtwineDatabaseOptions {
  /**
   * THE LAUNCHING PROJECT'S STATE DIR, and the way production names the file: `<data>/projects/<id>`
   * puts it at `<data>/ui.db`, beside the projects it imports. Derived rather than defaulted from
   * `homedir()` for the reason ntwine-paths.ts gives for the server address — and re-learned here the
   * hard way (2026-08-27): a `startServer` test with a fake project and the real HOME imported all
   * fifty-four of the maintainer's project files into `~/.ntwine/ui.db` and renamed them out from
   * under the live server. A state dir that is NOT `<root>/projects/<id>` (a test's temp dir) gets a
   * PRIVATE file inside it and no legacy scan at all.
   */
  stateDir?: string
  /** A sandbox home whose data root holds the file — ntwine-db.test.ts. Ignored when stateDir is set. */
  home?: string
  /** Override the file itself — tests and the sandbox stacks. `home` still decides the legacy scan. */
  path?: string
  /** Skip the legacy scan entirely (a throwaway file with no projects directory to read). */
  importLegacy?: boolean
}

/** Every table that lives in the unified file, in the order the import copies them. */
export const NTWINE_DB_TABLES: readonly string[] = [
  ...STORAGE_TABLES,
  ...WAKE_DELIVERY_TABLES,
  ...TAIL_STATE_TABLES,
  ...CODEX_APP_SERVER_TABLES,
  ...INTERACTION_TABLES,
]

/** Where the file lives and which directory the legacy scan reads — see OpenNtwineDatabaseOptions. */
export function ntwineDatabaseLocation(options: Pick<OpenNtwineDatabaseOptions, "stateDir" | "home" | "path">): { path: string; projectsDir: string | undefined } {
  if (options.stateDir !== undefined) {
    const projectsDir = dirname(options.stateDir)
    if (basename(projectsDir) === "projects") {
      return { path: options.path ?? join(dirname(projectsDir), "ui.db"), projectsDir }
    }
    return { path: options.path ?? join(options.stateDir, "ui.db"), projectsDir: undefined }
  }
  const data = options.home ? ntwinePaths({ home: options.home }).data : ntwineRoots().data
  return { path: options.path ?? join(data, "ui.db"), projectsDir: join(data, "projects") }
}

export function ntwineDatabasePath(home?: string): string {
  return ntwineDatabaseLocation({ home }).path
}

/** Every schema owner's DDL, idempotent, in one place — the importer needs all of it up front. */
export function ensureNtwineSchema(db: Database): void {
  // The import ledger — see THE IMPORT above. One row per legacy file ever copied in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS imported_project (
      project_id  TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      rows        INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
  `)
  ensureStorageSchema(db)
  ensureWakeDeliverySchema(db)
  ensureTailStateSchema(db)
  ensureCodexAppServerSchema(db)
  ensureInteractionSchema(db)
}

export function openNtwineDatabase(options: OpenNtwineDatabaseOptions = {}): NtwineDatabase {
  const { path, projectsDir } = ntwineDatabaseLocation(options)
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")
  ensureNtwineSchema(db)

  const imported: { projectId: string; rows: number }[] = []
  if (options.importLegacy !== false && projectsDir !== undefined) {
    const alreadyImported = new Set(
      db.prepare<[], { project_id: string }>("SELECT project_id FROM imported_project").all().map((r) => r.project_id),
    )
    // THE FEW HOURS OF `ui.db.imported` (2026-08-27, 13:14–20:23 on the maintainer's machine): the
    // first cut renamed a file after copying it, and one real boot ran that way before the ledger
    // replaced it. A renamed file with nothing beside it is one that boot already copied — put it back
    // where an older build looks for it and record it, so the scan below treats it as done rather
    // than copying it a second time (which would resurrect every thread forgotten since).
    for (const projectId of retiredLegacyProjectIds(projectsDir)) {
      if (alreadyImported.has(projectId)) continue
      const dir = join(projectsDir, projectId)
      try {
        renameSync(join(dir, "ui.db.imported"), join(dir, "ui.db"))
        db.prepare("INSERT INTO imported_project (project_id, source, rows, imported_at) VALUES (?, ?, 0, ?)")
          .run(projectId, join(dir, "ui.db"), new Date().toISOString())
        alreadyImported.add(projectId)
        ntwineLog.info("ntwine-db", `${projectId}: restored ui.db.imported to ui.db and recorded it as imported`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ntwineLog.warn("ntwine-db", `${projectId}: could not restore ui.db.imported: ${detail}`)
      }
    }
    for (const projectId of legacyProjectIds(projectsDir)) {
      if (alreadyImported.has(projectId)) continue
      const legacyPath = join(projectsDir, projectId, "ui.db")
      try {
        const rows = importLegacyProject(db, projectId, legacyPath)
        imported.push({ projectId, rows })
        ntwineLog.info("ntwine-db", `imported ${projectId} (${rows} rows) from ${legacyPath}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ntwineLog.error("ntwine-db", `${projectId}: could not import ${legacyPath}, will retry next boot: ${detail}`)
      }
    }
  }

  const purge = db.transaction((projectId: string) => {
    for (const table of [...NTWINE_DB_TABLES, "imported_project"]) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId)
    }
  })

  let closed = false
  return {
    db,
    path,
    imported,
    purgeProject: (projectId) => purge.immediate(projectId),
    close: () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

function projectIdsWithFile(projectsDir: string, file: string): string[] {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir)
    .filter((name) => {
      try {
        return statSync(join(projectsDir, name, file)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

function legacyProjectIds(projectsDir: string): string[] {
  return projectIdsWithFile(projectsDir, "ui.db")
}

/** Projects holding only the first cut's `ui.db.imported` — see the note at the scan. */
function retiredLegacyProjectIds(projectsDir: string): string[] {
  return projectIdsWithFile(projectsDir, "ui.db.imported")
    .filter((id) => !existsSync(join(projectsDir, id, "ui.db")))
}

function tableColumns(db: Database, schema: string, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA ${schema}.table_info(${table})`).all().map((c) => c.name)
}

/**
 * Copy one legacy file's rows in and record it. Returns the rows copied.
 *
 * The legacy stack runs FIRST, on the file's own connection, and that connection closes before the
 * ATTACH: closing checkpoints the WAL, so the attached read sees every committed row.
 */
function importLegacyProject(db: Database, projectId: string, legacyPath: string): number {
  const legacy = new Database(legacyPath)
  try {
    legacy.pragma("busy_timeout = 5000")
    migrateLegacyProjectDatabase(legacy)
  } finally {
    legacy.close()
  }
  db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath)
  let rows = 0
  try {
    const legacyTables = new Set(
      db.prepare<[], { name: string }>("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    )
    const copy = db.transaction(() => {
      for (const table of NTWINE_DB_TABLES) {
        if (!legacyTables.has(table)) continue
        const target = new Set(tableColumns(db, "main", table))
        const columns = tableColumns(db, "legacy", table).filter((c) => c !== "project_id" && target.has(c))
        if (columns.length === 0) continue
        const list = columns.map((c) => `"${c}"`).join(", ")
        rows += db.prepare(
          `INSERT OR IGNORE INTO main."${table}" (project_id, ${list}) SELECT ?, ${list} FROM legacy."${table}"`,
        ).run(projectId).changes
      }
      db.prepare("INSERT INTO imported_project (project_id, source, rows, imported_at) VALUES (?, ?, ?, ?)")
        .run(projectId, legacyPath, rows, new Date().toISOString())
    })
    copy.immediate()
  } finally {
    db.exec("DETACH DATABASE legacy")
  }
  return rows
}
