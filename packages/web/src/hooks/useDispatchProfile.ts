import { useEffect, useMemo } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { AcpAgent, CodexModel, SetDispatchPreferenceInput } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import {
  applyDispatchPreferenceUpdate,
  resolveDispatchPreferences,
  type ResolvedDispatchPreferences,
} from "../lib/dispatchPreferences.ts"

const PREFERENCES_KEY = ["dispatchPreferencesGet"] as const
const SAVE_KEY = ["dispatchPreferenceSet"] as const

// Every OTHER tab of this browser on this origin. The record is one machine-wide file, but each tab
// caches its read and the prompt box stays mounted for the tab's whole life, so without a nudge a
// window left open beside the one you changed it in kept dispatching on the old profile.
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("frizz:dispatch-preferences")
// Node's BroadcastChannel holds the event loop open until closed, so under the unit tests every file that
// imports the prompt box (Sidebar.tsx, for one) finished its tests and then never exited, wedging the run.
// Browsers have no `unref`; a page's channel lives as long as the page, which is what it is for.
;(channel as { unref?: () => void } | undefined)?.unref?.()

/** The durable new-thread profile changed server-side: re-read it here and in every other tab. */
export function dispatchPreferencesChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
  channel?.postMessage("changed")
}

// THE durable new-thread profile (backend + model + effort), shared by every surface that starts a
// thread from the prompt box: the dispatch composer and the GitHub batch picker. Both read the same
// preference row and write it through the same scoped mutation, so a selection made in either is the
// profile the other dispatches with — there is no second, surface-local copy to drift.
export function useDispatchProfile(): {
  // Undefined until BOTH durable intent and the Codex catalogue have landed. Rendering a profile
  // before then can classify a saved Codex model as Claude merely because the catalogue is cold.
  resolved: ResolvedDispatchPreferences | undefined
  codexList: readonly CodexModel[]
  // The ACP agents the server knows, `available` for the ones on its PATH. Empty on a server too old
  // to answer, which is why neither readiness nor `loadError` waits on this query.
  acpList: readonly AcpAgent[]
  loadError: boolean
  saveProfile: (update: SetDispatchPreferenceInput) => void
} {
  const queryClient = useQueryClient()
  // The MOST RECENT pick wins, wherever it was made: another tab, another device, another project, or
  // a thread's own profile control (the server writes that one through). So this read re-runs whenever
  // the page comes back into view — the app-wide default is not to — and on another tab's broadcast.
  const preferences = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => rpc.dispatchPreferencesGet(),
    refetchOnWindowFocus: true,
  })
  useEffect(() => {
    if (!channel) return
    const refetch = () => void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
    channel.addEventListener("message", refetch)
    return () => channel.removeEventListener("message", refetch)
  }, [queryClient])
  // The codex model catalogue + per-model effort options, from the authoritative ~/.codex cache (never a
  // hand-maintained list).
  const codexModels = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels() })
  const codexList = codexModels.data ?? []
  const acpAgents = useQuery({ queryKey: ["acpAgents"], queryFn: () => rpc.acpAgents() })
  const acpList = acpAgents.data ?? []

  const preference = useMutation({
    mutationFn: (update: SetDispatchPreferenceInput) => rpc.dispatchPreferenceSet(update),
    // TanStack serializes mutations sharing this scope. This prevents a fast pair of selections from
    // reaching SQLite out of order while optimistic query data keeps every mounted composer in sync.
    scope: { id: "dispatch-preferences" },
    mutationKey: SAVE_KEY,
    onMutate: async (update) => {
      // A read already in flight (a focus refetch, another tab's broadcast) answers with the record as
      // it stood BEFORE this pick; landing after the optimistic write, it would snap the pill back and
      // hand the next dispatch the old profile. Cancel it first; onSettled re-reads.
      await queryClient.cancelQueries({ queryKey: PREFERENCES_KEY })
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof rpc.dispatchPreferencesGet>>>(PREFERENCES_KEY)
      if (current) queryClient.setQueryData(PREFERENCES_KEY, applyDispatchPreferenceUpdate(current, update))
    },
    onError: (error) => {
      showToast(`Could not save new-thread preference: ${(error as Error).message.slice(0, 80)}`)
    },
    onSettled: () => {
      // Only the LAST of a burst re-reads: an earlier one's answer would overwrite the optimistic value
      // of a later pick still in flight.
      if (queryClient.isMutating({ mutationKey: SAVE_KEY }) === 1) dispatchPreferencesChanged(queryClient)
    },
  })

  // The ACP catalogue counts once it has SETTLED either way: a saved ACP profile must not read as
  // unavailable merely because the list is cold, and an older server that lacks the RPC must not block
  // the composer forever.
  const controlsReady = !!preferences.data && !!codexModels.data && (acpAgents.isSuccess || acpAgents.isError)
  const resolved = useMemo(
    () => controlsReady ? resolveDispatchPreferences(preferences.data!, codexList, acpList) : undefined,
    [controlsReady, preferences.data, codexList, acpList],
  )

  return {
    resolved,
    codexList,
    acpList,
    loadError: preferences.isError || codexModels.isError,
    saveProfile: preference.mutate,
  }
}
