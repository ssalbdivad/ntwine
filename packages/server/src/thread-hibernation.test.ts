import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"
import {
  HIBERNATE_IDLE_MS,
  HIBERNATE_SWEEP_INTERVAL_MS,
  hibernateIdleMs,
  hibernateSweepIntervalMs,
  hibernationEnabled,
  hibernationVerdict,
  lastActivityMs,
  describeResidentDaemons,
  sweepHibernationOnce,
  type HibernationCandidate,
} from "./thread-hibernation.ts"

const NOW = Date.parse("2026-08-19T12:00:00.000Z")
const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60_000).toISOString()
const TEN_MINUTES_AGO = new Date(NOW - 10 * 60_000).toISOString()
const DAEMON_STARTED = NOW - 3 * 60 * 60_000

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-the-queue", session_id: "sess-1", backend: "claude", claude_runtime: "broker",
    state: "open", archived: 0, exited: 0, delivery_ledger: null,
    ...over,
  } as SessionRow
}

function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastActivityAt: TWO_HOURS_AGO,
    ...over,
  } as SessionTelemetry
}

function candidate(over: Partial<HibernationCandidate> = {}): HibernationCandidate {
  return {
    slug: "fix-the-queue", sessionId: "sess-1", row: row(), telemetry: tele(),
    pendingInteractions: 0, daemonStartedAtMs: DAEMON_STARTED,
    ...over,
  }
}

const decide = (over: Partial<HibernationCandidate> = {}, idleMs = HIBERNATE_IDLE_MS) =>
  hibernationVerdict(candidate(over), { nowMs: NOW, idleMs })

/** The only shape that reaches `true`. Everything below is a way of losing it. */
test("a broker thread resting past the threshold with nothing outstanding hibernates", () => {
  const verdict = decide()
  assert.equal(verdict.hibernate, true)
  assert.equal(verdict.hibernate && Math.round(verdict.idleMs / 60_000), 120)
})

test("60 minutes is the default threshold, and it is the prompt-cache TTL", () => {
  assert.equal(HIBERNATE_IDLE_MS, 60 * 60_000)
  // 59 minutes of rest still holds a cache a resume would pay to rebuild.
  const almost = { telemetry: tele({ lastActivityAt: new Date(NOW - 59 * 60_000).toISOString() }) }
  assert.deepEqual(decide(almost), { hibernate: false, blockedBy: "not-idle-long-enough" })
  const past = { telemetry: tele({ lastActivityAt: new Date(NOW - 61 * 60_000).toISOString() }) }
  assert.equal(decide(past).hibernate, true)
})

// EVERY unknown is a refusal. A thread wrongly left running costs 504 MB; a thread wrongly hibernated
// costs the maintainer's in-flight work, and the two are not comparable.
test("fails CLOSED on anything it cannot see", () => {
  // The 2026-08-06 shape: the tailer could not prime a 566 MB transcript, held no state for the busiest
  // thread on the machine, and a guard read that absence as "nothing running".
  assert.deepEqual(decide({ telemetry: undefined }), { hibernate: false, blockedBy: "no-telemetry" })
  // Nothing for `resume: true` to read back — hibernating this would strand it, not park it.
  assert.deepEqual(decide({ telemetry: tele({ noTranscript: true }) }), { hibernate: false, blockedBy: "no-transcript" })
  // A timestamp that will not parse must never read as "long ago".
  assert.deepEqual(
    decide({ telemetry: tele({ lastActivityAt: "not a date", lastAssistantAt: undefined, lastUserAt: undefined }) }),
    { hibernate: false, blockedBy: "no-activity-timestamp" },
  )
})

test("a turn in flight is never torn down", () => {
  assert.deepEqual(decide({ telemetry: tele({ turn: "in-flight" }) }), { hibernate: false, blockedBy: "turn-in-flight" })
})

