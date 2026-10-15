import type { CompletionHold, ThreadView } from "@ntwine/shared"
import { isDirectSubAgent } from "@ntwine/shared"

export interface ThreadLifecycleAvailability {
  // The header's lifecycle cluster renders (ThreadLifecycleActions). TRUE for any owned session thread,
  // done or not — see `done`.
  lifecycle: boolean
  // The thread is already complete, so the cluster STATES that instead of offering a verb.
  done: boolean
  snooze: boolean
  archive: boolean
}

// One ownership/lifecycle decision shared by queue cards and full thread surfaces. The controls are
// deliberately not message actions: a done fence, transcript hydration, or selected tab can never
// move or duplicate them.
export function threadLifecycleAvailability(
  // A PICK, not the whole view: the resting card asks this same question off its own narrow slice of a
  // thread (AwaitingBackgroundCard), and widening it there just to satisfy a parameter would have made
  // the card claim to read fields it never touches.
  thread: Pick<ThreadView, "kind" | "foreign" | "state" | "archived">,
): ThreadLifecycleAvailability {
  // A terminal thread has the same verbs: snooze it to a time, mark it done (which stops a running one).
  const owned = (thread.kind === "session" || thread.kind === "terminal") && thread.foreign !== true
  // `archived` mirrors the pre-state-column protocol; honor it during a rolling server/client reload.
  const archived = owned && (thread.state === "archived" || thread.archived === true)
  // An archived thread has no lifecycle VERBS — there is no Reopen button (reopening is just sending
  // the thread another message), and Snooze rejects an archived thread server-side. It keeps the
  // CLUSTER regardless, reading "Done" where the buttons were, because dropping it left the completed
  // state with nowhere to appear: a thread's full view showed a title, an activity stamp and a composer,
  // and nothing anywhere said the thread was finished (maintainer 2026-07-29, on a /full page: "why does
  // this not have a footer with the mark as done button?" — the honest answer is a readout, not an
  // absence). The cluster was a footer under the prompt box until 2026-10-05; it closes the header's
  // action strip now.
  const lifecycle = owned
  const actionable = owned && !archived
  return {
    lifecycle,
    done: archived,
    snooze: actionable,
    archive: actionable,
  }
}

// Predict whether Mark-as-done will archive IMMEDIATELY — with no "End this session?" dialog — so the
// click can dismiss the card optimistically instead of waiting out the completeThread round-trip.
// Deliberately mirrors the server's completionNeedsConfirmation (server/src/router.ts): a resting,
// human-blocked, or exited shell completes in one action; an executing turn or live background work is
// asked about first. A wrong "immediate" guess is harmless — the server still owns the verdict, and the
// caller reinstates the card + opens the dialog on a needsConfirmation reply — so this only ever errs
// toward NON-optimistic (waiting), never toward skipping a dialog the server would have shown.
export function completionArchivesImmediately(thread: ThreadView): boolean {
  // A terminal thread's Mark as done is never asked about: it stops the process and files it.
  if (thread.kind === "terminal") return true
  // A worker that was CUT OFF mid-turn — dead, its recorded turn never ended — is asked about too
  // (router.cutOffHold): it is not finished, and Done would say it was. `crashed` is the board's reading
  // of exactly that, and a slight superset of the server's (it also covers a dead daemon still tracking
  // a sub-agent), which only ever errs toward waiting. Checked FIRST: a pending ask on a dead thread is
  // still a dead thread.
  if (thread.runtime === "exited" && thread.crashed) return false
  // A terminal this thread started and left running asks nothing: Done detaches it (router.withTerminalHold).
  // Paused-for-a-human states are explicitly safe to stop on the server, regardless of any background work.
  if (thread.runtime === "perm-prompt" || thread.pendingAsk) return true
  // An executing (or still-spawning) turn always prompts.
  if (thread.runtime === "running" || thread.runtime === "spawning") return false
  // A resting/exited shell prompts only if it still has live background sub-agents or shells.
  const busy = (op: { state: string }) => op.state === "running" || op.state === "stale"
  // Sub-agents: DIRECT children only, because that is what the server's completionConfirmationHold
  // counts. This guess only stays useful while it agrees with the verdict it is predicting.
  // A worker that signed off done has disowned its shells, so they no longer ask (router.completionConfirmationHold).
  const shellsHold = thread.lastFence?.kind !== "done" && thread.bgShells?.some(busy)
  if (thread.subAgents?.some((op) => isDirectSubAgent(op) && busy(op)) || shellsHold) return false
  return true
}

// One named group of work the confirmation is holding on — "2 sub-agents", with the labels beneath it.
//
// THE AGENT'S TERMINALS AND YOURS ARE ONE GROUP, "3 terminals", each item marked with its owner — the one
// place every process on the thread is listed together, and every other surface (the strip, the rail's
// "Terminals") already calls both terminals. It split them into "1 background shell"
// and "2 terminals" until 2026-09-29, the last surface still to.
export interface CompletionHoldGroup {
  kind: "agent" | "terminal"
  heading: string // "1 sub-agent" / "3 terminals"
  // The ops the server named (already capped). `stale` is carried through rather than flattened: it
  // is not proof the op stopped — which is why it holds the completion — but claiming a silent child
  // is actively running would overstate what the tailer knows. `owner` is a terminal's: the agent's
  // (a background shell) or yours.
  // `id` is a terminal thread's slug: the dialog offers a stop checkbox for it.
  items: { label: string; stale: boolean; owner?: "agent" | "human"; id?: string }[]
  overflow: number // labels the server withheld; >0 renders a "+N more" line
}

