import {
  inActiveBand,
  inWaitingBand,
  isSnoozed,
  parseAwaitingDurationRaw,
  parseDeadlineInput,
  sectionOf,
  type CompletionHold,
  type OwnWatchView,
  type PrWatchView,
  type RegisteredQuestionView,
  type ThreadDeadlineView,
  type ThreadStats,
  type ThreadView,
  type ThreadWorkingDir,
} from "@ntwine/shared"

export type ThreadBand = "pinned" | "ready" | "working" | "waiting" | "snoozed" | "done"

const BAND_ORDER: readonly ThreadBand[] = ["pinned", "ready", "working", "waiting", "snoozed", "done"]
const BAND_LABELS: Record<ThreadBand, string> = {
  pinned: "Pinned",
  ready: "Ready",
  working: "Working",
  waiting: "Waiting",
  snoozed: "Snoozed",
  done: "Done",
}

export type ThreadListEntry = {
  handle: string
  slug: string
  title?: string
  projectSlug: string
  projectName: string
  band: ThreadBand
  kind: "session" | "terminal"
  held?: boolean
  status?: string
  model?: string
  effort?: string
  doneCard?: boolean
  openQuestions: number
  liveSubAgents: number
  liveBgShells: number
  snoozedUntil?: string
}

export type FormatThreadListInput = {
  entries: readonly ThreadListEntry[]
  multiProject: boolean
  includeDone: boolean
  query?: string
}

export type ThreadInfoInput = {
  handle: string
  slug: string
  projectName: string
  projectSlug: string
  thread: ThreadView
  band: ThreadBand
  backend?: string
  model?: string
  effort?: string
  permissionMode?: string
  snoozedUntil?: string | null
  snoozePrompt?: string | null
  deadline?: ThreadDeadlineView | null
  goal?: { prompt: string; stopHook: boolean; heartbeat: boolean; postCompaction: boolean; intervalSeconds?: number } | null
  openQuestions: readonly RegisteredQuestionView[]
  watches: readonly OwnWatchView[]
  prWatches: readonly PrWatchView[]
  timers: readonly { id: string; fireAt: string; prompt: string }[]
  commandWatches: readonly { id: string; command: string; every: string; expiresAt: string }[]
  liveTerminals: readonly { id: string; handle?: string; command: string }[]
  workingDir?: ThreadWorkingDir
  stats?: ThreadStats
}

/** The board band a thread belongs to — matches the six-band sidebar model in AGENTS.md. */
export function threadBandOf(thread: ThreadView, nowMs = Date.now()): ThreadBand {
  if (thread.pinnedAt) return "pinned"
  if (sectionOf(thread) === "inactive") return "done"
  if (isSnoozed(thread, nowMs)) return "snoozed"
  if (inWaitingBand(thread, nowMs)) return "waiting"
  if (inActiveBand(thread)) return "working"
  return "ready"
}

/** Parse a duration string like `30m`, `2h`, `1h 30m`, `3d` into milliseconds. */
export function parseControlDurationMs(raw: string, nowMs = Date.now()): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const awaiting = parseAwaitingDurationRaw(trimmed)
  if (awaiting != null) return awaiting
  const parsed = parseDeadlineInput(trimmed, nowMs)
  if (parsed.ok && parsed.kind === "duration") return Math.max(0, parsed.atMs - nowMs)
  return undefined
}

