import { test } from "node:test"
import assert from "node:assert/strict"
import { drawsWorking, frozenPendingAsk } from "./operatorBlock.ts"

const ask = { questions: [{ question: "Which channel?", header: "Channel", multiSelect: false, options: [] }] }

test("the external-terminal question card is for a foreign session, and nothing Frizz runs", () => {
  assert.equal(frozenPendingAsk({ foreign: true, runtime: "turn-idle", pendingAsk: ask }), ask)
  // An owned thread's native ask is a card Frizz draws itself. In the instant before that card is
  // journaled, and the instant after it is answered, the fold still reports the ask — and that is
  // exactly when the terminal card used to flash.
  assert.equal(frozenPendingAsk({ runtime: "running", pendingAsk: ask }), undefined)
  assert.equal(frozenPendingAsk({ runtime: "running", pendingAsk: ask, pendingInteraction: false }), undefined)
  assert.equal(frozenPendingAsk({ foreign: true, runtime: "turn-idle", pendingAsk: ask, pendingInteraction: true }), undefined)
  assert.equal(frozenPendingAsk(undefined), undefined)
})

test("a permission block with no card on screen reads as a turn in flight", () => {
  // The state the maintainer's screenshot caught: approved, nothing pending, the server not yet caught up.
  assert.equal(drawsWorking({ runtime: "perm-prompt", pendingInteraction: false, actionableInteraction: false }, false), true)
  assert.equal(drawsWorking({ runtime: "perm-prompt" }, false), true)
  assert.equal(drawsWorking({ runtime: "running" }, true), true)
  assert.equal(drawsWorking({ runtime: "turn-idle" }, false), false)
})

test("no Working line under a card that is waiting on the operator", () => {
  assert.equal(drawsWorking({ runtime: "perm-prompt", pendingInteraction: true, actionableInteraction: true }, false), false)
  // A question card, or a Codex/ACP approval: nothing marks the runtime as blocked, so it says running.
  assert.equal(drawsWorking({ runtime: "running", pendingInteraction: true, actionableInteraction: true }, true), false)
  // Answered and on its way to the provider: the card is still readable, and the agent IS working again.
  assert.equal(drawsWorking({ runtime: "running", pendingInteraction: true, actionableInteraction: false }, true), true)
})
