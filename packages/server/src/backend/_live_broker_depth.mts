// LIVE DEPTH PROBE: does anything ntwine can see describe a GRANDCHILD — a sub-agent dispatched by a
// sub-agent — and if so, where?
//   nub packages/server/src/backend/_live_broker_depth.mts
//
// This answers, empirically and before any design:
//   1. Does the PARENT session's event stream carry the grandchild's task_* / assistant events, or does
//      it stop at depth 1?
//   2. Is `parentToolUseId` populated in practice on the events that do arrive?
//   3. If the stream stops at depth 1, does the CHILD's own transcript file (its `output_file`) record
//      the grandchild's dispatch — i.e. is the on-disk tree the real source?
//
// It prints the raw evidence first. Read the dump; the PASS/FAIL lines below it are only a summary.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bdepth-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bdepth-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const logDir = defaultLogDir(project)
const claudeBackend = createClaudeBackend({ claudeBin, logDir })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })

type TaskEvent = Extract<ClaudeQueryEvent, { kind: "task" }>
const taskEvents: TaskEvent[] = []
const parented: Array<{ kind: string; parentToolUseId?: string; tools: string }> = []
const dispatches = new Map<string, { name: string; description: string; parentToolUseId?: string }>()
const sessionIds = new Set<string>()

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    sessionIds.add(sessionId)
    if (event.kind === "task") taskEvents.push(event)
    if (event.kind === "assistant" || event.kind === "user") {
      const tools = event.kind === "assistant" ? event.toolUses.map((u) => u.name).join(",") : ""
      parented.push({ kind: event.kind, parentToolUseId: event.parentToolUseId, tools })
    }
    if (event.kind === "assistant") {
      for (const use of event.toolUses) {
        if (use.name !== "Agent" && use.name !== "Task") continue
        dispatches.set(use.id, {
          name: use.name,
          description: String(use.input.description ?? "").slice(0, 60),
          parentToolUseId: event.parentToolUseId,
        })
      }
    }
    ingest.onEvent(slug, sessionId, event)
  },
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "depth-live"
const sessionId = randomUUID()

// THE WORKLOAD. Three levels, each dispatched in the BACKGROUND so every level goes through the same
// tracked path the board renders.
const PROMPT = [
  "Dispatch ONE background sub-agent using the Agent tool with run_in_background set to true, with description exactly `LEVEL-ONE`.",
  "Its task, verbatim, must be: \"Dispatch ONE background sub-agent using the Agent tool with run_in_background set to true, with description exactly `LEVEL-TWO`. Its task: run `date` and `uname -a` with Bash and reply exactly LEAF-DONE. Wait for it to finish, then reply exactly L2-REPORTED.\"",
  "After dispatching LEVEL-ONE, WAIT for it to finish, then reply with exactly ALL-DONE.",
].join("\n")

/** Every `*.jsonl` under a session's log tree, with its depth in the subagents nesting. */
function walkTranscripts(dir: string, depth = 0, out: Array<{ path: string; depth: number }> = []): Array<{ path: string; depth: number }> {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walkTranscripts(full, name === "subagents" ? depth + 1 : depth, out)
    else if (name.endsWith(".jsonl")) out.push({ path: full, depth })
  }
  return out
}

