// A SCRIPTED Claude provider: it produces exactly the two artifacts a real broker-backed session
// produces — records appended to the session JSONL on disk, and typed events delivered over the
// broker socket — from a hand-written script, with no `claude` process anywhere.
//
// Ported in substance from t3code's apps/server/integration/TestProviderAdapter.integration.ts (a
// 577-line fake provider you queue canned canonical events into). The ntwine-specific difference is
// that an ntwine session has TWO surfaces, not one: the disk transcript the tailer folds, and the event
// stream the ingest consumes. A fake that drove only one of them would be testing half the seam —
// and the seam is the entire point, because the interesting failures are ORDERING failures between
// the two. So a script is a list of steps, and the harness can interleave them freely:
//
//   turn(
//     record(userRecord("go")),
//     event(assistantEvent("working…")),   // the SDK is ahead of the file
//     record(assistantRecord("working…", "tool_use")),
//     ...
//   )
//
// `eventFirst()` in particular exists so the dangerous ordering — the SDK reporting a turn finished
// before its final assistant record reaches disk — can be asserted deliberately rather than hoped
// against.
import { appendFileSync, writeFileSync } from "node:fs"
import type { ClaudeQueryEvent } from "../backend/claude-agent-sdk-protocol.ts"

export type ScriptStep =
  | { kind: "record"; record: Record<string, unknown> }
  | { kind: "event"; event: ClaudeQueryEvent }

export const record = (r: Record<string, unknown>): ScriptStep => ({ kind: "record", record: r })
export const event = (e: ClaudeQueryEvent): ScriptStep => ({ kind: "event", event: e })

// ---- record builders (the shapes the real Claude CLI writes; see tailer.ts's corpus notes) ----

export function userRecord(text: string, at: string): Record<string, unknown> {
  return { type: "user", timestamp: at, message: { role: "user", content: text } }
}

/** `stop_reason` is the tailer's definitive turn signal — "end_turn" idle, "tool_use" in-flight,
 *  anything else (or absent) is the 5s-backstop guess this whole spike exists to short-circuit. */
export function assistantRecord(
  text: string,
  stopReason: "end_turn" | "tool_use" | undefined,
  at: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: at,
    message: { stop_reason: stopReason, content: [{ type: "text", text }] },
  }
}

// ---- event builders (the ClaudeQueryEvent shapes the broker relays) ----

// `parentToolUseId` is what distinguishes the MAIN thread's events from a live CHILD's. A background
// child streams these for its whole life, long after the parent's own turn has ended, so the two must
// be scriptable apart — see the resting-parent case in claude-runtime.integration.test.ts.
export function assistantEvent(text: string, sessionId: string, parentToolUseId?: string): ClaudeQueryEvent {
  return { kind: "assistant", sessionId, messageId: `m-${text.length}`, parentToolUseId, text: [text], toolUses: [], supersedes: [] }
}

export function userEvent(text: string, sessionId: string, parentToolUseId?: string): ClaudeQueryEvent {
  return { kind: "user", sessionId, messageId: "u", parentToolUseId, text: [text], toolResultIds: [], synthetic: false }
}

export function resultEvent(sessionId: string, isError = false): ClaudeQueryEvent {
  return { kind: "result", sessionId, messageId: "r", subtype: isError ? "error_during_execution" : "success", isError, errors: [] }
}

// ---- record builders for a BACKGROUND SUB-AGENT, in the prose shapes the tailer folds ----
// These are the three records the regex path depends on. They stay in the harness because the whole
// point of the structured task stream is that it must coexist with them, not replace them: a pre-broker
// thread has only these, and a broker thread has both.

/** The `Agent` tool_use that registers a live child, keyed by its tool_use id. */
export function agentDispatchRecord(toolUseId: string, description: string, at: string, subagentType = "ntwine:opus-high"): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: at,
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id: toolUseId, input: { description, run_in_background: true, subagent_type: subagentType } }] },
  }
}

/** The launch ack whose ENGLISH PROSE the fold parses for the child's output path. */
export function agentLaunchRecord(toolUseId: string, outputFile: string, at: string, agentId = "agent-1"): Record<string, unknown> {
  return {
    type: "user",
    timestamp: at,
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputFile}\nDo not read this file.` }] }] },
  }
}

/**
 * The `SendMessage` that RESTARTS a stopped child, and its ack. Unlike every other builder here the ack
 * is structured JSON, not prose: `resumedAgentId` is the field that distinguishes a restart from an
 * ordinary delivery to a still-live child. The restarted run keeps the child's runtime id and gets a
 * NEW tool_use id — which is why the two must be scripted together.
 */
export function agentResumeRecords(sendToolUseId: string, agentId: string, outputFile: string, at: string): Record<string, unknown>[] {
  const ack = JSON.stringify({
    success: true,
    message: `Agent "${agentId}" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile}`,
    resumedAgentId: agentId,
  })
  return [
    { type: "assistant", timestamp: at, message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "SendMessage", id: sendToolUseId, input: { to: agentId, summary: "carry on" } }] } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: sendToolUseId, content: [{ type: "text", text: ack }] }] } },
  ]
}

/** The prose completion notification — the fallback terminal signal, and the one that can go missing. */
export function taskNotificationRecord(toolUseId: string, status: string, at: string): Record<string, unknown> {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at,
    content: `<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
  }
}

// ---- event builders for the STRUCTURED task lifecycle (stream-only; never on disk) ----

export function taskEvent(sessionId: string, over: Partial<Extract<ClaudeQueryEvent, { kind: "task" }>>): ClaudeQueryEvent {
  return { kind: "task", phase: "progress", sessionId, ...over } as ClaudeQueryEvent
}

export interface ScriptedClaudeSession {
  /** Play the steps in order: records land on disk, events go to the ingest. */
  play(...steps: ScriptStep[]): void
  /** Every record written so far, for a "what did the fold actually see" failure message. */
  written(): readonly Record<string, unknown>[]
}

export interface ScriptedClaudeOptions {
  transcriptPath: string
  onEvent: (event: ClaudeQueryEvent) => void
}

export function createScriptedClaudeSession(options: ScriptedClaudeOptions): ScriptedClaudeSession {
  const wrote: Record<string, unknown>[] = []
  writeFileSync(options.transcriptPath, "") // the SDK creates the file at session start
  return {
    play(...steps) {
      for (const step of steps) {
        if (step.kind === "record") {
          appendFileSync(options.transcriptPath, JSON.stringify(step.record) + "\n")
          wrote.push(step.record)
        } else {
          options.onEvent(step.event)
        }
      }
    },
    written: () => wrote,
  }
}
