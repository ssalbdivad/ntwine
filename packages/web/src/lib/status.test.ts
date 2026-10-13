import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@ntwine/shared"
import { canRetry } from "./status.ts"

type RecoveryInput = Pick<ThreadView, "kind" | "foreign" | "runtime" | "crashed">
const t = (over: Partial<RecoveryInput>): RecoveryInput => ({ kind: "session", foreign: false, runtime: "exited", ...over })

test("recovery actions: a crashed owned session retries", () => {
  assert.equal(canRetry(t({ crashed: true })), true)
})

test("recovery actions: an ordinary exited owned session retries too — no Dismiss verb anymore", () => {
  assert.equal(canRetry(t({ crashed: false })), true)
})

test("recovery actions: no retry for a live session", () => {
  for (const runtime of ["running", "turn-idle", "perm-prompt"] as const) {
    assert.equal(canRetry(t({ runtime, crashed: true })), false)
  }
})

test("recovery actions: foreign sessions remain read-only", () => {
  assert.equal(canRetry(t({ foreign: true, crashed: true })), false)
})

test("recovery actions: legacy file threads have no provider runtime to control", () => {
  assert.equal(canRetry(t({ kind: "legacy", crashed: true })), false)
})
