import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "tomorrow", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to one day", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "1d")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "1d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom", diffsRedefaulted: true })).snoozePreset, "1d")
})

test("queue order defaults to FIFO and only accepts fifo/lifo", () => {
  // Default (nothing stored / malformed) → fifo.
  assert.equal(parseStoredPrefs(null).queueOrder, "fifo")
  assert.equal(parseStoredPrefs("not-json").queueOrder, "fifo")
  // Both valid values round-trip; anything else falls back to fifo.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo", diffsRedefaulted: true })).queueOrder, "lifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "fifo", diffsRedefaulted: true })).queueOrder, "fifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "sideways", diffsRedefaulted: true })).queueOrder, "fifo")
})

test("the rail's edited-files fold is open by default and only a boolean folds it", () => {
  assert.equal(parseStoredPrefs(null).railFilesCollapsed, false)
  assert.equal(parseStoredPrefs("not-json").railFilesCollapsed, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: true, diffsRedefaulted: true })).railFilesCollapsed, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: "yes", diffsRedefaulted: true })).railFilesCollapsed, false)
})

test("keyboard-shortcut overrides persist, and a bad entry falls back to its default alone", () => {
  assert.deepEqual(parseStoredPrefs(null).keybindings, {})
  assert.deepEqual(parseStoredPrefs("not-json").keybindings, {})
  assert.deepEqual(
    parseStoredPrefs(JSON.stringify({ keybindings: { "thread.snooze": "s", "thread.done": "mod+w", "nope": "x" }, diffsRedefaulted: true })).keybindings,
    { "thread.snooze": "s" },
  )
  assert.deepEqual(parseStoredPrefs(JSON.stringify({ keybindings: "garbage", diffsRedefaulted: true })).keybindings, {})
})
