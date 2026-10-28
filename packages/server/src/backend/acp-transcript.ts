import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isKeepWorkingMessage, parseSpinoffChildPrompt, parseSpinoffRequest, type TranscriptMessage, type TranscriptToolCall } from "@ntwine/shared"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"
import { applyEvent } from "../tailer.ts"

// The ACP backend's transcript: a JSONL file NTWINE writes, one per thread, at
// `<stateDir>/acp/<ntwineSessionId>.jsonl`.
//
// Claude and Codex tail a transcript the PROVIDER writes (a Claude Code JSONL, a Codex rollout). An ACP
// agent keeps its history wherever it likes and only streams `session/update` notifications at us, so
// the bridge (acp-bridge.ts) turns that stream into this file. Its records ARE `NormalizedEvent`s — the
// backend-neutral vocabulary the tailer already folds — plus one header record. That is the whole point
// of the shape: `createAcpBackend().foldLine` is `applyEvent` over each line, so board telemetry, the
// rest/turn detection, the queue's rest time, the preview and the delivery ledger all work without a
// third fold, and `projectAcpTranscript` below turns the same file into the drawer's messages.
//
// Two extra fields ride on a record and are stripped before `applyEvent`: `messageId` on a streamed
// text block (so several partial flushes of one agent message render as one bubble) and `acp` on a
// tool call (its ACP `kind`, `title` and `locations`, which the drawer shows and the fold ignores).

export const ACP_TRANSCRIPT_DIR = "acp"

export interface AcpSessionHeader {
  kind: "acp-session"
  at: string
  agent: { id: string; name?: string; version?: string }
  acpSessionId: string
  cwd: string
  model?: string
}

export interface AcpNote { kind: "acp-note"; at: string; text: string }

export type AcpRecord =
  | AcpSessionHeader
  | AcpNote
  | (NormalizedEvent & { messageId?: string; acp?: { kind?: string; title?: string; locations?: string[]; input?: unknown } })

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn-start", "turn-end", "provider-error", "assistant-text", "user-message", "tool-call", "tool-result",
  "reasoning", "agent-report", "agent-instruction", "title", "compaction", "context-usage",
])

export function acpTranscriptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, ACP_TRANSCRIPT_DIR, `${sessionId}.jsonl`)
}

/** Parse one line into the record it is, or undefined for junk. */
export function parseAcpRecord(line: string): AcpRecord | undefined {
  if (!line.trim()) return undefined
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return undefined }
  if (!raw || typeof raw !== "object" || typeof (raw as { kind?: unknown }).kind !== "string") return undefined
  const kind = (raw as { kind: string }).kind
  if (kind === "acp-session" || kind === "acp-note" || EVENT_KINDS.has(kind)) return raw as AcpRecord
  return undefined
}

/** The tailer's view: only the events, with the transcript-only fields stripped. */
export function parseAcpLine(line: string): NormalizedEvent[] {
  const rec = parseAcpRecord(line)
  if (!rec || rec.kind === "acp-session" || rec.kind === "acp-note") return []
  const { messageId: _m, acp: _a, ...ev } = rec as NormalizedEvent & { messageId?: string; acp?: unknown }
  return [ev as NormalizedEvent]
}

/** Appends records; creates the directory and file on first write so the tailer can find it at once. */
export class AcpTranscriptWriter {
  readonly path: string
  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) appendFileSync(path, "")
  }
  append(record: AcpRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + "\n")
  }
}

export interface AcpBackendOptions { stateDir: string }

