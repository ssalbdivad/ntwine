import assert from "node:assert/strict"
import { test } from "node:test"
import { mayHaveLiveBackgroundWork, needsFreshProcessForLimit } from "./backend/usage-limit.ts"

const running = { subAgents: [{ state: "running" }], bgShells: [] }
const finished = { subAgents: [{ state: "rested" }, { state: "stale" }], bgShells: [{ state: "done" }] }
const shellOnly = { subAgents: [], bgShells: [{ state: "running" }] }

// THE ONE THAT COST SEVEN SUB-AGENTS (2026-08-06). The call sites read
// `(tailer.get(slug)?.subAgents ?? []).some(running)`, so a thread the tailer had NO state for — its
// 566MB transcript could not be primed — read as "no background work", and ntwine retired its daemon
// mid-flight. A read failure must never present as a confident negative to a safety guard.
test("a thread with NO tailer state is treated as possibly busy, not as idle", () => {
  assert.equal(mayHaveLiveBackgroundWork(undefined), true)
})

test("running sub-agents and running background shells both count as live work", () => {
  assert.equal(mayHaveLiveBackgroundWork(running), true)
  // Shells were never checked at all before; a running shell is exactly as live as a running agent.
  assert.equal(mayHaveLiveBackgroundWork(shellOnly), true)
})

test("a thread whose work has all finished is idle", () => {
  assert.equal(mayHaveLiveBackgroundWork(finished), false)
  assert.equal(mayHaveLiveBackgroundWork({ subAgents: [], bgShells: [] }), false)
})

// The guard exists to keep ntwine's OWN initiative from killing a live child; an operator asking
// outright is a separate path that deliberately still does.
test("ntwine declines to restart a limit-paused thread while work may be live", () => {
  const fault = { at: new Date(Date.now() - 60_000).toISOString(), resumeAt: new Date(Date.now() - 1000).toISOString() }
  const now = Date.now()
  // Whatever the fault says, live work vetoes the restart…
  assert.equal(needsFreshProcessForLimit(fault as never, now, true), false)
  // …and so does not knowing, which is the whole point of failing closed.
  assert.equal(needsFreshProcessForLimit(fault as never, now, mayHaveLiveBackgroundWork(undefined)), false)
})

// A state object missing an array is shape variance, not a read failure — it must not resurrect the
// fail-open behaviour, and it must not throw either (a stub without bgShells did exactly that).
test("a partially-shaped state contributes what it has, without throwing", () => {
  assert.equal(mayHaveLiveBackgroundWork({ subAgents: [{ state: "running" }] }), true)
  assert.equal(mayHaveLiveBackgroundWork({ subAgents: [] }), false)
  assert.equal(mayHaveLiveBackgroundWork({}), false)
})
