// THE GOAL'S LIMITS (2026-09-29): a run cap and a time bound that turn a Goal into a bounded loop.
// These drive the REAL scheduler over REAL storage; only the tailer is stubbed, because it is the input
// being varied (a new rest = a new `lastAssistantAt`), and `now` is injected so the clock is exact.
//
// What must hold, each with its control:
//   - a cap of N disarms after EXACTLY N deliveries — and an uncapped Goal keeps going past N;
//   - a time bound disarms at its deadline, not before;
//   - a new generation (text edited) starts the count again, and so does re-arming a stopped Goal;
//   - the "your loop stopped" wake is sent ONCE, however many ticks follow.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type RecurringWrite, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { resolveRecurringPrompt } from "./board.ts"

const T0 = Date.parse("2026-09-29T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function harness(write: Partial<RecurringWrite> = {}, opts: { busyAfterBump?: boolean; liveRuntimeAnswers?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-goal-limits-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "looping"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: iso(T0),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // The built-in sign-off reminder fires on every fenceless rest independently of the Goal; silenced so
  // every delivery counted here is the Goal's or the Goal's end.
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, {
    prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null,
    armedAt: iso(T0), ...write,
  })
  let nowMs = T0 + 1_000
  const tele: Partial<SessionTelemetry> = {
    turn: "idle", lastActivityAt: iso(T0), lastAssistantAt: iso(T0),
    subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
  }
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    now: () => nowMs,
    tailer: { get: () => ({ ...tele }) } as unknown as Tailer,
    // PRODUCTION'S SHAPE for a Claude worker: the runtime is live, so a send is left as "sent" for
    // reconcileOutbox to settle — and the worker ANSWERS the bump before that happens (below).
    ...(opts.liveRuntimeAnswers ? { wakeRuntimeState: () => "alive" as const } : {}),
    resume: async (_slug, message) => {
      delivered.push(message)
      if (opts.liveRuntimeAnswers && message.startsWith("keep going")) {
        // A one-word reply lands in seconds: a NEW rest, which is what makes the queued bump read as
        // superseded rather than delivered when the reconcile gets to it.
        nowMs += 2_000
        tele.lastUserAt = iso(nowMs - 1_000)
        tele.lastAssistantAt = iso(nowMs)
        tele.lastActivityAt = iso(nowMs)
      }
      // The realistic reading of a delivered bump: the agent starts a turn on it.
      if (opts.busyAfterBump && message.startsWith("keep going")) tele.turn = "in-flight"
    },
    log: () => {},
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
  })
  const deliveredWhere = (like: string) => (storage.db
    .prepare("SELECT COUNT(*) AS n FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE ? AND state = 'delivered'")
    .get(slug, like) as { n: number }).n
  return {
    s, storage, slug, delivered, tele,
    row: () => storage.getSession(slug)!,
    view: () => resolveRecurringPrompt(storage.getSession(slug)!),
    /** The agent takes a turn and rests again: a genuinely new rest instant, spoken after the bump. */
    rest: (atMs: number) => {
      nowMs = atMs
      tele.turn = "idle"
      tele.lastAssistantAt = iso(atMs)
      tele.lastActivityAt = iso(atMs)
      tele.lastUserAt = iso(atMs - 500)
    },
    setNow: (ms: number) => { nowMs = ms },
    goalBumps: () => deliveredWhere("stophook:%"),
    beats: () => deliveredWhere("heartbeat:%"),
    goalEnds: () => deliveredWhere("goalend:%"),
    /** The outbox's own record of when a trigger's delivery crossed to the worker. */
    sentAtOf: (like: string) => (storage.db
      .prepare("SELECT sent_at FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE ? ORDER BY sent_at DESC LIMIT 1")
      .get(slug, like) as { sent_at: number | null } | undefined)?.sent_at ?? null,
    goalEndsQueued: () => (storage.db
      .prepare("SELECT COUNT(*) AS n FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'goalend:%'")
      .get(slug) as { n: number }).n,
    close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** Rest `n` times, one minute apart starting at `fromMs`, ticking after each. */
async function restTimes(h: ReturnType<typeof harness>, n: number, fromMs: number) {
  for (let i = 0; i < n; i++) {
    h.rest(fromMs + i * 60_000)
    await h.s.tick()
  }
}

test("a cap of 3 disarms after EXACTLY 3 deliveries, keeps the text, and says why", async () => {
  const h = harness({ maxRuns: 3 })
  try {
    await restTimes(h, 6, T0 + 60_000)
    assert.equal(h.goalBumps(), 3, "three runs, not two and not four")
    const row = h.row()
    assert.equal(row.recurring_runs, 3)
    assert.equal(row.recurring_on_rest, 0, "the Goal disarmed itself")
    assert.equal(row.recurring_prompt, "keep going", "the text is kept, as a switch-off keeps it")
    assert.equal(row.recurring_stop_reason, "runs")
    const view = h.view()!
    assert.equal(view.runs, 3)
    assert.equal(view.maxRuns, 3)
    assert.equal(view.stopped?.reason, "runs")
    assert.equal(view.stopHook, false)
  } finally { h.close() }
})

// THE BUG A REAL STACK FOUND (2026-09-29). Counted only where a delivery SETTLED, five stop-hook runs to
// a real Claude worker counted zero: the send to a live runtime is settled later, and by then the
// worker's answer has made the bump read as superseded, which settles nothing. The count has to be
// taken at the send. This reproduces that production shape exactly and fails without it.
test("a live runtime that answers each bump before it settles still counts every run, and stops at 3", async () => {
  const h = harness({ maxRuns: 3 }, { liveRuntimeAnswers: true })
  try {
    for (let i = 0; i < 12; i++) {
      await h.s.tick()
      h.setNow(T0 + (i + 2) * 60_000) // a minute passes: the reconcile runs, the next bump comes due
    }
    const sent = h.delivered.filter((m) => m.startsWith("keep going")).length
    assert.equal(sent, 3, "three bumps crossed to the worker, and no fourth")
    assert.equal(h.row().recurring_runs, 3, "every one of them counted, though none settled as delivered")
    assert.equal(h.row().recurring_stop_reason, "runs")
    assert.equal(h.goalEndsQueued(), 1)
  } finally { h.close() }
})

// THE PANEL'S "LAST SENT" READING has the same blindness the run count had, and needs the same cure.
// Each trigger's stamp (`recurring_{rest,schedule,compact}_fired_at`) used to be written only when the
// delivery SETTLED — and a stop-hook bump to a live Claude worker never settles as delivered: the
// worker's answer is a new rest, `deliveryContext` reads the bump superseded, and the superseded
// branch stamps nothing. So "Last sent at rest" never appeared on a Claude thread at all, while a
// Codex thread (runtime "unknown", acknowledged on return) showed it. The heartbeat and the
// post-compaction bump are not rest-bound, so they did settle — but a minute late, at the confirmation
// grace, which also slid every beat's next due time by that minute. The stamp is now the SEND.
test("a live runtime that answers the rest bump still stamps 'last sent at rest', at the send", async () => {
  const h = harness({}, { liveRuntimeAnswers: true })
  try {
    await h.s.tick()
    const sentAt = h.sentAtOf("stophook:%")
    assert.ok(sentAt !== null, "the bump crossed to a live runtime and was left as sent")
    assert.equal(h.row().recurring_rest_fired_at, iso(sentAt), "stamped when it was sent, not when it settled")
    // The reconcile after the grace reads it superseded (the worker already answered) and stamps
    // nothing; the worker's answer was a new rest, so the next bump goes out and the reading follows
    // THAT send.
    h.setNow(T0 + 5 * 60_000)
    await h.s.tick()
    assert.equal(h.delivered.filter((m) => m.startsWith("keep going")).length, 2)
    const second = h.sentAtOf("stophook:%")
    assert.ok(second !== null && second > sentAt)
    assert.equal(h.row().recurring_rest_fired_at, iso(second))
    assert.ok(h.view()!.lastRestFiredAt, "and the panel's view carries it")
  } finally { h.close() }
})

test("a live runtime's heartbeat and post-compaction stamps read the send, not the confirmation a grace later", async () => {
  const h = harness({ stopHook: false, heartbeat: true, postCompaction: true, intervalMs: 60 * 60_000 }, { liveRuntimeAnswers: true })
  try {
    h.tele.lastCompactionAt = iso(T0 + 30_000)
    h.setNow(T0 + 60 * 60_000 + 1_000)
    await h.s.tick()
    const beatSent = h.sentAtOf("heartbeat:%")
    const compactSent = h.sentAtOf("compact:%")
    assert.ok(beatSent !== null && compactSent !== null, "both went out to the live runtime")
    assert.equal(h.row().recurring_schedule_fired_at, iso(beatSent))
    assert.equal(h.row().recurring_compact_fired_at, iso(compactSent))
    // Past the confirmation grace the live runtime confirms both; that must not move either stamp to
    // the confirmation instant — the next beat is due an interval after the beat was SENT.
    h.setNow(T0 + 60 * 60_000 + 5 * 60_000)
    await h.s.tick()
    assert.equal(h.row().recurring_schedule_fired_at, iso(beatSent), "the confirmation does not re-stamp the beat")
    assert.equal(h.row().recurring_compact_fired_at, iso(compactSent))
    assert.equal(h.beats() + (h.storage.db.prepare("SELECT COUNT(*) AS n FROM wake_delivery WHERE fence_id LIKE 'compact:%' AND state = 'delivered'").get() as { n: number }).n, 2, "and both did settle as delivered")
  } finally { h.close() }
})

// The control: a runtime that cannot tell sent from delivered (Codex, ACP — "unknown") is acknowledged
// on return, and was always stamped there. It still is, on the injected clock.
test("control: an acknowledged delivery (no live-runtime signal) stamps 'last sent at rest' as before", async () => {
  const h = harness()
  try {
    h.rest(T0 + 60_000)
    await h.s.tick()
    assert.equal(h.goalBumps(), 1)
    assert.equal(h.row().recurring_rest_fired_at, iso(T0 + 60_000))
  } finally { h.close() }
})

test("negative control: the same rests with NO cap keep delivering", async () => {
  const h = harness()
  try {
    await restTimes(h, 6, T0 + 60_000)
    assert.equal(h.goalBumps(), 6, "an uncapped Goal is as unbounded as it always was")
    assert.equal(h.row().recurring_runs, 6, "…and it still counts")
    assert.equal(h.row().recurring_on_rest, 1)
    assert.equal(h.goalEndsQueued(), 0, "nothing ended, so nothing says it did")
  } finally { h.close() }
})

test("the limit wake is sent ONCE, whatever follows, and names the limit and the count", async () => {
  const h = harness({ maxRuns: 2 })
  try {
    await restTimes(h, 8, T0 + 60_000)
    assert.equal(h.goalBumps(), 2)
    assert.equal(h.goalEnds(), 1, "one delivered end-of-loop wake")
    assert.equal(h.goalEndsQueued(), 1, "and only one ever queued")
    const end = h.delivered.filter((m) => /run limit/.test(m))
    assert.equal(end.length, 1)
    assert.match(end[0], /2 of 2 runs delivered/)
    assert.match(end[0], /do not re-arm it yourself/)
  } finally { h.close() }
})

test("the time bound disarms at its deadline, not before", async () => {
  const h = harness({ forMs: 60 * 60_000 })
  try {
    assert.equal(h.row().recurring_until_at, iso(T0 + 60 * 60_000), "the deadline is an hour from arming")
    assert.equal(h.view()!.endsAt, iso(T0 + 60 * 60_000))
    h.rest(T0 + 30 * 60_000)
    await h.s.tick()
    assert.equal(h.goalBumps(), 1, "half way through the bound it still runs")
    h.rest(T0 + 59 * 60_000)
    await h.s.tick()
    assert.equal(h.goalBumps(), 2, "a minute before the deadline it still runs")
    h.rest(T0 + 61 * 60_000)
    await h.s.tick()
    assert.equal(h.goalBumps(), 2, "past the deadline the rest is not bumped")
    assert.equal(h.row().recurring_stop_reason, "time")
    assert.equal(h.row().recurring_on_rest, 0)
    await h.s.tick()
    assert.equal(h.goalEnds(), 1)
    const end = h.delivered.find((m) => /time limit/.test(m))!
    assert.match(end, /time limit \(1h\) and stopped after 2 runs/)
  } finally { h.close() }
})

test("editing a bound keeps its start; adding one starts it; a flip moves nothing", () => {
  const h = harness({ forMs: 2 * 60 * 60_000 })
  try {
    const base = { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null }
    h.storage.setRecurringPromptBySlug(h.slug, { ...base, armedAt: iso(T0 + 30 * 60_000), forMs: 90 * 60_000 })
    assert.equal(h.row().recurring_until_at, iso(T0 + 90 * 60_000), "90m from the loop's start, not from the edit")
    h.storage.setRecurringPromptBySlug(h.slug, { ...base, heartbeat: true, intervalMs: null, armedAt: iso(T0 + 40 * 60_000) })
    assert.equal(h.row().recurring_until_at, iso(T0 + 90 * 60_000), "a trigger flip keeps the deadline")
    h.storage.setRecurringPromptBySlug(h.slug, { ...base, armedAt: iso(T0 + 45 * 60_000), forMs: null })
    h.storage.setRecurringPromptBySlug(h.slug, { ...base, armedAt: iso(T0 + 50 * 60_000), forMs: 60 * 60_000 })
    assert.equal(h.row().recurring_until_at, iso(T0 + 110 * 60_000), "a bound added later starts when it is added")
  } finally { h.close() }
})

test("the time bound fires with NO event to hang on — a thread that never rests still stops", async () => {
  const h = harness({ forMs: 60 * 60_000 })
  try {
    // Busy the whole time: the rest trigger never fires, so only the tick's own check can end it.
    h.setNow(T0 + 2 * 60 * 60_000)
    await h.s.tick()
    assert.equal(h.row().recurring_stop_reason, "time")
    assert.equal(h.row().recurring_runs, 0)
  } finally { h.close() }
})

test("the cap counts heartbeat deliveries too: beat 2 of 2 is the last", async () => {
  const h = harness({ stopHook: false, heartbeat: true, intervalMs: 60 * 60_000, maxRuns: 2 })
  try {
    for (const hour of [1, 2, 3, 4]) {
      h.setNow(T0 + hour * 60 * 60_000 + 1_000)
      await h.s.tick()
      // The beat stamps its clock on the injected timeline, so the next one is due an hour after this.
      assert.equal(h.row().recurring_schedule_fired_at, hour <= 2 ? iso(T0 + hour * 60 * 60_000 + 1_000) : iso(T0 + 2 * 60 * 60_000 + 1_000))
    }
    assert.equal(h.beats(), 2)
    assert.equal(h.row().recurring_on_schedule, 0)
    assert.equal(h.row().recurring_interval_ms, 60 * 60_000, "the cadence is kept for re-arming")
  } finally { h.close() }
})

// Two triggers due on ONE tick: a beat and a rest. The outbox merges a thread's ready wakes into one
// frame, so without reserving the cap at enqueue both would go out together as run 1 and run 2 of 1.
test("a cap of 1 across two triggers due on the same tick sends exactly one", async () => {
  const h = harness({ stopHook: true, heartbeat: true, intervalMs: 60 * 60_000, maxRuns: 1 })
  try {
    h.rest(T0 + 60 * 60_000 + 1_000)
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.goalBumps() + h.beats(), 1, "one delivery, whichever trigger won")
    assert.equal(h.row().recurring_runs, 1)
    assert.equal(h.row().recurring_stop_reason, "runs")
  } finally { h.close() }
})

