// Provider-local protocol for the disabled Claude Agent SDK foundation. Nothing in this file imports
// the Anthropic SDK: callers depend on these bounded, versioned shapes rather than on an expansive
// provider type union. The adapter is the sole translation boundary.

import type { ThreadSkillSource } from "@ntwine/shared"

export const CLAUDE_AGENT_SDK_PROTOCOL_VERSION = 1 as const
export const CLAUDE_AGENT_SDK_MAX_INPUT_BYTES = 64 * 1024
export const CLAUDE_AGENT_SDK_MAX_JSON_BYTES = 64 * 1024
export const CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES = 128 * 1024
export const CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES = 4 * 1024
export const CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS = 64
export const CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS = 256

const encoder = new TextEncoder()
// Keep ordinary tab/newline/CR available to message bodies, but reject the rest of the Unicode
// control/format/surrogate/line-separator families. Enumerating only the familiar bidi controls
// misses newer/deprecated format controls, tag characters, and lone surrogates.
const UNSAFE_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

// Tab, newline and CR — the three control codes a message body legitimately contains.
const DELIVERABLE_CONTROL_CODES = new Set([9, 10, 13])

/**
 * Is this prompt body undeliverable, as opposed to merely containing invisible characters?
 *
 * The operator's OWN prompt text is a different class from every other string crossing this membrane,
 * and applying `UNSAFE_TEXT` to it refused ORDINARY text. That policy strips the whole `\p{Cf}` family
 * because a bidi control in a rendered tool argument is a spoofing surface, and a control byte in a
 * permission `input` decides what the provider executes. A prompt body is neither: it is the human's
 * own words on their way into a user message's `content` — no shell, no rendering authority, and no
 * framing risk (the broker frame is JSON.stringify'd, which escapes every one of these).
 *
 * U+200D ZERO WIDTH JOINER is `\p{Cf}`, so every multi-part emoji (👩‍💻, 🏳️‍🌈, 👨‍👩‍👧) was refused, along
 * with a pasted BOM, a zero-width space and a soft hyphen. And because the daemon swallowed the
 * refusal (`claude-agent-broker.ts`) the message then VANISHED while ntwine's RPC answered success.
 * Measured live in `_live_broker_input_drop.mts`: one sentence delivered plain, and the same sentence
 * disappeared with a single emoji appended. The identical bytes typed straight into a `claude` CLI go
 * through untouched, so the broker path was silently stricter than the provider itself for the same
 * prompt.
 *
 * What stays refused is what is genuinely undeliverable: LONE surrogates (not encodable as UTF-8 on
 * the wire) and the C0/C1 control ranges. Iterating by code point is load-bearing — a valid surrogate
 * PAIR is one astral code point and must pass, which is what makes emoji work at all.
 */
export function hasUndeliverableInputText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) return true // lone surrogate
    if (code === 0x2028 || code === 0x2029) return true // line/paragraph separator (Zl/Zp)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      if (!DELIVERABLE_CONTROL_CODES.has(code)) return true
    }
  }
  return false
}

export type ClaudeJsonScalar = string | number | boolean | null
export type ClaudeJson = ClaudeJsonScalar | ClaudeJson[] | { [key: string]: ClaudeJson }
export type ClaudeJsonObject = { [key: string]: ClaudeJson }

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"

// A capability a broker DAEMON advertises in its on-disk record, so the bridge can tell a daemon this
// build forked from one a PREVIOUS build left running (they are detached and idle for six hours, so a
// ntwine upgrade routinely reattaches to an old one and no handshake would reveal the difference).
//
// This one covers input ADDRESSING. A pre-2026-07-28 daemon validates an input message with a
// validator that drops `parentToolUseId`, so a sub-agent steer sent to it arrives unaddressed — and an
// unaddressed steer is not a no-op, it is a message the PARENT obeys as if the operator had typed it
// into the thread composer. The bridge refuses rather than misdeliver.
//
// It lives HERE, in the pure protocol module, and deliberately not in claude-agent-broker.ts: that
// file is the detached daemon's process entry point and throws at module scope when loaded as one
// without NTWINE_CLAUDE_BROKER. In the promoted artifact everything is a single bundle, so importing a
// VALUE from it initializes it inside the SERVER process, the entry-point check passes on the bundle's
// own path, and the guard takes down the control plane at boot — green on dev source, dead on the
// artifact.
export const CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER = "subagent-steer-v1"

