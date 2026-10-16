// A HELD CARD'S TURN, LIVE (lib/queueHold.ts). A card held in the queue stays there while its thread works,
// and the human holding it is waiting on exactly that work, so it streams the worker's turn as the drawer
// does (maintainer 2026-10-16) rather than standing still on the human's reply until the rest lands. The
// card draws the turn from the human's last message on — their bubble, then the worker's prose and tool
// rows, then the drawer's working shimmer — through the drawer's own pieces: the same transcript reads,
// the same presentation pass (live background shells lifted out, tool runs coalesced, the live run held
// back for the shimmer) and the same Message rows. Once the thread rests, the card goes back to its
// handoff (AllQueuesCard.tsx), which then holds the same words.
//
// TWO SOURCES, BOTH THE DRAWER'S. A thread of the project the page is bound to reads `["transcript", slug]`
// (hooks.ts useTranscript), the drawer's own entry: api/transcript-live.ts keeps it live over the page's
// socket, and a drawer opened on the thread shares it. Any other project's thread cannot use that entry —
// the key, the socket and `rpc` all name the page's project (hooks/useCardTranscript.ts says why) — so
// it reads through its own project's client under a key that names the project, and polls at the
// drawer's own fallback cadence while it runs (useTranscript's 1.5s interval when the socket is down).
// Only held cards draw this, so the polling is bounded by what the human chose to hold.
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"
import { useTranscript, type ChatMessage, type TranscriptData } from "../hooks.ts"
import { lastHumanTurnIndex } from "../lib/messagePresentation.ts"
import { coalesceToolActivityMessages, historicalToolActivityMessages, liveRuntimeStartedAt, liveToolActivityRun, liveToolActivityTail, toolActivityLabel } from "../lib/toolActivity.ts"
import type { QueuesProject } from "../lib/allQueues.ts"
import { Message, VSpace, WorkingIndicator, withMessageSpacers, withoutLiveTranscriptBackgroundTools, workingIndicatorGap } from "./ChatView.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { focusedProject } from "./ThreadTerminals.tsx"

/** The drawer's fallback poll for a running thread (hooks.ts useTranscript `refetchInterval`). */
const LIVE_POLL_MS = 1_500

export function HeldLiveTurn({ project, thread, running }: { project: QueuesProject; thread: ThreadView; running: boolean }) {
  return focusedProject(project.slug)
    ? <PageProjectTurn project={project} thread={thread} running={running} />
    : <OtherProjectTurn project={project} thread={thread} running={running} />
}

function PageProjectTurn({ project, thread, running }: { project: QueuesProject; thread: ThreadView; running: boolean }) {
  const q = useTranscript(thread.id, { poll: running })
  return <Turn messages={q.data?.messages} projectDir={project.projectDir} slug={thread.id} running={running} />
}

function OtherProjectTurn({ project, thread, running }: { project: QueuesProject; thread: ThreadView; running: boolean }) {
  const q = useQuery({
    queryKey: ["ofProject", project.id, "transcript", thread.id, "live"],
    queryFn: async (): Promise<TranscriptData> => ({ ...(await projectRpc(project.id).threadTranscript({ slug: thread.id })) }),
    refetchInterval: running ? LIVE_POLL_MS : false,
    placeholderData: (previous) => previous,
  })
  return <Turn messages={q.data?.messages} projectDir={project.projectDir} slug={thread.id} running={running} />
}

function Turn({ messages, projectDir, slug, running }: { messages: ChatMessage[] | undefined; projectDir: string | undefined; slug: string; running: boolean }) {
  // From the human's last message on — where the card's handoff opens too (server handoffOf).
  const turn = useMemo(() => (messages ? messages.slice(lastHumanTurnIndex(messages)) : []), [messages])
  const coalesced = useMemo(() => coalesceToolActivityMessages(withoutLiveTranscriptBackgroundTools(turn)), [turn])
  const activity = useMemo(() => (running ? historicalToolActivityMessages(coalesced) : coalesced), [coalesced, running])
  const liveToolRun = running ? liveToolActivityRun(coalesced) : undefined
  const liveTool = running ? liveToolActivityTail(coalesced) : undefined
  const rows = activity.map((entry) => entry.message)
  return (
    <ThreadSlugContext.Provider value={slug}>
      <div data-transcript-column data-held-live-turn className="flex min-w-0 flex-col">
        {/* Every fence in a turn still running is stale: no awaiting card while the worker works (ChatView
            `awaitingCut`). */}
        {withMessageSpacers(rows, (m, i) => <Message key={i} m={m} staleAwaiting={running} />)}
        {running && (
          <>
            {rows.length > 0 && <VSpace h={workingIndicatorGap(rows)} />}
            <WorkingIndicator since={turn[0]?.at} startedAt={liveRuntimeStartedAt(coalesced)} activityLabel={liveTool ? toolActivityLabel(liveTool, projectDir) : undefined} run={liveToolRun} />
          </>
        )}
      </div>
    </ThreadSlugContext.Provider>
  )
}
