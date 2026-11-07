import { type, type Traversal } from "./ark.ts"
import { ThreadSlug } from "./thread-slug.ts"

// Runtime-neutral typed interaction protocol. Provider-controlled strings in this module are
// presentation-safe PLAIN TEXT only: consumers must render them as textContent/React text, never as
// HTML or Markdown. Every leaf and aggregate is capped before it can reach SQLite or a future card.

export const INTERACTION_PROTOCOL_VERSION = 1 as const
export const INTERACTION_REQUEST_MAX_BYTES = 64 * 1024
export const INTERACTION_RESPONSE_MAX_BYTES = 24 * 1024
export const INTERACTION_LIST_MAX = 128

const encoder = new TextEncoder()
const INTERACTION_NUMBER_LIMIT = 1_000_000_000_000_000
// Reject every Unicode formatting/surrogate/line-separator class, not just the handful of common
// bidi controls. Adapters may turn these code points into visible ASCII markers before parsing, but
// no raw invisible directionality or ill-formed UTF-16 is permitted in the durable/UI contract.
const UNSAFE_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

function byteLength(value: unknown): number {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength
}

// A rule a whole value breaks, in the words zod's custom issue used: `problem` is the location-free text,
// and `relativePath` points inside the value being checked.
type Issue = { problem: string; relativePath?: PropertyKey[] }

/** Report every issue found on `ctx`: the narrow passes exactly when there were none. */
function rejectEach(ctx: Traversal, issues: readonly Issue[]): boolean {
  for (const issue of issues) ctx.reject(issue)
  return issues.length === 0
}

// One rule set for every provider-controlled string: at most N characters, no unsafe text, a single line
// unless the field is multiline, and at most M UTF-8 bytes. Each rule reports on its own, so a value that
// breaks two of them says both.
//
// Each definition spells the chain out rather than calling a helper taking (maxChars, maxBytes), and every
// narrow is a module-level function, one per byte cap: arktype's precompiler (`@ark/aot`) builds each Type at
// build time and cannot yet precompile a helper's result that holds a function (it refuses both a function
// the helper creates and a module-level one the helper reads).
const safeText = (value: string, ctx: Traversal) =>
  !UNSAFE_TEXT.test(value) || ctx.reject({ problem: "contains unsafe control or bidirectional text" })
const singleLine = (value: string, ctx: Traversal) =>
  (!value.includes("\n") && !value.includes("\r")) || ctx.mustBe("a single line")
const atMost512Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 512 || ctx.mustBe("at most 512 UTF-8 bytes")
const atMost2000Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 2000 || ctx.mustBe("at most 2000 UTF-8 bytes")
const atMost2048Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 2048 || ctx.mustBe("at most 2048 UTF-8 bytes")
const atMost4096Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 4096 || ctx.mustBe("at most 4096 UTF-8 bytes")
const atMost8000Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 8000 || ctx.mustBe("at most 8000 UTF-8 bytes")
const atMost24000Bytes = (value: string, ctx: Traversal) => byteLength(value) <= 24000 || ctx.mustBe("at most 24000 UTF-8 bytes")

// zod 3's `datetime({ offset: true })` pattern, verbatim: a calendar-checked date, `T`, a 24h time whose
// seconds and fraction are optional, then `Z` or a `±hh[:]mm` offset. The durable journal holds instants
// this accepted, so the rule a record is re-read under must not move.
const ISO_DATETIME_WITH_OFFSET = /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|([+-]\d{2}:?\d{2}))$/

export const InteractionOpaqueId = type.string.atMostLength(256).narrow(safeText).narrow(singleLine).narrow(atMost512Bytes).atLeastLength(1)
// Back-compatible protocol name; the value itself is the canonical thread identifier schema.
export const InteractionThreadSlug = ThreadSlug
export const InteractionRevision = type("number.integer >= 0").atMost(Number.MAX_SAFE_INTEGER)
export const InteractionTimestamp = type(ISO_DATETIME_WITH_OFFSET).pipe((value) => new Date(value).toISOString())
export const InteractionLabel = type.string.atMostLength(160).narrow(safeText).narrow(singleLine).narrow(atMost512Bytes).atLeastLength(1)
export const InteractionDescription = type.string.atMostLength(4_000).narrow(safeText).narrow(atMost8000Bytes).atLeastLength(1)
export const InteractionPreview = type.string.atMostLength(16_000).narrow(safeText).narrow(atMost24000Bytes).atLeastLength(1)
  .narrow((value, ctx) => value.split(/\r?\n/u).length <= 256 || ctx.mustBe("at most 256 lines"))
