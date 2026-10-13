import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Database, { namedParameters } from "./sqlite.ts"

/**
 * These assertions were written by running them against better-sqlite3 13.0.2 FIRST and recording
 * what it did, so this file pins the adapter to measured behaviour rather than to what the port's
 * author hoped node:sqlite would do. Every case below is one Frizz's storage layer actually depends
 * on; the four marked DIVERGENCE are places raw node:sqlite behaves differently and the adapter has
 * to correct it.
 */

function withDb<T>(fn: (db: Database, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sqlite-"))
  const db = new Database(join(dir, "t.db"))
  try {
    return fn(db, dir)
  } finally {
    try { db.close() } catch { /* a test may have closed it already */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the pragmas Frizz sets on every connection apply", () => {
  withDb((db) => {
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.pragma("foreign_keys = ON")
    assert.equal((db.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]?.journal_mode, "wal")
    assert.equal((db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys, 1)
  })
})

test("exec returns the database, so chained setup keeps working", () => {
  // DIVERGENCE: node:sqlite's exec() returns undefined.
  withDb((db) => {
    assert.equal(db.exec("create table t (a integer)"), db)
    assert.equal(db.exec("insert into t values (1)").exec("insert into t values (2)"), db)
    assert.equal(db.prepare("select count(*) c from t").get().c, 2)
  })
})

test("statements bind positionally and by bare name, exactly as Frizz calls them", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text, c integer)")
    db.prepare("insert into t (a,b,c) values (?,?,?)").run(1, "positional", 10)
    db.prepare("insert into t (a,b,c) values (@a,@b,@c)").run({ a: 2, b: "bare", c: 20 })
    assert.equal(db.prepare("select b from t where a=?").get(1)?.b, "positional")
    assert.equal(db.prepare("select b from t where a=?").get(2)?.b, "bare")
    assert.equal(db.prepare("select a from t order by a").all().length, 2)
    assert.equal(db.prepare("select a from t where a=999").get(), undefined)
  })
})

test("a prefixed key also binds — a documented SUPERSET of better-sqlite3, not a port of it", () => {
  // Recorded so the difference is deliberate rather than discovered later: better-sqlite3 REJECTS
  // `{"@a": 1}` with `Missing named parameter "a"`, while node:sqlite accepts the prefixed spelling.
  // Nothing in Frizz writes keys this way; being laxer here cannot break a caller that never did.
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text)")
    assert.doesNotThrow(() => db.prepare("insert into t (a,b) values (@a,@b)").run({ "@a": 1, "@b": "prefixed" }))
    assert.equal(db.prepare("select b from t where a=1").get()?.b, "prefixed")
  })
})

test("run reports changes and lastInsertRowid as plain numbers", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key autoincrement, b text)")
    const result = db.prepare("insert into t (b) values (?)").run("x")
    assert.equal(result.changes, 1)
    assert.equal(typeof result.changes, "number")
    assert.equal(typeof result.lastInsertRowid, "number")
    assert.equal(result.lastInsertRowid, 1)
    assert.equal(db.prepare("update t set b=? where a=?").run("y", 1).changes, 1)
    assert.equal(db.prepare("update t set b=? where a=?").run("y", 999).changes, 0)
  })
})

test("a whole row object may be bound to a statement that uses only some of its fields", () => {
  // DIVERGENCE: raw node:sqlite throws "Unknown named parameter". Frizz does this everywhere —
  // normalizeSessionRow hands full SessionRow objects to narrow statements.
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text)")
    const row = { a: 1, b: "kept", ignored: "extra", alsoIgnored: 42 }
    assert.doesNotThrow(() => db.prepare("insert into t (a,b) values (@a,@b)").run(row))
    assert.equal(db.prepare("select b from t where a=1").get()?.b, "kept")
  })
})

test("undefined binds as NULL, because optional row fields arrive that way", () => {
  // DIVERGENCE: raw node:sqlite refuses to bind undefined at all.
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text, c integer)")
    assert.doesNotThrow(() => db.prepare("insert into t (a,b,c) values (@a,@b,@c)").run({ a: 1, b: undefined, c: null }))
    assert.doesNotThrow(() => db.prepare("insert into t (a,b,c) values (?,?,?)").run(2, undefined, undefined))
    assert.equal(db.prepare("select b from t where a=1").get()?.b, null)
    assert.equal(db.prepare("select c from t where a=2").get()?.c, null)
  })
})

