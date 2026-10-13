import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// ── CLAUDE CODE WORKFLOW RUNS, read off disk ─────────────────────────────────────────────────────────
//
// A `Workflow` tool call runs a script that fans out MANY agents, in phases, in the background. Until
// this existed Ntwine tracked none of it: the tool is neither `Agent` nor `Bash`, so a worker resting on
// "the wave 2 workflow" showed no child at all — no row under the prompt box, nothing on the rail, and
// no way into any of the dozen agents doing the actual work.
//
// The runtime already writes the whole tree down. Verified on real runs (arktype session a627551f,
// 2026-09-28/29, three runs of 1-40 agents):
//
//   launch ack (the tool_result):
//     "Workflow launched in background. Task ID: wy4e6vc5c\nSummary: …\n
//      Transcript dir: <session-dir>/subagents/workflows/wf_45e1076e-215\nScript file: …"
//   <run-dir>/journal.jsonl, one event per line, append-only:
//     {"type":"launched"}
//     {"type":"started","key":"v2:…","agentId":"aa80b7e1bdcc662bb","label":"impl:S1","phase":"Implement"}
//     {"type":"result","key":"v2:…","agentId":"adfb3b41e036d3106","result":…}
//     {"type":"failed","key":"v2:…","agentId":"a2f8d3002c4c264bd"}
//     (`label`/`phase` are optional — an agent() call without them journals only its agentId)
//   <run-dir>/agent-<agentId>.jsonl       the agent's own transcript, Claude's ordinary schema
//   <run-dir>/agent-<agentId>.meta.json   {"agentType":"workflow-subagent","description":"verify:S8:0.1",
//                                          "workflowPhase":"Review","spawnDepth":1,…}
//
// The run's own terminal signal is NOT here — it is the ordinary <task-notification> on the parent
// session, keyed by the Workflow call's tool_use id, which the tailer already folds. So a run that died
// with its process ("didn't finish before the previous session ended") leaves agents journalled as
// started and never finished; the caller must only trust "running" while the RUN is still live.

export type WorkflowAgentStatus = "running" | "done" | "failed"

export interface WorkflowAgent {
  agentId: string
  label: string
  phase?: string
  status: WorkflowAgentStatus
  transcript: string // <run-dir>/agent-<agentId>.jsonl — may not exist yet for a just-started agent
  startedAtMs?: number // the meta sidecar's mtime: written once at spawn, so it IS the spawn instant
}

// The launch ack's two handles. Anchored on the ack's own wording so no other tool_result can match.
export const WORKFLOW_ACK_RE = /^\s*Workflow launched in background\b/
export function workflowAckTaskId(text: string): string | undefined {
  return WORKFLOW_ACK_RE.test(text) ? text.match(/Task ID:\s*(\S+)/)?.[1] : undefined
}
export function workflowAckRunDir(text: string): string | undefined {
  return WORKFLOW_ACK_RE.test(text) ? text.match(/Transcript dir:\s*(\S+)/)?.[1] : undefined
}

// The row's name. A workflow script opens with `export const meta = { name: '…', description: '…' }` —
// the tool REQUIRES it — and the `name` is the short handle the worker itself uses ("featherduster-wave2");
// the description is a paragraph. A `scriptPath` re-run carries no script, but its filename is
// `<name>-wf_<run>.js`. A saved workflow is invoked by `name`.
export function workflowLabel(input: { script?: unknown; scriptPath?: unknown; name?: unknown; description?: unknown }): string {
  const fromScript = typeof input.script === "string" ? metaField(input.script, "name") ?? metaField(input.script, "description") : undefined
  if (fromScript) return fromScript
  if (typeof input.scriptPath === "string") {
    const base = input.scriptPath.split(/[\\/]/).pop()?.replace(/\.[cm]?js$/, "").replace(/-wf_[\w-]+$/, "")
    if (base) return base
  }
  if (typeof input.name === "string" && input.name.trim()) return input.name.trim()
  if (typeof input.description === "string" && input.description.trim()) return input.description.trim()
  return "workflow"
}

