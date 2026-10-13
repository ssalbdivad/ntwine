// The consumer for the structured event stream the Claude broker has always received and thrown away.
//
// The broker daemon runs the Agent SDK with `persistSession: true`, so the SDK writes the session
// JSONL to disk AND hands ntwine the same messages as typed events over the socket. Until now the
// bridge forwarded them to a `deps.onEvent` that context.ts never supplied, so every one was dropped
// and the tailer re-derived the identical state by polling that file from disk on a 1–10 s adaptive
// tick. This module is the handler that was missing (plans/t3code-adoption-spike.md item 1).
//
// It does NOT replace the tailer's fold. That fold is the corpus-verified authority for the things
// the board actually renders — signal fences, sub-agents, background shells, auto-titles, delivery
// correlation — and the broker's event projection is strictly lossier than the raw records. Swapping
// one for the other would be a rewrite of the board's derivation with no way to prove it neutral.
// Instead the event stream does the two things a disk poll structurally cannot:
//
//  1. NUDGE. An event means "this session just changed", so the tailer re-reads it now instead of on
//     the next tick. Same fold, same derivation, ~0 ms instead of up to 10 s. This is the change the
//     operator sees: a thread that finishes its turn lands in the queue immediately.
//
//  2. TURN LIVENESS. The SDK states outright when a turn began and when it ended. The tailer's
//     `computeTurn` has to infer both from `stop_reason`, and for an unknown/missing stop_reason it
//     falls back to a 5 s silence backstop — a guess. A `result` event is not a guess. See
//     `resolveRuntimeTurn` for the deliberately narrow way that signal is allowed to matter.
//
// The strict rule for (2), because it is where a DX regression would live: the runtime signal may
// only ever RESOLVE AN AMBIGUITY the fold has not settled. It must never override folded evidence.
// The SDK emits `result` over the socket at some point relative to the final assistant record
// reaching disk, and if a "turn is over" signal were allowed to beat that record to the board, the
// thread would queue with a stale last message and no parsed fence. So a folded `tool_use` (the model
// is definitively mid-tool) always wins over a runtime "settled", and only the backstop case — where
// the fold has no opinion and was going to time out into `idle` anyway — is short-circuited.
//
// (3) SUB-AGENT PROGRESS. The SDK reports child lifecycle as typed `task_*` system messages carrying a
//     description, the tool the child is running right now, a rolling summary and usage — and those
//     messages are STREAM-ONLY, absent from the JSONL the tailer folds. Until now the whole payload was
//     discarded at the protocol boundary, so the tailer reconstructed lifecycle by regex-matching
//     English prose out of launch acks ("output_file:", "Command running in background with ID:") — a
//     path whose own comments record three separate phantom-sub-agent leaks. `tasks()` below is that
//     payload, kept per session; the tailer reads it the same way it reads `liveness()`, as a signal it
//     may consult, and the prose fold stays exactly where it is for pre-broker threads that have nothing
//     else.
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { createDrainableWorker, type DrainableWorker, type ReceiptBus } from "@ntwine/shared"

/** What the SDK says about the session's turn right now, independent of what is on disk. */
export type ClaudeRuntimeTurn = "running" | "settled"

/** How many tasks to remember per session. Terminal ones are evicted first — see rememberTask. */
const MAX_TRACKED_TASKS = 256

/**
 * The provider's own live view of one background task (a sub-agent, a background Bash, a Monitor),
 * folded from the `task_*` stream. Everything but `taskId`/`updatedAt` is optional: the SDK fills a
 * different subset per phase, and the mapper degrades any field it cannot represent.
 */
