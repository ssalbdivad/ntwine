import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import { createPeriodicStatus, operatorMessages, recentConversation } from "./periodic-status.ts"
import { createStorage, type SessionRow } from "./storage.ts"

const SLUG = "long-thread"
const SESSION = "11111111-1111-4111-8111-111111111111"

const user = (text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ role: "user", text, tools: [], parts: [], ...extra }) as TranscriptMessage
const agent = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] }) as TranscriptMessage

function harness(titleLocked = 0) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-status-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-09-24T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: titleLocked, title: "Opening ask", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  let messages: TranscriptMessage[] = []
  const asked: string[] = []
  const names: Array<string | undefined> = []
  const periodic = createPeriodicStatus({
    storage,
    writeStatus: async ({ name, conversation }) => { asked.push(conversation); names.push(name); return `Status ${asked.length}` },
    nameOf: (row) => row.title ?? undefined,
    readMessages: () => messages,
    onStatus: () => {},
  })
  const rest = async (next: TranscriptMessage[]) => {
    messages = next
    periodic.onTurnDone(storage.getSession(SLUG)!)
    await new Promise((r) => setImmediate(r))
  }
  return { storage, asked, names, rest }
}

function exchanges(n: number): TranscriptMessage[] {
  return Array.from({ length: n }, (_, i) => [user(`ask ${i + 1}`), agent(`reply ${i + 1}`)]).flat()
}

test("only the operator's own messages count — wakes, child reports, boundaries and queued bubbles do not", () => {
  const counted = operatorMessages([
    user("real"),
    user("scheduler steer", { wake: true }),
    user("child report", { peerFrom: "ntwine:high" }),
    user("", { boundary: "compaction" }),
    user("not yet delivered", { queued: true }),
    user("into a child", { agentInstruction: true }),
    agent("reply"),
  ])
  assert.deepEqual(counted.map((m) => m.text), ["real"])
})

test("the description is the recent window, both sides, never the opening ask", () => {
  const text = recentConversation(exchanges(7), 5)!
  assert.match(text, /User: ask 3/)
  assert.match(text, /Assistant: reply 7/)
  assert.doesNotMatch(text, /ask 2\b/)
})

test("every rest the conversation moved writes a STATUS and leaves the name alone", async () => {
  const { storage, asked, names, rest } = harness()
  storage.setMintedTitle(SLUG, SESSION, "Shell budgets")
  await rest(exchanges(1))
  assert.equal(asked.length, 1)
  const row = storage.getSession(SLUG)!
  assert.equal(row.status, "Status 1")
  // The name is untouched — text, provenance and the worker's unspent rename alike.
  assert.equal(row.title, "Shell budgets")
  assert.equal(row.title_agent, 1)
  assert.equal(row.title_worker_renamed, 0)
  // The writer is told the name only so the status does not repeat it.
  assert.equal(names[0], "Shell budgets")
  await rest(exchanges(2))
  assert.equal(asked.length, 2)
  assert.equal(storage.getSession(SLUG)?.status, "Status 2")
  assert.equal(storage.getSession(SLUG)?.title, "Shell budgets")
})

test("a rest that added no reply and no operator message keeps the standing status", async () => {
  const { asked, rest } = harness()
  await rest(exchanges(2))
  assert.equal(asked.length, 1)
  // A watcher tick the agent answered with tool calls only, and a still-queued bubble.
  await rest([...exchanges(2), user("wake", { wake: true }), agent(""), user("later", { queued: true })])
  assert.equal(asked.length, 1)
  // A wake the agent DID answer moves the conversation: the reply may be what makes the status stale.
  await rest([...exchanges(2), user("wake", { wake: true }), agent(""), user("later", { queued: true }), agent("published")])
  assert.equal(asked.length, 2)
  assert.match(asked[1]!, /Assistant: published/)
})

test("the window is the last five exchanges", async () => {
  const { asked, rest } = harness()
  await rest(exchanges(10))
  assert.match(asked[0]!, /ask 6/)
  assert.doesNotMatch(asked[0]!, /ask 5\b/)
})

test("a human-named thread still gets a status — the status is not the name", async () => {
  const { storage, asked, rest } = harness(1)
  await rest(exchanges(1))
  assert.equal(asked.length, 1)
  assert.equal(storage.getSession(SLUG)?.status, "Status 1")
  assert.equal(storage.getSession(SLUG)?.title, "Opening ask")
  assert.equal(storage.getSession(SLUG)?.title_locked, 1)
})

test("a status read from a replaced session never lands on its successor", async () => {
  const { storage, rest } = harness()
  await rest(exchanges(4))
  assert.equal(storage.setStatus(SLUG, "22222222-2222-4222-8222-222222222222", "Stale"), false)
  assert.equal(storage.getSession(SLUG)?.status, "Status 1")
})
