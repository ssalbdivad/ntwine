import type { ThreadView } from "@ntwine/shared"
import { hasLiveSubAgents } from "@ntwine/shared"

// A SHORT REPLY STAYS IN THE FOREGROUND (maintainer 2026-11-11). A reply sent from a queue card holds that
// card in place automatically (lib/queueHold.ts `autoHoldInQueue`), the same as `h` does, so a question
// answered in seconds is answered right there instead of the card fading to Working and coming back at
// the bottom of the queue. The hold lets go the moment the turn shows it is LONG WORK, and the card then
// leaves the way any replied-to card does, to come back when the thread rests.
//
// WATCHED, NOT PREDICTED. A model reading the message could guess "quick question" or "long task" in under
// a second, but "why does X fail?" is a twenty-second answer or a twenty-minute investigation, and the
// worker itself does not know which until it starts. What the worker DOES in its first seconds says it:
//   • it edits files, or dispatches a sub-agent or a workflow → work. A quick answer does neither.
//   • anything still running FOREGROUND_MS after the reply → work, whatever it is doing.
// Reads, searches and shell commands are NOT signals on their own: answering a question about the code
// usually starts by reading some (this very feature's design answer ran a grep), so they ride on the
// clock instead.

/** How long a reply's turn may run before it counts as long work, whatever it is doing. */
export const FOREGROUND_MS = 45_000

// Edits and dispatches across the providers: Claude's own tools, and Codex's patch and agent tools.
const WORK_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "Workflow", "apply_patch", "spawn_agent"])

export function isWorkTool(name: string): boolean {
  return WORK_TOOLS.has(name)
}

export type LongTurnReason = "time" | "tool" | "agents"

/**
 * Why a reply's turn is long work, or undefined while it still reads as a short answer. `sentAt` is when
 * the human sent the reply; `toolNames` are the tools the turn has called since that message, when the
 * caller has its transcript. A thread at rest is never long work: what it said is on the card.
 */
export function longTurnReason(
  thread: Pick<ThreadView, "runtime" | "subAgents" | "liveTool">,
  sentAt: number,
  nowMs: number,
  toolNames: readonly string[] = [],
): LongTurnReason | undefined {
  if (thread.runtime !== "running" && thread.runtime !== "spawning") return undefined
  if (hasLiveSubAgents(thread as ThreadView)) return "agents"
  if ((thread.liveTool && isWorkTool(thread.liveTool.name)) || toolNames.some(isWorkTool)) return "tool"
  if (nowMs - sentAt >= FOREGROUND_MS) return "time"
  return undefined
}
