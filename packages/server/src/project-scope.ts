import type Database from "./sqlite.ts"
import { namedParameters, type Statement } from "./sqlite.ts"

// ONE DATABASE, EVERY PROJECT — the seam that keeps a project's rows its own (2026-08-27).
//
// ntwine kept one SQLite file per project until this landed: `~/.ntwine/projects/<id>/ui.db`, fifty-four
// of them on the maintainer's machine, each carrying its own copy of every table and its own unversioned
// migration state. A bad migration (the retired thread_watch table coming back with a new shape) left
// seven of them unopenable at once and the launch project among them, which aborted a restart; the
// maintainer's verdict was that the per-project file was a vestige of the one-server-per-repo era and
// should go. So every table now carries `project_id`, one file holds every project, and this module is
// how a tenant addresses only its own rows without every call site learning that.
//
// A ProjectScope wraps the SHARED connection for ONE project. Its `prepare` REFUSES a statement that
// does not name `@project_id` — at prepare time, so a forgotten scope fails the first test that builds
// the storage rather than silently reading another project's thread — and the Statement it returns
// binds the project id itself: merged into a named bag, or supplied as a bag ahead of positional values
// (sqlite.ts binds both). Call sites keep their existing arguments.
//
// WHAT THE ASSERTION CANNOT SEE: a subquery. `WHERE slug = @slug AND NOT EXISTS (SELECT 1 FROM session
// WHERE slug = @slug)` names @project_id nowhere and would be refused; the same statement with the
// outer WHERE scoped and the inner one not would pass, and the inner one would then see every project.
// storage.test.ts's cross-project isolation case is the net for that — every method is run against one
// project with an identical twin in another, and the twin's rows are compared before and after.
//
// `writes` counts the `run()` calls through this scope that CHANGED a row. It is what storage.ts's
// memoised whole-table read invalidates on instead of `total_changes()`: the connection is shared, so
// that counter moves for every project's writes and would re-read this project's rows whenever ANY
// project wrote. A write to this project's rows can only come through this scope (or through a raw
// `db.exec`, which the boot repairs are — and they run before any cache exists), so the count is exact
// for the one connection.
//
// `writes(table)` narrows it to the statements that write THAT table, because the session cache was
// being thrown away by writes that could not have touched a session row. Measured 2026-10-01 on a
// mirror of the maintainer's machine (9 projects, 440 sessions, 6 threads streaming): the board
// re-read and re-materialised every session row on nearly every assemble — `readAllSessions` 932ms
// and `plainRow` 879ms of a 40s profile — because (a) the per-assemble snooze sweep is an UPDATE that
// usually matches nothing, and `writes++` counted it anyway (`total_changes()`, which this replaced,
// did not), and (b) the tailer's `tail_state` flush, every tick a transcript grows, bumped the same
// counter. So a run that changed nothing no longer counts, and a statement's target table is read off
// its SQL at prepare time. The classification is CONSERVATIVE: only a plain `INSERT INTO t` /
// `REPLACE INTO t` / `UPDATE t` / `DELETE FROM t` is attributed to `t`; anything else that writes (a
// `WITH … UPDATE`, a statement this parser does not recognise) counts against EVERY table, so a new
// statement can over-invalidate but never serve stale rows. Triggers are not followed: the schema's
// only trigger (`session_former_titles`) writes the table that fired it, so attributing the outer
// statement is already exact — re-check that if a trigger that crosses tables is ever added.

export interface ProjectScope {
  readonly projectId: string
  /** The shared connection. Raw access — a statement prepared here is NOT scoped; prefer `prepare`. */
  readonly db: Database
  /** A statement bound to this project. Throws unless `sql` names `@project_id`. The first type
   *  parameter is the caller's own bindings, spelled the way Database.prepare spells them. */
  prepare<BindParameters extends any[] | object = any[], Row = any>(sql: string): Statement<Row>
  /** How many row-changing `run()` calls this scope has made — against `table` (plus every write this
   *  module could not attribute) when one is named, else against any table. See the note above. */
  writes(table?: string): number
}

function isBag(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date)
  )
}

export function scopeDatabase(db: Database, projectId: string): ProjectScope {
  if (typeof projectId !== "string" || projectId.length === 0) throw new Error("a project scope needs a project id")
  let writes = 0
  // Per table, plus the writes no table could be read off ("*"), which count against every table.
  const byTable = new Map<string, number>()
  const bind = (params: any[]): any[] =>
    params.length >= 1 && isBag(params[0])
      ? [{ ...(params[0] as Record<string, unknown>), project_id: projectId }, ...params.slice(1)]
      : [{ project_id: projectId }, ...params]
  return {
    projectId,
    db,
    prepare<BindParameters extends any[] | object = any[], Row = any>(sql: string): Statement<Row> {
      if (!namedParameters(sql).includes("project_id")) {
        throw new Error(`unscoped statement prepared through a project scope: ${sql.trim().slice(0, 120)}`)
      }
      const statement = db.prepare<any[], Row>(sql)
      const target = writeTarget(sql)
      return {
        run: (...params: any[]) => {
          const result = statement.run(...bind(params))
          // `changes` is undefined only from a stub; count it then rather than risk a stale cache.
          if (result?.changes === undefined || Number(result.changes) > 0) {
            writes++
            if (target !== null) byTable.set(target, (byTable.get(target) ?? 0) + 1)
          }
          return result
        },
        get: (...params: any[]) => statement.get(...bind(params)),
        all: (...params: any[]) => statement.all(...bind(params)),
      }
    },
    writes: (table?: string) => (table === undefined ? writes : (byTable.get(table) ?? 0) + (byTable.get("*") ?? 0)),
  }
}

const PLAIN_WRITE = /^\s*(?:INSERT(?:\s+OR\s+[A-Za-z]+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?|DELETE\s+FROM)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?[\s(]/i
const READ_ONLY = /^\s*(?:SELECT|PRAGMA\s+[A-Za-z_]+\s*(?:\(|$))/i

/** The one table a statement writes, `"*"` when it writes something this cannot name, or `null` for a
 *  plain read (which a `run()` never changes rows through). Exported for its test. */
export function writeTarget(sql: string): string | null {
  const text = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "")
  const plain = PLAIN_WRITE.exec(text)
  if (plain) return plain[1]!.toLowerCase()
  if (READ_ONLY.test(text)) return null
  return "*"
}
