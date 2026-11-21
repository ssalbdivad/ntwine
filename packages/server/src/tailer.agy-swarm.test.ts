import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"
import type { AgentBackend } from "./backend/types.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { acpTranscriptPath, createAcpBackend } from "./backend/acp-transcript.ts"
import { readAgyTranscriptFile } from "./backend/agy-transcript.ts"
import { agySubAgentId, agySubAgentsDir, agySwarmMemberId, agySwarmRosterPath, agyTranscriptPath } from "./agy-swarm.ts"

// THE WHOLE PATH, through the real tailer tick: an agy thread's ACP row, its own ntwine-written transcript,
// and agy's swarm files on disk under an injected agy home. What a board, the drill-in drawer and
// `ntwinectl activity` read is the tailer's telemetry and lookup, so those are what is asserted.

const COORD = "87bf2304-a211-407f-8cea-8f5baaeebec4" // the thread's agy conversation = the swarm's coordinator
const WORKER = "f966a7e2-ea7f-41c5-af39-849743c66523"
const DONE_ONE = "01d01998-1c3a-454f-91e4-cbe1a7e12f2f"

const step = (o: { [key: string]: unknown }) => JSON.stringify({ source: "MODEL", status: "DONE", ...o })
const brief = step({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", created_at: "2026-11-20T20:39:35Z", content: "<SYSTEM_MESSAGE>\n[Message] content=You have just started. Your assignment: review the GA branch\n</SYSTEM_MESSAGE>" })
const working = step({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-20T20:39:36Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"git log\"", toolSummary: "\"Git log for target commits\"" } }] })
const parked = [
  step({ step_index: 2, type: "GENERIC", created_at: "2026-11-20T20:39:40Z", content: "ok" }),
  step({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-20T20:41:00Z", content: "Posted my verdict.", tool_calls: [{ name: "post_message", args: {} }, { name: "swarm_wait", args: {} }] }),
  step({ step_index: 4, type: "GENERIC", created_at: "2026-11-20T20:41:01Z", content: "posted #163" }),
  step({ step_index: 5, type: "GENERIC", created_at: "2026-11-20T20:41:02Z", content: "waiting" }),
]

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ntwine-agy-tail-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir, { recursive: true })
  const stateDir = join(root, "state")
  const agyHome = join(root, "agy")
  const storage = createStorage(join(logDir, "ui.db"), "p")
  const row: SessionRow = { slug: "t", session_id: "ntwine-uuid", thread_name: "ntwine-t", spawned_at: "2026-11-20T20:30:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null }
  storage.upsertSession(row)
  storage.setBackend("t", "acp")
  storage.setAcpAgent("t", "antigravity")
  storage.setAgentSession("t", COORD)
  // The thread's own turn: open, so the coordinator is mid-turn while its swarm runs.
  const own = acpTranscriptPath(stateDir, "ntwine-uuid")
  mkdirSync(dirname(own), { recursive: true })
  writeFileSync(own, [
    JSON.stringify({ kind: "acp-session", at: "2026-11-20T20:30:00.000Z", agent: { id: "antigravity", name: "Antigravity CLI", version: "1.5.11" }, acpSessionId: COORD, cwd: "/x" }),
    JSON.stringify({ kind: "user-message", at: "2026-11-20T20:30:00.000Z", text: "harden the release", synthetic: false }),
    JSON.stringify({ kind: "turn-start", at: "2026-11-20T20:30:00.000Z" }),
  ].map((l) => l + "\n").join(""))
  const roster = (members: { [name: string]: { [key: string]: unknown } }) => {
    const path = agySwarmRosterPath(agyHome, COORD)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ title: "GA hardening", members }))
  }
  const transcript = (conv: string, lines: string[]) => {
    const path = agyTranscriptPath(agyHome, conv)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.map((l) => l + "\n").join(""))
    return path
  }
  const clock = { ms: Date.parse("2026-11-20T20:40:00.000Z") }
  const changes = { n: 0 }
  const acp = createAcpBackend({ stateDir })
  const claude = createClaudeBackend({ logDir })
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    onChange: () => changes.n++,
    now: () => clock.ms,
    paneDead: () => false,
    sessionLogDir: logDir,
    backendFor: (kind?: string): AgentBackend => (kind === "acp" ? acp : claude),
    agyHome,
  })
  return { tailer, roster, transcript, clock, changes, storage }
}

const live = { phase: "RUNNING", desired_state: "RUNNING", killed: false }

