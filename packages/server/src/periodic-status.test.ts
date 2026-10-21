import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import { createPeriodicStatus, operatorMessages, recentConversation, type RestHandoff } from "./periodic-status.ts"
import { createStorage, type SessionRow } from "./storage.ts"

const SLUG = "long-thread"
const SESSION = "11111111-1111-4111-8111-111111111111"

const user = (text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ role: "user", text, tools: [], parts: [], ...extra }) as TranscriptMessage
const agent = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] }) as TranscriptMessage

function harness(titleLocked = 0, opts: { gate?: () => Promise<void> } = {}) {
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
  const handoffs: Array<string | undefined> = []
  let handoff: RestHandoff | undefined
  const periodic = createPeriodicStatus({
    storage,
    writeStatus: async ({ name, conversation, handoff: told }) => {
      asked.push(conversation); names.push(name); handoffs.push(told)
      await opts.gate?.()
      return `Status ${asked.length}`
    },
    handoffOf: () => handoff,
    nameOf: (row) => row.title ?? undefined,
    readMessages: () => messages,
    onStatus: () => {},
  })
  const rest = async (next: TranscriptMessage[], nextHandoff?: RestHandoff) => {
    messages = next
    handoff = nextHandoff
    periodic.onTurnDone(storage.getSession(SLUG)!)
    await new Promise((r) => setImmediate(r))
  }
  return { storage, asked, names, handoffs, rest }
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

const working: RestHandoff = { questions: [], signoff: { kind: "awaiting", status: "working", waitsOn: ["agent a1"], steps: [] } }

test("a rest whose handoff changed rewrites the status with no new words, and tells the writer the handoff", async () => {
  const { asked, handoffs, rest } = harness()
  const asking: RestHandoff = { questions: ["Rename the package to @ark/aot?"] }
  await rest(exchanges(2), asking)
  assert.match(handoffs[0]!, /1 open question[\s\S]*@ark\/aot/)
  // The question was withdrawn and the worker parked on its children: nothing new was said, but the
  // card's "waiting on your pick" is now false.
  await rest(exchanges(2), working)
  assert.equal(asked.length, 2)
  assert.match(handoffs[1]!, /NO open question[\s\S]*status working: .*NOT needed/)
  // The same handoff again, with no new words, is not a move.
  await rest(exchanges(2), working)
  assert.equal(asked.length, 2)
})

test("a rest that lands while a write is in flight re-runs once it finishes, so the newest rest wins", async () => {
  let release!: () => void
  const gate = () => new Promise<void>((r) => { release = r })
  const { storage, asked, rest } = harness(0, { gate })
  await rest(exchanges(1))
  assert.equal(asked.length, 1)
  await rest(exchanges(2), working)
  assert.equal(asked.length, 1, "dropped while the first write is in flight")
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(asked.length, 2)
  assert.match(asked[1]!, /reply 2/)
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(storage.getSession(SLUG)?.status, "Status 2")
})

test("a new reply moves the conversation even when the fold came back SHORTER than the last read", async () => {
  const { asked, rest } = harness()
  await rest(exchanges(6))
  assert.equal(asked.length, 1)
  // A compaction folds the history away: fewer messages than were read last time, one of them new.
  await rest([user("", { boundary: "compaction" }), user("ask 7"), agent("reply 7")])
  assert.equal(asked.length, 2)
  assert.match(asked[1]!, /reply 7/)
})

test("a write that came back empty is retried at the next rest", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-status-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-09-24T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: 0, title: "Opening ask", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  const answers = [undefined, "Landed the fix"]
  let calls = 0
  const periodic = createPeriodicStatus({
    storage,
    writeStatus: async () => answers[calls++],
    readMessages: () => exchanges(1),
    onStatus: () => {},
  })
  for (let i = 0; i < 2; i++) {
    periodic.onTurnDone(storage.getSession(SLUG)!)
    await new Promise((r) => setImmediate(r))
  }
  assert.equal(calls, 2)
  assert.equal(storage.getSession(SLUG)?.status, "Landed the fix")
})
