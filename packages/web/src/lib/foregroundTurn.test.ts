import assert from "node:assert/strict"
import test from "node:test"
import type { ThreadView } from "@ntwine/shared"
import { FOREGROUND_MS, longTurnReason } from "./foregroundTurn.ts"

type Turn = Pick<ThreadView, "runtime" | "subAgents" | "liveTool">
const running: Turn = { runtime: "running", subAgents: [] }
const sentAt = 1_000_000

test("a turn that only talks, reads or runs commands stays a short answer until the clock runs out", () => {
  assert.equal(longTurnReason(running, sentAt, sentAt + 10_000, ["Read", "Grep", "Bash"]), undefined)
  assert.equal(longTurnReason({ ...running, liveTool: { name: "Bash" } }, sentAt, sentAt + FOREGROUND_MS - 1), undefined)
  assert.equal(longTurnReason(running, sentAt, sentAt + FOREGROUND_MS), "time")
})

test("an edit or a dispatch is long work at once, from the transcript or the live tool", () => {
  assert.equal(longTurnReason(running, sentAt, sentAt + 2_000, ["Read", "Edit"]), "tool")
  assert.equal(longTurnReason(running, sentAt, sentAt + 2_000, ["apply_patch"]), "tool")
  assert.equal(longTurnReason({ ...running, liveTool: { name: "Agent" } }, sentAt, sentAt + 2_000), "tool")
  const child = { id: "c", label: "Cache keys", state: "running" } as unknown as ThreadView["subAgents"][number]
  assert.equal(longTurnReason({ ...running, subAgents: [child] }, sentAt, sentAt + 2_000), "agents")
})

test("a thread at rest is never long work, however old the reply", () => {
  assert.equal(longTurnReason({ runtime: "turn-idle", subAgents: [] }, sentAt, sentAt + 10 * FOREGROUND_MS, ["Edit"]), undefined)
})
