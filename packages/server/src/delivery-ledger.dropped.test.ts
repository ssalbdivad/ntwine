import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import { createStorage } from "./storage.ts"
import {
  appendDelivery,
  beginDelivery,
  cancelDelivery,
  correlateDeliveryRecord,
  dismissFailedDelivery,
  parseDeliveryLedger,
  projectDeliveryLedger,
  recordDeliveryDropped,
  recordDeliveryFailure,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"

// A SEND THE BROKER DAEMON THREW AWAY. The daemon reports it with an `input dropped` diagnostic naming
// the delivery id, and until 2026-10-01 the server answered by tombstoning the row (`cancelled`) — the
// state for an operator's deliberate unqueue, which keeps the text in the row and renders nothing. The
// operator's message simply vanished. It is now `failed`, flagged `dropped`, so it renders with its
// text and Retry / Edit / Dismiss like any send whose transport threw.
const T0 = Date.parse("2026-10-01T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const DICTATION = "A long steer the operator dictated while the agent was busy. ".repeat(60).trim()
const REFUSAL = "Claude outstanding input limit exceeded"

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-dropped-ledger-"))
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

const dropped = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1", text: "fix the bug", state: "failed", dropped: true,
  error: `The Claude session refused this message: ${REFUSAL}`, at: iso(T0), updatedAt: iso(T0 + 50), ...over,
})
const msg = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ role: "user", text: "fix the bug", tools: [], parts: [], ...over })
const enqueue = (text: string, atMs: number) => ({ type: "queue-operation", operation: "enqueue", content: text, timestamp: iso(atMs) })

test("a drop reported after the router recorded success turns the send failed with its text — not a tombstone", () => {
  // The daemon too old to acknowledge an input: followUp resolved the moment the frame was written, so
  // the row is already `enqueued` when the drop diagnostic arrives.
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: DICTATION, now: T0 })
    appendDelivery(l.storage, "t", { id: "d-1", text: DICTATION, state: "enqueued", now: T0 + 20 })
    assert.equal(recordDeliveryDropped(l.storage, "t", "d-1", REFUSAL, T0 + 50), true)
    const [row] = l.items()
    assert.equal(row.state, "failed", "the operator's send, kept — never `cancelled`")
    assert.equal(row.dropped, true)
    assert.equal(row.text, DICTATION)
    assert.equal(row.error, `The Claude session refused this message: ${REFUSAL}`)
    assert.equal(row.at, iso(T0), "the bubble keeps its place")
    // What the operator sees: their whole message, not grayed, with the reason under it.
    const out = projectDeliveryLedger([msg({ text: "earlier", at: iso(T0 - 60_000) })], l.items())
    assert.equal(out.length, 2)
    const bubble = out[1]
    assert.equal(bubble.text, DICTATION)
    assert.equal(bubble.queued, false)
    assert.equal(bubble.deliveryState, "failed")
    assert.equal(bubble.deliveryId, "d-1")
    assert.equal(bubble.deliveryError, `The Claude session refused this message: ${REFUSAL}`)
  } finally { l.dispose() }
})

test("every live state turns failed on a drop; a cancelled tombstone and an unknown id do not", () => {
  const l = ledger()
  try {
    for (const state of ["pending", "delivered", "unconfirmed"] as const) {
      const id = `d-${state}`
      appendDelivery(l.storage, "t", { id, text: state, state, now: T0 })
      assert.equal(recordDeliveryDropped(l.storage, "t", id, REFUSAL), true, state)
      assert.equal(l.items().find((i) => i.id === id)?.state, "failed", state)
    }
    // An unqueue the operator already made stays exactly what it was: a deliberate take-back.
    appendDelivery(l.storage, "t", { id: "taken-back", text: "never mind", state: "enqueued", now: T0 })
    assert.equal(cancelDelivery(l.storage, "t", "taken-back"), "never mind")
    assert.equal(recordDeliveryDropped(l.storage, "t", "taken-back", REFUSAL), false)
    assert.equal(l.items().find((i) => i.id === "taken-back")?.state, "cancelled")
    assert.equal(recordDeliveryDropped(l.storage, "t", "nobody", REFUSAL), false)
  } finally { l.dispose() }
})

test("an acknowledging daemon's refusal and its drop diagnostic agree in either order, and the send is kept", () => {
  // input-ack-v1: the daemon answers the frame with the refusal AND relays the drop. The router's catch
  // (recordDeliveryFailure) and the diagnostic handler (recordDeliveryDropped) race; the client is told
  // `kept` only when recordDeliveryFailure returns true, so it must still find the entry either way.
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "diag-first", text: "a", now: T0 })
    assert.equal(recordDeliveryDropped(l.storage, "t", "diag-first", REFUSAL), true)
    assert.equal(recordDeliveryFailure(l.storage, "t", "diag-first", { error: `The Claude session refused this message: ${REFUSAL}`, retryable: false }), true)
    beginDelivery(l.storage, "t", { id: "ack-first", text: "b", now: T0 })
    assert.equal(recordDeliveryFailure(l.storage, "t", "ack-first", { error: `The Claude session refused this message: ${REFUSAL}`, retryable: false }), true)
    assert.equal(recordDeliveryDropped(l.storage, "t", "ack-first", REFUSAL), true)
    for (const row of l.items()) {
      assert.equal(row.state, "failed", row.id)
      assert.equal(row.dropped, true, row.id)
      assert.equal(row.error, `The Claude session refused this message: ${REFUSAL}`, row.id)
    }
  } finally { l.dispose() }
})

