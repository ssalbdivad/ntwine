// A SUB-AGENT'S TIME LIMIT (ARCHITECTURE.md § Time limits) — cc-worker/hooks/agent-deadline.mjs, as
// agent-dispatch.mjs carves a child's share and agent-inbox.mjs delivers its check-ins. Driven as the
// harness drives them: the real scripts as child processes, the hook events on stdin with the shapes
// measured on 2.1.287, a session directory laid out as Claude Code writes it, and for the thread's own
// deadline a real HTTP server behind a real `server.lock` answering the real query path.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { childDeadlineMs as sharedChild, DEADLINE_STAGES, deadlineStageAtMs, parseDeadlineInput, preciseSpanLabel as sharedPrecise, spanLabel as sharedSpan, TIME_LIMIT_LINE as SHARED_LINE } from "@ntwine/shared"
import * as twin from "../../../cc-worker/hooks/agent-deadline.mjs"

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "../../../cc-worker/hooks")
const PROJECT = "11111111-2222-3333-4444-555555555555"
const M = 60_000

function runHook(name: string, event: Record<string, unknown>, env: Record<string, string> = {}): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(HOOKS, name)], { env: { PATH: dirname(process.execPath), NTWINE_THREAD: "thread-under-test", ...env }, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout ? JSON.parse(stdout) : {}))
    child.stdin!.end(JSON.stringify(event))
  })
}

/** A ntwine root whose server answers `threadDeadline` with `at` (or no deadline). */
async function ntwineRoot(at: number | undefined) {
  const root = mkdtempSync(join(tmpdir(), "ntwine-agent-deadline-"))
  const permDir = join(root, "projects", PROJECT, "perm-requests")
  mkdirSync(permDir, { recursive: true })
  const asked: string[] = []
  const server = createServer((req, res) => {
    asked.push(req.url!)
    const deadline = at === undefined ? null : { at: new Date(at).toISOString(), setAt: new Date(at - 60 * M).toISOString(), setBy: "human" }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { deadline } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  writeFileSync(join(root, "server.lock"), JSON.stringify({ port: (server.address() as AddressInfo).port, pid: process.pid }))
  return {
    env: { NTWINE_PERM_DIR: permDir }, asked,
    close: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }) },
  }
}

/** A session dir with one sub-agent whose transcript's first record is `prompt`, written at `startMs`. */
function session(agents: Array<{ id: string; prompt: string; startMs?: number; workflowRun?: string }>) {
  const root = mkdtempSync(join(tmpdir(), "ntwine-agent-deadline-session-"))
  const transcript = join(root, "6962af17-1cb2-44fa-8e3f-c5bd405f4fa1.jsonl")
  writeFileSync(transcript, "")
  const sessionDir = transcript.slice(0, -".jsonl".length)
  for (const a of agents) {
    const dir = a.workflowRun ? join(sessionDir, "subagents", "workflows", a.workflowRun) : join(sessionDir, "subagents")
    mkdirSync(dir, { recursive: true })
    const first = { type: "user", timestamp: new Date(a.startMs ?? Date.now()).toISOString(), message: { role: "user", content: a.prompt } }
    writeFileSync(join(dir, `agent-${a.id}.jsonl`), JSON.stringify(first) + "\n" + JSON.stringify({ type: "assistant" }) + "\n")
  }
  return { transcript, sessionDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const dispatch = (prompt: string, over: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt, description: "Cache keys", run_in_background: true }, ...over,
})
const childTool = (transcript: string, agentId: string, agentType = "general-purpose") => ({
  hook_event_name: "PostToolUse", transcript_path: transcript, tool_name: "Bash", agent_id: agentId, agent_type: agentType,
})
const promptOf = (out: Record<string, any>) => out.hookSpecificOutput?.updatedInput?.prompt as string
const markerOf = (prompt: string) => {
  const m = [...prompt.matchAll(/⟦ntwine-deadline⟧ (\S+) (\S+)/g)].at(-1)
  return m ? { atMs: Date.parse(m[1]!), setAtMs: Date.parse(m[2]!) } : undefined
}
const contextOf = (out: Record<string, any>) => out.hookSpecificOutput?.additionalContext as string | undefined

