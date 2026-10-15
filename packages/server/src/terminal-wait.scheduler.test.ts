// SOURCE 17 — a terminal reaching a prompt, ending, or changing hands wakes a thread waiting on it: by a
// `threads:` (or `terminals:`) fence at rest, or by `ntwinectl watch terminal`. A control move is also owed
// to the threads it touched: at once when working or waiting, else riding their next wake. Real storage (the
// watch and the notes live on the terminal's row); the terminal's process is a hand-set reading, because
// the runner's own tests own the pty. Every wake is asserted DELIVERED (`resume` ran), not merely queued:
// a wake prefix with no deliveryContext branch is queued forever and never sent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NEEDS_INPUT_REQUIRED_AT, parseMergedWake, parseTerminalControlWake, parseTerminalWake, terminalControlWakeMessage, type AwaitingHint, type ThreadTerminal } from "@ntwine/shared"
import { createStorage, type SessionRow } from "./storage.ts"
import { createScheduler } from "./scheduler.ts"
import { SIGNOFF_NUDGE_SETTING } from "./board.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const T0 = Date.parse("2026-10-15T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function row(slug: string): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, backend: "claude",
  }
}

function harness(quietMs = 0) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-term-wait-")), "ui.db"), "p")
  // A bare rest would draw the sign-off nudge in the same delivery; these tests are about SOURCE 17 alone.
  storage.setSetting(SIGNOFF_NUDGE_SETTING, "off")
  const teles = new Map<string, SessionTelemetry>()
  const tailer: Tailer = { get: (slug: string) => teles.get(slug), foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} } as unknown as Tailer
  // Each terminal's process reading, set by the test.
  const procs = new Map<string, Partial<ThreadTerminal>>()
  const resumes: { slug: string; message: string }[] = []
  const clock = { ms: T0 }
  const s = createScheduler({
    storage, tailer, now: () => clock.ms, log: () => {}, wakeQuietWindowMs: quietMs,
    resume: (slug, message) => void resumes.push({ slug, message }),
    fetchPr: async () => undefined, fetchGithubReview: async () => [],
    terminals: () => storage.listThreadTerminals().map((r) => ({
      row: r,
      terminal: { id: r.slug, command: r.command, cwd: r.cwd ?? "", state: "running", runId: r.runs, startedAt: iso(r.started_at), handle: r.handle ?? undefined, startedBy: r.started_by ?? undefined, controller: r.controller ?? r.started_by ?? "human", ...procs.get(r.slug) } as ThreadTerminal,
    })),
    terminalScreen: () => "Listening on :5173\nContinue? [y/N]",
    threadHandle: (slug) => slug,
  })
  const start = (slug: string, handle: string, startedBy: string) => {
    storage.insertThreadTerminal({ slug, parentSlug: startedBy === "human" ? null : startedBy, startedBy, handle, command: "nub run dev", cwd: "/w", shell: false, createdAtMs: clock.ms })
  }
  const rest = (slug: string, hints: AwaitingHint[] = [], turn = "idle") => teles.set(slug, {
    turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso(clock.ms),
    ...(hints.length ? { lastFence: { kind: "awaiting", body: "", hints } } : {}),
  } as SessionTelemetry)
  return { storage, procs, resumes, clock, s, start, rest }
}

const waitingOn = (name: string): AwaitingHint[] => [{ kind: "thread", value: name }, { kind: "status", value: "working" }, { kind: "for", value: "2h" }]

test("a `threads:` rest on a terminal is woken ONCE when it reaches a prompt, with the screen and how to answer", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.rest("w", waitingOn("@nub-run-dev"))
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.resumes.length, 0, "running: nothing to say")

  h.procs.set("term-1", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(parseTerminalWake(h.resumes[0].message), { handle: "nub-run-dev", event: "is waiting for input" })
  assert.match(h.resumes[0].message, /Continue\? \[y\/N\]/)
  assert.match(h.resumes[0].message, /Answer it with `ntwinectl message-thread @nub-run-dev --message-file -`/)
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "one event, one wake")
})

test("a watch wakes on an exit whatever the rest says, and is cleared from the terminal's row", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.storage.setThreadTerminalWatch("term-1", { id: "trw_a", by: "w", armedAtMs: h.clock.ms, expiresAtMs: h.clock.ms + 3_600_000 })
  h.rest("w") // a bare rest: no fence names it
  h.clock.ms += 60_000
  h.procs.set("term-1", { state: "exited", exitCode: 1, exitedAt: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(parseTerminalWake(h.resumes[0].message), { handle: "nub-run-dev", event: "FAILED (exit 1)" })
  assert.match(h.resumes[0].message, /ntwinectl terminal restart @nub-run-dev/)
  assert.equal(h.storage.listThreadTerminals()[0].watch_id, null)
})

test("a thread waits on the user's terminal like any thread's, and is told it is the user's to answer", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-h", "shell", "human")
  h.rest("w", waitingOn("@shell"))
  h.clock.ms += 60_000
  h.procs.set("term-h", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(parseTerminalWake(h.resumes[0].message), { handle: "shell", event: "is waiting for input" })
  assert.match(h.resumes[0].message, /The user drives it, so only they can answer or rerun it\./)
})

test("a watch that lapses while the terminal runs wakes the worker to re-decide", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.storage.setThreadTerminalWatch("term-1", { id: "trw_a", by: "w", armedAtMs: h.clock.ms, expiresAtMs: h.clock.ms + 60_000 })
  h.rest("w")
  h.clock.ms += 120_000
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /Your watch on the terminal @nub-run-dev has expired/)
  assert.equal(h.storage.listThreadTerminals()[0].watch_id, null)
})