// Each of these is a promise living inside the daemon. Retiring the process leaves it unanswerable.
test("a thread the daemon is holding open for a human is never torn down", () => {
  assert.deepEqual(decide({ telemetry: tele({ permPrompt: true }) }), { hibernate: false, blockedBy: "awaiting-a-human" })
  assert.deepEqual(
    decide({ telemetry: tele({ pendingAsk: { id: "ask-1", title: "pick one", kind: "select", questions: [] } as unknown as SessionTelemetry["pendingAsk"] }) }),
    { hibernate: false, blockedBy: "awaiting-a-human" },
  )
  assert.deepEqual(decide({ pendingInteractions: 1 }), { hibernate: false, blockedBy: "pending-approval" })
})

// WIDER than completionConfirmationHold's `running`-only filter, on purpose: that gate asks whether a
// HUMAN is about to lose something they can see, and a human who clicks through it has decided. This
// runs with nobody watching.
test("a sub-agent in ANY state blocks hibernation, including stale and rested", () => {
  for (const state of ["running", "stale", "rested"] as const) {
    assert.deepEqual(
      decide({ telemetry: tele({ subAgents: [{ label: "child", startedAt: TWO_HOURS_AGO, state, id: "t1" }] }) }),
      { hibernate: false, blockedBy: "sub-agents" },
      `a ${state} sub-agent must block`,
    )
  }
  // A DESCENDANT is surfaced for rendering and always sits under a direct child, so it is not read here.
  assert.equal(
    decide({ telemetry: tele({ subAgents: [{ label: "grandchild", startedAt: TWO_HOURS_AGO, state: "running", id: "t2", depth: 2 }] }) }).hibernate,
    true,
  )
})

test("a background shell blocks hibernation", () => {
  assert.deepEqual(
    decide({ telemetry: tele({ bgShells: [{ id: "s1", state: "running" }] as SessionTelemetry["bgShells"] }) }),
    { hibernate: false, blockedBy: "background-shells" },
  )
})

// THE COMMAND WATCH EXISTS FOR THIS CASE (2026-10-11). The same wait — "tell me when npm serves the
// version" — rested on two ways: a polling loop in a background shell pins the daemon (three threads idle
// 1h47m–21h held ~750 MB that way on the maintainer's machine), while a `frizzctl watch-command` rest has
// nothing of the thread's running, because the SERVER runs the check. The verdict reads no registry, so a
// rest on a command watch is an ordinary rest, and the wake that ends it cold-resumes the transcript.
test("a rest on a command watch hibernates where the same wait in a polling shell cannot", () => {
  const fence = (hints: { kind: "shell" | "command" | "status" | "for"; value: string }[]) =>
    ({ kind: "awaiting" as const, body: "", hints })
  const pollingShell = tele({
    bgShells: [{ id: "toolu_poll", taskId: "bpoll1", label: "until npm view frizz@0.13.12 version; do sleep 300; done", state: "running" }] as SessionTelemetry["bgShells"],
    lastFence: fence([{ kind: "shell", value: "bpoll1" }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }]),
  })
  assert.deepEqual(decide({ telemetry: pollingShell }), { hibernate: false, blockedBy: "background-shells" })
  const commandWatch = tele({
    lastFence: fence([{ kind: "command", value: "cmw_0123456789ab" }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }]),
  })
  assert.equal(decide({ telemetry: commandWatch }).hibernate, true)
})

// Text frizz accepted but has not watched land is sitting in the DAEMON'S queue. Killing the process
// throws it away, and the ledger row would go on claiming for an hour that the provider holds it.
test("an undelivered send blocks hibernation", () => {
  for (const state of ["pending", "enqueued", "unconfirmed"]) {
    const ledger = JSON.stringify([{ id: "d1", text: "carry on", at: TWO_HOURS_AGO, updatedAt: TWO_HOURS_AGO, state }])
    assert.deepEqual(
      decide({ row: row({ delivery_ledger: ledger }) }),
      { hibernate: false, blockedBy: "undelivered-input" },
      `a ${state} delivery must block`,
    )
  }
  // A cancelled tombstone is not an outstanding send.
  const cancelled = JSON.stringify([{ id: "d1", text: "carry on", at: TWO_HOURS_AGO, updatedAt: TWO_HOURS_AGO, state: "cancelled" }])
  assert.equal(decide({ row: row({ delivery_ledger: cancelled }) }).hibernate, true)
})