export function createAcpBackend(opts: AcpBackendOptions): AgentBackend {
  return {
    kind: "acp",
    buildSpawn(_o: SpawnOpts): BuiltCommand { throw new Error("acp runs via the ACP bridge; this argv builder has no live caller") },
    buildResume(_o: ResumeOpts): BuiltCommand { throw new Error("acp runs via the ACP bridge; this argv builder has no live caller") },
    // Deterministic: the bridge names the file after the ntwine session id, so no discovery step.
    transcriptPath(sessionId: string): string | undefined { return acpTranscriptPath(opts.stateDir, sessionId) },
    parseLine: parseAcpLine,
    foldLine(state: FoldState, line: string): void {
      const rec = parseAcpRecord(line)
      if (!rec) return
      if (rec.kind === "acp-session") {
        if (rec.model) { state.model = rec.model; state.profileAt = rec.at; state.profileRevision = (state.profileRevision ?? 0) + 1 }
        return
      }
      for (const ev of parseAcpLine(line)) applyEvent(state, ev)
    },
  }
}

// ---- drawer projection --------------------------------------------------------------------------

const TOOL_TEXT_MAX = 12_000

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

type AcpToolMeta = { kind?: string; title?: string; locations?: string[]; input?: unknown }

/** The command or path a tool call is ABOUT, from its input first and its ACP locations second. */
function toolTarget(rawInput: unknown, acp: AcpToolMeta | undefined): { command?: string; path?: string; input?: Record<string, unknown> } {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : undefined
  const command = typeof input?.command === "string" ? input.command : undefined
  const path = typeof input?.filePath === "string" ? input.filePath
    : typeof input?.file_path === "string" ? input.file_path
    : typeof input?.path === "string" ? input.path
    : acp?.locations?.[0]
  return { command, path, input }
}

function toolCallFor(ev: Extract<NormalizedEvent, { kind: "tool-call" }>, acp: AcpToolMeta | undefined): TranscriptToolCall {
  const { command, path, input } = toolTarget(ev.input, acp)
  const detail = command ?? path ?? acp?.title ?? ""
  const call: TranscriptToolCall = { name: ev.name, status: "pending" }
  if (detail) call.detail = clip(detail, 500)
  if (command) call.command = command
  else if (input && Object.keys(input).length) call.input = clip(JSON.stringify(input, null, 2), TOOL_TEXT_MAX)
  return call
}

/** A result that learned the target the call did not know (opencode reports `locations`/`rawInput`
 *  only on the completing update) upgrades the call's detail from the tool's title to its target. */
function upgradeToolTarget(call: TranscriptToolCall, acp: AcpToolMeta | undefined): void {
  if (!acp || call.command || (call.detail && call.detail !== call.name)) return
  const { command, path, input } = toolTarget(acp.input, acp)
  const detail = command ?? path
  if (!detail) return
  call.detail = clip(detail, 500)
  if (command) call.command = command
  else if (input && Object.keys(input).length && !call.input) call.input = clip(JSON.stringify(input, null, 2), TOOL_TEXT_MAX)
}

