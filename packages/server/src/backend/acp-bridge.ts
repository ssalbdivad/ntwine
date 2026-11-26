import { statSync } from "node:fs"
import { INTERACTION_PROTOCOL_VERSION, InteractionRequest, type InteractionRequest as InteractionRequestType } from "@ntwine/shared"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import { agyTranscriptPath, defaultAgyHome, summarizeAgyTranscript } from "../agy-swarm.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import { log } from "../logging.ts"
import { acpAgentSpecs, resolveAcpAgent, type AcpAgentInput, type AcpAgentSpec, type ResolvedAcpAgent } from "./acp-agents.ts"
import { AcpConnection, AcpConnectionClosed, AcpRemoteError, AcpRequestError, spawnAcpChild, type AcpSpawn } from "./acp-rpc.ts"
import { daemonAcpHost, directAcpHost, liveAcpDaemonRecord, stopAcpDaemon, type AcpHost } from "./acp-host.ts"
import { AcpTranscriptWriter, acpTranscriptPath, hasOpenAcpTurn, type AcpRecord } from "./acp-transcript.ts"
import {
  ACP_ERROR_AUTH_REQUIRED, ACP_ERROR_INTERNAL, ACP_ERROR_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION,
  AcpInitializeResult, AcpLoadSessionResult, AcpNewSessionResult, AcpPromptResult, AcpRequestPermissionParams, AcpSessionNotification, AcpSetConfigOptionResult, type AcpConfigOption,
  contentText, parseSessionUpdate,
  type AcpInitializeResult as AcpInitializeResultType, type AcpMcpServerStdio, type AcpRequestPermissionResult, type AcpToolCallUpdate,
} from "./acp-types.ts"
import { NTWINE_MCP, ntwineCliEnv, ntwineMcpEnv, withNtwineCliOnPath, type NtwineCli, type NtwineMcp } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import { acpModelPreset, acpModelSlug, type AcpAgentModels, type PermissionMode } from "@ntwine/shared"

// The ACP backend's bridge: one live agent child per thread, driven over acp-rpc.ts, writing the
// thread's transcript through acp-transcript.ts. It is the third of three transports and deliberately
// the shallowest (plans/acp-backend.md): no daemon, no sub-agents, no quota, no steer.
//
// What it owns per session:
//   - the child (spawn → initialize → session/new or session/load with the ntwine MCP server mounted);
//   - the turn: `session/prompt` is long-lived and its response IS the end of the turn, so exactly one
//     is in flight at a time and a follow-up that arrives mid-turn QUEUES and goes out the moment the
//     current one returns (ACP has no steer; plan decision 8);
//   - the transcript: every `session/update` becomes a NormalizedEvent record the tailer folds and the
//     drawer projects, with text buffered and flushed as whole blocks rather than per token;
//   - permission cards: `session/request_permission` → an InteractionRequest, answered when the operator
//     resolves it and CANCELLED (fail closed) when the turn ends, the session is released or nobody can
//     answer — the Claude bridge's contract, because a card nothing terminalizes never leaves the queue.
//
// The agent runs inside a DETACHED DAEMON (acp-daemon.ts, attached through acp-host.ts), so an ntwine
// restart or crash only drops the socket: the agent, its running turn and every sub-agent inside it keep
// going, and `warmUp()` reattaches at the next boot — adopting the in-flight `session/prompt` as the live
// turn and raising afresh any permission card the dead runtime was holding. Until 2026-09-24 the agent
// was a plain child whose stdin closed with the server, and a running turn died with it; that was the
// stated difference from the broker and the app-server, and it is gone. A session whose daemon has
// actually died is re-opened on the next input: `session/load` when the agent advertised `loadSession`,
// else a fresh session with a transcript note saying so.

export interface AcpBridgeOptions {
  projectId: string
  stateDir: string
  /** The ntwine MCP descriptor; absent ⇒ the worker simply lacks the ntwine tools. */
  ntwineMcp?: NtwineMcp
  /** Which threads get that mount. Absent ⇒ every thread. An ACP thread's contract is its first prompt,
   *  so one started under the `ntwinectl` contract is given no MCP server, and one that predates it
   *  keeps the server it was told about at every re-open. */
  mountsMcp?: (threadSlug: string) => boolean
  /** Present ⇒ the agent's shell can run `ntwinectl`: its directory goes on PATH and the agent's
   *  environment names the server, the project and — one daemon per thread — the calling thread. */
  ntwineCli?: NtwineCli
  interactions?: InteractionStore
  /** The operator's environment; filtered through inheritWorkerEnvironment before the child sees it. */
  env?: NodeJS.ProcessEnv
  /** The operator's own agent entries (settings.acpAgents), re-read on every spawn. */
  customAgents?: () => readonly AcpAgentInput[] | undefined
  /** Test seam: a plain child per open, no daemon, no reattach (wrapped as `directAcpHost`). */
  spawn?: AcpSpawn
  /** How an agent process is obtained. Default: the detached daemon host (`daemonAcpHost`). */
  host?: AcpHost
  onDiagnostic?: (d: { threadSlug: string; kind: string; message: string }) => void
  /** Called whenever a turn starts or ends, so the board can refresh without polling. */
  onStatusChange?: () => void
  now?: () => Date
  initializeTimeoutMs?: number
  /** How long streamed text sits before it is flushed as a transcript record. */
  flushMs?: number
  /** How long an unsolicited turn (updates outside `session/prompt`, e.g. an agy subagent wake) waits
   *  with no open tools/permissions and no new updates before closing. */
  unsolicitedIdleMs?: number
  /** Test seam for Antigravity's data dir when checking parent `transcript.jsonl` on unsolicited turns. */
  agyHome?: string
}

export interface AcpSpawnDispatchInput {
  threadSlug: string
  sessionId: string
  cwd: string
  agentId: string
  /** One of the agent's advertised model ids (`acp:<agent>@<model>`), or nothing for the agent's own default. */
  modelId?: string | null
  /** The thread's reasoning effort, set through the agent's effort option; nothing leaves the agent's own. */
  effort?: string | null
  /** Launch permission mode: `bypassPermissions` appends the agent's `bypassArgs` (e.g. agy's
   *  `--dangerously-skip-permissions`), otherwise the session switches to the agent's `auto` mode. */
  permissionMode?: PermissionMode
  /** The full first prompt: worker contract, orientation, then the task. */
  prompt: string
  /** What the human actually wrote — the transcript records this, not the contract. */
  userText: string
}

export interface AcpSessionInfo {
  acpSessionId: string
  agent: { id: string; name?: string; version?: string }
  model?: string
}

export interface AcpFollowUpInput {
  threadSlug: string
  sessionId: string
  cwd: string
  agentId: string
  modelId?: string | null
  effort?: string | null
  permissionMode?: PermissionMode
  /** The ACP session id pinned on the row, for a resume after a restart. */
  acpSessionId?: string | null
  text: string
  deliveryId?: string
}

export interface AcpFollowUpResult extends AcpSessionInfo {
  state: "delivered" | "queued"
  /** How the session was reached: already live, re-opened via session/load, or started fresh. */
  resumed: "live" | "loaded" | "fresh"
}

export interface AcpTurnLiveness {
  sessionLive: boolean
  turnActive: boolean
  queued: number
}

type PermissionDecisionId = "grant-turn" | "grant-session" | "deny" | "accept" | "acceptForSession" | "decline"

interface PendingPermission {
  resolve: (result: AcpRequestPermissionResult) => void
  /** Canonical card decision id → the agent's own optionId, echoed verbatim on the answer. */
  optionByDecision: Map<string, string>
  scope: InteractionSessionScope
}

interface QueuedFollowUp { text: string; deliveryId?: string }

interface Turn {
  startedAt: string
  deliveryId?: string
  /** Streamed text not yet written to the transcript. */
  text: string
  messageId?: string
  /** Everything the CURRENT agent message has said, flushed or not — the turn's final text. */
  messageText: string
  thought: string
  thoughtId?: string
  thoughtSeq: number
  thoughtFlushed: boolean
  thoughtFlushTimer?: NodeJS.Timeout
  flushTimer?: NodeJS.Timeout
  /** True when the agent woke autonomously (e.g. a subagent finished) with no `session/prompt` in flight. */
  unsolicited?: boolean
  /** Tool call ids currently in flight during an unsolicited turn; while non-empty, idle close is held. */
  openTools?: Set<string>
  idleTimer?: NodeJS.Timeout
  cancelRequested: boolean
  done: Promise<void>
  finish: () => void
}