test("a NEW GENERATION (text edited) resets the count; a bare trigger flip does not", async () => {
  const h = harness({ maxRuns: 3 })
  try {
    await restTimes(h, 2, T0 + 60_000)
    assert.equal(h.row().recurring_runs, 2)
    // Flip the trigger off and on with the same words: same generation, same count, same cap.
    const same = { prompt: "keep going", heartbeat: false, postCompaction: false, intervalMs: null }
    h.storage.setRecurringPromptBySlug(h.slug, { ...same, stopHook: false, armedAt: iso(T0 + 10 * 60_000) })
    h.storage.setRecurringPromptBySlug(h.slug, { ...same, stopHook: true, armedAt: iso(T0 + 11 * 60_000) })
    assert.equal(h.row().recurring_runs, 2, "a flip is not a re-arming")
    assert.equal(h.row().recurring_max_runs, 3, "an omitted limit is KEPT, not cleared")
    // New words: a new generation, counted from zero.
    h.storage.setRecurringPromptBySlug(h.slug, { ...same, prompt: "now do the other thing", stopHook: true, armedAt: iso(T0 + 12 * 60_000) })
    assert.equal(h.row().recurring_runs, 0, "new words start a new count")
    assert.equal(h.row().recurring_max_runs, 3)
    await restTimes(h, 5, T0 + 13 * 60_000)
    assert.equal(h.goalBumps(), 2 + 3, "the new generation got its full three")
    assert.equal(h.row().recurring_stop_reason, "runs")
  } finally { h.close() }
})