// This one covers taking a queued follow-up BACK out of the CLI's command queue (the
// `cancel_async_message` control request, reached through the daemon's `cancel-input` frame). A
// pre-2026-07-28 daemon has no handler for that frame and answers nothing at all, so the request
// would sit until its timeout and then read as "the daemon is wedged" rather than "this session is
// too old". The bridge refuses up front instead — and refusing matters more here than it would for a
// cosmetic capability: the operator is being told whether the agent will still read their message.
export const CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT = "cancel-input-v1"

// This one covers a REAL sub-agent stop through the Agent SDK's `Query.stopTask(taskId)`. Without
// the capability gate a server upgraded in place would send `stop-task` to a surviving older daemon,
// which would ignore the unknown frame and leave the UI claiming work was stopped when it was not.
export const CLAUDE_BROKER_CAPABILITY_STOP_TASK = "stop-task-v1"

// This one covers reloading the worker plugin closure IN PLACE through the Agent SDK's
// `Query.reloadPlugins()` — the same thing `/reload-plugins` drives interactively. It exists because
// the only way ntwine could previously pick up an edited hook, skill, agent profile or MCP tool was to
// restart the worker process, which throws away the conversation to apply a file change the running
// session could have re-read. Same gate reasoning as stop-task: an older surviving daemon ignores the
// unknown frame, so the bridge refuses up front rather than letting the UI claim a reload happened.
//
// Since 2026-10-11 a daemon reloads ITSELF between turns (claude-plugin-sync.ts) and no server asks:
// the button, its RPC and the bridge's verb are gone. The daemon still advertises this and still
// answers the frame, so that an older server attached to it after a downgrade keeps a working button.
export const CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS = "reload-plugins-v1"

// On-demand re-title through the SDK's `generateSessionTitle`. It replaces typing `/rename` at an
// interactive `claude` prompt — the last user-facing verb that still needed a terminal — so the
// affordance survives the retirement of that transport instead of being deleted with it. Gated like the
// others: an older surviving daemon ignores the frame, and the operator would be left watching a
// rename that never happened.
//
// No current server asks: the re-title moved to Ntwine's own namer, and its button, RPC and the
// bridge's verb were removed on 2026-10-14. The daemon still advertises this and still answers the
// frame, so that an older server attached to it after a downgrade keeps a working rename.
export const CLAUDE_BROKER_CAPABILITY_RENAME = "rename-v1"

// Listing the session's invocable skills through the SDK's `supportedCommands()` — the harness's own
// discovery, so ntwine never re-implements skill resolution (plugins, project, global, enable state)
// and never drifts from it. Read-only and cosmetic, but gated like the mutating verbs for the same
// mechanical reason: an older surviving daemon ignores the unknown frame and the client would sit out
// its deadline reporting "the session did not answer" instead of "this session is too old".
export const CLAUDE_BROKER_CAPABILITY_LIST_SKILLS = "list-skills-v1"

// Mounting one of the operator's user-scope MCP servers into the LIVE session, through the SDK's
// `setMcpServers` — what answering an `ntwinectl mcp-request` card with a grant does. Gated like the
// rest: an older daemon ignores the frame, and the grant then reaches the thread at its next fork.
export const CLAUDE_BROKER_CAPABILITY_MOUNT_MCP = "mount-mcp-v1"

// An ACKNOWLEDGED input: the `input` frame carries a `requestId`, and the daemon answers it with an
// `input-result` once the session has taken the message into its input queue (or with the error that
// refused it). Before this the input frame was the one control action with NO reply, so a follow-up
// "succeeded" the moment a frame was handed to the client — including a frame buffered for a socket
// that never came back, which the client then dropped on its 30s give-up. That is how "GO!!" was
// recorded as delivered on 2026-09-30 while no daemon ever received it. Gated like the others because
// a daemon forked by an older build outlives the upgrade by hours and would never answer: the bridge
// only waits for the reply when the record advertises this, and otherwise settles for the frame having
// been WRITTEN to a connected socket, which still closes the never-connected hole.
export const CLAUDE_BROKER_CAPABILITY_INPUT_ACK = "input-ack-v1"

// One invocable skill, as the harness reports it. `name` is what `/name` invokes; `description` is the
// skill's own frontmatter line, for the composer typeahead to render. `source` is where claude
// resolved it from, normalized to the shared vocabulary — undefined when claude did not say, which the
// typeahead renders as an unlabelled row.
export interface ClaudeSkillInfo {
  name: string
  description: string
  source?: ThreadSkillSource
  // A built-in COMMAND rather than a skill — see ThreadSkill.command.
  command?: true
}

