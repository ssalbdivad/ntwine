import { test } from "node:test"
import assert from "node:assert/strict"

// The module singletons read sessionStorage at construction, so the tab's storage must exist before
// they are imported — the same order a real page load has.
const backing = new Map<string, string>()
Object.assign(globalThis, {
  sessionStorage: { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) },
})
const { PENDING_SEND_MAX_AGE_MS, PENDING_SENDS_STORAGE_KEY, pendingSends } = await import("./pendingSends.ts")
const { replayPendingSends, trackPendingSend } = await import("./eagerComposerSubmission.ts")
const { draftKey, draftStore } = await import("./drafts.ts")

const now = 1_000_000_000
const send = (over: Partial<Parameters<typeof pendingSends.add>[0]> = {}) => ({
  deliveryId: "d1", apiBase: "/_frizz/p1", projectDir: "/repo", slug: "fix-auth", sessionId: "s1", message: "yes, ship it", at: now, ...over,
})

test("an in-flight send is recorded until it settles, and a corrupt ledger reads as empty", async () => {
  backing.clear()
  let release!: () => void
  const done = trackPendingSend(send(), () => new Promise<void>((r) => { release = r }))
  assert.deepEqual(pendingSends.list().map((s) => s.deliveryId), ["d1"])
  release()
  await done
  assert.deepEqual(pendingSends.list(), [])
  backing.set(PENDING_SENDS_STORAGE_KEY, "{not json")
  assert.deepEqual(pendingSends.list(), [])
})

test("a send orphaned by a reload is replayed under its ORIGINAL deliveryId, then forgotten", async () => {
  backing.clear()
  pendingSends.add(send())
  const attempts: string[] = []
  await replayPendingSends(now + 5_000, async (s) => { attempts.push(`${s.apiBase} ${s.slug} ${s.deliveryId} ${s.message}`) })
  assert.deepEqual(attempts, ["/_frizz/p1 fix-auth d1 yes, ship it"])
  assert.deepEqual(pendingSends.list(), [])
  assert.equal(draftStore.get(draftKey.followUp("/repo", "fix-auth", "s1")), "")
})

test("a replay that fails puts the text back in that thread's prompt box instead of dropping it", async () => {
  backing.clear()
  const key = draftKey.followUp("/repo", "fix-auth", "s1")
  draftStore.set(key, "half-typed")
  pendingSends.add(send())
  await replayPendingSends(now + 5_000, async () => { throw new Error("RPC followUp returned a non-JSON response (HTTP 503)") })
  assert.equal(draftStore.get(key), "yes, ship it\n\nhalf-typed")
  assert.deepEqual(pendingSends.list(), [])
  draftStore.clear(key)
})

test("an entry too old to send unannounced is restored to the draft, never sent", async () => {
  backing.clear()
  const key = draftKey.followUp("/repo", "fix-auth", "s1")
  pendingSends.add(send())
  let sent = false
  await replayPendingSends(now + PENDING_SEND_MAX_AGE_MS + 1, async () => { sent = true })
  assert.equal(sent, false)
  assert.equal(draftStore.get(key), "yes, ship it")
  draftStore.clear(key)
})
