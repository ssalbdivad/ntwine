import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import { createStorage } from "./storage.ts"
import {
  ageDeliveries,
  appendDelivery,
  beginDelivery,
  correlateDeliveryRecord,
  dismissFailedDelivery,
  hasDelivery,
  MAX_FAILED_ITEMS,
  MAX_LEDGER_ITEMS,
  parseDeliveryLedger,
  projectDeliveryLedger,
  recordDeliveryFailure,
  RETRYABLE_SEND_GRACE_MS,
  SENDING_STALL_ERROR,
  SENDING_STALL_MS,
  trimLedger,
  UNCONFIRMED_DROP_MS,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"

// THE WRITE-AHEAD: a steer's words are the server's from the instant it receives them, and a delivery
// that throws or never answers leaves them as a `failed` entry the operator retries, edits or dismisses.
// Written after a ~4,000-character dictated steer was lost (2026-09-30): the cold resume threw, the
// server had recorded nothing, and the only copy was a sessionStorage draft a browser restart wiped.
const T0 = Date.parse("2026-09-30T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const DICTATION = "Here is the long dictated steer. ".repeat(120).trim()

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-failed-ledger-"))
  const path = join(dir, "ui.db")
  let storage = createStorage(path, "p")
  storage.upsertSession({
    slug: "t", session_id: "s", thread_name: "ntwine-t", spawned_at: iso(T0), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  return {
    get storage() { return storage },
    items: () => parseDeliveryLedger(storage.getSession("t")?.delivery_ledger),
    // A SERVER RESTART, as far as the ledger can tell: a fresh handle on the same file.
    reopen: () => { storage.close(); storage = createStorage(path, "p") },
    dispose: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const item = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1", text: "fix the bug", state: "sending", at: iso(T0), updatedAt: iso(T0), ...over,
})
const msg = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ role: "user", text: "fix the bug", tools: [], parts: [], ...over })

// ---- the row ----

test("the write-ahead entry exists BEFORE delivery, and a throw turns it failed with the text and error intact", () => {
  const l = ledger()
  try {
    assert.equal(beginDelivery(l.storage, "t", { id: "d-1", text: DICTATION, now: T0 }), "begin")
    assert.deepEqual(l.items().map((i) => [i.id, i.state, i.text.length]), [["d-1", "sending", DICTATION.length]])
    assert.equal(recordDeliveryFailure(l.storage, "t", "d-1", { error: "cold resume failed: spawn ENOENT", retryable: false, now: T0 + 3_000 }), true)
    const [failed] = l.items()
    assert.equal(failed.state, "failed")
    assert.equal(failed.text, DICTATION)
    assert.equal(failed.error, "cold resume failed: spawn ENOENT")
    assert.equal(failed.retryable, undefined)
  } finally { l.dispose() }
})

test("a failed entry survives a server restart", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: DICTATION, now: T0 })
    recordDeliveryFailure(l.storage, "t", "d-1", { error: "boom", retryable: false })
    l.reopen()
    const [failed] = l.items()
    assert.equal(failed.state, "failed")
    assert.equal(failed.text, DICTATION)
  } finally { l.dispose() }
})

test("a transport that answers settles the write-ahead entry in place, error cleared", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: "go", now: T0 })
    appendDelivery(l.storage, "t", { id: "d-1", text: "go", state: "enqueued", now: T0 + 2_000 })
    const [row] = l.items()
    assert.equal(row.state, "enqueued")
    assert.equal(row.at, iso(T0), "the bubble keeps its place")
    // …and a call that stalled into `failed` and THEN answered is delivered after all.
    beginDelivery(l.storage, "t", { id: "d-2", text: "late", now: T0 })
    recordDeliveryFailure(l.storage, "t", "d-2", { error: SENDING_STALL_ERROR, retryable: false })
    appendDelivery(l.storage, "t", { id: "d-2", text: "late", state: "delivered" })
    const late = l.items().find((i) => i.id === "d-2")!
    assert.equal(late.state, "delivered")
    assert.equal(late.error, undefined)
  } finally { l.dispose() }
})

