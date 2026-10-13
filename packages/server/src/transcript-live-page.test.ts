import { test } from "node:test"
import assert from "node:assert/strict"
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  latestTranscriptWindow,
  latestWindowStart,
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  projectClaudeTranscript,
} from "./transcript.ts"
import { createStorage } from "./storage.ts"
import type { Project } from "./project.ts"

// What the latest-page read costs on a LIVE transcript: the /ws producer runs it after every append of
// every subscribed working thread, so anything it does over the WHOLE file is paid once per push.

const USER = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-10T18:00:00.000Z", message: { role: "user", content: text } })
const ASSISTANT = (id: string, text: string) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-07-10T18:00:01.000Z", message: { id, content: [{ type: "text", text }] } })
// One exchange is two projected messages; 160 of them put the latest window's head past message 0, so
// every page carries a cursor — the case that hashes the transcript.
const exchanges = (from: number, n: number) => {
  const lines: string[] = []
  for (let i = from; i < from + n; i++) lines.push(USER(`user-${i}`), ASSISTANT(`a-${i}`, `assistant-${i} ${"x".repeat(200)}`))
  return lines.map((line) => line + "\n").join("")
}

function harness() {
  const slug = `-tmp-frizz-live-page-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  const store = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-live-page-")), "ui.db"), "p")
  store.upsertSession({ slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: new Date().toISOString(), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, transcript_id: null })
  const project = { cwdSlug: slug } as unknown as Project
  const path = join(logDir, "sid.jsonl")
  return { store, project, path, cleanup: () => rmSync(logDir, { recursive: true, force: true }) }
}

const cursorOf = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { prefixDigest: string; snapshotBytes: number }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64url")

/** Bytes `fs.readSync` returns while `fn` runs — transcript.ts reads every file through it. */
function bytesRead(fn: () => void): number {
  const real = fs.readSync
  let total = 0
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const n = (real as (...a: Parameters<typeof fs.readSync>) => number)(...args)
    total += n
    return n
  }) as typeof fs.readSync
  syncBuiltinESMExports()
  try {
    fn()
  } finally {
    fs.readSync = real
    syncBuiltinESMExports()
  }
  return total
}

test("a live transcript's page cursor hashes only the bytes appended since the last read, and still names the whole prefix", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 160))
    const first = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.ok(first.beforeCursor, "160 exchanges put the window head past the start, so the page carries a cursor")
    assert.equal(cursorOf(first.beforeCursor!).prefixDigest, sha256(readFileSync(h.path)))

    for (let round = 0; round < 3; round++) {
      const delta = exchanges(1000 + round, 1)
      appendFileSync(h.path, delta)
      let page!: ReturnType<typeof readLatestThreadTranscriptPage>
      const read = bytesRead(() => { page = readLatestThreadTranscriptPage(h.project, h.store, "t") })
      const whole = readFileSync(h.path)
      const cursor = cursorOf(page.beforeCursor!)
      assert.equal(cursor.snapshotBytes, whole.length)
      assert.equal(cursor.prefixDigest, sha256(whole), `round ${round}: the running digest is the digest of the whole file`)
      // The retained fold reads the delta once and the digest reads it once. It used to re-read the
      // whole file for the digest on every append, because its memo was keyed on the file's length.
      assert.ok(read <= 2 * Buffer.byteLength(delta), `round ${round}: read ${read} bytes for a ${Buffer.byteLength(delta)}-byte append of a ${whole.length}-byte file`)
    }

    // And the cursor it minted pages back exactly as before.
    const latest = readLatestThreadTranscriptPage(h.project, h.store, "t")
    const earlier = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.ok(earlier.messages.length > 0)
  } finally {
    h.cleanup()
  }
})

test("a transcript rewritten SHORTER in place starts its digest over", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 170))
    readLatestThreadTranscriptPage(h.project, h.store, "t")
    // Same inode, fewer bytes: the hashed prefix is no longer this file's.
    writeFileSync(h.path, exchanges(500, 160))
    const page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.equal(cursorOf(page.beforeCursor!).prefixDigest, sha256(readFileSync(h.path)))
  } finally {
    h.cleanup()
  }
})

test("a cursor whose prefix changed is still refused — the validation re-reads the prefix it names", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 160))
    const page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    // Rewrite one byte inside the prefix without changing the length (same inode, same size).
    const bytes = readFileSync(h.path)
    const at = bytes.indexOf("user-3")
    bytes[at] = "U".charCodeAt(0)
    writeFileSync(h.path, bytes)
    assert.throws(() => readEarlierThreadTranscriptPage(h.project, h.store, "t", page.beforeCursor!), /prior transcript bytes changed/)
  } finally {
    h.cleanup()
  }
})

test("latestTranscriptWindow given the head it would compute returns the identical window", () => {
  const all = projectClaudeTranscript(exchanges(0, 450))
  const start = latestWindowStart(all)
  assert.ok(start > 0)
  assert.deepEqual(latestTranscriptWindow(all, start), latestTranscriptWindow(all))
})
