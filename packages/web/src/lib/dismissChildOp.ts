import { isDirectSubAgent } from "@ntwine/shared"
import { rpc, type Api } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// THE × ON A CHILD-OPERATION ROW — one action, for all three surfaces that list children.
//
// It means one of two honest things, decided by the row's own state (see `childOpDismisser`, which is
// where the control is withheld entirely when neither is true):
//   RUNNING  → STOP. The server ends the child through the provider's real control, then retires the row.
//   STALE/RESTED → CLEAR. Nothing is running to stop; this retires a finished op from tracking, which
//                  is the escape hatch the × was originally built for (a completion that never landed
//                  keeps a thread hostage through the Done-warning count).
//
// No optimism: the server refreshes the board after it has applied that policy. If a real stop throws,
// it deliberately does not retire the row; the error toast is the only client-side bookkeeping.
// (This lives beside `lib/childOps.ts` rather than inside it because that module is the row's pure
// vocabulary, importable by an SSR test with no store or transport behind it.)
//
// `api` is the thread's OWN project's client. It defaults to `rpc`, the project the address bar names,
// which is right for the drawer and the /full page; a row in Everything's project list names a thread of
// any project on a page that names at most one, so it passes its scope's client (api/threadApi.tsx) —
// else the × on another project's `fix-auth` child would stop the focused project's.
//
// Resolves to whether a live child was actually KILLED once the stop has settled, and never rejects (the
// toast is the whole error path), so a caller that shows the result — the agent-terminal drawer's Stop on
// a Codex exec — can re-read after it and say "stopped" only when it was.
// A MONITOR is a shell to the server, and stops the same way; only its name differs. Its row, tooltip and
// drawer all call it an "agent monitor", so its stop toast does too.
export type DismissKind = "AGENT" | "SHELL" | "MONITOR"

export function dismissChildOp(slug: string, id: string, kind: DismissKind = "AGENT", api: Api = rpc): Promise<boolean> {
  // "Agent terminal", the name its row and its drawer use (ThreadTerminals.tsx), so the × and the drawer's
  // Stop announce the same thing in the same words.
  const noun = kind === "SHELL" ? "Agent terminal" : kind === "MONITOR" ? "Agent monitor" : "Sub-agent"
  return api.stopBackgroundOp({ slug, id })
    .then(({ stopped, note, descendantsStopped }) => {
      // Only the KILL is worth announcing. A clear needs no toast — the row leaving IS the feedback.
      if (!stopped) return false
      // The count belongs in the toast because the SUBTREE is the part the operator cannot see: the
      // row they clicked leaves the board either way, and until this stop covered the fan-out its
      // grandchildren kept running and reported back under an agent that was already gone. A
      // descendant ntwine failed to stop rides in `note` and outranks the count — that is live work
      // still burning, and it gets the longer toast the error path uses. A shell's `note` carries the
      // other failure only it can have: the kill landed but the WORKER could not be told.
      if (note) {
        showToast(`${noun} stopped. ${note}`, { duration: 7000 })
        return true
      }
      // A shell says who else knows. The worker is not watching the dashboard, and a stop it was never
      // told about leaves it waiting on a watcher that will never report — so "the worker was told" is
      // the half of this action the operator cannot otherwise verify. A sub-agent needs no such line:
      // the provider injects its own stop notification (backend/_live_shell_stop_notice.mts).
      if (kind !== "AGENT") showToast(`${noun} stopped — the agent was told`)
      else showToast(descendantsStopped > 0 ? `Sub-agent and ${descendantsStopped} descendant${descendantsStopped === 1 ? "" : "s"} stopped` : "Sub-agent stopped")
      return true
    })
    .catch((error: unknown) => {
      showToast(`Couldn’t stop: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`, { duration: 7000 })
      return false
    })
}

