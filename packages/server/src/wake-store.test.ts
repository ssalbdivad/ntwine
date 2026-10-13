import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { createWakeDeliveryStore, isQuietWindowExempt, WAKE_QUIET_WINDOW_MS, type WakeDeliveryInput } from "./wake-store.ts"

// The outbox's own half of wake coalescing: the QUIET WINDOW is carried by `next_attempt_at` at enqueue,
// so `claim` needs no new rule, and `adopt` is how the scheduler's merge leases a held row beside a
// claimed one. The scheduler's half — the merge itself — is pinned in scheduler.test.ts ("coalesce:").

function store(quietWindowMs?: number) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-wake-")), "ui.db"), "p")
  return { storage, outbox: createWakeDeliveryStore(storage.scope, quietWindowMs === undefined ? {} : { quietWindowMs }) }
}

function wake(id: string, over: Partial<WakeDeliveryInput> = {}): WakeDeliveryInput {
  return { id, slug: "t", sessionId: "sid", fenceId: `fence:${id}`, hintKey: `key:${id}`, message: `message ${id}`, reason: `reason ${id}`, ...over }
}

const T0 = Date.parse("2026-09-03T13:00:00.000Z")

test("quiet window: a wake enqueued after a handoff is due when the window ends; the first one is due at once", () => {
  const { storage, outbox } = store()
  assert.equal(outbox.enqueue(wake("a"), T0).delivery.nextAttemptAt, T0, "no handoff yet")
  const a = outbox.claim("me", T0, T0 + 30_000, 6)!
  assert.ok(outbox.acknowledge(a.id, "me", T0 + 1_000))

  const b = outbox.enqueue(wake("b"), T0 + 60_000).delivery
  assert.equal(b.nextAttemptAt, T0 + 1_000 + WAKE_QUIET_WINDOW_MS, "measured from the delivery, not from the enqueue")
  assert.equal(outbox.claim("me", T0 + 60_000, T0 + 90_000, 6), undefined, "not claimable inside the window")
  assert.equal(outbox.claim("me", b.nextAttemptAt - 1, T0 + 90_000, 6), undefined)
  assert.equal(outbox.claim("me", b.nextAttemptAt, b.nextAttemptAt + 30_000, 6)?.id, "b", "claimable the instant it ends")
  storage.close()
})

test("quiet window: a SENT wake is a handoff too — the turn began when the frame went out, not when it was confirmed", () => {
  const { storage, outbox } = store()
  outbox.enqueue(wake("a"), T0)
  const a = outbox.claim("me", T0, T0 + 30_000, 6)!
  assert.ok(outbox.markSent(a.id, "me", T0 + 5_000, T0 + 65_000))
  assert.equal(outbox.enqueue(wake("b"), T0 + 10_000).delivery.nextAttemptAt, T0 + 5_000 + WAKE_QUIET_WINDOW_MS)
  storage.close()
})

