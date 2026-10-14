// ── HOW LONG WAS THE MACHINE ACTUALLY AWAKE? ──────────────────────────────────────────────────────────
//
// ntwine judges silence by the wall clock: a child transcript untouched for 15 minutes reads stale, a turn
// quiet for 15 minutes queues. But when the host sleeps, the wall clock keeps going while every process on
// it is frozen — the agent, its command, and the harness's own `timeout` timer, which runs on a monotonic
// clock. On wake, every quiet child reads dead at once for time nobody spent.
//
// Measured, not assumed (arktype session a627551f, 2026-09-30): a workflow agent's transcript sat still for
// 68 minutes inside a Bash call declaring a 30-minute timeout, and its parent concluded it was probably
// hung. The call's own `uptime` lines read 11:50 → 11:59 across it — nine minutes of machine — and the
// command's report timed its work at 538s. The other 59 were the laptop asleep, and the 30-minute timeout
// never fired because its timer never saw them.
//
// So silence is measured in AWAKE time. A process cannot see its own suspension, but it can see the jump
// afterward: across a suspend the wall clock advances and the monotonic clock (performance.now — frozen
// with the process on Linux and macOS) does not. Sampling both on every tailer tick records each such gap
// as an interval, and a span of wall time minus the intervals inside it is the awake time in that span.
// An NTP step forward reads the same way, and is correctly treated the same: no process timer saw it.
//
// Fails toward the old behaviour. A platform whose monotonic clock counts sleep records nothing, and the
// span is plain wall time again — never shorter than the truth by more than one tick.

/** A wall-clock jump the monotonic clock did not share, below which it is scheduling noise. */
const MIN_SUSPEND_MS = 30_000
/** Suspensions older than this are dropped; nothing is measured across a span that long. */
const KEEP_MS = 48 * 60 * 60_000
const KEEP_MAX = 512

export interface AwakeClock {
  /** Record a sample. Cheap; called on every tick. */
  sample(): void
  /** Awake milliseconds between two wall instants: the span minus every recorded suspension inside it. */
  awakeBetween(fromMs: number, toMs: number): number
}

export function createAwakeClock(wallNow: () => number = Date.now, monoNow: () => number = () => performance.now()): AwakeClock {
  let last: { wall: number; mono: number } | undefined
  const suspended: Array<{ from: number; to: number }> = []
  const sample = () => {
    const wall = wallNow()
    const mono = monoNow()
    if (last) {
      const drift = wall - last.wall - (mono - last.mono)
      // Where inside the gap the suspension fell cannot be known; the awake part of it is one tick at most.
      if (drift > MIN_SUSPEND_MS) suspended.push({ from: wall - drift, to: wall })
      while (suspended.length > 0 && (suspended.length > KEEP_MAX || suspended[0]!.to < wall - KEEP_MS)) suspended.shift()
    }
    last = { wall, mono }
  }
  return {
    sample,
    awakeBetween(fromMs, toMs) {
      sample()
      let span = toMs - fromMs
      if (span <= 0) return span
      for (const s of suspended) {
        const overlap = Math.min(toMs, s.to) - Math.max(fromMs, s.from)
        if (overlap > 0) span -= overlap
      }
      return span
    },
  }
}

/** The process's own clock: shared by the tailer and the router's drawer listing, which run in one process. */
export const processAwakeClock: AwakeClock = createAwakeClock()

/** Plain wall time — what a test with an injected clock, and a caller with no awake clock, measures. */
export const wallSpan = (fromMs: number, toMs: number): number => toMs - fromMs
