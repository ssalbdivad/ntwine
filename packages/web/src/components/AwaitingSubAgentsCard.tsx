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
//   • the band carries the two EVENT snoozes. "Until all return" waits out the batch — each return still
//     wakes the agent, only the last one brings the card back (board.subAgentsSnoozeHolds). "Until new
//     activity" is the drawer's resting-card snooze (AwaitingBackgroundCard), spent by the next rest.
//     The footer's snooze menu offers the same two (SubAgentWaitSnoozeItems) beside its wall clock.
//
// It is its own component, mounted by AllQueuesCard in place of the fence it replaces, because that card
// is edited by several hands at once and this one only needs a line there.
import { useState } from "react"
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { ThreadProjectScope, useThreadApi } from "../api/threadApi.tsx"
import { projectSlug } from "../lib/base-path.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import {
  ACTIVITY_SNOOZE_TOAST,
  SUBAGENTS_SNOOZE_EXPLAINER,
  SUBAGENTS_SNOOZE_TOAST,
  subAgentWait,
  subAgentWaitHeading,
} from "../lib/subAgentWait.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { pushSubAgentDrawer, showToast, store } from "../store.ts"
import { BG_SNOOZE_EXPLAINER } from "./AwaitingBackgroundCard.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { MenuItem, MenuSeparator } from "./ui/Menu.tsx"
import { QueueSubAgentLines, type OpenQueueSubAgent } from "./QueueSubAgentLines.tsx"
import { BLOCK_RADIUS_INNER_BOTTOM, CARD_ACTION_RADIUS, CARD_PRIMARY_ACTION, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

type CardThread = Pick<ThreadView, "id" | "sessionId" | "kind" | "foreign" | "state" | "archived" | "subAgents" | "returnedSubAgents">

interface SnoozeCallbacks {
  /** The snooze landed: the card fades now, by the human's hand, rather than ghosting when the queue
   *  next reads the thread out. */
  onSnoozed?: () => void
  /** The toast's Undo cleared it again: give back what `onSnoozed` took. */
  onUndone?: () => void
}

/** The two event snoozes, as verbs. One hook for both surfaces that offer them, so the band and the menu
 *  cannot drift into two toasts, two undos, or two clients. The client is the thread's OWN project's
 *  (useThreadApi) — on Everything the page's `rpc` names the focused project, which is usually not the
 *  card's. */
function useSubAgentWaitSnoozes(thread: Pick<ThreadView, "id" | "sessionId">, { onSnoozed, onUndone }: SnoozeCallbacks) {
  const api = useThreadApi()
  const [pending, setPending] = useState(false)
  const ids = { slug: thread.id, sessionId: thread.sessionId ?? "" }
  const run = (arm: () => Promise<void>, clear: () => Promise<void>, toast: string) => {
    if (pending) return
    setPending(true)
    arm()
      .then(() => {
        onSnoozed?.()
        // UNDO, as the wall-clock snooze has it: the click takes the card off the page, and a snooze with
        // no deadline would otherwise hold the thread until its work happened to report.
        showToast(toast, {
          action: {
            label: "Undo",
            run: () =>
              void clear()
                .then(() => {
                  showToast("Snooze undone")
                  onUndone?.()
                })
                .catch((error: unknown) => showToast(`Undo failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)),
          },
        })
      })
      .catch((error: unknown) => showToast(`Couldn’t snooze: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`))
      .finally(() => setPending(false))
  }
  return {
    pending,
    untilAllReturn: () =>
      run(() => api.snoozeUntilSubAgentsReturn(ids), () => api.snoozeUntilSubAgentsReturn({ ...ids, clear: true }), SUBAGENTS_SNOOZE_TOAST),
    untilActivity: () =>
      run(() => api.snoozeAwaitingBackground(ids), () => api.snoozeAwaitingBackground({ ...ids, clear: true }), ACTIVITY_SNOOZE_TOAST),
  }
}

/** The same two verbs as items of the footer's snooze menu (SnoozeButton `eventItems`), above its wall
 *  clock. Nothing when the thread has no wait to snooze on. */
export function SubAgentWaitSnoozeItems({ thread, ...callbacks }: { thread: CardThread } & SnoozeCallbacks) {
  const verbs = useSubAgentWaitSnoozes(thread, callbacks)
  const wait = subAgentWait(thread)
  if (!wait || !threadLifecycleAvailability(thread).snooze) return null
  return (
    <>
      <MenuItem value="until-subagents-return" onSelect={verbs.untilAllReturn} icon={<Hourglass size={12} />}>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-4" title={SUBAGENTS_SNOOZE_EXPLAINER}>
          <span>Until all sub-agents return</span>
          <span className="text-[10px] text-muted-55">{wait.running} running</span>
        </span>
      </MenuItem>
      <MenuItem value="until-new-activity" onSelect={verbs.untilActivity} icon={<Hourglass size={12} />}>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-4" title={BG_SNOOZE_EXPLAINER}>
          <span>Until new activity</span>
          <span className="text-[10px] text-muted-55">next rest</span>
        </span>
      </MenuItem>
      <MenuSeparator />
    </>
  )
}

export function AwaitingSubAgentsCard({ project, thread, body, openThread, ...callbacks }: {
  project: { id: string; slug: string; projectDir: string | undefined }
  thread: CardThread
  /** The ```awaiting fence's body, which this card states in place of the fence card. */
  body: string
  /** Open the thread's own drawer on this page — how a row opens its child when the card's project is
   *  not the one the page is focused on (see openChild). */
  openThread: () => void
} & SnoozeCallbacks) {
  return (
    <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
      <WaitCard project={project} thread={thread} body={body} openThread={openThread} {...callbacks} />
    </ThreadProjectScope>
  )
}

function WaitCard({ project, thread, body, openThread, ...callbacks }: Parameters<typeof AwaitingSubAgentsCard>[0]) {
  const api = useThreadApi()
  const html = useMarkdownHtml(body.trim())
  const verbs = useSubAgentWaitSnoozes(thread, callbacks)
  const wait = subAgentWait(thread)
  if (!wait) return null
  const snoozable = threadLifecycleAvailability(thread).snooze
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
      className={snoozable ? "pb-0" : ""}
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
      {snoozable && (
        // THE BAND — the resting card's recessed footer strip (AwaitingBackgroundCard), flush with the
        // card's bottom corners, so the snoozes read as chrome under the batch rather than as one more row
        // of it. One white verb per card: the batch-long snooze is the one this card exists to offer, and
        // "until new activity" stands beside it outlined, as a sanctioned secondary sibling does.
        <div data-subagent-wait-snooze className={`-mx-4 mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border bg-fg/[0.03] px-4 py-2.5 ${BLOCK_RADIUS_INNER_BOTTOM}`}>
          <button
            type="button"
            data-snooze="until-subagents-return"
            onClick={verbs.untilAllReturn}
            disabled={verbs.pending}
            onMouseDown={(event) => event.preventDefault()}
            title={SUBAGENTS_SNOOZE_EXPLAINER}
            className={`disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
          >
            <Hourglass size={12} className={ICON_LABEL_NUDGE} />
            Snooze until all return
          </button>
          <button
            type="button"
            data-snooze="until-new-activity"
            onClick={verbs.untilActivity}
            disabled={verbs.pending}
            onMouseDown={(event) => event.preventDefault()}
            title={BG_SNOOZE_EXPLAINER}
            className={`shrink-0 ${CARD_ACTION_RADIUS} border border-border-strong px-2 py-[3px] text-[11px] font-medium text-fg/90 outline-none transition-colors hover:bg-panel focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45`}
          >
            Until new activity
          </button>
        </div>
      )}
    </TranscriptCard>
  )
}
