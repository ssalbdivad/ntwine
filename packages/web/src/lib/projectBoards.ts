import { useQueries } from "@tanstack/react-query"
import type { BoardSnapshot } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"

// ONE PROJECT'S WHOLE BOARD, read from a page that names another — the phone page's Done tab
// (components/PhonePage.tsx), for the band the 3-second poll does not carry.
//
// `projectsQueues` carries every project's OPEN threads, which is all the queue and the list's current work
// need, and a COUNT of its Done ones: that band grows without bound, and a poll of every project every few
// seconds is the wrong place to ship it. So Done's rows — and External, the project's own terminals, which
// the poll drops — come from the project's own board snapshot, the same payload its live feed seeds from.
// Measured on the maintainer's machine (2026-09-28): 93KB for a project with 45 done threads, 5-7KB for the
// rest, each answered from the server's cached snapshot in under 5ms.
//
// Keyed `ofProject`, which the cache's project scoping leaves alone (lib/queryKeyScope.ts): the key already
// says whose board it is.

export function projectBoardKey(projectId: string): readonly ["ofProject", string, "board"] {
  return ["ofProject", projectId, "board"]
}

/** Fresh enough to answer from the cache without a round trip. */
const BOARD_STALE_MS = 20_000

function projectBoardQuery(projectId: string) {
  return {
    queryKey: projectBoardKey(projectId),
    queryFn: (): Promise<BoardSnapshot> => projectRpc(projectId).board(),
    staleTime: BOARD_STALE_MS,
  }
}

/**
 * Several projects' boards at once, by id, in `projectIds`' order — the phone page's Done tab, which lists
 * every shown project's finished threads in one list (components/PhonePage.tsx). `live` fetches and keeps
 * them fresh (re-read every `refetchMs`, since no list is mounted there to invalidate them when the poll's
 * Done count moves); otherwise each answers from whatever the cache holds.
 */
export function useProjectBoards(projectIds: readonly string[], live: boolean, refetchMs?: number): (BoardSnapshot | undefined)[] {
  return useQueries({
    queries: projectIds.map((id) => ({ ...projectBoardQuery(id), enabled: live, refetchInterval: live ? refetchMs : undefined })),
  }).map((query) => query.data)
}
