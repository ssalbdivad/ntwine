import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadView } from "@frizz/shared"
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
    slug, session_id: `${slug}-session`, thread_name: `frizz-${slug}`, spawned_at: at("08:00"), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("a snoozed thread let back into the queue joins the BACK, and keeps that place across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-queue-clock-"))
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
  // A terminal command sitting at a prompt since 09:55 — queued before the restart and after it.
  let command = { id: "term-abc", kind: "command", needsYou: true, spawnedAt: at("08:00"), lastUserAt: at("09:30"), lastActivityAt: at("09:55"), runtime: "running" } as unknown as ThreadView
  const deps = { now: () => nowMs, commandThreads: () => [{ ...command }] }
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath, "p")
  storage.upsertSession(row("plain"))
  storage.insertCommandThread({ slug: "term-abc", command: "npm publish", createdAtMs: Date.parse(at("09:30")) })
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
    assert.deepEqual(readAt("10:00"), { plain: at("09:50"), held: undefined, overnight: undefined, "term-abc": at("09:55") })
    readAt("12:29")
    // The snooze elapses. Keyed on its 09:00 rest it would sort ABOVE `plain`; it entered at the back.
    assert.equal(readAt("12:31").held, at("12:31"))
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"))
    assert.equal(storage.getSession("plain")?.queued_at, at("09:50"))
    assert.equal(storage.listCommandThreads().find((c) => c.slug === "term-abc")?.queued_at, at("09:55"))

    await board.stop()
    storage.close()
    storage = createStorage(dbPath, "p")
    board = createBoard(project, storage, new Bus(), tailer, "queue-boot-2", deps)
    // The boot marks the run at the prompt interrupted, which re-dates its activity to the boot. It was
    // queued before and is queued now, so its place in line must not move with it.
    command = { ...command, runtime: "exited", lastActivityAt: at("12:38") } as ThreadView
    primed = false
    for (const hhmm of ["12:38", "12:39"]) {
      assert.deepEqual(readAt(hhmm), { plain: undefined, held: undefined, overnight: undefined, "term-abc": at("09:55") }, "unprimed rows read as running")
    }
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"), "an unprimed reading is not a departure")
    primed = true
    // `overnight` has no stamp and no sighting since the boot, but the old server last watched at 12:31
    // and its rest is older than that: it was let go in the gap, so it joins the back — not 08:00's front.
    assert.deepEqual(readAt("12:40"), { plain: at("09:50"), held: at("12:31"), overnight: at("12:40"), "term-abc": at("09:55") }, "a restart keeps every place in line")

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
  const dir = mkdtempSync(join(tmpdir(), "frizz-queue-settle-"))
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
  for (const slug of ["parent", "failing", "ending"]) {
    storage.upsertSession(row(slug))
    storage.setClaudeRuntime(slug, "broker")
  }
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify" && event.kind === "needs-decision") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "queue-settle", { now: () => nowMs })
  const read = (time: string) => {
    nowMs = Date.parse(`2026-09-24T${time}.000Z`)
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, { needsYou: t.needsYou, queuedAt: t.queuedAt }]))
  }

  try {
    const before = read("10:00:00")
    assert.deepEqual([before.parent, before.ending], [{ needsYou: false, queuedAt: undefined }, { needsYou: false, queuedAt: undefined }])
    // The child returns. `failing` comes back with a hard provider error — urgent, so it goes in at once.
    // `ending`'s turn reads idle: an ordinary rest, never withheld.
    telemetry.set("parent", resting())
    telemetry.set("failing", resting({ providerError: { message: "Overloaded" } }))
    telemetry.set("ending", resting({ lastAssistantAt: "2026-09-24T09:59:59.000Z" }))
    const released = read("10:00:02")
    assert.deepEqual(released.parent, { needsYou: false, queuedAt: undefined }, "withheld while its wake lands")
    assert.deepEqual(released.failing, { needsYou: true, queuedAt: "2026-09-24T10:00:02.000Z" })
    assert.deepEqual(released.ending, { needsYou: true, queuedAt: "2026-09-24T10:00:02.000Z" })
    assert.deepEqual(notified, ["failing", "ending"])
    // No wake came: it goes in when the window closes, at the back, and only now notifies.
    assert.deepEqual(read("10:00:14").parent, { needsYou: true, queuedAt: "2026-09-24T10:00:14.000Z" })
    assert.deepEqual(notified, ["failing", "ending", "parent"])
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
