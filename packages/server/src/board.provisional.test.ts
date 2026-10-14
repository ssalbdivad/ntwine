import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentParked, sectionOf, type ThreadView } from "@ntwine/shared"
import { boardTelemetry, createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { Project } from "./project.ts"
import { createTailer, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createTailStateCache } from "./tail-cache.ts"

// A ROW THE TAILER HAS NOT PRIMED YET MUST NOT CHANGE BAND (2026-09-30). After every restart the tailer
// primes a bounded number of rows per tick, and an unprimed headless row used to derive `running`: a thread
// parked on a PR jumped from Snoozed into Active, spinning, then dropped back once primed — and the operator,
// clicking where it had been, messaged the wrong thread. These tests run the REAL tailer and the REAL board
// across a restart: what the board shows for the row while unprimed must be what it showed before the
// restart and what it shows once primed, never `running`.

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `${slug}-session`, thread_name: `ntwine-${slug}`, spawned_at: minutesAgo(60), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const line = (record: object) => JSON.stringify(record) + "\n"
const user = (at: string, text: string) => line({ type: "user", timestamp: at, promptSource: "typed", message: { content: [{ type: "text", text }] } })
const assistant = (at: string, text: string) =>
  line({ type: "assistant", timestamp: at, message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: [{ type: "text", text }] } })

// The band the sidebar files a row under, and everything that decides it.
const band = (t: ThreadView | undefined) => t && ({
  section: sectionOf(t), runtime: t.runtime, needsYou: t.needsYou ?? false, fence: t.lastFence?.kind, rest: t.lastAssistantAt,
})