/** Agent tool_uses + their launch acks recorded inside one transcript file. */
function scanTranscript(path: string): { agents: Array<{ id: string; description: string }>; acks: Array<{ id: string; outputFile?: string }>; records: number } {
  const agents: Array<{ id: string; description: string }> = []
  const acks: Array<{ id: string; outputFile?: string }> = []
  let records = 0
  let text = ""
  try { text = readFileSync(path, "utf8") } catch { return { agents, acks, records } }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    records++
    let rec: Record<string, unknown>
    try { rec = JSON.parse(line) } catch { continue }
    const content = (rec.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as { type?: string; name?: string; id?: string; input?: { description?: string }; tool_use_id?: string; content?: unknown }
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && b.id) {
        agents.push({ id: b.id, description: String(b.input?.description ?? "").slice(0, 50) })
      }
      if (b.type === "tool_result" && b.tool_use_id) {
        const raw = typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n")
            : ""
        if (/output_file:|agentId:/.test(raw)) {
          acks.push({ id: b.tool_use_id, outputFile: raw.match(/output_file:\s*(\S+)/)?.[1] ?? (raw.match(/agentId:\s*(\S+)/)?.[1] ? `agent-${raw.match(/agentId:\s*(\S+)/)![1]}` : undefined) })
        }
      }
    }
  }
  return { agents, acks, records }
}

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  const t0 = Date.now()
  const deadline = Date.now() + 420_000
  let settled = 0
  let peakLive = 0
  const seen: string[] = []
  while (Date.now() < deadline) {
    tailer.tick()
    const tele = tailer.get(slug)
    const live = tele?.subAgents ?? []
    peakLive = Math.max(peakLive, live.length)
    const line = `t+${Math.round((Date.now() - t0) / 1000)}s turn=${tele?.turn} live=${live.length} ${live.map((v) => `[${v.label}|${v.state}|act=${v.activity ?? "-"}|doing=${v.activityDetail ?? "-"}]`).join(" ")}`
    if (seen.at(-1) !== line) seen.push(line)
    if (tele?.turn === "idle" && live.length === 0 && peakLive > 0) { if (++settled >= 4) break } else settled = 0
    await sleep(1_000)
  }

  console.log("\n      --- live board timeline (deduped) ---")
  for (const line of seen) console.log("      " + line)

  console.log("\n      --- every Agent/Task dispatch seen ON THE PARENT SESSION STREAM ---")
  for (const [id, d] of dispatches) console.log(`      tool_use=${id} name=${d.name} parentToolUseId=${d.parentToolUseId ?? "(none)"} desc=${JSON.stringify(d.description)}`)

  console.log("\n      --- assistant/user events by parentToolUseId ---")
  const byParent = new Map<string, number>()
  for (const p of parented) byParent.set(p.parentToolUseId ?? "(main thread)", (byParent.get(p.parentToolUseId ?? "(main thread)") ?? 0) + 1)
  for (const [k, n] of byParent) console.log(`      ${k}: ${n} events`)

  console.log("\n      --- RAW task events ---")
  for (const e of taskEvents.slice(0, 80)) {
    console.log(`      ${e.phase.padEnd(12)} task=${e.taskId ?? "-"} toolUse=${e.toolUseId ?? "-"} status=${e.status ?? "-"} tool=${e.lastToolName ?? "-"} desc=${JSON.stringify(e.description ?? "").slice(0, 70)} out=${e.outputFile ?? "-"}`)
  }
  if (taskEvents.length > 80) console.log(`      … and ${taskEvents.length - 80} more`)

  console.log("\n      --- ON-DISK transcript tree under the session log dir ---")
  const sessionDir = join(logDir, "")
  const files = walkTranscripts(sessionDir)
  for (const f of files.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))) {
    const scanned = scanTranscript(f.path)
    console.log(`      depth=${f.depth} ${f.path.replace(logDir, "…")} records=${scanned.records} agents=${scanned.agents.length ? JSON.stringify(scanned.agents) : "-"} acks=${scanned.acks.length ? JSON.stringify(scanned.acks) : "-"}`)
  }

  // ---- the questions ----
  const grandDispatches = [...dispatches.values()].filter((d) => d.parentToolUseId)
  ok("Q1 the PARENT stream carries a GRANDCHILD's own Agent dispatch",
    grandDispatches.length > 0,
    `${grandDispatches.length}/${dispatches.size} dispatches carried a parentToolUseId`)
  ok("Q3 parentToolUseId is populated on nested events at all",
    parented.some((p) => p.parentToolUseId), `${parented.filter((p) => p.parentToolUseId).length}/${parented.length} assistant+user events carried one`)
  const nested = files.filter((f) => f.depth >= 1)
  const nestedWithAgents = nested.filter((f) => scanTranscript(f.path).agents.length > 0)
  ok("Q2 a CHILD's own transcript file records its own Agent dispatch (the on-disk route)",
    nestedWithAgents.length > 0, `${nestedWithAgents.length}/${nested.length} child transcripts contain an Agent tool_use`)
  ok("depth-2 transcript files exist on disk", files.some((f) => f.depth >= 2), `depths seen: ${[...new Set(files.map((f) => f.depth))].join(",")}`)
  console.log(`\n      sessions seen on the stream: ${[...sessionIds].join(", ")}`)
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { ingest.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  console.log(`\n      (log dir left in place for inspection: ${logDir}${existsSync(logDir) ? "" : " — MISSING"})`)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