test("a late frame-written receipt does not settle a dropped send", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: "go", now: T0 })
    recordDeliveryDropped(l.storage, "t", "d-1", REFUSAL)
    appendDelivery(l.storage, "t", { id: "d-1", text: "go", state: "enqueued" })
    assert.equal(l.items()[0].state, "failed")
  } finally { l.dispose() }
})

test("a boot replay of an enqueue record with the same words never re-queues a dropped send", () => {
  // The tailer re-folds a thread's whole JSONL on boot whenever its ledger is non-empty, and an enqueue
  // record is contemporaneous with the send it belongs to. A plain `failed` item (a throw AFTER the
  // provider took the text) is rightly upgraded by one; a dropped send never reached the CLI, so the
  // record is another send's, and upgrading would put the gray queued bubble back for an hour.
  const record = enqueue("fix the bug", T0 + 30)
  const plain = correlateDeliveryRecord([dropped({ dropped: undefined })], record, iso(T0 + 1_000))
  assert.equal(plain[0].state, "enqueued", "control: the same record DOES upgrade an ordinary failed send")
  const kept = correlateDeliveryRecord([dropped()], record, iso(T0 + 1_000))
  assert.equal(kept[0].state, "failed")
  assert.equal(kept[0].dropped, true)
})

test("no text evidence retires a dropped send; only the SDK echoing its own id does", () => {
  const items = [dropped()]
  const at = iso(T0 + 1_000)
  const remove = { type: "queue-operation", operation: "remove", content: "fix the bug", timestamp: at }
  const user = { type: "user", message: { role: "user", content: "fix the bug" }, uuid: "someone-else", timestamp: at }
  const attachment = { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: "fix the bug" }, timestamp: at }
  for (const rec of [remove, user, attachment]) {
    assert.equal(correlateDeliveryRecord(items, rec, at), items, `${rec.type} with the same words is not this send`)
  }
  // Identity is different: a record carrying THIS id is the SDK saying it has this exact send.
  const echoed = { type: "user", message: { role: "user", content: "fix the bug" }, uuid: "d-1", timestamp: at }
  assert.deepEqual(correlateDeliveryRecord(items, echoed, at), [])
})

test("a dropped send never adopts another send's identical bubble — both stay on screen", () => {
  // The operator sent the same words twice in a second; the first landed and the second was dropped.
  const landedQueued = msg({ at: iso(T0 + 200), queued: true, sourceId: "jsonl-1" })
  const out = projectDeliveryLedger([landedQueued], [dropped()])
  assert.equal(out.length, 2)
  assert.equal(out[0].queued, true, "the landed send keeps its own styling")
  assert.equal(out[0].deliveryId, undefined, "and is not tagged as the dropped one")
  assert.equal(out[1].deliveryState, "failed")
  // …and after the FIFO backstop un-grays it, the dropped send is still not hidden behind it.
  const landed = msg({ at: iso(T0 + 200), sourceId: "jsonl-1" })
  const after = projectDeliveryLedger([landed], [dropped()])
  assert.equal(after.length, 2)
  assert.equal(after[1].deliveryState, "failed")
  assert.equal(after[1].text, "fix the bug")
})

test("a dropped send survives a restart, and Retry or Dismiss clears it like any failed send", () => {
  const l = ledger()
  try {
    beginDelivery(l.storage, "t", { id: "d-1", text: DICTATION, now: T0 })
    recordDeliveryDropped(l.storage, "t", "d-1", REFUSAL)
    l.reopen()
    assert.deepEqual(l.items().map((i) => [i.state, i.dropped, i.text.length]), [["failed", true, DICTATION.length]])
    // Retry: a new id that supersedes the dropped one in the same write.
    assert.equal(beginDelivery(l.storage, "t", { id: "d-2", text: DICTATION, supersedes: "d-1" }), "begin")
    assert.deepEqual(l.items().map((i) => [i.id, i.state]), [["d-2", "sending"]])
    // Dismiss.
    recordDeliveryDropped(l.storage, "t", "d-2", REFUSAL)
    assert.equal(dismissFailedDelivery(l.storage, "t", "d-2"), true)
    assert.deepEqual(l.items(), [])
  } finally { l.dispose() }
})
