// ENDING A BACKGROUND SHELL — the one path every stop takes, whoever asks for it.
//
// Two callers, one body: the operator's × (router.stopBackgroundOp, also the drawer's Stop) and the
// runtime budget (scheduler SOURCE 13, shell-budget.ts). They lived as one set of closures inside the
// router until the budget needed the same kill from the scheduler (2026-09-29), and a second copy would
// have been a second place to forget the notice — the half the provider does not do for us, whose
// absence left a worker waiting on a watcher ntwine had already killed. So the closures moved here, and
// the only thing a caller chooses is the REASON the worker is told.
import type { AppContext } from "./context.ts"
import { claudeWorkerSystemPrompt, coldResumePermission, workerCapabilities } from "./dispatch.ts"
import { deadlineSection } from "./deadline.ts"
import { workDirOf } from "./project.ts"
import { shellStopNotice, type ShellStopReason } from "./shell-budget.ts"

export type ShellStopDeps = Pick<AppContext, "project" | "storage" | "tailer" | "claudeBroker" | "codexAppServer" | "getSettings" | "board" | "editors">

// A CODEX background exec, resolved by the id its row carries — which for codex IS the `processId`
// the kill needs (see tailer.ts codexBgShellViews: there is exactly one handle and no correlation
// step). Undefined for every other kind of row, so the Claude path below is reached unchanged.
//
// It reads the BOARD's live shell list rather than the fold, because that list IS the app-server's
// item stream — a codex exec's processId never reaches the rollout ntwine folds (measured in
// backend/_live_codex_bgterm_match.mts, where the rollout-projected row carried no handle at all).
export function codexShellTarget(deps: ShellStopDeps, slug: string, id: string): { sessionId: string; processId: string; label: string } | undefined {
  if (!deps.codexAppServer) return undefined
  const row = deps.storage.getSession(slug)
  if (!row || row.backend !== "codex" || row.codex_runtime !== "app-server") return undefined
  const shell = deps.tailer.get(slug)?.bgShells?.find((entry) => entry.id === id && entry.state === "running")
  if (!shell) return undefined
  return { sessionId: row.session_id, processId: id, label: shell.label }
}

// Can ntwine END this live op, and if not, why not — for a sub-agent AND for a background shell.
//
// A SHELL used to be refused here categorically: "ntwine tracks a background shell by reading the
// worker's transcript and holds no handle on its process". That was measured wrong. A background
// `Bash` is a TASK in the very registry `Query.stopTask` addresses — the SDK's own
// `backgroundTasks()` says as much ("Bash commands and subagents") — and ntwine has been recording its
// task id all along, off the launch ack ("Command running in background with ID: …") and off the
// `task_started` stream. `backend/_live_shell_stop.mts` drove the production path end to end: the
// shell's OS process was gone within a second of the stop and the row left the board on its own.
// The maintainer's case for this is the 24-hour wedged watcher with no way to clear it.
//
// Only two things differ between the two kinds, and both are handled below rather than by forking
// the function: the LIVENESS reading, and the noun in every refusal.
export function backgroundOpStoppable(deps: ShellStopDeps, slug: string, id: string): { sessionId: string; taskId: string; shell: boolean } | { sessionId: null; note: string | null } {
  const blocked = (note: string | null) => ({ sessionId: null, note })
  const info = deps.tailer.subAgent(slug, id)
  if (!info) return blocked(null)
  const shell = deps.tailer.backgroundShell?.(slug, id)
  // The UI's noun: every refusal here reaches the operator (the agent terminal drawer's footer, the ×'s toast),
  // beside rows and a drawer that call the process an agent terminal. It said "background shell" there.
  const noun = shell ? "agent terminal" : "sub-agent"
  // A shell has NO staleness ceiling — its entry clears on a terminal notification, so a watcher that
  // has printed nothing for a day is still `running`, not `stale`. Read the shell's own state, which
  // says exactly that; `info.state` runs it through the sub-agent staleness rule and would report
  // "stale" for precisely the wedged shell this control exists to kill.
  //
  // What a shell DOES have is the OS's verdict (tailer shellIsGone, since 2026-08-19): one nobody holds
  // open is gone, and the board's row for it reads `stale`. The lookup above does not carry that
  // verdict, so a dead shell passed as running and the × attempted a real stop — which threw when no
  // daemon held the session (leaving the row the × exists to clear), and otherwise told the worker a
  // kill that never happened. Nothing is running to stop, so the × CLEARS it, as the client promises
  // for a stale row (lib/dismissChildOp.ts). (Upstream ad80eb20, carried into this fork's shell-stop.ts.)
  const shellGone = shell !== undefined && deps.tailer.get(slug)?.bgShells?.find((s) => s.id === id)?.state === "stale"
  if (!(shell ? shell.state === "running" && !shellGone : info.state === "running")) return blocked(null)
  const row = deps.storage.getSession(slug)
  if (!row) return blocked(null)
  if (row.backend === "codex") {
    return blocked(shell
      ? "Codex runs its background commands inside its own process and exposes no way to end one, so this terminal can't be stopped from here."
      : "Codex does not expose per-sub-agent interruption to Ntwine, so this child can't be stopped from here.")
  }
  if (row.claude_runtime !== "broker" || !deps.claudeBroker) {
    return blocked(`Stopping a ${noun} needs the Claude session broker; this thread predates it.`)
  }
  if (!info.taskId) return blocked(`This ${noun} did not publish the task identifier needed to stop it.`)
  return { sessionId: row.session_id, taskId: info.taskId, shell: Boolean(shell) }
}