test("the hook's arithmetic is the shared module's, over a grid of budgets and limits", () => {
  for (const remaining of [-5 * M, 0, 30_000, 2 * M, 4 * M, 9 * M, 25 * M, 2 * 60 * M, 3 * 24 * 60 * M]) {
    for (const declared of [undefined, 0, 30_000, 2 * M, 20 * M, 5 * 60 * M]) {
      for (const parent of [true, false]) {
        const input = { nowMs: 1_000_000, parentDeadlineMs: parent ? 1_000_000 + remaining : undefined, declaredMs: declared }
        assert.equal(twin.childDeadlineMs(input), sharedChild(input), JSON.stringify(input))
      }
    }
    if (remaining > 0) {
      for (const stage of DEADLINE_STAGES) assert.equal(twin.stageAtMs(0, remaining, stage), deadlineStageAtMs(0, remaining, stage), `${remaining} ${stage}`)
    }
  }
  assert.equal(twin.TIME_LIMIT_LINE.source, SHARED_LINE.source)
  for (const span of ["20m", "1h 30m", "1h30m", "90s", "2d"]) {
    const shared = parseDeadlineInput(span, 0)
    assert.equal(twin.parseSpan(span), shared.ok ? shared.atMs : undefined, span)
  }
  for (const ms of [0, 5_000, 59_000, 61_000, 80_500, 9 * M + 59_999, 42 * M, 72 * M, 26 * 60 * M]) {
    assert.equal(twin.spanLabel(ms), sharedSpan(ms))
    assert.equal(twin.preciseSpanLabel(ms), sharedPrecise(ms))
  }
})

test("a thread with a deadline: its child gets the remaining time minus a reserve, stated above the epilogue", async () => {
  const deadline = Date.now() + 2 * 60 * M
  const root = await ntwineRoot(deadline)
  try {
    const before = Date.now()
    const prompt = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey the cache keys."), root.env))
    const mark = markerOf(prompt)!
    assert.ok(mark, "the marker its own hook reads back")
    // 2h left: reserve max(24m, 5m) → the child's deadline is 1h 36m out.
    assert.ok(Math.abs(mark.atMs - (deadline - 24 * M)) < 2_000, `${new Date(mark.atMs).toISOString()}`)
    assert.ok(mark.setAtMs >= before - 1_000)
    assert.ok(prompt.indexOf("[TIME LIMIT") < prompt.indexOf("ORCHESTRATION EPILOGUE"), "above the epilogue, so its idempotence holds")
    assert.match(prompt, /Your final message is due by then/)
    assert.equal(root.asked.length, 1)
    assert.match(decodeURIComponent(root.asked[0]!), new RegExp(`/_ntwine/${PROJECT}/rpc/threadDeadline\\?input=\\{"slug":"thread-under-test"\\}`))
  } finally {
    await root.close()
  }
})

test("a declared Time limit is honoured under the ceiling, clamped above it, and stripped either way", async () => {
  const deadline = Date.now() + 30 * M // 30m left: reserve 6m → ceiling 24m out
  const root = await ntwineRoot(deadline)
  try {
    const short = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey the cache keys.\nTime limit: 10m\nReport the hit rate."), root.env))
    assert.ok(Math.abs(markerOf(short)!.atMs - (Date.now() + 10 * M)) < 3_000)
    assert.doesNotMatch(short, /^Time limit:/m, "the line the paragraph replaces")
    assert.match(short, /Survey the cache keys\.\nReport the hit rate\./)
    const long = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey the cache keys.\nTime limit: 3h"), root.env))
    assert.ok(Math.abs(markerOf(long)!.atMs - (deadline - 6 * M)) < 2_000, "never past the parent's deadline minus its reserve")
    const odd = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey.\nTime limit: until lunch"), root.env))
    assert.match(odd, /^Time limit: until lunch$/m, "a line it cannot read stays, for the child")
  } finally {
    await root.close()
  }
})

test("negative control: no deadline and no Time limit line, no share; a Time limit line alone sets one", async () => {
  const root = await ntwineRoot(undefined)
  try {
    const none = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey the cache keys."), root.env))
    assert.equal(markerOf(none), undefined)
    assert.doesNotMatch(none, /TIME LIMIT/)
    const declared = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey.\nTime limit: 2m"), root.env))
    assert.ok(Math.abs(markerOf(declared)!.atMs - (Date.now() + 2 * M)) < 3_000)
  } finally {
    await root.close()
  }
  // No server at all (nothing in the env to find one with): the dispatch still goes through, unshared.
  const offline = promptOf(await runHook("agent-dispatch.mjs", dispatch("Survey the cache keys.")))
  assert.equal(markerOf(offline), undefined)
  assert.match(offline, /ORCHESTRATION EPILOGUE/)
})

test("a nested dispatch is carved from the dispatching child's own deadline, not the thread's", async () => {
  const childAt = Date.now() + 10 * M
  const s = session([{ id: "achild0000000001", prompt: `Do it.${twin.deadlineParagraph(childAt, Date.now() - 10 * M)}` }])
  const root = await ntwineRoot(Date.now() + 5 * 60 * M)
  try {
    const prompt = promptOf(await runHook("agent-dispatch.mjs", dispatch("Help me.", { agent_id: "achild0000000001", transcript_path: s.transcript }), root.env))
    // 10m left for the child: reserve max(2m, 5m) = 5m → the grandchild's deadline is 5m out.
    assert.ok(Math.abs(markerOf(prompt)!.atMs - (childAt - 5 * M)) < 2_000)
    assert.equal(root.asked.length, 0, "the thread's deadline is not the ceiling here")
  } finally {
    await root.close()
    s.cleanup()
  }
})

