import { mkdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import Database from "./sqlite.ts"
import { CODEX_APP_SERVER_TABLES, ensureCodexAppServerSchema } from "./backend/codex-app-server.ts"
import { ntwinePaths, ntwineRoots } from "./ntwine-paths.ts"
import { INTERACTION_TABLES, ensureInteractionSchema } from "./interaction-store.ts"
import { STORAGE_TABLES, ensureStorageSchema } from "./storage.ts"
import { TAIL_STATE_TABLES, ensureTailStateSchema } from "./tail-cache.ts"
import { WAKE_DELIVERY_TABLES, ensureWakeDeliverySchema } from "./wake-store.ts"

// ONE DATABASE FOR THE MACHINE — `<data>/ui.db` (2026-08-27).
//
// ntwine kept one SQLite file per project, `<data>/projects/<id>/ui.db`, from the day it stored
// anything: each server served one repo and owned that repo's file. The singleton (one server, every
// project — see ARCHITECTURE.md) kept the files and opened all of them, which is how a bad migration
// on 2026-08-27 could leave seven of fifty-four unopenable at once, with the launch project among
// them and the restart aborted. The maintainer's call was that the per-project file was a vestige of
// the one-server-per-repo era and should go. This module is the one file that replaced them: opened
// ONCE per process at boot, handed to every tenant, and closed after the last tenant.
//
// NO IMPORT ANY MORE (2026-10-14). From 2026-08-27 every open also copied each per-project file still
// on disk into this one, once, recorded in an `imported_project` ledger. After a usage audit the
// maintainer cut the importer and the legacy schema stack it carried: a per-project `ui.db` left on
// disk is now never read, and a machine that never booted an importing build starts with an empty
// board. The ledger is neither created nor dropped. A file that has one keeps it untouched, so an
// older build stepped back to still sees its projects as imported rather than copying them in again.

export interface NtwineDatabase {
  readonly db: Database
  readonly path: string
  /** Delete every row a project has in every table — the database half of removing a project. */
  purgeProject(projectId: string): void
  close(): void
}

export interface OpenNtwineDatabaseOptions {
  /**
   * THE LAUNCHING PROJECT'S STATE DIR, and the way production names the file: `<data>/projects/<id>`
   * puts it at `<data>/ui.db`. Derived rather than defaulted from `homedir()` for the reason
   * ntwine-paths.ts gives for the server address — and re-learned here the hard way (2026-08-27): a
   * `startServer` test with a fake project and the real HOME imported all fifty-four of the
   * maintainer's project files into `~/.ntwine/ui.db` under the live server. A state dir that is NOT `<root>/projects/<id>` (a test's
   * temp dir) gets a PRIVATE file inside it.
   */
  stateDir?: string
  /** A sandbox home whose data root holds the file — ntwine-db.test.ts. Ignored when stateDir is set. */
  home?: string
  /** Override the file itself — tests and the sandbox stacks. */
  path?: string
}

/** Every table that lives in the unified file — each keyed by `project_id`, which is what purgeProject relies on. */
export const NTWINE_DB_TABLES: readonly string[] = [
  ...STORAGE_TABLES,
  ...WAKE_DELIVERY_TABLES,
  ...TAIL_STATE_TABLES,
  ...CODEX_APP_SERVER_TABLES,
  ...INTERACTION_TABLES,
]

/** Where the file lives — see OpenNtwineDatabaseOptions. */
export function ntwineDatabaseLocation(options: Pick<OpenNtwineDatabaseOptions, "stateDir" | "home" | "path">): string {
  if (options.path !== undefined) return options.path
  if (options.stateDir !== undefined) {
    const projectsDir = dirname(options.stateDir)
    if (basename(projectsDir) === "projects") return join(dirname(projectsDir), "ui.db")
    return join(options.stateDir, "ui.db")
  }
  const data = options.home ? ntwinePaths({ home: options.home }).data : ntwineRoots().data
  return join(data, "ui.db")
}

export function ntwineDatabasePath(home?: string): string {
  return ntwineDatabaseLocation({ home })
}

/** Every schema owner's DDL, idempotent, in one place. */
export function ensureNtwineSchema(db: Database): void {
  ensureStorageSchema(db)
  ensureWakeDeliverySchema(db)
  ensureTailStateSchema(db)
  ensureCodexAppServerSchema(db)
  ensureInteractionSchema(db)
}

export function openNtwineDatabase(options: OpenNtwineDatabaseOptions = {}): NtwineDatabase {
  const path = ntwineDatabaseLocation(options)
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")
  ensureNtwineSchema(db)

  const purge = db.transaction((projectId: string) => {
    for (const table of NTWINE_DB_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId)
    }
  })

  let closed = false
  return {
    db,
    path,
    purgeProject: (projectId) => purge.immediate(projectId),
    close: () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