test("re-arming a STOPPED Goal starts a fresh generation, so it does not re-hit the limit at once", async () => {
  const h = harness({ maxRuns: 1 })
  try {
    await restTimes(h, 2, T0 + 60_000)
    const stopped = h.row()
    assert.equal(stopped.recurring_stop_reason, "runs")
    // A write that leaves every trigger off (editing the cap in the footer) keeps the stop marker.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "keep going", stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 20 * 60_000), maxRuns: 2 })
    assert.equal(h.row().recurring_stop_reason, "runs", "still quiet, still saying why")
    assert.equal(h.row().recurring_armed_at, stopped.recurring_armed_at)
    // Switch it back on with the SAME words: a new generation all the same.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 21 * 60_000) })
    const rearmed = h.row()
    assert.notEqual(rearmed.recurring_armed_at, stopped.recurring_armed_at)
    assert.equal(rearmed.recurring_runs, 0)
    assert.equal(rearmed.recurring_stop_reason, null)
    assert.equal(rearmed.recurring_max_runs, 2)
    await restTimes(h, 4, T0 + 22 * 60_000)
    assert.equal(h.goalBumps(), 1 + 2)
    assert.equal(h.goalEnds(), 2, "one end per generation — two loops, two ends")
  } finally { h.close() }
})

