import { useCallback, useMemo, useEffect } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { acpModelPreset, acpModelSlug, type AcpAgent, type Backend, type ClaudeModel, type CodexModel, type SetDispatchPreferenceInput } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { useDraft } from "../lib/drafts.ts"
import type { ProfileGridSelection } from "../lib/profileGrid.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import {
  applyDispatchPreferenceUpdate,
  parseDispatchPick,
  pickFromSelection,
  resolveDispatchPreferences,
  sameDispatchProfile,
  withDispatchPick,
  type DispatchPick,
  type ResolvedDispatchPreferences,
} from "../lib/dispatchPreferences.ts"

const PREFERENCES_KEY = ["dispatchPreferencesGet"] as const
const SAVE_KEY = ["dispatchPreferenceSet"] as const

// Every OTHER tab of this browser on this origin. The record is one machine-wide file, but each tab
// caches its read and the prompt box stays mounted for the tab's whole life, so without a nudge a
// window left open beside the one you changed it in kept dispatching on the old profile.
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("ntwine:dispatch-preferences")
// Node's BroadcastChannel holds the event loop open until closed, so under the unit tests every file that
// imports the prompt box (Sidebar.tsx, for one) finished its tests and then never exited, wedging the run.
// Browsers have no `unref`; a page's channel lives as long as the page, which is what it is for.
;(channel as { unref?: () => void } | undefined)?.unref?.()

/** The durable new-thread default changed server-side: re-read it here and in every other tab. */
export function dispatchPreferencesChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
  channel?.postMessage("changed")
}

/** A surface's pick and its setter — kept beside the draft in the prompt box, component state in a modal. */
export type DispatchPickState = readonly [DispatchPick | undefined, (next: DispatchPick | undefined) => void]
const NO_PICK: DispatchPickState = [undefined, () => {}]

/**
 * The prompt box's pick, kept in the draft store beside its prompt (drafts.ts). A pick belongs to the
 * thread being written, so it survives what that draft survives — a remount, the anywhere-modal
 * closing, a same-tab reload — and the dispatch that clears the prompt clears it too.
 */
export function useDraftDispatchPick(key: string): DispatchPickState {
  const [raw, setRaw, clearRaw] = useDraft(key)
  const pick = useMemo(() => parseDispatchPick(raw), [raw])
  const setPick = useCallback((next: DispatchPick | undefined) => (next ? setRaw(JSON.stringify(next)) : clearRaw()), [setRaw, clearRaw])
  return [pick, setPick] as const
}