test("a fence naming a terminal already at a prompt when the worker rested is corrected, not parked", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.procs.set("term-1", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  h.clock.ms += 60_000
  h.rest("w", waitingOn("@nub-run-dev"))
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(parseTerminalWake(h.resumes[0].message), null, "the prompt came before the rest: no terminal wake")
  assert.match(h.resumes[0].message, /`threads: \[@nub-run-dev\]` — WAITING FOR INPUT — read it with `ntwinectl read-thread @nub-run-dev`/)
})

// CONTROL MOVES (plans/terminal-threads.md § Control). The router writes the move and what it owes; these
// drive the scheduler's half: who is told, and when.
const take = (h: ReturnType<typeof harness>, id: string, handle: string, from: string) => {
  h.storage.setThreadTerminalController(id, "human", h.clock.ms)
  h.storage.setThreadTerminalNotes(id, [{ to: from, text: terminalControlWakeMessage({ event: "taken", handle }) }])
}

test("taking control from a WORKING thread tells it mid-turn; a resting one that does not wait on it is not woken", async () => {
  const h = harness()
  h.storage.upsertSession(row("busy"))
  h.storage.upsertSession(row("idle"))
  h.start("term-b", "dev-b", "busy")
  h.start("term-i", "dev-i", "idle")
  h.rest("busy", [], "running")
  h.rest("idle")
  h.clock.ms += 60_000
  take(h, "term-b", "dev-b", "busy")
  take(h, "term-i", "dev-i", "idle")
  await h.s.tick()
  assert.deepEqual(h.resumes.map((r) => [r.slug, parseTerminalControlWake(r.message)?.event]), [["busy", "taken"]])
  assert.deepEqual(JSON.parse(h.storage.listThreadTerminals().find((t) => t.slug === "term-i")!.control_notes!).map((n: { to: string }) => n.to), ["idle"], "still owed")
  assert.equal(h.storage.listThreadTerminals().find((t) => t.slug === "term-b")!.control_notes, null, "told")
})

test("a note owed to a resting thread rides its next wake, and is then settled", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "dev-a", "w")
  h.start("term-2", "dev-b", "w")
  h.rest("w", waitingOn("@dev-b"))
  h.clock.ms += 60_000
  take(h, "term-1", "dev-a", "w")
  await h.s.tick()
  assert.equal(h.resumes.length, 0, "it waits on @dev-b, not @dev-a: nothing yet")
  h.clock.ms += 60_000
  h.procs.set("term-2", { state: "exited", exitCode: 0, exitedAt: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  const parts = parseMergedWake(h.resumes[0].message)?.map((p) => p.body) ?? []
  assert.deepEqual([parseTerminalWake(parts[0] ?? "")?.handle, parseTerminalControlWake(parts[1] ?? "")?.event], ["dev-b", "taken"])
  assert.equal(h.storage.listThreadTerminals().find((t) => t.slug === "term-1")!.control_notes, null)
})

test("a thread watching a terminal is woken by a control move it was not party to", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.storage.upsertSession(row("watcher"))
  h.start("term-1", "dev-a", "w")
  h.storage.setThreadTerminalWatch("term-1", { id: "trw_a", by: "watcher", armedAtMs: h.clock.ms, expiresAtMs: h.clock.ms + 3_600_000 })
  h.rest("w")
  h.rest("watcher")
  h.clock.ms += 60_000
  take(h, "term-1", "dev-a", "w")
  await h.s.tick()
  assert.deepEqual(h.resumes.map((r) => [r.slug, parseTerminalControlWake(r.message)]), [["watcher", { event: "moved", handle: "dev-a", other: "human" }]])
  assert.equal(h.storage.listThreadTerminals()[0].watch_id, null, "the watch fired")
})

test("a note sent mid-turn that the quiet window holds past the turn is owed again, not a turn of its own", async () => {
  const h = harness(5 * 60_000)
  h.storage.upsertSession(row("w"))
  h.start("term-1", "dev-a", "w")
  h.start("term-2", "dev-b", "w")
  h.rest("w", waitingOn("@dev-b"))
  h.clock.ms += 60_000
  h.procs.set("term-2", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "the prompt wake opens the quiet window")
  h.rest("w", [], "running")
  take(h, "term-1", "dev-a", "w")
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "held by the quiet window")
  h.rest("w")
  h.clock.ms += 6 * 60_000
  await h.s.tick()
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "the turn it was for is over: no wake for it")
  assert.deepEqual(JSON.parse(h.storage.listThreadTerminals().find((t) => t.slug === "term-1")!.control_notes!).map((n: { to: string }) => n.to), ["w"], "owed again")
})