test("a named parameter the caller forgot still throws instead of silently binding NULL", () => {
  // DIVERGENCE, and the one that matters most: node:sqlite binds a missing name as NULL, which in a
  // persistence layer is silent corruption. better-sqlite3 threw, so the adapter throws.
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text, c integer)")
    assert.throws(
      () => db.prepare("insert into t (a,b,c) values (@a,@b,@c)").run({ a: 1, b: "x" }),
      /Missing named parameter "c"/
    )
    assert.equal(db.prepare("select count(*) c from t").get().c, 0, "nothing was written")
  })
})

test("namedParameters ignores anything that is not really a parameter", () => {
  assert.deepEqual(namedParameters("insert into t (a,b) values (@a,@b)").sort(), ["a", "b"])
  assert.deepEqual(namedParameters("select :one, $two, @three").sort(), ["one", "three", "two"])
  // A literal, a comment and a quoted identifier must not invent bindings that can never be supplied.
  assert.deepEqual(namedParameters("select '@notAParam' where x = @real"), ["real"])
  assert.deepEqual(namedParameters("-- @commented\nselect @real"), ["real"])
  assert.deepEqual(namedParameters("/* @blockComment */ select @real"), ["real"])
  assert.deepEqual(namedParameters('select "@quotedIdent" , @real'), ["real"])
  assert.deepEqual(namedParameters("select 'it''s @escaped' , @real"), ["real"])
  assert.deepEqual(namedParameters("select 1"), [])
})

test("a transaction commits its work and returns the function's value", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const insert = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      return `wrote ${n}`
    })
    assert.equal(insert(1), "wrote 1")
    assert.equal(db.prepare("select count(*) c from t").get().c, 1)
  })
})

test("a throwing transaction rolls back and rethrows", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const boom = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      throw new Error("nope")
    })
    assert.throws(() => boom(1), /nope/)
    assert.equal(db.prepare("select count(*) c from t").get().c, 0, "the insert was rolled back")
    // The connection is usable afterwards — a leaked open transaction would wedge every later write.
    assert.doesNotThrow(() => db.prepare("insert into t values (?)").run(2))
    assert.equal(db.prepare("select count(*) c from t").get().c, 1)
  })
})

test("transactions nest via savepoints, the way better-sqlite3's do", () => {
  // storage.ts composes transaction-wrapped functions, so a naive BEGIN/COMMIT port would throw
  // "cannot start a transaction within a transaction" on whichever path happened to nest.
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const inner = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      return n
    })
    const outer = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      inner(n + 1)
      return "done"
    })
    assert.equal(outer(1), "done")
    assert.deepEqual(db.prepare("select a from t order by a").all().map((r: any) => r.a), [1, 2])
  })
})

test("an inner transaction that throws unwinds only its own work when the outer catches", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const inner = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      throw new Error("inner failed")
    })
    const outer = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      try { inner(n + 1) } catch { /* the outer deliberately survives its child */ }
      return "outer committed"
    })
    assert.equal(outer(1), "outer committed")
    assert.deepEqual(
      db.prepare("select a from t order by a").all().map((r: any) => r.a),
      [1],
      "the outer row survives and the inner row is gone"
    )
  })
})

test("an inner failure that propagates rolls the whole thing back", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const inner = db.transaction(() => { throw new Error("inner failed") })
    const outer = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      inner()
    })
    assert.throws(() => outer(1), /inner failed/)
    assert.equal(db.prepare("select count(*) c from t").get().c, 0)
    assert.doesNotThrow(() => db.prepare("insert into t values (?)").run(9), "connection is not wedged")
  })
})

test("immediate, deferred and exclusive are all callable and all transactional", () => {
  // interaction-store and wake-store use .immediate() specifically, to take the write lock up front
  // rather than discovering a conflict at COMMIT.
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    const write = db.transaction((n: number) => {
      db.prepare("insert into t values (?)").run(n)
      return n
    })
    assert.equal(write.immediate(1), 1)
    assert.equal(write.deferred(2), 2)
    assert.equal(write.exclusive(3), 3)
    assert.equal(write.default(4), 4)
    assert.equal(db.prepare("select count(*) c from t").get().c, 4)
    assert.throws(() => db.transaction(() => { throw new Error("x") }).immediate(), /x/)
    assert.doesNotThrow(() => write(5), "the failed immediate txn did not leave one open")
  })
})

