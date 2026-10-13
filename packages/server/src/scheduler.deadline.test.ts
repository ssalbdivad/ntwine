import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createScheduler, enqueueDeadlineNoticeWake } from "./scheduler.ts"
import type { SessionTelemetry, Tailer, TurnState } from "./tailer.ts"

// THE THREAD'S TIME LIMIT (ARCHITECTURE.md § Time limits, scheduler SOURCE 15). What must hold:
//  · check-ins at half-time, 80%, the final lead and the deadline — each ONCE per generation, across
//    passes and a restart, and only the LATEST due stage when several have passed;
//  · delivered MID-TURN, like a Goal heartbeat;
//  · a thread resting on a handoff (done, a question, a park on the human) is not woken;
//  · moving the deadline is a new generation: the stages start over against the new budget;
//  · every wake's clock line carries the time left;
//  · the Goal holds past the deadline, and comes back when the human extends it;
//  · negative control: a thread with no deadline gets nothing.

const M = 60_000
const START = Date.parse("2026-10-06T12:00:00.000Z")
const BUDGET = 40 * M // half at +20m, converge at +32m, final at +35m (5m lead), over at +40m

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: new Date(START).toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow
}

function tele(turn: TurnState, over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: new Date(START).toISOString(), ...over }
}

function harness(opts: { wakeQuietWindowMs?: number } = { wakeQuietWindowMs: 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-deadline-sched-"))
  const dbPath = join(dir, "ui.db")
  let storage: Storage = createStorage(dbPath, "p")
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId: string; at: number }[] = []
  const clock = { ms: START }
  const tailer: Tailer = {
    get: (slug) => teleMap.get(slug), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const make = () => createScheduler({
    storage, tailer, now: () => clock.ms,
    resume: (slug, message, deliveryId) => { resumes.push({ slug, message, deliveryId, at: clock.ms }) },
    fetchPr: async () => undefined, fetchGithubReview: async () => [], log: () => {},
    wakeQuietWindowMs: opts.wakeQuietWindowMs,
  })
  return {
    get storage() { return storage },
    tele: teleMap, resumes, clock, make,
    restart() { storage.close(); storage = createStorage(dbPath, "p"); return make() },
    cleanup() { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const checkIns = <R extends { message: string }>(resumes: R[]) => resumes.filter((r) => /⏰/.test(r.message))
const setDeadline = (storage: Storage, slug: string, atMs: number, setAtMs: number, setBy: "human" | "worker" = "human") =>
  storage.setDeadline(slug, { deadlineAt: new Date(atMs).toISOString(), setAt: new Date(setAtMs).toISOString(), setBy })

test("each stage reaches a busy worker MID-TURN, once, across passes and a restart", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    setDeadline(h.storage, "t", START + BUDGET, START)
    h.tele.set("t", tele("in-flight"))
    let s = h.make()

    h.clock.ms = START + 19 * M
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 0, "before half-time: nothing")

    h.clock.ms = START + 20 * M + 5_000
    await s.tick()
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 1, "half-time, delivered into the running turn, once")
    assert.match(checkIns(h.resumes)[0]!.message, /half your time is gone — 20m left/)
    assert.match(checkIns(h.resumes)[0]!.message, /commit to an approach now/)
    assert.match(checkIns(h.resumes)[0]!.message, /· 20m left\.$/, "the clock line carries the time left")
    assert.equal(h.storage.getSession("t")!.deadline_stage, "half", "the ledger is durable")
    await s.stop()

    h.clock.ms += M
    s = h.restart()
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 1, "a restart does not repeat a stage")

    h.clock.ms = START + 32 * M
    await s.tick()
    h.clock.ms = START + 35 * M
    await s.tick()
    h.clock.ms = START + 40 * M
    await s.tick()
    h.clock.ms = START + 55 * M
    await s.tick()
    const got = checkIns(h.resumes).map((r) => r.message)
    assert.equal(got.length, 4, "half, converge, final, over — and no second nag after over")
    assert.match(got[1]!, /Start nothing new/)
    assert.match(got[2]!, /Hand off at your next stop/)
    assert.match(got[3]!, /Your time is up/)
    assert.match(got[3]!, /Only the user can extend this deadline/)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a short budget's stages are not held by the quiet window the previous check-in opened", async () => {
  // Caught live (4m deadline, 2026-10-06): half reached the worker, and its delivery opened the
  // 5m quiet window, which held converge, final and over until each was superseded unsent.
  const h = harness({}) // the production window
  try {
    h.storage.upsertSession(row("t"))
    setDeadline(h.storage, "t", START + 4 * M, START)
    h.tele.set("t", tele("in-flight"))
    const s = h.make()
    for (const at of [2 * M + 1_000, 3.2 * M + 1_000, 3.5 * M + 1_000, 4 * M + 1_000, 5 * M]) {
      h.clock.ms = START + at
      await s.tick()
      await s.tick()
    }
    const got = checkIns(h.resumes)
    assert.deepEqual(got.map((r) => /half your time|Start nothing new|Hand off at your next stop|Your time is up/.exec(r.message)?.[0]), [
      "half your time", "Start nothing new", "Hand off at your next stop", "Your time is up",
    ])
    assert.deepEqual(got.map((r) => r.at - START), [2 * M + 1_000, 3.2 * M + 1_000, 3.5 * M + 1_000, 4 * M + 1_000], "each on its own tick")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a server down across two stages sends only the latest", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    setDeadline(h.storage, "t", START + BUDGET, START)
    h.tele.set("t", tele("in-flight"))
    const s = h.make()
    h.clock.ms = START + 33 * M // past half AND converge
    await s.tick()
    const got = checkIns(h.resumes)
    assert.equal(got.length, 1)
    assert.match(got[0]!.message, /Start nothing new/, "converge, not half")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a quiet park is woken; a thread resting on a handoff is not", async () => {
  const h = harness()
  try {
    for (const slug of ["parked", "done", "asked"]) {
      h.storage.upsertSession(row(slug))
      setDeadline(h.storage, slug, START + BUDGET, START)
    }
    h.tele.set("parked", tele("idle", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "agent", value: "a1" }, { kind: "for", value: "30m" }, { kind: "status", value: "working" }] } as SessionTelemetry["lastFence"] }))
    h.tele.set("done", tele("idle", { lastFence: { kind: "done", body: "", hints: [] } as SessionTelemetry["lastFence"] }))
    h.tele.set("asked", tele("idle", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "status", value: "needs_input" }, { kind: "for", value: "1h" }] } as SessionTelemetry["lastFence"] }))
    const s = h.make()
    h.clock.ms = START + 21 * M
    await s.tick()
    assert.deepEqual(checkIns(h.resumes).map((r) => r.slug), ["parked"])
    assert.equal(h.storage.getSession("done")!.deadline_stage ?? null, null, "a skipped stage is not spent")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("moving the deadline is a new generation: the stages start over against the new budget", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    setDeadline(h.storage, "t", START + BUDGET, START)
    h.tele.set("t", tele("in-flight"))
    const s = h.make()
    h.clock.ms = START + 33 * M
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 1)
    // The human extends at +33m to +73m: a 40m budget from now, half-time at +53m.
    setDeadline(h.storage, "t", START + 73 * M, START + 33 * M)
    h.clock.ms = START + 41 * M
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 1, "the old deadline's `over` is gone with its generation")
    h.clock.ms = START + 53 * M + 1_000
    await s.tick()
    assert.equal(checkIns(h.resumes).length, 2)
    assert.match(checkIns(h.resumes)[1]!.message, /half your time is gone — 20m left/)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("negative control: no deadline, no check-ins and no time on the clock line", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele("in-flight"))
    // A one-off timer, so SOME ntwine wake goes out and its clock line can be read.
    h.storage.armThreadTimer({ id: "tmr_x", slug: "t", prompt: "check the build", fireAtMs: START + 30 * M, createdAtMs: START })
    const s = h.make()
    for (const at of [20, 32, 35, 40, 60]) {
      h.clock.ms = START + at * M
      await s.tick()
    }
    assert.equal(checkIns(h.resumes).length, 0)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the Goal holds past the deadline, and comes back when the human extends it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setRecurringPromptBySlug("t", {
      prompt: "keep going", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: 5 * M, armedAt: new Date(START).toISOString(),
    })
    setDeadline(h.storage, "t", START + 10 * M, START)
    h.tele.set("t", tele("in-flight"))
    const s = h.make()
    const goals = () => h.resumes.filter((r) => r.message.includes("keep going"))
    h.clock.ms = START + 5 * M + 1_000
    await s.tick()
    assert.equal(goals().length, 1, "control: before the deadline the heartbeat fires")
    h.clock.ms = START + 10 * M + 1_000
    await s.tick()
    h.clock.ms = START + 16 * M
    await s.tick()
    assert.equal(goals().length, 1, "past the deadline the Goal is held")
    setDeadline(h.storage, "t", START + 60 * M, START + 16 * M)
    h.clock.ms = START + 16 * M + 1_000
    await s.tick()
    assert.equal(goals().length, 2, "extended: the Goal is back, armed as it was")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the human's notice joins a running turn, and a later change supersedes an earlier one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele("in-flight"))
    const s = h.make()
    setDeadline(h.storage, "t", START + 60 * M, START)
    const first = h.storage.getSession("t")!.deadline_set_at!
    enqueueDeadlineNoticeWake(h.storage, { slug: "t", sessionId: "sid-t", setAt: first, message: "⏱ notice one", nowMs: START })
    setDeadline(h.storage, "t", START + 90 * M, START + 1_000)
    const second = h.storage.getSession("t")!.deadline_set_at!
    enqueueDeadlineNoticeWake(h.storage, { slug: "t", sessionId: "sid-t", setAt: second, message: "⏱ notice two", nowMs: START + 1_000 })
    h.clock.ms = START + 2_000
    await s.tick()
    const notices = h.resumes.filter((r) => r.message.includes("notice"))
    assert.deepEqual(notices.map((r) => r.message.split("\n")[0]), ["⏱ notice two"], "mid-turn, and only the standing change")
    assert.match(notices[0]!.message, /\n\n⏱ \d{4}-\d\d-\d\d \d\d:\d\d — you last spoke [^\n]+ ago · 1h 30m left\.$/, "with the clock line, re-read at send")
    await s.stop()
  } finally {
    h.cleanup()
  }
})
