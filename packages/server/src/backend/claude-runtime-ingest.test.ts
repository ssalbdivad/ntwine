import { test } from "node:test"
import assert from "node:assert/strict"
import { createReceiptBus } from "@ntwine/shared"
import { createClaudeRuntimeIngest, resolveRuntimeTurn, type ClaudeRuntimeReceipt } from "./claude-runtime-ingest.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

// ---- resolveRuntimeTurn: the invariant, in isolation --------------------------------------------
// This function is the entire licence the provider's turn reading has to affect the board. Every case
// is enumerated here because the ones that must NOT change anything are as load-bearing as the ones
// that must.

test("resolveRuntimeTurn: no runtime signal changes nothing, ever", () => {
  assert.equal(resolveRuntimeTurn("idle", false, undefined), "idle")
  assert.equal(resolveRuntimeTurn("in-flight", false, undefined), "in-flight")
  assert.equal(resolveRuntimeTurn("in-flight", true, undefined), "in-flight")
})

test("resolveRuntimeTurn: `running` pulls a folded idle forward to in-flight", () => {
  // Safe in the only direction that matters — it can never fire a premature turn-done.
  assert.equal(resolveRuntimeTurn("idle", false, "running"), "in-flight")
})

test("resolveRuntimeTurn: `settled` short-circuits ONLY the backstop guess", () => {
  assert.equal(resolveRuntimeTurn("in-flight", true, "settled"), "idle")
})

test("resolveRuntimeTurn: `settled` NEVER overrides folded evidence", () => {
  // The fold reading in-flight on real evidence (an unresolved tool_use, or a trailing user record)
  // means the SDK is simply ahead of the disk. Trusting it here would queue the thread before its
  // final message — and its signal fence — had been folded.
  assert.equal(resolveRuntimeTurn("in-flight", false, "settled"), "in-flight")
})

// The second report of the resting-thread shimmer (2026-07-30). `running` outranks a folded `idle` for
// exactly one reason — the SDK's socket beats its own disk write by ~100-140 ms — so a reading that has
// stopped advancing has no claim on the board at all. Unbounded, one stale "running" pinned four rested
// threads at "Working…" for the whole life of the server process, because the turn was already over and
// no `result` was ever coming to clear it.
test("resolveRuntimeTurn: a STALE `running` stops outranking a folded idle", () => {
  assert.equal(resolveRuntimeTurn("idle", false, "running", 0), "in-flight", "fresh: the disk is behind")
  assert.equal(resolveRuntimeTurn("idle", false, "running", 29_000), "in-flight", "still inside the window")
  assert.equal(resolveRuntimeTurn("idle", false, "running", 31_000), "idle", "half a minute is not write lag")
  // The bound is on THIS rule alone. A folded tool_use is real evidence and still wins at any age…
  assert.equal(resolveRuntimeTurn("in-flight", false, "running", 10 * 60_000), "in-flight")
  assert.equal(resolveRuntimeTurn("in-flight", false, "settled", 10 * 60_000), "in-flight")
  // …and a stale `settled` only ever agrees with a fold that already reads idle, so it needs no bound.
  assert.equal(resolveRuntimeTurn("in-flight", true, "settled", 10 * 60_000), "idle")
})

test("resolveRuntimeTurn: a negative age (an injected clock behind the wall clock) reads as FRESH", () => {
  // The tailer clamps at 0 before calling; assert the contract from this side too, because a reading
  // treated as ancient by clock skew would silently disable the override the fold depends on.
  assert.equal(resolveRuntimeTurn("idle", false, "running", 0), "in-flight")
})

test("resolveRuntimeTurn: `running` never un-settles a folded idle... except to in-flight", () => {
  // Exhaustive over the remaining pairs, so a future edit that widens the rule fails here first.
  assert.equal(resolveRuntimeTurn("idle", false, "settled"), "idle")
  assert.equal(resolveRuntimeTurn("in-flight", true, "running"), "in-flight")
})

// ---- the ingest itself ---------------------------------------------------------------------------

