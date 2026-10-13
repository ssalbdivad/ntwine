import assert from "node:assert/strict"
import test from "node:test"
import { isReadOnlyCommand, toolSchedule, type QueueTool } from "./toolQueue.ts"

const gate = "nub run typecheck 2>&1 | tail -3 && nub --test src/remote-setup.test.ts 2>&1 | grep -E \"^ℹ (pass|fail)\""

// The measured case (session fe5967ef, 2026-10-02): a TaskStop issued right after a foreground gate in
// the same message waited 6m 24s for it, then took 0.9s.
test("a call behind a pending foreground Bash in the same message is queued, not running", () => {
  const live: QueueTool[] = [
    { name: "Bash", command: gate, status: "pending" },
    { name: "TaskStop", status: "pending" },
  ]
  assert.deepEqual(toolSchedule(live), [{}, { queued: true }])
})

test("once the batch ahead returns, the call reads its own time, not the wait", () => {
  const settled: QueueTool[] = [
    { name: "Bash", command: gate, status: "completed", durationMs: 383_538 },
    { name: "TaskStop", status: "completed", durationMs: 384_421 },
  ]
  const [, stop] = toolSchedule(settled)
  assert.deepEqual(stop, { waitedMs: 383_538 })
  assert.equal(384_421 - (stop.waitedMs ?? 0), 883, "the stop itself: under a second")
  // Running after the wait: not queued any more, and its clock starts when the gate returned.
  assert.deepEqual(toolSchedule([settled[0], { name: "TaskStop", status: "pending" }]), [{}, { waitedMs: 383_538 }])
})

test("concurrency-safe calls side by side run together: none of them is queued", () => {
  const reads: QueueTool[] = [
    { name: "Read", status: "pending" },
    { name: "Grep", status: "pending" },
    { name: "Bash", command: "git status --short && ls packages", status: "pending" },
    { name: "TaskStop", status: "pending" },
  ]
  assert.deepEqual(toolSchedule(reads), [{}, {}, {}, {}])
})

test("an unsafe call runs alone: what follows it waits, and so does it, behind an earlier batch", () => {
  const mixed: QueueTool[] = [
    { name: "Read", status: "pending" },
    { name: "Edit", status: "pending" },
    { name: "Read", status: "pending" },
  ]
  assert.deepEqual(toolSchedule(mixed), [{}, { queued: true }, { queued: true }])
  // Ntwine's own MCP tools carry no readOnlyHint, so they run one at a time too.
  assert.deepEqual(toolSchedule([{ name: "mcp__ntwine__title", status: "pending" }, { name: "mcp__ntwine__done", status: "pending" }]), [{}, { queued: true }])
})

// A pending card is not always a call that has not returned: these stay "pending" for the life of what
// they launched, while their tool_result came back at once. None of them may hold up what follows.
test("a detached shell, an Agent, a Workflow or a Monitor does not hold up the calls after it", () => {
  for (const launched of [
    { name: "Bash", command: "nub run dev", status: "pending", backgroundState: "background" },
    { name: "Bash", command: "nub run dev", status: "pending", shellId: "toolu_1" },
    { name: "Agent", status: "pending", agentId: "a1" },
    { name: "Workflow", status: "pending" },
    { name: "Monitor", status: "pending" },
  ] satisfies QueueTool[]) {
    assert.deepEqual(toolSchedule([launched, { name: "Edit", status: "pending" }]), [{}, {}], launched.name)
  }
})

test("a completed call is never queued, and a first call never waits", () => {
  assert.deepEqual(toolSchedule([{ name: "Bash", command: gate, status: "pending" }, { name: "Edit", status: "completed", durationMs: 12 }]), [{}, {}])
  assert.deepEqual(toolSchedule([{ name: "Edit", status: "pending" }]), [{}])
  assert.deepEqual(toolSchedule([]), [])
})

test("only a command built entirely from read-only programs counts as read-only", () => {
  for (const ro of ["ls -la", "git status --short && git log --oneline -3", "cd packages/web && grep -rn foo src | head", "FOO=1 cat a.txt"]) {
    assert.equal(isReadOnlyCommand(ro), true, ro)
  }
  for (const rw of [gate, "rm -rf out", "ls > files.txt", "git commit -m x", "echo $(nub run build)", "sed -i s/a/b/ f", "git", ""]) {
    assert.equal(isReadOnlyCommand(rw), false, rw)
  }
})