export const InteractionFieldId = type("1 <= string <= 128 & /^[A-Za-z_][A-Za-z0-9_.:-]*$/")
  .narrow((value, ctx) => !["__proto__", "constructor", "prototype"].includes(value) || ctx.reject({ problem: "reserved field id" }))
export const InteractionDecisionId = type("1 <= string <= 80 & /^[A-Za-z0-9][A-Za-z0-9._:-]*$/")

export const InteractionProvider = type({
  "+": "reject",
  kind: "'claude' | 'codex' | 'acp' | 'ntwine'",
  "name?": InteractionLabel,
  "version?": InteractionOpaqueId,
})
export type InteractionProvider = typeof InteractionProvider.infer

export const InteractionSource = type({
  "+": "reject",
  kind: "'runtime' | 'agent' | 'tool' | 'mcp-server' | 'ntwine'",
  id: InteractionOpaqueId,
  "label?": InteractionLabel,
})
export type InteractionSource = typeof InteractionSource.infer

export const InteractionOwner = type({
  "+": "reject",
  projectId: InteractionOpaqueId,
  threadSlug: InteractionThreadSlug,
  sessionId: InteractionOpaqueId,
  turnId: InteractionOpaqueId,
  itemId: InteractionOpaqueId,
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
})
export type InteractionOwner = typeof InteractionOwner.infer

export const InteractionDecisionSemantic = type("'approve' | 'deny' | 'cancel' | 'accept' | 'decline' | 'answer'")
export type InteractionDecisionSemantic = typeof InteractionDecisionSemantic.infer

export const InteractionDecision = type({
  "+": "reject",
  id: InteractionDecisionId,
  semantic: InteractionDecisionSemantic,
  // Provider context only. Authorization UIs must make `semantic` visible with a canonical verb and
  // must never infer the security effect from this provider-controlled label.
  label: InteractionLabel,
  "description?": InteractionDescription,
})
export type InteractionDecision = typeof InteractionDecision.infer

const InteractionNumber = type(`${-INTERACTION_NUMBER_LIMIT} <= number <= ${INTERACTION_NUMBER_LIMIT}`)

const InteractionScalar = type.or(
  type.string.atMostLength(4_000).narrow(safeText).narrow(atMost8000Bytes),
  InteractionNumber,
  "boolean",
)
export type InteractionScalar = typeof InteractionScalar.infer

export const InteractionValue = type.or(
  InteractionScalar,
  type.string.atMostLength(1_000).narrow(safeText).narrow(atMost2000Bytes).array().atMostLength(32),
)
export type InteractionValue = typeof InteractionValue.infer

const FieldBase = type({
  id: InteractionFieldId,
  label: InteractionLabel,
  "description?": InteractionDescription,
  required: "boolean",
  secret: "boolean = false",
})

const InteractionChoice = type({
  "+": "reject",
  value: InteractionScalar,
  label: InteractionLabel,
})

const InteractionMultiChoice = type({
  "+": "reject",
  value: type.string.atMostLength(1_000).narrow(safeText).narrow(atMost2000Bytes),
  label: InteractionLabel,
})

