import { queryOptions, useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query"
import { NTWINE_SUPERVISOR_STATUS_WAKE_EVENT, getNtwineSupervisorStatus, type NtwineSupervisorStatus, type StampedSupervisorStatus } from "./restart.ts"
import { store } from "../store.ts"

// ── ONE reader of /_ntwine/control/status, for every consumer ───────────────────────────────────────────
// Three call sites used to ask the supervisor the same question on three private schedules: App's
// hand-rolled control-plane loop, the Restart Ntwine button's mount probe, and the dev-build probe behind
// the worker-restart verb. Measured on the maintainer's board (2026-09-04) they fired at t+58ms, t+61ms
// and t+63ms of ONE navigation — three of the ~11 RPCs starting within 5ms of each other, into a browser
// HTTP/1.1 pool of six, in the burst that left a threadTranscript reporting `stall: 1978ms` before it was
// ever put on the wire.
//
// Each wanted the answer for its own reason, so none of them could simply be deleted; they share the
// query instead. react-query folds concurrent observers of one key into a single in-flight request, and
// re-arms every observer's refetch timer from the same update — so the poll stays ONE request per
// cadence however many surfaces read it, and a fourth caller costs nothing.
//
// Cadence is the union of what the old callers wanted: gentle at rest, prompt across a handoff (the
// window where the overlay is up and the operator is watching), plus the wake event that any accepted
// control action dispatches.
const AT_REST_MS = 8_000
const HANDOFF_MS = 500

export const SUPERVISOR_STATUS_KEY = ["supervisorStatus"] as const

/**
 * Fast while a transition is in flight — server-confirmed, OR optimistically raised by the button that
 * asked for it, which is the window where the supervisor has not yet answered but the overlay is up.
 */
export function supervisorPollMs(state: NtwineSupervisorStatus["state"] | undefined, restartPending: boolean): number {
  return state === "restarting" || restartPending ? HANDOFF_MS : AT_REST_MS
}

export const supervisorStatusQueryOptions = queryOptions({
  queryKey: SUPERVISOR_STATUS_KEY,
  // Every answer is stamped with the instant its request STARTED (pullfrog on #35, 2026-09-11): an
  // answer is not a point in time, and App's optimistic-restart guard has to tell a poll that was
  // already in flight when the operator clicked from one that can actually speak for the accepted
  // transition. The stamp is client-side only — never on the wire — and it also means no two answers
  // are structurally equal, so react-query hands App a fresh object per poll.
  queryFn: async (): Promise<StampedSupervisorStatus | null> => {
    const requestedAt = Date.now()
    const status = await getNtwineSupervisorStatus()
    return status ? { ...status, requestedAt } : null
  },
  // `null` is a legitimate ANSWER here, never an error: getNtwineSupervisorStatus folds an unreachable
  // supervisor, a non-protocol reply and the SPA HTML fallback all into it and never rejects. So there is
  // nothing to retry, and — unlike the module-level promise this replaces — nothing caches that window
  // for the life of the page either. The next poll is the retry, which is how a dev-only verb reappears
  // once a supervisor that was mid-restart at page load comes back.
  refetchInterval: (query) => supervisorPollMs(query.state.data?.state, store.controlPlaneRestartAttempt !== null),
  // Freshness tracks the poll's own period, which is what makes sharing the key actually share the READ.
  // Without it, react-query treats the entry as stale the instant it lands, so every observer arriving
  // LATER than the last answer refetches on mount — and the dev-build verb's observer is a thread-footer
  // one, one per queue card. That rebuilds the same fan-out one mount at a time. A mount inside the
  // period has nothing to add: the poll is already asking on schedule.
  staleTime: (query) => supervisorPollMs(query.state.data?.state, store.controlPlaneRestartAttempt !== null),
})

export function useSupervisorStatus(): UseQueryResult<StampedSupervisorStatus | null> {
  return useQuery(supervisorStatusQueryOptions)
}

let wakeClient: QueryClient | null = null

/**
 * Register the ONE wake listener, from main alongside the other init calls. Deliberately not per
 * consumer: `refetchQueries` cancels an in-flight read and starts another, so three listeners would turn
 * one accepted control action into three requests — the very fan-out this module exists to remove.
 */
export function initSupervisorStatus(queryClient: QueryClient): void {
  if (wakeClient) return
  wakeClient = queryClient
  window.addEventListener(NTWINE_SUPERVISOR_STATUS_WAKE_EVENT, () => {
    void queryClient.refetchQueries({ queryKey: SUPERVISOR_STATUS_KEY, exact: true })
  })
}
