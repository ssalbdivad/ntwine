import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

// THE QUEUE CLOCK THROUGH THE REAL BOARD: assembly stamps `queuedAt`, the session row persists it, and a
// restart reads it back — so a thread that entered the queue off a wait keeps its place at the back of
// the line instead of re-deriving its old rest time and jumping to the front. queue-clock.test.ts pins
// the rules; this pins the wiring, which is where a stamp that never reaches the wire would hide.

const at = (hhmm: string) => `2026-09-24T${hhmm}:00.000Z`

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `${slug}-session`, thread_name: `ntwine-${slug}`, spawned_at: at("08:00"), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("a snoozed thread let back into the queue joins the BACK, and keeps that place across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-queue-clock-"))
  const project: Project = { dir, id: "project-queue", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const telemetry = new Map<string, SessionTelemetry>([
    ["plain", { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("09:50") }],
    ["held", { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("09:00") }],
    ["overnight", { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("08:00") }],
  ])
  // False after the restart below until the test says otherwise. A real boot has BOTH unprimed shapes:
  // a row the tailer has not reached (no telemetry at all) and one it has set up but not folded yet (a
  // fresh state, `turn: "in-flight"`, `primed: false`). A broker row read off either is RUNNING.
  let primed = true
  const halfBuilt: SessionTelemetry = { turn: "in-flight", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, primed: false }
  const tailer = {
    get: (slug: string) => (primed ? telemetry.get(slug) : slug === "held" ? halfBuilt : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(at("10:00"))
  const deps = { now: () => nowMs }
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath, "p")
  // These rests stand for ordinary queue arrivals, so the sign-off reminder is off: a bare rest it is
  // about to take is held out of the queue, which has its own test in board.test.ts.
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession(row("plain"))
  // Rested at 09:00, parked by the human's snooze until 12:30 — the wait that used to hand it the 09:00.
  storage.upsertSession(row("held"))
  storage.setSnoozedUntil("held", at("12:30"))
  // Rested at 08:00 and snoozed past the restart below: its snooze runs out while no server is watching.
  storage.upsertSession(row("overnight"))
  storage.setSnoozedUntil("overnight", at("12:35"))
  // Broker rows, as every live Claude row is: with no telemetry one reads as RUNNING, not exited.
  for (const slug of ["plain", "held", "overnight"]) storage.setClaudeRuntime(slug, "broker")
  let board = createBoard(project, storage, new Bus(), tailer, "queue-boot-1", deps)
  const readAt = (hhmm: string) => {
    nowMs = Date.parse(at(hhmm))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.queuedAt]))
  }

  try {
    assert.deepEqual(readAt("10:00"), { plain: at("09:50"), held: undefined, overnight: undefined })
    readAt("12:29")
    // The snooze elapses. Keyed on its 09:00 rest it would sort ABOVE `plain`; it entered at the back.
    assert.equal(readAt("12:31").held, at("12:31"))
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"))
    assert.equal(storage.getSession("plain")?.queued_at, at("09:50"))

    await board.stop()
    storage.close()
    storage = createStorage(dbPath, "p")
    // These rests stand for ordinary queue arrivals, so the sign-off reminder is off: a bare rest it is
    // about to take is held out of the queue, which has its own test in board.test.ts.
    storage.setSetting("signoffNudge", "off")
    board = createBoard(project, storage, new Bus(), tailer, "queue-boot-2", deps)
    primed = false
    // Unprimed rows read as running, but the ones with a place in line keep SHOWING it until the tailer
    // vouches for a reading — a queue that blinked empty for the prime would move every card on screen.
    for (const hhmm of ["12:38", "12:39"]) {
      assert.deepEqual(readAt(hhmm), { plain: at("09:50"), held: at("12:31"), overnight: undefined }, "unprimed rows hold their place")
      assert.ok(board.refresh().threads.filter((t) => t.id === "plain" || t.id === "held").every((t) => t.needsYou === true), "and stay queued")
    }
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"), "an unprimed reading is not a departure")
    primed = true
    // `overnight` has no stamp and no sighting since the boot, but the old server last watched at 12:31
    // and its rest is older than that: it was let go in the gap, so it joins the back — not 08:00's front.
    assert.deepEqual(readAt("12:40"), { plain: at("09:50"), held: at("12:31"), overnight: at("12:40") }, "a restart keeps every place in line")

    // Marked done: out of the queue, and the stored stamp goes with it.
    storage.setState("plain", "archived")
    readAt("12:41")
    assert.equal(storage.getSession("plain")?.queued_at, null)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a parent let go by its sub-agent is withheld while its wake lands, and neither queues nor notifies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-queue-settle-"))
  const project: Project = { dir, id: "project-settle", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const child = { id: "toolu_child", label: "Review the diff", startedAt: at("09:00"), state: "running" as const }
  const resting = (over: Partial<SessionTelemetry> = {}): SessionTelemetry =>
    ({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("09:00"), ...over })
  // Both rested at 09:00 with a sub-agent still running: out of the queue, at rest — parked. `ending` is
  // mid-turn, and its final message is already folded while its turn still reads in flight (a Stop hook
  // running): the same rest before and after, but it was last seen out RUNNING, not parked.
  const telemetry = new Map<string, SessionTelemetry>([
    ["parent", resting({ subAgents: [child] })],
    ["failing", resting({ subAgents: [child] })],
    ["ending", resting({ turn: "in-flight", lastAssistantAt: "2026-09-24T09:59:59.000Z" })],
    // A plain rest in the queue that the human answers below.
    ["sent", resting({ lastAssistantAt: "2026-09-24T09:30:00.000Z" })],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(at("10:00"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // These rests stand for ordinary queue arrivals, so the sign-off reminder is off: a bare rest it is
  // about to take is held out of the queue, which has its own test in board.test.ts.
  storage.setSetting("signoffNudge", "off")
  for (const slug of ["parent", "failing", "ending", "sent"]) {
    storage.upsertSession(row(slug))
    storage.setClaudeRuntime(slug, "broker")
  }
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify" && event.kind === "needs-decision") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "queue-settle", { now: () => nowMs })
  const read = (time: string) => {
    nowMs = Date.parse(`2026-09-24T${time}.000Z`)
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, { needsYou: t.needsYou, queuedAt: t.queuedAt, settling: t.queueSettling }]))
  }

  try {
    const before = read("10:00:00")
    assert.deepEqual([before.parent, before.ending], [{ needsYou: false, queuedAt: undefined, settling: undefined }, { needsYou: false, queuedAt: undefined, settling: undefined }])
    // The human sends `sent` a follow-up: the delivery holds it out of the queue, at rest.
    const item = { id: "d1", text: "Rebase it", state: "delivered", at: "2026-09-24T10:00:01.000Z", updatedAt: "2026-09-24T10:00:01.000Z" }
    storage.setDeliveryLedger("sent", JSON.stringify([item]))
    assert.equal(read("10:00:01").sent.needsYou, false)
    // The child returns. `failing` comes back with a hard provider error — urgent, so it goes in at once.
    // `ending`'s turn reads idle: an ordinary rest, never withheld.
    telemetry.set("parent", resting())
    telemetry.set("failing", resting({ providerError: { message: "Overloaded" } }))
    telemetry.set("ending", resting({ lastAssistantAt: "2026-09-24T09:59:59.000Z" }))
    // …and the send is lost (the daemon refused it): no wake follows a lost message, so it comes straight
    // back rather than being withheld like a release.
    storage.setDeliveryLedger("sent", null)
    const released = read("10:00:02")
    assert.deepEqual(released.parent, { needsYou: false, queuedAt: undefined, settling: true }, "withheld while its wake lands")
    assert.deepEqual(released.failing, { needsYou: true, queuedAt: "2026-09-24T10:00:02.000Z", settling: undefined })
    assert.deepEqual(released.ending, { needsYou: true, queuedAt: "2026-09-24T10:00:02.000Z", settling: undefined })
    assert.deepEqual(released.sent, { needsYou: true, queuedAt: "2026-09-24T10:00:02.000Z", settling: undefined })
    assert.deepEqual([...notified].sort(), ["ending", "failing", "sent"])
    // No wake came: it goes in when the window closes, at the back, and only now notifies.
    assert.deepEqual(read("10:00:14").parent, { needsYou: true, queuedAt: "2026-09-24T10:00:14.000Z", settling: undefined })
    assert.deepEqual(notified.slice(3), ["parent"])
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a thread woken by its own work keeps its place in line; one the human sent a follow-up to goes to the back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-queue-keep-"))
  const project: Project = { dir, id: "project-keep", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const iso = (time: string) => `2026-09-24T${time}.000Z`
  const tele = (turn: "idle" | "in-flight", rested: string): SessionTelemetry =>
    ({ turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso(rested) })
  // Queued oldest first: `reading` (the card being read), `steered`, `later`, and `asked`, frozen on a
  // native question the human answers below.
  const ask = { id: "toolu_ask", questions: [{ question: "Which registry?", header: "Registry", options: [{ label: "npm" }, { label: "jsr" }], multiSelect: false }] }
  const telemetry = new Map<string, SessionTelemetry>([
    ["reading", tele("idle", "09:30:00")],
    ["steered", tele("idle", "09:40:00")],
    ["later", tele("idle", "09:45:00")],
    ["asked", { ...tele("idle", "09:50:00"), pendingAsk: ask } as SessionTelemetry],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(iso("10:00:00"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // These rests stand for ordinary queue arrivals, so the sign-off reminder is off: a bare rest it is
  // about to take is held out of the queue, which has its own test in board.test.ts.
  storage.setSetting("signoffNudge", "off")
  for (const slug of telemetry.keys()) {
    storage.upsertSession(row(slug))
    storage.setClaudeRuntime(slug, "broker")
  }
  const board = createBoard(project, storage, new Bus(), tailer, "queue-keep", { now: () => nowMs })
  const read = (time: string) => {
    nowMs = Date.parse(iso(time))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.queuedAt]))
  }

  try {
    assert.deepEqual(read("10:00:00"), { reading: iso("09:30:00"), steered: iso("09:40:00"), later: iso("09:45:00"), asked: iso("09:50:00") })
    // A shell of `reading`'s finishes and wakes it; the human sends `steered` a follow-up, which the router
    // records in the delivery ledger before its worker picks it up.
    telemetry.set("reading", tele("in-flight", "09:30:00"))
    storage.setDeliveryLedger("steered", JSON.stringify([{ id: "d1", text: "Rebase it", state: "delivered", at: iso("10:00:30"), updatedAt: iso("10:00:30") }]))
    // …and answers `asked`'s question, which lets its turn go on.
    telemetry.set("asked", tele("in-flight", "09:50:00"))
    assert.deepEqual(read("10:00:31"), { reading: undefined, steered: undefined, later: iso("09:45:00"), asked: undefined })
    // The send lands and both turns run, then both rest again.
    storage.setDeliveryLedger("steered", null)
    telemetry.set("steered", tele("in-flight", "09:40:00"))
    read("10:00:40")
    telemetry.set("reading", tele("idle", "10:01:00"))
    telemetry.set("steered", tele("idle", "10:01:10"))
    telemetry.set("asked", tele("idle", "10:01:15"))
    assert.deepEqual(read("10:01:20"), { reading: iso("09:30:00"), steered: iso("10:01:10"), later: iso("09:45:00"), asked: iso("10:01:15") })
    assert.equal(storage.getSession("reading")?.queued_at, iso("09:30:00"), "and the place it took back is persisted")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
