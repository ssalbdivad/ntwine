// THE DECLARED PARK — a thread is "awaiting background work" when it SAYS SO, naming what it waits on.
//
// The inference it replaces (does this thread happen to have something running?) is what put the resting
// card on a thread whose only background work was a dev server nobody tore down: true by the letter,
// useless as a signal.
//
// THE FENCE REGISTERS NOTHING — it is display-only, and exists so a worker can rest without being bumped
// for a handoff. A background shell already wakes its agent when it finishes, and a sub-agent's return
// re-invokes its parent, so there was never anything for ntwine to arm (maintainer 2026-08-14: "Both
// subagents and background shells should be display-only here").
//
// So what these pin is the INTEGRITY CHECK: every name in the fence has to correspond to something the
// thread ACTUALLY has out right now, and everything else must fail OPEN — back to the queue, never
// parked behind a wait that does not exist. A typo is not a way to disappear from the board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { declaredWaitIds, hasDeclaredBackgroundPark, hasDeclaredWait } from "./board.ts"
import { parkExpiresAt, parkForMaxMs, parkIsHonoured, parkOnHuman, readAwaitingPark, unaccountedItems } from "./awaiting.ts"
import { AGENT_PARK_FOR_MAX_MS, AWAITING_FOR_MAX_MS, isParkCorrection, parseParkWake, NEEDS_INPUT_REQUIRED_AT, PARK_CORRECTION_NEEDS_INPUT_LEAD, PR_WATCH_FOR_MAX_MS, splitAwaitingFrontmatter } from "@ntwine/shared"
import { createScheduler } from "./scheduler.ts"
import type { FenceView, SessionTelemetry } from "./tailer.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { replyWaitPrompt } from "./thread-mentions.ts"

const AT = "2026-08-14T00:00:00.000Z"
const NOW = Date.parse("2026-08-14T00:05:00.000Z")
// Up here, above every test that reads it: node:test starts the FIRST test the moment `test()` is called,
// while this module is still evaluating, so a `const` declared below that test is in its temporal dead
// zone when the test body runs ("Cannot access 'LIVE_SHELL' before initialization").
const LIVE_SHELL = { label: "the suite", startedAt: "2026-08-15T11:59:00.000Z", state: "running" as const, id: "toolu_x", taskId: "bzvtnt3ig" }

type Shell = SessionTelemetry["bgShells"][number]
type Agent = SessionTelemetry["subAgents"][number]

const shell = (label: string, id?: string, state: "running" | "stale" = "running") =>
  ({ label, id, startedAt: AT, state }) as unknown as Shell
const agent = (label: string, id: string, state: "running" | "stale" | "rested" = "running") =>
  ({ label, id, startedAt: AT, state }) as unknown as Agent

function parked(names: string[], over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    lastAssistantAt: AT,
    bgShells: [],
    subAgents: [],
    lastFence: {
      kind: "awaiting",
      body: "Waiting on the test run.",
      hints: names.map((value) => ({ kind: "shell" as const, value })),
    },
    ...over,
  } as SessionTelemetry
}

// `declaredWaitIds` is the thread's OWN RUNNING WORK, by the handle the worker sees. `timer:` and
// `pr:` are waits too, but they name rows in their own registries and are checked against those —
// mixing them in here would compare a timer id against a set of shell handles and call a healthy wait
// dead. `for:` and `reason:` describe the park itself and name nothing at all.
test("the names come off the shell/agent lines, and nothing else does", () => {
  const tele = parked([], {
    lastFence: {
      kind: "awaiting",
      body: "",
      hints: [
        { kind: "shell", value: "nub run test" },
        { kind: "pr", value: "acme/app#1" },
        { kind: "agent", value: "agent_7" },
        { kind: "timer", value: "tmr_abc123" },
        { kind: "for", value: "2h" },
        { kind: "shell", value: "bash_2" },
      ],
    },
  } as Partial<SessionTelemetry>)
  assert.deepEqual(declaredWaitIds(tele), ["nub run test", "agent_7", "bash_2"])
})

test("a done fence declares nothing, and neither does a thread with no fence", () => {
  assert.deepEqual(declaredWaitIds({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds({} as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds(undefined), [])
})

// A worker names what it can see in its own transcript, which is sometimes the tool id and sometimes the
// label. Refusing the label would make the fence unusable for the case it exists for.
test("a shell or a sub-agent can be named by id OR by label", () => {
  const withShell = { bgShells: [shell("nub run test", "bash_1")] }
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], withShell), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["nub run test"], withShell), NOW), true)
  const withAgent = { subAgents: [agent("reviewer", "toolu_9")] }
  assert.equal(hasDeclaredBackgroundPark(parked(["toolu_9"], withAgent), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["reviewer"], withAgent), NOW), true)
})

// EVERY ONE of these is a way a thread could vanish behind a wait nothing will resolve. They all have to
// land the same way: not a park, so the thread queues exactly as it would have without the fence.
test("a name matching nothing live is NOT a park", () => {
  // The fence outlived the work, or the worker invented the entry outright.
  assert.equal(hasDeclaredBackgroundPark(parked(["nub run test"]), NOW), false)
  // A typo against a real shell.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["nub run tests"], { bgShells: [shell("nub run test", "bash_1")] }), NOW),
    false,
  )
  // The shell went stale, so it is not live work any more and nothing will report back.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["bash_1"], { bgShells: [shell("nub run test", "bash_1", "stale")] }), NOW),
    false,
  )
  // A rested sub-agent has already returned; waiting on it waits forever.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["toolu_9"], { subAgents: [agent("reviewer", "toolu_9", "rested")] }), NOW),
    false,
  )
  // All-or-nothing: the thread claimed to be waiting on BOTH, so one dead name voids the claim.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["bash_1", "ghost"], { bgShells: [shell("nub run test", "bash_1")] }), NOW),
    false,
  )
  // An awaiting fence with no `watch:` line at all is prose, not a declaration.
  assert.equal(hasDeclaredBackgroundPark(parked([], { bgShells: [shell("nub run test", "bash_1")] }), NOW), false)
})

// A park with no expiry is the dev-server problem inverted: instead of a card that lies, a thread that
// disappears. The fence's own instant bounds it without any new syntax.
test("a park expires, so nothing parks forever", () => {
  const live = { bgShells: [shell("nub run test", "bash_1")] }
  const dayLater = Date.parse(AT) + 24 * 60 * 60 * 1000 + 1000
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], live), dayLater), false)
  // Just inside the cap it still holds.
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], live), Date.parse(AT) + 60_000), true)
})

// THE FENCE'S OWN CEILING FOLLOWS WHAT IT NAMES. A park is one sentence about every item in it, so it
// can only be as long as its shortest-lived kind — but a park naming NOTHING BUT PULL REQUESTS names no
// short-lived kind at all. Capping that one at a day is what bumped a thread daily for four days against
// an external PR nobody had touched: the watcher could be armed for months and the fence expired first.
test("a park naming only PRs may stand for months; anything else is still capped at a day", () => {
  const prs = { items: [{ kind: "pr" as const, value: "acme/app#391" }], forMs: 180 * 24 * 60 * 60_000, steps: [], questions: [] }
  const at = Date.parse(AT)
  assert.equal(parkForMaxMs(prs), PR_WATCH_FOR_MAX_MS)
  assert.equal(parkExpiresAt(prs, at), at + 180 * 24 * 60 * 60_000, "the duration as written, uncapped")
  // MIXED ⇒ THE LOW CEILING. The shell in the list is still a shell, and the sentence covers it too.
  const mixed = { items: [...prs.items, { kind: "shell" as const, value: "bzvtnt3ig" }], forMs: prs.forMs, steps: [], questions: [] }
  assert.equal(parkForMaxMs(mixed), AWAITING_FOR_MAX_MS)
  assert.equal(parkExpiresAt(mixed, at), at + AWAITING_FOR_MAX_MS)
  // …and a year is a ceiling, not a floor: a PR park asking for hours gets hours.
  assert.equal(parkExpiresAt({ ...prs, forMs: 2 * 60 * 60_000 }, at), at + 2 * 60 * 60_000)
  // Above even the PR ceiling it is still capped rather than refused.
  assert.equal(parkExpiresAt({ ...prs, forMs: 9999 * 24 * 60 * 60_000 }, at), at + PR_WATCH_FOR_MAX_MS)
  // AND THE READ KEEPS `for:` AS WRITTEN. Clamping at parse time is what made the ceiling one number for
  // every kind — the park has to reach parkExpiresAt uncapped for the rule above to have anything to say.
  assert.equal(
    readAwaitingPark([{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "180d" }]).forMs,
    180 * 24 * 60 * 60_000,
  )
})