const sessionId = "s1"
const ev = {
  init: { kind: "init", protocolVersion: 1, sessionId, messageId: "i", claudeCodeVersion: "x", cwd: "/", model: "m", permissionMode: "default", tools: [], mcpServers: [], slashCommands: [], skills: [], plugins: [], capabilities: [] },
  assistant: { kind: "assistant", sessionId, messageId: "a", text: ["hi"], toolUses: [], supersedes: [] },
  user: { kind: "user", sessionId, messageId: "u", text: ["go"], toolResultIds: [], synthetic: false },
  // The same two events as a background CHILD emits them: addressed to the dispatch that started it.
  childAssistant: { kind: "assistant", sessionId, messageId: "ca", parentToolUseId: "toolu_child", text: ["working"], toolUses: [], supersedes: [] },
  childUser: { kind: "user", sessionId, messageId: "cu", parentToolUseId: "toolu_child", text: ["result"], toolResultIds: ["toolu_x"], synthetic: false },
  result: { kind: "result", sessionId, messageId: "r", subtype: "success", isError: false, errors: [] },
  resultError: { kind: "result", sessionId, messageId: "r", subtype: "error_during_execution", isError: true, errors: ["boom"] },
  other: { kind: "other", type: "system", sessionId },
} satisfies Record<string, ClaudeQueryEvent>

test("ingest: every event nudges — including the ones that carry no turn meaning", async () => {
  const nudged: string[] = []
  const ingest = createClaudeRuntimeIngest({ nudge: (slug) => nudged.push(slug) })
  ingest.onEvent("t", sessionId, ev.init)
  ingest.onEvent("t", sessionId, ev.other)
  await ingest.drain()
  assert.deepEqual(nudged, ["t", "t"], "an `other` event still means a record just hit disk")
  ingest.close()
})

test("ingest: assistant/user mean running, result means settled", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.user)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")

  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")

  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running", "a new turn re-opens it")
  ingest.close()
})

// The resting-fleet-parent regression (reported 2026-07-30, reproduced live by _live_bg_rest_turn.mts).
// A worker that dispatches with `run_in_background: true` and rests keeps receiving its CHILD's events
// for as long as the child lives — 18 of them over two minutes in the live run. Folding those as the
// PARENT's turn held the board at in-flight for the child's whole lifetime, so the turn never settled,
// deriveAwaitingBackground (turn-idle only) could never fire, and a thread at rest for an hour rendered
// the "Working…" shimmer.
test("ingest: a CHILD's events say nothing about the PARENT's turn", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled", "the parent rested")

  ingest.onEvent("t", sessionId, ev.childAssistant)
  ingest.onEvent("t", sessionId, ev.childUser)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled", "the child's chatter must not un-rest it")
  assert.equal(ingest.liveness(sessionId)?.events, 4, "…but it is still counted, and still nudges")

  // The parent's OWN next record — the child's task-notification re-invoking it — does re-open the turn.
  ingest.onEvent("t", sessionId, ev.user)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")
  ingest.close()
})

test("ingest: a child event fires no turn-started receipt", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.result)
  ingest.onEvent("t", sessionId, ev.childAssistant)
  await ingest.drain()
  const kinds = receipts.recent().filter((e) => e.seq > cursor).map((e) => e.receipt.type)
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.started").length, 0)
  ingest.close()
  receipts.close()
})

// The restart shape, at the ingest. `live` is empty on every boot, so the FIRST event to arrive for an
// already-rested session is routinely one with no turn meaning — an `init` alone did this on a real
// broker session. Defaulting to "running" there invented a reading out of nothing, and because the turn
// was already over nothing could ever clear it.
test("ingest: a turn-neutral event with NO prior invents no reading at all", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  for (const neutral of [ev.init, ev.other]) {
    ingest.onEvent("t", sessionId, neutral)
    await ingest.drain()
    assert.equal(ingest.liveness(sessionId)?.turn, undefined, `${neutral.kind} says nothing about the turn`)
  }
  assert.equal(ingest.liveness(sessionId)?.events, 2, "…but it is still counted, and still nudges")

  // A real signal still lands normally on top of the reading-less entry.
  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")
  ingest.close()
})

