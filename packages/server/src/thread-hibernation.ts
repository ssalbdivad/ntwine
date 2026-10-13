// Idle-thread hibernation — reclaim the memory a RESTING worker holds, without ending it.
//
// An ntwine worker is expensive at rest and free to restart. Measured on the maintainer's machine
// 2026-08-19 (64 GB, 38 live worker threads, ALL 38 idle, 19 GB held): 504 MB per thread all-in —
// a `claude` CLI at 289 MB, a chrome-devtools MCP pair at 159 MB, the broker daemon at 39 MB and the
// ntwine MCP server at 17 MB. That browser was ntwine's own always-on mount, removed 2026-08-26: a
// thread now carries only the MCP servers the PROJECT configured, so the same measurement in a repo
// with no `.mcp.json` would read ~345 MB, and since 2026-10-05 so does one whose `.mcp.json` brings a browser
// until a tool call starts it (lazy-mcp-host.ts) — still the largest reclaimable block on the machine. Seventeen of those threads had been idle for an hour or
// more; the oldest for 19.5 hours, still holding its full 504 MB. Nothing in ntwine ever collected them:
// the broker daemon's own IDLE_EXIT_MS is six hours AND only fires when no client is attached, which
// for an ntwine-managed thread is never.
//
// SIXTY MINUTES is the threshold because it is the Anthropic prompt-cache TTL. A thread idle longer
// than that has ALREADY lost its cache, so tearing its process down and cold-resuming it later costs no
// extra tokens — the memory saving and the token cost genuinely do not overlap. Below the TTL they do,
// which is why the default is not lower.
//
// The MECHANISM is not new. `killBroker` + the next input's `resume: true` is exactly what a usage-limit
// resume and a permission-mode change already do in production ("Nothing durable is lost — the
// transcript is on disk and `resume: true` reads it back — beyond the in-memory sub-agents"). This
// module is the DECISION: which threads may be torn down unattended, and when.
//
// SAFETY — it fails CLOSED, everywhere, because the two outcomes are not comparable. A thread wrongly
// left running costs 504 MB of a 64 GB machine. A thread wrongly hibernated destroys whatever the
// maintainer had in flight: the in-memory sub-agents die with the process, a turn mid-tool-call is lost
// with no record of what it was doing, and an approval the daemon is parked on can never be answered.
// So every unknown — no telemetry, no transcript, an unparseable timestamp, an enumeration that threw —
// is a REFUSAL to hibernate, and the predicate below is the union of every "this thread is busy"
// reading ntwine already has rather than the minimum that would look sufficient.
import { formatElapsed, isDirectSubAgent } from "@ntwine/shared"
import { parseDeliveryLedger } from "./delivery-ledger.ts"
import { isBrokerClaudeRow, type SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

/** The prompt-cache TTL. Above it a cold resume is free; below it, it is not. */
export const HIBERNATE_IDLE_MS = 60 * 60_000
/** How often the sweep looks. Cheap — an in-memory pass over rows ntwine already holds. */
export const HIBERNATE_SWEEP_INTERVAL_MS = 5 * 60_000
/** A daemon younger than this is never hibernated regardless of its transcript's age: a thread woken
 *  seconds ago still reads as idle for the moment before its first record lands. The delivery-ledger
 *  and turn checks below both catch that too — this is the belt to their braces. */
export const HIBERNATE_MIN_DAEMON_AGE_MS = 5 * 60_000

/** Minutes, from NTWINE_HIBERNATE_IDLE_MINUTES. A missing/garbage/non-positive value keeps the default
 *  rather than disabling the guard — an operator who wants it off has NTWINE_HIBERNATE_OFF. */
export function hibernateIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.NTWINE_HIBERNATE_IDLE_MINUTES)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : HIBERNATE_IDLE_MS
}

/** Seconds, from NTWINE_HIBERNATE_SWEEP_SECONDS. Paired with the threshold above rather than a knob of
 *  its own: a two-minute threshold swept every five minutes is incoherent, and moving one without the
 *  other is the mistake this exists to make impossible. */
export function hibernateSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.NTWINE_HIBERNATE_SWEEP_SECONDS)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : HIBERNATE_SWEEP_INTERVAL_MS
}

export function hibernationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NTWINE_HIBERNATE_OFF !== "1"
}