export interface ClaudeRuntimeTask {
  taskId: string
  /** The dispatch tool_use id, when the SDK supplied one — the tailer's primary correlation key. */
  toolUseId?: string
  description?: string
  subagentType?: string
  taskType?: string
  /** Provider status verbatim, last one seen. Open set; `terminal` is the derived question. */
  status?: string
  /** The provider has reported this task finished (completed / failed / stopped / killed). */
  terminal: boolean
  /** Normalized terminal outcome, once `terminal`. */
  outcome?: "completed" | "failed" | "killed"
  /** The tool the child is running right now — the single most useful "what is it up to" field. */
  lastToolName?: string
  /**
   * What the child's CURRENT step is, in words — `task_progress.description`, which the provider
   * rewrites per tool call ("Running Print current date and time"). Distinct from `description`, which
   * is the stable dispatch description and does not move. Measured against a real session, this is the
   * richest live field on the stream: `summary` was empty on every progress event and only arrived with
   * the terminal notification, by which point the row is already retired.
   */
  activityDetail?: string
  /** The provider's rolling one-line summary of the child's work. */
  summary?: string
  outputFile?: string
  error?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  /**
   * Whether this task has ever appeared in a `background_tasks_changed` PAYLOAD. Deliberately NOT "has
   * ever looked alive" — a task_started sets no such thing. It is the precondition for the level sweep,
   * which may only retire a task it has watched leave the set it was previously in.
   */
  seenInLevel: boolean
  /** ms epoch of the event that last touched this record. */
  updatedAt: number
}

export interface ClaudeRuntimeLiveness {
  /**
   * The SDK's reading, or UNDEFINED while it has none — a session can have delivered events without
   * any of them saying a thing about its turn (`init`, `task`, `other`). This used to default to
   * "running", which invented a reading out of an event that carries no turn meaning; see the
   * fabrication note on the fold below.
   */
  turn?: ClaudeRuntimeTurn
  /** ms epoch of the event that produced this reading. */
  at: number
  /** Events ingested for this session since it was bound — a cheap "is anything arriving at all". */
  events: number
}

/** Runtime milestones published for tests and harnesses. NOT part of the production event model. */
export type ClaudeRuntimeReceipt =
  | { type: "claude.runtime.event"; slug: string; sessionId: string; kind: ClaudeQueryEvent["kind"] }
  | { type: "claude.runtime.turn.started"; slug: string; sessionId: string }
  | { type: "claude.runtime.turn.settled"; slug: string; sessionId: string; isError: boolean }
  | { type: "claude.runtime.session.released"; sessionId: string }
  | { type: "claude.runtime.task"; slug: string; sessionId: string; taskId: string; phase: string; terminal: boolean }

export interface ClaudeRuntimeIngestDeps {
  /** Ask the tailer to re-read now. Coalesced on its side; safe to call on every event. */
  nudge(slug: string): void
  /** Optional milestone sink for integration tests. Absent in production wiring. */
  receipts?: ReceiptBus<ClaudeRuntimeReceipt>
}