/** The turn's outcome record, shared by a turn this bridge started and one it adopted after a restart. */
type TurnOutcome = { kind: "ended"; raw: unknown } | { kind: "failed"; err: unknown }

interface ToolMeta { kind?: string; title?: string; locations?: string[]; written: boolean; status?: string }

interface LiveSession {
  slug: string
  sessionId: string
  cwd: string
  agent: ResolvedAcpAgent
  conn: AcpConnection
  init: AcpInitializeResultType
  acpSessionId: string
  model?: string
  /** The config option id the agent files its model under (`model` for every agent seen so far). */
  modelOptionId?: string
  /** The model's reasoning-effort option, when the agent offers one for it (OpenCode: `effort`, once a
   *  model with effort levels is set), and the values it takes. */
  effortOption?: { id: string; values: string[]; current?: string }
  writer: AcpTranscriptWriter
  /** True while `session/load` replays history — those updates are already in the file. */
  loading: boolean
  turn?: Turn
  queue: QueuedFollowUp[]
  pendingPerms: Map<string, PendingPermission>
  tools: Map<string, ToolMeta>
  exited: boolean
  /** True from `shutdown()` on: the connection is being DETACHED from a daemon that keeps running, so
   *  a rejected prompt is not the turn ending and must not be recorded as one. */
  detaching: boolean
}

const AUTH_HINT = "The agent needs a login first. "
const ACP_MODEL_CACHE_MS = 10 * 60_000

/** The reasoning-effort option among an agent's config options: ACP's `thought_level` category, else one
 *  literally named `effort`. Its `default` value (OpenCode's "send none") is not a level. */
export function acpEffortOption(configOptions: readonly AcpConfigOption[]): { id: string; values: string[]; current?: string } | undefined {
  const option = configOptions.find((o) => o.category === "thought_level") ?? configOptions.find((o) => o.id === "effort")
  if (!option) return undefined
  const values = (option.options ?? []).map((o) => o.value).filter((value) => value !== "default")
  return { id: option.id, values, ...(typeof option.currentValue === "string" ? { current: option.currentValue } : {}) }
}

/** The mode a worker runs an ACP session in, when the agent offers it: Claude Code's and Antigravity's
 *  `auto` — edits and safe commands approved by the agent's own judgement, irreversible actions still
 *  asked about. It is the ACP counterpart of the `auto` a Claude worker launches in
 *  (WORKER_DISPATCH_PERMISSION). Left in the agent's `default`, `agy acp` asked about every command, and
 *  each ask became a card the operator clicked through dozens of times a turn (2026-11-19). */
export const ACP_WORKER_MODE = "auto"

type AcpModeSwitch = { via: "config"; configId: string } | { via: "set_mode" }

/** How to put a session in ACP_WORKER_MODE, or nothing when it is already there or not offered. The
 *  agent advertises its modes as a `mode`-category config option (agy 1.5) or as the older `modes`
 *  field; the config option wins when both are present, since it is what ACP superseded `modes` with. */
export function acpWorkerModeSwitch(result: { configOptions?: readonly AcpConfigOption[] | null; modes?: unknown }): AcpModeSwitch | undefined {
  const option = result.configOptions?.find((o) => o.category === "mode")
  if (option) {
    if (option.currentValue === ACP_WORKER_MODE || !option.options?.some((o) => o.value === ACP_WORKER_MODE)) return undefined
    return { via: "config", configId: option.id }
  }
  const modes = result.modes as { currentModeId?: unknown; availableModes?: Array<{ id?: unknown }> } | null | undefined
  if (!modes || modes.currentModeId === ACP_WORKER_MODE || !modes.availableModes?.some((m) => m?.id === ACP_WORKER_MODE)) return undefined
  return { via: "set_mode" }
}

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

function ntwineMcpServer(mcp: NtwineMcp | undefined, slug: string): AcpMcpServerStdio[] {
  if (!mcp) return []
  return [{
    name: NTWINE_MCP.name,
    command: process.execPath,
    args: [mcp.scriptPath],
    env: Object.entries(ntwineMcpEnv({ ...mcp, slug })).map(([name, value]) => ({ name, value })),
  }]
}

/** The text a tool call's result carries, from `content` blocks first and `rawOutput` second. */
function toolResultText(tc: AcpToolCallUpdate): string {
  const parts: string[] = []
  for (const c of tc.content ?? []) {
    if (c.type === "content") { const t = contentText((c as { content: Parameters<typeof contentText>[0] }).content); if (t) parts.push(t) }
    else if (c.type === "diff") parts.push(`--- ${(c as { path: string }).path}\n${(c as { newText: string }).newText}`)
  }
  if (parts.length) return parts.join("\n")
  const raw = tc.rawOutput as { output?: unknown } | undefined
  if (raw && typeof raw === "object" && typeof raw.output === "string") return raw.output
  if (typeof tc.rawOutput === "string") return tc.rawOutput
  return ""
}

const UNSAFE_INTERACTION_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const utf8Encoder = new TextEncoder()

/** Truncate to at most `maxChars` UTF-16 code units AND `maxBytes` UTF-8 bytes, never splitting a
 *  surrogate pair (which `InteractionRequest`'s `UNSAFE_TEXT` regex rejects as `\p{Cs}`). */
function clipUtf8(text: string, maxChars: number, maxBytes: number): string {
  const fits = (s: string) => s.length <= maxChars && utf8Encoder.encode(s).byteLength <= maxBytes
  if (fits(text)) return text
  const suffix = "…"
  let end = Math.min(text.length, Math.max(0, maxChars - suffix.length))
  while (end > 0) {
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    const candidate = `${text.slice(0, end)}${suffix}`
    if (fits(candidate)) return candidate
    end--
  }
  return suffix
}

/** Sanitize provider-controlled text for a single-line `InteractionRequest` field (`InteractionLabel`,
 *  `InteractionOpaqueId`, `pathLabel`, `workingDirectoryLabel`): collapse newlines to spaces, scrub
 *  unsafe control/bidi characters, and enforce both char and UTF-8 byte caps. Without this, any
 *  multi-line shell command (heredocs, `node -e '\n...'`, loops) whose raw text rides in `tc.title`
 *  failed `InteractionLabel`'s single-line check and `handlePermission` silently denied it. */
function singleLineInteractionText(value: string, maxChars: number, maxBytes: number, fallback: string): string {
  const cleaned = value.replace(/[\r\n]+/gu, " ").replace(UNSAFE_INTERACTION_TEXT, "").trim()
  return cleaned ? clipUtf8(cleaned, maxChars, maxBytes) : fallback
}

/** Sanitize multi-line text for `InteractionPreview` (<= 256 lines, <= 16_000 chars, <= 24_000 bytes,
 *  no unsafe control/bidi chars). */
function previewInteractionText(value: string, maxChars = 6_000, maxBytes = 20_000, maxLines = 256): string {
  const scrubbed = value.replace(UNSAFE_INTERACTION_TEXT, "").trim()
  if (!scrubbed) return ""
  const lines = scrubbed.split(/\r?\n/u)
  const bounded = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), "…"].join("\n") : scrubbed
  return clipUtf8(bounded, maxChars, maxBytes)
}

/** An ACP permission request as an ntwine card. The card's decision ids are the CANONICAL ones the web
 *  renders buttons for (typedInteractions.ts `specFor`); the agent's own optionIds are kept beside the
 *  pending entry and echoed back verbatim on the answer. */