// …and the same thing through the scheduler, which is what actually bumps a worker. A month into a
// 180-day park on a REGISTERED external PR there is nothing to correct: the watcher is armed, the PR has
// not moved, and waking the thread would produce exactly the empty wake this change exists to stop.
test("a months-long PR park is not bumped a month in, where the same fence on a shell would be", async () => {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
  const h = parkHarness([{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "180d" }], {
    restedAt: monthAgo,
    prWatch: { owner: "acme", repo: "app", number: 391 },
  })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued().map((r) => r.fence_id), [], "an armed watcher inside its own `for:` is a healthy park")
  } finally { h.close() }
})

test("the day ceiling still bites a month-old park on a background shell", async () => {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "180d" }], {
    restedAt: monthAgo, shells: [LIVE_SHELL],
  })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a shell does not outlive its session by a month, whatever the fence asked for")
    assert.match(rows[0].fence_id, /^park:expired:/)
  } finally { h.close() }
})

// A `pr-watch:` park is ALSO a declaration and it also cards — but it must never take the thread out of
// the queue on its own. A PR whose reviews never arrive would vanish silently, which is the reason no
// watcher has ever parked its thread (maintainer 2026-07-22, reaffirmed 2026-08-12). Own background work
// is the opposite case: it reports on its own and there is nothing for the human to do meanwhile.
test("a pr-watch park cards but does NOT take the thread out of the queue", () => {
  const prWatch = {
    lastAssistantAt: AT,
    bgShells: [],
    subAgents: [],
    lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr", value: "acme/app#1" }] },
  } as unknown as SessionTelemetry
  assert.equal(hasDeclaredWait(prWatch, NOW, new Set(), new Set(["acme/app#1"])), true, "it states a wait, so the card shows")
  assert.equal(hasDeclaredBackgroundPark(prWatch, NOW), false, "but it never excuses the queue")
  // DECLARED AND REGISTERED, both (2026-08-26): with no watcher registered nothing will ever wake the
  // thread, so the declaration alone is not a wait — same rule as a timer named against the registry.
  assert.equal(hasDeclaredWait(prWatch, NOW), false, "unregistered → no wait")
})

// THE REGISTRY KEY IS NORMALIZED; THE FENCE IS WHATEVER THE WORKER WROTE. `watch_pr` accepts a URL and
// stores `owner/repo#N`, so a raw string match called a URL-named registered PR unaccounted: bumped
// "NOT REGISTERED", re-registered (idempotent), same fence re-written, bumped again — the loop the
// grammar exists to end, driven by the correction itself.
test("unaccountedItems: a registered PR named by URL is accounted", () => {
  const live = { shells: new Set<string>(), agents: new Set<string>(), timers: new Set<string>(), prs: new Set(["acme/app#1"]) }
  assert.deepEqual(unaccountedItems([{ kind: "pr", value: "https://github.com/acme/app/pull/1" }], live), [])
  assert.equal(unaccountedItems([{ kind: "pr", value: "acme/app#2" }], live).length, 1, "a different PR is still unaccounted")
})

test("own background work does both — it cards AND it leaves the queue", () => {
  const own = parked(["bash_1"], { bgShells: [shell("nub run test", "bash_1")] })
  assert.equal(hasDeclaredWait(own, NOW), true)
  assert.equal(hasDeclaredBackgroundPark(own, NOW), true)
})

// ---- SOURCE 12: THE PARK THAT STOPPED BEING TRUE --------------------------------------------------
// The two ways an awaiting fence goes stale, and the property that matters is that NEITHER is silent.
// Every stall this grammar replaced was silent: a watcher matched on ids the worker never saw, a
// blocking call that starved its own notification, a timer written in the past. Each one left a thread
// looking parked forever, and ntwine said nothing.

function parkHarness(hints: FenceView["hints"], opts: { shells?: any[]; agents?: any[]; restedAt?: string; body?: string; retired?: any[]; prWatch?: { owner: string; repo: string; number: number }; lastHumanAt?: string; spawnedAt?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-park-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off") // isolate SOURCE 12 from the nudge
  const slug = "parked"
  const restedAt = opts.restedAt ?? new Date(Date.now() - 60_000).toISOString()
  // The worker's CURRENT rest, which a case may move to stand for a later turn (`rest`).
  let current = restedAt
  let currentHints = hints
  let currentAgents = opts.agents ?? []
  // WHAT ACTUALLY REACHED THE WORKER. Every test in this file used to stop at the outbox row, which is
  // exactly how a correction that could never be delivered survived: enqueue is not delivery.
  const sent: string[] = []
  storage.upsertSession({
    // A LEGACY dispatch unless a case says otherwise: these cases pin the item checks, and a thread under
    // the answer-required contract owes a `status:` they are not about (see the answer cases below).
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: opts.spawnedAt ?? "2026-08-15T11:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: restedAt, title_auto: 0,
    title: null, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // Armed for a YEAR, so the watcher itself is never what settles in these tests — what is under test is
  // the FENCE's ceiling, and a watcher expiring underneath it would enqueue its own wake and confuse it.
  if (opts.prWatch) {
    storage.armPrWatch({
      id: "prw_park0000001", slug, ...opts.prWatch,
      createdAtMs: Date.parse(restedAt), expiresAtMs: Date.parse(restedAt) + 365 * 24 * 60 * 60_000,
    })
  }
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    now: opts.now,
    // Stubbed so an armed watcher never reaches the real `gh`. Nothing here polls for a verdict — every
    // test in this file is about the fence — so a PR that never changes is exactly the right answer.
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    tailer: {
      get: () => ({
        turn: "idle",
        lastAssistantAt: current,
        lastActivityAt: current,
        subAgents: currentAgents,
        bgShells: opts.shells ?? [],
        retiredShells: opts.retired ?? [],
        pendingQuestion: false,
        permPrompt: false,
        lastFence: { kind: "awaiting", body: opts.body ?? "", hints: currentHints },
        lastHumanAt: opts.lastHumanAt,
      }),
    } as never,
    resume: async (_slug, message) => { sent.push(message) },
    log: () => {},
  })
  const queued = () => storage.db.prepare("SELECT fence_id, message FROM wake_delivery WHERE thread_slug = ?").all(slug) as { fence_id: string; message: string; state: string }[]
  const state = () => storage.db.prepare("SELECT fence_id, state FROM wake_delivery WHERE thread_slug = ?").all(slug) as { fence_id: string; state: string }[]
  return { s, storage, queued, state, sent, restedAt, rest: (at: string, next?: { hints?: FenceView["hints"]; agents?: any[] }) => {
    current = at
    if (next?.hints) currentHints = next.hints
    if (next?.agents) currentAgents = next.agents
  }, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a park naming something that is NOT running bumps the worker, and says which", async () => {
  const h = parkHarness([
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "shell", value: "bGONE" },
    { kind: "for", value: "2h" },
  ], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a park that cannot resolve is never silent")
    assert.match(rows[0].fence_id, /^park:dead:/)
    // NAMING WHICH is the whole point: "your fence is wrong" sends a worker back to hunt for an id it
    // has already lost, which is how it got the id wrong in the first place.
    assert.match(rows[0].message, /bGONE.*NOT RUNNING/s)
    assert.match(rows[0].message, /bzvtnt3ig.*still running/s)
    assert.match(rows[0].message, /`ntwinectl activity`/, "…and points at the command that hands the ids back")
  } finally { h.close() }
})

