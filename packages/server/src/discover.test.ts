import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverTranscriptDir, discoverTranscriptId, sentinelFor } from "./discover.ts"

function tmp() {
  return mkdtempSync(join(tmpdir(), "ntwine-discover-"))
}

// Write a transcript whose first user message embeds the scratch-directory sentinel for `ownerId` (the
// ORIGINAL pinned id), simulating a worker whose file lives at a DIFFERENT filename `fileId`.
function transcript(dir: string, fileId: string, ownerId: string, mtimeSec?: number) {
  const first = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { role: "user", content: `Your scratch directory is \`.ntwine/threads/${ownerId}/\` — yours to use.` },
  })
  const path = join(dir, `${fileId}.jsonl`)
  writeFileSync(path, first + "\n")
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
  return path
}

test("sentinelFor: the scratch-directory path tail embeds the pinned id", () => {
  assert.equal(sentinelFor("abc-123"), "threads/abc-123/")
})

// WHY SHORTENING THE SENTINEL WAS FREE. Until 2026-08-06 it was `threads/<id>/scratch.md`, and every
// transcript on disk written before then carries that string. The new sentinel is a PREFIX of the old
// one, so those transcripts still match and no live thread lost its recovery path — there was nothing
// to migrate. Delete this test only if you are willing to strand every pre-2026-08-06 thread.
test("discoverTranscriptId: a PRE-2026-08-06 transcript still matches the shortened sentinel", () => {
  const dir = tmp()
  const path = join(dir, "forked-id.jsonl")
  writeFileSync(path, JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { role: "user", content: "Your scratchpad is `.ntwine/threads/pinned-id/scratch.md` — keep state there." },
  }) + "\n")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), "forked-id")
})

test("discoverTranscriptId: finds a drifted transcript by its scratchpad sentinel", () => {
  const dir = tmp()
  transcript(dir, "forked-id", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), "forked-id")
})

test("discoverTranscriptId: no sentinel match → undefined", () => {
  const dir = tmp()
  transcript(dir, "someone-else", "unrelated-owner")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})

test("discoverTranscriptId: never re-finds the pinned id's OWN file (excluded)", () => {
  const dir = tmp()
  // A file literally named <pinnedId>.jsonl that mentions its own sentinel must not self-match — we're
  // only here because that direct bind missed, so returning it would loop.
  transcript(dir, "pinned-id", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})

test("discoverTranscriptId: honors the exclude set (a transcript claimed by another row)", () => {
  const dir = tmp()
  transcript(dir, "claimed-by-b", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id", { exclude: new Set(["claimed-by-b"]) }), undefined)
})

test("discoverTranscriptId: newest match wins", () => {
  const dir = tmp()
  transcript(dir, "older", "pinned-id", 1_000_000) // ancient-ish but within the fresh window via nowMs
  transcript(dir, "newer", "pinned-id", 2_000_000)
  assert.equal(discoverTranscriptId(dir, "pinned-id", { nowMs: 2_000_000 * 1000 }), "newer")
})

test("discoverTranscriptId: a stale (aged-out) candidate is ignored", () => {
  const dir = tmp()
  transcript(dir, "ancient", "pinned-id", 1000) // mtime ~1970
  // now is far in the future → the only candidate is past the freshness window → no match
  assert.equal(discoverTranscriptId(dir, "pinned-id", { nowMs: Date.parse("2026-07-01T00:00:00Z") }), undefined)
})

test("discoverTranscriptId: a missing/unreadable dir degrades to undefined (never throws)", () => {
  assert.equal(discoverTranscriptId(join(tmpdir(), "ntwine-nope-does-not-exist-xyz"), "pinned-id"), undefined)
})

test("discoverTranscriptId: non-.jsonl and dotfiles are skipped", () => {
  const dir = tmp()
  writeFileSync(join(dir, "pinned-id.txt"), `.ntwine/threads/pinned-id/scratch.md`)
  writeFileSync(join(dir, ".hidden.jsonl"), `.ntwine/threads/pinned-id/scratch.md`)
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})

// ---- discoverTranscriptDir: the RENAMED / MOVED project directory ----
//
// Claude Code shards its transcript store by the cwd a session was born in, and a resumed session keeps
// writing to its BIRTH bucket forever (measured against the real CLI, 2026-08-11). Rename the checkout
// and every pre-existing thread's file is not missing — it is one directory over. Before this, ntwine
// read that as "no transcript 60s after dispatch — likely a boot failure" and stranded 417 transcripts
// behind a yellow [!] whose Retry could only ever start more work ntwine could not see.

function bucket(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true })
  return join(root, name)
}

function jsonl(dir: string, sessionId: string, body = '{"type":"user"}\n') {
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, body)
  return path
}