/** Could `stopBackgroundShell` end this shell right now? The runtime budget asks before it warns, so
 *  the warning never threatens a kill that cannot happen. */
export function backgroundShellStoppable(deps: ShellStopDeps, slug: string, id: string): boolean {
  if (codexShellTarget(deps, slug, id)) return true
  if (!deps.tailer.backgroundShell?.(slug, id)) return false
  return backgroundOpStoppable(deps, slug, id).sessionId !== null
}

/** The worker's own name for a live Claude shell ("Watching CI"), read BEFORE the kill — the row it
 *  comes from is retired moments later, and the label is what the worker will recognise. */
export function claudeShellLabel(deps: ShellStopDeps, slug: string, id: string): string {
  return deps.tailer.get(slug)?.bgShells?.find((s) => s.id === id)?.label ?? deps.tailer.backgroundShell?.(slug, id)?.command ?? "(unnamed)"
}

// TELL THE WORKER ITS SHELL WAS KILLED — the half the provider does not do for us.
//
// Measured (backend/_live_shell_stop_notice.mts, 2026-08-01) on a real session: stopping a SUB-AGENT
// injects a `<task-notification>` user record the model reads and acts on ("the sub-agent was stopped
// before it finished, so it never reported back"). Stopping a background SHELL injects NOTHING — the
// transcript gains not one record — and asked afterwards the model still believed its shell was
// "presumably still running … I have received no completion notification". A worker left waiting on a
// watcher ntwine already killed is the exact stall the × is meant to end, so ntwine supplies the missing
// notice itself. Shell-only, deliberately: adding one on the sub-agent path would say it twice.
//
// `[ntwine]` is the established prefix for a machine notice to a worker — transcript.ts NOISE_PREFIXES
// keeps it out of the human's chat, so this reaches the model without becoming a bubble the operator
// never typed.
//
// NEVER cold-starts a process. `stopSubAgent` already requires a daemon this bridge holds live, but a
// daemon can die in the gap, and `followUp` would then resume a whole `claude` from disk purely to
// announce a kill. The liveness check keeps the worst case at "nobody was there to tell", which is
// reported rather than hidden.
export async function noticeClaudeShellStopped(deps: ShellStopDeps, slug: string, label: string, reason: ShellStopReason): Promise<string | null> {
  const bridge = deps.claudeBroker
  const row = deps.storage.getSession(slug)
  if (!bridge || !row) return "The worker could not be told — the Claude session broker is unavailable."
  if (!bridge.isDaemonAlive(row.session_id)) return "The worker was not told — its session is no longer running."
  try {
    await bridge.followUp({
      threadSlug: slug,
      sessionId: row.session_id,
      cwd: workDirOf(deps.project),
      text: `${shellStopNotice(label, reason)} Whatever it wrote before the kill is still readable in its output file.`,
      // `isDaemonAlive` above is a check, not a hold: the daemon can exit before this frame lands,
      // and followUp then COLD-RESUMES rather than failing. Take the same floor every other fork
      // takes, so a notice that loses the race cannot be the thing that rebuilds the worker at
      // Claude's `default` — see coldResumePermission.
      permissionMode: coldResumePermission(row, deps.getSettings()),
      // …and the same contract: a cold resume with no appendSystemPrompt rebuilt the worker with no
      // Ntwine contract, scratch line or NTWINE.md (upstream affc40a2).
      appendSystemPrompt: claudeWorkerSystemPrompt(row.session_id, deps.project, {
        capabilities: workerCapabilities(deps.editors, workDirOf(deps.project)),
        deadline: deadlineSection(row),
      }),
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      // Ntwine's own notice, not the operator's reply to anything: an open card stays open.
      keepOpenCards: true,
    })
    return null
  } catch (error) {
    return `The worker could not be told: ${error instanceof Error ? error.message : String(error)}`
  }
}