// A PR NAMED BUT NEVER REGISTERED IS BUMPED, BY NAME — and this is a DELIBERATE design choice, not a
// gap. The maintainer was asked (2026-08-24) whether a `prs:` entry should simply arm the watcher itself,
// making `mcp__ntwine__watch_pr` optional, and chose to keep declaration and registration strictly
// separate: "a fence naming an unregistered PR keeps getting bumped, and the worker learns to call the
// tool first."
//
// That answer only holds while the bump actually happens, and nothing pinned it. `unaccountedItems`
// checks a `pr` item against the thread's REGISTERED watchers (awaiting.ts LIVE_SET), so an unregistered
// ref is unaccounted and the park is refused — the alternative, silently parking on a wait nothing can
// deliver, is the exact failure this grammar exists to prevent.
test("a PR named in the fence but never registered is refused, and the correction names it", async () => {
  const h = parkHarness([
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "2h" },
  ])
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a park on an unregistered PR is never silent")
    assert.match(rows[0].message, /acme\/app#391/, "the worker is told WHICH ref ntwine could not find")
    assert.match(rows[0].message, /`ntwinectl watch-pr add`/, "…and that registering it is the missing step")
  } finally { h.close() }
})

test("a park whose every item is live is left alone", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [], "an honest park is not interrupted")
  } finally { h.close() }
})

// `for:` ELAPSED. The wait did not fail — it simply outlived its own estimate, which is a checkpoint
// rather than an error, so the worker is brought back to look rather than told off.
test("a park whose `for:` runs out bumps with the status of every item, and re-parking is unlimited", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "30s" }], {
    shells: [LIVE_SHELL],
    restedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:expired:/)
    assert.match(rows[0].message, /Your wait expired, nothing resolved\. Check back in on everything\./)
    assert.match(rows[0].message, /bzvtnt3ig.*still running/s, "the status list says what is and is not going")
    assert.match(rows[0].message, /no limit on that/, "re-parking is explicitly unlimited")
    // ONE bump per rest per cause — not one per tick, which would be a loop.
    for (let i = 0; i < 3; i++) await h.s.tick()
    assert.equal(h.queued().length, 1, "one rest, one expiry bump")
  } finally { h.close() }
})
// A fence with ITEMS but no `for:` is MALFORMED rather than wrong, and the sign-off nudge teaches the
// whole grammar in one message — a better teacher than a correction aimed at one missing line. (A fence
// with no items AT ALL is the opposite case and is bumped here; see the nameless tests below.)
test("a fence with items but no `for:` is left to the sign-off nudge", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [], "not SOURCE 12's to report")
  } finally { h.close() }
})

// THE FENCE THAT NAMES NOTHING — the shape the maintainer caught in the wild (2026-08-16): `for: 24h`
// plus "TypeScript legs still running … waiting on the checks and your merge", and no item at all. The
// worker could have registered a PR watcher and been woken the moment CI settled; instead it waited on
// nothing, and ntwine — which correctly refused the park — said nothing about why for a whole day.
//
// It is now the most explicit of the three bumps, because it is the one where the worker has the most to
// gain from being told: it does not need to fix an id, it needs to register something at all.
test("an awaiting fence naming NOTHING is bumped, with how to register a real wait", async () => {
  const h = parkHarness([{ kind: "for", value: "24h" }], { body: "TypeScript legs still running; waiting on the checks and your merge" })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a wait with nothing to wake it is never silent")
    assert.match(rows[0].fence_id, /^park:nameless:/)
    assert.match(rows[0].message, /names nothing to wait on/)
    // It has to say HOW, naming the tool for each kind — a worker told only "that is wrong" writes the
    // same fence again.
    assert.match(rows[0].message, /`ntwinectl watch-pr add`/, "the PR case, which is the one it had")
    assert.match(rows[0].message, /`ntwinectl timer set`/)
    assert.match(rows[0].message, /`ntwinectl activity`/, "…and where to get the ids")
    // …and the other honest exit: if it is not waiting, it is done.
    assert.match(rows[0].message, /you are not awaiting — you are done/)
  } finally { h.close() }
})

// One bump per rest per CAUSE. A fence that names nothing is a different piece of news from one whose
// item died, so the ids must not collide — but neither may fire twice for the same rest.
test("the nameless bump fires once per rest, and does not collide with the other two causes", async () => {
  const h = parkHarness([{ kind: "for", value: "2h" }], { body: "waiting" })
  try {
    for (let i = 0; i < 4; i++) await h.s.tick()
    assert.equal(h.queued().length, 1, "one rest, one nameless bump")
  } finally { h.close() }
})

// A RETIRED LINE KIND IS BLOCKED BY NAME, not silently ignored (maintainer 2026-08-17: "BLOCK THEM with
// an error message… tell them what is now supported").
//
// A worker's contract is frozen at dispatch, so every session started before the 2026-08-15 cut keeps
// writing the old kinds. A deleted kind does not parse, so it falls into the fence BODY as prose and the
// fence silently becomes a park naming nothing — and the worker cannot see WHICH line ntwine ignored, so
// it writes the same one again. That produced three separate bug reports in two days, one of them a Goal
// loop re-writing `pr-watch:` every six seconds.
test("a fence using a RETIRED kind is bumped by name, with what replaced it", async () => {
  // The exact shape from the looping thread: the deleted kind lands in the body, hints are empty.
  const h = parkHarness([], { body: "pr-watch: pullfrog/app#1221\nDrift check re-run: CI green." })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:retired:/, "its own cause, so it cannot collide with the others")
    // NAMES THE OFFENDING LINE. "Your fence names nothing" was true but not actionable — the worker
    // could not tell which of its lines ntwine had dropped.
    assert.match(rows[0].message, /`pr-watch:` is GONE/)
    assert.match(rows[0].message, /`ntwinectl watch-pr add`/, "…and what to do instead")
    // AND THE WHOLE SUPPORTED SET, so the answer does not depend on the worker's frozen contract — which
    // is the entire point of this correction, and never more so than right after the 2026-08-24 cutover,
    // when every worker in flight has the retired SINGULAR keys frozen into its system prompt.
    for (const key of ["shells:", "agents:", "timers:", "prs:", "for:"]) {
      assert.ok(rows[0].message.includes(key), `the supported set must name ${key}`)
    }
    assert.match(rows[0].message, /REQUIRED — a DURATION, never an instant/)
    // The frontmatter is YAML, so the correction has to say the two things that break it: prose above the
    // delimiter, and the `reason:` key that used to carry it.
    assert.match(rows[0].message, /NO prose above the `---`/)
    assert.match(rows[0].message, /`reason:` is gone/)
  } finally { h.close() }
})

// A CORRECTION CARRIES THE IDS, not a tool name. A worker dispatched before `mcp__ntwine__activity`
// existed cannot call it — its MCP server is frozen at dispatch — and those are exactly the threads still
// writing fences this check refuses. Telling them to call it was pointing the whole affected population
// at a remedy they do not have.
test("a correction prints the live ids inline, ready to copy into a fence", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /Background shells still running:/)
    // The COPYABLE form — the exact line the worker should have written, by the id the runtime showed it,
    // in the plural YAML list the park check accepts. The singular `shell:` it printed until 2026-09-25 is
    // retired, so a worker copying it was refused for copying it.
    assert.match(msg, /- `bzvtnt3ig`  — /)
    assert.match(msg, /In a fence: `shells: \[bzvtnt3ig\]`/, "the id, in the shape a fence line takes")
    assert.doesNotMatch(msg, /`shell: /)
  } finally { h.close() }
})

// …and when there is genuinely nothing out, that is the answer rather than an empty list. This is the
// commonest nameless fence: a worker "waiting" on nothing at all.
test("a nameless fence with nothing running is told it is not awaiting at all", async () => {
  const h = parkHarness([{ kind: "for", value: "24h" }], { body: "waiting on the merge" })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /You have NOTHING running right now/)
    // The question fence is retired (2026-09-11); a registered question is the other way out.
    assert.match(msg, /finish in\s*```done, or register a question with `ntwinectl ask`/s)
  } finally { h.close() }
})

