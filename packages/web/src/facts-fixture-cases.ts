import type { ThreadView } from "@ntwine/shared"

// THE FACTS LINE'S COMBINATIONS (ThreadHeaderFacts FACTS_LINE_CLASS), shared by the two fixtures that draw
// it: the queue card's (queue-card-states-fixture.tsx `?case=facts-matrix`) and the drawer header's
// (thread-header-fixture.tsx `?facts=1`). Each case turns facts on or off, so one screenshot per width
// shows whether the line ever opens on a "·", leaves a hole, or squeezes a fact to nothing instead of
// dropping it whole.

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

const context = { context: { tokens: 148_000, window: 200_000 } }
const goal = {
  recurringPrompt: { prompt: "Keep the census sweep green.", stopHook: true, heartbeat: false, postCompaction: false, armedAt: minutesAgo(90), runs: 7, maxRuns: 20, forSeconds: 4 * 3600, endsAt: minutesAhead(72) },
}
const checkout = { checkout: { dir: "/fixture/signing/.ntwine/worktrees/catalog-v2-rollout", kind: "worktree" as const } }
const spinoff = (id: string) => ({
  spinoffs: [{ id: `spn_${id}`, parentSlug: "migrate-the-catalog-reader", childSlug: id, instructions: "Check the partner feed.", createdAt: Date.now() - 3_600_000 }],
})
const status = {
  runtime: "running",
  statusLine: "Replaying last week's traffic against both catalog readers and diffing every response body",
  statusSince: minutesAgo(4),
}

export interface FactCase { id: string; title: string; extra: Partial<ThreadView> }

export const FACT_CASES: FactCase[] = [
  { id: "time-only", title: "Time only", extra: {} },
  { id: "ctx", title: "Context", extra: { ...context } },
  { id: "ctx-goal", title: "Context and a goal loop", extra: { ...context, ...goal } as Partial<ThreadView> },
  { id: "checkout", title: "Context and a worktree", extra: { ...context, ...checkout } },
  { id: "spinoff", title: "A spinoff with context", extra: { ...context, ...spinoff("spinoff") } as Partial<ThreadView> },
  { id: "long-status", title: "A long status line", extra: { ...context, ...status } as Partial<ThreadView> },
  { id: "everything", title: "Every fact at once", extra: { ...context, ...goal, ...checkout, ...spinoff("everything"), ...status } as Partial<ThreadView> },
  // No band: the drawer header's line then opens on the time (a queue card has no band stamp at all).
  { id: "no-band", title: "No band stamp", extra: { kind: "legacy", ...context, ...checkout } as Partial<ThreadView> },
]