const InteractionFieldShapeSchema = type.or(
  {
    "...": FieldBase,
    "+": "reject",
    input: "'text' | 'multiline'",
    "minLength?": "0 <= number.integer <= 4000",
    "maxLength?": "0 <= number.integer <= 4000",
    "format?": "'email' | 'uri' | 'date' | 'date-time'",
    "default?": type.string.atMostLength(4_000).narrow(safeText).narrow(atMost8000Bytes),
  },
  {
    "...": FieldBase,
    "+": "reject",
    input: "'number' | 'integer'",
    "minimum?": InteractionNumber,
    "maximum?": InteractionNumber,
    "default?": InteractionNumber,
  },
  {
    "...": FieldBase,
    "+": "reject",
    input: "'boolean'",
    "default?": "boolean",
  },
  {
    "...": FieldBase,
    "+": "reject",
    input: "'select'",
    options: InteractionChoice.array().atLeastLength(1).atMostLength(64),
    "default?": InteractionScalar,
  },
  {
    "...": FieldBase,
    "+": "reject",
    input: "'multi-select'",
    options: InteractionMultiChoice.array().atLeastLength(1).atMostLength(64),
    "minItems?": "0 <= number.integer <= 32",
    "maxItems?": "0 <= number.integer <= 32",
    "default?": type.string.atMostLength(1_000).narrow(safeText).narrow(atMost2000Bytes).array().atMostLength(32),
  },
)
type InteractionFieldShape = typeof InteractionFieldShapeSchema.infer

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// One validator shared by defaults, live submissions, and durable-record integrity checks. Keeping
// these rules at the protocol layer prevents a provider from advertising a default the user can never
// submit and prevents a corrupted/migrated journal from reintroducing a value the live store rejected.
export function validateInteractionFieldValue(field: InteractionFieldShape, value: InteractionValue): string | undefined {
  if (field.input === "text" || field.input === "multiline") {
    if (typeof value !== "string") return "must be text"
    if (field.input === "text" && (value.includes("\n") || value.includes("\r"))) return "must be a single line"
    if (field.minLength !== undefined && value.length < field.minLength) return "is shorter than minLength"
    if (field.maxLength !== undefined && value.length > field.maxLength) return "is longer than maxLength"
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "must be an email address"
    if (field.format === "uri") {
      try {
        new URL(value)
      } catch {
        return "must be a URL"
      }
    }
    if (field.format === "date" && !validCalendarDate(value)) return "must be a date"
    if (field.format === "date-time" && !InteractionTimestamp.allows(value)) return "must be a date-time"
    return undefined
  }
  if (field.input === "number" || field.input === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number"
    if (field.input === "integer" && !Number.isInteger(value)) return "must be an integer"
    if (field.minimum !== undefined && value < field.minimum) return "is below minimum"
    if (field.maximum !== undefined && value > field.maximum) return "is above maximum"
    return undefined
  }
  if (field.input === "boolean") return typeof value === "boolean" ? undefined : "must be a boolean"
  if (field.input === "select") {
    if (Array.isArray(value)) return "must be one option"
    return field.options.some((option) => JSON.stringify(option.value) === JSON.stringify(value))
      ? undefined
      : "is not an advertised option"
  }
  if (field.input === "multi-select") {
    if (!Array.isArray(value)) return "must be a list of options"
    if (new Set(value).size !== value.length) return "contains duplicate options"
    if (field.minItems !== undefined && value.length < field.minItems) return "contains fewer than minItems"
    if (field.maxItems !== undefined && value.length > field.maxItems) return "contains more than maxItems"
    return value.every((candidate) => field.options.some((option) => option.value === candidate))
      ? undefined
      : "contains an unadvertised option"
  }
  return "has an unsupported input type"
}

export const InteractionField = InteractionFieldShapeSchema.narrow((field, ctx) => {
  const issues: Issue[] = []
  if (field.secret && field.default !== undefined) {
    issues.push({ problem: "secret fields cannot advertise defaults", relativePath: ["default"] })
  }
  if (field.input === "text" || field.input === "multiline") {
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
      issues.push({ problem: "minLength exceeds maxLength" })
    }
  }
  if (field.input === "number" || field.input === "integer") {
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      issues.push({ problem: "minimum exceeds maximum" })
    }
  }
  if (field.input === "select" || field.input === "multi-select") {
    const seen = new Set<string>()
    for (const [index, option] of field.options.entries()) {
      const key = JSON.stringify(option.value)
      if (seen.has(key)) issues.push({ problem: "duplicate option value", relativePath: ["options", index, "value"] })
      seen.add(key)
    }
    if (field.input === "multi-select" && field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) {
      issues.push({ problem: "minItems exceeds maxItems" })
    }
  }
  if (field.default !== undefined) {
    const error = validateInteractionFieldValue(field, field.default)
    if (error) issues.push({ problem: `invalid default: ${error}`, relativePath: ["default"] })
  }
  return rejectEach(ctx, issues)
})
export type InteractionField = typeof InteractionField.infer

