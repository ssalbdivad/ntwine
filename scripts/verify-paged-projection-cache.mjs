// Correctness net for the retained projection cache on the PAGED transcript read path
// (transcript.ts projectSnapshot). The cache folds only the bytes appended since the last read, so the
// thing that must hold is: an INCREMENTALLY grown projection is byte-for-byte the same as a one-shot
// parse of the same final bytes — including sourceIds, which are byte offsets, and including
// back-filled messages far behind the tail (tool_result completion, queued_command un-graying).
//
// Runs against a REAL session JSONL (the biggest one in the ntwine project dir by default) replayed in
// chunks, which is the only way to exercise torn multibyte characters and torn lines at real scale.
//
//   node scripts/verify-paged-projection-cache.mjs [/abs/session.jsonl]
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { projectClaudeTranscript, readLatestThreadTranscriptPage, readTranscript, __clearTranscriptCacheForTests, MAX_MESSAGES } from "../packages/server/src/transcript.ts"

let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

function biggestSessionFile() {
  const dir = join(homedir(), ".claude", "projects", "-Users-colinmcd94-Documents-projects-ntwine")
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))
  return files.map((f) => ({ f, size: statSync(f).size })).sort((a, b) => b.size - a.size)[0]?.f
}

const source = process.argv[2] ?? biggestSessionFile()
if (!source) { console.error("no session jsonl found"); process.exit(1) }
const full = readFileSync(source)
console.log(`source ${source} (${(full.length / 1e6).toFixed(1)} MB)`)

// A fake project/storage pair pointing at a temp claude log dir, so readLatestThreadTranscriptPage
// exercises the REAL paged reader (snapshot → cached projection → page slice → cursor), not a stub.
const home = mkdtempSync(join(tmpdir(), "ntwine-projcache-"))
const cwdSlug = "-verify-projection-cache"
const logDir = join(home, ".claude", "projects", cwdSlug)
process.env.HOME = home
const { mkdirSync } = await import("node:fs")
mkdirSync(logDir, { recursive: true })

const SESSION_ID = "11111111-2222-3333-4444-555555555555"
const filePath = join(logDir, `${SESSION_ID}.jsonl`)
const project = { dir: "/verify", cwdSlug }
const storage = {
  getSession: () => ({
    slug: "t", session_id: SESSION_ID, backend: "claude", runtime_generation: 0,
    transcript_id: null, agent_session_id: null, delivery_ledger: null,
    spawned_at: new Date(0).toISOString(),
  }),
  allSessions: () => [],
}

// Grow the file in chunks that deliberately land mid-line and mid-multibyte-character.
const cuts = [0.17, 0.39, 0.58, 0.71, 0.83, 0.94, 1].map((f) => Math.floor(full.length * f))
let lastPage = null
try {
  __clearTranscriptCacheForTests()
  const t0 = performance.now()
  for (const cut of cuts) {
    writeFileSync(filePath, full.subarray(0, cut))
    lastPage = readLatestThreadTranscriptPage(project, storage, "t")
  }
  const incrementalMs = Math.round(performance.now() - t0)

  // Reference: a cold one-shot projection of the SAME final bytes, through the same reader with an
  // empty cache.
  __clearTranscriptCacheForTests()
  const t1 = performance.now()
  const coldPage = readLatestThreadTranscriptPage(project, storage, "t")
  const coldMs = Math.round(performance.now() - t1)

  // And a warm repeat, which is the whole point of the cache.
  const t2 = performance.now()
  readLatestThreadTranscriptPage(project, storage, "t")
  const warmMs = Math.round(performance.now() - t2)

  console.log(`\ntiming: ${cuts.length} incremental reads ${incrementalMs}ms | cold ${coldMs}ms | warm ${warmMs}ms`)

  check("incremental projection equals cold projection",
    JSON.stringify(lastPage.messages) === JSON.stringify(coldPage.messages),
    "message arrays diverged")
  check("cursor/pagination fields match",
    lastPage.hasEarlier === coldPage.hasEarlier
    && lastPage.beforeCursor === coldPage.beforeCursor
    && lastPage.transcriptKey === coldPage.transcriptKey,
    `${JSON.stringify({ inc: lastPage.beforeCursor?.slice(0, 24), cold: coldPage.beforeCursor?.slice(0, 24) })}`)
  check("warm read is materially cheaper than cold", warmMs * 4 < coldMs || coldMs < 40,
    `warm ${warmMs}ms vs cold ${coldMs}ms`)

  // The page is the tail window of the canonical projection — compare against the module's own
  // one-shot projector so a regression in the CACHE cannot hide behind a regression in the reader.
  const oneShot = projectClaudeTranscript(full.toString("utf8"), `claude:${SESSION_ID}`)
  const expectedTail = oneShot.slice(Math.max(0, oneShot.length - MAX_MESSAGES))
  check("cached page equals one-shot projectClaudeTranscript tail",
    JSON.stringify(coldPage.messages) === JSON.stringify(expectedTail),
    `cached ${coldPage.messages.length} vs one-shot tail ${expectedTail.length}`)

  // The two readers must now SHARE one retained fold. Prove it two ways: readTranscript right after a
  // paged read is a cache HIT (so it costs ~nothing rather than a second full fold), and it agrees with
  // the paged page message-for-message over the window they have in common.
  const tShared = performance.now()
  const viaReadTranscript = readTranscript(project, SESSION_ID)
  const sharedMs = Math.round(performance.now() - tShared)
  check("readTranscript reuses the paged reader's fold (no second parse)", sharedMs * 4 < coldMs || coldMs < 40,
    `readTranscript ${sharedMs}ms vs cold fold ${coldMs}ms`)
  check("both readers project identical messages",
    JSON.stringify(viaReadTranscript) === JSON.stringify(coldPage.messages),
    `readTranscript ${viaReadTranscript.length} vs paged ${coldPage.messages.length}`)

  // NEGATIVE CONTROL: a rotated file (same path, new inode) must invalidate the fold rather than
  // append onto a stale projection.
  rmSync(filePath)
  const half = full.subarray(0, Math.floor(full.length * 0.4))
  writeFileSync(filePath, half)
  const rotated = readLatestThreadTranscriptPage(project, storage, "t")
  __clearTranscriptCacheForTests()
  const rotatedCold = readLatestThreadTranscriptPage(project, storage, "t")
  check("rotated/truncated file re-folds from byte 0 (negative control)",
    JSON.stringify(rotated.messages) === JSON.stringify(rotatedCold.messages),
    "stale fold leaked across a rotation")
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