test("a child's check-ins arrive after its tool calls: the latest stage due, once each", async () => {
  const now = Date.now()
  const s = session([
    { id: "ahalf00000000001", prompt: `Task.${twin.deadlineParagraph(now + 9 * M, now - 11 * M)}` }, // 55%: half
    { id: "aconv00000000001", prompt: `Task.${twin.deadlineParagraph(now + 3 * M, now - 17 * M)}` }, // 85%: converge
    { id: "aover00000000001", prompt: `Task.${twin.deadlineParagraph(now - M, now - 21 * M)}` }, // past: over
    { id: "aearly0000000001", prompt: `Task.${twin.deadlineParagraph(now + 15 * M, now - 5 * M)}` }, // 25%: nothing yet
    { id: "anone00000000001", prompt: "Task with no limit." },
  ])
  try {
    const half = contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "ahalf00000000001")))
    assert.match(half!, /^⏰ Time check: half your time is gone — (8m 59s|9m 00s) left/)
    assert.match(half!, /not a signal to stop/)
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "ahalf00000000001"))), undefined, "once")
    assert.match(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "aconv00000000001")))!, /Start nothing new/)
    const over = contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "aover00000000001")))!
    assert.match(over, /Your time is up/)
    assert.doesNotMatch(over, /half your time/, "only the latest stage")
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "aearly0000000001"))), undefined)
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "anone00000000001"))), undefined)
    // The main thread's own tool calls carry no agent_id: never a child's check-in.
    assert.equal(contextOf(await runHook("agent-inbox.mjs", { hook_event_name: "PostToolUse", transcript_path: s.transcript, tool_name: "Bash" })), undefined)
  } finally {
    s.cleanup()
  }
})

test("parallel tool calls in one child send a stage once", async () => {
  const now = Date.now()
  const s = session([{ id: "apar000000000001", prompt: `Task.${twin.deadlineParagraph(now + 9 * M, now - 11 * M)}` }])
  try {
    const outs = await Promise.all(Array.from({ length: 6 }, () => runHook("agent-inbox.mjs", childTool(s.transcript, "apar000000000001"))))
    assert.equal(outs.filter((o) => contextOf(o)).length, 1)
  } finally {
    s.cleanup()
  }
})

test("a Workflow agent's share is worked out from its own Time limit line and start, and introduced", async () => {
  const start = Date.now() - 70_000
  const wrapped = "[Workflow harness — computed task] Run this.\nThe computed task text follows:\n  Audit the cache.\n  Time limit: 2m\n  Report back."
  const s = session([
    { id: "awf0000000000001", prompt: wrapped, startMs: start, workflowRun: "wf_152a4514-9fb" },
    { id: "awf0000000000002", prompt: "[Workflow harness — computed task]\n  Audit the cache.", startMs: start, workflowRun: "wf_152a4514-9fb" },
  ])
  const root = await ntwineRoot(undefined)
  try {
    const first = contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "awf0000000000001", "workflow-subagent"), root.env))!
    assert.match(first, /^⏰ Your time limit: \d\d:\d\d \(a 2m budget/, "introduced, since its prompt never said")
    assert.match(first, /half your time is gone/, "70s into 2m: half-time")
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "awf0000000000001", "workflow-subagent"), root.env)), undefined)
    // No Time limit line and no thread deadline: nothing, asked of the server once and then remembered.
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "awf0000000000002", "workflow-subagent"), root.env)), undefined)
    assert.equal(contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "awf0000000000002", "workflow-subagent"), root.env)), undefined)
    assert.equal(root.asked.length, 2, "once per agent, then remembered")
  } finally {
    await root.close()
    s.cleanup()
  }
})

test("a Workflow agent in a thread with a deadline gets its share of it with no line at all", async () => {
  const start = Date.now() - 60_000
  const s = session([{ id: "awf0000000000003", prompt: "[Workflow harness — computed task]\n  Audit the cache.", startMs: start, workflowRun: "wf_152a4514-9fb" }])
  const root = await ntwineRoot(start + 10 * M) // 10m left at its start: reserve 5m → a 5m budget, 1m in
  try {
    const first = contextOf(await runHook("agent-inbox.mjs", childTool(s.transcript, "awf0000000000003", "workflow-subagent"), root.env))!
    assert.match(first, /\(a 5m budget/)
    assert.doesNotMatch(first, /Time check/, "a fifth of the way in, no stage yet")
  } finally {
    await root.close()
    s.cleanup()
  }
})
