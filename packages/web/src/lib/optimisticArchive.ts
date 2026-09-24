import { useMemo } from "react"
import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { isActivelyRunning } from "../groups.ts"

// OPTIMISTIC ARCHIVE STATE — "this thread is done", rendered on the rail the instant the operator
// clicks rather than when the server can prove it. The exact twin of lib/steering.ts, for the other
// direction, and it exists for the same reason: a lifecycle verb whose two surfaces disagreed.
//
// The QUEUE card has dismissed optimistically since the optimistic-done work (see
// queueOptimisticDone.e2e.test.ts) — click Mark as done and the card fades immediately, ahead of the
// completeThread round-trip. The SIDEBAR had no such path: its bands are derived purely from
// board.threads, so the row sat in Rested until the server's board delta arrived. Every millisecond
// the server took to answer was a millisecond where the card was gone and the row was still there
// (maintainer 2026-08-11: "often extreme delay in updating sidebar after clicking Mark as done").
// Server latency is worth fixing on its own terms — and is, separately — but a rail that waits on a
// round-trip to show a decision the operator already made is the wrong shape at ANY latency.
//
// Not a second source of truth: the hint only fires while server truth has said nothing, and yields the
// moment it does.
const archiving = proxy({ at: {} as Record<string, number> })

// How long the hint may outlive its evidence. A completion that has not shown up on the board in this
// long is one the operator should see the truth about rather than a guess — and the explicit rollback
// paths below (a declined completion, a failed RPC) normally clear it long before this fires.
export const ARCHIVE_OPTIMISM_MS = 12_000

const expiries = new Map<string, ReturnType<typeof setTimeout>>()

export function markArchived(slug: string, nowMs = Date.now()): void {
  archiving.at[slug] = nowMs
  const prior = expiries.get(slug)
  if (prior !== undefined) clearTimeout(prior)
  // The cap must REPAINT, not merely elapse: nothing else is guaranteed to re-render a quiet rail, so
  // without this a mispredicted archive could sit under Done for the rest of the session.
  expiries.set(slug, setTimeout(() => {
    expiries.delete(slug)
    delete archiving.at[slug]
  }, ARCHIVE_OPTIMISM_MS))
}

// The server declined (an executing turn wants confirmation) or the RPC failed — the thread is not
// done after all, so the row goes back where it was.
export function clearArchived(slug: string): void {
  const prior = expiries.get(slug)
  if (prior !== undefined) { clearTimeout(prior); expiries.delete(slug) }
  delete archiving.at[slug]
}

export function useArchivingAt(): Record<string, number> {
  return useSnapshot(archiving).at as Record<string, number>
}

// THE overlay. Deliberately the same shape as optimisticallySteered: assert the FIELDS the server will
// itself report, not a "hide this row" flag, so every existing pure predicate (sectionOf, isSnoozed,
// needsAction, sessionIndicatorKind) reaches the same conclusion from one rule and the row lands in
// exactly the band truth will put it in.
export function optimisticallyArchived(t: ThreadView, at: number | undefined, nowMs = Date.now()): ThreadView {
  if (at === undefined || nowMs - at > ARCHIVE_OPTIMISM_MS) return t
  // Server truth has landed — return BY IDENTITY so memoized rows skip the re-render.
  if (t.state === "archived") return t
  // A thread still working is not predicted: completeThread asks before it stops one, and Done is no
  // longer lifted for a running row, so predicting here would flash it under Done ahead of that ask.
  if (isActivelyRunning(t)) return t
  return {
    ...t,
    state: "archived",
    archived: true,
    // An archived thread is not waiting on the human. Left set, the row would land under Done still
    // wearing its needs-you mark and still counting toward the queue — the same half-applied state the
    // steer overlay clears in the other direction.
    needsYou: false,
    pendingAsk: undefined,
    pendingQuestion: false,
    actionableInteraction: false,
  }
}

// Apply the overlay across a board's threads. A thread with no pending archive is returned BY IDENTITY.
export function useOptimisticallyArchived(threads: readonly ThreadView[]): ThreadView[] {
  const at = useArchivingAt()
  return useMemo(() => threads.map((t) => optimisticallyArchived(t, at[t.id])), [threads, at])
}
