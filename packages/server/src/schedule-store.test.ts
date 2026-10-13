import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { threadIdentityName } from "@ntwine/shared"
import { createStorage, isScheduleHeldRow, type SessionRow } from "./storage.ts"
import type { ThreadScheduleRow } from "./schedule-store.ts"

const tmpStorage = () => createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-schedule-store-")), "ui.db"), "p")

const schedule = (patch: Partial<ThreadScheduleRow> = {}): ThreadScheduleRow => ({
  id: "sch_aaaaaaaaaaaa", title: "Triage issues", when_text: "every Monday at 9am", prompt: "triage new issues", condition: null,
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-05T09:00", tz: "UTC", model: "haiku", effort: "low",
  backend: "claude", state: "active", paused_reason: null, revision: 0, next_slug: null, next_occurrence_at: null,
  last_occurrence_at: null, consecutive_failures: 0, consecutive_overlaps: 0, created_by: "human", created_at: 1, updated_at: 1,
  ...patch,
})

const run = (id: string, occurrenceAt: number) => ({
  id, schedule_id: "sch_aaaaaaaaaaaa", occurrence_at: occurrenceAt, started_at: null, state: "starting" as const, reason: null,
  thread_slug: "triage-issues", session_id: "s1", owner: "me", created_at: 1,
})

const heldRow = (slug: string, patch: Partial<SessionRow> = {}): SessionRow => ({
  slug, session_id: `sess-${slug}`, thread_name: threadIdentityName(slug), spawned_at: "2026-10-05T00:00:00.000Z",
  last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title_locked: 1, title: "Triage issues",
  state: "open", snoozed_until: "2026-10-05T09:00:00.000Z", snooze_prompt: null, meta: null, seen_at: null, transcript_id: null,
  lazy_prompt: "triage new issues", held_by: "schedules", schedule_id: "sch_aaaaaaaaaaaa", ...patch,
})

test("claiming one occurrence twice records exactly one run", () => {
  const storage = tmpStorage()
  storage.insertSchedule(schedule())
  assert.equal(storage.claimScheduleRun(run("run_1", 1000), 0, 5), true)
  // The second claimant read the schedule at the SAME revision and races for the same occurrence: the
  // UNIQUE key refuses its row, and the transaction leaves the schedule alone.
  assert.equal(storage.claimScheduleRun(run("run_2", 1000), 0, 6), false)
  assert.equal(storage.listScheduleRuns("sch_aaaaaaaaaaaa", 10).length, 1)
  const after = storage.getSchedule("sch_aaaaaaaaaaaa")!
  assert.equal(after.revision, 1, "only the winning claim bumped the revision")
  assert.equal(after.last_occurrence_at, 1000)
})

test("a claim against a stale revision writes nothing — not even its run row", () => {
  const storage = tmpStorage()
  storage.insertSchedule(schedule())
  // An edit lands between the tick's read and its claim.
  assert.equal(storage.writeSchedule({ ...schedule(), prompt: "edited" }, 0, 2), true)
  assert.equal(storage.claimScheduleRun(run("run_1", 1000), 0, 5), false)
  assert.equal(storage.getScheduleRun("run_1"), undefined, "the run row rolled back with the guard")
  assert.equal(storage.getSchedule("sch_aaaaaaaaaaaa")!.revision, 1)
  // Read again, claim again: it goes through.
  assert.equal(storage.claimScheduleRun(run("run_1", 1000), 1, 5), true)
})

test("a paused schedule cannot be claimed", () => {
  const storage = tmpStorage()
  storage.insertSchedule(schedule({ state: "paused", paused_reason: "human" }))
  assert.equal(storage.claimScheduleRun(run("run_1", 1000), 0, 5), false)
  assert.equal(storage.listScheduleRuns("sch_aaaaaaaaaaaa", 10).length, 0)
})

test("last_occurrence_at only moves forward", () => {
  const storage = tmpStorage()
  storage.insertSchedule(schedule({ last_occurrence_at: 5000 }))
  assert.equal(storage.claimScheduleRun(run("run_1", 1000), 0, 5), true)
  assert.equal(storage.getSchedule("sch_aaaaaaaaaaaa")!.last_occurrence_at, 5000)
})

test("settling, summary and pruning", () => {
  const storage = tmpStorage()
  storage.insertSchedule(schedule())
  for (let i = 0; i < 5; i++) storage.insertScheduleRun({ ...run(`run_${i}`, 1000 + i), state: "skipped" })
  storage.insertScheduleRun(run("run_live", 9000))
  assert.equal(storage.settleScheduleRun("run_live", { state: "started", startedAt: 9001 }), true)
  assert.equal(storage.settleScheduleRun("run_live", { state: "failed", reason: "late" }), false, "only a starting row settles")
  assert.equal(storage.setScheduleRunSummary("run_live", "Nothing new"), true)
  assert.equal(storage.scheduleRunForThread("triage-issues")!.id !== undefined, true)
  assert.equal(storage.pruneScheduleRuns("sch_aaaaaaaaaaaa", 3), 3)
  assert.deepEqual(storage.listScheduleRuns("sch_aaaaaaaaaaaa", 10).map((r) => r.id), ["run_live", "run_4", "run_3"])
  assert.equal(storage.listScheduleRuns("sch_aaaaaaaaaaaa", 10)[0]!.summary, "Nothing new")
  assert.equal(storage.deleteSchedule("sch_aaaaaaaaaaaa"), true)
  assert.equal(storage.listScheduleRuns("sch_aaaaaaaaaaaa", 10).length, 0, "the history goes with the schedule")
})

test("the dispatch upsert that starts a schedule's held run never clears schedule_id", () => {
  const storage = tmpStorage()
  storage.upsertSession(heldRow("triage-issues"))
  assert.equal(isScheduleHeldRow(storage.getSession("triage-issues")), true)
  // What dispatch writes when it starts the held row: the same slug and session, no prompt, no snooze, and
  // neither a holder nor a schedule_id field at all.
  const { schedule_id: _drop, held_by: _holder, ...started } = heldRow("triage-issues", { lazy_prompt: null, snoozed_until: null, exited: 0 })
  storage.upsertSession(started)
  const row = storage.getSession("triage-issues")!
  assert.equal(row.schedule_id, "sch_aaaaaaaaaaaa")
  assert.equal(row.lazy_prompt, null)
  assert.equal(row.held_by, null)
  assert.equal(row.snoozed_until, null)
  assert.equal(isScheduleHeldRow(row), false, "a started run is no longer the pending next run")
})

test("snooze expiry leaves a schedule's pending next run alone, and clears every other promptless snooze", () => {
  const storage = tmpStorage()
  storage.upsertSession(heldRow("triage-issues"))
  storage.upsertSession(heldRow("plain-note", { schedule_id: null, held_by: "lazy" }))
  storage.upsertSession(heldRow("started-run", { lazy_prompt: null, held_by: null }))
  storage.clearExpiredSnoozes("2026-10-06T00:00:00.000Z")
  assert.equal(storage.getSession("triage-issues")!.snoozed_until, "2026-10-05T09:00:00.000Z")
  assert.equal(storage.getSession("plain-note")!.snoozed_until, null)
  assert.equal(storage.getSession("started-run")!.snoozed_until, null, "a STARTED run's snooze is an ordinary snooze")
})
