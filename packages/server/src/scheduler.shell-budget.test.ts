import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createScheduler } from "./scheduler.ts"
import { WAKE_QUIET_WINDOW_MS } from "./wake-store.ts"
import type { BgShellView, SessionTelemetry, Tailer, TurnState } from "./tailer.ts"
import {
  declaredShellBudgetMs,
  liveShellBudget,
  resolveShellBudget,
  SHELL_BUDGET_GRACE_MS,
  SHELL_BUDGET_MAX_MS,
  SHELL_BUDGET_MIN_MS,
  shellStopNotice,
  type ShellStopReason,
} from "./shell-budget.ts"

// THE BACKGROUND-SHELL RUNTIME BUDGET (shell-budget.ts, scheduler SOURCE 13).
//
// Maintainer 2026-09-29: "background shells running for 16 hours makes no sense" — and then, the same
// day, that a universal clock is wrong: a budget exists only when one was DECLARED. What must hold:
//  · the budget a launch carries — its Bash `timeout`, clamped; NONE declared ⇒ none at all;
//  · `extend_shell` can give a budget to a shell launched without one;
//  · an armed `watch` holds the deadline to its own expiry (it extends; it never creates a budget);
//  · ONE warning per deadline, however many passes and however many restarts see it overrun;
//  · the kill GRACE after that warning, through the injected stop (the operator's × in production);
//  · an extension moving the deadline defers both, and supersedes a warning still in the outbox;
//  · a shell frizz cannot stop is warned and never killed — and told so.

const HOUR = 60 * 60_000
const START = Date.parse("2026-09-29T09:00:00.000Z")

test("a launch's budget is only what it DECLARED: its `timeout`, clamped to [1m, 24h]; none (or garbage) is NO budget", () => {
  assert.equal(declaredShellBudgetMs(undefined), undefined)
  assert.equal(declaredShellBudgetMs("7200000"), undefined, "a string is not a declared budget")
  assert.equal(declaredShellBudgetMs(0), undefined)
  assert.equal(declaredShellBudgetMs(-5), undefined)
  assert.equal(declaredShellBudgetMs(2 * HOUR), 2 * HOUR)
  assert.equal(declaredShellBudgetMs(48 * HOUR), SHELL_BUDGET_MAX_MS, "clamped to a day")
  assert.equal(declaredShellBudgetMs(5_000), SHELL_BUDGET_MIN_MS, "a budget of seconds is a mis-sized timeout, floored")
  const base = { id: "toolu_sh", label: "npx vite", startedAt: new Date(START).toISOString() }
  assert.equal(resolveShellBudget(base, undefined), undefined, "undeclared: no deadline at all, not a default one")
  assert.equal(resolveShellBudget({ ...base, budgetMs: HOUR }, undefined)?.deadlineMs, START + HOUR, "control: a declared one resolves")
  assert.equal(resolveShellBudget({ ...base, budgetMs: HOUR, monitor: true }, undefined), undefined, "a Monitor never has one")
})

test("the kill notice says WHY: the operator's words stay put, a budget stop names the budget", () => {
  assert.match(shellStopNotice("Watching CI"), /^\[frizz\] The operator stopped your background command "Watching CI" from the Frizz dashboard/)
  const budget = shellStopNotice("npx vite", { kind: "budget", ranMs: HOUR + 10 * 60_000, budgetMs: HOUR })
  assert.match(budget, /^\[frizz\] Frizz stopped your background command "npx vite" after 1h 10m: it ran past its 1h budget/)
  assert.match(budget, /frizzctl extend-shell/)
  assert.match(budget, /do not wait on it/)
})

// ---- the scheduler pass ----

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-09-29T08:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow
}

function shell(over: Partial<BgShellView> = {}): BgShellView {
  return { label: "npx vite --port 5231", startedAt: new Date(START).toISOString(), state: "running", id: "toolu_sh", taskId: "bvite1", stoppable: true, budgetMs: HOUR, ...over }
}

function tele(shells: BgShellView[], turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: shells, pendingQuestion: false }
}