// WHICH rows may carry the ×, on every surface. Three independent reasons to withhold it, and the
// governing rule is the maintainer's (2026-07-30): "We shouldn't show the X if it doesn't fucking
// work." They hit it on a background SHELL, whose × cleared the row and then admitted in a toast that
// the work was probably still going — a control that lies about what it did.
//
//  1. NO ID / A DESCENDANT. Retiring acts on a tracked op BY ITS DISPATCH ID, and a descendant's
//     dispatch lives in an ANCESTOR's transcript — this thread never tracked it, so the call would be
//     a silent no-op. (`stopTask` alone could reach a descendant, but the row would then not clear,
//     which is the same lie in the other direction. The drawer's "Stop sub-agent" covers those.)
//  2. RUNNING, BUT NOT STOPPABLE. The row is live work ntwine has no channel to end: any op on a
//     codex thread, or one whose provider task handle ntwine never captured. `stoppable` is the
//     SERVER's answer and is never re-derived here — the policy depends on the thread's TRANSPORT,
//     which the browser has no honest way to know.
//
//     A background SHELL used to fall out of this clause BY CONSTRUCTION, because a BgShellView
//     carried no `stoppable` field at all — the server refused every shell stop categorically, on the
//     belief that ntwine held no handle on the process. That was measured wrong on 2026-08-01: a
//     background Bash is a task in the same registry `Query.stopTask` addresses, and killing it is as
//     real as killing a sub-agent (server/backend/_live_shell_stop.mts). The field now exists on both
//     views and this clause reads them identically, which is the point — the ×'s availability is a
//     property of the ROW, never of what kind of thing the row is.
//  3. Everything else keeps the ×, including every stale/rested row: there the click CLEARS a finished
//     op, which is exactly what it claims and works on every runtime.
export function childOpDismisser(
  slug: string,
  op: { id?: string; depth?: number; state?: string; stoppable?: boolean },
  kind: DismissKind = "AGENT",
  api: Api = rpc,
): (() => void) | undefined {
  if (!op.id || !isDirectSubAgent(op)) return undefined
  if (op.state === "running" && !op.stoppable) return undefined
  const id = op.id
  return () => dismissChildOp(slug, id, kind, api)
}

// THE RESTING CARD'S "Stop shell" — the same stop as the × above, applied to every shell the card rows
// at once (David 2026-09-29: "there also needs to be a cancel button for background shell,
// currently only snooze"). One click can end several shells, so it reports as ONE toast: N toasts
// stacked for one gesture read as N separate events, and the partial-failure case — the one the
// operator must not miss — would scroll out between two successes.
export type ShellStopOutcome =
  | { ok: true; stopped: boolean; note: string | null }
  | { ok: false; error: string }

/** The one toast for a batch of shell stops, or null when there is nothing worth announcing (every
 *  shell had already finished, so each stop was a CLEAR and the rows leaving are the feedback — the
 *  single-shell × stays silent in the same case). A failure outranks everything: a shell that is still
 *  running is the one fact the operator has to act on. */
export function shellStopSummary(outcomes: readonly ShellStopOutcome[]): { text: string; duration?: number } | null {
  const failed = outcomes.filter((o): o is Extract<ShellStopOutcome, { ok: false }> => !o.ok)
  const stopped = outcomes.filter((o): o is Extract<ShellStopOutcome, { ok: true }> => o.ok && o.stopped)
  // The single row's × and the agent drawer's Stop say "Agent terminal stopped — the agent was told"; one
  // process, one name, whichever control ended it.
  const shells = (n: number) => `${n} agent terminal${n === 1 ? "" : "s"}`
  if (failed.length > 0) {
    const why = failed[0].error.slice(0, 100)
    if (stopped.length === 0) return { text: `Couldn’t stop: ${why}`, duration: 7000 }
    return { text: `Stopped ${stopped.length} of ${shells(outcomes.length)}. Couldn’t stop the rest: ${why}`, duration: 7000 }
  }
  if (stopped.length === 0) return null
  const noun = stopped.length === 1 ? "Agent terminal" : shells(stopped.length)
  // A `note` is the kill landing while the WORKER could not be told — live confusion, not live work, but
  // still the longer toast the single-shell path gives it.
  const note = stopped.find((o) => o.note)?.note
  if (note) return { text: `${noun} stopped. ${note}`, duration: 7000 }
  return { text: `${noun} stopped — the agent was told` }
}

/** Stop each shell through the thread's own project client, then report once. Resolves when every
 *  call has settled, and never rejects: the toast is the whole error path, as it is for the ×. */
export async function stopBackgroundShells(slug: string, ids: readonly string[], api: Api = rpc): Promise<void> {
  const outcomes = await Promise.all(ids.map((id): Promise<ShellStopOutcome> =>
    api.stopBackgroundOp({ slug, id }).then(
      ({ stopped, note }) => ({ ok: true, stopped, note }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    )))
  const summary = shellStopSummary(outcomes)
  if (summary) showToast(summary.text, summary.duration ? { duration: summary.duration } : undefined)
}