interface Fixture {
  dir: string
  project: Project
  storage: Storage
  tailer(opts?: { cache?: boolean; live?: "running" | "settled" }): Tailer
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-provisional-"))
  const project: Project = { dir, id: "project-provisional", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  return {
    dir, project, storage,
    tailer: ({ cache = true, live }: { cache?: boolean; live?: "running" | "settled" } = {}) => createTailer({
      project, storage, bus: new Bus(), onChange: () => {},
      sessionLogDir: dir,
      // The detached daemon is alive across the restart, as a broker daemon is.
      brokerDaemonAlive: () => true,
      paneDead: () => false,
      ...(cache ? {} : { tailCache: null }),
      // The broker bridge's own reading of the daemon's turn, as the ingest reports it after reconnecting.
      ...(live ? { runtimeLiveness: () => ({ turn: live, at: Date.now(), events: 1 }) } : {}),
    }),
  }
}

// A thread that rested on a registered PR: its last message is an ```awaiting fence naming the PR, and the
// PR watcher is armed. That is the worker's own park, at rest in Working (Snoozed until 2026-10-14, when
// that band became the human's) — once the human has SEEN the reply:
// a park answering their prompt stays Ready until they have (board.replyUnseen). The fence answers
// `needs_input: false`: the row is spawned after NEEDS_INPUT_REQUIRED_AT, where an unanswered fence queues.
function seedParkedOnPr(f: Fixture, slug: string): void {
  f.storage.upsertSession(row(slug, { backend: "claude", seen_at: minutesAgo(25) }))
  f.storage.setClaudeRuntime(slug, "broker")
  f.storage.armPrWatch({ id: `prw-${slug}`, slug, owner: "acme", repo: "app", number: 7, createdAtMs: Date.now() - 30 * 60_000, expiresAtMs: Date.now() + 24 * 3_600_000 })
  writeFileSync(join(f.dir, `${slug}-session.jsonl`),
    user(minutesAgo(40), "Open the PR and wait for review.") +
    assistant(minutesAgo(30), "Opened acme/app#7.\n\n```awaiting\nprs: [acme/app#7]\nneeds_input: false\nfor: 2h\n```"))
}

test("an unprimed row parked on a PR reads the band it had before the restart, never running — and the same once primed", async () => {
  const f = fixture()
  seedParkedOnPr(f, "parked")
  const notified: string[] = []
  try {
    // Boot 1: primed, and the tail cache flushed on the way down.
    const before = f.tailer()
    before.start()
    const board1 = createBoard(f.project, f.storage, new Bus(), before, "boot-1")
    const primedThread = board1.refresh().threads.find((t) => t.id === "parked")
    const primedView = band(primedThread)
    await board1.stop()
    before.stop()
    assert.equal(primedThread && agentParked(primedThread), true, "the fixture really is a worker's park")
    assert.equal(primedView?.runtime, "turn-idle")

    // Boot 2: the board assembles before the tailer has reached the row.
    const after = f.tailer()
    const bus = new Bus()
    bus.subscribe((event) => { if (event.type === "notify") notified.push(event.slug) })
    const board2 = createBoard(f.project, f.storage, bus, after, "boot-2")
    assert.equal(after.get("parked"), undefined, "the tailer has not primed it")
    const unprimed = after.provisional?.("parked")
    assert.equal(unprimed?.primed, false, "a provisional reading is never evidence")
    assert.equal(unprimed?.lastFence?.kind, "awaiting", "the fence comes back from the cache")
    assert.deepEqual(band(board2.refresh().threads.find((t) => t.id === "parked")), primedView, "unprimed: same band as before the restart")

    // The prime lands.
    after.tick()
    assert.equal(after.get("parked")?.primed, true)
    assert.equal(after.provisional?.("parked"), undefined, "a primed row has no provisional reading")
    assert.deepEqual(band(board2.refresh().threads.find((t) => t.id === "parked")), primedView, "primed: same band again")
    assert.deepEqual(notified, [], "nothing notified across the restart")
    await board2.stop()
    after.stop()
  } finally {
    f.storage.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("a thread whose daemon is genuinely MID-TURN across the restart reads running before its prime, too", async () => {
  // A broker daemon outlives the server, and a child's return can start a turn while nobody watches. The
  // cache says parked; the bridge says a turn is running. The live reading wins, exactly as it does for a
  // primed row (resolveRuntimeTurn), so the stand-in never hides real motion.
  const f = fixture()
  seedParkedOnPr(f, "parked")
  try {
    const before = f.tailer()
    before.start()
    before.stop()
    const after = f.tailer({ live: "running" })
    assert.equal(after.provisional?.("parked")?.turn, "in-flight")
    const board = createBoard(f.project, f.storage, new Bus(), after, "mid-turn")
    assert.equal(board.refresh().threads.find((t) => t.id === "parked")?.runtime, "running")
    await board.stop()
    after.stop()
  } finally {
    f.storage.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("NEGATIVE CONTROL: with no stand-in at all, the same unprimed row reads running in Active — the reported flicker", async () => {
  const f = fixture()
  seedParkedOnPr(f, "parked")
  try {
    const before = f.tailer({ cache: false })
    before.start()
    before.stop()
    // The pre-fix board: no provisional reading, and a row whose durable rest is unknown.
    // Written from a second connection: the session cache only re-reads for a write it can see — a row
    // change through this project's scope, or another connection's commit (data_version), from the next
    // turn. A raw statement on the cache's own connection is neither, and no longer rides along on the
    // snooze sweep's no-op UPDATE (project-scope.ts).
    const other = createStorage(join(f.dir, "ui.db"), "p")
    other.db.prepare("UPDATE session SET rested_at = NULL").run()
    other.close()
    await Promise.resolve()
    const bare = f.tailer({ cache: false })
    const board = createBoard(f.project, f.storage, new Bus(), { ...bare, provisional: undefined }, "control")
    const view = band(board.refresh().threads.find((t) => t.id === "parked"))
    assert.equal(view?.runtime, "running")
    assert.equal(view?.section, "active")
    await board.stop()
  } finally {
    f.storage.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("an entry an OLDER fold schema wrote still serves the provisional reading, but never resumes a fold", async () => {
  const f = fixture()
  seedParkedOnPr(f, "parked")
  try {
    const before = f.tailer()
    before.start()
    before.stop()
    // The dev server restarts because server source changed — often the fold's own modules.
    f.storage.db.prepare("UPDATE tail_state SET fold_schema = 'an-older-build'").run()
    assert.equal(createTailStateCache(f.storage.scope).load().size, 0, "the fold refuses it")
    const after = f.tailer()
    assert.equal(after.provisional?.("parked")?.lastFence?.kind, "awaiting", "the provisional reading does not")
    after.tick()
    assert.equal(after.get("parked")?.lastFence?.kind, "awaiting", "and the real prime lands from a full fold")
    after.stop()
  } finally {
    f.storage.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("a cache miss falls back to the durable rest: a rested row with nothing in flight reads at rest, a never-rested one keeps running", () => {
  const unprimed: SessionTelemetry = { turn: "in-flight", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, primed: false }
  const none = () => undefined
  const rested = boardTelemetry({ rested_at: minutesAgo(5), delivery_ledger: null }, unprimed, none)
  assert.equal(rested?.turn, "idle")
  assert.equal(rested?.lastAssistantAt !== undefined, true, "the durable rest time stands in for the folded one")
  assert.equal(boardTelemetry({ rested_at: minutesAgo(5), delivery_ledger: null }, undefined, none)?.turn, "idle", "no state at all, same")
  // A follow-up on its way: the thread is about to move, and an at-rest reading would be the wrong guess.
  assert.equal(boardTelemetry({ rested_at: minutesAgo(5), delivery_ledger: "[{}]" }, unprimed, none), unprimed)
  // Never rested: its first turn, which is most likely what it is still doing.
  assert.equal(boardTelemetry({ rested_at: null, delivery_ledger: null }, undefined, none), undefined)
  // A vouched reading is never replaced, and the provisional one is never consulted for it.
  const primed: SessionTelemetry = { ...unprimed, primed: true }
  assert.equal(boardTelemetry({ rested_at: minutesAgo(5), delivery_ledger: null }, primed, () => assert.fail("asked")), primed)
})

test("an unprimed reading cannot put a thread INTO the queue, only keep one there: no card appears and leaves during a prime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-provisional-queue-"))
  const project: Project = { dir, id: "project-provisional-queue", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  // A bare rest: queued, by its own reading. `stale` has no stamp — it was outside the queue before the
  // restart — and its provisional reading (an older account) says queued anyway.
  const bareRest: SessionTelemetry = { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: minutesAgo(20) }
  let primed = false
  const tailer = {
    get: () => (primed ? bareRest : undefined),
    provisional: () => (primed ? undefined : { ...bareRest, primed: false }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  storage.upsertSession(row("stale"))
  storage.setClaudeRuntime("stale", "broker")
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "queue")
  try {
    for (let i = 0; i < 3; i++) {
      const t = board.refresh().threads.find((x) => x.id === "stale")
      assert.equal(t?.needsYou, false, "no card off a reading nobody vouched for")
      assert.equal(t?.runtime, "turn-idle", "and not spinning either")
    }
    assert.equal(storage.getSession("stale")?.queued_at, null, "and no stamp written")
    primed = true
    assert.equal(board.refresh().threads.find((x) => x.id === "stale")?.needsYou, true, "the real reading decides, once")
    assert.deepEqual(notified, ["stale"], "and notifies as the real arrival it is")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
