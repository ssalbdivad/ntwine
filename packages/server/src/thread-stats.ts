import { readdirSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { ThreadModelUsage, ThreadStats, ThreadTokenUsage } from "@ntwine/shared"

// THE THREAD INFO VIEW's numbers (⋯ menu → Thread info): what one thread has consumed, read off its own
// transcript rather than the tailer's fold. The fold keeps only what the board needs on every tick (the
// newest context reading, never a running total), and widening it would put a per-record sum on the hot
// path of every transcript at boot for a view nobody has open. This reads on demand instead, and
// INCREMENTALLY: each file keeps its byte offset and running totals, so a dialog refreshing a live
// thread re-reads only what was appended since its last look.
//
// CLAUDE. Each API response is split across several assistant records — one per content block — and
// every one of them repeats the response's full `usage`. Summing records therefore double- to
// quadruple-counts (measured on a real transcript: 579 assistant records for 244 responses), so a
// request is counted once per `message.id`. Sub-agents write their own transcripts under
// `<session>/subagents/agent-*.jsonl`; an older Claude Code wrote them inline as `isSidechain` records,
// and both land in the sub-agent bucket.
//
// COST is Claude Code's own figure, never a price table here: per-model rates differ by cache-write
// tier and have changed under the same model name, so a table would drift silently (a least-squares fit
// over 934 recorded snapshots on the maintainer's machine could not recover a consistent rate for most
// models). The figure comes from the SDK's `result.total_cost_usd` while the broker is attached (live),
// else from the transcript's `cost-state` record — which Claude Code writes only when its process
// exits, so a running daemon's reading lags; `partial` says so. Both are cumulative across resumes, so
// the larger of the two is the newer.
//
// CODEX. A rollout's `token_count` events carry a cumulative `total_token_usage`, so the newest one is
// the thread's total; `input_tokens` INCLUDES the cached part, which is split out here to match
// Claude's buckets. Codex reports no cost.

interface Totals {
  turns: number
  requests: number
  toolCalls: number
  compactions: number
  tokens: ThreadTokenUsage
  subAgentTokens: ThreadTokenUsage
  models: Map<string, { requests: number; tokens: ThreadTokenUsage }>
  startedAt?: string
  lastActivityAt?: string
  // Claude's `cost-state` snapshot, and how many requests landed after it (0 ⇒ it is current).
  snapshotCost?: number
  requestsSinceSnapshot: number
}

interface FileScan {
  offset: number
  totals: Totals
  seen: Set<string>
  // Codex: the cumulative reading and the model the next request is billed to.
  codexTotal?: ThreadTokenUsage
  codexModel?: string
}

const scans = new Map<string, FileScan>()
// A board of hundreds of threads opens at most a handful of info views; keep the newest few files.
const MAX_SCANS = 64

const zero = (): ThreadTokenUsage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

function emptyTotals(): Totals {
  return { turns: 0, requests: 0, toolCalls: 0, compactions: 0, tokens: zero(), subAgentTokens: zero(), models: new Map(), requestsSinceSnapshot: 0 }
}

function add(into: ThreadTokenUsage, from: ThreadTokenUsage): void {
  into.input += from.input
  into.cacheWrite += from.cacheWrite
  into.cacheRead += from.cacheRead
  into.output += from.output
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function noteModel(totals: Totals, model: string, tokens: ThreadTokenUsage): void {
  let row = totals.models.get(model)
  if (!row) totals.models.set(model, (row = { requests: 0, tokens: zero() }))
  row.requests++
  add(row.tokens, tokens)
}

function stamp(totals: Totals, at: unknown): void {
  if (typeof at !== "string") return
  if (totals.startedAt === undefined || at < totals.startedAt) totals.startedAt = at
  if (totals.lastActivityAt === undefined || at > totals.lastActivityAt) totals.lastActivityAt = at
}

type Rec = Record<string, unknown>

// A user record that set the agent going: not a tool result echo, not harness metadata, not the
// carry-over summary a compaction injects, not a local command's printed receipt.
function isClaudeTurn(rec: Rec): boolean {
  if (rec.isMeta === true || rec.isCompactSummary === true) return false
  const content = (rec.message as Rec | undefined)?.content
  if (typeof content === "string") return !/^\s*<local-command-(stdout|stderr|caveat)>/u.test(content)
  if (!Array.isArray(content)) return false
  return content.some((block) => (block as Rec | null)?.type !== "tool_result")
}

function foldClaude(scan: FileScan, rec: Rec, subAgentFile: boolean): void {
  const totals = scan.totals
  if (rec.type === "cost-state") {
    if (typeof rec.totalCostUSD === "number" && Number.isFinite(rec.totalCostUSD)) {
      totals.snapshotCost = rec.totalCostUSD
      totals.requestsSinceSnapshot = 0
    }
    return
  }
  const side = subAgentFile || rec.isSidechain === true
  if (rec.type === "user" || rec.type === "assistant" || rec.type === "system") stamp(totals, rec.timestamp)
  if (rec.type === "user") {
    if (!side && isClaudeTurn(rec)) totals.turns++
    return
  }
  if (rec.type === "system") {
    if (!side && rec.subtype === "compact_boundary") totals.compactions++
    return
  }
  if (rec.type !== "assistant") return
  const message = rec.message as Rec | undefined
  if (!message) return
  if (!side && Array.isArray(message.content)) {
    for (const block of message.content) if ((block as Rec | null)?.type === "tool_use") totals.toolCalls++
  }
  const model = typeof message.model === "string" ? message.model : undefined
  if (rec.isApiErrorMessage === true || model === "<synthetic>") return
  const id = typeof message.id === "string" ? message.id : typeof rec.requestId === "string" ? rec.requestId : undefined
  if (id !== undefined) {
    if (scan.seen.has(id)) return
    scan.seen.add(id)
  }
  const usage = message.usage as Rec | undefined
  if (!usage || typeof usage !== "object") return
  const tokens: ThreadTokenUsage = {
    input: count(usage.input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
  }
  if (!side) totals.requests++
  totals.requestsSinceSnapshot++
  add(side ? totals.subAgentTokens : totals.tokens, tokens)
  noteModel(totals, model ?? "unknown", tokens)
}

function codexUsage(raw: unknown): ThreadTokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const usage = raw as Rec
  const input = count(usage.input_tokens)
  const cached = Math.min(count(usage.cached_input_tokens), input)
  return { input: input - cached, cacheWrite: 0, cacheRead: cached, output: count(usage.output_tokens) }
}

const CODEX_TOOL_ITEMS = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"])

function foldCodex(scan: FileScan, rec: Rec): void {
  const totals = scan.totals
  stamp(totals, rec.timestamp)
  const payload = rec.payload as Rec | undefined
  if (rec.type === "compacted") {
    totals.compactions++
    return
  }
  if (!payload) return
  if (rec.type === "turn_context" && typeof payload.model === "string") scan.codexModel = payload.model
  else if (rec.type === "response_item" && typeof payload.type === "string" && CODEX_TOOL_ITEMS.has(payload.type)) totals.toolCalls++
  else if (rec.type === "event_msg" && payload.type === "user_message") totals.turns++
  else if (rec.type === "event_msg" && payload.type === "token_count") {
    const info = payload.info as Rec | null | undefined
    const total = codexUsage(info?.total_token_usage)
    if (!total) return
    // A repeated reading (codex re-emits the last one on a rate-limit update) is not a new request.
    const prior = scan.codexTotal
    if (prior && prior.input === total.input && prior.cacheRead === total.cacheRead && prior.output === total.output) return
    scan.codexTotal = total
    totals.tokens = { ...total }
    totals.requests++
    noteModel(totals, scan.codexModel ?? "unknown", codexUsage(info?.last_token_usage) ?? zero())
  }
}

/** Fold everything appended to `path` since the last look. Undefined when the file cannot be read.
 *  Two looks at one file share a single read: overlapping folds would count the same bytes twice. */
function scanFile(path: string, fold: (scan: FileScan, rec: Rec) => void, skip?: Buffer): Promise<FileScan | undefined> {
  const running = inflight.get(path)
  if (running) return running
  const next = readAppended(path, fold, skip).finally(() => inflight.delete(path))
  inflight.set(path, next)
  return next
}

const inflight = new Map<string, Promise<FileScan | undefined>>()
const CHUNK = 1 << 20

async function readAppended(path: string, fold: (scan: FileScan, rec: Rec) => void, skip?: Buffer): Promise<FileScan | undefined> {
  let file: FileHandle
  try {
    file = await open(path, "r")
  } catch {
    return undefined
  }
  try {
    const { size } = await file.stat()
    let scan = scans.get(path)
    // A file that shrank was rewritten, not appended to: start over.
    if (!scan || size < scan.offset) scan = { offset: 0, totals: emptyTotals(), seen: new Set() }
    scans.delete(path)
    scans.set(path, scan)
    if (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value!)
    const chunk = Buffer.alloc(CHUNK)
    let position = scan.offset
    let pending = Buffer.alloc(0)
    while (position < size) {
      // Each chunk is its own await, so a cold read of a 50MB transcript yields to the server between
      // megabytes rather than holding the event loop for the whole file.
      const { bytesRead } = await file.read(chunk, 0, Math.min(CHUNK, size - position), position)
      if (bytesRead <= 0) break
      position += bytesRead
      const view = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      let from = 0
      for (let nl = view.indexOf(10, from); nl >= 0; nl = view.indexOf(10, from)) {
        foldLine(scan, view.subarray(from, nl), fold, skip)
        from = nl + 1
      }
      pending = Buffer.from(view.subarray(from))
    }
    // The tail after the last newline is a record still being written; leave it for the next look.
    scan.offset = position - pending.length
    return scan
  } finally {
    await file.close()
  }
}

function foldLine(scan: FileScan, line: Buffer, fold: (scan: FileScan, rec: Rec) => void, skip?: Buffer): void {
  if (line.length === 0) return
  // Checked on the raw bytes, before anything is decoded: see CLAUDE_TOOL_RESULT.
  if (skip && line.indexOf(skip) >= 0) return
  let rec: unknown
  try {
    rec = JSON.parse(line.toString("utf8"))
  } catch {
    return
  }
  if (rec && typeof rec === "object") fold(scan, rec as Rec)
}

// A Claude tool-result echo — a user record carrying a tool's output — is where nearly all of a
// transcript's bytes are (88% of a measured 53MB one) and none of its stats: it is not a turn and bills
// nothing. Its `"tool_use_id":` KEY can only appear unescaped as a real key, never inside a string a
// human or a tool wrote (that would read `\"tool_use_id\":`), so finding it skips the line undecoded.
const CLAUDE_TOOL_RESULT = Buffer.from('"tool_use_id":')

function subAgentFiles(transcriptPath: string): string[] {
  const dir = join(transcriptPath.replace(/\.jsonl$/u, ""), "subagents")
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name))
  } catch {
    return []
  }
}

