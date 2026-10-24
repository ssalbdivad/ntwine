import { awaitingQuestions, awaitingStatus, awaitingSteps, isDirectSubAgent, isKeepWorkingMessage, type AwaitingHint, type ThreadView, type TranscriptMessage } from "@ntwine/shared"

// KEEP WORKING — the resting card's answer to a worker that parked `status: needs_input` while work it
// named is still running, because it offered the human something to look at ("try the dev server now").
// That park queues the thread; once the human has looked and needs nothing, the button sends the worker
// KEEP_WORKING_MESSAGE (shared) through the ordinary reply path and the worker re-parks `working`. ntwine
// never moves the thread itself: the worker's last word decides where it sits.

/** The button's label, and the marker's verb in the transcript (KeepWorkingMarker). It read "Keep
 *  working" until 2026-10-15 (maintainer: replace it with "Continue"); the code keeps the old name, and
 *  the message keeps its `<keep-working>` envelope so transcripts already written still draw the marker. */
export const KEEP_WORKING_LABEL = "Continue"
/** The one line the human's click leaves in the transcript, on their side of it. */
export const KEEP_WORKING_MARKER = "Told it to continue"

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

/** Does this thread's resting card offer Keep working? At rest, out of nothing the human must do, while
 *  work of the thread's own is still running for the worker to go back to waiting on. Two rests qualify:
 *
 *  · an ```awaiting fence that answers `needs_input` by its `status:` line — the worker offered something to
 *    look at ("try the dev server now") — when the fence names a shell or sub-agent still running, or the
 *    thread still has a direct sub-agent or Workflow running that the fence left out;
 *  · NO FENCE AT ALL while a direct sub-agent or Workflow runs: a plain answer to the human's question,
 *    where the contract owed a park and the worker slipped (@personal-page, 2026-10-15). It queues as an
 *    unanswered rest, and the button is the "I read it, go back to work" that would have been the park.
 *
 *  Never on a `working`/`watching` answer (it is not asking), on steps or questions (the human's to do, with
 *  their own verbs), or on a done. A shell counts only when the fence names it: an undeclared one is as
 *  likely a dev server nobody is waiting on (board.hasDeclaredWait's rule). `awaitingBackground` is the
 *  server's word that the rest is otherwise clear — no open question, no limit or provider fault.
 *  Ownership is the card's own test (threadLifecycleAvailability), not this one. */
export function offersKeepWorking(
  thread: Pick<ThreadView, "runtime" | "awaitingBackground" | "lastFence" | "subAgents" | "bgShells">,
): boolean {
  if (thread.runtime !== "turn-idle" || thread.awaitingBackground !== true) return false
  const runningSubAgent = (thread.subAgents ?? []).some((agent) => isDirectSubAgent(agent) && agent.state === "running")
  const fence = thread.lastFence
  if (fence === undefined) return runningSubAgent
  if (fence.kind !== "awaiting") return false
  const hints: readonly AwaitingHint[] = fence.hints ?? []
  if (awaitingSteps(hints).length > 0 || awaitingQuestions(hints).length > 0) return false
  if (awaitingStatus({ hints, body: fence.body ?? "" }) !== "needs_input") return false
  if (runningSubAgent) return true
  const live = liveWorkHandles(thread)
  return hints.some((h) => (h.kind === "shell" || h.kind === "agent") && live.has(h.value.trim()))
}

/** Does the chat draw this user turn as the Keep working marker rather than the human's bubble?
 *  `keepWorking` is the server's tell (transcript.ts userProjection, delivery-ledger.ts); the text read
 *  covers the optimistic copy, which no projection has seen. */
export function drawsKeepWorkingMarker(m: Pick<TranscriptMessage, "text" | "keepWorking">): boolean {
  return m.keepWorking === true || isKeepWorkingMessage(m.text)
}
