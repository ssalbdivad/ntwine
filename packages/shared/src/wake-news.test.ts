// The wakes that drew ntwine's fallback prose card until 2026-10-24, read back for the one line of news
// the chat draws instead, and the pass that hides a wait-expired check-in nothing came of. Each parser is
// driven through its real composer where that composer lives in this package; the two whose composers
// live in the server (the time limit, the shell budget) are round-tripped in server/src/deadline.test.ts
// and server/src/shell-budget.test.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  commandWatchCancelledWakeMessage,
  commandWatchExpiredWakeMessage,
  commandWatchPassedWakeMessage,
  goalLimitMessage,
  interruptEndedSubAgentsMessage,
  parkExpiredWakeMessage,
  parseCommandWatchWake,
  parseGoalLimitWake,
  parseInterruptEndedWake,
  silentCheckInIndexes,
} from "./index.ts"

test("a command watch's wake carries its command back, even one that needed a longer fence", () => {
  assert.deepEqual(
    parseCommandWatchWake(commandWatchPassedWakeMessage({ id: "cmw_a1", command: "nub run test", output: "ok", runs: 3, armedMs: 120_000 })),
    { kind: "passed", id: "cmw_a1", command: "nub run test" },
  )
  assert.deepEqual(
    parseCommandWatchWake(commandWatchExpiredWakeMessage({ id: "cmw_b2", command: "grep -c '```' notes.md\ntest -f done", lastRun: { outcome: "exit", exitCode: 1, output: "" } })),
    { kind: "expired", id: "cmw_b2", command: "grep -c '```' notes.md\ntest -f done" },
  )
  assert.deepEqual(
    parseCommandWatchWake(commandWatchCancelledWakeMessage({ id: "cmw_c3", command: "curl -sf localhost:5199", reason: "the thread's sandbox changed" })),
    { kind: "cancelled", id: "cmw_c3", command: "curl -sf localhost:5199" },
  )
})

test("the interrupt note names each sub-agent it ended, with or without a runtime id", () => {
  assert.deepEqual(
    parseInterruptEndedWake(interruptEndedSubAgentsMessage([{ taskId: "a8ba0911", label: "Survey the fence grammar" }, { label: "Draft — the second pass" }])),
    { agents: [{ taskId: "a8ba0911", label: "Survey the fence grammar" }, { label: "Draft — the second pass" }] },
  )
  assert.equal(parseInterruptEndedWake("⚠️ Something else entirely.\n\n- `x` — y"), null)
})

test("a Goal that hit its limit reads back which limit and how many runs", () => {
  assert.deepEqual(parseGoalLimitWake(goalLimitMessage({ reason: "runs", runs: 5, maxRuns: 5 })), { reason: "runs", runs: 5, maxRuns: 5 })
  assert.deepEqual(parseGoalLimitWake(goalLimitMessage({ reason: "time", runs: 1, forSeconds: 7_200 })), { reason: "time", runs: 1, limit: "2h" })
  assert.deepEqual(parseGoalLimitWake(goalLimitMessage({ reason: "time", runs: 7 })), { reason: "time", runs: 7 })
})

// ---- silentCheckInIndexes ---------------------------------------------------------------------------
type Msg = { role: string; kind?: string; text: string; tools: { name: string; command?: string }[] }
const human = (text = "how's it going?"): Msg => ({ role: "user", text, tools: [] })
const rest = (): Msg => ({ role: "assistant", kind: "event", text: "Agent rested", tools: [] })
const say = (text: string, ...tools: { name: string; command?: string }[]): Msg => ({ role: "assistant", text, tools })
const checkIn = (...items: string[]): Msg => ({ role: "user", text: parkExpiredWakeMessage(items.length ? items : ["- `agents: [a8ba]` — still running"], true), tools: [] })
const fence = (extra = "") => `\`\`\`awaiting\nagents: [a8ba]\nfor: 30m${extra}\n\`\`\``
const bash = { name: "Bash", command: "git log --oneline -3" }
const ntwinectl = { name: "Bash", command: "ntwinectl watch add a8ba --for 30m" }
const silent = (messages: Msg[]) => {
  const { hidden, folded } = silentCheckInIndexes(messages)
  return { hidden: [...hidden], folded: Object.fromEntries(folded) }
}

test("a check-in answered by a bare re-park is hidden with its reply", () => {
  assert.deepEqual(silent([say("Started."), rest(), checkIn(), say(fence()), rest(), human()]), { hidden: [2, 3], folded: {} })
})

test("a short acknowledgement, ntwine's own calls and the fence's own line of prose still read as a re-park", () => {
  assert.deepEqual(
    silent([checkIn(), say("", ntwinectl), say(`Still going.\n\n${fence("\n---\nNothing has changed since the update above.")}`), rest(), human()]),
    { hidden: [0, 1, 2], folded: {} },
  )
})

test("a reply that ran a real tool, or wrote a progress note, keeps its check-in", () => {
  assert.deepEqual(silent([checkIn(), say("", bash), say(fence()), rest(), human()]), { hidden: [], folded: {} })
  const note = "The config fixes are rebased and close to reporting.\n\nThe runtime agent is part-way through the review fixes."
  assert.deepEqual(silent([checkIn(), say(`${note}\n\n${fence()}`), rest(), human()]), { hidden: [], folded: {} })
})

test("a check-in whose items moved is never hidden, however short the reply", () => {
  const moved = checkIn("- `agents: [a8ba]` — still running", "- `agents: [c3d4]` — SILENT — nothing from it since 10:02")
  assert.deepEqual(silent([moved, say(fence()), rest(), human()]), { hidden: [], folded: {} })
})

test("an unanswered question or step does not count as movement", () => {
  const waiting = checkIn("- `agents: [a8ba]` — still running", "- `questions:` (2) — not answered yet; name the ones you still need")
  assert.deepEqual(silent([waiting, say(fence()), rest(), human()]), { hidden: [0, 1], folded: {} })
})

test("a reply with no fence is not a re-park", () => {
  assert.deepEqual(silent([checkIn(), say("Still waiting."), rest(), human()]), { hidden: [], folded: {} })
})

test("the newest check-in is never hidden, and carries the count of the silent ones above it", () => {
  // Three silent check-ins, then the current rest: its fence is the live wait, so it draws, folded.
  const run = [say("Started."), rest(), checkIn(), say(fence()), rest(), checkIn(), say(fence()), rest(), checkIn(), say(fence()), rest()]
  assert.deepEqual(silent(run), { hidden: [2, 3, 5, 6], folded: { 8: 3 } })
})

test("a run of silent check-ins ended by anything else folds into nothing", () => {
  // The human spoke: the run is gone and no divider stands for it.
  assert.deepEqual(silent([checkIn(), say(fence()), rest(), checkIn(), say(fence()), rest(), human(), say("Here.")]), { hidden: [0, 1, 3, 4], folded: {} })
  // A check-in that moved after the run takes the count, since it is the next one the human sees.
  const moved = checkIn("- `agents: [a8ba]` — FINISHED — its result is waiting for you")
  assert.deepEqual(silent([checkIn(), say(fence()), rest(), moved, say("Done.", bash), rest(), human()]), { hidden: [0, 1], folded: { 3: 2 } })
})
