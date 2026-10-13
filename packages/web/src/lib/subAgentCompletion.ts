import type { TranscriptToolCall } from "@ntwine/shared"
import { formatFixedDuration } from "./durationLabels.ts"

// A SUB-AGENT COMPLETION is transcript PUNCTUATION, not a tool call.
//
// The server re-emits a finished child's dispatch call as its own standalone message at the position
// the completion <task-notification> landed, flagged `agentCompletion` (see shared TranscriptToolCall
// and server transcript.ts completionEvents). That copy used to render as a second AgentBlock card,
// byte-identical to the launch card up-thread and indistinguishable from every other card around it.
// The maintainer's ruling (2026-07-27): "a background shell coming to rest or terminating renders in a
// totally different way from an agent finishing … converge on the format … we use currently for
// background shells resting, because it's more visually distinct in a big sea of tool call blocks."
//
// So it now draws the SAME centred wake divider a background shell's completion draws. This module
// holds the two decisions that rendering rests on — which messages are markers, and what the label
// says — because both are asserted by unit tests that must not import the whole ChatView tree (which
// pulls a stylesheet through the diff renderer and cannot load under the node test runner).

// The minimum message shape this decision reads. Structural on purpose: hooks' ChatMessage carries a
// stylesheet-importing dependency chain, and this predicate needs none of it.
export interface CompletionMessageLike {
  role: "user" | "assistant"
  text: string
  kind?: "event" | "reasoning"
  tools?: readonly TranscriptToolCall[]
  parts?: readonly ({ kind: "text"; text: string } | { kind: "tools"; tools: readonly TranscriptToolCall[] })[]
}

// The marker call, when this message is NOTHING BUT that marker. The guards are load-bearing, not
// defensive noise: the back-filled LAUNCH card carries the identical agentStatus/agentElapsedMs, and a
// silent single-Task assistant record has the identical message shape — only the server-set flag tells
// the two apart, and only a lone flagged call in a text-less message is the marker.
export function agentCompletionCall(m: CompletionMessageLike): TranscriptToolCall | undefined {
  if (m.kind !== undefined || m.role !== "assistant" || m.text.trim()) return undefined
  const parts = m.parts ?? []
  // Both transports: the block-ordered `parts` walk, and the legacy flat `tools` array.
  const tools = parts.length > 0 ? (parts.length === 1 && parts[0].kind === "tools" ? parts[0].tools : []) : (m.tools ?? [])
  const only = tools.length === 1 ? tools[0] : undefined
  return only?.agentCompletion ? only : undefined
}

// THE OUTCOME VOCABULARY — the ONE place a raw `agentStatus` becomes a word a reader sees. It mirrors
// the background-shell wake label (finished / stopped / failed — see server transcript.ts
// backgroundWakeLabel) so every surface that reports a finished child reads as one family.
//
// "killed" is deliberately NOT that word. It is the harness's process-level enum, and the event it
// names is almost always a deliberate stop (the operator interrupted the child, or it timed out) —
// which is why the server files a killed dispatch under the tool status "cancelled", not "failed"
// (transcript.ts). This map exists because the AgentBlock header duplicated the ternary and drifted:
// it shipped a blood-red "killed 10m" beside its neighbours' quiet "done · 9 ms" (maintainer
// 2026-07-29: "this is way too scary looking"). One source, so it cannot drift again.
export const AGENT_OUTCOME_VERB: Record<NonNullable<TranscriptToolCall["agentStatus"]>, string> = {
  completed: "finished",
  killed: "stopped",
  failed: "failed",
}

// The divider's label parts. A marker with no status degrades to the neutral "finished" rather than
// inventing an outcome. The duration is the dispatch→completion elapsed, in the same coarse form the
// AgentBlock header uses ("<1m", "42m", "1h 3m").
export function subAgentCompletionOutcome(call: Pick<TranscriptToolCall, "agentStatus" | "agentElapsedMs">): { outcome: string; tail: string } {
  const outcome = AGENT_OUTCOME_VERB[call.agentStatus ?? "completed"]
  const duration = call.agentElapsedMs !== undefined ? formatFixedDuration(call.agentElapsedMs) : undefined
  return { outcome, tail: `${outcome}${duration ? ` · ${duration}` : ""}` }
}
