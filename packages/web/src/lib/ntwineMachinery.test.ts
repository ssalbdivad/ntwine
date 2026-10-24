import { test } from "node:test"
import assert from "node:assert/strict"
import { carriedQuestionsNudgeMessage, mergedWakeMessage, ownWatchExpiredWakeMessage, shellDoneMessage, signoffNudgeMessage, strayShellsMessage, terminalWatchExpiredWakeMessage, type TranscriptToolCall } from "@ntwine/shared"
import type { ChatMessage } from "../hooks.ts"
import { servedMessage, wakeRendersNothing, withoutNtwineOwnCalls } from "./ntwineMachinery.ts"
import { coalesceToolActivityMessages, liveToolActivityTail } from "./toolActivity.ts"

const call = (command: string, status: TranscriptToolCall["status"] = "completed"): TranscriptToolCall => ({ name: "Bash", detail: command, command, status })
const turn = (sourceId: string, text: string, ...calls: TranscriptToolCall[]): ChatMessage =>
  ({ sourceId, role: "assistant", text, tools: calls, parts: [...(text ? [{ kind: "text" as const, text }] : []), ...(calls.length ? [{ kind: "tools" as const, tools: calls }] : [])] })

test("a sign-off nudge draws nothing in every variant that shares its marker", () => {
  assert.equal(wakeRendersNothing(signoffNudgeMessage()), true)
  assert.equal(wakeRendersNothing(strayShellsMessage([{ id: "b5htn6rlx", label: "vite" }])), true)
  assert.equal(wakeRendersNothing(carriedQuestionsNudgeMessage([{ id: "qst_1", question: "Ship it?" }])), true)
})

test("a lapsed watch on the worker's own shell, sub-agent or terminal draws nothing", () => {
  assert.equal(wakeRendersNothing(ownWatchExpiredWakeMessage("agent", "a8ba0911")), true)
  assert.equal(wakeRendersNothing(terminalWatchExpiredWakeMessage("dev-server")), true)
})

test("a merged delivery draws nothing only when every part of it is hidden", () => {
  const nudge = { reason: "sign-off nudge", message: signoffNudgeMessage() }
  const shell = { reason: "background shell finished (b1)", message: shellDoneMessage({ taskId: "b1", label: "nub run test", status: "completed" }) }
  assert.equal(wakeRendersNothing(mergedWakeMessage([nudge, { reason: "watch lapsed", message: ownWatchExpiredWakeMessage("shell", "b2") }], Date.now())), true)
  assert.equal(wakeRendersNothing(mergedWakeMessage([nudge, shell], Date.now())), false)
})

test("a successful ntwinectl call leaves the message; a failed one stays", () => {
  const done = call("ntwinectl done --body-file -")
  const refused = call("ntwinectl done --body-file -", "failed")
  const work = call("git log --oneline -3")
  const mixed = turn("m", "", done, work)
  const stripped = withoutNtwineOwnCalls(mixed)
  assert.deepEqual(stripped.tools, [work])
  assert.deepEqual(stripped.parts, [{ kind: "tools", tools: [work] }])
  // The same object on every ask, and the served message behind it, so the exchange passes still see the call.
  assert.equal(withoutNtwineOwnCalls(mixed), stripped)
  assert.equal(servedMessage(stripped), mixed)
  const kept = turn("k", "", refused)
  assert.equal(withoutNtwineOwnCalls(kept), kept)
})

test("ntwine's calls are out of the run's count and never name the live activity", () => {
  const messages = [
    turn("a", "", call("git status")),
    turn("b", "", call("ntwinectl title 'Fix the divider'")),
    turn("c", "", call("ntwinectl watch add b5htn6rlx --for 30m", "pending")),
  ].map(withoutNtwineOwnCalls)
  const entries = coalesceToolActivityMessages(messages)
  assert.deepEqual(entries.map((e) => e.message.tools.map((t) => t.command)), [["git status"]])
  // The pending call was ntwine's, so nothing is executing: the slot reads its thinking line instead.
  assert.equal(liveToolActivityTail(entries), undefined)
})