function harness(opts: {
  stoppable?: boolean
  stopThrows?: boolean
  quietWindowMs?: number
  /** The transport refuses every wake until this instant — a delivery that lags its enqueue. */
  resumeFailsUntilMs?: number
  delivery?: { retryBaseMs?: number; retryMaxMs?: number; deliveryLeaseMs?: number; maxDeliveryAttempts?: number }
  wakeRuntimeState?: () => "alive" | "dead" | "unknown"
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-budget-"))
  const dbPath = join(dir, "ui.db")
  let storage: Storage = createStorage(dbPath, "p")
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId: string; at: number }[] = []
  const stops: { slug: string; id: string; reason: ShellStopReason; notify: boolean; at: number }[] = []
  const clock = { ms: START }
  const tailer: Tailer = {
    get: (slug) => teleMap.get(slug), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const make = () => createScheduler({
    storage,
    tailer,
    resume: (slug, message, deliveryId) => {
      if (opts.resumeFailsUntilMs !== undefined && clock.ms < opts.resumeFailsUntilMs) throw new Error("socket down")
      resumes.push({ slug, message, deliveryId, at: clock.ms })
    },
    now: () => clock.ms,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    log: () => {},
    wakeQuietWindowMs: opts.quietWindowMs ?? 0,
    ...opts.delivery,
    ...(opts.wakeRuntimeState ? { wakeRuntimeState: opts.wakeRuntimeState } : {}),
    shellControl: {
      stoppable: () => opts.stoppable !== false,
      stop: async (slug, id, reason, stopOpts) => {
        if (opts.stopThrows) throw new Error("daemon went away")
        stops.push({ slug, id, reason, notify: stopOpts.notify, at: clock.ms })
        // The real stop retires the row from tracking; so does this.
        const t = teleMap.get(slug)
        if (t) teleMap.set(slug, { ...t, bgShells: t.bgShells.filter((s) => s.id !== id) })
        return { stopped: true, note: null }
      },
    },
  })
  return {
    get storage() { return storage },
    tele: teleMap, resumes, stops, clock, make,
    /** A server restart: the same database file, a fresh connection and a fresh scheduler. */
    restart() {
      storage.close()
      storage = createStorage(dbPath, "p")
      return make()
    },
    cleanup() { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const warnings = <R extends { message: string }>(resumes: R[]): R[] => resumes.filter((r) => /past its .* budget/.test(r.message))

test("inside its budget a shell is left alone; past it, ONE warning — across passes and a restart", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setBackend("t", "claude")
    h.tele.set("t", tele([shell()]))
    let s = h.make()
    h.clock.ms = START + HOUR - 60_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 0, "a minute short of the budget: nothing")

    h.clock.ms = START + HOUR + 30_000
    await s.tick()
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "past it: exactly one warning over two passes")
    assert.equal(h.storage.getShellBudget("t", "toolu_sh")?.warned_deadline, START + HOUR, "the warning is durable on the budget row, not only in the outbox")
    const w = warnings(h.resumes)[0]!
    assert.match(w.message, /Your background shell `bvite1` \(npx vite --port 5231\) has been running 1h, past its 1h budget/)
    assert.match(w.message, /Frizz stops it in 10m unless you extend it/)
    assert.match(w.message, /`frizzctl extend-shell bvite1 --for <duration>`/)
    assert.match(w.message, /TaskStop/)
    assert.match(w.message, /⏱ /, "frizz-authored, so it carries the wall clock")
    await s.stop()

    // A RESTART — the outbox row is still there, and more to the point the budget row records the
    // warning, so a fresh scheduler must not warn again for the same deadline.
    h.clock.ms += 60_000
    s = h.restart()
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "a restart does not re-warn the same deadline")
    assert.deepEqual(h.stops, [], "and nothing is stopped inside the grace")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the warning goes out MID-TURN — its grace clock is already running", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()], "in-flight"))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "delivered while the worker is busy")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("unanswered, the shell is stopped GRACE after the warning — through the shared stop, with the reason", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    const warnedAt = START + HOUR + 5_000
    h.clock.ms = warnedAt
    await s.tick()
    h.clock.ms = warnedAt + SHELL_BUDGET_GRACE_MS - 1_000
    await s.tick()
    assert.equal(h.stops.length, 0, "one second short of the grace: still running")
    h.clock.ms = warnedAt + SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    assert.equal(h.stops[0]!.id, "toolu_sh", "addressed by the row id the × uses")
    assert.equal(h.stops[0]!.notify, true, "the worker is told")
    assert.deepEqual(h.stops[0]!.reason, { kind: "budget", ranMs: HOUR + 5_000 + SHELL_BUDGET_GRACE_MS, budgetMs: HOUR })
    assert.notEqual(h.storage.getShellBudget("t", "toolu_sh")?.stopped_at, null, "recorded")
    await s.tick()
    assert.equal(h.stops.length, 1, "a stopped shell is not stopped twice")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the grace counts from the WARNING: a server down across the deadline still gives the worker its window", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    // First pass the scheduler ever runs is three hours past the deadline.
    h.clock.ms = START + 4 * HOUR
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /has been running 4h, past its 1h budget/)
    assert.deepEqual(h.stops, [], "not killed on first sight, however late")
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

// ---- THE GRACE RUNS FROM DELIVERY (2026-09-29) ----
//
// Observed on a real stack: two shells whose warnings fell due 8s apart were DELIVERED ~5m apart — the
// second was held by the thread's quiet window, opened by the first — while the kill clock ran from the
// instant each warning was QUEUED. The second worker got ~5 of its 10 minutes. These drive the real
// scheduler + outbox on a 10s tick, the production cadence, and read the grace off what the worker
// actually received.

/** Tick the scheduler every 10s from `from` to `to`, as production does. */
async function run(h: { clock: { ms: number } }, s: { tick(): Promise<void> }, from: number, to: number): Promise<void> {
  for (h.clock.ms = from; h.clock.ms <= to; h.clock.ms += 10_000) await s.tick()
}

test("two shells due 8s apart under the REAL quiet window: both warnings land promptly, each gets its full grace from delivery", async () => {
  const h = harness({ quietWindowMs: WAKE_QUIET_WINDOW_MS })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([
      shell({ id: "toolu_a", taskId: "ba", label: "sleep 3600", budgetMs: HOUR }),
      shell({ id: "toolu_b", taskId: "bb", label: "sleep 3601", budgetMs: HOUR + 8_000 }),
    ]))
    const s = h.make()
    await run(h, s, START + HOUR + 5_000, START + HOUR + 40 * 60_000)
    for (const [taskId, id, deadline] of [["ba", "toolu_a", START + HOUR], ["bb", "toolu_b", START + HOUR + 8_000]] as const) {
      const warned = h.resumes.find((r) => r.message.includes(`\`${taskId}\``) && /past its/.test(r.message))
      const stop = h.stops.find((x) => x.id === id)
      assert.ok(warned, `${taskId} was warned`)
      assert.ok(stop, `${taskId} was stopped`)
      assert.ok(warned.at - deadline <= 20_000, `${taskId}'s warning lands within two ticks of its deadline, not a quiet window later (${(warned.at - deadline) / 1000}s)`)
      assert.ok(stop.at - warned.at >= SHELL_BUDGET_GRACE_MS, `${taskId} gets its full grace after the warning REACHED it (${(stop.at - warned.at) / 1000}s)`)
      assert.ok(stop.at - warned.at <= SHELL_BUDGET_GRACE_MS + 10_000, `…and is stopped within a tick of it running out`)
    }
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a warning DELIVERED late still gets its full grace — the clock runs from delivery, not from the queue", async () => {
  const deadline = START + HOUR
  // The transport is down for the first six minutes past the deadline; the wake is retried every tick.
  const h = harness({ resumeFailsUntilMs: deadline + 6 * 60_000, delivery: { retryBaseMs: 1, retryMaxMs: 1, deliveryLeaseMs: 1, maxDeliveryAttempts: 1_000 } })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    await run(h, s, deadline + 5_000, deadline + 30 * 60_000)
    const warned = warnings(h.resumes)
    assert.equal(warned.length, 1)
    assert.ok(warned[0]!.at >= deadline + 6 * 60_000, "control: the delivery really did lag")
    assert.equal(h.stops.length, 1)
    assert.ok(h.stops[0]!.at - warned[0]!.at >= SHELL_BUDGET_GRACE_MS, `full grace after delivery (${(h.stops[0]!.at - warned[0]!.at) / 1000}s)`)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("SENT to a live runtime counts as delivered: the grace runs from the send, not from the later confirmation", async () => {
  const h = harness({ wakeRuntimeState: () => "alive", resumeFailsUntilMs: START + HOUR + 3 * 60_000, delivery: { retryBaseMs: 1, retryMaxMs: 1, deliveryLeaseMs: 1, maxDeliveryAttempts: 1_000 } })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    await run(h, s, START + HOUR + 5_000, START + HOUR + 30 * 60_000)
    const warned = warnings(h.resumes)
    assert.equal(warned.length, 1)
    assert.equal(h.stops.length, 1)
    const grace = h.stops[0]!.at - warned[0]!.at
    assert.ok(grace >= SHELL_BUDGET_GRACE_MS && grace <= SHELL_BUDGET_GRACE_MS + 10_000, `grace from the send (${grace / 1000}s)`)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a warning that can NEVER be delivered does not keep the shell alive: the clock falls back to when it was queued", async () => {
  const h = harness({ resumeFailsUntilMs: Number.POSITIVE_INFINITY, delivery: { retryBaseMs: 1, retryMaxMs: 1, deliveryLeaseMs: 1, maxDeliveryAttempts: 3 } })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    await run(h, s, START + HOUR + 5_000, START + HOUR + 30 * 60_000)
    assert.equal(warnings(h.resumes).length, 0, "control: nothing ever reached the worker")
    assert.equal(h.stops.length, 1, "the exhausted warning does not hold the kill forever")
    assert.ok(h.stops[0]!.at - (START + HOUR + 5_000) <= SHELL_BUDGET_GRACE_MS + 10_000)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("an extension defers the warning, supersedes one already queued, and re-arms at the new deadline", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()], "in-flight"))
    // AHEAD OF TIME: extended before the first deadline, so nothing happens at it.
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: START + 3 * HOUR, nowMs: START + 30 * 60_000 })
    const s = h.make()
    h.clock.ms = START + 2 * HOUR
    await s.tick()
    assert.equal(warnings(h.resumes).length, 0, "the extended deadline governs, not the launch budget")

    // Past the extended deadline: warned, and then extended IN THE MOMENT before the grace runs out.
    h.clock.ms = START + 3 * HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /past its 3h budget/, "the budget read back is the one in force")
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: h.clock.ms + 2 * HOUR, nowMs: h.clock.ms })
    h.clock.ms += SHELL_BUDGET_GRACE_MS + 1_000
    await s.tick()
    assert.deepEqual(h.stops, [], "an extension inside the grace cancels the kill")
    assert.equal(warnings(h.resumes).length, 1)

    // …and the NEW deadline gets its own warning when it, too, runs out.
    h.clock.ms = START + 5 * HOUR + 2_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 2, "a moved deadline is warned afresh")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a warning still QUEUED when the worker extends is superseded, not delivered", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    // A resume that throws keeps the wake in the outbox for retry.
    let fail = true
    const resumes: string[] = []
    const s = createScheduler({
      storage: h.storage,
      tailer: { get: (slug) => h.tele.get(slug), foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} },
      resume: (_slug, message) => {
        if (fail) throw new Error("socket down")
        resumes.push(message)
      },
      now: () => h.clock.ms,
      log: () => {},
      wakeQuietWindowMs: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      deliveryLeaseMs: 1,
    })
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(resumes.length, 0, "the first attempt failed and is held for retry")
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: h.clock.ms + HOUR, nowMs: h.clock.ms })
    fail = false
    h.clock.ms += 60_000
    await s.tick()
    await s.tick()
    assert.deepEqual(resumes.filter((m) => /past its/.test(m)), [], "the extension made the queued warning untrue")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a shell frizz cannot stop is WARNED, told frizz cannot stop it, and never killed", async () => {
  const h = harness({ stoppable: false })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell({ stoppable: undefined })]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /Frizz cannot stop this one for you/)
    assert.doesNotMatch(warnings(h.resumes)[0]!.message, /Frizz stops it in/)
    h.clock.ms += 5 * SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(h.stops, [])
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a Monitor, a stale shell, and a shell under budget are all left alone", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([
      shell({ id: "toolu_mon", taskId: "bmon", budgetMs: undefined, monitor: true, label: "tail -f log" }),
      shell({ id: "toolu_gone", taskId: "bgone", state: "stale" }),
      shell({ id: "toolu_long", taskId: "blong", budgetMs: 8 * HOUR }),
    ]))
    const s = h.make()
    h.clock.ms = START + 5 * HOUR
    await s.tick()
    h.clock.ms += 2 * SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [])
    assert.deepEqual(h.stops, [])
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("an ARCHIVED thread is not woken, but its forgotten shell still ends on the same clock — silently", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [], "nobody is reading an archived thread")
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    assert.equal(h.stops[0]!.notify, false, "and no turn is spent announcing the kill")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a failed stop is retried, spaced — not every tick", async () => {
  const h = harness({ stopThrows: true })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    let attempts = 0
    const s = createScheduler({
      storage: h.storage,
      tailer: { get: (slug) => h.tele.get(slug), foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} },
      resume: () => {},
      now: () => h.clock.ms,
      log: () => {},
      wakeQuietWindowMs: 0,
      shellControl: { stoppable: () => true, stop: async () => { attempts++; throw new Error("daemon went away") } },
    })
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    await s.tick()
    assert.equal(attempts, 1, "one attempt, then a pause")
    h.clock.ms += 5 * 60_000
    await s.tick()
    assert.equal(attempts, 2, "and a retry once the pause is over")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a budget row recorded for a DIFFERENT shell under the same id is ignored (and replaced on write)", () => {
  const h = harness()
  try {
    const older = "2026-09-28T09:00:00.000Z"
    h.storage.extendShellBudget({ slug: "t", shellId: "proc-1", startedAt: older, deadlineAtMs: START + 20 * HOUR, nowMs: START })
    h.storage.markShellBudgetWarned({ slug: "t", shellId: "proc-1", startedAt: older, deadlineMs: START + 20 * HOUR, nowMs: START })
    const live = { id: "proc-1", label: "sleep 900", startedAt: new Date(START).toISOString(), budgetMs: HOUR }
    const budget = liveShellBudget(h.storage, "t", live)
    assert.equal(budget?.deadlineMs, START + HOUR, "the earlier shell's extension does not carry over")
    assert.equal(budget?.record, undefined)
    h.storage.markShellBudgetWarned({ slug: "t", shellId: "proc-1", startedAt: live.startedAt, deadlineMs: START + HOUR, nowMs: START + HOUR })
    const row = h.storage.getShellBudget("t", "proc-1")!
    assert.equal(row.started_at, live.startedAt)
    assert.equal(row.deadline_at, null, "the old shell's extension was reset, not inherited")
    assert.equal(row.warned_deadline, START + HOUR)
  } finally {
    h.cleanup()
  }
})

