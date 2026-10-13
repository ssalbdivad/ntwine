// WORKFLOW runs: a `Workflow` tool call and the phased fan-out of agents behind it.
//
// Before this, the tailer tracked `Agent`, `Bash` and `Monitor` only, so a worker resting on a workflow
// showed no child anywhere and none of the run's agents could be opened. Every fixture is shaped from
// the real bytes of an arktype session's runs (a627551f, 2026-09-28/29): the launch ack, the journal
// events, the meta sidecars and the terminal notification are verbatim but for shortened ids and text.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"
import { workflowLabel } from "./workflow-runs.ts"

const SESSION = "11111111-2222-3333-4444-555555555555"
const SLUG = "workflow"
const TOOL = "toolu_wf"

const SCRIPT = `export const meta = {
  name: 'featherduster-wave2',
  description: 'Wave 2 of the featherduster push',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}
const r = await agent('do it', { label: 'impl:S1', phase: 'Implement', name: 'not-the-meta' })`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-workflow-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const runDir = join(dir, SESSION, "subagents", "workflows", "wf_45e1076e-215")
  mkdirSync(runDir, { recursive: true })
  const at = new Date().toISOString()
  writeFileSync(join(dir, `${SESSION}.jsonl`), [
    JSON.stringify({ type: "assistant", timestamp: at, message: { id: "m1", stop_reason: "tool_use", content: [{ type: "tool_use", id: TOOL, name: "Workflow", input: { script: SCRIPT } }] } }),
    JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL, content: `Workflow launched in background. Task ID: wy4e6vc5c\nSummary: Wave 2 of the featherduster push\nTranscript dir: ${runDir}\nScript file: ${dir}/workflows/scripts/featherduster-wave2-wf_45e1076e-215.js` }] } }),
  ].join("\n") + "\n")

  const agent = (id: string, meta: object, transcript = true) => {
    writeFileSync(join(runDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1, ...meta }))
    if (transcript) writeFileSync(join(runDir, `agent-${id}.jsonl`), `${JSON.stringify({ type: "assistant", timestamp: at, message: { id: "x", content: [{ type: "text", text: `I am ${id}` }] } })}\n`)
  }
  agent("aImpl1", { description: "impl:S1", workflowPhase: "Implement" })
  agent("aImpl2", { description: "impl:S2", workflowPhase: "Implement" })
  agent("aReview", { description: "review:S1", workflowPhase: "Review" })
  agent("aBare", { description: "bare agent", workflowPhase: "Review" })
  writeFileSync(join(runDir, "journal.jsonl"), [
    { type: "launched" },
    { type: "started", key: "v2:1", agentId: "aImpl1", label: "impl:S1", phase: "Implement" },
    { type: "started", key: "v2:2", agentId: "aImpl2", label: "impl:S2", phase: "Implement" },
    { type: "result", key: "v2:1", agentId: "aImpl1", result: { ok: true } },
    { type: "started", key: "v2:3", agentId: "aReview", label: "review:S1", phase: "Review" },
    { type: "failed", key: "v2:3", agentId: "aReview" },
    // An agent() call with no label/phase journals only its id; the sidecar supplies both.
    { type: "started", key: "v2:4", agentId: "aBare" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n")

  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  tailer.tick()
  return { tailer, storage, dir, runDir }
}

function cleanup(f: { tailer: { stop(): void }; storage: { close(): void }; dir: string }) {
  f.tailer.stop()
  f.storage.close()
  rmSync(f.dir, { recursive: true, force: true })
}

test("a live workflow is a tracked child, with its RUNNING agents nested one level beneath it", () => {
  const f = fixture()
  try {
    const rows = f.tailer.get(SLUG)?.subAgents ?? []
    assert.deepEqual(rows.map((r) => [r.id, r.label, r.depth ?? 1, r.parentId, r.workflow ?? false, r.phase]), [
      [TOOL, "featherduster-wave2", 1, undefined, true, undefined],
      // Finished (aImpl1) and failed (aReview) agents stay off the live surfaces; the drawer lists them.
      ["aImpl2", "impl:S2", 2, TOOL, false, "Implement"],
      ["aBare", "bare agent", 2, TOOL, false, "Review"],
    ])
    assert.equal(rows[0].taskId, "wy4e6vc5c", "the ack's task id is the handle the worker was given")
    assert.equal(rows[0].state, "running")
  } finally {
    cleanup(f)
  }
})

test("the drill-in resolves the run to its tree and each agent to its own transcript", () => {
  const f = fixture()
  try {
    const run = f.tailer.subAgent(SLUG, TOOL)
    assert.equal(run?.workflow?.runDir, f.runDir)
    assert.equal(run?.workflow?.live, true)
    assert.equal(run?.direct, false, "a workflow is not a conversation: no steer may be addressed to it")
    assert.deepEqual(run!.workflow!.agents.map((a) => [a.id, a.phase, a.state]), [
      ["aImpl1", "Implement", "done"],
      ["aImpl2", "Implement", "running"],
      ["aReview", "Review", "failed"],
      ["aBare", "Review", "running"],
    ])
    const agent = f.tailer.subAgent(SLUG, "aImpl2")
    assert.equal(agent?.outputFile, join(f.runDir, "agent-aImpl2.jsonl"))
    assert.equal(agent?.state, "running")
    assert.equal(agent?.direct, false)
    assert.equal(f.tailer.subAgent(SLUG, "aNobody"), undefined, "an id no run holds still resolves to nothing")
  } finally {
    cleanup(f)
  }
})

test("the run's terminal notification retires it, its agents with it, and the tree stays browsable", () => {
  const f = fixture()
  try {
    // Verbatim shape of a run that died with its process — agents journalled as started, never finished.
    appendFileSync(join(f.dir, `${SESSION}.jsonl`), `${JSON.stringify({
      type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(),
      content: `<task-notification>\n<task-id>wy4e6vc5c</task-id>\n<tool-use-id>${TOOL}</tool-use-id>\n<status>stopped</status>\n<summary>Background workflow "featherduster-wave2" (run wf_45e1076e-215) didn't finish before the previous session ended</summary>\n</task-notification>`,
    })}\n`)
    f.tailer.tick()
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents ?? [], [])
    const run = f.tailer.subAgent(SLUG, TOOL)
    assert.equal(run?.state, "done")
    assert.equal(run?.workflow?.live, false)
    // A dead run's "started" agents are not running — nothing is left to run them.
    assert.equal(f.tailer.subAgent(SLUG, "aImpl2")?.state, "done")
    assert.equal(f.tailer.subAgent(SLUG, "aImpl2")?.outputFile, join(f.runDir, "agent-aImpl2.jsonl"))
  } finally {
    cleanup(f)
  }
})

test("the row is named by the script's meta, never by a name: deeper in its body", () => {
  assert.equal(workflowLabel({ script: SCRIPT }), "featherduster-wave2")
  assert.equal(workflowLabel({ scriptPath: "/x/workflows/scripts/featherduster-wave1-wf_af23b2c8-854.js" }), "featherduster-wave1")
  assert.equal(workflowLabel({ name: "review-changes" }), "review-changes")
  assert.equal(workflowLabel({}), "workflow")
})