export interface ClaudeRuntimeIngest {
  /** The `ClaudeBrokerBridgeDeps["onEvent"]` handler. */
  onEvent(slug: string, sessionId: string, event: ClaudeQueryEvent): void
  /** The SDK's own reading of this session's turn, or undefined if nothing has been ingested. */
  liveness(sessionId: string): ClaudeRuntimeLiveness | undefined
  /**
   * The provider's own view of this session's background tasks — what each child is doing right now,
   * and which ones it says are finished. Empty for a session that has emitted no `task_*` event (every
   * pre-broker thread, every codex row, an older claude that does not emit them).
   */
  tasks(sessionId: string): readonly ClaudeRuntimeTask[]
  /**
   * The context window this session actually RUNS IN — the model's size, lowered to the auto-compact
   * ceiling its daemon was forked with when that is smaller. Undefined forever for a pre-broker/foreign
   * row that has no broker at all. The numerator comes off disk on every assistant record, so this is
   * the half that decides whether a Claude row has a readout — and an undefined here must render
   * nothing, never a fabricated denominator.
   *
   * A SESSION'S OWN READING ARRIVES ONLY WHEN ITS FIRST TURN ENDS, because the window rides `result`
   * and nothing earlier says it (see ClaudeResultEvent.modelContextWindows — not `init`, not the
   * control-initialize capability list). That left every freshly dispatched thread with no readout for
   * the whole of its first turn, which is exactly the thread an operator opens (maintainer 2026-08-26:
   * "the context breakdown is often not visible in the drawer view, which I find quite odd"). So a
   * session with no reading of its own BORROWS the window this process last saw for its own model
   * alias — see `modelWindows`. Not a hardcoded table and not a guess: it is a number the provider
   * reported, for this alias, on this account, and the session's own `result` overwrites it.
   *
   * THE CEILING IS PART OF THE READING, not a second number beside it — see `noteCompactionWindow`.
   */
  contextWindow(sessionId: string): number | undefined
  /**
   * The session's cost so far, off its newest `result` (ClaudeResultEvent.totalCostUsd). Live while this
   * process is attached; the transcript's own `cost-state` record is written only when Claude Code
   * exits, so the thread info view prefers this and falls back to that (thread-stats.ts).
   */
  totalCost(sessionId: string): number | undefined
  /**
   * The auto-compact ceiling this session's daemon was forked with (CLAUDE_CODE_AUTO_COMPACT_WINDOW,
   * from Settings.autoCompactWindow). Reported by the bridge at every attach, off the daemon's own
   * record, so a reattach after a ntwine restart re-learns the value that daemon is really running under
   * rather than whatever the drawer says today.
   *
   * WHY IT LOWERS `contextWindow` INSTEAD OF RIDING BESIDE IT. Claude Code's effective window is
   * literally `Math.min(model window, this)` — its own `/config` help says so ("the actual threshold is
   * the minimum of this setting and your model's maximum context window"), and the CLI computes exactly
   * that. So a ntwine worker dispatched at `opus[1m]` under the shipped 500K ceiling has 500K of room,
   * not 1M, and the footer's dial spent its whole life reporting the second number: 253,862 of
   * 1,000,000 = a comfortable 25%, when the session was in fact half full and half a turn's reading
   * away from a summary (maintainer 2026-09-01). One number, one meaning — how full the space this
   * session has is.
   */
  noteCompactionWindow(sessionId: string, window: number | undefined): void
  /** Forget a session (replaced or deleted) so a later same-slug dispatch starts clean. */
  release(sessionId: string): void
  /** Resolves once every event handed to `onEvent` so far has been folded. Tests only. */
  drain(): Promise<void>
  close(): void
}

// Which events mean "a turn is underway". `init` is session setup, not a turn; `prompt-suggestion`
// and `other` are sidecar chatter.
//
// Only the MAIN thread's assistant/user events count. A CHILD's (parentToolUseId set) says nothing
// about the parent's turn, and reading one as "running" put every resting fleet-parent under a
// permanent shimmer. The old rule assumed a live child implies the parent is blocked inside its Task
// call — true only for a FOREGROUND dispatch, and there the fold already reads `tool_use` (real
// evidence, which resolveRuntimeTurn never overrides) so the runtime signal was redundant anyway. The
// ntwine worker shape is the opposite: `run_in_background: true`, then rest. Measured on a live broker
// session (_live_bg_rest_turn.mts): the parent's `result` landed at t+9s → settled, and the child's
// very next assistant event — 40ms later, then 17 more over the next two minutes — flipped it back to
// "running", which dragged the folded `idle` to `in-flight` for the child's entire lifetime. So the
// turn never settled, `deriveAwaitingBackground` (which requires turn-idle) could never fire, and the
// board showed "Working…" for a thread that had been at rest for an hour (reported 2026-07-30).
function turnSignal(event: ClaudeQueryEvent): ClaudeRuntimeTurn | undefined {
  if (event.kind === "assistant" || event.kind === "user") {
    return event.parentToolUseId === undefined ? "running" : undefined
  }
  if (event.kind === "result") return "settled"
  return undefined
}

