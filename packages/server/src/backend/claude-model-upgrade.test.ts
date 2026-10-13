import assert from "node:assert/strict"
import { test } from "node:test"
import type { ClaudeModel } from "@ntwine/shared"
import type { SessionRow } from "../storage.ts"
import type { SessionTelemetry } from "../tailer.ts"
import type { HibernationCandidate } from "../thread-hibernation.ts"
import { claudeModelStanding, claudeModelUpgradeDue, claudeModelUpgradeRefusal } from "./claude-model-upgrade.ts"

// The catalogue Claude Code 2.1.281 resolves (claude-models.test.ts carries the raw rows it came from).
const CATALOGUE: ClaudeModel[] = [
  { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1", edition: "5.1" },
  { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5", edition: "5.5" },
  { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5", edition: "5" },
  { alias: "haiku", label: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001", edition: "4.5" },
]

const NOW = Date.parse("2026-09-24T18:00:00.000Z")
const DAEMON_STARTED = NOW - 3 * 60 * 60_000
const SERVER_STARTED = NOW - 60 * 60_000
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { slug: "fix-the-queue", session_id: "sess-1", backend: "claude", claude_runtime: "broker", state: "open", archived: 0, exited: 0, delivery_ledger: null, ...over } as SessionRow
}

// A thread that ran Opus 5, compacted ten minutes ago (after both the daemon and this server started), and
// is resting with nothing outstanding — the one shape the upgrade at compaction takes.
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, model: "claude-opus-5", lastCompactionAt: at(10 * 60_000), lastActivityAt: at(60_000), ...over } as SessionTelemetry
}

function candidate(over: Partial<HibernationCandidate> = {}): HibernationCandidate {
  return { slug: "fix-the-queue", sessionId: "sess-1", row: row(), telemetry: tele(), pendingInteractions: 0, daemonStartedAtMs: DAEMON_STARTED, ...over }
}

const due = (over: Partial<HibernationCandidate> = {}, catalogue: { models: ClaudeModel[] | undefined } = { models: CATALOGUE }) =>
  claudeModelUpgradeDue(candidate(over), { catalogue: catalogue.models, nowMs: NOW, serverStartedAtMs: SERVER_STARTED })

test("a worker's model id reads against the pin's catalogue: behind, current, or unreadable", () => {
  assert.deepEqual(claudeModelStanding("claude-opus-5", CATALOGUE), {
    running: { alias: "opus", edition: "5", label: "Opus 5" },
    newer: { label: "Opus 5.5", edition: "5.5" },
  })
  assert.deepEqual(claudeModelStanding("claude-opus-5-5", CATALOGUE), { running: { alias: "opus", edition: "5.5", label: "Opus 5.5" } })
  // A worker NEWER than the pin (a server rolled back under a live daemon) is not "behind" either way.
  assert.equal(claudeModelStanding("claude-opus-6", CATALOGUE)?.newer, undefined)
  assert.equal(claudeModelStanding("<synthetic>", CATALOGUE), undefined)
  assert.equal(claudeModelStanding(undefined, CATALOGUE), undefined)
  // No catalogue yet, or only the bare family words of a failed probe: unknown is never "behind".
  assert.equal(claudeModelStanding("claude-opus-5", undefined)?.newer, undefined)
  assert.equal(claudeModelStanding("claude-opus-5", [{ alias: "opus", label: "Opus" }])?.newer, undefined)
})

test("a thread at rest that compacted on an older edition takes its next input in a fresh process", () => {
  assert.deepEqual(due(), { due: true, from: "Opus 5", to: "Opus 5.5" })
})

test("a thread already on the family's current edition is left alone", () => {
  assert.deepEqual(due({ telemetry: tele({ model: "claude-opus-5-5" }) }), { due: false, blockedBy: "current" })
  assert.deepEqual(due({}, { models: undefined }), { due: false, blockedBy: "current" })
})

test("the compaction must be newer than both the worker and this server", () => {
  // No compaction at all: the upgrade waits for one (the button is the way across before that).
  assert.deepEqual(due({ telemetry: tele({ lastCompactionAt: undefined }) }), { due: false, blockedBy: "no-compaction-since" })
  // Compacted under the previous process — this worker's context has grown since.
  assert.deepEqual(due({ daemonStartedAtMs: NOW - 5 * 60_000 }), { due: false, blockedBy: "no-compaction-since" })
  // Compacted before this server (and so before the upgrade existed) started.
  assert.deepEqual(due({ telemetry: tele({ lastCompactionAt: at(2 * 60 * 60_000) }) }), { due: false, blockedBy: "no-compaction-since" })
  // An unreadable instant refuses rather than reading as "long ago".
  assert.deepEqual(due({ daemonStartedAtMs: Number.NaN }), { due: false, blockedBy: "no-compaction-since" })
  assert.deepEqual(due({ telemetry: tele({ lastCompactionAt: "not a date" }) }), { due: false, blockedBy: "no-compaction-since" })
})

// The compaction usually lands MID-TURN. A retire there kills the turn, its sub-agents and its shells, so
// every one of those holds the upgrade off until the thread is genuinely at rest.
test("anything in flight holds the upgrade off", () => {
  assert.deepEqual(due({ telemetry: tele({ turn: "in-flight" }) }), { due: false, blockedBy: "turn-in-flight" })
  assert.deepEqual(due({ telemetry: tele({ subAgents: [{ state: "running" }] as SessionTelemetry["subAgents"] }) }), { due: false, blockedBy: "sub-agents" })
  assert.deepEqual(due({ telemetry: tele({ bgShells: [{ state: "running" }] as SessionTelemetry["bgShells"] }) }), { due: false, blockedBy: "background-shells" })
  assert.deepEqual(due({ pendingInteractions: 1 }), { due: false, blockedBy: "pending-approval" })
  assert.deepEqual(due({ row: row({ delivery_ledger: JSON.stringify([{ id: "d1", text: "carry on", at: at(30_000), updatedAt: at(30_000), state: "enqueued" }]) }) }), { due: false, blockedBy: "undelivered-input" })
  // Unlike hibernation, neither a short rest nor a young daemon holds it: those gate MEMORY reclaim.
  assert.deepEqual(due({ telemetry: tele({ lastActivityAt: at(1_000) }) }), { due: true, from: "Opus 5", to: "Opus 5.5" })
})

test("each refusal of the one-click upgrade reads as an instruction, short enough for a toast", () => {
  for (const block of ["turn-in-flight", "awaiting-a-human", "pending-approval", "sub-agents", "background-shells", "undelivered-input", "not-a-broker-thread", "archived", "no-telemetry"] as const) {
    const message = claudeModelUpgradeRefusal(block)
    assert.ok(message.length > 0 && message.length < 60, `${block}: ${message}`)
  }
})
