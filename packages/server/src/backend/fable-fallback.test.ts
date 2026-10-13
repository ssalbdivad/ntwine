import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProviderQuota } from "@ntwine/shared"
import { baseNearlyOut, dispatchFallsBackToFable, fableHasHeadroom } from "./fable-fallback.ts"

function quota(windows: Record<string, number>): ProviderQuota {
  return { status: "ok", windows: Object.entries(windows).map(([key, usedPercent]) => ({ key, label: key, usedPercent })) }
}

test("a dispatch falls back to Fable only when a base window is nearly out AND Fable has room", () => {
  assert.equal(dispatchFallsBackToFable("opus", quota({ "5h": 92, weekly: 40, "weekly-fable": 30 })), true)
  assert.equal(dispatchFallsBackToFable(undefined, quota({ "5h": 10, weekly: 90, "weekly-fable": 30 })), true, "the CLI default is not Fable")
  assert.equal(dispatchFallsBackToFable("opus", quota({ "5h": 89, weekly: 40, "weekly-fable": 30 })), false, "base still has room")
  assert.equal(dispatchFallsBackToFable("opus", quota({ "5h": 95, weekly: 40, "weekly-fable": 90 })), false, "Fable is nearly spent too")
  assert.equal(dispatchFallsBackToFable("fable", quota({ "5h": 95, weekly: 40, "weekly-fable": 30 })), false, "already Fable")
})

test("only Fable's own scoped window counts as Fable budget, matched by name", () => {
  // A lone scoped window for another model is NOT Fable — scopedQuotaWindow's single-window guess must not apply.
  assert.equal(fableHasHeadroom(quota({ "5h": 95, "weekly-sonnet": 10 })), false)
  assert.equal(fableHasHeadroom(quota({ "weekly-fable-5": 10 })), true)
  assert.equal(baseNearlyOut(quota({ "weekly-fable": 99 })), false, "a scoped window is not a base window")
})

test("an unavailable reading never triggers the fallback", () => {
  const down: ProviderQuota = { status: "unavailable", windows: [] }
  assert.equal(dispatchFallsBackToFable("opus", down), false)
  assert.equal(dispatchFallsBackToFable("opus", undefined), false)
})
