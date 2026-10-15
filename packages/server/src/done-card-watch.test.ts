// THE DONE CARD'S WATCH BUTTON (2026-10-07) — router.watchDoneRef against real SQLite and the REAL board.
//
// The click is the human saying "this thread is finished, but tell it when its PR moves". What has to
// hold, end to end through the board the browser bands from:
//   - it arms the same `pr_watch` row the worker tools arm (one poller), marked as the human's;
//   - PR or issue is found out by the two registration probes, never guessed from prose;
//   - the thread leaves the queue and rests in Waiting as a `watching` rest, done card intact (it rested
//     in Snoozed until 2026-10-14, when Snoozed became a time the human picks and nothing else);
//   - the park belongs to THIS rest: the worker's next rest decides the place again;
//   - it is not the worker's wait, so it neither supersedes nor gates the worker's `done`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inWaitingBand, isSnoozed, sectionOf, type Settings, type ThreadView } from "@ntwine/shared"
import { createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { PrProbe, PrRef } from "./scheduler.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const REST = "2026-10-07T12:00:00.000Z"
const NOW = Date.parse(REST) + 5 * 60_000
const DONE_BODY = "Pushed the fix to #1685; CI is green."

function harness(opts: { probePr?: (ref: PrRef) => PrProbe; probeIssue?: (ref: PrRef) => PrProbe; tele?: Partial<SessionTelemetry> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-done-watch-"))
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const probed: string[] = []
  let tele: Partial<SessionTelemetry> = {
    turn: "idle", lastAssistantAt: REST, lastActivityAt: REST,
    lastFence: { kind: "done", body: DONE_BODY, hints: [] },
    ...opts.tele,
  }
  const tailer = {
    get: () => ({ permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...tele }) as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "done-watch", { claudeBrokerDaemonAlive: () => true, now: () => NOW })
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    probePr: async (ref: PrRef) => { probed.push(`pr ${ref.owner}/${ref.repo}#${ref.number}`); return opts.probePr?.(ref) ?? { ok: true as const } },
    probeIssue: async (ref: PrRef) => { probed.push(`issue ${ref.owner}/${ref.repo}#${ref.number}`); return opts.probeIssue?.(ref) ?? { ok: true as const } },
  } as unknown as AppContext
  storage.upsertSession(row())
  storage.setBackend("t", "claude")
  storage.setClaudeRuntime("t", "broker")
  storage.setRestedAt("t", REST)
  return {
    storage,
    router: createRouter(ctx),
    probed,
    view: (): ThreadView => board.refresh().threads.find((t) => t.id === "t")!,
    setTele: (next: Partial<SessionTelemetry>) => { tele = { ...tele, ...next } },
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "sess-t", thread_name: "ntwine-t", spawned_at: "2026-10-07T11:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: REST, title_auto: 0,
    title: "t", state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const watch = (h: ReturnType<typeof harness>, target = "acme/app#1685") =>
  h.router.watchDoneRef.handler({ input: { slug: "t", sessionId: "sess-t", target } })

test("a done thread is in the queue until the human watches its PR, then it rests in Waiting as a watch", async () => {
  const h = harness()
  try {
    // The control: the done card queues on its own.
    const before = h.view()
    assert.equal(before.needsYou, true)
    assert.equal(sectionOf(before), "active")
    assert.equal(isSnoozed(before), false)

    const result = await watch(h)
    assert.deepEqual(result, { target: "acme/app#1685", kind: "pull", alreadyArmed: false })
    assert.deepEqual(h.probed, ["pr acme/app#1685"], "a readable PR needs no issue probe")
    const [armed] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.deepEqual(
      { kind: armed.kind, owner: armed.owner, repo: armed.repo, number: armed.number, by: armed.registered_by },
      { kind: "pull", owner: "acme", repo: "app", number: 1685, by: "human" },
    )
    assert.ok(armed.expires_at! > NOW + 300 * 86_400_000, "no deadline to pick: it runs to the ceiling")

    const after = h.view()
    assert.equal(after.needsYou, false, "out of the queue")
    assert.equal(after.waitStatus, "watching")
    assert.equal(inWaitingBand(after), true)
    assert.equal(isSnoozed(after), false, "Waiting, in view — not folded into Snoozed")
    assert.equal(after.lastFence?.kind, "done", "the done card is still the thread's last word")
    assert.ok((after.watches ?? []).some((w) => w.kind === "github" && w.target === "acme/app#1685" && w.state === "armed"))
  } finally { h.close() }
})

test("the park is THIS rest's: the worker's next rest puts the thread back where its answer says", async () => {
  const h = harness()
  try {
    await watch(h)
    assert.equal(inWaitingBand(h.view()), true)
    // The watch woke the worker and it rested again with a new done: a new rest, the park is spent, and
    // the human sees the news in the queue.
    const later = new Date(Date.parse(REST) + 60_000).toISOString()
    h.storage.setRestedAt("t", later)
    h.setTele({ lastAssistantAt: later, lastActivityAt: later, lastUserAt: new Date(Date.parse(REST) + 30_000).toISOString(), lastFence: { kind: "done", body: "Fixed the red CI.", hints: [] } })
    const v = h.view()
    assert.equal(v.needsYou, true)
    assert.equal(sectionOf(v), "active")
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 1, "the watch itself stays armed")
  } finally { h.close() }
})

test("a number that is not a PR is probed as an issue, and armed as one", async () => {
  const h = harness({ probePr: () => ({ ok: false, reason: "GraphQL: Could not resolve to a PullRequest with the number of 12." }) })
  try {
    const result = await watch(h, "acme/app#12")
    assert.deepEqual(result, { target: "acme/app#12", kind: "issue", alreadyArmed: false })
    assert.deepEqual(h.probed, ["pr acme/app#12", "issue acme/app#12"])
    const [armed] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.equal(armed.kind, "issue")
    assert.match(armed.id, /^isw_/)
    assert.equal(inWaitingBand(h.view()), true)
  } finally { h.close() }
})

test("a ref GitHub cannot read is refused with the reason, and nothing is armed or parked", async () => {
  const h = harness({
    probePr: () => ({ ok: false, reason: "HTTP 404: Not Found" }),
    probeIssue: () => ({ ok: false, reason: "HTTP 404: Not Found" }),
  })
  try {
    await assert.rejects(watch(h, "acme/gone#9"), /Couldn't read acme\/gone#9 on GitHub: HTTP 404/)
    assert.equal(h.storage.listPrWatches("t").length, 0)
    assert.equal(h.storage.getSession("t")?.bg_snooze_rested_at ?? null, null)
    assert.equal(h.view().needsYou, true, "still in the queue")
  } finally { h.close() }
})

test("a PR the worker already watches is not armed twice — only the park is new", async () => {
  const h = harness()
  try {
    h.storage.armPrWatch({ id: "prw_worker", slug: "t", owner: "acme", repo: "app", number: 1685, createdAtMs: NOW - 1000, expiresAtMs: NOW + 86_400_000 })
    const result = await watch(h, "Acme/App#1685")
    assert.equal(result.alreadyArmed, true)
    assert.deepEqual(h.probed, [], "no probe for a ref already being polled")
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 1)
  } finally { h.close() }
})

test("an archived thread, a working one and a replaced session are refused", async () => {
  const h = harness()
  try {
    await assert.rejects(h.router.watchDoneRef.handler({ input: { slug: "t", sessionId: "other", target: "acme/app#1" } }), /replaced/)
    h.storage.setRestedAt("t", null as unknown as string)
    await assert.rejects(watch(h), /still working/)
    h.storage.setRestedAt("t", REST)
    h.storage.setState("t", "archived")
    await assert.rejects(watch(h), /Reopen this thread/)
    assert.equal(h.storage.listPrWatches("t").length, 0)
  } finally { h.close() }
})

test("the human's watch neither supersedes a registered done nor gates the worker's next one; a worker's does both", async () => {
  const h = harness({ tele: { lastFence: undefined } })
  try {
    h.storage.markThreadDone("t", DONE_BODY, Date.parse(REST))
    assert.equal(h.view().lastFence?.kind, "done", "the registered done cards")
    await watch(h)
    const v = h.view()
    assert.equal(v.lastFence?.kind, "done", "a human's watch leaves the done standing")
    assert.equal(inWaitingBand(v), true)
    const done = await h.router.markOwnDone.handler({ input: { slug: "t", body: "Fixed the red CI." } })
    assert.equal(done.done, true, "the human's watch is not the worker's outstanding wait")

    // The control: a WORKER's own watcher supersedes the done and gates the next one, as it always has.
    h.storage.armPrWatch({ id: "prw_worker", slug: "t", owner: "acme", repo: "app", number: 7, createdAtMs: NOW, expiresAtMs: NOW + 86_400_000 })
    assert.notEqual(h.view().lastFence?.kind, "done")
    const refused = await h.router.markOwnDone.handler({ input: { slug: "t", body: "again" } })
    assert.equal(refused.done, false)
    assert.deepEqual(refused.blockingWatches.map((w) => w.id), ["prw_worker"])
  } finally { h.close() }
})