/**
 * Normalize the provider's terminal vocabulary. `stopped` (a manual TaskStop, or a task the previous
 * CLI process left behind) and `killed` are the same thing to ntwine: the op is over and was not its own
 * idea. Anything else — `pending`, `running`, `paused` — is NOT terminal, and an UNKNOWN status is
 * deliberately not terminal either: a future status ntwine has never seen must not retire a live child.
 */
function terminalOutcome(status: string | undefined): "completed" | "failed" | "killed" | undefined {
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  if (status === "stopped" || status === "killed") return "killed"
  return undefined
}

export function createClaudeRuntimeIngest(deps: ClaudeRuntimeIngestDeps): ClaudeRuntimeIngest {
  const live = new Map<string, ClaudeRuntimeLiveness>() // keyed by session id
  // Provider-reported background tasks, keyed by session id then task id. Insertion-ordered, so the
  // eviction below drops the oldest.
  const tasks = new Map<string, Map<string, ClaudeRuntimeTask>>()
  // The session's own model alias, from `init` — the key that picks THIS thread's row out of the
  // per-model `modelUsage` table on `result`. Kept because the alias is load-bearing: an orchestrator
  // session bills its sub-agents' models on the same result, and `claude-opus-5[1m]` and
  // `claude-opus-5` are different windows under the same canonical model.
  const sessionModel = new Map<string, string>()
  const contextWindows = new Map<string, number>() // keyed by session id; the main model's window
  // The window each model ALIAS was last seen to report, from any session in this process. It is what a
  // session still inside its FIRST turn reads instead of nothing (see `contextWindow` above). Keyed on
  // the alias `init` named rather than on a canonical model, because the alias is what decides the
  // window: `claude-opus-5[1m]` and `claude-opus-5` are different rows, and the same alias names
  // different windows on different SUBSCRIPTIONS — which is why this is a memory of what was measured
  // here rather than a table anyone could write down.
  //
  // Deliberately NOT cleared by `release`: it describes a model, not a session, and forgetting it when
  // one thread ends would put the next dispatch back to a blank readout.
  const modelWindows = new Map<string, number>()
  // The auto-compact ceiling each session's daemon was forked with, keyed by session id. Set by the
  // bridge at attach; see `noteCompactionWindow` for why it lowers the window rather than sitting
  // beside it. Per-SESSION and not per-model: it is a property of one daemon's environment.
  const compactionWindows = new Map<string, number>()
  const costs = new Map<string, number>() // keyed by session id; the newest result's total_cost_usd

  // Which row of `modelUsage` describes the MAIN thread. The alias `init` named, when the result
  // carries it. Otherwise: a single-row table is unambiguous (no sub-agent billed anything), and a
  // multi-row table with no match is NOT guessed at — a wrong denominator is worse than none.
  function pickWindow(sessionId: string, windows: Record<string, number>): number | undefined {
    const alias = sessionModel.get(sessionId)
    if (alias && windows[alias] !== undefined) return windows[alias]
    const rows = Object.values(windows)
    return rows.length === 1 ? rows[0] : undefined
  }

  function rememberTask(sessionId: string, taskId: string, now: number): ClaudeRuntimeTask {
    let table = tasks.get(sessionId)
    if (!table) { table = new Map(); tasks.set(sessionId, table) }
    let task = table.get(taskId)
    if (!task) {
      task = { taskId, terminal: false, seenInLevel: false, updatedAt: now }
      table.set(taskId, task)
      // Bounded, terminal-first: a long orchestrator session can dispatch hundreds of children, and the
      // ones still running are the ones the board needs. Evicting a FINISHED task is harmless — the
      // tailer retires on the edge, and a re-seen terminal retire is a no-op either way.
      while (table.size > MAX_TRACKED_TASKS) {
        const victim = [...table.values()].find((entry) => entry.terminal) ?? table.values().next().value
        if (!victim || victim === task) break
        table.delete(victim.taskId)
      }
    }
    task.updatedAt = now
    return task
  }

  /**
   * Fold ONE task event into the session's table. Defensive throughout: a phase ntwine does not know, a
   * missing task id, a status it has never seen — every one of them is a no-op, never a throw and never
   * a state change it cannot justify. This runs inside the drainable worker, whose failure would stall
   * every later nudge.
   */
  function foldTask(slug: string, sessionId: string, event: Extract<ClaudeQueryEvent, { kind: "task" }>, now: number): void {
    // The REPLACE-semantics level signal, and the one place a task can go terminal without an edge.
    // Deliberately narrow: only a task ntwine has ALREADY SEEN IN A LEVEL PAYLOAD and that has now
    // dropped out of one is treated as finished. Without that guard, a `task_started` racing ahead of
    // the next level payload would look like a task that "disappeared" and retire a child that is very
    // much alive — the phantom bug in its most damaging direction (the board says done, work continues).
    if (event.phase === "level") {
      const present = new Set((event.tasks ?? []).map((entry) => entry.taskId))
      for (const entry of event.tasks ?? []) {
        const task = rememberTask(sessionId, entry.taskId, now)
        task.seenInLevel = true
        if (entry.description && !task.description) task.description = entry.description
        if (entry.taskType && !task.taskType) task.taskType = entry.taskType
      }
      for (const task of tasks.get(sessionId)?.values() ?? []) {
        if (task.terminal || !task.seenInLevel || present.has(task.taskId)) continue
        task.terminal = true
        task.outcome = "completed" // absent from the live set with no notification: finished, cause unknown
        task.updatedAt = now
        deps.receipts?.publish({ type: "claude.runtime.task", slug, sessionId, taskId: task.taskId, phase: "level", terminal: true })
      }
      return
    }
    if (!event.taskId) return // an edge with no correlation key can enrich nothing
    const task = rememberTask(sessionId, event.taskId, now)
    // A task id OUTLIVES the run that created it. `SendMessage` restarts a stopped child, and the
    // provider reuses the SAME taskId for the new run — measured on a real session: three `task_started`
    // events for one agent, one per restart, with the taskId stable and the tool_use id different every
    // time. So `terminal` is a fact about a RUN, not about the id, and `task_started` is the provider
    // saying this id is running again. Without clearing it the latch is permanent: the tailer's
    // `applyRuntimeTasks` re-reads the dead run's terminal flag and retires the revived child on the
    // very next tick, which is exactly what happened on the promoted artifact — the fold revived the
    // child correctly and the board still showed nothing for the 37 s it ran.
    if (event.phase === "started") {
      task.terminal = false
      task.outcome = undefined
    }
    if (event.toolUseId) task.toolUseId = event.toolUseId
    // `description` means two different things by phase and must not be collapsed: on `started` it is
    // the stable dispatch description (the board's label), on `progress` it is the live step.
    if (event.description) {
      if (event.phase === "progress") task.activityDetail = event.description
      else task.description = event.description
    }
    if (event.subagentType) task.subagentType = event.subagentType
    if (event.taskType) task.taskType = event.taskType
    if (event.lastToolName) task.lastToolName = event.lastToolName
    if (event.summary) task.summary = event.summary
    if (event.outputFile) task.outputFile = event.outputFile
    if (event.error) task.error = event.error
    if (event.usage?.totalTokens !== undefined) task.totalTokens = event.usage.totalTokens
    if (event.usage?.toolUses !== undefined) task.toolUses = event.usage.toolUses
    if (event.usage?.durationMs !== undefined) task.durationMs = event.usage.durationMs
    if (event.status) task.status = event.status
    const outcome = terminalOutcome(event.status)
    if (outcome) {
      task.terminal = true
      task.outcome = outcome
    }
    deps.receipts?.publish({ type: "claude.runtime.task", slug, sessionId, taskId: task.taskId, phase: event.phase, terminal: task.terminal })
  }
  // Serialized so `drain()` means something: after it resolves, every event handed in has been
  // folded and its nudge issued. Without that a harness is back to sleeping and hoping.
  const worker: DrainableWorker<{ slug: string; sessionId: string; event: ClaudeQueryEvent }> =
    createDrainableWorker((item) => {
      const now = Date.now()
      const prior = live.get(item.sessionId)
      const signal = turnSignal(item.event)
      // NEVER FABRICATE A READING. An event that carries no turn meaning (`init`, `task`, `other`)
      // leaves the turn exactly as it was — INCLUDING "as it was: unknown". This used to fall back to
      // "running", which is a guess, and `resolveRuntimeTurn` lets a "running" override a folded
      // `idle` — so the guess overrode folded evidence, the one thing this module's contract forbids.
      // It mattered on every restart: `live` starts empty, so the first signal-less event for an
      // ALREADY-RESTED session minted "running" from nothing, and nothing could ever clear it (the
      // turn is over; no `result` is coming). Measured on a real broker session, an `init` alone did
      // exactly this. Four threads that had been at rest for hours rendered "Working…" for the life of
      // the server process (reported 2026-07-30, the second report of this shimmer).
      live.set(item.sessionId, {
        turn: signal ?? prior?.turn,
        at: now,
        events: (prior?.events ?? 0) + 1,
      })
      deps.receipts?.publish({ type: "claude.runtime.event", slug: item.slug, sessionId: item.sessionId, kind: item.event.kind })
      // Never let a malformed task frame stall the worker: the nudge below is what makes the board
      // responsive at all, and it is queued behind this fold.
      if (item.event.kind === "task") {
        try { foldTask(item.slug, item.sessionId, item.event, now) } catch { /* telemetry only */ }
      }
      // Context-window latch: `init` names the model alias, `result` prices every alias it billed.
      // Latched, never cleared by a later result that omits the row — the window of a running session
      // does not change, and losing it would blank a readout the operator is already reading.
      if (item.event.kind === "init") sessionModel.set(item.sessionId, item.event.model)
      if (item.event.kind === "result" && item.event.totalCostUsd !== undefined) costs.set(item.sessionId, item.event.totalCostUsd)
      if (item.event.kind === "result" && item.event.modelContextWindows) {
        const window = pickWindow(item.sessionId, item.event.modelContextWindows)
        if (window !== undefined && window > 0) {
          contextWindows.set(item.sessionId, window)
          // Only a window picked BY ALIAS teaches the alias table. `pickWindow`'s single-row fallback
          // resolves a thread's own denominator without proving which model it belongs to, and a wrong
          // entry here would spread to every later session on that alias.
          const alias = sessionModel.get(item.sessionId)
          if (alias && item.event.modelContextWindows[alias] === window) modelWindows.set(alias, window)
        }
      }
      if (signal === "running" && prior?.turn !== "running") {
        deps.receipts?.publish({ type: "claude.runtime.turn.started", slug: item.slug, sessionId: item.sessionId })
      }
      if (signal === "settled" && prior?.turn !== "settled") {
        const isError = item.event.kind === "result" ? item.event.isError : false
        deps.receipts?.publish({ type: "claude.runtime.turn.settled", slug: item.slug, sessionId: item.sessionId, isError })
      }
      // Every event is a "this session changed" signal, including the ones that carry no turn
      // meaning: an `other` event still corresponds to a record the SDK just wrote to disk.
      deps.nudge(item.slug)
    })

  return {
    onEvent(slug, sessionId, event) { worker.enqueue({ slug, sessionId, event }) },
    liveness: (sessionId) => live.get(sessionId),
    tasks: (sessionId) => [...(tasks.get(sessionId)?.values() ?? [])],
    contextWindow: (sessionId) => {
      const own = contextWindows.get(sessionId)
      const alias = sessionModel.get(sessionId)
      const measured = own ?? (alias ? modelWindows.get(alias) : undefined)
      if (measured === undefined) return undefined
      // The ceiling only ever LOWERS the reading, never raises it — the same `min` Claude Code itself
      // applies, so a ceiling above the model's window (the "1M tokens" preset on a 200K model) is
      // correctly a no-op rather than a window the session does not have.
      const ceiling = compactionWindows.get(sessionId)
      return ceiling === undefined ? measured : Math.min(measured, ceiling)
    },
    totalCost: (sessionId) => costs.get(sessionId),
    noteCompactionWindow(sessionId, window) {
      // Absent is a real answer, not "leave it": a daemon re-forked with the setting turned off runs on
      // the whole window again, and a stale ceiling would keep shrinking a reading that has grown.
      if (window === undefined || !Number.isInteger(window) || window <= 0) compactionWindows.delete(sessionId)
      else compactionWindows.set(sessionId, window)
    },
    release(sessionId) {
      live.delete(sessionId)
      tasks.delete(sessionId)
      sessionModel.delete(sessionId)
      contextWindows.delete(sessionId)
      compactionWindows.delete(sessionId)
      costs.delete(sessionId)
      deps.receipts?.publish({ type: "claude.runtime.session.released", sessionId })
    },
    drain: () => worker.drain(),
    close() { worker.close(); live.clear(); tasks.clear(); sessionModel.clear(); contextWindows.clear(); modelWindows.clear(); compactionWindows.clear(); costs.clear() },
  }
}