export function buildAcpPermissionInteraction(
  params: AcpRequestPermissionParams,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
  agent: { id: string; label: string },
): { request: InteractionRequestType; optionByDecision: Map<string, string> } | null {
  const tc = params.toolCall
  const input = tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput as Record<string, unknown> : undefined
  const command = typeof input?.command === "string" ? input.command : typeof input?.CommandLine === "string" ? input.CommandLine : ""
  const isCommand = tc.kind === "execute" && command !== ""
  const isFile = (tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") && (tc.locations?.[0]?.path || typeof input?.filePath === "string" || typeof input?.path === "string")
  const payloadKind = isCommand ? "command-approval" : isFile ? "file-approval" : "permission-approval"

  const optionByDecision = new Map<string, string>()
  const allowedDecisions: InteractionRequestType["allowedDecisions"] = []
  const add = (id: PermissionDecisionId, semantic: "approve" | "deny", label: string, optionId: string, description?: string) => {
    if (optionByDecision.has(id)) return
    optionByDecision.set(id, optionId)
    allowedDecisions.push({ id, semantic, label: singleLineInteractionText(label, 150, 512, "Option"), ...(description ? { description: clip(description, 500) } : {}) })
  }
  for (const opt of params.options) {
    const label = opt.name ?? opt.kind ?? opt.optionId
    const once = payloadKind === "permission-approval" ? "grant-turn" : "accept"
    const always = payloadKind === "permission-approval" ? "grant-session" : "acceptForSession"
    const deny = payloadKind === "permission-approval" ? "deny" : "decline"
    if (opt.kind === "allow_once") add(once, "approve", label, opt.optionId, "Allow this once.")
    else if (opt.kind === "allow_always") add(always, "approve", label, opt.optionId, "Allow for the rest of this session.")
    else if (opt.kind === "reject_once" || opt.kind === "reject_always") add(deny, "deny", label, opt.optionId, "Block this tool call.")
  }
  if (!allowedDecisions.some((d) => d.semantic === "deny")) return null // nothing safe to press
  const fallbackTitle = isCommand ? "Run a command?" : "Approve a tool call?"
  const title = singleLineInteractionText(redactCredentialSyntax(tc.title ?? fallbackTitle), 150, 512, fallbackTitle)
  const previewLines = [command || "", ...Object.entries(input ?? {}).filter(([k, v]) => k !== "command" && k !== "CommandLine" && v !== "" && v !== null).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)].filter(Boolean)
  const preview = previewInteractionText(redactCredentialSyntax(previewLines.join("\n\n")))
  const commandSummary = singleLineInteractionText(redactCredentialSyntax(command).replace(/\s+/gu, " "), 150, 512, "Run a command")
  const rawPath = tc.locations?.[0]?.path ?? (typeof input?.filePath === "string" ? input.filePath : typeof input?.path === "string" ? input.path : "")
  const pathLabel = singleLineInteractionText(rawPath, 1_000, 2_048, "(unknown path)")
  const cwdLabel = singleLineInteractionText(owner.cwd, 1_000, 2_048, ".")
  const toolCallId = singleLineInteractionText(tc.toolCallId, 256, 512, "tool-call")
  const base = {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text" as const,
    provider: { kind: "acp" as const, name: singleLineInteractionText(agent.label, 150, 512, "ACP agent") },
    source: { kind: "tool" as const, id: toolCallId, label: singleLineInteractionText(redactCredentialSyntax(tc.title ?? tc.kind ?? "tool"), 150, 512, "tool") },
    owner: { projectId: owner.projectId, threadSlug: owner.threadSlug, sessionId: owner.sessionId, turnId: toolCallId, itemId: toolCallId, sessionEpoch: 0, capabilityRevision: 0 },
    providerRequestId: toolCallId,
    allowedDecisions,
    expiresAt: null,
  }
  const payload = payloadKind === "command-approval"
    ? { kind: "command-approval" as const, title, command: { summary: commandSummary, preview: preview || commandSummary, redacted: true as const, workingDirectoryLabel: cwdLabel } }
    : payloadKind === "file-approval"
      ? { kind: "file-approval" as const, title, operation: (tc.kind === "delete" ? "delete" : tc.kind === "move" ? "move" : "write") as "delete" | "move" | "write", pathLabel, ...(preview ? { diffPreview: preview } : {}) }
      : { kind: "permission-approval" as const, title, permission: singleLineInteractionText(tc.kind ?? "tool", 250, 512, "tool"), ...(preview ? { preview } : {}), workingDirectoryLabel: cwdLabel }
  const parsed = InteractionRequest.safeParse({ ...base, payload })
  return parsed.success ? { request: parsed.data, optionByDecision } : null
}

export class AcpBridge {
  private readonly sessions = new Map<string, LiveSession>()
  // Opens in flight, by ntwine session id. See `openOnce`.
  private readonly opening = new Map<string, ReturnType<AcpBridge["open"]>>()
  private readonly unsubscribe: (() => void) | undefined
  private closed = false
  private readonly options: AcpBridgeOptions

