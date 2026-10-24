import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { commandWatchPassedWakeMessage, compactionPromptMessage, goalLimitMessage, interruptEndedSubAgentsMessage, parkExpiredWakeMessage, questionsCancelledWakeMessage, signoffNudgeMessage, strayShellsMessage } from "@ntwine/shared"
import { NtwineWake } from "./NtwineWake.tsx"

// WHAT EACH WAKE DRAWS, as the words a reader sees (2026-10-24). The ones below printed their whole
// agent-facing body in the fallback card, or drew a line in worker-contract words, before this.
const line = (text: string, checkIns?: number) =>
  renderToStaticMarkup(createElement(NtwineWake, { text, checkIns })).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&")

test("a sign-off nudge draws nothing, in any of its variants", () => {
  assert.equal(line(signoffNudgeMessage()), "")
  assert.equal(line(strayShellsMessage([{ id: "b1", label: "vite" }])), "")
})

test("a Goal delivered after a compaction says so, rather than claiming the thread rested", () => {
  // Both readings are in the markup; a container query shows one (narrow: `Goal · compacted`).
  assert.equal(line(compactionPromptMessage("Keep going on the migration.")), "Goal · after compactionGoal · compacted")
})

test("ntwine's news about the worker's registrations and limits is one line each", () => {
  assert.equal(line(commandWatchPassedWakeMessage({ id: "cmw_a1", command: "nub run test", output: "ok", runs: 3, armedMs: 120_000 })), "Command watch «nub run test» passed")
  assert.equal(line("⏰ The user set a time limit: your deadline is now 15:30, 45m from now.\n\nPlan to the best deliverable you can hand over by then."), "Time limit set for 15:30")
  assert.equal(line("⏰ Time check: 45m left until your deadline at 15:30 (a 1h 30m budget).\n\nStart nothing new."), "Time limit · 45m left")
  assert.equal(line("⏰ Your background shell `b5htn6rlx` (vite --port 5199) has been running 31m, past its 30m budget. ntwine stops it in 2m unless you extend it."), "Agent terminal «vite --port 5199» ran past its 30m limit over 30m")
  assert.equal(line(goalLimitMessage({ reason: "runs", runs: 5, maxRuns: 5 })), "Goal stopped · 5 of 5 runs")
  assert.equal(line(interruptEndedSubAgentsMessage([{ taskId: "a1", label: "Survey" }, { label: "Draft" }])), "2 sub-agents ended by your interrupt·Click to expand")
})

test("a check-in standing for a run of silent ones says how many", () => {
  const wake = parkExpiredWakeMessage(["- `agents: [a8ba]` — still running"], true)
  assert.equal(line(wake), "Wait expired — nothing resolved·Click to expand")
  assert.equal(line(wake, 12), "Wait expired 12 times — nothing resolved·Click to expand")
})

test("cancelled questions say the agent decides, not how", () => {
  assert.equal(line(questionsCancelledWakeMessage(2)), "2 questions cancelled — the agent decides")
})
