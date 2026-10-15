import { heldQuestionViews, type ThreadView } from "@ntwine/shared"

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
// jarring if you're reading/typing input on another thread. make it work like an actual queue"). The
// top-level terminal command threads of the time had it worse: at rest they had no rest time at all, so
// they sorted by when the run STARTED.
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
// line. Session rows persist it (`session.queued_at`). (Terminal command threads persisted their own in
// `command_thread.queued_at` until 2026-09-29, when a terminal stopped being a thread: one waiting at a
// prompt now queues the thread it belongs to, on that thread's stamp.)
//
// AN UNKNOWN READING IS NOT A DEPARTURE. The board starts before the tailer, and the tailer primes at
// most 25 rows a tick, so for the first seconds after a boot every row it has not reached yet has no
// telemetry, or a half-built state it has not folded a transcript into — and a headless row read off
// either is `running`, out of the queue. Taking that at
// face value would clear every stored stamp and send the whole queue to the back in prime-batch order on
// every restart. So the board says which readings it can vouch for (`known`), and only a KNOWN reading
// outside the queue clears a stamp or counts as having seen the thread out. An unknown one changes
// nothing: the stamp waits for the thread's first real reading, and the thread keeps SHOWING queued at it
// meanwhile — a queue that blinked empty for the seconds of a prime moved every card on the reader's screen.
// Symmetrically, a reading the board drew from a STAND-IN with no stamp does not enter the queue unless it
// is urgent (2026-09-30): the stamps are durable, so their absence is the queue's membership as of the last
// server, and it holds until a real reading says otherwise.
//
// A STORED STAMP IS CHECKED ONCE, the first time its thread reads as queued after a boot: if the agent
// has spoken since it (a rest newer than the stamp), the thread left and re-entered while this server was
// not watching, and the stamp is refused for a fresh one. After that the stamp simply holds — a thread
// can be queued MID-TURN (a permission prompt, its terminal at a prompt), and whatever its
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
//
// A RELEASE WAITS ITS TURN TO BE WOKEN. Most holds end in a wake: a sub-agent's return re-invokes its
// parent, CI settling fires the PR watcher, a timer or a park's deadline delivers its prompt. The hold
// lets go first and the wake usually lands seconds later, so for that gap the thread sat in the queue — a
// card flashing in at the bottom and a desktop notification for a thread nobody needed to touch. So an entry
// off a hold is WITHHELD for SETTLE_MS (maintainer 2026-09-24, choosing it: "Hold a released thread out
// for ~12s"): a worker that wakes inside it never reaches the queue, and one that does not enters at the
// back when the window closes, stamped at that instant. The board reads `needsYou` as false meanwhile,
// so it neither notifies nor draws the card, and `queueSettling` tells the client no park stands. A wake
// the scheduler DEFERS (its quiet window after a recent handoff holds one for minutes) is not waited for:
// the thread goes in when the window closes, exactly as it did before there was a window. Only an entry
// off a PARK counts — the last known sighting out of the queue found the thread at rest, with the same
// rest it has now, behind a hold something wakes it from (the board's `parked`) — so an ordinary rest,
// whose last sighting out was its own running turn, is never delayed. Nor is a snooze lifted BEFORE its
// deadline: that was a person (Wake now), and nothing is coming to wake the thread — the bump a snooze may
// carry fires at the deadline, not when it is lifted. And an URGENT reading enters at once whatever held
// it: a permission prompt, a question, a crash, a limit pause.
//
// A THREAD ONLY LOSES ITS PLACE WHEN A PERSON ACTS ON IT (David 2026-09-28, choosing it: "Keep its
// place"). A thread already waiting in line is often re-woken by its own work — a shell finishing, a PR
// watcher, a child's report — and rests again with nobody having touched it. By the rules above that was a
// departure and a fresh arrival, so the card being read (a 2FA question, on 2026-09-24) vanished and came
// back at the bottom. So a departure the human did not cause leaves a claim on the old place, and an entry
// that finds its claim unbroken takes the place back. Everything a person does to a queued thread breaks
// it, through one of three channels the board can see:
//   • a HOLD the human made, seen on any reading out of the queue (`humanOut`): a snooze, done, a done card's
//     Watch, or a follow-up still in the delivery ledger. Every follow-up passes through the
//     ledger and the router re-assembles the board the moment it writes one, so no message the human sends
//     can slip past unseen — which is why this reads the ledger rather than the transcript, where a wake
//     ntwine delivers is a user turn exactly like one the human typed;
//   • a GATE only the human's own reply clears, on any reading while the thread waited IN the queue
//     (`humanGate`): a permission prompt, a native ask, a request in the interaction journal — the gate
//     ending is the human answering it;
//   • a REGISTERED QUESTION that stops being open, at any reading from its entry to its return: answered
//     (or withdrawn — the two look alike from here, and erring toward the back is the safe side). A NEW
//     question is not a person acting, so a thread that wakes itself and asks one keeps its place.
// A claim is memory only. It lasts from one departure to the next entry — seconds to minutes — and a
// restart between the two costs the place, which is where the thread would have gone without it.