test("a default transaction takes the WRITE lock up front, unlike better-sqlite3's", () => {
  // The deliberate divergence, and the reason for it. A DEFERRED transaction must upgrade its read
  // lock to a write lock, which SQLite cannot always wait for — busy_timeout does not help, the write
  // just fails with "database is locked" and is LOST. Measured across 6 processes × 40 read-then-write
  // transactions: deferred managed 186/240 on better-sqlite3 and 109/240 here; immediate is 240/240 on
  // both. Frizz's default transactions are all write paths, so they take the lock they are going to need.
  const dir = mkdtempSync(join(tmpdir(), "frizz-sqlite-lock-"))
  const path = join(dir, "t.db")
  try {
    const writer = new Database(path)
    writer.pragma("journal_mode = WAL")
    writer.exec("create table t (a integer primary key)")

    const other = new Database(path)
    other.pragma("busy_timeout = 100")
    writer.transaction(() => {
      // The write lock is already held, so a second connection cannot take it. That is only true if
      // the default mode is IMMEDIATE; a DEFERRED transaction would not have acquired it yet.
      assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked|busy/i)
      writer.prepare("insert into t values (?)").run(1)
    })()

    // Once it commits the lock is released and the other connection proceeds normally.
    assert.doesNotThrow(() => {
      other.exec("BEGIN IMMEDIATE")
      other.prepare("insert into t values (?)").run(2)
      other.exec("COMMIT")
    })
    assert.deepEqual(writer.prepare("select a from t order by a").all().map((r: any) => r.a), [1, 2])

    // `.deferred()` still exists for a genuine read-only snapshot that must not block writers.
    assert.doesNotThrow(() => writer.transaction(() => writer.prepare("select count(*) c from t").get()).deferred())
    writer.close()
    other.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a constraint violation surfaces as an error and leaves the table clean", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    db.prepare("insert into t values (?)").run(1)
    assert.throws(() => db.prepare("insert into t values (?)").run(1), /UNIQUE constraint failed/)
    assert.equal(db.prepare("select count(*) c from t").get().c, 1)
  })
})

test("rows are ordinary objects, so deepStrictEqual against a literal still works", () => {
  // DIVERGENCE: node:sqlite returns null-prototype rows, and `assert.deepStrictEqual(row, {…})` fails
  // against those even when every key and value matches. A codex-app-server test caught exactly that.
  withDb((db) => {
    db.exec("create table t (a integer primary key, b text)")
    db.prepare("insert into t (a,b) values (?,?)").run(1, "x")
    const row = db.prepare("select a, b from t where a=?").get(1)
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.deepEqual(row, { a: 1, b: "x" })
    const rows = db.prepare("select a, b from t").all()
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype)
    assert.deepEqual(rows, [{ a: 1, b: "x" }])
    assert.equal(db.prepare("select a from t where a=999").get(), undefined, "a miss stays undefined")
  })
})

test("inTransaction sees a hand-rolled BEGIN, not just transaction()", () => {
  // storage.ts opens its adoption fence by hand and then asks whether it still owes a ROLLBACK, so a
  // flag that only tracked transaction() would leave a transaction open on every error path.
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    assert.equal(db.inTransaction, false)
    db.exec("BEGIN IMMEDIATE")
    assert.equal(db.inTransaction, true)
    db.prepare("insert into t values (?)").run(1)
    db.exec("COMMIT")
    assert.equal(db.inTransaction, false)

    db.exec("BEGIN")
    db.exec("ROLLBACK")
    assert.equal(db.inTransaction, false)

    // A savepoint rollback/release does NOT end the enclosing transaction.
    db.exec("BEGIN")
    db.exec("SAVEPOINT sp")
    db.exec("ROLLBACK TO sp")
    assert.equal(db.inTransaction, true, "ROLLBACK TO must not look like the end of the transaction")
    db.exec("RELEASE sp")
    assert.equal(db.inTransaction, true)
    db.exec("COMMIT")
    assert.equal(db.inTransaction, false)
  })
})

