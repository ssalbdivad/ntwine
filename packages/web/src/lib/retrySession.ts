import type { QueryClient } from "@tanstack/react-query"
import { RETRY_MESSAGE } from "@ntwine/shared"
import { showToast } from "../store.ts"
import { sendEagerFollowUp } from "./eagerComposerSubmission.ts"

// THE recovery follow-up, shared by every surface that offers to restart an exited session — the
// thread header's Retry pill, the queue card header's, and the sidebar row's hover-revealed one — so
// they can never send different messages down different paths.
//
// Recovery is an ORDINARY follow-up: the server reattaches the dead provider session (for a detached
// Codex app-server session it rebinds the rollout and retires the phantom current turn first), then
// starts this continuation. That sentence was already true of the MESSAGE and false of everything
// else: this called rpc.followUp DIRECTLY, so alone among the send paths it skipped the optimistic
// bubble, the steer hint, and the per-slug FIFO chain. Measured cost — the row kept its yellow [!] and
// its rested-band position for 2.2s after the click, with a toast as the only sign the click landed,
// on the one verb whose whole job is rescuing a thread that already looks broken. Being off the FIFO
// chain was the quieter half: a Retry racing a composer send can lose the server's runtime-control CAS
// and fail outright.
//
// So recovery goes through sendEagerFollowUp like every other send, and is now an ordinary follow-up
// in the CODE as well as in the prose. The session guard it used to resolve by hand comes with it —
// sendEagerFollowUp binds the id at send time from the live board, which is strictly better than the
// render-time read this did.
// The message is shared RETRY_MESSAGE: a card action, drawn in the transcript as the human's "Retried"
// marker rather than a bubble of the worker's instruction (lib/cardActions.ts).
export const STALLED_RETRY_MESSAGE = RETRY_MESSAGE

export function retrySession(queryClient: QueryClient, slug: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const started = sendEagerFollowUp(queryClient, slug, STALLED_RETRY_MESSAGE, {
      onSuccess: () => { showToast("Retrying…"); resolve() },
      onRollback: () => resolve(),
      failureToast: (message) => `Retry failed: ${message.slice(0, 80)}`,
    })
    // Unreachable while the message is a non-empty constant, but a caller's `finally` must never be
    // stranded on a send that was refused before it ever started.
    if (!started) resolve()
  })
}
