import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  agyMemberState,
  agySwarmMemberId,
  agySwarmRosterPath,
  agyTranscriptPath,
  agyTurnEnded,
  createAgySwarmTracker,
  type AgySwarmLiveEntry,
  type AgySwarmRetiredEntry,
  type AgySwarmSink,
} from "./agy-swarm.ts"

// Steps in agy's own transcript schema (agy 1.5.11) — every `args` value JSON-encoded, as agy writes them.
const at = (s: number) => `2026-11-20T20:39:${String(s).padStart(2, "0")}Z`
const planner = (i: number, calls: { name: string; summary?: string }[] = [], content = "") =>
  JSON.stringify({
    step_index: i, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(i), content,
    ...(calls.length ? { tool_calls: calls.map((c) => ({ name: c.name, args: c.summary ? { toolSummary: JSON.stringify(c.summary) } : {} })) } : {}),
  })
const result = (i: number, status = "DONE") => JSON.stringify({ step_index: i, source: "MODEL", type: "GENERIC", status, created_at: at(i), content: "ok" })
const system = (i: number, text: string) => JSON.stringify({ step_index: i, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: at(i), content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${at(i)} content=${text}\n</SYSTEM_MESSAGE>` })

test("agyTurnEnded: a run has stopped only on a bare reply or a DONE swarm_wait", () => {
  assert.equal(agyTurnEnded([system(0, "brief"), planner(1, [], "all done")]), true, "a final reply with no tool calls ends the turn")
  assert.equal(agyTurnEnded([planner(1, [{ name: "post_message" }, { name: "swarm_wait" }]), result(2), result(3)]), true, "a batch whose swarm_wait came back DONE parks the member")
  // swarm_wait still pending: the second result has not landed.
  assert.equal(agyTurnEnded([planner(1, [{ name: "post_message" }, { name: "swarm_wait" }]), result(2)]), false)
  // A wait that failed lets the turn go on.
  assert.equal(agyTurnEnded([planner(1, [{ name: "swarm_wait" }]), result(2, "ERROR")]), false)
  assert.equal(agyTurnEnded([planner(1, [{ name: "run_command" }]), result(2)]), false, "an ordinary tool batch is mid-turn")
  assert.equal(agyTurnEnded([planner(1, [], "done"), system(2, "[swarm] new board message #9")]), false, "a wake after the reply is a new turn")
  assert.equal(agyTurnEnded([planner(1, [], "done"), '{"step_index":2,"type":"PLAN']), false, "a torn final line reads mid-turn")
  assert.equal(agyTurnEnded([]), false)
})

test("agyMemberState: the roster's kill outranks the transcript, phase carries stopped, wake_mode is only a fallback", () => {
  assert.equal(agyMemberState({ killed: true, phase: "RUNNING" }, false), "killed")
  assert.equal(agyMemberState({ desired_state: "KILLED" }, false), "killed")
  assert.equal(agyMemberState({ phase: "KILLED" }, undefined), "killed")
  assert.equal(agyMemberState({ phase: "STOPPED" }, false), "stopped")
  // The transcript wins over wake_mode: a member woken by a background task stays `mentions` while it works.
  assert.equal(agyMemberState({ phase: "RUNNING", wake_mode: "mentions" }, false), "working")
  assert.equal(agyMemberState({ phase: "RUNNING", wake_mode: "working" }, true), "waiting")
  assert.equal(agyMemberState({ phase: "RUNNING", wake_mode: "mentions" }, undefined), "waiting")
  assert.equal(agyMemberState({ phase: "RUNNING", wake_mode: "working" }, undefined), "working")
})

const COORD = "c0000000-0000-4000-8000-000000000000"
const SCOUT = "a1111111-0000-4000-8000-000000000000"
const CRITIC = "b2222222-0000-4000-8000-000000000000"
const OLD = "d3333333-0000-4000-8000-000000000000"

type Member = { conversation_id: string; role?: string; model?: string; applied_model?: string; phase?: string; desired_state?: string; killed?: boolean; wake_mode?: string }

function swarmFixture() {
  const home = mkdtempSync(join(tmpdir(), "ntwine-agyhome-"))
  const roster = (members: { [name: string]: Member }) => {
    const path = agySwarmRosterPath(home, COORD)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ title: "Hardening", members }))
  }
  const transcript = (conv: string, lines: string[]) => {
    const path = agyTranscriptPath(home, conv)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.map((l) => l + "\n").join(""))
    return path
  }
  return { home, roster, transcript }
}

type Call = { op: "live"; id: string; entry: AgySwarmLiveEntry } | { op: "retire"; id: string; entry?: AgySwarmRetiredEntry; status: string }
function recordingSink(live: string[] = []): AgySwarmSink & { calls: Call[]; live: Set<string> } {
  const calls: Call[] = []
  const liveSet = new Set(live)
  return {
    calls,
    live: liveSet,
    setLive: (id, entry) => { liveSet.add(id); calls.push({ op: "live", id, entry }) },
    retire: (id, entry, status) => { liveSet.delete(id); calls.push({ op: "retire", id, ...(entry ? { entry } : {}), status }) },
    liveIds: () => [...liveSet],
  }
}

const running = (extra: Partial<Member> = {}): Partial<Member> => ({ phase: "RUNNING", desired_state: "RUNNING", killed: false, ...extra })

test("tracker: discovers every member but the coordinator, with its name, model, state and transcript", () => {
  const fx = swarmFixture()
  fx.roster({
    coordinator: { conversation_id: COORD, role: "coordinator", ...running({ wake_mode: "mentions" }) },
    scout: { conversation_id: SCOUT, role: "worker", applied_model: "gemini-4-neon-xhigh", ...running() },
    critic: { conversation_id: CRITIC, role: "worker", model: "claude-opus-5-5-high", ...running() },
    old: { conversation_id: OLD, role: "worker", model: "gemini-4-hydrogen-high", phase: "KILLED", desired_state: "KILLED", killed: true },
  })
  const scoutPath = fx.transcript(SCOUT, [system(0, "You have just started. Your assignment: audit the parser"), planner(1, [{ name: "run_command", summary: "Run the parser suite" }])])
  fx.transcript(CRITIC, [system(0, "review"), planner(1, [{ name: "post_message" }, { name: "swarm_wait" }]), result(2), result(3)])
  fx.transcript(OLD, [system(5, "old brief"), planner(6, [], "finished")])
  const sink = recordingSink()
  const tracker = createAgySwarmTracker({ home: fx.home, conversationId: COORD, sink })
  tracker.poll(1_000)

  // The killed member is retired FIRST (the ring is bounded and keeps the newest), straight into the ring.
  assert.deepEqual(sink.calls.map((c) => `${c.op}:${c.id}`), [`retire:${agySwarmMemberId(OLD)}`, `live:${agySwarmMemberId(SCOUT)}`, `live:${agySwarmMemberId(CRITIC)}`])
  const old = sink.calls[0] as Extract<Call, { op: "retire" }>
  assert.equal(old.status, "killed")
  assert.equal(old.entry?.name, "old")
  assert.equal(old.entry?.startedAt, at(5), "a finished member's start is its first step")
  assert.ok(old.entry?.finishedAt, "and its finish is its transcript's last write")
  const scout = sink.calls[1] as Extract<Call, { op: "live" }>
  assert.deepEqual(scout.entry, {
    name: "scout", startedAt: at(0), transcriptPath: scoutPath, state: "working",
    model: "gemini-4-neon-xhigh", activity: "run_command", activityDetail: "Run the parser suite",
  })
  const critic = sink.calls[2] as Extract<Call, { op: "live" }>
  assert.equal(critic.entry.state, "waiting")
  assert.equal(critic.entry.model, "claude-opus-5-5-high")
  assert.equal(critic.entry.activity, undefined, "a parked member is doing nothing")
  assert.deepEqual(tracker.members().map((m) => [m.name, m.state]), [["scout", "working"], ["critic", "waiting"], ["old", "killed"]])
})

test("tracker: follows a member through working → waiting → killed, and an unchanged swarm costs the sink nothing", () => {
  const fx = swarmFixture()
  const members = {
    scout: { conversation_id: SCOUT, model: "gemini-4-neon-xhigh", ...running() } as Member,
  }
  fx.roster(members)
  const path = fx.transcript(SCOUT, [system(0, "brief"), planner(1, [{ name: "run_command" }])])
  const sink = recordingSink()
  const tracker = createAgySwarmTracker({ home: fx.home, conversationId: COORD, sink, intervalMs: 1_000 })
  tracker.poll(1_000)
  assert.equal(sink.calls.length, 1)

  tracker.poll(1_500)
  assert.equal(sink.calls.length, 1, "within the interval the disk is not read")
  tracker.poll(5_000)
  assert.equal(sink.calls.length, 1, "nothing changed, nothing republished")

  // It reports and parks on the board.
  appendFileSync(path, [result(2), planner(3, [{ name: "post_message" }, { name: "swarm_wait" }]), result(4), result(5)].join("\n") + "\n")
  tracker.poll(10_000)
  assert.equal(sink.calls.length, 2)
  assert.deepEqual(sink.calls[1], { op: "live", id: agySwarmMemberId(SCOUT), entry: { name: "scout", startedAt: at(0), transcriptPath: path, state: "waiting", model: "gemini-4-neon-xhigh" } })

  // A board post wakes it: a system message after the wait is a new turn.
  appendFileSync(path, system(6, "[swarm] new board message #4") + "\n")
  tracker.poll(15_000)
  assert.equal((sink.calls[2] as Extract<Call, { op: "live" }>).entry.state, "working")

  // The coordinator kills it.
  fx.roster({ scout: { ...members.scout, phase: "KILLED", desired_state: "KILLED", killed: true } })
  tracker.poll(20_000)
  assert.deepEqual(sink.calls.slice(3).map((c) => [c.op, c.op === "retire" ? c.status : ""]), [["retire", "killed"]])
  tracker.poll(25_000)
  assert.equal(sink.calls.length, 4, "a killed member is retired once, not on every poll")
})

test("tracker: a member no transcript has reached yet is live from its first sighting, and stopped is its own reading", () => {
  const fx = swarmFixture()
  fx.roster({
    fresh: { conversation_id: SCOUT, ...running({ wake_mode: "working" }) },
    parked: { conversation_id: CRITIC, phase: "STOPPED", desired_state: "RUNNING" },
  })
  const sink = recordingSink()
  createAgySwarmTracker({ home: fx.home, conversationId: COORD, sink }).poll(Date.parse("2026-11-20T21:00:00.000Z"))
  const byName = new Map(sink.calls.map((c) => [c.op === "live" ? c.entry.name : "", c]))
  assert.deepEqual((byName.get("fresh") as Extract<Call, { op: "live" }>).entry, { name: "fresh", startedAt: "2026-11-20T21:00:00.000Z", transcriptPath: agyTranscriptPath(fx.home, SCOUT), state: "working" })
  assert.equal((byName.get("parked") as Extract<Call, { op: "live" }>).entry.state, "stopped")
})

test("tracker: rows a restored state carried in are reconciled against the roster on the first poll", () => {
  const fx = swarmFixture()
  fx.roster({ scout: { conversation_id: SCOUT, ...running() } })
  fx.transcript(SCOUT, [system(0, "brief"), planner(1, [{ name: "run_command" }])])
  const ghost = agySwarmMemberId(OLD)
  const sink = recordingSink([ghost, agySwarmMemberId(SCOUT)])
  createAgySwarmTracker({ home: fx.home, conversationId: COORD, sink }).poll(1_000)
  assert.deepEqual(sink.calls.filter((c) => c.op === "retire").map((c) => c.id), [ghost], "the member the roster no longer names is retired; the one it does is refreshed")
  assert.deepEqual([...sink.live], [agySwarmMemberId(SCOUT)])

  // With no roster at all (the thread's swarm is gone), every carried-in row retires once.
  const empty = swarmFixture()
  const orphaned = recordingSink([ghost])
  const tracker = createAgySwarmTracker({ home: empty.home, conversationId: COORD, sink: orphaned, intervalMs: 0 })
  tracker.poll(1_000)
  tracker.poll(2_000)
  assert.deepEqual(orphaned.calls, [{ op: "retire", id: ghost, status: "completed" }])
})

test("tracker: a roster caught mid-write keeps the last good reading instead of retiring the swarm", () => {
  const fx = swarmFixture()
  fx.roster({ scout: { conversation_id: SCOUT, ...running() } })
  fx.transcript(SCOUT, [system(0, "brief"), planner(1, [{ name: "run_command" }])])
  const sink = recordingSink()
  const tracker = createAgySwarmTracker({ home: fx.home, conversationId: COORD, sink, intervalMs: 0 })
  tracker.poll(1_000)
  writeFileSync(agySwarmRosterPath(fx.home, COORD), '{"title":"Hardening","members":{"scout":{"conver')
  tracker.poll(2_000)
  assert.deepEqual(sink.calls.map((c) => c.op), ["live"], "a torn roster retires nobody")
})