/**
 * How long a `running` reading may go on outranking a folded `idle`. That override exists for ONE
 * reason — the SDK's socket runs ahead of its own disk write — and the lag it covers is milliseconds:
 * measured at ~100-140 ms on a live broker session, with the tailer's own chase budgeted for ~500 ms.
 * Past this bound "the transcript has not caught up yet" is no longer a possible explanation; the
 * transcript has had half a minute. Generous on purpose — it is a backstop against a reading that
 * STOPPED ADVANCING, not a second turn heuristic.
 */
const RUNNING_OVERRIDE_MAX_AGE_MS = 30_000

/**
 * How a runtime turn reading is allowed to affect the folded one. Pure, so the rule is testable on
 * its own — this is the single place the "never override folded evidence" invariant lives.
 *
 * @param folded    what `computeTurn` derived from the transcript
 * @param backstopped  true when `folded === "in-flight"` ONLY because the unknown-stop_reason 5 s
 *                     backstop has not elapsed — i.e. the fold has no real evidence either way
 * @param runtime   the SDK's reading, or undefined when there is none
 * @param ageMs     how long ago the event that produced `runtime` arrived. 0 (the default) means
 *                  "fresh"; a negative skew from an injected clock is treated as fresh too.
 */
export function resolveRuntimeTurn(
  folded: "in-flight" | "idle",
  backstopped: boolean,
  runtime: ClaudeRuntimeTurn | undefined,
  ageMs = 0,
): "in-flight" | "idle" {
  if (!runtime) return folded
  // The SDK says a turn is underway and the transcript has not caught up (the user record for a
  // just-delivered follow-up is not on disk yet). Safe in the only direction that matters: it can
  // never fire a premature turn-done, it just stops the board showing `idle` for a beat.
  //
  // Bounded by age, because a "running" that stops advancing is indistinguishable from one that is
  // merely early — and unbounded it pinned a rested thread's board reading at "Working…" forever.
  // Only THIS rule is bounded: a stale `settled` can only ever agree with a fold that already reads
  // idle, and a folded `tool_use` still wins over both regardless of age.
  if (runtime === "running" && folded === "idle") {
    return ageMs > RUNNING_OVERRIDE_MAX_AGE_MS ? "idle" : "in-flight"
  }
  // The SDK says the turn is over and the fold is only holding `in-flight` on the 5 s silence guess.
  // Short-circuit the guess. A fold reading `tool_use` — real evidence the model is mid-tool — is
  // deliberately NOT overridden: there the runtime is simply ahead of the disk, and trusting it
  // would queue the thread before its final message (and its signal fence) has been folded.
  if (runtime === "settled" && backstopped) return "idle"
  return folded
}
