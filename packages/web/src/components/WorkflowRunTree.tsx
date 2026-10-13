import type { ReactElement } from "react"
import { Check, X } from "lucide-react"
import type { WorkflowAgentView } from "@ntwine/shared"
import { subAgentName } from "../groups.ts"
import { pushSubAgentDrawer } from "../store.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CHILD_STALE_DOT_CLASS, CHILD_STALE_TITLE } from "../lib/childOps.ts"

// THE BODY OF A WORKFLOW's DRAWER. A `Workflow` run is one tool call that fans out a phased tree of
// agents, so its drawer is that tree rather than a transcript: the run's phases in script order, each
// agent it has started beneath its phase, finished ones included — the point of opening a run is
// usually to read what one of its agents did. Every row drills into that agent's own transcript,
// stacking a sub-agent drawer over this one, so the hierarchy reads thread → run → agent.
//
// The marks speak the child-row vocabulary (lib/childOps.ts): the pulsing agent dot for running, the
// flat stale dot for quiet-but-tracked. A finished agent gets a check here, unlike the live strips —
// those only ever list live work, where "no mark" is the finished reading; this list mixes both, so
// finished has to be said.
export function WorkflowRunTree({ slug, agents }: { slug: string; agents: readonly WorkflowAgentView[] }): ReactElement {
  const now = useNowMs()
  if (agents.length === 0) {
    return <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">No agents started yet.</div>
  }
  // Phases in the order the run first reached them; an agent() call with no phase gathers under none.
  const phases: Array<{ name: string | undefined; agents: WorkflowAgentView[] }> = []
  for (const agent of agents) {
    const group = phases.find((p) => p.name === agent.phase)
    if (group) group.agents.push(agent)
    else phases.push({ name: agent.phase, agents: [agent] })
  }
  const running = agents.filter((a) => a.state === "running").length
  const failed = agents.filter((a) => a.state === "failed").length
  const summary = [`${agents.length} ${agents.length === 1 ? "agent" : "agents"}`, running > 0 ? `${running} running` : undefined, failed > 0 ? `${failed} failed` : undefined].filter(Boolean).join(" · ")

  return (
    <div data-workflow-run className="flex flex-col gap-4 px-6 py-5">
      <div className="text-[12px] text-muted-70">{summary}</div>
      {phases.map((phase, i) => {
        const done = phase.agents.filter((a) => a.state === "done").length
        return (
          <section key={phase.name ?? `__none-${i}`} data-workflow-phase={phase.name ?? ""} className="flex flex-col gap-0.5">
            {phase.name !== undefined && (
              <header className="flex items-baseline gap-2 pb-1 text-[12px]">
                <span className="font-medium text-fg/85">{phase.name}</span>
                <span className="text-muted-45">{done}/{phase.agents.length} done</span>
              </header>
            )}
            {phase.agents.map((agent) => (
              <WorkflowAgentRow key={agent.id} slug={slug} agent={agent} now={now} />
            ))}
          </section>
        )
      })}
    </div>
  )
}

function WorkflowAgentRow({ slug, agent, now }: { slug: string; agent: WorkflowAgentView; now: number }): ReactElement {
  const live = agent.state === "running" || agent.state === "stale"
  const elapsed = live ? compactElapsedSince(agent.startedAt, now) : undefined
  // Each mark is lifted onto the label's CAP BAND by its own measured amount (sans, 13px labels, ink
  // centre vs cap-band centre, 2026-09-29): the dots and the ✕ read 0.78px low, the check 0.53px low.
  // In `em` so the lift tracks the row's font size. Re-measure rather than re-guess if the row changes.
  const mark =
    agent.state === "running" ? <span aria-hidden className="ntwine-live-dot ntwine-live-dot--agent -translate-y-[0.06em]" data-running-indicator="workflow-agent" />
    : agent.state === "stale" ? <span className={`${CHILD_STALE_DOT_CLASS} -translate-y-[0.06em]`} title={CHILD_STALE_TITLE} />
    : agent.state === "failed" ? <X aria-label="failed" className="h-3 w-3 shrink-0 -translate-y-[0.06em] text-danger-soft" strokeWidth={2.25} />
    : <Check aria-label="done" className="h-3 w-3 shrink-0 -translate-y-[0.04em] text-muted-45" strokeWidth={2.25} />
  return (
    <button
      type="button"
      data-workflow-agent={agent.id}
      onClick={() => pushSubAgentDrawer(slug, agent.id, { label: agent.label, startedAt: agent.startedAt })}
      title="Open agent transcript"
      className="group -mx-2 flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left text-[13px] outline-none transition-colors hover:bg-panel-2/60 focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60"
    >
      <span className="flex w-3 shrink-0 items-center justify-center">{mark}</span>
      <span className={`min-w-0 truncate ${live ? "text-fg/85" : "text-muted-70"} group-hover:text-fg group-hover:underline`}>{subAgentName(agent.label)}</span>
      {elapsed && <span className="ml-auto shrink-0 pl-2 text-[12px] text-muted-40" title={`Working for ${elapsed}`}>{elapsed}</span>}
    </button>
  )
}
