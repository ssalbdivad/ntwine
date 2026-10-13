// Frizz's SQLite driver: better-sqlite3's SHAPE, node:sqlite's implementation.
//
// WHY THIS FILE EXISTS. better-sqlite3 is a native addon, and a native addon carries a Node-API floor
// that moves without warning. Its 13.x prebuild is built with `NAPI_VERSION=10`, which exists only
// from Node 22.14 and 23.6, while the package itself declares `engines: ">=22"` — so on Node 22.12 it
// does not fail to load, it SEGFAULTS inside `napi_module_register_by_symbol`, killing the board
// before it can report anything. `node:sqlite` is built into the runtime: no prebuild, no ABI, no
// floor of its own beyond the release that shipped it (22.13 / 23.4), and no way for that floor to
// change under a `pnpm update`.
//
// This adapter keeps the ~300 existing `prepare`/`run`/`get`/`all` call sites exactly as they were.
// It is intentionally NOT a general better-sqlite3 polyfill — it implements the surface Frizz actually
// uses and nothing else, so there is no dead code pretending to be supported.
//
// The differences it has to paper over were MEASURED against better-sqlite3 13.0.2, not assumed:
//   • node:sqlite rejects unknown keys in a named-parameter object; better-sqlite3 ignores them, and
//     Frizz relies on that — it passes whole row objects to statements that bind a subset.
//   • node:sqlite refuses to bind `undefined`; better-sqlite3 binds NULL, and Frizz's row types are
//     full of optional fields.
//   • node:sqlite binds a MISSING named parameter as NULL instead of throwing. That one is a silent
//     data-corruption hazard in a persistence layer, so it is re-implemented here rather than lost.
//   • `exec()` returns the database in better-sqlite3 and undefined in node:sqlite.
//   • node:sqlite has no `pragma()` and no `transaction()` at all.
// One difference is deliberate rather than corrected: a bare `transaction()` here is IMMEDIATE, not
// DEFERRED. See transaction() for the measurement that decided it.
import { createRequire } from "node:module"
import "./sqlite-quiet.ts"
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite"

// Loaded through createRequire rather than `import { DatabaseSync } from "node:sqlite"`, and the
// difference is load-bearing. A static import of an EXTERNAL module is hoisted to the very top of
// esbuild's bundle — above the inlined body of `sqlite-quiet.ts` — so in the published artifact the
// warning was emitted before the filter that suppresses it was installed. It leaked into the launcher
// readout on Node 22.13, and only the built artifact showed it; the dev source, which is not bundled,
// looked fine. A require() is a plain call expression, so it runs where it is written.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType
}

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface Statement<Row = any> {
  run(...params: any[]): RunResult
  get(...params: any[]): Row | undefined
  all(...params: any[]): Row[]
}

/** A transaction function, with better-sqlite3's mode selectors hanging off it. */
export type Transaction<A extends any[], R> = ((...args: A) => R) & {
  default: (...args: A) => R
  deferred: (...args: A) => R
  immediate: (...args: A) => R
  exclusive: (...args: A) => R
}

/**
 * Named parameters referenced by a statement, so a missing one can throw the way better-sqlite3 did.
 *
 * A regex over the whole statement would find `@id` inside a string literal or a comment and then
 * demand a binding for it, so this walks the SQL and skips the places an identifier cannot live.
 * SQLite accepts `@name`, `:name` and `$name`; all three are normalized to the bare name, which is
 * how every Frizz call site passes them.
 */
export function namedParameters(sql: string): string[] {
  const found = new Set<string>()
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    if (char === "'" || char === '"' || char === "`") {
      const quote = char
      index++
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index++ // an escaped quote, not the end
          else break
        }
        index++
      }
      continue
    }
    if (char === "[") {
      while (index < sql.length && sql[index] !== "]") index++
      continue
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++
      continue
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++
      index++
      continue
    }
    if (char === "@" || char === ":" || char === "$") {
      let end = index + 1
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end++
      if (end > index + 1) found.add(sql.slice(index + 1, end))
      index = end - 1
    }
  }
  return [...found]
}

