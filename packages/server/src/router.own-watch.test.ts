// THE WORKER'S OWN WATCH REGISTRY at the RPC boundary — the real router against real SQLite.
//
// `mcp__ntwine__watch` registers a wait on work this thread already has running, so that coming to rest
// stops being a line the worker restates in a fence at every rest (plans/rest-by-registration.md). What
// makes this registry different from the PR one is that its target cannot be validated by SHAPE: a
// background shell's handle and a sub-agent's handle are both opaque runtime strings that overlap
// completely, so the only exact answer available is live telemetry's.
//
// Every test here is a way a worker could come to rest believing it is covered when it is not.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@ntwine/shared"
import { AWAITING_FOR_MAX_MS, OWN_WATCH_MAX_ARMED } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
// The tailer keeps its OWN copies of these two shapes, deliberately decoupled from the wire schema —
// and the handler reads TELEMETRY, so these are the ones a fixture has to satisfy.
import type { BgShellView, SessionTelemetry, SubAgentView, Tailer } from "./tailer.ts"

function harness(tele: Partial<SessionTelemetry> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-own-watch-rpc-"))
  const project: Project = { dir, id: "ownw", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ subAgents: [], bgShells: [], ...tele }) as unknown as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-08-26T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const shell = (over: Partial<BgShellView> = {}): BgShellView => ({
  label: "nub --test", startedAt: "2026-08-26T00:00:00.000Z", state: "running",
  id: "toolu_shell", taskId: "bzvtnt3ig", ...over,
})

const agent = (over: Partial<SubAgentView> = {}): SubAgentView => ({
  label: "Auditing token overhead", startedAt: "2026-08-26T00:00:00.000Z", state: "running",
  id: "toolu_agent", ...over,
})

test("add registers a live shell by the handle the runtime showed the worker", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    // The taskId, because "Command running in background with ID: bzvtnt3ig" is the ONE id a worker ever
    // reads — matching on the launch tool_use id alone made every honest shell watcher unfireable once
    // already (scheduler.evalWatchers, 2026-08-14).
    const added = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "2h" } })
    assert.equal(added.alreadyArmed, false)
    assert.equal(added.kind, "shell")
    assert.deepEqual(added.watches.map((w) => w.target), ["bzvtnt3ig"])
    // The label is re-resolved from telemetry on every read rather than stored, so it is either current
    // or absent — never a confident name for work that has since ended.
    assert.deepEqual(added.watches.map((w) => w.label), ["nub --test"])
    const [stored] = h.storage.listThreadWatches("t", { armedOnly: true })
    assert.deepEqual({ kind: stored.kind, target: stored.target, state: stored.state }, { kind: "shell", target: "bzvtnt3ig", state: "armed" })
    assert.equal(stored.expires_at - stored.created_at, 2 * 60 * 60 * 1000)
    assert.equal(h.refreshes() > 0, true, "the board must re-derive: a new registration can change the park")
  } finally { h.close() }
})

test("a sub-agent registered as a shell is REFUSED, and told what it actually is", async () => {
  const h = harness({ subAgents: [agent()] })
  try {
    h.storage.upsertSession(row("t"))
    // The exact miss that filed two sub-agents under a "Background shells" heading on 2026-08-26. Shape
    // could never have caught it — `toolu_agent` is the same shape as a shell's launch id — so the kind
    // is resolved from telemetry and the refusal NAMES the mismatch instead of guessing.
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "toolu_agent", for: "2h" } }),
      /is a sub-agent, not a background shell/,
    )
    assert.deepEqual(h.storage.listThreadWatches("t", { armedOnly: true }), [])
  } finally { h.close() }
})

test("a handle nothing live answers to is REFUSED rather than stored", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    // A watch on work that is over can never fire, and the worker would rest behind it until the expiry.
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "nope", for: "2h" } }),
      /nothing running on this thread answers to/,
    )
  } finally { h.close() }
})

test("a shell that has gone stale is no longer watchable", async () => {
  const h = harness({ bgShells: [shell({ state: "stale" })] })
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "2h" } }),
      /nothing running on this thread answers to/,
    )
  } finally { h.close() }
})

test("registering the same (kind, target) twice returns the SAME row and moves no expiry", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "20m" } })
    // Re-registering after a compaction is the COMMON, CORRECT case — the worker has forgotten what it
    // holds and is being careful. A second row would mean two wakes; a replaced row would move an expiry
    // the human is already reading off the card.
    const again = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "3d" } })
    assert.equal(again.alreadyArmed, true)
    assert.equal(again.id, first.id)
    const [stored] = h.storage.listThreadWatches("t", { armedOnly: true })
    assert.equal(stored.expires_at - stored.created_at, 20 * 60 * 1000, "the FIRST duration stands")
  } finally { h.close() }
})

