import { useCallback, useState, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { subscribe } from "valtio"
import type { Backend } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { removeQueuedMessage } from "../hooks.ts"
import { showToast, store, threadBySlug } from "../store.ts"
import { draftKey, mergeIntoDraft, useProjectDir } from "./drafts.ts"

// TAKING A SENT MESSAGE BACK.
//
// A follow-up sent to a working agent sits in the provider's command queue — visible in the chat as
// the gray bubble — until the agent picks it up, which is anywhere from seconds to (measured) hours.
// For that whole window the operator's own message is somewhere they cannot reach: the composer is
// empty, the words are on screen, and the only way to change their mind was to send a second message
// correcting the first. Clicking the bubble is the retraction: ntwine asks the provider to drop it, and
// on a confirmed drop hands the text back to the prompt box where it can be edited and re-sent.
//
// The whole thing is worth nothing unless it is TRUTHFUL, so nothing here is optimistic. The bubble
// disappears only after the provider confirms the message left its queue; a refusal ("the agent
// already picked it up") leaves the bubble exactly where it is and says so. Silently clearing a bubble
// for a message the agent is about to read would be worse than not having the feature.

// Which surfaces can offer this at all. Only a Claude thread has a queue ntwine holds a control channel
// into; a codex steer goes straight into the running turn, so there is never anything to take back and
// the affordance would be a dead click. (A LEGACY Claude row dispatched before the broker became the
// sole transport also can't — its text was typed into Claude Code's own TUI composer — but nothing
// distinguishes it from a broker row on the client, so that one refusal is surfaced as the server's
// reason rather than predicted here.)
export function useUnqueueSupported(slug: string | null): boolean {
  // useSyncExternalStore over a SCALAR rather than useSnapshot: this runs in every user bubble in the
  // transcript, and a snapshot proxy would re-render all of them on every board push (the threads array
  // is replaced wholesale each time). A scalar getSnapshot re-renders only when the answer changes.
  return useSyncExternalStore(
    (onChange) => subscribe(store, onChange),
    () => (slug ? backendOf(slug) !== "codex" : false),
    () => false,
  )
}

function backendOf(slug: string): Backend | undefined {
  return threadBySlug(store.board, slug)?.backend
}

export type UnqueueOutcome = "unqueued" | "too-late" | "failed"

// Restore a retracted message into the thread's prompt box. Both surfaces bound to a slug (the drawer
// footer and the queue card) share ONE draft key, so this reaches whichever one the operator is
// looking at — and survives a reload, like every other draft.
//
// A draft already in the box is KEPT and the retracted text goes above it: the operator typed that
// while their message was in flight, and silently replacing it would lose words they never sent.
export function restoreDraft(projectDir: string | undefined, slug: string, sessionId: string | undefined, text: string): string {
  const key = draftKey.followUp(projectDir, slug, sessionId)
  mergeIntoDraft(key, text)
  return key
}

// Focus the composer belonging to the SAME surface as the clicked bubble, by walking outward from it
// until an ancestor contains one. A thread can be open in the drawer and rendered as a queue card at
// the same time, and both textareas are bound to the draft key above — focusing "the" composer by a
// global id would drop the caret into the wrong one. The drawer's own id is the last-resort fallback.
export function focusComposerNear(from: HTMLElement | null): void {
  if (typeof document === "undefined") return
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    const box = node.querySelector<HTMLTextAreaElement>("[data-thread-composer-box] textarea")
    if (!box) continue
    box.focus()
    // Caret at the END of the restored text, so typing continues the message rather than inserting
    // ahead of it.
    box.setSelectionRange(box.value.length, box.value.length)
    return
  }
  document.getElementById("followup-input")?.focus()
}

/** What to take back. `text` goes back into the prompt box. */
export type UnqueueInput = { deliveryId: string; text: string; rawText: string; from: HTMLElement | null }

export function useUnqueueFollowUp(slug: string | null): {
  unqueue: (input: UnqueueInput) => void
  pending: boolean
} {
  const queryClient = useQueryClient()
  const projectDir = useProjectDir()
  const [pending, setPending] = useState(false)

  const unqueue = useCallback((input: UnqueueInput) => {
    if (!slug || pending) return
    // Resolved at CLICK time, not render time: a thread re-dispatched under an open drawer must not
    // unqueue against the session the bubble was painted for. The server enforces this too — this only
    // keeps the request from being made with a knowingly stale id.
    const sessionId = threadBySlug(store.board, slug)?.sessionId
    if (!sessionId) { showToast("This thread has no live session to unqueue from"); return }
    setPending(true)
    void rpc.unqueueFollowUp({ slug, sessionId, deliveryId: input.deliveryId }).then(
      (result) => {
        setPending(false)
        if (!result.unqueued) { showToast(result.reason ?? "That message could not be taken back"); return }
        // The server has tombstoned the ledger row, so the next transcript push carries no bubble for
        // this send; drop the copy already in the cache so the retraction is instant rather than
        // waiting on that round trip.
        removeQueuedMessage(queryClient, slug, input.rawText, input.deliveryId)
        restoreDraft(projectDir, slug, sessionId, input.text)
        focusComposerNear(input.from)
      },
      (error: unknown) => {
        setPending(false)
        showToast(`Couldn't unqueue — ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
      },
    )
  }, [pending, projectDir, queryClient, slug])

  return { unqueue, pending }
}
