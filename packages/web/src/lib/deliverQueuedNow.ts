import { useCallback, useState, useSyncExternalStore } from "react"
import { subscribe } from "valtio"
import { rpc } from "../api/rpc.ts"
import { showToast, store, threadBySlug } from "../store.ts"

// PUSH IT THROUGH NOW.
//
// A follow-up sent to a working agent waits in the provider's queue until the current turn ends —
// measured p50 13.8s, p90 49s, p99 2.5m, and the tail is a real 90s tool call. The operator can already
// pay for that wait up front (⌘⏎ sends AND interrupts), but that forces the decision at the moment of
// typing, before they know how long the worker is going to take. This is the same capability offered
// AFTERWARDS, from the one surface that is on screen for the whole wait: the queued bubble.
//
// There is nothing to send here — the words are already queued. All that is left is the interrupt, and
// the SDK's interrupt aborts a turn WITHOUT discarding queued input, so the next turn opens on exactly
// the messages the operator is looking at. That asymmetry is why this needed no new delivery path.
//
// It preempts the TURN, so with several bubbles queued it delivers all of them, in order. The button's
// title says that rather than implying it singles out the one under the pointer.

// Which surfaces can offer this at all: the same broker-backed-Claude boundary as unqueue (a codex
// steer goes straight into the running turn, so there is no queue to jump), plus a turn that is
// actually RUNNING — with the worker at rest there is nothing to interrupt and the button would be a
// dead click. Mirrors `canInterrupt` in ThreadComposerBox, which gates ⌘⏎ on the same two facts.
export function useDeliverQueuedNowSupported(slug: string | null): boolean {
  // useSyncExternalStore over a SCALAR, not useSnapshot — the same reason useUnqueueSupported does it:
  // this runs in every user bubble in the transcript, and a snapshot proxy would re-render all of them
  // on every board push.
  return useSyncExternalStore(
    (onChange) => subscribe(store, onChange),
    () => {
      if (!slug) return false
      const thread = threadBySlug(store.board, slug)
      return thread?.backend !== "codex" && thread?.runtime === "running"
    },
    () => false,
  )
}

export function useDeliverQueuedNow(slug: string | null): {
  deliverNow: () => void
  releaseHeld: () => void
  pending: boolean
} {
  const [pending, setPending] = useState(false)

  const deliverNow = useCallback(() => {
    if (!slug || pending) return
    // Resolved at CLICK time, not render time — a thread re-dispatched under an open drawer must not
    // interrupt the session the bubble was painted for. The server enforces this too.
    const sessionId = threadBySlug(store.board, slug)?.sessionId
    if (!sessionId) { showToast("This thread has no live session to interrupt"); return }
    setPending(true)
    void rpc.deliverQueuedNow({ slug, sessionId }).then(
      (result) => {
        setPending(false)
        // Nothing optimistic here, and nothing needed: the server moves the queue's delivery-ledger
        // entries to `delivered` under the same landed interrupt and pushes a transcript frame, so the
        // bubbles un-gray on this round trip rather than on the tailer. Keeping the claim server-side
        // is what makes it survive a reload and reach every other open tab. A refusal is spoken, since
        // the operator asked for something and did not get it.
        // `released`: messages Frizz was holding for the rest went to the runtime. On a runtime with
        // no interrupt that is the whole of "send now", and it is not a refusal.
        if (!result.interrupted && !result.released) showToast(result.reason ?? "That message could not be pushed through")
      },
      (error: unknown) => {
        setPending(false)
        showToast(`Couldn't push it through — ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
      },
    )
  }, [pending, slug])

  // SEND WHAT FRIZZ IS HOLDING, WITHOUT INTERRUPTING — the "Send now" under a message sent to the queue.
  // The operator stopped waiting for the rest; the message goes in as the steer it would have been.
  const releaseHeld = useCallback(() => {
    if (!slug || pending) return
    const sessionId = threadBySlug(store.board, slug)?.sessionId
    if (!sessionId) { showToast("This thread has no live session to send to"); return }
    setPending(true)
    void rpc.deliverQueuedNow({ slug, sessionId, releaseOnly: true }).then(
      (result) => {
        setPending(false)
        if (!result.released) showToast(result.reason ?? "That message could not be sent now")
      },
      (error: unknown) => {
        setPending(false)
        showToast(`Couldn't send it now — ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
      },
    )
  }, [pending, slug])

  return { deliverNow, releaseHeld, pending }
}