test("`for` is required and an unparseable one is refused, never silently defaulted", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    // Unlike watch_pr's `for`, which is optional only for sessions whose MCP binary predates the field.
    // This RPC has no such sessions, so a duration it cannot read means the worker tried to choose and
    // got it wrong — and substituting a number would hide that.
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "soon" } }),
      /is not a duration/,
    )
    assert.deepEqual(h.storage.listThreadWatches("t", { armedOnly: true }), [])
  } finally { h.close() }
})

// THE CEILING STAYS A DAY HERE, where a PR watcher now gets a year: a shell dies with its session, so a
// wait on one standing longer than that is a wait on something already gone. What changed is that the
// cap is SAID — a worker handed a day when it asked for a year, and told nothing, has no way to learn it.
test("a `for` above the day ceiling is capped, and the worker is told rather than left to assume", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "365d" } })
    assert.equal(added.clampedFrom, "365d")
    const [stored] = h.storage.listThreadWatches("t", { armedOnly: true })
    assert.equal(stored.expires_at - stored.created_at, AWAITING_FOR_MAX_MS)
  } finally { h.close() }
})

test("a `for` inside the ceiling is left alone and reports no cap", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "45m" } })
    assert.equal(added.clampedFrom, undefined)
    const [stored] = h.storage.listThreadWatches("t", { armedOnly: true })
    assert.equal(stored.expires_at - stored.created_at, 45 * 60_000)
  } finally { h.close() }
})

test("an archived thread refuses a registration", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "2h" } }),
      /Reopen this thread/,
    )
  } finally { h.close() }
})

test("the armed set is bounded, and the bound names itself", async () => {
  const shells = Array.from({ length: OWN_WATCH_MAX_ARMED + 1 }, (_, i) => shell({ id: `toolu_${i}`, taskId: `task_${i}`, label: `shell ${i}` }))
  const h = harness({ bgShells: shells })
  try {
    h.storage.upsertSession(row("t"))
    for (let i = 0; i < OWN_WATCH_MAX_ARMED; i++) {
      await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: `task_${i}`, for: "2h" } })
    }
    await assert.rejects(
      () => h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: `task_${OWN_WATCH_MAX_ARMED}`, for: "2h" } }),
      new RegExp(`the limit is ${OWN_WATCH_MAX_ARMED}`),
    )
  } finally { h.close() }
})

test("drop is scoped to the caller's own thread, and a miss is reported rather than swallowed", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const added = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "2h" } })
    // Another thread holding the id cannot drop it — a worker that believes it withdrew a wait it still
    // holds will come to rest behind it.
    const foreign = await h.router.dropOwnWatch.handler({ input: { slug: "other", id: added.id } })
    assert.equal(foreign.dropped, false)
    assert.deepEqual(h.storage.listThreadWatches("t", { armedOnly: true }).map((w) => w.id), [added.id])

    const own = await h.router.dropOwnWatch.handler({ input: { slug: "t", id: added.id } })
    assert.equal(own.dropped, true)
    assert.deepEqual(own.watches, [])
    // Dropped, not deleted: the row survives as history in a settled state.
    assert.deepEqual(h.storage.listThreadWatches("t").map((w) => w.state), ["dropped"])

    const twice = await h.router.dropOwnWatch.handler({ input: { slug: "t", id: added.id } })
    assert.equal(twice.dropped, false)
  } finally { h.close() }
})

test("a watch whose target has since ended still reads back, and names itself rather than lying", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnWatch.handler({ input: { slug: "t", kind: "shell", target: "bzvtnt3ig", for: "2h" } })
    assert.deepEqual(added.watches.map((w) => w.label), ["nub --test"])
    // The shell finishes. The row stands — settling it is the scheduler's job, not a read's — but its
    // label goes ABSENT rather than staying a confident name for work that is over.
    const gone = harness({ bgShells: [] })
    try {
      gone.storage.upsertSession(row("t"))
      gone.storage.armThreadWatch({ id: added.id, slug: "t", kind: "shell", target: "bzvtnt3ig", createdAtMs: Date.now(), expiresAtMs: Date.now() + 3600_000 })
      const after = await gone.router.dropOwnWatch.handler({ input: { slug: "t", id: "wch_nothing" } })
      assert.equal(after.dropped, false)
      assert.deepEqual(after.watches.map((w) => ({ target: w.target, label: w.label })), [{ target: "bzvtnt3ig", label: undefined }])
    } finally { gone.close() }
  } finally { h.close() }
})