test("tailer: an agy thread surfaces its swarm workers — live state, model, activity, and the finished ones in the ring", () => {
  const h = setup()
  h.roster({
    coordinator: { conversation_id: COORD, role: "coordinator", model: "gemini-4-neon-high", ...live, wake_mode: "mentions" },
    "armstrong-ga-pr": { conversation_id: WORKER, role: "worker", applied_model: "gemini-4-neon-xhigh", ...live, wake_mode: "working" },
    "aot-surface": { conversation_id: DONE_ONE, role: "worker", model: "claude-sonnet-5-5-high", phase: "KILLED", desired_state: "KILLED", killed: true },
  })
  const workerPath = h.transcript(WORKER, [brief, working])
  h.transcript(DONE_ONE, [brief])
  h.tailer.tick()

  const tele = h.tailer.get("t")
  assert.equal(tele?.turn, "in-flight")
  const id = agySwarmMemberId(WORKER)
  assert.deepEqual(tele?.subAgents?.map((a) => ({ id: a.id, taskId: a.taskId, label: a.label, state: a.state, subagentType: a.subagentType, activity: a.activity, activityDetail: a.activityDetail, startedAt: a.startedAt })), [
    { id, taskId: "armstrong-ga-pr", label: "armstrong-ga-pr", state: "running", subagentType: "gemini-4-neon-xhigh", activity: "run_command", activityDetail: "Git log for target commits", startedAt: "2026-11-20T20:39:35Z" },
  ], "the coordinator is the thread itself, and a killed member is off the live list")
  // The drawer resolves the live member to its own agy transcript, and reads it with the agy reader.
  const lookup = h.tailer.subAgent("t", id)
  assert.equal(lookup?.state, "running")
  assert.equal(lookup?.outputFormat, "agy")
  assert.equal(lookup?.outputFile, workerPath)
  assert.match(readAgyTranscriptFile(lookup!.outputFile!).find((m) => m.role === "user")?.text ?? "", /Your assignment: review the GA branch/)
  // …and the killed one, never seen live, is still browsable as a finished child.
  const done = h.tailer.subAgent("t", agySwarmMemberId(DONE_ONE))
  assert.deepEqual([done?.state, done?.outcome, done?.outputFormat], ["done", "killed", "agy"])

  // The worker posts and parks on the board: still listed, no longer running work.
  appendFileSync(workerPath, parked.join("\n") + "\n")
  const before = h.changes.n
  h.clock.ms += 5_000
  h.tailer.tick()
  const waiting = h.tailer.get("t")?.subAgents?.find((a) => a.id === id)
  assert.equal(waiting?.state, "waiting")
  assert.equal(waiting?.activity, undefined, "a parked member is not doing anything")
  assert.equal(h.tailer.subAgent("t", id)?.state, "running", "its drawer keeps following it: a post can wake it any second")
  assert.ok(h.changes.n > before, "the state change reaches the board without the thread's own transcript moving")

  // The coordinator kills it: retired, with agy's own outcome.
  h.roster({
    coordinator: { conversation_id: COORD, role: "coordinator", ...live },
    "armstrong-ga-pr": { conversation_id: WORKER, role: "worker", applied_model: "gemini-4-neon-xhigh", phase: "KILLED", desired_state: "KILLED", killed: true },
    "aot-surface": { conversation_id: DONE_ONE, role: "worker", phase: "KILLED", desired_state: "KILLED", killed: true },
  })
  h.clock.ms += 5_000
  h.tailer.tick()
  assert.deepEqual(h.tailer.get("t")?.subAgents ?? [], [])
  const killed = h.tailer.subAgent("t", id)
  assert.deepEqual([killed?.state, killed?.outcome, killed?.startedAt], ["done", "killed", "2026-11-20T20:39:35Z"])
})

test("tailer: a non-agy ACP thread never looks for a swarm", () => {
  const h = setup()
  h.storage.setAcpAgent("t", "opencode")
  h.roster({ scout: { conversation_id: WORKER, ...live } })
  h.transcript(WORKER, [brief, working])
  h.tailer.tick()
  assert.deepEqual(h.tailer.get("t")?.subAgents ?? [], [])
})

test("tailer: an agy thread surfaces invoke_subagent children with conversationId taskId and retires them on turn end", () => {
  const h = setup()
  const subDir = agySubAgentsDir(join(dirname(h.transcript(WORKER, [brief, working])), "..", "..", "..", ".."), COORD)
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, `${WORKER}.json`), JSON.stringify({
    conversationId: WORKER,
    subagentDescriptor: { typeName: "research", role: "Codebase Researcher" },
    state: "SUBAGENT_STATE_ALIVE",
  }))
  h.tailer.tick()

  const id = agySubAgentId(WORKER)
  const sub = h.tailer.get("t")?.subAgents?.find((a) => a.id === id)
  assert.deepEqual(sub && { id: sub.id, taskId: sub.taskId, label: sub.label, state: sub.state, subagentType: sub.subagentType, activity: sub.activity, activityDetail: sub.activityDetail }, {
    id,
    taskId: WORKER,
    label: "Codebase Researcher",
    state: "running",
    subagentType: "research",
    activity: "run_command",
    activityDetail: "Git log for target commits",
  })

  // Subagent finishes its turn -> retired as completed (even though state JSON stays SUBAGENT_STATE_ALIVE).
  const workerPath = h.tailer.subAgent("t", id)!.outputFile!
  appendFileSync(workerPath, [
    step({ step_index: 2, type: "GENERIC", created_at: "2026-11-20T20:39:40Z", content: "ok" }),
    step({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-20T20:40:10Z", content: "Done." }),
  ].join("\n") + "\n")
  h.clock.ms += 5_000
  h.tailer.tick()
  assert.deepEqual(h.tailer.get("t")?.subAgents ?? [], [])
  const finished = h.tailer.subAgent("t", id)
  assert.deepEqual([finished?.state, finished?.outcome, finished?.outputFormat], ["done", "completed", "agy"])
})
