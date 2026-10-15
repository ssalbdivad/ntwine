import { awaitingQuestions, awaitingStatus, awaitingSteps, isDirectSubAgent, isKeepWorkingMessage, type AwaitingHint, type ThreadView, type TranscriptMessage } from "@ntwine/shared"

// KEEP WORKING — the resting card's answer to a worker that parked `status: needs_input` while work it
// named is still running, because it offered the human something to look at ("try the dev server now").
// That park queues the thread; once the human has looked and needs nothing, the button sends the worker
// KEEP_WORKING_MESSAGE (shared) through the ordinary reply path and the worker re-parks `working`. ntwine
// never moves the thread itself: the worker's last word decides where it sits.

/** The button's label, and the marker's verb in the transcript (KeepWorkingMarker). */
export const KEEP_WORKING_LABEL = "Keep working"
/** The one line the human's click leaves in the transcript, on their side of it. */
export const KEEP_WORKING_MARKER = "Told it to keep working"

/** Every handle a running shell or direct sub-agent answers to — the client's copy of the server's
 *  board.liveWaitHandles, which accepts the launch id, the runtime task id and the label, because a
 *  worker names whichever it was shown. */
function liveWorkHandles(thread: Pick<ThreadView, "subAgents" | "bgShells">): Set<string> {
  const handles = new Set<string>()
  for (const shell of thread.bgShells ?? []) {
    if (shell.state !== "running") continue
    for (const h of [shell.id, shell.taskId, shell.label]) if (h) handles.add(h)
  }
  for (const agent of thread.subAgents ?? []) {
    if (!isDirectSubAgent(agent) || agent.state !== "running") continue
    for (const h of [agent.id, agent.taskId, agent.label]) if (h) handles.add(h)
  }
  return handles
}

/** Does this thread's resting card offer Keep working? Only at rest on its own ```awaiting fence, when
 *  that fence answers `needs_input` by its `status:` line (steps and questions are the human's to do, and
 *  carry their own verbs) and still names a shell or sub-agent that is running — the work the worker can
 *  go back to waiting on. Ownership is the card's own test (threadLifecycleAvailability), not this one. */
export function offersKeepWorking(
  thread: Pick<ThreadView, "runtime" | "awaitingBackground" | "lastFence" | "subAgents" | "bgShells">,
): boolean {
  if (thread.runtime !== "turn-idle" || thread.awaitingBackground !== true) return false
  const fence = thread.lastFence
  if (fence?.kind !== "awaiting") return false
  const hints: readonly AwaitingHint[] = fence.hints ?? []
  if (awaitingSteps(hints).length > 0 || awaitingQuestions(hints).length > 0) return false
  if (awaitingStatus(hints) !== "needs_input") return false
  const live = liveWorkHandles(thread)
  return hints.some((h) => (h.kind === "shell" || h.kind === "agent") && live.has(h.value.trim()))
}

/** Does the chat draw this user turn as the Keep working marker rather than the human's bubble?
 *  `keepWorking` is the server's tell (transcript.ts userProjection, delivery-ledger.ts); the text read
 *  covers the optimistic copy, which no projection has seen. A FAILED send keeps the bubble, which is what
 *  carries Retry / Edit / Dismiss. */
export function drawsKeepWorkingMarker(m: Pick<TranscriptMessage, "text" | "keepWorking" | "deliveryState">): boolean {
  return (m.keepWorking === true || isKeepWorkingMessage(m.text)) && m.deliveryState !== "failed"
}