const CommonPayload = type({
  title: InteractionLabel,
  "message?": InteractionDescription,
})

// Authorization displays keep security-relevant structure separate from provider prose. Adapters
// construct these values from provider protocols after redaction and bounding; React renders every
// string as text, never as HTML or Markdown.
export const InteractionCommandAction = type({
  "+": "reject",
  kind: "'read' | 'list-files' | 'search' | 'unknown'",
  commandPreview: InteractionPreview,
  "resourceLabel?": type.string.atMostLength(2_048).narrow(safeText).narrow(singleLine).narrow(atMost4096Bytes).atLeastLength(1),
  "queryLabel?": type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
})
export type InteractionCommandAction = typeof InteractionCommandAction.infer

const InteractionResourceLabel = type.string.atMostLength(2_048).narrow(safeText).narrow(singleLine).narrow(atMost4096Bytes).atLeastLength(1)
export const InteractionCapability = type.or(
  {
    "+": "reject",
    kind: "'network'",
    enabled: "boolean | null",
    hosts: InteractionResourceLabel.array().atMostLength(24),
  },
  {
    "+": "reject",
    kind: "'filesystem'",
    access: "'read' | 'write' | 'deny'",
    resources: InteractionResourceLabel.array().atLeastLength(1).atMostLength(32),
  },
  {
    "+": "reject",
    kind: "'glob-scan'",
    depth: "0 <= number.integer <= 256",
  },
  {
    "+": "reject",
    kind: "'exec-policy'",
    prefixes: InteractionResourceLabel.array().atLeastLength(1).atMostLength(32),
  },
  {
    "+": "reject",
    kind: "'network-policy'",
    access: "'allow' | 'deny'",
    hosts: InteractionResourceLabel.array().atLeastLength(1).atMostLength(24),
  },
)
export type InteractionCapability = typeof InteractionCapability.infer

export const InteractionFileChangeDisplay = type({
  "+": "reject",
  operation: "'create' | 'write' | 'move' | 'delete'",
  pathLabel: type.string.atMostLength(2_048).narrow(safeText).narrow(singleLine).narrow(atMost4096Bytes).atLeastLength(1),
  "destinationLabel?": type.string.atMostLength(2_048).narrow(safeText).narrow(singleLine).narrow(atMost4096Bytes).atLeastLength(1),
  // Display-only, bounded plain text. This value is never parsed or applied as a patch by ntwine.
  "diffPreview?": InteractionPreview,
})
export type InteractionFileChangeDisplay = typeof InteractionFileChangeDisplay.infer

