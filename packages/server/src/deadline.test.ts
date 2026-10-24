// The worker's deadline wakes are composed here and drawn by the chat from their heads alone
// (shared parseDeadlineWake). This pins the two together: a reworded head must fail here, not quietly
// drop the transcript back to a card of instructions addressed to the agent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDeadlineWake } from "@ntwine/shared"
import { deadlineCheckInMessage, deadlineClock, deadlineNoticeMessage } from "./deadline.ts"

const now = Date.parse("2026-10-24T14:00:00")
const d = { setAtMs: now - 3_600_000, atMs: now + 45 * 60_000, setBy: "human" as const }

test("every check-in reads back as the time left, and the last as time up", () => {
  assert.deepEqual(parseDeadlineWake(deadlineCheckInMessage("half", d, now)), { kind: "check", left: "45m" })
  assert.deepEqual(parseDeadlineWake(deadlineCheckInMessage("converge", d, now + 30 * 60_000)), { kind: "check", left: "15m" })
  assert.deepEqual(parseDeadlineWake(deadlineCheckInMessage("final", d, now + 41 * 60_000 + 40_000)), { kind: "check", left: "3m 20s" })
  assert.deepEqual(parseDeadlineWake(deadlineCheckInMessage("over", d, now + 50 * 60_000)), { kind: "over" })
})

test("the human's changes read back as what they did, with the clock they set", () => {
  const clock = deadlineClock(d.atMs, now)
  assert.deepEqual(parseDeadlineWake(deadlineNoticeMessage({ kind: "set", deadline: d }, now)), { kind: "set", clock })
  assert.deepEqual(parseDeadlineWake(deadlineNoticeMessage({ kind: "set", deadline: d, previousAtMs: d.atMs - 60_000, note: "restarting soon" }, now)), { kind: "extended", clock })
  assert.deepEqual(parseDeadlineWake(deadlineNoticeMessage({ kind: "set", deadline: d, previousAtMs: d.atMs + 60_000 }, now)), { kind: "earlier", clock })
  assert.deepEqual(parseDeadlineWake(deadlineNoticeMessage({ kind: "cleared" }, now)), { kind: "cleared" })
})
