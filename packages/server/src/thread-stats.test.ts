import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readThreadStats, resetThreadStatsCache } from "./thread-stats.ts"

const line = (rec: unknown) => `${JSON.stringify(rec)}\n`
const usage = (input: number, write: number, read: number, output: number) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output })
// One API response written as two records (a thinking block, then a tool call), each repeating the
// full usage — the shape Claude Code really writes.
const response = (id: string, at: string, u: ReturnType<typeof usage>, extra: Record<string, unknown> = {}) => [
  { type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage: u, content: [{ type: "thinking", thinking: "" }] }, ...extra },
  { type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage: u, content: [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: {} }] }, ...extra },
]

function claudeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-thread-stats-"))
  const path = join(dir, "s1.jsonl")
  const records = [
    { type: "user", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: "do the thing" } },
    ...response("m1", "2026-10-01T00:00:01.000Z", usage(2, 100, 1000, 50)),
    { type: "user", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-m1", content: "ok" }] } },
    { type: "user", isMeta: true, timestamp: "2026-10-01T00:00:02.500Z", message: { role: "user", content: "<system-reminder>" } },
    ...response("m2", "2026-10-01T00:00:03.000Z", usage(1, 10, 1100, 20)),
    // A human quoting the skip key is still a turn: inside a string its quotes are escaped.
    { type: "user", timestamp: "2026-10-01T00:00:04.000Z", message: { role: "user", content: 'why does "tool_use_id": matter' } },
    { type: "cost-state", totalCostUSD: 1.25 },
  ]
  writeFileSync(path, records.map(line).join(""))
  return { dir, path }
}

test("Claude: each response counts once, tool results and metadata are not turns", async () => {
  resetThreadStatsCache()
  const { path } = claudeWorld()
  const stats = await readThreadStats({ backend: "claude", path })
  assert.equal(stats.turns, 2)
  assert.equal(stats.requests, 2)
  assert.equal(stats.toolCalls, 2)
  assert.deepEqual(stats.tokens, { input: 3, cacheWrite: 110, cacheRead: 2100, output: 70 })
  assert.deepEqual(stats.cost, { usd: 1.25, partial: false })
  assert.equal(stats.startedAt, "2026-10-01T00:00:00.000Z")
  assert.deepEqual(stats.models.map((m) => [m.model, m.requests]), [["claude-opus-5-5", 2]])
})

test("Claude: an append is read incrementally, and a request after the cost snapshot marks it partial", async () => {
  resetThreadStatsCache()
  const { path } = claudeWorld()
  await readThreadStats({ backend: "claude", path })
  // A record half-written at the moment of the look must wait for its newline, not be lost.
  const [first, second] = response("m3", "2026-10-01T00:01:00.000Z", usage(1, 0, 1200, 5))
  const whole = line(first)
  appendFileSync(path, whole.slice(0, 40))
  assert.equal((await readThreadStats({ backend: "claude", path })).requests, 2)
  appendFileSync(path, whole.slice(40) + line(second) + line({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-01T00:02:00.000Z" }))
  const stats = await readThreadStats({ backend: "claude", path })
  assert.equal(stats.requests, 3)
  assert.equal(stats.tokens.cacheRead, 3300)
  assert.equal(stats.compactions, 1)
  assert.deepEqual(stats.cost, { usd: 1.25, partial: true })
  // The broker's live reading is newer than the snapshot, so it wins outright.
  assert.deepEqual((await readThreadStats({ backend: "claude", path }, 1.9)).cost, { usd: 1.9, partial: false })
})

test("Claude: sub-agent transcripts, and inline sidechain records, land in the sub-agent bucket", async () => {
  resetThreadStatsCache()
  const { dir, path } = claudeWorld()
  appendFileSync(path, response("side1", "2026-10-01T00:00:04.000Z", usage(5, 0, 0, 5), { isSidechain: true }).map(line).join(""))
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true })
  writeFileSync(join(dir, "s1", "subagents", "agent-a1.jsonl"), [
    { type: "user", isSidechain: true, timestamp: "2026-10-01T00:00:05.000Z", message: { role: "user", content: "child task" } },
    ...response("c1", "2026-10-01T00:00:06.000Z", usage(10, 20, 30, 40), { isSidechain: true }),
  ].map(line).join(""))
  const stats = await readThreadStats({ backend: "claude", path })
  assert.equal(stats.subAgents, 1)
  assert.equal(stats.turns, 2, "a child's prompt is not the thread's turn")
  assert.equal(stats.requests, 2, "the thread's own requests only")
  assert.equal(stats.toolCalls, 2)
  assert.deepEqual(stats.subAgentTokens, { input: 15, cacheWrite: 20, cacheRead: 30, output: 45 })
  assert.equal(stats.models[0]!.requests, 4)
  assert.equal(stats.lastActivityAt, "2026-10-01T00:00:06.000Z")
})

test("two overlapping looks at one file share a read rather than counting it twice", async () => {
  resetThreadStatsCache()
  const { path } = claudeWorld()
  const [a, b] = await Promise.all([readThreadStats({ backend: "claude", path }), readThreadStats({ backend: "claude", path })])
  assert.equal(a.requests, 2)
  assert.equal(b.requests, 2)
})

test("Codex: the newest cumulative token_count is the total, cached input split out", async () => {
  resetThreadStatsCache()
  const path = fileURLToPath(new URL("./backend/codex.fixtures/exec-two-turn.jsonl", import.meta.url))
  const stats = await readThreadStats({ backend: "codex", path })
  assert.equal(stats.backend, "codex")
  assert.equal(stats.turns, 2)
  assert.ok(stats.requests >= 2)
  assert.equal(stats.tokens.cacheWrite, 0)
  assert.ok(stats.tokens.input > 0 && stats.tokens.cacheRead > 0 && stats.tokens.output > 0)
  assert.equal(stats.cost, undefined)
})

test("a missing transcript reads as unrecorded, not as zero usage", async () => {
  resetThreadStatsCache()
  assert.equal((await readThreadStats({ backend: "claude", path: join(tmpdir(), "ntwine-no-such-transcript.jsonl") })).recorded, false)
})