export const InteractionPayload = type.or(
  {
    "...": CommonPayload,
    "+": "reject",
    kind: "'command-approval'",
    command: {
      "+": "reject",
      summary: InteractionLabel,
      // Adapters must redact credentials/environment/stdin before constructing this preview. The
      // literal makes accidentally passing an unreviewed raw command shape a schema error.
      preview: InteractionPreview,
      redacted: "true",
      "workingDirectoryLabel?": type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
      "actions?": InteractionCommandAction.array().atMostLength(16),
    },
    "capabilities?": InteractionCapability.array().atMostLength(32),
  },
  {
    "...": CommonPayload,
    "+": "reject",
    kind: "'file-approval'",
    operation: "'read' | 'create' | 'write' | 'move' | 'delete' | 'execute' | 'other'",
    pathLabel: type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
    "destinationLabel?": type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
    // `grantRoot` in the pinned Codex protocol is broader than an affected path: accepting for the
    // session authorizes writes below this root for the rest of that session. Keep it separately
    // labeled so the affected-file summary cannot disguise the durable scope.
    "grantRootLabel?": type.string.atMostLength(2_048).narrow(safeText).narrow(singleLine).narrow(atMost4096Bytes).atLeastLength(1),
    "scopeLabel?": InteractionDescription,
    // Plain-text, bounded preview only. It is never a trusted patch and must never be applied by ntwine.
    "diffPreview?": InteractionPreview,
    "changes?": InteractionFileChangeDisplay.array().atLeastLength(1).atMostLength(16),
  },
  {
    "...": CommonPayload,
    "+": "reject",
    kind: "'permission-approval'",
    permission: InteractionOpaqueId,
    // The exact text of what is being authorized — a command, a path, a request body. Multi-line and
    // rendered monospace, because a Bash command is the one thing the operator actually reads and a
    // single-line label cannot hold a heredoc. Adapters redact and clamp it before it gets here.
    "preview?": InteractionPreview,
    // A shell prompt to render in FRONT of `preview`, which is how a terminal shows a command and where
    // the working directory belongs when there is one. Set it only when the preview genuinely IS a shell
    // command line: a file path or an MCP argument behind a `❯` would be a lie about what runs.
    "promptLabel?": type.string.atMostLength(256).narrow(safeText).narrow(singleLine).narrow(atMost512Bytes).atLeastLength(1),
    "resourceLabel?": type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
    "workingDirectoryLabel?": type.string.atMostLength(1_024).narrow(safeText).narrow(singleLine).narrow(atMost2048Bytes).atLeastLength(1),
    "scopeLabel?": InteractionDescription,
    "capabilities?": InteractionCapability.array().atLeastLength(1).atMostLength(32),
  },
  {
    "+": "reject",
    kind: "'mcp-elicitation-form'",
    title: InteractionLabel,
    message: InteractionDescription,
    protocolVersion: InteractionOpaqueId,
    fields: InteractionField.array().atMostLength(32),
  },
  {
    "+": "reject",
    kind: "'mcp-elicitation-url'",
    title: InteractionLabel,
    message: InteractionDescription,
    protocolVersion: InteractionOpaqueId,
    elicitationId: InteractionOpaqueId,
    // URL-mode consent is explicit. Consumers must display the complete URL and must not prefetch it.
    url: type("string.url & 1 <= string <= 2048").narrow((value, ctx) => {
      const url = new URL(value)
      const issues: Issue[] = []
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      if (url.protocol !== "https:" && !localHttp) {
        issues.push({ problem: "URL elicitation requires HTTPS (except localhost development)" })
      }
      if (url.username || url.password) {
        issues.push({ problem: "URL elicitation must not contain userinfo credentials" })
      }
      return rejectEach(ctx, issues)
    }),
  },
  {
    "+": "reject",
    kind: "'agent-question'",
    title: InteractionLabel,
    "message?": InteractionDescription,
    fields: InteractionField.array().atLeastLength(1).atMostLength(32),
  },
)
export type InteractionPayload = typeof InteractionPayload.infer

// An `agent-question` splits ONE question across TWO fields: the options (a select the store validates
// against the advertised choices) and the free text beside them (which by definition no option list can
// validate). `<optionFieldId>` + this suffix is the entire pairing convention — the PRODUCER (the Claude
// broker, server/src/backend/claude-permission-interactions.ts) emits the pair and reads the answer back
// out of it, and the CONSUMER (web/src/lib/interactionQuestion.ts) folds the pair into a single card. It
// is a wire contract between two packages, so it lives here rather than as two hand-mirrored copies that
// can silently drift: change it on one side alone and the card splits into a phantom second question.
export const NOTES_FIELD_SUFFIX = "_notes"

const InteractionRequestObject = type({
  "+": "reject",
  protocolVersion: type.unit(INTERACTION_PROTOCOL_VERSION),
  contentFormat: "'plain-text'",
  provider: InteractionProvider,
  source: InteractionSource,
  owner: InteractionOwner,
  providerRequestId: InteractionOpaqueId,
  allowedDecisions: InteractionDecision.array().atLeastLength(1).atMostLength(8),
  payload: InteractionPayload,
  expiresAt: InteractionTimestamp.or("null"),
})