  constructor(options: AcpBridgeOptions) {
    this.options = options
    // A resolved (or cancelled/expired) card answers the agent. The store is the durable holder; this
    // map only knows which live request each card is attached to.
    this.unsubscribe = options.interactions?.subscribe((change) => {
      for (const live of this.sessions.values()) {
        const pending = live.pendingPerms.get(change.interactionId)
        if (!pending || change.lifecycle === "pending") continue
        live.pendingPerms.delete(change.interactionId)
        const record = options.interactions!.get(pending.scope, change.interactionId)
        const decisionId = change.lifecycle === "resolved" ? record?.resolution?.decisionId : undefined
        const optionId = decisionId ? pending.optionByDecision.get(decisionId) : undefined
        pending.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } })
        this.touchUnsolicitedTurn(live)
      }
    })
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  private diagnostic(slug: string, kind: string, message: string): void {
    this.options.onDiagnostic?.({ threadSlug: slug, kind, message })
    if (kind !== "stderr") log.debug("acp", `[${slug}] ${kind}: ${message}`)
  }

  /** The agents this bridge can launch, with the operator's own entries merged in. */
  agents(): AcpAgentSpec[] { return acpAgentSpecs(this.options.customAgents?.()) }

  private resolveAgent(agentId: string): ResolvedAcpAgent {
    const agent = resolveAcpAgent(agentId, this.options.customAgents?.(), this.options.env ?? process.env)
    if (!agent) throw new Error(`Unknown ACP agent "${agentId}". Add it under settings.acpAgents or pick one of: ${this.agents().map((a) => a.id).join(", ")}.`)
    if (!agent.bin) throw new Error(`The ACP agent "${agent.label}" is not installed: \`${agent.command}\` is not on PATH. Install it, or point settings.acpAgents at its executable.`)
    return agent
  }

  // ---- session lifecycle ----------------------------------------------------------------------

  /** Spawn the agent, initialize, and open (or load) a session. Throws an actionable error on any
   *  failure and leaves nothing behind. */
  private host(): AcpHost {
    return this.options.host ?? (this.options.spawn ? directAcpHost(this.options.spawn) : daemonAcpHost)
  }

  private async open(input: { threadSlug: string; sessionId: string; cwd: string; agentId: string; modelId?: string | null; effort?: string | null; permissionMode?: PermissionMode; acpSessionId?: string | null }): Promise<{ live: LiveSession; resumed: "loaded" | "fresh" | "reattached" }> {
    const { threadSlug: slug, sessionId, cwd } = input
    const agent = this.resolveAgent(input.agentId)
    const bypass = input.permissionMode === "bypassPermissions" && (agent.bypassArgs?.length ?? 0) > 0
    const spawnArgs = bypass ? [...agent.args, ...agent.bypassArgs!] : agent.args
    // An ACP agent is one detached daemon PER THREAD (acp-host.ts), so its environment can say who is
    // calling — which is all `ntwinectl`, run from the agent's own shell, needs. Applied when the daemon
    // is forked; one that survived an ntwine restart keeps the environment it was born with.
    const cli = this.options.ntwineCli
    const inherited = inheritWorkerEnvironment(this.options.env ?? process.env)
    const env = cli ? withNtwineCliOnPath({ ...inherited, ...ntwineCliEnv(cli, slug) }, cli) : inherited
    const attachment = await this.host()({ stateDir: this.options.stateDir, threadSlug: slug, sessionId, command: agent.bin!, args: spawnArgs, cwd, env })
    const proc = attachment.process
    const writer = new AcpTranscriptWriter(acpTranscriptPath(this.options.stateDir, sessionId))
    let live: LiveSession | undefined
    // Traffic from the agent that arrives before the session is READY is held, not dropped or refused.
    // On a reattach the daemon replays everything the agent said while ntwine was away — the running
    // turn's chunks, and any permission request it re-sends — the instant the socket opens, before
    // `initialize` has even been answered. Refusing a request then ("session not ready") would be taken
    // by the daemon as THE answer, and a dropped chunk is a hole in the transcript. `ready()` flips at
    // the point the handlers can act: right after the session exists on a fresh open (so session/load's
    // own replay is still governed by `loading`), and after the in-flight turn is adopted on a reattach.
    let isReady = false
    const held: Array<() => void> = []
    const ready = (): void => { isReady = true; for (const run of held.splice(0)) run() }
    const conn = new AcpConnection(proc, {
      onRequest: (method, params) => {
        if (isReady && live) return this.handleRequest(live, method, params)
        return new Promise((resolve, reject) => { held.push(() => { this.handleRequest(live!, method, params).then(resolve, reject) }) })
      },
      onNotification: (method, params) => {
        if (method !== "session/update") return
        if (isReady && live) this.handleNotification(live, params)
        else held.push(() => this.handleNotification(live!, params))
      },
      onDiagnostic: (d) => this.diagnostic(slug, d.kind, d.message),
      requestTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    })
    const fail = async (err: unknown): Promise<never> => {
      await conn.close(500)
      // An agent that cannot complete the handshake or open a session is no use alive in a daemon.
      await stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {})
      const stderr = conn.recentStderr.slice(-3).join(" | ")
      const e = err instanceof Error ? err : new Error(String(err))
      throw new Error(`${e.message}${stderr ? ` (agent stderr: ${clip(stderr, 400)})` : ""}`)
    }
    let init: AcpInitializeResultType
    try {
      init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ntwine", version: "0" },
      }))
    } catch (err) { return fail(err instanceof Error ? new Error(`${agent.label} did not complete the ACP handshake: ${err.message}`) : err) }
    const mcpServers = this.options.mountsMcp?.(slug) === false ? [] : ntwineMcpServer(this.options.ntwineMcp, slug)
    live = { slug, sessionId, cwd, agent, conn, init, acpSessionId: "", writer, loading: false, queue: [], pendingPerms: new Map(), tools: new Map(), exited: false, detaching: false }
    void conn.exited.then(() => { if (live) this.onExit(live) })

    // REATTACHED to an agent that outlived an ntwine restart: the session is already open (the daemon
    // reports its id) and a `session/prompt` may still be running. Adopt both — no session/new, no
    // session/load, and the in-flight prompt becomes the live turn so it ends in the transcript exactly
    // as it would have had nothing happened.
    if (attachment.reattached && attachment.hello.acpSessionId) {
      live.acpSessionId = attachment.hello.acpSessionId
      writer.append({ kind: "acp-note", at: this.now(), text: `Reattached to the running ${agent.label} session after an ntwine restart.` })
      if (attachment.hello.droppedWhileDetached > 0) {
        writer.append({ kind: "acp-note", at: this.now(), text: `${attachment.hello.droppedWhileDetached} message(s) from the agent were lost while ntwine was away; the transcript may have gaps.` })
      }
      this.sessions.set(sessionId, live)
      const prompt = attachment.hello.outstanding.find((o) => o.method === "session/prompt")
      if (prompt) {
        const current = live
        const turn = this.newTurn(undefined)
        current.turn = turn
        this.options.onStatusChange?.()
        void this.awaitTurn(current, turn, conn.adoptPending("session/prompt", (id) => attachment.adopt(prompt.daemonId, id)))
      } else if (hasOpenAcpTurn(writer.path)) {
        // The daemon reports no in-flight or unadopted `session/prompt` (the agent is idle), yet the
        // transcript still has an unclosed `turn-start` — e.g. from a pre-fix daemon that dropped a
        // response while detached. Close the bracket so the thread does not spin in-flight forever.
        const at = this.now()
        writer.append({ kind: "acp-note", at, text: "The previous turn finished while ntwine was away and its ending could not be recovered." })
        writer.append({ kind: "turn-end", at, successful: false })
        this.options.onStatusChange?.()
      }
      ready()
      return { live, resumed: "reattached" }
    }
    ready()

    const authError = (err: AcpRemoteError): Error => {
      const hint = (init.authMethods ?? []).map((m) => m.description ?? m.name ?? m.id).filter(Boolean).join("; ")
      return new Error(`${AUTH_HINT}${agent.label} refused to open a session: ${err.error.message}.${hint ? ` ${hint}.` : ""}`)
    }
    let resumed: "loaded" | "fresh" = "fresh"
    let modeSwitch: AcpModeSwitch | undefined
    if (input.acpSessionId && init.agentCapabilities?.loadSession) {
      live.loading = true
      try {
        const loaded = AcpLoadSessionResult.parse(await conn.request("session/load", { sessionId: input.acpSessionId, cwd, mcpServers }))
        live.acpSessionId = input.acpSessionId
        this.adoptModel(live, loaded.configOptions)
        modeSwitch = acpWorkerModeSwitch(loaded)
        resumed = "loaded"
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        this.diagnostic(slug, "protocol", `session/load ${input.acpSessionId} failed (${(err as Error).message}); starting a fresh session`)
      } finally { live.loading = false }
    }
    if (!live.acpSessionId) {
      try {
        const created = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers }))
        live.acpSessionId = created.sessionId
        this.adoptModel(live, created.configOptions)
        modeSwitch = acpWorkerModeSwitch(created)
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        return fail(err instanceof Error ? new Error(`${agent.label} could not open a session: ${err.message}`) : err)
      }
    }
    // The thread's chosen model, applied before the header so the header records what is in effect.
    const modelProblem = await this.applyModel(live, input.modelId)
    // A picker preset (`acpModelPreset`) is chosen FOR its model, so one the agent will not run fails the
    // open instead of quietly running the agent's default on the operator's money.
    if (modelProblem && acpModelPreset(acpModelSlug(agent.id, input.modelId))) return fail(new Error(modelProblem))
    // The effort after the model: the agent's effort option, and the levels in it, belong to the model.
    const effortProblem = await this.applyEffort(live, input.effort)
    // When the daemon launched with `bypassArgs` (e.g. agy's `--dangerously-skip-permissions`), do NOT
    // switch the session mode to `auto` — that would re-enable the agent's classifier over the bypass.
    if (!bypass && modeSwitch) await this.applyWorkerMode(live, modeSwitch)
    if (resumed === "fresh") {
      writer.append({ kind: "acp-session", at: this.now(), agent: { id: agent.id, ...(init.agentInfo?.name ? { name: init.agentInfo.name } : {}), ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}) }, acpSessionId: live.acpSessionId, cwd, ...(live.model ? { model: live.model } : {}) })
      if (input.acpSessionId) writer.append({ kind: "acp-note", at: this.now(), text: `Resumed with a fresh ${agent.label} session: the previous one (${input.acpSessionId}) could not be loaded, so the agent no longer has the earlier conversation.` })
    }
    if (modelProblem) writer.append({ kind: "acp-note", at: this.now(), text: modelProblem })
    if (effortProblem) writer.append({ kind: "acp-note", at: this.now(), text: effortProblem })
    this.sessions.set(sessionId, live)
    return { live, resumed }
  }

  /**
   * ONE open per session at a time; every concurrent caller shares it. The session's daemon is keyed by
   * session id — one record path, one socket path — so two opens racing for a session with no live
   * agent (the waker delivering answers while the operator sends, a boot `warmUp` under a follow-up)
   * each found no daemon and FORKED one. The second took the record and the socket path, and the two
   * attaches could reach the SAME daemon, which serves one client at a time: the later one hung up the
   * earlier, whose next stdin write failed with EPIPE — an unhandled stream error that took the whole
   * process down until acp-rpc.ts listened for it. Short of that, a failed open `stopAcpDaemon`s
   * whatever the record names (the other caller's agent), and the loser of the two `sessions.set`s
   * runs its turn on a second agent nobody tracks, appending to the same transcript.
   * The same race forked two Claude daemons on 2026-09-30 (claude-agent-broker-bridge.ts `attachOnce`);
   * scripts/verify-daemon-socket-takeover.mjs, scenario D, reproduces it here.
   */
  private openOnce(input: Parameters<AcpBridge["open"]>[0]): ReturnType<AcpBridge["open"]> {
    const inflight = this.opening.get(input.sessionId)
    if (inflight) return inflight
    const opening = this.open(input).finally(() => { if (this.opening.get(input.sessionId) === opening) this.opening.delete(input.sessionId) })
    this.opening.set(input.sessionId, opening)
    return opening
  }

  /** The agent's model option (`category: "model"`, else the one literally named `model`). */
  private modelOption(configOptions: AcpNewSessionResult["configOptions"]): AcpConfigOption | undefined {
    return configOptions?.find((o) => o.category === "model") ?? configOptions?.find((o) => o.id === "model")
  }

  private adoptModel(live: LiveSession, configOptions: AcpNewSessionResult["configOptions"]): void {
    if (!configOptions) return
    const effort = acpEffortOption(configOptions)
    if (effort) live.effortOption = effort
    else delete live.effortOption
    const option = this.modelOption(configOptions)
    if (!option) return
    live.modelOptionId = option.id
    if (typeof option.currentValue === "string") live.model = option.currentValue
  }

  /** Set the thread's reasoning effort through the agent's effort option. Returns the note to write when
   *  it cannot be: the model has no effort option, or not that level — the turn runs on the agent's own. */
  private async applyEffort(live: LiveSession, effort: string | null | undefined): Promise<string | undefined> {
    if (!effort) return undefined
    const option = live.effortOption
    const on = live.model ?? "its default model"
    if (!option) return `${live.agent.label} offers no reasoning effort for ${on}; it runs at its own.`
    if (!option.values.includes(effort)) return `${live.agent.label} has no ${effort} effort for ${on} (it offers ${option.values.join(", ")}); it runs at ${option.current ?? "its own"}.`
    if (option.current === effort) return undefined
    try {
      const res = AcpSetConfigOptionResult.parse(await live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId: option.id, value: effort }))
      this.adoptModel(live, res.configOptions)
      if (!res.configOptions?.length && live.effortOption) live.effortOption.current = effort
      return undefined
    } catch (err) {
      const message = err instanceof AcpRemoteError ? err.error.message : (err as Error).message
      this.diagnostic(live.slug, "protocol", `session/set_config_option ${option.id}=${effort} failed: ${message}`)
      return `${live.agent.label} could not set ${effort} effort (${clip(message, 200)}); it runs at ${option.current ?? "its own"}.`
    }
  }

  /** Put the session in ACP_WORKER_MODE. A refusal is a diagnostic, not a note: the thread still works,
   *  it only asks more, and every ask is already a card. */
  private async applyWorkerMode(live: LiveSession, change: AcpModeSwitch): Promise<void> {
    try {
      if (change.via === "set_mode") await live.conn.request("session/set_mode", { sessionId: live.acpSessionId, modeId: ACP_WORKER_MODE })
      else this.adoptModel(live, AcpSetConfigOptionResult.parse(await live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId: change.configId, value: ACP_WORKER_MODE })).configOptions)
    } catch (err) {
      const message = err instanceof AcpRemoteError ? err.error.message : (err as Error).message
      this.diagnostic(live.slug, "protocol", `switching to ${ACP_WORKER_MODE} mode failed: ${message}`)
    }
  }

  /** Ask the agent for the thread's model when it is not already the one in effect. Returns the note
   *  to write when the agent refused — the thread runs on, on the agent's own model, and says so. */
  private async applyModel(live: LiveSession, modelId: string | null | undefined): Promise<string | undefined> {
    if (!modelId || modelId === live.model) return undefined
    try {
      const res = AcpSetConfigOptionResult.parse(await live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId: live.modelOptionId ?? "model", value: modelId }))
      this.adoptModel(live, res.configOptions)
      if (live.model !== modelId && res.configOptions?.length) return `${live.agent.label} did not switch to ${modelId}; the session runs on ${live.model ?? "its own default model"}.`
      if (!res.configOptions?.length) live.model = modelId
      return undefined
    } catch (err) {
      const message = err instanceof AcpRemoteError ? err.error.message : (err as Error).message
      this.diagnostic(live.slug, "protocol", `session/set_config_option ${modelId} failed: ${message}`)
      return `${live.agent.label} could not switch to ${modelId} (${clip(message, 200)}); the session runs on ${live.model ?? "its own default model"}.`
    }
  }

  // ---- the model catalogue an agent advertises -----------------------------------------------------

  private readonly modelProbes = new Map<string, Promise<AcpAgentModels>>()
  private readonly modelCache = new Map<string, AcpAgentModels>()

  /** The models an agent offers, read by opening a throwaway session (there is no other way to ask:
   *  ACP advertises models only in a session's config options). Cached per agent for ten minutes; a
   *  probe that cannot open a session (not installed, not logged in) yields an empty list with the
   *  reason, never a throw, so the composer degrades to the agent's own default. */
  agentModels(agentId: string, cwd: string, opts: { refresh?: boolean } = {}): Promise<AcpAgentModels> {
    const cached = this.modelCache.get(agentId)
    if (cached && !opts.refresh && Date.now() - Date.parse(cached.probedAt) < ACP_MODEL_CACHE_MS) return Promise.resolve(cached)
    const inflight = this.modelProbes.get(agentId)
    if (inflight) return inflight
    const probe = this.probeModels(agentId, cwd).then((result) => {
      if (!result.error) this.modelCache.set(agentId, result)
      return result
    }).finally(() => this.modelProbes.delete(agentId))
    this.modelProbes.set(agentId, probe)
    return probe
  }

  private async probeModels(agentId: string, cwd: string): Promise<AcpAgentModels> {
    const probedAt = this.now()
    const empty = (error: string): AcpAgentModels => ({ agentId, models: [], error, probedAt })
    let agent: ResolvedAcpAgent
    try { agent = this.resolveAgent(agentId) } catch (err) { return empty((err as Error).message) }
    const env = inheritWorkerEnvironment(this.options.env ?? process.env)
    const spawn = this.options.spawn ?? spawnAcpChild
    let proc: ReturnType<typeof spawnAcpChild>
    try { proc = spawn({ command: agent.bin!, args: agent.args, cwd, env }) } catch (err) { return empty(`${agent.label} could not start: ${(err as Error).message}`) }
    const conn = new AcpConnection(proc, {
      onRequest: () => Promise.reject(new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, "probe session takes no requests")),
      onNotification: () => {},
      onDiagnostic: (d) => this.diagnostic(`probe:${agentId}`, d.kind, d.message),
      requestTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    })
    try {
      const init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ntwine", version: "0" },
      }))
      const created = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers: [] }))
      const option = this.modelOption(created.configOptions)
      const current = typeof option?.currentValue === "string" ? option.currentValue : undefined
      void init
      return {
        agentId,
        models: (option?.options ?? []).map((o) => ({ id: o.value, name: o.name ?? o.value })),
        ...(current ? { current } : {}),
        probedAt,
      }
    } catch (err) {
      const message = err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED
        ? `${AUTH_HINT}${agent.label} refused to open a session: ${err.error.message}`
        : `${agent.label}: ${(err as Error).message}`
      return empty(clip(message, 400))
    } finally {
      await conn.close(500)
    }
  }

  private onExit(live: LiveSession): void {
    if (live.exited) return
    live.exited = true
    this.retirePermissions(live, "provider-cancelled")
    if (live.turn?.unsolicited) {
      this.closeUnsolicitedTurn(live, live.turn, false)
    }
    if (this.sessions.get(live.sessionId) === live) this.sessions.delete(live.sessionId)
    this.options.onStatusChange?.()
  }

  // ---- public API --------------------------------------------------------------------------------

  async spawnDispatch(input: AcpSpawnDispatchInput): Promise<AcpSessionInfo> {
    if (this.closed) throw new Error("ACP bridge is closed")
    const { live } = await this.openOnce(input)
    void this.runTurn(live, input.prompt, input.userText, undefined)
    return this.info(live)
  }

  /** Deliver a follow-up: to the live session, to a re-opened one (load or fresh), or into the queue
   *  when a turn is running. Returns the (possibly new) ACP session id so the caller can re-pin it. */
  async followUp(input: AcpFollowUpInput): Promise<AcpFollowUpResult> {
    if (this.closed) throw new Error("ACP bridge is closed")
    let live = this.sessions.get(input.sessionId)
    let resumed: AcpFollowUpResult["resumed"] = "live"
    if (!live || live.exited || live.conn.closed) {
      // Shared with any open already in flight for this session. The first caller to resume runs its
      // turn (runTurn claims `live.turn` before its first await); every other one then queues behind it.
      const opened = await this.openOnce(input)
      live = opened.live
      // A reattach IS the live session — the agent never went away, only the socket did.
      resumed = opened.resumed === "reattached" ? "live" : opened.resumed
    }
    if (live.turn) {
      live.queue.push({ text: input.text, ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) })
      return { ...this.info(live), state: "queued", resumed }
    }
    void this.runTurn(live, input.text, input.text, input.deliveryId)
    return { ...this.info(live), state: "delivered", resumed }
  }

  /** `session/cancel`, then wait (bounded) for the prompt to return. `interrupted: false` when no turn
   *  was running (or when `onlyIfQueued` is set and the queue is already empty). The queue is NOT
   *  discarded — queued follow-ups run immediately as the next turn. */
  async interruptTurn(threadSlug: string, sessionId: string, opts?: { onlyIfQueued?: boolean }): Promise<{ interrupted: boolean }> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || !live.turn) return { interrupted: false }
    if (opts?.onlyIfQueued && live.queue.length === 0) return { interrupted: false }
    if (live.turn.unsolicited) {
      live.turn.cancelRequested = true
      live.conn.notify("session/cancel", { sessionId: live.acpSessionId })
      this.closeUnsolicitedTurn(live, live.turn, false)
      return { interrupted: true }
    }
    live.turn.cancelRequested = true
    live.conn.notify("session/cancel", { sessionId: live.acpSessionId })
    const settled = await Promise.race([live.turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000).unref?.())])
    if (!settled) { await live.conn.close(1_000); return { interrupted: true } }
    return { interrupted: true }
  }

  /** Drop a queued follow-up before it starts its turn. `false` when it already left the queue. */
  cancelFollowUp(threadSlug: string, sessionId: string, deliveryId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return false
    const idx = live.queue.findIndex((item) => item.deliveryId === deliveryId)
    if (idx === -1) return false
    live.queue.splice(idx, 1)
    return true
  }

  /** END the session's agent: cancel its turn, drop its cards, and stop the daemon holding it. This is
   *  the teardown for a thread that is dismissed, replaced or marked done — never for a restart, which
   *  is `shutdown()`. Inert when nothing is live AND no daemon exists for the session. */
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): void {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug) {
      this.sessions.delete(sessionId)
      live.queue.length = 0
      this.retirePermissions(live, "provider-cancelled")
      if (live.turn?.idleTimer) { clearTimeout(live.turn.idleTimer); live.turn.idleTimer = undefined }
      if (live.turn) live.conn.notify("session/cancel", { sessionId: live.acpSessionId })
      if (live.turn?.unsolicited) { live.turn.finish(); live.turn = undefined }
      void live.conn.close(3_000)
    }
    void reason
    void stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {})
  }

  /** Boot-time reattach: every session in `rows` whose daemon is still running is re-opened NOW, so a
   *  turn that survived the restart is live on the board (and its in-flight prompt adopted) before the
   *  next input rather than after it. Fire-and-forget per row: one agent's trouble never blocks a boot. */
  async warmUp(rows: ReadonlyArray<{ threadSlug: string; sessionId: string; cwd: string; agentId: string; modelId?: string | null; effort?: string | null; permissionMode?: PermissionMode; acpSessionId?: string | null }>): Promise<void> {
    for (const row of rows) {
      if (this.closed) return
      if (!liveAcpDaemonRecord(this.options.stateDir, row.sessionId)) continue
      if (this.sessions.has(row.sessionId)) continue
      try {
        await this.openOnce(row)
      } catch (err) {
        this.diagnostic(row.threadSlug, "reattach", `could not reattach to the running agent: ${(err as Error).message}`)
      }
    }
  }

  /** Switch a LIVE session's model and effort (`session/set_config_option`); `applied: false` when the
   *  session is not open, in which case the caller's stored profile reaches the agent on the next open. A
   *  refusal is written to the transcript as a note, exactly as on open, and still counts as applied: the
   *  agent answered, and the note says what it runs on. */
  async setModel(threadSlug: string, sessionId: string, modelId: string | null | undefined, effort?: string | null): Promise<{ applied: boolean; model?: string }> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || live.exited || live.conn.closed) return { applied: false }
    for (const problem of [await this.applyModel(live, modelId), await this.applyEffort(live, effort)]) {
      if (problem) live.writer.append({ kind: "acp-note", at: this.now(), text: problem })
    }
    return { applied: true, ...(live.model ? { model: live.model } : {}) }
  }

  /** An agent process exists for the session: attached here, or held by a daemon nobody has reattached
   *  to yet. What "live" means to Mark as done and dismiss — an idle agent is still one to end. */
  isAgentAlive(threadSlug: string, sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug && !live.exited && !live.conn.closed) return true
    return liveAcpDaemonRecord(this.options.stateDir, sessionId) !== null
  }

  turnLiveness(threadSlug: string, sessionId: string): AcpTurnLiveness | undefined {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return undefined
    return { sessionLive: !live.exited && !live.conn.closed, turnActive: live.turn !== undefined, queued: live.queue.length }
  }

  session(threadSlug: string, sessionId: string): AcpSessionInfo | undefined {
    const live = this.sessions.get(sessionId)
    return live && live.slug === threadSlug ? this.info(live) : undefined
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    const live = this.sessions.get(scope.sessionId)
    return live !== undefined && live.slug === scope.threadSlug && live.pendingPerms.has(interactionId)
  }

  /** DETACH from every agent — the daemons and their turns keep running for the next runtime to
   *  reattach to. Open cards are cancelled on OUR side only (the answer would have nowhere to go); the
   *  agent's request stays unanswered in its daemon, which re-sends it on reattach so the card is raised
   *  afresh. A plain-child session (test seam) simply ends here, as it always did. */
  async shutdown(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(async (live) => {
      live.detaching = true
      if (live.turn?.idleTimer) { clearTimeout(live.turn.idleTimer); live.turn.idleTimer = undefined }
      if (live.turn?.unsolicited) {
        if (live.turn.flushTimer) { clearTimeout(live.turn.flushTimer); live.turn.flushTimer = undefined }
        this.flushThought(live)
        this.flushText(live, false)
        live.turn.finish()
      }
      this.dropPermissionCards(live)
      await live.conn.close(1_000)
    }))
  }

  /** Cancel a session's open cards without answering the agent. The pending entries go FIRST, so the
   *  store's cancellation event (which resolves a pending entry with `cancelled`) finds none to answer. */
  private dropPermissionCards(live: LiveSession): void {
    if (!live.pendingPerms.size) return
    live.pendingPerms.clear()
    try { this.options.interactions?.cancelForSession(live.slug, live.sessionId, "provider-cancelled") } catch { /* hygiene */ }
  }

  private info(live: LiveSession): AcpSessionInfo {
    return {
      acpSessionId: live.acpSessionId,
      agent: { id: live.agent.id, ...(live.init.agentInfo?.name ? { name: live.init.agentInfo.name } : {}), ...(live.init.agentInfo?.version ? { version: live.init.agentInfo.version } : {}) },
      ...(live.model ? { model: live.model } : {}),
    }
  }

  // ---- the turn ---------------------------------------------------------------------------------

  private newTurn(deliveryId: string | undefined): Turn {
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    return { startedAt: this.now(), ...(deliveryId ? { deliveryId } : {}), text: "", messageText: "", thought: "", thoughtSeq: 0, thoughtFlushed: false, cancelRequested: false, done, finish }
  }

  private async runTurn(live: LiveSession, sendText: string, recordTexts: string | readonly string[], deliveryId: string | undefined): Promise<void> {
    const turn = this.newTurn(deliveryId)
    live.turn = turn
    const texts = typeof recordTexts === "string" ? [recordTexts] : recordTexts
    for (const text of texts) live.writer.append({ kind: "user-message", at: turn.startedAt, text, synthetic: false })
    live.writer.append({ kind: "turn-start", at: turn.startedAt })
    this.options.onStatusChange?.()
    await this.awaitTurn(live, turn, live.conn.requestOpenEnded("session/prompt", { sessionId: live.acpSessionId, prompt: [{ type: "text", text: sendText }] }))
  }

  /** Wait for a `session/prompt` — one this bridge sent, or one adopted from a daemon after a restart —
   *  and write the turn's ending. */
  private async awaitTurn(live: LiveSession, turn: Turn, response: Promise<unknown>): Promise<void> {
    let outcome: TurnOutcome
    try { outcome = { kind: "ended", raw: await response } } catch (err) { outcome = { kind: "failed", err } }
    // DETACHING, not ending: `shutdown()` closed the socket to a daemon whose agent is still running
    // this very turn. Leave the turn OPEN in the transcript — the next runtime reattaches and adopts it,
    // and its real ending is written then. Nothing else in `finally` applies either: the cards are the
    // daemon's to re-raise, and the queue was never the agent's.
    if (outcome.kind === "failed" && live.detaching && outcome.err instanceof AcpConnectionClosed) {
      if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
      this.flushThought(live)
      this.flushText(live, false)
      turn.finish()
      return
    }
    try {
      if (outcome.kind === "failed") throw outcome.err
      const result = AcpPromptResult.parse(outcome.raw)
      this.flushThought(live)
      const finalText = this.flushText(live, true)
      // A cancelled turn is not a success: the tailer clears provider faults on a successful bracket,
      // and an operator's stop must not read as the agent having finished cleanly.
      live.writer.append({ kind: "turn-end", at: this.now(), ...(finalText !== undefined ? { finalText } : {}), successful: result.stopReason !== "refusal" && result.stopReason !== "cancelled" })
      if (result.stopReason === "cancelled") live.writer.append({ kind: "acp-note", at: this.now(), text: "Turn cancelled." })
    } catch (err) {
      this.flushThought(live)
      const finalText = this.flushText(live, true)
      const at = this.now()
      // Some agents (Gemini) answer a cancel with -32603 "aborted" instead of stopReason cancelled.
      const abortedByUs = turn.cancelRequested && err instanceof AcpRemoteError && err.error.code === ACP_ERROR_INTERNAL
      if (abortedByUs) {
        live.writer.append({ kind: "turn-end", at, ...(finalText !== undefined ? { finalText } : {}), successful: false })
        live.writer.append({ kind: "acp-note", at, text: "Turn cancelled." })
      } else {
        const message = err instanceof AcpRemoteError
          ? (err.error.code === ACP_ERROR_AUTH_REQUIRED ? `${AUTH_HINT}${err.error.message}` : err.error.message)
          : (err as Error).message
        live.writer.append({ kind: "provider-error", at, error: { message: clip(message, 2_000), ...(err instanceof AcpRemoteError ? { code: String(err.error.code) } : {}) } })
        live.writer.append({ kind: "turn-end", at, ...(finalText !== undefined ? { finalText } : {}), successful: false })
      }
    } finally {
      this.retirePermissions(live, "turn-ended")
      if (live.turn === turn) live.turn = undefined
      turn.finish()
      this.options.onStatusChange?.()
      const queued = live.queue.splice(0)
      if (queued.length > 0 && !live.exited && !live.conn.closed) {
        const sendText = queued.map((q) => q.text).join("\n\n")
        const recordTexts = queued.map((q) => q.text)
        void this.runTurn(live, sendText, recordTexts, queued[queued.length - 1]!.deliveryId)
      }
    }
  }

  /** Write the buffered text as one record. Returns, for a FINAL flush, the whole text of the agent's
   *  last message (every partial flush included) — what the turn-end carries as `finalText`, so the
   *  fold's preview and fence parsing see the complete message, never the last chunk. */
  private flushText(live: LiveSession, final: boolean): string | undefined {
    const turn = live.turn
    if (!turn) return undefined
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
    if (turn.text) {
      const text = turn.text
      turn.text = ""
      live.writer.append({ kind: "assistant-text", at: this.now(), text, final, ...(turn.messageId ? { messageId: turn.messageId } : {}) })
    }
    return final && turn.messageText ? turn.messageText : undefined
  }

  private flushThought(live: LiveSession, endBurst = true): void {
    const turn = live.turn
    if (!turn) return
    if (turn.thoughtFlushTimer) { clearTimeout(turn.thoughtFlushTimer); turn.thoughtFlushTimer = undefined }
    if (turn.thought && (turn.thoughtFlushed || turn.thought.trim())) {
      live.writer.append({ kind: "reasoning", at: this.now(), text: turn.thought, ...(turn.thoughtId ? { thoughtId: turn.thoughtId } : {}) })
      turn.thought = ""
      turn.thoughtFlushed = true
    } else if (endBurst) {
      turn.thought = ""
    }
    if (endBurst) {
      turn.thoughtId = undefined
      turn.thoughtFlushed = false
    }
  }

  private scheduleThoughtFlush(live: LiveSession): void {
    const turn = live.turn
    if (!turn || turn.thoughtFlushTimer) return
    turn.thoughtFlushTimer = setTimeout(() => { turn.thoughtFlushTimer = undefined; this.flushThought(live, false) }, this.options.flushMs ?? 1_000)
    turn.thoughtFlushTimer.unref?.()
  }

  private scheduleFlush(live: LiveSession): void {
    const turn = live.turn
    if (!turn || turn.flushTimer) return
    turn.flushTimer = setTimeout(() => { turn.flushTimer = undefined; this.flushText(live, false) }, this.options.flushMs ?? 1_000)
    turn.flushTimer.unref?.()
  }

  /** Open an unsolicited turn when an ACP agent (e.g. agy waking on a background subagent's reply)
   *  streams updates with no `session/prompt` in flight. Without this, text/thought chunks were dropped
   *  and no turn-start/turn-end bracket reached the transcript or board. */
  private ensureUnsolicitedTurn(live: LiveSession): Turn {
    if (live.turn) return live.turn
    const turn = this.newTurn(undefined)
    turn.unsolicited = true
    turn.openTools = new Set()
    live.turn = turn
    live.writer.append({ kind: "turn-start", at: turn.startedAt })
    this.options.onStatusChange?.()
    return turn
  }

  private touchUnsolicitedTurn(live: LiveSession): void {
    const turn = live.turn
    if (!turn?.unsolicited) return
    if (turn.idleTimer) clearTimeout(turn.idleTimer)
    turn.idleTimer = setTimeout(() => this.checkUnsolicitedIdle(live, turn), this.options.unsolicitedIdleMs ?? 2_500)
    turn.idleTimer.unref?.()
  }

  private checkUnsolicitedIdle(live: LiveSession, turn: Turn): void {
    turn.idleTimer = undefined
    if (live.turn !== turn || live.exited || live.detaching) return
    if ((turn.openTools?.size ?? 0) > 0 || live.pendingPerms.size > 0) return
    if (live.agent.id === "antigravity") {
      // Antigravity writes its own transcript to disk; consulting `agyTurnEnded` avoids closing an
      // unsolicited turn mid-pause while the model is thinking between two tool calls.
      const path = agyTranscriptPath(this.options.agyHome ?? defaultAgyHome(), live.acpSessionId)
      try {
        const s = statSync(path)
        const summary = summarizeAgyTranscript(path, s.size)
        if (summary && !summary.idle) {
          this.touchUnsolicitedTurn(live)
          return
        }
      } catch { /* no on-disk transcript yet — fall through to idle close */ }
    }
    this.closeUnsolicitedTurn(live, turn, true)
  }

  private closeUnsolicitedTurn(live: LiveSession, turn: Turn, successful: boolean): void {
    if (live.turn !== turn) return
    if (turn.idleTimer) { clearTimeout(turn.idleTimer); turn.idleTimer = undefined }
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
    this.flushThought(live)
    const finalText = this.flushText(live, true)
    live.writer.append({ kind: "turn-end", at: this.now(), ...(finalText !== undefined ? { finalText } : {}), successful })
    if (turn.cancelRequested) live.writer.append({ kind: "acp-note", at: this.now(), text: "Turn cancelled." })
    this.retirePermissions(live, "turn-ended")
    live.turn = undefined
    turn.finish()
    this.options.onStatusChange?.()
    const queued = live.queue.splice(0)
    if (queued.length > 0 && !live.exited && !live.conn.closed) {
      const sendText = queued.map((q) => q.text).join("\n\n")
      const recordTexts = queued.map((q) => q.text)
      void this.runTurn(live, sendText, recordTexts, queued[queued.length - 1]!.deliveryId)
    }
  }

  private handleNotification(live: LiveSession, params: unknown): void {
    if (live.loading) return
    const parsed = AcpSessionNotification.safeParse(params)
    if (!parsed.success) { this.diagnostic(live.slug, "protocol", "malformed session/update"); return }
    const update = parseSessionUpdate(parsed.data.update)
    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        const t = contentText(update.content)
        if (!t) return
        const turn = this.ensureUnsolicitedTurn(live)
        if (!turn.thoughtId) turn.thoughtId = `t${++turn.thoughtSeq}`
        turn.thought += t
        this.scheduleThoughtFlush(live)
        this.touchUnsolicitedTurn(live)
        return
      }
      case "agent_message_chunk": {
        const t = contentText(update.content)
        if (!t) return
        const turn = this.ensureUnsolicitedTurn(live)
        this.flushThought(live)
        if (update.messageId && turn.messageId && update.messageId !== turn.messageId) { this.flushText(live, false); turn.messageText = "" }
        if (update.messageId) turn.messageId = update.messageId
        turn.text += t
        turn.messageText += t
        this.scheduleFlush(live)
        this.touchUnsolicitedTurn(live)
        return
      }
      case "tool_call": {
        const turn = this.ensureUnsolicitedTurn(live)
        this.flushThought(live)
        this.flushText(live, false)
        turn.messageText = "" // text before a tool call is commentary, not the answer
        const meta: ToolMeta = { ...(update.kind ? { kind: update.kind } : {}), ...(update.title ? { title: update.title } : {}), locations: (update.locations ?? []).map((l) => l.path), written: true }
        live.tools.set(update.toolCallId, meta)
        live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: update.title ?? update.kind ?? "tool", input: update.rawInput ?? {}, acp: { ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.title ? { title: meta.title } : {}), locations: meta.locations ?? [] } })
        if (update.status === "completed" || update.status === "failed") {
          this.recordToolResult(live, update)
        } else {
          turn.openTools?.add(update.toolCallId)
          this.touchUnsolicitedTurn(live)
        }
        return
      }
      case "tool_call_update": {
        const turn = this.ensureUnsolicitedTurn(live)
        let meta = live.tools.get(update.toolCallId)
        if (!meta) {
          // An update-first agent (or v2): the first sighting creates the call.
          meta = { written: false }
          live.tools.set(update.toolCallId, meta)
        }
        if (update.kind) meta.kind = update.kind
        if (update.title) meta.title = update.title
        if (update.locations?.length) meta.locations = update.locations.map((l) => l.path)
        if (!meta.written) {
          this.flushThought(live)
          this.flushText(live, false)
          turn.messageText = ""
          meta.written = true
          live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: meta.title ?? meta.kind ?? "tool", input: update.rawInput ?? {}, acp: { ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.title ? { title: meta.title } : {}), locations: meta.locations ?? [] } })
        }
        if (update.status === "completed" || update.status === "failed") {
          this.recordToolResult(live, update)
        } else {
          turn.openTools?.add(update.toolCallId)
          this.touchUnsolicitedTurn(live)
        }
        return
      }
      case "usage_update":
        // Keep the file in reading order: the text this usage reading follows goes first.
        this.flushText(live, false)
        // opencode reports `used: 0` on a cancelled turn (live 2026-09-15); a zero reading is not a
        // measurement and would drop the context dial to empty, so only a positive one is recorded.
        if (update.used > 0) live.writer.append({ kind: "context-usage", at: this.now(), tokens: update.used, window: update.size })
        return
      case "session_info_update":
        if (update.title) live.writer.append({ kind: "title", title: clip(update.title, 200) })
        return
      case "config_option_update":
        this.adoptModel(live, update.configOptions)
        return
      case "plan":
      case "user_message_chunk":
      case "compaction_update":
        return
      case "unknown":
        this.diagnostic(live.slug, "update", `unhandled session/update ${String((update.raw as { sessionUpdate?: unknown })?.sessionUpdate)}`)
        return
    }
  }

  private recordToolResult(live: LiveSession, tc: AcpToolCallUpdate): void {
    const meta = live.tools.get(tc.toolCallId)
    if (meta?.status === "completed" || meta?.status === "failed") return // already recorded
    if (meta) meta.status = tc.status
    live.turn?.openTools?.delete(tc.toolCallId)
    // opencode's `tool_call` carries neither `rawInput` nor `locations`; both arrive on the completing
    // `tool_call_update` (live 2026-09-15). The result record carries them so the drawer's "edited N
    // files" can name the file instead of the tool.
    const input = tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput as Record<string, unknown> : undefined
    live.writer.append({ kind: "tool-result", at: this.now(), id: tc.toolCallId, text: clip(toolResultText(tc), 20_000), acp: { ...(tc.status ? { kind: tc.status } : {}), ...(meta?.locations?.length ? { locations: meta.locations } : {}), ...(input && Object.keys(input).length ? { input } : {}) } })
    this.touchUnsolicitedTurn(live)
  }

  // ---- the agent asking us ------------------------------------------------------------------------

  private async handleRequest(live: LiveSession, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") return this.handlePermission(live, params)
    // fs/* and terminal/* were not advertised in clientCapabilities; an agent that calls them anyway
    // gets the spec's answer and does its own I/O.
    throw new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, `ntwine does not implement ${method}`)
  }

  private handlePermission(live: LiveSession, params: unknown): Promise<AcpRequestPermissionResult> {
    const parsed = AcpRequestPermissionParams.safeParse(params)
    const cancelled: AcpRequestPermissionResult = { outcome: { outcome: "cancelled" } }
    if (!parsed.success) {
      log.warn("acp", `[${live.slug}] malformed session/request_permission; cancelling`)
      this.diagnostic(live.slug, "permission", "malformed permission request; cancelling")
      return Promise.resolve(cancelled)
    }
    const store = this.options.interactions
    const reject = parsed.data.options.find((o) => o.kind === "reject_once") ?? parsed.data.options.find((o) => o.kind === "reject_always")
    const failClosed: AcpRequestPermissionResult = reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : cancelled
    if (!store) { this.diagnostic(live.slug, "permission", "no interaction store; denying the request"); return Promise.resolve(failClosed) }
    const built = buildAcpPermissionInteraction(parsed.data, { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId, cwd: live.cwd }, { id: live.agent.id, label: live.agent.label })
    if (!built) {
      log.warn("acp", `[${live.slug}] permission request ${parsed.data.toolCall.toolCallId} could not be represented as a card; denying`)
      this.diagnostic(live.slug, "permission", "request could not be represented as a card; denying")
      live.writer.append({ kind: "acp-note", at: this.now(), text: "Denied a permission request that could not be represented as a card." })
      return Promise.resolve(failClosed)
    }
    const scope: InteractionSessionScope = { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId }
    let id: string
    try { id = store.create(built.request).interaction.id } catch (err) {
      const msg = (err as Error).message
      log.warn("acp", `[${live.slug}] could not record permission card ${parsed.data.toolCall.toolCallId}: ${msg}`)
      this.diagnostic(live.slug, "permission", `could not record the approval: ${msg}`)
      live.writer.append({ kind: "acp-note", at: this.now(), text: `Denied a permission request that could not be recorded (${clip(msg, 200)}).` })
      return Promise.resolve(failClosed)
    }
    return new Promise<AcpRequestPermissionResult>((resolve) => {
      live.pendingPerms.set(id, { resolve, optionByDecision: built.optionByDecision, scope })
      this.options.onStatusChange?.()
    })
  }

  /** Cancel every open card for a session that can no longer answer one, answering the agent
   *  `cancelled` for each. Hygiene, so it never throws. */
  private retirePermissions(live: LiveSession, reason: "turn-ended" | "provider-cancelled"): void {
    if (!live.pendingPerms.size) return
    const store = this.options.interactions
    let swept: Array<{ id: string }> = []
    try { swept = store?.cancelForSession(live.slug, live.sessionId, reason) ?? [] } catch { /* hygiene */ }
    for (const record of swept) live.pendingPerms.get(record.id)?.resolve({ outcome: { outcome: "cancelled" } })
    for (const [id, pending] of live.pendingPerms) { pending.resolve({ outcome: { outcome: "cancelled" } }); live.pendingPerms.delete(id) }
  }
}

export function createAcpBridge(options: AcpBridgeOptions): AcpBridge { return new AcpBridge(options) }
