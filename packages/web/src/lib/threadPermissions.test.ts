import { test } from "node:test"
import assert from "node:assert/strict"
import { threadComposerStatus, threadFollowUpBlocked, threadPermissionBlockedReason, threadPermissionEffectMessage } from "./threadPermissions.ts"

const state = (over: Partial<Parameters<typeof threadPermissionBlockedReason>[0]> = {}) => ({ ...over })

test("thread permission control: only idle or exited owned threads are editable", () => {
  assert.equal(threadPermissionBlockedReason(state({ runtime: "turn-idle" })), null)
  assert.equal(threadPermissionBlockedReason(state({ runtime: "exited" })), null)
  assert.match(threadPermissionBlockedReason(state({ runtime: "running" }))!, /current turn/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionPending: "bypassPermissions" }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionChangePending: true }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", profileChangePending: true }))!, /model and effort change/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", runtimeControlPending: true }))!, /runtime control/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", subAgents: [{ state: "running" }] }))!, /background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", bgShells: [{ state: "stale" }] }))!, /unresolved background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "perm-prompt" }))!, /open approval or question/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", pendingAsk: { questions: [] } }))!, /open approval or question/)
})

test("thread permission control: foreign threads remain read-only", () => {
  assert.match(threadPermissionBlockedReason(state({ foreign: true }))!, /Read-only/)
})

// The running-turn / background-work gates exist for CLAUDE's reattach, which restarts the pane. Codex
// changes its sandbox in place through thread/settings/update, which the app-server takes mid-turn — so
// those gates must not reach it, while every gate that is about SAFETY rather than the pane still does.
test("thread permission control: a running Codex turn does not disable the control", () => {
  assert.equal(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running" })), null)
  assert.equal(threadPermissionBlockedReason(state({ backend: "codex", runtime: "spawning" })), null)
  assert.equal(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", subAgents: [{ state: "running" }] })), null)
  assert.equal(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", bgShells: [{ state: "stale" }] })), null)
  // Claude keeps the strict gate, and so does a row whose backend we cannot identify.
  assert.match(threadPermissionBlockedReason(state({ backend: "claude", runtime: "running" }))!, /current turn/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "running" }))!, /current turn/)
})

test("thread permission control: Codex still fails closed on the non-pane guards", () => {
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", foreign: true }))!, /Read-only/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", permissionChangePending: true }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", permissionPending: "plan" }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", profileChangePending: true }))!, /model and effort change/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", runtimeControlPending: true }))!, /runtime control/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "perm-prompt" }))!, /open approval or question/)
  assert.match(threadPermissionBlockedReason(state({ backend: "codex", runtime: "running", pendingAsk: { questions: [] } }))!, /open approval or question/)
})

test("any durable runtime-control owner blocks follow-up submission", () => {
  assert.equal(threadFollowUpBlocked(state()), false)
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true })), true)
  assert.equal(threadFollowUpBlocked(state({ permissionPending: "default" })), true)
  assert.equal(threadFollowUpBlocked(state({ permissionChangePending: true })), true)
  assert.equal(threadFollowUpBlocked(state({ profileChangePending: true })), true)
})

test("composer status surfaces only an ancillary profile-options failure", () => {
  assert.equal(threadComposerStatus(), null)
  assert.deepEqual(threadComposerStatus(" profile lookup failed "), {
    kind: "profile-error",
    message: "Profile controls unavailable: profile lookup failed",
  })
})

test("thread permission control: feedback distinguishes a live apply from next resume", () => {
  assert.equal(threadPermissionEffectMessage("applied", "codex"), "Sandbox applied to the live session")
  assert.equal(threadPermissionEffectMessage("next-resume", "codex"), "Sandbox saved for the next resume")
  // A mid-turn change is real and durable but never reaches the turn already executing (verified live
  // against codex app-server 0.144.6), so it must not borrow the "applied to the live session" copy.
  assert.equal(threadPermissionEffectMessage("next-turn", "codex"), "Sandbox applied — takes effect on the next turn")
  assert.equal(threadPermissionEffectMessage("applied", "claude"), "Permissions applied to the live session")
  // Claude reaches "next-turn" by RETIRING the worker process — a permission mode is a launch flag
  // there, and real `claude` refuses to move a live session to bypass at all. So its sentence names the
  // restart rather than borrowing codex's retune wording: the thread just lost its process and its
  // in-memory sub-agents, and the operator has to be told that rather than discover it.
  assert.equal(threadPermissionEffectMessage("next-turn", "claude"), "Permissions saved — the worker restarts on the next turn")
  assert.equal(threadPermissionEffectMessage("next-resume", "claude"), "Permissions saved for the next resume")
})