test("a re-arm that lands before the end wake supersedes it — news that stopped being true", async () => {
  const h = harness({ maxRuns: 1 }, { busyAfterBump: true })
  try {
    h.rest(T0 + 60_000)
    // Busy after the delivery: the end wake waits for rest, which is when the human re-arms.
    await h.s.tick()
    assert.equal(h.goalBumps(), 1)
    assert.equal(h.row().recurring_stop_reason, "runs")
    assert.equal(h.goalEndsQueued(), 1, "queued, held while the last run is being worked")
    assert.equal(h.goalEnds(), 0)
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 90_000), maxRuns: 5 })
    h.rest(T0 + 120_000)
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.goalEnds(), 0, "the loop is running again, so 'it stopped' is not delivered")
  } finally { h.close() }
})

test("lowering the cap under the count already reached stops it on the next tick", async () => {
  const h = harness()
  try {
    await restTimes(h, 4, T0 + 60_000)
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 10 * 60_000), maxRuns: 2 })
    assert.equal(h.row().recurring_runs, 4, "a cap change is not a new generation")
    h.setNow(T0 + 11 * 60_000)
    await h.s.tick()
    assert.equal(h.row().recurring_stop_reason, "runs")
    assert.equal(h.goalBumps(), 4)
  } finally { h.close() }
})