test("quiet window: an answer and a limit resume are not held; the exemption is by hint-key prefix", () => {
  assert.equal(isQuietWindowExempt("answers:abc123"), true)
  assert.equal(isQuietWindowExempt("limit:session"), true)
  assert.equal(isQuietWindowExempt("limit:model-switch"), true)
  // The interrupt note reports children the human's own send just killed; the worker is mid-turn on
  // that send and must hear it before it rests on a dead id (see interruptEndedSubAgentsMessage).
  assert.equal(isQuietWindowExempt("interrupt-ended:1700000000000"), true)
  assert.equal(isQuietWindowExempt("shell-budget:1700000000000:toolu_sh"), true)
  // The sign-off nudge and the fence corrections answer the worker's own rest — the card the human is
  // reading now. An EXPIRED park is a scheduled re-check, and stays held.
  assert.equal(isQuietWindowExempt("signoff:rest"), true)
  assert.equal(isQuietWindowExempt("park:dead:2026-09-25T21:59:41.787Z"), true)
  assert.equal(isQuietWindowExempt("park:retired:2026-09-25T21:59:41.787Z"), true)
  assert.equal(isQuietWindowExempt("park:nameless:2026-09-25T21:59:41.787Z"), true)
  assert.equal(isQuietWindowExempt("park:question:2026-09-25T21:59:41.787Z"), true)
  assert.equal(isQuietWindowExempt("park:expired:2026-09-25T21:59:41.787Z"), false)
  assert.equal(isQuietWindowExempt("prwatch:prw_1"), false)
  assert.equal(isQuietWindowExempt("timer:tmr_1"), false)
  const { storage, outbox } = store()
  outbox.enqueue(wake("a"), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  assert.equal(outbox.enqueue(wake("held"), T0 + 1_000).delivery.nextAttemptAt, T0 + WAKE_QUIET_WINDOW_MS)
  assert.equal(outbox.enqueue(wake("ans", { hintKey: "answers:abc" }), T0 + 2_000).delivery.nextAttemptAt, T0 + 2_000)
  assert.equal(outbox.enqueue(wake("lim", { hintKey: "limit:session" }), T0 + 3_000).delivery.nextAttemptAt, T0 + 3_000)
  assert.equal(outbox.claim("me", T0 + 3_000, T0 + 33_000, 6)?.id, "ans", "the exempt rows are due, oldest first")
  assert.equal(outbox.claim("me", T0 + 3_000, T0 + 33_000, 6)?.id, "lim")
  assert.equal(outbox.claim("me", T0 + 3_000, T0 + 33_000, 6), undefined, "the held one is still held")
  storage.close()
})

test("quiet window: the window is per THREAD — another thread's handoff holds nothing here", () => {
  const { storage, outbox } = store()
  outbox.enqueue(wake("a", { slug: "other" }), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  assert.equal(outbox.enqueue(wake("b"), T0 + 1_000).delivery.nextAttemptAt, T0 + 1_000)
  storage.close()
})

test("adopt leases a held row where claim will not, and refuses a row that is not pending", () => {
  const { storage, outbox } = store()
  outbox.enqueue(wake("a"), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  const held = outbox.enqueue(wake("b"), T0 + 1_000).delivery
  assert.ok(held.nextAttemptAt > T0 + 1_000)
  assert.equal(outbox.claim("me", T0 + 1_000, T0 + 31_000, 6), undefined)
  const adopted = outbox.adopt("b", "me", T0 + 1_000, T0 + 31_000, 6)
  assert.equal(adopted?.state, "leased")
  assert.equal(adopted?.attempts, 1, "an adoption is an attempt, like a claim")
  assert.equal(adopted?.leaseOwner, "me")
  assert.equal(outbox.adopt("b", "me", T0 + 1_000, T0 + 31_000, 6), undefined, "already leased")
  assert.equal(outbox.adopt("a", "me", T0 + 1_000, T0 + 31_000, 6), undefined, "already delivered")
  assert.equal(outbox.adopt("nope", "me", T0 + 1_000, T0 + 31_000, 6), undefined)
  storage.close()
})

test("adopt honours the attempt cap exactly as claim does", () => {
  const { storage, outbox } = store(0)
  outbox.enqueue(wake("a"), T0)
  assert.equal(outbox.adopt("a", "me", T0, T0 + 30_000, 0), undefined, "cap of zero: never")
  assert.equal(outbox.adopt("a", "me", T0, T0 + 30_000, 1)?.attempts, 1)
  storage.close()
})

test("pendingFor lists a thread's pending rows in creation order, held or not, and nothing else", () => {
  const { storage, outbox } = store()
  outbox.enqueue(wake("a"), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  outbox.enqueue(wake("c"), T0 + 2_000)
  outbox.enqueue(wake("b"), T0 + 1_000)
  outbox.enqueue(wake("elsewhere", { slug: "other" }), T0 + 1_000)
  outbox.enqueue(wake("old-session", { sessionId: "sid-old" }), T0 + 1_000)
  assert.deepEqual(outbox.pendingFor("t", "sid").map((d) => d.id), ["b", "c"])
  outbox.adopt("b", "me", T0 + 3_000, T0 + 33_000, 6)
  assert.deepEqual(outbox.pendingFor("t", "sid").map((d) => d.id), ["c"], "a leased row is no longer pending")
  storage.close()
})

test("a repeat enqueue of the same fence returns the existing row and leaves its window alone", () => {
  const { storage, outbox } = store()
  outbox.enqueue(wake("a"), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  const first = outbox.enqueue(wake("b"), T0 + 1_000)
  assert.equal(first.effect, "created")
  const again = outbox.enqueue(wake("b"), T0 + WAKE_QUIET_WINDOW_MS + 60_000)
  assert.equal(again.effect, "existing")
  assert.equal(again.delivery.nextAttemptAt, first.delivery.nextAttemptAt)
  assert.equal(again.delivery.createdAt, T0 + 1_000)
  storage.close()
})

test("a window of zero disables the hold", () => {
  const { storage, outbox } = store(0)
  outbox.enqueue(wake("a"), T0)
  outbox.acknowledge(outbox.claim("me", T0, T0 + 30_000, 6)!.id, "me", T0)
  assert.equal(outbox.enqueue(wake("b"), T0 + 1_000).delivery.nextAttemptAt, T0 + 1_000)
  assert.equal(outbox.claim("me", T0 + 1_000, T0 + 31_000, 6)?.id, "b")
  storage.close()
})