test("ingest: a turn-neutral event leaves the reading alone rather than resetting it", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.result)
  ingest.onEvent("t", sessionId, ev.other)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")
  assert.equal(ingest.liveness(sessionId)?.events, 2)
  ingest.close()
})

test("ingest: receipts fire on the EDGE, not on every event", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  const kinds = receipts.recent().filter((e) => e.seq > cursor).map((e) => e.receipt.type)
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.started").length, 1, "two assistant events, one start")
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.settled").length, 1)
  ingest.close()
  receipts.close()
})

test("ingest: a failed turn's settled receipt carries isError", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.resultError)
  await ingest.drain()
  const settled = await receipts.waitFor((r) => r.type === "claude.runtime.turn.settled", { since: cursor })
  assert.equal(settled.type === "claude.runtime.turn.settled" && settled.isError, true)
  ingest.close()
  receipts.close()
})

test("ingest: release forgets the session so a replacement never inherits its reading", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")
  ingest.release(sessionId)
  assert.equal(ingest.liveness(sessionId), undefined)
  ingest.close()
})

test("ingest: sessions are tracked independently", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("a", "sa", { ...ev.assistant, sessionId: "sa" })
  ingest.onEvent("b", "sb", { ...ev.result, sessionId: "sb" })
  await ingest.drain()
  assert.equal(ingest.liveness("sa")?.turn, "running")
  assert.equal(ingest.liveness("sb")?.turn, "settled")
  ingest.close()
})

test("ingest: a throwing nudge cannot wedge the queue", async () => {
  // The nudge runs the tailer's tick. A tick that throws must not stop the next event being folded.
  let calls = 0
  const ingest = createClaudeRuntimeIngest({
    nudge: () => { calls++; if (calls === 1) throw new Error("tick blew up") },
  })
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(calls, 2)
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")
  ingest.close()
})

// ---- task lifecycle: the payload the protocol used to discard --------------------------------------
// The tailer's whole sub-agent derivation was regex archaeology over English prose because these
// events arrived as `{kind:"other", type:"system", subtype:"task_started"}` and nothing else. Each
// test below pins one rule of the fold that replaced it.

const task = (over: Partial<Extract<ClaudeQueryEvent, { kind: "task" }>>): ClaudeQueryEvent =>
  ({ kind: "task", phase: "progress", sessionId, ...over }) as ClaudeQueryEvent

test("tasks: a session with no task events reports an empty set", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.deepEqual(ingest.tasks(sessionId), [])
  ingest.close()
})

test("tasks: started → progress accumulates what the child is doing", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k1", toolUseId: "toolu_1", description: "Audit the fold", subagentType: "ntwine:opus-high" }))
  ingest.onEvent("t", sessionId, task({ phase: "progress", taskId: "k1", lastToolName: "Bash", summary: "running the harness", usage: { totalTokens: 1234, toolUses: 7, durationMs: 9000 } }))
  await ingest.drain()
  const [entry] = ingest.tasks(sessionId)
  assert.equal(entry?.toolUseId, "toolu_1")
  assert.equal(entry?.description, "Audit the fold")
  assert.equal(entry?.subagentType, "ntwine:opus-high")
  assert.equal(entry?.lastToolName, "Bash")
  assert.equal(entry?.summary, "running the harness")
  assert.equal(entry?.toolUses, 7)
  assert.equal(entry?.totalTokens, 1234)
  assert.equal(entry?.terminal, false)
  ingest.close()
})

test("tasks: a notification is terminal, and its outcome is normalized", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "done", toolUseId: "toolu_done" }))
  ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: "done", status: "completed", summary: "all green", outputFile: "/tmp/child.jsonl" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "bad" }))
  ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: "bad", status: "failed" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "gone" }))
  ingest.onEvent("t", sessionId, task({ phase: "updated", taskId: "gone", status: "stopped" }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.deepEqual([byId.get("done")?.terminal, byId.get("done")?.outcome], [true, "completed"])
  assert.equal(byId.get("done")?.outputFile, "/tmp/child.jsonl")
  assert.deepEqual([byId.get("bad")?.terminal, byId.get("bad")?.outcome], [true, "failed"])
  assert.deepEqual([byId.get("gone")?.terminal, byId.get("gone")?.outcome], [true, "killed"])
  ingest.close()
})