const semanticsForKind: Record<InteractionPayload["kind"], ReadonlySet<InteractionDecisionSemantic>> = {
  "command-approval": new Set(["approve", "deny", "cancel"]),
  "file-approval": new Set(["approve", "deny", "cancel"]),
  "permission-approval": new Set(["approve", "deny", "cancel"]),
  "mcp-elicitation-form": new Set(["accept", "decline", "cancel"]),
  "mcp-elicitation-url": new Set(["accept", "decline", "cancel"]),
  "agent-question": new Set(["answer", "decline", "cancel"]),
}

function validateInteractionRequest(value: typeof InteractionRequestObject.infer, issues: Issue[]): void {
  const allowedSemantics = semanticsForKind[value.payload.kind]
  const decisionIds = new Set<string>()
  for (const [index, decision] of value.allowedDecisions.entries()) {
    if (decisionIds.has(decision.id)) {
      issues.push({ problem: "duplicate decision id", relativePath: ["allowedDecisions", index, "id"] })
    }
    decisionIds.add(decision.id)
    if (!allowedSemantics.has(decision.semantic)) {
      issues.push({ problem: `decision is invalid for ${value.payload.kind}`, relativePath: ["allowedDecisions", index, "semantic"] })
    }
  }

  const fields = value.payload.kind === "mcp-elicitation-form" || value.payload.kind === "agent-question"
    ? value.payload.fields
    : []
  const fieldIds = new Set<string>()
  for (const [index, field] of fields.entries()) {
    if (fieldIds.has(field.id)) issues.push({ problem: "duplicate field id", relativePath: ["payload", "fields", index, "id"] })
    fieldIds.add(field.id)
    // MCP form mode is explicitly non-secret; sensitive flows belong in URL mode. Agent questions may
    // mark an input secret, in which case the store validates it transiently and persists only a marker.
    if (value.payload.kind === "mcp-elicitation-form" && field.secret) {
      issues.push({ problem: "MCP form elicitation cannot request secret fields; use URL mode", relativePath: ["payload", "fields", index, "secret"] })
    }
  }

  // This validator is also reused by InteractionRecord. Measure only the wire request so durable
  // lifecycle metadata does not make a request valid at create time but unreadable after journaling.
  const requestOnly = {
    protocolVersion: value.protocolVersion,
    contentFormat: value.contentFormat,
    provider: value.provider,
    source: value.source,
    owner: value.owner,
    providerRequestId: value.providerRequestId,
    allowedDecisions: value.allowedDecisions,
    payload: value.payload,
    expiresAt: value.expiresAt,
  }
  if (byteLength(requestOnly) > INTERACTION_REQUEST_MAX_BYTES) {
    issues.push({ problem: `interaction request exceeds ${INTERACTION_REQUEST_MAX_BYTES} bytes` })
  }
}

export const InteractionRequest = InteractionRequestObject.narrow((value, ctx) => {
  const issues: Issue[] = []
  validateInteractionRequest(value, issues)
  return rejectEach(ctx, issues)
})
export type InteractionRequest = typeof InteractionRequest.infer

export const InteractionLifecycle = type("'pending' | 'resolved' | 'cancelled' | 'expired'")
export type InteractionLifecycle = typeof InteractionLifecycle.infer

// Provider-neutral delivery authority projected by scoped server reads. This is deliberately an
// effect rather than a provider transport state: React must not learn provider ids, RPC request ids,
// response payloads, or adapter-specific labels in order to decide whether an action is safe.
//
// Absence means the interaction is journal-owned and follows its lifecycle. For provider-backed
// requests, only `awaiting-user` permits a decision submission. `sending` means an answer is already
// durably queued or has crossed the ambiguous write boundary; `reconnect-required` is fail-closed
// until the owning bridge can safely accept the first response.
export const InteractionDeliveryEffect = type("'awaiting-user' | 'sending' | 'reconnect-required'")
export type InteractionDeliveryEffect = typeof InteractionDeliveryEffect.infer

export const InteractionDelivery = type({
  "+": "reject",
  effect: InteractionDeliveryEffect,
})
export type InteractionDelivery = typeof InteractionDelivery.infer