// THE CORRECTION IS CAPPED, because a correction only helps a worker that can act on it.
//
// Every test above ticks against ONE rest, where the delivery id alone bounds the bump. The loop lives in
// the shape they cannot express: the worker WAKES, cannot write a fence this grammar accepts — its
// contract froze before the grammar existed — and rests again under a NEW instant, which is a new
// delivery id and so a new bump. Closed loop, no dedupe reached.
//
// Measured on the live board 2026-08-17: `investigate-nubjs-nub-656` had taken 617 corrective bumps in
// 4h45m, one every ~28 seconds, and two more threads were doing the same. Every other parked thread on
// that board had taken exactly one.
function loopHarness(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-parkloop-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  const slug = "looping"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: "2026-08-17T11:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: new Date().toISOString(),
    title_auto: 0, title: null, state: "open", meta: null, seen_at: null,
    transcript_id: null,
  } as SessionRow)
  // The worker's own last word, advanced by `restAgain()` to model a wake that changes nothing.
  let restedAt = new Date(Date.now() - 60_000).toISOString()
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastAssistantAt: restedAt, lastActivityAt: restedAt,
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        lastFence: { kind: "awaiting", body, hints: [] },
      }),
    } as never,
    resume: async () => {},
    log: () => {},
  })
  return {
    s, storage,
    restAgain: () => { restedAt = new Date(Date.parse(restedAt) + 30_000).toISOString() },
    bumps: () => (storage.db.prepare("SELECT COUNT(*) n FROM wake_delivery WHERE thread_slug = ?").get(slug) as { n: number }).n,
    close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a worker that cannot act on the correction is corrected a few times, then left alone", async () => {
  const h = loopHarness("pr-watch: a/b#1")
  try {
    // Twelve rests it never learns from. Uncapped this is twelve bumps — and in production it was 617.
    for (let i = 0; i < 12; i++) {
      await h.s.tick()
      h.restAgain()
    }
    const n = h.bumps()
    assert.ok(n > 0, "it is still told — a silent refusal is the bug this source exists to fix")
    assert.ok(n <= 3, `the correction is bounded, got ${n} bumps from 12 unlearning rests`)
  } finally { h.close() }
})

// …and the allowance comes BACK, so the cap cannot silently retire the check on a long-lived thread that
// makes one mistake early and another one hours later.
test("an honoured park gives the corrective allowance back", async () => {
  const h = loopHarness("pr-watch: a/b#1")
  try {
    for (let i = 0; i < 6; i++) { await h.s.tick(); h.restAgain() }
    const spent = h.bumps()
    assert.ok(spent > 0 && spent <= 3, "capped first")
    h.storage.resetParkBumps("looping") // what an honoured park does, exercised directly
    for (let i = 0; i < 6; i++) { await h.s.tick(); h.restAgain() }
    assert.ok(h.bumps() > spent, "a thread that came right is corrected again when it errs again")
  } finally { h.close() }
})

test("every retired kind is recognized, and a repeat teaches once", async () => {
  const h = parkHarness([], { body: "watch: b1\nhuman: Alice\nci: build 9\nsession: s1\npr-watch: a/b#1\npr-watch: a/b#2" })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    for (const k of ["watch:", "human:", "ci:", "session:", "pr-watch:"]) {
      assert.ok(msg.includes(`\`${k}\` is GONE`), `${k} must be named`)
    }
    // Two `pr-watch:` lines are ONE thing to learn.
    assert.equal(msg.match(/`pr-watch:` is GONE/g)?.length, 1, "deduped by kind, not by line")
  } finally { h.close() }
})

// ---- AND IT HAS TO ACTUALLY ARRIVE ---------------------------------------------------------------
// Every test above this line asserts on the OUTBOX ROW, and for a year that was the whole suite. It is
// also why SOURCE 12 shipped broken and stayed broken: `deliveryContext()` had no branch for a `park:…`
// id, so each correction fell to the awaiting-fence tail, whose `isActionable` has been hardwired false
// since the 2026-08-15 grammar cut, and read as SUPERSEDED at zero attempts. Enqueue is not delivery.
//
// Measured on the maintainer's own board 2026-08-18, across four projects: 2034 park corrections
// enqueued, 0 delivered, ever — while `stophook` ran 963/963 and `prwatch` 33/33, because those have a
// branch. The thread that surfaced it wrote `timer: none`, was correctly refused a park, and sat in the
// queue for three hours with nothing able to tell it so.
test("the correction is DELIVERED, not just queued", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }])
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 1, "a queued correction nobody receives is the same silence it exists to end")
    assert.match(h.sent[0], /not running/i)
    assert.deepEqual(h.state().map((r) => r.state), ["delivered"])
  } finally { h.close() }
})

// The exact shape of the thread that surfaced it: `timer: none` — the word, not a registered row.
test("a fence naming a timer that was never registered reaches the worker", async () => {
  const h = parkHarness([{ kind: "timer", value: "none" }, { kind: "for", value: "15m" }])
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0], /`timers: \[none\]` — NOT RUNNING/)
  } finally { h.close() }
})

// THE HUMAN'S "Ask for update": the hourly sub-agent check-in, on demand. It lands on a park that has not
// run out, carries the same check-in steps, asks for a `needs_input: true` report, and is spent by one
// wake — a later tick on the same rest sends nothing more, and a request for a rest the worker has moved
// past is inert.
test("requestCheckIn wakes a live agent park early with the check-in, once", async () => {
  const live = { id: "toolu_A", taskId: "a01b2d20b32feab11", label: "the reviewer", startedAt: "2026-10-03T10:00:00.000Z", state: "running" as const }
  const h = parkHarness([{ kind: "agent", value: "a01b2d20b32feab11" }, { kind: "for", value: "1h" }], { agents: [live] })
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 0, "a live park inside its hour is left alone")
    h.s.requestCheckIn("parked", "2000-01-01T00:00:00.000Z")
    await h.s.tick()
    assert.equal(h.sent.length, 0, "a request for another rest is inert")
    h.s.requestCheckIn("parked", h.restedAt)
    await h.s.tick()
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0], /^👋 The user asked for an update/)
    assert.match(h.sent[0], /SUB-AGENT CHECK-IN/)
    assert.match(h.sent[0], /re-park with `status: needs_input`/)
    assert.deepEqual(parseParkWake(h.sent[0]), { kind: "requested", items: ["- `agents: [a01b2d20b32feab11]` — still running"] })
    assert.match(h.queued()[0].fence_id, /^park:requested:/)
    for (let i = 0; i < 3; i++) await h.s.tick()
    assert.equal(h.sent.length, 1, "one click, one wake")
  } finally { h.close() }
})

// THE CHECK-IN KEEPS THE BAND. It used to say "else \`working\`" whatever the worker had answered, so @3-0,
// parked \`watching\` on two Workflows, re-parked \`working\` at its check-in with nothing changed and its row
// jumped from Snoozed to the spinning Working band (2026-10-06).
test("a sub-agent check-in tells the worker to keep the status its last park answered", async () => {
  const t0 = Date.parse("2026-10-06T23:23:00.000Z")
  const live = { id: "toolu_A", taskId: "wygmxtip8", label: "design", startedAt: "2026-10-06T23:00:00.000Z", state: "running" as const }
  for (const status of ["watching", "working"] as const) {
    const h = parkHarness([{ kind: "agent", value: "wygmxtip8" }, { kind: "status", value: status }, { kind: "for", value: "1h" }], {
      agents: [live],
      restedAt: new Date(t0).toISOString(),
      now: () => t0 + 30 * 60_000 + 1000,
    })
    try {
      await h.s.tick()
      assert.equal(h.sent.length, 1)
      assert.match(h.sent[0], /SUB-AGENT CHECK-IN/)
      assert.match(h.sent[0], new RegExp(`keep\\n   \`status: ${status}\`, which your last park answered`))
      assert.doesNotMatch(h.sent[0], /else `working`/)
    } finally { h.close() }
  }
})

// THE CHECK-IN IS ANCHORED ON THE LAST CHECK-IN, NOT THE LAST REST (scheduler.ts checkInAnchors). Any
// other wake — here a PR event — makes the worker rest again, and keyed on the rest that restarted the 30
// minutes, so a thread kept busy by its PR never reported on its children (@zod-json-validation,
// 2026-10-06: a workflow 41 minutes in with no progress report, the next one due at 71).
test("a wake in between does not push the sub-agent check-in back", async () => {
  const t0 = Date.parse("2026-10-06T09:46:00.000Z")
  let clock = t0 + 60_000
  const live = { id: "toolu_A", taskId: "wuscd823t", label: "yes-types-lean", startedAt: "2026-10-06T09:35:00.000Z", state: "running" as const }
  const h = parkHarness([{ kind: "agent", value: "wuscd823t" }, { kind: "for", value: "30m" }], {
    agents: [live],
    restedAt: new Date(t0).toISOString(),
    now: () => clock,
  })
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 0, "inside its 30 minutes")
    // 29 minutes in, a PR wake: the worker answers it and re-parks on the same child.
    clock = t0 + 29 * 60_000
    h.rest(new Date(clock).toISOString())
    await h.s.tick()
    assert.equal(h.sent.length, 0, "the check-in is not due yet")
    clock = t0 + 30 * 60_000 + 1000
    await h.s.tick()
    assert.equal(h.sent.length, 1, "due 30 minutes after the FIRST rest, not the second")
    assert.match(h.sent[0], /SUB-AGENT CHECK-IN/)
    // The check-in is the next anchor: a re-park right after it waits a full 30 minutes again.
    h.rest(new Date(clock + 10_000).toISOString())
    clock += 29 * 60_000
    await h.s.tick()
    assert.equal(h.sent.length, 1, "a fresh 30 minutes from the check-in")
    clock += 2 * 60_000
    await h.s.tick()
    assert.equal(h.sent.length, 2)
  } finally { h.close() }
})

