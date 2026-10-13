#!/usr/bin/env node
// Resolve a per-message debug id (a message's `sourceId` — every rendered message root carries its own
// on `data-ntwine-msg`, so an inspector reads one straight off the DOM) back to BOTH SIDES of the
// projection seam — the raw session-log record(s) that produced the message, and the projected
// TranscriptMessage the renderer actually received.
//
// That pairing is the whole point. A rendering bug is always one of two things, and comparing the two
// halves says which in one read:
//   raw right + projected WRONG → the projector mis-parsed        → packages/server/src/transcript.ts
//   raw right + projected right → the renderer mis-drew a correct projection → web/src/components/ChatView.tsx
//
//   node scripts/debug-message.mjs claude:8f2c…:24009
//   node scripts/debug-message.mjs codex:01ab…:9312:2 --raw   # raw records only
//   node scripts/debug-message.mjs claude:8f2c…:24009 --json  # machine-readable, for piping
//
// A sourceId is `<backend>:<sessionId>:<byteOffset>` (codex appends `:<eventOrdinal>`), where
// byteOffset is the position — from byte 0 of the session log — of the record that OPENED the
// rendered message. See transcript.ts createTranscriptFold / projectCodexTranscript.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const SERVER_SRC = new URL("../packages/server/src/", import.meta.url)

function die(msg) {
  console.error(`debug-message: ${msg}`)
  process.exit(1)
}

// `<backend>:<sessionId>:<byteOffset>[:<eventOrdinal>]`. The sessionId is a uuid (Claude) or a codex
// rollout id — neither contains a colon, so a positional split is unambiguous.
export function parseSourceId(raw) {
  const parts = String(raw ?? "").trim().split(":")
  if (parts.length < 3 || parts.length > 4) return undefined
  const [backend, sessionId, offset, ordinal] = parts
  if (backend !== "claude" && backend !== "codex") return undefined
  if (!sessionId || !/^\d+$/.test(offset)) return undefined
  if (ordinal !== undefined && !/^\d+$/.test(ordinal)) return undefined
  return {
    backend,
    sessionId,
    offset: Number(offset),
    ...(ordinal === undefined ? {} : { ordinal: Number(ordinal) }),
  }
}

// Claude writes <sessionId>.jsonl under a per-project dir keyed by a cwd slug. The id alone doesn't
// name the project, so scan every project dir — an id is globally unique, so the first hit is right.
function findClaudeTranscript(sessionId) {
  const root = join(homedir(), ".claude", "projects")
  if (!existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, `${sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}

async function findCodexTranscript(sessionId) {
  const { findRolloutById } = await import(new URL("backend/codex.ts", SERVER_SRC).href)
  return findRolloutById(sessionId)
}

// The projected message OWNS every raw record from its own offset up to the next message's offset:
// one assistant turn folds many JSONL lines (text blocks, tool_use, the tool_result back-fills) into
// a single bubble, and a bug usually lives in one of the records the opening line doesn't show.
function recordsInSpan(raw, startByte, endByte) {
  const buf = Buffer.from(raw, "utf8")
  const slice = buf.subarray(startByte, endByte ?? buf.length).toString("utf8")
  const out = []
  let cursor = startByte
  for (const line of slice.split("\n")) {
    const byteLen = Buffer.byteLength(line, "utf8")
    if (line.trim()) {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = { __unparseable: line.slice(0, 400) }
      }
      out.push({ offset: cursor, record: parsed })
    }
    cursor += byteLen + 1 // + the '\n' the split consumed
  }
  return out
}

// Token-accounting and request-plumbing fields the projector never reads. Dropping them keeps a
// multi-record turn readable (and cheap to paste to an agent); `--full` restores byte fidelity.
const NOISE = new Set(["usage", "diagnostics", "requestId", "sessionId", "version", "gitBranch", "userType", "cwd"])
function denoise(value) {
  if (Array.isArray(value)) return value.map(denoise)
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (NOISE.has(k)) continue
    out[k] = denoise(v)
  }
  return out
}

function summarize(record) {
  const content = record?.message?.content
  const kinds = Array.isArray(content)
    ? content.map((b) => (b?.type === "tool_use" ? `tool_use(${b.name})` : b?.type)).join(", ")
    : typeof content === "string" ? "string"
    : record?.type ?? "?"
  return `type=${record?.type ?? "?"} ${kinds ? `content=[${kinds}]` : ""}`.trim()
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"))
  const flags = new Set(argv.filter((a) => a.startsWith("--")))
  const id = args[0]
  if (!id) die("usage: node scripts/debug-message.mjs <sourceId> [--raw|--projected|--json]")

  const parsed = parseSourceId(id)
  if (!parsed) die(`not a sourceId: ${JSON.stringify(id)} (expected <claude|codex>:<sessionId>:<byteOffset>)`)

  const path = parsed.backend === "claude"
    ? findClaudeTranscript(parsed.sessionId)
    : await findCodexTranscript(parsed.sessionId)
  if (!path) die(`no ${parsed.backend} session log found for ${parsed.sessionId}`)

  const raw = readFileSync(path, "utf8")
  const transcript = await import(new URL("transcript.ts", SERVER_SRC).href)
  const messages = parsed.backend === "claude"
    ? transcript.projectClaudeTranscript(raw, `claude:${parsed.sessionId}`)
    : transcript.projectCodexTranscript(raw, `codex:${parsed.sessionId}`)

  const index = messages.findIndex((m) => m.sourceId === id)
  if (index === -1) {
    die(
      `sourceId not present in the current projection of ${path}.\n` +
      `  The log may have been rewritten (compaction/resume), or the id predates a projector change.\n` +
      `  ${messages.length} messages projected; offsets run ${messages[0]?.sourceId ?? "-"} … ${messages.at(-1)?.sourceId ?? "-"}`,
    )
  }
  const message = messages[index]
  const nextOffset = (() => {
    const next = messages[index + 1]?.sourceId
    const p = next ? parseSourceId(next) : undefined
    return p?.offset
  })()
  const records = recordsInSpan(raw, parsed.offset, nextOffset)

  if (flags.has("--json")) {
    console.log(JSON.stringify({ sourceId: id, path, backend: parsed.backend, message, records }, null, 2))
    return
  }

  const wantRaw = !flags.has("--projected")
  const wantProjected = !flags.has("--raw")

  console.log(`sourceId   ${id}`)
  console.log(`log        ${path}`)
  console.log(`span       bytes ${parsed.offset}…${nextOffset ?? "EOF"}  (${records.length} record(s))`)
  console.log(`position   message ${index + 1} of ${messages.length}`)

  if (wantRaw) {
    const full = flags.has("--full")
    console.log(`\n── RAW session-log records ${full ? "" : "(token/plumbing fields elided; --full for all) "}───────────`)
    for (const { offset, record } of records) {
      console.log(`\n  @${offset}  ${summarize(record)}`)
      const shown = full ? record : denoise(record)
      console.log(JSON.stringify(shown, null, 2).split("\n").map((l) => `    ${l}`).join("\n"))
    }
  }

  if (wantProjected) {
    console.log(`\n── PROJECTED TranscriptMessage (what the renderer received) ───────────`)
    console.log(JSON.stringify(message, null, 2).split("\n").map((l) => `  ${l}`).join("\n"))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => die(error?.stack ?? String(error)))
}