/** Everything one decision reads, gathered by the caller so the decision itself stays pure. */
export interface HibernationCandidate {
  slug: string
  sessionId: string
  row: SessionRow
  /** `undefined` means the tailer has no state for this thread — which is NOT evidence of no work. */
  telemetry: SessionTelemetry | undefined
  /** Interactions still awaiting a human for this exact session (approvals, native asks). Each one is
   *  a promise living INSIDE the daemon; retiring the process leaves it unanswerable forever. */
  pendingInteractions: number
  /** BrokerRecord.createdAt for the daemon under consideration. */
  daemonStartedAtMs: number
}

/** Why a thread was left alone. A string rather than an enum because its only consumer is the log line
 *  an operator greps when they ask why nothing is being reclaimed. */
export type HibernationBlock =
  | "not-a-broker-thread"
  | "archived"
  | "stopped"
  | "no-telemetry"
  | "no-transcript"
  | "turn-in-flight"
  | "awaiting-a-human"
  | "pending-approval"
  | "sub-agents"
  | "background-shells"
  | "undelivered-input"
  | "daemon-too-young"
  | "no-activity-timestamp"
  | "not-idle-long-enough"

export type HibernationVerdict = { hibernate: true; idleMs: number } | { hibernate: false; blockedBy: HibernationBlock }

/** ISO8601 → epoch ms, or NaN. An unparseable timestamp must never read as "long ago". */
function instant(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : Number.NaN
}

/**
 * When did anything last happen on this thread?
 *
 * The tailer's folded record timestamps, not the transcript file's mtime. The mtime moves for reasons
 * that are not activity (a cache write-back, an editor, a copy) and stands still for one that is (a
 * record written with an older timestamp), whereas `lastActivityAt` is the last timestamped record of
 * ANY kind the fold actually saw — the same reading the board's rest time is derived from, so the sweep
 * and the row the operator is looking at can never disagree about how long a thread has rested.
 *
 * All three are maxed rather than trusting `lastActivityAt` alone: they are independently maintained
 * fields, and taking the newest can only ever make the thread look MORE recently active, which is the
 * safe direction.
 */
export function lastActivityMs(tele: Pick<SessionTelemetry, "lastActivityAt" | "lastAssistantAt" | "lastUserAt">): number {
  const times = [instant(tele.lastActivityAt), instant(tele.lastAssistantAt), instant(tele.lastUserAt)].filter((t) => !Number.isNaN(t))
  return times.length ? Math.max(...times) : Number.NaN
}

/**
 * May this thread's daemon be torn down right now?
 *
 * Ordered cheapest-and-most-decisive first, and every arm is a REFUSAL — there is exactly one way to
 * reach `true`. The three work-in-flight readings are deliberately WIDER than the ones
 * `completionConfirmationHold` (router.ts) uses to gate Mark-as-done, and the difference is the point:
 *
 *  - that gate asks "is a HUMAN about to lose something they can see", and a human who clicks through
 *    it has decided; this asks the same question with NOBODY WATCHING, so `stale` and `rested`
 *    sub-agents count too. A `rested` child means its own fan-out is still running IN-PROCESS, and a
 *    `stale` child is one whose completion signal ntwine merely lost.
 *  - a pending permission card is safe to STOP through (the session is ending anyway) and catastrophic
 *    to hibernate through (the session is not — and the promise it is parked on dies unanswered).
 */
