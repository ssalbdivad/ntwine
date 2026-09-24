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
//   • A plain rest — the agent stopped AFTER the last assembly that saw it outside the queue — enters at
//     its rest time, so ordinary arrivals keep the exact order they always had. A thread that rested
//     BEFORE that sighting was held, and entered somewhere between the sighting and now; it is stamped
//     NOW, the late end of that window, because the early end would let it slip ahead of a thread that
//     arrived inside the window and is already on screen — the original bug in miniature.
//
// DURABLE, because the server restarts constantly and the alternative is re-deriving the key from the
// rest time at every boot — which puts every thread that entered off a wait back at the front of the
// line. Session rows persist it (`session.queued_at`), and so do terminal command threads
// (`command_thread.queued_at`): a run sitting at a prompt is queued before a restart and after it, and
// the boot's "interrupted" exit time must not re-date it.
//
// AN UNKNOWN READING IS NOT A DEPARTURE. The board starts before the tailer, and the tailer primes at
// most 25 rows a tick, so for the first seconds after a boot every row it has not reached yet has no
// telemetry, or a half-built state it has not folded a transcript into — and a headless row read off
// either is `running`, out of the queue. Taking that at
// face value would clear every stored stamp and send the whole queue to the back in prime-batch order on
// every restart. So the board says which readings it can vouch for (`known`), and only a KNOWN reading
// outside the queue clears a stamp or counts as having seen the thread out. An unknown one changes
// nothing: the stamp waits for the thread's first real reading.
//
// A STORED STAMP IS CHECKED ONCE, the first time its thread reads as queued after a boot: if the agent
// has spoken since it (a rest newer than the stamp), the thread left and re-entered while this server was
// not watching, and the stamp is refused for a fresh one. After that the stamp simply holds — a thread
// can be queued MID-TURN (a permission prompt, a silent turn, a command at a prompt), and whatever its
// agent or process writes while it waits must not move it.
//
// A RESTART IS A GAP IN THE SIGHTINGS, and the clock bridges it with one durable instant: when the last
// server was still watching (`alive`). It is written only after an assembly in which EVERY durable
// thread had a known reading — so each was either queued (and stamped) or seen outside the queue — and at
// most every ALIVE_EVERY_MS. A durable thread with no stored stamp was therefore outside the queue as of
// that instant, and after a boot it is the thread's last sighting out: one that rested since is a plain
// rest and keeps its rest time, and one that rested before it was held and let go while nobody was
// watching — a snooze that ran out overnight — joins the back like any other release instead of the
// front. A boot that dies before it has read every thread writes nothing, so the instant the next boot
// reads is never one that vouched for rows it had not seen. A row that never gets a known reading holds
// the instant where it was, which errs toward the rest time; so does the first boot after this landed,
// which has no instant at all and keeps exactly the order the queue had before the clock existed.

export interface QueueClockStore {
  /** Stamps a previous server persisted, by slug, and when it was last watching. Read once, at the first
   *  assembly, before anything is written. */
  load(): { stamps: ReadonlyMap<string, string>; alive?: string }
  /** Whether this thread's stamp is durable. Only a durable stamp's ABSENCE says anything after a boot,
   *  so only these threads inherit the old server's last sighting; the rest never reach `save`. */
  persists(thread: ThreadView): boolean
  /** Persist (ISO) or clear (null) one thread's stamp. Called only on an edge, never per assembly. */
  save(thread: ThreadView, at: string | null): void
  /** Record that the clock is watching as of `at` (ISO). Throttled to ALIVE_EVERY_MS. */
  saveAlive(at: string): void
}

// How stale the durable "still watching" instant may run. It only has to be recent enough that a hold
// ending in the gap before it is vanishingly rare; the cost is one settings write per period.
export const ALIVE_EVERY_MS = 15_000

export interface QueueClock {
  /** Set `queuedAt` on every queued thread in `threads`, in place, and record the edges it crossed.
   *  `known` says whether a thread's `needsYou` reading is real rather than a default standing in for
   *  telemetry the server does not have yet. */
  stamp(threads: readonly ThreadView[], nowMs: number, known: (thread: ThreadView) => boolean): void
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
  // When the previous server was last watching: the sighting-out every unstamped thread inherits at boot.
  let aliveBefore: number | undefined
  let aliveSavedAt = -Infinity
  // Stored stamps not yet checked against their thread's rest (see the header): slugs loaded at boot.
  const unchecked = new Set<string>()
  // The last KNOWN assembly that saw each thread outside the queue: a rest before it means the thread
  // was held, and a rest after it is a plain rest.
  const lastSeenOut = new Map<string, number>()

  return {
    stamp(threads, nowMs, known) {
      if (!stamps) {
        stamps = new Map()
        const loaded = store.load()
        for (const [slug, at] of loaded.stamps) {
          const ms = Date.parse(at)
          if (!Number.isFinite(ms)) continue
          stamps.set(slug, ms)
          unchecked.add(slug)
        }
        const alive = Date.parse(loaded.alive ?? "")
        if (Number.isFinite(alive)) aliveBefore = alive
      }
      const seen = new Set<string>()
      // Whether every durable thread this assembly had a known reading — the condition for `alive`.
      let allVouched = true
      for (const t of threads) {
        seen.add(t.id)
        const held = stamps.get(t.id)
        const vouched = known(t)
        const durable = store.persists(t)
        if (durable && !vouched) allVouched = false
        if (t.needsYou !== true) {
          if (!vouched) continue
          lastSeenOut.set(t.id, nowMs)
          unchecked.delete(t.id)
          if (held !== undefined) {
            stamps.delete(t.id)
            if (durable) store.save(t, null)
          }
          continue
        }
        // Queued on a reading the board cannot vouch for yet: show the stamp it has, decide nothing.
        if (!vouched) {
          if (held !== undefined) t.queuedAt = new Date(held).toISOString()
          continue
        }
        const rest = restMs(t)
        // "Spoken since" means the AGENT's own output, never the activity fallback: a terminal command has
        // none, and the boot that marks a run at a prompt interrupted re-dates its activity to the boot.
        const spoke = Date.parse(t.lastAssistantAt ?? "")
        const stale = unchecked.delete(t.id) && held !== undefined && spoke > held
        if (held !== undefined && !stale) {
          t.queuedAt = new Date(held).toISOString()
          continue
        }
        // The bridge speaks only for a durable thread with NO stamp: one whose stamp was refused as stale
        // was queued as of the old server, not outside it, so its own rest is the best it has.
        const out = lastSeenOut.get(t.id) ?? (durable && held === undefined ? aliveBefore : undefined)
        let at = out === undefined || rest > out ? rest : nowMs
        if (!Number.isFinite(at) || at > nowMs) at = nowMs
        stamps.set(t.id, at)
        t.queuedAt = new Date(at).toISOString()
        if (durable) store.save(t, t.queuedAt)
      }
      // A thread that is gone (purged, removed) takes its clock with it, so a slug reused later starts
      // fresh rather than inheriting a place in line.
      for (const id of [...stamps.keys()]) if (!seen.has(id)) stamps.delete(id)
      for (const id of [...lastSeenOut.keys()]) if (!seen.has(id)) lastSeenOut.delete(id)
      for (const id of [...unchecked]) if (!seen.has(id)) unchecked.delete(id)
      if (allVouched && nowMs - aliveSavedAt >= ALIVE_EVERY_MS) {
        aliveSavedAt = nowMs
        store.saveAlive(new Date(nowMs).toISOString())
      }
    },
  }
}
