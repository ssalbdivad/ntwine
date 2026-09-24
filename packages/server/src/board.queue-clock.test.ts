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
  ])
  // False after the restart below until the test says otherwise: an unprimed row has no telemetry, and
  // a broker row with none reads as RUNNING — out of the queue — which is what a real boot looks like.
  let primed = true
  const tailer = {
    get: (slug: string) => (primed ? telemetry.get(slug) : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(at("10:00"))
  const command = { id: "term-abc", kind: "command", needsYou: true, spawnedAt: at("08:00"), lastUserAt: at("09:30"), lastActivityAt: at("09:55"), runtime: "exited" } as unknown as ThreadView
  const deps = { now: () => nowMs, commandThreads: () => [{ ...command }] }
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath, "p")
  storage.upsertSession(row("plain"))
  // Rested at 09:00, parked by the human's snooze until 12:30 — the wait that used to hand it the 09:00.
  storage.upsertSession(row("held"))
  storage.setSnoozedUntil("held", at("12:30"))
  // Broker rows, as every live Claude row is: with no telemetry one reads as RUNNING, not exited.
  for (const slug of ["plain", "held"]) storage.setClaudeRuntime(slug, "broker")
  let board = createBoard(project, storage, new Bus(), tailer, "queue-boot-1", deps)
  const readAt = (hhmm: string) => {
    nowMs = Date.parse(at(hhmm))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.queuedAt]))
  }

  try {
    assert.deepEqual(readAt("10:00"), { plain: at("09:50"), held: undefined, "term-abc": at("09:55") })
    readAt("12:29")
    // The snooze elapses. Keyed on its 09:00 rest it would sort ABOVE `plain`; it entered at the back.
    assert.equal(readAt("12:31").held, at("12:31"))
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"))
    // Only session rows persist: a command thread's rest time is already exact.
    assert.equal(storage.getSession("plain")?.queued_at, at("09:50"))

    await board.stop()
    storage.close()
    storage = createStorage(dbPath, "p")
    board = createBoard(project, storage, new Bus(), tailer, "queue-boot-2", deps)
    primed = false
    for (const hhmm of ["12:38", "12:39"]) {
      assert.deepEqual(readAt(hhmm), { plain: undefined, held: undefined, "term-abc": at("09:55") }, "unprimed rows read as running")
    }
    assert.equal(storage.getSession("held")?.queued_at, at("12:31"), "an unprimed reading is not a departure")
    primed = true
    assert.deepEqual(readAt("12:40"), { plain: at("09:50"), held: at("12:31"), "term-abc": at("09:55") }, "a restart keeps every place in line")

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
