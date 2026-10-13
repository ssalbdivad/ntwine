import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { DEADLINES_DIRNAME, INBOX_DIRNAME, postToAgentInbox, setChildDeadline, workflowSessionDir } from "./agent-inbox.ts"

// ---- workflow-agent mailbox (cc-worker/hooks/agent-inbox.mjs + agent-inbox.ts) ----
// The server writes a message with agent-inbox.ts; the worker plugin's hook reads it. The two are
// separate implementations of one file format (the hook runs under bare node and cannot import TS),
// so these tests write with the server's code and read with the REAL hook, fed the event JSON Claude
// Code sends. The event shapes are the ones measured live on 2.1.287 (agent-inbox.ts header).

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/agent-inbox.mjs")
const AGENT = "ad5015db0606ea02e"
const RUN = "wf_afd1c1ef-ace"

/** A session dir laid out as Claude Code writes it, with one Workflow run whose journal says `agents`. */
function newSession(agents: Array<{ id: string; label?: string; done?: boolean }>, runStatus?: string): { transcript: string; sessionDir: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-inbox-"))
  const transcript = join(root, "6962af17-1cb2-44fa-8e3f-c5bd405f4fa1.jsonl")
  writeFileSync(transcript, "")
  const sessionDir = transcript.slice(0, -".jsonl".length)
  const runDir = join(sessionDir, "subagents", "workflows", RUN)
  mkdirSync(runDir, { recursive: true })
  const lines = [{ type: "launched" }]
  for (const a of agents) {
    lines.push({ type: "started", key: `v2:${a.id}`, agentId: a.id, ...(a.label ? { label: a.label } : {}) } as never)
    if (a.done) lines.push({ type: "result", key: `v2:${a.id}`, agentId: a.id, result: "ok" } as never)
  }
  writeFileSync(join(runDir, "journal.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  if (runStatus) {
    mkdirSync(join(sessionDir, "workflows"), { recursive: true })
    writeFileSync(join(sessionDir, "workflows", `${RUN}.json`), JSON.stringify({ runId: RUN, status: runStatus }))
  }
  return { transcript, sessionDir, runDir }
}

function runHook(event: Record<string, unknown>, env: Record<string, string> = { NTWINE_THREAD: "some-thread" }): string {
  return execFileSync("node", [HOOK], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, NTWINE_THREAD: "", NTWINE_PERM_DIR: "", ...env } })
}

const postToolUse = (transcript: string, agentId?: string) => ({
  hook_event_name: "PostToolUse",
  transcript_path: transcript,
  tool_name: "Bash",
  ...(agentId ? { agent_id: agentId, agent_type: "workflow-subagent" } : {}),
})

const sendMessage = (transcript: string, to: string, message: unknown = "switch to the parser fix") => ({
  hook_event_name: "PreToolUse",
  transcript_path: transcript,
  tool_name: "SendMessage",
  tool_input: { to, summary: "redirect", message },
})

test("the server's run dir resolves to the session dir the hook derives from the transcript", () => {
  const s = newSession([{ id: AGENT }])
  assert.equal(workflowSessionDir(s.runDir), s.sessionDir)
})

test("a queued message reaches the agent after its next tool call, once, in order", () => {
  const s = newSession([{ id: AGENT }])
  postToAgentInbox(s.sessionDir, AGENT, { from: "operator", text: "first" })
  postToAgentInbox(s.sessionDir, AGENT, { from: "parent", text: "second" })

  const out = JSON.parse(runHook(postToolUse(s.transcript, AGENT)))
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse")
  const ctx: string = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /⟦Ntwine mailbox: message from the user operating Ntwine⟧ first/)
  assert.match(ctx, /⟦Ntwine mailbox: message from the agent that dispatched you⟧ second/)
  assert.ok(ctx.indexOf("first") < ctx.indexOf("second"), "oldest first")

  assert.equal(runHook(postToolUse(s.transcript, AGENT)), "", "a delivered message is not delivered again")
  assert.deepEqual(readdirSync(join(s.sessionDir, INBOX_DIRNAME, AGENT)), [], "and nothing is left behind")
})