test("discoverTranscriptDir: finds a transcript stranded in the pre-rename bucket", () => {
  const root = tmp()
  const current = bucket(root, "-Users-me-projects-ntwine")
  const old = bucket(root, "-Users-me-projects-fray")
  jsonl(old, "stranded-id")
  assert.equal(discoverTranscriptDir(current, "stranded-id", new Set()), old)
})

test("discoverTranscriptDir: NO freshness filter — a thread idle for years is exactly what we recover", () => {
  const root = tmp()
  const old = bucket(root, "-Users-me-projects-fray")
  utimesSync(jsonl(old, "ancient-id"), 1000, 1000) // mtime ~1970
  assert.equal(discoverTranscriptDir(bucket(root, "-now"), "ancient-id", new Set()), old)
})

test("discoverTranscriptDir: skips the caller's own dir, so a 0-byte local file can't shadow the real one", () => {
  const root = tmp()
  const current = bucket(root, "-Users-me-projects-ntwine")
  const old = bucket(root, "-Users-me-projects-fray")
  jsonl(current, "sid", "") // the empty husk a worker leaves when it dies before writing a record
  jsonl(old, "sid")
  assert.equal(discoverTranscriptDir(current, "sid", new Set()), old)
})

test("discoverTranscriptDir: an EMPTY candidate is not a hit (same rule as the tailer's crash-net)", () => {
  const root = tmp()
  const old = bucket(root, "-Users-me-projects-fray")
  jsonl(old, "sid", "")
  assert.equal(discoverTranscriptDir(bucket(root, "-now"), "sid", new Set()), undefined)
})

test("discoverTranscriptDir: no match anywhere → undefined (a genuine boot failure still reads as one)", () => {
  const root = tmp()
  bucket(root, "-Users-me-projects-fray")
  assert.equal(discoverTranscriptDir(bucket(root, "-now"), "never-written", new Set()), undefined)
})

test("discoverTranscriptDir: a missing root degrades to undefined (never throws)", () => {
  assert.equal(discoverTranscriptDir(join(tmpdir(), "ntwine-nope-xyz", "-a-bucket"), "sid", new Set()), undefined)
})

// A rename strands EVERY session of a project at once, so the first hit must answer for the rest without
// re-sweeping ~300 buckets per row per retry — that sweep is what the tick-latency warning is made of.
test("discoverTranscriptDir: a hit is memoized, and the memo answers the next session without a sweep", () => {
  const root = tmp()
  const current = bucket(root, "-Users-me-projects-ntwine")
  const old = bucket(root, "-Users-me-projects-fray")
  jsonl(old, "first-id")
  const memo = new Set<string>()
  assert.equal(discoverTranscriptDir(current, "first-id", memo), old)
  assert.deepEqual([...memo], [old], "the bucket that held it is remembered")

  // Now hide the root: a re-sweep would be impossible. Only the memo can answer.
  jsonl(old, "second-id")
  assert.equal(discoverTranscriptDir(join(root, "gone", "-a-bucket"), "second-id", memo), old)
})

test("discoverTranscriptDir: the memo never fabricates a hit for a session that isn't there", () => {
  const root = tmp()
  const old = bucket(root, "-Users-me-projects-fray")
  const memo = new Set<string>([old])
  assert.equal(discoverTranscriptDir(bucket(root, "-now"), "absent-id", memo), undefined)
})

// A session id CAN name a file in two buckets at once. Measured against the real CLI (2026-08-11):
// moving a transcript out from under a LIVE session makes that session RE-CREATE it at the old path, so
// the same id then exists twice — a small live file and a large stale one. First-hit-wins made the choice
// `readdirSync` order, i.e. arbitrary, and losing that coin flip renders a truncated conversation.
test("discoverTranscriptDir: with the SAME id in two buckets, the most recently written one wins", () => {
  const root = tmp()
  const current = bucket(root, "-current")
  const stale = bucket(root, "-a-stale-copy")
  const live = bucket(root, "-z-the-live-one")
  utimesSync(jsonl(stale, "sid", "stale but large\n".repeat(50)), 1000, 1000) // mtime ~1970
  jsonl(live, "sid", "live\n") // written now
  // Named so that `readdirSync` order would pick the STALE one first if order decided it.
  assert.equal(discoverTranscriptDir(current, "sid", new Set()), live)
})

test("discoverTranscriptDir: a memoized bucket cannot shadow a newer one for the same id", () => {
  const root = tmp()
  const current = bucket(root, "-current")
  const memoized = bucket(root, "-memoized")
  const newer = bucket(root, "-newer")
  utimesSync(jsonl(memoized, "sid"), 1000, 1000)
  jsonl(newer, "sid")
  // The memo is consulted first and holds a real hit — it must still lose to the newer file.
  assert.equal(discoverTranscriptDir(current, "sid", new Set([memoized, newer])), newer)
})