// A thread woken seconds ago reads as idle for the moment before its first record lands.
test("a freshly forked daemon is left alone however old its transcript is", () => {
  assert.deepEqual(decide({ daemonStartedAtMs: NOW - 30_000 }), { hibernate: false, blockedBy: "daemon-too-young" })
  // An unparseable createdAt is an unknown, and an unknown is a refusal.
  assert.deepEqual(decide({ daemonStartedAtMs: Number.NaN }), { hibernate: false, blockedBy: "daemon-too-young" })
})

test("a row that is not a resting broker thread is not this sweep's business", () => {
  assert.deepEqual(decide({ row: row({ backend: "codex", codex_runtime: "app-server" }) }), { hibernate: false, blockedBy: "not-a-broker-thread" })
  assert.deepEqual(decide({ row: row({ state: "archived" }) }), { hibernate: false, blockedBy: "archived" })
  assert.deepEqual(decide({ row: row({ archived: 1 }) }), { hibernate: false, blockedBy: "archived" })
  assert.deepEqual(decide({ row: row({ exited: 1 }) }), { hibernate: false, blockedBy: "stopped" })
})

// The newest of the three can only ever make a thread look MORE recently active, which is the safe
// direction. `lastActivityAt` alone would have called this thread two hours idle.
test("idle age takes the NEWEST activity reading, not just lastActivityAt", () => {
  assert.equal(lastActivityMs(tele({ lastUserAt: TEN_MINUTES_AGO })), Date.parse(TEN_MINUTES_AGO))
  assert.deepEqual(
    decide({ telemetry: tele({ lastUserAt: TEN_MINUTES_AGO }) }),
    { hibernate: false, blockedBy: "not-idle-long-enough" },
  )
})

// ---- the sweep ------------------------------------------------------------------------------------

function sweepDeps(over: Partial<Parameters<typeof sweepHibernationOnce>[0]> = {}) {
  const retired: { threadSlug: string; sessionId: string; reason: string }[] = []
  const deps = {
    liveDaemons: () => [{ sessionId: "sess-1", createdAt: new Date(DAEMON_STARTED).toISOString() }],
    rows: () => [row()],
    telemetry: () => tele(),
    pendingInteractions: () => 0,
    retire: (input: { threadSlug: string; sessionId: string; reason: "hibernate" }) => { retired.push(input); return true },
    now: () => NOW,
    idleMs: HIBERNATE_IDLE_MS,
    ...over,
  }
  return { deps, retired }
}

test("the sweep retires exactly the qualifying daemons, naming hibernation as the reason", () => {
  const { deps, retired } = sweepDeps()
  const result = sweepHibernationOnce(deps)
  assert.deepEqual(result.hibernated.map((h) => h.slug), ["fix-the-queue"])
  assert.deepEqual(retired, [{ threadSlug: "fix-the-queue", sessionId: "sess-1", reason: "hibernate" }])
})

test("a daemon whose registry row is gone is left to the orphan reaper", () => {
  const { deps, retired } = sweepDeps({ rows: () => [] })
  assert.deepEqual(sweepHibernationOnce(deps).hibernated, [])
  assert.deepEqual(retired, [])
})

// A sweep that cannot see the board reclaims nothing rather than guessing — the orphan reaper's rule.
test("every enumeration failure reclaims NOTHING", () => {
  for (const broken of [
    { liveDaemons: () => { throw new Error("ps failed") } },
    { rows: () => { throw new Error("db locked") } },
    { telemetry: () => { throw new Error("tailer threw") } },
  ]) {
    const { deps, retired } = sweepDeps(broken as never)
    assert.deepEqual(sweepHibernationOnce(deps).hibernated, [])
    assert.deepEqual(retired, [])
  }
})