test("tasks: an UNKNOWN status is never terminal", async () => {
  // A status ntwine has never seen must not retire a live child. The whole point of this signal is to
  // remove phantoms, and "retire on anything unfamiliar" would manufacture the opposite failure —
  // the board reporting done while the work continues.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  ingest.onEvent("t", sessionId, task({ phase: "updated", taskId: "k", status: "hibernating" }))
  await ingest.drain()
  assert.equal(ingest.tasks(sessionId)[0]?.terminal, false)
  assert.equal(ingest.tasks(sessionId)[0]?.status, "hibernating")
  ingest.close()
})

test("tasks: the level signal retires a task that DROPS OUT of the live set", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "a" }, { taskId: "b" }] }))
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "a" }] }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.equal(byId.get("a")?.terminal, false)
  assert.equal(byId.get("b")?.terminal, true, "b left the live set, so it is over")
  ingest.close()
})

test("tasks: the level sweep NEVER retires a task it has not first seen in a level payload", async () => {
  // The ordering of the level signal relative to the start/stop edges is documented as unspecified, so
  // a task_started that races ahead of the next level payload would otherwise read as "disappeared" —
  // retiring a child that is very much alive. Present-then-absent is the only edge that counts.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "fresh" }))
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "other" }] }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.equal(byId.get("fresh")?.terminal, false, "a never-levelled task is not swept")
  ingest.close()
})

test("tasks: release drops the table with the session", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  await ingest.drain()
  assert.equal(ingest.tasks(sessionId).length, 1)
  ingest.release(sessionId)
  assert.deepEqual(ingest.tasks(sessionId), [])
  ingest.close()
})

test("tasks: a task event with no id folds nothing and wedges nothing", async () => {
  const nudged: string[] = []
  const ingest = createClaudeRuntimeIngest({ nudge: (slug) => nudged.push(slug) })
  ingest.onEvent("t", sessionId, task({ phase: "progress", lastToolName: "Bash" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  await ingest.drain()
  assert.deepEqual(ingest.tasks(sessionId).map((entry) => entry.taskId), ["k"])
  assert.equal(nudged.length, 2, "the un-foldable event still nudged")
  ingest.close()
})

test("tasks: the per-session table is bounded, evicting FINISHED tasks first", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  // One live task, then far more than the cap of finished ones.
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "keep-me" }))
  for (let i = 0; i < 400; i++) {
    ingest.onEvent("t", sessionId, task({ phase: "started", taskId: `k${i}` }))
    ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: `k${i}`, status: "completed" }))
  }
  await ingest.drain()
  const all = ingest.tasks(sessionId)
  assert.ok(all.length <= 256, `table grew to ${all.length}`)
  assert.ok(all.some((entry) => entry.taskId === "keep-me"), "the still-running task survived the eviction")
  ingest.close()
})

// ---- the context meter's denominator -------------------------------------------------------------
// Claude names the model's context window in exactly one place — `result.modelUsage` — and an
// orchestrator session bills its sub-agents' models on the SAME result, so picking this thread's row
// needs the alias `init` announced. There was no coverage here at all, which is how the reattach
// regression below survived: the alias arrived once per DAEMON lifetime, and a broker daemon outlives
// the ntwine server, so every thread reattached after a restart lost its readout for good.

const initAs = (model: string): ClaudeQueryEvent => ({ ...ev.init, model })
const resultBilling = (windows: Record<string, number>): ClaudeQueryEvent =>
  ({ ...ev.result, modelContextWindows: windows })

test("context window: the init alias picks THIS thread's row out of a multi-model result", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000, "claude-haiku-4-5-20251001": 200_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000, "the parent's window, not the sub-agent's")
  ingest.close()
})

