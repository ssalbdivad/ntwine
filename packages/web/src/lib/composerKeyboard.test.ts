import { test } from "node:test"
import assert from "node:assert/strict"
import { canInterruptAndSend, shouldInterruptSubmitComposerEnter, shouldPushQueuedComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter, shouldSubmitStagedEnter, type ComposerKeyboardEvent } from "./composerKeyboard.ts"

function key(overrides: Partial<ComposerKeyboardEvent> = {}): ComposerKeyboardEvent {
  return {
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  }
}

// THREE ENTER KEYS (maintainer 2026-08-26): Enter = the ordinary send, Shift/Option-Enter = a
// newline, ⌘/Ctrl-Enter = the forced send. These pin that the three stay disjoint in every box.

test("composer submits only a plain Enter when sending is allowed", () => {
  assert.equal(shouldSubmitComposerEnter(key(), true), true)
  assert.equal(shouldSubmitComposerEnter(key(), false), false, "empty, disabled, or busy composers leave Enter untouched")
})

test("composer Shift/Option-Enter preserve the textarea newline default", () => {
  assert.equal(shouldSubmitComposerEnter(key({ shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true }), true), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true, shiftKey: true }), true), false)
})

test("composer plain send never takes the forced chord", () => {
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ ctrlKey: true }), true), false)
})

test("composer never submits an IME composition confirmation", () => {
  assert.equal(shouldSubmitComposerEnter(key({ isComposing: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ key: "Process", isComposing: true }), true), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitComposerEnter(key({ isComposing: false, keyCode: 229 }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ keyCode: 13 }), true), true, "a real Enter keyCode still submits")
})

test("Option-Enter fallback is eligible only without Ctrl or Command", () => {
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, shiftKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, ctrlKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, metaKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, isComposing: true })), false)
})

// ---- shouldInterruptSubmitComposerEnter — ⌘/Ctrl-Enter, the FORCED send ----
// Ctrl is ⌘'s Windows/Linux twin throughout the app, so both are the forced chord and neither is
// ever a newline. The caller turns it into interrupt-and-send or a plain send; the predicate only
// keeps it disjoint from the plain Enter and from the Shift/Option newlines.

test("forced send fires on Command- or Ctrl-Enter, gated like the ordinary send", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ ctrlKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), false), false, "nothing sendable, nothing forced")
})

test("forced send never takes a keystroke the composer already owns", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key(), true), false, "a plain Enter is the ordinary send")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ shiftKey: true }), true), false, "Shift-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ altKey: true }), true), false, "Option-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, altKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ key: "a", metaKey: true }), true), false)
})

test("forced send never fires on an IME confirmation", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, isComposing: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, keyCode: 229 }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, keyCode: 13 }), true), true)
})

// ---- shouldSubmitStagedEnter — the ```question card's inputs and the typed interaction form ----
// Enter AND the forced chord both send (a waiting worker has nothing to interrupt, so "send now"
// and "send" are one act); Shift/Option-Enter stay newlines. The caller owns the staged gate.

test("a staged answer box submits on Enter and on Command- or Ctrl-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key()), true)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true })), true)
  assert.equal(shouldSubmitStagedEnter(key({ ctrlKey: true })), true)
})

test("a staged answer box takes a NEWLINE on Shift- or Option-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key({ shiftKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ altKey: true })), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, shiftKey: true })), false)
})

test("a staged answer box never submits a non-Enter key or an IME confirmation", () => {
  assert.equal(shouldSubmitStagedEnter(key({ key: "a" })), false)
  assert.equal(shouldSubmitStagedEnter(key({ isComposing: true })), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitStagedEnter(key({ keyCode: 229 })), false)
  assert.equal(shouldSubmitStagedEnter(key({ keyCode: 13 })), true)
})

// THE FORCED CHORD MAY ONLY INTERRUPT A CLAUDE TURN. A Codex follow-up steers the running turn and an
// ACP follow-up queues behind it; neither runtime is ever sent an interrupt for a message, so a
// worker's sub-agents on those backends cannot be ended by ⌘-Enter (maintainer 2026-09-24: "make sure
// that we don't kill subagents unnecessarily for Codex either. Or any of the ACPs").
test("⌘-Enter may interrupt a running Claude or ACP turn — never Codex", () => {
  assert.equal(canInterruptAndSend({ runtime: "running", backend: "claude" }, false), true)
  assert.equal(canInterruptAndSend({ runtime: "running", backend: "codex" }, false), false, "codex: the chord is a plain send that steers")
  assert.equal(canInterruptAndSend({ runtime: "running", backend: "acp" }, false), true, "acp: ⌘⏎ cancels the in-flight prompt and drains the queue")
  assert.equal(canInterruptAndSend({ runtime: "rested", backend: "claude" }, false), false, "nothing in flight to interrupt")
  assert.equal(canInterruptAndSend(undefined, false), false)
  assert.equal(canInterruptAndSend({ runtime: "running", backend: "claude" }, true), false, "a staged-answer surface sends a whole answer set")
})

// ---- shouldPushQueuedComposerEnter — ⌘/Ctrl-Enter in an EMPTY box pushes the queued message ----

test("the forced chord on an empty box pushes the queued message; anything else does not", () => {
  assert.equal(shouldPushQueuedComposerEnter(key({ metaKey: true }), true), true)
  assert.equal(shouldPushQueuedComposerEnter(key({ ctrlKey: true }), true), true)
  // A draft goes through the forced SEND instead.
  assert.equal(shouldPushQueuedComposerEnter(key({ metaKey: true }), false), false)
  // A plain, Shift or Option Enter on an empty box stays a no-op/newline.
  assert.equal(shouldPushQueuedComposerEnter(key(), true), false)
  assert.equal(shouldPushQueuedComposerEnter(key({ metaKey: true, shiftKey: true }), true), false)
  assert.equal(shouldPushQueuedComposerEnter(key({ ctrlKey: true, altKey: true }), true), false)
  assert.equal(shouldPushQueuedComposerEnter(key({ metaKey: true, isComposing: true }), true), false)
  // Disjoint from the forced send: with a draft only that one fires, with none only this one.
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), false), false)
})

test("⌘/Ctrl-Shift-Enter is neither send", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false)
})

// There is no schedule chord (ARCHITECTURE.md § Scheduled threads): the new-thread box reads its words for a schedule,
// and Enter is the one submit. ⌘/Ctrl-Option-Enter is no send and no newline repair.
test("⌘/Ctrl-Option-Enter claims nothing", () => {
  for (const chord of [key({ metaKey: true, altKey: true }), key({ ctrlKey: true, altKey: true })]) {
    assert.equal(shouldSubmitComposerEnter(chord, true), false)
    assert.equal(shouldInterruptSubmitComposerEnter(chord, true), false)
    assert.equal(shouldRestoreOptionEnterNewline(chord), false)
    assert.equal(shouldPushQueuedComposerEnter(chord, true), false)
  }
})