export interface CompletionHoldSummary {
  lead: string // the sentence that names WHY Done stopped to ask
  groups: CompletionHoldGroup[]
  trailer: string // what "End session & mark done" will actually do
}

// The confirm dialog's copy. "This thread is still running" answers nothing the human can act on —
// they clicked Done precisely because they thought it was finished — so the reason gets spelled out:
// an executing turn, a specific count of live sub-agents and terminals with their labels, or an
// unreadable transcript. `hold` absent (an older server, or a mispredicted needsConfirmation with no
// evidence attached) degrades to the original generic sentence rather than asserting something false.
export function completionHoldSummary(hold: CompletionHold | undefined): CompletionHoldSummary {
  const generic = {
    lead: "This thread is still running.",
    groups: [],
    trailer: "Marking it done will stop its agent session, then move it to Done.",
  }
  if (!hold) return generic
  // The terminal threads this thread started, still running. They are listed in any state of the worker —
  // resting, dead or mid-turn — each with a stop checkbox, unticked: Done leaves them running unless ticked.
  const terminals = holdGroup("terminal", "terminal", hold.terminals ?? [], hold.terminalCount ?? 0, "human")
  // Nothing of the agent's is running and nothing of its will be stopped: the worker is already gone,
  // mid-turn. The correction the human needs is that the thread is NOT finished — and that Retry, not
  // Done, is the verb that picks it back up. No agent groups: a dead worker's children cannot be live, and
  // the server names none. Its terminals are not its children, so they can be, and are named.
  if (hold.cutOff) {
    return {
      lead: "This session was cut off mid-turn — its worker ended before the turn finished, so the thread isn’t done.",
      groups: terminals ? [terminals] : [],
      trailer: terminals
        ? "Marking it done files it under Done as it is; its terminals keep running unless ticked. Retry resumes it where it left off."
        : "Marking it done files it under Done as it is. Retry resumes it where it left off.",
    }
  }
  const subAgents = holdGroup("agent", "sub-agent", hold.subAgents, hold.subAgentCount)
  const agentShells = holdGroup("terminal", "terminal", hold.bgShells, hold.bgShellCount, "agent")
  // What the AGENT owns, for the lead's wording; the dialog lists its terminals with yours.
  const agentGroups = [subAgents, agentShells].filter((group): group is CompletionHoldGroup => group !== null)
  const allTerminals = mergeHoldGroups(agentShells, terminals)
  const groups = [subAgents, allTerminals].filter((group): group is CompletionHoldGroup => group !== null)
  if (hold.unobservable) {
    return {
      lead: "This session is live, but its transcript can’t be read right now — it may still be working.",
      groups,
      trailer: "Marking it done will stop the session anyway, then move it to Done.",
    }
  }
  // Defensive: a hold with no evidence of the agent's own (terminals alone never raise one).
  if (!hold.turnInFlight && agentGroups.length === 0) return generic
  const lead = hold.turnInFlight
    ? agentGroups.length > 0
      ? "The agent is mid-turn, and it still owns background work:"
      : terminals
      ? "The agent is mid-turn, and a terminal on this thread is still running:"
      : "The agent is mid-turn — it’s executing right now."
    : terminals
    ? "The agent is resting, but work on this thread is still running:"
    : "The agent is resting, but the background work it launched is still running:"
  return {
    lead,
    groups,
    trailer: terminals
      ? "Marking it done will stop the session and the agent's work, then move it to Done. Terminals keep running unless ticked."
      : groups.length > 0
      ? "Marking it done will stop the session and everything running under it, then move it to Done."
      : "Marking it done will stop its agent session mid-turn, then move it to Done.",
  }
}

function holdGroup(
  kind: CompletionHoldGroup["kind"],
  noun: string,
  ops: CompletionHold["subAgents"],
  count: number,
  owner?: "agent" | "human",
): CompletionHoldGroup | null {
  // The count is authoritative — the label list is capped server-side and can be shorter.
  const total = Math.max(count, ops.length)
  if (total === 0) return null
  return {
    kind,
    heading: headingFor(total, noun),
    // A terminal thread carries its own starter (`op.owner`: an agent's `ntwinectl terminal start`, or yours)
    // and its slug, which is what earns the Stop box.
    items: ops.map((op) => {
      const by = op.owner ?? owner
      return { label: op.label, stale: op.state === "stale", ...(by ? { owner: by } : {}), ...(kind === "terminal" && op.id ? { id: op.id } : {}) }
    }),
    overflow: Math.max(0, total - ops.length),
  }
}

const headingFor = (total: number, noun: string) => `${total} ${noun}${total === 1 ? "" : "s"}`

/** The agent's terminals and yours as the one group every other surface draws: the agent's first (they
 *  are what "the background work it launched" names in the lead), then yours. Each list is capped on its
 *  own server-side, so the withheld labels add. */
function mergeHoldGroups(agent: CompletionHoldGroup | null, human: CompletionHoldGroup | null): CompletionHoldGroup | null {
  if (!agent || !human) return agent ?? human
  const total = agent.items.length + agent.overflow + human.items.length + human.overflow
  return { kind: "terminal", heading: headingFor(total, "terminal"), items: [...agent.items, ...human.items], overflow: agent.overflow + human.overflow }
}
