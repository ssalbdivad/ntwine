// A CHILD BLOCKED IN ONE LONG FOREGROUND CALL IS NOT A DEAD ONE, through the real tick loop.
//
// Observed three times on 2026-09-29 (session 054bee45): a sub-agent running `timeout 2400 nub …` in the
// foreground writes its tool_use, two PreToolUse hook records, and then nothing until the call returns —
// so 15 minutes in, the tailer called it stale, `mcp__ntwine__activity` dropped it, and the park check
// refused its parent's fence "NOT RUNNING (nothing by that name)" while its processes were alive in `ps`.
// A workflow read the same way with three verifier agents mid-call. The fixtures are those bytes, shortened.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"

const MIN = 60_000
const T = (iso: string) => Date.parse(iso)
const CALL_AT = "2026-07-01T00:01:00.000Z"
const BOUND = 40 * MIN
// The staleness window opens AT the pending call's deadline (tailer.ts pendingCallDeadline) and runs the
// ordinary 15 minutes from there.
const WINDOW = 15 * MIN

const lines = (...recs: object[]) => recs.map((r) => JSON.stringify(r) + "\n").join("")
const IN_FLIGHT = { type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { role: "user", content: "go" } }
const dispatch = (id: string) => ({
  type: "assistant", timestamp: "2026-07-01T00:00:01.000Z",
  message: { id: "msg_p1", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id, input: { description: "goal-limits", run_in_background: true, subagent_type: "ntwine:high" } }] },
})
const launch = (id: string, outputFile: string) => ({
  type: "user", timestamp: "2026-07-01T00:00:01.500Z",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: a93a2fe4400f31533\noutput_file: ${outputFile}\nDo not read this file.` }] }] },
})
const notification = (id: string) => ({
  type: "queue-operation", operation: "enqueue", timestamp: "2026-07-01T00:30:00.000Z",
  content: `<task-notification>\n<task-id>a93a2fe4400f31533</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`,
})
// The child's own transcript: its brief, then the observed tail of a long foreground call.
const childPrompt = { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "user", content: "run the real-stack harness" } }
const bashCall = (timeout?: number) => ({
  type: "assistant", timestamp: CALL_AT,
  message: { id: "msg_c1", role: "assistant", content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "timeout 2400 nub /tmp/goal-realstack.mjs", description: "Run real-stack goal cap harness", ...(timeout === undefined ? {} : { timeout }) } }] },
})
const hook = { type: "attachment", timestamp: "2026-07-01T00:01:00.050Z", attachment: { type: "hook_success", hookName: "PreToolUse:Bash" } }
const answered = { type: "user", timestamp: CALL_AT, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_long", content: "EXIT=0" }] } }

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { slug: "t", session_id: "sid", thread_name: "ntwine-t", spawned_at: "2026-07-01T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null, ...over }
}

function harness(childTail: object[], over: { awakeBetween?: (a: number, b: number) => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ntwine-pending-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir, { recursive: true })
  const child = join(logDir, "sid", "subagents", "agent-a93a2fe4400f31533.jsonl")
  mkdirSync(join(logDir, "sid", "subagents"), { recursive: true })
  writeFileSync(child, lines(childPrompt, ...childTail))
  writeFileSync(join(logDir, "sid.jsonl"), lines(IN_FLIGHT, dispatch("toolu_child"), launch("toolu_child", child)))
  const storage = createStorage(join(logDir, "ui.db"), "p")
  storage.upsertSession(row())
  const clock = { ms: T(CALL_AT) }
  // The child's last write is the hook record right after its call began.
  const mtimes = new Map<string, number>([[child, T(CALL_AT) + 50]])
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), onChange: () => {},
    now: () => clock.ms,
    paneDead: () => false,
    sessionLogDir: logDir,
    mtimeMs: (p) => mtimes.get(p),
    ...over,
  })
  const at = (iso: string | number) => {
    clock.ms = typeof iso === "number" ? iso : T(iso)
    tailer.tick()
    return tailer.get("t")?.subAgents ?? []
  }
  return {
    at, child, logDir, mtimes,
    close() {
      tailer.stop()
      storage.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a child 20 minutes into a 40-minute foreground call is RUNNING, not stale", () => {
  const h = harness([bashCall(BOUND), hook, hook])
  try {
    assert.equal(h.at(T(CALL_AT) + 20 * MIN)[0]?.state, "running", "the declared bound outlasts the 15m floor")
    assert.equal(h.at(T(CALL_AT) + 39 * MIN)[0]?.state, "running")
  } finally { h.close() }
})

test("NEGATIVE CONTROL: a dead child with a pending call still goes stale once the window past that call's bound runs out", () => {
  const h = harness([bashCall(BOUND), hook, hook])
  try {
    assert.equal(h.at(T(CALL_AT) + BOUND + WINDOW - 1000)[0]?.state, "running", "inside the window that opens at the deadline")
    assert.equal(h.at(T(CALL_AT) + BOUND + WINDOW + 1000)[0]?.state, "stale", "past it, nothing written")
  } finally { h.close() }
})

test("a pending call's window is AWAKE time too: a host asleep past the deadline does not end it", () => {
  // 30 minutes suspended a minute after the deadline: 25 wall minutes past it is 1 awake minute past it,
  // where the wall clock alone (the test above) would already read stale.
  const deadline = T(CALL_AT) + BOUND
  const slept = (from: number, to: number) => {
    const suspended = { from: deadline + MIN, to: deadline + 31 * MIN }
    return to - from - Math.max(0, Math.min(to, suspended.to) - Math.max(from, suspended.from))
  }
  const h = harness([bashCall(BOUND), hook, hook], { awakeBetween: slept })
  try {
    assert.equal(h.at(deadline + 25 * MIN)[0]?.state, "running", "1 awake minute past the deadline")
    assert.equal(h.at(deadline + 31 * MIN + WINDOW)[0]?.state, "stale", "16 awake minutes past it")
  } finally { h.close() }
})

test("NEGATIVE CONTROL: a child with no pending call keeps the 15-minute rule", () => {
  // Its call returned; it has written nothing since. Nothing it declared is still running.
  const h = harness([bashCall(BOUND), hook, answered])
  try {
    assert.equal(h.at(T(CALL_AT) + 14 * MIN)[0]?.state, "running")
    assert.equal(h.at(T(CALL_AT) + 16 * MIN)[0]?.state, "stale")
  } finally { h.close() }
  // And a call that names no timeout declares only the harness default, which the 15m floor already covers.
  const bare = harness([bashCall(), hook, hook])
  try {
    assert.equal(bare.at(T(CALL_AT) + 16 * MIN)[0]?.state, "stale")
  } finally { bare.close() }
})

test("NEGATIVE CONTROL: the parent's task-notification ends the child at once, mid-call", () => {
  const h = harness([bashCall(BOUND), hook, hook])
  try {
    assert.equal(h.at(T(CALL_AT) + 20 * MIN)[0]?.state, "running")
    appendFileSync(join(h.logDir, "sid.jsonl"), lines(notification("toolu_child")))
    assert.deepEqual(h.at(T(CALL_AT) + 20 * MIN + 1000), [], "a real completion retires it on the next tick")
  } finally { h.close() }
})

test("host sleep is not silence: 60 wall minutes with 50 of them suspended reads running", () => {
  // No pending call at all — only the floor — so the awake clock is the whole difference.
  const slept = (from: number, to: number) => {
    const suspended = { from: T(CALL_AT) + 5 * MIN, to: T(CALL_AT) + 55 * MIN }
    return to - from - Math.max(0, Math.min(to, suspended.to) - Math.max(from, suspended.from))
  }
  const h = harness([bashCall(BOUND), hook, answered], { awakeBetween: slept })
  try {
    assert.equal(h.at(T(CALL_AT) + 60 * MIN)[0]?.state, "running", "10 awake minutes of quiet")
    assert.equal(h.at(T(CALL_AT) + 66 * MIN)[0]?.state, "stale", "16 awake minutes of quiet")
  } finally { h.close() }
})

// ---- a WORKFLOW: its run is live while any running agent is, by that agent's own reading ----

test("a workflow whose only running agent is deep in a long call stays running, and goes stale past its bound", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-pending-wf-"))
  const logDir = join(root, "-a-project")
  const runDir = join(logDir, "sid", "subagents", "workflows", "wf_8a4833df-387")
  mkdirSync(runDir, { recursive: true })
  const agentPath = join(runDir, "agent-aVerify1.jsonl")
  writeFileSync(join(runDir, "agent-aVerify1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "verify:S8:0.1", workflowPhase: "Review", spawnDepth: 1 }))
  writeFileSync(agentPath, lines(childPrompt, bashCall(BOUND), hook, hook))
  const journal = join(runDir, "journal.jsonl")
  writeFileSync(journal, lines({ type: "launched" }, { type: "started", key: "v2:1", agentId: "aVerify1", label: "verify:S8:0.1", phase: "Review" }))
  writeFileSync(join(logDir, "sid.jsonl"), lines(
    IN_FLIGHT,
    { type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { id: "m1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "export const meta = { name: 'verify-wave', description: 'x' }" } }] } },
    { type: "user", timestamp: "2026-07-01T00:00:01.500Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wf", content: `Workflow launched in background. Task ID: wchfovxqw\nSummary: x\nTranscript dir: ${runDir}\nScript file: /x.js` }] } },
  ))
  const storage = createStorage(join(logDir, "ui.db"), "p")
  storage.upsertSession(row())
  const clock = { ms: T(CALL_AT) }
  const mtimes = new Map<string, number>([[journal, T(CALL_AT) - 1000], [agentPath, T(CALL_AT) + 50]])
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project, storage, bus: new Bus(), onChange: () => {},
    now: () => clock.ms, paneDead: () => false, sessionLogDir: logDir, mtimeMs: (p) => mtimes.get(p),
  })
  const at = (ms: number) => {
    clock.ms = ms
    tailer.tick()
    return (tailer.get("t")?.subAgents ?? []).map((r) => [r.id, r.state])
  }
  try {
    assert.deepEqual(at(T(CALL_AT) + 20 * MIN), [["toolu_wf", "running"], ["aVerify1", "running"]],
      "journal quiet 20m, but its agent is inside a 40m call: the run and its row both read running")
    assert.deepEqual(at(T(CALL_AT) + BOUND + WINDOW + 1000), [["toolu_wf", "stale"]],
      "past the window that opens at the agent's bound the run reads stale, and the stale agent leaves the live rows")
  } finally {
    tailer.stop()
    storage.close()
    rmSync(root, { recursive: true, force: true })
  }
})