// What a reload actually changed, bounded for the wire. Counts rather than full lists because the
// operator is answering "did my edit land?", not auditing the closure — and `mcpServers` carries names
// because a reload that CHANGES MCP tools is the one case with a real cost (the provider re-reads the
// whole conversation instead of using the prompt cache), so it is worth naming.
export interface ClaudePluginReload {
  plugins: number
  commands: number
  agents: number
  mcpServers: string[]
  errorCount: number
}

export interface ClaudeInputMessage {
  id: string
  text: string
  // ADDRESSING. Absent/undefined ⇒ the message is a top-level turn for the session's main thread —
  // every follow-up ntwine has ever sent. SET to a live Agent-tool dispatch's `tool_use_id` ⇒ the CLI
  // routes the message INTO that running sub-agent's own conversation instead, which is how a human
  // steers a child mid-flight. Verified live against claude 2.1.220 / SDK 0.3.207: a message carrying
  // the child's tool_use_id reached the child (it acted on it, and only the CHILD's subagent JSONL
  // carried the token) while the same session's null-addressed control reached only the main thread.
  // There is no control-request equivalent — this field IS the entire steering channel.
  parentToolUseId?: string
}

export interface ClaudeCommandCapability {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
}

export interface ClaudeModelCapability {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort: boolean
  supportedEffortLevels: string[]
  supportsAdaptiveThinking: boolean
  supportsFastMode: boolean
}

export interface ClaudeAgentCapability {
  name: string
  description: string
  model?: string
}

export interface ClaudeControlInitialization {
  commands: ClaudeCommandCapability[]
  agents: ClaudeAgentCapability[]
  outputStyle: string
  availableOutputStyles: string[]
  models: ClaudeModelCapability[]
}

export interface ClaudeSessionInitEvent {
  kind: "init"
  protocolVersion: typeof CLAUDE_AGENT_SDK_PROTOCOL_VERSION
  sessionId: string
  messageId: string
  claudeCodeVersion: string
  cwd: string
  model: string
  permissionMode: ClaudePermissionMode
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
  slashCommands: string[]
  skills: string[]
  plugins: Array<{ name: string; path: string }>
  capabilities: string[]
}

export interface ClaudeAssistantEvent {
  kind: "assistant"
  sessionId: string
  messageId: string
  parentToolUseId?: string
  text: string[]
  toolUses: Array<{ id: string; name: string; input: ClaudeJsonObject }>
  supersedes: string[]
}

export interface ClaudeUserEvent {
  kind: "user"
  sessionId?: string
  messageId?: string
  parentToolUseId?: string
  text: string[]
  toolResultIds: string[]
  synthetic: boolean
}

export interface ClaudeResultEvent {
  kind: "result"
  sessionId: string
  messageId: string
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  isError: boolean
  stopReason?: string
  result?: string
  errors: string[]
  /**
   * The context SIZE of every model this session billed against, keyed by the SDK's own model alias
   * (`modelUsage`). This is the ONLY place Claude names a context window: the JSONL records what each
   * request carried but never what it could have carried, and neither the `init` event nor the
   * control-initialize `models` capability list mentions it. Keyed rather than flattened because a
   * session that dispatched sub-agents bills several models at once and the windows differ — the main
   * thread's row is the one that describes the main thread's context. The alias matters as much as the
   * model does: `claude-opus-5[1m]` reports 1_000_000 where plain `claude-opus-5` MAY report either
   * 1_000_000 or 200_000 — the window is granted by the SUBSCRIPTION, not by the alias alone. Measured
   * 2026-08-18 on the maintainer's account: bare `opus` and bare `sonnet` both report 1_000_000 (so the
   * `[1m]` suffix changes nothing there), while issue #19 reports a bare alias landing on 200_000 for a
   * different subscription tier. So the same alias names two different windows on two accounts, which is
   * precisely why a hardcoded per-model table would be wrong rather than merely stale — reading it off
   * `modelUsage` per session is the only correct source.
   * Optional/bounded — informational, and a build that stops reporting it must cost the readout, never
   * the session.
   */
  modelContextWindows?: Record<string, number>
  /**
   * What Claude Code prices the session at so far (`total_cost_usd`), at API rates whatever the plan.
   * Cumulative for the session — a resumed session carries its earlier cost forward — so the latest
   * reading is the whole figure. Optional for the same reason as the windows: it is telemetry.
   */
  totalCostUsd?: number
}

