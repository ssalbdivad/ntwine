// A QUEUE CARD'S LIVE WORK — every sub-agent and Workflow the thread has running, in one column, WHATEVER
// THE WORKER IS DOING, with the card's terminals hung under them in the same column.
//
// IN THE OPS PANEL since 2026-10-06. The column hung under the card's reply box until the box docked to
// the bottom of the screen (upstream's queue dock, 199adf2c): a dock cannot carry a column of rows, so the
// rows fold into one line of counts above it (QueueOpsSummary) and this column is what its hover panel
// shows. The rows are unchanged — same component, same order, same drill-in and ×.
//
// Until 2026-09-29 a card named its children only inside AwaitingSubAgentsCard, which is drawn in place of
// the worker's ```awaiting fence — at rest, with that fence, and no question open. Anything else drew
// none: a card held on screen while its worker ran the answer to one of its questions, a done
// or a question beside live children, and every card from the moment a human reply retired the fence
// until the worker rested again. The maintainer, replying to a parent with children running: it "no
// longer appears to be running anything". The rail (Sidebar SubAgentCount) and the drawer's strip under
// its prompt box (ChatView BackgroundOpsStrip) read `subAgents` with no such gate; now the card does too.
//
// THE DRAWER'S STRIP, REPRODUCED. The same ChildOpRow at the drawer's own "sheet" density — dot, kind tag
// (AGENT / FLOW), label, age, × — in dispatch order with their subtrees indented, so a card reads exactly
// like the prompt box it opens into. When the awaiting card IS drawn it lists the children with their
// returned siblings, so `agents` is off here.
//
// THE TERMINALS ARE NOT THIS COLUMN'S ROWS. Every terminal on a thread, the agent's and the human's, is one
// TERM row in ThreadTerminals' process strip — its budget, its folder hint and its drawer included — which
// the card hands in as `after`, so it hangs in this same column and inset, under the AGENT / FLOW rows and
// on their label column. This column drew its own SHELL rows until then; with the strip on every card they
// were never drawn, and were removed.
//
// NOT BackgroundOpsStrip itself, which reads the PAGE's board (useBoard) and stops through the page's
// `rpc` — on the cross-project page both name the FOCUSED project, which is usually not the card's. The
// thread, the ×, and the drill-in all come from the CARD's own project here.
import type { ReactNode } from "react"
import type { ThreadView } from "@ntwine/shared"
import type { Api } from "../api/rpc.ts"
import { subAgentName } from "../groups.ts"
import { projectSlug } from "../lib/base-path.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { pushSubAgentDrawer, store } from "../store.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

export function QueueChildOps({ project, thread, api, agents = true, after, onOpenThread }: {
  project: { slug: string }
  thread: Pick<ThreadView, "id" | "subAgents">
  /** The card's OWN project's client — never the page's `rpc` (see the header). */
  api: Api
  /** False while the awaiting card above lists the children itself. */
  agents?: boolean
  /** Rows drawn in this column after its own — the card's process strip. */
  after?: ReactNode
  /** Open the thread in place, where its drawer lists the same work with its output. */
  onOpenThread: () => void
}) {
  // The card's policy (lib/childOps.ts): running, stale and rested — a quiet child is unresolved work, and
  // a card that hid it read as "done underneath" while the rail still showed it.
  const children = agents ? visibleChildOps(thread.subAgents ?? [], "card") : []
  if (children.length === 0 && !after) return null
  // A CHILD'S TRANSCRIPT OPENS OVER THE PAGE'S PROJECT (AwaitingSubAgentsCard's openChild, for the same
  // reason): addressed by slug, read through the page's client — so on another project's card the row opens
  // the thread's own drawer instead, one click from the same child in its strip.
  const openChild = (child: { id: string; label: string; subagentType?: string; startedAt?: string }) => {
    const focused = projectSlug() === project.slug && store.board?.projectSlug === project.slug
    if (focused) pushSubAgentDrawer(thread.id, child.id, child)
    else onOpenThread()
  }
  return (
    // The strip's own 2px pitch, nothing around it: the panel (QueueOpsSummary) carries the padding.
    <div className="flex min-w-0 flex-col gap-0.5" data-queue-ops={thread.id}>
      {children.map((agent, i) => (
        <ChildOpRow
          key={agent.id ?? `a${i}`}
          kind={agent.workflow ? "WORKFLOW" : "AGENT"}
          label={subAgentName(agent.label)}
          state={agent.state}
          density="sheet"
          depth={agent.depth}
          startedAt={agent.startedAt}
          parentSlug={thread.id}
          onOpen={agent.id ? () => openChild({ id: agent.id!, label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
          onDismiss={childOpDismisser(thread.id, agent, "AGENT", api)}
          title={agent.phase ? `${agent.phase} › ${agent.label}` : undefined}
        />
      ))}
      {after}
    </div>
  )
}
