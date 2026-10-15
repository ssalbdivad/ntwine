import { isDirectSubAgent, type ReturnedSubAgentView, type SubAgentView, type ThreadView } from "@ntwine/shared"

// ── A QUEUED PARENT'S SUB-AGENT WAIT — what its card says about the batch it fanned out ──────────────
//
// A parent that dispatched several background sub-agents is re-invoked by each one's return, and a rest
// that is not an honoured park queues (a partial return may give the human something to act on). So the
// queue meets the same parent once per return, and until 2026-09-29 its card said only "Awaiting" over the
// worker's prose — nothing about which children were still out, which had come back, or why it was back.
// The pure half of that card lives here, beside the words it puts on screen, so a test can pin them
// without a DOM (AwaitingSubAgentsCard draws them).

export interface SubAgentWait {
  /** The direct children the thread still has out, in any liveness state the card draws. */
  out: readonly SubAgentView[]
  /** The ones that came back inside the wait (server-filtered — board.returnedSubAgentsView). */
  returned: readonly ReturnedSubAgentView[]
  running: number
  total: number
}

/** The batch, or undefined when nothing is running — with no child out there is no "of N" to state. */
export function subAgentWait(thread: Pick<ThreadView, "subAgents" | "returnedSubAgents">): SubAgentWait | undefined {
  const out = (thread.subAgents ?? []).filter(isDirectSubAgent)
  const running = out.filter((agent) => agent.state === "running").length
  if (running === 0) return undefined
  const returned = thread.returnedSubAgents ?? []
  return { out, returned, running, total: out.length + returned.length }
}

/** THE HEADING, in place of the bare "Awaiting" (David 2026-09-29: the card's header "says it
 *  plainly"). Nothing back yet reads as a wait on a count; anything back reads as progress through it. */
export function subAgentWaitHeading(wait: Pick<SubAgentWait, "returned" | "total">): string {
  if (wait.returned.length === 0) return `Waiting on ${wait.total} sub-agent${wait.total === 1 ? "" : "s"}`
  return `${wait.returned.length} of ${wait.total} sub-agents returned`
}

/** Does this queue card draw the wait in place of its ```awaiting fence?
 *
 *  At rest, with a direct child running, and nothing that outranks "waiting on its children": a done
 *  handoff is the worker's own last word, and an ask is the actionable thing on the card — the same
 *  ordering deriveAwaitingBackground keeps for the drawer's resting card. */
export function showsSubAgentWait(
  thread: Pick<ThreadView, "kind" | "foreign" | "runtime" | "lastFence" | "pendingAsk" | "pendingQuestion" | "questions" | "subAgents" | "returnedSubAgents">,
): boolean {
  if (thread.kind !== "session" || thread.foreign === true || thread.runtime !== "turn-idle") return false
  if (thread.lastFence?.kind === "done") return false
  if (thread.pendingAsk || thread.pendingQuestion || (thread.questions?.length ?? 0) > 0) return false
  return subAgentWait(thread) !== undefined
}

/** Is the awaiting card what lists this card's children? `fences` are the handoff's own, once it is read;
 *  until then the thread's last fence stands in, so the rows do not start under the reply box and then
 *  jump into the card. Everywhere else — mid-turn after a reply, a question or a done beside live work —
 *  the card's ops column lists them (QueueChildOps), so live work is never off the card. */
export function drawsSubAgentWaitCard(
  thread: Parameters<typeof showsSubAgentWait>[0],
  fences: readonly { kind: string }[] | undefined,
): boolean {
  if (!showsSubAgentWait(thread)) return false
  return fences ? fences.some((fence) => fence.kind === "awaiting") : thread.lastFence?.kind === "awaiting"
}