// "There might be an approval" is the only honest answer from a store that will not answer.
test("an interaction store that throws blocks hibernation rather than reading as zero", () => {
  const { deps, retired } = sweepDeps({ pendingInteractions: () => { throw new Error("db locked") } })
  assert.deepEqual(sweepHibernationOnce(deps).blocked, [{ slug: "fix-the-queue", blockedBy: "pending-approval", ageMs: NOW - DAEMON_STARTED }])
  assert.deepEqual(retired, [])
})

test("a retire that finds no live daemon is not counted as a hibernation", () => {
  const { deps } = sweepDeps({ retire: () => false })
  assert.deepEqual(sweepHibernationOnce(deps).hibernated, [])
})

test("the sweep reports why each thread was left alone", () => {
  const { deps } = sweepDeps({ telemetry: () => tele({ turn: "in-flight" }) })
  assert.deepEqual(sweepHibernationOnce(deps).blocked, [{ slug: "fix-the-queue", blockedBy: "turn-in-flight", ageMs: NOW - DAEMON_STARTED }])
})

// The census answers "why is this daemon still here after a day" from the log alone. Only daemons up
// longer than the threshold are news; a younger one could not have been hibernated yet.
test("the census names each long-lived kept daemon with its age and refusal, oldest first", () => {
  const day = 29 * 60 * 60_000
  const line = describeResidentDaemons({
    hibernated: [],
    blocked: [
      { slug: "fresh", blockedBy: "turn-in-flight", ageMs: 10 * 60_000 },
      { slug: "orchestrator", blockedBy: "background-shells", ageMs: day },
      { slug: "auditor", blockedBy: "sub-agents", ageMs: 5 * 60 * 60_000 },
      { slug: "unborn", blockedBy: "daemon-too-young", ageMs: Number.NaN },
    ],
  }, HIBERNATE_IDLE_MS)
  assert.equal(line, "hibernate: kept 2 broker daemon(s) up longer than 1h: orchestrator (up 1d 5h, background-shells), auditor (up 5h, sub-agents)")
  assert.equal(describeResidentDaemons({ hibernated: [], blocked: [{ slug: "fresh", blockedBy: "turn-in-flight", ageMs: 10 * 60_000 }] }, HIBERNATE_IDLE_MS), undefined)
})

// ---- configuration --------------------------------------------------------------------------------

test("the threshold and the kill switch read from the environment", () => {
  assert.equal(hibernateIdleMs({}), HIBERNATE_IDLE_MS)
  assert.equal(hibernateIdleMs({ FRIZZ_HIBERNATE_IDLE_MINUTES: "5" }), 5 * 60_000)
  // Garbage keeps the default rather than disabling the guard — off is FRIZZ_HIBERNATE_OFF's job.
  assert.equal(hibernateIdleMs({ FRIZZ_HIBERNATE_IDLE_MINUTES: "nonsense" }), HIBERNATE_IDLE_MS)
  assert.equal(hibernateIdleMs({ FRIZZ_HIBERNATE_IDLE_MINUTES: "0" }), HIBERNATE_IDLE_MS)
  assert.equal(hibernateIdleMs({ FRIZZ_HIBERNATE_IDLE_MINUTES: "-3" }), HIBERNATE_IDLE_MS)
  assert.equal(hibernateSweepIntervalMs({}), HIBERNATE_SWEEP_INTERVAL_MS)
  assert.equal(hibernateSweepIntervalMs({ FRIZZ_HIBERNATE_SWEEP_SECONDS: "20" }), 20_000)
  assert.equal(hibernateSweepIntervalMs({ FRIZZ_HIBERNATE_SWEEP_SECONDS: "nope" }), HIBERNATE_SWEEP_INTERVAL_MS)
  assert.equal(hibernationEnabled({}), true)
  assert.equal(hibernationEnabled({ FRIZZ_HIBERNATE_OFF: "1" }), false)
})
