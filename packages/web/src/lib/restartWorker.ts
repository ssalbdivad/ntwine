import type { QueryClient } from "@tanstack/react-query"
import { showToast } from "../store.ts"
import { sendEagerFollowUp } from "./eagerComposerSubmission.ts"

// THE "Restart worker" verb — retire the thread's live `claude` process and continue the SAME
// conversation in a freshly started one.
//
// Why it has to exist at all: a worker inherits its plugin (and therefore its HOOKS) and its system
// prompt at process start, and can never pick either up afterwards. Measured, not assumed — patching a
// Stop hook into a live worker's plugin dir mid-session does nothing, while a brand-new process on that
// same patched dir runs it. So a worker dispatched before an ntwine build shipped a hook keeps running
// without it for as long as its process lives, however many turns it takes. Nothing the operator can
// type reaches that; only replacing the process does.
//
// It is NOT "start a fresh agent": the transcript is on disk, so the cold resume replays the whole
// conversation into the new process, and the server rebuilds the worker system prompt on the way in.
// The thread keeps its history, its scratch directory and its identity — it just comes back on current tooling.
//
// Delivering a message is the point rather than an afterthought. Retiring the daemon alone would leave
// the operator staring at a card where nothing visibly happened until the thread's next natural wake;
// carrying a continuation makes the restart the observable act it reads as.
export const RESTART_WORKER_MESSAGE =
  "Your worker process was restarted so it picks up ntwine's current tooling (hooks and worker contract). Re-read whatever you left in your scratch directory, then continue exactly where you left off."

// Live sub-agents do NOT gate this verb. A restart does kill the parent's in-memory children, and for a
// while that reasoning disabled the button whenever any of them was running — but the operator reaching
// for this verb is the one person who already knows, and the children they were being protected from
// losing are routinely the reason the worker needs replacing in the first place. Making them wait it out
// (maintainer 2026-08-01: "do not disable the button when there are sub-agents running") turned the one
// recovery affordance into a control that is unavailable exactly when it is wanted. The completion
// invariant binds ntwine's OWN automatic restarts — needsFreshProcessForLimit still refuses to kill a live
// child on its own initiative — not an explicit human instruction.
export function restartWorker(queryClient: QueryClient, slug: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const started = sendEagerFollowUp(queryClient, slug, RESTART_WORKER_MESSAGE, {
      freshProcess: true,
      onSuccess: () => { showToast("Restarting worker…"); resolve() },
      onRollback: () => resolve(),
      failureToast: (message) => `Restart failed: ${message.slice(0, 80)}`,
    })
    // Unreachable while the message is a non-empty constant, but a caller's `finally` must never be
    // stranded on a send that was refused before it ever started.
    if (!started) resolve()
  })
}