function result(backend: ThreadStats["backend"], totals: Totals, subAgents: number, cost: ThreadStats["cost"]): ThreadStats {
  const models: ThreadModelUsage[] = [...totals.models]
    .map(([model, row]) => ({ model, requests: row.requests, tokens: { ...row.tokens } }))
    .sort((a, b) => b.requests - a.requests)
  return {
    backend,
    recorded: true,
    ...(totals.startedAt ? { startedAt: totals.startedAt } : {}),
    ...(totals.lastActivityAt ? { lastActivityAt: totals.lastActivityAt } : {}),
    turns: totals.turns,
    requests: totals.requests,
    toolCalls: totals.toolCalls,
    compactions: totals.compactions,
    subAgents,
    tokens: { ...totals.tokens },
    subAgentTokens: { ...totals.subAgentTokens },
    models,
    ...(cost ? { cost } : {}),
  }
}

export function unrecordedStats(backend: ThreadStats["backend"]): ThreadStats {
  return { backend, recorded: false, turns: 0, requests: 0, toolCalls: 0, compactions: 0, subAgents: 0, tokens: zero(), subAgentTokens: zero(), models: [] }
}

/**
 * A thread's stats from its transcript. `liveCost` is the broker's newest `total_cost_usd` for the
 * session, when one has been seen (claude-runtime-ingest.ts totalCost).
 */