// THE NEGATIVE CONTROL: a different set of children is a new run. The turn that launched them read the
// old ones' result, so it was the report, and the clock starts over from that rest.
test("a new set of sub-agents starts the check-in clock over", async () => {
  const t0 = Date.parse("2026-10-06T09:46:00.000Z")
  let clock = t0 + 60_000
  const h = parkHarness([{ kind: "agent", value: "wFIRST" }, { kind: "for", value: "30m" }], {
    agents: [{ id: "toolu_A", taskId: "wFIRST", label: "first", startedAt: "2026-10-06T09:35:00.000Z", state: "running" as const }],
    restedAt: new Date(t0).toISOString(),
    now: () => clock,
  })
  try {
    await h.s.tick()
    // 29 minutes in the first child returns, and the worker launches another and parks on it.
    clock = t0 + 29 * 60_000
    h.rest(new Date(clock).toISOString(), {
      hints: [{ kind: "agent", value: "wSECOND" }, { kind: "for", value: "30m" }],
      agents: [{ id: "toolu_B", taskId: "wSECOND", label: "second", startedAt: new Date(clock).toISOString(), state: "running" as const }],
    })
    await h.s.tick()
    clock = t0 + 31 * 60_000
    await h.s.tick()
    assert.equal(h.sent.length, 0, "a fresh child's park runs its own 30 minutes")
    clock = t0 + 59 * 60_000 + 1000
    await h.s.tick()
    assert.equal(h.sent.length, 1, "…and checks in when they run out")
  } finally { h.close() }
})

// …and the OTHER cause, which is the one that decides whether an over-running wait ever ends. An expiry
// bump is uncapped by design, so a lost one is a thread parked forever on a `for:` nobody honours.
test("an expired park is delivered too", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "30s" }], {
    shells: [LIVE_SHELL],
    restedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0], /Your wait expired/)
  } finally { h.close() }
})

// THE NEGATIVE CONTROL, and it is what proves the branch is a binding and not a rubber stamp: a
// correction is bound to the rest it was minted for. The worker speaking again means it is no longer
// looking at the fence being corrected, so the queued bump must die rather than land on a new turn.
test("a correction for a rest the worker has already moved past is not delivered", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }])
  try {
    await h.s.tick()
    assert.equal(h.sent.length, 1, "control: it lands while the rest is current")
    // Re-mint the same correction against a rest the telemetry no longer reports.
    const row = h.queued()[0]
    h.storage.db.prepare("UPDATE wake_delivery SET fence_id = ?, state = 'pending', delivered_at = NULL WHERE fence_id = ?")
      .run("park:dead:2020-01-01T00:00:00.000Z", row.fence_id)
    await h.s.tick()
    assert.equal(h.sent.length, 1, "a stale rest's correction is superseded, not sent")
  } finally { h.close() }
})

// FINISHED IS NOT MISSING, and the difference is the whole message.
//
// `read-the-file-read-up` wrote 284 awaiting fences. Each one parked on a build; the build FINISHED; and
// ntwine answered "NOT RUNNING", which reads as "your fence is broken" — so the worker relaunched the work
// instead of reading the output it had been waiting for, and went round again. ntwine has always known the
// difference: the fold retires a shell with its finish instant.
test("a park whose work simply FINISHED is told to read the result, not that its fence is wrong", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }], {
    shells: [],
    retired: [{ id: "toolu_x", taskId: "bzvtnt3ig", label: "the suite", status: "completed", finishedAt: AT }],
  })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "the park is still over — the thread must come back")
    assert.match(rows[0].fence_id, /^park:dead:/, "same cause; only the wording changes")
    assert.match(rows[0].message, /has FINISHED/)
    assert.match(rows[0].message, /its result is waiting for you/)
    // THE ANTI-CHURN INSTRUCTION, which is the point of the whole distinction.
    assert.match(rows[0].message, /Do NOT relaunch the same work/)
    // …and it must NOT read as a broken fence, or the worker fixes something that was never wrong.
    assert.doesNotMatch(rows[0].message, /not running, so it is not a park/)
    // …nor end by telling it to wrap up: "read the result and carry on" was followed by "nothing could
    // wake you, finish in done", which contradicted it (2026-10-01).
    assert.doesNotMatch(rows[0].message, /NOTHING running/)
  } finally { h.close() }
})

// ONE EVENT, ONE WAKE. A shell that finishes AFTER the rest gets its own completion wake, so the park's
// "has FINISHED" for the same shell was the same news twice, merged under two headings (wsl-cleanup,
// 2026-10-01). The test above is the control: finished BEFORE the rest, no completion wake, so the
// park still speaks.
test("a park whose shell finished after the rest draws ONE wake — the shell's own", async () => {
  const h = parkHarness([{ kind: "shell", value: "b5h60hai3" }, { kind: "for", value: "2h" }], {
    shells: [],
    retired: [{ id: "toolu_p", taskId: "b5h60hai3", label: "Pruning package stores", status: "completed", finishedAt: new Date().toISOString() }],
  })
  try {
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.sent.length, 1, "one shell finishing is one piece of news")
    assert.match(h.sent[0], /Your background shell finished: `b5h60hai3`/)
    assert.doesNotMatch(h.sent[0], /parked on has FINISHED/)
  } finally { h.close() }
})

// FINISHED-not-MISSING holds for the other kinds too — it shipped shell-only. A sub-agent that RETURNED
// reads `rested` in telemetry, and until 2026-08-26 a fence naming one got "NOT RUNNING (nothing by
// that name)": the wrong-fence wording, aimed at a worker whose wait simply ended.
test("a park on a sub-agent that RETURNED reads as finished, not as a wrong fence", async () => {
  const h = parkHarness([{ kind: "agent", value: "toolu_A" }, { kind: "for", value: "2h" }], {
    agents: [{ id: "toolu_A", label: "the reviewer", startedAt: AT, state: "rested" }],
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /has FINISHED/)
    assert.match(msg, /its result is waiting for you/)
    assert.doesNotMatch(msg, /nothing by that name/)
  } finally { h.close() }
})

// …and a timer that FIRED already delivered its wake as a user turn, so the truthful note points back
// at the transcript — not at a "result", and not at a fence that was never wrong.
test("a park on a timer that already FIRED says so, not the wrong-fence wording", async () => {
  const h = parkHarness([{ kind: "timer", value: "tmr_fired1" }, { kind: "for", value: "2h" }])
  try {
    h.storage.armThreadTimer({ id: "tmr_fired1", slug: "parked", prompt: "re-check the deploy", fireAtMs: Date.now() - 60_000, createdAtMs: Date.now() - 120_000 })
    h.storage.markThreadTimerFired("tmr_fired1", Date.now() - 30_000)
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /already FIRED — its wake was delivered/)
    assert.doesNotMatch(msg, /nothing by that name/)
  } finally { h.close() }
})

// A DEMOTED shell is neither finished nor a typo: ntwine has its launch and saw no completion notice, but
// can no longer find its process. "nothing by that name" sent the worker hunting for a mistake in an id it
// had copied exactly (2026-10-03, on a shell the probe had wrongly demoted while it ran).
test("a park on a shell ntwine demoted to stale says it is gone without a notice, not that the id is unknown", async () => {
  const h = parkHarness([{ kind: "shell", value: "bv8wnkd2q" }, { kind: "for", value: "2h" }], {
    shells: [{ id: "toolu_e2e", taskId: "bv8wnkd2q", label: "Running the released e2e", startedAt: AT, state: "stale" }],
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /`shells: \[bv8wnkd2q\]` — GONE WITHOUT A COMPLETION NOTICE/)
    assert.match(msg, /read its output to see how it ended/)
    assert.doesNotMatch(msg, /nothing by that name/)
    assert.doesNotMatch(msg, /has FINISHED/, "no notice arrived, so nothing says it finished")
  } finally { h.close() }
})