/** Human- and worker-readable refusal explaining why `thread done` held back without `--force`. */
export function formatCompletionHold(handle: string, hold: CompletionHold): string {
  const reasons: string[] = []
  if (hold.unreadMessage) reasons.push("has an unread message just sent to it")
  else if (hold.cutOff) reasons.push("was cut off mid-turn and did not finish cleanly")
  else if (hold.turnInFlight) reasons.push("has a turn currently running")
  else if (hold.unobservable) reasons.push("has a live worker whose turn state cannot be observed")

  if (hold.subAgentCount > 0) {
    const names = hold.subAgents.map((a) => a.label).join(", ")
    const extra = hold.subAgentCount > hold.subAgents.length ? ` (+${hold.subAgentCount - hold.subAgents.length} more)` : ""
    reasons.push(`${hold.subAgentCount} running sub-agent${hold.subAgentCount === 1 ? "" : "s"}${names ? `: ${names}${extra}` : ""}`)
  }
  if (hold.bgShellCount > 0) {
    const names = hold.bgShells.map((s) => s.label).join(", ")
    const extra = hold.bgShellCount > hold.bgShells.length ? ` (+${hold.bgShellCount - hold.bgShells.length} more)` : ""
    reasons.push(`${hold.bgShellCount} running background shell${hold.bgShellCount === 1 ? "" : "s"}${names ? `: ${names}${extra}` : ""}`)
  }
  if (hold.terminalCount && hold.terminalCount > 0) {
    const names = (hold.terminals ?? []).map((t) => t.label).join(", ")
    reasons.push(`${hold.terminalCount} running terminal${hold.terminalCount === 1 ? "" : "s"}${names ? `: ${names}` : ""}`)
  }

  const detail = reasons.length ? reasons.join("; ") : "has active work in flight"
  const terminalHint = hold.terminalCount && hold.terminalCount > 0 ? " (add `--stop-terminals` to stop its running terminals too)" : ""
  return `NOT marked done — @${handle} ${detail}. Pass \`--force\` to stop it and mark it done anyway${terminalHint}.`
}

export function formatThreadList({ entries, multiProject, includeDone, query }: FormatThreadListInput): string {
  if (entries.length === 0) {
    const scope = multiProject ? "across open projects" : "in this project"
    const suffix = query ? ` matching "${query}"` : ""
    return `No ${includeDone ? "" : "open "}threads ${scope}${suffix}.`
  }
  const sections: string[] = []
  for (const band of BAND_ORDER) {
    const rows = entries.filter((e) => e.band === band)
    if (rows.length === 0) continue
    const lines = rows.map((r) => {
      const tags: string[] = []
      if (multiProject) tags.push(`#${r.projectSlug}`)
      if (r.kind === "terminal") tags.push("terminal")
      if (r.held) tags.push("to-do")
      if (r.doneCard && r.band !== "done") tags.push("done card")
      if (r.openQuestions > 0) tags.push(`${r.openQuestions} open question${r.openQuestions === 1 ? "" : "s"}`)
      if (r.liveSubAgents > 0) tags.push(`${r.liveSubAgents} sub-agent${r.liveSubAgents === 1 ? "" : "s"}`)
      if (r.liveBgShells > 0) tags.push(`${r.liveBgShells} shell${r.liveBgShells === 1 ? "" : "s"}`)
      if (r.snoozedUntil) tags.push(`until ${r.snoozedUntil}`)
      if (r.model) tags.push(r.effort ? `${r.model}/${r.effort}` : r.model)
      const meta = tags.length ? ` [${tags.join(" · ")}]` : ""
      const status = r.status ? ` — ${r.status}` : ""
      return `  @${r.handle}${meta}${status}`
    })
    sections.push(`${BAND_LABELS[band]} (${rows.length})\n${lines.join("\n")}`)
  }
  return sections.join("\n\n")
}

