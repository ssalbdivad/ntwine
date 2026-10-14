import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "tomorrow", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to tomorrow", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("a stored 1d from before the tomorrow default is re-defaulted once, then sticks", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "1d", diffsRedefaulted: true })).snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "1d", diffsRedefaulted: true, snoozeRedefaulted: true })).snoozePreset, "1d")
})

test("the retired queue order is dropped from a stored blob, and everything else kept", () => {
  const parsed = parseStoredPrefs(JSON.stringify({ queueOrder: "lifo", railFilesCollapsed: true, diffsRedefaulted: true }))
  assert.equal("queueOrder" in parsed, false)
  assert.equal(parsed.railFilesCollapsed, true)
})

test("the rail's edited-files fold is open by default and only a boolean folds it", () => {
  assert.equal(parseStoredPrefs(null).railFilesCollapsed, false)
  assert.equal(parseStoredPrefs("not-json").railFilesCollapsed, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: true, diffsRedefaulted: true })).railFilesCollapsed, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: "yes", diffsRedefaulted: true })).railFilesCollapsed, false)
})

test("status lines are a hover by default; only a stored true writes them after the name", () => {
  assert.equal(parseStoredPrefs(null).alwaysShowStatusLines, false)
  assert.equal(parseStoredPrefs("not-json").alwaysShowStatusLines, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ alwaysShowStatusLines: true, diffsRedefaulted: true })).alwaysShowStatusLines, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ alwaysShowStatusLines: "yes", diffsRedefaulted: true })).alwaysShowStatusLines, false)
})

test("keyboard-shortcut overrides persist, and a bad entry falls back to its default alone", () => {
  assert.deepEqual(parseStoredPrefs(null).keybindings, {})
  assert.deepEqual(parseStoredPrefs("not-json").keybindings, {})
  assert.deepEqual(
    parseStoredPrefs(JSON.stringify({ keybindings: { "thread.snooze": "x", "thread.done": "mod+w", "nope": "x" }, diffsRedefaulted: true })).keybindings,
    { "thread.snooze": "x" },
  )
  assert.deepEqual(parseStoredPrefs(JSON.stringify({ keybindings: "garbage", diffsRedefaulted: true })).keybindings, {})
})

test("the retired per-browser code-files choice is dropped from a stored blob", () => {
  const parsed = parseStoredPrefs(JSON.stringify({ codeFiles: "editor", codeFilesRedefaulted: true, railFilesCollapsed: true, diffsRedefaulted: true }))
  assert.equal("codeFiles" in parsed, false)
  assert.equal("codeFilesRedefaulted" in parsed, false)
  assert.equal(parsed.railFilesCollapsed, true, "everything else kept")
})

test("the context bar's eye is no longer a pref: a stored value is dropped and everything else kept", () => {
  // It is the extension's ntwine.shareEditorState now (lib/editorContext.ts setShareEditor).
  assert.equal("sendEditorContext" in parseStoredPrefs(null), false)
  const older = parseStoredPrefs(JSON.stringify({ sendEditorContext: false, railFilesCollapsed: true, diffsRedefaulted: true }))
  assert.equal("sendEditorContext" in older, false)
  assert.equal(older.railFilesCollapsed, true)
})