test("a park naming something that never existed still reads as a wrong fence", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGHOST" }, { kind: "for", value: "2h" }], { shells: [] })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /nothing by that name/, "an id matching nothing is a typo, not a finished job")
    assert.match(msg, /`ntwinectl activity`/, "…so it is pointed at the ids it actually has")
    assert.doesNotMatch(msg, /has FINISHED/)
  } finally { h.close() }
})

// THE CLOCK, on ntwine's own correction only.
//
// A broker-run worker is told neither the date nor the time by its runtime — measured 2026-08-19 on
// `read-the-file-read-up` (`claude_runtime = broker`, as 181 of that project's 338 sessions are): ZERO
// date injections and ZERO system-reminders across its entire life. So a worker writing `for: 1h` is not
// estimating badly; it has no clock to estimate against, and no way to notice that its last four parks
// each lasted four minutes.
//
// It rides ONLY on messages ntwine itself authors. Two pinned invariants forbid the blanket version — "the
// operator's text leads, verbatim" (Goal/heartbeat) and "the prompt VERBATIM" (snooze) — and ntwine's own
// corrections are in any case the only deliveries that discuss the fence.
test("a park correction tells the worker what time it is and how long it has been gone", async () => {
  const h = parkHarness([{ kind: "for", value: "24h" }], { body: "waiting",
    restedAt: new Date(Date.now() - 3 * 60 * 60_000 - 12 * 60_000).toISOString(),
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /⏱ \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "an absolute wall clock…")
    assert.match(msg, /you last spoke 3h 12m ago/, "…and the ELAPSED number, which is the one that teaches")
    // At the FOOT: the correction's own instruction is what the worker must act on first.
    assert.ok(msg.trimEnd().endsWith("ago."), "the clock is ntwine's footnote, not its headline")
  } finally { h.close() }
})

// THE RUNTIME AGENT ID IS THE ONE A WORKER ACTUALLY HAS. The Agent tool's launch ack hands the model
// `agentId: a01b2d20b32feab11`; the dispatch tool_use id ntwine keys the child by never appears in its
// context. A shell has answered to its runtime handle (`taskId`) since 2026-08-14; a sub-agent answered
// to only its tool_use id and label until 2026-08-28, when a worker that fenced the id it was handed was
// bumped "NOT RUNNING (nothing by that name)", re-fenced with the `toolu_…` the correction printed, and
// the maintainer asked why there were two ids (thread review-and-babysit-zod-pr-6471).
test("a sub-agent answers to the runtime agentId the worker was handed, on every reading", () => {
  const withAgent = { subAgents: [{ ...agent("reviewer", "toolu_9"), taskId: "a01b2d20b32feab11" }] }
  assert.equal(hasDeclaredBackgroundPark(parked(["a01b2d20b32feab11"], withAgent), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["toolu_9"], withAgent), NOW), true, "the tool_use id still works")
  // The waker's own live set, which is the reading that actually parks or bumps the thread.
  assert.deepEqual(
    unaccountedItems([{ kind: "agent", value: "a01b2d20b32feab11" }], {
      shells: new Set(), agents: new Set(["a01b2d20b32feab11", "toolu_9", "reviewer"]), timers: new Set(), prs: new Set(),
    }),
    [],
  )
})

test("a park naming a running sub-agent by its runtime agentId is HONOURED — no correction", async () => {
  const h = parkHarness([{ kind: "agent", value: "a01b2d20b32feab11" }, { kind: "for", value: "45m" }], {
    agents: [{ id: "toolu_A", taskId: "a01b2d20b32feab11", label: "the reviewer", startedAt: AT, state: "running" }],
  })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [], "the fence named live work by the id the worker was shown; nothing to correct")
  } finally { h.close() }
})

test("a park on a RETURNED sub-agent named by its runtime agentId reads as finished, not as a wrong fence", async () => {
  const h = parkHarness([{ kind: "agent", value: "a01b2d20b32feab11" }, { kind: "for", value: "2h" }], {
    agents: [{ id: "toolu_A", taskId: "a01b2d20b32feab11", label: "the reviewer", startedAt: AT, state: "rested" }],
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /has FINISHED/)
    assert.doesNotMatch(msg, /nothing by that name/)
  } finally { h.close() }
})

// SILENT IS NOT MISSING (2026-09-29). A sub-agent past its allowance reads `stale`: ntwine knows the id, and
// what it knows about the child is that it has written nothing for longer than its pending call declared.
// "NOT RUNNING (nothing by that name)" sent a parent hunting for a typo while the child's processes were
// alive (thread think-hard-about-this-conversation-between, three times in one evening). The wake stays —
// it is how a parent hears that a child went quiet past its word — but it says what is true.
test("a park naming a SILENT sub-agent wakes the parent with what ntwine saw, not 'nothing by that name'", async () => {
  const h = parkHarness([{ kind: "agent", value: "a2d303d9459d3b0fe" }, { kind: "for", value: "2h" }], {
    agents: [{ id: "toolu_S", taskId: "a2d303d9459d3b0fe", label: "sweep agent", startedAt: AT, state: "stale", lastActivityAt: "2026-09-29T23:11:46.530Z" }],
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /gone silent past what it declared/)
    assert.match(msg, /a2d303d9459d3b0fe.*SILENT — nothing from it since 2026-09-29T23:11:46\.530Z/s)
    assert.match(msg, /ntwine stopped nothing/)
    assert.doesNotMatch(msg, /nothing by that name/)
    assert.equal(isParkCorrection(msg), true, "still a correction the transcript folds away")
  } finally { h.close() }
})

// …and the correction's own listing prints THAT id, so what ntwine tells a worker to copy is the string it
// already recognises from its ack — not a second id it has never seen, which is what produced "why are
// there 2 ids?". The tool_use id remains accepted, since the listing printed it for two weeks.
test("the correction lists a running sub-agent by its runtime agentId, not its tool_use id", async () => {
  const h = parkHarness([{ kind: "agent", value: "bGHOST" }, { kind: "for", value: "2h" }], {
    agents: [{ id: "toolu_A", taskId: "a01b2d20b32feab11", label: "the reviewer", startedAt: AT, state: "running" }],
  })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /- `a01b2d20b32feab11`  — the reviewer/)
    assert.match(msg, /In a fence: `agents: \[a01b2d20b32feab11\]`/)
    assert.doesNotMatch(msg, /toolu_A/)
  } finally { h.close() }
})

// AN OPEN QUESTION THE FENCE DOES NOT NAME REFUSES THE PARK (2026-08-28, narrowed 2026-10-05). Until
// 2026-10-05 any open question refused every park outright (maintainer 2026-08-28: "Weird that there's
// both an awaiting block and open questions … it should not be allowed, basically"), which forced every
// later rest of a thread with an old question open to be a bare one — and the old card was redrawn under
// it as the sign-off. Now a fence may stand beside open questions by naming each one under `questions:`;
// one it leaves out is refused, so the worker names it or withdraws it.
const ELECTRON = { id: "qst_6506c36d2f28", question: "Nub still breaks Electron 34 and older — how should that flag be handled?" }
const askElectron = (h: ReturnType<typeof parkHarness>, askedAtMs = Date.now() - 90 * 60_000) =>
  h.storage.askThreadQuestion({ id: ELECTRON.id, slug: "parked", askedAtMs, spec: JSON.stringify({ question: ELECTRON.question, kind: "question", options: [{ label: "Add it only when coverage is detectable" }] }) })