// ---- OPT-IN (2026-09-29): no declaration, no clock ----

test("an UNDECLARED shell is never warned or stopped, however long it runs — beside a declared one that is", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([
      shell({ id: "toolu_dev", taskId: "bdev", label: "npx vite --port 5231", budgetMs: undefined }),
      // THE NEGATIVE CONTROL: the same thread, the same clock, one declared hour. If the pass could not
      // fire at all, the undeclared shell's silence would prove nothing.
      shell({ id: "toolu_poll", taskId: "bpoll", label: "until gh run view …; do sleep 30; done", budgetMs: HOUR }),
    ]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.deepEqual(warnings(h.resumes).map((r) => /`(b\w+)`/.exec(r.message)?.[1]), ["bpoll"], "only the declared shell is warned")
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(h.stops.map((x) => x.id), ["toolu_poll"], "…and only it is stopped")
    // Days later, the dev server is still simply running.
    h.clock.ms = START + 72 * HOUR
    await s.tick()
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.deepEqual(h.stops.map((x) => x.id), ["toolu_poll"])
    assert.equal(h.storage.getShellBudget("t", "toolu_dev"), undefined, "no bookkeeping is ever written for it")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a CODEX exec (no launch knob, no budget) is left alone until extend_shell gives it one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setBackend("t", "codex")
    const exec = shell({ id: "proc-7", taskId: undefined, label: "pnpm dev", budgetMs: undefined })
    h.tele.set("t", tele([exec]))
    const s = h.make()
    h.clock.ms = START + 30 * HOUR
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [], "unbudgeted")
    // The worker gives it two hours from now.
    h.storage.extendShellBudget({ slug: "t", shellId: "proc-7", startedAt: exec.startedAt, deadlineAtMs: h.clock.ms + 2 * HOUR, nowMs: h.clock.ms })
    h.clock.ms += 2 * HOUR - 1_000
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [], "a second short of the new deadline")
    h.clock.ms += 2_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /`proc-7` \(pnpm dev\) has been running 1d 8h, past its 1d 8h budget/)
    assert.match(warnings(h.resumes)[0]!.message, /end its process yourself/)
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(h.stops.map((x) => x.id), ["proc-7"], "the budget it was given is enforced like a declared one")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("an armed WATCH holds a declared shell to the watch's expiry — the 20h watch no longer dies at 17h", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([
      shell({ id: "toolu_ci", taskId: "bci", label: "arktype CI poller", budgetMs: HOUR }),
      // NEGATIVE CONTROL: the same declared hour, no watch on it.
      shell({ id: "toolu_other", taskId: "bother", label: "vitest --watch", budgetMs: HOUR }),
    ]))
    h.storage.armThreadWatch({ id: "wch_ci", slug: "t", kind: "shell", target: "bci", createdAtMs: START, expiresAtMs: START + 20 * HOUR })
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.deepEqual(warnings(h.resumes).map((r) => /`(b\w+)`/.exec(r.message)?.[1]), ["bother"], "the unwatched shell is warned at its hour; the watched one is not")
    h.clock.ms = START + 17 * HOUR
    await s.tick()
    assert.deepEqual(h.stops.map((x) => x.id), ["toolu_other"], "at 17h only the unwatched shell has been stopped")
    assert.equal(liveShellBudget(h.storage, "t", shell({ id: "toolu_ci", taskId: "bci", label: "arktype CI poller" }))?.watchUntilMs, START + 20 * HOUR)
    // The watch expires at 20h — evalOwnWatches settles it and wakes the worker — and the shell, still
    // past the budget it declared, gets the ordinary warning at that instant, and its grace.
    h.clock.ms = START + 20 * HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 2)
    assert.match(warnings(h.resumes)[1]!.message, /`bci` \(arktype CI poller\) has been running 20h, past its 1h budget/)
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(h.stops.map((x) => x.id), ["toolu_other", "toolu_ci"])
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("arming a watch AFTER the warning cancels the pending kill, as extend_shell would", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    h.storage.armThreadWatch({ id: "wch_v", slug: "t", kind: "shell", target: "npx vite --port 5231", createdAtMs: h.clock.ms, expiresAtMs: h.clock.ms + 6 * HOUR })
    h.clock.ms += SHELL_BUDGET_GRACE_MS + 1_000
    await s.tick()
    assert.deepEqual(h.stops, [], "held by the watch (named by its label)")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a watch never CREATES a budget, and a watch on another shell or an agent holds nothing", () => {
  const started = new Date(START).toISOString()
  const watches = [
    { kind: "shell", target: "bci", expiresAtMs: START + 20 * HOUR },
    { kind: "agent", target: "bvite1", expiresAtMs: START + 20 * HOUR },
  ]
  assert.equal(resolveShellBudget({ id: "toolu_ci", taskId: "bci", label: "ci", startedAt: started }, undefined, watches), undefined, "unbudgeted stays unbudgeted under a watch")
  const vite = { id: "toolu_sh", taskId: "bvite1", label: "npx vite", startedAt: started, budgetMs: HOUR }
  assert.equal(resolveShellBudget(vite, undefined, watches)?.deadlineMs, START + HOUR, "an agent-kind watch on the same string and a watch on another shell do not hold it")
  assert.equal(resolveShellBudget(vite, undefined, [{ kind: "shell", target: "toolu_sh", expiresAtMs: START + 30 * 60_000 }])?.deadlineMs, START + HOUR, "a watch that ends BEFORE the budget does not shorten it")
  assert.equal(resolveShellBudget(vite, undefined, [{ kind: "shell", target: "toolu_sh", expiresAtMs: START + 5 * HOUR }])?.deadlineMs, START + 5 * HOUR, "control: a longer one on its launch id holds it")
})