function metaField(script: string, field: string): string | undefined {
  // Only the meta literal's head is searched, so a `name:` deeper in the script body cannot be mistaken
  // for the workflow's own.
  const head = script.slice(0, 4000)
  const meta = head.indexOf("meta")
  if (meta < 0) return undefined
  const m = head.slice(meta).match(new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).){1,200})\\1`))
  return m?.[2]?.trim() || undefined
}

// Cached per journal (mtime, size): the board reads a live run every tick, and a journal carries every
// agent's full RESULT inline (tens of KB per line on a real run). Append-only, so the pair is a complete
// invalidation key.
const cache = new Map<string, { mtime: number; size: number; agents: WorkflowAgent[] }>()
const CACHE_MAX = 64
// A run is bounded by its script, not by us — but this sits on the tick path, so bound the read.
const AGENTS_MAX = 500

// Every agent a run has started, in start order. Never throws: a missing dir, a half-written last line
// or a junk record each just contributes nothing, because this runs on the board's tick.
export function readWorkflowRun(runDir: string): WorkflowAgent[] {
  const journal = join(runDir, "journal.jsonl")
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(journal)
  } catch {
    return []
  }
  const hit = cache.get(runDir)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.agents
  let text: string
  try {
    text = readFileSync(journal, "utf8")
  } catch {
    return []
  }
  const byId = new Map<string, WorkflowAgent>()
  for (const line of text.split("\n")) {
    if (!line) continue
    let rec: { type?: unknown; agentId?: unknown; label?: unknown; phase?: unknown }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || typeof rec !== "object" || typeof rec.agentId !== "string" || !rec.agentId) continue
    const agentId = rec.agentId
    if (rec.type === "started") {
      // A resumed run re-journals an agent it restarts; the latest start wins, in its original slot.
      const prev = byId.get(agentId)
      if (!prev && byId.size >= AGENTS_MAX) continue
      byId.set(agentId, {
        agentId,
        label: str(rec.label) ?? prev?.label ?? "",
        phase: str(rec.phase) ?? prev?.phase,
        status: "running",
        transcript: join(runDir, `agent-${agentId}.jsonl`),
      })
    } else if (rec.type === "result" || rec.type === "failed") {
      const agent = byId.get(agentId)
      if (agent) agent.status = rec.type === "result" ? "done" : "failed"
    }
  }
  const agents = [...byId.values()]
  for (const agent of agents) {
    // An agent() call with no `label` journals none; its sidecar still carries the description (the
    // workflow harness writes the label there) and the phase.
    const meta = readMeta(join(runDir, `agent-${agent.agentId}.meta.json`))
    if (!agent.label) agent.label = meta.description ?? "agent"
    if (!agent.phase && meta.phase) agent.phase = meta.phase
    if (meta.mtimeMs !== undefined) agent.startedAtMs = meta.mtimeMs
  }
  cache.delete(runDir)
  cache.set(runDir, { mtime: st.mtimeMs, size: st.size, agents })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return agents
}

function readMeta(path: string): { description?: string; phase?: string; mtimeMs?: number } {
  try {
    const mtimeMs = statSync(path).mtimeMs
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { description?: unknown; workflowPhase?: unknown }
    return { description: str(parsed?.description), phase: str(parsed?.workflowPhase), mtimeMs }
  } catch {
    return {}
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** The tailer's staleness rule for one transcript (tailer.ts quietPastWindow): quiet past its window, in
 *  awake time, and past the deadline of any Bash wait it ends in. Injected rather than imported, because
 *  the tailer imports this module and owns the clock, the stat and the tail cache the rule runs on. */
export type QuietPast = (path: string, lastWriteMs: number, nowMs: number) => boolean

// One agent's liveness. "running" only while the RUN is live: a run that died with its process leaves
// agents journalled as started forever. Quiet past its window (`quietPast`) reads "stale", the rule every
// tracked child follows. `mtimeMs` is the tailer's own (test-controllable) stat.
export function workflowAgentState(
  agent: WorkflowAgent,
  runLive: boolean,
  nowMs: number,
  mtimeMs: (path: string) => number | undefined,
  quietPast: QuietPast,
): "running" | "stale" | "done" | "failed" {
  if (agent.status !== "running") return agent.status
  if (!runLive) return "done"
  const m = mtimeMs(agent.transcript) ?? agent.startedAtMs
  return m === undefined || quietPast(agent.transcript, m, nowMs) ? "stale" : "running"
}

export type WorkflowAgentListing = { id: string; label: string; phase?: string; state: "running" | "stale" | "done" | "failed"; startedAt?: string }

// The drawer's listing of a run: every agent it started, finished ones included.
export function workflowAgentViews(
  runDir: string | undefined,
  runLive: boolean,
  nowMs: number,
  mtimeMs: (path: string) => number | undefined,
  quietPast: QuietPast,
): WorkflowAgentListing[] {
  if (!runDir) return []
  return readWorkflowRun(runDir).map((agent) => ({
    id: agent.agentId,
    label: agent.label,
    ...(agent.phase ? { phase: agent.phase } : {}),
    state: workflowAgentState(agent, runLive, nowMs, mtimeMs, quietPast),
    ...(agent.startedAtMs === undefined ? {} : { startedAt: new Date(agent.startedAtMs).toISOString() }),
  }))
}