test("a park that leaves an OPEN registered question unnamed is refused, even when everything it names is live", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "1h" }], { shells: [LIVE_SHELL] })
  try {
    askElectron(h)
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a live park is still not a park while it leaves a question out")
    assert.match(rows[0].fence_id, /^park:question:/)
    // NAMED, with the question's own words: the worker never saw the id ntwine minted, so the id alone
    // would not tell it which question is meant.
    assert.match(rows[0].message, /Open, and not named under `questions:`:\n- `qst_6506c36d2f28` — Nub still breaks Electron 34/)
    assert.match(rows[0].message, /`questions: \[qst_…\]`/, "…says how to keep the question")
    assert.match(rows[0].message, /`ntwinectl unask <id>`/, "…and how to drop it")
    assert.doesNotMatch(rows[0].message, /NOT RUNNING|still running/, "the live shell is not the news")
    // The transcript reads this delivery as a correction, so the refused fence stops drawing.
    assert.equal(isParkCorrection(rows[0].message), true)
    // COUNTED against the cap: a worker whose contract predates the rule re-fences at every rest.
    assert.equal(h.storage.getSession("parked")?.park_bumps, 1)
    // …and DELIVERED, through the same outbox branch as the other causes.
    assert.equal(h.sent.length, 1)
    assert.deepEqual(h.state().map((r) => r.state), ["delivered"])
  } finally { h.close() }
})

test("a park that NAMES every open question under `questions:` stands beside them", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "question", value: "QST_6506C36D2F28" }, { kind: "for", value: "1h" }], { shells: [LIVE_SHELL] })
  try {
    askElectron(h)
    await h.s.tick()
    assert.equal(h.queued().length, 0, "named (case-blind) and live: nothing to correct")
  } finally { h.close() }
})

test("a fence naming ONLY questions is a park on the human: no other name and no `for:` needed", async () => {
  const h = parkHarness([{ kind: "question", value: ELECTRON.id }], { spawnedAt: "2026-10-05T09:00:00.000Z" })
  try {
    askElectron(h)
    await h.s.tick()
    assert.equal(h.queued().length, 0, "not nameless, not missing `status:` (implied), not malformed")
    assert.equal(parkIsHonoured(readAwaitingPark([{ kind: "question", value: ELECTRON.id }]), { shells: new Set(), agents: new Set(), timers: new Set(), prs: new Set() }), true)
  } finally { h.close() }
})

test("a park naming a question that is NOT open is refused — unless it settled after the rest", async () => {
  const stale = parkHarness([{ kind: "question", value: "qst_0000deadbeef" }, { kind: "question", value: ELECTRON.id }])
  try {
    askElectron(stale)
    await stale.s.tick()
    const rows = stale.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].message, /names a question that is not open/)
    assert.match(rows[0].message, /Named, but not an open question of yours:\n- `qst_0000deadbeef`/)
    assert.doesNotMatch(rows[0].message, /Open, and not named/, "the open one IS named")
  } finally { stale.close() }

  // Answered WHILE the park stood: the fence was right when it was written, and the answer's own wake
  // carries the news — no correction.
  const answered = parkHarness([{ kind: "question", value: ELECTRON.id }])
  try {
    const q = askElectron(answered)
    answered.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: ELECTRON.question, answer: "Detect it" }), Date.now())
    await answered.s.tick()
    assert.equal(answered.queued().length, 0)
  } finally { answered.close() }
})

test("readAwaitingPark carries `questions:` lowercased, and they count as naming the human", () => {
  const park = readAwaitingPark([{ kind: "question", value: "QST_AB12" }, { kind: "question", value: "qst_cd34 — the cache call" }])
  assert.deepEqual(park.questions, ["qst_ab12", "qst_cd34"])
  assert.deepEqual(park.items, [])
  assert.equal(parkOnHuman(park), true)
  assert.equal(parkForMaxMs(park), parkForMaxMs({ ...park, questions: [], steps: ["x"] }), "the same ceiling a park on steps gets")
})

test("an ANSWERED question no longer refuses the park", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "1h" }], { shells: [LIVE_SHELL] })
  try {
    const q = h.storage.askThreadQuestion({ id: "qst_answered0001", slug: "parked", askedAtMs: Date.now() - 60_000, spec: JSON.stringify({ question: "Which store — SQLite or a JSON file?", kind: "question" }) })
    h.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "Which store — SQLite or a JSON file?", answer: "SQLite" }), Date.now())
    await h.s.tick()
    assert.equal(h.queued().length, 0, "a settled row is not a standing question")
  } finally { h.close() }
})

// A QUESTION THE HUMAN TYPED PAST HOLDS NOTHING (2026-10-14): a later fence need not name it, and one that
// does is refused like a name on a settled question — the claim would move its card down under this rest.
// A secret request is an input the worker cannot proceed without, so typing past it changes nothing.
test("a question the human typed past needs no name in a later fence, and a fence naming it is refused", async () => {
  const typedPast = { shells: [LIVE_SHELL], lastHumanAt: new Date(Date.now() - 30 * 60_000).toISOString() }
  const askedAtMs = Date.now() - 90 * 60_000
  const spec = JSON.stringify({ question: "Which store — SQLite or a JSON file?", kind: "question" })
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "1h" }], typedPast)
  try {
    h.storage.askThreadQuestion({ id: "qst_typedpast01", slug: "parked", askedAtMs, spec })
    await h.s.tick()
    assert.deepEqual(h.queued().filter((r) => isParkCorrection(r.message)), [], "left out: the park takes")
  } finally { h.close() }

  const named = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "question", value: "qst_typedpast02" }, { kind: "for", value: "1h" }], typedPast)
  try {
    named.storage.askThreadQuestion({ id: "qst_typedpast02", slug: "parked", askedAtMs, spec })
    await named.s.tick()
    const [refusal] = named.queued().filter((r) => isParkCorrection(r.message))
    assert.ok(refusal, "named: refused")
    assert.match(refusal.message, /it names a question the user typed past, so ntwine refused the park\./)
    assert.match(refusal.message, /Named, but the user typed past it — drop it; its card stays answerable where you asked it:\n- `qst_typedpast02`/)
  } finally { named.close() }

  const secret = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "1h" }], typedPast)
  try {
    secret.storage.askThreadQuestion({ id: "qst_typedpast03", slug: "parked", askedAtMs, spec: JSON.stringify({ question: "The npm code.", kind: "question", secret: true }) })
    await secret.s.tick()
    const [refusal] = secret.queued().filter((r) => isParkCorrection(r.message))
    assert.match(refusal?.message ?? "", /Open, and not named under `questions:`:\n- `qst_typedpast03`/, "a secret still has to be named")
  } finally { secret.close() }
})

// ---- `threads:` — a wait on another thread's answer -------------------------------------------------
// `message_thread` with `await_reply` REGISTERS the wait (a reply-wait timer); the fence names it by
// `@handle`, and the park check holds it to a live wait exactly as it holds every other name.
const REPLY_WAIT = (rested: string) => ({ id: "tmr_replywait01", slug: "parked", prompt: replyWaitPrompt("shell-budgets", "sb"), fireAtMs: Date.parse(rested) + 24 * 3600_000, createdAtMs: Date.parse(rested) - 60_000 })

test("a `threads:` name with a live await from this thread takes the park — by handle, slug or any casing", async () => {
  for (const name of ["@shell-budgets", "shell-budgets", "@ShellBudgets", "sb"]) {
    const h = parkHarness([{ kind: "thread", value: name }, { kind: "status", value: "watching" }, { kind: "for", value: "1h" }])
    try {
      h.storage.armThreadTimer(REPLY_WAIT(h.restedAt))
      await h.s.tick()
      assert.deepEqual(h.queued(), [], `\`threads: [${name}]\` names the live await`)
    } finally { h.close() }
  }
})

test("a `threads:` name matching no live await is refused, and the correction says how to register one", async () => {
  const h = parkHarness([{ kind: "thread", value: "@focus-mode" }, { kind: "for", value: "1h" }])
  try {
    h.storage.armThreadTimer(REPLY_WAIT(h.restedAt))
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a dead name is refused, a live wait on ANOTHER thread notwithstanding")
    assert.equal(isParkCorrection(rows[0].message), true)
    assert.match(rows[0].message, /`threads: \[@focus-mode\]` — NOT AWAITED — ask it with `ntwinectl message-thread` and `--await-reply` first/)
    assert.match(rows[0].message, /In a fence: `threads: \[@shell-budgets\]`/, "the live one is printed for the re-fence")
  } finally { h.close() }
})