test("nothing waiting, the main thread, or a non-worker session: the hook says nothing", () => {
  const s = newSession([{ id: AGENT }])
  assert.equal(runHook(postToolUse(s.transcript, AGENT)), "")
  postToAgentInbox(s.sessionDir, AGENT, { from: "parent", text: "hello" })
  assert.equal(runHook(postToolUse(s.transcript)), "", "the main thread never reads a sub-agent's mail")
  assert.equal(runHook(postToolUse(s.transcript, AGENT), { NTWINE_THREAD: "" }), "", "inert outside an Ntwine worker")
  assert.equal(runHook(postToolUse(s.transcript, "a-different-agent")), "", "another agent's mail is not this one's")
})

test("every sub-agent is told about its mailbox before it runs anything", () => {
  // Measured live (2.1.287): delivered cold, the message reads as an instruction smuggled into a tool
  // result, and the agent declined it. Telling it at the start is what makes the later message its
  // dispatcher's word rather than an injection.
  const s = newSession([{ id: AGENT }])
  const start = (agentType: string) => ({ hook_event_name: "SubagentStart", transcript_path: s.transcript, agent_id: AGENT, agent_type: agentType })
  const out = JSON.parse(runHook(start("workflow-subagent")))
  assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart")
  assert.match(out.hookSpecificOutput.additionalContext, /⟦Ntwine mailbox⟧/)
  assert.match(out.hookSpecificOutput.additionalContext, /not part of that tool's output/)
  // A plain sub-agent too (2026-10-08): the server now posts to any running child — a time limit's note, a
  // drawer steer, a message_thread to @thread.child — so it needs the same introduction.
  assert.match(JSON.parse(runHook(start("general-purpose"))).hookSpecificOutput.additionalContext, /⟦Ntwine mailbox⟧/)
})

test("an agent about to finish is held for a waiting message, and only then", () => {
  const s = newSession([{ id: AGENT }])
  const stop = { hook_event_name: "SubagentStop", transcript_path: s.transcript, agent_id: AGENT, agent_type: "workflow-subagent", stop_hook_active: false }
  assert.equal(runHook(stop), "", "nothing waiting: it finishes")
  postToAgentInbox(s.sessionDir, AGENT, { from: "parent", text: "one more thing" })
  const out = JSON.parse(runHook(stop))
  assert.equal(out.decision, "block")
  assert.match(out.reason, /⟦Ntwine mailbox: message from the agent that dispatched you⟧ one more thing/)
  assert.equal(runHook({ ...stop, stop_hook_active: true }), "", "the message was taken, so the next stop goes through")
})

test("SendMessage to a running Workflow agent is diverted into its mailbox and reported as delivered", () => {
  const s = newSession([{ id: AGENT, label: "impl:errors" }])
  const out = JSON.parse(runHook(sendMessage(s.transcript, AGENT)))
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny", "the native SendMessage would start a second copy")
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Delivered by Ntwine\./)
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /do not resend/)

  const delivered = JSON.parse(runHook(postToolUse(s.transcript, AGENT))).hookSpecificOutput.additionalContext
  assert.match(delivered, /⟦Ntwine mailbox: message from the agent that dispatched you⟧ switch to the parser fix/)
})

test("SendMessage finds a running Workflow agent by its label when exactly one carries it", () => {
  const s = newSession([{ id: AGENT, label: "impl:errors" }, { id: "b1", label: "review" }, { id: "b2", label: "review" }])
  assert.match(runHook(sendMessage(s.transcript, "impl:errors")), /Delivered by Ntwine/)
  assert.equal(runHook(sendMessage(s.transcript, "review")), "", "an ambiguous label is left to SendMessage's own resolution")
  assert.equal(existsSync(join(s.sessionDir, INBOX_DIRNAME, "b1")), false)
})

test("SendMessage passes through untouched for anything that is not a RUNNING Workflow agent", () => {
  const finished = newSession([{ id: AGENT, done: true }])
  assert.equal(runHook(sendMessage(finished.transcript, AGENT)), "", "a finished agent has no live copy to duplicate")

  const settled = newSession([{ id: AGENT }], "completed")
  assert.equal(runHook(sendMessage(settled.transcript, AGENT)), "", "a settled run has no running agents, whatever its journal says")

  const live = newSession([{ id: AGENT }], "running")
  assert.equal(runHook(sendMessage(live.transcript, "main")), "", "a message to the main thread is SendMessage's own")
  assert.equal(runHook(sendMessage(live.transcript, "some-plain-subagent")), "", "a plain sub-agent takes SendMessage natively")
  assert.equal(runHook(sendMessage(live.transcript, AGENT, { type: "shutdown_request" })), "", "a structured message is not text to deliver")
  assert.match(runHook(sendMessage(live.transcript, AGENT)), /Delivered by Ntwine/, "a run still marked running is live")
})