export interface ClaudePromptSuggestionEvent {
  kind: "prompt-suggestion"
  sessionId: string
  messageId: string
  suggestion: string
}

/** Provider-reported cost of a background task so far. Every field optional — informational only. */
export interface ClaudeTaskUsage {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

/**
 * SUB-AGENT / BACKGROUND-TASK LIFECYCLE, as the Agent SDK actually reports it.
 *
 * These ride `type:"system"` messages (`task_started`, `task_updated`, `task_progress`,
 * `task_notification`, `background_tasks_changed`) and used to flatten into `ClaudeOtherEvent` — two
 * strings, whole payload discarded. That discard is why the tailer reconstructs child lifecycle by
 * REGEX-MATCHING ENGLISH PROSE out of launch acks and `<task-notification>` blocks, a path whose own
 * comments record three separate phantom-sub-agent leaks.
 *
 * They are STREAM-ONLY: probed against the broker's exact `persistSession:true` config, task_started /
 * task_progress / task_notification all appear on the SDK stream and NONE of them in the on-disk
 * JSONL. So the payload exists only if it survives this boundary.
 *
 * EVERY field except `kind`/`phase` is optional and informational, because the mapper is required to
 * DEGRADE rather than throw (see mapAssistant's incident note in claude-agent-sdk.ts): a task event
 * ntwine cannot fully represent must cost that event's detail, never the session.
 */
export interface ClaudeTaskEvent {
  kind: "task"
  /**
   * Which system message this came from.
   *  - "started"      task_started — a child/background op began
   *  - "progress"     task_progress — rolling activity: last tool, summary, usage
   *  - "updated"      task_updated — a status/description patch
   *  - "notification" task_notification — terminal (completed/failed/stopped) + output file
   *  - "level"        background_tasks_changed — the FULL live set, REPLACE semantics (see `tasks`)
   */
  phase: "started" | "updated" | "progress" | "notification" | "level"
  sessionId?: string
  messageId?: string
  /** The runtime task id — the handle a `TaskStop` references and every notification carries. */
  taskId?: string
  /** The dispatch tool_use id, when the SDK supplies it: the tailer's own correlation key. */
  toolUseId?: string
  description?: string
  /** `task_notification.status`, or `task_updated.patch.status`. Open set — never switch exhaustively. */
  status?: string
  summary?: string
  lastToolName?: string
  subagentType?: string
  taskType?: string
  outputFile?: string
  error?: string
  usage?: ClaudeTaskUsage
  /**
   * phase "level" ONLY: every live background task after the change. REPLACE semantics — swap your set
   * for this payload rather than pairing start/stop edges, so a missed bookend cannot wedge a stale
   * "running" row. Per-process: nothing is emitted at startup.
   */
  tasks?: Array<{ taskId: string; taskType?: string; description?: string }>
}

export interface ClaudeOtherEvent {
  kind: "other"
  type: string
  subtype?: string
  sessionId?: string
  messageId?: string
}

export type ClaudeQueryEvent =
  | ClaudeSessionInitEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudePromptSuggestionEvent
  | ClaudeTaskEvent
  | ClaudeOtherEvent

export interface ClaudePermissionRequest {
  requestId: string
  toolUseId: string
  agentId?: string
  toolName: string
  input: ClaudeJsonObject
  blockedPath?: string
  decisionReason?: string
  /** WHICH check escalated: the CLI's `decision_reason_type` (`safetyCheck`, `subcommandResults`, `rule`,
   *  `workingDir`, `other`, …), a field the SDK forwards but does not declare. Advisory only — absent from
   *  a daemon forked before 2026-10-06, and dropped rather than refused when it is not a plain word. */
  decisionReasonType?: string
  /** A `permissions.ask` rule forced this prompt (the SDK's `matchedAskRule`, which rides here instead of
   *  `decisionReasonType: "rule"` when the tool minted a richer reason of its own). */
  ruleForced?: boolean
  title?: string
  displayName?: string
  description?: string
  suggestions: ClaudeJsonObject[]
}

export type ClaudePermissionDecision =
  | { behavior: "allow"; updatedInput?: ClaudeJsonObject; updatedPermissions?: ClaudeJsonObject[] }
  | { behavior: "deny"; message: string; interrupt?: boolean }

export interface ClaudeElicitationRequest {
  serverName: string
  message: string
  mode?: "form" | "url"
  url?: string
  elicitationId?: string
  requestedSchema?: ClaudeJsonObject
  title?: string
  displayName?: string
  description?: string
}

export type ClaudeElicitationResult =
  | { action: "accept"; content?: ClaudeJsonObject }
  | { action: "decline" | "cancel" }

export interface ClaudeInterruptReceipt {
  stillQueued: string[]
}

export type ClaudeDiagnostic =
  | { kind: "stderr"; message: string; truncated: boolean }
  | { kind: "lifecycle"; phase: "started" | "closed" | "crashed"; message?: string }

/**
 * The opening of the daemon's refused-input diagnostic. A `stderr` diagnostic is otherwise ordinary
 * provider noise, so this prefix is the only thing that distinguishes "the agent never saw the
 * operator's message" from a log line — and the daemon that writes it and the server that logs it are
 * different processes, which is exactly why it is a shared constant rather than a string in each.
 */
export const CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX = "input dropped, the agent never received it"

export type ClaudeCanUseTool = (
  request: ClaudePermissionRequest,
  context: { signal: AbortSignal },
) => Promise<ClaudePermissionDecision>

export type ClaudeOnElicitation = (
  request: ClaudeElicitationRequest,
  context: { signal: AbortSignal },
) => Promise<ClaudeElicitationResult>

export class ClaudeAgentSdkProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeAgentSdkProtocolError"
  }
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