export function formatThreadInfo(info: ThreadInfoInput): string {
  const { thread } = info
  const lines: string[] = [
    `@${info.handle} (${info.slug}) — #${info.projectSlug} (${info.projectName})`,
    `Band: ${BAND_LABELS[info.band]} · State: ${thread.state} · Kind: ${thread.kind}${thread.held ? " (held / not started)" : ""}`,
  ]
  if (thread.title && thread.title !== info.handle) lines.push(`Title: ${thread.title}`)
  if (thread.status) lines.push(`Status: ${thread.status}`)
  if (info.backend || info.model || info.effort) {
    const profile = [info.backend, info.model, info.effort].filter(Boolean).join(" · ")
    lines.push(`Profile: ${profile}`)
  }
  if (info.permissionMode) lines.push(`Permission: ${info.permissionMode}`)
  if (thread.pinnedAt) lines.push(`Pinned: since ${thread.pinnedAt}`)
  if (info.snoozedUntil) {
    lines.push(`Snoozed until: ${info.snoozedUntil}${info.snoozePrompt ? ` (follow-up: ${info.snoozePrompt})` : ""}`)
  }
  if (info.deadline) {
    lines.push(`Deadline: ${info.deadline.at} (set by ${info.deadline.setBy})`)
  }
  if (info.workingDir) {
    lines.push(`Checkout: ${info.workingDir.dir} (${info.workingDir.kind})`)
  }
  if (info.goal) {
    const triggers = [
      info.goal.stopHook ? "stop-hook" : null,
      info.goal.heartbeat ? `heartbeat ${info.goal.intervalSeconds ?? 0}s` : null,
      info.goal.postCompaction ? "post-compaction" : null,
    ].filter(Boolean)
    lines.push(`Goal (${triggers.join(", ") || "paused"}): ${info.goal.prompt.replace(/\s+/g, " ").slice(0, 160)}`)
  }
  if (thread.terminal) {
    const t = thread.terminal
    lines.push(`Terminal: \`${t.command}\` in ${t.cwd} (${t.state}, controller: ${t.controller ?? "human"})`)
  }
  const liveAgents = (thread.subAgents ?? []).filter((a) => a.state === "running")
  if (liveAgents.length > 0) {
    lines.push("", `Live sub-agents (${liveAgents.length}):`)
    for (const a of liveAgents) lines.push(`  ${a.id}  ${a.label}`)
  }
  const liveShells = (thread.bgShells ?? []).filter((s) => s.state === "running")
  if (liveShells.length > 0) {
    lines.push("", `Live background shells (${liveShells.length}):`)
    for (const s of liveShells) lines.push(`  ${s.id}  ${s.label}`)
  }
  if (info.liveTerminals.length > 0) {
    lines.push("", `Running terminals (${info.liveTerminals.length}):`)
    for (const t of info.liveTerminals) lines.push(`  ${t.handle ? `@${t.handle}` : t.id} (${t.id})  \`${t.command}\``)
  }
  if (info.openQuestions.length > 0) {
    lines.push("", `Open questions (${info.openQuestions.length}):`)
    for (const q of info.openQuestions) {
      const opts = q.spec.options?.map((o) => o.label).join(" | ")
      const meta = [q.spec.kind, q.spec.danger ? "danger" : null, q.passedOver ? "typed past" : null].filter(Boolean).join(", ")
      lines.push(`  ${q.id}  [${meta}]  ${q.spec.question.split("\n")[0]}${opts ? `\n    Options: ${opts}` : ""}`)
    }
  }
  if (info.watches.length > 0) {
    lines.push("", `Armed watches (${info.watches.length}):`)
    for (const w of info.watches) lines.push(`  ${w.id}  ${w.kind}: ${w.label ?? w.target} (expires ${w.expiresAt})`)
  }
  if (info.prWatches.length > 0) {
    lines.push("", `PR watches (${info.prWatches.length}):`)
    for (const w of info.prWatches) lines.push(`  ${w.id}  ${w.target}`)
  }
  if (info.timers.length > 0) {
    lines.push("", `Armed timers (${info.timers.length}):`)
    for (const t of info.timers) lines.push(`  ${t.id}  fires ${t.fireAt} — ${t.prompt.replace(/\s+/g, " ").slice(0, 80)}`)
  }
  if (info.commandWatches.length > 0) {
    lines.push("", `Command watches (${info.commandWatches.length}):`)
    for (const w of info.commandWatches) lines.push(`  ${w.id}  every ${w.every} until ${w.expiresAt} — ${w.command}`)
  }
  if (info.stats && info.stats.recorded) {
    const t = info.stats.tokens
    const total = t.input + t.output + t.cacheRead + t.cacheWrite
    const cost = info.stats.cost !== undefined ? `$${info.stats.cost.usd.toFixed(4)}` : undefined
    const bits = [
      `${info.stats.turns} turn${info.stats.turns === 1 ? "" : "s"}`,
      `${total.toLocaleString()} tokens`,
      cost,
    ].filter(Boolean)
    lines.push("", `Usage: ${bits.join(" · ")}`)
  }
  return lines.join("\n")
}
