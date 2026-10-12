import type { BgShellView, ThreadView } from "@frizz/shared"
import { visibleChildOps, type TranscriptShellRecord } from "./childOps.ts"
import { cardProcesses } from "./threadProcesses.ts"

export type QueueOpsKind = "agent" | "workflow" | "terminal" | "pr" | "issue" | "file" | "link"

export interface QueueOpsCount {
  readonly key: QueueOpsKind
  readonly n: number
  readonly one: string
  readonly many: string
  // The states of the rows behind the count, which pick its liveness mark. A parked watcher IS live —
  // its row is always `running` (BackgroundOpsStrip) — so a PR or issue count reads as running. A
  // terminal waiting at a prompt is live work too, so it reads as running.
  readonly states: readonly (string | undefined)[]
}

// The counts on the line above a thread's prompt box — the queue card's docked one and the drawer's
// (QueueOpsSummary) — in display order, with the empty kinds dropped. Taken from the same lists the rows
// in its panel render, by the same filters, so the line and the panel cannot disagree about how many
// there are. `transcriptShells` are the shells read off the transcript, whose Codex background execs the
// board reports none of (see mergeBackgroundShells); both surfaces pass them, to the panel too.
//
// THE FORK'S ROWS, NOT UPSTREAM'S. Upstream counted `agents` and `shells` (the board's bgShells) because
// its panel drew QueueSubAgentLines and BackgroundOpsStrip. The cross-project card's panel draws the rows
// its ops column drew under the reply box until 2026-10-06: AGENT and WORKFLOW rows (QueueChildOps), then
// every live process on the thread — the agent's shells and the human's own terminals, one TERM row each
// (ThreadTerminals cardProcesses). So the counts are agents, workflows and terminals, then the PR/issue
// watches and saved files and links upstream's panel added.
//
// `agents: false` while the card's awaiting card lists the children itself (drawsSubAgentWaitCard): the
// panel draws no AGENT rows then, so the line counts none.
//
// ONLY GITHUB WATCHES COUNT. A shell watch is not a second object: the shell it waits on is already a
// terminal, from the board's own shell list, and counting the watch too would name one process twice — the
// double-naming the lifecycle footer's watcher readout was removed for (2026-08-14).
export function queueOpsCounts(
  thread: ThreadView,
  { agents: withAgents = true, now = Date.now(), transcriptShells = [] }: { agents?: boolean; now?: number; transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[] } = {},
): QueueOpsCount[] {
  const children = withAgents ? visibleChildOps(thread.subAgents ?? [], "card") : []
  const agents = children.filter((child) => !child.workflow)
  const workflows = children.filter((child) => child.workflow)
  const processes = cardProcesses(thread, now, transcriptShells)
  const watches = (thread.watches ?? []).filter((watch) => watch.kind === "github")
  const prs = watches.filter((watch) => watch.subject !== "issue")
  const issues = watches.filter((watch) => watch.subject === "issue")
  const links = thread.links ?? []
  const files = links.filter((link) => link.kind === "file")
  const urls = links.filter((link) => link.kind === "link")
  const counts: QueueOpsCount[] = [
    { key: "agent", n: agents.length, one: "agent", many: "agents", states: agents.map((agent) => agent.state) },
    { key: "workflow", n: workflows.length, one: "workflow", many: "workflows", states: workflows.map((flow) => flow.state) },
    { key: "terminal", n: processes.length, one: "terminal", many: "terminals", states: processes.map((p) => (p.state === "prompt" ? "running" : p.state === "quiet" ? "stale" : p.state)) },
    { key: "pr", n: prs.length, one: "PR", many: "PRs", states: ["running"] },
    { key: "issue", n: issues.length, one: "issue", many: "issues", states: ["running"] },
    { key: "file", n: files.length, one: "file", many: "files", states: [] },
    { key: "link", n: urls.length, one: "link", many: "links", states: [] },
  ]
  return counts.filter((count) => count.n > 0)
}