export function hibernationVerdict(
  candidate: HibernationCandidate,
  opts: { nowMs: number; idleMs: number; minDaemonAgeMs?: number },
): HibernationVerdict {
  const { row, telemetry: tele } = candidate
  // Only the broker owns a per-thread daemon whose death is recoverable by `resume: true`. A codex row
  // shares one app-server daemon across every thread (see the note at the bottom of this file).
  if (!isBrokerClaudeRow(row)) return { hibernate: false, blockedBy: "not-a-broker-thread" }
  // An archived or stopped row should have no daemon at all; one that does is a leak for
  // releaseSession/the orphan reaper to answer for, not a resting thread to reclaim.
  if (row.state === "archived" || row.archived === 1) return { hibernate: false, blockedBy: "archived" }
  if (row.exited === 1) return { hibernate: false, blockedBy: "stopped" }

  // No state is not evidence of no work. On 2026-08-06 a 566 MB transcript could not be primed, the
  // tailer held NO state for the busiest thread on the machine, a guard read that absence as "nothing
  // running", and retiring the daemon killed seven sub-agents whose reports were never delivered. That
  // is this exact class of decision, and it is why absence refuses here.
  if (!tele) return { hibernate: false, blockedBy: "no-telemetry" }
  // The transcript never materialized, so there is nothing for `resume: true` to read back. Hibernating
  // this thread would not park it — it would strand it.
  if (tele.noTranscript) return { hibernate: false, blockedBy: "no-transcript" }
  if (tele.turn !== "idle") return { hibernate: false, blockedBy: "turn-in-flight" }
  // Each of these is the daemon holding a promise open for a person. The turn check above already
  // covers them in practice (a blocked tool call keeps the turn in flight by construction); they are
  // asked again because "in practice" is not the standard this decision is held to.
  if (tele.permPrompt || tele.pendingAsk) return { hibernate: false, blockedBy: "awaiting-a-human" }
  if (candidate.pendingInteractions > 0) return { hibernate: false, blockedBy: "pending-approval" }
  // DIRECT children only, matching every other thread-state predicate — a descendant always sits under
  // a direct child, so reading the top level loses nothing. Any state counts, unlike the queue rules.
  if (tele.subAgents.some(isDirectSubAgent)) return { hibernate: false, blockedBy: "sub-agents" }
  if (tele.bgShells.length > 0) return { hibernate: false, blockedBy: "background-shells" }
  // A send ntwine has accepted but not yet watched land is text sitting in the DAEMON'S queue. Killing
  // the process throws it away, and the ledger row would go on claiming for an hour that the provider
  // holds it — the exact failure the dropped-input diagnostic exists to prevent, caused by ntwine itself.
  // A write-ahead `sending` send is a delivery (often a cold resume) in progress right now. A `failed`
  // one does NOT hold the daemon: its words are in the ledger, not the process.
  if (parseDeliveryLedger(row.delivery_ledger).some((d) => d.state === "sending" || d.state === "pending" || d.state === "enqueued" || d.state === "unconfirmed")) {
    return { hibernate: false, blockedBy: "undelivered-input" }
  }
  const minDaemonAge = opts.minDaemonAgeMs ?? HIBERNATE_MIN_DAEMON_AGE_MS
  if (!(opts.nowMs - candidate.daemonStartedAtMs >= minDaemonAge)) return { hibernate: false, blockedBy: "daemon-too-young" }

  const last = lastActivityMs(tele)
  if (Number.isNaN(last)) return { hibernate: false, blockedBy: "no-activity-timestamp" }
  const idle = opts.nowMs - last
  if (idle < opts.idleMs) return { hibernate: false, blockedBy: "not-idle-long-enough" }
  return { hibernate: true, idleMs: idle }
}

export interface HibernationDeps {
  /** Every live broker daemon under this project's state dir — the sweep's whole input set. */
  liveDaemons: () => { sessionId: string; createdAt: string }[]
  /** This project's registry rows, by session id. */
  rows: () => readonly SessionRow[]
  telemetry: (slug: string) => SessionTelemetry | undefined
  /** How many interactions still await a human on this exact session. */
  pendingInteractions: (slug: string, sessionId: string) => number
  /** Tear the daemon down. Returns whether a live one was actually retired. */
  retire: (input: { threadSlug: string; sessionId: string; reason: "hibernate" }) => boolean
  now?: () => number
  idleMs?: number
  minDaemonAgeMs?: number
  log?: (msg: string) => void
}

export interface HibernationResult {
  /** Threads whose daemon was torn down this pass. */
  hibernated: { slug: string; idleMs: number }[]
  /** Why each live daemon was left alone — the answer to "why is nothing being reclaimed". `ageMs` is
   *  the daemon's own age (NaN when its record carries no readable birth). */
  blocked: { slug: string; blockedBy: HibernationBlock; ageMs: number }[]
}

/** One sweep: enumerate live daemons → decide each → retire the ones that qualify. Never throws, and
 *  every enumeration failure reclaims NOTHING rather than guessing (fail closed, exactly like the
 *  orphan reaper's). */
