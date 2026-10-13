// A THREAD'S SUB-AGENT DIRECTORY — every child it ever dispatched, live first, then finished newest first
// (tailer subAgentDirectory, the `subAgentDirectory` RPC and `read_thread thread.subAgent` behind it).
//
// The property that matters is HISTORY: a child that has returned, and even one that has aged out of the
// tailer's bounded retained ring, is still listed and still opens — because its sidecar and transcript
// are on disk in the session's own flat `subagents/` dir, which Claude writes once at spawn and never
// deletes. Fixture layout and record shapes follow tailer.descendants.test.ts (real broker bytes).
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"

const SESSION = "11111111-2222-3333-4444-555555555555"
const SLUG = "directory"

const assistant = (content: unknown[], at = "2026-09-30T02:00:00.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id: `m${Math.random()}`, stop_reason: "end_turn", content } })
const notification = (agentId: string, toolUseId: string, status: string, at: string) =>
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at,
    content: [
      "<task-notification>",
      `<task-id>${agentId}</task-id>`,
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      `<status>${status}</status>`,
      `<summary>Agent "${agentId}" finished</summary>`,
      "<result>Here is the review.</result>",
      "</task-notification>",
    ].join("\n"),
  })
const dispatch = (id: string, description: string) => ({ type: "tool_use", id, name: "Agent", input: { description, subagent_type: "ntwine:high", prompt: `Do ${description}.`, run_in_background: true } })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-directory-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const subagents = join(dir, SESSION, "subagents")
  mkdirSync(subagents, { recursive: true })
  const sidecar = (agentId: string, body: Record<string, unknown>, spawnedAt: Date) => {
    const path = join(subagents, `agent-${agentId}.meta.json`)
    writeFileSync(path, JSON.stringify(body))
    utimesSync(path, spawnedAt, spawnedAt)
  }
  const transcript = (agentId: string, lines: string[]) => writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`)

  // This transcript dispatches THREE children, finishes two of them, and keeps one running.
  // An OLDER first "Review" exists only on disk: its dispatch predates this transcript's window, the way a
  // child ages out of the retained ring on a long thread. Nothing in memory knows it; the sidecar does.
  writeFileSync(join(dir, `${SESSION}.jsonl`), [
    assistant([dispatch("toolu_keys", "Cache keys"), dispatch("toolu_review", "Review"), dispatch("toolu_path", "Migration path")]),
    notification("aReview", "toolu_review", "completed", "2026-09-30T02:10:00.000Z"),
    notification("aPath", "toolu_path", "failed", "2026-09-30T02:05:00.000Z"),
  ].join("\n") + "\n")

  const hour = (h: number) => new Date(Date.UTC(2026, 8, 30, h))
  sidecar("aOldReview", { agentType: "ntwine:high", description: "Review", toolUseId: "toolu_old_review", spawnDepth: 1 }, hour(0))
  transcript("aOldReview", [JSON.stringify({ type: "user", timestamp: "2026-09-30T00:00:00.000Z", message: { role: "user", content: "Review the first cut." } }), assistant([{ type: "text", text: "The first cut is fine." }], "2026-09-30T00:05:00.000Z")])
  sidecar("aKeys", { agentType: "ntwine:high", description: "Cache keys", toolUseId: "toolu_keys", spawnDepth: 1 }, hour(2))
  transcript("aKeys", [assistant([dispatch("toolu_trace", "Trace collision")])])
  sidecar("aReview", { agentType: "ntwine:high", description: "Review", toolUseId: "toolu_review", spawnDepth: 1 }, hour(2))
  transcript("aReview", [assistant([{ type: "text", text: "Reviewed." }])])
  sidecar("aPath", { agentType: "ntwine:high", description: "Migration path", toolUseId: "toolu_path", spawnDepth: 1 }, hour(2))
  transcript("aPath", [assistant([{ type: "text", text: "Could not finish." }])])
  // A grandchild under the live child, and one whose parent has no sidecar (cannot be placed).
  sidecar("aTrace", { agentType: "general-purpose", description: "Trace collision", toolUseId: "toolu_trace", parentAgentId: "aKeys", spawnDepth: 2 }, hour(2))
  transcript("aTrace", [assistant([{ type: "text", text: "Tracing." }])])
  sidecar("aOrphan", { agentType: "general-purpose", description: "Orphan", toolUseId: "toolu_orphan", parentAgentId: "aGone", spawnDepth: 2 }, hour(1))

  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  const tailer = createTailer({ project: { cwdSlug: "x" } as Project, storage, bus: new Bus(), sessionLogDir: dir, onChange: () => {}, paneDead: () => false })
  tailer.tick()
  return { tailer, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the directory lists live children first, then every finished one newest first — including one only the disk remembers", () => {
  const { tailer, cleanup } = fixture()
  try {
    const rows = tailer.subAgentDirectory!(SLUG)
    assert.deepEqual(
      rows.map((r) => [r.label, r.state, r.depth, r.parentId ?? null]),
      [
        ["Cache keys", "running", 1, null],
        ["Trace collision", "running", 2, "toolu_keys"],
        ["Review", "done", 1, null],
        ["Migration path", "done", 1, null],
        ["Review", "done", 1, null],
      ],
    )
    const [, , review, path, oldReview] = rows
    assert.equal(review!.id, "toolu_review")
    assert.equal(review!.outcome, "completed", "a retired child carries how it ended")
    assert.equal(review!.finishedAt, "2026-09-30T02:10:00.000Z")
    assert.equal(path!.outcome, "failed")
    assert.equal(oldReview!.id, "toolu_old_review", "the older Review comes last: newest finished first")
    assert.equal(oldReview!.startedAt, "2026-09-30T00:00:00.000Z", "its dispatch instant is its sidecar's own mtime")
    assert.ok(!rows.some((r) => r.label === "Orphan"), "a descendant whose parent left no sidecar is not misfiled at the top")
  } finally {
    cleanup()
  }
})

test("a child only the disk remembers still opens: its transcript resolves by its dispatch id", () => {
  const { tailer, cleanup } = fixture()
  try {
    const found = tailer.subAgent(SLUG, "toolu_old_review")
    assert.ok(found?.outputFile?.endsWith("agent-aOldReview.jsonl"), "the drawer and read_thread read the same file")
  } finally {
    cleanup()
  }
})

test("a directory for a thread the tailer does not know is empty, never invented", () => {
  const { tailer, cleanup } = fixture()
  try {
    assert.deepEqual(tailer.subAgentDirectory!("no-such-thread"), [])
  } finally {
    cleanup()
  }
})

test("a finished child's late transcript write does not revive it in the directory", () => {
  const { tailer, dir, cleanup } = fixture()
  try {
    appendFileSync(join(dir, SESSION, "subagents", "agent-aReview.jsonl"), `${assistant([{ type: "text", text: "late" }])}\n`)
    tailer.tick()
    assert.equal(tailer.subAgentDirectory!(SLUG).find((r) => r.id === "toolu_review")?.state, "done")
  } finally {
    cleanup()
  }
})