export async function readThreadStats(source: { backend: ThreadStats["backend"]; path: string }, liveCost?: number): Promise<ThreadStats> {
  if (source.backend === "acp") return unrecordedStats("acp")
  if (source.backend === "codex") {
    const scan = await scanFile(source.path, foldCodex)
    return scan ? result("codex", scan.totals, 0, undefined) : unrecordedStats("codex")
  }
  const main = await scanFile(source.path, (scan, rec) => foldClaude(scan, rec, false), CLAUDE_TOOL_RESULT)
  if (!main) return unrecordedStats("claude")
  const merged: Totals = { ...main.totals, tokens: { ...main.totals.tokens }, subAgentTokens: { ...main.totals.subAgentTokens }, models: new Map() }
  for (const [model, row] of main.totals.models) merged.models.set(model, { requests: row.requests, tokens: { ...row.tokens } })
  const files = subAgentFiles(source.path)
  for (const file of files) {
    const sub = await scanFile(file, (scan, rec) => foldClaude(scan, rec, true), CLAUDE_TOOL_RESULT)
    if (!sub) continue
    add(merged.subAgentTokens, sub.totals.subAgentTokens)
    for (const [model, row] of sub.totals.models) {
      let into = merged.models.get(model)
      if (!into) merged.models.set(model, (into = { requests: 0, tokens: zero() }))
      into.requests += row.requests
      add(into.tokens, row.tokens)
    }
    if (sub.totals.lastActivityAt && (!merged.lastActivityAt || sub.totals.lastActivityAt > merged.lastActivityAt)) merged.lastActivityAt = sub.totals.lastActivityAt
  }
  const snapshot = main.totals.snapshotCost
  let cost: ThreadStats["cost"]
  if (liveCost !== undefined && (snapshot === undefined || liveCost >= snapshot)) cost = { usd: liveCost, partial: false }
  // A sub-agent only runs inside a turn of the thread's own, so the thread's requests alone say whether
  // the snapshot is behind.
  else if (snapshot !== undefined) cost = { usd: snapshot, partial: merged.requestsSinceSnapshot > 0 }
  return result("claude", merged, files.length, cost)
}

/** Test seam: forget every file's running totals. */
export function resetThreadStatsCache(): void {
  scans.clear()
}
