import type { ThreadView } from "@frizz/shared"

// THE QUEUE CLOCK — when each thread ENTERED the queue, which is what the queue is ordered by.
//
// The queue used to order by the agent's rest time (`lastAssistantAt`), on the theory that a thread
// enters the queue the moment its agent stops talking. That holds for a plain rest and for nothing
// else. A thread that rests BEHIND a wait — a live sub-agent, CI still running on its PR, a declared
// park, an armed timer, the human's own snooze, a stale delivery — sits outside the queue for minutes
// or hours and then enters it without saying another word, carrying the rest time of a turn that
// ended long ago. Under oldest-first that sorted it ABOVE everything the human had been waiting on,
// straight into the card they were reading or answering, and the "queue" behaved like a stack
// (maintainer 2026-09-24: "when a new thread is ready, it moves to the top of the *stack* which can be
// jarring if you're reading/typing input on another thread. make it work like an actual queue"). A
// terminal command thread had it worse: at rest it had no rest time at all, so it sorted by when the
// run STARTED.
//
// So the order key is the enqueue instant itself, observed rather than inferred: the board runs every
// thread through `stamp` on each assembly (the tailer's ~1s nudge plus the 15s reconcile), and the
// clock notices the false→true edge of `needsYou`.
//
//   • A thread keeps its stamp for exactly as long as it stays queued, so nothing that happens to it
//     while it waits — a sub-agent finishing, a label moving, a reader opening it — can move it.
//   • Leaving the queue (the human answers it, snoozes it, marks it done; a wait takes it back) forgets
//     the stamp, so its next entry joins the BACK of the line like any other arrival.
//   • The stamp is the best bound on the edge the clock has: no earlier than the thread's own rest (it
//     cannot have been waiting on the human before its agent stopped) and no earlier than the last
//     assembly that saw it outside the queue. For a plain rest that IS the rest time, so ordinary
//     arrivals keep the exact order they always had; for a wait that let go it is within one assembly
//     of the moment it did.
//
// DURABLE, because the server restarts constantly and the alternative is re-deriving the key from the
// rest time at every boot — which puts every thread that entered off a wait back at the front of the
// line. Session rows persist it (`session.queued_at`); command threads need not, because their rest
// time is exact (the run's exit, or the output that left it at a prompt).
//
// THE FIRST ASSEMBLY AFTER BOOT IS A BASELINE. It adopts every stored stamp a queued thread still has
// and clears none, the way the needs-decision notifier primes instead of firing: the board's first
// reading must not be able to reshuffle the line. The one stored stamp it refuses is one the agent has
// since spoken past — the thread rested again while this server was down, so it left and re-entered.

export interface QueueClockStore {
  /** Stamps a previous server persisted, by slug. Read once, at the first assembly. */
  load(): ReadonlyMap<string, string>
  /** Persist (ISO) or clear (null) one thread's stamp. Called only on an edge, never per assembly. */
  save(thread: ThreadView, at: string | null): void
}

export interface QueueClock {
  /** Set `queuedAt` on every queued thread in `threads`, in place, and record the edges it crossed. */
  stamp(threads: readonly ThreadView[], nowMs: number): void
}

// The latest instant the thread itself can vouch for having stopped: the agent's own last output, or —
// for a thread with no agent output (a terminal command, a worker that died before speaking) — its last
// activity, then its spawn.
function restMs(t: ThreadView): number {
  for (const at of [t.lastAssistantAt, t.lastActivityAt, t.spawnedAt]) {
    const ms = Date.parse(at ?? "")
    if (Number.isFinite(ms)) return ms
  }
  return -Infinity
}

export function createQueueClock(store: QueueClockStore): QueueClock {
  let stamps: Map<string, number> | undefined
  // The last assembly that saw each thread OUTSIDE the queue — the lower bound on when it entered.
  const lastSeenOut = new Map<string, number>()
  let primed = false

  return {
    stamp(threads, nowMs) {
      if (!stamps) {
        stamps = new Map()
        for (const [slug, at] of store.load()) {
          const ms = Date.parse(at)
          if (Number.isFinite(ms)) stamps.set(slug, ms)
        }
      }
      const seen = new Set<string>()
      for (const t of threads) {
        seen.add(t.id)
        const held = stamps.get(t.id)
        if (t.needsYou !== true) {
          lastSeenOut.set(t.id, nowMs)
          if (held !== undefined && primed) {
            stamps.delete(t.id)
            store.save(t, null)
          }
          continue
        }
        const rest = restMs(t)
        if (held !== undefined && (primed || !(rest > held))) {
          t.queuedAt = new Date(held).toISOString()
          continue
        }
        let at = Math.max(rest, lastSeenOut.get(t.id) ?? -Infinity)
        if (!Number.isFinite(at) || at > nowMs) at = nowMs
        stamps.set(t.id, at)
        t.queuedAt = new Date(at).toISOString()
        store.save(t, t.queuedAt)
      }
      // A thread that is gone (purged, removed) takes its clock with it, so a slug reused later starts
      // fresh rather than inheriting a place in line.
      for (const id of [...stamps.keys()]) if (!seen.has(id)) stamps.delete(id)
      for (const id of [...lastSeenOut.keys()]) if (!seen.has(id)) lastSeenOut.delete(id)
      primed = true
    },
  }
}