test("storage: one delivery counts once, and a stale generation counts nothing", () => {
  const h = harness()
  try {
    const armedAt = h.row().recurring_armed_at!
    assert.equal(h.storage.countRecurringRun(h.slug, armedAt, "stophook:a"), 1)
    assert.equal(h.storage.countRecurringRun(h.slug, armedAt, "stophook:a"), 1, "a second settle of the same delivery is a no-op")
    assert.equal(h.storage.countRecurringRun(h.slug, armedAt, "stophook:b"), 2)
    assert.equal(h.storage.countRecurringRun(h.slug, "2020-01-01T00:00:00.000Z", "stophook:c"), undefined)
    assert.equal(h.row().recurring_runs, 2)
  } finally { h.close() }
})

test("storage: a cleared Goal keeps no limits, and a refused guarded write changes nothing", () => {
  const h = harness({ maxRuns: 3, forMs: 3_600_000 })
  try {
    const before = h.row()
    assert.equal(
      h.storage.setRecurringPromptIfCurrent(h.slug, "other-session", 0, { prompt: "hijack", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 5_000), maxRuns: null }),
      false,
    )
    assert.deepEqual(h.row(), before, "the transaction rolled back whole")
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: iso(T0 + 6_000) })
    const cleared = h.row()
    assert.equal(cleared.recurring_max_runs, null)
    assert.equal(cleared.recurring_for_ms, null)
    assert.equal(cleared.recurring_until_at, null)
    assert.equal(cleared.recurring_runs, 0)
  } finally { h.close() }
})
