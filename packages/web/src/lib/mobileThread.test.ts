import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
import { compactTokens, contextLine, displayUrl, effortWord, isLoopbackUrl, mobileThreadAge, mobileThreadState, turnStartedAt } from "./mobileThread.ts"

const now = Date.parse("2026-09-30T12:00:00.000Z")
const ago = (ms: number) => new Date(now - ms).toISOString()

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "t", title: "T", status: "in-progress", hasPlan: false, mechanism: null, humanBlocked: false, ready: false,
    dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false,
    archived: false, subAgents: [], bgShells: [], watches: [], pendingQuestion: false, questions: [],
    kind: "session", state: "open", ...over,
  } as ThreadView
}

test("the state word follows the board's mark, not queue membership", () => {
  // needsYou alone is every ordinary rest now — it must not turn the word into "Needs you".
  assert.equal(mobileThreadState(thread({ needsYou: true })), "rested")
  assert.equal(mobileThreadState(thread({ pendingQuestion: true })), "needs-you")
  assert.equal(mobileThreadState(thread({ runtime: "running" })), "working")
  assert.equal(mobileThreadState(thread({ runtime: "spawning" })), "working")
  assert.equal(mobileThreadState(thread({ state: "archived", archived: true })), "done")
  assert.equal(mobileThreadState(thread({ snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() })), "snoozed")
})

test("the age is the rest time at rest and the turn's length while working", () => {
  const rested = thread({ lastAssistantAt: ago(2 * 86_400_000) })
  assert.equal(mobileThreadAge(rested, "rested", undefined, now), "2d")
  const working = thread({ runtime: "running", lastActivityAt: ago(1_000) })
  assert.equal(mobileThreadAge(working, "working", ago(4 * 60_000), now), "4m")
  assert.equal(mobileThreadAge(working, "working", ago(77 * 60_000), now), "1h 17m")
})

test("the turn starts at the newest landed human-side message", () => {
  const messages = [
    { role: "user", at: ago(600_000) },
    { role: "assistant", at: ago(500_000) },
    { role: "user", at: ago(300_000) },
    { role: "assistant", at: ago(100_000) },
    { role: "user", queued: true, at: ago(1_000) },
  ]
  assert.equal(turnStartedAt(messages), ago(300_000))
  assert.equal(turnStartedAt([]), undefined)
})

test("tokens and effort read in the phone footer's short grammar", () => {
  assert.equal(compactTokens(118_234), "118k")
  assert.equal(compactTokens(288_000), "288k")
  assert.equal(compactTokens(1_000_000), "1M")
  assert.equal(compactTokens(1_250_000), "1.3M")
  assert.equal(compactTokens(512), "512")
  assert.equal(contextLine({ tokens: 118_234, window: 288_000 }), "Context 41% · 118k of 288k")
  assert.equal(contextLine(undefined), null)
  assert.equal(contextLine({ tokens: 5, window: 0 }), null)
  assert.equal(effortWord("high"), "high")
  assert.equal(effortWord("xhigh"), "x-high")
  assert.equal(effortWord(undefined), undefined)
})

test("a link to the Ntwine machine is recognised as unreachable from a phone", () => {
  assert.equal(isLoopbackUrl("http://localhost:5175/"), true)
  assert.equal(isLoopbackUrl("http://127.0.0.1:4930/x"), true)
  assert.equal(isLoopbackUrl("http://[::1]:8080/"), true)
  assert.equal(isLoopbackUrl("http://app.localhost:3000"), true)
  assert.equal(isLoopbackUrl("https://github.com/ssalbdivad/ntwine/pull/42"), false)
  assert.equal(isLoopbackUrl("not a url"), false)
  assert.equal(displayUrl("http://localhost:5175/"), "localhost:5175")
  assert.equal(displayUrl("https://github.com/ssalbdivad/ntwine/pull/42"), "github.com/ssalbdivad/ntwine/pull/42")
})

test("every row the board files in Snoozed says Snoozed, not Rested", () => {
  // A done the human parked on "Watch #N": the server reads it as a `watching` rest over the event-snooze.
  const watchedDone = thread({ waitStatus: "watching", bgSnoozed: true, lastFence: { kind: "done" } as ThreadView["lastFence"] })
  assert.equal(mobileThreadState(watchedDone), "snoozed")
  // A worker's own `status: watching` rest, and the resting card's event-snooze, park the same way.
  assert.equal(mobileThreadState(thread({ waitStatus: "watching" })), "snoozed")
  assert.equal(mobileThreadState(thread({ bgSnoozed: true })), "snoozed")
  // Negative control: the same done with no park is an ordinary rest.
  assert.equal(mobileThreadState(thread({ lastFence: { kind: "done" } as ThreadView["lastFence"] })), "rested")
  // A running turn still says Working, whatever its last rest was.
  assert.equal(mobileThreadState(thread({ waitStatus: "watching", runtime: "running" })), "working")
})
