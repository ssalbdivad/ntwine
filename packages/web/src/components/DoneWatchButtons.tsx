import { useContext, useMemo, useState } from "react"
import type { ThreadView } from "@ntwine/shared"
import { useThreadApi } from "../api/threadApi.tsx"
import { showToast } from "../store.ts"
import { doneWatchRefs, watchedRefs } from "../lib/doneWatchRefs.ts"
import { MarkdownScopeContext, useGithubRepoForLinks } from "../lib/useMarkdown.ts"
import { CARD_ACTION_RADIUS } from "./TranscriptCard.tsx"

// THE DONE CARD'S WATCH BUTTONS (2026-10-07): one "Watch #N" per pull request or issue the card links.
//
// A finished worker used to park itself on the PR it touched for months (`watch_pr` for 180d, chosen
// blind), so threads vanished into Snoozed whether or not anyone wanted to follow them. It now signs off
// `done`, and following the PR is the human's choice, made here whenever they read the card: the click
// arms the same watcher the worker tools arm and parks the thread in Waiting until it reports
// (router.watchDoneRef). ntwine parks nothing on the worker's behalf — the click is the human's.
//
// OUTLINED, NOT THE WHITE CARD VERB. "Mark as done" is the card's verb and the default answer (it is the
// header's check on the queue, and the white button beside these in the drawer); watching is the
// secondary choice, so it takes the secondary sibling's chrome — the provider-fault card's Retry — and
// sits AFTER the verb so the verb never moves. `py-[3px]`, not Retry's `py-1`: the 1px border made that
// one 25.70px tall beside the verb's 23.70px; measured equal (23.70px, same centre) in the drawer, sans.
//
// Only on the thread's CURRENT done at rest: an older done card further up a transcript names work the
// thread has since moved past, and the click parks the rest the human is looking at.
export const DONE_WATCH_BUTTON = `shrink-0 ${CARD_ACTION_RADIUS} border border-border px-2 py-[3px] text-[11px] text-fg/90 transition-colors hover:bg-panel hover:border-border-strong disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:border-border`

export function useDoneWatchRefs(html: string) {
  const scope = useContext(MarkdownScopeContext)
  const pageRepo = useGithubRepoForLinks()
  const repo = scope ? scope.repo : pageRepo
  return useMemo(() => doneWatchRefs(html, repo), [html, repo])
}

/** Whether this done card is the thread's current sign-off at rest — the one Watch may park. */
export function doneWatchable(thread: Pick<ThreadView, "lastFence" | "runtime" | "state" | "archived" | "kind" | "foreign">, body: string): boolean {
  const fence = thread.lastFence
  if (thread.kind !== "session" || thread.foreign === true || thread.state === "archived" || thread.archived) return false
  if (thread.runtime !== "turn-idle" || fence?.kind !== "done") return false
  // The board caps a fence body (tailer FENCE_BODY_MAX, with a trailing ellipsis), so it is a prefix.
  const stored = fence.body.trim().replace(/…$/, "")
  return body.trim().startsWith(stored)
}

export function DoneWatchButtons({ thread, refs, onWatched, onWatchFailed }: {
  thread: ThreadView
  refs: { ref: string; label: string }[]
  /** The queue card's optimistic exit, as Snooze takes it; absent in the drawer. */
  onWatched?: () => void
  onWatchFailed?: () => void
}) {
  const api = useThreadApi()
  const [pending, setPending] = useState<string | null>(null)
  const watched = watchedRefs(thread.watches)
  // Waiting on its watch right now — the board's verdict (board.doneParkedOnWatch), not this click's.
  const parked = thread.waitStatus === "watching" && thread.bgSnoozed === true
  const watch = (ref: string, label: string) => {
    setPending(ref)
    onWatched?.()
    api
      .watchDoneRef({ slug: thread.id, sessionId: thread.sessionId ?? "", target: ref })
      .then(() => showToast(`Snoozed until ${label} changes`))
      .catch((error) => {
        onWatchFailed?.()
        showToast(`Couldn’t watch ${label}: ${(error as Error).message.slice(0, 80)}`)
      })
      .finally(() => setPending(null))
  }
  return (
    <>
      {refs.map(({ ref, label }) => {
        const watching = parked && watched.has(ref.toLowerCase())
        return (
          <button
            key={ref}
            type="button"
            data-done-watch={ref}
            disabled={watching || pending !== null}
            onClick={() => watch(ref, label)}
            onMouseDown={(e) => e.preventDefault()}
            className={DONE_WATCH_BUTTON}
          >
            {watching ? `Watching ${label}` : `Watch ${label}`}
          </button>
        )
      })}
    </>
  )
}
