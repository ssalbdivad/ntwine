import { test } from "node:test"
import assert from "node:assert/strict"
import { manualThreadTitleSeed, threadTitleToCommit } from "./threadTitle.ts"

test("threadTitleToCommit: trims a human title and preserves empty/unchanged titles as no-ops", () => {
  assert.equal(threadTitleToCommit("  Human-readable thread title  ", "generated-slug"), "Human-readable thread title")
  assert.equal(threadTitleToCommit("   ", "Keep this"), undefined)
  assert.equal(threadTitleToCommit(" Keep this ", "Keep this"), undefined)
})

test("manualThreadTitleSeed: never seeds an editor with an internal slug or placeholder", () => {
  assert.equal(manualThreadTitleSeed("generated-slug", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Untitled thread", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Spinning up a thread…", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Readable title", "generated-slug"), "Readable title")
})
