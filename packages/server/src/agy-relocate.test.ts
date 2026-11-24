import assert from "node:assert/strict"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import Database from "./sqlite.ts"
import { relocateAgyConversationDb, rewriteProtobufStrings, snapshotSqliteFile } from "./agy-relocate.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-agy-reloc-")))
after(() => rmSync(root, { recursive: true, force: true }))

function varint(n: number): Buffer {
  const out: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Buffer.from(out)
}

function ldField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload])
}

function varintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([varint((fieldNumber << 3) | 0), varint(value)])
}

function fixed64Field(fieldNumber: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint((fieldNumber << 3) | 1), bytes])
}

describe("protobuf wire-format string rewriting", () => {
  it("rewrites nested strings across length-varint boundaries while leaving other wire types intact", () => {
    const shortUri = "file:///a/repo"
    // Longer than 127 bytes so the enclosing message's length varint grows from 1 byte to 2 bytes.
    const longUri = `file:///${"segment/".repeat(18)}repo`
    const opaque = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xde, 0xad, 0xbe, 0xef])
    const inner = Buffer.concat([
      ldField(1, Buffer.from(shortUri, "utf8")),
      varintField(2, 42),
      ldField(3, Buffer.from("untouched", "utf8")),
    ])
    const outer = Buffer.concat([
      ldField(1, inner),
      fixed64Field(2, opaque),
      ldField(4, opaque), // non-UTF8 binary payload must stay byte-for-byte identical
    ])

    const grown = rewriteProtobufStrings(outer, (s) => (s === shortUri ? longUri : undefined))
    assert.ok(grown?.changed)
    const expectedInner = Buffer.concat([
      ldField(1, Buffer.from(longUri, "utf8")),
      varintField(2, 42),
      ldField(3, Buffer.from("untouched", "utf8")),
    ])
    const expectedOuter = Buffer.concat([
      ldField(1, expectedInner),
      fixed64Field(2, opaque),
      ldField(4, opaque),
    ])
    assert.deepEqual(grown.data, expectedOuter)

    // Round-trip back to the shorter string restores the exact original bytes.
    const shrunk = rewriteProtobufStrings(grown.data, (s) => (s === longUri ? shortUri : undefined))
    assert.ok(shrunk?.changed)
    assert.deepEqual(shrunk.data, outer)
  })

  it("returns undefined for truncated or non-protobuf blobs without throwing", () => {
    assert.equal(rewriteProtobufStrings(Buffer.from([0x0a, 0x20, 0x41]), () => "x"), undefined)
    assert.equal(rewriteProtobufStrings(Buffer.from([0x00]), () => "x"), undefined)
    assert.equal(rewriteProtobufStrings(Buffer.from([0x0b]), () => "x"), undefined) // wire type 3 (group)
  })
})

describe("relocating an Antigravity conversation database", () => {
  it("rewrites workspace URIs in metadata tables and leaves steps and gen_metadata byte-for-byte intact", () => {
    const dbPath = join(root, "conv.db")
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `)
    const meta = ldField(1, ldField(1, Buffer.from("file:///Users/ssalb/ntwine", "utf8")))
    const exec = Buffer.concat([
      ldField(12, Buffer.from("file:///Users/ssalb/ntwine", "utf8")),
      ldField(12, Buffer.from("file:///Users/ssalb/.gemini/antigravity-cli", "utf8")),
    ])
    const stepBlob = ldField(1, Buffer.from("file:///Users/ssalb/ntwine", "utf8"))
    const genBlob = ldField(1, Buffer.from("signed-thought:/Users/ssalb/ntwine", "utf8"))
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(meta)
    db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (0, ?)").run(exec)
    db.prepare("INSERT INTO steps (idx, step_payload) VALUES (0, ?)").run(stepBlob)
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)").run(genBlob)
    db.close()

    relocateAgyConversationDb(dbPath, [
      { from: "/Users/ssalb/ntwine", to: "/home/ssalb/code/ntwine" },
      { from: "/Users/ssalb", to: "/home/ssalb" },
    ])

    const check = new Database(dbPath, { readonly: true })
    try {
      const gotMeta = Buffer.from((check.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data: Uint8Array }).data)
      const gotExec = Buffer.from((check.prepare("SELECT data FROM executor_metadata WHERE idx = 0").get() as { data: Uint8Array }).data)
      const gotStep = Buffer.from((check.prepare("SELECT step_payload FROM steps WHERE idx = 0").get() as { step_payload: Uint8Array }).step_payload)
      const gotGen = Buffer.from((check.prepare("SELECT data FROM gen_metadata WHERE idx = 0").get() as { data: Uint8Array }).data)
      assert.deepEqual(gotMeta, ldField(1, ldField(1, Buffer.from("file:///home/ssalb/code/ntwine", "utf8"))))
      assert.deepEqual(gotExec, Buffer.concat([
        ldField(12, Buffer.from("file:///home/ssalb/code/ntwine", "utf8")),
        ldField(12, Buffer.from("file:///home/ssalb/.gemini/antigravity-cli", "utf8")),
      ]))
      assert.deepEqual(gotStep, stepBlob, "steps stay byte-for-byte untouched")
      assert.deepEqual(gotGen, genBlob, "gen_metadata stays byte-for-byte untouched")
    } finally {
      check.close()
    }
  })

  it("snapshots a WAL-mode database into one self-contained file without mutating the origin", () => {
    const dbPath = join(root, "wal.db")
    const writer = new Database(dbPath)
    writer.pragma("journal_mode = WAL")
    writer.pragma("wal_autocheckpoint = 0")
    writer.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
    writer.prepare("INSERT INTO kv (k, v) VALUES ('code', 'FALCON-7')").run()
    assert.equal(existsSync(`${dbPath}-wal`), true)

    const bytes = snapshotSqliteFile(dbPath)
    writer.close()

    const restored = join(root, "restored.db")
    writeFileSync(restored, bytes)
    const reader = new Database(restored, { readonly: true })
    try {
      const row = reader.prepare("SELECT v FROM kv WHERE k = 'code'").get() as { v: string } | undefined
      assert.equal(row?.v, "FALCON-7")
    } finally {
      reader.close()
    }
  })
})
