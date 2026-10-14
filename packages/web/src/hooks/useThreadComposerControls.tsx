import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useSnapshot } from "valtio"
import { acpAgentIdFromModel, acpModelIdFromModel, acpModelPreset, acpModelSlug, type PermissionMode, type ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { threadFollowUpBlocked, threadComposerStatus, threadPermissionBlockedReason, threadPermissionEffectMessage } from "../lib/threadPermissions.ts"
import { showToast, store } from "../store.ts"
import { ProfileGridSelector } from "../components/ProfileGridSelector.tsx"
import { AcpModelSelect } from "../components/AcpModelSelect.tsx"
import { ThreadPermissionControl } from "../components/ThreadPermissionControl.tsx"
import { CLAUDE_DISPATCH_PERMISSION_OPTIONS, claudePermValue } from "../lib/options.ts"
import { threadProfileControlState } from "../lib/threadProfile.ts"
import { stepProfileGridEffort } from "../lib/profileGrid.ts"
import { ownedByThisPage } from "../lib/projectOwnership.ts"

// One control strip for every place a registered thread can be steered: the model/effort selector, and
// — for a Claude thread — the Auto/Bypass permission picker beside it. This lives outside the component
// module so exporting the hook does not invalidate Vite Fast Refresh for ThreadActionBar.
//
// THE PERMISSION PICKER CAME BACK, NARROWED. Every per-thread permission/sandbox control was removed
// from this strip on 2026-07-23, and the reason was sound for the controls that existed: they offered
// the RESTRICTIVE modes, and a headless worker narrowed to `default` or `acceptEdits` or a codex
// `read-only` just wedges on an approval nobody is watching. What the maintainer asked for on
// 2026-08-13 is the other half of that axis — "for Claude Code specifically, I'm curious if there's a
// way for us to switch between Auto mode and Bypass Permissions mode" — and neither of those two can
// wedge anything: `auto` is what dispatch already launches with, and bypass is strictly more permissive
// still. So the options here are exactly the two Settings offers for a NEW worker
// (CLAUDE_DISPATCH_PERMISSION_OPTIONS), which is also what keeps the launch default and the per-thread
// override speaking one vocabulary.
//
// CODEX IS DELIBERATELY LEFT OUT. Its axis is a sandbox rather than a permission mode, its restrictive
// end is the one that caused the 2026-07-23 removal, and the ask was Claude-specific.
//
// ANY PROJECT, NOT ONLY THE PAGE'S. A drawer or /full passes just the slug and the thread comes from the
// store's board. The cross-project page's card (AllQueuesCard) passes its own `scopedThread` — read from
// the machine-wide poll, since the store holds only the FOCUSED project's board — and sits inside a
// ThreadProjectScope, so every write goes to the card's own project through `useThreadApi`. The option
// cache is keyed by project too: two projects can each own a `fix-auth`. (The strip was left off that
// card until 2026-09-28; maintainer: "being able to change model in the middle of a thread should be
// possible anywhere".)
//
// ON A PHONE the strip is `phoneTools`: the model chip alone (it opens the phone's model sheet — the
// ProfileGridSelector's own phone branch), with no permission picker. Permissions stay on the desktop.
export function useThreadComposerControls(slug: string, scopedThread?: ThreadView): { busy: boolean; footer: ReactNode; permission?: ReactNode; phoneTools: ReactNode; status: ReactNode; stepEffort?: (step: 1 | -1) => void } {
  const snap = useSnapshot(store)
  // The page's project is read either way: a valtio snapshot that reads nothing re-renders on every store
  // change. The board's threads only without a scoped thread — reading them subscribed every queue card's
  // strip to every board delta, when the card's thread comes from the poll and the board is not its own.
  const pageProject = snap.board?.projectSlug
  const boardThread = scopedThread ? undefined : snap.board?.threads.find((candidate) => candidate.id === slug)
  const thread = scopedThread ?? boardThread
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const queryClient = useQueryClient()
  const profiles = useQuery({
    queryKey: projectId ? ["ofProject", projectId, "threadProfileOptions", slug] : ["threadProfileOptions", slug],
    queryFn: () => api.threadProfileOptions({ slug }),
    // An unscoped control asks the PAGE's project, so only while the store's board is the page's: the
    // cross-project page's focus moves the moment a drawer closes, and the sheet still sliding out asked
    // the project it just left for a thread it does not have (a 500 per close).
    enabled: Boolean(thread && !thread.foreign && thread.kind === "session" && (scopedThread || ownedByThisPage(pageProject))),
    staleTime: 5_000,
  })
  const profile = useMutation({
    // An ACP thread sends effort "" (it has no effort axis); the RPC takes that as ABSENT, not "".
    mutationFn: (target: { model: string; effort: string }) => api.setThreadProfile({ slug, model: target.model, ...(target.effort ? { effort: target.effort } : {}) }),
  })
  const permission = useMutation({
    mutationFn: (permissionMode: PermissionMode) => api.setThreadPermission({ slug, permissionMode }),
  })
  // The one-click move onto the edition the thread's family resolves to now (ThreadView.modelUpgrade).
  const upgrade = useMutation({
    mutationFn: (sessionId: string) => rpc.upgradeThreadModel({ slug, sessionId }),
  })
  const localBusy = profile.isPending || permission.isPending || upgrade.isPending
  const backend = thread?.backend === "codex" ? "codex" : thread?.backend === "acp" ? "acp" : "claude"
  // An ACP thread's model slug is `acp:<agent>[@<model>]`. The AGENT cannot be swapped under a live
  // session, so the thread's one control is the model inside it (AcpModelSelect below); the agent's
  // label only names that control. The same catalogue query the dispatch composer runs; react-query
  // serves both from one fetch.
  //
  // ABOVE the early return, and it must stay there. This query sat below it until 2026-09-19, so the
  // render in which a thread LEFT the board — a steered queue card whose row drops before its fade
  // ends, the moment the queue holds the card to dissolve it — called one hook fewer than the render
  // before, and React tore the whole queue down ("change in the order of Hooks"). Every card vanished in
  // one frame instead of one card fading. The browser pin is components/queueCardStates.e2e.test.ts,
  // on AllQueues' card, which holds the same fade the project board's queue did until 2026-09-28.
  // Asked of the thread's own project (ThreadProjectScope), under a key that names it (upstream ff43f7d3).
  const acpAgents = useQuery({ queryKey: projectId ? ["acpAgents", { project: projectId }] : ["acpAgents"], queryFn: () => api.acpAgents(), enabled: Boolean(thread) && backend === "acp" })

  // Legacy/rowless and foreign transcripts have no ntwine-owned runtime profile to mutate. Keep their
  // existing composer behavior, but never render a misleading disabled control.
  if (!thread || thread.foreign || thread.kind !== "session") return { busy: localBusy, footer: null, phoneTools: null, status: null }

  // The board's pending bit is authoritative across every mounted surface (queue + drawer + another
  // tab). A local React mutation alone cannot prevent a second composer from steering the pane during
  // the backend handoff.
  const busy = localBusy || threadFollowUpBlocked(thread)

  const model = thread.model?.trim()
  const effort = thread.effort?.trim()
  const acpAgentId = backend === "acp" ? acpAgentIdFromModel(model) : undefined
  const acpModelId = backend === "acp" ? acpModelIdFromModel(model) : undefined
  // A thread on a picker preset (Muse Wonder) has a model and effort grid of its agent's presets, like a
  // Claude or Codex thread, instead of the agent's model dropdown.
  const acpPreset = backend === "acp" ? acpModelPreset(model) : undefined
  const providerLabel = backend === "codex" ? "Codex" : backend === "acp" ? acpAgents.data?.find((agent) => agent.id === acpAgentId)?.label ?? acpAgentId ?? "ACP" : "Claude Code"
  // OPTIMISTIC PENDING. The profile control is backed by a runtime handoff that can take a half-second
  // or more, and the board's own pending bit only appears once the server has claimed the row — so
  // picking a model used to produce NO visible response at all until it landed, which reads as a dropped
  // click and invites a second one. The in-flight mutation variables give us the exact target
  // immediately, expressed in the SAME "→ … pending" affordance the server's bit drives, so the local
  // hint and the authoritative one are indistinguishable and hand over without a flicker. Deliberately
  // NOT rendered as the applied value: the server may still answer "next-resume", and a control that
  // claims a live change it did not make is worse than a slow one.
  const optimisticProfile = profile.isPending ? profile.variables : undefined
  const pendingModel = thread.profilePendingModel ?? optimisticProfile?.model
  const pendingEffort = thread.profilePendingEffort ?? optimisticProfile?.effort
  // An ACP model change is the dropdown's to show as pending: the in-flight pick, until the row's
  // model catches up.
  const optimisticAcpModelId = backend === "acp" && optimisticProfile ? acpModelIdFromModel(optimisticProfile.model) : undefined
  const profileOptions = profiles.data?.options ?? []
  const { modelSelectable } = threadProfileControlState(profileOptions, model, effort, thread.runtime === "exited")
  const catalogLoaded = profiles.data !== undefined
  const acpAgentLabel = acpAgents.data?.find((agent) => agent.id === acpAgentId)?.label ?? acpAgentId
  const profileGroups = [{ id: backend, label: providerLabel, options: profileOptions }]
  const composerStatus = threadComposerStatus(profiles.isError ? (profiles.error as Error).message : undefined)

  // WHAT THE OPERATOR IS LOOKING AT, and it is deliberately not `thread.permissionMode` raw: a thread
  // whose stored mode is one of the restrictive ones (an adopted foreign session, or a row left over
  // from before this control narrowed to two) has no option to select, and a Select with a value that
  // matches nothing renders empty. `claudePermValue` folds the one such mode Claude can carry back onto
  // `auto`; anything else unrecognised does the same here, so the readout always names a real row.
  const storedPermission = thread.permissionMode ? claudePermValue(thread.permissionMode) : "auto"
  const permissionValue = CLAUDE_DISPATCH_PERMISSION_OPTIONS.some((o) => o.value === storedPermission) ? storedPermission : "auto"
  // OPTIMISTIC, exactly like the profile control above: the write is a round trip, and a picker that
  // snaps back to the old value for its duration reads as a dropped click.
  const shownPermission = permission.isPending ? (permission.variables as PermissionMode) : permissionValue
  const permissionBlocked = threadPermissionBlockedReason(thread)

  // A scoped card's thread comes from the cross-project poll rather than the live board, so re-read it
  // at once instead of showing the old profile until the next tick.
  const refreshScoped = () => {
    if (projectId) void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }

  function changePermission(next: PermissionMode) {
    if (next === permissionValue) return
    permission.mutate(next, {
      onSuccess: (result) => {
        refreshScoped()
        showToast(threadPermissionEffectMessage(result.effect, "claude"))
      },
      onError: (e) => showToast(`Permission change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  // The same process-restart gate the permission picker uses, because it is the same act: the upgrade
  // retires the worker so the next turn starts in a fresh one. The server re-checks it on its own.
  const upgradeBlocked = backend === "claude" ? threadPermissionBlockedReason(thread) : null
  function upgradeModel() {
    if (!thread?.sessionId) return
    upgrade.mutate(thread.sessionId, {
      onSuccess: (result) => showToast(`${result.label} from the next turn — the worker restarts then`),
      onError: (e) => showToast(`Upgrade failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  function changeProfile(target: { model: string; effort: string }) {
    profile.mutate(target, {
      onSuccess: (result) => {
        refreshScoped()
        showToast(backend === "acp" && !acpPreset
          ? result.effect === "next-resume" ? "Model saved for the next resume" : "Model applied"
          : result.effect === "next-resume"
            ? "Model and effort saved for the next resume"
            : "Model and effort applied")
      },
      onError: (e) => showToast(`Profile change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  // The box's ⌥⇧↑/↓ (Composer `onEffortStep`): the grid picker's next cell along the row, gated exactly
  // as the picker is, so a key never changes what a click could not.
  const gridProfile = backend !== "acp" || Boolean(acpPreset)
  const profileDisabled = busy || !catalogLoaded || !modelSelectable || profiles.isError
  const stepEffort = gridProfile && !profileDisabled && model
    ? (step: 1 | -1) => {
        const next = stepProfileGridEffort(profileGroups, { provider: backend, model, effort: effort ?? "" }, step)
        if (next) changeProfile({ model: next.model, effort: next.effort })
      }
    : undefined

  // The model control, shared by the desktop strip and the phone's tools: the grid selector for a
  // Claude or Codex thread (a chip and a sheet on the phone — ProfileGridSelector branches itself),
  // the agent's model dropdown for an ACP thread.
  const profileControl = (
    <>
      {gridProfile && (
        <ProfileGridSelector
          groups={profileGroups}
          value={{ provider: backend, model, effort }}
          pending={pendingModel || pendingEffort
            ? { provider: backend, model: pendingModel, effort: pendingEffort }
            : undefined}
          onValueChange={({ model: nextModel, effort: nextEffort }) => changeProfile({ model: nextModel, effort: nextEffort })}
          placeholder={profiles.isPending ? "Profile loading…" : "Profile unknown"}
          ariaLabel="Thread model and effort"
          menuAriaLabel={`Choose ${providerLabel} model and effort`}
          title={modelSelectable
            ? thread.runtime === "exited"
              ? "Saved per thread and applied when this conversation resumes"
              : "Change this idle conversation's model and reasoning effort"
            : "The current live backend profile is unavailable; controls fail closed"}
          disabled={profileDisabled}
          compact
          side="top"
          className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
          runningModelLabel={thread.runningModelLabel}
          upgrade={thread.modelUpgrade && thread.runningModelLabel
            ? {
                latest: thread.modelUpgrade.label,
                staged: thread.modelUpgrade.staged,
                blockedReason: upgradeBlocked,
                pending: upgrade.isPending,
                onUpgrade: upgradeModel,
              }
            : undefined}
        />
      )}
      {/* An ACP thread carries ONE control, the model inside its agent. The agent itself is not a
          choice on a live thread — a session belongs to the process that opened it, exactly as a
          thread never moves between Claude Code and Codex — so no pill names it as one (a disabled
          agent pill stood here for a day and read as a switch; maintainer 2026-09-16: "that
          shouldn't be possible"). The sidebar mark and the dropdown's tooltip say which agent. */}
      {backend === "acp" && acpAgentId && !acpPreset && (
        <AcpModelSelect
          agentId={acpAgentId}
          agentLabel={acpAgentLabel ?? acpAgentId}
          modelId={optimisticAcpModelId ?? acpModelId}
          // The agent slug stays; only the tail changes. Effort is "" — an ACP thread has none.
          onValueChange={(nextModelId) => changeProfile({ model: acpModelSlug(acpAgentId, nextModelId), effort: "" })}
          disabled={busy}
          side="top"
          className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
        />
      )}
    </>
  )

  // THE PERMISSION MODE IS A RAIL GLYPH, not a footer pill: it is almost never changed, and a labelled
  // dropdown beside the model pill gave it the same weight as the one control that is (maintainer
  // 2026-10-14). The title carries the COST the glyph cannot: a Claude permission mode is a launch flag,
  // so changing it retires the worker process and the next turn resumes the conversation in a new one.
  const permissionTitle = permissionBlocked
    ? `${permissionBlocked} — changing permissions restarts this thread's worker process`
    : shownPermission === "bypassPermissions"
      ? "Permissions: bypass — the worker never asks for approval. Changing this restarts the worker process."
      : "Permissions: auto — risky actions raise an approval card here. Changing this restarts the worker process."
  const permissionDisabled = busy || permissionBlocked !== null
  const permissionControl = backend === "claude"
    ? <ThreadPermissionControl value={shownPermission} onChange={changePermission} title={permissionTitle} disabled={permissionDisabled} />
    : undefined

  return {
    busy,
    permission: permissionControl,
    footer: (
      <div
        data-thread-composer-controls
        // gap-x-1.5, MEASURED. The row held one pill and a quiet text readout on `gap-x-1`; a SECOND
        // bordered pill beside the first turned that 4px box gap into 3.69px of ink between two
        // borders, and two pills that close read as one segmented control rather than as two
        // independent choices. 6px of box is 5.7px of ink, which separates them without letting the
        // pair drift apart from each other.
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5"
      >
        {profileControl}
        {pendingModel && pendingEffort && (
          <span className="min-w-0 truncate text-[9px] text-muted-50">
            → {pendingModel} · {pendingEffort} pending
          </span>
        )}
      </div>
    ),
    phoneTools: profileControl,
    stepEffort,
    status: composerStatus ? (
          <div
            data-thread-control-error=""
            className="px-1 pt-1 text-[9.5px] leading-tight text-muted-65"
          >
            {composerStatus.message}
          </div>
        ) : null,
  }
}
