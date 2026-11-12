import { useQuery, type QueryClient } from "@tanstack/react-query"
import type { PeersState } from "@ntwine/shared"
import { rpc } from "./rpc.ts"

// THE OTHER MACHINES this one is paired with (plans/thread-handoff.md). One reading for every surface that
// needs it — Settings → Other machines, and every thread's ⋯ menu, which offers a move only when there is
// somewhere to move to.
//
// MACHINE-WIDE: the server keeps one peer store per machine and every project's router answers the same
// (router.ts `peersState`), so the key is listed in lib/queryKeyScope.ts MACHINE_WIDE and any project's
// client may ask. Scoped per project, each project switch would mint a second copy of one answer, and a ⋯
// menu on another project's queue card would wait on its own fetch before it could offer the move.
export const PEERS_KEY = ["peersState"] as const

/** The peers reading. `pollMs` while something is expected to change it from the OTHER side — a pairing
 *  code is on screen, and the other machine entering it is what adds the row. */
export function usePeersState({ enabled = true, pollMs, fresh = false }: { enabled?: boolean; pollMs?: number; fresh?: boolean } = {}) {
  return useQuery<PeersState>({
    queryKey: PEERS_KEY,
    queryFn: () => rpc.peersState(),
    enabled,
    // The ⋯ menu mounts on every queue card and drawer; one answer serves them all for a minute. Settings
    // passes `fresh`, refetching on open, so the list it shows is never a minute old.
    staleTime: 60_000,
    refetchOnMount: fresh ? "always" : true,
    refetchInterval: pollMs ?? false,
    retry: false,
  })
}

export function invalidatePeers(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: PEERS_KEY })
}

/** The message of a failed call, in the server's own words. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
