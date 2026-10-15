// A QUEUED PARENT'S SUB-AGENTS, ON ITS QUEUE CARD.
//
// A parent that fanned out several background sub-agents rests "awaiting" them, and each return wakes it:
// it reads the report and rests again. A rest that is not an honoured park queues (a partial return may
// give the human something to act on), so the queue meets that parent once per return. Everything's card
// drew it as a bare "Awaiting" fence over the worker's prose and a wall-clock Snooze, so nothing said
// which children were still out, which had come back, or why the card was back at all.
//
// This card is that fence, stated plainly (David 2026-09-29):
//   • the heading counts the batch — "2 of 3 sub-agents returned" — rather than naming the state;
//   • the rows are the batch: the ones still out (QueueSubAgentLines, the rows the project board's
//     queue card drew under its prompt box until 2026-09-28) and the ones that came back since the wait
//     opened, with the muted check upstream's focus-mode mockup (4d7b3cb8) drew them with;
//   • (a band of two EVENT snoozes — "until all return" and "until new activity" — rode under the rows
//     until 2026-10-14, when both were removed: they hid threads whose own work was still out.)
//
//   • Keep working (lib/keepWorking.ts) is its one verb, when the worker parked the batch `needs_input`:
//     the queue reaches this card in place of the resting card that carries it in the drawer.
//
// It is its own component, mounted by AllQueuesCard in place of the fence it replaces, because that card
// is edited by several hands at once and this one only needs a line there.
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { ThreadProjectScope, useThreadApi } from "../api/threadApi.tsx"
import { projectSlug } from "../lib/base-path.ts"
import { offersKeepWorking } from "../lib/keepWorking.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { subAgentWait, subAgentWaitHeading } from "../lib/subAgentWait.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { pushSubAgentDrawer, store } from "../store.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QueueSubAgentLines, type OpenQueueSubAgent } from "./QueueSubAgentLines.tsx"
import { KeepWorkingButton } from "./KeepWorking.tsx"
import { CardActions, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

type CardThread = Pick<ThreadView, "id" | "sessionId" | "kind" | "foreign" | "state" | "archived" | "subAgents" | "returnedSubAgents" | "runtime" | "awaitingBackground" | "lastFence" | "bgShells" | "lastAssistantAt">

export function AwaitingSubAgentsCard({ project, thread, body, openThread, onReplied, onReplyFailed, reply }: {
  project: { id: string; slug: string; projectDir: string | undefined }
  thread: CardThread
  /** The ```awaiting fence's body, which this card states in place of the fence card. */
  body: string
  /** Open the thread's own drawer on this page — how a row opens its child when the card's project is
   *  not the one the page is focused on (see openChild). */
  openThread: () => void
  /** Keep working's optimistic card exit, its rollback, and its send into the card's project — the
   *  resting card's own (AwaitingBackgroundCard). */
  onReplied?: () => void
  onReplyFailed?: () => void
  reply?: (message: string) => Promise<void>
}) {
  return (
    <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
      <WaitCard project={project} thread={thread} body={body} openThread={openThread} onReplied={onReplied} onReplyFailed={onReplyFailed} reply={reply} />
    </ThreadProjectScope>
  )
}

function WaitCard({ project, thread, body, openThread, onReplied, onReplyFailed, reply }: Parameters<typeof AwaitingSubAgentsCard>[0]) {
  const api = useThreadApi()
  const html = useMarkdownHtml(body.trim())
  const wait = subAgentWait(thread)
  if (!wait) return null
  // A CHILD'S TRANSCRIPT OPENS OVER THE PAGE'S PROJECT. The sub-agent drawer is addressed by slug and read
  // through the page's client, so on a card of the FOCUSED project it opens the child in place, as every
  // other child row does; on another project's card it would read the focus's `<slug>` — so that row opens
  // the thread's own drawer instead, one click from the same child row in its ops strip.
  const openChild: OpenQueueSubAgent = (child) => {
    const focused = projectSlug() === project.slug && store.board?.projectSlug === project.slug
    if (focused) pushSubAgentDrawer(thread.id, child.id, child)
    else openThread()
  }
  return (
    <TranscriptCard
      data-subagent-wait={`${wait.returned.length}/${wait.total}`}
      icon={Hourglass}
      label={subAgentWaitHeading(wait)}
    >
      {html && <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />}
      {/* The batch. Live rows first — they are what the card is still waiting on — then the returns,
          oldest first. `px-0`: the rows sit on the card's own content edge, under the title and prose. */}
      <QueueSubAgentLines
        slug={thread.id}
        subAgents={wait.out}
        returned={wait.returned}
        api={api}
        onOpenChild={openChild}
        className={html ? "pt-3" : "pt-1"}
      />
      {threadLifecycleAvailability(thread).snooze && offersKeepWorking(thread) && (
        <CardActions data-awaiting-actions>
          <KeepWorkingButton key={`keep-working:${thread.lastAssistantAt ?? ""}`} slug={thread.id} onReplied={onReplied} onReplyFailed={onReplyFailed} send={reply} />
        </CardActions>
      )}
    </TranscriptCard>
  )
}
