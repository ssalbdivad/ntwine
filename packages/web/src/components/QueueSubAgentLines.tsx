import type { ReturnedSubAgentView, SubAgentView } from "@ntwine/shared"
import type { Api } from "../api/rpc.ts"
import { subAgentName } from "../groups.ts"
import { pushSubAgentDrawer } from "../store.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// A queue handoff should name the work still running beneath the parent without turning it into a
// second operations toolbar. Live AND stale children render here (visibleChildOps "card", unified onto
// the rail's policy — a stale child is unresolved work, not gone, and a card that hid it read as "done
// underneath" while the rail still showed it); background shells/Monitors remain in BackgroundOpsStrip
// below as a separate runtime concern. The row itself is the shared ChildOpRow at "card" density — the
// same component, tokens and glyph the sidebar rail and the drawer's ops strip render. The dispatch's
// model+effort tag was REMOVED from these lines on 2026-07-27 (maintainer): the profile belongs to the
// prompt box's own control one line up, not repeated on every child line. It still rides the drill-in
// so the drawer knows which cell it opened.
//
// It DOES carry the dismiss × (maintainer 2026-07-30 — "the X button to stop a sub-agent should show up
// everywhere sub-agents are listed"). That is not the "second operations toolbar" this comment has
// always warned against: the card names the live work, and retiring a child that finished without
// signalling is the one action that reading provokes. The counters and the profile still stay off the
// card. The kind tag does not, since 2026-10-03: the shell, watcher and File/Link rows that continue this
// column below are tagged, so an untagged agent line here started a tag's width left of all of them —
// and the same child lost its tag every time its thread moved from the drawer to the queue (see
// ChildOpRow).
// Whether this card will actually draw any ⤷ child lines. The card renders these lines and the
// background-ops strip as two SIBLING lists in one visual column, so the strip has to know whether it
// is opening that column or continuing it (the project board's card, TodosView, asked this until
// 2026-09-28; subagent-completion-fixture and operation-indicators-fixture still do) — and it must get
// the same answer this component does. Exported from here, and used by the component itself, so the two cannot drift.
export function hasQueueSubAgentLines(subAgents: readonly SubAgentView[]): boolean {
  return visibleChildOps(subAgents, "card").length > 0
}

/** How a row opens its child. `pushSubAgentDrawer` by default — the child's transcript stacked over its
 *  parent — which reads the PAGE's project; a card drawn for another project's thread passes its own. */
export type OpenQueueSubAgent = (child: { id: string; label: string; subagentType?: string; startedAt?: string }) => void

export function QueueSubAgentLines({
  slug,
  subAgents,
  returned = [],
  api,
  onOpenChild,
  // The ops COLUMN's padding, which is positional and therefore the caller's to set — the same prop
  // BackgroundOpsStrip takes, for the same reason.
  // Default = the column's opening padding with no bottom air, i.e. what a lone fixture wants.
  className = "px-1 pt-1.5",
}: {
  slug: string
  subAgents: readonly SubAgentView[]
  /** The batch's RETURNED half (ThreadView.returnedSubAgents), drawn after the live rows with the mark and
   *  reading of a finished child. Only a queued parent's card passes it (AwaitingSubAgentsCard). */
  returned?: readonly ReturnedSubAgentView[]
  /** The thread's own project's client for the × — `rpc` (the page's project) when absent. */
  api?: Api
  onOpenChild?: OpenQueueSubAgent
  className?: string
}) {
  const visible = visibleChildOps(subAgents, "card")
  if (visible.length === 0 && returned.length === 0) return null
  const open: OpenQueueSubAgent = onOpenChild ?? ((child) => pushSubAgentDrawer(slug, child.id, child))
  return (
    <div data-queue-subagents className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      {visible.map((agent, index) => (
        <ChildOpRow
          key={agent.id ?? `${agent.startedAt}-${index}`}
          kind={agent.workflow ? "WORKFLOW" : "AGENT"}
          label={subAgentName(agent.label)}
          state={agent.state}
          density="card"
          depth={agent.depth}
          startedAt={agent.startedAt}
          // What the child is DOING right now. The counters stay off a handoff card (see ChildOpRow).
          parentSlug={slug}
          onOpen={agent.id ? () => open({ id: agent.id!, label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
          onDismiss={childOpDismisser(slug, agent, "AGENT", api)}
        />
      ))}
      {returned.map((child) => (
        <ChildOpRow
          key={child.id}
          kind="AGENT"
          label={subAgentName(child.label)}
          state="returned"
          outcome={child.status}
          endedAt={child.finishedAt}
          density="card"
          parentSlug={slug}
          // A retired child's transcript stays resolvable for review (the tailer's retained ring), and
          // reading what it came back with is the reason to click it.
          onOpen={() => open({ id: child.id, label: child.label, subagentType: child.subagentType, startedAt: child.startedAt })}
        />
      ))}
    </div>
  )
}