/** The drawer's messages from the raw file. `identityPrefix` seeds `sourceId`s the client keys on. */
export function projectAcpTranscript(raw: string, identityPrefix = "acp"): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  let current: TranscriptMessage | undefined // the open assistant message
  let currentMessageId: string | undefined
  const openTools = new Map<string, TranscriptToolCall>()
  let sawUser = false
  const lines = raw.split("\n")

  const close = () => { current = undefined; currentMessageId = undefined }
  const openAssistant = (i: number, at: string | undefined): TranscriptMessage => {
    if (!current) {
      current = { sourceId: `${identityPrefix}:${i}`, role: "assistant", text: "", tools: [], parts: [], ...(at ? { at } : {}) }
      out.push(current)
    }
    return current
  }
  const appendText = (msg: TranscriptMessage, text: string) => {
    const last = msg.parts[msg.parts.length - 1]
    if (last?.kind === "text") last.text += text
    else msg.parts.push({ kind: "text", text })
    msg.text = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n\n")
  }
  const appendTool = (msg: TranscriptMessage, tool: TranscriptToolCall) => {
    const last = msg.parts[msg.parts.length - 1]
    if (last?.kind === "tools") last.tools.push(tool)
    else msg.parts.push({ kind: "tools", tools: [tool] })
    msg.tools.push(tool)
  }

  for (let i = 0; i < lines.length; i++) {
    const rec = parseAcpRecord(lines[i]!)
    if (!rec) continue
    switch (rec.kind) {
      case "acp-session":
      case "acp-note":
      case "title":
      case "context-usage":
      case "compaction":
      case "agent-report":
      case "agent-instruction":
        break
      case "user-message": {
        close()
        const text = rec.text ?? ""
        // A spinoff child's opening prompt projects into its spinoff header, exactly as the Claude/Codex
        // projection does it (transcript.ts userProjection). The bridge records the human-side prompt
        // with no dispatch envelope, so the first user record IS the composed spinoffChildPrompt.
        const origin = !sawUser && !rec.synthetic ? parseSpinoffChildPrompt(text) : null
        // …and a SPINOFF REQUEST an older build delivered to the worker is stamped the same way too.
        // Without the stamp the request read as the human's own latest turn to every reader that skips
        // `m.spinoff` to find one, and operatorMessages described the thread by the spinoff.
        const spinoff = !rec.synthetic ? parseSpinoffRequest(text) : null
        sawUser = true
        // …and the human's Keep working, which the chat draws as their one-line marker (userProjection).
        const keepWorking = !rec.synthetic && isKeepWorkingMessage(text)
        const projected = spinoff ? { displayText: spinoff.instructions, spinoff } : origin ? { displayText: origin.instructions, spinoffOrigin: origin } : keepWorking ? { keepWorking: true as const } : {}
        out.push({ sourceId: `${identityPrefix}:${i}`, role: "user", text, ...projected, tools: [], parts: [], ...(rec.at ? { at: rec.at } : {}), ...(rec.synthetic ? { wake: true } : {}) })
        break
      }
      case "turn-start":
        break
      case "turn-end":
        close()
        break
      case "reasoning": {
        close()
        out.push({ sourceId: `${identityPrefix}:${i}`, role: "assistant", kind: "reasoning", text: rec.text, tools: [], parts: [], ...(rec.at ? { at: rec.at } : {}) })
        break
      }
      case "assistant-text": {
        // Partial flushes of one agent message share a messageId → one bubble. A different message (or
        // none) after tools still continues the same assistant turn as a new text part.
        const msg = openAssistant(i, rec.at)
        const mid = (rec as { messageId?: string }).messageId
        if (mid && mid === currentMessageId) {
          const last = msg.parts[msg.parts.length - 1]
          if (last?.kind === "text") { last.text += rec.text; msg.text = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n\n"); break }
        }
        currentMessageId = mid
        appendText(msg, rec.text)
        break
      }
      case "tool-call": {
        const msg = openAssistant(i, rec.at)
        currentMessageId = undefined
        const call = toolCallFor(rec, (rec as { acp?: AcpToolMeta }).acp)
        openTools.set(rec.id, call)
        appendTool(msg, call)
        break
      }
      case "tool-result": {
        const call = openTools.get(rec.id)
        if (!call) break
        openTools.delete(rec.id)
        const failed = (rec as { acp?: { status?: string } }).acp?.status === "failed" || (rec as { acp?: { kind?: string } }).acp?.kind === "failed"
        call.status = failed ? "failed" : "completed"
        upgradeToolTarget(call, (rec as { acp?: AcpToolMeta }).acp)
        if (rec.text) call.output = clip(rec.text, TOOL_TEXT_MAX)
        break
      }
      case "provider-error": {
        const msg = openAssistant(i, rec.at)
        msg.providerError = rec.error
        close()
        break
      }
    }
  }
  return out
}

export function readAcpTranscriptFile(absPath: string, nativeId = absPath): TranscriptMessage[] {
  try { return projectAcpTranscript(readFileSync(absPath, "utf8"), `acp:${nativeId}`) } catch { return [] }
}
