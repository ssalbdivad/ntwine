import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { InteractionLifecycle, InteractionOpaqueId, InteractionRevision, InteractionThreadSlug } from "./interactions.ts"
import { ThreadSlug } from "./thread-slug.ts"
import { insideCodeFence } from "./code-fences.ts"
import { ProjectSchedules, ThreadScheduleRef } from "./schedules.ts"
import { formatDeadlineLeft, ThreadDeadlineView } from "./deadline.ts"
import { EDITOR_COMPOSE_MAX_TEXT, EDITOR_MAX_FOLDERS, EDITOR_MAX_PATH, EDITOR_PROTOCOL_VERSION, EDITOR_REVIEW_MAX_CHECKOUTS, EDITOR_REVIEW_MAX_FILES, EDITOR_STATE_MAX_DIAGNOSTICS, EDITOR_STATE_MAX_MESSAGE, EDITOR_STATE_MAX_OPEN, EDITOR_STATE_MAX_SELECTION_TEXT, EDITOR_STATE_MAX_TAG, type EditorClientMessage, type EditorComposeInput, type EditorReviewTarget, type EditorSnapshot, type EditorWindowSummary } from "./editor-protocol.ts"
import type { TranscriptPatchOp } from "./transcript-delta.ts"

// ---- Attachment intake (drag/drop, paste, file picker) ----
// What a worker can actually GET AT. A format qualifies two ways: an agent's Read/file tool consumes
// it with no conversion step (images, PDF, text, code), or its bytes are a documented container the
// agent cracks with a tool it installs in one command — openpyxl/pandas for a spreadsheet, python-docx
// and python-pptx for a document, duckdb/pyarrow for a columnar dump, the sqlite3 CLI for a database,
// unzip/tar for an archive, and pandoc or LibreOffice (often already on the machine) for most of the
// rest. Office, columnar and archive formats were REFUSED until 2026-08-27 on the theory that they'd
// reach the agent as opaque zip/XML garbage; that underrates the agent, and the cost of the refusal
// landed on the person, who had to convert the file by hand before ntwine would take it. A dropped file
// lands on disk and its absolute path — inserted as plain text into the message — is what the worker
// opens; nothing here is parsed, rendered or extracted by ntwine itself.
//
// Widening this list widens NOTHING else. /local-image serves only its own content-type map (which
// mirrors ATTACHMENT_IMAGE_EXTENSIONS), and the desktop-open action gates on trusted ROOTS rather than
// on extension (local-file.ts). What the list decides is exactly: what /attach writes to disk, what the
// file picker offers, and which standalone path lines become openable chips (web lib/imagePaths.ts).

// Inline-renderable raster images: served back to the chat via the gated /local-image proxy and seen
// visually by the agent. SVG is DELIBERATELY not here — it is an XSS vector when served as an image
// (which is why the server's /local-image content-type map omits it), so an attached .svg is treated
// as a document (an openable chip + the agent reads its XML), never rendered inline.
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const
// Read straight as text by both backends — or, for PDF, rendered natively by Claude's Read.
export const ATTACHMENT_TEXT_EXTENSIONS = [
  "pdf", "svg", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sql",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php", "swift", "lua", "r",
] as const
// Office and open-document formats. Each is a zip of XML (or, for the pre-2007 binaries, a documented
// OLE container) that one install reads: openpyxl, python-docx, python-pptx, odfpy, striprtf.
export const ATTACHMENT_OFFICE_EXTENSIONS = [
  "xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
] as const
// Analytical dumps. duckdb and pyarrow read the whole columnar set; the sqlite3 CLI ships with macOS
// and most Linux; .ipynb is JSON, which Claude's Read renders as cells and NotebookEdit writes back.
export const ATTACHMENT_DATA_EXTENSIONS = [
  "parquet", "avro", "orc", "arrow", "feather", "ipynb", "db", "sqlite", "sqlite3",
] as const
// Archives. `unzip` and `tar` are on every machine an agent runs on, and refusing a .zip while
// accepting .docx — which IS a zip — was never coherent. ntwine never extracts one: the file sits on
// disk and the worker unpacks it deliberately, or does not.
export const ATTACHMENT_ARCHIVE_EXTENSIONS = ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z"] as const
// Everything that is NOT rendered inline as an image: the chip set, and the alternation behind the
// chat's standalone-path detection.
export const ATTACHMENT_DOC_EXTENSIONS = [
  ...ATTACHMENT_TEXT_EXTENSIONS,
  ...ATTACHMENT_OFFICE_EXTENSIONS,
  ...ATTACHMENT_DATA_EXTENSIONS,
  ...ATTACHMENT_ARCHIVE_EXTENSIONS,
] as const
export const ATTACHMENT_EXTENSIONS = [...ATTACHMENT_IMAGE_EXTENSIONS, ...ATTACHMENT_DOC_EXTENSIONS] as const

// Cap on the /attach base64 payload (~chars). A screenshot is small; a PDF can be larger, so the cap
// is generous but bounded — base64 is ~4/3 the byte size, so this is ~18MB of binary.
export const ATTACHMENT_MAX_BASE64_CHARS = 25_000_000
// The equivalent RAW-byte budget (base64 inflates ~4/3), for a client-side pre-check that rejects an
// oversized file with a clear message before it spends time encoding a doomed upload.
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_MAX_BASE64_CHARS / 4) * 3

const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTENSIONS)
// Lowercased extension (no dot) of a filename, or "" when it has none.
export function attachmentExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}
export function isAllowedAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(attachmentExtension(name))
}
// The <input accept> value for the file picker: every allowed extension as `.ext`.
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")

// ---- ntwine board vocabulary (mirrors board/config.mjs) ----

// Declaration order IS the lifecycle order (STATUS_ORDER = NtwineStatus.options), consumed by the
// status pickers and the roadmap-count ordering. `needs-human` is a FIRST-CLASS status — the declared
// "awaiting a human" state and THE queue definition — and sits at the human gate between `active`
// (work in flight) and `blocked` (now narrowed to machine-waits only: blocking_threads / revalidate_at).
export const NtwineStatus = z.enum(["planning", "planned", "active", "needs-human", "blocked", "done", "dismissed"])
export type NtwineStatus = z.infer<typeof NtwineStatus>

// How a blocked thread unblocks. `human` = the awaiting-you queue.
export const BlockMechanism = z.enum(["human", "threads", "timer"])
export type BlockMechanism = z.infer<typeof BlockMechanism>

// ---- Runtime state of the Claude process bound to a thread ----

export const RuntimeState = z.enum([
  "none", // no session ever spawned for this thread
  "spawning",
  "running", // process alive, turn in flight
  "perm-prompt", // process alive, parked on a permission request a person has not answered yet
  "turn-idle", // process alive, waiting at the prompt
  "exited", // the worker process that owned this session is gone, or is no longer driving its turn
])
export type RuntimeState = z.infer<typeof RuntimeState>

// Which agent CLI a dispatch/thread runs on (Codex-support epic, Phase 3). Mirrors BackendKind in
// server/backend/types.ts (the wire can't import it — it lives behind the server boundary). A model
// selection drives this: a Claude model ⇒ "claude", an OpenAI/GPT model ⇒ "codex", an `acp:<agent>`
// slug ⇒ "acp" (any Agent Client Protocol agent; plans/acp-backend.md).
export const Backend = z.enum(["claude", "codex", "acp"])
export type Backend = z.infer<typeof Backend>

// One selectable Codex model, derived server-side from the AUTHORITATIVE ~/.codex/models_cache.json
// (the codexModels RPC) rather than a hand-maintained list — the source of two live breakages (a bare
// `gpt-5.6` that codex 400s, and a single hardcoded effort set that's wrong per-model). `slug` is the
// `codex -m` id; `efforts` is exactly that model's supported reasoning levels (5.6 → …/max/ultra, 5.5 →
// …/xhigh), so the effort dropdown offers only what the chosen model actually accepts. Ordered by the
// cache's `priority` (index 0 = the codex default). See .ntwine/codex-model-cache.md.
export const CodexModel = z.object({
  slug: z.string(),
  displayName: z.string(),
  defaultEffort: z.string(),
  efforts: z.array(z.string()),
  // The model's stock context window and the largest one it accepts, in tokens, straight from the
  // cache's `context_window` / `max_context_window` (272K / 872K on GPT-5.6, 128K / 128K on Spark).
  // The Settings "Context window" presets are built from these so the drawer names the numbers codex
  // will actually run at (maintainer 2026-09-11: "reflect the actual numbers"). Optional: a cache from
  // before the fields existed, or the degraded fallback, simply carries neither.
  contextWindow: z.number().int().positive().optional(),
  maxContextWindow: z.number().int().positive().optional(),
})
export type CodexModel = z.infer<typeof CodexModel>

// One selectable Claude Code model, as the pinned Claude runtime RESOLVES it (the claudeModels RPC).
// `alias` is the `claude --model` word ntwine dispatches with and keys every preference on ("opus");
// `label` is the resolved edition the operator should read in the picker ("Opus 5.5"), derived from
// the runtime's own `supportedModels()` so the picker names the model the alias will actually run —
// the same reason the Codex column reads "GPT-6 Astra" and not "gpt". `resolvedModel` is the canonical
// wire id behind the alias ("claude-opus-5-5"); absent on the degraded fallback, where `label` is the
// bare family.
export const ClaudeModel = z.object({
  alias: z.string(),
  label: z.string(),
  resolvedModel: z.string().optional(),
  // The edition alone ("5.5") — the tail of `label`, which the picker sets dimmer than the family word.
  // Absent exactly when `resolvedModel` is.
  edition: z.string().optional(),
})
export type ClaudeModel = z.infer<typeof ClaudeModel>

// The DEGRADED catalogue used while ntwine's pinned Codex runtime has not written a compatible
// `models_cache.json` yet. This is deliberately one shared mirror: the server used to fall back to
// GPT-5.5 alone while the browser's fallback included the current generation, so an older Codex app
// rewriting the machine-wide cache made a model visible in one tab and unavailable in another.
// Keep the order/defaults in step with the pinned runtime's catalogue when that runtime moves.
// Re-read from codex-cli 0.161.0 on 2026-10-08 (unchanged from 0.160.1 on 2026-10-05 but for the cache's
// hyphenated display names, which the mirror keeps spaced); defaults vary by model generation. That
// catalogue hides gpt-5.5 (visibility "hide", so the live picker drops it too), which is why the mirror
// no longer lists it.
export const CODEX_MODELS_FALLBACK_VERSION = "0.161.0"
export const CODEX_MODELS_FALLBACK: CodexModel[] = [
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-astra", displayName: "GPT-6 Astra", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-sol", displayName: "GPT-6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-luna", displayName: "GPT-6 Luna", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
]

// An Agent Client Protocol agent ntwine can launch (server/backend/acp-agents.ts). `available` means
// its executable was found on the server's PATH; the composer lists only those, as `acp:<id>` models.
export const AcpAgent = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  available: z.boolean(),
})
export type AcpAgent = z.infer<typeof AcpAgent>

/** The model slug the composer uses for an ACP agent, and its inverses. Model already drives backend in
 *  the web (`backendForModel`), so an agent IS a model there — a slug with this prefix means `acp`.
 *
 *  `acp:<agent>` runs the agent on whatever model its own CLI is configured for; `acp:<agent>@<model>`
 *  asks for one of the models the agent advertises (`session/set_config_option` on the ACP wire). The
 *  separator is `@` because agent model ids carry `/` and `:` themselves (`openai/gpt-5.5`). */
export const ACP_MODEL_PREFIX = "acp:"
export function acpModelSlug(agentId: string, modelId?: string | null): string {
  return `${ACP_MODEL_PREFIX}${agentId}${modelId ? `@${modelId}` : ""}`
}
function acpSlugParts(model: string | null | undefined): { agent: string; model?: string } | undefined {
  if (typeof model !== "string" || !model.startsWith(ACP_MODEL_PREFIX)) return undefined
  const rest = model.slice(ACP_MODEL_PREFIX.length)
  const at = rest.indexOf("@")
  const agent = at === -1 ? rest : rest.slice(0, at)
  const id = at === -1 ? "" : rest.slice(at + 1)
  return agent ? { agent, ...(id ? { model: id } : {}) } : undefined
}
export function acpAgentIdFromModel(model: string | null | undefined): string | undefined { return acpSlugParts(model)?.agent }
export function acpModelIdFromModel(model: string | null | undefined): string | undefined { return acpSlugParts(model)?.model }

/** A model the picker offers as a row of its own, with an effort ladder, although it runs through an
 *  ACP agent: the slug pins agent and model (`acp:<agent>@<model>`), and the thread's effort reaches the
 *  model through the agent's reasoning-effort config option (`category: "thought_level"` on the ACP
 *  wire; OpenCode advertises one per model once the model is set). Any other `acp:` slug keeps the
 *  agent-row-plus-model-dropdown shape and has no effort axis. */
export interface AcpModelPreset {
  agentId: string
  modelId: string
  label: string
  defaultEffort: string
  efforts: readonly string[]
}

// Meta's Muse Wonder models through OpenCode's OpenRouter provider (OPENROUTER_API_KEY in ntwine's
// environment, or `opencode auth login`). OpenCode offers minimal…max for Muse Wonder; the ladder here is
// the part of it ntwine's effort vocabulary already has.
const MUSE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export const ACP_MODEL_PRESETS: readonly AcpModelPreset[] = [
  // Verified live 2026-10-13 (opencode 1.19.0): low and high reach OpenRouter as `reasoning.effort`.
  { agentId: "opencode", modelId: "openrouter/meta/muse-wonder", label: "Muse Wonder", defaultEffort: "medium", efforts: MUSE_EFFORTS },
  // UNTESTED, and expected to be refused today: OpenRouter does not list Muse Wonder Full (2026-10-13),
  // which Meta sells by subscription in Muse Code only (Meta API id `muse-wonder-full-1.0`). The id
  // follows OpenRouter's naming for the day it appears there; until then OpenCode will not switch to it
  // and the dispatch fails rather than running another model.
  { agentId: "opencode", modelId: "openrouter/meta/muse-wonder-full", label: "Muse Wonder Full", defaultEffort: "medium", efforts: MUSE_EFFORTS },
]

/** The preset an ACP model slug names exactly, if any. */
export function acpModelPreset(model: string | null | undefined): AcpModelPreset | undefined {
  const parts = acpSlugParts(model)
  return parts?.model ? ACP_MODEL_PRESETS.find((preset) => preset.agentId === parts.agent && preset.modelId === parts.model) : undefined
}

/** One model an ACP agent advertises, and the probe result the composer's model picker reads. */
export const AcpAgentModel = z.object({ id: z.string(), name: z.string() })
export type AcpAgentModel = z.infer<typeof AcpAgentModel>
export const AcpAgentModels = z.object({
  agentId: z.string(),
  models: z.array(AcpAgentModel),
  /** The model the agent opens a session on when ntwine asks for none. */
  current: z.string().optional(),
  /** Why the list is empty, when the probe could not open a session (not installed, not logged in…). */
  error: z.string().optional(),
  probedAt: z.string(),
})
export type AcpAgentModels = z.infer<typeof AcpAgentModels>
export const AcpAgentModelsInput = z.object({ agentId: z.string().min(1).max(100), refresh: z.boolean().optional() }).strict()
export type AcpAgentModelsInput = z.infer<typeof AcpAgentModelsInput>

// A provider-scoped launch profile. The server is the catalogue authority for existing threads:
// callers receive only models that belong to the row's exact backend and each model carries its
// complete supported effort set. The intentionally generic shape also lets a future backend expose
// its own native ids without teaching the browser how to classify model names.
export const ThreadProfileOption = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  // The edition at the end of `label` ("5.5" of "Opus 5.5"), for a Claude row the pinned runtime resolved.
  edition: z.string().optional(),
  defaultEffort: z.string().min(1),
  efforts: z.array(z.string().min(1)).min(1),
})
export type ThreadProfileOption = z.infer<typeof ThreadProfileOption>

export const ThreadAgent = z.object({
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
})

// A LIVE background sub-agent the thread's worker dispatched and is now resting against — derived by
// the JSONL tailer from Agent-tool dispatches + their task-notifications, NOT the .ntwine file. This is
// what makes a "dispatched a sub-agent, then came to rest" worker read as in-motion rather than idle.
// `running` = the child's transcript is still being appended to; `stale` = no output for a while (a
// completion record we likely missed). Distinct from `ThreadAgent`/`agents` (ntwine frontmatter).
export const SubAgentView = z.object({
  label: z.string(), // the dispatch's `description` (e.g. "Investigate nubjs/nub GitHub issue 376")
  startedAt: z.string(), // ISO8601 of the dispatch record
  // running — appending to its transcript now. stale — tracked, but quiet past the staleness ceiling.
  // rested — its RUN ended (the harness notified `completed`/`failed`) while its own fan-out kept
  // running. Not a phantom and not a lie: `completed` does not mean finished — the same notification
  // says outright that a stopped agent can be resumed and may notify again — and a child that rests
  // holding live grandchildren used to take the entire branch off the board with it. See anchorRoots in
  // tailer.ts. Only ever emitted for a DIRECT child that still has something running under it, so it
  // clears itself when that work does. Every liveness reading keys on "running", so a rested row holds
  // nothing back: it does not block a rest, hold the queue, or gate Mark-as-done.
  state: z.enum(["running", "stale", "rested"]),
  // The worker-profile cell (model+effort) for the dispatch — RESOLVED, not the raw `subagent_type`:
  // an effort-only profile carries no model, so the server composes it from the call's own `model` or
  // the dispatching turn's (server/subagent-profile.ts). It is NO LONGER drawn as a tag on the child
  // rows under the prompt box (maintainer 2026-07-27: the profile belongs to the prompt box's own
  // control one line up, not repeated on every child line); the transcript's dispatch card shows it,
  // the sidebar rail carries it in the row tooltip, and the drill-in passes it to the drawer.
  // Optional — absent when nothing about the child's runtime is known.
  subagentType: z.string().optional(),
  // The dispatch tool_use id (the stable correlation key: same id on the Agent tool_use block, the
  // completion <task-notification>, and the transcript AgentBlock). Optional — absent on a pre-restart
  // server that doesn't emit it yet → the drill-in drawer's entry point is simply not offered. Present
  // → the banner row / AgentBlock is clickable and resolves this exact child's transcript.
  id: z.string().optional(),
  // The RUNTIME agent id — the `agentId: a01b2d20b32feab11` line of the Agent tool's launch ack, which
  // is the only id the MODEL is ever shown for its child (the tool_use id above is invisible to it). So
  // it is the string a worker writes in an `agents:` fence line or registers a `watch` against, exactly
  // as BgShellView.taskId is for a shell. Every liveness reading accepts both. Absent for a codex row
  // and for a Claude row between its tool_use and its launch ack.
  taskId: z.string().optional(),
  // Can ntwine actually END this child's work right now? Computed SERVER-side (board.ts, the one place
  // holding both the session row and the tailer's telemetry) and never re-derived by a client — the
  // same discipline as `steerable`, and for the same reason: the policy depends on the thread's
  // TRANSPORT, which the browser has no honest way to know.
  //
  // It exists because the × that offers to stop a child must not appear on a row where stopping is
  // impossible (maintainer 2026-07-30: "We shouldn't show the X if it doesn't fucking work"). Only a
  // broker-backed Claude thread has a per-child control channel (`Query.stopTask`); a codex thread runs
  // its sub-agents inside its own app-server process, which exposes no such channel.
  // Absent/false on a pre-restart server's snapshot ⇒ the × is simply not offered on a RUNNING row,
  // which fails toward showing no control rather than a false one.
  stoppable: z.boolean().optional(),
  // ISO8601 of the child transcript's last append (its output file's mtime — the SAME signal that
  // decides running vs stale). Surfaced so a row can show "last active 6 min ago": the state alone only
  // says quiet-for-15-min, not HOW quiet. Optional — absent before the output path resolves, or on a
  // pre-restart server. Minute-bucketed into the board signature server-side, so a running child's
  // steadily-advancing mtime does not spam deltas.
  lastActivityAt: z.string().optional(),
  // ---- what the child is actually DOING, from the provider's own task_* event stream ----
  // A live sub-agent used to be a name and a spinner: start, stop, nothing in between. These come off
  // the Claude Agent SDK's typed task lifecycle (stream-only — none of it is in the session JSONL), so
  // they are present for a BROKER thread and absent for a codex one, an older CLI, or a pre-restart
  // server. Render each only when set; never assume they arrive together.
  activity: z.string().optional(), // the tool the child is running right now (e.g. "Bash", "Edit")
  // What the current step IS, in words — the provider rewrites it per tool call ("Running Print
  // current date and time"). Measured against a real session this is the richest LIVE field: `summary`
  // stayed empty on every progress event and only arrived with the terminal notification.
  activityDetail: z.string().optional(),
  summary: z.string().optional(), // the provider's rolling one-line summary of the child's work
  toolUses: z.number().optional(), // tool calls the child has made so far
  tokens: z.number().optional(), // total tokens the child has spent so far
  durationMs: z.number().optional(), // the provider's own working-time measure (excludes paused)
  // ---- NESTING: a sub-agent's sub-agent, and so on down ----
  // 1 = a child this thread's worker dispatched itself (the only kind that used to reach any surface).
  // 2 = a grandchild, 3 = a great-grandchild, … Its dispatch is in an ANCESTOR's transcript rather than
  // this thread's, so it is derived from claude's flat descendant sidecars, not from the fold — see the
  // DESCENDANTS note in tailer.ts. Absent on a pre-restart server's snapshot, which is why every reader
  // treats absent as 1 (`isDirectSubAgent`) instead of testing for the field.
  depth: z.number().optional(),
  // The dispatch tool_use id of the sub-agent that dispatched THIS one — the `id` of another row in the
  // same list. Absent at depth 1 (the thread itself is the parent). Present → the row indents under it.
  parentId: z.string().optional(),
  // ---- WORKFLOWS: a `Workflow` tool run, and the agents it fans out ----
  // true on the row for the RUN itself — a phased fan-out of many agents behind one tool call, which the
  // row drills into as a tree rather than as a transcript (see WorkflowAgentView).
  workflow: z.boolean().optional(),
  // On a workflow AGENT's row (depth 2, `parentId` = the run's id): the script phase it ran in.
  phase: z.string().optional(),
})
export type SubAgentView = z.infer<typeof SubAgentView>

// A DIRECT sub-agent that has RETURNED while its siblings are still out — what a queued parent's card
// lists beside the ones still running, so "2 of 3 sub-agents returned" can say which two.
//
// The server keeps a ring of every retired child (tailer RETAINED_SUBAGENTS_MAX) and deliberately keeps
// it off the wire; this is the slice of it a card needs, filtered SERVER-side to the returns inside the
// wait that is still open (board.returnedSubAgentsView). The wait opens when the oldest child still out
// was dispatched, so a sibling that came back before the parent even rested counts, and a child from an
// earlier, finished batch does not. Absent whenever no direct sub-agent is running: with nothing out
// there is no "of N" to state.
export const ReturnedSubAgentView = z.object({
  id: z.string(), // the dispatch tool_use id — the same drill-in handle SubAgentView.id is
  label: z.string(),
  // How it ended, as the harness reported it. `killed` is a stop — the human's ×, or an interrupt.
  status: z.enum(["completed", "failed", "killed"]),
  startedAt: z.string().optional(), // ISO8601 of the dispatch
  finishedAt: z.string().optional(), // ISO8601 of its completion notification
  subagentType: z.string().optional(),
})
export type ReturnedSubAgentView = z.infer<typeof ReturnedSubAgentView>

// One agent of a workflow run, as its drawer lists it — every agent the run has started, finished ones
// included, so the run can be browsed after the fact. `id` is the agent id, which is also the drill-in
// handle `subAgentTranscript` resolves.
export const WorkflowAgentView = z.object({
  id: z.string(),
  label: z.string(),
  phase: z.string().optional(),
  state: z.enum(["running", "stale", "done", "failed"]),
  startedAt: z.string().optional(),
})
export type WorkflowAgentView = z.infer<typeof WorkflowAgentView>

// A sub-agent THIS thread's worker dispatched itself, as opposed to one of its descendants.
//
// Every LIVENESS reading keys on this and never on the raw list. A descendant has no retirement signal
// in this thread's transcript — a direct child clears on its <task-notification>, but a sidecar is
// written once and never deleted — so counting descendants as live work would hold a thread out of the
// queue (hasLiveBackgroundWork) for the full staleness window after a grandchild finished, which is
// exactly the invisible-for-hours failure the queue exists to prevent. Descendants are a RENDERING
// concern: they show what is happening under the thread, and they change no thread state.
export function isDirectSubAgent(agent: { depth?: number }): boolean {
  return (agent.depth ?? 1) === 1
}

// A CHECKOUT THAT IS NOT THE PROJECT'S OWN ROOT — where an agent, a shell or a terminal is working when
// that is somewhere else (server thread-cwd.ts liftCheckout). ABSENT EVERYWHERE MEANS THE ROOT: no surface
// draws anything for the main checkout, so the readout appears only when it says something.
//   kind "worktree" — the folder's `.git` is a FILE: a linked worktree (`git worktree add`, EnterWorktree).
//   kind "folder"   — anything else off the root: another repository's own checkout, or a plain folder.
// ntwine takes no position on worktrees; this INFORMS where a terminal will open and never prescribes.
export const WorkCheckout = z.object({ dir: z.string(), kind: z.enum(["worktree", "folder"]) }).strict()
export type WorkCheckout = z.infer<typeof WorkCheckout>

// A LIVE background SHELL the worker launched (Bash run_in_background:true) — same tailer tracking as a
// sub-agent (dispatch → launch output path → task-notification clear). Foreground-blocking waits keep
// the turn in-flight, so the spinner already covers them; this is for ops that PERSIST across a rest
// (a CI watcher, a long build). New servers include the stable tool-use id so the row can open its
// read-only output drawer; it stays optional for old snapshots. The raw command remains behind that
// drawer's scoped RPC rather than inflating or exposing it in every board snapshot. Its FOLDER (`cwd`)
// does ride the board: a folder is not the command, and it is what tells a shell running in the agent's
// worktree from one running in the project root.
export const BgShellView = z.object({
  label: z.string(), // the command's `description`, else its first-line summary
  startedAt: z.string(), // ISO8601 of the launch record
  state: z.enum(["running", "stale"]),
  id: z.string().optional(),
  // Can ntwine actually END this shell right now? The same contract as SubAgentView.stoppable — computed
  // server-side, never re-derived by a client — but it takes TWO answers, because a shell's control
  // handle is not implied by the thread's transport alone:
  //   · the TAILER contributes "we hold a provider task handle for this shell" (its launch ack names
  //     one, or the task stream paired one to its tool_use id);
  //   · the BOARD contributes "this thread has a control channel at all" (broker-backed Claude).
  // Both must hold. The tailer's half is what closes the seconds-long window between a shell's row
  // appearing (at its tool_use) and its task id arriving (at its launch ack), where an × keyed only on
  // the transport would render and then fail — "We shouldn't show the X if it doesn't fucking work".
  //
  // Until 2026-08-01 this field did not exist and no shell could be stopped: the server refused
  // categorically, on the belief that ntwine "holds no handle on its process". That was measured wrong —
  // a background Bash is a TASK in the same session-wide registry a sub-agent lives in, so
  // `Query.stopTask` ends it (verified end-to-end in backend/_live_shell_stop.mts: the OS process is
  // gone inside a second).
  stoppable: z.boolean().optional(),
  // ntwine cannot read this shell's output, so the row must NOT offer a drill-in. True only for a CODEX
  // background exec: codex keeps a yielded command's output inside its own session and hands it back
  // only when the model polls, so there is no file for ntwine to tail — unlike a Claude shell, whose
  // output file ntwine reads directly. Absent ⇒ readable, which is every row that predates codex shells.
  //
  // A positive flag for the EXCEPTION rather than a `readable` that every existing row would have to
  // start setting: an old snapshot then keeps its drill-in instead of silently losing it.
  outputUnavailable: z.boolean().optional(),
  // The command this shell runs, when ntwine knows it independently of the label. Set only on a CODEX
  // row, where it is the ONE thing the board's copy of the shell and the transcript's copy share — see
  // lib/childOps.ts mergeBackgroundShells, which reconciles the two on it. A Claude row leaves it
  // absent: its two copies already reconcile on the launch tool_use id, and a `command` that merely
  // repeated the label would make two identically-described shells collide into one row.
  command: z.string().optional(),
  // ISO8601 of the shell output file's last write — "last active 6 min ago" for a quiet-but-live
  // watcher. Optional (see SubAgentView.lastActivityAt).
  lastActivityAt: z.string().optional(),
  // The PROVIDER's session-wide background-task handle (`bzvtnt3ig`), as distinct from `id`, which is
  // the launch tool_use id. Both name the same shell and neither is a substitute for the other:
  // `id` is what the two copies of a row reconcile on, and this is the handle the runtime hands the
  // MODEL — "Command running in background with ID: bzvtnt3ig" is the only id a worker ever sees, so
  // it is the one it registers a `shell` watcher against. Matching on `id`/`label` alone meant every
  // such watcher was unfireable (scheduler.evalWatchers, 2026-08-14). Absent for a CODEX row, whose
  // single `processId` IS its `id`, and for a Claude row between its tool_use and its launch ack.
  taskId: z.string().optional(),
  // The runtime budget this shell LAUNCHED with, in ms (server shell-budget.ts): the Bash `timeout` the
  // worker passed on its `run_in_background` call, clamped to [1m, 24h]. Absent ⇒ none was declared, and
  // none is imposed — a shell with no budget runs until it ends or is stopped (the 1h default of
  // 4e5eaca1 was withdrawn the same day). An `extend_shell` does not rewrite this; see `budgetEndsAt`.
  budgetMs: z.number().optional(),
  // A `Monitor` rather than a background Bash — never budgeted, and `extend_shell` refuses it.
  monitor: z.boolean().optional(),
  // When the budget ACTUALLY runs out (ISO8601): launch + `budgetMs`, or the deadline an `extend_shell`
  // set, held later by an armed `watch` on the shell (shell-budget.ts resolveShellBudget). This is what
  // the card's "2h left" reads. Past it the worker is warned once and, unextended, the shell is stopped
  // ten minutes later. Absent ⇒ unbudgeted.
  budgetEndsAt: z.string().optional(),
  // The absolute folder the shell RUNS in, NOT lifted to its checkout: what the row's tooltip ("Runs in")
  // and the drawer's subtitle say. While the shell runs it is the OS's answer — the folder the process
  // holding its log is in (server shell-cwd-probe.ts), which is where it is NOW. Until the OS has answered,
  // and for a Codex exec, it is the start folder the transcript names: the session's `cwd` on the launch
  // record, or where a leading `cd <path> &&` moved it (tailer.ts leadingCd). A retired shell keeps the
  // last of these it had.
  cwd: z.string().optional(),
  // That folder lifted to its checkout, present only when that checkout is NOT the project root — the
  // row's quiet folder hint. Absent ⇒ the root (see WorkCheckout), or no reading: see `atRoot`.
  checkout: WorkCheckout.optional(),
  // The server READ this row's folder and it is in the project's own checkout. `checkout` alone could not
  // say that: absent, it is the root and also "no reading" — a folder since deleted, a Codex exec whose
  // item named none — and a row that claimed the root on no reading said `root` beside a shell running in
  // a worktree. With neither field set, no surface claims a place for the row.
  atRoot: z.literal(true).optional(),
})
export type BgShellView = z.infer<typeof BgShellView>

// A background shell that has FINISHED, still listed in the drawer's TERM strip the way a finished terminal
// of yours is: openable (its drawer reads its log from the server's retired ring), cleared with its ×.
// Bounded by that ring (the tailer keeps the newest 20 per thread), newest first. Until 2026-09-30 a
// finished agent terminal left every surface the moment it ended, so a 10-second shell could not be opened
// from anywhere — while a finished terminal of yours stayed in the strip with its exit code.
export const EndedShellView = z.object({
  id: z.string(), // the launch tool_use id, as BgShellView.id — what its drawer is addressed by
  label: z.string(),
  status: z.enum(["completed", "failed", "killed"]),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  taskId: z.string().optional(), // see BgShellView.taskId — what an ntwine-relayed completion names it by
  monitor: z.boolean().optional(),
  cwd: z.string().optional(),
  checkout: WorkCheckout.optional(),
  atRoot: z.literal(true).optional(),
})
export type EndedShellView = z.infer<typeof EndedShellView>

// ONE AGENT TERMINAL'S LOG — the drawer's read of a background shell (server router backgroundShellOutput).
//
// Only `slug` and `id` name what is read: the path is the one the harness's own ack named, looked up in
// that thread's fold and vetted to the harness's task-log shape (background-shell-output.ts). `from`
// resumes at a previous reply's `end`, so the drawer's poll appends only what arrived; `raw` keeps colour
// and bare `\r` for its xterm. Every field added since the first version is optional both ways, so an
// older client's call and reply are unchanged.
export const BackgroundShellOutputInput = z.object({
  slug: ThreadSlug,
  id: z.string().max(128),
  from: z.number().int().nonnegative().optional(),
  raw: z.boolean().optional(),
}).strict()
export type BackgroundShellOutputInput = z.infer<typeof BackgroundShellOutputInput>
export const BackgroundShellOutputResult = z.object({
  command: z.string().nullable(),
  output: z.string(),
  truncated: z.boolean(),
  state: z.enum(["running", "done", "gone"]),
  // The drawer renders Stop if and only if this is true, and states `stopNote` in its place when a
  // running shell still cannot be reached. Never re-derived client-side.
  stoppable: z.boolean(),
  stopNote: z.string().nullable(),
  // The offset read's cursor: where the next read starts, whether this one started over on a file that
  // shrank, and whether more is already waiting.
  end: z.number().optional(),
  reset: z.boolean().optional(),
  more: z.boolean().optional(),
  // A path WAS named and nothing the vet accepts is readable there — a forged ack, or a task log tmp
  // cleanup removed after the shell ended.
  missing: z.boolean().optional(),
  // A CODEX background exec: Codex keeps its output inside its own session and hands it to the model when
  // it polls, so ntwine holds no file to read. The command, the folder and Stop still work.
  outputUnavailable: z.boolean().optional(),
  // Where it runs (BgShellView.cwd) and that folder's checkout when it is off the project root — kept
  // with the retired shell, so an open drawer keeps its subtitle after the shell ends.
  cwd: z.string().nullable().optional(),
  checkout: WorkCheckout.nullable().optional(),
  monitor: z.boolean().optional(),
})
export type BackgroundShellOutputResult = z.infer<typeof BackgroundShellOutputResult>

// WHY "Mark as done" stopped to ask instead of ending the session outright. The server already knows
// the exact evidence it refused on (an executing turn, named live children, or no telemetry at all) —
// this carries it to the confirm dialog so the human reads "2 sub-agents and 1 background shell are
// still running, here they are" rather than a bare "this thread is still running". Labels are the same
// worker-authored strings the board's ops strip already renders; the lists are capped and the true
// totals travel separately so a long list can say "+N more" instead of silently truncating.
export const CompletionHoldOp = z.object({
  label: z.string(),
  state: z.enum(["running", "stale"]),
})
export type CompletionHoldOp = z.infer<typeof CompletionHoldOp>
export const CompletionHold = z.object({
  turnInFlight: z.boolean().default(false), // the session's own turn is mid-execution
  // Telemetry is missing entirely (live runtime, unreadable transcript). We can neither confirm nor
  // rule out work in flight, so the dialog says exactly that rather than inventing a specific cause.
  unobservable: z.boolean().default(false),
  subAgents: z.array(CompletionHoldOp).default([]),
  subAgentCount: z.number().default(0), // total live sub-agents (≥ subAgents.length)
  bgShells: z.array(CompletionHoldOp).default([]),
  bgShellCount: z.number().default(0), // total live background shells (≥ bgShells.length)
  // The thread's own TERMINALS still running (server thread-terminals.ts) — `npm run dev`, a shell the
  // human opened. Marking the thread done stops them, so the dialog names them beside the shells. Their
  // labels are the human's own command lines. Optional so a pre-change client reads a hold unchanged.
  terminals: z.array(CompletionHoldOp).optional(),
  terminalCount: z.number().optional(),
  // The worker is DEAD and its recorded turn never ended — cut off by a reboot, a signal or a crash
  // mid-tool-call (router.cutOffHold). Nothing is running, so nothing will be killed; the hold exists
  // because the thread is not finished and Done would say it was. Optional rather than defaulted so it
  // is absent (⇒ false) on every hold that is not this one, and a pre-change client reads them unchanged.
  cutOff: z.boolean().optional(),
})
export type CompletionHold = z.infer<typeof CompletionHold>

// A PENDING native AskUserQuestion — the worker (or any session) called Claude Code's AskUserQuestion
// tool and is frozen at its TUI dialog, no tool_result yet. Safety net for pre-contract / external
// sessions that bypass the thread-file ask channel: we surface the REAL question(s) so the human knows
// what's being asked, and route them to answer in the terminal (a deny-hook enforces the contract
// channel for compliant workers; answering here is deliberately NOT wired — too fragile). Structured
// input is capped defensively (never trust a foreign tool's payload shape).
export const AskOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const AskQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOption),
})
export const PendingAsk = z.object({
  questions: z.array(AskQuestion),
})
export type AskOption = z.infer<typeof AskOption>
export type AskQuestion = z.infer<typeof AskQuestion>
export type PendingAsk = z.infer<typeof PendingAsk>

// Cap a foreign string defensively (AskUserQuestion is an UNTRUSTED tool payload — never let it
// fatten a snapshot or a projected transcript). Caps chosen so the read-only render stays a compact card.
function capAsk(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Parse an AskUserQuestion tool_use `input.questions` into the capped structured shape. Defensive at
 *  every level: a missing/misshaped field is skipped, never thrown. Empty result → treat as "no ask".
 *  Shared by the tailer (the pending-ask safety net) and the transcript projector (the settled call's
 *  read-only question card), so the two can never cap or shape the same payload differently. */
export function parseAskUserQuestionInput(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  const out: AskQuestion[] = []
  for (const q of qs.slice(0, 8)) {
    if (!q || typeof q !== "object") continue
    const qq = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown }
    const question = typeof qq.question === "string" && qq.question.trim() ? capAsk(qq.question.trim(), 400) : ""
    if (!question) continue
    const header = typeof qq.header === "string" && qq.header.trim() ? capAsk(qq.header.trim(), 60) : undefined
    const multiSelect = qq.multiSelect === true ? true : undefined
    const options: AskOption[] = []
    if (Array.isArray(qq.options)) {
      for (const o of qq.options.slice(0, 12)) {
        if (!o || typeof o !== "object") continue
        const oo = o as { label?: unknown; description?: unknown }
        const label = typeof oo.label === "string" && oo.label.trim() ? capAsk(oo.label.trim(), 160) : undefined
        if (!label) continue
        const description = typeof oo.description === "string" && oo.description.trim() ? capAsk(oo.description.trim(), 300) : undefined
        options.push({ label, description })
      }
    }
    out.push({ question, header, multiSelect, options })
  }
  return out
}

/** Parse an answered AskUserQuestion's structured tool result (`toolUseResult.answers` — a record
 *  keyed by question text) into the per-question answer list, parallel to `questions`. Null when the
 *  result carries no readable answers at all (the withdrawn / denied case). */
export function parseAskUserQuestionAnswers(result: unknown, questions: readonly AskQuestion[]): (string | null)[] | null {
  const answers = (result as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null
  const byQuestion = answers as Record<string, unknown>
  let any = false
  const out = questions.map((q) => {
    // The result keys carry the UNCAPPED question text; a capped `q.question` still matches by prefix.
    const key = Object.keys(byQuestion).find((k) => k === q.question || capAsk(k.trim(), 400) === q.question)
    const raw = key === undefined ? undefined : byQuestion[key]
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((v) => typeof v === "string").join(", ") : ""
    if (!text.trim()) return null
    any = true
    return capAsk(text.trim(), 600)
  })
  return any ? out : null
}

// ---- THE AWAITING FENCE ---------------------------------------------------------------------------
// A worker ends every turn in ONE terminal state: it needs the human, it is waiting on work that is
// actually running, or it is finished. Each is now said EITHER by a fence or by a registration — a
// `thread_question` row asked at THIS rest is a standing sign-off on its own, and so is an armed watch or
// a recorded done, which is why a worker that has just asked rests normally and writes no fence at all.
// A question still open from an EARLIER rest is not: the worker names it under `questions:` or withdraws
// it (2026-10-05). This is the FENCE form of the middle one, and it is PURE STRUCTURE — a list of things
// ntwine can look up, a duration, and one line of prose.
//
//   shells: [<runtime task id>, …]   background shells it launched   → checked against live telemetry
//   agents: [<runtime agent id>, …]  sub-agents it dispatched        → checked against live telemetry
//   timers: [tmr_…, …]               timers it set                   → checked against thread_timer
//   prs:    [owner/repo#123, …]      PR watchers it registered       → checked against its PR registry
//   for:    2h                       REQUIRED. How long the park may stand (parseAwaitingDurationRaw).
//                                    Capped at a day — or at PR_WATCH_FOR_MAX_MS when every item is a
//                                    `prs:` entry, because an external PR does not move on a day's clock.
//                                    An `agents:` entry caps it at 30m instead: AGENT_PARK_FOR_MAX_MS.
//   title:  Waiting on the CI run    OPTIONAL. The resting card's heading, in the worker's own words.
//   status: watching                 REQUIRED for a thread dispatched at or after NEEDS_INPUT_REQUIRED_AT.
//                                    Where the thread sits while it waits, in the worker's own word:
//                                    `needs_input` (the human should look now — the queue), `working`
//                                    (its own work finishes by itself — Running) or `watching` (something
//                                    must happen outside the thread — Snoozed). See awaitingStatus.
//   needs_input: false               The 2026-10-01 spelling of the same answer, read as an alias:
//                                    `true` is `status: needs_input`; `false` leaves the band to the
//                                    board's default (see awaitingNeedsInput, board.deriveWaitStatus).
//   steps:                           OPTIONAL. Steps only the HUMAN can perform — a sign-in, an
//     - Run `npm login`              approval, a merge the worker may not make — one `- ` item per
//     - Approve the browser prompt   line, read VERBATIM (see awaitingSteps). A fence carrying them
//                                    waits on the human: it needs no other name and no `for:`, and it
//                                    always queues (awaitingNeedsInput reads it as `true`).
//   questions: [qst_…, …]            The worker's registered questions it is STILL waiting on. A fence
//                                    beside open questions must name every one of them (anything else
//                                    is withdrawn with `unask`), and a card it names is drawn at THIS
//                                    rest (see awaitingQuestions). Like `steps:` it names the human as
//                                    the wait: no other name and no `for:` needed, and it always queues.
//
// THE FRONTMATTER IS REAL YAML (2026-08-24), parsed by the `yaml` package — the keys are PLURAL and take
// SEQUENCES, block or flow. A bare scalar where a sequence is expected is accepted and normalised to a
// one-element list, because that is the shape a worker most often reaches for and refusing it buys
// nothing. Everything the human reads is prose below the `---`.
//
// …then, after a `---` line, as much arbitrary Markdown as the worker wants (2026-08-17). The structural
// lines are FRONTMATTER; the delimiter is what makes "is this line structural?" answerable, which is what
// lets a retired or unknown kind be refused by name instead of silently swallowed as prose.
//
// IT IS YAML SINCE 2026-08-24, AND THE ONE THING THAT MADE IT IMPOSSIBLE BEFORE WAS `reason:`. This block
// used to read "IT IS NOT YAML, AND MUST NOT BECOME YAML", on three measurements taken 2026-08-17 against
// the real `yaml` package. All three still reproduce — and two of them are about PROSE, not structure:
//
//   `reason: waiting on your merge: the propKeys revert`  → parse error (nested mappings)
//   `reason: see #6422`                                   → silently {"reason":"see"} (` #` opens a comment)
//   two `shell:` lines                                    → parse error (map keys must be unique)
//
// A worker's prose carries colons and `#`-refs constantly, and no YAML parser will take the rest of a
// line verbatim. So `reason:` is RETIRED (below) — the `---` body had already superseded it — and with it
// gone the frontmatter is pure data. The duplicate-key objection is what the plural keys answer; the old
// note conceded arrays would fix it and judged them not worth it, which was right while `reason:` was
// still in the frontmatter and wrong once it left. Re-measured 2026-08-24: `prs: [owner/repo#123]` parses
// correctly (no space before the `#`, so it is not a comment), as do block sequences and mixed kinds.
//
// TWO NEW FAILURE MODES COME WITH IT, and both are handled rather than hoped away: a TAB indent is a hard
// parse error (so a parse failure must BUMP the worker with the error, never park it), and a key with
// nothing under it yields `null` silently (so an empty sequence is refused, not read as a park).
//
// REGISTRATION IS ORTHOGONAL TO THIS FENCE (maintainer 2026-08-15). Dispatching a shell or a sub-agent,
// setting a timer, registering a PR watcher — none of that is a fence, and none of it parks anything.
// Those things simply exist and ntwine watches them. The fence is only how a worker declares that it has
// STOPPED, and names which of them it stopped for.
//
// EVERY NAME IS CHECKED, THE MOMENT THE FENCE LANDS. All valid ⇒ the thread goes to Held. Any name that
// is dead, unknown, or another thread’s ⇒ the worker is BUMPED immediately. It does not fail open and it
// does not park: a wait that cannot resolve must never be able to look like one that can.
//
// WHAT WAS DELETED, AND WHY, BECAUSE EACH ONE WAS A WAY TO STALL SILENTLY:
//   `human: <person>`  parked a thread in Held and NOTHING EVER FIRED IT. Waiting on a person to DECIDE
//                      is a registered question; waiting on one to ACT is `steps:` (2026-10-03), which
//                      keeps the thread IN the queue — and the human's reply is the wake.
//   `timer: <instant>` an absolute instant the worker computed. One was written 5h55m in the past; it
//                      parsed, armed nothing, and stalled its thread for 5.5 hours. `for:` is a duration
//                      precisely so this cannot be expressed (see parseAwaitingDurationRaw).
//   `pr-watch: ref`    free text the poller armed from. A PR is now a registered watcher with an id.
//   `watch: id`        superseded: a shell is named directly by its runtime handle.
//   `ci:`/`session:`   legacy conditions nothing has fired for a long time.
//   the SINGULAR keys  `shell:`/`agent:`/`timer:`/`pr:` — one line per item, repeated. YAML cannot express
//                      a repeated key, so they became the plural sequence keys above (2026-08-24).
//   `reason:`          the last prose in the frontmatter, and the reason it could not be YAML. It moves
//                      below the `---`, where it always belonged and where it has no length limit.
//   prose bodies       narrowed to `reason:` so the fence is machine-checkable — then given back in full
//                      below the `---` delimiter, where prose cannot be mistaken for structure.
export const AwaitingHint = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr", "thread", "command", "for", "title", "status", "needs_input", "step", "question"]),
  value: z.string(),
})
export type AwaitingHint = z.infer<typeof AwaitingHint>

/** The hint kinds that USED to exist, so a worker still writing one can be told rather than ignored.
 *
 *  A worker's contract is frozen into its system prompt at dispatch, so every session started before the
 *  2026-08-15 cut keeps writing these — and a deleted kind does not parse, so it falls into the fence BODY
 *  as prose and the fence silently becomes a park that names nothing. Measured three times in two days,
 *  each as a separate bug report: a `for:`-only fence, a card printing `watch: bvg44v4ij`, and a Goal
 *  loop re-writing `pr-watch:` every six seconds.
 *
 *  Falling through quietly is the whole problem: the worker cannot see which line ntwine ignored, so it
 *  writes the same one again. Recognising them by name is what lets the bump say "you wrote `pr-watch:`,
 *  that kind is gone, here is what replaced it" (maintainer 2026-08-17: "BLOCK THEM with an error
 *  message… tell them what is now supported"). */
export const RETIRED_AWAITING_KINDS = ["watch", "pr-watch", "human", "ci", "session", "shell", "agent", "timer", "pr", "reason", "issues"] as const
export type RetiredAwaitingKind = (typeof RETIRED_AWAITING_KINDS)[number]

const RETIRED_LINE_RE = new RegExp(`^\\s*(${RETIRED_AWAITING_KINDS.join("|")}):\\s*\\S`, "im")

/** Every retired kind a fence body still carries, in the order the grammar lists them — deduped, because
 *  a worker repeating `pr-watch:` for three PRs has ONE thing to learn, not three. */
export function retiredAwaitingKindsIn(body: string): RetiredAwaitingKind[] {
  if (!body || !RETIRED_LINE_RE.test(body)) return []
  const found: RetiredAwaitingKind[] = []
  for (const line of body.split("\n")) {
    const m = /^\s*([a-z-]+):\s*\S/i.exec(line)
    const kind = m?.[1].toLowerCase()
    if (!kind) continue
    const hit = RETIRED_AWAITING_KINDS.find((k) => k === kind)
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return found
}

/** What each retired kind became, so the bump can say it in one line rather than restating the grammar. */
export const RETIRED_AWAITING_REPLACEMENT: Record<RetiredAwaitingKind, string> = {
  "watch": "`shells: [<the id your runtime gave you>]` (or `agents: [<id>]`) — the same id, in the current sequence",
  "pr-watch": "register the PR with `ntwinectl watch-pr add`, then name it `prs: [owner/repo#123]`",
  "human": "there is no human gate any more — steps only the user can perform go under `steps:`, one `- ` item per line; a decision you need from them is a question, registered with `ntwinectl ask`",
  "ci": "CI is not a wait of its own: register the PR with `ntwinectl watch-pr add` and you are woken when its checks settle",
  "session": "there is no cross-session wait — name the sub-agent you dispatched with `agents: [<id>]`",
  // THE 2026-08-24 CUTOVER. The frontmatter is YAML now, and YAML has no repeated keys — so the four
  // one-per-line item kinds became plural sequences, and `reason:` (the prose that made YAML impossible)
  // moved below the `---`. Every worker dispatched before the cut has the old grammar frozen into its
  // system prompt and will keep writing these, which is exactly what these five lines are for.
  "shell": "`shells: [<id>, <id>]` — one YAML sequence, not one line per shell",
  "agent": "`agents: [<id>, <id>]` — one YAML sequence, not one line per sub-agent",
  "timer": "`timers: [tmr_…]` — one YAML sequence, not one line per timer",
  "pr": "`prs: [owner/repo#123]` — one YAML sequence, not one line per PR",
  "reason": "put it below the `---` as ordinary Markdown — the frontmatter is YAML now and takes no prose",
  // THE WORKER'S ISSUE WATCH WAS REMOVED ON 2026-10-14, `ntwinectl watch-issue` with it. A worker
  // dispatched before then still has `issues:` in its contract.
  "issues": "there is no issue wait any more — if nothing else is left, end with ```done and name the issue; the user can watch it from there",
}

/** The four kinds that NAME A LIVE THING. Every one is checked against something ntwine can look up — a
 *  runtime handle in this thread's telemetry, or a row in one of its registries — which is the whole
 *  point of the grammar. `for`/`reason` describe the park itself and name nothing. */
/** THE ONE FENCE-FRONTMATTER PARSER, and it lives here because there used to be TWO.
 *
 *  The server folds a fence out of the transcript to decide whether the thread PARKS; the client parses
 *  the same fence to decide how it RENDERS. Those were separate implementations with a comment on each
 *  begging the next reader to keep them in step — and on 2026-08-24 the YAML cutover moved one and not
 *  the other, so a correct fence parked correctly on the server and printed its own raw frontmatter at
 *  the human in the in-chat card. That is the exact bug class the twin comments predicted, and the only
 *  fix that ends it is a single function both sides call.
 *
 *  DEFENSIVE BY CONTRACT: it runs on whatever an LLM wrote, so it never throws. A parse failure, a
 *  non-mapping document, a key holding the wrong type, or an empty sequence all yield NO hints — which
 *  makes the fence name less than it claimed and gets the worker BUMPED rather than parked. Silently
 *  parking on a fence ntwine could not read is the one outcome that must be impossible.
 */

/** Any `key: value` line at the top level of the frontmatter. Deliberately WIDER than the grammar: its
 *  job is to spot a line that CLAIMS to be structural, so an unrecognised key can be refused BY NAME.
 *  Hyphens are in the class because the oldest retired kind is `pr-watch:`, and a regex that could not
 *  see it let one pass as prose. Underscores are in it for `needs_input:`, which without them fell to
 *  the body as a sentence and left the fence with no answer. */
const AWAITING_KEY_RE = /^([a-z][a-z_-]*):\s*(\S.*)?$/i

/** The keys the frontmatter recognises as STRUCTURE: four PLURAL sequences of things ntwine can look up,
 *  the scalars `for:`, `status:` and its alias `needs_input:`, and `title:` and `steps:` — which are
 *  recognised here so they never fall to the body, but are read verbatim rather than as YAML (see
 *  splitAwaitingFrontmatter). Anything else falls through to the body. `needs-input` is the same key
 *  spelled the way the other hyphenated kinds are. */
const AWAITING_YAML_KEYS = new Set(["shells", "agents", "timers", "prs", "threads", "commands", "questions", "for", "title", "steps", "status", "needs_input", "needs-input"])

/** Which singular hint kind each plural sequence key produces. The WIRE SHAPE is unchanged by the
 *  2026-08-24 cutover — every consumer still reads a flat `{kind, value}` list with SINGULAR kinds — so
 *  only the grammar the worker WRITES moved to YAML. */
const AWAITING_SEQUENCE_KEYS: { [key: string]: AwaitingItemKind | undefined } = {
  shells: "shell",
  agents: "agent",
  timers: "timer",
  prs: "pr",
  // `commands:` (2026-10-11) names a command watch registered with `ntwinectl watch-command`, by its
  // `cmw_…` id. Checked like a timer: the row must be armed on THIS thread.
  commands: "command",
}

/** Defensive caps, shared so the sidebar gloss and the in-chat card can never render a divergent row.
 *  The cap counts NAMED ITEMS only: the scalars (`for:`, `status:`, `needs_input:`, `title:`) ride
 *  outside it (see AWAITING_SCALAR_KINDS), because each one is at most a single hint and dropping one is
 *  worse than useless — a fence naming eight shells lost its `needs_input:` line to the cap, and the
 *  correction for the missing line could never be satisfied by re-sending it. */
export const AWAITING_HINT_MAX = 8
export const AWAITING_HINT_VALUE_MAX = 200
const AWAITING_SCALAR_KINDS: ReadonlySet<AwaitingHint["kind"]> = new Set(["for", "title", "status", "needs_input"])

/** `steps:` has caps of its own, and the list is appended AFTER the hints capped above, so a long list can
 *  never crowd a `prs:` entry out of AWAITING_HINT_MAX.
 *
 *  THE LENGTH CAP IS DEFENSIVE, NOT A FIT. The board carries every thread's last fence, so a runaway
 *  step must not fatten it — that is the cap's whole job, and keeping a step to one act is the worker
 *  contract's. It was 500, "a sentence's length", from 2026-10-03 to 2026-10-12, and that cut a real
 *  step: one naming three 32-character key ids beside a dashboard link ran 665 characters, and the card
 *  ended mid-sentence on "open each token" with nothing to say it had been cut (maintainer: "Did your
 *  question get cut off or something?"). The contract demands every link, id and value written in, and
 *  Markdown link targets spend characters nobody reads, so 2,000 now — and a step past it ends on an
 *  ellipsis rather than mid-word in silence. */
export const AWAITING_STEPS_MAX = 12
export const AWAITING_STEP_VALUE_MAX = 2_000

/** `questions:` rides after the capped hints for the same reason `steps:` does: a thread carrying many
 *  open questions must still be able to name every one of them — the park is refused for any it leaves
 *  out — without crowding a `prs:` entry out of AWAITING_HINT_MAX. */
export const AWAITING_QUESTIONS_MAX = 24

/** `title:` — the resting card's heading in the WORKER'S OWN WORDS, replacing the derived one
 *  ("Awaiting" / "Agent terminals running", see awaitingBackgroundLabel).
 *
 *  IT IS A HEADING, NOT A SENTENCE, and the cap is what keeps it one. The card already carries the
 *  worker's full prose below it and a row per awaited thing under that, so a title that restates either
 *  is the doubling this card has been trimmed for twice.
 *
 *  THE CAP IS DEFENSIVE, NOT A FIT. It was 40 from 2026-08-26 to 2026-09-19, measured so the heading
 *  drew on ONE line at the queue card's narrowest (368px content box) in the then-wider mono font — and
 *  that cut real headings mid-thought: "Spread ask and soundness issue on…" was the whole title a reader
 *  got of a park on two TypeScript issues (maintainer 2026-09-19: "We are truncating this title way too
 *  aggressively. It should wrap if need be."). The heading WRAPS (TranscriptCard's head, plus
 *  `overflow-wrap:anywhere` on this one because a worker can write an unbreakable token), so the cap
 *  only has to stop a paragraph from becoming a heading: 120 is about two and a half lines at that
 *  narrowest width in sans (7.21px per character), which is still a heading and never a handoff.
 *
 *  Longer is TRIMMED on a word boundary rather than refused: a worker that overruns still meant something
 *  specific, and "Waiting on the three-platform CI run…" says more than falling back to "Awaiting".
 *
 *  Sentence case, like every other piece of copy in the app (CLAUDE.md), and the trim never invents
 *  capitalisation. */
export const AWAITING_TITLE_MAX = 120

/** The title as it will RENDER: collapsed to one line, cap-trimmed on a word boundary. Applied at PARSE
 *  time so the stored hint is already what the card draws — every consumer then agrees by construction,
 *  and nothing downstream has to re-trim. */
export function trimAwaitingTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat.length <= AWAITING_TITLE_MAX) return flat
  const cut = flat.slice(0, AWAITING_TITLE_MAX)
  const space = cut.lastIndexOf(" ")
  return `${(space > AWAITING_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.,;:–—-]$/, "").trimEnd()}…`
}

/** Split an ```awaiting fence body into its hints and its prose.
 *
 *  FRONTMATTER, THEN MARKDOWN: structural lines first, a `---` line ends them, everything after is
 *  arbitrary prose. No delimiter ⇒ the whole fence is frontmatter, which is how every fence written
 *  before 2026-08-17 parses.
 *
 *  A RETIRED or UNKNOWN key never reaches the YAML parser, and that is not an optimisation. A retired key
 *  would otherwise surface as an opaque "map keys must be unique" or a nested-mapping error, when the
 *  worker needs to be told BY NAME what replaced it — the scheduler reads those lines back out of the
 *  BODY with `retiredAwaitingKindsIn`, exactly as it did under the line grammar.
 *
 *  THE TITLE NEVER REACHES THE YAML PARSER EITHER. It is the one line of PROSE the frontmatter still
 *  carries — a heading in the worker's own words — and prose is exactly what YAML cannot hold: a ` #`
 *  starts a comment, a `: ` starts a nested mapping, a leading quote must close. On 2026-09-10 a worker
 *  wrote `title: De-slop rewrite of the #64172 comment` — naming the PR, as the contract tells it to in
 *  every resting message — and the card drew "De-slop rewrite of the" with no ellipsis and no error,
 *  because YAML had read the PR number as a comment. A colon would have been worse: the whole
 *  frontmatter fails to parse, and a fence that named a live sub-agent and a PR parks NOTHING. So the
 *  title is read verbatim off its line (plus any indented continuation), and only the lookups stay YAML.
 *
 *  `steps:` IS READ VERBATIM FOR THE SAME REASON, and more urgently: a step is an instruction, and an
 *  instruction is the prose most likely to carry what YAML cannot hold. `- Run \`npm login\`` is a parse
 *  error outright (a backtick may not open a plain scalar), `- Approve it: use the org account` silently
 *  becomes a one-key mapping, and either failure would cost the fence every lookup beside it. So each
 *  `- ` item under the key is taken as written, an indented line continues the item above it, and a
 *  value on the key line itself is one step — or, written `[a, b]`, a flow list YAML is allowed to try. */
export function splitAwaitingFrontmatter(raw: string): { body: string; hints: AwaitingHint[] } {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""))
  const delimiter = lines.findIndex((l) => /^\s*---+\s*$/.test(l))
  const frontmatter = delimiter === -1 ? lines : lines.slice(0, delimiter)
  const after = delimiter === -1 ? [] : lines.slice(delimiter + 1)
  const rest: string[] = []
  const yamlLines: string[] = []
  const titleLines: string[] = []
  const steps: string[] = []
  // `structural` tracks whether the line we are on belongs to the YAML document. A block sequence's items
  // and any indented continuation belong to the KEY ABOVE THEM, so they follow that key's fate — which is
  // what keeps a retired `pr:` with its list underneath from orphaning a bare sequence into the parser.
  // `inTitle` and `inSteps` are the same rule for the two keys that are prose: their lines follow them
  // verbatim.
  // `threads:` names another ntwine thread this one asked with `ntwinectl message-thread` and
  // `await_reply: true`, by its `@handle` — and `@` is a character YAML reserves, so `threads: [@x]` is a
  // parse error that would cost the fence every lookup beside it. So its values are read verbatim too,
  // as a flow list or `- ` items, with any quotes a worker added taken off.
  const threads: string[] = []
  let structural = true
  let inTitle = false
  let inSteps = false
  let inThreads = false
  for (const line of frontmatter) {
    const m = line.match(AWAITING_KEY_RE)
    const key = m?.[1].toLowerCase()
    if (m && key) {
      structural = AWAITING_YAML_KEYS.has(key)
      inTitle = key === "title"
      inSteps = key === "steps"
      inThreads = key === "threads"
    }
    // A LINE THAT IS NOT A KEY AND NOT A CONTINUATION IS PROSE, exactly as it was under the line grammar:
    // a worker that omits the `---` and writes its handoff straight into the frontmatter must still park.
    // Feeding that sentence to YAML would be a parse error and would cost it the whole fence.
    else if (line.trim() !== "" && !/^\s/.test(line) && !/^\s*-\s/.test(line)) {
      structural = false
      inTitle = false
      inSteps = false
      inThreads = false
    }
    if (inTitle) titleLines.push(m && key === "title" ? (m[2] ?? "") : line)
    else if (inThreads) {
      const raw = m && key === "threads" ? (m[2] ?? "") : (/^\s*-\s+(.*)$/.exec(line)?.[1] ?? "")
      const v = raw.trim()
      const list = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1).split(",") : [v]
      threads.push(...list.map((t) => t.trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean))
    }
    else if (inSteps) {
      if (m && key === "steps") steps.push(...inlineSteps(m[2] ?? ""))
      else {
        const item = /^\s*-\s+(.*)$/.exec(line)
        if (item) steps.push(item[1])
        else if (line.trim() && steps.length > 0) steps[steps.length - 1] += ` ${line.trim()}`
      }
    }
    else (structural ? yamlLines : rest).push(line)
  }
  const parsed = parseAwaitingYaml(yamlLines.join("\n"))
  // Unparsed lines go to the BODY rather than being dropped: the worker has to be able to see what it
  // wrote, or the correction it gets is about a fence it can no longer read.
  if (!parsed.ok) rest.push(...yamlLines)
  for (const thread of threads) parsed.hints.push({ kind: "thread", value: thread.slice(0, AWAITING_HINT_VALUE_MAX) })
  rest.push(...after)
  // Capped HERE rather than at the card, so the hint on the wire is already the string that renders and
  // no consumer can draw a longer one. A title alone still parks nothing (see readAwaitingPark).
  const title = trimAwaitingTitle(titleLines.join(" "))
  if (title) parsed.hints.push({ kind: "title", value: title })
  const stepHints: AwaitingHint[] = steps
    .map(readStep)
    .filter(Boolean)
    .slice(0, AWAITING_STEPS_MAX)
    .map((step) => ({ kind: "step", value: step }))
  const questionHints = parsed.hints.filter((h) => h.kind === "question").slice(0, AWAITING_QUESTIONS_MAX)
  // The cap counts named items alone (see AWAITING_HINT_MAX); every scalar survives it, in written order.
  let items = 0
  const capped = parsed.hints.filter((h) => h.kind !== "question" && (AWAITING_SCALAR_KINDS.has(h.kind) || items++ < AWAITING_HINT_MAX))
  return { body: rest.join("\n").trim(), hints: [...capped, ...questionHints, ...stepHints] }
}

/** The steps written ON the `steps:` line: none, one, or a flow list. A flow list YAML cannot read — a
 *  step opening on a backtick, a colon inside one — stays ONE step with its brackets off, so the human
 *  still reads every word rather than the fence losing them. */
function inlineSteps(value: string): string[] {
  const v = value.trim()
  if (!v) return []
  if (!(v.startsWith("[") && v.endsWith("]"))) return [v]
  try {
    const list = parseYaml(v)
    if (Array.isArray(list) && list.every((s) => typeof s === "string" || typeof s === "number")) return list.map(String)
  } catch {
    // fall through to the one-step reading
  }
  return [v.slice(1, -1)]
}

/** One step as it will RENDER: trimmed, unquoted, and capped where the cut shows.
 *
 *  A WORKER WRITES YAML OUT OF HABIT, and the frontmatter looks like YAML, so a step arrives as a quoted
 *  scalar often enough to matter — `- "Open the token list and delete…"` — and read verbatim its quotes
 *  rendered as the step's first character (2026-10-12). A step that is ONE whole quoted scalar is
 *  unwrapped by YAML itself, escapes and `''` included; anything YAML cannot read as a single string —
 *  `"Done" — then type "yes"` opens and closes on a quote without being one — stays as written. */
function readStep(raw: string): string {
  let step = raw.trim()
  if (step.length >= 2 && (step[0] === '"' || step[0] === "'") && step.endsWith(step[0])) {
    try {
      const value = parseYaml(step)
      if (typeof value === "string") step = value.trim()
    } catch {
      // not one quoted scalar: the quotes are the worker's prose
    }
  }
  return step.length > AWAITING_STEP_VALUE_MAX ? `${step.slice(0, AWAITING_STEP_VALUE_MAX).trimEnd()}…` : step
}

/** The fence's steps for the human, in the order written — empty for every fence that is not waiting on
 *  one, which is how every reader tells the two shapes apart. */
export function awaitingSteps(hints: readonly AwaitingHint[] | undefined): string[] {
  return (hints ?? []).filter((h) => h.kind === "step").map((h) => h.value)
}

/** The registered questions the fence says it is still waiting on, as lowercased ids in the order
 *  written — empty for a fence that names none.
 *
 *  WHY THE KEY EXISTS (maintainer 2026-10-05). Until then an open question was drawn at whatever rest
 *  the thread had most recently reached, and it refused any awaiting fence outright — so a question the
 *  human had replied past, or one a CI wake had buried, kept reappearing UNDER the worker's newest
 *  handoff and took its place as the sign-off ("the pending questions that may or may not be relevant
 *  kind of supersede how the agent actually signed off"). Now the card stays where it was asked, and a
 *  worker that still needs the answer says so here; one it no longer needs it withdraws. A value that
 *  carries more than the id (`qst_ab12 — the cache call`) is read down to the id, so a gloss never costs
 *  the name. */
export function awaitingQuestions(hints: readonly AwaitingHint[] | undefined): string[] {
  return (hints ?? []).filter((h) => h.kind === "question").map((h) => questionIdOf(h.value))
}

function questionIdOf(value: string): string {
  return (/qst_[a-z0-9]+/i.exec(value)?.[0] ?? value.trim()).toLowerCase()
}

function parseAwaitingYaml(text: string): { ok: boolean; hints: AwaitingHint[] } {
  if (!text.trim()) return { ok: true, hints: [] }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return { ok: false, hints: [] } // not YAML at all — a tab indent, a stray bracket, an unclosed quote
  }
  // A frontmatter that parses to a scalar or a sequence is not a mapping of keys, so it names nothing —
  // and the worker still needs to see it, hence `ok: false` rather than an empty success.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, hints: [] }
  const hints: AwaitingHint[] = []
  const push = (kind: AwaitingHint["kind"], raw: unknown) => {
    // A number or a boolean is a value a worker plausibly wrote unquoted; anything structural is not a
    // name and cannot be looked up, so it is dropped rather than stringified into nonsense.
    if (raw === null || raw === undefined || typeof raw === "object") return
    const value = String(raw).trim()
    if (!value) return
    hints.push({ kind, value: value.slice(0, AWAITING_HINT_VALUE_MAX) })
  }
  for (const [rawKey, raw] of Object.entries(doc as { [key: string]: unknown })) {
    // Case-insensitive, because the line grammar was and a worker that shouts `PRS:` means `prs:`. YAML
    // itself is case-sensitive, so without this the key would parse and then silently match nothing.
    const key = rawKey.toLowerCase()
    const itemKind = AWAITING_SEQUENCE_KEYS[key]
    if (itemKind) {
      // A BARE SCALAR IS ACCEPTED where a sequence is expected — `prs: acme/app#1` is what a worker
      // reaches for with one item, and refusing it would fail a fence that says exactly the right thing.
      for (const entry of Array.isArray(raw) ? raw : [raw]) push(itemKind, entry)
    } else if (key === "questions") {
      for (const entry of Array.isArray(raw) ? raw : [raw]) push("question", entry)
    } else if (key === "for") {
      push("for", raw)
    } else if (key === "status") {
      // Kept as written, like `needs_input:` below, so a value that is none of the three can be quoted
      // back by the correction; awaitingStatus reads it as no answer at all.
      push("status", raw)
    } else if (key === "needs_input" || key === "needs-input") {
      // YAML hands `true`/`false` over as booleans, which `push` stringifies. Anything else — `yes`, a
      // sentence — is kept as written so the correction can quote it back; awaitingNeedsInput reads it
      // as no answer at all.
      push("needs_input", raw)
    }
    // No `title` arm: splitAwaitingFrontmatter lifts that line out before the YAML parse, because a
    // heading is prose and a ` #` or a `: ` in it would cut it or fail the document.
  }
  return { ok: true, hints }
}

/** The heading this fence asked for, already trimmed — null when it named none, which is every fence
 *  written before 2026-08-26 and most written after. The LAST one wins: YAML cannot hold a repeated key,
 *  so this can only be reached by a hand-built hint list, and the last write is the ordinary reading. */
export function awaitingFenceTitle(hints: readonly AwaitingHint[] | undefined): string | null {
  let title: string | null = null
  for (const h of hints ?? []) {
    if (h.kind !== "title") continue
    const value = trimAwaitingTitle(h.value)
    if (value) title = value
  }
  return title
}

// ONE ANSWER FOR THREE PLACES (maintainer 2026-10-05). A rest on running work lands in one of three
// places — the queue, Running or Snoozed — and the 2026-10-01 `needs_input: true|false` chose between
// only two of them, so "nothing for the human" was drawn as "working": a thread polling five model
// catalogs every 30 minutes for a day sat in Running behind a spinner ("it looks like it's actively
// working on stuff, but it's obviously not"). A second boolean beside it was proposed and rejected —
// two lines give four combinations for three places, and `needs_input: true` with `working: true` means
// nothing `needs_input: true` does not ("Maybe we should just consolidate all of this to a status
// enum"). So the answer is one REQUIRED enum, in the worker's own words:
//
//   needs_input  the human can read, try or answer something now          → the queue
//   working      the named work finishes by itself (a test, a build, CI,
//                a sub-agent with a task)                                  → Running, with the spinner
//   watching     something must happen outside the thread (a release, a
//                review, another agent's merge, tomorrow's cycle)          → Snoozed
//
// The worker says it because ntwine cannot see it: a background shell is a build or a poller through the
// same telemetry, and the contract routes long waits to sub-agents, so a sub-agent can be a watcher too.
// What ntwine CAN see still bounds it, in the safe direction only: `working` with nothing named in motion
// draws no spinner (board.deriveWaitStatus), and every park still holds only while each named item is
// live and its `for:` has not run out (awaiting.needsInputParkHolds).
export const AWAITING_STATUSES = ["needs_input", "working", "watching"] as const
export type AwaitingStatus = (typeof AWAITING_STATUSES)[number]

/** What a `status:` value names, or null for one that is none of the three. `needs-input` is read as the
 *  value spelled the way the alias key's own hyphenated form is. */
function statusValueOf(value: string): AwaitingStatus | null {
  const v = value.trim().toLowerCase().replace(/-/g, "_")
  return (AWAITING_STATUSES as readonly string[]).includes(v) ? (v as AwaitingStatus) : null
}

/** The fence's two answer lines as written: the `status:` value (null when absent or none of the three)
 *  and the `needs_input:` alias (null when absent or neither boolean). The LAST of each wins, as
 *  awaitingFenceTitle's does. */
function restAnswerLines(hints: readonly AwaitingHint[] | undefined): { status: AwaitingStatus | null; needsInput: boolean | null } {
  let status: AwaitingStatus | null = null
  let needsInput: boolean | null = null
  for (const h of hints ?? []) {
    if (h.kind === "status") status = statusValueOf(h.value)
    else if (h.kind === "needs_input") {
      const value = h.value.trim().toLowerCase()
      needsInput = value === "true" ? true : value === "false" ? false : null
    }
  }
  return { status, needsInput }
}

/** Does this fence name the HUMAN as its wait — `steps:` to perform, or `questions:` still owed an answer?
 *  Either is the answer `needs_input` by construction, whatever the answer line says. */
function fenceWaitsOnHuman(hints: readonly AwaitingHint[] | undefined): boolean {
  return awaitingSteps(hints).length > 0 || awaitingQuestions(hints).length > 0
}

/** The fence's answer to WHERE the thread sits while it waits — `needs_input`, `working` or `watching` —
 *  or null when it said no more than `needs_input: false` (out of the queue, band left to the board's
 *  default) or nothing usable at all. A valid `status:` outranks the `needs_input:` alias beside it, so a
 *  fence that writes both reads as its newer line; `needs_input: true` alone is `needs_input`.
 *
 *  STEPS AND QUESTIONS ARE THE ANSWER, whatever the line says (see awaitingNeedsInput). */
export function awaitingStatus(hints: readonly AwaitingHint[] | undefined): AwaitingStatus | null {
  if (fenceWaitsOnHuman(hints)) return "needs_input"
  const { status, needsInput } = restAnswerLines(hints)
  if (status) return status
  return needsInput === true ? "needs_input" : null
}

/** The fence's answer to "does the human need to look now?": `true` (`status: needs_input`, or the alias
 *  `needs_input: true`), `false` (`status: working`/`watching`, or `needs_input: false`), or null when the
 *  fence gave no answer or one that is none of them — which a new-contract thread is bumped for and
 *  queued on, never parked on. This is the QUEUE's question alone; which band a `false` lands in is
 *  awaitingStatus's.
 *
 *  STEPS ARE THE ANSWER, whatever the line says. A fence listing `steps:` is waiting on the human to
 *  perform them, so the human is needed now by construction: the line may be left out, and a `false`
 *  beside steps is a contradiction read the safe way — a thread that is waiting on its human must never
 *  be the one that disappears from their queue. Questions are the same answer for the same reason: a
 *  fence still waiting on the human's ANSWER is waiting on the human. */
export function awaitingNeedsInput(hints: readonly AwaitingHint[] | undefined): boolean | null {
  if (fenceWaitsOnHuman(hints)) return true
  const { status, needsInput } = restAnswerLines(hints)
  if (status) return status === "needs_input"
  return needsInput
}

export const AWAITING_ITEM_KINDS = ["shell", "agent", "timer", "pr", "thread", "command"] as const
export type AwaitingItemKind = (typeof AWAITING_ITEM_KINDS)[number]
export function isAwaitingItemKind(kind: string): kind is AwaitingItemKind {
  return (AWAITING_ITEM_KINDS as readonly string[]).includes(kind)
}

/** `for: 2h` — how long this park may stand before ntwine bumps the worker to re-check everything.
 *
 *  A DURATION, NEVER AN INSTANT, and that is the entire point. The grammar this replaced took an absolute
 *  ISO instant, which a worker has to compute — and on 2026-08-15 one wrote `timer: 2026-08-14T19:45:00Z`
 *  into a fence it published at `01:39:59Z`, an instant already 5h55m gone. It parsed (the old validator
 *  checked shape only), armed nothing (an already-past timer is never registered — the boot no-mass-fire
 *  guard), and the thread sat 5.5 hours looking parked with nothing able to wake it. A duration cannot be
 *  written in the past, needs no clock arithmetic and carries no timezone, so that failure is not merely
 *  caught here — it is unrepresentable. */
const AWAITING_DURATION_RE = /^(\d{1,5})(s|m|h|d)$/
const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** The park's ceiling for a wait on the thread's OWN running work — a background shell, a sub-agent.
 *  A worker may ask for less; anything longer is capped rather than refused, so a fat-fingered
 *  `for: 9999d` still parks — it just cannot disappear a thread for a decade.
 *
 *  A DAY IS RIGHT FOR THIS KIND AND ONLY THIS KIND. A shell or a sub-agent lives inside the session
 *  that launched it, so a wait on one that has stood for a day is almost always a wait on something
 *  already dead. A PULL REQUEST is nothing like that and gets its own, far higher ceiling — see
 *  PR_WATCH_FOR_MAX_MS. */
export const AWAITING_FOR_MAX_MS = 24 * 60 * 60 * 1000
/** The ceiling for a park that names a SUB-AGENT, and it is a check-in cadence rather than a timeout.
 *  An orchestrator parked on its children for the full day reports nothing for the whole run: @3-0 rested
 *  `for: 8h` on five lanes of fixers and the board showed one stale line while they landed work
 *  (David 2026-10-03: "the top level thread should regularly be reporting back feedback and
 *  communicating with sub agents … avoid long periods of top level no updates"). Expiry wakes the parent
 *  with parkExpiredWakeMessage's check-in steps, and re-parking stays unlimited. Shipped at an hour, cut
 *  to 20 minutes and settled at 30 the same day: each check-in re-reads the orchestrator's whole
 *  context, a 20-minute wake would often land mid-task with no news (unmeasured), and "Ask for update" covers impatience. */
export const AGENT_PARK_FOR_MAX_MS = 30 * 60 * 1000
/** Milliseconds as WRITTEN, uncapped — for a caller that has to know whether the ceiling bit. Every
 *  wait applies one; none of them may apply it silently. */
export function parseAwaitingDurationRaw(value: string): number | null {
  const m = AWAITING_DURATION_RE.exec(value.trim())
  if (!m) return null
  const ms = Number(m[1]) * DURATION_UNIT_MS[m[2]]
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms
}

// A user-chosen snooze is UI lifecycle state, not agent-authored transcript state. The browser
// serializes local date/time input with Date#toISOString, so the wire/storage representation is one
// unambiguous UTC instant. Keeping this stricter than the legacy awaiting-timer grammar avoids locale
// strings and offset-normalization surprises at the RPC boundary.
export const SnoozeUntil = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "Snooze time must be an ISO-8601 UTC instant",
).refine((value) => {
  const instant = Date.parse(value)
  // Date.parse normalizes impossible calendar dates in some runtimes (for example February 31).
  // Round-trip the canonical UTC serialization so the durable deadline is a real exact instant.
  return Number.isFinite(instant) && new Date(instant).toISOString() === value
}, "Snooze time must be valid")
export type SnoozeUntil = z.infer<typeof SnoozeUntil>

// The follow-up a snooze carries. Its presence is what turns a snooze from a passive reminder (the
// card re-surfaces, you act) into a SCHEDULED BUMP (ntwine resumes the agent with this text at the
// deadline). Trimmed at the boundary so whitespace can never arm a wake that delivers nothing, and
// capped like a composer message because it is delivered as an ordinary user turn.
export const SNOOZE_PROMPT_MAX = 4000
export const SnoozePrompt = z.string().trim().min(1).max(SNOOZE_PROMPT_MAX)
export type SnoozePrompt = z.infer<typeof SnoozePrompt>

// ---- THE RECURRING PROMPT (scheduler SOURCES 4 and 5) --------------------------------------------
// ONE piece of text, and up to two independent reasons to send it:
//
//   ON REST      (SOURCE 5) — every time the thread comes to a stop. No clock and nothing to tune: if
//                it stopped, it is prompted. This is what drives an effort forward.
//   ON SCHEDULE  (SOURCE 4) — every N minutes on a clock the operator sets, consulting nothing about
//                what the thread is doing and DELIVERED MID-TURN. This is what reaches a thread that
//                never stops.
//
// Either, both, or neither. NEITHER IS THE OFF STATE — there is deliberately no separate enable switch,
// because with both triggers off nothing can fire and a third toggle would only be a way to disagree
// with the other two (maintainer 2026-08-03: "we can delete the top-level toggle since you can now
// achieve that by just disabling both of the other two toggles").
//
// WHY ONE PROMPT AND NOT TWO FEATURES. These shipped as separate features with separate prompts, and
// the argument for keeping them apart rested on something that is no longer true. While a beat was held
// until the thread rested, a schedule could only ever deliver AT a rest — and the rest trigger fires at
// every rest — so with one shared text the schedule's deliveries were a strict subset of the rest
// trigger's: same words, same instants, nothing added. Mid-turn delivery is what pulled the two apart,
// and once they genuinely diverge, "nudge this thread whenever it stops, and at least every N minutes
// even if it doesn't" is ONE intent that used to cost two prompts and two toggles to express.
//
// What that costs, stated plainly: you can no longer run two DIFFERENT texts on the two triggers.
// Weighed and accepted — the shared-intent case is the common one.
export const RECURRING_PROMPT_MAX = SNOOZE_PROMPT_MAX
// One minute floor: a delivery is read at the agent's next sampling boundary, so a sub-minute cadence
// buys no promptness — it only churns the outbox and talks over the work. One day ceiling keeps a
// forgotten schedule from being indistinguishable from a dead one.
export const RECURRING_MIN_INTERVAL_SECONDS = 60
export const RECURRING_MAX_INTERVAL_SECONDS = 24 * 60 * 60
export const RecurringPromptText = z.string().trim().min(1).max(RECURRING_PROMPT_MAX)

// WHAT THE PANEL PREFILLS on a thread that has never armed one. The overwhelmingly common reason an
// operator reaches for this control is the same one every time — the thread stopped with work left in it
// — so the panel writes that sentence for them rather than making them phrase it again. It is a starting
// point, not a fixed string: it is seeded into an editable textarea and anything typed over it wins, and
// it arms NOTHING until the operator switches a trigger on (see RecurringPromptControl).
//
// IT IS DELIBERATELY LOPSIDED (maintainer 2026-08-14: "should bias the agent strongly towards continuing
// with its work if there is incomplete work, unless there is a pressing or imminent decision that is
// needed from the human"). It lands on a thread that has already stopped, so the only outcome worth
// buying is the one where it starts again — hence it sends the worker straight back to the work.
//
// MAINTAINER-AUTHORED, VERBATIM (2026-08-24: "when did this get so fcking wordy?" … "Use my suggestion
// verbatim"). The text below is the maintainer's own wording, byte for byte — do not grow it back. It
// had grown twice: `0092d21c` added the decide-don't-ask clause and an enumeration of the endings a
// worker mistakes for one, `b2d7dc58` cut it to one sentence on the maintainer's instruction, and
// `b7cb8723` grew it again to 92 words carrying two ceiling guards. Those guards were real — traced
// 2026-08-17 on `investigate-nubjs-nub-642`, dispatched to TRIAGE issue #642, which produced the
// analysis, waited 36 hours on an unanswered question, and then — bumped by this prompt at every rest,
// with no ceiling on "keep going" — decided the question itself and shipped seven commits. But the
// guards no longer need to live HERE: the worker contract states the ceiling at length (discovered work
// is a finding to report, a triage/review/plan is finished when its write-up is), and the fence-less-rest
// nudge (`SIGNOFF_NUDGE_MESSAGE`, pinned in `signoff-nudge.test.ts`) repeats it. So this string went
// back to the instruction alone.
//
// NO BACKTICKED FENCE NAMES IN HERE. This text is rendered as markdown wherever the operator sees it,
// and a lone ``` opens a code block that swallows the rest of the card.
//
// Nothing here teaches the ```done exit, because the trailer already does (`OPT_OUT_NOTE`), on every
// delivery, whatever the operator has typed over this text.
export const DEFAULT_RECURRING_PROMPT =
  "If additional work remains on the original task, keep going. Make decisions autonomously."
export const RecurringIntervalSeconds = z
  .number()
  .int()
  .min(RECURRING_MIN_INTERVAL_SECONDS)
  .max(RECURRING_MAX_INTERVAL_SECONDS)

// What the board renders for a thread carrying one. The three triggers are independent booleans rather
// than one `enabled` flag, and the text survives all of them being switched off so re-arming costs no
// retyping. `intervalSeconds` is present whenever a schedule has ever been set, INCLUDING while the
// heartbeat is off — otherwise flipping the schedule back on would lose the cadence the operator chose.
export const ThreadRecurringPrompt = z.object({
  prompt: z.string(),
  /** The three mechanisms, named as the panel labels them. `stopHook` fires at every rest; `heartbeat`
   *  fires on `intervalSeconds`; `postCompaction` fires whenever the harness summarizes the thread's
   *  context away. The latter two both reach the agent mid-turn. */
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  postCompaction: z.boolean(),
  intervalSeconds: z.number().int().positive().optional(),
  armedAt: z.string(),
  /** Last delivery per trigger; stamped separately so each reads its own clock. */
  lastRestFiredAt: z.string().optional(),
  lastScheduleFiredAt: z.string().optional(),
  lastCompactFiredAt: z.string().optional(),
  /** THE RUN COUNTER: deliveries that actually reached the worker under THIS generation (a text or
   *  cadence edit starts a new one at 0). Optional only so a view built by an older server still parses. */
  runs: z.number().int().nonnegative().optional(),
  /** The LIMITS (2026-09-29). Either, both or neither: with neither the Goal is unbounded, as before. */
  maxRuns: z.number().int().positive().optional(),
  forSeconds: z.number().int().positive().optional(),
  /** The instant a time bound runs out — present exactly when `forSeconds` is. */
  endsAt: z.string().optional(),
  /** Present when the Goal DISARMED ITSELF at a limit: which one, and when. Retired the moment any
   *  trigger is switched back on or the text changes. */
  stopped: z.object({ reason: z.enum(["runs", "time"]), at: z.string() }).strict().optional(),
}).strict()
export type ThreadRecurringPrompt = z.infer<typeof ThreadRecurringPrompt>

// ---- THE GOAL'S LIMITS ---------------------------------------------------------------------------
// A Goal is a loop when it has an end. Maintainer 2026-09-29: loops are a Goal SETTING, not a new thread
// type — so the end is two optional numbers on the same row: a count of deliveries, and a span from
// arming. Reaching either disarms the Goal (text kept, exactly as a switch-off keeps it), and the worker
// hears ONE wake saying which limit ended it (`goalLimitMessage`).
//
// The span is written in the SAME grammar the worker contract teaches for an ```awaiting fence's
// `for:` — `30m`, `2h`, `3d` — because a worker arming a bounded loop already knows that grammar and
// should not learn a second one for the same idea. It is parsed by that grammar's own parser rather than
// a copy, so the two cannot drift; the bounds below are the Goal's own.
export const GOAL_MAX_RUNS = 10_000
/** A time bound shorter than a minute is shorter than most single runs — it could only ever stop the
 *  loop before its first delivery landed. Thirty days matches the one-off timer's ceiling. */
export const GOAL_MIN_FOR_SECONDS = 60
export const GOAL_MAX_FOR_SECONDS = 30 * 24 * 60 * 60
export const GoalMaxRuns = z.number().int().min(1).max(GOAL_MAX_RUNS)
export const GoalForSeconds = z.number().int().min(GOAL_MIN_FOR_SECONDS).max(GOAL_MAX_FOR_SECONDS)

/** `2h` → 7200. `null` for anything the `for:` grammar does not accept, or out of the Goal's bounds. */
export function parseGoalForSeconds(value: string): number | null {
  const ms = parseAwaitingDurationRaw(value)
  if (ms === null) return null
  const seconds = Math.round(ms / 1000)
  return seconds >= GOAL_MIN_FOR_SECONDS && seconds <= GOAL_MAX_FOR_SECONDS ? seconds : null
}

/** A time bound as the `for:` grammar writes it, so it reads back in the shape it was typed: the
 *  LARGEST unit that divides it exactly (`2h`, `90m`, `3d`). Always a single token, which is what makes
 *  it round-trip through `parseGoalForSeconds`. */
export function formatGoalFor(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** What ntwine delivers ONCE when a Goal disarms itself at a limit (scheduler `evalGoalLimits`). ntwine is
 *  the author, so this is the news and not an operator prompt: which limit, and how many runs landed.
 *
 *  It tells the worker NOT to re-arm around the limit. The limit is the loop's terminating condition —
 *  whoever set it (the human in the footer, or the worker itself) chose where the loop ends, and a
 *  worker that reads "stopped" as an obstacle and calls `start` again has turned a bounded loop back
 *  into an unbounded one. */
export function goalLimitMessage(o: { reason: "runs" | "time"; runs: number; maxRuns?: number | null; forSeconds?: number | null }): string {
  const runs = `${o.runs} run${o.runs === 1 ? "" : "s"}`
  const head = o.reason === "runs"
    ? `Your Goal reached its run limit and stopped: ${o.runs} of ${o.maxRuns ?? o.runs} runs delivered.`
    : `Your Goal reached its time limit${o.forSeconds ? ` (${formatGoalFor(o.forSeconds)})` : ""} and stopped after ${runs}.`
  return (
    `${head} ntwine will not send it again.\n\n` +
    "(The loop is over by design. Wrap up what it was doing and say where the work stands. Its text is" +
    " kept in the thread footer, so it can be re-armed — but do not re-arm it yourself just to keep going" +
    " past the limit that ended it.)"
  )
}

// ---- The opt-out ---------------------------------------------------------------------------------
// THE OPT-OUT IS THE ```done FENCE, as of 2026-08-11. A worker that signs off as done has said "there
// is no further work here", and ntwine stops prompting it — every trigger, because a run that keeps
// being woken has not stalled and the whole point of the signal is that it has finished.
//
// IT USED TO BE A SENTINEL WORD, `ALLDONE`, and collapsing the two is the change. One vocabulary beats
// two: the worker already has to end its turn with a fence, and a second magic token that ALSO means
// "stop" was a rule to remember on top of a rule to remember. Maintainer 2026-08-11: "we should drop
// ALLDONE in favor of simply ```done".
//
// It is not a "skip this one" — it is the end of the arrangement, and nothing but new activity on the
// thread reopens it. Every delivered message therefore names it in one de-emphasized line and warns
// against it in the same breath: the failure it guards is a worker that signs off to look tidy and
// silently parks an effort nobody is watching.
//
// Mechanically it needs no stored state at all, which is what makes it honest: both the fence and the
// legacy sentinel are folded off the FINAL assistant message, so either holds for exactly as long as
// that message is the thread's last word. Anything the thread says or receives afterwards reopens the
// loop by itself.

// Claude Code narrates its OWN control action into the transcript: every turn cut short leaves a bare
// `[Request interrupted by user]` user record. ntwine cuts turns short as a feature — "send now" (⌘⏎ and
// the queue's push-through button) interrupts the running turn so the worker reads the queue at once —
// so the marker landed as a human bubble directly above the very message that caused it, saying nothing
// the reader did not just do (maintainer 2026-08-14). The broker's own shutdown writes the same record,
// which is worse: nobody typed anything at all.
//
// EXACT match on the trimmed text, deliberately not a prefix: all 306 of these records across the 3933
// transcripts on this machine are one of these two strings ALONE in a single text block, so a human
// message that opens by quoting the marker keeps its bubble.
//
// Lives HERE rather than in transcript.ts (its first caller) because the tailer needs it too — an
// interrupt receipt is a `user` record that means the turn is OVER, not starting — and
// transcript.ts already imports from tailer.ts, so the other direction would close a cycle.
const INTERRUPT_MARKERS = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]
export function isInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKERS.includes(text.trim())
}

/** LEGACY. The sentinel that used to be the opt-out, superseded by the ```done fence on 2026-08-11.
 *
 * STILL HONOURED, and deliberately: workers dispatched before the change are running right now with
 * trailers that told them to reply `ALLDONE`, and a scheduler that stopped recognizing it the same day
 * would silently take their exit away and loop them forever. It is no longer ADVERTISED anywhere — see
 * `OPT_OUT_NOTE` — so nothing new learns it, and the recogniser can be deleted once no session predates
 * the change. */
export const ALLDONE_SENTINEL = "ALLDONE"

/** Does this assistant text defer its recurring prompt? True iff some line, stripped of markdown
 * emphasis/backticks and trailing punctuation, IS the sentinel.
 *
 * CASE-SENSITIVE, which is load-bearing now that the word is `AWAITING`: ntwine's own signal-fence
 * grammar opens with ```awaiting, and a worker parking on a fence writes that token constantly. Lowered
 * case would make every ```awaiting fence silently suppress a bump as well. */
export function saysAllDone(text: string | undefined): boolean {
  if (typeof text !== "string") return false
  for (const line of text.split(/\r?\n/)) {
    // Tolerate the ways a model dresses a line: a list bullet, bold/italic, code ticks, a quote marker,
    // and trailing punctuation. The comparison itself is EXACT and case-sensitive — "all done" is prose,
    // and only the shouted token is the opt-out.
    const bare = line.trim().replace(/^[*_`>\s-]+/, "").replace(/[*_`.!\s]+$/, "")
    if (bare === ALLDONE_SENTINEL) return true
  }
  return false
}

// THE TRAILER, in one de-emphasized line, on both sources.
//
// It has two jobs pulling against each other: a worker being re-prompted needs to know the opt-out
// exists at all, and it must not reach for it. So the line OFFERS and WARNS in the same breath, and
// stays parenthetical — the operator's own words are the message; this is a footnote about the
// machinery. Expanding it is how a worker starts treating "am I allowed to stop?" as the question,
// instead of the work it was actually sent.
const OPT_OUT_NOTE =
  "To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished:" +
  " it files this thread away, and nothing but new work from the user reopens it."

/** What ntwine delivers when the ON REST trigger fires: the operator's words VERBATIM, then the trailer.
 * Kept beside the parser so the wording sent and the wording recognized can never drift apart.
 *
 * IT DOES NOT ADVERTISE THE OTHER EXIT, and that is a budget decision rather than an oversight. An
 * ```awaiting fence on a wait the scheduler owns now holds this trigger too (scheduler
 * `parkedOnAWaitItCannotAdvance`), so a parked worker could in principle be told so here — but the
 * trailer is capped at a footnote, the shared note already spends all of it, and the worker contract
 * teaches the park at length. A worker that parks stops being bumped, so it never reads this line
 * again; the one that does read it is mid-work, where ```done is the only exit worth naming.
 *
 * `overQuestion` IS THE ONE CASE THAT NEEDS MORE THAN A FOOTNOTE. The rest trigger fires over an
 * unanswered ```question fence (scheduler `restMessageIsSignedOff`), so this delivery can land on a
 * worker whose own last word was a question to the human. Handed the bare goal there, the honest thing
 * for it to do is ask again — its question really is unanswered — and the operator gets the same card
 * twice, which is precisely the loop the old question hold existed to prevent. So the delivery that
 * crosses a pending question SAYS SO: no answer is coming, make the call yourself. The clause carries no
 * parenthesis, because `RECURRING_TRAILER` matches the trailer up to the first one. */
export function restPromptMessage(prompt: string, opts: { overQuestion?: boolean } = {}): string {
  const note = opts.overQuestion ? `${OVER_QUESTION_NOTE} ${OPT_OUT_NOTE}` : OPT_OUT_NOTE
  return `${prompt.trim()}\n\n(Goal — sent each time you come to rest. ${note})`
}

// What the trailer adds when the bump crosses the worker's own unanswered question. It has to do two
// things the plain note does not: overrule the worker's correct instinct to re-ask, and tell it what to
// do with the decision instead — because a call the operator cannot see is worse than the question.
//
// It named an operator SETTING until 2026-08-16 ("the operator has AUTONOMOUS MODE on"), which stopped
// being true when the question hold was deleted: arming a Goal at all is now the whole of that consent.
// Maintainer, on dropping the switch: "If somebody enables the stop hook goal, then that kind of implies
// to me that they don't really want to answer any more questions."
const OVER_QUESTION_NOTE =
  "Your registered question is still unanswered, and a Goal armed at rest means the operator is not waiting" +
  " to answer it: decide it yourself, say in one line which way you went and what would reverse it," +
  " and carry on. Do NOT re-ask it."

/** What ntwine delivers when the POST-COMPACTION trigger fires (scheduler SOURCE 7).
 *
 * This one lands in a context that has just been summarized away, which is the whole reason it exists —
 * so unlike its two siblings the trailer must first say WHERE the reader is, or the operator's words
 * arrive with nothing to attach to. It also answers the compaction preamble in the same breath: a
 * worker reading "a previous conversation that ran out of context" routinely treats it as a report on
 * ITSELF and starts winding down, and this delivery is the one piece of ntwine text guaranteed to land
 * in that exact window.
 *
 * Like the schedule trigger's, it may arrive MID-TURN — a compaction does not stop the work. */
export function compactionPromptMessage(prompt: string): string {
  return (
    `${prompt.trim()}\n\n(Goal — your context was just compacted. This is what you asked to` +
    " be handed back: re-ground on it before doing anything else, and treat it as authoritative over" +
    " anything the summary implies. The window is close to empty again, which is normal and not a reason" +
    ` to wind down or hand off. ${OPT_OUT_NOTE})`
  )
}

/** What ntwine delivers when the ON SCHEDULE trigger fires. Same text, same shape, and it names the
 * cadence — which is the ONE thing that distinguishes the two deliveries now that the prompt is shared.
 * A worker needs that distinction: a scheduled delivery may arrive MID-TURN, so reading one does not
 * mean it has stopped.
 *
 * The trailer's exact wording is pinned by `parseRecurringPrompt` below and by the prompt goldens —
 * change one and you must change all three. */
export function schedulePromptMessage(prompt: string, intervalSeconds: number): string {
  return `${prompt.trim()}\n\n(Goal — sent every ${formatIntervalLabel(intervalSeconds)}. ${OPT_OUT_NOTE})`
}

/** "10m" / "1h 30m" / "90s" — whole units only, because a cadence printed to the second promises a
 * precision the delivery does not have (it is read at the agent's next sampling boundary).
 *
 * The house duration grammar (`web/src/lib/durationLabels.ts`), which is also why an hour and a half
 * is `1h 30m` rather than the `1.5 hr` this printed until 2026-08-31. That decimal was not only off
 * the house grammar, it broke the round trip: `RECURRING_TRAILER` stops the cadence capture at the
 * first `.`, so a 90-minute goal's trailer never parsed back into a wake divider. */
export function formatIntervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

/** What a delivered recurring prompt looks like once it is back out of the transcript.
 *
 * The chat needs to tell a delivery from a human message, and to say WHICH TRIGGER fired, and the
 * transcript carries no structure — a delivery is an ordinary user turn. So this parses the trailer the
 * two composers above emit, exactly as `parseGithubWakeSteer` parses the steer its own formatter writes.
 * That is not a text GUESS: the format is ntwine's, it is defined ten lines up, and both directions live
 * in this file so they cannot drift. Anything that does not match returns undefined and renders as it
 * did before — text is never lost to a parse. */
export interface RecurringPrompt {
  kind: "rest" | "schedule" | "compaction" | "signoff"
  /** The cadence as the trailer stated it ("10 min"); absent for a rest or post-compaction delivery. */
  every?: string
  /** The operator's own words, with the trailer removed. */
  prompt: string
}
// The LEGACY alternates matter: transcripts written before the two features merged carry
// "Stop hook — …" / "Heartbeat — sent every …", and those messages are still sitting in every open
// thread on disk. Dropping them from the pattern would not lose the text (a non-match falls through to
// plain rendering) but it would silently demote a whole thread's history from wake dividers to prose.
//
// The post-compaction alternate does not say "sent …" at all — its trailer opens by telling the reader
// where they are, because it lands in a window that was just emptied. So it is matched on its own
// opening clause rather than bent into the shared "sent X" shape.
const RECURRING_TRAILER =
  /\n\n\((?:Goal|Recurring prompt|Stop hook|Heartbeat) — (?:sent (?:(each time you come to rest)|every ([^.)]+))|(your context was just compacted))\. [^)]*\)$/
export function parseRecurringPrompt(text: string | undefined): RecurringPrompt | undefined {
  if (typeof text !== "string") return undefined
  // ntwine's built-in sign-off reminder (scheduler SOURCE 9). It carries no trailer — it is not the
  // operator's text with a note attached, it IS ntwine's text — so it is matched on its own opening
  // marker and collapsed like any other repeating ntwine delivery. Left as a card it dominated the queue
  // item it was complaining about (maintainer 2026-08-12, with a screenshot of exactly that).
  const lead = text.trimStart()
  if (SIGNOFF_NUDGE_MARKERS.some((marker) => lead.startsWith(marker))) return { kind: "signoff", prompt: "" }
  const m = RECURRING_TRAILER.exec(text.trimEnd())
  if (!m) return undefined
  const prompt = text.trimEnd().slice(0, m.index).trim()
  if (!prompt) return undefined
  if (m[3]) return { kind: "compaction", prompt }
  return m[2]
    ? { kind: "schedule", every: m[2].trim(), prompt }
    : { kind: "rest", prompt }
}

// ---- ONE-OFF TIMERS (scheduler SOURCE 6) ---------------------------------------------------------
// A worker's own alarm clock: text it asks ntwine to hand back at ONE instant, once. It is the recurring
// prompt's ON SCHEDULE trigger with the repetition taken out — same durable outbox, same mid-turn
// delivery — and a thread may hold ARBITRARILY MANY at a time, which is the whole reason they are rows
// of their own rather than another set of `recurring_*` columns on the session (one row can hold one
// arrangement; a worker that wants "check the deploy in 10 min AND re-read the spec in an hour" needs
// two).
//
// MID-TURN, like the heartbeat and unlike the human's snooze. A timer set for 15:00 that a busy thread
// only hears at 15:50 has not kept its promise, and "in ten minutes" is the instruction being obeyed.
// Both transports take a queued mid-turn message without aborting the work in flight.
//
// NO ALLDONE OPT-OUT, and no trailer teaching one. That sentinel exists because a RECURRING trigger is
// an infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, so
// the only thing worth saying in the trailer is that this was a timer and it will not fire again.
export const TIMER_PROMPT_MAX = SNOOZE_PROMPT_MAX
// Ten seconds is the scheduler's own tick, so a shorter delay would promise a precision the delivery
// cannot have. Thirty days is far past any real "come back to this later" while still rejecting a
// mistyped epoch. The armed CAP is what makes "arbitrarily many" safe: a looping tool call cannot fill
// the table, and 64 outstanding alarms is well beyond what any real effort schedules.
export const TIMER_MIN_DELAY_SECONDS = 10
export const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60
export const TIMER_MAX_ARMED = 64

export const TimerPromptText = z.string().trim().min(1).max(TIMER_PROMPT_MAX)

/** What ntwine delivers when a one-off timer fires: the worker's own words VERBATIM, then a one-line
 *  trailer naming the INSTANT — with several timers armed at once, the instant is the only thing that
 *  says WHICH one this is.
 *
 *  Deliberately NOT parsed back out for a bespoke transcript line, unlike a recurring delivery. That
 *  parser exists because a recurring prompt repeats the same paragraph down the whole transcript and has
 *  to collapse to a divider; a one-off is said once, so the chat's generic first-party wake card — the
 *  one already written for "a CI/timer/limit wake" — shows it correctly with no new component. */
/** What ntwine delivers when one of a thread's background shells finishes while the thread is RESTING.
 *
 *  There is no operator text to carry — nobody asked for this wake, a finished shell simply happened —
 *  so the message IS the news, and it has two jobs: say WHICH shell precisely enough to act on, and say
 *  why ntwine is the one saying it. The second matters because the agent has a runtime notification for
 *  exactly this event and will reasonably wonder why it did not arrive: it only ever reaches a RUNNING
 *  turn, so a shell that finishes behind a rested worker is never reported by anyone else. */
// ---- THE AGENT-FACING TRAILERS, AS CONSTANTS ------------------------------------------------------
// Each of these is a paragraph ntwine writes FOR THE WORKER at the end of a wake it composed: what the
// registration is, whether it is still armed, and which tool drops it. A human reading the transcript
// has no watcher to re-register and no tool to call, so none of it is ever news to them.
//
// THEY ARE CONSTANTS SO ONE FUNCTION CAN STRIP ALL OF THEM (`stripWakeTrailer`, beside the rest of the
// wake grammar). The dividers already drop the trailer by never rendering it — but that only holds for
// a delivery some parser RECOGNIZED, and the browser is the half that routinely cannot: a tab is a
// build behind whenever ntwine restarts under it, so the first delivery in a shape its bundle predates
// falls through to the raw-text card and prints this boilerplate to the operator (maintainer
// 2026-09-04, on a conflict wake an hour-old tab could not parse: "this should just never show up").
// Stripping in the display projection makes that impossible for a tab of ANY age, and for any wake
// shape, including the ones not written yet.
//
// The WORKER's copy is untouched — the projection narrows what is shown, never what was delivered.
export const PR_WATCH_SPENT_TRAILER = "(This watcher is spent — there is nothing further to report on a finished PR.)"
export const PR_WATCH_ARMED_TRAILER = "(Registered PR watcher — STILL ARMED. It reports again on the next CI change, review,"
  + " comment, label, conflict or review request. Drop it with `ntwinectl watch-pr drop <id>` when it stops"
  + " mattering.)"
export const SHELL_DONE_TRAILER = "(ntwine sends this because it finished after you came to rest, where your runtime's own completion"
  + " notification does not reach you. Read its output if you still need it.)"
export const ISSUE_WATCH_SPENT_TRAILER = "(This watcher is spent — there is nothing further to report on a closed issue.)"
// A worker can no longer register an issue watcher (removed 2026-10-14); this trailer ends the wakes of
// one it registered before then, which keeps polling until it settles or expires.
export const ISSUE_WATCH_ARMED_TRAILER = "(Registered issue watcher — STILL ARMED. It reports again on the next comment, label or"
  + " assignee change, and once more when the issue closes. Drop it with `ntwinectl unwatch <id>` when"
  + " it stops mattering.)"
// THE TWO ARMED TRAILERS AS THEY WERE WRITTEN UNTIL 2026-10-11, when the drop verb they name was an MCP
// tool. Nothing composes them any more, but every transcript written before that date ends its watcher
// wakes with these exact bytes, and `stripWakeTrailer` matches exact strings — so they stay in its list,
// or a wake delivered last week would start printing its boilerplate at the operator again.
const LEGACY_PR_WATCH_ARMED_TRAILER = "(Registered PR watcher — STILL ARMED. It reports again on the next CI change, review,"
  + " comment, label, conflict or review request. Drop it with `mcp__ntwine__watch_pr` when it stops"
  + " mattering.)"
const LEGACY_ISSUE_WATCH_ARMED_TRAILER = "(Registered issue watcher — STILL ARMED. It reports again on the next comment, label or"
  + " assignee change, and once more when the issue closes. Drop it with `mcp__ntwine__watch_issue` when"
  + " it stops mattering.)"
// The same, as written from 2026-10-11 until `ntwinectl watch-issue` was removed on 2026-10-14.
const LEGACY_ISSUE_WATCH_CLI_ARMED_TRAILER = "(Registered issue watcher — STILL ARMED. It reports again on the next comment, label or"
  + " assignee change, and once more when the issue closes. Drop it with `ntwinectl watch-issue drop <id>` when"
  + " it stops mattering.)"
// The same two, for a watcher the HUMAN armed from the done card (router.watchDoneRef, 2026-10-07). The
// worker signed off `done` and never registered it, so the wake says whose it is, that it stays, and how
// to rest on it — a worker that read the plain trailer dropped "its" watcher or tried to sign off around it.
// A watch the HUMAN armed is one they want to follow (maintainer 2026-10-07: watched threads that "never
// come back" to the queue). So only green CI may stay quiet; a review, a comment, red CI or any state
// change goes back in front of them as `needs_input`, rather than being judged noise and re-snoozed.
const HUMAN_WATCH_SURFACE = " The user chose to follow this, so put it in front of them: rest on it with"
  + " `status: needs_input` and one or two sentences on what happened, unless it needs work from you first."
  + " It does not block `done`.)"
export const PR_WATCH_HUMAN_TRAILER = "(The user registered this PR watcher from your done card — STILL ARMED. It reports again"
  + " on the next CI change, review, comment, label, conflict or review request. Leave it armed." + HUMAN_WATCH_SURFACE
/** Green CI alone on a human's watch: the one report that stays quiet. */
export const PR_WATCH_HUMAN_QUIET_TRAILER = "(The user registered this PR watcher from your done card — STILL ARMED. Green CI"
  + " alone needs nothing from the user: rest on it with the fence alone, naming it under `prs:` with"
  + " `status: watching` and a long `for:`. It does not block `done`.)"
export const ISSUE_WATCH_HUMAN_TRAILER = "(The user registered this issue watcher from your done card — STILL ARMED. It reports"
  + " again on the next comment, label or assignee change, and once more when the issue closes. Leave it"
  + " armed." + HUMAN_WATCH_SURFACE

/** What ntwine delivers when a REGISTERED PR WATCHER has something to report.
 *
 *  Two things can move and the message names which: CI reaching a terminal verdict, and new review or
 *  comment activity. Both in one message when both happened in one poll — a worker woken twice for one
 *  glance at the same PR is a wasted turn.
 *
 *  It says the watcher is STILL ARMED, because the opposite is the expensive mistake: a worker that
 *  thinks its watcher is spent will re-register (a duplicate, so two wakes per event) or stop waiting.
 *
 *  Its STATUS lines read back out through `parsePrWatchWake`, which lives with the rest of the wake
 *  grammar (the `WAKE_REF` pattern it shares is declared there). That is the pair the chat renders a
 *  hairline divider from — change the wording of a line here and change it there in the same edit. */
export function prWatchWakeMessage(input: {
  target: string
  checks?: {
    verdict: "passing" | "failing" | "gated"
    passed: number
    failed: number
    failing: string[]
    /** Terminal but asserted nothing — printed beside a green tally so a rollup of skips can never again
     *  read as a build. Optional: a report held across the 2026-09-04 upgrade carries neither this nor
     *  the two below, and folding one forward must not invent them. */
    skipped?: number
    /** `gated` only: how many workflows GitHub is holding for an approval, and which. */
    gated?: number
    gating?: string[]
  }
  /** What changed about the PR itself — a conflict appearing, a label moving, a reviewer being asked.
   *  ONE LINE for all of them, joined with semicolons, because each is a clause and not a headline: a
   *  separate line per fact would give a label edit the same weight as a red build. */
  changes?: string[]
  review?: string
  merged?: boolean
  closed?: boolean
  /** The human armed it from the done card, not the worker — the trailer says so (PR_WATCH_HUMAN_TRAILER). */
  byHuman?: boolean
}): string {
  const lines: string[] = []
  if (input.merged || input.closed) {
    lines.push(`\u23f0 ${input.target} was ${input.merged ? "MERGED" : "CLOSED"}.`, "")
    lines.push(PR_WATCH_SPENT_TRAILER)
    return lines.join("\n")
  }
  if (input.checks) {
    const c = input.checks
    if (c.verdict === "gated") {
      // THE ONE REPORT THAT NAMES ITS OWN DEAD END. Every other line here says what CI did; this says CI
      // has not been allowed to start, and no amount of waiting changes that — a human has to press the
      // button. A worker parked on the watcher alone would sit out its whole `for:` and learn nothing.
      const held = c.gated ?? c.gating?.length ?? 0
      lines.push(
        `⏸️ CI on ${input.target} is WAITING FOR APPROVAL — ${held} workflow${held === 1 ? "" : "s"} held${c.gating?.length ? `: ${c.gating.join(", ")}` : ""}.`,
        "",
        "Nothing has run on this commit. GitHub holds a fork or first-time contributor's workflows until a"
          + " maintainer approves them, so this does not clear on its own — ask for the approval rather than"
          + " waiting on it.",
      )
    } else if (c.verdict === "passing") {
      // The skip count rides beside the green tally because leaving it out is how "15 checks green" got
      // said about 3 label bots and 12 skips (nodejs/node#65795, 2026-09-04).
      const skipped = c.skipped ?? 0
      lines.push(`\u2705 CI PASSED on ${input.target} — ${c.passed} check${c.passed === 1 ? "" : "s"} green${skipped > 0 ? `, ${skipped} skipped` : ""}.`)
    } else {
      lines.push(`\u274c CI FAILED on ${input.target}${c.failing.length ? `: ${c.failing.join(", ")}` : ""}.`)
    }
  }
  if (input.changes?.length) {
    if (lines.length) lines.push("")
    lines.push(`🔔 ${input.target}: ${input.changes.join("; ")}.`)
  }
  if (input.review) {
    if (lines.length) lines.push("")
    lines.push(input.review)
  }
  const quiet = input.checks?.verdict === "passing" && !input.changes?.length && !input.review
  lines.push("", !input.byHuman ? PR_WATCH_ARMED_TRAILER : quiet ? PR_WATCH_HUMAN_QUIET_TRAILER : PR_WATCH_HUMAN_TRAILER)
  return lines.join("\n")
}

/** What ntwine delivers when a REGISTERED ISSUE WATCHER has something to report — the issue twin of
 *  `prWatchWakeMessage`, with the CI limb gone because an issue has none.
 *
 *  THE LINES KEEP THE PR SHAPES ON PURPOSE. `⏰ owner/repo#N was CLOSED.` and `🔔 owner/repo#N: …` are
 *  exactly what `parsePrWatchWake` and `parsePrWatchStateWake` already read, so a browser tab built before
 *  issues existed draws the same hairline divider for an issue wake as for a PR one instead of falling
 *  through to the raw-text card. The close line carries the REASON as a clause after the divider-bearing
 *  sentence, where a parser that does not know it simply ignores it. */
export function issueWatchWakeMessage(input: {
  target: string
  closed?: { reason?: string }
  /** What changed about the issue itself — a label moving, someone assigned. One line for all of them,
   *  joined with semicolons, for the reason `prWatchWakeMessage.changes` is. */
  changes?: string[]
  review?: string
  /** The human armed it from the done card — ISSUE_WATCH_HUMAN_TRAILER. */
  byHuman?: boolean
}): string {
  const lines: string[] = []
  if (input.closed) {
    // The reason on its OWN line, below the divider-bearing sentence: `PR_WATCH_FINISHED` is anchored at
    // the period, so a clause appended to the close line would cost the chat its divider.
    lines.push(`\u23f0 ${input.target} was CLOSED.`, "")
    if (input.closed.reason) lines.push(`GitHub's reason: ${input.closed.reason}.`, "")
    lines.push(ISSUE_WATCH_SPENT_TRAILER)
    return lines.join("\n")
  }
  if (input.changes?.length) lines.push(`🔔 ${input.target}: ${input.changes.join("; ")}.`)
  if (input.review) {
    if (lines.length) lines.push("")
    lines.push(input.review)
  }
  lines.push("", input.byHuman ? ISSUE_WATCH_HUMAN_TRAILER : ISSUE_WATCH_ARMED_TRAILER)
  return lines.join("\n")
}

export function shellDoneMessage(shell: { taskId?: string; label: string; status: "completed" | "failed" | "killed" }): string {
  const what = shell.taskId ? `\`${shell.taskId}\` — ${shell.label}` : shell.label
  const verb = shell.status === "failed" ? "FAILED" : shell.status === "killed" ? "was STOPPED" : "finished"
  return (
    `\u23f0 Your background shell ${verb}: ${what}.\n\n${SHELL_DONE_TRAILER}`
  )
}

/** The delivered shell-done wake, read back — `null` for anything else.
 *
 *  Same producer/parser pair, and the same reason for it, as the PR-watch status line: the chat draws
 *  this event as a hairline and has nothing but the text to draw it from.
 *
 *  IT EXISTS TO MAKE ONE EVENT READ AS ONE EVENT. A background shell finishing while the worker is
 *  RUNNING is reported by the runtime, and the transcript has always drawn that as a wake divider
 *  (`backgroundWakeLabel` — "Agent terminal «…» finished"). The very same shell finishing while the
 *  worker RESTS is reported by ntwine instead, because the runtime's notification only ever reaches a
 *  running turn — and that one arrived as a full-width card. So whether a shell's completion was a
 *  hairline or a panel came down to whether anyone happened to be awake, which is not a distinction the
 *  transcript should be drawing at all (maintainer 2026-08-19, extending the pr-watch fix: "yes").
 *
 *  The trailer is not parsed and not rendered: "ntwine sends this because your runtime's own completion
 *  notification does not reach you" explains ntwine to the agent, and the human it is shown to never had
 *  that expectation to correct. */
export interface ShellDoneWake {
  taskId?: string
  label: string
  outcome: "finished" | "failed" | "stopped"
}

const SHELL_DONE = /^⏰ Your background shell (finished|FAILED|was STOPPED): (?:`([^`]+)` — )?(.+)\.$/

export function parseShellDoneWake(text: string): ShellDoneWake | null {
  // The FIRST line, unlike the PR-watch scan: this delivery is composed alone and never rides beside
  // another part, so a match anywhere else would mean the agent quoted the message back at itself.
  const m = SHELL_DONE.exec(text.trim().split("\n")[0]?.trim() ?? "")
  if (!m) return null
  const outcome = m[1] === "FAILED" ? "failed" : m[1] === "was STOPPED" ? "stopped" : "finished"
  return { ...(m[2] ? { taskId: m[2] } : {}), label: m[3], outcome }
}

// ---- SUB-AGENTS ENDED BY AN INTERRUPT (router followUp `interrupt` / deliverQueuedNow) -----------
// "Interrupt and send" preempts the worker's turn through the SDK's `query.interrupt()`, and that
// abort takes every BACKGROUND sub-agent with it: each child's sidecar flips to `stoppedByUser` at the
// interrupt instant and its transcript ends on `[Request interrupted by user]`. The worker is told
// nothing by the runtime. Observed on the nub thread `looks-like-my-github-account-was` (2026-09-24):
// the same daemon sub-agent was killed by two successive interrupts (01:06:21Z, 03:11:32Z), and the
// worker — still believing it live — parked on `agents: [abc9b9b5f0da4c677]` and was bumped NOT RUNNING
// twice; the bump itself never reached it, because each next follow-up superseded the pending bump.
// The maintainer chose this over a confirm in the composer: the worker is told what died, so it
// re-dispatches or takes the work over instead of waiting on a child that will never return.
export interface InterruptEndedSubAgent {
  /** The runtime agent id the model was shown — the handle it would write in an `agents:` line. */
  taskId?: string
  label: string
}

const INTERRUPT_ENDED_LEAD = "⚠️ The user's last follow-up was sent with INTERRUPT, which aborted your turn — and the runtime ends every background sub-agent with the turn. These did not return:"

export function interruptEndedSubAgentsMessage(agents: readonly InterruptEndedSubAgent[]): string {
  const lines = agents.map((a) => `- ${a.taskId ? `\`${a.taskId}\` — ` : ""}${a.label}`)
  return [
    INTERRUPT_ENDED_LEAD,
    "",
    ...lines,
    "",
    "None of them will report back, and an `agents:` line naming one is refused as NOT RUNNING. Check what each left behind (commits, edited files, a half-finished step), then re-dispatch it or take its work over yourself before you rest.",
  ].join("\n")
}

/** Is this delivered wake the interrupt note above? A text match, honest for the same reason it is for
 *  `SIGNOFF_NUDGE_MARKER`: ntwine writes the lead and nothing else does. */
export function isInterruptEndedWake(text: string): boolean {
  const lead = text.trimStart()
  return lead.startsWith(INTERRUPT_ENDED_LEAD) || lead.startsWith(legacyHumanWording(INTERRUPT_ENDED_LEAD))
}

// ---- THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) --------------------------------------------
// The rules arrive when they are ABOUT TO BE USED, rather than 200k tokens earlier in a system prompt
// the agent has long since stopped attending to. Maintainer 2026-08-11: "the agent seems to often
// forget about this stuff when it's added to the additional system prompt anyway."
//
// Delivered ONLY to a rest that carried NO fence at all — a thread that signed off correctly never sees
// it, so the whole cost of the mechanism is paid by exactly the rests that were about to produce an
// untriageable queue item. That is the invariant it exists to buy: every item in the queue is a
// question you can answer or a checkmark you can archive.
//
// IT REACHES EVERY THREAD, including one driving itself on an armed Goal. That case was carved out for a
// day (2026-08-13 → 2026-08-14, when the Goal still carried a question-hold switch) on the reading that
// the invariant is about a queue a HUMAN triages, so a thread nobody is waiting on does not need it. Two
// things sank that: this text now opens by sending a half-finished thread back to the WORK rather than
// offering a menu of ways to stop, so it no longer pulls against the Goal arriving beside it; and it is
// the only delivery that names the ```awaiting park at all (the Goal's own trailer deliberately does not
// — see restPromptMessage), so silencing it left the longest-running threads — the self-driving ones, the
// ones most likely to hold background work — with no way to learn how to park on it.
//
// SHORT, because it competes with the agent's own conclusion for attention, and because a long one
// invites the agent to treat "how do I sign off?" as the task. Three facts and a shape.
//
// IT LEADS WITH "GO BACK TO THE WORK", not with the fence menu (2026-08-14, the same change that made
// `DEFAULT_RECURRING_PROMPT` lopsided — see the comment there). The two deliveries land on the SAME rest
// and must not pull against each other: a nudge whose first instruction is "pick one of these three ways
// to stop" hands a half-finished thread a menu with no correct entry on it, and the agent picks the
// closest — usually `done`, which is a dismissal. So the fence menu is now the OTHERWISE branch, and the
// first branch says the fence is not what a thread with parts left owes. Nothing is lost from the
// invariant: a thread that goes back to work leaves the queue by SPINNING, which is the outcome the
// reminder wanted anyway.
/** The nudge's opening line, exported because it does DOUBLE DUTY: it tells the agent whose message
 *  this is, and it is what the transcript matches on to collapse the delivery to one hairline rather
 *  than rendering ntwine's boilerplate as a card over the agent's own words. A text match is honest here
 *  — ntwine writes this string and ntwine reads it, both from this file. */
export const SIGNOFF_NUDGE_MARKER = "**This message is from ntwine, not from the user.**"

/** ntwine's worker-facing vocabulary said "the human" until 2026-10-08 and says "the user" now (a worker
 *  leaking the contract's noun into its prose reads less oddly that way). Text ntwine wrote BEFORE the
 *  change is still in every open thread's transcript, so each recognizer that matches one of these
 *  constants also accepts its old spelling, rebuilt from the new one so the two cannot drift. */
function legacyHumanWording(text: string): string {
  return text.replaceAll("The user", "The human").replaceAll("the user", "the human")
}
const LEGACY_SIGNOFF_NUDGE_MARKER = legacyHumanWording(SIGNOFF_NUDGE_MARKER)
/** Both wordings. */
const SIGNOFF_NUDGE_MARKERS = [SIGNOFF_NUDGE_MARKER, LEGACY_SIGNOFF_NUDGE_MARKER]

/** The live things a thread could legitimately park on, appended to the reminder so the agent does not
 *  have to go looking for ids it cannot see. Maintainer 2026-08-14: "the handoff lists out all of the
 *  background shells and sub-agents with their identifiers so that it's really easy for the agent to
 *  produce an awaiting fence that lists out the IDs properly."
 *
 *  It goes at the END and stays short. A long preamble is what made an agent omit half its handoff once
 *  already, and this section is a lookup table, not an instruction. */
export interface SignoffLiveOps {
  /** Running background shells, named by the handle the RUNTIME gave the worker — the string it was
   *  actually shown ("Command running in background with ID: bzvtnt3ig"), not the launch tool_use id.
   *  These are what a `shells:` list names. */
  shells: { id?: string; label: string }[]
  /** Running sub-agents, named the same way. A fence may park on one, though it does not need to: a
   *  finished sub-agent re-invokes its parent by itself. */
  subAgents: { id?: string; label: string }[]
  /** Armed one-off timers, by row id (`tmr_…`) — what a `timers:` list names. */
  timers?: { id?: string; label: string }[]
  /** Registered pull requests, by ref (`owner/repo#N`) — what a `prs:` list names. */
  prs?: { id?: string; label: string }[]
  /** Other threads this one awaits a reply from (`message_thread` with `await_reply`), by `@handle` —
   *  what a `threads:` entry names. */
  threads?: { id?: string; label: string }[]
  /** Armed command watches, by row id (`cmw_…`) — what a `commands:` entry names. */
  commands?: { id?: string; label: string }[]
}

// THE NUDGE PRINTS THE IDS, and that is not a convenience — it is what makes the fence writable at all.
// The awaiting grammar references live things BY ID, so a worker that has lost them (a compaction, a long
// turn) cannot write a correct fence and will be bumped for naming something wrong. Giving it the exact
// lines here closes that loop at the one moment it is provably needed: it just rested without a fence.
// `ntwinectl activity` returns the same list on demand, from the same source.
/** The registries as one `kinds: [id, …]` line per kind a fence can copy verbatim, each above the ids it
 *  holds and what they are, or `[]` when nothing is running.
 *
 *  ONE LINE PER KIND, NOT PER ITEM, because the frontmatter is YAML (2026-08-24) and YAML has no repeated
 *  keys. This printed `shell: <id>` per item until 2026-09-25 — the retired grammar, which the park check
 *  refuses by name — so a worker that copied what ntwine handed it was bumped for copying it.
 *
 *  Shared with SOURCE 12's corrections, and that sharing is the point rather than tidiness: a worker
 *  dispatched before `mcp__ntwine__activity` existed CANNOT call it — its MCP server is frozen at dispatch
 *  — so a correction whose only remedy is that tool teaches the oldest threads nothing, which is exactly
 *  the population most likely to be writing a bad fence. Printing the ids needs no tool at all. */
export function liveOpsLines(ops?: SignoffLiveOps, needsInput = false): string[] {
  const lines: string[] = []
  // `threads:` is read verbatim (splitAwaitingFrontmatter), so its `@handle`s are printed as written rather
  // than quoted for YAML.
  const section = (heading: string, key: string, items: { id?: string; label: string }[]) => {
    if (!items.length) return
    lines.push("", heading)
    for (const i of items) lines.push(`- \`${i.id ?? "?"}\`  — ${i.label}`)
    lines.push(`In a fence: \`${key}: [${items.map((i) => i.id ? (key === "threads" ? i.id : fenceScalar(i.id)) : "?").join(", ")}]\``)
  }
  section("Background shells still running:", "shells", ops?.shells ?? [])
  // Under the answer-required contract (`status:`, NEEDS_INPUT_REQUIRED_AT) a sub-agent is no longer
  // optional to name: a rest on one with no fence is a bare rest and queues, so the heading must not
  // tell the worker it can skip it.
  section(needsInput ? "Sub-agents still running:" : "Sub-agents still running (they re-invoke you on their own, so parking on one is optional):", "agents", ops?.subAgents ?? [])
  section("Timers you have armed:", "timers", ops?.timers ?? [])
  section("Pull requests you registered:", "prs", ops?.prs ?? [])
  section("Threads you are awaiting a reply from:", "threads", ops?.threads ?? [])
  section("Command watches you registered:", "commands", ops?.commands ?? [])
  return lines
}

// ---- THE WAITING VARIANT: A BARE REST WITH A SHELL STILL RUNNING ---------------------------------
// The long reminder below is written for a worker that STOPPED — it opens on "the task still has parts
// left, go back to the work" and spends sixty lines on ceilings, documents and questions. Read at a worker
// that is legitimately waiting on a build it just launched, every line of that is the wrong framing.
// Measured 2026-09-29 → 10-01: 46 nudges, ~20 of them to a worker resting behind a live shell, sub-agent
// or Workflow, and every one of those answered with a correct ```awaiting fence 2–3s later — a turn and
// a wall of "unfinished work" prose spent to produce one fence the worker already meant to write.
//
// So a bare rest with a running shell gets THIS: the shells by the id the runtime gave the worker, the
// fence already written for them, and one line for the case where the work is in fact finished. The
// worker deletes what it is not waiting on and sets `for:`; nothing else is left to compose, so nothing
// else can be got wrong.
//
// IT IS STILL A NUDGE, NOT A PARK. Treating a live shell as an implicit park was the alternative and it
// was turned down: 26% of real background launches are servers that never exit (see board.ts on the
// shell excusal that was tried and reverted on 2026-08-04), so a forgotten dev server would hold its
// thread out of the queue forever, silently. Asking costs one short turn; inferring costs a lost thread.
//
// SHELLS, because they are the one live thing that does NOT already park. A running direct sub-agent
// — a `Workflow` run is one too — excuses its parent from the queue on its own, so the nudge does not
// fire behind one at all (board.signoffNudgeVerdict) — EXCEPT on a thread with a Goal armed at rest,
// which a child does not hold: there the children are listed here too, with an `agents:` line, because
// that fence is the one thing that quiets the Goal until they return. Timers and PRs are
// registrations, not running work; they ride along as lines to add, never pre-filled, because a shell
// wait and a PR wait are different waits and the fence must name only what this rest is for.
/** The `for:` the waiting variant pre-fills. A guess, deliberately on the short side: running out only
 *  brings the worker back to re-check and re-park (uncapped), while a long one leaves a dead shell's
 *  thread quiet for longer. */
export const SIGNOFF_WAITING_FOR = "1h"

/** An id as a fence can carry it: bare when YAML reads it back as the same string, JSON-quoted when it
 *  would not. Ids are base36 runtime handles, `tmr_…` rows and `owner/repo#N` refs, which are all bare in
 *  practice — but a runtime id that happens to read as a number (`1234e5678` is Infinity, `0x1a2b3c4` is
 *  27440068) would otherwise be copied verbatim into a fence whose park check then refuses it. */
export function fenceScalar(id: string): string {
  try {
    const doc = parseYaml(`k: [${id}]`) as { k?: unknown } | null
    if (Array.isArray(doc?.k) && doc.k.length === 1 && doc.k[0] === id) return id
  } catch {
    // not even a flow item on its own — quote it
  }
  return JSON.stringify(id)
}

export function signoffWaitingNudgeMessage(ops: SignoffLiveOps, needsInput = false): string {
  const { shells, subAgents } = ops
  const threads = ops.threads ?? []
  // A REPLY WAIT ALONE (`message_thread` with `await_reply`) is a wait like a shell's: registered, so it
  // has a wake, but not parked until the fence names it. It gets the same pre-filled fence, `watching`
  // because the reply is another thread's work, not this one's.
  if (shells.length + subAgents.length === 0 && threads.length > 0) return replyWaitNudgeMessage(threads, ops, needsInput)
  const count = shells.length + subAgents.length
  const one = count === 1
  // An id the fence can carry, or the label QUOTED — the park check answers to a shell's label too, and a
  // label is free text, so bare it could break the YAML flow list.
  const handle = (i: { id?: string; label: string }) => i.id ? fenceScalar(i.id) : JSON.stringify(i.label)
  const what = !subAgents.length
    ? (one ? "this background shell" : `${count} background shells`)
    : !shells.length
      ? (one ? "this sub-agent" : `${count} sub-agents`)
      : "this background work"
  const extras = (
    [["timers", ops.timers], ["prs", ops.prs]] as const
  ).filter(([, items]) => items?.length).map(([key, items]) => `\`${key}: [${items!.map(handle).join(", ")}]\``)
  return [
    `${SIGNOFF_NUDGE_MARKER} You rested without a fence, with ${what} still running:`,
    "",
    ...shells.map((sh) => `- \`${handle(sh)}\` — ${sh.label}`),
    ...subAgents.map((a) => `- \`${handle(a)}\` — sub-agent: ${a.label}`),
    "",
    `If you are waiting on ${one ? "it" : "them"}, end your next message with this fence${one ? "" : " (keep only the ids you are waiting on)"}, setting \`for:\` to how long it should take:`,
    "",
    "```awaiting",
    ...(shells.length ? [`shells: [${shells.map(handle).join(", ")}]`] : []),
    ...(subAgents.length ? [`agents: [${subAgents.map(handle).join(", ")}]`] : []),
    // An awaited thread rides the fence pre-filled: the worker asked it and chose to wait on it.
    ...(threads.length ? [`threads: [${threads.map((t) => t.id ?? t.label).join(", ")}]`] : []),
    ...(needsInput ? ["status: working"] : []),
    `for: ${SIGNOFF_WAITING_FOR}`,
    ...(needsInput ? [] : ["---", "What is running and what it gates, in one sentence."]),
    "```",
    // Under the answer-required contract the `status:` answer decides the band: `working` and `watching`
    // park with no write-up owed; `needs_input` queues. Pre-filled `working` because the rest this
    // variant answers is the archetypal build-just-launched wait (see the measurement above).
    ...(needsInput ? ["", "`status: working` says the work finishes by itself (a build, a test, a sub-agent's task); make it `watching` if it waits on something outside the thread (a release, a review, a poll). Either keeps you out of the user's queue with no write-up owed. If the user can read, try or act on something NOW, make it `needs_input` and add a `---` line with what to look at."] : []),
    // Only a Goal thread reaches here with a child, and it is the one place the child's own park falls
    // short — said in a line, because a worker told "a running child parks you" has no other reason to fence.
    ...(subAgents.length && !needsInput ? ["", "A running sub-agent keeps you out of the queue on its own, but only this fence holds your Goal until it returns."] : []),
    ...(extras.length ? ["", `Add a line only if this rest waits on these too: ${extras.join(", ")}.`] : []),
    "",
    `If work is left, do it now; if it is finished${subAgents.length ? "" : ` and ${one ? "the shell is" : "they are"} only left running`}, end with \`\`\`done instead.`,
  ].join("\n")
}

/** The waiting variant for a bare rest whose only live wait is a reply from another thread. */
function replyWaitNudgeMessage(threads: readonly { id?: string; label: string }[], ops: SignoffLiveOps, needsInput: boolean): string {
  const one = threads.length === 1
  const names = threads.map((t) => t.id ?? t.label)
  const extras = (
    [["timers", ops.timers], ["prs", ops.prs]] as const
  ).filter(([, items]) => items?.length).map(([key, items]) => `\`${key}: [${items!.map((i) => (i.id ? fenceScalar(i.id) : JSON.stringify(i.label))).join(", ")}]\``)
  return [
    `${SIGNOFF_NUDGE_MARKER} You rested without a fence, waiting on ${one ? `a reply from ${names[0]}` : `replies from ${names.join(", ")}`}. Registering the wait is not parking: if you are waiting on ${one ? "it" : "them"}, end your next message with this fence, setting \`for:\` to how long to wait before you go on without ${one ? "it" : "them"}:`,
    "",
    "```awaiting",
    `threads: [${names.join(", ")}]`,
    ...(needsInput ? ["status: watching"] : []),
    `for: ${SIGNOFF_WAITING_FOR}`,
    "```",
    ...(extras.length ? ["", `Add a line only if this rest waits on these too: ${extras.join(", ")}.`] : []),
    "",
    "If work is left, do it now; if you no longer need the answer, stop waiting with `ntwinectl unwatch <id>` on the wait's `tmr_…` id (`ntwinectl activity` lists it) and sign off.",
  ].join("\n")
}

/** The sign-off nudge for one fenceless rest: the short waiting variant when a background shell (or, on a
 *  Goal thread or under the answer-required contract, a direct child) is still running, or another thread's
 *  reply is awaited, the full protocol when nothing is. `needsInput` is the worker's contract (`needsInputRequired`): a worker dispatched under
 *  the answer-required cut is taught `status:` — the 2026-10-05 spelling, which a worker that learned
 *  `needs_input:` can write just as well, since the fence reads both — and one dispatched before the cut
 *  is taught the grammar it can actually satisfy. */
export function signoffNudgeMessage(ops?: SignoffLiveOps, needsInput = false): string {
  if (ops && (ops.shells.length || ops.subAgents.length || ops.threads?.length)) return signoffWaitingNudgeMessage(ops, needsInput)
  const base = needsInput ? SIGNOFF_NUDGE_MESSAGE_NEEDS_INPUT : SIGNOFF_NUDGE_MESSAGE
  const lines = liveOpsLines(ops, needsInput)
  if (lines.length) {
    lines.push("", "An ```awaiting fence names only what you are ACTUALLY waiting on, one such list per kind, plus")
    if (needsInput) {
      lines.push("a required `for:` duration (`30s`/`15m`/`2h`/`3d`) and a required `status:` (`working`, `watching`")
      lines.push("or `needs_input`), then a `---` line and whatever prose the user needs. ntwine checks every id:")
      lines.push("name something that is not running and you are bumped rather than parked.")
    } else {
      lines.push("a required `for:` duration (`30s`/`15m`/`2h`/`3d`), then a `---` line and whatever prose you want")
      lines.push("(optional). ntwine checks every id: name something that is not running and you are bumped")
      lines.push("rather than parked.")
    }
  }
  return lines.length === 0 ? base : `${base}\n${lines.join("\n")}`
}

// ---- STRAY SHELLS BEHIND A QUESTION (scheduler SOURCE 14) ---------------------------------------
// A question outranks every other card, so a thread resting on one draws the question and NOTHING about
// the background shells it left running — the resting card that would list them yields to the ask. The
// human finds out only when "Mark as done" warns that ending the session will kill a shell they never
// saw. Measured 2026-09-29: a worker launched a 6-hour poller waiting on a Workflow's output file,
// `TaskStop`ped the Workflow when the human narrowed the job, never stopped the poller, and rested on a
// commit question with it still polling a file nothing would ever write.
//
// So a question rest with live shells gets ONE message listing them — once per SET of shells, not per
// rest, so a dev server kept on purpose is asked about once and then left alone.
export function strayShellsMessage(shells: readonly { id?: string; label: string }[]): string {
  return [
    `${SIGNOFF_NUDGE_MARKER} You rested on a question with ${shells.length === 1 ? "a background shell" : `${shells.length} background shells`} still running, and the question's card hides ${shells.length === 1 ? "it" : "them"} — the user cannot see ${shells.length === 1 ? "it is" : "they are"} there:`,
    "",
    ...shells.map((sh) => `- \`${sh.id ?? "?"}\` — ${sh.label}`),
    "",
    "`TaskStop` every one you no longer need, NOW. Above all a poller or waiter whose target has already finished or been stopped — and a shell that waits on a Workflow or a sub-agent was never needed: both notify you themselves when they finish.",
    "Keep one only if it still serves the work (a dev server the user is about to open), and then say so in one line.",
    "Then rest again. Your question stays open, and this will not repeat for these shells.",
  ].join("\n")
}

/** The ```awaiting bullet of the reminder, per contract. The rest of the reminder is identical for both. */
function signoffNudgeAwaitingLines(needsInput: boolean): string[] {
  if (!needsInput) {
    return [
      "- `` ```awaiting `` — you are WAITING on work that is actually running. FRONTMATTER, THEN MARKDOWN:",
      "  one YAML list per kind of thing you are waiting on, a REQUIRED `for:` duration, then a `---` line and",
      "  ONE OR TWO SENTENCES naming what is running and what it gates — never the plan for when it lands.",
      "  The prose is OPTIONAL; the lines above it are not.",
      "",
      "  ```awaiting",
      "  shells: [<the id your runtime gave you>]",
      "  prs: [owner/repo#123]",
      "  for: 2h",
      "  ---",
      "  What is running and what it gates, in one sentence — this is what the user reads on your card.",
      "  ```",
    ]
  }
  return [
    "- `` ```awaiting `` — you are WAITING on work that is actually running: a background shell, a",
    "  sub-agent, a timer or a registered PR. FRONTMATTER, THEN MARKDOWN: one YAML list per kind of thing",
    "  you are waiting on, a REQUIRED `for:` duration, a REQUIRED `status:`, then optionally a `---` line",
    "  and prose.",
    "",
    "  ```awaiting",
    "  agents: [<the id your runtime gave you>]",
    "  status: working",
    "  for: 2h",
    "  ```",
    "",
    "  `status:` says where the thread sits while you wait, in one of three words:",
    "  - `working` — what you named finishes by itself: a test, a build, a benchmark, CI, a sub-agent doing",
    "    a task. The thread shows as running until the work wakes you.",
    "  - `watching` — something has to HAPPEN outside the thread: a release, a review, another agent's",
    "    merge, the next daily cycle. The thread is snoozed, and nothing on its row moves, until a named",
    "    item reports or `for:` runs out.",
    "  - `needs_input` — the user can read, try or act on something NOW while the work runs (a partial",
    "    result, a file you wrote, a server to try), even if you need nothing back from them. The thread",
    "    goes into their queue, and the prose under `---` says what to look at.",
    "  `working` and `watching` owe NO write-up: the fence alone is the whole message. If you wrote ANY",
    "  words for the user at this rest, it is `needs_input` — nothing else is put in front of them. A rest",
    "  on running work with NO fence is a bare rest, and it lands in the user's queue.",
  ]
}

function signoffNudgeText(needsInput: boolean): string {
  return [
  `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and no new work is being asked of you.`,
  "",
  "You rested without a fence, so this thread cannot be triaged.",
  "",
  "**IF THE TASK STILL HAS PARTS LEFT, THE FENCE IS NOT WHAT YOU OWE — THE WORK IS.** If ANY part of the",
  "original task is unfinished, unverified, or deferred, resume it NOW, in THIS turn, and sign off once it",
  "is genuinely finished. A milestone, a green test run and a long turn are none of them endings, and",
  "neither is naming the next step or writing it into a scratch file.",
  "",
  "**AND THAT TASK IS ALSO THE CEILING — finish it, and nothing else.** Work you notice on the way is a",
  "FINDING TO REPORT in your sign-off, never work to take on: the bug beside the one you were sent for,",
  "the refactor the code obviously wants, the second issue the first one touches. Widening the job is not",
  "thoroughness — it is a different job nobody asked for, and it buries the answer they did ask for under",
  "changes they now have to review. If it should be done, name it in one line and let the user dispatch",
  "it.",
  "",
  "**IF WHAT YOU WERE ASKED FOR IS A DOCUMENT, THE DOCUMENT IS THE ENDING.** A triage, a review, an",
  "investigation, a recommendation, a plan — when that is the deliverable, the finished write-up IS the",
  "work. Implementing what it proposes is the NEXT job, and not yours unless you were asked. Sign off with",
  "the write-up.",
  "",
  "**DECIDE RATHER THAN ASK.** Stop only for a decision that is genuinely the user's AND that blocks you",
  "right now: register that one with `ntwinectl ask`. Every other open choice INSIDE the task — a name, a",
  "default, a reversible design call — is yours to make: decide it, say in one line which way you went and",
  "what would reverse it, and carry on. A choice that would ENLARGE the task is not one of those: an",
  "unanswered question is not permission to go build the answer.",
  "",
  "Otherwise, sign off — a registration, or a fence at the END of your next message:",
  "",
  "- `ntwinectl ask` — you need the user. NOT a fence: the ```question fence is retired, and a fence",
  "  with a question in its body is plain prose. Register it (options with one-line trade-offs, the",
  "  recommended one first), then rest normally — an open registered question is the sign-off.",
  "- `` ```done `` — genuinely FINISHED. A DISMISSAL: the card is filed away and nobody looks again, so",
  "  if anything is still owed, it is not done. Body: at most one sentence, then one ONE-LINE bullet per",
  "  deliverable, each opening with a **bolded verb phrase**. A card is read at a glance: keep it short.",
  ...signoffNudgeAwaitingLines(needsInput),
  "",
  "  ntwine CHECKS every line: name something that is not running and you are bumped rather than parked.",
  "  A fence that names NOTHING is not a park at all — if you are not waiting on anything, you are not",
  "  awaiting, you are done. Register a PR with `ntwinectl watch-pr add` and a timer with",
  "  `ntwinectl timer set`; `ntwinectl activity` reads back everything you have running, with its id.",
  "- `` ```awaiting `` with `steps:` — the user must PERFORM something you cannot: sign in, approve,",
  "  merge, press a button you may not. List each step as a `- ` line under `steps:`, written to be",
  "  followed cold: a real Markdown link to every page and file it names, every command in a code span,",
  "  every value the act needs written in. ntwine reads them verbatim. Steps name the USER as the wait,",
  "  so the fence needs no other name and no `for:`, and the thread goes into their queue. Their Done",
  "  comes back to you as their reply; anything else they need to say comes as a message of their own.",
  "- `` ```awaiting `` with `questions:` — a question you registered at an EARLIER rest is still open and",
  "  you still need its answer. Name every such question (`questions: [qst_…]`) and withdraw the rest with",
  "  `ntwinectl unask <id>`: a fence that leaves an open question out is refused. A named card is drawn at",
  "  this rest; an unnamed one stays where you asked it.",
  "",
  "**STILL OWED counts things you are not going to do yourself.** A decision you are RECOMMENDING, a",
  "draft you wrote but did not send, follow-up work you discovered — all of it dies with the card, even",
  "the part that is someone else's to do. Each ends on a question with your recommendation as option 1,",
  "or you DO it first — a sub-agent's result comes BACK to you, so it lands on your card; a new card via",
  "`ntwinectl spawn-thread` is the LAST resort, since nothing it learns returns to you or its siblings.",
  "None of them is a `done`. And what is not",
  "worth a card is not worth a SENTENCE: delete the dangling \"one thing to carry forward\", never park it",
  "in the handoff.",
  "",
  "**DO NOT REPEAT YOURSELF.** If the message you just wrote already stands on its own, reply with the",
  "fence ALONE — the user reads both together, so restating it costs them the second read for nothing.",
  "The same holds inside one message: the card is the ledger of what shipped, the prose is only what a",
  "ledger cannot hold, and a sentence that reads the same in either belongs in exactly one of them.",
  "",
  "Only if it does NOT stand alone, fix that first, briefly. It has to be readable cold: the user has",
  "seen nothing since their own last message — the Goal, this reminder, a watcher wake all came from",
  "ntwine — so anything you assumed they had followed, they have not.",
  ].join("\n")
}

export const SIGNOFF_NUDGE_MESSAGE = signoffNudgeText(false)

/** The same reminder for a worker dispatched under the answer-required contract (NEEDS_INPUT_REQUIRED_AT),
 *  which it teaches as `status:` since 2026-10-05. */
export const SIGNOFF_NUDGE_MESSAGE_NEEDS_INPUT = signoffNudgeText(true)

/** The reminder for a fenceless rest that leaves questions from an EARLIER rest open (2026-10-05). A
 *  question asked at THIS rest is the rest's own sign-off; one carried from before is not, because its
 *  card is no longer drawn under the newest handoff — it stays where it was asked — so a rest that says
 *  nothing about it reads as a bare stop while the thread sits in the queue on an ask nobody can see at
 *  the bottom. The worker settles each one: name it, or withdraw it. Same marker as the reminder above,
 *  so it folds out of the chat the same way. */
export function carriedQuestionsNudgeMessage(questions: readonly { id: string; question: string }[], ops?: SignoffLiveOps, needsInput = false): string {
  const one = questions.length === 1
  const lines = [
    `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and no new work is being asked of you.`,
    "",
    `${one ? "A question you registered at an EARLIER rest is" : "Questions you registered at EARLIER rests are"} still open, and this rest neither names ${one ? "it" : "them"} nor withdraws ${one ? "it" : "them"}:`,
    "",
    ...questions.map((q) => `- \`${q.id}\` — ${q.question}`),
    "",
    "ntwine does not draw an earlier rest's question under your newest handoff: its card stays where you",
    `asked it. So say where ${one ? "it stands" : "each one stands"}:`,
    "",
    "- STILL NEED THE ANSWER → end with an ```awaiting fence naming it, `questions: [qst_…]`. A fence on",
    "  questions needs no other name and no `for:`, and the thread stays in the user's queue. The card is",
    "  drawn at this rest, under the reasoning you write below the `---` — what changed since you asked,",
    "  if anything did.",
    "- NO LONGER NEED IT → withdraw it with `ntwinectl unask <id>`, then sign off as you otherwise would.",
    ...liveOpsLines(ops, needsInput),
  ]
  return lines.join("\n")
}

// ---- THE FENCE CORRECTIONS (scheduler SOURCE 12) -------------------------------------------------
// ntwine refusing a park and telling the worker why: a fence naming something that is not running, a
// fence naming nothing at all, a fence written in a line kind that no longer exists.
//
// THEY ARE INVISIBLE IN THE CHAT, and that is the whole reason these two strings live here. A
// correction is ntwine talking to the AGENT about its own grammar — there is no news in it and nothing
// for the human to do — and left as a first-party card it dominated the very handoff it was complaining
// about, then sat above the worker's re-fence as a second, louder copy of a conversation the human was
// never part of (maintainer 2026-08-19, with a screenshot of exactly that). It is the same verdict the
// sign-off nudge got on 2026-08-12, one step further: that one collapses to a hairline, this one is
// dropped from the transcript entirely.
//
// The LEADS are matched rather than a marker being minted, so the corrections already sitting in every
// open thread on disk disappear too — a marker would only ever reach the ones written after it shipped.
// A text match is honest for the same reason it is honest for `SIGNOFF_NUDGE_MARKER`: ntwine writes these
// strings and ntwine reads them, and the formatter in scheduler.ts builds its heads FROM them, so the two
// cannot drift.
//
// `⏰ Your wait expired` is deliberately NOT one of them. That is not a correction — the fence was right
// and the clock ran out — it is the wake that ENDED the park, and the reason the thread is moving again.
// The scheduler draws the same line for its bump cap (`cause !== "expired"`).
export const PARK_CORRECTION_NAMES_LEAD = "⚠️ Your ```awaiting fence names "
export const PARK_CORRECTION_RETIRED_LEAD = "⛔ Your ```awaiting fence uses "
/** The third refusal (2026-08-28): the fence was well-formed and everything it named was live, but a
 *  REGISTERED QUESTION stood open on the thread. A question outranks a park everywhere else — the queue
 *  rule, the resting card — so the fence was refused outright rather than drawn beside the ask
 *  (maintainer: "it should not be allowed, basically"). Since 2026-10-05 a fence may stand beside open
 *  questions by NAMING every one under `questions:`; the refusal is for the ones it leaves out, or names
 *  that are not open questions at all. The lead is unchanged, so old corrections on disk still fold. */
export const PARK_CORRECTION_QUESTION_LEAD = "⚠️ Your ```awaiting fence landed while "
/** The fourth (2026-10-01): a worker dispatched under the answer-required contract parked without saying
 *  where the thread sits while it waits — no `status:` (2026-10-05; `needs_input:` before it), or a value
 *  that is none of its answers. The lead is unchanged across the rename, so old corrections still fold. */
export const PARK_CORRECTION_NEEDS_INPUT_LEAD = "⚠️ Your ```awaiting fence gives no "
/** Is this delivered wake one of ntwine's fence corrections? */
export function isParkCorrection(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith(PARK_CORRECTION_NAMES_LEAD) || t.startsWith(PARK_CORRECTION_RETIRED_LEAD) || t.startsWith(PARK_CORRECTION_QUESTION_LEAD) || t.startsWith(PARK_CORRECTION_NEEDS_INPUT_LEAD)
}

export function timerPromptMessage(prompt: string, fireAt: string): string {
  return `${prompt.trim()}\n\n(One-off timer, set for ${fireAt}. It has fired and will not repeat.)`
}

/** A fired one-off timer, read back out of its delivery.
 *
 *  THIS ONE KEEPS ITS BODY, and it is the only wake in the family that does. Everything else ntwine
 *  composes is ntwine's own sentence about something outside the turn, so a hairline says all of it; this
 *  is the WORKER'S OWN prose, arbitrary and up to TIMER_PROMPT_MAX long. The recurring prompt collapses
 *  to a bare label for a reason that does NOT hold here — its text is the ARMED text, still legible and
 *  editable in the Goal panel, so repeating it inline adds nothing (see RecurringPromptLine). A fired
 *  one-off has no such second home: the registration is gone the instant it delivers, so a bare hairline
 *  would destroy the only rendering of that text anywhere in the app.
 *
 *  Hence a hairline WITH a disclosure — the family's shape, the body one click away (maintainer
 *  2026-08-19, choosing that over both a card and a bare line).
 *
 *  Matched on the TRAILER, exactly like `parseRecurringPrompt`: ntwine writes it and ntwine reads it, both
 *  from this file, and the prompt above it is arbitrary text no pattern could anchor on. */
export interface TimerWake {
  prompt: string
  /** The instant it was set for. With several timers armed at once this is the only thing that says
   *  WHICH one fired — the same reason the producer puts it in the trailer. */
  at: string
}

const TIMER_TRAILER = /\n\n\(One-off timer, set for (\S+?)\. It has fired and will not repeat\.\)$/

export function parseTimerWake(text: string): TimerWake | null {
  const trimmed = text.trimEnd()
  const m = TIMER_TRAILER.exec(trimmed)
  if (!m) return null
  const prompt = trimmed.slice(0, m.index).trim()
  // A trailer with nothing above it is not a timer delivery — the worker's text IS the message here.
  return prompt ? { prompt, at: m[1] } : null
}

// A SPINOFF REQUEST AN OLDER BUILD DELIVERED TO THE PARENT'S WORKER. Until 2026-10-07 a spinoff that could
// not fork the parent was a `<spinoff-request>` message the parent's worker answered with a `spawn_thread`
// call carrying a brief. Nothing sends one now (server router.ts `spinoff`), but transcripts from then
// still hold the request, and the chat still draws it as the spinoff card rather than the agent-facing
// errand. `spin-off-request` is the envelope's first-day name, when the request also quoted the message
// it was asked from in a `<selected-message>` block.
const SPINOFF_REQUEST = /^<(spinoff|spin-off)-request id="(spn_[0-9a-f]{16})">\n[\s\S]*?\n<instructions>\n([\s\S]*?)\n<\/instructions>\n[\s\S]*\n<\/\1-request>/

/** The spinoff request inside a delivered user turn, or null. Anchored at the START so a human who
 *  pastes the envelope mid-message is still just talking. */
export function parseSpinoffRequest(text: string): { id: string; instructions: string } | null {
  const m = SPINOFF_REQUEST.exec(text.trimStart())
  if (!m) return null
  return { id: m[2], instructions: m[3] }
}

/** The new thread's first prompt when it does not fork the parent: the human's words and where they came
 *  from, then the context ntwine assembled from the parent (spinoffContext). Written by the SERVER, so the
 *  human's instructions reach the child verbatim, and the child can find its way back.
 *
 *  The parent is named by its `@handle` when it has one — what `read_thread` resolves and what the
 *  child's own prose autolinks — and by a link otherwise (a sentence-length title has no handle). The
 *  chat never shows this text as written: the child's transcript projects it into its spinoff header
 *  (parseSpinoffChildPrompt), the instructions as the human's request and the context folded beneath
 *  them, because the context is not the human speaking (maintainer 2026-09-30: "this kind of context
 *  can't be included as a user message"). */
export function spinoffChildPrompt(input: { parentSlug: string; parentTitle: string; parentHandle?: string; instructions: string; brief: string }): string {
  const quoted = input.instructions.trim().split("\n").map((line) => `> ${line}`).join("\n")
  const parent = spinoffParentRef(input)
  return [
    `A spinoff of ${parent}, at the user's request. Their instructions:`,
    "",
    quoted,
    "",
    `Context from ${input.parentHandle ? parent : "that thread"}:`,
    "",
    input.brief.trim(),
  ].join("\n")
}

/** How a spinoff child's prompt names its parent: the `@handle`, else a link titled with its name. */
function spinoffParentRef(input: { parentSlug: string; parentTitle: string; parentHandle?: string }): string {
  return input.parentHandle ? `@${input.parentHandle}` : `[${input.parentTitle.replace(/[\[\]]/g, "")}](/thread/${input.parentSlug})`
}

/** The CONTEXT a spinoff child starts with when it does not fork its parent (David 2026-10-07): a Codex
 *  or ACP parent, a cross-project spinoff, or a Claude parent with no transcript yet. ntwine assembles it
 *  from what it already stores — the parent's original request, its latest handoff (a registered done's
 *  body, else its last resting message) and, across projects, where the parent lives — and points the
 *  child at `read_thread` for the rest. No model writes it and nothing reaches the parent, so a spinoff
 *  never touches the thread it came from.
 *
 *  The request and the handoff lead, so the text the child is NAMED from (spinoffNameSource) is about the
 *  work rather than ntwine's own orientation. Each is quoted, being another thread's words. `readAs` is
 *  what `read_thread` resolves the parent by: its handle, or its slug when it has none. */
export function spinoffContext(input: {
  parentSlug: string
  parentTitle: string
  parentHandle?: string
  readAs: string
  request?: string
  handoff?: string
  project?: { name: string; dir: string }
}): string {
  const parent = spinoffParentRef(input)
  const quote = (text: string) => text.trim().split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
  const where = input.project
    ? `${parent} is in the ${input.project.name} project (\`${input.project.dir}\`), not this one: its paths are relative to that checkout, and this thread's working directory is a different one. `
    : ""
  return [
    ...(input.request?.trim() ? [`${parent}'s original request:`, "", quote(input.request), ""] : []),
    ...(input.handoff?.trim() ? [`${parent}'s latest handoff:`, "", quote(input.handoff), ""] : []),
    `${where}${parent} was not told about this thread and does not wait on it. Read more of its conversation with the \`read_thread\` tool on \`${input.readAs}\`.`,
  ].join("\n")
}

/** A FORKED spinoff child's first prompt (2026-09-30). On a Claude thread Spinoff forks the parent's
 *  session (server router.ts forkSpinoff): the child continues the parent's whole conversation, so there
 *  is no brief to write, and what the child needs instead is to be told, unmistakably, that the
 *  conversation above it is not its own. Measured over 18 graded handoffs, a plain fork matched the
 *  brief route on correctness and scope, cost the same, and was up to twice as fast — but only because
 *  the fork does the instructions and nothing else. A fork left to read its inherited history as its own
 *  would carry on the parent's work, answer the parent's questions and sign off for it.
 *
 *  Opens exactly as spinoffChildPrompt does, so the chat projects it into the same spinoff header
 *  (parseSpinoffChildPrompt, with no brief to fold beneath it), and the human's words stay verbatim. */
export function spinoffForkPrompt(input: { parentSlug: string; parentTitle: string; parentHandle?: string; instructions: string }): string {
  const quoted = input.instructions.trim().split("\n").map((line) => `> ${line}`).join("\n")
  const parent = spinoffParentRef(input)
  return [
    `A spinoff of ${parent}, at the user's request. Their instructions:`,
    "",
    quoted,
    "",
    `${SPINOFF_FORK_ORIENTATION} Everything above this message is ${parent}'s conversation, copied so you start with all of its context. It is not yours to continue. You are a NEW thread, with your own handle, your own scratch directory and your own sign-off, and your task is the instructions above and nothing else. So do not carry on ${parent}'s work, write to its scratch directory, or act on its open questions, watches, timers, goals, sub-agents, background shells or sign-offs: none of them belong to you, and none of their results will reach you. Do not message ${parent} unless the instructions ask you to. When you are done, sign off for this thread alone.`,
  ].join("\n")
}

// The fork prompt's orientation opens on this, and the parser keys on it: the two cannot drift apart.
const SPINOFF_FORK_ORIENTATION = "This thread was FORKED from that one."

/** What a spinoff child is NAMED from: the human's instructions, then the context under them. The
 *  instructions alone are often subject-less ("evaluate whether this is a good idea") — the context is
 *  where the subject lives — and the composed prompt's opening "A spinoff of @parent…" line would name
 *  every child after its parent. Used by the dispatch's mint (router.ts spinoff). */
export function spinoffNameSource(origin: { instructions: string; brief: string }): string {
  return [origin.instructions.trim(), origin.brief.trim()].filter(Boolean).join("\n\n")
}

// Both spellings of the parent — `@handle`, or the first day's `[Title](/thread/slug)` — and every
// spelling of the context line: "Context from …:" now, and "The context … gathered for you:" from when the
// parent's worker wrote a brief (before 2026-10-07). Anchored at the START of the (envelope-stripped)
// first turn, like the request's parser.
const SPINOFF_CHILD_PROMPT = /^A spinoff of (?:@[\p{L}\p{N}_.-]+|\[[^\]\n]*\]\(\/thread\/[^)\s]+\)), at the (?:user|human)'s request\. Their instructions:\n\n((?:>[^\n]*(?:\n|$))+)\n(?:Context from (?:@[\p{L}\p{N}_.-]+|that thread)|The context (?:@[\p{L}\p{N}_.-]+|that thread) gathered for you):\n\n([\s\S]*)$/u

// A FORKED child's prompt (spinoffForkPrompt): the same opening and quote, then ntwine's orientation —
// which is not a brief, so it projects as none.
const SPINOFF_FORK_PROMPT = new RegExp(
  String.raw`^A spinoff of (?:@[\p{L}\p{N}_.-]+|\[[^\]\n]*\]\(\/thread\/[^)\s]+\)), at the (?:user|human)'s request\. Their instructions:\n\n((?:>[^\n]*(?:\n|$))+)\n` +
    SPINOFF_FORK_ORIENTATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`[\s\S]*$`,
  "u",
)

/** A spinoff child's first prompt read back into its parts, or null for any other text. A FORKED
 *  child's has no brief: the context it started with is the parent's conversation itself. */
export function parseSpinoffChildPrompt(text: string): { instructions: string; brief: string } | null {
  const fork = SPINOFF_FORK_PROMPT.exec(text.trim())
  if (fork) {
    const instructions = fork[1].replace(/\n$/, "").split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim()
    return instructions ? { instructions, brief: "" } : null
  }
  const m = SPINOFF_CHILD_PROMPT.exec(text.trim())
  if (!m) return null
  const instructions = m[1].replace(/\n$/, "").split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim()
  const brief = m[2].trim()
  if (!instructions) return null
  return { instructions, brief }
}

/** The message a worker receives when the usage window that cut it off has rolled over.
 *
 *  MOVED HERE FROM THE SCHEDULER on 2026-08-19, when this became the last ntwine-composed wake still
 *  arriving as a card. It could not be a hairline while it lived in the server package: the chat has
 *  nothing but the delivered text to draw from, so the parser has to sit beside the formatter, and only
 *  this package is reachable from both sides. Every other wake formatter is here for that same reason.
 *
 *  Deliberately a plain continue — the agent's own transcript already holds everything it was doing, so
 *  the useful thing to add is only WHY it stopped and that it should pick the work back up rather than
 *  re-plan or re-report. */
export function limitResumeSteer(window: LimitWindow): string {
  const which = window === "weekly" ? "weekly usage limit" : window === "session" ? "session usage limit" : window === "model" ? "model usage limit" : "usage limit"
  return `⏳ The ${which} that interrupted you has reset. Continue exactly where you left off.`
}

/** The message a worker receives when ntwine answered a MODEL-SCOPED cap by moving the thread down a rung.
 *
 *  The provider's own line says it outright — "Switch to another model … to continue" — so the account
 *  is not out of capacity, this MODEL is, and waiting out a weekly window is the wrong answer. ntwine
 *  takes the provider's advice on the thread's behalf and restarts it on the next model down (see
 *  claudeFallbackModel), which is why this wake says nothing has reset: the cap is still standing.
 *
 *  Named at the same altitude as the human's own vocabulary — the models by their catalogue LABELS
 *  ("Fable", "Opus"), never their argv slugs — because the operator reads this line in the transcript
 *  and the composer's selector beside it says exactly the same word. */
export function limitModelSwitchSteer(capped: string, to: string): string {
  return `⏳ The ${capped} limit that interrupted you is still closed — ntwine restarted this thread on ${to}. Continue exactly where you left off.`
}

const LIMIT_MODEL_SWITCH = /^⏳ The (.+?) limit that interrupted you is still closed — ntwine restarted this thread on (.+?)\. Continue exactly where you left off\.$/

/** Which model was capped and which one the thread now runs, or `null` when this is not a switch wake. */
export function parseLimitModelSwitchWake(text: string): { capped: string; to: string } | null {
  const m = LIMIT_MODEL_SWITCH.exec(text.trim())
  return m ? { capped: m[1], to: m[2] } : null
}

const LIMIT_RESUME = /^⏳ The (weekly usage limit|session usage limit|model usage limit|usage limit) that interrupted you has reset\. Continue exactly where you left off\.$/

/** Which window reset, or `null` when this is not a limit-resume wake. The chat draws one hairline from
 *  it; the amber pause card already standing above it carries the weight of the interruption itself. */
export function parseLimitResumeWake(text: string): { window: LimitWindow } | null {
  const m = LIMIT_RESUME.exec(text.trim())
  if (!m) return null
  return { window: m[1] === "weekly usage limit" ? "weekly" : m[1] === "session usage limit" ? "session" : m[1] === "model usage limit" ? "model" : "unknown" }
}

// ---- THE PARK-INTEGRITY WAKES (scheduler SOURCE 12) ------------------------------------------------
// THE RULE THIS FILE ALREADY STATES, applied to the three formatters that never made it here: a wake
// ntwine composes ITSELF is a hairline, because it is one line of news about something outside the turn,
// and the instructions under that line are addressed to the WORKER — its own registrations, its own
// fence grammar, the tools it should call. Left in the server package a formatter has no parser the chat
// can reach, so it fell through `NtwineWake`'s legacy fallback and printed VERBATIM: a bordered "ntwine"
// card of agent-contract prose, in the human's transcript (maintainer 2026-08-24, on a card reading
// "THE ONLY LINE KINDS NOW SUPPORTED": "ntwine cards that seem to be exposing internals").
//
// Measured before the move: 73 of 12 891 delivered wakes on this machine drew that raw card, and every
// live one was one of the three below. So they move here for the same reason `limitResumeSteer` did on
// 2026-08-19 — "the parser has to sit beside the formatter, and only this package is reachable from both
// sides". The agent-facing wording is UNCHANGED, byte for byte: workers read it and it is carefully
// written; what changes is that the human now gets the one line it is news about.

/** Scheduler SOURCE 12, cause `expired`: the `for:` ran out and nothing resolved. `status` is the live
 *  readout of what the fence named, already formatted by the caller. */
export function parkExpiredWakeMessage(status: readonly string[], checkIn = false, requested = false, prior: AwaitingStatus | null = null): string {
  return [
    requested ? PARK_REQUESTED_LEAD : "⏰ Your wait expired, nothing resolved. Check back in on everything.",
    "",
    ...status,
    "",
    // THE HUMAN PRESSED "Ask for update" on the resting card (router.requestParkCheckIn): the same wake as
    // the expiry, early, and with a reader waiting on the answer — so the note is owed to the queue.
    ...(requested
      ? [
        "The user is waiting to read this one: write the progress note — what landed, what is running,",
        "what changed — and re-park with `status: needs_input` so it reaches them.",
        "",
      ]
      : []),
    // A park on sub-agents expires on AGENT_PARK_FOR_MAX_MS, so this wake is the parent's regular
    // check-in. No line here may open with "- ": parkWakeItems reads those as the parked items.
    ...(checkIn
      ? [
        "THIS IS YOUR SUB-AGENT CHECK-IN. Before re-parking:",
        "1. Read where each child stands: `ntwinectl read-thread` on its address, its output file, or the",
        "   commits and files it has written since the last check-in.",
        "2. Steer any child that is off course, stuck or duplicating another's work. `SendMessage` reaches a",
        "   plain background sub-agent and a running Workflow's agent alike.",
        "3. Report: a short progress note above the fence — what landed, what is running, what changed.",
        "   Write it for someone who has read nothing since their last message: where the effort stands",
        "   against its goal, in their words, with no names you coined (round numbers, phase codes, ids).",
        // KEEP THE BAND THE LAST PARK CHOSE. This line used to read "else `working`", and it overrode a
        // worker's own `watching`: @3-0 parked `watching` on two Workflows, woke here 6m later with nothing
        // changed, obeyed, and its row jumped from Snoozed to the spinning Working band (maintainer
        // 2026-10-06: "went from awaiting … to working status without me interacting or seemingly any
        // change in its state"). `prior` is that last park's own answer.
        prior === "working" || prior === "watching"
          ? `   \`status: needs_input\` when the user can read or act on something now; otherwise keep\n   \`status: ${prior}\`, which your last park answered, unless the wait itself changed.`
          : "   `status: needs_input` when the user can read or act on something now, else `working` —\n   or `watching` when the children only watch the world for you.",
        "4. Ask now. A decision the work has surfaced that is the user's to make goes to `ntwinectl ask`",
        "   at this check-in — never into the note or a file \"for the user\", which nobody is prompted to",
        "   answer. The children keep running while it waits; rest on the question, with no fence.",
        "",
      ]
      : []),
    "Re-park if they are genuinely still going — there is no limit on that, and a long job is not a",
    "failure. If something is finished, read its result. If nothing is left, end in ```done or register",
    "a question with `ntwinectl ask`.",
  ].join("\n")
}

/** Scheduler SOURCE 12, cause `dead` where every named item FINISHED: the park is simply over. */
export function parkFinishedWakeMessage(status: readonly string[], several: boolean): string {
  return [
    `✅ ${several ? "Everything you parked on has FINISHED" : "The work you parked on has FINISHED"}, so the park is over and your thread is back in the queue.`,
    "",
    ...status,
    "",
    "READ ITS OUTPUT AND CARRY ON. This is not a broken fence and there is nothing to fix: the wait",
    "you declared simply ended. Do NOT relaunch the same work — its result is already on disk.",
    "",
    "Then park on whatever comes next, or end in ```done or a registered question (`ntwinectl ask`) if nothing is left.",
  ].join("\n")
}

/** Scheduler SOURCE 11: a registered PR watcher whose own `for:` ran out. */
export function prWatchExpiredWakeMessage(ref: string, kind: "pull" | "issue" = "pull"): string {
  // The head keeps its exact wording for either subject — `PR_WATCH_EXPIRED_HEAD` reads it — and only
  // the noun and the advice change. An issue watcher cannot be registered again by a worker (its
  // command was removed 2026-10-14), so its expiry points only at the terminal state.
  const head = `⏰ Your watcher on ${ref} has expired and is no longer armed — nothing on that ${kind === "issue" ? "issue" : "PR"} will wake you now.\n\n`
  if (kind === "issue") return `${head}If it was the only thing you were waiting on, end in a proper terminal state instead of parking on it again.`
  return (
    `${head}If you still care about it, register it again with \`ntwinectl watch-pr add\` and a ` +
    `fresh \`--for\`. If you do not, and it was the only thing you were waiting on, end in a proper ` +
    `terminal state instead of parking on it again.`
  )
}

/** The wake a REGISTERED WATCH sends when its `for:` runs out — the twin of prWatchExpiredWakeMessage
 *  above, and here for the same reason: the scheduler mints it and nothing else may re-word it.
 *
 *  Expiry CANCELS the row rather than extending it, which is the whole mechanism that stops a
 *  registration outliving its own relevance: the worker is put back in front of the decision it made
 *  once, with the wait no longer standing, and re-registers only if it still means it. */
export function ownWatchExpiredWakeMessage(kind: "shell" | "agent", target: string): string {
  const what = kind === "agent" ? "sub-agent" : "background shell"
  return (
    `⏰ Your watch on the ${what} \`${target}\` has expired and is no longer armed — nothing about it ` +
    `will wake you now, and it is no longer holding your thread out of the queue.\n\nIf you are still ` +
    `waiting on it, register it again with \`ntwinectl watch\` and a fresh \`--for\`. If you are not, ` +
    `and it was the only thing you were waiting on, end in a proper terminal state instead of parking ` +
    `on it again.`
  )
}

/** One park-integrity wake, read back out of its delivery. `items` is the status readout the message
 *  carried — the only part of the body a human has any use for, and the reason the divider can open. */
export interface ParkWake {
  kind: "expired" | "finished" | "requested"
  items: string[]
}

/** The head of an expiry wake the HUMAN asked for early (parkExpiredWakeMessage's `requested`). */
const PARK_REQUESTED_LEAD = "👋 The user asked for an update before your wait ran out. Check back in on everything."
const PARK_EXPIRED_HEAD = /^⏰ Your wait expired, nothing resolved\./
const PARK_FINISHED_HEAD = /^✅ (?:The work you parked on has|Everything you parked on has) FINISHED, so the park is over/

/** The status lines between the head and the instruction paragraph. They are the worker's own item
 *  labels (`- \`shell: bkjf8exat\` — still running`), which is the one thing here a human reads. */
function parkWakeItems(body: string): string[] {
  return body.split("\n").filter((line) => line.trimStart().startsWith("- "))
}

export function parseParkWake(text: string): ParkWake | null {
  const trimmed = text.trim()
  if (PARK_EXPIRED_HEAD.test(trimmed)) return { kind: "expired", items: parkWakeItems(trimmed) }
  if (trimmed.startsWith(PARK_REQUESTED_LEAD) || trimmed.startsWith(legacyHumanWording(PARK_REQUESTED_LEAD))) return { kind: "requested", items: parkWakeItems(trimmed) }
  if (PARK_FINISHED_HEAD.test(trimmed)) return { kind: "finished", items: parkWakeItems(trimmed) }
  return null
}

const PR_WATCH_EXPIRED_HEAD = /^⏰ Your watcher on (\S+) has expired and is no longer armed\b/

/** The PR whose watcher lapsed, or null. One hairline: the registration is gone, and the ref is the
 *  only thing on it a reader can act on. */
export function parsePrWatchExpiredWake(text: string): { ref: string } | null {
  const m = PR_WATCH_EXPIRED_HEAD.exec(text.trim())
  return m ? { ref: m[1] } : null
}

const OWN_WATCH_EXPIRED_HEAD = /^⏰ Your watch on the (sub-agent|background shell) `([^`]+)` has expired and is no longer armed\b/

/** A lapsed `ntwinectl watch` on one of the worker's own shells or sub-agents, or null. The twin of
 *  the PR one above, and it had no parser from the day `ownWatchExpiredWakeMessage` shipped — so the one
 *  ntwine-composed wake left printing its "register it again with `ntwinectl watch`" body at the human
 *  was this (measured 2026-10-11: 1 of the 4 deliveries on this machine still drawing the verbatim card). */
export function parseOwnWatchExpiredWake(text: string): { kind: "shell" | "agent"; target: string } | null {
  const m = OWN_WATCH_EXPIRED_HEAD.exec(text.trim())
  return m ? { kind: m[1] === "sub-agent" ? "agent" : "shell", target: m[2] } : null
}

/** What is being waited ON: one of the worker's own background shells, or a pull request. */
// NEITHER KIND HAS A REGISTRY ROW BEHIND IT any more (2026-08-14). Both are derived from the worker's
// own ```awaiting fence — `shell` from its `shells:` list, `github` from its `prs:` list — so this strip
// lists exactly what will wake the thread and cannot drift from it.
//
// `github` became a view kind first (2026-08-13). A PR wait lives in the worker's
// ```awaiting fence — that is deliberate and settled (`f366e2d`, "the fence owns PR watching") — but the
// operator still wants to SEE it standing, in the same strip under the prompt box that lists sub-agents
// and background shells: "showing the active watchers underneath the prompt box, similar to how
// subagents work… now GitHub watchers can be included in the ranks of those" (maintainer 2026-08-13).
// So the board SYNTHESIZES one row per parseable `prs:` entry on the thread's standing fence. It is
// derived state, not a registration: it appears when the worker parks, vanishes when it says anything
// else, and carries no drop affordance, because there is no row to drop.
export const ThreadWatchKind = z.enum(["shell", "github", "timer"])
export type ThreadWatchKind = z.infer<typeof ThreadWatchKind>

/** How a watched PR's checks stand right now, in the shape GitHub's own merge box states it: a rollup
 *  verdict plus the counts behind it, and whether the PR can actually be merged.
 *
 *  IT DECIDES A QUEUE RULE, not just a readout (maintainer 2026-08-14: "if there is a GitHub watcher
 *  registered and the GitHub actions are still running, then that should remain in the running active
 *  rail. Only if CI has failed or completed successfully should it show up back in the queue"). So it
 *  has to travel — a card that renders check state the board cannot also read would put the two out of
 *  step, which is the drift that produced two cards saying different things about the same wait. */
export const GithubChecksState = z.enum(["none", "running", "passing", "failing"])
export type GithubChecksState = z.infer<typeof GithubChecksState>

/** Can GitHub merge it? `blocked` covers a required review or a failing required check — GitHub reports
 *  the two the same way, and neither is something ntwine should claim to distinguish. */
export const GithubMergeState = z.enum(["mergeable", "blocked", "conflicting", "unknown"])
export type GithubMergeState = z.infer<typeof GithubMergeState>

export const GithubWatchStatus = z.object({
  checks: GithubChecksState,
  /** The counts behind the verdict, so the card can say "3 running, 12 passed" the way GitHub does
   *  rather than only "checks are running". */
  running: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Checks that reached a terminal state without asserting anything — GitHub's `SKIPPED` and `STALE`.
   *  Counted apart from `passed` since 2026-09-04: they were folded into it, so a rollup of 12 skipped
   *  no-ops and 3 label bots rendered and reported as "15 checks green". Defaulted, because a reading
   *  written before that date carries neither this nor `gated`. */
  skipped: z.number().int().nonnegative().default(0),
  /** Workflows held at `action_required` — GitHub's "Approve and run" gate on a fork or first-time
   *  contributor's PR. They produce NO check run, so they are absent from the rollup entirely and the
   *  poll cannot see them there; the head's workflow runs are where they show up. Non-zero means CI has
   *  not started and will not until a maintainer presses the button. */
  gated: z.number().int().nonnegative().default(0),
  /** The gated workflow NAMES, capped — "Test Linux, Test macOS, Linters" says what is being withheld,
   *  where a bare count does not. */
  gating: z.array(z.string()).max(8).default([]),
  /** The failing job NAMES, capped — what a human actually needs to decide whether to look. */
  failing: z.array(z.string()).max(8).default([]),
  merge: GithubMergeState,
  /** OPEN | CLOSED | MERGED, lowercased. A merged or closed PR ends the wait outright. */
  state: z.enum(["open", "closed", "merged"]),
  /** When ntwine last heard from GitHub. A poll can fail or be rate-limited, and a stale reading stated
   *  as current is worse than no reading. */
  polledAt: z.string(),
  /** The head commit this verdict was reached on. A PR watcher reports a CI verdict when it is NEWS, and
   *  "red again on a new commit" is news that the bare word `failing` cannot express. Optional because a
   *  reading taken before 2026-08-17 carries none. */
  head: z.string().optional(),
  /** A digest of WHICH jobs are failing right now. The head commit alone cannot express a re-run of the
   *  same job, or a slower job going red after the first — both of which are a second failure the worker
   *  must hear about. Empty when nothing is failing. */
  failureSig: z.string().optional(),
}).strict()
export type GithubWatchStatus = z.infer<typeof GithubWatchStatus>

/** How a watched ISSUE stands right now — the issue twin of `GithubWatchStatus`, and deliberately a
 *  different shape rather than that one with its CI fields zeroed: an issue has no checks and no merge,
 *  and a row that said "no checks" about an issue would be reading a PR fact off a thing that has none.
 *  It decides no queue rule: an issue watcher is a visible queue handoff exactly as a PR watcher without
 *  running CI is, so this is a readout for the card and the worker's `list`, nothing more. */
export const GithubIssueStatus = z.object({
  /** OPEN | CLOSED, lowercased. A closed issue ends the wait outright. */
  state: z.enum(["open", "closed"]),
  /** GitHub's own reason for a close — `completed`, `not_planned`, `duplicate` — lowercased, when it
   *  gave one. Absent while open. */
  stateReason: z.string().optional(),
  /** The issue's title, as of the last poll — the one fact a human needs to place a bare `owner/repo#N`
   *  on the card. Capped, because a title is a headline and the card is not the place to read one. */
  title: z.string().max(200).optional(),
  /** The conversation's size, so the card can say "14 comments" the way GitHub's list does. */
  comments: z.number().int().nonnegative(),
  /** When ntwine last heard from GitHub, for the same reason `GithubWatchStatus.polledAt` carries it. */
  polledAt: z.string(),
}).strict()
export type GithubIssueStatus = z.infer<typeof GithubIssueStatus>

/** One wait the thread has out, as the board states it.
 *
 *  A `shell` row is DERIVED FROM THE FENCE — a `shells:` entry checked against live telemetry — and has
 *  no registration behind it: it lives exactly as long as the fence that declares it, which is also
 *  exactly as long as the scheduler watches it. A `github` row mirrors a REGISTERED PR watcher and a
 *  `timer` row an ARMED timer (`thread_timer`), fence or no fence — a registration is live work that
 *  WILL wake the thread. Either way the coupling is the point: the strip lists precisely what will
 *  actually wake the thread, and the two cannot drift into claiming different things. */
export const ThreadWatchView = z.object({
  id: z.string(),
  kind: ThreadWatchKind,
  target: z.string(),
  state: z.enum(["armed", "fired", "dropped"]),
  createdAt: z.string(),
  /** `github` rows only, and absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
  /** `github` rows only: WHAT the row watches. A pull request and an issue share the kind — they are one
   *  registry, one ref grammar (`owner/repo#N`) and one place on every surface that lists waits — and
   *  differ in what the poll can read off them, which is what this field lets a card branch on.
   *  Optional, and absent means a pull request — a row from a server that predates issues reads as the
   *  PR it always was, and the non-github kinds never carry it. */
  subject: z.enum(["pull", "issue"]).optional(),
  /** `github` rows watching an ISSUE only, and absent until the first successful poll — the twin of the
   *  `github` half above, for the rows whose subject has no checks to report. */
  issue: GithubIssueStatus.optional(),
  /** `timer` rows only: the armed timer's own registration, which is everything the row renders — the
   *  worker's prompt is the row's NAME (a `tmr_…` id names nothing to a human) and the fire instant is
   *  its status. Unlike `github` there is no polled half to be absent: a timer that exists is fully
   *  known, so a timer row always carries this. */
  timer: z.object({ fireAt: z.string(), prompt: z.string() }).strict().optional(),
}).strict()
export type ThreadWatchView = z.infer<typeof ThreadWatchView>

/** A PR watcher's own ceiling, and it is a YEAR — deliberately nothing like AWAITING_FOR_MAX_MS.
 *
 *  A shell dies with its session; a pull request in a repo nobody here controls does not. It sits
 *  unreviewed for as long as its maintainers take, and a watcher shorter than that expires against a PR
 *  that has not changed — which wakes the thread, produces nothing, and costs a re-arm. Measured on the
 *  live board: a worker's PR into `vercel/ai` re-armed at the 24h ceiling four days running, four wakes,
 *  zero maintainer activity (maintainer 2026-09-02: "for an external PR that we have no control over,
 *  you could snooze basically for like a year … much easier just to let the user hit the snooze button").
 *
 *  It is a CEILING, not a recommendation for every PR — a worker watching CI on its own PR still wants
 *  hours. What the ceiling buys is that the long wait is now REPRESENTABLE, so the guidance can ask for
 *  it and the answer is no longer capped back to a day behind the worker's back. */
export const PR_WATCH_FOR_MAX_MS = 365 * 24 * 60 * 60 * 1000

/** What an old worker's `watch_pr` gets when its MCP binary predates `for` and cannot send one. Still
 *  BOUNDED — the point of the field is that an unrenewed watcher eventually stops polling — but no
 *  longer short enough to be its own source of wakes: a worker that cannot choose was re-arming every
 *  6h forever, which is the exact noise the ceiling above exists to end. */
export const PR_WATCH_DEFAULT_FOR_MS = 30 * 24 * 60 * 60 * 1000

/** The ceiling on registered PR watchers per thread. A tool call in a loop cannot fill the table, and
 *  the refusal names the number so a worker drops one rather than retrying. */
export const PR_WATCH_MAX_ARMED = 32

/** One registered PR watcher, as the worker's own tool reads it back. */
export const PrWatchView = z.object({
  id: z.string(),
  /** `owner/repo#N`, normalized — the same string the board's row and the status book are keyed by. */
  target: z.string(),
  /** A pull request or an issue. Both live in one registry (`pr_watch`) and answer to one drop verb; an
   *  issue row is the human's, from the done card's Watch (or a worker's from before 2026-10-14, when
   *  `watch_issue` was removed), and `watch_pr` lists only pull requests. Defaulted for a row an older
   *  server sends. */
  kind: z.enum(["pull", "issue"]).default("pull"),
  state: z.enum(["armed", "dropped", "settled"]),
  createdAt: z.string(),
  /** The PR's checks/mergeability as the poller last saw it. Absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
  /** An ISSUE's state as the poller last saw it — `kind: "issue"` rows only, absent until polled. */
  issue: GithubIssueStatus.optional(),
}).strict()
export type PrWatchView = z.infer<typeof PrWatchView>

export const AddOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  /** `owner/repo#123` or a PR URL. Parsed server-side; an unparseable ref is refused rather than stored,
   *  because a watcher that can never fire is worse than none — the worker rests believing it is covered. */
  target: z.string().trim().min(1).max(200),
  /** How long to watch, as a DURATION (`2h`, `3d`, `180d` — parseAwaitingDurationRaw, capped at
   *  PR_WATCH_FOR_MAX_MS).
   *
   *  A PR nobody ever reviews would otherwise be polled forever, and a thread parked on it would wait
   *  forever with it — the same unbounded wait the awaiting fence's `for:` closes, one level down. A
   *  duration rather than an instant for the same reason it is one there: it cannot be written in the
   *  past (maintainer 2026-08-15, asking for it explicitly).
   *
   *  BOUNDED IS NOT THE SAME AS SHORT, and conflating them is what made this field a noise source. The
   *  bound exists so a forgotten watcher stops polling eventually, which a year satisfies exactly as
   *  well as a day — and a day spent it against every external PR, which does not move on that clock.
   *
   *  REQUIRED BY THE TOOL, OPTIONAL ON THE WIRE, and the asymmetry is deliberate. A worker's MCP server
   *  outlives every ntwine restart, so a session dispatched before this existed still holds a binary that
   *  cannot send it — and making the RPC reject that would break `watch_pr` outright for every thread
   *  already running, with no recourse from inside those threads. Absent ⇒ PR_WATCH_DEFAULT_FOR, which
   *  still BOUNDS the poll; the point of the field is that a worker chooses, and one that cannot choose
   *  is better bounded than broken. */
  for: z.string().trim().min(1).max(16).optional(),
}).strict()
export type AddOwnPrWatchInput = z.infer<typeof AddOwnPrWatchInput>

export const AddOwnPrWatchResult = z.object({
  id: z.string(),
  target: z.string(),
  /** True when this exact PR was ALREADY watched by this thread, so the call registered nothing new.
   *  Re-registering after a compaction is the common case, and a duplicate would double every wake. */
  alreadyArmed: z.boolean(),
  /** When this watcher runs out. Read back so the worker sees the duration it ACTUALLY got rather than
   *  the one it asked for — on a re-registration that is the original expiry, which the call left alone. */
  expiresAt: z.string(),
  /** The `for:` the worker wrote, present ONLY when it exceeded the ceiling and was capped. A clamp
   *  nobody is told about is a worker resting on a year of coverage it does not have. */
  clampedFrom: z.string().optional(),
  watches: z.array(PrWatchView),
}).strict()
export type AddOwnPrWatchResult = z.infer<typeof AddOwnPrWatchResult>

/** The done card's Watch button (2026-10-07): the HUMAN arms a watcher on a pull request or issue the
 *  finished thread names, and parks this rest in Snoozed until it reports. `target` is `owner/repo#N` —
 *  the card resolves a bare `#N` against the project's repo, as its links do. Which of the two it is, is
 *  the server's to find out (it probes), because prose cannot say. */
export const WatchDoneRefInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  target: z.string().trim().min(1).max(200),
}).strict()
export type WatchDoneRefInput = z.infer<typeof WatchDoneRefInput>

export const WatchDoneRefResult = z.object({
  target: z.string(),
  kind: z.enum(["pull", "issue"]),
  /** The thread already watched it (the worker's own watcher, or an earlier click); only the park is new. */
  alreadyArmed: z.boolean(),
}).strict()
export type WatchDoneRefResult = z.infer<typeof WatchDoneRefResult>

export const DropOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnPrWatchInput = z.infer<typeof DropOwnPrWatchInput>

export const DropOwnPrWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(PrWatchView),
}).strict()
export type DropOwnPrWatchResult = z.infer<typeof DropOwnPrWatchResult>

// ---- THE WORKER'S OWN WATCHES on its own running work (2026-08-26) -----------------------------------
// `ntwinectl watch` / `ntwinectl unwatch`. See plans/rest-by-registration.md: a wait stops being a
// line the worker restates at every rest and becomes a row it creates once.
//
// ONE VERB ACROSS KINDS, unlike the four narrow item kinds the fence grammar has. A shell and a sub-agent
// are the same act — "bring me back when this finishes" — and splitting them into two tools would teach
// two things where there is one. A PR keeps its own verb because it is not the same act: `watch_pr`
// creates a REPEATING poll against a service ntwine has to reach, and it can fail for reasons a runtime
// handle never can (signed out, an SSO-gated org, no `gh`).
export const OwnWatchKind = z.enum(["shell", "agent"])
export type OwnWatchKind = z.infer<typeof OwnWatchKind>

export const AddOwnWatchInput = z.object({
  slug: ThreadSlug,
  /** What KIND of thing the target is. Stored, and checked against the thread's live telemetry before the
   *  row is written — see the note on `target`. */
  kind: OwnWatchKind,
  /** The handle the worker was shown: a runtime task id ("Command running in background with ID: …"), a
   *  launch tool_use id, or the op's own label.
   *
   *  VALIDATED AGAINST LIVE TELEMETRY, NOT AGAINST ITS SHAPE. A PR ref is checkable by shape because
   *  `owner/repo#123` looks like nothing else; a shell handle and a sub-agent handle are both opaque
   *  runtime strings and overlap completely, so shape can only ever be a guess. What ntwine CAN answer
   *  exactly is whether this thread has a live shell — or a live sub-agent — answering to this handle, and
   *  that is both the stronger check and the one that catches the real mistake: naming a sub-agent under
   *  `kind: "shell"`, which is what put two sub-agents under a "Background shells" heading on 2026-08-26. */
  target: z.string().trim().min(1).max(200),
  /** REQUIRED, and a DURATION (`30m`, `2h`, `3d` — parseAwaitingDurationRaw, capped at 24h).
   *
   *  STILL A DAY, where a PR watcher now gets a year: this names a shell or a sub-agent, which lives
   *  inside the session that launched it, so a wait standing longer than a day is one whose target is
   *  almost certainly already gone.
   *
   *  No default and no wire-level optionality, unlike `AddOwnPrWatchInput.for`: that field is optional
   *  only to keep working for sessions dispatched before it existed, and this RPC has no such sessions.
   *  On elapse the row is CANCELLED and the thread woken to re-decide, which is what stops a registration
   *  outliving its own relevance — the one thing an un-restated fence could never do wrong. */
  for: z.string().trim().min(1).max(16),
}).strict()
export type AddOwnWatchInput = z.infer<typeof AddOwnWatchInput>

// ---- EXTENDING A BACKGROUND SHELL'S RUNTIME BUDGET (`ntwinectl extend-shell`, 2026-09-29) -------------
// A background shell carries a budget only when one was declared (server shell-budget.ts: its launch
// `timeout`, or this; no default). Past it the worker is warned once and, unextended, the shell is
// stopped ten minutes later. This GIVES a budget to a shell launched without one, answers that warning
// ("keep it"), or pre-empts it for a shell the worker knows will run long. It sets the budget to end
// `for` from NOW, not from launch, so the worker never has to do arithmetic against an instant it
// cannot see.
export const ExtendOwnShellInput = z.object({
  slug: ThreadSlug,
  /** The shell's handle — the same three a `watch` of kind shell accepts: the runtime task id the worker
   *  was shown, the launch tool_use id, or the shell's label. Resolved against live telemetry. */
  shell: z.string().trim().min(1).max(200),
  /** A DURATION (`30m`, `2h`), parseAwaitingDurationRaw, capped at 24h and the cap reported. */
  for: z.string().trim().min(1).max(16),
}).strict()
export type ExtendOwnShellInput = z.infer<typeof ExtendOwnShellInput>

export const ExtendOwnShellResult = z.object({
  /** The handle the shell answers to in every other readout (its task id where it has one). */
  shell: z.string(),
  label: z.string(),
  /** The new deadline, ISO8601. */
  budgetEndsAt: z.string(),
  /** The `for` as written, present ONLY when it exceeded 24h and was capped. */
  clampedFrom: z.string().optional(),
}).strict()
export type ExtendOwnShellResult = z.infer<typeof ExtendOwnShellResult>

export const OwnWatchView = z.object({
  id: z.string(),
  kind: OwnWatchKind,
  target: z.string(),
  /** The op's own label where the target resolved to one, so a read-back names the work rather than an
   *  opaque handle. Absent when the target no longer resolves — the row still stands and names itself. */
  label: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict()
export type OwnWatchView = z.infer<typeof OwnWatchView>

export const AddOwnWatchResult = z.object({
  id: z.string(),
  kind: OwnWatchKind,
  target: z.string(),
  /** True when this exact (kind, target) was already watched, so the call registered nothing new and the
   *  existing expiry stands. Re-registering after a wake or a compaction is the common, correct case. */
  alreadyArmed: z.boolean(),
  /** The `for:` the worker wrote, present ONLY when it exceeded the ceiling and was capped — the twin of
   *  `AddOwnPrWatchResult.clampedFrom`, for the same reason: a silent clamp is a worker resting on
   *  coverage it does not have. */
  clampedFrom: z.string().optional(),
  watches: z.array(OwnWatchView),
}).strict()
export type AddOwnWatchResult = z.infer<typeof AddOwnWatchResult>

export const DropOwnWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnWatchInput = z.infer<typeof DropOwnWatchInput>

export const DropOwnWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(OwnWatchView),
}).strict()
export type DropOwnWatchResult = z.infer<typeof DropOwnWatchResult>

/** How many watches one thread may hold at once. A bound, not an opinion — the same shape as
 *  PR_WATCH_MAX_ARMED, and generous enough that no honest fan-out meets it. */
export const OWN_WATCH_MAX_ARMED = 24

// ---- THE WORKER'S COMMAND WATCHES (2026-10-11) -------------------------------------------------------
// `ntwinectl watch-command`. A wait on an OUTSIDE condition a shell command can check — a package version
// appearing on npm, a release run finishing, a URL coming up — run by the SERVER on a cadence, so the
// wait holds nothing in the thread's own process tree and a resting thread can hibernate under it.
//
// WHY IT EXISTS. A worker parked on a polling background shell (`until npm view pkg@1.2.3 version; do
// sleep 300; done`) pins its whole daemon tree, ~250 MB, for the life of the loop: hibernation refuses
// any thread holding a background shell, because tearing the CLI down kills it. On the maintainer's
// machine on 2026-10-11 three threads idle between 1h47m and 21h were pinned exactly that way (~750 MB),
// one of them on an npm version for 21 hours. The shell bought nothing but re-running a check.
//
// THE CONDITION IS EXIT STATUS 0, and nothing else: no output matching, no state carried between runs.
// The first run that exits 0 settles the row and wakes the thread once, with the command and the tail of
// its output. `for` running out cancels it and wakes the thread to re-decide, the `watch` semantics.

/** The shortest cadence. A check every minute is already a process every minute for as long as the wait
 *  lasts; anything faster is a busy loop the server would run on the worker's behalf. */
export const COMMAND_WATCH_EVERY_MIN_MS = 60_000
/** The longest cadence — a day. A check rarer than that is a timer's job, not a watch's. */
export const COMMAND_WATCH_EVERY_MAX_MS = 24 * 60 * 60 * 1000
/** The ceiling on `for`: a WEEK. Long enough for every wait this exists for (npm's review hold has been
 *  measured at up to ~4h, a release run at under 6h, a deploy at minutes) with days to spare, and short
 *  enough that a forgotten watch stops spawning a process a minute within the week. Nothing like a PR
 *  watcher's year: a PR moves on someone else's clock, while a command checks something this machine's
 *  own work set in motion. Clamped and REPORTED, never refused, the same rule every other `for` follows. */
export const COMMAND_WATCH_FOR_MAX_MS = 7 * 24 * 60 * 60 * 1000
/** Per thread. Each one is a process on a clock, so this is far below the PR watcher's 32. */
export const COMMAND_WATCH_MAX_ARMED = 8
/** The longest command accepted, in characters. A check is one line; a script belongs in a file. */
export const COMMAND_WATCH_COMMAND_MAX = 4000
/** How much of a run's output is kept and handed back: the TAIL, in bytes, stdout and stderr interleaved. */
export const COMMAND_WATCH_OUTPUT_MAX_BYTES = 4096
/** One run's limit. Killed with its whole process group past this, and counted as a failed check. */
export const COMMAND_WATCH_RUN_TIMEOUT_MS = 2 * 60_000

/** One finished check, as stored on the row and read back. `exitCode` is null for every outcome but
 *  `exit`: a run killed by its timeout, by a signal, or that never started has no exit status to report. */
export const CommandWatchRun = z.object({
  at: z.string(),
  outcome: z.enum(["exit", "timeout", "signal", "error"]),
  exitCode: z.number().int().nullable(),
  output: z.string(),
}).strict()
export type CommandWatchRun = z.infer<typeof CommandWatchRun>

export const CommandWatchState = z.enum(["armed", "dropped", "passed", "expired", "cancelled"])
export type CommandWatchState = z.infer<typeof CommandWatchState>

/** One registered command watch, as the worker's own command reads it back. */
export const CommandWatchView = z.object({
  id: z.string(),
  command: z.string(),
  /** The cadence in the house duration grammar (`5m`, `1h 30m`). */
  every: z.string(),
  state: CommandWatchState,
  createdAt: z.string(),
  expiresAt: z.string(),
  /** How many checks have run since it was armed, the registration's own first check included. */
  runs: z.number().int().nonnegative(),
  lastRun: CommandWatchRun.optional(),
}).strict()
export type CommandWatchView = z.infer<typeof CommandWatchView>

export const AddOwnCommandWatchInput = z.object({
  slug: ThreadSlug,
  /** Run with `/bin/sh -c` in the project root, with the server's environment. Exit status 0 is "passed". */
  command: z.string().trim().min(1).max(COMMAND_WATCH_COMMAND_MAX),
  /** How often to check, as a DURATION (`5m`; parseAwaitingDurationRaw). Clamped to [1m, 24h] and reported. */
  every: z.string().trim().min(1).max(16),
  /** How long to keep checking, as a DURATION. Clamped to COMMAND_WATCH_FOR_MAX_MS and reported. */
  for: z.string().trim().min(1).max(16),
}).strict()
export type AddOwnCommandWatchInput = z.infer<typeof AddOwnCommandWatchInput>

export const AddOwnCommandWatchResult = z.object({
  /** Present when the call was REFUSED — the thread may not run commands outside the CLI's permission
   *  system, or the command cannot run here at all. A refusal is an answer, not a fault: the text says
   *  why and what to use instead, and nothing was stored. */
  refused: z.string().optional(),
  /** The armed row's id. Absent when nothing was armed: a refusal, or a first check that already passed. */
  id: z.string().optional(),
  /** This exact command was already watched on this thread, so the call registered nothing new. */
  alreadyArmed: z.boolean().default(false),
  /** The FIRST CHECK, run before anything was stored. Exit 0 there means the condition already holds:
   *  nothing is armed, and the worker proceeds now rather than waiting a cadence to be told so. */
  firstRun: CommandWatchRun.optional(),
  passed: z.boolean().default(false),
  expiresAt: z.string().optional(),
  every: z.string().optional(),
  /** The `every` / `for` the worker wrote, present ONLY when it was clamped — a clamp nobody is told about
   *  is a worker resting on coverage it does not have. */
  clamped: z.object({ every: z.string().optional(), for: z.string().optional() }).strict().optional(),
  watches: z.array(CommandWatchView),
}).strict()
export type AddOwnCommandWatchResult = z.infer<typeof AddOwnCommandWatchResult>

export const DropOwnCommandWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnCommandWatchInput = z.infer<typeof DropOwnCommandWatchInput>

export const DropOwnCommandWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(CommandWatchView),
}).strict()
export type DropOwnCommandWatchResult = z.infer<typeof DropOwnCommandWatchResult>

export const ListOwnCommandWatchesInput = z.object({ slug: ThreadSlug }).strict()
export type ListOwnCommandWatchesInput = z.infer<typeof ListOwnCommandWatchesInput>

export const OwnCommandWatchesResult = z.object({ watches: z.array(CommandWatchView) }).strict()
export type OwnCommandWatchesResult = z.infer<typeof OwnCommandWatchesResult>

/** A code fence that cannot be closed early by what it holds: one backtick longer than the longest run
 *  of backticks inside. A command or its output may carry ``` of its own. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return "`".repeat(Math.max(3, longest + 1))
}

function codeBlock(text: string, info = ""): string {
  const fence = fenceFor(text)
  return `${fence}${info}\n${text.replace(/\n+$/, "")}\n${fence}`
}

/** How one check ended, as a clause: "exited 1", "timed out after 2m", "was killed by SIGKILL". */
function commandRunClause(run: Pick<CommandWatchRun, "outcome" | "exitCode">): string {
  if (run.outcome === "exit") return `exited ${run.exitCode ?? "?"}`
  if (run.outcome === "timeout") return `timed out after ${formatElapsed(COMMAND_WATCH_RUN_TIMEOUT_MS)}`
  if (run.outcome === "signal") return "was killed by a signal"
  return "could not be started"
}

const COMMAND_WATCH_PASSED_HEAD = /^✅ Your command watch `(cmw_[a-z0-9]+)` PASSED\b/
const COMMAND_WATCH_EXPIRED_HEAD = /^⏰ Your command watch `(cmw_[a-z0-9]+)` has expired and is no longer armed\b/
const COMMAND_WATCH_CANCELLED_HEAD = /^⚠️ ntwine cancelled your command watch `(cmw_[a-z0-9]+)`/

/** The wake a command watch sends when a check exits 0 — the one piece of news it exists to deliver. */
export function commandWatchPassedWakeMessage(input: { id: string; command: string; output: string; runs: number; armedMs: number }): string {
  const checks = `${input.runs} check${input.runs === 1 ? "" : "s"}`
  const output = input.output.trim()
  return [
    `✅ Your command watch \`${input.id}\` PASSED — its command exited 0 on check ${input.runs} (${checks} over ${formatElapsed(input.armedMs)}):`,
    "",
    codeBlock(input.command, "sh"),
    "",
    output ? `Its output ended:\n\n${codeBlock(output)}` : "It printed nothing.",
    "",
    "The watch is settled and runs no more. Carry on with whatever you were waiting on it for.",
  ].join("\n")
}

/** The wake a command watch sends when its `for` runs out — the twin of ownWatchExpiredWakeMessage. */
export function commandWatchExpiredWakeMessage(input: { id: string; command: string; lastRun?: Pick<CommandWatchRun, "outcome" | "exitCode" | "output"> }): string {
  const last = input.lastRun
  const tail = last?.output.trim()
  return [
    `⏰ Your command watch \`${input.id}\` has expired and is no longer armed — its command never exited 0, and nothing about it will wake you now:`,
    "",
    codeBlock(input.command, "sh"),
    "",
    last
      ? `Its last check ${commandRunClause(last)}${tail ? `, ending:\n\n${codeBlock(tail)}` : " and printed nothing."}`
      : "It never completed a check.",
    "",
    "If you still mean to wait, find out why it never passed, then register it again with `ntwinectl watch-command add` " +
      "and a fresh `--for`. If you do not, and it was the only thing you were waiting on, end in a proper terminal " +
      "state instead of parking on it again.",
  ].join("\n")
}

/** The wake a command watch sends when ntwine stops it before it passed or expired — the thread's
 *  permission mode or sandbox changed under it, so the server may no longer run the command for it. */
export function commandWatchCancelledWakeMessage(input: { id: string; command: string; reason: string }): string {
  return [
    `⚠️ ntwine cancelled your command watch \`${input.id}\` and will not run it again: ${input.reason}`,
    "",
    codeBlock(input.command, "sh"),
    "",
    "Nothing about it will wake you now. If you still need the wait, run the check in a background shell instead.",
  ].join("\n")
}

/** A command watch's wake, read back — which of the three it is and the watch's id — or null. */
export function parseCommandWatchWake(text: string): { kind: "passed" | "expired" | "cancelled"; id: string } | null {
  const first = text.trim()
  const passed = COMMAND_WATCH_PASSED_HEAD.exec(first)
  if (passed) return { kind: "passed", id: passed[1] }
  const expired = COMMAND_WATCH_EXPIRED_HEAD.exec(first)
  if (expired) return { kind: "expired", id: expired[1] }
  const cancelled = COMMAND_WATCH_CANCELLED_HEAD.exec(first)
  return cancelled ? { kind: "cancelled", id: cancelled[1] } : null
}

// ---- THE WORKER'S REGISTERED QUESTIONS (2026-08-26) ------------------------------------------------
// `ntwinectl ask` / `ntwinectl unask`. See plans/rest-by-registration.md.
//
// THE FREE-FORM ```question FENCE IS RETIRED (2026-09-11). A fence with a question in its body was the
// original way a worker asked, and the `ask` tool landed beside it on 2026-08-26 as the "better" form
// rather than the only one — so the contract went on teaching both, workers went on writing fences on
// most days, and an answered fence stayed answerable because nothing tracks a fence's answer (a fence
// is bytes in a message; the row is the only lifecycle). PR #33 proposed settling fences by matching
// the human's later Answers: turns against them, and the maintainer declined it for what it is: guessing
// which historical fences are done (2026-09-11: "I don't like the idea of guessing at which question
// fences should be considered marked as complete or not"). So the fence stops being a question at all.
// A thread dispatched at or after this instant reads under the new contract: `ask` is the ONLY way to
// ask — see questionFencesLive. (The one fence it kept, the empty PLACEMENT marker ```question qst_…,
// was retired in turn on 2026-09-28: a registered card renders at the bottom of its rest, never inside
// a handoff, and a marker draws nothing — web/lib/questionShadow.)
//
// THE CUTOVER IS BY DISPATCH INSTANT, not by a version stamp, because the worker prompt is injected at
// dispatch and a running thread keeps the contract it started with: a thread that was spawned under the
// old prompt may still fence, and its fence must still queue the thread and still render answerable —
// exactly as it always did — or a human would be left with a worker waiting on a card nobody can click.
// The tailer, the board, the scheduler and the web all read the same predicate, so they cannot disagree
// about which threads still speak the old grammar.
export const QUESTION_FENCE_RETIRED_AT = "2026-09-11T17:30:00Z"

/** Does this thread's worker still speak the free-form ```question fence — was it dispatched before the
 *  fence was retired? An unknown dispatch instant reads as LEGACY: the cost of treating an old thread's
 *  fence as prose (an unanswerable ask) is worse than the cost of the reverse (a stray fence from a new
 *  worker still queues the thread). */
export function questionFencesLive(spawnedAt: string | number | undefined | null): boolean {
  if (spawnedAt === undefined || spawnedAt === null) return true
  const at = typeof spawnedAt === "number" ? spawnedAt : Date.parse(spawnedAt)
  if (!Number.isFinite(at)) return true
  return at < Date.parse(QUESTION_FENCE_RETIRED_AT)
}

// THE WORKER DECIDES WHETHER A REST NEEDS THE HUMAN (maintainer 2026-10-01). Until this cut, whether a
// thread resting on running work sat in the queue or in the Active band was ntwine's GUESS, one rule per
// kind of wait: a live sub-agent kept it out, a shell did not, a declared shell did, a watched PR did
// only while its CI ran. Each rule was a guess about what the worker wanted, and the worker knows — a
// worker with a sub-agent out and half a report the human could already act on had no way to say so
// short of asking a question or claiming `done` (maintainer: "the agent should have the ability to
// specifically signal whether or not the user is needed or not").
//
// So a worker that rests on running work now SAYS it, in the ```awaiting fence: `needs_input: true` puts
// the thread in the queue while the work runs, `needs_input: false` keeps it out. The answer is REQUIRED
// on every such rest ("we should make it required so the agent always needs to provide an answer here"),
// and only on such rests — `done` and a registered question already are the answer "yes". A rest on
// running work with no fence is a bare rest: queued, and the sign-off nudge teaches the fence.
//
// The safety rules are the fence's own and nothing new: a `false` parks only while every item it names
// is live and its `for:` has not run out (awaiting.parkIsHonoured), so a wrong `false` cannot hide a
// thread that nothing will ever wake.
//
// BY DISPATCH INSTANT, for the reason QUESTION_FENCE_RETIRED_AT gives: a running thread keeps the
// contract it started with, so a worker dispatched before this cut never heard of the key and keeps the
// per-wait rules. An unknown dispatch instant reads as LEGACY for the same reason — the old rules are the
// ones a worker that never saw the key can satisfy.
//
// THE ANSWER BECAME `status:` ON 2026-10-05 WITH NO NEW CUT (see AWAITING_STATUSES). The cut decides only
// whether an answer is REQUIRED, and a worker taught `needs_input:` still satisfies it: the fence reads
// the old line as an alias, so nothing this cut gave a running worker is taken away. Every reminder and
// correction now teaches `status:`, which such a worker can write just as well.
export const NEEDS_INPUT_REQUIRED_AT = "2026-10-02T00:48:00Z"

/** Does this thread's worker decide its own placement with the fence's answer line (`status:`, or the
 *  older `needs_input:`) — was it dispatched at or after NEEDS_INPUT_REQUIRED_AT? */
export function needsInputRequired(spawnedAt: string | number | undefined | null): boolean {
  if (spawnedAt === undefined || spawnedAt === null) return false
  const at = typeof spawnedAt === "number" ? spawnedAt : Date.parse(spawnedAt)
  if (!Number.isFinite(at)) return false
  return at >= Date.parse(NEEDS_INPUT_REQUIRED_AT)
}

// WHY A ROW AND NOT A FENCE. A ```question block has the lifetime of the MESSAGE carrying it: the
// tailer recomputes `pendingQuestion` from the latest assistant text on every assistant record
// (`lastAssistantHasQuestion = hasQuestionBlock(raw)`, an assignment and not an OR), and clears it on
// any human turn. So a worker that asks and then says one more sentence has silently un-asked, and a
// steer that was not an answer discharges a question the human still owed. A row survives both.
//
// THE AUTHORING SHAPE, not the render shape. `ParsedQuestion` (web/lib/questionBlocks.ts) is what the
// CARD consumes — flat, markdown-oriented, options as bare strings, because it is recovered by parsing
// prose. This is what a worker WRITES, and an adapter maps it onto that same card, exactly as
// lib/interactionQuestion.ts already does for a typed interaction. One card, three producers.
//
// THE VOCABULARY IS THE FENCE'S, deliberately: `kind` is QuestionKind (`question` | `multi`) and
// `danger` is orthogonal to it, so nothing here invents a second name for a thing the renderer already
// has a name for. A FREE-TEXT question is one with no options — which the card already renders, since
// its "something else…" row is unconditional — rather than a third kind.
export const AskQuestionKind = z.enum(["question", "multi"])
export type AskQuestionKind = z.infer<typeof AskQuestionKind>

export interface AskedOption {
  label: string
  /** The trade-off, or the evidence. ONE LINE renders inline after the label (the fence's em-dash
   *  join); MORE THAN ONE LINE renders as a full-markdown body INSIDE the option — a list, a code
   *  block, the diff the option would produce — visible before the human picks anything, because a
   *  detail that decides a choice is useless once the choice is already made. */
  description?: string
  /** Marks an option the worker recommends. A pick-ONE question takes at most one — a second is
   *  refused, since "recommended" means nothing if it is on two of three choices. A `multi` takes as
   *  many as the worker would tick: one chip in a list the human ticks several of reads as "pick only
   *  this" (maintainer 2026-10-10: "weird that there's a recommended chip on only a single item"). */
  recommended?: boolean
  /** Taking this option acts OUTSIDE this machine — files an issue, posts a comment, merges, pushes,
   *  publishes, spends — usually under the human's name. ntwine's unanswered-question default never takes
   *  such an option (recommendedDefaultAnswer): the David, 2026-10-06, after a TS 7 migration
   *  thread asked whether to file an upstream issue under their account and the 10m default was on
   *  course to file it — "an issue shouldn't be opened from me unless I actually answer". */
  external?: boolean
  /** RETIRED 2026-09-01 (it revealed markdown under the option only once picked — detail that should
   *  inform a choice arrived after the choice; maintainer: "you should just be rendering it as part of
   *  the answer before I click on it"). Still ACCEPTED, never refused: stored rows and in-flight
   *  workers carry it, and the card now folds it into the option's always-visible body. New workers
   *  never see it — the `ask` tool schema no longer offers it; a rich `description` is the shape. */
  preview?: string
  /** Questions that become live only if the human picks THIS option — the static tree. A branch nobody
   *  took returns nothing, so an unpicked follow-up is not a question anyone owes an answer to. */
  followUps?: AskedQuestion[]
}

export interface AskedQuestion {
  question: string
  /** A very short chip label for the card's heading (<= 12 chars), as the fence's own convention. */
  header?: string
  kind: AskQuestionKind
  /** The destructive gate — force-merge, deletion, history rewrite, prod rollback. It changes TWO
   *  things: the card wears the `risk` tone, and the human's × cannot reach it. A generic close icon is
   *  not consent for something irreversible; declining is an OPTION inside the question. */
  danger?: boolean
  /** The worker's mark that this decision shapes the work built on it — a library's architecture, a
   *  public API, a data model — so a guessed answer would be redone, not tweaked. ntwine's
   *  unanswered-question default never answers it (recommendedDefaultAnswer); the recommendation still
   *  shows. David, 2026-10-08, after a 3.0 precompile design thread had its architecture questions
   *  answered by the 10m default: "fundamental architectural decisions like this … should wait for my
   *  feedback". */
  waitForHuman?: boolean
  /** The worker's opt-in to the unanswered-question default: only a question marked `mayDefault` is
   *  ever answered on the human's behalf. Absent ⇒ it waits for the human. The default was opt-out
   *  (`waitForHuman`) until 2026-10-08, and a worker started before that rule existed let three ArkType
   *  3.0 design questions default anyway; David: "this should absolutely never be defaulted". An opt-in
   *  fails safe when a worker forgets — `waitForHuman` is kept only so older workers' calls still parse,
   *  and now changes nothing a missing `mayDefault` does not already do. */
  mayDefault?: boolean
  /** A SECRET request (`ntwinectl secret`): a free-text question whose answer is a credential — a
   *  one-time code, a token, a password. The card masks the box and keeps the typed value out of every
   *  draft cache; the server serves the value once, from memory, through a named pipe
   *  (`secret-files.ts`) and stores and delivers only `secretAnswerText`, so the value never reaches
   *  the disk, the database, the transcript or the model. Root questions only, and never with options. */
  secret?: boolean
  /** A REQUEST FOR ONE OF THE OPERATOR'S MCP SERVERS, by name — `ntwinectl mcp-request`. The server
   *  writes the question and its options itself (mcpRequestQuestion), and answering it with a grant
   *  mounts the server in the thread (router.ts applyMcpGrants). Root questions only. */
  mcp?: string
  /** Absent or empty ⇒ a free-text question. */
  options?: AskedOption[]
}

/** How deep a follow-up tree may go. Three: a question, a follow-up on the option taken, and one more.
 *  Past that the human is filling in a form rather than answering a question, and the worker should be
 *  deciding the rest itself.
 *
 *  THE ONE COUNT THE TOOL STILL BOUNDS. The options per question, the questions per call, the
 *  follow-ups per option and the open set per thread all carried caps (8 / 4 / 4 / 12) until
 *  2026-09-03, when the maintainer had them removed as arbitrary ("what other stupid limits are
 *  there?"). The depth stays only because the MCP schema INLINES the tree to exactly this depth — no
 *  `$ref`, since some clients drop one (cc-worker/bin/ntwine-mcp.mjs) — so it can be raised, never
 *  unbounded. */
export const ASK_MAX_DEPTH = 3

const AskedOptionSchema: z.ZodType<AskedOption> = z.lazy(() => z.object({
  // 400, not the 120 it launched with (2026-09-03): a label is a chip line, but "Post the drafted
  // comment as written" plus its qualifier runs long, and the fence has no cap at all. The answer's
  // `chosen` carries labels, so its per-item cap matches this one.
  label: z.string().trim().min(1).max(400),
  // 20000, not the 4000 the retired `preview` had (2026-09-03): a description is allowed to BE the rich
  // body — a diff, a drafted comment, a table — and a real diff exceeds 4000.
  description: z.string().trim().max(20000).optional(),
  recommended: z.boolean().optional(),
  external: z.boolean().optional(),
  preview: z.string().max(4000).optional(),
  // No count cap, like `options` (2026-09-03); the tree is bounded by ASK_MAX_DEPTH instead.
  followUps: z.array(AskedQuestionSchema).optional(),
}).strict())

export const AskedQuestionSchema: z.ZodType<AskedQuestion> = z.lazy(() => z.object({
  // 4000, not the 600 it launched with (2026-09-03): this field is the whole card context — everything
  // the human needs to answer cold — and a question that carries its own evidence needs the room. The
  // answer restates it, so QuestionAnswerSchema's cap matches.
  question: z.string().trim().min(1).max(4000),
  header: z.string().trim().max(24).optional(),
  kind: AskQuestionKind,
  danger: z.boolean().optional(),
  waitForHuman: z.boolean().optional(),
  mayDefault: z.boolean().optional(),
  secret: z.boolean().optional(),
  mcp: z.string().trim().min(1).max(200).optional(),
  // UNBOUNDED, deliberately. This carried `.max(8)` from launch until 2026-09-03, when the maintainer
  // asked for the cap to go ("allow arbitrary numbers of options"): a `multi` over a long list — which
  // gates to run, which of twenty findings to act on — is a real shape, and the card numbers past 9
  // (only 1–9 are keys) already. The count is the worker's to choose; the answer's `chosen` is unbounded to match.
  options: z.array(AskedOptionSchema).optional(),
}).strict())

/** The depth of a question tree, counting the root as 1. Separate from the schema because zod's `lazy`
 *  cannot bound its own recursion — the RPC refuses on this, with a message naming the limit. */
export function askedQuestionDepth(q: AskedQuestion): number {
  let deepest = 1
  for (const option of q.options ?? []) {
    for (const child of option.followUps ?? []) deepest = Math.max(deepest, 1 + askedQuestionDepth(child))
  }
  return deepest
}

/** Every way a tree can be malformed beyond its shape, as prose the worker can act on. Empty ⇒ fine. */
export function askedQuestionFaults(q: AskedQuestion): string[] {
  const faults: string[] = []
  const walk = (node: AskedQuestion, path: string) => {
    const options = node.options ?? []
    // A SECRET IS A VALUE, NOT A CHOICE: its card is one masked box, and the server swaps that box's
    // text for a file path — a picked label would reach the worker unmasked beside it.
    if (node.secret && options.length > 0) faults.push(`${path}: a secret request takes no options — it is one masked box`)
    // …and it is its own registration. A follow-up's answer rides inside its parent's, and the server
    // redacts at the root, so a secret branch would deliver the value in the clear.
    if (node.secret && path !== "question") faults.push(`${path}: a secret request cannot be a follow-up — register it on its own`)
    if (node.mcp && path !== "question") faults.push(`${path}: an MCP server request cannot be a follow-up — register it on its own`)
    // A MULTI-SELECT WITH NO OPTIONS IS A FREE-TEXT BOX WEARING THE WRONG LABEL, and it renders as one —
    // silently, so the worker never learns its `multi` did nothing.
    if (node.kind === "multi" && options.length === 0) faults.push(`${path}: \`kind: "multi"\` needs options — a question with none is free text`)
    // A `multi` is exempt: its recommendation is a SET — every option the worker would tick.
    if (node.kind !== "multi" && options.filter((o) => o.recommended).length > 1) faults.push(`${path}: only ONE option may be \`recommended\` on a pick-one question — a recommendation on two of three choices says nothing (a \`multi\` may mark every option worth ticking)`)
    // FOLLOW-UPS HANG OFF AN OPTION, so a free-text question cannot carry one: there is no answer to
    // branch on. A worker wanting a second question should register a second ROOT.
    for (const [i, option] of options.entries()) {
      if ((option.followUps ?? []).length > 0 && node.kind === "multi") {
        faults.push(`${path}: a \`multi\` option cannot carry follow-ups — several picked options would open several branches at once`)
      }
      for (const child of option.followUps ?? []) walk(child, `${path} → ${option.label}`)
      void i
    }
  }
  walk(q, "question")
  if (askedQuestionDepth(q) > ASK_MAX_DEPTH) {
    faults.push(`the follow-up tree is ${askedQuestionDepth(q)} levels deep; the limit is ${ASK_MAX_DEPTH} — past that you are asking the user to fill in a form`)
  }
  return faults
}

export const AskInput = z.object({
  slug: ThreadSlug,
  // No cap on the count (four until 2026-09-03): the command's own help says several at once is one
  // run — register them together — and a cap here told a worker with six to batch and then refused it.
  questions: z.array(AskedQuestionSchema).min(1),
}).strict()
export type AskInput = z.infer<typeof AskInput>

/** One registered question, as every reader sees it: the worker's read-back, the board, and the card. */
export const RegisteredQuestionView = z.object({
  /** Minted by ntwine. The worker never chose it, which is why an answer RESTATES the question text —
   *  an id alone cannot be correlated back to what was asked. */
  id: z.string(),
  spec: AskedQuestionSchema,
  askedAt: z.string(),
  /** When ntwine will take the recommended option for the human (questionDefaultAtMs). Absent when it
   *  will not: the thread is still working, the question has nothing to take, it was typed past, or the
   *  human turned the default off with the countdown's ×. The card counts down to it. */
  defaultsAt: z.string().optional(),
  /** The label the default will pick, present beside `defaultsAt` only when it is NOT the recommended
   *  option — the recommendation acts outside this machine, so the default falls back (see
   *  recommendedDefaultAnswer) and the countdown names what it will actually take. */
  defaultsTo: z.string().optional(),
  /** A `secret` question only: the path its value will be served at. Known at registration, so the
   *  worker can prepare the command that reads it before the human has answered. */
  secretPath: z.string().optional(),
}).strict()
export type RegisteredQuestionView = z.infer<typeof RegisteredQuestionView>

/** HAS THE HUMAN TYPED TO THE WORKER SINCE THIS WAS ASKED? True when their newest TYPED turn landed
 *  after the ask (`lastHumanAt` is the tailer's clock for exactly that; ntwine's own wakes never move it,
 *  and neither does a delivery of answers). An unknown clock reads as "no".
 *
 *  It changes nothing about the question's lifecycle: a question stays open, and owed, until the human
 *  answers or dismisses it or the worker withdraws it with `unask`. The one reader is ntwine's default
 *  answer (scheduler evalQuestionDefaults, and the board's countdown), which never takes an option on a
 *  question the human has typed past: that one waits for the human, or for the worker's `unask`. */
export function questionRepliedPast(q: { asked_at: number }, lastHumanAt: string | undefined): boolean {
  if (!lastHumanAt) return false
  const human = Date.parse(lastHumanAt)
  return Number.isFinite(human) && Number.isFinite(q.asked_at) && human > q.asked_at
}

/** HOW LONG A RESTED THREAD WAITS ON AN UNANSWERED QUESTION BEFORE NTWINE TAKES THE WORKER'S RECOMMENDED
 *  OPTION FOR IT (2026-10-05). A long-running thread that asks and rests stalls on the human's clock: a
 *  wave-Z design thread sat for hours on a "narrow the error rule?" card whose recommended option the
 *  maintainer then picked anyway (maintainer: "it should have a timeout after which it selects
 *  recommended ... Maybe 10 minutes?"). The clock starts when the card can first be seen — the later of
 *  the ask and the rest that put it in the queue — so a question asked mid-turn does not
 *  expire before the thread has rested. Only questions with something to take qualify; see
 *  `recommendedDefaultAnswer`. */
export const QUESTION_DEFAULT_AFTER_MS = 10 * 60_000

/** How long a human's interaction with a card holds its default off. The card reports a pick, a toggle
 *  or a keystroke (holdQuestionDefault), and the deadline never lands sooner than this after the latest
 *  one — so a default cannot fire under someone halfway through answering, and still fires if they walk
 *  away from a half-staged card. */
export const QUESTION_DEFAULT_ENGAGED_GRACE_MS = 2 * 60_000

/** THE ONE READING OF WHEN A QUESTION DEFAULTS — the scheduler acts on it and the board counts down to
 *  it, so the two cannot disagree. Undefined while the thread is working (`restedMs` undefined), and for
 *  a question the human turned the default off on. Callers check `recommendedDefaultAnswer` and
 *  `questionRepliedPast` themselves. */
export function questionDefaultAtMs(
  q: { asked_at: number; engaged_at?: number | null; default_off?: number | null },
  restedMs: number | undefined,
): number | undefined {
  if (q.default_off || restedMs === undefined || !Number.isFinite(restedMs)) return undefined
  const base = Math.max(q.asked_at, restedMs) + QUESTION_DEFAULT_AFTER_MS
  return q.engaged_at != null ? Math.max(base, q.engaged_at + QUESTION_DEFAULT_ENGAGED_GRACE_MS) : base
}

/** The card's report on a question's default: `engage` when the human picks, toggles or types on it
 *  (pushes the deadline out by QUESTION_DEFAULT_ENGAGED_GRACE_MS), `cancel` when they press the
 *  countdown's × (the question waits for them for good). */
export const HoldQuestionDefaultInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
  action: z.enum(["engage", "cancel"]),
}).strict()
export type HoldQuestionDefaultInput = z.infer<typeof HoldQuestionDefaultInput>

export const HoldQuestionDefaultResult = z.object({ held: z.boolean() }).strict()
export type HoldQuestionDefaultResult = z.infer<typeof HoldQuestionDefaultResult>

/** The `text` an automatic answer carries beside its picked label — read by the worker in the answers
 *  wake and by the human on the settled card, so neither mistakes ntwine's default for the human's pick. */
export const DEFAULTED_ANSWER_NOTE = `No reply in ${QUESTION_DEFAULT_AFTER_MS / 60_000}m, so ntwine took the recommended option`

/** The `text` when the recommended option acts outside this machine, so the default took the first
 *  option that does not. The worker reads it as "the human never approved the external act" — the
 *  recommendation is still theirs to put to the human later, never something to do anyway. */
export const DEFAULTED_FALLBACK_NOTE = `No reply in ${QUESTION_DEFAULT_AFTER_MS / 60_000}m. The recommended option acts outside this machine, so ntwine took the first option that does not; the user has not approved the recommended one`

/** The option ntwine's default takes on one question node, or undefined when it takes none: the
 *  recommended option when it stays on this machine, else the FIRST option that does — the worker
 *  orders options by preference, so that is the least-blocking safe one. No recommendation, or every
 *  option `external`, takes nothing. */
function defaultOption(node: AskedQuestion): { option: AskedOption; fallback: boolean } | undefined {
  if (node.kind !== "question" || node.waitForHuman) return undefined
  const recommended = node.options?.find((o) => o.recommended)
  if (!recommended) return undefined
  if (!recommended.external) return { option: recommended, fallback: false }
  const safe = node.options?.find((o) => !o.external)
  return safe ? { option: safe, fallback: true } : undefined
}

/** The answer ntwine gives an unanswered question on the human's behalf, or undefined when it has none to
 *  give: a free-text or `multi` question (no single pick to take), one with no option marked
 *  `recommended`, a `danger` question — the irreversible call stays the human's however long it
 *  waits — one the worker did not mark `mayDefault` (follow-ups ride on the root's mark), and one whose every option is `external`. A recommendation marked `external` is never taken:
 *  the default falls back to the first option that stays on this machine (defaultOption). Follow-ups
 *  under the taken option follow the same rule, or go out with nothing chosen, the same shape the card
 *  sends for a live follow-up the human left blank. */
export function recommendedDefaultAnswer(questionId: string, spec: AskedQuestion): QuestionAnswer | undefined {
  if (spec.danger || !spec.mayDefault) return undefined
  const build = (node: AskedQuestion, root: boolean): QuestionAnswer | undefined => {
    const pick = defaultOption(node)
    const taken = pick?.option
    if (!taken && root) return undefined
    const followUps = (taken?.followUps ?? []).flatMap((child) => build(child, false) ?? [])
    return {
      questionId,
      question: node.question,
      chosen: taken ? [taken.label] : [],
      ...(root ? { text: pick?.fallback ? DEFAULTED_FALLBACK_NOTE : DEFAULTED_ANSWER_NOTE } : {}),
      ...(followUps.length > 0 ? { followUps } : {}),
    }
  }
  return build(spec, true)
}

/** A recommendation the worker did not opt into the default: the human must answer it, so it holds its
 *  siblings like a `danger` one. With no recommendation there is nothing to take either way. */
function holdsForHuman(spec: AskedQuestion): boolean {
  return spec.kind === "question" && !!spec.options?.some((o) => o.recommended) && !spec.mayDefault
}

/** ONE THREAD'S OPEN QUESTIONS DEFAULT TOGETHER OR NOT AT ALL (David 2026-10-08: "groups of questions
 *  should probably all be either default to recommended or blocked for human based on the most
 *  dangerous/in need of input … dismissing 10 … bubbles individually is painful"). The default exists
 *  for the human who is away; one who has to come back for any of them answers all of them. So any open
 *  question marked `danger`, a pickable one not marked `mayDefault`, or whose countdown the human turned off, holds every one,
 *  and the rest share ONE deadline — the latest of their own (questionDefaultAtMs) — so touching any
 *  card holds the group. A question with nothing to take (free text, `multi`, no recommendation) or one
 *  the human typed past simply waits for them without holding the others. The board's countdown and the
 *  scheduler both read this. */
export function threadQuestionDefaults(
  open: readonly { id: string; asked_at: number; engaged_at?: number | null; default_off?: number | null; spec: AskedQuestion }[],
  restedMs: number | undefined,
  lastHumanAt: string | undefined,
): { atMs: number; answers: Map<string, QuestionAnswer> } | undefined {
  if (open.some((q) => q.spec.danger || q.spec.waitForHuman || q.default_off || holdsForHuman(q.spec))) return undefined
  const answers = new Map<string, QuestionAnswer>()
  let atMs: number | undefined
  for (const q of open) {
    const due = questionDefaultAtMs(q, restedMs)
    if (due === undefined) return undefined
    atMs = Math.max(atMs ?? due, due)
    if (questionRepliedPast(q, lastHumanAt)) continue
    const answer = recommendedDefaultAnswer(q.id, q.spec)
    if (answer) answers.set(q.id, answer)
  }
  return atMs === undefined || answers.size === 0 ? undefined : { atMs, answers }
}

/** What a SECRET answer is stored and delivered as, in place of the value: where to read it, and the
 *  terms it is served on. It is the WORKER's text: the `secret` tool already handed it the recipe, so
 *  this stays short. Every card the human reads draws `SECRET_ANSWER_MASK` in its place. */
export function secretAnswerText(path: string): string {
  return `${SECRET_ANSWER_PREFIX}${quotePath(path)} — it can be read ONCE, within ${SECRET_TTL_MS / 60_000}m; never print it)`
}

const SECRET_ANSWER_PREFIX = "(secret ready at "

/** Whether a stored answer is a secret's delivery note rather than something the human typed. The note
 *  is for the WORKER; a card the human reads draws `SECRET_ANSWER_MASK` in its place. */
export function isSecretAnswerText(text: string): boolean {
  return text.startsWith(SECRET_ANSWER_PREFIX)
}

/** What every card draws for a sent secret: the masked field the human typed into, and nothing about
 *  where the value went (maintainer 2026-10-09: the path note on the card was "useless" commentary). */
export const SECRET_ANSWER_MASK = "••••••••••••"

/** How long a secret waits to be read before the server drops it (`secret-files.ts`). Here rather than
 *  beside the server, because the stored answer text names it to the worker. */
export const SECRET_TTL_MS = 15 * 60_000

/** POSIX single-quoting, so the path pastes into a command as-is. The macOS state dir is
 *  `~/Library/Application Support/…`, and an unquoted `$(cat <path>)` splits at the space. */
function quotePath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const AskResult = z.object({
  registered: z.array(RegisteredQuestionView),
  /** Everything still open on this thread afterwards, so a worker never needs a second call. */
  open: z.array(RegisteredQuestionView),
}).strict()
export type AskResult = z.infer<typeof AskResult>

export const UnaskInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type UnaskInput = z.infer<typeof UnaskInput>

export const UnaskResult = z.object({
  withdrawn: z.boolean(),
  open: z.array(RegisteredQuestionView),
}).strict()
export type UnaskResult = z.infer<typeof UnaskResult>

/** One question's answer, as the worker receives it.
 *
 *  IT RESTATES THE QUESTION. The worker never saw `questionId` — ntwine minted it at registration — so
 *  the id alone cannot be correlated back to anything the worker wrote. The text is what makes the
 *  payload readable on its own, and it is why this is not simply `{id: choice}`. */
export interface QuestionAnswer {
  questionId: string
  question: string
  /** The labels the human picked — one for a `question`, any number for a `multi`, none for free text. */
  chosen: string[]
  /** What they typed, when they typed instead of (or as well as) picking. */
  text?: string
  /** Answers to the follow-ups under the option they took. A branch NOT taken contributes nothing: the
   *  answered set plus the branch taken is the whole payload, so an absent follow-up means "not asked",
   *  never "asked and skipped". */
  followUps?: QuestionAnswer[]
  /** Left blank when the human pressed Send answers on the rest of its group: they are done with the
   *  group for now, so the question settles rather than holding the card open, and the worker may ask it
   *  again if it still matters (David 2026-10-08: "it should submit the answers you selected and follow
   *  up as needed at that point"). Unlike a dismissal, which says "decide it yourself". */
  skipped?: boolean
  /** The human CHANGED this answer after the worker already had the earlier one, so the delivery says it
   *  replaces it. Set by the server (answerQuestions), never by the card: only the server knows whether
   *  the earlier answer reached the worker. A change made before it did simply replaces it unmarked. */
  changed?: boolean
}

export const QuestionAnswerSchema: z.ZodType<QuestionAnswer> = z.lazy(() => z.object({
  questionId: z.string().min(1).max(64),
  question: z.string().min(1).max(4000),
  // No count cap: a `multi` may carry any number of options (see AskedQuestionSchema), and the human
  // may pick every one of them. The per-item cap is the option label's.
  chosen: z.array(z.string().max(400)),
  text: z.string().max(8000).optional(),
  followUps: z.array(QuestionAnswerSchema).optional(),
  skipped: z.boolean().optional(),
  changed: z.boolean().optional(),
}).strict())

export const AnswerQuestionsInput = z.object({
  slug: ThreadSlug,
  /** ONE QUESTION'S ANSWER, USUALLY — sent the moment that question is complete (a pick, an Enter in its
   *  own box, a multi's confirm), so the worker starts on it while the human is still reading the rest
   *  (David 2026-09-29: "the agent should receive the answer to one question at a time so it can
   *  start working"). Several when the human sends what they have staged on purpose, or when a typed reply
   *  carries the staged answers ahead of itself. The contract already requires the questions of one `ask`
   *  to be independent — dependent ones are `followUps` — which is what makes one answer actionable
   *  alone. Answers stored before the scheduler's next pass still reach the worker as ONE delivery,
   *  merged at claim (scheduler adoptCompanions, mergeAnswerMessages). */
  answers: z.array(QuestionAnswerSchema).min(1),
}).strict()
export type AnswerQuestionsInput = z.infer<typeof AnswerQuestionsInput>

export const AnswerQuestionsResult = z.object({
  /** The ids that were open and are now answered, or answered and now changed. An id that was dismissed
   *  or withdrawn is silently absent rather than an error: two browser tabs answering the same card is a race nobody should see. */
  answered: z.array(z.string()),
  open: z.array(RegisteredQuestionView),
}).strict()
export type AnswerQuestionsResult = z.infer<typeof AnswerQuestionsResult>

export const DismissQuestionsInput = z.object({
  slug: ThreadSlug,
  ids: z.array(z.string().min(1).max(64)).min(1),
}).strict()
export type DismissQuestionsInput = z.infer<typeof DismissQuestionsInput>

export const DismissQuestionsResult = z.object({
  dismissed: z.array(z.string()),
  open: z.array(RegisteredQuestionView),
}).strict()
export type DismissQuestionsResult = z.infer<typeof DismissQuestionsResult>

/** A registered question the human ANSWERED, with the answer — what the transcript draws in the slot the
 *  open card used to fill. An answered card used to vanish the moment it was sent, leaving the rest it
 *  was asked at with no trace of the ask; the maintainer wanted it to stay where it was, greyed out,
 *  showing only what was picked (2026-09-25). Read per thread, beside its transcript, rather than
 *  carried on the board: the board ships every thread on every keyframe, and a thread's whole answered
 *  history is dead weight to every surface but the one reading that thread. */
export const SettledQuestionView = z.object({
  id: z.string(),
  spec: AskedQuestionSchema,
  askedAt: z.string(),
  /** When the human sent the answer — what decides which rest the card stood at when it was answered. */
  settledAt: z.string(),
  answer: QuestionAnswerSchema,
}).strict()
export type SettledQuestionView = z.infer<typeof SettledQuestionView>

export const ThreadSettledQuestionsResult = z.object({
  questions: z.array(SettledQuestionView),
}).strict()
export type ThreadSettledQuestionsResult = z.infer<typeof ThreadSettledQuestionsResult>

/** THE HEADER OF THE ONE WIRE FORMAT AN ANSWER TRAVELS IN, and the reason it is declared in shared
 *  rather than beside either producer: two of them write this line — the fence path's `composeAnswerWire`
 *  in the browser and `questionAnswerMessage` below — and ONE parser in the chat reads it
 *  (`parseBuriedAnswersMessage`). A private copy in each of the three is three chances to drift, and the
 *  failure is silent: the message still delivers, it just stops being the human's answer on screen. */
export const BURIED_ANSWERS_HEADER = "Answers to earlier questions:"

/** THE FOLLOW-UP MARKER on an answer row — U+2937, the app's one "branches from its parent" glyph
 *  (`CHILD_ARROW` in the web's lib/childOps.ts, which every child surface shares; U+21B3 is banned there
 *  outright, and the two are six pixels apart on screen). Declared here because the SERVER writes it and
 *  the browser's parser reads it, so a literal on either side is a chance to drift. */
export const ANSWER_FOLLOW_UP_MARKER = "⤷"

/** A MULTI-LINE ANSWER'S CONTINUATION LINES ARE INDENTED on the wire — two spaces, the markdown list
 *  continuation — and the chat's parsers strip exactly that indent back off. The rows are numbered
 *  `N. …` lines and the human's typed text goes in RAW, so a typed answer that is itself a numbered
 *  list ("Do these:\n1. run x\n2. run y") used to FORGE two extra rows: the parser read every `N. `
 *  line as a row and the card drew three answers for one question (found 2026-09-23, sweeping after
 *  a multi-line QUESTION broke the same grammar). An indented line can never open a row, so the
 *  indent is what keeps the human's own text from being read as the wire's structure. Both writers —
 *  the browser's composeAnswerWire and questionAnswerMessage below — go through this, and a
 *  continuation written before the indent existed still parses: the parsers only strip an indent
 *  that is there. */
export const ANSWER_CONTINUATION_INDENT = "  "
export const indentAnswerContinuation = (text: string): string => text.replace(/\n/g, `\n${ANSWER_CONTINUATION_INDENT}`)

/** ONE PICKED OPTION PER LINE, as a checked task-list item, when an answer carries several picks or a
 *  pick and a note. They were joined onto one line until 2026-10-08 (`A, B, C — note`), which the
 *  Answers card could only print as a run-on paragraph — five long labels and the human's note fused
 *  into one wall of text, with nothing saying where a label ended (maintainer: "the answers block to a
 *  multiple selection question look like shit"). A comma cannot be split back out, since a label can
 *  hold one. The `- [x] ` line can: the card draws each as its own checked chip and the note below
 *  them (the web's `splitAnswerPicks`), and the worker reads a checked list as plainly as it read the
 *  commas. A lone pick with no note stays a bare label — a single-select's answer is exactly that. */
export const ANSWER_PICK_PREFIX = "- [x] "
export function answerPicksText(chosen: readonly string[], text: string | undefined): string {
  const note = text?.trim() ?? ""
  if (chosen.length === 0) return note
  if (chosen.length === 1 && !note) return chosen[0]
  return [chosen.map((label) => `${ANSWER_PICK_PREFIX}${label}`).join("\n"), note].filter(Boolean).join("\n\n")
}

/** What a DISMISSED question carries in place of an answer. One row like any other (see below), so it
 *  cannot be swallowed into the answer above it, and it tells the worker what to do with it. It is the
 *  WORKER's row only: the human's Answers card leaves it out (the web's `answersForDisplay`), because
 *  the × already said it and the row can arrive several rests after the click. */
export const DISMISSED_ANSWER = "(dismissed — decide it yourself; do not re-ask)"
/** A question the human left blank when they sent the rest of its group (QuestionAnswer `skipped`). */
export const SKIPPED_ANSWER = "(skipped for now — ask again if it still matters)"
/** Leads a row whose answer replaces one the worker already received (QuestionAnswer.changed). */
export const CHANGED_ANSWER = "(changed — replaces the earlier answer)"

/** A question the human waved away, as the answer message needs it: the TEXT, never the id. The worker
 *  never saw an id — ntwine minted it — so a list of ids names nothing it can act on. */
export interface QuestionDismissal {
  question: string
}

/** The answer as it reaches the worker — one message, composed here so the RPC, the delivery and any
 *  read-back cannot word it three ways.
 *
 *  IT IS THE HUMAN'S OWN TURN AND IT MUST READ AS ONE. The chat renders any user message in this wire
 *  form as the structured Answers card — each question restated above the chip carrying what was chosen
 *  or typed — and it checks for that form BEFORE it checks whether ntwine delivered the message, so
 *  matching the format is the whole of the attribution. Until 2026-08-27 this composed
 *  `Answers to the questions you registered:` over `- ` bullets, which matched no parser: a registered
 *  question's answer landed in the transcript as ntwine's own notification card, full of agent-facing
 *  prose, over the human's own words (maintainer: "Why did you regress how this looks when I answer a
 *  question? They used to look good. It just showed it, reiterated the question as well as my selected
 *  or typed answer", then, of the header: "Why would this show up in the UI?").
 *
 *  SO THE TREE IS FLATTENED — one numbered row per answered node, a follow-up marked `⤷` before its
 *  quote. Indenting a child under its parent is what the fence form does NOT support: the parser reads
 *  any line after a row that is not itself a row as a CONTINUATION of that row's answer, so an indented
 *  follow-up renders inside its parent's answer chip. The rows stay in tree order, so the shape is still
 *  legible; the marker is what says which is which.
 *
 *  A DISMISSAL RIDES ALONG rather than waking anybody. The human dismissing questions is almost always
 *  dismissing several in a row and is sitting right there, so each × marking the row and waking the
 *  worker would be a turn per click. They are told at the next wake, in this same message — as ROWS, for
 *  the same reason the follow-ups are: a trailing paragraph is swallowed into the last answer. */
export function questionAnswerMessage(answers: readonly QuestionAnswer[], dismissed: readonly QuestionDismissal[] = []): string {
  // NO ANSWERS AT ALL is its own message, not the answers one with an empty list. It reaches exactly one
  // thread: an AUTONOMOUS one, whose questions were cancelled wholesale when its Goal was armed and
  // which has no next steer for them to ride (scheduler.evalQuestionAnswers). Wording it as "answers"
  // would tell that worker the human replied, when the whole point is that nobody is going to. ntwine is
  // speaking here rather than the human, so the chat draws it as a hairline — see questionsCancelledWake.
  if (answers.length === 0) return questionsCancelledWakeMessage(dismissed.length)
  const rows: string[] = []
  const push = (a: QuestionAnswer, followUp: boolean): void => {
    const said = answerPicksText(a.chosen, a.text)
    const shown = said || (a.skipped ? SKIPPED_ANSWER : "(no answer)")
    rows.push(`${followUp ? `${ANSWER_FOLLOW_UP_MARKER} ` : ""}“${a.question}” → ${indentAnswerContinuation(a.changed ? `${CHANGED_ANSWER} ${shown}` : shown)}`)
    for (const child of a.followUps ?? []) push(child, true)
  }
  for (const a of answers) push(a, false)
  for (const d of dismissed) rows.push(`“${d.question}” → ${DISMISSED_ANSWER}`)
  return `${BURIED_ANSWERS_HEADER}\n${rows.map((row, i) => `${i + 1}. ${row}`).join("\n")}`
}

/** SEVERAL ANSWER DELIVERIES AS ONE — the outbox's merge for the one wake it cannot wrap (scheduler
 *  adoptCompanions). Every other merged wake goes out under a heading per part, but an answers message is
 *  the HUMAN'S OWN TURN in a shape the chat parses by position — the header first, and every line that
 *  is not a row read as the last row's continuation — so a heading, or a second header halfway down,
 *  would print ntwine's prose inside the human's answer chip. So the parts are folded into the one form:
 *  one header, every row renumbered in order. That is safe to do on the text because of the wire's own
 *  invariant (ANSWER_CONTINUATION_INDENT): a row is the only line that starts `N. ` at column 0, so a
 *  continuation can never be mistaken for one and renumbered.
 *
 *  Each part may carry its trailing clock line (the scheduler's withClock); it is dropped here and the
 *  caller stamps ONE. Undefined when any part is not an answers message — a cancellation wake is ntwine's
 *  own voice and never merges into the human's. */
export function mergeAnswerMessages(parts: readonly string[]): string | undefined {
  const lines: string[] = []
  const notes: string[] = []
  let rows = 0
  for (const part of parts) {
    // A note sent beside the answers (withAnswersNote) ends that part's rows, so it is lifted out and
    // every part's note goes under ONE note header after all the rows — left in place, it would sit
    // between two parts' rows and the next part's rows would read as the note.
    const { answers, note } = splitAnswersNote(stripWakeTimeHeader(part).trim())
    if (note) notes.push(note)
    const [header, ...body] = answers.split("\n")
    if (header !== BURIED_ANSWERS_HEADER) return undefined
    for (const line of body) {
      const row = /^\d+\. /.exec(line)
      lines.push(row ? `${++rows}. ${line.slice(row[0].length)}` : line)
    }
  }
  return rows === 0 ? undefined : withAnswersNote(`${BURIED_ANSWERS_HEADER}\n${lines.join("\n")}`, notes.join("\n\n"))
}

/** WHAT THE HUMAN TYPED BESIDE THEIR ANSWERS, in the same message. The prompt box's Send carries the
 *  staged answers and whatever is in the box as ONE turn (maintainer 2026-10-11: "It's very annoying to
 *  me that I can't send my answers and submit an additional steer at the same time, so we need to unify
 *  them"), and the answer wire has no place for free prose: its parsers fold any line after a row into
 *  that row's answer, so a note appended bare would render inside the last question's chip. This header
 *  on its own UNINDENTED line ends the rows — an answer's own continuation lines are indented
 *  (ANSWER_CONTINUATION_INDENT), so a typed answer can never forge it — and everything below it is the
 *  note, verbatim. One writer and one splitter, here, for the same reason BURIED_ANSWERS_HEADER is here:
 *  the browser composes the fenced form, the server the registered form, and the chat reads both. */
export const ANSWERS_NOTE_HEADER = "Sent with these answers:"
export function withAnswersNote(answersWire: string, note: string): string {
  const trimmed = note.trim()
  if (!answersWire) return trimmed
  return trimmed ? `${answersWire}\n\n${ANSWERS_NOTE_HEADER}\n${trimmed}` : answersWire
}
/** Split a user message into its answers wire and the note sent with it. A message with no note header
 *  comes back whole, as `answers`, whatever it is — the caller's own parser decides if it is one. */
export function splitAnswersNote(text: string): { answers: string; note: string } {
  const marker = `\n${ANSWERS_NOTE_HEADER}\n`
  const at = text.indexOf(marker)
  if (at < 0) return { answers: text, note: "" }
  return { answers: text.slice(0, at).trimEnd(), note: text.slice(at + marker.length).trim() }
}

/** THE ONE WAKE ON THIS PATH NTWINE WRITES IN ITS OWN VOICE, so it is the one the chat draws as a
 *  hairline instead of a card (NtwineWake's rule: ntwine's own news is a line, someone else's prose keeps
 *  the card). It says nobody is coming — the thread went autonomous while questions were still open, so
 *  they were cancelled wholesale and there is no next steer for them to ride. */
export function questionsCancelledWakeMessage(count: number): string {
  return (
    `${count} question${count === 1 ? "" : "s"} you registered ${count === 1 ? "was" : "were"} CANCELLED without an answer. ` +
    `Decide ${count === 1 ? "it" : "them"} yourself and carry on — say which way you went in your write-up. Do not re-ask.`
  )
}

const QUESTIONS_CANCELLED_WAKE = /^(\d+) questions? you registered (?:was|were) CANCELLED without an answer\./

/** The count, or undefined when this is not that message. Lives beside the producer for the reason every
 *  parser in this file does: a wording change on one that forgets the other puts agent-facing prose back
 *  in front of the human. */
export function parseQuestionsCancelledWake(text: string): { count: number } | undefined {
  const m = QUESTIONS_CANCELLED_WAKE.exec(text.trim())
  return m ? { count: Number(m[1]) } : undefined
}

/** The worker's own completion. `body` is the markdown the card renders — the same thing the ```done
 *  fence carried, minus the fence. */
export const MarkOwnDoneInput = z.object({
  slug: ThreadSlug,
  body: z.string().trim().min(1).max(20_000),
  // A SCHEDULED RUN's quiet finish (ARCHITECTURE.md § Scheduled threads): nothing for the human, so the thread
  // goes straight to Done instead of the queue and the body's first line becomes the run's history line.
  // Refused on any thread that is not a run of a schedule.
  quiet: z.boolean().optional(),
}).strict()
export type MarkOwnDoneInput = z.infer<typeof MarkOwnDoneInput>

/** What still holds the thread open, when something does. The call is REFUSED in that case and this is
 *  the refusal's material: the worker is told exactly what to resolve, by id, so it can act rather than
 *  guess. There is deliberately NO `force` flag anywhere in this contract — a bypass riding the gated
 *  call gets learned (the first refusal teaches it, it is then passed pre-emptively) and the gate
 *  degrades to a two-token tax. Any gate whose escape hatch is a parameter on the gated call is not a
 *  gate; the escape hatches here are `unask` and `unwatch`, which are the worker deciding on purpose. */
export const MarkOwnDoneResult = z.object({
  done: z.boolean(),
  /** Open questions, by id and question text. */
  blockingQuestions: z.array(z.object({ id: z.string(), question: z.string() }).strict()),
  /** Armed registrations, by id and what each names. Watches, PR watchers and timers alike. */
  blockingWatches: z.array(z.object({ id: z.string(), what: z.string() }).strict()),
}).strict()
export type MarkOwnDoneResult = z.infer<typeof MarkOwnDoneResult>

export const ListOwnPrWatchesInput = z.object({ slug: ThreadSlug }).strict()
export type ListOwnPrWatchesInput = z.infer<typeof ListOwnPrWatchesInput>

export const OwnPrWatchesResult = z.object({ watches: z.array(PrWatchView) }).strict()
export type OwnPrWatchesResult = z.infer<typeof OwnPrWatchesResult>

/** One armed (or just-settled) timer, as the worker's own tool reads it back. */
export const ThreadTimerView = z.object({
  id: z.string(),
  prompt: z.string(),
  /** The exact UTC instant it fires — the same string the delivered trailer names. */
  fireAt: z.string(),
  state: z.enum(["armed", "fired", "cancelled"]),
  createdAt: z.string(),
}).strict()
export type ThreadTimerView = z.infer<typeof ThreadTimerView>

// The signal fence on a thread's FINAL assistant message — the fence language IS the state, the
// body is the message. `done` = checked success card in the queue until the human Archives it (the
// fence itself MUTATES NOTHING — maintainer-settled); `awaiting` = a parked human/timer wait.
// Only excuses WHILE it is the final message — any newer activity clears it. ```question fences
// keep their own machinery (pendingQuestion / questionBlocks) and are NOT an excusal.
export const ThreadFence = z.object({
  kind: z.enum(["done", "awaiting"]),
  body: z.string(), // fence body minus hint lines, capped server-side; may be ""
  hints: z.array(AwaitingHint).default([]),
  // Present only on a completion the worker REGISTERED (`ntwinectl done`, board.registeredDoneFence)
  // rather than wrote as a ```done fence in its final message. The two are one fence to every predicate,
  // but the TRANSCRIPT draws a fence card from the message text it parses — so a registered done, which
  // is in no message, needs the client to know it must draw the card itself at the bottom of the thread
  // (maintainer 2026-08-27: a thread that signed off by tool rested with no card at all).
  registered: z.literal(true).optional(),
  // On a registered done only: the human has written since it was registered and the worker answered in
  // prose, so the done still stands (board.registeredDoneFence) but its ledger is old news. The client
  // draws the card without its body (web lib/registeredDone registeredDoneBody).
  spokenPast: z.literal(true).optional(),
})
export type ThreadFence = z.infer<typeof ThreadFence>

// ---- Subscription usage-limit pause (auto-resume) ------------------------------------------------
// Which metered subscription window the provider says is exhausted. "session" is the 5-hour rolling
// window (Claude's "You've hit your session limit"); "weekly" is the 7-day window; "model" is a
// MODEL-SCOPED weekly cap ("You've reached your Fable 5 limit. Switch to another model…", CLI
// ≥2.1.251 — the usage endpoint reports it as a `weekly-<model>` scoped window); "unknown" is a limit
// stop whose phrasing we could not attribute — never auto-resumed on a text-derived clock.
export const LimitWindow = z.enum(["session", "weekly", "model", "unknown"])
export type LimitWindow = z.infer<typeof LimitWindow>

// A thread whose turn was cut off mid-work by an exhausted subscription window, plus what ntwine will
// do about it. `resumesAt` is a unix-seconds instant resolved from the provider's own reset clock (or
// its usage endpoint) — absent when neither source could supply one, in which case `autoResume` is
// false and the thread stays a normal human handoff.
export const LimitPause = z.object({
  backend: Backend,
  window: LimitWindow,
  at: z.string(), // ISO8601 of the limit record — "when the agent got cut off"
  resumesAt: z.number().optional(), // unix seconds the window rolls
  // Whether ntwine intends to deliver its own "continue" once `resumesAt` passes. False when the
  // setting is off, the instant is unresolvable, or the pause is too old to safely resume.
  autoResume: z.boolean(),
})
export type LimitPause = z.infer<typeof LimitPause>

// Provider-authored failure data, never inferred from assistant prose. Unknown codes are retained so
// a new provider error cannot silently turn into an ordinary rest. Render the message as plain text.
export const ProviderError = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.string().optional(),
  retrying: z.boolean().optional(),
  at: z.string().optional(),
})
export type ProviderError = z.infer<typeof ProviderError>

// Saved destinations, not live work. They survive rests and never hold a thread open.
export const ThreadLinkView = z.object({
  id: z.string(),
  kind: z.enum(["link", "file"]),
  label: z.string(),
  target: z.string(),
}).strict()
export type ThreadLinkView = z.infer<typeof ThreadLinkView>

export const UpsertOwnLinkInput = z.object({
  slug: ThreadSlug,
  label: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
  target: z.string().trim().min(1).max(8192).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict()
export type UpsertOwnLinkInput = z.infer<typeof UpsertOwnLinkInput>
export const UpsertOwnLinkResult = z.object({ link: ThreadLinkView }).strict()
export type UpsertOwnLinkResult = z.infer<typeof UpsertOwnLinkResult>
export const DropOwnLinkInput = z.object({ slug: ThreadSlug, id: z.string().min(1) }).strict()
export type DropOwnLinkInput = z.infer<typeof DropOwnLinkInput>
export const DropOwnLinkResult = z.object({ dropped: z.boolean() }).strict()
export type DropOwnLinkResult = z.infer<typeof DropOwnLinkResult>

// A THREAD'S TERMINAL — a live pty the human opened on a thread, running in the folder that thread's
// agent works in (server thread-terminals.ts). It is not a thread: it has no row and no card of its own,
// and rides its parent's `ThreadView.terminals`. `id` is its /term/<id> handle. `runId` counts starts, so
// a restart is a NEW terminal to the browser (a fresh pty, a fresh screen) rather than more output on the
// old one. An exited run with no `exitCode` is one the server went away under (an ntwine restart takes its
// children with it) — shown as interrupted, never as a success.
export const ThreadTerminal = z.object({
  id: ThreadSlug,
  // The line it runs, or — for an interactive shell (`shell`) — the shell's name, which is what a
  // terminal tab calls one.
  command: z.string(),
  shell: z.boolean().optional(),
  // The folder it runs in: the project root, or the worktree the agent had moved into when it opened.
  cwd: z.string(),
  state: z.enum(["running", "exited"]),
  runId: z.number().int(),
  startedAt: z.string(),
  exitedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  // The human pressed Stop — the signal's code is theirs, not a failure.
  stopped: z.boolean().optional(),
  // A LIVE run that has gone quiet on an unterminated line — a password, OTP or [y/N] prompt. It queues
  // the terminal's THREAD (the terminal has no card of its own), and clears the moment it writes again.
  awaitingInput: z.boolean().optional(),
  // When it went quiet at that prompt — the queue entry's honest time.
  awaitingSince: z.string().optional(),
  // `cwd` lifted to its checkout, present only when that is not the project root (WorkCheckout) — the
  // same rule an agent's shell row follows, so the two kinds carry the folder hint on one condition.
  checkout: WorkCheckout.optional(),
  // `cwd` was read and is in the project's own checkout (BgShellView.atRoot): a terminal left in a
  // worktree that has since been removed has neither, and claims no place.
  atRoot: z.literal(true).optional(),
})
export type ThreadTerminal = z.infer<typeof ThreadTerminal>

// Open a terminal on a thread. No `command` ⇒ an interactive login shell. `cwd` absent ⇒ the thread's
// current working folder (threadWorkingDir); the drawer sends the one the human confirmed or edited.
export const TERMINAL_COMMAND_MAX_CHARS = 4_000
export const TerminalCommand = z.string().trim().min(1).max(TERMINAL_COMMAND_MAX_CHARS)
export const StartTerminalInput = z.object({
  slug: ThreadSlug,
  command: TerminalCommand.optional(),
  cwd: z.string().trim().min(1).max(4_096).optional(),
}).strict()
export type StartTerminalInput = z.infer<typeof StartTerminalInput>
export const TerminalInput = z.object({ id: ThreadSlug }).strict()
export type TerminalInput = z.infer<typeof TerminalInput>
// The terminal drawer's `$` line once a run finished: the terminal's next run, of a new line.
export const RunTerminalInput = z.object({ id: ThreadSlug, command: TerminalCommand }).strict()
export type RunTerminalInput = z.infer<typeof RunTerminalInput>
export const StartTerminalResult = z.object({ id: ThreadSlug }).strict()
export type StartTerminalResult = z.infer<typeof StartTerminalResult>
// Where a new terminal on this thread would start, and how that was worked out — the drawer's folder
// field opens on it. `source`: the agent's own latest reading (a Claude transcript's `cwd`, a Codex
// tool call's `workdir`), the session's recorded folder, or the project root when neither is known.
// `kind` says what that folder IS — the project root, a linked worktree, or somewhere else — so the dialog
// can say so. Optional, so a client older than it still parses the answer.
export const ThreadWorkingDir = z.object({
  dir: z.string(),
  source: z.enum(["transcript", "session", "project"]),
  kind: z.enum(["root", "worktree", "folder"]).optional(),
}).strict()
export type ThreadWorkingDir = z.infer<typeof ThreadWorkingDir>

// THE THREAD INFO VIEW (⋯ menu → Thread info): what a thread has consumed, read off its own transcript
// by server thread-stats.ts. Token buckets follow the API's accounting: `input` is fresh input only, and
// `cacheRead` / `cacheWrite` are the prompt prefix read back from or newly written to the cache, so a
// request's whole input is the three summed. Codex reports no cache writes; its `cacheWrite` stays 0.
export const ThreadTokenUsage = z.object({
  input: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
  output: z.number(),
}).strict()
export type ThreadTokenUsage = z.infer<typeof ThreadTokenUsage>

export const ThreadModelUsage = z.object({
  model: z.string(),
  requests: z.number(),
  tokens: ThreadTokenUsage,
}).strict()
export type ThreadModelUsage = z.infer<typeof ThreadModelUsage>

export const ThreadStats = z.object({
  backend: z.enum(["claude", "codex", "acp"]),
  // False when there is no transcript to read (an ACP thread, a session that never started): every
  // count below is then zero and means "unknown", not "none".
  recorded: z.boolean(),
  startedAt: z.string().optional(),
  lastActivityAt: z.string().optional(),
  // Times the agent was set going: a prompt, a follow-up, a wake. Tool results do not count.
  turns: z.number(),
  // Model requests, the unit the provider bills.
  requests: z.number(),
  toolCalls: z.number(),
  compactions: z.number(),
  subAgents: z.number(),
  // The thread's own requests, then its sub-agents' — kept apart so the cost of fanning out is visible.
  tokens: ThreadTokenUsage,
  subAgentTokens: ThreadTokenUsage,
  models: z.array(ThreadModelUsage),
  // Claude only: what Claude Code prices the session at, at API rates (on a subscription this is what
  // the work would have cost, not a charge). `partial`: the newest reading predates later requests,
  // so the true figure is higher.
  cost: z.object({ usd: z.number(), partial: z.boolean() }).strict().optional(),
}).strict()
export type ThreadStats = z.infer<typeof ThreadStats>

/** One spinoff edge as a thread sees it — either end. `childSlug` is null while the parent has not yet
 *  dispatched it. */
export const SpinoffView = z.object({
  id: z.string(),
  parentSlug: ThreadSlug,
  childSlug: ThreadSlug.nullable(),
  instructions: z.string(),
  createdAt: z.number(),
  // A CROSS-PROJECT spinoff (2026-09-30) names the project of whichever end is NOT the board's own, so a
  // link to it can go there. Absent for an end in this project — every same-project spinoff.
  parentProjectId: z.string().optional(),
  childProjectId: z.string().optional(),
}).strict()
export type SpinoffView = z.infer<typeof SpinoffView>

// One sidebar row: ntwine board thread + runtime overlay.
/**
 * The in-flight tool call a board row can name: the tool, the model's own one-line `description` (a
 * Bash call's), and the target the input reveals (a path, a pattern, a command's first line). A subset
 * of TranscriptToolCall, so the web labels it with the transcript's own `toolActivityLabel`.
 */
export const LiveTool = z.object({
  name: z.string(),
  desc: z.string().optional(),
  detail: z.string().optional(),
})
export type LiveTool = z.infer<typeof LiveTool>

export const ThreadView = z.object({
  id: ThreadSlug, // slug; filename is <slug>.md
  title: z.string(),
  status: NtwineStatus,
  statusText: z.string().optional(),
  // Form-constrained gerund label (≤100 chars, e.g. "Awaiting CI on PR #391") the worker maintains;
  // the listing row's at-a-glance gloss. Optional → absent on old threads renders nothing. Distinct
  // from statusText, which keeps its own surfaces (queue cards / board gloss).
  activity: z.string().optional(),
  next: z.string().optional(),
  // DERIVED (board shell-out, from the body): the thread keeps a `## Plan` section, i.e. it carries a
  // plan document → the sidebar renders a quiet PLAN badge. NOT a status and NOT a frontmatter flag
  // (that was deliberately rejected). Defaults false so an old snapshot / pre-restart server (which
  // omits it) parses.
  hasPlan: z.boolean().default(false),
  mechanism: BlockMechanism.nullable(), // set only when status=blocked
  humanBlocked: z.boolean(),
  ready: z.boolean(), // deps cleared, auto-fire candidate
  dependsOn: z.array(ThreadSlug),
  externalDeps: z.array(z.string()),
  owner: z.string().optional(),
  revalidate: z.string().optional(), // ISO8601
  agents: z.array(ThreadAgent),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // runtime overlay (from the UI server, not the .ntwine file)
  runtime: RuntimeState,
  sessionId: z.string().optional(),
  threadName: z.string().optional(),
  unread: z.boolean(),
  archived: z.boolean(), // user hid the row from the nav; respawn/resume un-archives
  lastAssistant: z.string().optional(), // trimmed preview of last assistant text
  // The FIRST non-empty line of that same text, markdown intact and newlines honoured (capped) — the
  // handoff's verdict line ("**Fixed** — …"), which `lastAssistant` cannot give back because its preview
  // collapses every newline to a space. The phone board's rested row reads it. Optional so old
  // snapshots parse.
  lastAssistantLine: z.string().optional(),
  // The newest tool call the agent has issued and not yet had a result for (Claude session threads),
  // in the shape `toolActivityLabel` reads, so a list row can say "Running the focused tests" with the
  // gerund the chat's working indicator shows. Absent between calls, at rest, and for other backends.
  liveTool: LiveTool.optional(),
  spawnedAt: z.string().optional(), // ISO8601
  lastActivityAt: z.string().optional(), // ISO8601, from jsonl tail — ANY record (incl. sub-agent/system)
  // ISO8601 of the agent's OWN last output (Claude: last assistant record; Codex: turn-end/final text).
  // This is the "rest time" — when the thread's own turn last came to rest — and UNLIKE lastActivityAt
  // it is NOT bumped by a background sub-agent's completion notification (a promptSource:system record).
  // The at-rest "Last active" label keys off this; the QUEUE orders by `queuedAt` instead, which equals
  // this for a plain rest. Optional so old snapshots parse; the client falls back to
  // lastActivityAt/spawnedAt when absent.
  lastAssistantAt: z.string().optional(),
  aiTitle: z.string().optional(), // Claude's own auto-generated session title (latest ai-title record)
  // The thread's live STATUS — a short phrase of what is happening NOW, rewritten at
  // every rest the conversation moved (server periodic-status.ts). Never the NAME: the name is one or two stable words for the
  // subject, and this is the part allowed to move. Shown beside the name on the queue card, in the
  // drawer header and in the rail row's tooltip — never as a second rail line, which would cost the rail
  // its density. Absent until the first one lands. Named `statusLine` because `status` above is the
  // legacy .ntwine-file lifecycle field, synthesized and unused for session rows; the registry column is
  // `session.status`.
  statusLine: z.string().optional(),
  // When `statusLine` last CHANGED (ISO) — the start of the task it names. While the thread is working
  // the status wears "for how long" off this (server live-status.ts); a write that keeps the text keeps it.
  statusSince: z.string().optional(),
  // True when `title` is a machine-guessed dispatch slug (title_auto=1), NOT a real name — the display
  // then shows a "Spinning up a thread…" placeholder instead of the guess until aiTitle lands. Optional
  // (absent ⇒ legacy/slim row) so old snapshots parse; absent is treated as "not provisional".
  titleAuto: z.boolean().optional(),
  // True when a HUMAN named this thread (rename / native /rename) and no
  // backend auto-title may replace it. FALSE is the interesting case: a title hard-coded by a dispatch
  // CALLER — `Investigate acme/app#391`, a parent agent's guess through spawn_thread — reads as a real
  // name (titleAuto false) yet still yields to the worker's own aiTitle, which is usually the more
  // informative one. Optional (absent ⇒ legacy/slim row): the display then derives it the pre-split way,
  // treating any non-guessed title as the human's. The server enforces this too by withholding aiTitle
  // from a locked row; the client keeps its own copy so a stale record can never win on either side.
  titleLocked: z.boolean().optional(),
  // True when the row carries a persisted NAME — a human's, a caller's dispatch title, or a machine name
  // that landed (server thread-names.ts `rowThreadName`). Only a name is shown as an `@handle`, and a
  // name never changes once shown (David 2026-09-30: "once someone sees the id, it cannot
  // change"), so while this is false `aiTitle` is the live session title and displays as plain text.
  // Optional (absent ⇒ legacy/slim row): the display then keeps the pre-2026-09-30 aiTitle-is-a-name rule.
  titleNamed: z.boolean().optional(),
  // The NAMES this thread has carried before its current one, oldest first (storage.ts
  // session_former_titles trigger). Prose written under an old name keeps linking: a worker told its
  // sub-agent is `@donePersistence.doneRepro` a second before it renamed the thread "Done reappears"
  // still wrote that address in every handoff after. Resolved only, never offered in the typeahead.
  formerTitles: z.array(z.string()).optional(),
  // Live background sub-agents the worker dispatched (tailer-derived). Defaults to [] so an old
  // snapshot/row (or a pre-restart server that doesn't emit the field yet) parses without breaking.
  subAgents: z.array(SubAgentView).default([]),
  // Live background SHELLS the worker launched (tailer-derived). Same default-[] discipline. Rendered
  // in the anchored background-ops strip alongside sub-agents; ids make current rows drillable.
  bgShells: z.array(BgShellView).default([]),
  // FINISHED agent terminals the strip still lists (EndedShellView). Optional for an older server.
  endedShells: z.array(EndedShellView).optional(),
  // WHERE THE AGENT IS WORKING, when that is not the project root: the newest folder its own transcript
  // names (a Claude record's `cwd`, a Codex tool call's `workdir`), lifted to its checkout. It flips the
  // moment an agent moves into a worktree, and it is where a terminal opened on the thread starts. Absent
  // ⇒ the root, or no reading — both draw nothing (see WorkCheckout).
  checkout: WorkCheckout.optional(),
  // Optional for snapshots from a server that predates link registration.
  links: z.array(ThreadLinkView).optional(),
  // SPINOFFS touching this thread, at either end: the ones it was asked for (parentSlug = this thread)
  // and the one it came from (childSlug = this thread). Optional for an older server.
  spinoffs: z.array(SpinoffView).optional(),
  // The thread's ARMED WATCHERS — registry-derived, not folded from the transcript, which is what makes
  // them survive the worker saying one more sentence. Same default-[] discipline as the two above.
  //
  // These NEVER park the thread: a row with an armed watcher stays a visible queue handoff, and Snooze
  // remains the only way to hide one (maintainer 2026-08-12, choosing this over auto-Held for every
  // kind). So this field is for the operator to SEE what a thread is waiting on — it deliberately feeds
  // no queue-membership rule.
  watches: z.array(ThreadWatchView).default([]),
  // A pending native AskUserQuestion the session is frozen on (tailer-derived). Optional — absent
  // when there's no unanswered ask. Feeds needsAction + the read-only question render + "Answer in Terminal".
  pendingAsk: PendingAsk.optional(),
  // Derived safety net (tailer): at rest with an unanswered ```question the worker asked in chat but
  // never encoded as blocked. Defaults false so old snapshots/rows parse. Feeds needsAction.
  pendingQuestion: z.boolean().default(false),
  // The worker's REGISTERED questions, still open (thread_question). Distinct from `pendingQuestion`
  // beside it, and the difference is the whole point of the registry: that boolean is recomputed from
  // the LATEST assistant text on every assistant record and cleared by any human turn, so it cannot
  // outlive the message that carried it. These rows can, and they carry the question itself rather than
  // merely asserting one exists — the card renders from this instead of re-parsing prose.
  questions: z.array(RegisteredQuestionView).default([]),
  /** The answer the human has already SENT that the worker has not received yet, as the exact message
   *  the delivery will carry (board.answersInFlight → questionAnswerMessage). The chat parses it with
   *  the same reader it uses on the delivered turn, so the in-flight card and the landed one are the
   *  same card and the swap is invisible. Absent whenever there is nothing in flight, which is almost
   *  always — it exists for the seconds between the human sending and the worker being handed it. */
  answersInFlight: z.string().optional(),
  /** The human's message — a follow-up or a registered answer — is on its way to the worker and the turn
   *  has not started yet (board.deriveDeliveryInFlight). The queue has already let the thread go; this
   *  tells the rail to draw it as working in every tab, not only the one that sent it (web
   *  lib/steering.ts). Absent otherwise. */
  deliveryInFlight: z.boolean().optional(),
  // ISO8601 of the newest REAL user interaction (answer/steer/dispatch) — the chronological listing
  // sort key. Optional; the listing falls back to spawnedAt when absent (a dispatch IS an interaction).
  lastUserAt: z.string().optional(),
  // Runtime provider-auth rejection (claude-auth plan): the session's provider positively rejected
  // its credential (Claude: synthetic isApiErrorMessage 401 record, or the 401/login text on a
  // boot-failed pane). Bounded by design — only the typed category travels, never raw provider/pane
  // text. Drives the trusted sign-in recovery card. Optional so old snapshots/servers parse.
  providerFault: z.object({
    backend: z.enum(["claude", "codex"]),
    category: z.enum(["authentication_required", "authentication_rejected"]),
  }).optional(),
  // The session's turn was cut off by an exhausted SUBSCRIPTION window. Distinct from providerFault:
  // the credential is fine, the account is simply out of quota until the window rolls, so the recovery
  // is to WAIT and continue — not to sign in. Same discipline as providerFault: only typed data
  // travels, never the provider's own error text. Optional so old snapshots/servers parse.
  limitPause: LimitPause.optional(),
  providerError: ProviderError.optional(),

  // ---- Session-first fields (ALL optional: absent ⇒ a legacy .ntwine-file row / pre-restart server;
  // the client treats such rows as Legacy-shelf material). Deliberately not zod-defaulted so server
  // constructors that predate the model still typecheck and old snapshots parse unchanged. ----
  // "session" = a session-backed thread (the working rail's unit); "legacy" (or absent) = a .ntwine
  // file row, rendered read-only in the collapsed Legacy shelf.
  // There is no third kind. Terminal COMMAND threads (`kind: "command"`, 2026-09-23) were rows of their
  // own until 2026-09-29; a terminal now belongs to a session thread (`terminals` below).
  kind: z.enum(["session", "legacy"]).optional(),
  // A HELD thread (server SessionRow.held_by): present ⇒ no agent has ever run for it, and it names who holds
  // it — `schedules` for a schedule's next run, or `lazy` on a row left from lazy threads. A message sent
  // to it starts it. Base never queues one.
  held: z.string().optional(),
  // A held thread's OPENING PROMPT as base keeps it (server SessionRow.lazy_prompt): a schedule's next run's
  // prompt, which the human may edit for that run alone, and for any other held thread the text it starts on.
  // Present exactly when `held` is.
  heldPrompt: z.string().optional(),
  // The SCHEDULE this thread is a run of (ARCHITECTURE.md § Scheduled threads) — what draws the repeat glyph and
  // its tooltip. `pending` marks the schedule's next run: a held row that sits in Snoozed with its wake
  // time until the scheduler starts it, even once that time has passed (isSnoozed). Absent on every other
  // thread, and on a run whose schedule has since been deleted.
  schedule: ThreadScheduleRef.optional(),
  // The terminals the human opened on this thread that are not yet filed away — running, or finished and
  // still worth reading. Absent ⇒ none. A terminal waiting at a prompt (`awaitingInput`) is what queues
  // this thread on its behalf (server board.ts withThreadTerminals).
  terminals: z.array(ThreadTerminal).optional(),
  // No registry row (a maintainer terminal discovered from the JSONL dir): read-only transcript,
  // no lifecycle verbs (no composer / kill / resume), never in Needs-you, no archive/seen state.
  foreign: z.boolean().optional(),
  // ui.db lifecycle for session threads (open|archived) — written ONLY by explicit Archive/Reopen.
  state: z.enum(["open", "archived"]).optional(),
  // Exact durable user snooze. While this instant is in the future, an otherwise-resting thread is
  // suppressed from Queue and shown dimmed in Held. Hard interactive gates (question, permission,
  // native approval, crash) deliberately break through it. Expired values are cleared server-side.
  snoozedUntil: SnoozeUntil.optional(),
  // The prompt this snooze will deliver at its deadline, when it carries one. Present ⇒ the wake is an
  // AUTO-bump (the scheduler resumes the agent with exactly this text) rather than a reminder, which is
  // the distinction the held row's tooltip renders. Absent ⇒ the card merely re-surfaces.
  snoozePrompt: z.string().optional(),
  // THE THREAD'S TIME LIMIT (deadline.ts): when it runs out, when it was set (the budget runs from
  // here) and by whom — only the human may move or clear one the human set, so the drawer offers its
  // controls on that basis. Absent ⇒ no limit. The card and the drawer count down from `at` and read
  // "over by …" past it; nothing is stopped there.
  deadline: ThreadDeadlineView.optional(),
  // The instant the human PINNED this thread (absent = not pinned). A pinned thread leaves the rail's
  // band system entirely — Rested/Active/Snoozed/Done — and holds the pinned band at the very top, in
  // this instant's order. Lifecycle metadata like the snooze: written only by the pin/unpin verb, and
  // it outranks every derived state (a pinned thread that finishes stays pinned).
  pinnedAt: z.string().optional(),
  /** The EVENT snooze on the resting card is armed for this exact rest — the human has said "hide this
   *  until something reports". Distinct from `snoozedUntil`, which is a wall-clock park on the whole
   *  thread: this one has no deadline and clears itself when the thread comes to a NEW rest.
   *
   *  It travels because the chat has to honour it too (2026-08-14). Until then only the QUEUE did, on
   *  the reasoning that the card states a FACT the drawer must keep showing or it blanks at rest and
   *  reads as "the agent died". That reasoning holds for a thread nobody has parked; once the human has
   *  explicitly parked THIS rest, showing them the same card with the same button one surface over is
   *  not information, and they said so. */
  bgSnoozed: z.boolean().optional(),
  /** The human snoozed this thread UNTIL ALL ITS SUB-AGENTS RETURN, and that snooze is what is keeping
   *  it out of the queue right now. Server truth (board.subAgentsSnoozeHolds): unlike `bgSnoozed` it
   *  survives the parent's intermediate rests — each child's return still wakes the parent, which runs
   *  and rests again without re-queueing — and it lets go when no direct sub-agent is running, when the
   *  human speaks to the thread, or earlier when something outranks it (a question, a crash, a done).
   *  Present only while it is the reason the thread is out of the queue; isSnoozed parks the row in
   *  Snoozed on it. */
  subAgentsSnoozed: z.boolean().optional(),
  /** Direct sub-agents that returned inside the wait still open — see ReturnedSubAgentView. */
  returnedSubAgents: z.array(ReturnedSubAgentView).optional(),
  // Which Claude transport serves this thread. "broker" — a session-broker-owned Agent SDK session with
  // a typed control channel — is the only one there is; ABSENT means a row dispatched before the broker
  // became the sole transport, which ntwine can no longer reach that way. Only the broker can be asked to
  // reload its plugin closure in place, so the board needs this to decide whether to offer that verb at
  // all rather than render a button that throws.
  claudeRuntime: z.literal("broker").optional(),
  // The thread's recurring prompt, when one has been written. Present with BOTH triggers false ⇒ the
  // text and the cadence are kept but nothing fires — that pair of falses IS the off state, which is
  // why there is no separate enable flag here to disagree with them.
  recurringPrompt: ThreadRecurringPrompt.optional(),
  // The signal fence on the final assistant message, present only while the thread is excused by it.
  lastFence: ThreadFence.optional(),
  // SERVER-DERIVED queue membership: explicit questions, checked/done handoffs, plus the process-level
  // blocks (perm-prompt / pendingAsk / crash) that a view can't clear. The client renders the
  // queue off this bit alone for session threads (legacy rows keep needsAction()).
  needsYou: z.boolean().optional(),
  // When this thread most recently ENTERED the queue (ISO), present exactly while `needsYou` is. The
  // queue's order key: a thread keeps it for as long as it stays queued and gets a fresh one each time
  // it re-enters, so a new arrival joins the BACK of the line. It is not the rest time — a thread that
  // rested behind a wait (CI, a sub-agent, a park, a snooze) enters when the wait lets go. See the
  // server's queue-clock.ts.
  queuedAt: z.string().optional(),
  // True while the server WITHHOLDS this thread's entry into the queue: a hold (a sub-agent, CI, a park)
  // has just let go and the wake that usually follows gets a few seconds to land (queue-clock.ts). The
  // thread reads `needsYou: false` meanwhile, but no hold stands any more — so nothing may read a park
  // into it (groups.isSnoozed), and its page keeps its handoff card.
  queueSettling: z.boolean().optional(),
  // True while the ONLY thing queuing this thread is a reply to the human they have not read: it is
  // parked on a wait it named, and once they have seen the reply it leaves the queue on its own. The
  // card says so and offers "Mark as read" (board.ts queuedForReply).
  queuedForReply: z.boolean().optional(),
  // True only for the crash/stall branch (pane exited while the transcript still says in-flight).
  // Once every ordinary rest also queues, runtime=exited + needsYou is no longer enough for clients
  // to distinguish a failed worker from a clean completed process.
  crashed: z.boolean().optional(),
  // The queued reason is "resting while its OWN background work (sub-agents / shells) is still live,
  // with no human ask": the agent came to rest awaiting results it dispatched, not awaiting the human.
  // The card renders the informational awaiting-background banner + an event-Snooze that hides it until
  // the work returns (the parent re-rests). True only when this is the SOLE queue reason (no question /
  // ask / native input / done fence outranks it) and no event-snooze is armed for the current rest.
  // Optional like needsYou/crashed: absent ⇒ a pre-restart server or a non-session row; the client
  // treats absence as false.
  awaitingBackground: z.boolean().optional(),
  // SERVER-DERIVED: which band a rest OUT OF THE QUEUE sits in (board.deriveWaitStatus, 2026-10-05).
  // `working` — the work it waits on finishes by itself, so it is Running and spins; `watching` —
  // something must happen outside the thread, so it is Snoozed and still. Present only for a thread at
  // rest behind a wait the server honoured with no queue card; absent everywhere else, including every
  // queued rest, which never spins. Absent from a pre-2026-10-05 server, which the client reads as the
  // old Running placement.
  waitStatus: z.enum(["working", "watching"]).optional(),
  // Exact typed-interaction presence for this CURRENT registered session. The board already derives
  // this from the scoped durable journal to compute needsYou; exposing the reason lets React avoid a
  // pendingInteractions RPC for every unrelated question/completion card. Optional preserves rolling
  // compatibility: a client paired with an older server treats absence as "unknown" and keeps the
  // previous query behavior, while a current server always emits true/false for owned session rows.
  pendingInteraction: z.boolean().optional(),
  // True only while a durable typed interaction still needs a USER decision. This is deliberately
  // distinct from pendingInteraction: after the human answers, provider delivery can remain queued or
  // sent (and therefore pending/readable) without remaining a hard gate that disables Snooze.
  // Optional keeps rolling client/server reloads compatible; current servers always emit the bit.
  actionableInteraction: z.boolean().optional(),
  // ISO8601 read/seen telemetry (threadSeen RPC — recorded when the human opens the thread). Kept for
  // compatibility and analytics only; viewing never acknowledges or removes a queue handoff.
  seenAt: z.string().optional(),
  // Which agent backend runs this thread (Codex-support epic, Phase 3) — drives the subtle per-row
  // rail badge. Optional so a legacy/foreign/pre-restart row parses; absent OR "claude" ⇒ no badge
  // (Claude is the unmarked default), "codex" ⇒ the small Codex badge.
  backend: Backend.optional(),
  // The backend-native permission/sandbox profile this session was launched (or explicitly
  // re-attached) with. Persisted per thread: never inferred from mutable Settings. Optional for
  // migrated/foreign sessions whose actual process mode is unknown.
  permissionMode: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // A durable requested mode that has not yet appeared in backend telemetry. The UI renders this as
  // pending beside permissionMode; it never replaces the observed value optimistically.
  permissionPending: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // Raw durable barrier bit. Unlike permissionPending this remains true for a future/corrupt value,
  // so rolling clients fail closed instead of enabling another composer while ownership is unknown.
  permissionChangePending: z.boolean().optional(),
  // The last DENIAL the worker's permission POLICY made for this thread (cc-worker/hooks/
  // perm-policy.mjs), and how many times it has denied. A refusal changes what the worker can do, so
  // it earns a card. Approvals and deferrals are deliberately absent: a deferral already shows as a
  // permission prompt / Needs you, and an approval blocks nobody — the quiet line that used to report
  // one stuck to the bottom of the thread forever, describing a command the reader had long moved past.
  permPolicy: z.object({
    decision: z.literal("deny"),
    rule: z.string(),
    reason: z.string(),
    tool: z.string().nullable(),
    at: z.string(),
    command: z.string().optional(),
  }).optional(),
  permDenies: z.number().optional(),
  // Atomic model+effort handoff state. The displayed model/effort remain the last committed launch
  // target until both pending values are attached and readiness-proven for a new generation.
  profilePendingModel: z.string().optional(),
  profilePendingEffort: z.string().optional(),
  profileChangePending: z.boolean().optional(),
  // One durable runtime-control owner serializes reattach/resume/native-composer mutations. Unknown
  // future owner values still disable the composer rather than being treated as idle.
  runtimeControlPending: z.boolean().optional(),
  // controlError is an actionable reason the controller failed closed (for example a busy thread).
  controlError: z.string().optional(),
  // The session's concrete model + reasoning effort: pinned launch metadata for new dispatches,
  // refined/backfilled from backend transcript telemetry where available (Claude records model;
  // Codex records both). Never derived from current Settings. Strings keep future backend-native
  // values forward-compatible; absent when neither durable source knows → the UI renders no guess.
  model: z.string().optional(),
  effort: z.string().optional(),
  // The Claude EDITION this thread's worker last ran ("Opus 5"), read off the model id on its own
  // transcript. It can be older than the edition the picker's row names ("Opus 5.5"): a worker keeps the
  // runtime it was started on, and a new pin only reaches the workers started after it. Emitted only when
  // that id belongs to the family `model` names, so a pending model switch never shows the old family's.
  runningModelLabel: z.string().optional(),
  // Present when the pinned runtime now resolves this thread's family to a NEWER edition than it runs.
  // `staged`: no live worker holds the old edition, so the next turn starts on `label` with nothing
  // further to do; otherwise the composer offers the upgrade, and the first message after the thread's
  // next compaction takes it on its own.
  modelUpgrade: z.object({ label: z.string(), staged: z.boolean() }).optional(),
  // How full the session's context window is right now — the header's fullness readout. BOTH halves
  // are provider-measured and the field is emitted ONLY when both are present, so a client never has
  // to decide what to do with half a fraction: absent ⇒ no reading, never a 0% dial. Codex reports
  // both on every `token_count`; a Claude row gets `tokens` from each assistant record's usage but
  // `window` only once its first broker turn has ended (and never at all for a foreign row, or one
  // dispatched before the broker became the only Claude transport).
  // `tokens` legitimately DROPS after a compaction — the context really did get smaller.
  context: z.object({ tokens: z.number(), window: z.number() }).optional(),
})
export type ThreadView = z.infer<typeof ThreadView>

/**
 * Whether a thread is IN THE QUEUE — the maintainer's "rested" band, the one with a card per row.
 *
 * ONE definition for both sides of the wire. `needsYou` is derived on the server (board.ts) and is
 * the queue; the two guards around it are display facts the server also enforces (it clears
 * `needsYou` on an archived row, and a foreign session never queues because its interaction surface
 * is the terminal the human is already sitting in). The web's sidebar and queue read it through
 * groups.ts `queued`; the server counts it per project for the rail's badges — and a badge that
 * disagreed with the rail it sits beside would be worse than no badge.
 */
export function queuedThread(t: Pick<ThreadView, "kind" | "foreign" | "needsYou" | "state">): boolean {
  return t.kind === "session" && t.foreign !== true && t.needsYou === true && t.state !== "archived"
}

/**
 * The reasons a queued thread must be seen AT ONCE, as one comparable string ("" when there are none) —
 * the server's hard gates: a terminal at a prompt, a request the human must answer, a question, a crash,
 * a limit pause. Registered questions by id, because a Codex worker can register one without moving its
 * rest. The queue clock reads it as a yes/no (never withhold an urgent entry); both needs-decision
 * notifiers — the server's (board.ts notifyNeedsYou) and the All queues page's for other projects
 * (web crossProjectNotify.ts) — compare the whole string, so a thread that comes back to the place and
 * rest it left with is news only if it came back with a reason it did not leave with.
 *
 * ONE definition for both notifiers (2026-09-30): the web kept a yes/no copy, so a thread resting on a
 * question that came back from a departure with that same question was silent on the server and
 * announced by the page — the disagreement the shared rule exists to remove.
 */
export function queueUrgency(t: ThreadView): string {
  const reasons: string[] = []
  if (t.terminals?.some((terminal) => terminal.awaitingInput === true)) reasons.push("terminal")
  if (t.actionableInteraction === true) reasons.push("interaction")
  if (t.runtime === "perm-prompt") reasons.push("perm-prompt")
  if (t.pendingAsk !== undefined) reasons.push("ask")
  if (t.pendingQuestion === true) reasons.push("question")
  for (const q of t.questions ?? []) reasons.push(`q:${q.id}`)
  if (t.crashed === true) reasons.push("crashed")
  if (t.limitPause !== undefined) reasons.push("limit")
  if (t.providerError !== undefined && t.providerError.retrying !== true) reasons.push("provider-error")
  return reasons.join(" ")
}

// ── THE SIDEBAR'S BANDS ────────────────────────────────────────────────────────────────────────────
// Moved here from web/src/groups.ts (which re-exports them) so the SERVER can count a project's Active
// band for the rail — the same reason `queuedThread` lives here: a rail badge that disagreed with the
// sidebar beside it would be worse than none. The vocabulary (Rested / Active / Snoozed / Done) is in
// groups.ts § SIDEBAR SECTIONS and ARCHITECTURE.md § Board nomenclature.

export type SectionKey = "active" | "snoozed" | "inactive"

// A session process is "at rest" (off-turn) when the pane is idle or the session has exited — the gate
// an awaiting excusal needs (a mid-turn worker is still working, never awaiting).
export function atRest(t: ThreadView): boolean {
  return t.runtime === "turn-idle" || t.runtime === "exited"
}

// DECLARED PARK: at rest behind an ```awaiting fence — the thread ITSELF declared it is parked, not
// still working. The current contract reserves this for a human gate/timer; legacy hints remain readable. The
// RAW signal; the banding below refines it into external-vs-internal. NB: this requires the worker to
// actually emit the fence — a thread that rests bare (prose only) reads as idle/waiting, not declared.
export function isDeclaredAwaiting(t: ThreadView): boolean {
  return atRest(t) && t.lastFence?.kind === "awaiting"
}

// INTERNAL WORK: a thread with a LIVE sub-agent is awaiting its OWN dispatched child — not an external
// event — so it is a fully ACTIVE thread and is not dimmed (maintainer 2026-07-10: "when an agent is
// merely awaiting its own sub-agents, we should NOT dim it — that's the differentiator"). The one
// exception is the worker's own word: a rest it called `watching` parks even with a child out, because
// that child is watching the world for it (watchingRest, 2026-10-05).
// Direct children only, matching the server's hasLiveBackgroundWork: `subAgents` also carries the live
// DESCENDANTS under those children so the rows can nest, and those are a rendering concern that must
// never move thread state (see isDirectSubAgent). A running descendant sits under a running direct child
// anyway, so the reading is unchanged — this keeps it that way by construction rather than by luck.
export function hasLiveSubAgents(t: ThreadView): boolean {
  return (t.subAgents ?? []).some((s) => isDirectSubAgent(s) && s.state === "running")
}

// A background Bash/Monitor does NOT make its thread live (maintainer 2026-07-22). `run_in_background`
// means only "don't block my turn": a vite dev server and a CI watcher are indistinguishable through
// it, and 26% of real background launches are long-lived servers that will never end. Treating them
// as live work spun a finished thread forever and kept it out of the queue. `bgShells` stays as
// transcript-level telemetry (the "background running" chip) — it just no longer speaks for the
// THREAD. A worker that genuinely wants to wait dispatches a sub-agent to own the wait.
//
// `awaitingBackground` is the ONE exception, and it is not `bgShells` by another name: it is SERVER
// truth (board.deriveAwaitingBackground) meaning "at rest, its own dispatched work is still live, and
// nothing harder outranks that". Reading it here is what keeps the bands honest for a thread with no
// queue card behind it — the server excuses a rest on a live SUB-AGENT from the queue (2026-07-30), so
// without this a live-but-cardless row would fall into the RESTED band, which is the queue-ordered band,
// with nothing behind it: the exact 2026-07-29 report, "showing up as a rested thread in my sidebar, yet
// there's no card for it". (That report was an EVENT-SNOOZED shell-only rest, which is cardless too; since
// 2026-08-28 that one parks in Snoozed instead — isSnoozed reads `bgSnoozed` ahead of this flag — so this
// flag no longer bands it. An UNsnoozed shell-only rest DOES card since 2026-08-04, and `needsYou` then
// bands it below the rule regardless — see inActiveBand. This flag decides nothing for it beyond keeping
// it out of Snoozed.)
//
// It does NOT re-spin finished threads. What the row reads as is a separate decision made downstream in
// sessionIndicatorKind, and a shell-only rest gets the quiet pulsing dot there, never the spinner — the
// 2026-07-22 worry (a dev server spinning its thread forever) is answered by the GLYPH.
//
// AND THE FLAG NO LONGER MEANS WHAT THE PARAGRAPH ABOVE SAYS, WHICH IS WHY THE TIMER CARVE-OUT EXISTS.
// `awaitingBackground` was "its own dispatched work is still live" when this read it, and the sentence
// that made that safe — deriveAwaitingBackground drops any fenced thread — stopped being true in three
// steps: a parked PR watch (2026-08-13), a declared background park, and an ARMED TIMER (2026-08-24,
// f50f9e60). The flag now means "at rest behind a declared wait the resting card should state", which
// includes a park with NOTHING running behind it at all. See parkedOnRegistrationAlone.
//
// A REST ITS WORKER CALLED `watching` HAS NO MOTION (2026-10-05), and that is the one reading that
// outranks the sub-agent line: the worker said the thread waits on something outside itself, and the
// board honoured it (deriveWaitStatus). A live child does not change that — the contract gives a long
// wait to a sub-agent, so the parent of a polling child is waiting on the world — and the child keeps
// its own spinner on its own row.
export function hasLiveOps(t: ThreadView): boolean {
  if (watchingRest(t)) return false
  if (hasLiveSubAgents(t)) return true
  return t.awaitingBackground === true && !parkedOnRegistrationAlone(t)
}

/** At rest on a wait its worker called `watching`, which the server honoured — so the thread is
 *  Snoozed, and nothing on its row moves (see ThreadView.waitStatus). */
export function watchingRest(t: Pick<ThreadView, "waitStatus" | "runtime">): boolean {
  return t.waitStatus === "watching" && t.runtime === "turn-idle"
}

// AN ARMED TIMER IS A PARK, NOT LIVE WORK — it is the archetypal Snoozed row, and it was the one park that
// could never reach the band. A `timers:` fence names a future wake and launches nothing, so when the
// server widened `awaitingBackground` to cover it (f50f9e60, so the resting card could state the wait),
// hasLiveOps read that through its old meaning and isSnoozed's very FIRST gate threw the thread into the
// Active band — the band ARCHITECTURE.md reserves for rows with no queue card and something in flight,
// against its own definition of Snoozed: "a declared `human:` gate, a valid future `timer:`, a user
// wall-clock snooze, or a limit pause ntwine will auto-resume". Reported 2026-08-26 on a thread parked on
// a Sept-2 timer: "showing up in a separate rail that isn't held".
//
// ALONE is the whole predicate. Anything else behind the same fence keeps the row visible and undimmed,
// exactly as it is today: a live child or shell is own work in flight (maintainer 2026-07-10, "when an
// agent is merely awaiting its own sub-agents, we should NOT dim it"), and a PR watcher is a handoff
// that must never vanish into the dimmed band (see parkedAwaitingHint, maintainer 2026-07-22). Reading
// raw `bgShells` is safe in that direction where it would not be in hasLiveOps: this is already gated on
// the server's own verdict and only ever keeps a thread OUT of Snoozed, so a stale shell costs a dimming,
// never a disappearance — the same argument restingOnLiveBackgroundWork makes below.
//
// A FENCED GITHUB PARK JOINS IT (2026-09-24). The server now excuses every honoured ```awaiting park from
// the queue, a registered PR included (board.hasHonouredPark) — a watcher wake the worker answers
// with "still waiting" was re-queuing a thread with nothing for the human to do. So `!needsYou` plus an
// awaiting fence plus an armed GitHub watch is that verdict, and the row parks like a timer. Two
// exceptions keep their old band: CI still RUNNING stays in Active under the spinning octocat
// (prChecksRunning, maintainer 2026-09-20), and a registered watch with NO fence still queues server-side,
// so `needsYou` keeps it out of here anyway.
export function parkedOnRegistrationAlone(t: ThreadView): boolean {
  if (t.awaitingBackground !== true) return false
  const watches = t.watches ?? []
  if (hasLiveSubAgents(t) || (t.bgShells ?? []).some((s) => s.state === "running")) return false
  const github = watches.some((w) => w.kind === "github" && w.state === "armed")
  if (github) return !t.needsYou && fenceNamesGithub(t) && !prChecksRunning(t)
  return watches.some((w) => w.kind === "timer" && w.state === "armed")
}

// The FENCE, not the registry: the server parks only on a `prs:` line it could honour, so a
// timer-only fence beside a registered watch is not the GitHub park.
function fenceNamesGithub(t: ThreadView): boolean {
  return t.lastFence?.kind === "awaiting" && t.lastFence.hints.some((h) => h.kind === "pr" && h.value.trim() !== "")
}

/** IS CI RUNNING ON A PULL REQUEST THIS THREAD WATCHES? The one reading of a PR wait that is MOTION —
 *  something is happening somewhere, and its finish is a wake ntwine delivers — as opposed to the settled
 *  readings (green, red, no checks, merged, closed, never polled), which are a handoff sitting on a
 *  human. It picks the rail's mark for the `pr` kind: the octocat inside the spinner while checks run,
 *  the static octocat once they settle (maintainer 2026-09-20: a PR wait "should just stay in the running
 *  rail if it's actively waiting on checks"). Lives here beside the band predicates, which read it (parkedOnRegistrationAlone); web/groups.ts
 *  re-exports it for the Sidebar arm and its tests.
 *
 *  GATED CI IS NOT RUNNING. Workflows held at GitHub's "Approve and run" gate read `checks: "running"`
 *  (nothing has settled), but nothing is moving either: a maintainer has to press a button. The PR row's
 *  own checks glyph already refuses to spin for that shape (AwaitingBackgroundCard ChecksGlyph), and the
 *  rail follows it — a spinner over a gate would promise motion for as long as nobody notices. */
export function prChecksRunning(t: Pick<ThreadView, "watches">): boolean {
  return (t.watches ?? []).some(
    (w) =>
      w.kind === "github" && w.state === "armed" && w.github?.checks === "running" && w.github.state === "open" &&
      !(w.github.running === 0 && (w.github.gated ?? 0) > 0),
  )
}


export function futureSnoozedUntil(
  t: Pick<ThreadView, "snoozedUntil">,
  nowMs = Date.now(),
): string | undefined {
  const at = Date.parse(t.snoozedUntil ?? "")
  return Number.isFinite(at) && at > nowMs ? t.snoozedUntil : undefined
}

// SNOOZED IS THE HUMAN'S BAND (2026-10-14). Only a park the human made folds a thread into it: a
// wall-clock snooze, the resting card's event-snoozes ("until new activity", "until all sub-agents
// return"), and a schedule's next run waiting to start. A worker's own park — `status: watching`, or any
// honoured ```awaiting wait — stays in Working, at rest under its wait's mark (agentParked), because the
// human may still consider that thread active (maintainer: "if I consider a thread to be active and an
// agent happens to be waiting for something, I still don't want to see it collapsed"). Until then a
// worker's park dimmed its row into Snoozed the same as the human's click did.
export function isSnoozed(t: ThreadView, nowMs = Date.now()): boolean {
  return parkOf(t, nowMs) === "human"
}

/** At rest on a wait its WORKER declared, which the server honoured — the park that sits in Working,
 *  undimmed, since Snoozed became the human's band. The rail draws it with its wait's mark. */
export function agentParked(t: ThreadView, nowMs = Date.now()): boolean {
  return parkOf(t, nowMs) === "agent"
}

// WHO PARKED THIS ROW, if anyone. One semantic predicate owns both classification and presentation. Only
// a valid FUTURE timestamp or a server-honoured declared wait is a park at all. Legacy automated waits
// (pr/ci/session), malformed/elapsed timers, and hintless fences are not — rested (in the queue) if their
// turn is over, Active if it isn't — so they cannot hide work an agent should own through an in-band
// watcher. A live child/Monitor wins unless the worker called the rest `watching`, and archived rows go
// Done.
function parkOf(t: ThreadView, nowMs: number): "human" | "agent" | undefined {
  const userSnooze = futureSnoozedUntil(t, nowMs) !== undefined
  if (t.state === "archived") return undefined
  // A SCHEDULE'S NEXT RUN is parked until the scheduler starts it — including the seconds after its wake
  // time passes and before the tick that starts it (a post-boot grace, the start cap). Reading its clock
  // here would drop it into Active for exactly that window (ARCHITECTURE.md § Scheduled threads).
  if (t.schedule?.pending === true && t.held !== undefined) return "human"
  // THE RESTING CARD'S EVENT-SNOOZE IS A PARK THE HUMAN MADE, and it parks into Snoozed exactly as the
  // wall-clock snooze does. It arrives as `bgSnoozed` (server truth: bg_snooze_rested_at equals the
  // current rest) on a thread resting behind a shell, a PR watch or a timer — the three shapes whose
  // queue card carries that snooze. Until 2026-08-28 the gate below read `hasLiveOps` alone, and that
  // predicate reads `awaitingBackground`, which the server keeps TRUE across the snooze (the flag states
  // what the thread waits on, and a snooze does not change that) — so the click took the card away and
  // left the row in the Active band, undimmed, wearing an at-rest mark. Reported on a thread parked on a
  // green PR (maintainer 2026-08-28: "It's resting and snoozed, and for some reason it's in the actively
  // running rail instead of a snoozed rail"). A live SUB-AGENT still wins, as it does over every park:
  // a child's return re-invokes the parent within seconds, so that row keeps spinning in Active
  // (maintainer 2026-07-10, "when an agent is merely awaiting its own sub-agents, we should NOT dim it")
  // — unless the worker itself called the rest `watching` (see hasLiveOps).
  const eventSnooze = t.bgSnoozed === true && t.runtime === "turn-idle"
  // "SNOOZE UNTIL ALL SUB-AGENTS RETURN" IS THE ONE PARK A LIVE SUB-AGENT DOES NOT OUTRANK, because the
  // live sub-agents are exactly what it parks on. The human looked at the card, saw children still out,
  // and chose to stop seeing the thread until they are all back; a row that spun in Active through each
  // intermediate return would undo that choice on the one surface still showing the thread. While the
  // parent is RUNNING a turn (a child's return woke it) it spins in Active like any snoozed row, and it
  // comes back here at its next rest. The server drops the flag the moment the snooze lets go.
  const subAgentsSnooze = t.subAgentsSnoozed === true && t.runtime === "turn-idle"
  const watching = watchingRest(t)
  if (!subAgentsSnooze && !watching && (hasLiveSubAgents(t) || (hasLiveOps(t) && !eventSnooze))) return undefined
  // A user-owned snooze deliberately wins over a concrete ask, permission prompt, or crash. Those
  // states still exist in the transcript/runtime and re-enter Queue at the exact wake deadline; the
  // snooze merely parks their presentation until then. Mid-turn work keeps spinning in the Active band,
  // while a provider permission prompt is itself parked and may therefore move to Snoozed.
  if (userSnooze) return t.runtime !== "running" && t.runtime !== "spawning" ? "human" : undefined
  // A LIMIT KILL OUTRANKS EVERY PARK BELOW (2026-08-31). The fault postdates any ```awaiting fence the
  // worker left at its LAST rest, so letting the declared wait below claim the row would park a killed
  // thread on a stale story. The server already queues it (needsYou, next line), but the mark and the
  // band must not hinge on that flag arriving: a limit-killed thread is never Snoozed unless the
  // OPERATOR snoozed it (userSnooze above, which wins by design). PRESENCE, not `autoResume`: a fault
  // ntwine cannot promise to resume (an unknown phrasing, an aged-out pause) is MORE the human's
  // problem, not less.
  if (t.limitPause && t.foreign !== true) return undefined
  // Without an explicit user snooze, higher-priority attention states render ?, !, or a native
  // prompt—not a wait glyph—so a stale awaiting fence cannot demote them out of Queue.
  if (t.needsYou || t.pendingAsk || t.runtime === "perm-prompt") return undefined
  // A WITHHELD ENTRY IS NOT A PARK. The server holds a thread out of the queue for a few seconds after a
  // hold lets go, while its wake lands (queue-clock.ts), and it reads `!needsYou` meanwhile — but the hold
  // has ENDED, so the inference below (an awaiting fence plus `!needsYou` means the park stood) would be
  // false, and the row would drop into Snoozed for those seconds on the way to Ready or back to Active.
  if (t.queueSettling) return undefined
  if (!atRest(t)) return undefined
  // (A limit pause used to return true here — "parked on the clock with a wake already armed" — until
  // 2026-08-31. It is now the hard NON-snooze gate above, and the queue's problem: see deriveNeedsYou.)
  // The event-snooze needs no fence behind it: a shell-only rest cards without one and its snooze is the
  // same click. It expires by itself at the thread's next rest, which is the wake the human asked for.
  if (eventSnooze || subAgentsSnooze) return "human"
  // THE WORKER'S OWN PARK (2026-10-05): `status: watching`, honoured by the server — "parked until
  // something wakes it", said by the one party that knows the wait is on the world. It needs no fence
  // check, because a registered watch with no fence is a park too.
  if (watching) return "agent"
  // THE SERVER ALREADY DECIDED THIS, and the client must not re-derive it. A park is honoured only when
  // every item the fence names is still live — checked against telemetry and the registries, which the
  // browser cannot see (board.hasDeclaredBackgroundPark). What reaches here is that verdict: the server
  // excuses an honoured park from the queue, so by this line `!t.needsYou` and `atRest(t)` already hold,
  // and an `awaiting` fence on top of them means the park was checked and stood.
  //
  // Reading the HINTS instead is what the deleted grammar did, and it is exactly why a worker could park
  // itself on `human: Alice` or an instant already in the past: the client believed the assertion.
  return t.lastFence?.kind === "awaiting" ? "agent" : undefined
}

// ACTIVELY RUNNING: a live session with work in flight — running/spawning, or turn-idle while a
// dispatched sub-agent is still going. NOT the same as the ACTIVE band, and the gap is the whole reason
// `inActiveBand` exists: this is true of a queued thread too, and a queued thread belongs to Rested no
// matter how much live work it has out. Read this as "has motion", and `inActiveBand` as "is Active".
// A running thread must NEVER be filed under Done, even when its row is archived (maintainer
// 2026-07-10, hit 3×: a bumped-then-resumed archived thread showed a spinner under the archived band).
export function isActivelyRunning(t: ThreadView): boolean {
  if (t.runtime === "running" || t.runtime === "spawning") return true
  return t.runtime === "turn-idle" && hasLiveOps(t)
}

export function sectionOf(t: ThreadView): SectionKey | null {
  // MAINTAINER 2026-07-09 (v2 sections): ONE section for open work — anything running, awaiting the
  // human, or machine-awaiting lands here (the split sections made seen-clearance visibly shuffle rows
  // between Needs-you and Working on click, which read as an unread feature). It is the Active AND
  // Rested bands together; the rule between them is drawn downstream (partitionActive), and the
  // needs-you/awaiting distinction renders as the row INDICATOR and the queue cards, not as sections.
  // Legacy (.ntwine-file) rows are HIDDEN entirely (null; not even a shelf). Foreign never rows.
  if (t.kind !== "session") return null
  // Archived → Done, UNLESS it's actively running: a live, in-flight session must never sit under Done
  // (upstream 2026-07-10, hit 3×). It shows in the Active band (labelled Running) with its spinner while it
  // works, and drops back to Done the moment it comes to rest still archived. The STATE never moves —
  // only the human reopens a thread (David 2026-09-24: "if something is marked as done ensure that the
  // agent doesn't unmark it as done that should only be reversible by human"), and a human bump does
  // that for real (server resume.ts `reopenArchivedThreadForFollowUp`). This is only where the row is
  // DRAWN while its worker drains a last turn or waits on a sub-agent it dispatched.
  //
  // From 2026-09-24 (da8ebaf1) to 2026-10-06 the fork filed such a row in Done whatever its worker was
  // doing, so the agent never appeared to unmark Done. But Done is collapsed by default, so a running
  // worker filed there was invisible — the exact failure the lift-back exists for, and a break of the
  // rule that each thread's rail is always in view (David 2026-10-06, adopting upstream's rule back). What
  // da8ebaf1 guarded against is answered inside the lift instead: the lifted row keeps its Done dim and
  // its uncheck box, which draws the spinner and reads "Done, still working" (doneButRunning), so it
  // says both that the human filed it and that the worker is still finishing.
  if (t.state === "archived" && !isActivelyRunning(t)) return "inactive"
  // Only truthful human/future-timer waiters split into the labeled, dimmed Snoozed band. Everything else
  // open — running, needs-you, bare rest, done-fenced, awaiting-its-own-subs, or an awaiting
  // `session`/hintless wait — belongs to the Active/Rested section, which band decided downstream.
  if (isSnoozed(t)) return "snoozed"
  return "active"
}

// THE RULE THE CUE IS DRAWN ON: a row belongs above it EXACTLY WHEN it has a queue card. Everything
// else in this section — spinning or not — belongs below, in the Active band.
//
// THE INVARIANT, both directions (maintainer 2026-08-01: "if something is listed as currently running,
// then it should never show up in the queue"): nothing in this band has a card, and every card has a row
// in the cue above the rule. `needsYou` IS the queue (see `queued`, which within this section reduces to
// exactly this field — foreign rows never section, and the server clears needsYou on an archived row),
// so keying the split on it alone is what makes both halves true by construction rather than by every
// upstream excusal remembering to band its own threads.
//
// It used to read `isActivelyRunning(t) && t.needsYou !== true`, which enforced only the first half. The
// second half was left to the SERVER: a thread it excused from the queue was expected to be either Snoozed
// or visibly alive (`awaitingBackground`, which is what puts a shell-only or CI-holding rest in this
// band). Every excusal that forgot dropped its thread into the cue with nothing behind it — a row that
// looks queued, has no card, and opens a DRAWER on click instead of scrolling to one. Reported
// 2026-07-29 on a snoozed shell-only rest ("there's no card for it in the UI — when I click it, it opens
// it in a drawer") and again 2026-08-14 on a stale delivery ledger, which is a queue excusal with no
// banding of its own at all (board.ts hasFreshDelivery). Two different upstream bugs, one symptom,
// because the rule the maintainer actually reads the rail by was never written down here.
//
// A cardless row below the rule states the truth in every case that reaches it: the human has nothing to
// answer, and something — a child, a shell, CI, a follow-up in flight — is between this thread and its
// next rest. It wears its own at-rest mark there (sessionIndicatorKind), so it never fakes a spinner.
export function inActiveBand(t: ThreadView): boolean {
  return t.needsYou !== true
}

/**
 * A row of the maintainer's ACTIVE band — open, not Snoozed, not Done, and holding no queue card.
 *
 * The rail's running count: the rows the sidebar draws below the rule, with their spinners. Unlike
 * the sidebar it ignores a pin — a pin moves a row to the top of ONE project's sidebar, and says
 * nothing about whether that project has work in flight.
 */
export function activeBandThread(t: ThreadView): boolean {
  if (t.kind !== "session" || t.foreign === true) return false
  return sectionOf(t) === "active" && inActiveBand(t)
}

/**
 * DONE, AND STILL MOVING — a thread the human marked done whose session is actively running anyway: a
 * turn still draining, a sub-agent it dispatched still out.
 *
 * Its row lifts back into the Active band (Running) while it moves (sectionOf, upstream 2026-07-10), and
 * its STATE stays archived, because only the human reopens a thread (David 2026-09-24). This predicate is
 * the "finishing" mark that says both: the row keeps the Done dim and its uncheck box, and the box draws
 * the spinner (web groups.ts sessionIndicatorKind, Sidebar RowUncheckDone — "Done, still working").
 */
export function doneButRunning(t: ThreadView): boolean {
  return t.kind === "session" && t.foreign !== true && t.state === "archived" && isActivelyRunning(t)
}

/**
 * The rail badge's RUNNING count: every Active-band row. A Done row still moving (doneButRunning) is one
 * of them, because sectionOf lifts it into Active while it moves; from 2026-09-24 to 2026-10-06, while
 * Done held such rows in place, this had to add them on its own or a project whose only live work was
 * marked done read as idle from the rail. The OR is kept as a belt: it counts such a row even if it
 * reached the client still carrying \`needsYou\` (the server clears that on archive, but the count should
 * not hinge on it).
 */
export function workingThread(t: ThreadView): boolean {
  return activeBandThread(t) || doneButRunning(t)
}

// Moved here from web/src/groups.ts (which re-exports it) on 2026-09-30 so the SERVER can count a
// project's asks for the phone's projects list with the rule the board's "N need you" uses.
// A thread "needs action" when it is genuinely waiting on the human — and ONLY once the agent has
// actually come to rest on that wait. A mid-turn thread is still working; surfacing it as a card
// gives an empty "no ask" card because the ask text lands only when the turn ends. These sort to top.
export function needsAction(t: ThreadView): boolean {
  // A TERMINAL thread (done/dismissed) NEVER cards — no exceptions. The thread file is the source
  // of truth, and a thread whose own status says the work is over has by definition nothing waiting
  // on the human. (An earlier "done-but-unread = card until acknowledged" rule violated this and
  // was explicitly overruled by the maintainer: a done thread must never appear in the queue.)
  if (t.status === "done" || t.status === "dismissed") return false
  // THE OPERATOR'S OWN PARK COMES FIRST, exactly as the server orders it (deriveNeedsYou checks
  // futureSnooze ahead of every ask gate). Without it this predicate promoted rows the server had
  // already dequeued — a snoozed thread with an unanswered ask sorted to the top of the attention order
  // and led the mobile asks-first list, with no card behind it to open. Same pair of guards as
  // sessionIndicatorKind, for the same reasons.
  if (futureSnoozedUntil(t) !== undefined && isSnoozed(t)) return false
  // Paused on an interactive permission prompt: the process is parked waiting on the human's answer.
  if (t.runtime === "perm-prompt") return true
  // Frozen at a native AskUserQuestion TUI dialog (safety net for pre-contract / external sessions that
  // bypass the thread-file ask channel). Unlike the chat/needs-human nets below, NO rest-gate: the ask
  // text lives in the tool_use input (tailer-captured) and is available even while the turn reads
  // "running" (the session is blocked mid-tool_use), so it should card the moment it appears.
  if (t.pendingAsk) return true
  // The DECLARED awaiting-you channel: humanBlocked is re-derived server-side from `status:
  // needs-human` — the first-class "awaiting a human" state and THE queue definition. TWO gates:
  //   • NOT mid-turn (running/spawning): the worker writes needs-human MID-TURN (~150ms after the
  //     file hits disk), but the visible ask text lands with the final message only when the turn
  //     comes to rest — counting it early yields a card with no visible ask.
  //   • A SESSION EXISTS (runtime !== "none"): the queue is strictly "agent work paused on the
  //     human" (maintainer, 2026-07-09: with no agent it makes no sense for a thread to ever show
  //     up inside the queue). A needs-human thread worked OUTSIDE ntwine (ntwine classic, hand
  //     edits) has no transcript to card — it stays visible in the SIDEBAR (yellow awaiting-you
  //     dot), and its click-through composite (doc + kick-off composer) is where it gets read and
  //     acted on. `exited` still cards: that agent RAN and asked here — the ask is in its transcript.
  if (t.humanBlocked && t.runtime !== "none" && t.runtime !== "running" && t.runtime !== "spawning") return true
  // DERIVED safety net behind the declared needs-human channel: a worker that asked the human a
  // question IN CHAT (a ```question block in its final message) but never flipped its thread file to
  // needs-human — the board would otherwise see {active, humanBlocked:false, turn-idle} and show
  // nothing. Same rest-gate: only once the agent is off-turn (else the ask text hasn't landed).
  if (t.pendingQuestion && t.runtime !== "running" && t.runtime !== "spawning") return true
  // A REGISTERED question (open thread_question rows on the view) is the same ask through the durable
  // channel — the server queues it once at rest (deriveNeedsYou's openQuestions), and this predicate
  // must agree so the mobile asks-first ordering and the attention sort count it. Same rest-gate as the
  // fence net above: the worker keeps working after registering, and the card lands at its rest. Every
  // open one: a question stays the human's until it is answered, dismissed or withdrawn.
  if ((t.questions?.length ?? 0) > 0 && t.runtime !== "running" && t.runtime !== "spawning") return true
  // CRASH / STALL net (replaces the old `unread`-gated clause — `unread` no longer drives anything).
  // A thread whose status still claims WORK IN FLIGHT (active or planning) but whose backing agent
  // PROCESS is gone — `exited` (session row present, worker process dead) or `none` (registry lost the row)
  // — is a crash/stall the human must see. Deliberately SCOPED to the in-flight work statuses, because
  // "an agent died MID-WORK" is exactly active/planning:
  //   • `blocked` is a MACHINE-wait — its agent is LEGITIMATELY absent (waiting on revalidate_at /
  //     blocking_threads), and a killed/rebooted session (the workers die → every spawned thread goes
  //     exited/none) must NOT card it or steal its timer/threads glyph (Nav short-circuits on
  //     needsAction before those glyphs). blocked never cards — that's the spec.
  //   • `needs-human` with a session already cards via the humanBlocked clause above (session-less
  //     needs-human deliberately does NOT card — see that clause); `done`/`dismissed` are excluded
  //     by the terminal guard; `planned` is not-yet-started backlog.
  // No fight with the humanBlocked clause: this net requires status active/planning, which
  // needs-human never is; and its `none` case requires spawnedAt (a session RAN then vanished from
  // the registry — a real crash), which a never-spawned thread lacks.
  // Also gated on `spawnedAt` (a NEVER-spawned item never "died mid-work") and `!archived` (a hidden
  // thread never cards, even if its archive→done write lost a race).
  if (
    (t.status === "active" || t.status === "planning") &&
    (t.runtime === "exited" || t.runtime === "none") &&
    t.spawnedAt &&
    !t.archived
  )
    return true
  return false
}

/**
 * An ASK on the board: a queue row (the Rested/Active section, or the pinned shelf the phone folds into
 * the top of it) that is waiting on the human by `needsAction`. The phone board's "N need you" and the
 * phone projects list's accent count are both this, so the two cannot disagree. Narrower than
 * `queuedThread`, which also counts a rested handoff that asks nothing.
 */
export function boardAskThread(t: ThreadView): boolean {
  if (t.kind === "session" && t.foreign === true) return false
  const pinned = t.kind === "session" && typeof t.pinnedAt === "string"
  return (pinned || sectionOf(t) === "active") && needsAction(t)
}

// STRUCTURED board error — a machine-readable companion to the legacy `errors: string[]` so the
// client can tell a REPAIRABLE error from an inert one and which file it names. `no-frontmatter` is
// the one-click-repairable case (a thread .md written with no YAML frontmatter, invisible to the
// queue/status system until healed); everything else is `other` (a dangling dep, a bad status, a
// board-read failure) and renders as today with no repair affordance. Additive: the legacy string
// array is untouched, this is a PARALLEL field. `file` is the .md basename (or "" for a board-level
// failure with no single file).
export const BoardErrorItem = z.object({
  file: z.string(),
  kind: z.enum(["no-frontmatter", "other"]),
  message: z.string(),
})
export type BoardErrorItem = z.infer<typeof BoardErrorItem>

export const BoardSnapshot = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(), // "owner/repo" from the git origin remote; falls back to projectName
  // "owner/repo" ONLY when that origin remote is github.com — the link target the rendered-markdown
  // autolinker turns `#123` and a bare commit hash into. Deliberately NOT projectLabel, which is a
  // host-agnostic DISPLAY name: a GitLab origin yields an owner/repo there too, and pointing its `#12`
  // at github.com would be a wrong destination rather than a missing one. Absent means the
  // augmentation stays off (no remote, another forge, or a pre-restart server).
  githubRepo: z.string().optional(),
  // This project's URL slug — the `<slug>` in `/project/<slug>`. The client cannot derive it: a
  // PREFIXED page reads it off its own path, but the LAUNCHING project is served unprefixed and so has
  // nothing to read, which left `/` — the all-projects GRID — as the only URL its queue could name.
  // Optional so a pre-restart server keeps working; absent means "fall back to `/`", i.e. the old
  // behaviour. Registry-derived, so it is the same slug every other surface links to.
  projectSlug: z.string().optional(),
  // The server's home directory — the expansion of a `~` a worker wrote in prose. Agents reference
  // files that way constantly (`~/.claude/CLAUDE.md`), and the browser has no way to derive it, so a
  // `~`-anchored Markdown link had no absolute path to become and stayed a same-origin anchor that
  // navigated out of ntwine. The client only ever uses it to build a path it then hands BACK to the
  // server, which realpath-gates it exactly as it gates one the author typed in full. Optional so a
  // pre-restart server keeps working; absent means `~` links stay unresolved, i.e. the old behaviour.
  homeDir: z.string().optional(),
  // (No `.ntwine/ exists` bit here on purpose. Threads are session-first — the ui.db registry IS the
  // board — so `.ntwine/` presence says nothing about whether this project has one. Its only consumer
  // was a shell gate that dead-ended `.ntwine`-less repos; the server still probes the directory
  // locally where it genuinely matters, for scratchpad storage.)
  threads: z.array(ThreadView),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem). Optional so a pre-restart server / old
  // snapshot that omits it still parses; the client treats absent as "no structured errors" and
  // falls back to rendering the plain `errors` strings.
  errorItems: z.array(BoardErrorItem).optional(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshot>

// ---- Provider quota (subscription rate-limit windows) ----
// A single usage window for a provider's plan — the 5-hour rolling window or the weekly window that
// Claude/Codex subscriptions meter against. `usedPercent` is 0..100 (how much of the window is spent,
// so remaining = 100 - usedPercent); `resetsAt` is a unix-seconds instant the window rolls over.
export const QuotaWindow = z.object({
  key: z.string(), // stable id: "5h" | "weekly" (provider-neutral)
  label: z.string(), // short human label for the chip ("5h", "Weekly") — house duration grammar
  usedPercent: z.number(), // 0..100
  resetsAt: z.number().optional(), // unix seconds; absent when the source doesn't report it
})
export type QuotaWindow = z.infer<typeof QuotaWindow>

// One provider's quota. `status: "ok"` carries live windows; "unavailable" means we could not read it
// (no recent session, endpoint unreachable, not logged in) and the UI shows a neutral dash + `detail`.
export const ProviderQuota = z.object({
  status: z.enum(["ok", "unavailable"]),
  planType: z.string().optional(), // "pro" / "max" / etc. when the source reports it
  windows: z.array(QuotaWindow),
  detail: z.string().optional(), // why unavailable, or an extra note
})
export type ProviderQuota = z.infer<typeof ProviderQuota>

// The polled quota snapshot the sidebar status bar renders — one entry per agent backend.
export const QuotaSnapshot = z.object({
  claude: ProviderQuota,
  codex: ProviderQuota,
})
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>

// ---- Provider auth (local credential presence) ----
// Whether a provider's LOCAL credential exists — the signal the new-thread dispatch gate keys on.
// DISTINCT from quota's "unavailable": that is overloaded with transient endpoint failures, whereas
// this reports credential presence only. "signed-out" = we positively found no credential; "unknown" =
// we couldn't determine it (read error). The gate BLOCKS on "signed-out" and FAILS OPEN on "unknown".
export const ProviderAuth = z.enum(["authed", "signed-out", "unknown"])
export type ProviderAuth = z.infer<typeof ProviderAuth>

// WHICH account each credential belongs to — the email the provider's own on-disk account record
// carries. Purely informational (the quota popover answers "signed in as who?"); nothing gates on it,
// so every field is optional and an unreadable record simply yields nothing rather than an error.
// Deliberately a SIBLING of the per-provider auth verdicts rather than nested with them: the gate's
// shape (`snapshot[backend] === "signed-out"`) is load-bearing in dispatch and must not move.
export const AccountEmails = z.object({
  claude: z.string().max(320).optional(),
  codex: z.string().max(320).optional(),
})
export type AccountEmails = z.infer<typeof AccountEmails>

// The per-provider auth snapshot the new-thread gate reads — one entry per agent backend.
export const AuthSnapshot = z.object({
  claude: ProviderAuth,
  codex: ProviderAuth,
  emails: AccountEmails,
})
// The backends that HAVE an account ntwine can read and act on. An ACP agent's credentials belong to the
// agent's own CLI (plans/acp-backend.md, decision 5): ntwine never reads, refreshes or revokes them.
export const AccountBackend = z.enum(["claude", "codex"])
export type AccountBackend = z.infer<typeof AccountBackend>
export const AccountLogoutInput = z.object({ backend: AccountBackend }).strict()
export type AccountLogoutInput = z.infer<typeof AccountLogoutInput>
// Result of the typed provider logout action. "blocked" = refused because the provider had live
// turns (account state is process-global; changing it mid-request produces ambiguous failures);
// "failed" = the CLI errored AND the credential still reads present. `auth` is the post-attempt
// credential state so the client can refresh its snapshot without another round-trip.
export const AccountLogoutResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  auth: ProviderAuth,
  activeThreads: z.number().int().positive().optional(),
  detail: z.string().max(200).optional(),
})
export type AccountLogoutResult = z.infer<typeof AccountLogoutResult>
export type AuthSnapshot = z.infer<typeof AuthSnapshot>

// ---- Settings ----

export const PermissionMode = z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

// Where a vetted local artifact link opens. This is intentionally a server-owned setting: the
// browser never gets permission to navigate to file:// or choose an arbitrary executable. `editor` is
// the SERVER's own `$VISUAL`/`$EDITOR`, read from the environment ntwine was started in — the browser
// still names no executable, it only picks "whatever this machine's shell already says".
export const LocalFileOpener = z.enum(["system", "cursor", "vscode", "editor", "finder", "copy"])
export type LocalFileOpener = z.infer<typeof LocalFileOpener>

export const Settings = z.object({
  // The mode NEW Claude workers launch in. Settings surfaces exactly two of them — `bypassPermissions`
  // (--dangerously-skip-permissions, the shipped default since 0.7.2) and `auto` — because those are the only two
  // an unattended worker can actually run in; the server's workerDispatchPermission enforces that same
  // floor, so a restrictive value left here by an older build cannot reach a spawn.
  permissionMode: PermissionMode,
  model: z.string().optional(), // the agent's --model value; undefined = CLI default
  // The agent backend the selected model runs on (Codex-support epic, Phase 3). Persisted ALONGSIDE
  // `model` — a Claude model pins "claude", a GPT/Codex model pins "codex" — so the dependent controls
  // (permission-mode vs sandbox, the effort set) know which axis to present. Optional so an old blob
  // parses; absent ⇒ "claude" (derivable from `model` too, via backendForModel in web/lib/options).
  backend: Backend.optional(),
  // Reasoning effort. The ladder spans BOTH backends' universes: Claude's (low..max, plus "ultracode")
  // and codex's (adds "ultra" — a 5.6-sol/terra level above max). Which subset is OFFERED is
  // backend/model-gated in the UI (a codex model exposes exactly its cache `efforts`; "ultracode" is
  // offered only on an xhigh-capable Claude model), and the server passes the chosen value through per
  // backend — so the wire enum is simply the union.
  //
  // "ultracode" is a Claude rung with no `--effort` equivalent: Claude Code's effort flag stops at max,
  // and ultracode is a separate session-scoped setting meaning "xhigh + standing dynamic-workflow
  // orchestration". It travels the wire as an effort because that is how Claude Code's own `/effort`
  // presents it; resolveClaudeEffort (server/backend/claude-effort.ts) translates it at the spawn edge.
  //
  // "auto" is not a level either: it asks ntwine to pick one per dispatch from the prompt (a short Haiku
  // call, server/effort-chooser.ts) before anything launches. It is a DISPATCH value only — a started
  // thread's row records the concrete level that call chose, so no runtime ever sees "auto".
  effort: z.enum(["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).optional(),
  notifications: z.boolean(),
  // (No `projectRail`: the opt-in column of project icons was a setting from 2026-10-06 to 2026-10-14,
  // and before 2026-09-30; a stored value is stripped on parse, this being non-strict.)
  // (No `homeFolder`: the Home workspace's agents run in the operator's home folder, always. It was a
  // setting from 2026-09-28 to 2026-10-07; a stored value is stripped on parse, this being non-strict.)
  // (No `worktreeDir` / `removeWorktreesOnDone`: ntwine mandates no worktree folder and removes no
  // worktree on done, as upstream. Settings from 2026-09-30 to 2026-10-07; stripped on parse.)
  /**
   * Remove a linked git worktree under a registered project's `<main checkout>/.ntwine/worktrees` once it
   * has been idle this many days and nothing in it could be lost: clean, only regenerable ignored files,
   * its HEAD on a ref, and no open thread working in it. Checked shortly after boot and daily after
   * (server/worktree-sweep.ts). Branches are never deleted. 0 = never. Optional so an old blob parses;
   * defaultSettings pins 7. A number rather than an absent key for "never", for the same reason as
   * `deleteDoneThreadsUntouchedDays`. Machine-level.
   */
  removeIdleWorktreesDays: z.number().int().min(0).max(3650).optional(),
  /**
   * Done threads the human has not touched (opened, replied to, acted on) for this many days are deleted, in every open project, by an hourly sweep
   * (server/thread-retention.ts). 0 = never, the default — a delete cannot be undone, so nothing is
   * deleted on an operator's behalf until they choose a period. A number rather than an absent key for
   * "never" because an absent machine key falls back to a project's stored blob (settings.ts), which
   * would resurrect the period just cleared. Machine-level.
   */
  deleteDoneThreadsUntouchedDays: z.number().int().min(0).max(3650).optional(),
  /**
   * Spend Fable's own weekly budget when the base Claude usage runs low: while the 5-hour or weekly
   * window is nearly out (90% used) and the Fable window still has room, a new Claude thread launches
   * on Fable, and a thread a base limit paused restarts on Fable instead of waiting for the reset
   * (server/backend/fable-fallback.ts). Off by default — it moves work onto a different, costlier
   * model. Machine-level, because quota is the account's, not a project's.
   */
  fableFallback: z.boolean().optional(),
  // There is no `backgroundSummaries` key any more: ntwine's own model calls were a Settings switch until
  // 2026-10-07, and are on now (NTWINE_*=0 still turns one off). A stored key is stripped on parse.
  // There is no `font` key any more. The interface rendered in one of two type families as a machine
  // setting until 2026-09-19 (maintainer: "let's drop monospace as an option"); every surface is sans
  // now, and index.html pins `data-font="sans"` on <html> directly. Settings is a non-strict object,
  // so a stored `font` is stripped the moment an old blob parses — no migration.
  // Default action for a vetted non-image local path in agent markdown. Image clicks always use the
  // OS default viewer so screenshots retain their expected behavior.
  localFileOpener: LocalFileOpener.optional(),
  // The token count at which a NEW Claude worker auto-compacts its conversation. ntwine requests the
  // 1M context window on every dispatch (resolveClaudeLaunchModel), so without this a worker grows
  // toward 1M before it ever compacts — and every turn past 200K re-sends up to 5x the conversation a
  // 200K TUI session would, which is the single largest reason an ntwine thread spends quota faster than
  // the TUI (measured 2026-08-26). Reaches the worker as CLAUDE_CODE_AUTO_COMPACT_WINDOW, which Claude
  // Code caps to the model's real window. Optional so an old blob parses; defaultSettings pins 500_000
  // (maintainer 2026-08-26: "a default compaction window of 500k by default").
  autoCompactWindow: z.number().int().positive().optional(),
  // The prompt-cache tier a NEW Claude worker writes to. "auto" leaves the CLI's own choice (1h on a
  // subscription); "5m" and "1h" reach the worker as CLAUDE_CODE_PROMPT_CACHE_TTL (and the sub-agent
  // twin). The 1h tier bills a cache write at 2x input against 1.25x for 5m; on 2026-09-03 cache
  // writes were 51% of a day's spend while the entries were invalidated every 15–30 minutes anyway
  // (see claudePromptCacheEnv). Optional so an old blob parses; defaultSettings pins "auto".
  promptCacheTtl: z.enum(["auto", "5m", "1h"]).optional(),
  // The context window a NEW Codex thread runs with, in tokens. Codex's own default is the model's
  // stock window (272K on GPT-5.6), but the catalogue also carries a larger `max_context_window` (872K
  // on GPT-5.6-sol/terra/luna and GPT-6-astra, measured 2026-09-11 in ~/.codex/models_cache.json) that
  // a thread only reaches when asked. Reaches codex as the `model_context_window` config override on
  // `thread/start` and every cold `thread/resume` (see codexContextWindowConfig); codex clamps it to
  // the model's maximum, so a value above it is harmless, and it moves the auto-compact threshold with
  // it (codex compacts at 90% of the resolved window). Unset ⇒ nothing is sent and the model's stock
  // window applies. Optional so an old blob parses; defaultSettings leaves it unset.
  codexContextWindow: z.number().int().positive().optional(),
  // The operator's OWN Agent Client Protocol agents, merged over the built-in catalogue by id
  // (server/backend/acp-agents.ts). `command` is an executable name on PATH or an absolute path;
  // `args` is what puts it into ACP mode (`["acp"]`, `["--acp"]`). Optional so an old blob parses.
  acpAgents: z.array(z.object({
    id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
    label: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1).max(1_024),
    args: z.array(z.string().max(1_024)).max(32).optional(),
  })).max(32).optional(),
})
export type Settings = z.infer<typeof Settings>

/**
 * The settings that describe the MACHINE rather than a project — stored once for every project the
 * server serves (server/settings.ts, which explains why each is one), while the rest of `Settings` is
 * a project's own. The server reads the list to decide what goes in the machine record; the web reads
 * it to publish a save of these keys to every project's cached copy (hooks/useSettingsAutosave.tsx),
 * because the query cache keeps one `settingsGet` entry per project and a machine setting changed in
 * one is changed in all.
 */
export const MACHINE_SETTING_KEYS = ["notifications", "localFileOpener", "removeIdleWorktreesDays", "deleteDoneThreadsUntouchedDays", "fableFallback"] as const satisfies readonly (keyof Settings)[]

// The new-thread composer's durable choices — MACHINE-wide, one record for every project the server
// serves (server/dispatch-preferences.ts), because the profile belongs to the operator, not to a
// repository. Keep one profile per runtime so
// moving between Claude and Codex never overwrites the other runtime's model, effort, or permission
// selection. Fields stay optional for the first-run/default case: a displayed fallback is not stored
// as user intent until the human actually chooses it.
export const DispatchProviderPreferences = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export type DispatchProviderPreferences = z.infer<typeof DispatchProviderPreferences>

export const DispatchPreferences = z.object({
  backend: Backend,
  claude: DispatchProviderPreferences,
  codex: DispatchProviderPreferences,
  // Optional because every record written before the ACP backend existed lacks it, and a required
  // key would fail those records' parse and silently reset the operator's saved profile.
  acp: DispatchProviderPreferences.optional(),
})
export type DispatchPreferences = z.infer<typeof DispatchPreferences>

// Atomic updates avoid read/modify/write races between the sidebar form and the anywhere composer.
// A matrix-cell selection is one complete model+effort profile mutation; permission remains an
// independent axis. Every provider-owned update names its runtime so a delayed request can never
// contaminate the other profile.
export const SetDispatchPreferenceInput = z.discriminatedUnion("field", [
  z.object({ field: z.literal("backend"), value: Backend }),
  z.object({
    field: z.literal("profile"),
    backend: Backend,
    model: z.string().trim().min(1).max(200),
    // Optional ONLY for an ACP profile, which runs with whatever model and effort its own CLI is
    // configured for — ntwine has no effort axis to offer there. A Claude/Codex profile without an
    // effort is refused below rather than silently stored as "default".
    effort: Settings.shape.effort,
  }),
  z.object({ field: z.literal("model"), backend: Backend, value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("effort"), backend: Backend, value: Settings.shape.effort.unwrap() }),
]).superRefine((update, ctx) => { if (update.field === "profile") requireEffortOutsideAcp(update, ctx) })
export type SetDispatchPreferenceInput = z.infer<typeof SetDispatchPreferenceInput>

function requireEffortOutsideAcp(profile: { backend: Backend; effort?: string }, ctx: z.RefinementCtx): void {
  if (profile.backend !== "acp" && profile.effort === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effort"], message: `effort is required for a ${profile.backend} profile` })
  }
}

// ---- RPC inputs ----

export const DispatchInput = z.object({
  // Optional: when omitted, dispatch derives a fallback title from the prompt (Claude later renames
  // the session via ai-title, which the UI prefers for display). The thread FILE always gets a
  // concrete title regardless — ntwine requires one.
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  slug: ThreadSlug.optional(), // derived from title if omitted
  // IGNORED: dispatch permission is decided server-side (workerDispatchPermission) from the
  // non-interactive floor plus the operator's Settings choice, never per dispatch. Accepted-but-ignored
  // so old clients still parse.
  permissionMode: PermissionMode.optional(),
  model: z.string().optional(),
  // The agent backend for THIS dispatch (Codex-support epic, Phase 3). Omitted ⇒ the dispatcher
  // defaults to "claude", keeping the legacy RPC path byte-identical. The router forwards it into
  // `dispatch(input, { backend })`; the model picker sets it from the chosen model's family.
  backend: Backend.optional(),
  effort: Settings.shape.effort,
  // The thread's TIME LIMIT (deadline.ts): the absolute instant the browser resolved from the prompt
  // box's control ("2h", "15:30"). Set by the HUMAN — a worker's `spawn_thread` cannot pass one, so a
  // spawned thread starts with none and its own worker may set it with `ntwinectl deadline`.
  deadline: z.string().refine((v) => Number.isFinite(Date.parse(v)), "deadline must be an ISO-8601 instant").optional(),
  // `spawn_thread`'s choice of project (router spawnTarget, server spawn-project.ts): a slug, name, id or
  // checkout path of a project ntwine has open. Omitted ⇒ the project this dispatch was addressed to.
  project: z.string().min(1).optional(),
  // The thread calling `spawn_thread`, from the shim's own identity. Its presence marks a WORKER's
  // dispatch, whose prompt is checked for another project's checkout when `project` is omitted; the
  // board's own dispatch never sets it, so what the human types is never second-guessed. A plain string:
  // only its presence is read, and a caller id that is not a slug must not refuse the whole spawn.
  spawnedFrom: z.string().optional(),
  // `spawn_thread` sets it: hold the answer until the new thread has its NAME (a caller's title at once,
  // else the mint, bounded) and return its `@handle`, which is how one thread names another. The board's
  // own dispatch leaves it off and is answered the moment the thread exists.
  awaitHandle: z.boolean().optional(),
})
export type DispatchInput = z.infer<typeof DispatchInput>

// A HELD THREAD (SessionRow.held_by on the server): a thread created WITHOUT starting an agent, held by whoever
// wrote it down — a schedule's next run. `prompt` is what it will start with, and what
// its name is minted from unless a `title` is typed. The profile is the prompt box's pick at the moment it
// was written down, and is what the agent starts on unless changed then.
export const CreateHeldThreadInput = z.object({
  prompt: z.string().trim().min(1),
  title: z.string().min(1).optional(),
  model: z.string().optional(),
  backend: Backend.optional(),
  effort: Settings.shape.effort,
})
export type CreateHeldThreadInput = z.infer<typeof CreateHeldThreadInput>
// Rewrite a held thread's opening prompt (ThreadView.heldPrompt) — a schedule's next run's, edited for that run.
export const UpdateHeldPromptInput = z.object({ slug: ThreadSlug, sessionId: z.string().min(1), prompt: z.string() }).strict()
export type UpdateHeldPromptInput = z.infer<typeof UpdateHeldPromptInput>
// Start a held thread's agent: `prompt` is its opening message (the held prompt, usually edited first). The
// profile fields default to the ones the thread was written down with.
export const StartHeldThreadInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  backend: Backend.optional(),
  effort: Settings.shape.effort,
}).strict()
export type StartHeldThreadInput = z.infer<typeof StartHeldThreadInput>

// ---- SPINOFFS (2026-09-29) -----------------------------------------------------------------------
// A new thread the HUMAN asks for from an existing one — "fix this", "investigate perf" — with the
// current thread supplying the context. It is not a sub-agent (nothing returns to the parent) and not a
// bare dispatch (the new thread does not start cold). On a Claude thread the new thread is a FORK of the
// parent's session and starts with its whole conversation (2026-09-30, spinoffForkPrompt, server
// router.ts forkSpinoff). Everywhere else it starts fresh on context ntwine assembles from the parent
// (2026-10-07, spinoffContext). Either way the parent is sent nothing. Both threads then carry the edge:
// the parent's timeline shows the request as a card linking forward, and the child's header links back.
// "Spinoff" is one word, verb and noun alike (maintainer 2026-09-29); it is asked of the whole thread,
// never of one message.
export const SpinoffInput = z.object({
  slug: ThreadSlug,
  // Bound to the session the tab is looking at, exactly like FollowUpInput.
  sessionId: z.string().min(1),
  // Uncapped, like the prompt box's own follow-up and dispatch: a 4,000-char cap here silently cut off
  // pasted context (maintainer 2026-10-01).
  instructions: z.string().trim().min(1),
  // The project the new thread starts in (its id), when that is not this thread's own (2026-09-30). It
  // must be open on this server: the child is dispatched through that project's own dispatcher.
  project: z.string().min(1).optional(),
}).strict()
export type SpinoffInput = z.infer<typeof SpinoffInput>
export const SpinoffResult = z.object({ id: z.string() }).strict()
export type SpinoffResult = z.infer<typeof SpinoffResult>


export const FollowUpInput = z.object({
  slug: ThreadSlug,
  // Binds the call to the session the tab is looking at, so a stale page cannot deliver a follow-up
  // into a thread that has since been re-dispatched (merged from origin/main, 2026-07-21).
  sessionId: z.string().min(1),
  // EMPTY only when `answers` ride: the staged answers alone are a message. The server refuses a send
  // that carries neither.
  message: z.string(),
  // REGISTERED-QUESTION ANSWERS SENT WITH THIS MESSAGE — the prompt box's one Send. The server settles
  // each question exactly as `answerQuestions` does, then delivers ONE turn: the answers in their wire
  // form (questionAnswerMessage) and `message` under them as the note (withAnswersNote). They ride the
  // follow-up rather than the scheduler's answer wake so the pair arrives together, in the order the
  // human wrote it, and as fast as a steer does.
  answers: z.array(QuestionAnswerSchema).optional(),
  // SEND TO THE QUEUE: while the agent is mid-turn, ntwine keeps this message and delivers it when the
  // thread comes to rest, so it opens the next turn instead of steering this one. At rest it is an
  // ordinary send — there is nothing to wait for. See `held` in the server's delivery-ledger.ts.
  hold: z.boolean().optional(),
  // Generated once before the optimistic clear so a transport replay can be idempotent.
  deliveryId: z.string().min(1).max(200).optional(),
  // Retire the worker's live process before delivering, so this message lands in a `claude` that has
  // just started. The operator's "Restart worker" verb — the ONLY caller that sets it — exists because
  // a worker inherits its plugin/hooks AND its system prompt at process start and can never pick up a
  // newer ntwine build in place (hooks are read once, at startup). Everything else that needs a fresh
  // process derives it server-side; see needsFreshProcessForLimit.
  freshProcess: z.boolean().optional(),
  // PREEMPT the operation the worker is running right now, so this message is read at once instead of
  // when that operation finishes. The operator's "Interrupt and send" verb, and opt-in for the same
  // reason `freshProcess` is: it costs the in-flight tool call's result. (It no longer costs the
  // worker's sub-agents: since 2026-09-24 the broker's SDK query declares `perTaskStopAffordance`,
  // so the interrupt aborts only the turn and background agents run on.)
  //
  // It exists because delivery is ALREADY as fast as queueing can be. Measured over 14 days of this
  // project's own transcripts, Claude Code drains its queue at the first sampling boundary that
  // exists; the wait an operator feels is the remaining time of whatever was in flight (a long `Bash`,
  // or one 73–133s reasoning+answer generation), which put mid-turn operator prose at p50 13.8s,
  // p90 49s, p99 2.5m. Preempting is the only lever left.
  //
  // Broker-backed Claude only — that is every Claude thread dispatched since the broker cutover. On
  // any other runtime the message is delivered normally and this is ignored, never refused: a send
  // that arrives is always better than a send that errors.
  interrupt: z.boolean().optional(),
  // The deliveryId of a FAILED send this one re-sends — the failed bubble's Retry. The server drops that
  // failed entry in the same write that opens this send's own, so the retry replaces the failed bubble
  // rather than standing beside it. A new deliveryId, never the old one: the old send's failure may be
  // ambiguous, and only the operator decides to risk a second copy.
  supersedes: z.string().min(1).max(200).optional(),
})
export type FollowUpInput = z.infer<typeof FollowUpInput>

// Dismiss a FAILED send — the × on its bubble, or the second half of Edit (the text goes back into the
// prompt box first). Only a failed entry can go: every other ledger state belongs to its transport.
export const DismissFailedFollowUpInput = z.object({
  slug: ThreadSlug,
  deliveryId: z.string().min(1).max(200),
}).strict()
export type DismissFailedFollowUpInput = z.infer<typeof DismissFailedFollowUpInput>
export const DismissFailedFollowUpResult = z.object({ dismissed: z.boolean() }).strict()
export type DismissFailedFollowUpResult = z.infer<typeof DismissFailedFollowUpResult>

// Take a follow-up back out of the provider's queue — the operator clicked their own queued bubble to
// unqueue it and get the text back in the prompt box. Keyed by the same `deliveryId` the send carried,
// which IS the uuid the provider queued the message under.
export const UnqueueFollowUpInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as followUp: a stale tab must not unqueue against a re-dispatched session.
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1).max(200),
}).strict()
export type UnqueueFollowUpInput = z.infer<typeof UnqueueFollowUpInput>
// `unqueued:false` is a real, expected outcome, NOT an error: the message had already been dequeued for
// execution. It is reported rather than thrown precisely because the operator must be able to tell
// "I took it back" from "it's already on its way" — `reason` is what the surface shows them.
export const UnqueueFollowUpResult = z.object({
  unqueued: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type UnqueueFollowUpResult = z.infer<typeof UnqueueFollowUpResult>

// PUSH IT THROUGH NOW — the ↑ on a queued bubble. Carries no message, because there is nothing left to
// send: the words are already sitting in the provider's queue, and the only thing between the agent and
// them is the turn it is currently running. So this is the interrupt half of followUp's `interrupt`
// flag, on its own. Same order-is-the-contract (deliver, THEN interrupt) — here the delivery happened
// whenever the operator hit Enter, which is precisely why the decision no longer has to be made at send
// time the way the composer's old ⚡ demanded.
//
// It preempts the TURN, not one message: the SDK opens the next turn on everything queued, so with
// several bubbles waiting this delivers all of them, in order. The button's copy says so.
export const DeliverQueuedNowInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as unqueueFollowUp: a stale tab must not preempt a re-dispatched session.
  sessionId: z.string().min(1),
  // Hand over what ntwine is HOLDING for the agent's rest ("Send to queue") and stop there — no
  // interrupt. The "Send now" under a held bubble: the operator changed their mind about waiting, not
  // about interrupting, so the message goes in as the steer it would have been.
  releaseOnly: z.boolean().optional(),
}).strict()
export type DeliverQueuedNowInput = z.infer<typeof DeliverQueuedNowInput>
// `interrupted:false` is an expected outcome, NOT an error: there was no live turn to preempt (the
// daemon is gone, or the agent is already resting), and the queued message is read the ordinary way.
// Reported rather than thrown so the surface can say which happened — the same truthfulness rule
// UnqueueFollowUpResult is built on.
export const DeliverQueuedNowResult = z.object({
  interrupted: z.boolean(),
  reason: z.string().optional(),
  // How many messages ntwine was HOLDING for the agent's rest ("Send to queue") and has now handed over.
  // Those were never in a provider queue, so on a runtime that cannot be interrupted this is the whole
  // of what "send now" did — and it is a success the surface must not report as a refusal.
  released: z.number().int().nonnegative().optional(),
}).strict()
export type DeliverQueuedNowResult = z.infer<typeof DeliverQueuedNowResult>

// COMPACT NOW — the button in the context meter's hover panel. Asks the thread's own harness to
// summarize its context in place, the same act as typing `/compact` into Claude Code or codex: a
// broker-backed Claude row is sent the literal `/compact` (the Agent SDK runs a streamed slash command
// as a local command, recording a `compact_boundary` with trigger "manual"), and an app-server codex row
// gets `thread/compact/start`. Refused while a turn is in flight and for every other runtime.
export const CompactThreadInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as followUp: a stale tab must not compact a re-dispatched session.
  sessionId: z.string().min(1),
}).strict()
export type CompactThreadInput = z.infer<typeof CompactThreadInput>

/** Whether the thread's runtime gives ntwine a way to request a compaction at all — the gate the
 *  server enforces and the context meter's panel reads to decide whether to offer the button. */
export function threadCanCompact(thread: { backend?: string; claudeRuntime?: string; foreign?: boolean }): boolean {
  if (thread.foreign) return false
  // `claudeRuntime` is set only on a Claude row, whose `backend` may itself be absent (Claude is the
  // unmarked default), so the broker marker alone identifies one.
  return thread.backend === "codex" || thread.claudeRuntime === "broker"
}

export const SetThreadSnoozeInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  // null is the explicit "wake now"/cancel operation; presets and custom local input send UTC.
  until: SnoozeUntil.nullable(),
  // Optional scheduled follow-up. Omitted/null ⇒ a plain reminder snooze; a prompt ⇒ the thread is
  // automatically bumped with it at `until`. Always cleared together with the instant, so a wake-now
  // can never leave an armed prompt behind.
  prompt: SnoozePrompt.nullable().optional(),
}).strict()
export type SetThreadSnoozeInput = z.infer<typeof SetThreadSnoozeInput>

// Pin/unpin a thread out of the rail's band system (the pinned band at the very top of the rail).
// Session-guarded like the snooze: the verb lives on a row a stale tab may still be showing.
export const SetThreadPinnedInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  pinned: z.boolean(),
}).strict()
export type SetThreadPinnedInput = z.infer<typeof SetThreadPinnedInput>

// The recurring prompt's OPERATOR half — the Goal panel, arming and disarming in ONE call. The
// text, the two triggers and the cadence are all views of one row, and splitting them into separate
// mutations would let a tab holding only some of them clobber the rest on save.
//
// Session-guarded like every other browser write: a tab looking at a thread that has since been
// re-dispatched fails closed rather than arming whatever now owns the slug.
//
// `prompt: null` clears the row entirely. A prompt with both triggers false keeps the text and the
// cadence parked and silent — that IS the off state, and it is why there is no `enabled` field.
// `intervalSeconds` is required when `heartbeat` is true, because a schedule nobody chose is exactly
// the ambiguity the minutes field exists to remove.
export const SetThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  intervalSeconds: RecurringIntervalSeconds.optional(),
  // The LIMITS. Omitted KEEPS what the row holds (a tab that predates them must not drop a cap the
  // worker set); `null` clears one.
  maxRuns: GoalMaxRuns.nullable().optional(),
  forSeconds: GoalForSeconds.nullable().optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetThreadRecurringPromptInput = z.input<typeof SetThreadRecurringPromptInput>

// The WORKER half, through `ntwinectl goal` (which POSTs the same `/rpc/*` surface the
// board uses). A worker has no other way to keep a long effort moving — Claude Code's own in-session
// schedulers cannot fire in the runtime ntwine spawns — so this is the counterpart to the operator's
// control above, writing the same row.
//
// Deliberately NOT session-guarded, unlike the operator's input: the MCP server is spawned with its
// thread's slug and keeps it across a resume, while the session id and generation bump underneath it.
// A guard here would fail on exactly the long-lived thread this exists for. The slug is stamped into
// that server's env by ntwine, not supplied by the model.
//
// There is deliberately no thread parameter a model could aim elsewhere: a worker may only ever arm its
// OWN thread. One agent making a DIFFERENT thread loop forever is not a capability ntwine hands out.
//
// `prompt: null` is the explicit stop, which is how a worker ends its own loop deliberately rather than
// by falling back on the ALLDONE sentinel.
export const SetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  /** ACCEPTED AND IGNORED. The question hold was deleted 2026-08-16 (see scheduler.ts) and no caller in
   *  this repo sends it any more — but this object is `.strict()`, and the caller on the other end is a
   *  DETACHED worker daemon holding the `ntwine-mcp.mjs` it was spawned with. Those outlive a server
   *  restart by design, so for as long as any pre-2026-08-16 worker is alive a `start` would otherwise
   *  come back as a validation error on a field the model cannot see it is sending. Tolerated here rather
   *  than in the router so the shape stays one declaration; delete it once no such worker can be running.
   *  The BROWSER input above needs no such clause — a stale tab is one reload away. */
  pauseOnQuestions: z.boolean().optional(),
  intervalSeconds: RecurringIntervalSeconds.optional(),
  // The LIMITS, as above. The `goal` tool's `start` sends both explicitly (null for "no limit"), since a
  // `start` replaces the whole Goal; an older MCP server sends neither, and keeps whatever is set.
  maxRuns: GoalMaxRuns.nullable().optional(),
  forSeconds: GoalForSeconds.nullable().optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetOwnThreadRecurringPromptInput = z.input<typeof SetOwnThreadRecurringPromptInput>

// What the write ANSWERS with: the row it just overwrote. A `start` REPLACES whatever the thread held —
// including text the HUMAN edited in the Goal panel — and the writer could not previously see what it
// destroyed. Returning the superseded row lets the command say so in the same breath, so a blind overwrite
// is at least a REPORTED one. `null` when the thread held nothing.
export const SetOwnThreadRecurringPromptResult = z.object({
  replaced: ThreadRecurringPrompt.nullable(),
}).strict()
export type SetOwnThreadRecurringPromptResult = z.infer<typeof SetOwnThreadRecurringPromptResult>

// The READ half, from `ntwinectl goal get`. Without it a worker can only
// write: it cannot tell whether it is armed at all, what text it armed before its context was compacted
// away, or whether the human has since edited it in the Goal panel. Same caller rules as the write above —
// keyed on the slug alone, and no thread parameter a model could aim at anyone else's row.
export const GetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
}).strict()
export type GetOwnThreadRecurringPromptInput = z.infer<typeof GetOwnThreadRecurringPromptInput>

// `null` — rather than an omitted field — because "nothing is armed" is the answer a worker most needs
// to be able to tell apart from "this server is too old to know", which arrives as an HTTP 404 instead.
export const OwnThreadRecurringPromptResult = z.object({
  recurringPrompt: ThreadRecurringPrompt.nullable(),
}).strict()
export type OwnThreadRecurringPromptResult = z.infer<typeof OwnThreadRecurringPromptResult>

// ---- THE ONE-OFF TIMER's three worker procedures -------------------------------------------------
// Same caller and therefore the same rules as the recurring prompt above: no session guard (the MCP
// server outlives the session ids underneath it), and no thread parameter a model could aim elsewhere.
//
// `fireAt` is an exact UTC instant, resolved by the TOOL from whichever of "in N seconds" / "at this
// instant" the worker gave it — one representation reaches the server, so the row, the trailer and the
// scheduler all name the same string.
export const SetOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  prompt: TimerPromptText,
  fireAt: SnoozeUntil,
}).strict()
export type SetOwnThreadTimerInput = z.infer<typeof SetOwnThreadTimerInput>

export const CancelOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type CancelOwnThreadTimerInput = z.infer<typeof CancelOwnThreadTimerInput>

export const ListOwnThreadTimersInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadTimersInput = z.infer<typeof ListOwnThreadTimersInput>

// Every one of the three answers with the thread's CURRENT armed set, so a worker never has to make a
// second call to see what it now holds — and so a `set` that lands while an earlier timer is still armed
// shows both.
export const OwnThreadTimersResult = z.object({
  timers: z.array(ThreadTimerView),
}).strict()
export type OwnThreadTimersResult = z.infer<typeof OwnThreadTimersResult>

// ---- THE ACTIVITY READOUT -------------------------------------------------------------------------
// EVERY kind of background work a thread has out, with the id the awaiting fence names it by, in ONE
// call. The fence is structural — it references things by id — so a worker that has lost its ids (a
// compaction, a long turn, a wake it did not expect) cannot write a correct fence at all. This is how it
// gets them back, and it is the same list the sign-off nudge prints, so the two can never disagree.
export const ThreadActivityItem = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr", "thread", "command"]),
  /** The string a `<kind>:` fence line must carry. For a shell that is the runtime task id the worker
   *  was shown; for a PR, `owner/repo#N`; for a timer, its `tmr_…` row id; for a thread this one awaits a
   *  reply from, its `@handle`. */
  id: z.string(),
  label: z.string(),
  /** ISO8601 of when it started or was armed — absent when ntwine has no instant for it. */
  since: z.string().optional(),
  /** A timer's fire instant, or a PR's expiry. Absent for shells and sub-agents. */
  until: z.string().optional(),
  /** The `wch_…` id of the REGISTERED WATCH holding this item, when the worker armed one — so a readout
   *  that exists to hand ids back also hands back the one `unwatch` takes. A separate ROW per watch was
   *  the alternative and it would list the same shell twice, which is exactly the duplication that put
   *  two sub-agents under a "Background shells" heading. */
  watchId: z.string().optional(),
  /** A SUB-AGENT's `thread.subAgent` address (thread-handle.ts), so the worker names it in its prose the
   *  way the board shows it — as a link the human can click — rather than as "a sub-agent". */
  address: z.string().optional(),
  /** A SHELL's runtime-budget deadline (ISO8601) — when ntwine warns about it and, unextended, stops it
   *  ten minutes later. Its own field rather than `until`, which reads as "fires at" everywhere else. */
  budgetEndsAt: z.string().optional(),
}).strict()
export type ThreadActivityItem = z.infer<typeof ThreadActivityItem>

export const ListOwnThreadActivityInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadActivityInput = z.infer<typeof ListOwnThreadActivityInput>

export const OwnThreadActivityResult = z.object({
  /** This thread's own handle — the head of every sub-agent address above, and what other threads call it. */
  handle: z.string().optional(),
  activity: z.array(ThreadActivityItem),
  links: z.array(ThreadLinkView).optional(),
  /** Every question still owed an answer. NOT a `ThreadActivityItem` and deliberately its own list: a
   *  question is not running work, it waits on a PERSON, and the awaiting fence names one only by id,
   *  under `questions:` (2026-10-05), never as an item to wait on. Until 2026-08-28 a worker could read its open questions back only
   *  as a side effect of `ask` (which registers another) or `unask` (which withdraws one) — so the ids
   *  that block `done` were readable only by mutating something (maintainer: "Is there a way for the
   *  agent to read out the current set of watchers and questions?"). */
  questions: z.array(RegisteredQuestionView).default([]),
}).strict()
export type OwnThreadActivityResult = z.infer<typeof OwnThreadActivityResult>

export const SetOwnThreadTimerResult = z.object({
  id: z.string(),
  fireAt: z.string(),
  timers: z.array(ThreadTimerView),
}).strict()
export type SetOwnThreadTimerResult = z.infer<typeof SetOwnThreadTimerResult>

export const CancelOwnThreadTimerResult = z.object({
  cancelled: z.boolean(),
  timers: z.array(ThreadTimerView),
}).strict()
export type CancelOwnThreadTimerResult = z.infer<typeof CancelOwnThreadTimerResult>

// ---- The SUPERSEDED worker shapes, kept alive for MCP servers already in flight -----------------
//
// A worker's `ntwine-mcp.mjs` is spawned ONCE, out of the promoted build its session was dispatched with,
// and it lives as long as that session — across every ntwine server restart. The server meanwhile gets
// restarted from newer source whenever the operator promotes a build. So `/rpc` is a VERSIONED CONTRACT
// between two processes that update INDEPENDENTLY, and renaming a procedure a worker's MCP server calls
// strands every session already running.
//
// Not hypothetical: merging the old `stop_hook` and `heartbeat` tools into one `recurring_prompt` renamed
// this procedure, and every worker holding an older MCP server started getting a bare HTTP 404 for its
// only means of keeping a long effort moving. The two shapes below are what those builds actually send;
// the router folds them onto the merged row above. Retire them only once no build that sends them can
// still be running — the cost of keeping them is two thin aliases, the cost of dropping them early is a
// live worker silently losing a capability mid-effort.
//
// The trigger each one owns is fixed: the stop hook was the ON-REST feature.
export const SetOwnThreadStopHookInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  enabled: z.boolean(),
}).strict()
export type SetOwnThreadStopHookInput = z.infer<typeof SetOwnThreadStopHookInput>

// The heartbeat was the ON-SCHEDULE feature. This covers BOTH of its generations: the older one (posted
// as `setThreadHeartbeat`) carried no `enabled` field and signalled its stop with `prompt: null` alone,
// which is why `enabled` is optional here rather than required.
export const SetOwnThreadHeartbeatInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  intervalSeconds: RecurringIntervalSeconds.optional(),
  enabled: z.boolean().optional(),
}).strict()
export type SetOwnThreadHeartbeatInput = z.infer<typeof SetOwnThreadHeartbeatInput>

// A human-authored display title for a registered session. Trimming happens at the RPC boundary so
// storage never has to distinguish whitespace-only names from real intent; the web input mirrors the
// same cap. This is metadata-only and therefore works identically for Claude and Codex sessions.
export const RenameThreadInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
})
export type RenameThreadInput = z.infer<typeof RenameThreadInput>

// THE WORKER NAMING ITS OWN THREAD, from `ntwinectl title`. Both backends get a name automatically at
// spawn — Claude from the provider's own titler, Codex from the first-line `<!-- ntwine title="…" -->`
// marker — and both are minted from the raw dispatch prompt before the worker has read a single line of
// the repo, so they can only ever paraphrase what the operator typed. That is how a zod thread came out
// named "Zon4.5 features and z.properties documentation audit": the titler copied the operator's typo
// verbatim, because at that instant nothing in the session knew the product is called Zod.
//
// It used to be a SECOND, considered pass — the worker renamed its thread once it understood the task.
// Since 2026-09-30 it only NAMES a thread that has no name yet: a name is the thread's `@handle`, and a
// handle never changes once the board has shown it (server thread-names.ts).
//
// Unlike RenameThreadInput it never LOCKS the row — the name is machine-authored, so a human rename
// still outranks it. Unguarded on session/generation for `SetOwnThreadRecurringPromptInput`'s reasons:
// the MCP server knows only the slug ntwine stamped into its env, and a model chooses the TEXT, never
// the thread.
export const SetOwnThreadTitleInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
}).strict()
export type SetOwnThreadTitleInput = z.infer<typeof SetOwnThreadTitleInput>

// ONE THREAD READING OR MESSAGING ANOTHER, BY HANDLE (thread-handle.ts). `slug` is the CALLER, stamped
// into the worker's MCP env exactly as for `title`; `handle` is the other thread's kebab-case name as the
// board shows it — `shell-budgets`, with or without the `@`, in any casing.
export const ReadThreadInput = z.object({
  slug: ThreadSlug,
  handle: z.string().trim().min(1).max(200),
}).strict()
export type ReadThreadInput = z.infer<typeof ReadThreadInput>

// Either the thread, or — when the handle names none — the handles that DO exist, so the worker can
// correct a typo without a second lookup.
export const ReadThreadResult = z.object({
  found: z.boolean(),
  handle: z.string().optional(),
  slug: z.string().optional(),
  state: z.enum(["running", "resting", "done"]).optional(),
  status: z.string().optional(),
  request: z.string().optional(),
  latest: z.string().optional(),
  latestAt: z.string().optional(),
  /** Up to three assistant messages BEFORE the newest, oldest first — the thread's approach and progress,
   *  which the newest message alone (often a terse handoff) does not carry. */
  earlier: z.array(z.string()).optional(),
  editedFiles: z.array(z.string()).optional(),
  known: z.array(z.string()).optional(),
  /** Set when the handle named a SUB-AGENT (`thread.subAgent`): the handle of the thread it belongs to.
   *  `state` is then the child's own — "done" once it has returned — and `outcome` how it ended. */
  subAgentOf: z.string().optional(),
  outcome: z.enum(["completed", "failed", "killed"]).optional(),
  /** Set when the thread is in ANOTHER open project than the caller's (a handle the caller's own project
   *  does not carry): that project's name. */
  project: z.string().optional(),
}).strict()
export type ReadThreadResult = z.infer<typeof ReadThreadResult>

// A THREAD'S SUB-AGENTS, EVERY ONE IT EVER DISPATCHED — live first, then the finished ones newest first
// (the `subAgentDirectory` RPC). The board's `subAgents` is the LIVE list only; a child that has returned
// leaves it, but its name, its transcript and its place in the tree stay on disk in the session's own
// `subagents/` dir (Claude's `agent-<id>.meta.json` sidecars, and each Workflow run's journal), so the
// directory is read from there rather than kept by ntwine. It is what `@thread.` completes against in the
// prompt box, and what a `@thread.subAgent` mention opens — after the child has returned as well as while
// it runs (shared thread-handle.ts for the address itself).
export const SubAgentDirectoryEntry = z.object({
  /** The drill-in id — what `subAgentTranscript` and the sub-agent drawer take. */
  id: z.string(),
  /** The dispatch name as written (`description`, or a Workflow agent's `label`). */
  label: z.string(),
  /** Its full `thread.subAgent` address without the `@`, when every link down to it has a handle. */
  address: z.string().optional(),
  /** The drill-in id of the sub-agent that dispatched it; absent for the thread's own children. */
  parentId: z.string().optional(),
  depth: z.number().int().min(1),
  state: z.enum(["running", "stale", "rested", "done"]),
  outcome: z.enum(["completed", "failed", "killed"]).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  workflow: z.boolean().optional(),
  subagentType: z.string().optional(),
}).strict()
export type SubAgentDirectoryEntry = z.infer<typeof SubAgentDirectoryEntry>

export const SubAgentDirectory = z.object({
  /** The thread's own handle, the head of every address below; absent when its name has none. */
  threadHandle: z.string().optional(),
  agents: z.array(SubAgentDirectoryEntry),
}).strict()
export type SubAgentDirectory = z.infer<typeof SubAgentDirectory>

export const MessageThreadInput = z.object({
  slug: ThreadSlug,
  handle: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(20_000),
  /** Register a wait on the other thread's answer. The registration is a one-off TIMER on the sender (it
   *  blocks `done` and is what a `threads:` fence entry is checked against) that the ANSWER cancels. It
   *  does not park the sender: the rest that follows ends with an ```awaiting fence naming the thread
   *  under `threads:`, whose `for:` is the timeout, as on every park. */
  awaitReply: z.boolean().optional(),
  /** RETIRED, and ignored: the wait's own timeout, which only duplicated the fence's `for:`. Still
   *  accepted because a worker's MCP server outlives a server upgrade and may still send it. */
  for: z.string().trim().min(1).max(16).optional(),
}).strict()
export type MessageThreadInput = z.infer<typeof MessageThreadInput>

export const MessageThreadResult = z.object({
  sent: z.boolean(),
  handle: z.string().optional(),
  from: z.string().optional(),
  /** The `tmr_…` id of the reply wait, when `awaitReply` armed one, and when the registration lapses. */
  timerId: z.string().optional(),
  waitUntil: z.string().optional(),
  /** A reply wait on the RECIPIENT's side that this message answered, now settled. */
  answered: z.boolean().optional(),
  refusal: z.string().optional(),
  known: z.array(z.string()).optional(),
  /** Set when the recipient is in ANOTHER open project than the sender's: that project's name. */
  project: z.string().optional(),
  /** `mailbox`: the recipient is a running SUB-AGENT (`@thread.child`), which reads it after its next tool call. */
  delivery: z.literal("mailbox").optional(),
}).strict()
export type MessageThreadResult = z.infer<typeof MessageThreadResult>

// What the write answers with: whether it landed, and the name the thread carries NOW. A refusal is not
// an error — a human who has renamed the thread owns its name — so it comes back as a flag the command can
// explain rather than a throw the model will retry. `refusal` says why in words the worker can act on:
// another open thread already holds the name (named, so it can pick a different subject), the name is
// longer than two words, or the thread already has a name (thread-names.ts).
export const SetOwnThreadTitleResult = z.object({
  accepted: z.boolean(),
  title: z.string(),
  lockedByHuman: z.boolean(),
  refusal: z.string().optional(),
}).strict()
export type SetOwnThreadTitleResult = z.infer<typeof SetOwnThreadTitleResult>

export const SetThreadPermissionInput = z.object({
  slug: ThreadSlug,
  permissionMode: PermissionMode,
})
export type SetThreadPermissionInput = z.infer<typeof SetThreadPermissionInput>

export const SetThreadPermissionResult = z.object({
  // "next-turn" is the Codex mid-turn answer: `thread/settings/update` ACCEPTS a sandbox change while a
  // turn is running, but the running turn keeps the policy it started with (verified live — a turn that
  // attempted a write after the flip to danger-full-access was still refused). So the change is real and
  // durable, yet it does not reach work already executing. Distinct from "next-resume", which means
  // nothing was applied to the live session at all.
  //
  // It is ALSO the Claude answer, arrived at from the opposite direction: a permission mode is a LAUNCH
  // flag there, so ntwine retires the idle worker process and the next turn cold-resumes under the new
  // one (router `setThreadPermission`). Same promise to the operator — stored, and true from the next
  // turn on — reached by restarting rather than by retuning.
  effect: z.enum(["applied", "next-turn", "next-resume"]),
})
export type SetThreadPermissionResult = z.infer<typeof SetThreadPermissionResult>

export const ThreadProfileOptionsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadProfileOptionsInput = z.infer<typeof ThreadProfileOptionsInput>
export const ThreadProfileOptionsResult = z.object({
  backend: Backend,
  options: z.array(ThreadProfileOption),
})
export type ThreadProfileOptionsResult = z.infer<typeof ThreadProfileOptionsResult>

// The thread's invocable skills — and, on Claude, the built-in slash commands an ntwine thread can run —
// for the composer's `/` typeahead. Always the HARNESS's own list —
// Claude's `supportedCommands()` through the broker, Codex's `skills/list` through the app-server —
// never an ntwine-side scan of skill directories, which could only drift from what the session actually
// loaded. `description` may be empty (Claude's init-frame names carry no descriptions for entries the
// command list omits).
//
// `source` is where the harness resolved the skill FROM, normalized to one vocabulary so the typeahead
// renders "project" the same whether Claude called it `projectSettings` or Codex called it `repo`. It
// is OPTIONAL, and deliberately so: the promise is "show it if we know it", and a harness that reports
// a scope ntwine has no mapping for must degrade to an unlabelled row rather than to a wrong label.
// `ntwine` is never a harness's answer: it labels a USER COMMAND written in ntwine's own editor, which the
// composer offers in the same menu (UserCommand below).
export const ThreadSkillSource = z.enum(["project", "user", "builtin", "plugin", "ntwine"])
export type ThreadSkillSource = z.infer<typeof ThreadSkillSource>
export const ThreadSkill = z.object({
  name: z.string().min(1).max(512),
  description: z.string().max(1024),
  source: ThreadSkillSource.optional(),
  // A built-in COMMAND (`/context`, `/usage`) rather than a skill. Claude runs a command only when it
  // OPENS the message — mid-sentence it is plain text — so the composer offers these at the start of a
  // draft alone, where a skill is offered at any word boundary.
  command: z.literal(true).optional(),
}).strict()
export type ThreadSkill = z.infer<typeof ThreadSkill>

export const ThreadSkillsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadSkillsInput = z.infer<typeof ThreadSkillsInput>
export const ThreadSkillsResult = z.object({ skills: z.array(ThreadSkill).max(1024) }).strict()
export type ThreadSkillsResult = z.infer<typeof ThreadSkillsResult>

// USER SLASH COMMANDS — a markdown file whose body is a prompt, invoked by its file name (`commit.md` is
// `/commit`). The same format Claude Code and Cursor read: an optional frontmatter block carrying
// `description` and `argument-hint`, then the prompt, where `$ARGUMENTS` stands for whatever was typed
// after the name. ntwine reads them from three places, first match winning:
//
// - `ntwine` — `<ntwine data home>/commands/`, the ones written in ntwine's own editor. The only kind it edits.
// - `project` — `<project>/.agents/commands/`, a repo's own, checked in beside its skills.
// - `global` — `~/.agents/commands/`, the agent-neutral home every agent tool on the machine can share.
//
// NTWINE expands them, not the harness, so `/commit` means the same thing on a Claude, Codex or ACP
// thread — see expandUserCommand.
export const UserCommandSource = z.enum(["ntwine", "project", "global"])
export type UserCommandSource = z.infer<typeof UserCommandSource>
// A file name is a command name: what can follow a `/` and survive every filesystem.
export const UserCommandName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, "Use letters, digits, '-', '_', '.' or ':' (up to 64), starting with a letter or digit")
export const UserCommand = z.object({
  name: UserCommandName,
  description: z.string().max(1024),
  argumentHint: z.string().max(256).optional(),
  body: z.string().max(64 * 1024),
  source: UserCommandSource,
  path: z.string(),
}).strict()
export type UserCommand = z.infer<typeof UserCommand>
export const UserCommandsResult = z.object({
  commands: z.array(UserCommand).max(1024),
  // Where a new ntwine command is written, for the editor to say.
  ntwineDir: z.string(),
}).strict()
export type UserCommandsResult = z.infer<typeof UserCommandsResult>
export const SaveUserCommandInput = z.object({
  name: UserCommandName,
  description: z.string().max(1024),
  argumentHint: z.string().max(256).optional(),
  body: z.string().min(1).max(64 * 1024),
  // Set when an edit RENAMES a command: that file is removed once the new one is written.
  previousName: UserCommandName.optional(),
}).strict()
export type SaveUserCommandInput = z.infer<typeof SaveUserCommandInput>
export const DeleteUserCommandInput = z.object({ name: UserCommandName }).strict()
export type DeleteUserCommandInput = z.infer<typeof DeleteUserCommandInput>

// The text a user command is DELIVERED as. Not a `<ntwine-…>` tag: that prefix marks ntwine's own
// plumbing, which every transcript drops (NOISE_PREFIXES), and this is the human's message. The prompt goes to the agent wrapped in a tag naming the
// command and what was typed after it, so any surface that reads the message back — the transcript, a
// queued bubble, a retry — can show `/commit fix the tests` instead of the whole expanded prompt.
const USER_COMMAND_OPEN = /^<slash-command name="([^"]+)"(?: args="([^"]*)")?>\n/
const USER_COMMAND_CLOSE = "\n</slash-command>"
const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, "&#10;")
const unescapeAttr = (text: string) => text.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")

/** The prompt `/name args` sends: `$ARGUMENTS` replaced by the arguments, or — when the prompt never
 *  names them — the arguments appended on a line of their own, as Claude Code does. */
export function expandUserCommand(command: Pick<UserCommand, "name" | "body">, args: string): string {
  const body = command.body.trim()
  const prompt = body.includes("$ARGUMENTS") ? body.replaceAll("$ARGUMENTS", args) : args ? `${body}\n\nARGUMENTS: ${args}` : body
  return `<slash-command name="${escapeAttr(command.name)}"${args ? ` args="${escapeAttr(args)}"` : ""}>\n${prompt}${USER_COMMAND_CLOSE}`
}

// A `/name` token at a word boundary, ending before whitespace or trailing sentence punctuation — the
// composer's tint rule (web lib/slashCommands.ts SLASH_TOKEN), so what is tinted is what expands.
const USER_COMMAND_TOKEN = /(^|\s)\/([^\s/@]+?)(?=[.,;!?)]*(?:\s|$))/gu
// A command referenced MID-PROMPT rides after the prose as a block of its own. The leading wrapper
// opens the text; these never do, so a reader tells the two apart by position.
const USER_COMMAND_REFERENCE = /\n\n<slash-command name="[^"]+">\n[\s\S]*?\n<\/slash-command>/g

/** A draft that INVOKES user commands, expanded; undefined when it names none.
 *
 *  `/name` as the draft's FIRST token is the command with the rest of the draft as its arguments: the
 *  draft becomes the command's prompt. `/name` ANYWHERE ELSE ("review it, then /commit") keeps the prose
 *  as written and appends that command's prompt after it, so the agent reads what the name stands for on
 *  every backend — a harness that knows no such command, or no commands at all, included. */
export function expandUserCommandDraft(draft: string, commands: readonly Pick<UserCommand, "name" | "body">[]): string | undefined {
  const byName = new Map(commands.map((c) => [c.name, c]))
  const lead = /^\s*\/([^\s/]+)(?:[ \t]+([\s\S]*))?$/.exec(draft)
  const leading = lead ? byName.get(lead[1]!) : undefined
  // A name in a fenced code block is quoted, not invoked — the same blocks the composer paints as code
  // and never tints. (Inline `code` needs no rule: a backtick before the `/` is not a word boundary.)
  const quoted = insideCodeFence(draft)
  const inline: Pick<UserCommand, "name" | "body">[] = []
  for (const m of draft.matchAll(USER_COMMAND_TOKEN)) {
    const command = byName.get(m[2]!)
    if (!command || command === leading || inline.includes(command) || quoted(m.index! + m[1]!.length)) continue
    inline.push(command)
  }
  if (!leading && inline.length === 0) return undefined
  const head = leading ? expandUserCommand(leading, (lead![2] ?? "").trim()) : draft
  return head + inline.map((c) => `\n\n${expandUserCommand(c, "")}`).join("")
}

/** What a delivered user command reads as to the human: the draft as typed, plus anything the send
 *  appended (attached context, file paths). Undefined for any text no user command expanded into. */
export function userCommandDisplayText(text: string): string | undefined {
  const open = USER_COMMAND_OPEN.exec(text)
  if (!open) {
    const typed = text.replace(USER_COMMAND_REFERENCE, "")
    return typed === text ? undefined : typed
  }
  const close = text.indexOf(USER_COMMAND_CLOSE, open[0].length)
  if (close < 0) return undefined
  const args = open[2] ? unescapeAttr(open[2]) : ""
  const typed = `/${unescapeAttr(open[1]!)}${args ? ` ${args}` : ""}`
  const after = text.slice(close + USER_COMMAND_CLOSE.length).replace(USER_COMMAND_REFERENCE, "")
  return after.trim() ? `${typed}${after}` : typed
}

export const SetThreadProfileInput = z.object({
  slug: ThreadSlug,
  model: z.string().trim().min(1).max(200),
  // Absent ONLY for an ACP thread, whose model slug (`acp:<agent>@<model>`) carries no effort axis; the
  // router refuses a Claude/Codex profile without one rather than storing "".
  effort: z.string().trim().min(1).max(100).optional(),
}).strict()
export type SetThreadProfileInput = z.infer<typeof SetThreadProfileInput>
export const SetThreadProfileResult = z.object({
  effect: z.enum(["applied", "next-resume"]),
})
export type SetThreadProfileResult = z.infer<typeof SetThreadProfileResult>

// Move a Claude thread onto the newer edition of its family that the pinned runtime resolves (ThreadView
// `modelUpgrade`). Always `next-turn`: the worker process is retired and the next turn starts in a fresh
// one, on the current pin.
export const UpgradeThreadModelInput = z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict()
export type UpgradeThreadModelInput = z.infer<typeof UpgradeThreadModelInput>
export const UpgradeThreadModelResult = z.object({ effect: z.literal("next-turn"), label: z.string() })
export type UpgradeThreadModelResult = z.infer<typeof UpgradeThreadModelResult>

// ---- DISPATCH TASK BANNER (composer ↔ transcript) -------------------------------------------------
// The loud fence ntwine puts between its own dispatch orientation and the human operator's prompt. It is
// BOTH the worker's system→human handoff cue and the transcript's display boundary, so it lives here,
// next to the other exact presentation markers, rather than in either consumer.
//
// The rule the banner buys is: NOTHING of ntwine's sits below it. Everything the worker needs to be told
// about the framing goes ABOVE — below the banner is the operator's prompt, byte for byte, and the
// first user bubble shows exactly that. (Until 2026-07-26 an explanation line and a bare `TASK:` marker
// sat between the banner and the prompt; that marker was the display cut, which is why the retired
// envelope is still recognized in transcript.ts.)
export const DISPATCH_TASK_BANNER = [
  "===============================================================",
  "======================    YOUR TASK    ========================",
  "===============================================================",
].join("\n")

// The exact cut: the banner on its own lines, followed by one blank line, then the prompt. Requiring
// the surrounding newlines keeps a banner quoted inside prose from being read as the boundary.
export const DISPATCH_TASK_BANNER_MARKER = `\n${DISPATCH_TASK_BANNER}\n\n`

// ---- Retired GitHub batch dispatch envelope (read by server/transcript.ts) ----

// Exact, versioned presentation boundary in a GitHub batch-dispatch prompt. The GitHub picker that
// wrote it was removed on 2026-10-14; the threads it started still open on such a prompt, so transcript
// normalization still shows only the generated lead above this line as `displayText`. Namespacing +
// versioning make an ordinary HTML comment or markdown example inert.
export const GITHUB_DISPATCH_UI_BOUNDARY = "<!-- ntwine:github-dispatch-ui-boundary:v1 -->"

// ---- WAKE-DELIVERY TOKEN (scheduler ↔ transcript) ------------------------------------------------
// The scheduler appends this to every wake it delivers so the worker's own next user record proves the
// delivery landed (the outbox ack is `lastUserText.includes(wakeDeliveryToken(id))`) — which is exactly
// why the token must stay in the STORED text and can only ever be projected out for display.
//
// PRODUCER AND STRIPPER LIVE TOGETHER ON PURPOSE. The delivered message is recorded as an ordinary user
// turn, and the chat renders user text VERBATIM (a pre-wrap bubble, not markdown), so an unstripped
// token is shown to the human as literal `<!-- ntwine-wake:… -->`. A format change on one side without the
// other silently brings that back; keeping the pair adjacent is the guard.
// WHAT TIME IT IS, AND HOW LONG YOU HAVE BEEN GONE — because a broker-run worker is told neither.
//
// Measured 2026-08-19 on `read-the-file-read-up` (`claude_runtime = broker`, as 181 of that project's 338
// sessions are): its transcript contains ZERO system-reminders and ZERO date injections across its whole
// life. The runtime's env block does not reach a broker daemon, so these workers have no idea what day it
// is, let alone how long they have been parked.
//
// That is the root of arbitrary `for:` values. A worker writing `for: 1h` is not estimating badly — it
// has no clock to estimate against, and no way to notice that its last four parks each lasted four
// minutes. ELAPSED is the number that teaches it: "you last spoke 3h 12m ago" is the feedback that makes
// the next `for:` an actual judgement.
//
// ntwine cannot fix the runtime's env block, but every wake IT sends lands in the worker's context, so
// this rides along on all of them — one line, at the point every delivery passes through.
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

/** One line of wall clock, prepended to every ntwine delivery. Local time, because that is the clock the
 *  human reading the transcript is on. `lastAssistantAt` absent ⇒ the elapsed clause is dropped rather
 *  than guessed.
 *
 *  A THREAD WITH A TIME LIMIT (deadline.ts) also hears what is left of it — `· 42m left`, `· over by 8m`
 *  — so the worker sees its clock on every turn ntwine starts, not only at the check-ins. */
export function wakeTimeHeader(nowMs: number, lastAssistantAt?: string | null, deadlineMs?: number | null): string {
  const d = new Date(nowMs)
  const p2 = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  const since = lastAssistantAt ? Date.parse(lastAssistantAt) : NaN
  const elapsed = Number.isFinite(since) && nowMs >= since ? ` — you last spoke ${formatElapsed(nowMs - since)} ago` : ""
  const left = deadlineMs != null && Number.isFinite(deadlineMs) ? ` · ${formatDeadlineLeft(deadlineMs, nowMs, { precise: true })}` : ""
  return `⏱ ${stamp}${elapsed}${left}.`
}

// PRODUCER AND STRIPPER LIVE TOGETHER, the same pairing (and the same reason) as the human-gap note
// below: the line above is written FOR THE WORKER — it has no clock of its own — and it rides on a
// message the transcript then shows to a human, who has one. Rendered it is pure noise at the foot of
// every wake card, and on the one wake that is the human's OWN words (an answer to a registered
// question) it is worse than noise: the answers parser reads a trailing line as a continuation of the
// last answer, so ntwine's clock printed INSIDE the chip holding what the human chose. That exact defect
// was reported for the gap note on 2026-08-25 ("the freaking time stamps are still showing up in my
// question answers") and this is the same line arriving by the other door.
//
// Anchored to end-of-text on a line of its own and matched down to the wall clock, so prose that merely
// quotes one — a bug report pasting the line — stays in the bubble. Stripping is a DISPLAY projection
// only: the stored text keeps the stamp, which is the whole point of sending it.
const WAKE_TIME_HEADER_TAIL = /\n+⏱ \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: — you last spoke [^\n]*? ago)?(?: · (?:[^\n]*? left|over by [^\n]*?))?\.[ \t]*$/

/** Display projection: an ntwine wake without the clock line ntwine appended for the worker. */
export function stripWakeTimeHeader(text: string): string {
  return text.replace(WAKE_TIME_HEADER_TAIL, "")
}

// The trailers ntwine writes for the WORKER at the end of a wake it composed, declared with their
// producers above. Every one of them is a sentence about a registration the reader does not hold and a
// command the reader cannot run.
//
// THE TIMER'S TRAILER IS DELIBERATELY NOT HERE. `parseTimerWake` matches ON it — a fired one-off is the
// worker's own arbitrary prose, and that parenthetical is the only anchor saying which timer this was —
// so stripping it upstream would cost the divider it is there to draw. It comes off in the parser
// instead, which is the same outcome by the other route.
// The three a human-armed watch writes also strip in their pre-2026-10-08 wording (legacyHumanWording).
const HUMAN_WATCH_TRAILERS = [PR_WATCH_HUMAN_TRAILER, ISSUE_WATCH_HUMAN_TRAILER, PR_WATCH_HUMAN_QUIET_TRAILER]
const WAKE_TRAILERS = [PR_WATCH_ARMED_TRAILER, PR_WATCH_SPENT_TRAILER, ISSUE_WATCH_ARMED_TRAILER, ISSUE_WATCH_SPENT_TRAILER, LEGACY_PR_WATCH_ARMED_TRAILER, LEGACY_ISSUE_WATCH_ARMED_TRAILER, LEGACY_ISSUE_WATCH_CLI_ARMED_TRAILER, ...HUMAN_WATCH_TRAILERS, ...HUMAN_WATCH_TRAILERS.map(legacyHumanWording), SHELL_DONE_TRAILER]

/** Display projection: an ntwine wake without the agent-facing trailer ntwine appended for the worker.
 *
 *  Anchored to END-OF-TEXT, after the clock line and the delivery token have already come off (see
 *  `userDisplayText`, which composes the three in that order — the order they were appended in). Exact
 *  strings, never a shape: a paragraph that merely LOOKS like a trailer — a worker quoting one back, a
 *  human pasting one into a bug report — keeps it, and only the bytes ntwine itself wrote are dropped. */
export function stripWakeTrailer(text: string): string {
  for (const trailer of WAKE_TRAILERS) {
    const at = text.lastIndexOf(trailer)
    if (at < 0 || text.slice(at + trailer.length).trim() !== "") continue
    const head = text.slice(0, at).trimEnd()
    // A wake whose whole body IS the trailer keeps it. Nothing composes one today, but showing an empty
    // bubble is a worse failure than showing the boilerplate, and it is one line to make impossible.
    return head === "" ? text : head
  }
  return text
}

/** The gap the HUMAN left before replying, as a line ntwine appends to their message.
 *
 *  A worker has no clock of its own (a broker-run one is told neither the date nor the time by its
 *  runtime), so an answer arriving after four hours is indistinguishable from one arriving after four
 *  seconds. That matters for more than tone: a worker resuming on a stale premise will happily re-run a
 *  build whose result has since gone cold, or re-park on a shell that finished while nobody was reading.
 *
 *  Below the floor it returns undefined — a live back-and-forth needs no stamp on every turn, and a note
 *  on each one is noise that teaches nothing.
 *
 *  ATTRIBUTED, because the message it rides on is the human's and this line is not. ntwine names itself
 *  here for the same reason SIGNOFF_NUDGE_MARKER does. */
export const HUMAN_GAP_FLOOR_MS = 20 * 60_000

export function humanGapNote(nowMs: number, lastAssistantAt?: string | null): string | undefined {
  const since = lastAssistantAt ? Date.parse(lastAssistantAt) : NaN
  if (!Number.isFinite(since) || nowMs - since < HUMAN_GAP_FLOOR_MS) return undefined
  const d = new Date(nowMs)
  const p2 = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  return `⏱ ntwine: the message above arrived ${formatElapsed(nowMs - since)} after your last one. It is now ${stamp}.`
}

// PRODUCER AND STRIPPER LIVE TOGETHER, for the reason the wake token's pair does — except this one is
// worse if it drifts, because the text it rides on is the HUMAN'S OWN. The router appends the note only
// to the copy handed to the worker and leaves the bubble and the delivery ledger untouched; but the chat
// does not read either of those. It reads the worker's TRANSCRIPT, where the note is simply part of the
// user record — so it rendered inside the operator's own right-justified bubble, over their own words,
// as if they had typed it (reported 2026-08-20: "can we make these invisible? they're showing up in my
// own user messages"). Stripping it is a DISPLAY projection only: the stored text keeps the note, which
// is the whole point of sending it.
//
// Anchored to end-of-text on a line of its own, and required to match the note's FULL shape down to the
// wall clock, so a message that merely quotes one — a bug report pasting the line, this comment's own
// wording — is left in the bubble intact. The round-trip test over humanGapNote is what keeps a wording
// change on the producer from silently putting the note back in front of the human.
const HUMAN_GAP_NOTE_TAIL = /\n+⏱ ntwine: the message above arrived [^\n]* after your last one\. It is now \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.[ \t]*$/

/** Display projection: the human's message without the clock note ntwine appended for the worker. */
export function stripHumanGapNote(text: string): string {
  return text.replace(HUMAN_GAP_NOTE_TAIL, "")
}

/** A TYPED MESSAGE REACHING A WORKER THAT HAS QUESTIONS OPEN, with ntwine's note naming them — appended
 *  to the copy handed to the worker, exactly as humanGapNote is, and to that copy ONLY.
 *
 *  THE MESSAGE CHANGES NOTHING ABOUT THEM: each stays open until the human answers or dismisses it or the
 *  worker withdraws it. ntwine cannot tell a pivot from a side question; the worker can, so the note tells
 *  it to `unask` at once any the message moved past, and to name the rest under `questions:` when it
 *  rests — the rule the park-integrity check and the carried-questions nudge then hold it to.
 *
 *  Each question is named by its text AND its id, because `questions:` and `unask` take the id and the
 *  worker never chose one. Folded to one line and clipped, so the note stays ONE line and its stripper
 *  can anchor on it. Undefined with nothing open. */
export function openQuestionsNote(open: readonly { id: string; question: string }[]): string | undefined {
  if (open.length === 0) return undefined
  const named = open.map((q) => {
    const text = q.question.replace(/\s+/g, " ").trim()
    return `“${text.length > 100 ? `${text.slice(0, 99)}…` : text}” (${q.id})`
  })
  const count = open.length === 1 ? "1 question you registered is" : `${open.length} questions you registered are`
  return `❓ ntwine: ${count} still open: ${named.join(", ")}.${OPEN_QUESTIONS_NOTE_TAIL}`
}

const OPEN_QUESTIONS_NOTE_TAIL =
  " The message above leaves them open. If it moves past one — a new direction, a different priority — " +
  "`unask` that one NOW, before any other work: an open card keeps the thread waiting on the human while " +
  "the question scrolls away above the new work. Name each one still needed under `questions:` when you rest."

// The tail from 2026-09-29 to 2026-10-13. It deferred the withdrawal to the next rest, so a worker sent
// in a new direction kept a stale card open through the whole of the new work. Still stripped.
const OPEN_QUESTIONS_NOTE_TAIL_2026_10_13 =
  " The message above leaves them open. When you next rest, name each one you still need under " +
  "`questions:` in your ```awaiting fence, and withdraw the rest with `unask`."

// The note's earlier tails, when a typed message set questions aside and the worker opted one back in
// with `keep` (2026-10-02, then 2026-09-30). Still stripped, so a transcript written then does not start
// showing it in the human's bubble.
const OPEN_QUESTIONS_NOTE_TAIL_2026_10_02 =
  " They no longer hold this thread, and ntwine WITHDRAWS every one still set aside when you next come to " +
  "rest. `keep` one only if it is directly relevant to the message above — reworded with `question` if " +
  "the direction changed — and it rides to the bottom of your next handoff; let the rest go. If the work " +
  "later needs one of them, ask a new question then."

const OPEN_QUESTIONS_NOTE_TAIL_2026_09_30 =
  " Their cards stay answerable where they were asked, but no longer hold this thread. If the message " +
  "above did not move past one, `keep` it — reworded with `question` if the direction changed — and it " +
  "rides to the bottom of your next handoff; otherwise leave it."

// The note's tail before 2026-09-30, when a typed message left every question open. Still stripped, so a
// transcript written then does not start showing it in the human's bubble.
const OPEN_QUESTIONS_NOTE_TAIL_2026_09_29 =
  " If the message above made any of them moot, `unask` exactly those and say so; leave the rest open — " +
  "they are still the human's to answer, and still your sign-off."

// The stripper, for humanGapNote's reason exactly: the note rides the HUMAN'S message, and the chat reads
// the worker's transcript, where it is simply part of their bubble. Anchored to end-of-text on a line of
// its own and to the note's fixed opening AND closing words, so a message that quotes one keeps it.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const OPEN_QUESTIONS_NOTE_LINE = new RegExp(
  `\\n+❓ ntwine: (?:1 question you registered is|\\d+ questions you registered are) (?:still open|now set aside by this message): [^\\n]*(?:${escapeRegExp(OPEN_QUESTIONS_NOTE_TAIL)}|${escapeRegExp(OPEN_QUESTIONS_NOTE_TAIL_2026_10_13)}|${escapeRegExp(OPEN_QUESTIONS_NOTE_TAIL_2026_10_02)}|${escapeRegExp(OPEN_QUESTIONS_NOTE_TAIL_2026_09_30)}|${escapeRegExp(OPEN_QUESTIONS_NOTE_TAIL_2026_09_29)})[ \\t]*$`,
)

/** Display projection: the human's message without the open-questions note ntwine appended for the
 *  worker. */
export function stripOpenQuestionsNote(text: string): string {
  return text.replace(OPEN_QUESTIONS_NOTE_LINE, "")
}

/** Every rider ntwine appends to the worker's copy of a TYPED follow-up, off, in the reverse of the order
 *  the router appends them (the gap note, then the open-questions note). The one call every display and
 *  match key should make, so a rider added later cannot be stripped in one place and shown in another. */
export function stripFollowUpRiders(text: string): string {
  return stripHumanGapNote(stripOpenQuestionsNote(text))
}

export function wakeDeliveryToken(id: string): string {
  return `<!-- ntwine-wake:${id} -->`
}

// Anchored to end-of-text with its leading blank line, matching how context.ts appends it. Requiring
// that trailing position (rather than matching anywhere) keeps prose that merely quotes the token —
// this comment's own wording, a bug report pasting one — intact in the bubble.
const WAKE_DELIVERY_TOKEN_TAIL = /\n*<!-- ntwine-wake:[A-Za-z0-9_-]+ -->\s*$/

// The token wherever it sits ON A LINE OF ITS OWN. That is how the scheduler always writes it, and it
// is never how prose quotes one — a human asking "why is <!-- ntwine-wake:… --> in my bubble?" writes it
// mid-sentence, which this deliberately leaves alone (see the transcript test of exactly that).
//
// The tail anchor above is the RULE; this is the BACKSTOP. The tail is only correct while one record
// holds one delivery, and the runtime breaks that whenever two land while the worker is mid-turn
// (splitWakeDeliveries, below). Splitting restores the anchor — but the split has to model how the
// runtime joins, and that is not ntwine's format to pin. So the display strip refuses to depend on it:
// a token on its own line is machine plumbing wherever it ended up, and no shape the runtime invents
// next can put one in front of the human again.
const WAKE_DELIVERY_TOKEN_LINE = /(?:^|\n)[ \t]*<!-- ntwine-wake:[A-Za-z0-9_-]+ -->[ \t]*(?=\n|$)/g

// Display projection: the steer the human is meant to read, without the machine-facing token.
export function stripWakeDeliveryToken(text: string): string {
  const out = text.replace(WAKE_DELIVERY_TOKEN_LINE, "")
  // The blank line the token sat behind is its punctuation, not the message's — a token that LED the
  // text leaves one at the top, one that closed it leaves one at the bottom. Both go with it, and only
  // when something was actually removed, so an ordinary message with trailing whitespace does not
  // acquire a display projection (userDisplayText treats "changed" as "worth sending to the client").
  return out === text ? text.replace(WAKE_DELIVERY_TOKEN_TAIL, "") : out.replace(/^\n+/, "").replace(/\s+$/, "")
}

// Was this user turn WRITTEN BY NTWINE rather than by the human? The token rides only on a scheduler
// delivery, so its presence is the one unambiguous tell — and it matters for presentation: a wake
// rendered in the human's own off-white right-justified bubble claims the operator typed it, when in
// fact ntwine is reporting something it noticed. The chat renders these as a first-party card instead.
export function isWakeDelivery(text: string): boolean {
  return WAKE_DELIVERY_TOKEN_TAIL.test(text)
}

// A COALESCED delivery: several outbox messages merged by the runtime into ONE user record.
//
// Everything above assumes one record carries one delivery — the token is anchored to the END, and both
// the display strip and every downstream parse (the recurring-prompt trailer, the GitHub steer) read
// from there. That assumption breaks whenever two deliveries land while the worker is mid-turn: the
// runtime hands the model one user message holding both, joined by a newline, each still carrying its
// own token. The record then ends in a token — so `isWakeDelivery` says yes and the strip takes the
// LAST one — while the first delivery's own token and trailer are stranded in the middle, where no
// anchored parse can see them. That is exactly how a recurring prompt lost its `Recurring prompt · at
// rest` divider and rendered instead as a generic bell card with the whole run of deliveries inside it,
// interior `<!-- ntwine-wake:… -->` and all (measured: 14 of 380 real deliveries on this machine).
//
// So cut the record back into the deliveries the scheduler actually sent, and let each one be projected
// on its own. A boundary is a token line WITH MORE CONTENT AFTER IT — the token ends a delivery, so
// anything below it came from the next one. Deliberately not keyed on the runtime's joiner (measured
// today as a single "\n"): that is its format, not ntwine's, and a fix that hard-codes it silently stops
// working the day it changes. Whitespace between segments is dropped with the join.
/** One user record → the deliveries it carries, each ending in its own token. `[text]` when it carries
 *  a single delivery (or none), so every caller can treat the split as the general case. */
export function splitWakeDeliveries(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (const m of text.matchAll(WAKE_DELIVERY_TOKEN_LINE)) {
    const end = m.index + m[0].length
    if (!text.slice(end).trim()) break // the LAST token — it closes the record, so nothing follows it
    out.push(text.slice(start, end))
    start = end
  }
  if (out.length === 0) return [text]
  const rest = text.slice(start).replace(/^\s*\n/, "")
  if (rest.trim()) out.push(rest)
  return out
}

// ---- A MERGED delivery: several of ntwine's OWN wakes, sent as one message --------------------------
// The other way one record comes to hold several wakes, and the one ntwine composes itself. The scheduler
// holds a thread's wakes through a quiet window and sends everything waiting for it as ONE message
// (scheduler `adoptCompanions`): a lead sentence, then each wake's own text under a numbered heading,
// then one clock. One delivery, one token — so `splitWakeDeliveries` above sees a single wake, and every
// parser that reads a wake from its first line reads the lead instead.
//
// THE COMPOSER AND THE SPLITTER SIT TOGETHER HERE because they did not, from the day the merge shipped
// (2026-09-03) until 2026-10-11: the composer lived in the scheduler, where the chat cannot reach it, so
// the envelope had no parser and fell through `NtwineWake` to the verbatim card — both wakes' agent-facing
// bodies, in a bordered box, in the human's transcript. It is not a rare shape: a park ending and the
// shell whose exit ended it are caused by one event, so they are queued together and merged every time
// (maintainer 2026-10-11, on exactly that pair: "I'm so tired of these unformatted shitty ntwine blocks
// showing up"). Same rule as every formatter above — the parser has to sit beside it, and only this
// package is reachable from both sides.
const MERGED_WAKE_LEAD = /^[Nn]twine held (\d+) wakes for this thread and is delivering them together, oldest first\. Each is under its own heading; read all of them before acting on any\.(?=\n|$)/
// A section heading, with the blank line the composer always puts on both sides of it.
const MERGED_WAKE_HEADING = /\n\n### (\d+)\. [^\n]*?(?: — (\d+) identical events)?\n\n/g

/** Several wakes as ONE message: each under its own reason line, oldest first, and ONE clock at the foot
 *  in place of the one each ntwine-authored part carried (a stamp per section would put five clocks in
 *  one message; the display stripper is anchored to a single trailing one). Parts whose reason AND body
 *  are identical — the same review event reported by two polls, the same "CI passing" twice — fold into
 *  one section that says how many there were, rather than saying the same thing three times to a reader
 *  who pays per token to read it. `deadlineMs` is the thread's time limit, which the clock names as every
 *  lone wake's does (server deadline.ts). */
export function mergedWakeMessage(frame: readonly { reason: string; message: string }[], nowMs: number, lastAssistantAt?: string | null, deadlineMs?: number | null): string {
  const sections: { reason: string; body: string; count: number }[] = []
  for (const part of frame) {
    const body = stripWakeTimeHeader(part.message).trim()
    const same = sections.find((s) => s.reason === part.reason && s.body === body)
    if (same) same.count++
    else sections.push({ reason: part.reason, body, count: 1 })
  }
  const lead = `ntwine held ${frame.length} wakes for this thread and is delivering them together, oldest first. Each is under its own heading; read all of them before acting on any.`
  const body = sections.map((s, i) => `### ${i + 1}. ${s.reason}${s.count > 1 ? ` — ${s.count} identical events` : ""}\n\n${s.body}`)
  return `${lead}\n\n${body.join("\n\n")}\n\n${wakeTimeHeader(nowMs, lastAssistantAt, deadlineMs)}`
}

/** One wake out of a merged delivery: its own message, exactly as it would have read arriving alone
 *  (minus its clock, which the composer took off), and how many identical events it stands for. */
export interface MergedWakePart {
  body: string
  count: number
}

/** A merged delivery cut back into the wakes it carries, or `null` for anything else.
 *
 *  The lead and the reason lines are NOT returned: they are the envelope, written for a worker reading
 *  five things at once, and each part is drawn by whatever draws that wake alone. The delivery token and
 *  the clock may still be on the text or already stripped — both come off here, so the raw record and
 *  its display projection parse alike.
 *
 *  IT REFUSES RATHER THAN GUESSES. Most parts are ntwine's own sentences, but a Goal prompt or a timer's
 *  text is arbitrary prose and may carry numbered headings of its own — and nothing in the envelope says
 *  which `### 2.` is the scheduler's. So every such heading must be a boundary, numbered 1, 2, 3 in
 *  order, and the parts must add up to the count the lead declares; anything else is no split, and the
 *  text reaches the fallback card whole. A cut inside someone's prose would hand the chat one wake that
 *  ends mid-thought and another that starts there, and drop the heading line between them. */
export function parseMergedWake(text: string): MergedWakePart[] | null {
  const whole = stripWakeTimeHeader(stripWakeDeliveryToken(text).trimEnd()).trim()
  const lead = MERGED_WAKE_LEAD.exec(whole)
  if (!lead) return null
  const heads: { at: number; end: number; count: number }[] = []
  for (const m of whole.matchAll(MERGED_WAKE_HEADING)) {
    if (Number(m[1]) !== heads.length + 1) return null
    heads.push({ at: m.index, end: m.index + m[0].length, count: m[2] ? Number(m[2]) : 1 })
  }
  // The first heading follows the lead directly; anything between them is not this envelope.
  if (heads.length === 0 || heads[0].at !== lead[0].length) return null
  const parts = heads.map((head, i) => ({ body: whole.slice(head.end, heads[i + 1]?.at ?? whole.length).trim(), count: head.count }))
  if (parts.some((part) => !part.body)) return null
  return parts.reduce((sum, part) => sum + part.count, 0) === Number(lead[1]) ? parts : null
}

// ---- harness plumbing that arrives dressed as a user turn -----------------------------------------
// A user record that is not the human speaking: a task-notification from a background child, a bare
// system-reminder wrapper, an ntwine orchestrator pulse. Matched on the LEADING tag so a human message
// that merely QUOTES one of these somewhere inside still counts as the human.
//
// THIS IS THE SHARED CLASSIFIER, and it is shared for a reason. It used to live in transcript.ts alone,
// so the chat DROPPED these records while the tailer's fold counted them as ordinary user turns — two
// projections of one transcript disagreeing about whether the human had spoken. That is what let a
// thread render an unanswered ```question card and the working shimmer AT THE SAME TIME, in the Active
// rail rather than the queue (maintainer 2026-08-24: "this needs to be structurally impossible").
// Anything that decides what the HUMAN owes must ask this question the same way the chat does.
//
// `[Cross-session ` is Claude Code's own notice about a PEER session (2.1.280+): `[Cross-session idle
// notice] "<name>" … is idle now`, answering a `SendMessage` subscription, and `[Cross-session delivery
// notice]`, reporting that a peer held or refused this session's message. Both say of themselves that
// they are "not a message from a person", and both reach the queue exactly like a typed follow-up — so
// until this prefix they rendered as the operator's own gray bubble. A peer's actual MESSAGE is not
// plumbing and is not matched here; see parseCrossSessionMessage.
const NOISE_PREFIXES = ["<task-notification>", "[SYSTEM NOTIFICATION", "<system-reminder>", "<ntwine-", "[ntwine]", "[Cross-session "]
export function isInjectedNoise(text: string): boolean {
  const t = text.trimStart()
  return NOISE_PREFIXES.some((p) => t.startsWith(p))
}

/** Is this whole record plumbing? The prefix check above answers that for ONE message, and a record may
 *  hold several — a coalesced record LED by a relay is plumbing in its first segment and a real delivery
 *  in its second, and dropping it whole would silently swallow the delivery. */
export function isAllInjectedNoise(text: string): boolean {
  return splitWakeDeliveries(text).every(isInjectedNoise)
}

// ---- THE agent-to-agent UPWARD message (a sub-agent reporting to its parent) ----------------------
// Claude Code's own wrapper for a message that arrived through the agent-to-agent channel — what a
// BACKGROUND CHILD produces by calling `SendMessage({to:"main"})`. It is delivered into the parent's
// input queue exactly like a human follow-up, so the parent's transcript records it as a user turn
// carrying this wrapper as its literal text. Recognizing it is what stops a child's report from
// rendering as the operator's own bubble with raw XML showing (the `wake` defect, one channel over).
//
// Anchored to the START of the text and required to close, so prose that merely QUOTES a wrapper — this
// repo's own tests and docs do — is left alone. `from` is the sender label; today that is the child's
// `subagent_type` (the worker dispatch hook strips `name`), so it is NOT unique across siblings — the
// delivery record's `origin.senderTaskId` is the unambiguous id, and the parser deliberately does not
// invent one here.
const AGENT_MESSAGE_WRAPPER = /^<agent-message from="([^"]*)">\n?([\s\S]*?)\n?<\/agent-message>\s*$/

// Parse an upward agent-to-agent message into its sender label and body, or undefined when `text` is
// not one. The body is returned verbatim (minus the wrapper's own framing newlines) — it is the part a
// human actually reads, and the part the transcript projects as `displayText`.
export function parseAgentMessage(text: string): { from: string; body: string } | undefined {
  const m = AGENT_MESSAGE_WRAPPER.exec(text.trim())
  if (!m) return undefined
  const from = m[1].trim()
  const body = m[2]
  // A wrapper with no readable body, or none naming its sender, is plumbing rather than a report. Both
  // degrade to the ordinary user path (a plain bubble) instead of an empty or unattributed child card —
  // the label is the whole point of the card, so inventing one would be worse than not drawing it.
  if (!body.trim() || !from) return undefined
  return { from, body }
}

// ---- A MESSAGE FROM ANOTHER CLAUDE SESSION (a peer thread, not a sub-agent) ----------------------
// What one top-level session's `SendMessage({to:"ntwine-75"})` delivers into ANOTHER session — a
// coordinator thread steering a thread it spawned, say. Claude Code writes it in two places, and both
// carry the same wrapper:
//
//   • the queue enqueue, the `queued_command` attachment and the removal: the bare wrapper;
//   • the delivery record of an idle session: the wrapper behind a fixed preamble and in front of a
//     paragraph of handling guidance addressed to the receiving agent.
//
//   <cross-session-message from="uds:/tmp/cc-socks/2908.sock" from-name="ntwine-11" from-mode="bypass">
//   …the body…
//   </cross-session-message>
//
// Left alone it renders as the operator's own bubble with the XML showing. `from` is the sender's
// messaging socket, `from-name` its Claude Code session name (`<cwd basename>-<2 hex>`, which is not a
// ntwine thread name and is not unique). The server turns the socket into the sending THREAD (see
// session-peer.ts); this parser only takes the wrapper apart. Anchored at both ends, so prose that quotes
// a wrapper stays prose.
const CROSS_SESSION_PREAMBLE = /^Another Claude session sent a message(?: while you were working)?:\n/
const CROSS_SESSION_WRAPPER = /^<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/
const CROSS_SESSION_GUIDANCE = "This came from another Claude session"
const XML_ATTRIBUTE = /([a-z][a-z-]*)="([^"]*)"/g

function decodeXmlAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

export function parseCrossSessionMessage(text: string): { name?: string; socket?: string; body: string } | undefined {
  let rest = text.trim()
  const preamble = CROSS_SESSION_PREAMBLE.exec(rest)
  if (preamble) rest = rest.slice(preamble[0].length)
  const m = CROSS_SESSION_WRAPPER.exec(rest)
  if (!m) return undefined
  // After the wrapper: nothing, or the delivery record's guidance paragraph — never more of the human's
  // own words, which would mean this is prose that happens to open on a quoted wrapper.
  const after = rest.slice(m[0].length).trim()
  if (after && !after.startsWith(CROSS_SESSION_GUIDANCE)) return undefined
  const attributes = new Map<string, string>()
  for (const [, key, value] of m[1].matchAll(XML_ATTRIBUTE)) attributes.set(key, decodeXmlAttribute(value).trim())
  const body = m[2].trim()
  const name = attributes.get("from-name") || undefined
  const socket = attributes.get("from") || undefined
  // No body, or no sender at all, is nothing to attribute: a line naming nobody would be worse than the
  // ordinary path.
  if (!body || !(name || socket)) return undefined
  return { ...(name ? { name } : {}), ...(socket ? { socket } : {}), body }
}

// ---- A message from ANOTHER NTWINE THREAD (`ntwinectl message-thread`) ---------------------------------
// FORMATTER AND PARSER LIVE TOGETHER, for the reason the PR-watcher steer below gives: the scheduler
// pastes this text into the recipient's composer as a wake, and the chat has nothing but the text to
// rebuild the sender, the body and whether it answered a wait from. The agent-facing instructions after
// the `---` are for the recipient worker; the parser drops them, so the human reads only what was said.
export function threadMessageBody(input: { fromHandle: string; message: string; awaitsReply?: boolean; answersWait?: boolean; fromProject?: string }): string {
  const from = input.fromHandle
  // A sender in ANOTHER project is still answered by its bare handle: a handle this project's threads do
  // not carry resolves in the other open projects (router resolveElsewhere).
  const where = input.fromProject ? `in the ${input.fromProject} project` : "in this project"
  const how = input.awaitsReply
    ? `@${from} is WAITING on your answer — it is parked until you reply. Answer with ` +
      `\`ntwinectl message-thread ${from} --message-file -\` as soon as you can, even if only to say you cannot help; it ` +
      "reaches that thread, not the user."
    : `Answer with \`ntwinectl message-thread ${from} --message-file -\` only if it asks you something; it reaches that ` +
      "thread, not the user. Do not reply just to acknowledge."
  return [
    `Message from @${from}, another ntwine thread ${where}${input.answersWait ? THREAD_MESSAGE_ANSWERS : ""}:`,
    "",
    input.message,
    "",
    "---",
    `${how} Do not drop your own work for it unless it matters to that work. ` +
      `\`ntwinectl read-thread ${from}\` reads @${from}'s own request, approach and latest handoff.`,
  ].join("\n")
}

const THREAD_MESSAGE_ANSWERS = " — this answers the message you were waiting on"
const THREAD_MESSAGE_HEAD = /^Message from @([^\s,]+), another [Nn]twine thread (?:in this project|in the (.+?) project)( — this answers the message you were waiting on)?:\n\n/
// The instructions open on one of exactly two sentences, so a `---` the SENDER wrote inside its message
// is never mistaken for the trailer. `mcp__ntwine__message_thread` is how they named the reply until
// 2026-10-12, and every message already in a transcript still ends that way.
const THREAD_MESSAGE_TRAILER = /\n\n---\n(?:@[^\s]+ is WAITING on your answer|Answer with `(?:mcp__ntwine__message_thread|ntwinectl message-thread)\b)[\s\S]*$/

export function parseThreadMessage(text: string): { from: string; project?: string; answersWait: boolean; awaitsReply: boolean; body: string } | undefined {
  const head = THREAD_MESSAGE_HEAD.exec(text)
  if (!head) return undefined
  const rest = text.slice(head[0].length)
  const trailer = THREAD_MESSAGE_TRAILER.exec(rest)
  const body = (trailer ? rest.slice(0, trailer.index) : rest).trim()
  if (!body) return undefined
  return {
    from: head[1],
    ...(head[2] ? { project: head[2] } : {}),
    answersWait: Boolean(head[3]),
    awaitsReply: Boolean(trailer && trailer[0].startsWith("\n\n---\n@")),
    body,
  }
}

// ---- THE PR-WATCHER WAKE STEER (scheduler ↔ chat card) -------------------------------------------
// FORMATTER AND PARSER LIVE TOGETHER, for the same reason the token and its stripper do. The scheduler
// composes this string and pastes it into a worker's composer; the chat then has nothing BUT that
// string to rebuild a first-party card from, because the structured activity lives in the scheduler's
// own cursor (keyed by fence generation) and never reaches the transcript. Two definitions of one
// format in two packages is a silent drift waiting to happen — a wording tweak on the producer would
// quietly downgrade every card in the chat to a plain text blob. Keeping the pair adjacent, with a
// round-trip test over both, is the guard.

// Zod rather than a bare interface because the SERVER hands the parsed steer to the chat on the
// transcript message (TranscriptMessage.wakeSteer), so it has to survive wire validation.
export const GithubWakeItem = z.object({
  label: z.string(), // the activity's noun ("comment", "approval", "change request", …)
  actor: z.string(), // GitHub login, no leading @
  bot: z.boolean(), // drives the 🤖/👤 icon; an app files most of what wakes this watcher
  at: z.string().optional(), // ISO8601
  url: z.string().optional(), // the item's own permalink
})
export type GithubWakeItem = z.infer<typeof GithubWakeItem>

export const GithubWakeSteer = z.object({
  ref: z.string(), // owner/repo#N
  items: z.array(GithubWakeItem),
  omitted: z.number(), // fresh items counted but not named (the enumeration cap)
})
export type GithubWakeSteer = z.infer<typeof GithubWakeSteer>

const WAKE_SCOPE = "ignore older activity you have already handled"

function wakeItemTail(item: GithubWakeItem): string {
  // The URL goes LAST and carries no trailing punctuation, so terminal autolinkers cannot swallow a
  // following period into the href.
  return `${item.at ? ` at ${item.at}` : ""}${item.url ? `: ${item.url}` : ""}`
}

// ---- the review-read tail -------------------------------------------------------------------------
// A review's substance is routinely NOT its body. A review app files an empty-bodied review carrying N
// inline comments, so the permalink above lands on an anchor whose obvious read — `gh api …/reviews/ID`
// — hands back `body: ""` and the worker has to GUESS where the content went.
//
// A worker woken by exactly that spent FOUR calls getting to it (2026-07-31, nubjs/nub#587): the body,
// the body again in full to be sure, a `…/pulls/N/comments` sweep filtered by `pull_request_review_id`
// that silently hit the 100-item default page, and finally the same sweep with `--paginate`. The one
// endpoint that answers the question in a single call — `…/pulls/N/reviews/ID/comments` — was never
// reached. So the steer names that call outright, fully materialized, once per review it woke for.
//
// The tail is DERIVED from the items and never stored: the parser drops these lines and rebuilds the
// steer from the header and item lines alone, which is what keeps the round-trip exact without adding a
// field to GithubWakeSteer. It is also invisible to the human — NtwineWake renders from the PARSE,
// not from this text — so it costs the card nothing to speak to the worker here.
const WAKE_REVIEW_LEAD = "A review's body is often empty because its substance is inline comments. Read them, one call each:"

// The review permalink is the only place the review id exists, but owner/repo/number come from `ref`,
// which the wake format already validates — so a surprising URL costs the hint, never a wrong command.
function wakeReviewReads({ ref, items }: GithubWakeSteer): string[] {
  const [repo, number] = ref.split("#")
  const ids = new Set<string>()
  for (const item of items) {
    const id = /#pullrequestreview-(\d+)$/.exec(item.url ?? "")?.[1]
    if (id) ids.add(id)
  }
  return [...ids].map((id) => `gh api --paginate repos/${repo}/pulls/${number}/reviews/${id}/comments`)
}

function wakeReviewTail(steer: GithubWakeSteer): string {
  const reads = wakeReviewReads(steer)
  return reads.length ? `\n\n${WAKE_REVIEW_LEAD}\n${reads.join("\n")}` : ""
}

// ---- the BACKLOG tail -----------------------------------------------------------------------------
// The one wake that names activity which is NOT new: the first time a thread parks on a given PR, the
// watcher hands over whatever was already sitting there (maintainer 2026-08-12, choosing this over a
// card that merely mentions it). A worker had parked on a Zod PR (#6318) saying "waiting on review"
// with two unread reviews already on it, and the old baseline recorded them as handled — so the watcher
// slept on the very thing it was watching for.
//
// It rides as a derived TAIL on the ordinary burst shape rather than a third header, for the reason the
// parser documents below: an unrecognized line under the header is DROPPED, so every already-open tab
// renders this card exactly as before. A new header shape would have made them all fall back to prose.
//
// `backlog` is deliberately NOT a GithubWakeSteer field — it is an argument. Putting it in the schema
// would break the parse round-trip (the parser cannot recover it from the text), and that round-trip is
// the contract that keeps formatter and parser from drifting.
const WAKE_BACKLOG_TAIL =
  "These were already on the PR when you parked, so you may have handled some. Check what is still" +
  " unaddressed, deal with it, and re-park — this is the only time ntwine replays a PR's existing" +
  " activity to you."

/** Is this delivered steer the FIRST-PARK REPLAY rather than news?
 *
 *  The chat needs to tell them apart, because they read as opposite things: activity that landed while
 *  the worker was parked is an event, and a PR's pre-existing history is not (maintainer 2026-08-13:
 *  "That already is preexisting on the PR, which I find quite weird… For PRs that have been around for a
 *  long time, it's going to render like a hundred reviews").
 *
 *  Matched on the TAIL rather than carried in `GithubWakeSteer`, which keeps the formatter's round-trip
 *  intact — see the note above on why `backlog` is an argument and not a field. A legacy transcript
 *  written before the tail existed simply reads as not-a-backlog, which is what it was. */
export function isGithubWakeBacklog(text: string | undefined): boolean {
  return typeof text === "string" && text.includes(WAKE_BACKLOG_TAIL)
}

export function formatGithubWakeSteer({ ref, items, omitted }: GithubWakeSteer, opts: { backlog?: boolean } = {}): string {
  const icon = items.some((i) => !i.bot) ? "👤" : "🤖"
  const reviewTail = wakeReviewTail({ ref, items, omitted }) + (opts.backlog ? `\n\n${WAKE_BACKLOG_TAIL}` : "")
  if (items.length === 1 && omitted === 0) {
    const item = items[0]
    const url = item.url ? `: ${item.url}` : "."
    return `${icon} New GitHub ${item.label} on ${ref} from @${item.actor}${item.at ? ` at ${item.at}` : ""}. Read that exact ${item.label} — ${WAKE_SCOPE} — and continue${url}${reviewTail}`
  }
  const more = omitted > 0 ? `\n- …and ${omitted} more not listed — check ${ref} for the rest` : ""
  // The blank line separates the instruction from the items. ntwine's transcript renders a delivered
  // wake as PLAIN TEXT with line breaks preserved, so this buys a paragraph break rather than an <li>,
  // and it keeps the two readable as distinct parts in a terminal composer too.
  // Each line carries its OWN 🤖/👤. A burst routinely mixes a maintainer's comment with a review
  // app's output, and "who is a person here" is the first thing both the worker and a human scanning
  // the card want — the header icon alone cannot say it, and a login is not a reliable tell (@pullfrog
  // is a GitHub App with no `[bot]` suffix). It is also what makes the format round-trip losslessly.
  const lines = items.map((i) => `- ${i.bot ? "🤖" : "👤"} ${i.label} from @${i.actor}${wakeItemTail(i)}`).join("\n")
  return `${icon} ${items.length + omitted} new GitHub items on ${ref}. Read exactly these — ${WAKE_SCOPE} — and continue:\n\n${lines}${more}${reviewTail}`
}

const WAKE_REF = String.raw`[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d+`
const WAKE_SINGLE = new RegExp(
  String.raw`^(👤|🤖) New GitHub (.+?) on (${WAKE_REF}) from @(\S+?)(?: at (\S+?))?\. Read that exact .+? — ` +
    WAKE_SCOPE +
    String.raw` — and continue(?::\s*(\S+)|\.)$`,
)
const WAKE_MULTI_HEAD = new RegExp(
  String.raw`^(👤|🤖) (\d+) new GitHub items on (${WAKE_REF})\. Read exactly these — ` + WAKE_SCOPE + String.raw` — and continue:$`,
)
const WAKE_ITEM = /^- (👤|🤖) (.+?) from @(\S+?)(?: at (\S+?))?(?:: (\S+))?$/
const WAKE_MORE = /^- …and (\d+) more not listed — check .+ for the rest$/

// Rebuild the structured wake from its delivered text. `null` for anything that is not one of the two
// shapes above — the chat then falls back to rendering the text as-is, so a format the parser does not
// know costs a card, never the message.
//
// It is the FALLBACK path now: the server parses at projection time and hands the result over on
// `TranscriptMessage.wakeSteer`, so a current client never re-derives the card from prose. This still
// runs for a legacy transcript and for a server too old to send the field.
//
// UNRECOGNIZED LINES ARE DROPPED, not refused. That is the correction for a real defect: the steer
// gained a review-read tail (c741fb1), the parser learned an allowlist for exactly those two line
// shapes — and every ALREADY-OPEN tab, whose bundle predated it, started rendering the raw-text
// fallback card instead of the divider. Nothing reloads those tabs: `web/api/boot.ts` adopts a new
// server boot id in place on purpose, so an unsent draft survives a restart, which means a promoted
// artifact routinely leaves an old parser reading a new format. An allowlist has to be taught each new
// line and is wrong until it is; dropping what it does not recognize is right in advance. Structural
// integrity rides on the header's own COUNT instead (below), which is what actually catches a
// misread — a truncated or padded burst still returns null.
export function parseGithubWakeSteer(text: string): GithubWakeSteer | null {
  // Absent fields are OMITTED rather than set to undefined, so a parsed steer is deep-equal to the one
  // the formatter was handed — which is what makes the round-trip test a real contract.
  const item = (label: string, actor: string, bot: boolean, at?: string, url?: string): GithubWakeItem => ({
    label,
    actor,
    bot,
    ...(at ? { at } : {}),
    ...(url ? { url } : {}),
  })
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // The FIRST line decides the shape. Anything below a single-item steer is agent-facing prose the
  // formatter derived (today the review-read tail, tomorrow whatever the next steer gains) — the card
  // has nothing to render from it, so it never gets a say in whether the card renders at all.
  const single = WAKE_SINGLE.exec(lines[0] ?? "")
  if (single) {
    return { ref: single[3], omitted: 0, items: [item(single[2], single[4], single[1] === "🤖", single[5], single[6])] }
  }
  const head = WAKE_MULTI_HEAD.exec(lines[0] ?? "")
  if (!head) return null
  const items: GithubWakeItem[] = []
  let omitted = 0
  for (const line of lines.slice(1)) {
    const more = WAKE_MORE.exec(line)
    if (more) {
      omitted = Number(more[1])
      continue
    }
    const m = WAKE_ITEM.exec(line)
    if (!m) continue // prose below the burst, not an item — see the header-count check below
    items.push(item(m[2], m[3], m[1] === "🤖", m[4], m[5]))
  }
  // The header's own count is the authority on how many landed; disagreeing with it means we misread.
  // Now that an unrecognized line is skipped rather than refused, this is the WHOLE integrity check —
  // a burst that lost a line to truncation, gained one to corruption, or whose item shape drifted out
  // from under this parser lands here and returns null, exactly as before.
  if (!items.length || items.length + omitted !== Number(head[2])) return null
  return { ref: head[3], omitted, items }
}

// ---- THE PR-WATCH STATUS LINE --------------------------------------------------------------------
// The other half of what a registered PR watcher says, and the half that had no parser: a PR reaching a
// terminal state, and CI reaching a terminal verdict. `prWatchWakeMessage` (above) writes both; this
// reads them back, and the pair round-trips in github-wake.test.ts for the same reason the steer's pair
// does — one wording tweak on the producer would otherwise silently downgrade every one of these to a
// raw-text blob in the chat.
//
// Which is exactly what it was doing. A watcher's REVIEW activity has rendered as a hairline divider
// since the card died (see NtwineWake), but "#760 was CLOSED" and "CI PASSED on #761" fell through
// to the fallback card — so the same watcher, on the same PR, spoke in two completely different voices
// down one transcript, and the louder voice was the one carrying the least news (maintainer 2026-08-18,
// with a screenshot of two full-width CLOSED cards under a run of hairlines: "these callouts should
// obviously be hairlines").
//
// It reads ONE line out of a delivery that may carry several parts — a CI verdict and a review steer
// arrive together when one poll saw both — so the caller parses this AND `parseGithubWakeSteer`, and
// renders a divider per part. Everything else in the message is the agent-facing trailer (the
// still-armed / watcher-is-spent parenthetical), which is boilerplate ntwine wrote for the worker and
// has nothing to say to a human.
export type PrWatchWake =
  | { ref: string; kind: "merged" | "closed" }
  // `passed` is absent on a failure because the FORMATTER does not write it — a red line names the
  // failing jobs, not the tally. Never invent a field the text does not carry. `skipped` is absent on a
  // green line that had none, for the same reason: the formatter omits the clause entirely.
  | { ref: string; kind: "ci"; verdict: "passing" | "failing"; passed?: number; skipped?: number; failing: string[] }
  // CI HELD FOR AN APPROVAL, which is neither a pass nor a failure and must not be drawn as one.
  | { ref: string; kind: "ci"; verdict: "gated"; gated: number; gating: string[] }

const PR_WATCH_FINISHED = new RegExp(String.raw`^⏰ (${WAKE_REF}) was (MERGED|CLOSED)\.$`)
// The skip clause is OPTIONAL because the formatter omits it when nothing was skipped — a green line
// with no skips reads exactly as it did before 2026-09-04, so every delivery already in a transcript
// still parses.
const PR_WATCH_CI_PASSED = new RegExp(String.raw`^✅ CI PASSED on (${WAKE_REF}) — (\d+) checks? green(?:, (\d+) skipped)?\.$`)
const PR_WATCH_CI_GATED = new RegExp(String.raw`^⏸️ CI on (${WAKE_REF}) is WAITING FOR APPROVAL — (\d+) workflows? held(?:: (.+?))?\.$`)
const PR_WATCH_STATE = new RegExp(String.raw`^🔔 (${WAKE_REF}): (.+)\.$`)

/** The PR's own state moving — a conflict appearing, a label added or dropped, a reviewer requested.
 *
 *  ITS OWN PARSER RATHER THAN A `PrWatchWake` VARIANT, because it coexists with one: a poll that sees CI
 *  go red AND a label move says both, and `parsePrWatchWake` returns the FIRST line it recognizes. Two
 *  parsers means two dividers, which is what the CI line and the review steer already do down the same
 *  delivery. The clauses are kept as ONE opaque string: they are prose ntwine composed for the worker,
 *  and the chat's job is to show them, not to re-derive what they meant. */
export interface PrWatchStateWake { ref: string; detail: string }

export function parsePrWatchStateWake(text: string): PrWatchStateWake | null {
  for (const raw of text.split("\n")) {
    const m = PR_WATCH_STATE.exec(raw.trim())
    if (m) return { ref: m[1], detail: m[2] }
  }
  return null
}
const PR_WATCH_CI_FAILED = new RegExp(String.raw`^❌ CI FAILED on (${WAKE_REF})(?:: (.+?))?\.$`)

/** The PR-watch status part of a delivered wake, or `null` when the text carries none.
 *
 *  SCANS rather than reading line 0, unlike `parseGithubWakeSteer`: this line can sit above a review
 *  steer, below it in a legacy delivery, or alone. The three shapes are specific enough that scanning
 *  costs nothing — each names its own emoji, its own verb and an `owner/repo#N`. */
export function parsePrWatchWake(text: string): PrWatchWake | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const done = PR_WATCH_FINISHED.exec(line)
    if (done) return { ref: done[1], kind: done[2] === "MERGED" ? "merged" : "closed" }
    const passed = PR_WATCH_CI_PASSED.exec(line)
    if (passed) {
      return {
        ref: passed[1], kind: "ci", verdict: "passing", passed: Number(passed[2]), failing: [],
        ...(passed[3] ? { skipped: Number(passed[3]) } : {}),
      }
    }
    const gated = PR_WATCH_CI_GATED.exec(line)
    // Same comma-split caveat as the failing branch below, and the same cost: a workflow whose name
    // contains ", " is listed as two. Never the divider, never the verdict.
    if (gated) return { ref: gated[1], kind: "ci", verdict: "gated", gated: Number(gated[2]), gating: gated[3] ? gated[3].split(", ") : [] }
    const failed = PR_WATCH_CI_FAILED.exec(line)
    // The formatter joins the job names with ", ", so a job whose own name contains a comma-space splits
    // wrong here. It costs a label that lists one job as two — never the divider, and never the verdict.
    if (failed) return { ref: failed[1], kind: "ci", verdict: "failing", failing: failed[2] ? failed[2].split(", ") : [] }
  }
  return null
}

// The server's gh-CLI availability signal. `installed`/`inRepo`/`nameWithOwner` are STABLE for the
// process lifetime (resolved once at boot); `authed` can flip mid-session (the user runs
// `gh auth login`) so it is re-checked live on each githubStatus query.
export const GithubStatus = z.object({
  installed: z.boolean(),
  inRepo: z.boolean(),
  nameWithOwner: z.string().nullable(),
  authed: z.boolean(),
})
export type GithubStatus = z.infer<typeof GithubStatus>

// ── Hovercards for the GitHub references autolinked into prose ───────────────────────────────────
//
// One card = one `#123` / `owner/repo#123` / commit hash the autolinker turned into an anchor
// (web/lib/githubAutolink.ts). The wire shape is FLAT and every field past `kind` is optional rather
// than a discriminated union, because the same card renders an issue, a PR and a commit: a union
// would triple the schema and the rpc-contract gate for three shapes that differ by four fields.
//
// `ref` is the canonical key both sides cache on — `owner/repo#123` for an issue or PR,
// `owner/repo@<sha>` for a commit — and it is echoed back so a batched response can be matched to
// its request without positional assumptions.
export const GithubRefCard = z.object({
  ref: z.string(),
  kind: z.enum(["issue", "pr", "commit"]),
  repo: z.string(), // owner/repo, for the card's header line
  url: z.string(),
  title: z.string(),
  body: z.string(), // already truncated server-side to the card's excerpt budget
  state: z.string(), // OPEN | CLOSED | MERGED | DRAFT — empty for a commit, which has no state
  stateReason: z.string().optional(), // COMPLETED | NOT_PLANNED | REOPENED — GitHub's closed-issue nuance
  at: z.string().optional(), // ISO: opened-at for an issue/PR, committed-at for a commit
  authorLogin: z.string().optional(),
  authorName: z.string().optional(), // commits carry a git author name with no GitHub account behind it
  authorAvatar: z.string().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  // Epoch ms of the fetch this card came from. The CLIENT owns the freshness decision (render the
  // cached card instantly, then revalidate if it is old), so it has to be able to see the age.
  fetchedAt: z.number().int().nonnegative(),
})
export type GithubRefCard = z.infer<typeof GithubRefCard>

// ONE request for every reference on the page. The whole point of the batch is that a hover costs no
// round trip at all: the client asks for a screenful of refs as the prose renders and answers the
// hover out of its own store. `refresh` is the revalidation half — set only for the handful of refs
// the client is actually looking at, it makes the server bypass its TTL for those.
export const GithubRefPreviewInput = z.object({
  refs: z.array(z.string().min(3).max(120)).min(1).max(100),
  refresh: z.boolean().default(false),
})
export type GithubRefPreviewInput = z.infer<typeof GithubRefPreviewInput>

// `missing` is a real answer, not a failure: a `#123` in prose can name an issue that does not exist
// (a worker misremembered, or the repo is private to someone else). The client caches it so the
// anchor never asks twice. `error` is set only when the whole batch failed — no gh, no token, rate
// limit — and the client keeps the plain link with no card rather than showing a broken one.
export const GithubRefPreviewResult = z.object({
  cards: z.array(GithubRefCard),
  missing: z.array(z.string()),
  error: z.string().optional(),
})
export type GithubRefPreviewResult = z.infer<typeof GithubRefPreviewResult>

// ---- SSE events on the global /events channel ----
// The channel is DELTA-based (see delta.ts): a full "board" frame is the connect keyframe and the
// resync frame; steady-state changes ship as "board-delta" (only the threads that actually changed).
// A one-thread status change ships one ThreadView, not the whole ~310KB board — that is the byte win.

// Board-level (non-thread) fields, diffed as a unit and shipped only when they change (BoardDelta.meta).
export const BoardMeta = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem), diffed + shipped with the rest of the board
  // meta so the repair affordance survives a delta (not just the connect keyframe). Optional for the
  // same pre-restart back-compat reason as on BoardSnapshot.
  errorItems: z.array(BoardErrorItem).optional(),
})
export type BoardMeta = z.infer<typeof BoardMeta>

// ── The editor bridge's wire (types and rationale: ./editor-protocol.ts, ARCHITECTURE.md § VS Code extension) ──
// The server validates every frame an editor sends with these; each is pinned to its plain type below.
const EditorKindSchema = z.enum(["vscode", "cursor", "windsurf", "other"])
const EditorWindowSummarySchema = z.object({ app: z.string(), kind: EditorKindSchema, acceptsOpens: z.boolean(), reviews: z.literal(true).optional(), extensionVersion: z.string().optional() }).strict()
const EditorPath = z.string().min(1).max(EDITOR_MAX_PATH)
const EditorLine = z.number().int().min(1).max(10_000_000)
export const EditorComposeInputSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  path: EditorPath,
  text: z.string().max(EDITOR_COMPOSE_MAX_TEXT).optional(),
  startLine: EditorLine.optional(),
  endLine: EditorLine.optional(),
}).strict()
// The `editor` frame — what a window's editor shows, for the agents (`ntwinectl editor`). Every
// count and length is capped, so one frame is bounded however large the workspace; the extension fits
// itself under these and under EDITOR_STATE_MAX_BYTES before it sends (packages/vscode editor-state.ts).
const EditorStateLines = z.object({ startLine: EditorLine, endLine: EditorLine }).strict()
const EditorStateTag = z.string().max(EDITOR_STATE_MAX_TAG)
export const EditorSnapshotSchema = z.object({
  t: z.literal("editor"),
  shared: z.boolean(),
  active: z.object({
    path: EditorPath,
    untitled: z.literal(true).optional(),
    languageId: EditorStateTag,
    dirty: z.boolean(),
    lineCount: z.number().int().min(0).max(10_000_000),
    cursorLine: EditorLine,
    selection: EditorStateLines.extend({
      text: z.string().max(EDITOR_STATE_MAX_SELECTION_TEXT).optional(),
      truncated: z.literal(true).optional(),
      withheld: z.literal(true).optional(),
    }).strict().optional(),
    visible: EditorStateLines,
  }).strict().nullable(),
  open: z.array(z.object({ path: EditorPath, untitled: z.literal(true).optional(), dirty: z.literal(true).optional() }).strict()).max(EDITOR_STATE_MAX_OPEN),
  diagnostics: z.array(z.object({
    path: EditorPath,
    line: EditorLine,
    severity: z.enum(["error", "warning"]),
    message: z.string().max(EDITOR_STATE_MAX_MESSAGE),
    source: EditorStateTag.optional(),
    code: EditorStateTag.optional(),
  }).strict()).max(EDITOR_STATE_MAX_DIAGNOSTICS),
  problems: z.object({ errors: z.number().int().min(0), warnings: z.number().int().min(0) }).strict(),
}).strict()
export const EditorClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(EDITOR_PROTOCOL_VERSION),
    windowId: z.string().min(1).max(200),
    app: z.string().min(1).max(200),
    extensionVersion: z.string().max(100),
    folders: z.array(EditorPath).max(EDITOR_MAX_FOLDERS),
    focused: z.boolean(),
    focusedAgoMs: z.number().int().min(0).optional(),
    acceptsOpens: z.boolean(),
    home: z.string().max(4096),
    platform: z.string().max(40),
  }).strict(),
  z.object({
    t: z.literal("state"),
    folders: z.array(EditorPath).max(EDITOR_MAX_FOLDERS),
    focused: z.boolean(),
    acceptsOpens: z.boolean(),
  }).strict(),
  z.object({ t: z.literal("result"), id: z.string().min(1).max(200), ok: z.boolean(), error: z.string().max(1000).optional() }).strict(),
  z.object({ t: z.literal("compose"), id: z.string().min(1).max(200), item: EditorComposeInputSchema }).strict(),
  EditorSnapshotSchema,
  // Names this server does not know are kept, not refused: a newer extension may name more than it.
  z.object({ t: z.literal("features"), features: z.array(z.string().max(100)).max(32) }).strict(),
  z.object({ t: z.literal("listen"), attention: z.boolean() }).strict(),
])
// A thread's changes for the extension to show (`review`, editor-protocol.ts): the `reviewTarget` RPC's
// answer, and the body of the `review` frame the server pushes.
export const EditorReviewTargetSchema = z.object({
  title: z.string().max(500),
  checkouts: z.array(z.object({
    dir: EditorPath,
    scope: z.enum(["branch", "files"]),
    files: z.array(EditorPath).max(EDITOR_REVIEW_MAX_FILES),
  }).strict()).max(EDITOR_REVIEW_MAX_CHECKOUTS),
}).strict()
// Both directions, so neither the plain types nor the schemas can drift without a type error here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const editorClientWireMatches: Same<z.infer<typeof EditorClientMessageSchema>, EditorClientMessage> = true
const editorWindowWireMatches: Same<z.infer<typeof EditorWindowSummarySchema>, EditorWindowSummary> = true
const editorComposeWireMatches: Same<z.infer<typeof EditorComposeInputSchema>, EditorComposeInput> = true
const editorSnapshotWireMatches: Same<z.infer<typeof EditorSnapshotSchema>, EditorSnapshot> = true
const editorReviewWireMatches: Same<z.infer<typeof EditorReviewTargetSchema>, EditorReviewTarget> = true
void editorClientWireMatches, editorWindowWireMatches, editorComposeWireMatches, editorSnapshotWireMatches, editorReviewWireMatches

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("board"),
    board: BoardSnapshot,
    // Monotonic publish counter this keyframe corresponds to (the client adopts it, then applies
    // deltas seq+1, seq+2 …). `bootId` is the server's per-process id. BOTH optional so a pre-restart
    // server's frame (which omits them) still parses; a new client treats absent seq as "no delta
    // tracking yet" and absent bootId as "unknown — no reload check".
    seq: z.number().optional(),
    bootId: z.string().optional(),
  }),
  z.object({
    // Keyed per-thread delta. `upserts` are COMPLETE ThreadViews for threads whose serialization
    // changed (or are new); `removed` are ids gone from the board; `meta` is present only when a
    // board-level field changed. Emitted only by a post-restart server → seq/bootId are required here.
    type: z.literal("board-delta"),
    seq: z.number(),
    bootId: z.string(),
    upserts: z.array(ThreadView),
    removed: z.array(ThreadSlug),
    meta: BoardMeta.optional(),
  }),
  z.object({
    type: z.literal("notify"),
    slug: ThreadSlug,
    kind: z.enum(["needs-decision", "turn-done", "exited"]),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    // Payload-free invalidation for future interaction cards. Provider-controlled command/diff/form
    // metadata never rides the global event bus; clients re-read the authorization-scoped RPC instead.
    type: z.literal("interactions-invalidated"),
    slug: InteractionThreadSlug,
    sessionId: InteractionOpaqueId,
    interactionId: InteractionOpaqueId,
    lifecycle: InteractionLifecycle,
    recordRevision: InteractionRevision,
  }).strict(),
  z.object({
    // The editor windows connected over the editor bridge (packages/vscode), whole, on every change.
    // MACHINE-WIDE: published on every open project's bus, because a page hears only its own project's.
    type: z.literal("editors"),
    windows: z.array(EditorWindowSummarySchema),
  }).strict(),
  z.object({
    // An editor sent something to the prompt box. Payload-free, like interactions-invalidated: the
    // page that has focus claims it through `composeTake`, so exactly one tab inserts it.
    type: z.literal("compose-pending"),
    id: z.string(),
  }).strict(),
  z.object({
    // What some editor window shows changed — its file in front, its selection's lines, whether it shares,
    // which one was used last. MACHINE-WIDE and payload-free: which window has which project open is the
    // server's to work out, so a page showing an editor line asks its project again (`editorFront`).
    type: z.literal("editor-front"),
  }).strict(),
  z.object({
    // The machine's PROJECT LIST changed: a reorder, a rename, an icon, a project added or forgotten.
    // Payload-free for the same reason as above — the list is one cheap read, and a client that
    // re-reads it cannot apply a stale copy out of order. It is the one event that is not about this
    // stream's own project: the server publishes it on EVERY open project's stream, because the rail
    // and the grid draw the same list in every tab whichever board that tab is on.
    type: z.literal("projects-changed"),
  }).strict(),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type BoardEvent = Extract<ServerEvent, { type: "board" }>
export type BoardDelta = Extract<ServerEvent, { type: "board-delta" }>

// Pure delta engine + client apply/decision helpers (kept in a sibling module, re-exported here so
// `@ntwine/shared` stays the single entry point).
export * from "./claim.ts"
export * from "./claude-editions.ts"
export * from "./code-fences.ts"
export * from "./deadline.ts"
export * from "./delta.ts"
export * from "./transcript-delta.ts"
export * from "./drainable-worker.ts"
export * from "./editor-protocol.ts"
export * from "./file-position.ts"
export * from "./embed-protocol.ts"
export * from "./interactions.ts"
export * from "./receipt-bus.ts"
export * from "./relay-protocol.ts"
export * from "./schedule-rule.ts"
export * from "./schedule-text.ts"
export * from "./schedule-trigger.ts"
export * from "./schedules.ts"
export * from "./shell-writes.ts"
export * from "./thread-handle.ts"
export * from "./thread-slug.ts"

// ---- Rendered conversation (parsed mechanically from the session JSONL — no AI) ----

// Structured file-edit payload for Edit/Write/MultiEdit tool calls, so the client can render a
// syntax-highlighted diff instead of an opaque "edited file.ts" line. Write → old: "" (whole file
// is new); MultiEdit → one TranscriptToolCall per sub-edit. Both strings are capped (see
// transcript.ts EDIT_CAP) so transcripts stay light.
export const TranscriptEdit = z.object({
  file: z.string(),
  old: z.string(),
  new: z.string(),
  // Line counts of the UNCAPPED sides, taken at projection time — `old`/`new` above are capped for
  // transport, so a diffstat recomputed from them undercounts any large edit.
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
})
export type TranscriptEdit = z.infer<typeof TranscriptEdit>

// One row of an agent's built-in TO-DO LIST. Set only for a call that ITSELF carries the whole list —
// Claude Code's `TaskList` (whose result enumerates every task), codex's `update_plan` and Claude's
// legacy `TodoWrite` (both of which pass the entire list on every call). The server normalizes those
// onto this one row so one client card renders all three.
//
// Deliberately NOT reconstructed for Claude's per-task deltas (`TaskCreate`/`TaskUpdate`, whose payload
// is `{taskId:"3", status:"completed"}` and nothing more). Deriving a list from them would mean the
// projector accumulating list state across the transcript, which is not its job (maintainer 2026-07-29:
// "don't bother with maintaining your own state here"). Those calls render as ordinary tool cards.
export const TranscriptTodo = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
})
export type TranscriptTodo = z.infer<typeof TranscriptTodo>

export const TranscriptToolCall = z.object({
  name: z.string(),
  detail: z.string().optional(), // file path / command / description — whatever the input reveals
  edit: TranscriptEdit.optional(), // set only for Edit/Write/MultiEdit blocks
  // The model-authored one-line description of a Bash command (Claude Code's `description` input
  // field) — the collapsed block's title.
  desc: z.string().optional(),
  // Raw (multi-line) command, set only for a Bash call whose command spans multiple lines or runs
  // long — the client renders it as its own code block instead of the flattened one-line `detail`.
  command: z.string().optional(),
  // Capped human-readable input/source for any tool that has useful payload beyond its one-line
  // detail. Generic cards expand this exactly like Bash expands `command`; specialized cards may
  // retain it as failure context (for example a wrapped apply_patch that did not apply).
  input: z.string().optional(),
  // A capped excerpt of a Read call's tool_result (the file content it returned) — set only for Read
  // calls whose result shipped as text. The client renders it as a collapsed, bordered card (same
  // family as Bash/Edit) that expands to the excerpt. Absent for older transcripts / pre-restart
  // servers, in which case the client falls back to the compact one-line Read summary.
  read: z.string().optional(),
  // A capped excerpt of a tool's captured result. Codex records results for shell calls and for its
  // unified custom-tool wrapper; the client renders this as a second pane below either the Bash body
  // or a generic input body. Absent for Claude calls whose result isn't present in the transcript.
  output: z.string().optional(),
  // Absolute path to an IMAGE the tool returned in its result — e.g. a `take_screenshot` (chrome-devtools
  // MCP) or any tool whose tool_result carries a base64 image block. The server decodes the image once to
  // a content-hashed file under the OS temp dir and records the path here; the client renders it inline in
  // the tool card via the gated /local-image route (tmpdir is a trusted root). Absent for text-only results.
  outputImage: z.string().optional(),
  // Tool lifecycle inferred from call/result pairs. A just-appended call is `pending`; the matching
  // result promotes it to completed/failed/cancelled. Background launches deliberately remain pending
  // after their launch acknowledgement: a later provider-native completion is the only terminal fact.
  // Kept optional for pre-restart transcript data.
  // `exitCode` is present for shell-like results that expose it.
  status: z.enum(["pending", "completed", "failed", "cancelled"]).optional(),
  // A non-terminal shell has a durable, provider-neutral lifecycle identity. `background` means the
  // provider confirmed a live child/session; `unknown` means we saw a poll for an unpaired session.
  // Neither is rendered as done merely because the wrapper call returned.
  backgroundState: z.enum(["background", "unknown"]).optional(),
  // The launching tool_use id of a `background` shell — the SAME key the tailer tracks that shell under
  // (BgShellView.id), and therefore the only exact way to tell "the board's row and this transcript card
  // are one process" from "two processes the model described identically".
  //
  // The ops strip lists a live shell from BOTH sources, and it used to reconcile them on
  // label+startedAt. That key cannot hold: the board's instant is the tool_use RECORD's timestamp while
  // the transcript's is the projected MESSAGE's, and an assistant turn whose prose lands before its call
  // makes those differ by seconds (measured: 19:11:28.190 vs 19:11:32.200 on one real launch), so the
  // same shell rendered twice — once clickable, once not. Optional: absent on codex (whose background
  // execs are transcript-native and have no board row to collide with) and on pre-restart servers,
  // which fall back to the label+startedAt key.
  shellId: z.string().optional(),
  exitCode: z.number().int().optional(),
  // Execution context/result metadata that is useful in a compact card header without dumping a
  // backend envelope. `cwd` comes from exec_command's workdir/cwd, `sessionId` identifies a yielded
  // PTY process (and later write_stdin polls), and `durationMs` is result wall time when recorded.
  cwd: z.string().optional(),
  sessionId: z.union([z.string(), z.number()]).optional(),
  durationMs: z.number().nonnegative().optional(),
  // ---- Agent (sub-agent dispatch) block ----
  // Set only for an `Agent` tool_use that carried a `prompt`. The client promotes such a call into an
  // AgentBlock (same collapsed-card family as Bash/Read): the `detail` is the dispatch description,
  // `subagentType` the model+effort cell, and expanding reveals the (capped) dispatch `prompt`. All
  // optional so a pre-restart server / older transcript falls back to the plain `Agent(detail)` line.
  prompt: z.string().optional(), // the capped dispatch prompt (the AgentBlock's expanded body)
  // The RESOLVED model+effort cell (e.g. "ntwine:opus-high"), not `subagent_type` verbatim: a modern
  // profile is effort-only, so the server folds the call's `model` — or, when omitted, the model the
  // dispatching turn itself ran at — back into the cell. See server/subagent-profile.ts.
  subagentType: z.string().optional(),
  agentId: z.string().optional(), // the Agent tool_use id — the correlation key to the live tracked sub-agent
  // Terminal outcome of the dispatched sub-agent, back-filled when a matching completion
  // <task-notification> appears LATER in the transcript. Drives the AgentBlock header's finished state
  // ("finished 35m" / "failed 12m"). Absent while the child is still live (or its completion was
  // missed) — in which case the live tracked-sub-agent overlay supplies "running Nm" instead.
  agentStatus: z.enum(["completed", "failed", "killed"]).optional(),
  agentElapsedMs: z.number().optional(), // dispatch → completion elapsed, for the finished-state label
  // TRUE only on the copy of the dispatch call the server re-emits, as its own standalone message, at
  // the position the completion <task-notification> landed (see transcript.ts completionEvents). That
  // copy is a TIMELINE MARKER, not a second tool call, so the client renders it as the centered wake
  // divider a background shell's completion already uses — never as a second AgentBlock card
  // (maintainer 2026-07-27: converge an agent finishing onto the background-shell rendering, which is
  // "more visually distinct in a big sea of tool call blocks"). The LAUNCH card, which carries the same
  // agentStatus/agentElapsedMs after back-fill, never sets this and stays an expandable prompt card.
  // Optional + additive: an old client ignores it and shows the previous duplicate-card rendering.
  agentCompletion: z.boolean().optional(),
  // ---- SendMessage (peer / agent-to-agent messaging) block ----
  // Set only for a `SendMessage` tool_use (an orchestrator steering a sub-agent, or a teammate note).
  // The client promotes such a call into the centred WAKE DIVIDER the sub-agent completion and upward
  // report already draw (maintainer 2026-07-31: "render 'Steered' or SendMessage using the same full
  // width notifications, the horizontal rule style component that we render when an agent completes").
  // `sendTo` is the recipient agent id/name, `sendSummary` the short recap, `sendBody` the (capped)
  // message body, and `sendType` the message type when it is NOT a plain "message" (e.g.
  // "shutdown_request"). Summary and body are retained because the SUB-AGENT DRAWER — where the same
  // call is read as the child's own record — still needs them; the parent's divider renders neither.
  // All optional so a pre-restart server / older transcript falls back to a bare divider.
  sendTo: z.string().optional(), // recipient agent id/name (the SendMessage `to`)
  sendSummary: z.string().optional(), // the short recap (the SendMessage `summary`)
  sendBody: z.string().optional(), // the capped message body (the SendMessage `message`/`content`)
  sendType: z.string().optional(), // the message type when not a plain "message" (e.g. "shutdown_request")
  // The steer's DRILL-IN pair, set only when the server could resolve `sendTo` to a child this same
  // transcript dispatched. A Claude `SendMessage` addresses its target by AGENT ID, which is both
  // meaningless to a reader and not a key any drawer resolves — every sub-agent lookup goes through the
  // DISPATCH tool_use id. The server owns that translation (childDispatchIds, the one record where a
  // child's two identities meet) and ships the result: `sendDispatchId` is what the divider's title
  // opens, `sendTargetLabel` the dispatch's own description, which is what the title reads.
  // Absent on codex (its peer tools name a target that was never dispatch-acked here) and on `to:"main"`
  // — in both cases the divider degrades to plain text rather than a link to an unavailable drawer.
  sendDispatchId: z.string().optional(),
  sendTargetLabel: z.string().optional(),
  // ---- SendUserFile (Claude Code file delivery) block ----
  // Set only for a `SendUserFile` tool_use — the worker surfacing files (screenshots, artifacts) to the
  // human. The client promotes such a call into a SentFilesCard that renders the delivered files inline
  // instead of a generic tool block: `sentImages` are absolute paths the server COPIED into its servable
  // screenshot cache (the sources are often scratchpad paths /local-image won't serve), each rendered
  // inline via the gated /local-image route; `sentFiles` are the basenames of any NON-image files
  // (rendered as openable chips); `caption` is the model's one-line caption, shown below. All optional so
  // a pre-restart server / older transcript falls back to the generic tool card.
  sentImages: z.array(z.string()).optional(),
  sentFiles: z.array(z.string()).optional(),
  caption: z.string().optional(),
  // ---- To-do list block ----
  // The whole to-do list, for the calls that carry it (see TranscriptTodo). The client promotes such a
  // call into a TodoBlock — a checklist card, one row per task with its status. Optional, so a
  // pre-restart server / older transcript falls back to the generic card.
  todos: z.array(TranscriptTodo).optional(),
  // ---- Native question (AskUserQuestion) block ----
  // The structured questions an `AskUserQuestion` tool_use asked, so a SETTLED call renders as a
  // read-only question card at its place in the transcript instead of a generic tool line buried in a
  // disclosure. This is what keeps a question the human saw from vanishing: a follow-up sent instead
  // of an answer retires the pending interaction card (the broker denies the parked call), and without
  // this field nothing in the transcript ever said what was asked. Optional, so a pre-restart server /
  // older transcript falls back to the generic card.
  ask: z.array(AskQuestion).optional(),
  // The human's answers, parallel to `ask` (null = that question got no answer), parsed from the
  // call's structured tool result. Absent entirely when the call settled unanswered — the withdrawn /
  // denied case — which the client renders as "Not answered".
  askAnswers: z.array(z.string().nullable()).optional(),
})
export type TranscriptToolCall = z.infer<typeof TranscriptToolCall>

// One block-ordered PART of an assistant turn — the fidelity fix. A turn's content interleaves text
// and tool_use blocks in a meaningful order (a "Let me draft the notes:" lead-in sits DIRECTLY above
// the call it introduces). The legacy split text/tools fields discarded that order (all tools rendered
// before all prose); `parts` preserves it. Contiguous same-kind blocks coalesce into one part.
export const TranscriptPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tools"), tools: z.array(TranscriptToolCall) }),
])
export type TranscriptPart = z.infer<typeof TranscriptPart>

export const TranscriptMessage = z.object({
  // Stable identity of this PROVIDER-NEUTRAL projected message. The server derives it from the
  // transcript incarnation plus the source record that opened the rendered unit; clients use it only
  // for overlap reconciliation, keyed rendering, and scroll anchoring. Optional for rolling upgrades.
  sourceId: z.string().min(1).max(768).optional(),
  // Latest-window projection may pin an unresolved background shell whose original launch message
  // has scrolled into paginated history. The synthetic tools-only card points back to that canonical
  // source so loading the earlier page can replace (not duplicate) it.
  pinnedFromSourceId: z.string().min(1).max(768).optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(), // markdown; empty when the message was tool-calls only
  // Optional presentation-only projection of `text`. The full text remains available to persistence,
  // search, and transcript logic; shared chat surfaces use this compact form for generated prompts
  // whose machine-facing tail would otherwise dominate the first user bubble.
  displayText: z.string().optional(),
  providerError: ProviderError.optional(),
  tools: z.array(TranscriptToolCall),
  at: z.string().optional(), // ISO8601
  // Additive message variant. "event" is transcript PUNCTUATION emitted inline at the position a
  // sub-agent completion <task-notification> was seen (text like `Agent "…" finished — 35m`).
  // "reasoning" is a Codex model-reasoning SUMMARY (the plaintext `summary[]` of a rollout reasoning
  // record — Claude's thinking is redacted at every seam, so this is Codex-only); `text` holds the
  // summary markdown, rendered as a collapsed-by-default expandable block. Absent (undefined) → an
  // ordinary user/assistant message. Old clients that don't know a `kind` render it as a plain
  // assistant line, which is a graceful (if unstyled) degrade.
  kind: z.enum(["event", "reasoning"]).optional(),
  // Wall-clock the model spent THINKING, in ms — set only on a `kind:"reasoning"` message. Derived from
  // the rollout's per-step reasoning timestamps (Σ of each reasoning step's gap from the event before it,
  // which excludes tool-execution time). NOT rendered: it used to caption the reasoning disclosure as
  // "Thought for N seconds", and a permanent row reporting how long the model paused is exactly what the
  // transcript no longer carries (see ReasoningBlock). Kept because it is the server's own measurement
  // and costs nothing to project. Optional: absent on non-reasoning messages and on any reasoning block
  // whose timing couldn't be derived.
  durationMs: z.number().nonnegative().optional(),
  // A turn-BOUNDARY marker: this `kind:"event"` line was emitted at the position a turn opened or
  // closed, so it renders as a centered divider rule carrying the cause label — without it, two
  // consecutive assistant turns (each with its own trailing signal) paint as one seamless bubble.
  // Additive + optional: an old client ignores it and shows the plain quiet event line (graceful
  // degrade).
  //
  // It names WHICH KIND of boundary, because several unrelated events earn the divider and the client
  // has to tell them apart to put the right glyph on each:
  //   wake       — a background task/shell completion `<task-notification>` re-invoked the agent
  //   compaction — the provider rewrote the conversation and dropped everything above this point
  //   rest       — the agent CAME TO REST: its turn ended and nothing further is in flight
  // It was a bare boolean until the dividers grew icons (a shell glyph on a compaction line is simply
  // wrong), and the kind has to come from the SERVER: the alternative is the client sniffing the label
  // text, which is the guess this codebase refuses everywhere else. A string stays truthy, so any
  // surviving `if (boundary)` reads exactly as it did — including on a client that predates `rest`,
  // which draws it as an iconless divider rather than dropping it.
  boundary: z.enum(["wake", "compaction", "rest"]).optional(),
  // On a `wake` line for an agent terminal's completion ("Agent terminal «…» finished"): that terminal's
  // launch tool_use id, so the line opens its drawer as the strip's row does. Absent for a completion the
  // server could not tie to its launch.
  wakeShellId: z.string().optional(),
  // Block-ordered content for an assistant turn (see TranscriptPart). Defaults to [] so a pre-restart
  // server (which ships only text/tools) parses; the client renders `parts` when non-empty and falls
  // back to the legacy tools-then-text layout when it's empty. `text`/`tools` stay populated for that
  // fallback window and for consumers (useLiveAnswering, previews) that read the flat fields.
  parts: z.array(TranscriptPart).default([]),
  // A human follow-up SENT to a mid-turn worker that Claude Code has QUEUED but not yet delivered into
  // the agent's context (an `enqueue` queue-operation with no matching delivery record yet). Rendered as
  // a grayed user bubble — the SAME affordance the client uses for its own optimistic send. Flips to
  // undefined/false once the delivery (a `queued_command` attachment) materializes the message. Additive
  // + optional: a pre-restart client ignores it; an old server simply never sets it. NB: the client ALSO
  // sets this transiently on an optimistic local send (see web hooks.ts) — same meaning, same styling.
  queued: z.boolean().optional(),
  // Server-side delivery-ledger identity for a Claude follow-up (delivery-ledger.ts): set on a queued
  // bubble the ledger projects (or tags), so the client's optimistic copy of the SAME send is consumed
  // by id instead of by exact text — the text-match path stays only for id-less legacy flows. Additive.
  deliveryId: z.string().optional(),
  // The ledger's own state for that send. "pending": injected, no JSONL evidence yet. "enqueued":
  // Claude Code's queue holds it (positive receipt, undelivered). "delivered": the transport's receipt
  // proved the provider took it straight into a turn, but its transcript record has not reached disk
  // yet — renders as an ordinary (un-grayed) user bubble. "unconfirmed": no evidence appeared within
  // the timeout — the injection likely mutated/never landed; the client renders a quiet warning.
  // Once the real transcript record lands the ledger drops the item and this field goes with it.
  // "sending": the server's WRITE-AHEAD entry, opened before any transport is touched, so the text is
  // the server's from the instant it arrives. "failed": the transport threw, or never answered — the
  // text is kept until the operator retries, edits or dismisses it, and nothing retries it on its own.
  // Additive + optional: an older client renders both as a plain bubble (gray for "sending").
  // "held": the operator sent it TO THE QUEUE — ntwine has it and no transport does, until the agent rests.
  deliveryState: z.enum(["sending", "pending", "enqueued", "delivered", "unconfirmed", "failed", "held"]).optional(),
  // Why a "failed" send failed, verbatim from the transport. Set only alongside deliveryState "failed".
  deliveryError: z.string().optional(),
  // NTWINE wrote this user turn, not the human: it is a scheduler wake delivery (isWakeDelivery). The
  // client renders it as a first-party card rather than the human's off-white right-justified bubble,
  // which was claiming the operator had typed a message the watcher composed. Additive + optional: an
  // old client ignores it and shows the plain bubble (the previous behavior), and an old server simply
  // never sets it.
  wake: z.boolean().optional(),
  // The STRUCTURED wake, parsed by the server from the same text the same build formatted. The chat
  // renders the divider from this rather than re-deriving it from prose in the browser.
  //
  // It exists because re-deriving it in the browser is version-skewed by construction. `web/api/boot.ts`
  // adopts a new server boot id IN PLACE (so an unsent draft survives a restart), so a promoted artifact
  // swaps the server under tabs that keep their old bundle — and on 2026-07-31 a steer that gained two
  // agent-facing lines met parsers that predated them, which cost every open tab its card and dumped the
  // raw `gh api …` text into the transcript instead. Server-side, formatter and parser can never
  // disagree. Additive + optional: absent from a legacy transcript or an older server, and the client
  // falls back to `parseGithubWakeSteer` on the text.
  wakeSteer: GithubWakeSteer.optional(),
  // Input delivered INTO a sub-agent by its coordinator or another agent. It is a user-side turn in
  // that CHILD's conversation, but it is not the human speaking. The drawer's live projection keeps
  // these messages even when the ordinary 300-message tail has moved past them — clicking a parent's
  // "Steered"/"Followed up" divider promises the corresponding instruction remains readable there.
  // Additive + optional: ordinary thread transcripts never set it.
  agentInstruction: z.literal(true).optional(),
  // The OUTPUT of a slash command the harness ran itself — `/context`, `/usage`, `/mcp` — rather than
  // handing to the model. Set on a `kind:"event"` message whose `text` is that output (plain text or
  // Markdown); `command` is the command it answered, when the transcript named it. Neither the agent nor
  // the human said it, so it renders as its own block under the `/name` bubble. Additive + optional: a
  // client that predates it shows the text as an ordinary event line.
  commandOutput: z.object({ command: z.string().max(512).optional(), stream: z.enum(["stdout", "stderr"]) }).strict().optional(),
  // A SUB-AGENT (or peer session) wrote this user turn, not the human — the same defect class `wake`
  // above corrects. Claude Code's agent-to-agent channel (a background child calling
  // `SendMessage({to:"main"})`) delivers UPWARD into the parent's queue like any follow-up, so the
  // parent's transcript records it as an ordinary user turn whose text is the raw
  // `<agent-message from="…">…</agent-message>` wrapper. Left alone that renders as the operator's own
  // off-white bubble with the XML showing — claiming the human typed what a child reported.
  //
  // `peerFrom` is the sender label the wrapper carries (today the child's `subagent_type`, e.g.
  // `ntwine:opus-high`, because the worker dispatch hook strips `name`), and `displayText` carries the
  // unwrapped body.
  //
  // `peerDispatchId` is what makes the chat's report line CLICKABLE: it is the child's Agent DISPATCH
  // tool_use id, which is the key `tailer.subAgent()` resolves a drawer against (live map, retired ring
  // and descendant sidecars are all keyed by it — see TranscriptToolCall.agentId, the same id).
  //
  // It is deliberately NOT the child's own agentId. The delivery record supplies `origin.senderTaskId`,
  // which IS that agentId and is the unambiguous sender identity when several children share one profile
  // label — but the drawer cannot resolve it, so handing it over would open an "unavailable" drawer. The
  // two identities meet in exactly one place: the dispatch's launch-ack record, whose `toolUseResult`
  // carries the new child's `agentId` beside the `tool_use_id` that spawned it. The parser correlates
  // there and stores the DISPATCH id here. Additive + optional: absent when the ack was never seen (a
  // resumed session whose dispatch scrolled out), and the line then renders as plain text, not a dead link.
  peerFrom: z.string().optional(),
  peerDispatchId: z.string().optional(),
  // …and the tell that `peerFrom` is ONLY that subagent_type — that the parser could not resolve the
  // dispatch's own description for this sender. It matters because a profile cell is not a name: every
  // child dispatched at `ntwine:opus-high` reports under the identical string, so a divider reading
  // «ntwine:opus-high» names the MODEL, not the work, and two siblings are indistinguishable
  // (maintainer 2026-08-06: "I'm also still occasionally seeing things like 'Agent <OPUS:HIGH>
  // rested'"). The client renders an unnamed sender as "Sub-agent reported" and keeps the cell in the
  // tooltip, rather than promoting a profile to a title.
  //
  // Resolution is genuinely late-arriving, not merely missing: the description comes from the DISPATCH
  // record, so a report rendered while the window has not yet reached that record is unnamed and gains
  // its title once it has. Set only on the Claude path — a codex peer names a real task.
  peerUnnamed: z.literal(true).optional(),
  // The sender's own RUNTIME agent id (`origin.senderTaskId`) — kept so a LATER pass can finish the job
  // the fold could not. The paged transcript RPC folds a bounded window, so a report whose dispatch
  // scrolled above the page start has no description available at fold time; the tailer still holds the
  // pairing, and `projectTranscriptPeerNames` uses this id to ask it. Never a drawer key on its own —
  // that is `peerDispatchId`, which the same pass can also supply once this resolves.
  peerSenderTaskId: z.string().optional(),
  // ANOTHER TOP-LEVEL SESSION wrote this user turn — a thread messaging this one through Claude Code's
  // cross-session channel (see parseCrossSessionMessage), most often the coordinator thread that spawned
  // it. Not the human, and not a sub-agent either: the chat draws it as an expandable hairline naming
  // the sending thread, with the body one click away. `displayText` carries the unwrapped body.
  //
  // `name` is the sender's Claude Code session name, the fallback label. `thread` is the ntwine thread
  // behind it, filled in by the server from the sender's socket (session-peer.ts) — absent when the
  // sender is not an ntwine thread or is gone without having been resolved, and then the line names the
  // session without a link. `project` is the URL slug of the sender's project.
  sessionPeer: z.object({
    name: z.string().optional(),
    socket: z.string().optional(),
    thread: z.object({ project: z.string().optional(), slug: z.string(), title: z.string() }).optional(),
  }).optional(),
  // NTWINE REFUSED the ```awaiting fence this message ends in — it named something that is not running,
  // or named nothing at all, or used a retired line kind (see `isParkCorrection`). The fence is not a
  // park, so the chat draws nothing for it: an hourglass card with a park button asserts a wait that
  // ntwine declined to arm, and the settled-fence prose beneath it is a handoff the worker is about to
  // write again in its re-fence. Set by the server when it drops the correction that followed, so the
  // signal and the thing it is derived from can never disagree in the browser.
  //
  // Additive + optional: an old client ignores it and renders the fence as it did before.
  fenceRefused: z.literal(true).optional(),
  // A SPINOFF REQUEST: the human asked to spinoff a new thread from this one. Drawn from the spinoff's row
  // at the instant they asked (server transcript.ts withSpinoffCards), or — in a transcript from before
  // 2026-10-07 — the user turn that delivered the request to the worker (parseSpinoffRequest). The chat
  // draws it as a spinoff card: the human's instructions and a link to the new thread. Additive + optional.
  spinoff: z.object({ id: z.string(), instructions: z.string() }).optional(),
  // A SPINOFF CHILD'S FIRST TURN: the prompt ntwine composed from the human's instructions and the
  // parent's context (spinoffChildPrompt), read back into its parts. The chat draws it as the thread's
  // spinoff header — the instructions as the human's request, the context folded beneath them — never as
  // one user bubble, since the context is not the human's words. `displayText` carries the instructions alone, so everything that quotes a thread's request
  // (the queue card, `read_thread`) quotes what the human asked. Additive + optional.
  spinoffOrigin: z.object({ instructions: z.string(), brief: z.string() }).optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessage>

// Backward transcript pagination is cursor-based rather than an arbitrary message-count offset. A
// cursor is opaque to the browser and binds one projected boundary to its exact session/transcript
// incarnation. `reachedTurnBoundary:false` is the explicit continuation-within-turn contract used
// only when one pathological turn crosses the bounded page ceiling.
export const TranscriptPageCursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/)
export type TranscriptPageCursor = z.infer<typeof TranscriptPageCursor>

// A file the thread's worker has WRITTEN — one row of the fullscreen rail's "Edited files", derived
// server-side over the WHOLE projected transcript rather than the latest window the page carries.
// The distinction is the whole reason it rides the page: a worker edits in the middle of an effort
// and verifies at the end, so by the time anyone opens the thread every Edit sits hundreds of
// messages above the window (this repo's own threads: last Edit at record 633 of 2113, 2026-08-28).
export const EditedFile = z.object({
  path: z.string().min(1),
  edits: z.number().int().positive(),
  lastEditedAt: z.string().optional(),
  // The file's diffstat, summed over its write calls (each call's counts are the line counts of its
  // raw old/new sides). A Write counts as all additions — what it replaced is unknowable here.
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
}).strict()
export type EditedFile = z.infer<typeof EditedFile>

export const TranscriptPage = z.object({
  messages: z.array(TranscriptMessage),
  beforeCursor: TranscriptPageCursor.nullable(),
  hasEarlier: z.boolean(),
  reachedTurnBoundary: z.boolean(),
  transcriptKey: z.string().min(1).max(256),
  // The LATEST page only (see EditedFile); an earlier page is settled history and carries none.
  editedFiles: z.array(EditedFile).optional(),
}).strict()
export type TranscriptPage = z.infer<typeof TranscriptPage>

export const TranscriptEarlierInput = z.object({
  slug: ThreadSlug,
  cursor: TranscriptPageCursor,
}).strict()
export type TranscriptEarlierInput = z.infer<typeof TranscriptEarlierInput>

// ---- Terminal WebSocket protocol (ws://host/term/:id) — a thread's terminals ----
// client -> server: {t:"input", d:string} | {t:"resize", cols:number, rows:number}
// server -> client: raw utf8 terminal output frames
export type TermClientMsg = { t: "input"; d: string } | { t: "resize"; cols: number; rows: number }

// ---- /ws multiplex protocol (ws://host/ws) — stage 2: ONE socket for board + transcript + notify ----
// The board & notify frames REUSE the stage-1 ServerEvent shapes verbatim (wrapped in {t:"event"}), so the
// client feeds them through the exact same delta/seq/boot handler as SSE (see web/api/board-stream.ts).
// Transcript frames replace the 1.5s threadTranscript poll with server PUSH for subscribed slugs.
// Coexists with /events as a graceful fallback (a pre-restart server has
// no /ws route → the client degrades to SSE + polling).

// Client -> server (zod-validated server-side): subscribe / unsubscribe a thread's transcript push.
// Keep the wire identifier aligned with every server-owned thread slug. Besides bounding retained
// subscription state, the shape excludes path separators/control text before it can reach transcript
// lookup code. Foreign session ids are UUID-shaped and remain valid under this grammar.
export const SocketTranscriptSlug = ThreadSlug
// A local file a reader has open — the /full split viewer's or the Markdown drawer's document. The
// bound matches the read RPCs' own; the server gates the path exactly as it gates the read, so a
// file the reader could not read is a file it cannot watch either.
export const SocketFilePath = z.string().min(1).max(4096)
const SocketTranscriptClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
])
// The FILE topic: "tell me when this file changes on disk". The server answers with `file-changed`
// frames carrying the path AS SUBSCRIBED, and the reader re-reads through its gated RPC — the push is a
// notice, never the bytes.
const SocketFileClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("file"), path: SocketFilePath }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("file"), path: SocketFilePath }).strict(),
])
export const SocketClientMsg = z.union([SocketTranscriptClientMsg, SocketFileClientMsg])
export type SocketClientMsg = z.infer<typeof SocketClientMsg>

// server -> client (hand-built by the server, parsed defensively by the client — a plain union, no zod):
//   - {t:"event"}      wraps a ServerEvent (board keyframe / board-delta / notify)
//   - {t:"transcript"} the pushed transcript for a subscribed slug (replaces the poll response)
//   - {t:"payload-too-large"} is a stable, typed transport downgrade. A board overflow moves the client
//     to SSE once; a transcript overflow pauses only that subscription and leaves explicit HTTP refresh.
//   - {t:"resource-limited"} rejects one transcript subscription when the process/origin read budget is
//     exhausted. The board socket stays healthy and the client exposes an explicit retry instead of churn.
//   - {t:"file-changed"} a subscribed local file changed on disk; `path` is the path the client
//     subscribed with, so it keys straight back into the reader's query. No bytes ride this frame.
//   - {t:"hb"}         10s heartbeat so the client's staleness watchdog works as it did over SSE
// The page ENVELOPE a transcript push may carry beside its messages — everything the paged HTTP read
// returns except the messages themselves and `editedFiles` (a git-backed scan over the whole projection,
// too costly to redo on every byte-advance; the client keeps the copy its last HTTP read delivered).
// The push and the paged read are the SAME bounded latest window (server: readLatestThreadTranscriptPage),
// so the client reconciles both through one function (web: reconcileLatestPage) and a long thread's
// cursor can never go stale under a push that slid the window. Optional only for a server that predates
// it — a client then falls back to the messages-only reconcile.
export type TranscriptPushPage = Omit<TranscriptPage, "messages" | "editedFiles">

export type SocketServerMsg =
  | { t: "event"; event: ServerEvent }
  // `sig` names the window this frame carries, so a later `transcript-delta` can say which window it was
  // cut against. A frame without one (a pre-delta server) is never a delta base.
  | { t: "transcript"; slug: ThreadSlug; messages: TranscriptMessage[]; page?: TranscriptPushPage; sig?: string }
  // Only what changed since the window `base` this connection last received (transcript-delta.ts). A
  // client holding any other window resubscribes for a fresh snapshot rather than apply it.
  | { t: "transcript-delta"; slug: ThreadSlug; base: string; sig: string; ops: TranscriptPatchOp[]; page?: TranscriptPushPage }
  | { t: "file-changed"; path: string }
  | { t: "payload-too-large"; channel: "board"; actualBytes: number; maxBytes: number }
  | { t: "payload-too-large"; channel: "transcript"; slug: ThreadSlug; actualBytes: number; maxBytes: number }
  | {
      t: "resource-limited"
      resource: "transcript-read"
      scope: "origin" | "global"
      slug: ThreadSlug
      retryAfterMs: number
    }
  | { t: "hb" }

/**
 * One card on the machine's project grid.
 *
 * Everything here comes from the registry index, which is why listing every project costs one file
 * read and never opens a database: the grid must stay cheap enough to be the home page even with
 * forty projects, and opening them to draw cards is exactly the cost lazy activation exists to avoid.
 */
export const ProjectCard = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  lastOpenedAt: z.string(),
  /**
   * When `ntwine` was last run in this project (a cold launch or a join), as the launcher stamped it in
   * the registry. All projects' prompt box aims at the most recent one when this browser has neither
   * picked nor focused a project. Absent for a project no current launcher has run in.
   */
  lastLaunchedAt: z.string().optional(),
  /** The directory is gone — moved or deleted. The card stays so it can be reopened or forgotten. */
  stale: z.boolean(),
  /**
   * When this project's icon was last established, or absent if it never has been.
   *
   * Carried purely so the client can hang it off the `/_ntwine/project-icon` URL: the icon bytes are
   * cached hard (a rail of forty squares is forty requests, and none of them should recur), which
   * means a newly uploaded icon would otherwise stay invisible behind the cached old one. A changed
   * version is a changed URL, so the swap is immediate without weakening the caching for everyone.
   *
   * Deliberately NOT "does this project have an icon". Answering that for a project nobody has
   * scanned yet would mean scanning it, and this list is one file read on purpose.
   */
  iconVersion: z.string().optional(),
  /**
   * Whether this project HAS an icon — and crucially, whether we have even looked.
   *
   * Three states, not a boolean, because the two "no icon to draw right now" cases must behave
   * differently and a boolean collapses them:
   *   · `icon`    — one is stored; draw it.
   *   · `none`    — scanned recently, nothing found. Draw the monogram and DO NOT request the icon
   *                 route, which is what stops an iconless project flashing its initials and then
   *                 swapping. An OLD miss reads `unknown` again, so an icon added since is found.
   *   · `unknown` — never scanned. The monogram shows, but the request MUST still go out, because
   *                 that request is what triggers the (lazy, cached) scan in the first place.
   *
   * Collapsing `unknown` into `none` deadlocks the whole feature: no image element is rendered, so
   * the icon route is never called, so the scan never runs, so the project stays `unknown` forever.
   * Measured 2026-08-06 — a rail of 29 projects had scanned exactly ONE, and only because a probe
   * had fetched that one's URL by hand.
   */
  iconStatus: z.enum(["icon", "none", "unknown"]),
  /** An operator's uploaded icon, rather than one the scan found. Drives what the menu offers. */
  iconIsCustom: z.boolean().optional(),
  /**
   * The built-in HOME workspace rather than a registered project: the prompt box's target for work
   * that belongs to no project, run in the operator's home folder. `path` is
   * that folder. It cannot be renamed, given an icon or removed — it is not a folder ntwine adopted, so
   * there is nothing to forget — and it draws a house instead of a monogram.
   */
  home: z.literal(true).optional(),
})
export type ProjectCard = z.infer<typeof ProjectCard>

/**
 * One project's rail counts: its queue (`queuedThread`) and its Active band (`activeBandThread`).
 *
 * The rail's badge draws `queued` alone; `running` is named in the square's tooltip and on the phone's
 * projects list. A project absent from the map has no board open on this server — no badge, not a zero.
 *
 * `asks` is the phone's number, not the rail's: the threads waiting on a human ANSWER (`boardAskThread`,
 * the board header's "N need you"), a subset of `queued` that leaves out rested handoffs. Upstream's
 * phone projects list drew it in the accent; the desktop rail does not read it. (The fork's phone list
 * reads `projectsQueues`, which it already has; the field is kept so the RPC is upstream's.)
 */
export const ProjectRailCounts = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  asks: z.number().int().nonnegative(),
})
export type ProjectRailCounts = z.infer<typeof ProjectRailCounts>

/** Formats the icon route will serve — a browser renders each of these in an `<img>`. */
export const PROJECT_ICON_EXTENSIONS = ["png", "svg", "ico", "webp", "jpg", "jpeg", "gif"] as const

/** 4 MB of base64. An app icon that does not fit in this is not an app icon. */
export const PROJECT_ICON_MAX_BASE64_CHARS = 4 * 1024 * 1024

/**
 * What the machine's folder picker came back with.
 *
 * `cancelled` is not an error — it is the commonest outcome after a mis-click, and rendering it as
 * one would put a red message on screen every time someone changed their mind.
 */
export const DirectoryPickResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picked"), project: ProjectCard }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])
export type DirectoryPickResult = z.infer<typeof DirectoryPickResult>

/**
 * The chosen folder sits INSIDE another project root — a Git checkout or a manifest root — and so
 * would have added that root instead. Nothing was registered or written.
 *
 * Until 2026-09-28 the add path took the enclosing root silently: picking `~/app/yes` reopened `~/app`
 * and navigated to its board, which read as "nothing happened". The page now asks — open the enclosing
 * root, or add the folder as a project of its own (`projectAdd` with `exact`).
 */
export const ProjectEnclosed = z.object({
  kind: z.literal("enclosed"),
  /** The folder that was chosen, resolved. */
  path: z.string(),
  /**
   * The project it belongs to: the nearest REGISTERED project above it, else the root it would have
   * resolved to. A registered ancestor wins over a nearer unregistered root — `~/app/action/yes` names
   * `~/app`, not the `~/app/action` package the operator never added.
   */
  root: z.string(),
  /** What the operator calls that root: the project's display name, or the folder's own name. */
  rootName: z.string(),
  /** Whether that root is already a registered project (open it) or not yet (add it). */
  rootRegistered: z.boolean(),
})
export type ProjectEnclosed = z.infer<typeof ProjectEnclosed>

/** `projectAdd`'s answer: the project it registered, or the enclosing root it declined to take silently. */
export const ProjectAddResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), project: ProjectCard }),
  ProjectEnclosed,
])
export type ProjectAddResult = z.infer<typeof ProjectAddResult>

/** `projectPick`'s answer — the picker's own outcomes, plus the same enclosed case `projectAdd` has. */
export const ProjectPickResult = z.discriminatedUnion("kind", [...DirectoryPickResult.options, ProjectEnclosed])
export type ProjectPickResult = z.infer<typeof ProjectPickResult>

/**
 * One project's slice of the machine-wide queues read (`projectsQueues`) — the All queues page's data.
 *
 * THE PROJECT TRAVELS WITH ITS THREADS. A `ThreadView` carries no project, and slugs are unique only
 * within one, so a list merged across projects is only safe to act on while every row still says whose
 * it is. The page addresses each action through `/_ntwine/<projectId>/rpc`, never through its own URL.
 *
 * `threads` is every OPEN session thread — the Queue, Running, Snoozed and Pinned rows the project's own
 * rail draws, plus any ARCHIVED one whose worker is still running (sectionOf lifts it into Running until
 * it comes to rest). Every other archived thread is Done, which grows without bound (553 rows on one real
 * board), so it is `doneCount` here — except a PINNED Done thread, which is `pinnedDone` and not counted:
 * the pin outranks Done, so the rail rows it under Pinned, greyed, and its Done band never holds it (web
 * groups.ts `sectionThreads`). A thread's
 * TERMINALS ride its row (`ThreadView.terminals`), and one waiting at a prompt queues that thread.
 * Foreign sessions (a project's own terminals) are left out; they are read-only and never queue. The
 * client bands every row with the same pure `groups.ts` functions the rail uses.
 */
export const ProjectQueue = z.object({
  projectId: z.string(),
  /** The registry slug — the `<slug>` in `/project/<slug>`. */
  projectSlug: z.string(),
  projectName: z.string(),
  /** What a relative path in this project's prose resolves against, and a `~` expands to. */
  projectDir: z.string(),
  homeDir: z.string().optional(),
  /** `owner/repo` for `#123` autolinks in this project's prose — never the page's. */
  githubRepo: z.string().optional(),
  threads: z.array(ThreadView),
  doneCount: z.number().int().nonnegative(),
  /** The Done threads that are PINNED, whole: the Pinned band lists them whatever their state, and they
   *  are few by construction (a pin is the human's shelf), so they ride the poll rather than wait for the
   *  project's board — a pinned Done thread in a project nobody had opened was rowless on All projects
   *  until it was. Absent when there are none; never in `doneCount`. */
  pinnedDone: z.array(ThreadView).optional(),
  /** The most recently rested Done threads, newest first, capped (`RECENT_DONE_THREADS`) — what the
   *  All projects `@` typeahead offers after the open ones (web lib/threadMentions.ts). Never drawn as
   *  rows: this page's Done band is still `doneCount`. */
  recentDone: z.array(ThreadView).optional(),
  /** The project's schedules — the row's fourth count, warning-toned when one was paused by ntwine or is
   *  a proposal waiting for Turn on. Absent when the project has none. */
  schedules: ProjectSchedules.optional(),
})
export type ProjectQueue = z.infer<typeof ProjectQueue>

/**
 * One thread with the project it belongs to — a row of a list merged across projects (History, the
 * palette's cross-project search). The project travels with the thread for the reason `ProjectQueue`
 * gives: a slug is unique only within one project, so a merged row is only safe to act on while it says
 * whose it is.
 */
export const ProjectThreadEntry = z.object({
  projectId: z.string(),
  projectSlug: z.string(),
  projectName: z.string(),
  thread: ThreadView,
})
export type ProjectThreadEntry = z.infer<typeof ProjectThreadEntry>

/**
 * `projectsDone` — Done threads across every open project, newest rest first, a page at a time.
 *
 * `before` is the opaque cursor a previous page returned as `nextBefore`; a bare ISO instant also works
 * and means "rested strictly before this". The cursor carries a tie-break (project id, thread id) beside
 * the instant, so two threads that rested in the same millisecond are neither repeated nor skipped
 * across a page boundary. `projectIds` is the lens (absent = every project); `external` adds the
 * project's foreign sessions (ones ntwine did not start) that are at rest.
 */
export const ProjectsDoneInput = z.object({
  before: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  projectIds: z.array(z.string()).optional(),
  external: z.boolean().optional(),
})
export type ProjectsDoneInput = z.infer<typeof ProjectsDoneInput>
export const ProjectsDonePage = z.object({
  entries: z.array(ProjectThreadEntry),
  /** Present when there may be more: pass it back as `before`. */
  nextBefore: z.string().optional(),
})
export type ProjectsDonePage = z.infer<typeof ProjectsDonePage>

/** `threadsSearch` — every project's threads, open and Done, whose name or slug contains the query. */
export const ThreadsSearchInput = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(200).optional(),
})
export type ThreadsSearchInput = z.infer<typeof ThreadsSearchInput>
export const ThreadSearchEntry = ProjectThreadEntry.extend({ done: z.boolean() })
export type ThreadSearchEntry = z.infer<typeof ThreadSearchEntry>

/**
 * A resting thread's handoff, whole: the text a queue card is built around.
 *
 * The board carries only a ~200-character, whitespace-collapsed preview (`ThreadView.lastAssistant`),
 * which loses exactly the structure a verdict line and a done card depend on. This is the final
 * assistant message of the latest transcript window, verbatim, plus the human's own last message so a
 * card can say what the agent was answering. Both absent when the thread has not spoken.
 *
 * `answer` is the worker's reply to `asked` when wakes rested after it, so `text` — the newest rest —
 * answers a wake rather than the human (router.ts `handoffOf`). Absent when `text` is the reply.
 * `answerDone` says that answer's own rest signed off done, so a later done is a postscript to it.
 */
export const ThreadHandoff = z.object({
  text: z.string().optional(),
  answer: z.string().optional(),
  answerDone: z.boolean().optional(),
  at: z.string().optional(),
  asked: z.string().optional(),
  askedAt: z.string().optional(),
})
export type ThreadHandoff = z.infer<typeof ThreadHandoff>

/** Where a thread slug actually lives, for a link that no longer says which project it belongs to. */
export const ThreadLocation = z.object({ projectSlug: z.string(), projectName: z.string() })
export type ThreadLocation = z.infer<typeof ThreadLocation>

/**
 * Everything ntwine itself serves lives under this prefix, so the top level stays free for the project
 * routes (`/project/<slug>`) and for the SPA's own route names. Without a reserved namespace the
 * deny-list is a growing list of route names that breaks the day someone clones a repo called
 * `settings`.
 *
 * One constant, exported to both sides, because a server route and the client URL that calls it
 * drifting apart is a 404 that looks like a hung request. The client end is `apiBase()`
 * (web/src/lib/base-path.ts), which appends the project slug; ARCHITECTURE.md § URL shape has the map.
 *
 * (This docstring sat ~80 lines up the file, stacked on ProjectCard's own, until 2026-08-07 — which is
 * why nothing here said where the client half lived.)
 */
export const NTWINE_ROUTE_PREFIX = "/_ntwine"
export function ntwineRoute(path: string): string {
  return `${NTWINE_ROUTE_PREFIX}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * `http://localhost:9393`.
 *
 * Unassigned in the IANA registry on both TCP and UDP — its neighbours `9390` (OpenVAS) and `9396`
 * are registered and it is not — clear of both Chromium's and Firefox's blocklists (the highest port
 * either blocks is 10080), no dev-tool default, and below every platform's ephemeral floor.
 *
 * Port choice CANNOT buy robustness on Windows: Hyper-V/WSL reservations reported at
 * microsoft/WSL#5514 and #5306 cover 89% of 1024-9999 between them, and every four-digit repeating
 * port is inside a block on at least one of those machines — as are Vite's 5173 and Postgres's 5432.
 * Robustness lives entirely in the fallback below.
 */
export const DEFAULT_PORT = 9393

/**
 * The dev server's own default, so `ntwine-dev` never fights the singleton for `9393`.
 *
 * Picked off the same verified shortlist as DEFAULT_PORT: IANA-unassigned on TCP and UDP, on neither
 * browser's blocklist, no tool default. Adjacent by sight for the same reason the fallback is.
 */
export const DEFAULT_DEV_PORT = 9494

/**
 * The primary with a `1` in front: 9393 → 19393.
 *
 * Lands in `10896-24265`, a 13,370-port gap clean on both reported Windows machines, above the
 * highest browser-blocked port and below Linux's ephemeral floor (32768). The band is wide enough
 * that "clean" picks no winner, so the tiebreak is explicability — someone meeting
 * `localhost:19393` is meeting it while something is already going wrong, and it should read at a
 * glance as the same app on its backup port.
 */
export function fallbackPort(base: number): number {
  return base + 10_000
}
// A thread's stable identity string, `ntwine-<slug>`. It named a tmux session once; ntwine has no tmux,
// and this survives as the integrity check on the session row's `thread_name` column — a row whose
// stored name does not re-derive from its own slug has been tampered with or mis-keyed.
export const threadIdentityName = (slug: string) => `ntwine-${ThreadSlug.parse(slug)}`
export * from "./schedule-rule.ts"