export function safeText(value: unknown, label: string, maxBytes = CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES): string {
  if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError(`${label} must be text`)
  const cleaned = value.replace(UNSAFE_TEXT, "�")
  if (utf8Bytes(cleaned) <= maxBytes) return cleaned
  let low = 0
  let high = cleaned.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(cleaned.slice(0, middle)) <= maxBytes - utf8Bytes("…")) low = middle
    else high = middle - 1
  }
  return `${cleaned.slice(0, low)}…`
}

export function boundedId(value: unknown, label: string): string {
  const id = safeText(value, label, 512)
  if (id.length > 256 || !ID_PATTERN.test(id)) throw new ClaudeAgentSdkProtocolError(`${label} is not a valid opaque id`)
  return id
}

export function boundedOptionalId(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : boundedId(value, label)
}

export function boundedStringArray(value: unknown, label: string, maxItems = 128, itemBytes = 512): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ClaudeAgentSdkProtocolError(`${label} must be a bounded list`)
  return value.map((entry, index) => safeText(entry, `${label}[${index}]`, itemBytes))
}

export function boundedJsonObject(value: unknown, label: string, maxBytes = CLAUDE_AGENT_SDK_MAX_JSON_BYTES): ClaudeJsonObject {
  const state = { nodes: 0 }
  const clone = boundedJson(value, label, state, 0)
  if (clone === null || Array.isArray(clone) || typeof clone !== "object") {
    throw new ClaudeAgentSdkProtocolError(`${label} must be a JSON object`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(clone)
  } catch {
    throw new ClaudeAgentSdkProtocolError(`${label} is not JSON serializable`)
  }
  if (utf8Bytes(encoded) > maxBytes) throw new ClaudeAgentSdkProtocolError(`${label} exceeds ${maxBytes} bytes`)
  return clone
}

function boundedJson(value: unknown, label: string, state: { nodes: number }, depth: number): ClaudeJson {
  state.nodes += 1
  if (state.nodes > 2_048 || depth > 12) throw new ClaudeAgentSdkProtocolError(`${label} is too complex`)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ClaudeAgentSdkProtocolError(`${label} contains a non-finite number`)
    return value
  }
  if (typeof value === "string") {
    if (utf8Bytes(value) > 16 * 1024) throw new ClaudeAgentSdkProtocolError(`${label} contains oversized text`)
    if (UNSAFE_TEXT.test(value)) {
      UNSAFE_TEXT.lastIndex = 0
      throw new ClaudeAgentSdkProtocolError(`${label} contains unsafe text`)
    }
    UNSAFE_TEXT.lastIndex = 0
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new ClaudeAgentSdkProtocolError(`${label} contains too many array items`)
    return value.map((entry, index) => boundedJson(entry, `${label}[${index}]`, state, depth + 1))
  }
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError(`${label} contains a non-JSON value`)
  const entries = Object.entries(value)
  if (entries.length > 256) throw new ClaudeAgentSdkProtocolError(`${label} contains too many object fields`)
  const output: ClaudeJsonObject = {}
  for (const [key, entry] of entries) {
    if (RESERVED_KEYS.has(key) || utf8Bytes(key) > 256 || UNSAFE_TEXT.test(key)) {
      UNSAFE_TEXT.lastIndex = 0
      throw new ClaudeAgentSdkProtocolError(`${label} contains an invalid object key`)
    }
    UNSAFE_TEXT.lastIndex = 0
    output[key] = boundedJson(entry, `${label}.${key}`, state, depth + 1)
  }
  return output
}