// The answer CANCELS the wait the instant it is sent, so until it is delivered the fence names a wait that
// is no longer armed. Answered after the rest, that is the answer's own wake to deliver — no correction.
test("a `threads:` wait answered after the rest draws no correction; the answer is its own wake", async () => {
  const h = parkHarness([{ kind: "thread", value: "@shell-budgets" }, { kind: "for", value: "1h" }])
  try {
    h.storage.armThreadTimer(REPLY_WAIT(h.restedAt))
    assert.equal(h.storage.cancelThreadTimer("parked", "tmr_replywait01", Date.now()), true)
    await h.s.tick()
    assert.deepEqual(h.queued(), [])
  } finally { h.close() }
  // Negative control: answered BEFORE the rest, the fence named a wait that was already over.
  const before = parkHarness([{ kind: "thread", value: "@shell-budgets" }, { kind: "for", value: "1h" }])
  try {
    before.storage.armThreadTimer(REPLY_WAIT(before.restedAt))
    before.storage.cancelThreadTimer("parked", "tmr_replywait01", Date.parse(before.restedAt) - 1_000)
    await before.s.tick()
    assert.equal(before.queued().length, 1)
    assert.match(before.queued()[0].message, /ANSWERED/)
  } finally { before.close() }
})

// ---- `issues:` RETIRED (2026-10-14) ----------------------------------------------------------------
// A worker dispatched before the worker's issue watch was removed still has `issues:` in its contract.
// The key no longer parses, so it lands in the body and is bumped by name like every retired kind.
test("a fence still naming `issues:` is bumped by name, and told to end in done instead", async () => {
  const { body, hints } = splitAwaitingFrontmatter("issues: [acme/app#9]\nfor: 30d\n---\nWaiting on the reporter.")
  assert.deepEqual(hints, [{ kind: "for", value: "30d" }], "the key is not structure any more")
  const h = parkHarness(hints, { body })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:retired:/)
    assert.match(rows[0].message, /`issues:` is GONE → there is no issue wait any more/)
    assert.doesNotMatch(rows[0].message, /watch-issue/)
  } finally { h.close() }
})

test("parkForMaxMs: a sub-agent anywhere in the park caps it at the 30-minute check-in", () => {
  const at = Date.parse("2026-10-03T10:00:00Z")
  const lanes = { items: [{ kind: "agent" as const, value: "wzkorrv4u" }, { kind: "agent" as const, value: "wt5dxjxhp" }], forMs: 8 * 60 * 60_000, steps: [], questions: [] }
  assert.equal(parkForMaxMs(lanes), AGENT_PARK_FOR_MAX_MS)
  assert.equal(parkExpiresAt(lanes, at), at + AGENT_PARK_FOR_MAX_MS, "for: 8h becomes a 30-minute check-in")
  assert.equal(parkExpiresAt({ ...lanes, forMs: 10 * 60_000 }, at), at + 10 * 60_000, "a shorter for: stands as written")
  assert.equal(parkForMaxMs({ items: [{ kind: "agent", value: "a1" }, { kind: "pr", value: "acme/app#7" }], forMs: 1, steps: [], questions: [] }), AGENT_PARK_FOR_MAX_MS)
  assert.equal(parkForMaxMs({ items: [{ kind: "shell", value: "bash_1" }], forMs: 1, steps: [], questions: [] }), AWAITING_FOR_MAX_MS)
})

// ---- THE `status:` ANSWER (2026-10-01 as `needs_input:`, 2026-10-05 as `status:`) ----------------
// A worker dispatched at or after NEEDS_INPUT_REQUIRED_AT owes every park an answer to "where does this
// rest sit?". A fence without one is not a park the board will honour, so the worker is told which line
// is missing — but only once the items are right, because a fence naming dead work or none is wrong for a
// reason the answer would not fix. The older `needs_input:` line still answers it.
const NEW_CONTRACT = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString()

test("a new-contract park that gives no answer is corrected for exactly that line", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL], spawnedAt: NEW_CONTRACT })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:needs-input:/)
    assert.ok(rows[0].message.startsWith(PARK_CORRECTION_NEEDS_INPUT_LEAD))
    assert.equal(isParkCorrection(rows[0].message), true, "invisible in the chat like every other correction")
    // It teaches the three places, by the words the worker writes.
    assert.match(rows[0].message, /`status: working` — the work finishes by itself/)
    assert.match(rows[0].message, /`status: watching` — the wait is on something outside the thread/)
    assert.match(rows[0].message, /`status: needs_input` — the user can act on something now/)
    assert.match(rows[0].message, /no write-up/)
    // One per rest, however many ticks run over it.
    await h.s.tick()
    assert.equal(h.queued().length, 1)
  } finally { h.close() }
})

test("an answer ntwine cannot read is quoted back — the `status:` line it wrote, else the older one", async () => {
  for (const [hint, quoted] of [
    [{ kind: "status" as const, value: "wrking" }, "status: wrking"],
    [{ kind: "needs_input" as const, value: "yes" }, "needs_input: yes"],
  ] as const) {
    const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }, hint], { shells: [LIVE_SHELL], spawnedAt: NEW_CONTRACT })
    try {
      await h.s.tick()
      assert.ok(h.queued()[0].message.includes(`(it says \`${quoted}\`)`), quoted)
    } finally { h.close() }
  }
})

test("an answered new-contract park on live work is left alone — every `status:`, and the older line", async () => {
  for (const answer of [
    { kind: "status" as const, value: "working" },
    { kind: "status" as const, value: "watching" },
    { kind: "status" as const, value: "needs_input" },
    { kind: "needs_input" as const, value: "false" },
    { kind: "needs_input" as const, value: "true" },
  ]) {
    const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }, answer], { shells: [LIVE_SHELL], spawnedAt: NEW_CONTRACT })
    try {
      await h.s.tick()
      assert.deepEqual(h.queued(), [], `${answer.kind}: ${answer.value}`)
    } finally { h.close() }
  }
})

test("a dead name outranks a missing answer — the item correction speaks first", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL], spawnedAt: NEW_CONTRACT })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:dead:/)
    assert.doesNotMatch(rows[0].message, /gives no `status:`/)
  } finally { h.close() }
})

test("a legacy park owes no answer", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [])
  } finally { h.close() }
})

// ---- STEPS FOR THE HUMAN (2026-10-03) --------------------------------------------------------------
// `steps:` NAME THE HUMAN as the wait. The human is the one party ntwine never has to watch: the thread
// sits in their queue, and their reply is the wake — so a fence carrying only steps needs no item and no
// `for:`, and must not be bumped as one that "names nothing".

const STEPS = [{ kind: "step" as const, value: "Run `npm login`" }, { kind: "step" as const, value: "Approve the prompt" }]
const NOBODY_LIVE = { shells: new Set<string>(), agents: new Set<string>(), timers: new Set<string>(), prs: new Set<string>() }

test("a park on steps alone is honoured with no item and no for:, and runs on the human's clock", () => {
  const park = readAwaitingPark(STEPS)
  assert.deepEqual(park.steps, ["Run `npm login`", "Approve the prompt"])
  assert.equal(parkIsHonoured(park, NOBODY_LIVE), true)
  assert.equal(parkForMaxMs(park), PR_WATCH_FOR_MAX_MS, "a person's clock is not a day's")
  // An item named beside the steps must still be live: steps are not a way to park on a dead shell.
  assert.equal(parkIsHonoured(readAwaitingPark([...STEPS, { kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }]), NOBODY_LIVE), false)
  // And without steps, nothing changed: a fence naming nothing is still not a park.
  assert.equal(parkIsHonoured(readAwaitingPark([{ kind: "for", value: "2h" }]), NOBODY_LIVE), false)
})

test("SOURCE 12 leaves a steps fence alone — legacy or new contract, no for:, no status line", async () => {
  for (const spawnedAt of ["2026-08-15T11:00:00.000Z", new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString()]) {
    const h = parkHarness(STEPS, { spawnedAt, body: "The publish step runs as the maintainer." })
    try {
      await h.s.tick()
      assert.deepEqual(h.queued(), [], `nothing to correct (dispatched ${spawnedAt}): the human's reply is the wake`)
    } finally { h.close() }
  }
})

test("a steps fence with a for: that ran out sends the worker to check whether the steps happened", async () => {
  const h = parkHarness([...STEPS, { kind: "for", value: "30s" }], { restedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:expired:/)
    assert.match(rows[0].message, /`steps:` \(2\) — the user has not replied; check whether they were done anyway/)
  } finally { h.close() }
})