test("inTransaction is true inside a transaction() body and false once it settles", () => {
  withDb((db) => {
    db.exec("create table t (a integer primary key)")
    let seenInside: boolean | undefined
    db.transaction(() => { seenInside = db.inTransaction })()
    assert.equal(seenInside, true)
    assert.equal(db.inTransaction, false)
    try { db.transaction(() => { throw new Error("x") })() } catch { /* expected */ }
    assert.equal(db.inTransaction, false, "a failed transaction leaves nothing open")
  })
})

test("the database exposes its path, and opens read-only on request", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sqlite-ro-"))
  const path = join(dir, "ui.db")
  try {
    const writable = new Database(path)
    assert.equal(writable.name, path, "scheduler tests reopen a store through .name")
    writable.exec("create table t (a integer primary key)")
    writable.prepare("insert into t values (?)").run(1)
    writable.close()

    const readonly = new Database(path, { readonly: true })
    assert.equal(readonly.prepare("select count(*) c from t").get().c, 1)
    assert.throws(() => readonly.prepare("insert into t values (?)").run(2), /readonly|read-only/i)
    readonly.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("data written by one connection is visible to the next, through a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sqlite-reopen-"))
  const path = join(dir, "ui.db")
  try {
    const first = new Database(path)
    first.pragma("journal_mode = WAL")
    first.exec("create table t (a integer primary key, b text)")
    first.prepare("insert into t (a,b) values (?,?)").run(1, "persisted")
    first.close()

    const second = new Database(path)
    assert.equal(second.prepare("select b from t where a=1").get()?.b, "persisted")
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("callers preparing the SAME SQL share one compiled statement, and each call still binds its own values", () => {
  withDb((db) => {
    db.exec("CREATE TABLE row (project_id TEXT NOT NULL, slug TEXT NOT NULL, n INTEGER)")
    // What every project's storage does on the one shared connection: the same text, a different id.
    const insertA = db.prepare("INSERT INTO row (project_id, slug, n) VALUES (@project_id, @slug, @n)")
    const insertB = db.prepare("INSERT INTO row (project_id, slug, n) VALUES (@project_id, @slug, @n)")
    const readA = db.prepare<[], { slug: string; n: number }>("SELECT slug, n FROM row WHERE project_id = @project_id ORDER BY slug")
    const readB = db.prepare<[], { slug: string; n: number }>("SELECT slug, n FROM row WHERE project_id = @project_id ORDER BY slug")
    assert.equal(db.compiledStatements, 2, "four prepares of two texts compile two statements")

    insertA.run({ project_id: "a", slug: "x", n: 1 })
    insertB.run({ project_id: "b", slug: "x", n: 2 })
    insertA.run({ project_id: "a", slug: "y", n: 3 })
    // Interleaved reads through the two handles: a get() on one between all()s on the other.
    assert.deepEqual(readA.all({ project_id: "a" }), [{ slug: "x", n: 1 }, { slug: "y", n: 3 }])
    assert.deepEqual(readB.get({ project_id: "b" }), { slug: "x", n: 2 })
    assert.deepEqual(readA.get({ project_id: "a" }), { slug: "x", n: 1 })
    assert.deepEqual(readB.all({ project_id: "b" }), [{ slug: "x", n: 2 }])
    // A missing named parameter still throws per CALL, not per compiled statement.
    assert.throws(() => readB.all({}), /Missing named parameter "project_id"/)
  })
})

test("the compiled-statement cache is bounded, and an evicted statement keeps working for its holder", async () => {
  const { STATEMENT_CACHE_CAP } = await import("./sqlite.ts")
  withDb((db) => {
    db.exec("CREATE TABLE t (v INTEGER)")
    const first = db.prepare<[], { v: number }>("SELECT 0 AS v")
    for (let i = 1; i <= STATEMENT_CACHE_CAP + 10; i++) db.prepare(`SELECT ${i} AS v`)
    assert.equal(db.compiledStatements, STATEMENT_CACHE_CAP)
    assert.deepEqual(first.get(), { v: 0 }, "the oldest was evicted from the cache, not finalized")
  })
})