// How long an entry off a park is withheld (see the header): one scheduler tick (10s) for a wake to be
// sent, plus delivery.
export const SETTLE_MS = 12_000

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

// What the board can say about one thread's reading that the view alone does not.
export interface QueueReading {
  /** Whether its `needsYou` is real, rather than a default standing in for telemetry the server does not
   *  have yet. */
  known(thread: ThreadView): boolean
  /** An unknown reading the board drew from a STAND-IN for that telemetry (board.ts boardTelemetry: the
   *  tail cache's pre-restart state, or a bare rest off the durable columns). Such a reading cannot put
   *  the thread in the queue — see `stamp`. Optional: absent reads as no stand-in, the old behaviour. */
  standIn?(thread: ThreadView): boolean
  /** Out of the queue at rest behind a hold that usually ends in a wake — so its entry is withheld. */
  parked(thread: ThreadView): boolean
  /** A reason the human must see at once, never withheld. */
  urgent(thread: ThreadView): boolean
  /** Out of the queue because of something the human did — a snooze, done, a follow-up on its way. */
  humanOut(thread: ThreadView): boolean
  /** Queued on something only the human's own reply clears: a permission prompt, a native ask. */
  humanGate(thread: ThreadView): boolean
}

export interface QueueClock {
  /** Set `queuedAt` on every queued thread in `threads`, in place, and record the edges it crossed. A
   *  withheld entry has its `needsYou` set to false, in place. */
  stamp(threads: readonly ThreadView[], nowMs: number, reading: QueueReading): void
  /** When the earliest withheld entry still ahead of `afterMs` is due to go in, so the board can
   *  assemble then rather than on its next unrelated refresh. */
  nextEntryAt(afterMs: number): number | undefined
}

function withhold(t: ThreadView): void {
  t.needsYou = false
  t.queueSettling = true
}

// The registered questions holding a thread: open, and not typed past (heldQuestionViews).
function openQuestions(t: ThreadView): Set<string> {
  return new Set(heldQuestionViews(t.questions).map((q) => q.id))
}

function allStillOpen(ids: ReadonlySet<string>, open: ReadonlySet<string>): boolean {
  for (const id of ids) if (!open.has(id)) return false
  return true
}

