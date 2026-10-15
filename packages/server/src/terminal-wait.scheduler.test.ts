// SOURCE 17 — a terminal a thread STARTED (`ntwinectl terminal start`) reaching a prompt or ending wakes that
// thread when it waits on it: by a `terminals:` fence at rest, or by `ntwinectl watch terminal`. Real
// storage (the watch lives on the terminal's row); the terminal's process is a hand-set reading, because
// the runner's own tests own the pty. Every wake is asserted DELIVERED (`resume` ran), not merely queued:
// a wake prefix with no deliveryContext branch is queued forever and never sent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NEEDS_INPUT_REQUIRED_AT, parseTerminalWake, parseTerminalWatchExpiredWake, type AwaitingHint, type ThreadTerminal } from "@ntwine/shared"
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

function harness() {
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
    storage, tailer, now: () => clock.ms, log: () => {}, wakeQuietWindowMs: 0,
    resume: (slug, message) => void resumes.push({ slug, message }),
    fetchPr: async () => undefined, fetchGithubReview: async () => [],
    terminals: () => storage.listThreadTerminals().map((r) => ({
      row: r,
      terminal: { id: r.slug, command: r.command, cwd: r.cwd ?? "", state: "running", runId: r.runs, startedAt: iso(r.started_at), handle: r.handle ?? undefined, startedBy: r.started_by ?? undefined, ...procs.get(r.slug) } as ThreadTerminal,
    })),
    terminalScreen: () => "Listening on :5173\nContinue? [y/N]",
  })
  const start = (slug: string, handle: string, startedBy: string) => {
    storage.insertThreadTerminal({ slug, parentSlug: startedBy === "human" ? null : startedBy, startedBy, handle, command: "nub run dev", cwd: "/w", shell: false, createdAtMs: clock.ms })
  }
  const rest = (slug: string, hints: AwaitingHint[] = []) => teles.set(slug, {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso(clock.ms),
    ...(hints.length ? { lastFence: { kind: "awaiting", body: "", hints } } : {}),
  } as SessionTelemetry)
  return { storage, procs, resumes, clock, s, start, rest }
}

const onTerminal = (name: string): AwaitingHint[] => [{ kind: "terminal", value: name }, { kind: "status", value: "working" }, { kind: "for", value: "2h" }]

test("a `terminals:` rest is woken ONCE when its terminal reaches a prompt, with the screen", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.rest("w", onTerminal("@nub-run-dev"))
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.resumes.length, 0, "running: nothing to say")

  h.procs.set("term-1", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(parseTerminalWake(h.resumes[0].message), { handle: "nub-run-dev", event: "is waiting for input" })
  assert.match(h.resumes[0].message, /Continue\? \[y\/N\]/)
  assert.match(h.resumes[0].message, /ntwinectl terminal send @nub-run-dev --text-file -/)
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "one event, one wake")
})

test("a watch wakes on an exit whatever the rest says, and is cleared from the terminal's row", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.storage.setThreadTerminalWatch("term-1", "trw_a", h.clock.ms + 3_600_000)
  h.rest("w") // a bare rest: no fence names it
  h.clock.ms += 60_000
  h.procs.set("term-1", { state: "exited", exitCode: 1, exitedAt: iso(h.clock.ms) })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(parseTerminalWake(h.resumes[0].message), { handle: "nub-run-dev", event: "FAILED (exit 1)" })
  assert.match(h.resumes[0].message, /ntwinectl terminal restart @nub-run-dev/)
  assert.equal(h.storage.listThreadTerminals()[0].watch_id, null)
})

test("a watch that lapses while the terminal runs wakes the worker to re-decide; a human's terminal wakes nobody", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.storage.setThreadTerminalWatch("term-1", "trw_a", h.clock.ms + 60_000)
  // The human's own terminal, named in the fence and at a prompt: not this thread's to wait on.
  h.start("term-h", "shell", "human")
  h.procs.set("term-h", { awaitingInput: true, awaitingSince: iso(h.clock.ms + 1_000) })
  h.rest("w", onTerminal("@shell"))
  h.clock.ms += 120_000
  await h.s.tick()
  // One delivery: the lapse, and the park check refusing a fence on a terminal that is not the thread's.
  assert.equal(h.resumes.length, 1)
  const [delivered] = h.resumes
  assert.match(delivered.message, /Your watch on the terminal @nub-run-dev has expired/)
  assert.match(delivered.message, /`terminals: \[@shell\]` — NOT YOURS/)
  assert.doesNotMatch(delivered.message, /Your terminal @shell/, "the human's prompt is not news to the worker")
  assert.equal(h.storage.listThreadTerminals().find((t) => t.slug === "term-1")?.watch_id, null)
})

test("a fence naming a terminal already at a prompt when the worker rested is corrected, not parked", async () => {
  const h = harness()
  h.storage.upsertSession(row("w"))
  h.start("term-1", "nub-run-dev", "w")
  h.procs.set("term-1", { awaitingInput: true, awaitingSince: iso(h.clock.ms) })
  h.clock.ms += 60_000
  h.rest("w", onTerminal("@nub-run-dev"))
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(parseTerminalWake(h.resumes[0].message), null, "the prompt came before the rest: no terminal wake")
  assert.match(h.resumes[0].message, /`terminals: \[@nub-run-dev\]` — WAITING FOR INPUT/)
})
