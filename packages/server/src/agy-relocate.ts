import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import Database from "./sqlite.ts"
import { mapPrefix, type PrefixMap } from "./transcript-relocate.ts"

// REWRITING AN ANTIGRAVITY (`agy`) CONVERSATION DB ON MOVE.
//
// `agy acp` loads a conversation from `~/.gemini/antigravity-cli/conversations/<conv>.db` via
// `session/load`. That SQLite database keeps its workspace URI (`file:///Users/ssalb/ntwine`) inside
// protobuf blobs in `trajectory_metadata_blob` and `executor_metadata`: even when `session/load` passes
// the destination's `cwd`, `agy` executes shell commands in the workspace recorded in those metadata
// blobs and fails with "no such directory" when the origin's path does not exist on the destination
// (measured live against agy 1.5.11).
//
// Only those two metadata tables are touched — `steps` and `gen_metadata` are left byte-for-byte
// intact so signed Gemini thought blocks and model history are never disturbed.

export type ProtobufRewriteResult = {
  data: Buffer
  changed: boolean
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length && shift < 70n) {
    const byte = buf[pos++]!
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: pos }
    shift += 7n
  }
  return undefined
}

function writeVarint(value: number | bigint): Buffer {
  let remaining = BigInt(value)
  const out: number[] = []
  do {
    let byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining > 0n) byte |= 0x80
    out.push(byte)
  } while (remaining > 0n)
  return Buffer.from(out)
}

/**
 * Rewrite UTF-8 strings matching `rewrite` inside a protobuf wire-format message, updating every
 * enclosing length prefix. Returns `undefined` when `buf` is not a valid wire-format message so a
 * non-protobuf blob is never silently altered.
 */
export function rewriteProtobufStrings(
  buf: Buffer,
  rewrite: (value: string) => string | undefined,
): ProtobufRewriteResult | undefined {
  const parts: Buffer[] = []
  let pos = 0
  let changed = false
  while (pos < buf.length) {
    const start = pos
    const tag = readVarint(buf, pos)
    if (!tag || tag.value === 0n) return undefined
    const wire = Number(tag.value & 7n)
    const field = tag.value >> 3n
    if (field === 0n || field > 536_870_911n) return undefined
    pos = tag.next
    if (wire === 0) {
      const val = readVarint(buf, pos)
      if (!val) return undefined
      pos = val.next
      parts.push(buf.subarray(start, pos))
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return undefined
      pos += 8
      parts.push(buf.subarray(start, pos))
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return undefined
      pos += 4
      parts.push(buf.subarray(start, pos))
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len || len.value > BigInt(buf.length - len.next)) return undefined
      const end = len.next + Number(len.value)
      const payload = buf.subarray(len.next, end)
      pos = end
      const asString = payload.toString("utf8")
      const isUtf8 = Buffer.from(asString, "utf8").equals(payload)
      const replaced = isUtf8 ? rewrite(asString) : undefined
      if (replaced !== undefined && replaced !== asString) {
        const nextBytes = Buffer.from(replaced, "utf8")
        parts.push(buf.subarray(start, tag.next), writeVarint(nextBytes.length), nextBytes)
        changed = true
      } else {
        const nested = payload.length > 0 ? rewriteProtobufStrings(payload, rewrite) : undefined
        if (nested?.changed) {
          parts.push(buf.subarray(start, tag.next), writeVarint(nested.data.length), nested.data)
          changed = true
        } else {
          parts.push(buf.subarray(start, pos))
        }
      }
    } else {
      return undefined
    }
  }
  return changed ? { data: Buffer.concat(parts), changed: true } : { data: buf, changed: false }
}

function fileUriPrefix(absPath: string): string | undefined {
  try {
    return pathToFileURL(absPath).href.replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

/** Expand path prefix maps to cover both plain paths and `file://` URI forms (`agy` stores URIs). */
function agyPrefixMaps(maps: readonly PrefixMap[]): PrefixMap[] {
  const out: PrefixMap[] = []
  const seen = new Set<string>()
  const push = (from: string, to: string) => {
    if (!from || from === to) return
    const key = `${from}\0${to}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ from, to })
  }
  for (const { from, to } of maps) {
    if (!from || from === to) continue
    push(from, to)
    const fromUri = fileUriPrefix(from)
    const toUri = fileUriPrefix(to)
    if (fromUri && toUri) push(fromUri, toUri)
    if (from.startsWith("/") && to.startsWith("/")) push(`file://${from}`, `file://${to}`)
  }
  return out
}

const AGY_METADATA_TABLES: readonly { table: string; idCol: string }[] = [
  { table: "trajectory_metadata_blob", idCol: "id" },
  { table: "executor_metadata", idCol: "idx" },
]

/**
 * Rewrite workspace/home paths and `file://` URIs inside an `agy` conversation SQLite database's
 * metadata tables so `session/load` on the destination runs in the destination's checkout.
 */
export function relocateAgyConversationDb(dbPath: string, maps: readonly PrefixMap[]): void {
  const expanded = agyPrefixMaps(maps)
  if (!expanded.length) return
  const rewrite = (value: string): string | undefined => {
    const mapped = mapPrefix(value, expanded)
    return mapped === value ? undefined : mapped
  }
  const db = new Database(dbPath)
  try {
    const tables = new Set(
      db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    )
    const update = db.transaction(() => {
      for (const { table, idCol } of AGY_METADATA_TABLES) {
        if (!tables.has(table)) continue
        const rows = db.prepare<[], { id: unknown; data: Buffer | Uint8Array | null }>(`SELECT ${idCol} AS id, data FROM ${table}`).all()
        for (const row of rows) {
          if (!row.data) continue
          const rewritten = rewriteProtobufStrings(Buffer.from(row.data), rewrite)
          if (rewritten?.changed) {
            db.prepare(`UPDATE ${table} SET data = ? WHERE ${idCol} = ?`).run(rewritten.data, row.id)
          }
        }
      }
    })
    update.immediate()
  } finally {
    db.close()
  }
}

/**
 * Read a SQLite database file as one self-contained buffer. When a `-wal` sidecar is present, copies
 * the pair to a temp directory and checkpoints it there so the origin file is never mutated and no
 * uncheckpointed frames are lost in transit.
 */
export function snapshotSqliteFile(srcPath: string): Buffer {
  const walPath = `${srcPath}-wal`
  if (!existsSync(walPath)) return readFileSync(srcPath)
  const dir = mkdtempSync(join(tmpdir(), "ntwine-sqlite-snap-"))
  try {
    const copy = join(dir, "conv.db")
    copyFileSync(srcPath, copy)
    copyFileSync(walPath, `${copy}-wal`)
    const shmPath = `${srcPath}-shm`
    if (existsSync(shmPath)) copyFileSync(shmPath, `${copy}-shm`)
    const db = new Database(copy)
    try {
      db.pragma("wal_checkpoint(TRUNCATE)")
      db.pragma("journal_mode = DELETE")
    } finally {
      db.close()
    }
    return readFileSync(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