export function validateInputMessage(value: ClaudeInputMessage): ClaudeInputMessage {
  const id = boundedId(value.id, "input.id")
  if (typeof value.text !== "string") throw new ClaudeAgentSdkProtocolError("input.text must be text")
  if (utf8Bytes(value.text) > CLAUDE_AGENT_SDK_MAX_INPUT_BYTES) {
    throw new ClaudeAgentSdkProtocolError(`input.text exceeds ${CLAUDE_AGENT_SDK_MAX_INPUT_BYTES} bytes`)
  }
  // User input is an authority-bearing provider instruction, not presentation metadata. Never
  // silently replace controls or truncate: the accepted bytes must be exactly the bytes the caller
  // supplied, so this REFUSES rather than sanitizing — and the refusal has to reach the operator,
  // which is why the bridge validates before `sendInput` and the daemon reports what it drops.
  //
  // The class is `hasUndeliverableInputText`, NOT the display-grade `UNSAFE_TEXT`: see its doc for why
  // a prompt body must be allowed to carry the zero-width joiner that every multi-part emoji is built
  // from. Every other string on this membrane keeps the strict policy.
  const text = value.text
  if (hasUndeliverableInputText(text)) throw new ClaudeAgentSdkProtocolError("input.text contains unsafe text")
  // Addressing is an opaque provider id (`toolu_…`), validated on the same bounded-id path as every
  // other id that crosses this membrane. Omitted stays omitted — the adapter turns that into the
  // null the SDK expects for a main-thread turn, so an unaddressed send is byte-identical to before.
  const parentToolUseId = boundedOptionalId(value.parentToolUseId, "input.parentToolUseId")
  return parentToolUseId === undefined ? { id, text } : { id, text, parentToolUseId }
}

export function validatePermissionMode(value: unknown): ClaudePermissionMode {
  if (typeof value === "string" && ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(value)) {
    return value as ClaudePermissionMode
  }
  throw new ClaudeAgentSdkProtocolError("permission mode is unsupported")
}

export function validatePermissionDecision(value: ClaudePermissionDecision): ClaudePermissionDecision {
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError("permission decision must be an object")
  if (value.behavior === "allow") {
    if (value.updatedPermissions !== undefined && (!Array.isArray(value.updatedPermissions) || value.updatedPermissions.length > 32)) {
      throw new ClaudeAgentSdkProtocolError("permission.updatedPermissions must be a bounded list")
    }
    return {
      behavior: "allow",
      ...(value.updatedInput === undefined ? {} : { updatedInput: boundedJsonObject(value.updatedInput, "permission.updatedInput") }),
      ...(value.updatedPermissions === undefined ? {} : {
        updatedPermissions: value.updatedPermissions.map((entry, index) => boundedJsonObject(entry, `permission.updatedPermissions[${index}]`, 16 * 1024)),
      }),
    }
  }
  if (value.behavior === "deny") {
    if (value.interrupt !== undefined && typeof value.interrupt !== "boolean") {
      throw new ClaudeAgentSdkProtocolError("permission.interrupt must be boolean")
    }
    return {
      behavior: "deny",
      message: safeText(value.message, "permission.message", 8 * 1024),
      ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
    }
  }
  throw new ClaudeAgentSdkProtocolError("permission decision behavior is unsupported")
}

export function validateElicitationResult(value: ClaudeElicitationResult): ClaudeElicitationResult {
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError("elicitation result must be an object")
  if (value.action === "accept") {
    return value.content === undefined
      ? { action: "accept" }
      : { action: "accept", content: boundedJsonObject(value.content, "elicitation.content") }
  }
  if (value.action === "decline" || value.action === "cancel") {
    if ("content" in value && value.content !== undefined) {
      throw new ClaudeAgentSdkProtocolError("declined or cancelled elicitation must not contain form content")
    }
    return { action: value.action }
  }
  throw new ClaudeAgentSdkProtocolError("elicitation action is unsupported")
}
