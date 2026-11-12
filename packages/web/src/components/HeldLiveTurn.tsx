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
import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"
import { useTranscript, type ChatMessage, type TranscriptData } from "../hooks.ts"
import { lastHumanTurnIndex } from "../lib/messagePresentation.ts"
import { coalesceToolActivityMessages, historicalToolActivityMessages, liveRuntimeStartedAt, liveToolActivityRun, liveToolActivityTail, toolActivityLabel } from "../lib/toolActivity.ts"
import type { QueuesProject } from "../lib/allQueues.ts"
import type { HeldReply } from "../lib/queueHold.ts"
import { Message, VSpace, WorkingIndicator, withMessageSpacers, withoutLiveTranscriptBackgroundTools, workingIndicatorGap } from "./ChatView.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { focusedProject } from "./ThreadTerminals.tsx"

/** The drawer's fallback poll for a running thread (hooks.ts useTranscript `refetchInterval`). */
const LIVE_POLL_MS = 1_500

/** How far the transcript's stamp on a reply may run behind the sending browser's clock and still be that
 *  reply (`sent`); the text match is what settles it in the ordinary case. */
const SENT_CLOCK_SLACK_MS = 2_000

/** What both transcript sources hand the turn. `sent` is the reply this card just sent (lib/queueHold.ts
 *  noteHeldReply): until the transcript has it, the turn is that reply alone, drawn at once, with the
 *  working shimmer under it. `onTools` hears the names of the tools the turn has
 *  called since the human's message, and when that message was written, whenever they change — what tells
 *  an automatic hold that the reply became long work (lib/foregroundTurn.ts). */
type Hooks = { running: boolean; sent?: HeldReply; onTools?: (names: readonly string[], humanAt: number) => void }
type TurnProps = Hooks & { project: QueuesProject; thread: ThreadView }

export function HeldLiveTurn(props: TurnProps) {
  return focusedProject(props.project.slug) ? <PageProjectTurn {...props} /> : <OtherProjectTurn {...props} />
}

function PageProjectTurn({ project, thread, ...hooks }: TurnProps) {
  // Read live from the send on: the board can still say "at rest" while the reply is already in.
  const q = useTranscript(thread.id, { poll: hooks.running || hooks.sent !== undefined })
  return <Turn messages={q.data?.messages} projectDir={project.projectDir} slug={thread.id} {...hooks} />
}

function OtherProjectTurn({ project, thread, ...hooks }: TurnProps) {
  const running = hooks.running || hooks.sent !== undefined
  const q = useQuery({
    queryKey: ["ofProject", project.id, "transcript", thread.id, "live"],
    queryFn: async (): Promise<TranscriptData> => ({ ...(await projectRpc(project.id).threadTranscript({ slug: thread.id })) }),
    refetchInterval: running ? LIVE_POLL_MS : false,
    placeholderData: (previous) => previous,
  })
  return <Turn messages={q.data?.messages} projectDir={project.projectDir} slug={thread.id} {...hooks} />
}

function Turn({ messages, projectDir, slug, running: threadRunning, sent, onTools }: Hooks & { messages: ChatMessage[] | undefined; projectDir: string | undefined; slug: string }) {
  // From the human's last message on — where the card's handoff opens too (server handoffOf).
  const latest = useMemo(() => (messages ? messages.slice(lastHumanTurnIndex(messages)) : []), [messages])
  const human = latest[0]
  const sentSeen = sent !== undefined && human?.role === "user" &&
    (human.text.includes(sent.text.trim()) || Date.parse(human.at ?? "") >= sent.at - SENT_CLOCK_SLACK_MS)
  // Working from the send on, not from when the board first reads the thread as running.
  const running = threadRunning || (sent !== undefined && !sentSeen)
  const turn = useMemo<ChatMessage[]>(
    () => (sent && !sentSeen ? [{ role: "user", text: sent.text, tools: [], parts: [], at: new Date(sent.at).toISOString() }] : latest),
    [sent, sentSeen, latest],
  )
  const toolNames = useMemo(() => turn.flatMap((m) => (m.role === "assistant" ? m.tools.map((tool) => tool.name) : [])), [turn])
  const toolNamesId = toolNames.join("\n")
  useEffect(() => {
    if (running && onTools) onTools(toolNames, Date.parse(turn[0]?.at ?? ""))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the names, not the array's identity
  }, [toolNamesId, running, onTools])
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