export interface ShellStopResult {
  /** A real provider kill landed. */
  stopped: boolean
  /** The row left live tracking (a Claude shell is retired; a codex exec leaves the bridge's level). */
  dismissed: boolean
  /** Something the caller must pass on: the refusal's reason, or a notice that did not land. */
  note: string | null
  /** Ntwine holds no way to end this shell (legacy transport, no task id yet, already finished) and did
   *  NOTHING. The operator's × still retires such a row as a phantom; the budget leaves it alone. */
  refused?: true
}

/** STOP ONE BACKGROUND SHELL: the provider's own kill, then the notice telling the worker why, then the
 *  row retired from tracking. Undefined when `id` names no shell ntwine tracks, so the caller can fall
 *  through to the sub-agent path.
 *
 *  A kill that THROWS throws through, and nothing is retired: a failed stop means the shell is still
 *  running, and hiding it is the bug the × was rebuilt to end. `notify:false` skips the notice — for a
 *  thread nobody is reading (an archived one), where waking the worker to announce the kill would spend
 *  a turn on news no one will act on. */
export async function stopBackgroundShell(
  deps: ShellStopDeps,
  slug: string,
  id: string,
  reason: ShellStopReason,
  opts: { notify?: boolean } = {},
): Promise<ShellStopResult | undefined> {
  const notify = opts.notify !== false
  // CODEX takes its own route, not a branch inside the Claude one: its shells never enter the fold's op
  // map, so neither `tailer.subAgent` nor `tailer.backgroundShell` can see them, and its kill is a
  // different protocol call against a different bridge. It shares the SHAPE — stop first, then let the
  // row go — and the row leaves without `dismissOp` because the bridge drops it from the live level the
  // board reads.
  const codex = codexShellTarget(deps, slug, id)
  if (codex) {
    const result = await deps.codexAppServer!.terminateBackgroundExec({
      threadSlug: slug,
      sessionId: codex.sessionId,
      processId: codex.processId,
      ...(notify ? { notice: shellStopNotice(codex.label, reason) } : {}),
    })
    deps.board.refresh()
    // `terminated:false` is the app-server saying the PTY was already gone. Nothing was killed and
    // nothing may claim it was — but the phantom row does clear, which is the ×'s other honest job.
    return { stopped: result.terminated, dismissed: true, note: result.noticeFailed }
  }
  if (!deps.tailer.backgroundShell?.(slug, id)) return undefined
  const target = backgroundOpStoppable(deps, slug, id)
  if (target.sessionId === null) return { stopped: false, dismissed: false, note: target.note, refused: true }
  const bridge = deps.claudeBroker
  if (!bridge) throw new Error("Claude session broker is unavailable; cannot stop this agent terminal")
  const label = claudeShellLabel(deps, slug, id)
  await bridge.stopSubAgent({ threadSlug: slug, sessionId: target.sessionId, taskId: target.taskId })
  // AFTER the kill, never before: the notice states the shell is already dead, and a stop that throws
  // must not leave a worker believing work ended that is still burning. A notice that fails to land
  // is reported, not thrown — the process IS dead by this line.
  const noticeFailed = notify ? await noticeClaudeShellStopped(deps, slug, label, reason) : null
  // Retired AFTER the kill, so the row leaves every live surface on this stop's own board frame instead
  // of waiting for the fold — which never would: a killed shell writes no terminal record.
  const dismissed = deps.tailer.dismissOp?.(slug, id) ?? false
  deps.board.refresh()
  return { stopped: true, dismissed, note: noticeFailed }
}
