import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DISPATCH_TASK_BANNER_MARKER, spinoffChildPrompt } from "@ntwine/shared"
import { parseTranscript, projectCodexTranscript } from "./transcript.ts"
import { projectAcpTranscript } from "./backend/acp-transcript.ts"
import { createStorage, type SessionRow } from "./storage.ts"

// THE CHILD END OF A SPINOFF (2026-09-30): a spinoff child's opening turn is the human's instructions and
// the context it started with, drawn as the thread's spinoff header — never one giant user bubble. Plus
// what happens to the edge when the child is forgotten.

const INSTRUCTIONS = "Evaluate whether the sub-agent addresses feature is worth keeping"
const BRIEF = "Context: addresses landed in c47844bd.\n\nRead packages/shared/src/thread-handle.ts first."
const HANDLE_PROMPT = spinoffChildPrompt({ parentSlug: "live-sub-agents", parentTitle: "Live sub-agents", parentHandle: "liveSubAgents", instructions: INSTRUCTIONS, brief: BRIEF })
const LINK_PROMPT = spinoffChildPrompt({ parentSlug: "live-sub-agents", parentTitle: "Live sub-agents", instructions: INSTRUCTIONS, brief: BRIEF })
const envelope = (task: string) => `Your scratchpad is \`.ntwine/threads/sid/scratch.md\` — …${DISPATCH_TASK_BANNER_MARKER}${task}`
const ORIGIN = { instructions: INSTRUCTIONS, brief: BRIEF }
const AT = "2026-09-30T03:44:00.000Z"

const userRecord = (content: string, ts = AT) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } })
const enqueueRecord = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: AT, content })
const assistantText = (text: string, id = "m1") => JSON.stringify({ type: "assistant", timestamp: AT, message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })

test("a spinoff child's opening turn projects into its origin under both parent spellings and every Claude record shape", () => {
  for (const prompt of [HANDLE_PROMPT, LINK_PROMPT]) {
    // The spawned-CLI runtime writes a plain user record, the broker a queue-operation enqueue.
    for (const record of [userRecord(envelope(prompt)), enqueueRecord(envelope(prompt))]) {
      const [first] = parseTranscript(record)
      assert.deepEqual(first.spinoffOrigin, ORIGIN)
      assert.equal(first.displayText, INSTRUCTIONS, "the request every reader quotes is what the human asked")
      assert.equal(first.text, envelope(prompt), "the stored text is never narrowed")
    }
  }
})

test("only the OPENING turn is a spinoff origin, and an ordinary opening turn is untouched", () => {
  const msgs = parseTranscript([userRecord(envelope("Fix the flaky resolver test")), assistantText("ok"), userRecord(HANDLE_PROMPT, "2026-09-30T03:45:00.000Z")].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users[0].displayText, "Fix the flaky resolver test")
  assert.equal(users[0].spinoffOrigin, undefined)
  assert.equal(users[1].spinoffOrigin, undefined, "a human who pastes the framing later is just talking")
})

// A child an older build started opened on the parent worker's brief under "The context … gathered for
// you:"; it still draws its header.
test("a child whose prompt carries the older brief framing still projects its origin", () => {
  const older = HANDLE_PROMPT.replace("Context from @liveSubAgents:", "The context @liveSubAgents gathered for you:")
  assert.notEqual(older, HANDLE_PROMPT)
  const [first] = parseTranscript(userRecord(envelope(older)))
  assert.deepEqual(first.spinoffOrigin, ORIGIN)
  const linked = LINK_PROMPT.replace("Context from that thread:", "The context that thread gathered for you:")
  assert.deepEqual(parseTranscript(userRecord(envelope(linked)))[0].spinoffOrigin, ORIGIN)
})

test("Codex: the opening turn projects its origin, and a spawn_thread call is an ordinary call", () => {
  const line = (payload: Record<string, unknown>, type = "event_msg") => JSON.stringify({ timestamp: AT, type, payload })
  const msgs = projectCodexTranscript([
    line({ type: "user_message", message: envelope(HANDLE_PROMPT) }),
    line({ type: "function_call", call_id: "call_1", name: "mcp__ntwine__spawn_thread", arguments: JSON.stringify({ prompt: "brief", model: "gpt-5.6-sol", effort: "high", spinoff: "spn_0123456789abcdef" }) }, "response_item"),
    line({ type: "function_call", call_id: "call_2", name: "mcp__ntwine__spawn_thread", arguments: JSON.stringify({ prompt: "plain", model: "gpt-5.6-sol", effort: "high" }) }, "response_item"),
  ].join("\n"))
  const first = msgs.find((m) => m.role === "user")!
  assert.deepEqual(first.spinoffOrigin, ORIGIN)
  assert.equal(first.displayText, INSTRUCTIONS)
  assert.deepEqual(msgs.flatMap((m) => m.tools).map((c) => "spinoff" in c), [false, false])
})