// The thread info view's live cost: the newest result's cumulative figure, latched per session and
// kept through a result that omits it (a telemetry gap must not blank a reading already shown).
test("session cost: the newest result's total wins, a result without one keeps it, release forgets it", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  assert.equal(ingest.totalCost(sessionId), undefined)
  ingest.onEvent("t", sessionId, { ...ev.result, totalCostUsd: 0.5 } as ClaudeQueryEvent)
  ingest.onEvent("t", sessionId, { ...ev.result, totalCostUsd: 1.75 } as ClaudeQueryEvent)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(ingest.totalCost(sessionId), 1.75)
  ingest.release(sessionId)
  assert.equal(ingest.totalCost(sessionId), undefined)
  ingest.close()
})

test("context window: no alias + more than one billed model reports NOTHING", async () => {
  // A wrong denominator is worse than none: the dial would silently read against a sub-agent's window.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000, "claude-haiku-4-5-20251001": 200_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), undefined)
  // A single-row table is unambiguous, so that one still reads.
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000)
  ingest.close()
})

// THE REATTACH REGRESSION. ntwine restarts; the broker daemon does not. The first events this ingest ever
// sees for a surviving session are mid-session, and the alias has to arrive on the NEXT turn's re-init
// — which the SDK wrapper used to swallow (claude-agent-sdk.ts). Without it, this session's very next
// multi-model result names no window and the thread's context dial never comes back, however long it
// keeps working. Measured on the maintainer's board before the fix: 42 of 323 claude threads had a
// reading, split exactly on which ntwine process had forked the daemon.
test("context window: a session joined mid-flight relearns its alias from the next turn's re-init", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  // Turn N ends first — we attached after its init, so there is no alias yet and nothing is guessed.
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000, "claude-sonnet-5": 1_000_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), undefined)
  // Turn N+1 opens with the provider's per-turn re-init, which names the model.
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000, "claude-haiku-4-5-20251001": 200_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000)
  ingest.close()
})

// A FRESHLY DISPATCHED THREAD HAS NO WINDOW OF ITS OWN for the whole of its first turn — the SDK names
// one only on `result` — so the context dial was blank on exactly the thread an operator opens
// (maintainer 2026-08-26: "the context breakdown is often not visible in the drawer view, which I find
// quite odd"). It reads the window this process last measured for its own alias instead.
test("context window: a session still inside its first turn borrows the window measured for its alias", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  const fresh = "s2"
  // Nothing has been measured yet, so there is nothing to borrow and nothing is invented.
  ingest.onEvent("t2", fresh, { ...initAs("claude-opus-5"), sessionId: fresh })
  await ingest.drain()
  assert.equal(ingest.contextWindow(fresh), undefined)
  // Another session on the same alias finishes a turn.
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(fresh), 1_000_000, "the fresh thread reads a window measured on its own alias")
  // A DIFFERENT alias borrows nothing — the window is a property of the alias, not of the account.
  const haiku = "s3"
  ingest.onEvent("t3", haiku, { ...initAs("claude-haiku-4-5-20251001"), sessionId: haiku })
  await ingest.drain()
  assert.equal(ingest.contextWindow(haiku), undefined)
  // The borrow never outranks a session's own reading.
  ingest.onEvent("t2", fresh, { ...ev.result, sessionId: fresh, modelContextWindows: { "claude-opus-5": 200_000 } })
  await ingest.drain()
  assert.equal(ingest.contextWindow(fresh), 200_000)
  ingest.close()
})

// `pickWindow`'s single-row fallback resolves a thread's OWN denominator without proving which model it
// belongs to. Teaching the alias table from it would spread one unattributed reading to every later
// session on that alias, so only a window picked BY ALIAS is remembered.
test("context window: an unattributed single-row result is not learned as an alias's window", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 })) // no init ⇒ no alias
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000, "its own reading still resolves")
  const other = "s9"
  ingest.onEvent("t9", other, { ...initAs("claude-opus-5"), sessionId: other })
  await ingest.drain()
  assert.equal(ingest.contextWindow(other), undefined, "…but nothing was learned from it")
  ingest.close()
})

