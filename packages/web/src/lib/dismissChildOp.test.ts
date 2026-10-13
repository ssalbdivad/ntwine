import assert from "node:assert/strict"
import test from "node:test"
import { childOpDismisser, shellStopSummary } from "./dismissChildOp.ts"

// WHO GETS THE ×. The maintainer's ruling, twice over on 2026-07-30: first the × had to actually kill
// ("The fucking X button didn't actually kill the sub-agent"), then — when a background shell's × still
// cleared the row and admitted in a toast that the work was probably still going — it had to stop being
// offered at all where it cannot deliver: "We shouldn't show the X if it doesn't fucking work."
//
// So these pin the ABSENCE cases as hard as the presence ones. A missing × is the feature.

const has = (op: Parameters<typeof childOpDismisser>[1]) => childOpDismisser("t", op) !== undefined

test("a RUNNING row gets the × only when the server says it can actually be stopped", () => {
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: true }), true, "broker-backed live child: a real kill")
  assert.equal(has({ id: "toolu_a", state: "running" }), false, "no stop channel ⇒ no control, not a control that lies")
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: false }), false, "an explicit false is as binding as an absent flag")
})

test("a background SHELL is judged by the SAME rule as a sub-agent — no kind check anywhere", () => {
  // Until 2026-08-01 a running shell fell out here by CONSTRUCTION: BgShellView carried no `stoppable`
  // field, because the server refused every shell stop on the belief that ntwine held no handle on the
  // process. Measured wrong — a background Bash is a task in the registry `Query.stopTask` addresses,
  // and killing it is as real as killing a sub-agent (server/backend/_live_shell_stop.mts). The field
  // now exists on both views, and this function still cannot tell the two apart. That is the design:
  // the ×'s availability is a property of the ROW, never of what kind of thing the row is.
  assert.equal(has({ id: "toolu_sh", state: "running", stoppable: true }), true, "the exact row the maintainer could not kill")
  assert.equal(has({ id: "toolu_sh", state: "running" }), false, "a shell ntwine holds no task handle for still shows no ×")
  assert.equal(has({ id: "toolu_sh", state: "stale" }), true, "…and a finished shell can still be cleared")
})

test("a SETTLED row keeps its ×: clearing a finished op is the escape hatch, and it works everywhere", () => {
  // Withholding it here would strand a phantom row — and its Done-warning count — forever, which is
  // the original bug the × exists for. No provider control is needed to retire tracking.
  for (const state of ["stale", "rested"]) {
    assert.equal(has({ id: "toolu_a", state }), true, `${state} rows clear without needing a stop channel`)
  }
})

test("no handle, no ×: an id-less row and a descendant are both unactionable", () => {
  assert.equal(has({ state: "stale" }), false, "nothing to address the call with")
  assert.equal(has({ id: "toolu_g", state: "running", stoppable: true, depth: 2 }), false, "a descendant's dispatch lives in an ANCESTOR's transcript, so the row would not clear")
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: true, depth: 1 }), true, "depth 1 is this thread's own child")
})

// THE RESTING CARD'S STOP ends several shells in one click and reports ONCE.
test("a batch of shell stops reads as one toast, and a failure outranks the successes", () => {
  const ok = { ok: true as const, stopped: true, note: null }
  assert.equal(shellStopSummary([ok])?.text, "Agent terminal stopped — the agent was told")
  assert.equal(shellStopSummary([ok, ok])?.text, "2 agent terminals stopped — the agent was told")
  // Every shell had already finished: each stop was a clear, and the rows leaving are the feedback.
  assert.equal(shellStopSummary([{ ok: true, stopped: false, note: null }]), null)
  const failed = { ok: false as const, error: "provider refused" }
  assert.deepEqual(shellStopSummary([failed]), { text: "Couldn’t stop: provider refused", duration: 7000 })
  assert.deepEqual(shellStopSummary([ok, failed]), { text: "Stopped 1 of 2 agent terminals. Couldn’t stop the rest: provider refused", duration: 7000 })
  // The kill landed but the worker could not be told — the longer toast, as on the single ×.
  assert.deepEqual(shellStopSummary([ok, { ok: true, stopped: true, note: "The worker could not be told." }]), { text: "2 agent terminals stopped. The worker could not be told.", duration: 7000 })
})

// THE TOAST NAMES WHAT WAS STOPPED in the words its row uses: a Monitor's row, tooltip and drawer all say
// "agent monitor", and its × said "Agent terminal stopped" (verified on the stack, 2026-09-29).
test("stopping a Monitor says 'Agent monitor', a shell 'Agent terminal'", async () => {
  const { dismissChildOp } = await import("./dismissChildOp.ts")
  const { store } = await import("../store.ts")
  const api = { stopBackgroundOp: async () => ({ stopped: true, note: null, descendantsStopped: 0 }) } as unknown as Parameters<typeof dismissChildOp>[3]
  assert.equal(await dismissChildOp("t", "toolu_m", "MONITOR", api), true)
  assert.equal(store.toast?.text, "Agent monitor stopped — the agent was told")
  await dismissChildOp("t", "toolu_s", "SHELL", api)
  assert.equal(store.toast?.text, "Agent terminal stopped — the agent was told")
  const noted = { stopBackgroundOp: async () => ({ stopped: true, note: "The agent could not be told.", descendantsStopped: 0 }) } as unknown as Parameters<typeof dismissChildOp>[3]
  await dismissChildOp("t", "toolu_m", "MONITOR", noted)
  assert.equal(store.toast?.text, "Agent monitor stopped. The agent could not be told.")
})