function isNamedBagCandidate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date)
  )
}

/**
 * node:sqlite hands back rows with a NULL prototype; better-sqlite3 returns ordinary objects.
 *
 * This is not cosmetic. `assert.deepStrictEqual(row, { … })` fails against a null-prototype object
 * even when every key and value matches — which is exactly how it surfaced, as a codex-app-server
 * test comparing a persisted row to a literal. Anything that reaches for `Object.prototype` on a row
 * would fail the same way and much more quietly, so rows are normalized once, here.
 */
function plainRow(row: unknown): unknown {
  return row === undefined || row === null ? row : Object.assign({}, row)
}

/** Bare or prefixed — accept whichever spelling the caller used, as better-sqlite3 did. */
function hasBinding(bag: Record<string, unknown>, name: string): boolean {
  return name in bag || `@${name}` in bag || `:${name}` in bag || `$${name}` in bag
}

class PreparedStatement<Row> implements Statement<Row> {
  readonly #statement: StatementSync
  readonly #required: string[]
  readonly #sql: string

  constructor(statement: StatementSync, sql: string) {
    this.#statement = statement
    this.#sql = sql
    this.#required = namedParameters(sql)
  }

  /**
   * Build exactly the bindings this statement asks for, and nothing else.
   *
   * Frizz hands whole row objects to statements that bind a subset of their fields, which raw
   * node:sqlite rejects with "Unknown named parameter". The obvious fix is
   * `setAllowUnknownNamedParameters(true)` — but that method only exists from Node 23.11, and using it
   * would have raised Frizz's floor above the release that first shipped `node:sqlite` at all, for no
   * reason. Selecting the required names from the bag needs no runtime API, and gets the same result.
   *
   * A name the caller never supplied throws, rather than binding NULL the way node:sqlite would.
   * See the file header: silently writing NULL where a value was expected is the one difference that
   * could quietly corrupt data instead of failing.
   *
   * A bag FOLLOWED BY positional values binds both (2026-08-27): node:sqlite's own signature is
   * `run(namedParameters?, ...anonymousParameters)`, and `?` placeholders take the anonymous values in
   * order no matter where the named ones sit in the text (measured on Node 26 before this shipped).
   * better-sqlite3 accepted the same mix. It is what lets a project-scoped statement carry
   * `project_id = @project_id` while its call sites keep passing their existing positional arguments —
   * see project-scope.ts.
   */
  #bind(params: any[]): any[] {
    if (params.length >= 1 && this.#required.length > 0 && isNamedBagCandidate(params[0])) {
      const bag = params[0] as Record<string, unknown>
      const bound: Record<string, unknown> = {}
      for (const name of this.#required) {
        if (!hasBinding(bag, name)) {
          throw new RangeError(
            `Missing named parameter "${name}" for statement: ${this.#sql.trim().slice(0, 120)}`
          )
        }
        const value = name in bag ? bag[name] : (bag[`@${name}`] ?? bag[`:${name}`] ?? bag[`$${name}`])
        bound[name] = value === undefined ? null : value
      }
      return [bound, ...params.slice(1).map((value) => (value === undefined ? null : value))]
    }
    return params.map((value) => (value === undefined ? null : value))
  }

  run(...params: any[]): RunResult {
    const result = this.#statement.run(...this.#bind(params))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  get(...params: any[]): Row | undefined {
    return plainRow(this.#statement.get(...this.#bind(params))) as Row | undefined
  }

  all(...params: any[]): Row[] {
    return (this.#statement.all(...this.#bind(params)) as unknown[]).map(plainRow) as Row[]
  }
}

export interface DatabaseOptions {
  /** better-sqlite3's spelling; node:sqlite calls it `readOnly`. */
  readonly?: boolean
}

/**
 * Track whether `sql` opens or closes a transaction.
 *
 * `storage.ts` runs its adoption fence by hand — `exec("BEGIN IMMEDIATE")` … `exec("COMMIT")` — and
 * then asks `db.inTransaction` whether it still owes a ROLLBACK, so the flag has to see manual
 * statements and not just the ones `transaction()` issues. `ROLLBACK TO <savepoint>` and `RELEASE`
 * deliberately do NOT end the enclosing transaction, which is why this cannot be a keyword match.
 */
function transactionControl(sql: string): "open" | "close" | null {
  let last: "open" | "close" | null = null
  for (const statement of sql.split(";")) {
    const text = statement.trim().toUpperCase()
    if (/^BEGIN\b/.test(text)) last = "open"
    else if (/^(COMMIT|END)\b/.test(text)) last = "close"
    else if (/^ROLLBACK\b/.test(text) && !/^ROLLBACK\s+TO\b/.test(text)) last = "close"
  }
  return last
}

/** Distinct SQL texts kept compiled per connection. Frizz prepares a few hundred; see Database.#compiled. */
export const STATEMENT_CACHE_CAP = 1024

export class Database {
  readonly #db: DatabaseSyncType
  /** Transaction nesting depth, so a nested transaction becomes a SAVEPOINT rather than an error. */
  #depth = 0
  /** Fallback transaction state for runtimes without `isTransaction` (added in Node 24). */
  #openTransaction = false
  /** Compiled statements by SQL text — see #compiled. Insertion order is LRU order. */
  readonly #statements = new Map<string, StatementSync>()

  /** How many distinct statements this connection holds compiled (observability for tests). */
  get compiledStatements(): number {
    return this.#statements.size
  }
  /** better-sqlite3 exposes the database file here; the scheduler tests reopen a store through it. */
  readonly name: string

  constructor(path: string, options: DatabaseOptions = {}) {
    this.name = path
    this.#db = new DatabaseSync(path, options.readonly ? { readOnly: true } : {})
  }

  /** True while a transaction is open, however it was opened. */
  get inTransaction(): boolean {
    const native = (this.#db as { isTransaction?: boolean }).isTransaction
    return typeof native === "boolean" ? native : this.#openTransaction
  }

  /**
   * Type parameters are `<BindParameters, Row>`, matching better-sqlite3 — 53 call sites already
   * spell them that way (`prepare<[string], SessionRow>`), and silently swapping the order would
   * type every one of them as `any` rather than failing loudly.
   */
  prepare<BindParameters extends any[] | object = any[], Row = any>(sql: string): Statement<Row> {
    return new PreparedStatement<Row>(this.#compiled(sql), sql)
  }

  /**
   * ONE compiled statement per distinct SQL text on this connection, however many callers prepare it.
   *
   * Every project's storage (and its interaction and wake stores) prepares the same ~190 statements
   * against the one shared connection, differing only in the `@project_id` they BIND — so a server
   * serving 12 projects held 12 compiled copies of each: ~2,300 statements, ~1.4 MB of SQLite malloc
   * per project (measured: 12 storages on one connection took MALLOC_SMALL from 20.5 to 35.8 MB).
   *
   * Sharing is safe because nothing outside this file can reach the native statement: a
   * PreparedStatement exposes only run/get/all, each of which binds afresh and runs to completion
   * synchronously — there is no iterator to hold a statement open across another caller's use, and no
   * per-statement option (readBigInts, bare named parameters) a caller could set for everyone else.
   *
   * Bounded, so SQL built from data could never grow it without limit: the text interpolated today
   * is table and column names only, but the cap is what makes that a fact about the cache rather than
   * about every future call site. An evicted statement stays alive for whoever still holds it.
   */
  #compiled(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (statement) {
      this.#statements.delete(sql) // LRU touch
    } else {
      statement = this.#db.prepare(sql)
    }
    this.#statements.set(sql, statement)
    if (this.#statements.size > STATEMENT_CACHE_CAP) {
      const oldest = this.#statements.keys().next().value
      if (oldest !== undefined) this.#statements.delete(oldest)
    }
    return statement
  }

  /** Returns the database, matching better-sqlite3, so existing `db.exec(a).exec(b)` chains hold. */
  exec(sql: string): this {
    this.#db.exec(sql)
    const control = transactionControl(sql)
    if (control === "open") this.#openTransaction = true
    else if (control === "close") this.#openTransaction = false
    return this
  }

  /**
   * `PRAGMA` with better-sqlite3's calling convention. Frizz only ever SETS pragmas (`journal_mode`,
   * `busy_timeout`, `foreign_keys`) and ignores the result, but returning the rows keeps the shape
   * honest for a read like `pragma("journal_mode")`.
   */
  pragma(source: string): unknown {
    const sql = `PRAGMA ${source}`
    try {
      return this.#db.prepare(sql).all()
    } catch {
      // A handful of pragmas cannot be prepared as a statement; run them and report nothing.
      this.#db.exec(sql)
      return undefined
    }
  }

  /**
   * better-sqlite3's `transaction()`, including the part that is easy to miss: it is RE-ENTRANT.
   * Calling one transaction-wrapped function from inside another must not throw "cannot start a
   * transaction within a transaction" — better-sqlite3 quietly switches to a SAVEPOINT, and Frizz's
   * storage layer composes these freely, so the nesting has to survive the port.
   */
  transaction<A extends any[], R>(fn: (...args: A) => R): Transaction<A, R> {
    const runWith = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE") => (...args: A): R => {
      // Routed through this.exec(), not the raw driver, so `inTransaction` stays accurate on the
      // Node releases that predate node:sqlite's own `isTransaction` (added in 24).
      const depth = this.#depth
      const savepoint = `frizz_txn_${depth}`
      this.#depth = depth + 1
      try {
        this.exec(depth === 0 ? `BEGIN ${mode}` : `SAVEPOINT ${savepoint}`)
        let result: R
        try {
          result = fn(...args)
        } catch (error) {
          // Roll back to exactly the point this level opened, then release the savepoint it created —
          // ROLLBACK TO leaves the savepoint on the stack, and leaking it wedges the enclosing level.
          this.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`)
          if (depth > 0) this.exec(`RELEASE ${savepoint}`)
          throw error
        }
        this.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`)
        return result
      } finally {
        this.#depth = depth
      }
    }
    // The DEFAULT is IMMEDIATE, which is the one place this deliberately diverges from
    // better-sqlite3 (whose bare `transaction()` is DEFERRED). Measured, 6 processes × 40 writes
    // against one WAL database, each transaction reading then writing:
    //
    //   deferred, read-then-write   better-sqlite3 186/240   this adapter 109/240
    //   immediate, read-then-write  better-sqlite3 240/240   this adapter 240/240
    //
    // A DEFERRED transaction takes a read lock first and must UPGRADE it to write. SQLite cannot
    // always wait for that upgrade — busy_timeout does not save it — so a concurrent writer gets
    // "database is locked" and the write is simply LOST. Both drivers lose writes there; the adapter
    // lost more, which is what made this worth fixing rather than matching.
    //
    // IMMEDIATE takes the write lock up front, so a loser waits out busy_timeout instead of failing.
    // Every transaction Frizz runs without an explicit mode is a write path, and the one genuine
    // read-only snapshot asks for `.deferred()` by name — so nothing pays for a lock it does not need.
    const wrapper = runWith("IMMEDIATE") as Transaction<A, R>
    wrapper.default = wrapper
    wrapper.deferred = runWith("DEFERRED")
    wrapper.immediate = runWith("IMMEDIATE")
    wrapper.exclusive = runWith("EXCLUSIVE")
    return wrapper
  }

  close(): void {
    this.#statements.clear()
    this.#db.close()
  }
}

export default Database
