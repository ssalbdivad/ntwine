// `mcp__ntwine__extend_shell` AT THE RPC BOUNDARY — the real router against real SQLite.
//
// The answer to a background shell's over-budget warning (shell-budget.ts). Every refusal here is a
// worker that would otherwise believe it bought time for a shell it did not extend.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { BgShellView, SessionTelemetry, SubAgentView, Tailer } from "./tailer.ts"
import { liveShellBudget } from "./shell-budget.ts"

function harness(tele: Partial<SessionTelemetry> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-extend-shell-rpc-"))
  const project: Project = { dir, id: "exts", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ subAgents: [], bgShells: [], ...tele }) as unknown as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = { project, storage, board, tailer, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  return { storage, router: createRouter(ctx), close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-09-29T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  }
}

const STARTED = new Date(Date.now() - 50 * 60_000).toISOString()
const shell = (over: Partial<BgShellView> = {}): BgShellView => ({
  label: "npx vite", startedAt: STARTED, state: "running", id: "toolu_sh", taskId: "bvite1", stoppable: true, budgetMs: 3_600_000, ...over,
})
const agent = (): SubAgentView => ({ label: "Auditing", startedAt: STARTED, state: "running", id: "toolu_agent" })

test("extend_shell moves the budget to `for` from NOW, durably, by any handle the worker holds", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    for (const handle of ["bvite1", "toolu_sh", "npx vite"]) {
      const before = Date.now()
      const got = await h.router.extendOwnShell.handler({ input: { slug: "t", shell: handle, for: "2h" } })
      assert.equal(got.shell, "bvite1", "read back by the handle every other readout uses")
      assert.equal(got.clampedFrom, undefined)
      const ends = Date.parse(got.budgetEndsAt)
      assert.ok(ends >= before + 2 * 3_600_000 && ends <= Date.now() + 2 * 3_600_000, handle)
      // The row the scheduler reads — keyed on the row id, whatever handle the worker used.
      assert.equal(liveShellBudget(h.storage, "t", shell())?.deadlineMs, ends)
    }
  } finally {
    h.close()
  }
})

test("extend_shell caps at 24h and SAYS so", async () => {
  const h = harness({ bgShells: [shell()] })
  try {
    h.storage.upsertSession(row("t"))
    const got = await h.router.extendOwnShell.handler({ input: { slug: "t", shell: "bvite1", for: "3d" } })
    assert.equal(got.clampedFrom, "3d")
    assert.ok(Date.parse(got.budgetEndsAt) <= Date.now() + 24 * 3_600_000)
  } finally {
    h.close()
  }
})

test("extend_shell refuses what it cannot extend — and names why", async () => {
  const h = harness({
    bgShells: [shell({ id: "toolu_done", taskId: "bdone", state: "stale" }), shell({ id: "toolu_mon", taskId: "bmon", label: "tail log", budgetMs: undefined, monitor: true })],
    subAgents: [agent()],
  })
  try {
    h.storage.upsertSession(row("t"))
    const refuse = (shellHandle: string, forValue: string, pattern: RegExp) =>
      assert.rejects(() => h.router.extendOwnShell.handler({ input: { slug: "t", shell: shellHandle, for: forValue } }), pattern)
    await refuse("nope", "2h", /no background shell running on this thread answers to `nope`/)
    await refuse("bdone", "2h", /no background shell running/)
    await refuse("toolu_agent", "2h", /is a sub-agent, not a background shell/)
    await refuse("bmon", "2h", /is a Monitor, which carries no runtime budget/)
    const live = harness({ bgShells: [shell()] })
    try {
      live.storage.upsertSession(row("t"))
      await assert.rejects(() => live.router.extendOwnShell.handler({ input: { slug: "t", shell: "bvite1", for: "two hours" } }), /is not a duration/)
      assert.equal(live.storage.getShellBudget("t", "toolu_sh"), undefined, "a refusal writes nothing")
    } finally {
      live.close()
    }
    await assert.rejects(() => h.router.extendOwnShell.handler({ input: { slug: "ghost", shell: "bvite1", for: "2h" } }), /not registered/)
  } finally {
    h.close()
  }
})

test("activity prints each running shell's budget end — the extension when there is one", async () => {
  const h = harness({ bgShells: [shell(), shell({ id: "toolu_mon", taskId: "bmon", label: "tail log", budgetMs: undefined, monitor: true }), shell({ id: "toolu_dev", taskId: "bdev", label: "npx vite dev", budgetMs: undefined })] })
  try {
    h.storage.upsertSession(row("t"))
    const before = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    const vite = before.activity.find((a) => a.id === "bvite1")!
    assert.equal(vite.budgetEndsAt, new Date(Date.parse(STARTED) + 3_600_000).toISOString(), "launch + its budget")
    assert.equal(before.activity.find((a) => a.id === "bmon")!.budgetEndsAt, undefined, "a Monitor has none")
    assert.equal(before.activity.find((a) => a.id === "bdev")!.budgetEndsAt, undefined, "nor does a shell launched without a timeout")
    const ext = await h.router.extendOwnShell.handler({ input: { slug: "t", shell: "bvite1", for: "5h" } })
    const after = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.equal(after.activity.find((a) => a.id === "bvite1")!.budgetEndsAt, ext.budgetEndsAt)
  } finally {
    h.close()
  }
})

// A shell launched with NO `timeout` has no budget (shell-budget.ts); extend_shell is how it gets one.
test("extend_shell GIVES a budget to a shell launched without one — and only to that shell", async () => {
  const dev = shell({ id: "toolu_dev", taskId: "bdev", label: "npx vite dev", budgetMs: undefined })
  // NEGATIVE CONTROL: a second unbudgeted shell on the same thread, not extended.
  const other = shell({ id: "toolu_srv", taskId: "bsrv", label: "node server.mjs", budgetMs: undefined })
  const h = harness({ bgShells: [dev, other] })
  try {
    h.storage.upsertSession(row("t"))
    assert.equal(liveShellBudget(h.storage, "t", dev), undefined, "unbudgeted before")
    const before = Date.now()
    const got = await h.router.extendOwnShell.handler({ input: { slug: "t", shell: "bdev", for: "3h" } })
    const ends = Date.parse(got.budgetEndsAt)
    assert.ok(ends >= before + 3 * 3_600_000 && ends <= Date.now() + 3 * 3_600_000)
    assert.equal(liveShellBudget(h.storage, "t", dev)?.deadlineMs, ends, "the scheduler now reads a deadline for it")
    assert.equal(liveShellBudget(h.storage, "t", other), undefined, "and still none for the shell nobody extended")
    const activity = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.equal(activity.activity.find((a) => a.id === "bdev")!.budgetEndsAt, got.budgetEndsAt)
    assert.equal(activity.activity.find((a) => a.id === "bsrv")!.budgetEndsAt, undefined)
  } finally {
    h.close()
  }
})
