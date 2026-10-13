// A QUEUE CARD'S TRANSCRIPT — read through the card's OWN project, under a key that names it.
//
// The card opens on the handoff (AllQueuesCard handoffQuery), which is two messages the server cuts for it
// and the reason a page of every project's queue is cheap to draw. It reads the transcript itself only when
// it needs one: to place its open questions at the rest each was asked at (lib/queueCardQuestions.ts),
// which the handoff cannot say — the rests between the human's turn and the newest one are not in it.
// (Reading back through the thread is the drawer's job, one click away: AllQueuesCard "Show earlier
// messages".)
//
// NOT the drawer's cache entry (`["transcript", slug]`, hooks.ts useTranscript). That one is the PAGE's:
// hashed under the page's project scope, kept live by transcript-live.ts through the page's socket, and read
// through the page's `rpc` — all three name the focused project, which on All projects is usually not the
// card's, and an observer of that key would subscribe the card's slug on the wrong project's socket. This
// key carries its project (`ofProject`, lib/queryKeyScope.ts) and its REST, like the handoff's: a card is a
// thread at rest, so the transcript it shows cannot move until the thread rests again, and a new rest is a
// new key. No socket, no poll, no watchdog — the same economy as the handoff.
import { useQuery } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"
import type { TranscriptData } from "../hooks.ts"

export function cardTranscriptKey(project: { id: string }, thread: Pick<ThreadView, "id" | "lastAssistantAt">) {
  return ["ofProject", project.id, "transcript", thread.id, thread.lastAssistantAt ?? ""] as const
}

export function cardTranscriptQuery(project: { id: string }, thread: Pick<ThreadView, "id" | "lastAssistantAt">) {
  return {
    queryKey: cardTranscriptKey(project, thread),
    queryFn: async (): Promise<TranscriptData> => {
      const page = await projectRpc(project.id).threadTranscript({ slug: thread.id })
      return { ...page, messages: page.messages }
    },
    staleTime: Infinity,
  }
}

/** The card's transcript, read only while `enabled`. The previous rest's stays on screen while the next one
 *  loads, as the handoff's does, so the card never blanks between two rests. */
export function useCardTranscript(project: { id: string }, thread: Pick<ThreadView, "id" | "lastAssistantAt">, enabled: boolean) {
  return useQuery({
    ...cardTranscriptQuery(project, thread),
    enabled,
    placeholderData: (previous) => previous,
  })
}
