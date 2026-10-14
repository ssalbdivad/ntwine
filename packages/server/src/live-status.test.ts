import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import type { ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import { createLiveStatus, liveActivity, parseLiveStatus } from "./live-status.ts"
import { createStorage, type SessionRow } from "./storage.ts"

const SLUG = "busy-thread"
const SESSION = "11111111-1111-4111-8111-111111111111"
const T0 = Date.parse("2026-09-29T10:00:00.000Z")

const user = (text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ role: "user", text, tools: [], parts: [], ...extra }) as TranscriptMessage
const agent = (text: string, tools: Array<{ name: string; desc?: string; detail?: string }> = []): TranscriptMessage =>
  ({ role: "assistant", text, tools, parts: [] }) as unknown as TranscriptMessage

function harness(answers: string[]) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-live-status-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-09-29T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: 0, title: "Resolver", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  let clock = T0
  const asked: ClaudeOneShotRequest[] = []
  const messages: TranscriptMessage[] = [user("fix the resolver cache"), agent("Looking.", [{ name: "Grep", detail: "cache" }])]
  const live = createLiveStatus({
    storage,
    complete: async (request) => { asked.push(request); return answers.shift() ?? "SAME" },
    readMessages: () => messages,
    onStatus: () => {},
    now: () => clock,
    intervalMs: 120_000,
    firstMs: 20_000,
  })
  const row = () => storage.getSession(SLUG)!
  const activity = async (atMs: number) => {
    clock = T0 + atMs
    live.onActivity(row())
    await new Promise((r) => setImmediate(r))
  }
  const rest = (atMs: number) => {
    clock = T0 + atMs
    return live.onTurnDone(row())
  }
  return { storage, asked, activity, rest, row }
}

test("a working status waits into the turn, then checks at most once per interval", async () => {
  const h = harness(["Tracing the cache miss in resolver.ts"])
  await h.activity(0)
  await h.activity(10_000)
  assert.equal(h.asked.length, 0, "a turn that rests within seconds never pays for a check")
  await h.activity(20_000)
  assert.equal(h.asked.length, 1)
  assert.equal(h.row().status, "Tracing the cache miss in resolver.ts")
  assert.equal(h.row().status_at, new Date(T0 + 20_000).toISOString())
  await h.activity(60_000)
  assert.equal(h.asked.length, 1, "no second check inside the interval")
  await h.activity(140_000)
  assert.equal(h.asked.length, 2)
  assert.match(h.asked[1]!.prompt, /currently shown: "Tracing the cache miss in resolver\.ts"/)
})

test("SAME keeps the task's clock; a shift restarts it", async () => {
  const h = harness(["Tracing the cache miss", "SAME", "Writing the regression test"])
  await h.activity(0)
  await h.activity(20_000)
  await h.activity(140_000)
  assert.equal(h.row().status, "Tracing the cache miss")
  assert.equal(h.row().status_at, new Date(T0 + 20_000).toISOString())
  await h.activity(260_000)
  assert.equal(h.row().status, "Writing the regression test")
  assert.equal(h.row().status_at, new Date(T0 + 260_000).toISOString())
})

test("the turn reports whether it wore a working status, and a short-gap resume gets its clock back", async () => {
  const h = harness(["Tracing the cache miss", "SAME"])
  await h.activity(0)
  assert.equal(h.rest(5_000), false, "a turn too short to check hands nothing to the rest writer")
  await h.activity(10_000)
  await h.activity(30_000)
  assert.equal(h.rest(40_000), true)
  // The rest writer replaces the text…
  h.storage.setStatus(SLUG, SESSION, "Found the miss, asked about the fix", new Date(T0 + 41_000).toISOString())
  // …and a wake a minute later resumes the same task.
  await h.activity(100_000)
  await h.activity(120_000)
  assert.equal(h.row().status, "Tracing the cache miss")
  assert.equal(h.row().status_at, new Date(T0 + 30_000).toISOString())
})

test("a turn that starts long after the last rest does not inherit the old task", async () => {
  const h = harness(["Tracing the cache miss", "Reviewing the new PR"])
  await h.activity(0)
  await h.activity(20_000)
  h.rest(30_000)
  await h.activity(3_600_000)
  await h.activity(3_620_000)
  assert.match(h.asked[1]!.prompt, /No status is shown yet/)
  assert.equal(h.row().status, "Reviewing the new PR")
})

test("an answer that lands after the turn rested is dropped", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-live-status-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-09-29T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: 0, title: "Resolver", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  let release!: (value: string) => void
  const live = createLiveStatus({
    storage,
    complete: () => new Promise((resolve) => { release = resolve }),
    readMessages: () => [user("go"), agent("ok", [{ name: "Bash", desc: "Running tests" }])],
    onStatus: () => {},
    firstMs: 0,
  })
  live.onActivity(storage.getSession(SLUG)!)
  // The read is awaited before the model is asked, so let it reach the model call first.
  await new Promise((r) => setImmediate(r))
  live.onTurnDone(storage.getSession(SLUG)!)
  release("Running the test suite")
  await new Promise((r) => setImmediate(r))
  assert.equal(storage.getSession(SLUG)?.status ?? null, null)
})

test("the activity window starts at the operator's latest message and keeps wakes", () => {
  const read = liveActivity([
    user("old ask"),
    agent("old reply", [{ name: "Read", detail: "old.ts" }]),
    user("fix the rail"),
    agent("On it.", [{ name: "Bash", desc: "Running the rail tests", detail: "nub --test" }]),
    user("CI went red", { wake: true }),
    agent("", [{ name: "Edit", detail: "Sidebar.tsx" }]),
  ])!
  assert.equal(read.request, "fix the rail")
  assert.equal(read.activity, [
    "Agent: On it.",
    "→ Bash: Running the rail tests",
    "[ntwine] CI went red",
    "→ Edit: Sidebar.tsx",
  ].join("\n"))
})

test("an answer parses as SAME, a cleaned status, or nothing", () => {
  assert.deepEqual(parseLiveStatus("SAME"), { same: true })
  assert.deepEqual(parseLiveStatus("same."), { same: true })
  assert.deepEqual(parseLiveStatus("\"Running the full suite.\""), { status: "Running the full suite" })
  assert.equal(parseLiveStatus("  "), undefined)
  assert.equal(parseLiveStatus("The agent has retired the project board"), undefined, "narration is not a status")
  assert.equal(parseLiveStatus("Reviewing the agent's activity"), undefined)
})

test("the first check fires on its own when the turn writes nothing more", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-live-status-")), "ui.db"), "p")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-09-29T00:00:00Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title_locked: 0, title: "Resolver", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  const live = createLiveStatus({
    storage,
    complete: async () => "Running the long migration",
    readMessages: () => [user("migrate"), agent("", [{ name: "Bash", desc: "Running the migration" }])],
    onStatus: () => {},
    firstMs: 30,
  })
  live.onActivity(storage.getSession(SLUG)!)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(storage.getSession(SLUG)?.status, "Running the long migration")
})
