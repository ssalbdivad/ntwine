import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { appendDelivery, cancelDelivery, hasDelivery, parseDeliveryLedger } from "./delivery-ledger.ts"

// The persisted half of taking a message back. The projection rules live in delivery-ledger.test.ts;
// this pins what the ROW does, because the tombstone is what survives a reload and a server restart —
// the whole reason the cancellation is not just a client-side splice.
const T0 = "2026-07-28T10:00:00.000Z"

function ledger(over: Partial<SessionRow> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-cancel-ledger-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug: "t", session_id: "s", thread_name: "ntwine-t", spawned_at: T0, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  })
  return {
    storage,
    items: () => parseDeliveryLedger(storage.getSession("t")?.delivery_ledger),
    // Close the db BEFORE removing the dir: Windows refuses to delete a file another handle still has
    // open, so an unclosed storage turns cleanup into EPERM once every assertion has already passed.
    dispose: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("cancelDelivery tombstones the row in place and hands back the text", () => {
  const l = ledger()
  try {
    appendDelivery(l.storage, "t", { id: "d-1", text: "wait, not that", state: "enqueued" })
    assert.equal(cancelDelivery(l.storage, "t", "d-1"), "wait, not that")
    const [row] = l.items()
    assert.equal(row.state, "cancelled")
    // Identity and text are RETAINED: the id keeps a replayed send deduped, and the text is what the
    // projection matches the orphaned JSONL enqueue bubble against.
    assert.equal(row.id, "d-1")
    assert.equal(row.text, "wait, not that")
  } finally { l.dispose() }
})

test("a second cancel is a no-op — a double click cannot restore the same text twice", () => {
  const l = ledger()
  try {
    appendDelivery(l.storage, "t", { id: "d-1", text: "wait, not that", state: "enqueued" })
    assert.equal(cancelDelivery(l.storage, "t", "d-1"), "wait, not that")
    assert.equal(cancelDelivery(l.storage, "t", "d-1"), null)
    assert.equal(l.items().length, 1)
  } finally { l.dispose() }
})

test("a cancelled id is still a delivery on record, so a replayed send stays deduped", () => {
  const l = ledger()
  try {
    appendDelivery(l.storage, "t", { id: "d-1", text: "wait, not that", state: "enqueued" })
    cancelDelivery(l.storage, "t", "d-1")
    assert.equal(hasDelivery(l.storage, "t", "d-1"), true)
    // …and re-appending under the same id cannot revive it as a live send.
    appendDelivery(l.storage, "t", { id: "d-1", text: "wait, not that" })
    assert.equal(l.items()[0].state, "cancelled")
  } finally { l.dispose() }
})

test("cancelling an id ntwine never sent changes nothing", () => {
  const l = ledger()
  try {
    appendDelivery(l.storage, "t", { id: "d-1", text: "still going", state: "enqueued" })
    assert.equal(cancelDelivery(l.storage, "t", "nope"), null)
    assert.equal(l.items()[0].state, "enqueued")
  } finally { l.dispose() }
})
