import { readFileSync } from "node:fs"
import type { TranscriptMessage, TranscriptToolCall } from "@ntwine/shared"

// The drill-in drawer's reading of an Antigravity (`agy`) conversation's own compact transcript —
// `<agyHome>/brain/<conv>/.system_generated/logs/transcript.jsonl`, one step per line. ntwine's own agy
// THREADS never need this (their transcript is the ACP stream ntwine writes itself, acp-transcript.ts);
// it exists for an agy native SWARM member (agy-swarm.ts), whose conversation never crosses ntwine's pipe.
//
// The step schema (agy 1.5.11, profiled over every transcript on this machine): `type` is
//   USER_INPUT        — what the human typed
//   SYSTEM_MESSAGE    — input agy injected: a swarm worker's assignment, a board-post wake
//   PLANNER_RESPONSE  — one model step: `content` (its words), `tool_calls` [{name, args}]
//   GENERIC           — one tool result, in call order after its planner step; `status` DONE / ERROR /
//                       RUNNING (sent to the background) / INVALID
//   CHECKPOINT        — a context checkpoint; nothing to show
// Every `args` value is itself JSON-encoded (`"CommandLine": "\"git status\""`), so values are decoded
// before they are shown.

const TOOL_TEXT_MAX = 4_000
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

type Step = {
  step_index?: unknown
  type?: unknown
  status?: unknown
  created_at?: unknown
  content?: unknown
  error?: unknown
  tool_calls?: unknown
}

const asText = (v: unknown): string => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "")

function decodeArg(v: unknown): unknown {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v) as unknown
  } catch {
    return v
  }
}

// The one argument that names what a call acts on, in the order a reader looks for it.
const DETAIL_KEYS = ["CommandLine", "AbsolutePath", "Path", "TargetFile", "File", "Url", "URL", "Query", "SearchPath", "DirectoryPath", "name", "action"]

function toolCallFor(raw: unknown): TranscriptToolCall {
  const call = raw && typeof raw === "object" ? (raw as { name?: unknown; args?: unknown }) : {}
  const name = typeof call.name === "string" && call.name ? call.name : "tool"
  const args: { [key: string]: unknown } = {}
  if (call.args && typeof call.args === "object") {
    for (const [key, value] of Object.entries(call.args as { [key: string]: unknown })) args[key] = decodeArg(value)
  }
  const out: TranscriptToolCall = { name, status: "pending" }
  const summary = typeof args.toolSummary === "string" ? args.toolSummary.trim() : ""
  const detailKey = DETAIL_KEYS.find((key) => typeof args[key] === "string" && (args[key] as string).trim())
  const detail = detailKey ? (args[detailKey] as string).trim() : summary
  if (detail) out.detail = clip(detail, 500)
  if (summary && summary !== detail) out.desc = clip(summary, 500)
  if (typeof args.CommandLine === "string") out.command = args.CommandLine
  else if (Object.keys(args).length) out.input = clip(JSON.stringify(args, null, 2), TOOL_TEXT_MAX)
  return out
}

// agy wraps injected input as `<SYSTEM_MESSAGE>[Message] timestamp=… sender=… priority=… content=<text>`.
// The text after `content=` is what the agent was actually told.
function systemMessageText(raw: string): string {
  const inner = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/.exec(raw)?.[1] ?? raw
  const content = /\bcontent=([\s\S]*)$/.exec(inner)?.[1]
  return (content ?? inner).trim()
}

export function projectAgyTranscript(raw: string, identityPrefix = "agy"): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  // The newest planner step's calls, still waiting for their GENERIC results, oldest first.
  let pending: TranscriptToolCall[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let step: Step
    try {
      step = JSON.parse(line) as Step
    } catch {
      continue // a torn final line; the next read settles it
    }
    if (!step || typeof step !== "object") continue
    const at = typeof step.created_at === "string" ? step.created_at : undefined
    const sourceId = `${identityPrefix}:${typeof step.step_index === "number" ? step.step_index : out.length}`
    const base = { sourceId, tools: [], parts: [], ...(at ? { at } : {}) }
    switch (step.type) {
      case "USER_INPUT": {
        pending = []
        const text = asText(step.content).trim()
        if (text) out.push({ ...base, role: "user", text })
        break
      }
      case "SYSTEM_MESSAGE": {
        pending = []
        const text = systemMessageText(asText(step.content))
        if (!text) break
        // A board wake ("[swarm] new board message #162") is punctuation, not something the agent was asked.
        if (/^\[swarm\]/.test(text)) out.push({ ...base, role: "assistant", kind: "event", text })
        else out.push({ ...base, role: "user", text })
        break
      }
      case "PLANNER_RESPONSE": {
        const text = asText(step.content).trim()
        const tools = Array.isArray(step.tool_calls) ? step.tool_calls.map(toolCallFor) : []
        pending = [...tools]
        if (!text && tools.length === 0) break
        out.push({
          ...base,
          role: "assistant",
          text,
          tools,
          parts: [...(text ? [{ kind: "text" as const, text }] : []), ...(tools.length ? [{ kind: "tools" as const, tools }] : [])],
        })
        break
      }
      case "GENERIC": {
        const call = pending.shift()
        if (!call) break
        const status = step.status
        call.status = status === "DONE" ? "completed" : status === "RUNNING" ? "pending" : status === "ERROR" || status === "INVALID" ? "failed" : call.status
        const text = asText(step.content) || asText(step.error)
        if (text) call.output = clip(text, TOOL_TEXT_MAX)
        break
      }
      default:
        break
    }
  }
  return out
}

export function readAgyTranscriptFile(absPath: string, nativeId = absPath): TranscriptMessage[] {
  try {
    return projectAgyTranscript(readFileSync(absPath, "utf8"), `agy:${nativeId}`)
  } catch {
    return []
  }
}
