import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@frizz/shared"
import { createPeriodicRetitler, operatorMessages, recentConversation } from "./periodic-retitle.ts"
import { createStorage, type SessionRow } from "./storage.ts"

const SLUG = "long-thread"
const SESSION = "11111111-1111-4111-8111-111111111111"

const user = (text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ role: "user", text, tools: [], parts: [], ...extra }) as TranscriptMessage
const agent = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] }) as TranscriptMessage

function harness(titleLocked = 0) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-retitle-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: "2026-09-24T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: titleLocked, title: "Opening ask", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  let messages: TranscriptMessage[] = []
  const asked: string[] = []
  const retitler = createPeriodicRetitler({
    storage,
    generateTitle: async ({ description }) => { asked.push(description); return `Title ${asked.length}` },
    readMessages: () => messages,
    onTitled: () => {},
  })
  const rest = async (next: TranscriptMessage[]) => {
    messages = next
    retitler.onTurnDone(storage.getSession(SLUG)!)
    await new Promise((r) => setImmediate(r))
  }
  return { storage, asked, rest }
}

function exchanges(n: number): TranscriptMessage[] {
  return Array.from({ length: n }, (_, i) => [user(`ask ${i + 1}`), agent(`reply ${i + 1}`)]).flat()
}

test("only the operator's own messages count — wakes, child reports, boundaries and queued bubbles do not", () => {
  const counted = operatorMessages([
    user("real"),
    user("scheduler steer", { wake: true }),
    user("child report", { peerFrom: "frizz:high" }),
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

test("retitles on every 5th operator message and writes an unlocked agent title", async () => {
  const { storage, asked, rest } = harness()
  await rest(exchanges(1)) // first sighting only records the count
  await rest(exchanges(4))
  assert.equal(asked.length, 0)
  await rest(exchanges(5))
  assert.equal(asked.length, 1)
  assert.equal(storage.getSession(SLUG)?.title, "Title 1")
  assert.equal(storage.getSession(SLUG)?.title_agent, 1)
  await rest([...exchanges(5), user("wake", { wake: true })]) // same window, nothing new
  await rest(exchanges(9))
  assert.equal(asked.length, 1)
  await rest(exchanges(10))
  assert.equal(asked.length, 2)
  assert.match(asked[1]!, /ask 6/)
  assert.doesNotMatch(asked[1]!, /ask 5\b/)
})

test("a human-named thread is never retitled", async () => {
  const { storage, asked, rest } = harness(1)
  await rest(exchanges(4))
  await rest(exchanges(5))
  assert.equal(asked.length, 0)
  assert.equal(storage.getSession(SLUG)?.title, "Opening ask")
})

test("a first sighting after a restart records the count instead of retitling at once", async () => {
  const { asked, rest } = harness()
  await rest(exchanges(12))
  assert.equal(asked.length, 0)
  await rest(exchanges(15))
  assert.equal(asked.length, 1)
})