test("replays: an accepted or in-flight id is a duplicate, a retryable refusal re-opens, an ambiguous failure never does", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "ok", text: "a" })
    appendDelivery(l.storage, "t", { id: "ok", text: "a", state: "delivered" })
    assert.equal(beginDelivery(l.storage, "t", { id: "ok", text: "a" }), "duplicate")

    beginDelivery(l.storage, "t", { id: "flying", text: "b" })
    assert.equal(beginDelivery(l.storage, "t", { id: "flying", text: "b" }), "duplicate", "a call still in flight is never sent twice")

    beginDelivery(l.storage, "t", { id: "gate", text: "c" })
    recordDeliveryFailure(l.storage, "t", "gate", { error: "Another runtime control is in progress", retryable: true })
    assert.equal(l.items().find((i) => i.id === "gate")!.state, "sending", "a retryable refusal waits for the client's replay")
    assert.equal(beginDelivery(l.storage, "t", { id: "gate", text: "c" }), "begin")

    beginDelivery(l.storage, "t", { id: "ambiguous", text: "d" })
    recordDeliveryFailure(l.storage, "t", "ambiguous", { error: "socket hang up", retryable: false })
    assert.equal(beginDelivery(l.storage, "t", { id: "ambiguous", text: "d" }), "duplicate")
    assert.equal(l.items().find((i) => i.id === "ambiguous")!.state, "failed", "the replay did not touch it")
  } finally { l.dispose() }
})

test("hasDelivery does not read a write-ahead or failed entry as delivered", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: "a" })
    assert.equal(hasDelivery(l.storage, "t", "d-1"), false)
    recordDeliveryFailure(l.storage, "t", "d-1", { error: "x", retryable: false })
    assert.equal(hasDelivery(l.storage, "t", "d-1"), false)
    appendDelivery(l.storage, "t", { id: "d-1", text: "a", state: "enqueued" })
    assert.equal(hasDelivery(l.storage, "t", "d-1"), true)
  } finally { l.dispose() }
})

test("Retry supersedes the failed entry in the same write that opens the new one", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "old", text: DICTATION })
    recordDeliveryFailure(l.storage, "t", "old", { error: "x", retryable: false })
    beginDelivery(l.storage, "t", { id: "other", text: "unrelated" })
    assert.equal(beginDelivery(l.storage, "t", { id: "new", text: DICTATION, supersedes: "old" }), "begin")
    assert.deepEqual(l.items().map((i) => [i.id, i.state]), [["other", "sending"], ["new", "sending"]])
    // Supersedes only ever reaches a failed or still-sending entry — never an accepted one.
    appendDelivery(l.storage, "t", { id: "other", text: "unrelated", state: "enqueued" })
    beginDelivery(l.storage, "t", { id: "newer", text: "x", supersedes: "other" })
    assert.equal(l.items().find((i) => i.id === "other")?.state, "enqueued")
  } finally { l.dispose() }
})

test("a late failure does not resurrect an entry the operator already superseded or dismissed", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "old", text: "a" })
    beginDelivery(l.storage, "t", { id: "new", text: "a", supersedes: "old" })
    assert.equal(recordDeliveryFailure(l.storage, "t", "old", { error: "late", retryable: false }), false)
    assert.deepEqual(l.items().map((i) => i.id), ["new"])
  } finally { l.dispose() }
})

test("dismiss removes only a failed entry", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "live", text: "a" })
    assert.equal(dismissFailedDelivery(l.storage, "t", "live"), false, "a send its transport still owns cannot be dismissed")
    recordDeliveryFailure(l.storage, "t", "live", { error: "x", retryable: false })
    assert.equal(dismissFailedDelivery(l.storage, "t", "live"), true)
    assert.deepEqual(l.items(), [])
  } finally { l.dispose() }
})

// ---- aging ----

test("a send with no answer reads as failed once the client's own deadline has passed — never sooner", () => {
  const items = [item()]
  assert.equal(ageDeliveries(items, T0 + 120_000), items, "the browser is still waiting at 2m")
  const [aged] = ageDeliveries(items, T0 + SENDING_STALL_MS + 1)
  assert.equal(aged.state, "failed")
  assert.equal(aged.error, SENDING_STALL_ERROR)
  assert.equal(aged.text, "fix the bug")
})

test("a retryable refusal whose replays stopped reads as failed after the short grace, keeping its error", () => {
  const items = [item({ retryable: true, error: "Another runtime control is in progress" })]
  assert.equal(ageDeliveries(items, T0 + RETRYABLE_SEND_GRACE_MS - 1), items)
  const [aged] = ageDeliveries(items, T0 + RETRYABLE_SEND_GRACE_MS + 1)
  assert.equal(aged.state, "failed")
  assert.equal(aged.error, "Another runtime control is in progress")
})

