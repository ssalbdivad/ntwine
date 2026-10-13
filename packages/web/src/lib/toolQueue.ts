// A TOOL CALL THAT IS WAITING ITS TURN IS NOT RUNNING.
//
// Claude Code runs the tool calls of ONE assistant message in BATCHES: a run of consecutive
// concurrency-safe calls runs together, every other call runs alone, and each batch starts only once the
// batch before it has returned. So a TaskStop issued in the same message as a foreground `nub run
// typecheck && nub --test …` sat queued for 6m 24s and then took 0.9s (session fe5967ef, 2026-10-02) —
// while its card, timed from the message's own timestamp like every card in it, read "RUNNING · 4m 56s"
// and the human asked what TaskStop was doing for five minutes. Its finished card then read "done ·
// 6m 24s" for a sub-second stop.
//
// The batch rule is Claude Code's own, read out of the shipped binary (claude-agent-sdk 0.3.282, each
// tool's `isConcurrencySafe`): TRUE for Read, Grep, Glob, WebFetch, Monitor, Agent and TaskStop; TRUE for
// Bash only when its command is read-only, and for an MCP tool only with `readOnlyHint` (Ntwine's own MCP
// tools carry no annotations, so they run serially); FALSE — the default — for everything else (Edit,
// Write, Skill, SendMessage, Workflow, ToolSearch…). WebSearch is not in that read; it is treated as safe
// because transcripts show it finishing before an earlier WebFetch.
//
// Two things the browser cannot know exactly, and which way each errs:
// - Whether a Bash command is read-only. Claude decides with its own parser; here a short allowlist of
//   read-only programs stands in, and anything it does not recognise counts as NOT safe. A read-only
//   command it misses can show a later pending call as queued while it really runs beside it — only for
//   as long as both are pending, which for two read-only commands is moments.
// - Whether a pending call has already RETURNED. A detached Bash (`backgroundState`), an Agent, a Workflow
//   and a Monitor all stay "pending" on their card long after their tool_result came back, so none of them
//   is taken to hold up the calls after it. A FOREGROUND Agent does hold them; missing that leaves a card
//   reading "running" exactly as it did before this rule existed, never a false "queued".
//
// Claude only. Codex runs a turn's parallel calls concurrently and maps its exec calls to "Bash" too, so
// this rule would mislabel them; the caller gates on the thread's backend.

export type QueueTool = {
  name: string
  status?: "pending" | "completed" | "failed" | "cancelled"
  backgroundState?: "background" | "unknown"
  shellId?: string
  agentId?: string
  command?: string
  durationMs?: number
}

export type ToolSlot = {
  /** Pending, and an earlier batch in the same message has not returned: it has not started. */
  queued?: true
  /** How long it waited for the batches before it, once they have all returned — subtract it from the
   *  call's own `durationMs`, and add it to the message timestamp to get when the call actually began. */
  waitedMs?: number
}

const SAFE_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Monitor", "Agent", "TaskStop", "TaskOutput", "BashOutput", "KillShell", "LS", "NotebookRead"])

// Programs that only read. The whole command must be built from these (joined by `&&`, `||`, `;` or `|`)
// with no output redirection, or it is not taken as read-only.
const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "find", "wc", "pwd", "echo", "printf", "which", "file", "stat", "du", "df", "tree", "sort", "uniq", "cut", "diff", "date", "true", "basename", "dirname", "realpath", "readlink"])
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "remote", "describe", "shortlog", "grep"])

export function isReadOnlyCommand(command: string | undefined): boolean {
  if (!command?.trim()) return false
  if (/[<>`]|\$\(/.test(command)) return false
  return command.split(/&&|\|\||[;|\n]/).every((segment) => {
    const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    if (words.length === 0) return true
    const [program, sub] = words
    if (program === "git") return sub !== undefined && READ_ONLY_GIT.has(sub)
    if (program === "cd") return true
    return READ_ONLY_PROGRAMS.has(program)
  })
}

function concurrencySafe(tool: QueueTool): boolean {
  if (tool.name === "Bash") return isReadOnlyCommand(tool.command)
  return SAFE_TOOLS.has(tool.name)
}

/** Still holding up the batches after it: pending, and its tool_result has not come back. */
function holding(tool: QueueTool): boolean {
  if (tool.status !== "pending") return false
  if (tool.backgroundState || tool.shellId) return false
  if (tool.agentId || tool.name === "Agent" || tool.name === "Workflow" || tool.name === "Monitor") return false
  return true
}

/** One slot per call, in the order the model issued them in ONE assistant message. */
export function toolSchedule(tools: readonly QueueTool[]): ToolSlot[] {
  const batchOf: number[] = []
  let batch = -1
  let previousSafe = false
  for (const tool of tools) {
    const safe = concurrencySafe(tool)
    if (!(safe && previousSafe)) batch++
    batchOf.push(batch)
    previousSafe = safe
  }
  return tools.map((tool, i) => {
    const earlier = tools.filter((_, j) => batchOf[j] < batchOf[i])
    if (earlier.length === 0) return {}
    if (earlier.some(holding)) return tool.status === "pending" ? { queued: true } : {}
    // Every earlier batch has returned. Its calls were issued together with this one, so the latest of
    // their durations is when this call's batch began. A returned call with no duration (a detached
    // launch's ack) came back at once and moves nothing.
    const waitedMs = Math.max(0, ...earlier.filter((t) => !holding(t) && t.status !== "pending").map((t) => t.durationMs ?? 0))
    return waitedMs > 0 ? { waitedMs } : {}
  })
}
