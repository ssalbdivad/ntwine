import assert from "node:assert/strict"
import test from "node:test"
import { subAgentProfileLabel } from "./subAgentProfile.ts"

test("sub-agent profile readout formats provider cells without inventing missing values", () => {
  assert.equal(subAgentProfileLabel("ntwine:opus-high"), "opus › high")
  assert.equal(subAgentProfileLabel("ntwine:ntwine-sonnet-medium"), "sonnet › medium")
  assert.equal(subAgentProfileLabel("ntwine:haiku"), "haiku")
  // An effort-only profile (the shape since 2026-08-26) reads as the effort alone: the model is not in
  // the cell, and the readout does not invent one.
  assert.equal(subAgentProfileLabel("ntwine:high"), "high")
  assert.equal(subAgentProfileLabel("explorer gpt-5.6-terra/high"), "explorer · gpt-5.6-terra › high")
  assert.equal(subAgentProfileLabel("gpt-5.6-sol/ultra"), "gpt-5.6-sol › ultra")
  assert.equal(subAgentProfileLabel("general-purpose"), "general-purpose")
  assert.equal(subAgentProfileLabel(), "Profile unknown")
})

// LEGACY (shared legacy-frizz.ts; deleted with it): a transcript from before the rename names the same
// plugin's profiles in the old namespace.
test("a pre-rename frizz: profile reads like its ntwine: twin", () => {
  assert.equal(subAgentProfileLabel("frizz:frizz-sonnet-medium"), "sonnet › medium")
})