export const InteractionCancellationReason = type("'user-cancelled' | 'provider-cancelled' | 'turn-ended' | 'session-replaced' | 'session-deleted' | 'capabilities-changed' | 'expired'")
export type InteractionCancellationReason = typeof InteractionCancellationReason.infer

// zod's record checked every key against InteractionFieldId; a key the index signature does not match is
// undeclared here, so rejecting undeclared keys is that same check.
export const InteractionValues = type.Record(InteractionFieldId, InteractionValue).onUndeclaredKey("reject").narrow((values, ctx) => {
  const issues: Issue[] = []
  if (Object.keys(values).length > 32) issues.push({ problem: "too many response fields" })
  if (byteLength(values) > INTERACTION_RESPONSE_MAX_BYTES) {
    issues.push({ problem: `interaction response exceeds ${INTERACTION_RESPONSE_MAX_BYTES} bytes` })
  }
  return rejectEach(ctx, issues)
})
export type InteractionValues = typeof InteractionValues.infer

export const InteractionResolution = type({
  "+": "reject",
  responseId: InteractionOpaqueId,
  decisionId: InteractionDecisionId,
  "values?": InteractionValues,
  // Secret response values are absent from `values`; only their field ids survive persistence.
  redactedFieldIds: InteractionFieldId.array().atMostLength(32),
  resolvedAt: InteractionTimestamp,
})
export type InteractionResolution = typeof InteractionResolution.infer

export const InteractionRecord = type({
  "...": InteractionRequestObject,
  "+": "reject",
  id: InteractionOpaqueId,
  lifecycle: InteractionLifecycle,
  "delivery?": InteractionDelivery,
  recordRevision: InteractionRevision,
  createdAt: InteractionTimestamp,
  updatedAt: InteractionTimestamp,
  completedAt: InteractionTimestamp.or("null"),
  resolution: InteractionResolution.or("null"),
  cancellationReason: InteractionCancellationReason.or("null"),
}).narrow((value, ctx) => {
  const issues: Issue[] = []
  validateInteractionRequest(value, issues)
  if (value.delivery && value.lifecycle !== "pending") {
    issues.push({ problem: "terminal interaction cannot advertise a delivery effect" })
  }
  if (value.lifecycle === "pending") {
    if (value.completedAt || value.resolution || value.cancellationReason) issues.push({ problem: "pending interaction has terminal data" })
    if (value.recordRevision !== 0 || value.updatedAt !== value.createdAt) {
      issues.push({ problem: "pending interaction has invalid revision or timestamps" })
    }
  } else if (!value.completedAt) {
    issues.push({ problem: "terminal interaction is missing completedAt" })
  } else {
    if (value.recordRevision < 1 || value.updatedAt !== value.completedAt || value.updatedAt < value.createdAt) {
      issues.push({ problem: "terminal interaction has invalid revision or timestamps" })
    }
  }
  if (value.lifecycle === "resolved") {
    if (!value.resolution || value.cancellationReason) issues.push({ problem: "resolved interaction has invalid terminal data" })
  } else if (value.resolution) {
    issues.push({ problem: "non-resolved interaction contains a resolution" })
  }
  if (value.lifecycle === "cancelled" && (!value.cancellationReason || value.cancellationReason === "expired")) {
    issues.push({ problem: "cancelled interaction has invalid reason" })
  }
  if (value.lifecycle === "expired" && value.cancellationReason !== "expired") {
    issues.push({ problem: "expired interaction has invalid reason" })
  }
  if (value.resolution) {
    if (value.resolution.resolvedAt !== value.completedAt) {
      issues.push({ problem: "resolution timestamp does not match its terminal record" })
    }
    const decision = value.allowedDecisions.find((candidate) => candidate.id === value.resolution!.decisionId)
    if (!decision) {
      issues.push({ problem: "resolution names an unadvertised decision", relativePath: ["resolution", "decisionId"] })
    }
    const fields = value.payload.kind === "mcp-elicitation-form" || value.payload.kind === "agent-question"
      ? value.payload.fields
      : []
    const byId = new Map(fields.map((field) => [field.id, field]))
    const redactedIds = new Set(value.resolution.redactedFieldIds)
    if (redactedIds.size !== value.resolution.redactedFieldIds.length) {
      issues.push({ problem: "resolution contains duplicate redaction markers", relativePath: ["resolution", "redactedFieldIds"] })
    }
    for (const id of value.resolution.redactedFieldIds) {
      if (!byId.get(id)?.secret) issues.push({ problem: "redaction marker does not name a secret field", relativePath: ["resolution", "redactedFieldIds"] })
    }
    for (const [id, responseValue] of Object.entries(value.resolution.values ?? {})) {
      const field = byId.get(id)
      if (!field) {
        issues.push({ problem: "resolution contains an unadvertised field", relativePath: ["resolution", "values", id] })
      } else if (field.secret) {
        issues.push({ problem: "secret value persisted in resolution", relativePath: ["resolution", "values", id] })
      } else if (validateInteractionFieldValue(field, responseValue)) {
        issues.push({ problem: "persisted response failed advertised validation", relativePath: ["resolution", "values", id] })
      }
    }
    if (decision) {
      const expectsValues = (value.payload.kind === "mcp-elicitation-form" && decision.semantic === "accept") ||
        (value.payload.kind === "agent-question" && decision.semantic === "answer")
      if (!expectsValues) {
        if (value.resolution.values !== undefined || value.resolution.redactedFieldIds.length > 0) {
          issues.push({ problem: "resolution decision cannot contain response fields", relativePath: ["resolution"] })
        }
      } else {
        for (const field of fields) {
          const supplied = field.secret
            ? redactedIds.has(field.id)
            : Object.prototype.hasOwnProperty.call(value.resolution.values ?? {}, field.id)
          if (field.required && !supplied) {
            issues.push({ problem: "resolution is missing a required field", relativePath: ["resolution", "values", field.id] })
          }
        }
      }
    }
  }
  return rejectEach(ctx, issues)
})
export type InteractionRecord = typeof InteractionRecord.infer