// The latest instant the thread itself can vouch for having stopped: the agent's own last output, or —
// for a thread with no agent output (a worker that died before speaking) — its last activity, then its
// spawn.
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
  // The last KNOWN assembly that saw each thread outside the queue (`at`: a rest before it means the
  // thread was held, and a rest after it is a plain rest), and what that sighting found — including the
  // deadline of any snooze holding it, so a snooze lifted early can be told from one that ran out.
  const lastSeenOut = new Map<string, { at: number; rest: number; parked: boolean; snoozedUntil: number }>()
  // Entries withheld off a park, and when each is due to go in.
  const settling = new Map<string, number>()
  // Each queued thread's stint in the queue so far: whether a person has acted on it (a gate answered, a
  // question resolved), and the questions open at its latest reading — what its departure is judged by.
  const stints = new Map<string, { touched: boolean; open: Set<string> }>()
  // Places held by threads that left the queue with no person acting on them, and the questions each
  // left with (see the header).
  const claims = new Map<string, { at: number; open: Set<string> }>()
  const noteQueued = (t: ThreadView, humanGate: boolean) => {
    const open = openQuestions(t)
    const was = stints.get(t.id)
    stints.set(t.id, { touched: humanGate || (was !== undefined && (was.touched || !allStillOpen(was.open, open))), open })
  }

  return {
    nextEntryAt(afterMs) {
      // Only deadlines still ahead: one that passed while its thread read unknown is settled at its next
      // known reading, and must not mask the deadlines behind it.
      const ahead = [...settling.values()].filter((due) => due > afterMs)
      return ahead.length > 0 ? Math.min(...ahead) : undefined
    },
    stamp(threads, nowMs, reading) {
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
        const vouched = reading.known(t)
        const durable = store.persists(t)
        if (durable && !vouched) allVouched = false
        if (t.needsYou !== true) {
          // Out of the queue on a reading nobody can vouch for, with a place in line from before the boot:
          // it is still queued as far as anyone knows, so it SHOWS queued until a real reading decides. A
          // card that dropped out for the seconds the tailer takes to prime and came back would move every
          // card below it on the reader's screen, on every restart.
          if (!vouched) {
            if (held !== undefined) {
              t.needsYou = true
              t.queuedAt = new Date(held).toISOString()
            }
            continue
          }
          lastSeenOut.set(t.id, { at: nowMs, rest: restMs(t), parked: reading.parked(t), snoozedUntil: Date.parse(t.snoozedUntil ?? "") })
          settling.delete(t.id)
          unchecked.delete(t.id)
          const left = stints.get(t.id)
          stints.delete(t.id)
          if (reading.humanOut(t)) claims.delete(t.id)
          // Only an agent can wake itself. A thread that leaves its terminal's prompt left because someone
          // typed the answer — a human gate (board.ts humanGate) — so its stint is `touched` and keeps no claim.
          else if (held !== undefined && t.kind === "session" && left && !left.touched) claims.set(t.id, { at: held, open: left.open })
          if (held !== undefined) {
            stamps.delete(t.id)
            if (durable) store.save(t, null)
          }
          continue
        }
        // Queued on a reading the board cannot vouch for yet: show the stamp it has, keep withholding an
        // entry already withheld, and decide nothing.
        //
        // AND A STAND-IN WITH NO STAMP IS NOT QUEUED (2026-09-30). The mirror of the branch above: just as
        // an unknown reading cannot take a thread OUT of the queue, a reading drawn from a stand-in cannot
        // put one IN. The board draws an unprimed row from what was true before the restart (board.ts
        // boardTelemetry), and stamps are durable and written on every entry, so a thread with none was
        // outside the queue as far as anyone knows — a stand-in that queues it anyway (an account older
        // than the last flush, a park whose deadline passed while nobody watched, a bare rest standing in
        // for a fence it cannot see) would put a card on the reader's screen for the seconds of a prime and
        // possibly take it straight back, the same swap this branch exists to prevent. A thread that really
        // did arrive while the server was down enters at its first real reading, seconds later, on the
        // rules below (and notifies then, as a real arrival should). Not `withhold`: that also says "no
        // park stands", which would pull a parked row out of the Snoozed band it is drawn in.
        //
        // EXCEPT AN URGENT ONE, as everywhere in this clock: a request in the interaction journal, a
        // registered question, a crash, a limit pause. Most of those are durable facts the board read
        // without the tailer at all — an approval a provider raised while the row is still unprimed has
        // to reach the human now, not after the prime.
        if (!vouched) {
          if (held !== undefined) t.queuedAt = new Date(held).toISOString()
          else if ((settling.get(t.id) ?? -Infinity) > nowMs) withhold(t)
          else if (reading.standIn?.(t) === true && !reading.urgent(t)) t.needsYou = false
          continue
        }
        const rest = restMs(t)
        // "Spoken since" means the AGENT's own output, never the activity fallback, which moves for reasons
        // that are not the agent speaking.
        const spoke = Date.parse(t.lastAssistantAt ?? "")
        const stale = unchecked.delete(t.id) && held !== undefined && spoke > held
        if (held !== undefined && !stale) {
          t.queuedAt = new Date(held).toISOString()
          noteQueued(t, reading.humanGate(t))
          continue
        }
        const sighting = lastSeenOut.get(t.id)
        // `nowMs < NaN` is false, so a sighting with no snooze never reads as lifted early.
        const liftedEarly = sighting !== undefined && nowMs < sighting.snoozedUntil
        if (sighting?.parked && sighting.rest === rest && !liftedEarly && !reading.urgent(t)) {
          const due = settling.get(t.id) ?? nowMs + SETTLE_MS
          if (nowMs < due) {
            settling.set(t.id, due)
            withhold(t)
            continue
          }
        }
        settling.delete(t.id)
        const claim = claims.get(t.id)
        claims.delete(t.id)
        // The bridge speaks only for a durable thread with NO stamp: one whose stamp was refused as stale
        // was queued as of the old server, not outside it, so its own rest is the best it has.
        const out = sighting?.at ?? (durable && held === undefined ? aliveBefore : undefined)
        let at = out === undefined || rest > out ? rest : nowMs
        if (!Number.isFinite(at) || at > nowMs) at = nowMs
        // Back from a wake nobody asked for, every question it left with still open: the place it left.
        if (claim && allStillOpen(claim.open, openQuestions(t))) at = claim.at
        stamps.set(t.id, at)
        stints.delete(t.id)
        noteQueued(t, reading.humanGate(t))
        t.queuedAt = new Date(at).toISOString()
        if (durable) store.save(t, t.queuedAt)
      }
      // A thread that is gone (purged, removed) takes its clock with it, so a slug reused later starts
      // fresh rather than inheriting a place in line.
      for (const id of [...stamps.keys()]) if (!seen.has(id)) stamps.delete(id)
      for (const id of [...lastSeenOut.keys()]) if (!seen.has(id)) lastSeenOut.delete(id)
      for (const id of [...unchecked]) if (!seen.has(id)) unchecked.delete(id)
      for (const id of [...settling.keys()]) if (!seen.has(id)) settling.delete(id)
      for (const id of [...stints.keys()]) if (!seen.has(id)) stints.delete(id)
      for (const id of [...claims.keys()]) if (!seen.has(id)) claims.delete(id)
      if (allVouched && nowMs - aliveSavedAt >= ALIVE_EVERY_MS) {
        aliveSavedAt = nowMs
        store.saveAlive(new Date(nowMs).toISOString())
      }
    },
  }
}
