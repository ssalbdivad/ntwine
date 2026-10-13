import { test } from "node:test"
import assert from "node:assert/strict"
import { parseScheduledRunPrompt, scheduledRunHeader, scheduledRunPrompt } from "@ntwine/shared"
import { QueryClient } from "@tanstack/react-query"
import { invalidateSchedules, proposedByLine, scheduledRunFacts, scheduleKeys, scheduleNextLabel } from "./schedules.ts"

const NOW = Date.parse("2026-10-05T12:00:00Z")
const next = (at: string) => ({ slug: "triage-issues", sessionId: "s", at, occurrenceAt: at, moved: false })

test("the row's column counts down to the next run in the house grammar", () => {
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T15:00:00Z") }, NOW), "in 3h")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-07T12:00:00Z") }, NOW), "in 2d")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T12:40:00Z") }, NOW), "in 40m")
  // Due and not started yet (a post-boot grace, the start cap): it is about to run, never "in 0s".
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T11:59:00Z") }, NOW), "now")
})

test("a schedule that will not run on its own says why instead", () => {
  assert.equal(scheduleNextLabel({ state: "proposed", nextRun: undefined }, NOW), "Proposed")
  assert.equal(scheduleNextLabel({ state: "paused", nextRun: undefined }, NOW), "Paused")
  assert.equal(scheduleNextLabel({ state: "ended", nextRun: undefined }, NOW), "Ended")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: undefined }, NOW), "Ended")
})

test("only a worker's proposal names its proposer", () => {
  assert.equal(proposedByLine("triage-bot"), "Proposed by @triage-bot")
  assert.equal(proposedByLine("human"), null)
})

test("a run's opening header names its schedule back, and anything else names none", () => {
  const header = scheduledRunHeader({
    scheduleId: "sch_0123456789ab",
    title: "Triage issues",
    describe: "every Monday at 9am",
    condition: "skip US public holidays",
    occurrenceAt: Date.parse("2026-10-12T13:00:00Z"),
    tz: "America/New_York",
    previous: { slug: "triage-issues", at: Date.parse("2026-10-05T13:00:00Z") },
  })
  const run = parseScheduledRunPrompt(scheduledRunPrompt(header, "triage new issues"))
  assert.ok(run)
  assert.equal(run.prompt, "triage new issues")
  assert.deepEqual(scheduledRunFacts(run.header), { title: "Triage issues", describe: "every Monday at 9am" })
  assert.equal(scheduledRunFacts("triage new issues"), undefined)
})

test("a delete re-reads every schedule list but never the deleted schedule's own read", () => {
  const client = new QueryClient()
  const keys = {
    list: scheduleKeys.list("p1"),
    all: scheduleKeys.all(),
    gone: scheduleKeys.get("p1", "sch_000000000001"),
    other: scheduleKeys.get("p1", "sch_000000000002"),
    page: scheduleKeys.get("page", "sch_000000000001"),
  }
  for (const key of Object.values(keys)) client.setQueryData(key, {})
  invalidateSchedules(client, "sch_000000000001")
  const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
  assert.equal(stale(keys.list), true)
  assert.equal(stale(keys.all), true)
  assert.equal(stale(keys.other), true)
  // Still mounted for the frame its sheet or drawer takes to close: a refetch would ask for what is gone.
  assert.equal(stale(keys.gone), false)
  assert.equal(stale(keys.page), false)
  // Without a delete, every read goes.
  invalidateSchedules(client)
  assert.equal(stale(keys.gone), true)
  client.clear()
})