export function sweepHibernationOnce(deps: HibernationDeps): HibernationResult {
  const nowMs = deps.now?.() ?? Date.now()
  const idleMs = deps.idleMs ?? hibernateIdleMs()
  const empty: HibernationResult = { hibernated: [], blocked: [] }

  let daemons: { sessionId: string; createdAt: string }[]
  let rows: readonly SessionRow[]
  try {
    daemons = deps.liveDaemons()
    rows = deps.rows()
  } catch {
    return empty // cannot see the board ⇒ touch nothing
  }
  if (daemons.length === 0) return empty
  const bySessionId = new Map(rows.map((row) => [row.session_id, row]))

  const result: HibernationResult = { hibernated: [], blocked: [] }
  for (const daemon of daemons) {
    const row = bySessionId.get(daemon.sessionId)
    // A daemon with no registry row belongs to nothing this project can reason about — another
    // project's state dir would not be enumerated here, so this is a row that was hard-deleted out from
    // under a running daemon. That is the orphan reaper's business, not a rest to reclaim.
    if (!row) continue
    let verdict: HibernationVerdict
    try {
      verdict = hibernationVerdict(
        {
          slug: row.slug,
          sessionId: daemon.sessionId,
          row,
          telemetry: deps.telemetry(row.slug),
          // A store that cannot be read answers "there might be one", never "there is none".
          pendingInteractions: (() => { try { return deps.pendingInteractions(row.slug, daemon.sessionId) } catch { return 1 } })(),
          daemonStartedAtMs: instant(daemon.createdAt),
        },
        { nowMs, idleMs, minDaemonAgeMs: deps.minDaemonAgeMs },
      )
    } catch {
      continue // a decision that threw decided nothing
    }
    if (!verdict.hibernate) {
      result.blocked.push({ slug: row.slug, blockedBy: verdict.blockedBy, ageMs: nowMs - instant(daemon.createdAt) })
      continue
    }
    let retired = false
    try {
      retired = deps.retire({ threadSlug: row.slug, sessionId: daemon.sessionId, reason: "hibernate" })
    } catch {
      continue
    }
    if (retired) result.hibernated.push({ slug: row.slug, idleMs: verdict.idleMs })
  }
  if (result.hibernated.length) {
    const detail = result.hibernated
      .map(({ slug, idleMs: ms }) => `${slug} (idle ${(ms / 3_600_000).toFixed(1)}h)`)
      .join(", ")
    deps.log?.(
      `hibernate: retired ${result.hibernated.length} idle broker daemon(s); each wakes on its next input by cold-resuming its transcript: ${detail}`,
    )
  }
  return result
}

/**
 * The census line: every daemon the sweep KEPT that has been up longer than the idle threshold, with the
 * refusal that kept it. Without it the log answered only "what was hibernated", never "why is this
 * daemon still here after a day" — on 2026-10-08 that question about a 29h daemon had to be answered
 * from the live DB and its transcript (it held eleven background shells and a fan-out of sub-agents).
 * A daemon younger than the threshold is not news: it could not have been hibernated yet whatever it is
 * doing. Undefined when there is nothing to say.
 */
export function describeResidentDaemons(result: HibernationResult, idleMs: number): string | undefined {
  const resident = result.blocked
    .filter((b) => Number.isFinite(b.ageMs) && b.ageMs >= idleMs)
    .sort((a, b) => b.ageMs - a.ageMs)
  if (!resident.length) return undefined
  const detail = resident.map((b) => `${b.slug} (up ${formatElapsed(b.ageMs)}, ${b.blockedBy})`).join(", ")
  return `hibernate: kept ${resident.length} broker daemon(s) up longer than ${formatElapsed(idleMs)}: ${detail}`
}

/** Start the periodic sweep. Returns a stop handle. The timer is unref'd — housekeeping never holds
 *  the event loop open. Deliberately NO startup sweep, unlike the orphan reaper: at boot the tailer has
 *  not primed yet, so every thread would read `no-telemetry` and the pass would be pure noise. Once per
 *  idle-threshold's worth of sweeps it also logs the census above. */
export function startThreadHibernator(deps: HibernationDeps & { intervalMs?: number }): () => void {
  const intervalMs = deps.intervalMs ?? hibernateSweepIntervalMs()
  const idleMs = deps.idleMs ?? hibernateIdleMs()
  const censusEvery = Math.max(1, Math.round(idleMs / intervalMs))
  let sweeps = 0
  const timer = setInterval(() => {
    try {
      const result = sweepHibernationOnce({ ...deps, idleMs })
      if (++sweeps % censusEvery === 0) {
        const census = describeResidentDaemons(result, idleMs)
        if (census) deps.log?.(census)
      }
    } catch {
      // never let a sweep error escape the timer
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

// ---- Why this is Claude-only ---------------------------------------------------------------------
//
// A codex thread has the same 42 MB-per-daemon shape on paper and a different one in fact: ONE
// `codex app-server` daemon serves every codex thread on the machine (three of them held 0.12 GB in the
// same census, against 19 GB for the claude side), so there is no per-thread process to reclaim. The
// per-thread cost that would matter — the model session inside it — has no teardown verb the bridge
// exposes and no `resume: true` equivalent to bring one back on the next input; `resumeOwnedSession`
// re-binds a thread the daemon still holds. Hibernating codex would therefore be a new mechanism, not
// an extension of this one, and it would be aimed at 0.6% of the memory. Left undone on purpose.
