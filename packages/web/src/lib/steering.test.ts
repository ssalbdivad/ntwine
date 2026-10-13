import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
import { isOptimisticallySteering, optimisticallySteered, STEER_OPTIMISM_MS } from "./steering.ts"
import { isActivelyRunning, isSnoozed, orderActive, partitionActive, sectionOf, sessionIndicatorKind } from "../groups.ts"

const at = (lastActivityAt?: string) => ({ id: "t", lastActivityAt } as unknown as ThreadView)

test("a fresh steer renders as working before the server has said anything", () => {
  const sent = 1_000_000
  // Board activity predating the steer is exactly the stale reading the hint exists to cover.
  assert.equal(isOptimisticallySteering(at(new Date(sent - 5_000).toISOString()), sent, sent + 200), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + 200), true)
})

test("server truth reclaims the row as soon as it is newer than the steer", () => {
  const sent = 1_000_000
  // Any activity stamped after the send means the tailer has looked since — whatever it reports now
  // (running, or already finished and back at rest) beats the guess.
  assert.equal(isOptimisticallySteering(at(new Date(sent + 1).toISOString()), sent, sent + 200), false)
})

test("the hint expires rather than spinning forever on a steer that produced nothing", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS - 1), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS + 1), false)
})

test("a thread that was never steered is untouched", () => {
  assert.equal(isOptimisticallySteering(at(undefined), undefined, 1_000_000), false)
})

test("an unparseable activity stamp falls back to the hint rather than throwing it away", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at("not-a-date"), sent, sent + 200), true)
})

// ── the overlay ───────────────────────────────────────────────────────────────────────────────────
// The spinner was never the point on its own: the rail's SECTION and BAND are derived, so a hint the
// indicator alone consulted left the row spinning inside the queue-ordered rested band until the
// tailer caught up. These pin that one overlay drives every derivation.

const SENT = 1_000_000
const queued = (over: Partial<ThreadView> = {}) =>
  ({
    id: "t",
    kind: "session",
    state: "open",
    status: "active",
    runtime: "turn-idle",
    needsYou: true,
    pendingQuestion: true,
    spawnedAt: new Date(SENT - 600_000).toISOString(),
    lastUserAt: new Date(SENT - 600_000).toISOString(),
    ...over,
  }) as unknown as ThreadView

test("a steered row reads as running to every rail predicate, not just the indicator", () => {
  const t = optimisticallySteered(queued(), SENT, SENT + 200)
  assert.equal(isActivelyRunning(t), true)
  assert.equal(sectionOf(t), "active")
  assert.equal(sessionIndicatorKind(t), "working")
  // The band split is `isActivelyRunning && needsYou !== true` — clearing the queue reasons the steer
  // just answered is what actually moves the row out of the rested run.
  assert.deepEqual(partitionActive(orderActive([t])).running.map((x) => x.id), ["t"])
})

test("a steered row sorts to the top of the running band, where server truth will also put it", () => {
  // The running band orders by user recency. Without the lastUserAt bump the row would enter at its
  // stale position and then hop again when the server reported this same instant.
  const older = queued({ id: "older", runtime: "running", needsYou: false, pendingQuestion: false, lastUserAt: new Date(SENT - 60_000).toISOString() })
  const steered = optimisticallySteered(queued(), SENT, SENT + 200)
  assert.deepEqual(orderActive([older, steered]).map((t) => t.id), ["t", "older"])
})

test("a steered row leaves the dimmed Snoozed band, exactly as a real turn start would", () => {
  const snoozed = queued({ needsYou: false, pendingQuestion: false, snoozedUntil: new Date(SENT + 6 * 3_600_000).toISOString() })
  assert.equal(isSnoozed(snoozed, SENT + 200), true)
  assert.equal(isSnoozed(optimisticallySteered(snoozed, SENT, SENT + 200), SENT + 200), false)
})

test("the overlay yields — expired, unsteered, and newer-server-truth rows come back BY IDENTITY", () => {
  const t = queued()
  assert.equal(optimisticallySteered(t, undefined, SENT + 200), t)
  assert.equal(optimisticallySteered(t, SENT, SENT + STEER_OPTIMISM_MS + 1), t)
  const answered = queued({ lastActivityAt: new Date(SENT + 1).toISOString() })
  assert.equal(optimisticallySteered(answered, SENT, SENT + 200), answered)
})

test("the overlay never writes lastActivityAt — that is the evidence it yields to", () => {
  // Writing it would make the hint self-sealing: isOptimisticallySteering would then read its own
  // stamp as proof the server had spoken, and the row could never be reclaimed by truth.
  const t = optimisticallySteered(queued({ lastActivityAt: new Date(SENT - 5_000).toISOString() }), SENT, SENT + 200)
  assert.equal(t.lastActivityAt, new Date(SENT - 5_000).toISOString())
  assert.equal(isOptimisticallySteering(t, SENT, SENT + 400), true)
})

// ── the server's own assertion ────────────────────────────────────────────────────────────────────
// The local stamp lives 12s in the one tab that sent the message. `deliveryInFlight` is the server
// saying the same thing — message stored, turn not started — so every tab, a reload, and a delivery
// slower than the hint draw the row as working instead of as an at-rest row in the Running band.

test("the server's in-flight flag takes the overlay with no local stamp at all", () => {
  // The server only raises it once the queue has let the thread go, so needsYou is already false.
  const rested = queued({ needsYou: false, pendingQuestion: false, deliveryInFlight: true })
  const t = optimisticallySteered(rested, undefined, SENT + 60_000)
  assert.equal(sessionIndicatorKind(t), "working")
  assert.deepEqual(partitionActive(orderActive([t])).running.map((x) => x.id), ["t"])
  // It knows no instant, so it leaves the ordering to the server's own reading.
  assert.equal(t.lastUserAt, rested.lastUserAt)
})

test("…and outlives the local hint, which is the whole reason it exists", () => {
  const rested = queued({ needsYou: false, pendingQuestion: false, deliveryInFlight: true })
  assert.equal(optimisticallySteered(rested, SENT, SENT + STEER_OPTIMISM_MS + 1).runtime, "running")
  // Control: the same row without the flag is back to its at-rest reading once the hint expires.
  const bare = queued({ needsYou: false, pendingQuestion: false })
  assert.equal(optimisticallySteered(bare, SENT, SENT + STEER_OPTIMISM_MS + 1), bare)
})