test("ACP: the opening turn projects its origin, and a later one does not", () => {
  const records = [
    { kind: "user-message", at: AT, text: HANDLE_PROMPT, synthetic: false },
    { kind: "turn-start", at: AT },
    // opencode titles an MCP tool `<server>_<tool>`; its input may only arrive on the completing update.
    { kind: "tool-call", at: AT, id: "c1", name: "ntwine_spawn_thread", input: { prompt: "b", model: "m", effort: "high", spinoff: "spn_0123456789abcdef" } },
    { kind: "tool-call", at: AT, id: "c2", name: "ntwine_spawn_thread", input: {} },
    { kind: "tool-result", at: AT, id: "c2", text: "Spawned a new ntwine thread `x`.", acp: { input: { prompt: "b", spinoff: "spn_00000000000000aa" } } },
    { kind: "turn-end", at: AT, finalText: "", successful: true },
    { kind: "user-message", at: AT, text: HANDLE_PROMPT, synthetic: false },
  ]
  const msgs = projectAcpTranscript(records.map((r) => JSON.stringify(r)).join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users[0].spinoffOrigin, ORIGIN)
  assert.equal(users[0].displayText, INSTRUCTIONS)
  assert.equal(users[1].spinoffOrigin, undefined)
  assert.deepEqual(msgs.flatMap((m) => m.tools).map((c) => "spinoff" in c), [false, false])
})

// ---- a forgotten child ------------------------------------------------------------------------------

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return { slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-09-30T03:44:27.775Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over }
}

const REQUEST_AT = Date.parse("2026-09-30T04:00:00.000Z")

// A FORGOTTEN CHILD TAKES ITS EDGE WITH IT (2026-09-30). deleteThread frees the slug, and the next thread
// slugified to it — the human re-dispatching the task by hand — used to inherit the dead child's edge, and
// the board linked it back to a parent it never came from.
test("forgetting a spinoff child drops its edge, so the next thread under its slug is nobody's spinoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-spinoff-child-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  try {
    storage.upsertSession(sessionRow("parent"))
    storage.upsertSession(sessionRow("investigate-perf"))
    storage.insertSpinoff({ id: "spn_00000000000000f1", parentSlug: "parent", instructions: "OLD INSTRUCTIONS", createdAtMs: REQUEST_AT })
    storage.completeSpinoff("spn_00000000000000f1", "investigate-perf", REQUEST_AT + 1)
    storage.forgetSession("investigate-perf")
    assert.equal(storage.spinoffsBySlug().get("investigate-perf"), undefined)
    assert.equal(storage.spinoffsBySlug().get("parent"), undefined, "deleted, not left behind as a request")
    assert.deepEqual(storage.spinoffsOf("parent"), [], "and the parent's chat draws no card for it")

    // The human dispatches the same task by hand; it slugifies to the freed slug.
    storage.upsertSession(sessionRow("investigate-perf", { session_id: "sid-new", spawned_at: "2026-09-30T05:00:00.000Z" }))
    assert.equal(storage.spinoffsBySlug().get("investigate-perf"), undefined, "the new thread is nobody's spinoff")
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// …and the edge a forget left behind BEFORE that fix is swept the next time the database is opened; a
// live child's edge, and an older build's request that never started, are left exactly as they are.
test("opening storage drops a spinoff edge whose child was already forgotten", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-spinoff-child-"))
  try {
    const first = createStorage(join(dir, "ui.db"), "p")
    first.upsertSession(sessionRow("parent"))
    first.upsertSession(sessionRow("alive"))
    first.insertSpinoff({ id: "spn_00000000000000f3", parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    first.completeSpinoff("spn_00000000000000f3", "ghost", REQUEST_AT + 1) // a child with no row: forgotten
    first.insertSpinoff({ id: "spn_00000000000000f4", parentSlug: "parent", instructions: "b", createdAtMs: REQUEST_AT })
    first.completeSpinoff("spn_00000000000000f4", "alive", REQUEST_AT + 1)
    first.insertSpinoff({ id: "spn_00000000000000f5", parentSlug: "parent", instructions: "c", createdAtMs: REQUEST_AT })
    first.close()
    const reopened = createStorage(join(dir, "ui.db"), "p")
    try {
      assert.deepEqual(reopened.spinoffsOf("parent").map((r) => [r.id, r.child_slug]), [["spn_00000000000000f4", "alive"], ["spn_00000000000000f5", null]])
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