test("a failed send never ages out and is not retired by a later user turn", () => {
  const items = [item({ state: "failed", error: "x" })]
  // A day on, with a newer user record in the transcript — the rules that drop every other state.
  assert.equal(ageDeliveries(items, T0 + 24 * UNCONFIRMED_DROP_MS, iso(T0 + 60_000)), items)
  // …and the same exemption holds for a send still in flight: a scheduler wake can land mid-resume.
  const sending = [item()]
  assert.equal(ageDeliveries(sending, T0 + 30_000, iso(T0 + 20_000)), sending)
})

test("twenty-plus ordinary sends never evict a failed one", () => {
  const failed = item({ id: "failed", state: "failed", error: "x" })
  const live = Array.from({ length: MAX_LEDGER_ITEMS + 5 }, (_, n) => item({ id: `live-${n}`, state: "enqueued" }))
  const trimmed = trimLedger([failed, ...live])
  assert.ok(trimmed.some((i) => i.id === "failed"))
  assert.equal(trimmed.filter((i) => i.state !== "failed").length, MAX_LEDGER_ITEMS)
  // Failed sends have their own bound, oldest first.
  const many = Array.from({ length: MAX_FAILED_ITEMS + 2 }, (_, n) => item({ id: `f-${n}`, state: "failed" }))
  assert.deepEqual(trimLedger(many).map((i) => i.id), many.slice(2).map((i) => i.id))
})

// ---- correlation: the transcript can still prove a "failed" send landed ----

test("evidence the provider took a failed send clears the failure", () => {
  const failed = [item({ state: "failed", error: "ack timeout" })]
  const enqueued = correlateDeliveryRecord(failed, { type: "queue-operation", operation: "enqueue", content: "fix the bug", timestamp: iso(T0 + 500) }, iso(T0 + 500))
  assert.equal(enqueued[0].state, "enqueued")
  assert.equal(enqueued[0].error, undefined)
  const echoed = correlateDeliveryRecord(failed, { type: "user", uuid: "d-1", message: { content: "fix the bug" }, timestamp: iso(T0 + 500) }, iso(T0 + 500))
  assert.deepEqual(echoed, [])
})

// ---- projection ----

test("a failed send projects at the tail, not grayed, with its error", () => {
  const out = projectDeliveryLedger([msg({ role: "assistant", text: "done", at: iso(T0 - 1_000) })], [item({ state: "failed", text: DICTATION, error: "boom" })])
  const tail = out.at(-1)!
  assert.equal(tail.sourceId, "delivery:d-1")
  assert.equal(tail.text, DICTATION)
  assert.equal(tail.queued, false)
  assert.equal(tail.deliveryState, "failed")
  assert.equal(tail.deliveryError, "boom")
})

test("a write-ahead send projects as the gray bubble the client's optimistic copy is consumed by", () => {
  const [bubble] = projectDeliveryLedger([], [item()])
  assert.equal(bubble.queued, true)
  assert.equal(bubble.deliveryState, "sending")
  assert.equal(bubble.deliveryId, "d-1")
})

test("an OLDER identical message never hides a failed send", () => {
  // The operator said "continue" an hour ago; this "continue" failed. The old bubble is not this send.
  const history = [msg({ text: "continue", sourceId: "u-old", at: iso(T0 - 3_600_000) })]
  const out = projectDeliveryLedger(history, [item({ state: "failed", text: "continue", error: "x" })])
  assert.equal(out.length, 2)
  assert.equal(out[1].deliveryState, "failed")
})

test("the kept error is its first line, bounded — not a daemon's stack trace", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: "a" })
    const trace = "Claude broker exited before it became ready (exit code 1): Claude executable is not executable\n    at validateExecutablePath (/x/claude-agent-sdk.ts:1933:11)\n    at runClaudeBroker (/x/claude-agent-broker.ts:164:19)"
    recordDeliveryFailure(l.storage, "t", "d-1", { error: trace, retryable: false })
    assert.equal(l.items()[0].error, "Claude broker exited before it became ready (exit code 1): Claude executable is not executable")
    beginDelivery(l.storage, "t", { id: "d-2", text: "b" })
    recordDeliveryFailure(l.storage, "t", "d-2", { error: "x".repeat(1_000), retryable: false })
    assert.equal(l.items()[1].error!.length, 300)
  } finally { l.dispose() }
})