test("a malformed agent id is refused rather than written outside the mailbox", () => {
  const s = newSession([])
  assert.throws(() => postToAgentInbox(s.sessionDir, "../escape", { from: "operator", text: "x" }), /not an agent id/)
})

test("a message from another Ntwine thread is signed with that thread's handle", () => {
  const s = newSession([{ id: AGENT }])
  postToAgentInbox(s.sessionDir, AGENT, { from: "@shell-budgets", text: "the cache key moved to src/keys.ts" })
  const ctx: string = JSON.parse(runHook(postToolUse(s.transcript, AGENT))).hookSpecificOutput.additionalContext
  assert.match(ctx, /⟦Ntwine mailbox: message from the Ntwine thread @shell-budgets⟧ the cache key moved/)
})

// ---- a running child's time limit, rewritten by the server (agent-inbox.ts setChildDeadline) ----
// The child's hook works its deadline out ONCE and caches it — "none" included — so a limit the user sets
// after the child started reached it only through this rewrite. Written by the server, read by the REAL hook.

const PLAIN = "a1b2c3d4e5f6a7b8c"
/** A session with one PLAIN running sub-agent whose prompt carried no deadline marker. */
function plainChild(): { transcript: string; sessionDir: string } {
  const s = newSession([])
  mkdirSync(join(s.sessionDir, "subagents"), { recursive: true })
  writeFileSync(join(s.sessionDir, "subagents", `agent-${PLAIN}.jsonl`), JSON.stringify({ type: "user", timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: "user", content: "Audit the parser." } }) + "\n")
  return s
}
const childToolCall = (transcript: string) => ({ hook_event_name: "PostToolUse", transcript_path: transcript, tool_name: "Bash", agent_id: PLAIN, agent_type: "general-purpose" })
const childSays = (transcript: string): string => {
  const out = runHook(childToolCall(transcript))
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : ""
}

test("a child that cached no limit picks up the one the user set later, introduced as the user's, then checked in on", () => {
  const s = plainChild()
  assert.equal(childSays(s.transcript), "", "negative control: no limit, nothing said")
  assert.deepEqual(JSON.parse(readFileSync(join(s.sessionDir, DEADLINES_DIRNAME, `${PLAIN}.json`), "utf8")), { none: true }, "and the hook cached that")

  const now = Date.now()
  assert.equal(setChildDeadline(s.sessionDir, PLAIN, { atMs: now + 10 * 60_000, nowMs: now }), true)
  const intro = childSays(s.transcript)
  assert.match(intro, /⏰ Your time limit: .* set by the user operating Ntwine, after you started/)
  assert.equal(childSays(s.transcript), "", "introduced once")

  // Past the deadline already: the next tool call brings the `over` check-in.
  assert.equal(setChildDeadline(s.sessionDir, PLAIN, { atMs: now - 1_000, nowMs: now - 120_000 }), true)
  assert.match(childSays(s.transcript), /Your time is up/)
})

test("a sooner limit the child already has is kept; a lift touches only a limit the user set", () => {
  const s = plainChild()
  const now = Date.now()
  mkdirSync(join(s.sessionDir, DEADLINES_DIRNAME), { recursive: true })
  const own = { atMs: now + 5 * 60_000, setAtMs: now, announce: false }
  writeFileSync(join(s.sessionDir, DEADLINES_DIRNAME, `${PLAIN}.json`), JSON.stringify(own))
  assert.equal(setChildDeadline(s.sessionDir, PLAIN, { atMs: now + 30 * 60_000, nowMs: now }), false, "later than its own: kept")
  assert.equal(setChildDeadline(s.sessionDir, PLAIN, null), false, "its dispatcher's share is not the user's to lift")
  assert.deepEqual(JSON.parse(readFileSync(join(s.sessionDir, DEADLINES_DIRNAME, `${PLAIN}.json`), "utf8")), own)

  assert.equal(setChildDeadline(s.sessionDir, PLAIN, { atMs: now + 2 * 60_000, nowMs: now }), true, "sooner: taken")
  assert.equal(setChildDeadline(s.sessionDir, PLAIN, null), true, "and the user's own limit can be lifted")
  assert.deepEqual(JSON.parse(readFileSync(join(s.sessionDir, DEADLINES_DIRNAME, `${PLAIN}.json`), "utf8")), { none: true })
})