export const ListInteractionsInput = type({
  "+": "reject",
  slug: InteractionThreadSlug,
  sessionId: InteractionOpaqueId,
})
export type ListInteractionsInput = typeof ListInteractionsInput.infer

export const ListInteractionsResult = type({ "+": "reject", interactions: InteractionRecord.array().atMostLength(INTERACTION_LIST_MAX) })
export type ListInteractionsResult = typeof ListInteractionsResult.infer

export const GetInteractionInput = type({ "...": ListInteractionsInput, "+": "reject", interactionId: InteractionOpaqueId })
export type GetInteractionInput = typeof GetInteractionInput.infer

export const GetInteractionResult = type({ "+": "reject", interaction: InteractionRecord })
export type GetInteractionResult = typeof GetInteractionResult.infer

export const ResolveInteractionInput = type({
  "...": GetInteractionInput,
  "+": "reject",
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
  expectedRecordRevision: InteractionRevision,
  responseId: InteractionOpaqueId,
  decisionId: InteractionDecisionId,
  "values?": InteractionValues,
})
export type ResolveInteractionInput = typeof ResolveInteractionInput.infer

export const ResolveInteractionResult = type({
  "+": "reject",
  // Provider-backed interactions remain pending until the provider acknowledges the delivered
  // response. `queued` is therefore a truthful intermediate result, not an optimistic resolution.
  effect: "'resolved' | 'already-resolved' | 'queued' | 'already-queued'",
  interaction: InteractionRecord,
})
export type ResolveInteractionResult = typeof ResolveInteractionResult.infer

export const CancelInteractionInput = type({
  "...": GetInteractionInput,
  "+": "reject",
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
  expectedRecordRevision: InteractionRevision,
})
export type CancelInteractionInput = typeof CancelInteractionInput.infer

export const CancelInteractionResult = type({
  "+": "reject",
  effect: "'cancelled' | 'already-cancelled'",
  interaction: InteractionRecord,
})
export type CancelInteractionResult = typeof CancelInteractionResult.infer