// THE durable new-thread DEFAULT (backend + model + effort), shared by every surface that starts a
// thread: the prompt box and the GitHub batch picker. Each surface lays its own PICK over it — the
// profile for the thread or batch it starts next — and goes back to the default once that dispatch is
// out. Only `makeDefault` writes the record, so escalating one task to max stays with that task
// instead of becoming every later thread's profile (see DispatchPick).
export function useDispatchProfile(pickState: DispatchPickState = NO_PICK): {
  // What the surface dispatches with: its pick over the default. Undefined until BOTH durable intent
  // and the Codex catalogue have landed. Rendering a profile before then can classify a saved Codex
  // model as Claude merely because the catalogue is cold.
  resolved: ResolvedDispatchPreferences | undefined
  // The default alone — what every new thread starts from, and what a surface returns to after it
  // dispatches. Same readiness as `resolved`.
  defaultResolved: ResolvedDispatchPreferences | undefined
  // The pick names a different profile from the default, so "Make default" has something to do.
  picked: boolean
  codexList: readonly CodexModel[]
  // The Claude aliases with the edition the pinned runtime resolves each to ("Opus 5.5") — labels
  // only. Empty while the runtime answers or on a server too old to ask, which is why readiness never
  // waits on it: the rows fall back to their family words, and the profile itself is keyed on the alias.
  claudeList: readonly ClaudeModel[]
  // The ACP agents the server knows, `available` for the ones on its PATH. Empty on a server too old
  // to answer, which is why neither readiness nor `loadError` waits on this query.
  acpList: readonly AcpAgent[]
  loadError: boolean
  // A cell chosen in the profile grid, and a model chosen inside an ACP agent: both set the pick.
  choose: (selection: ProfileGridSelection) => void
  chooseAcpModel: (agentId: string, modelId: string | undefined) => void
  // The pick becomes the default for every new thread, in every project.
  makeDefault: () => void
} {
  const [pick, setPick] = pickState
  const queryClient = useQueryClient()
  // The MOST RECENT default wins, wherever it was set: another tab, another device, another project. A
  // thread's own profile control never sets it — its pick stays on that thread (maintainer
  // 2026-09-24) — and neither does a pick in a dispatch surface. So this read re-runs whenever
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
  // These two are answered by a PROJECT (its runtime, its PATH), so a prompt box on another project's
  // card asks that project (ThreadProjectScope), under a key that names it (upstream ff43f7d3, in the
  // fork's scoping).
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const scoped = (key: string) => (projectId ? [key, { project: projectId }] : [key])
  const claudeModels = useQuery({ queryKey: scoped("claudeModels"), queryFn: () => api.claudeModels(), retry: false })
  const claudeList = claudeModels.data ?? []
  const acpAgents = useQuery({ queryKey: scoped("acpAgents"), queryFn: () => api.acpAgents() })
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
      showToast(`Could not save the new-thread default: ${(error as Error).message.slice(0, 80)}`)
    },
    onSettled: () => {
      // Only the LAST of a burst re-reads: an earlier one's answer would overwrite the optimistic value
      // of a later pick still in flight.
      if (queryClient.isMutating({ mutationKey: SAVE_KEY }) === 1) dispatchPreferencesChanged(queryClient)
    },
  })

  // The ACP catalogue counts once it has SETTLED either way: a saved ACP profile must not read as
  // unavailable merely because the list is cold, and an older server that lacks the RPC must not block
  // the composer forever. Only an ACP profile waits for it — it is all the list resolves — and the list
  // is per project (it merges the project's settings), so a Claude or Codex profile sat on "Profile
  // loading…", its Enter ignored, each time the box moved to a project it had not asked yet: 316ms and
  // 2.3s stepping through four projects with ⌥↓ (2026-09-28). A pick is a profile here too: an ACP
  // pick over a Claude default resolves against the same list.
  const acpSettled = acpAgents.isSuccess || acpAgents.isError
  const needsAcp = preferences.data?.backend === "acp" || pick?.backend === "acp"
  const controlsReady = !!preferences.data && !!codexModels.data && (!needsAcp || acpSettled)
  const defaultResolved = useMemo(
    () => controlsReady ? resolveDispatchPreferences(preferences.data!, codexList, acpList) : undefined,
    [controlsReady, preferences.data, codexList, acpList],
  )
  const resolved = useMemo(
    () => controlsReady && pick ? resolveDispatchPreferences(withDispatchPick(preferences.data!, pick), codexList, acpList) : defaultResolved,
    [controlsReady, preferences.data, codexList, acpList, pick, defaultResolved],
  )

  const choose = useCallback((selection: ProfileGridSelection) => {
    if (!resolved || !defaultResolved) return
    const backend = selection.provider as Backend
    // The grid names an ACP AGENT, never the model inside it (that is the dropdown beside the pill).
    // Re-picking the agent already in effect keeps its model; landing on the default's agent lands on
    // the default's model too, rather than on a pick that differs from it only by a dropped tail.
    // A preset row is a model with efforts, so a click on it is an ordinary model+effort pick.
    if (backend === "acp" && resolved.backend === "acp" && selection.model === resolved.pickerModel && !acpModelPreset(selection.model)) return
    const model = backend === "acp" && defaultResolved.backend === "acp" && selection.model === defaultResolved.pickerModel
      ? defaultResolved.model
      : selection.model
    setPick(pickFromSelection({ backend, model, effort: selection.effort }, defaultResolved))
  }, [resolved, defaultResolved, setPick])

  // The chosen model becomes the pick's slug (`acp:<agent>@<model>`); none (the agent's own default)
  // drops the tail.
  const chooseAcpModel = useCallback((agentId: string, modelId: string | undefined) => {
    setPick(pickFromSelection({ backend: "acp", model: acpModelSlug(agentId, modelId) }, defaultResolved))
  }, [defaultResolved, setPick])

  const saveDefault = preference.mutate
  const makeDefault = useCallback(() => {
    if (!resolved) return
    saveDefault(
      { field: "profile", backend: resolved.backend, model: resolved.model, effort: (resolved.effort || undefined) as DispatchPick["effort"] },
      // Dropped only once the record holds it. The optimistic write already hides the control; a
      // failed one rolls the record back, and the kept pick brings the control back with it.
      { onSuccess: () => setPick(undefined) },
    )
  }, [resolved, saveDefault, setPick])

  return {
    resolved,
    defaultResolved,
    picked: !!resolved && !!defaultResolved && !sameDispatchProfile(resolved, defaultResolved),
    codexList,
    claudeList,
    acpList,
    loadError: preferences.isError || codexModels.isError,
    choose,
    chooseAcpModel,
    makeDefault,
  }
}