test("context window: latched — a later result that omits the row does not blank the readout", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  ingest.onEvent("t", sessionId, ev.result) // no modelUsage at all
  ingest.onEvent("t", sessionId, resultBilling({ "claude-haiku-4-5-20251001": 200_000, "claude-sonnet-5": 1_000_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000, "the window of a running session does not change")
  ingest.release(sessionId)
  assert.equal(ingest.contextWindow(sessionId), undefined, "…but it goes with the session it described")
  ingest.close()
})

// ---- the auto-compact ceiling ---------------------------------------------------------------------
// ntwine dispatches at the 1M window and then hands the worker a 500K CLAUDE_CODE_AUTO_COMPACT_WINDOW,
// and Claude Code's effective window is the `min` of the two — its own /config help says so. The dial
// divided by the model's number instead, so a session with 253,862 tokens of a 500K allowance rendered
// "25% full" (maintainer 2026-09-01). The lowering lives here, once, so every reader downstream gets
// one number meaning one thing: how full the room this session has actually is.

test("compaction ceiling: it LOWERS the measured window, and the fraction reads against the room the session has", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000, "no ceiling ⇒ the model's own window")
  ingest.noteCompactionWindow(sessionId, 500_000)
  assert.equal(ingest.contextWindow(sessionId), 500_000)
  ingest.close()
})

test("compaction ceiling: a ceiling ABOVE the model's window is a no-op, never a window the session lacks", async () => {
  // The drawer's "1M tokens" preset on a 200K model is exactly this case, and it must not promise room
  // the provider never granted.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-haiku-4-5-20251001"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-haiku-4-5-20251001": 200_000 }))
  await ingest.drain()
  ingest.noteCompactionWindow(sessionId, 1_000_000)
  assert.equal(ingest.contextWindow(sessionId), 200_000)
  ingest.close()
})

test("compaction ceiling: it lowers a BORROWED window too — a first-turn thread runs under the same cap", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  const fresh = "s-fresh"
  ingest.onEvent("t2", fresh, { ...initAs("claude-opus-5"), sessionId: fresh })
  await ingest.drain()
  ingest.noteCompactionWindow(fresh, 350_000)
  assert.equal(ingest.contextWindow(fresh), 350_000)
  assert.equal(ingest.contextWindow(sessionId), 1_000_000, "and it is per-SESSION — the neighbour is untouched")
  ingest.close()
})

test("compaction ceiling: a ceiling alone renders NOTHING — it is not a denominator of its own", async () => {
  // It describes the worker's environment, not a measurement. Without a provider-reported window there
  // is still no reading, exactly as before.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.noteCompactionWindow(sessionId, 500_000)
  assert.equal(ingest.contextWindow(sessionId), undefined)
  ingest.close()
})

test("compaction ceiling: absent CLEARS it — a re-forked daemon without one is back on the whole window", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  ingest.noteCompactionWindow(sessionId, 500_000)
  assert.equal(ingest.contextWindow(sessionId), 500_000)
  for (const junk of [undefined, 0, -1, 12.5, Number.NaN]) {
    ingest.noteCompactionWindow(sessionId, junk)
    assert.equal(ingest.contextWindow(sessionId), 1_000_000, `${String(junk)} must leave no stale ceiling behind`)
    ingest.noteCompactionWindow(sessionId, 500_000)
  }
  ingest.close()
})

test("compaction ceiling: it is released with the session, like every other per-session fact", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  ingest.onEvent("t", sessionId, resultBilling({ "claude-opus-5": 1_000_000 }))
  await ingest.drain()
  ingest.noteCompactionWindow(sessionId, 500_000)
  ingest.release(sessionId)
  // A same-alias successor borrows the measured window — and must NOT inherit the dead session's cap.
  ingest.onEvent("t", sessionId, initAs("claude-opus-5"))
  await ingest.drain()
  assert.equal(ingest.contextWindow(sessionId), 1_000_000)
  ingest.close()
})
