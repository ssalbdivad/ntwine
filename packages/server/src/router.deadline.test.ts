// THE THREAD'S TIME LIMIT AT THE RPC BOUNDARY — the real router against real SQLite (ARCHITECTURE.md § Time limits).
//
// The rule these pin is the one the plan calls irreversible-in-spirit: ONLY THE HUMAN may move or clear a
// deadline the human set. A worker reads it, sets one where there is none, and moves only its own.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { ChildMailbox, SessionTelemetry, Tailer } from "./tailer.ts"
import { withDispatchCaller } from "./dispatch-caller.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-deadline-rpc-"))
  const project: Project = { dir, id: "dl", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  // Each thread's running children, by slug — what `liveMailboxes` answers (the real tailer reads them off disk).
  const children = new Map<string, ChildMailbox[]>()
  const tailer: Tailer = {
    get: () => ({ subAgents: [], bgShells: [] }) as unknown as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined,
    liveMailboxes: (slug) => children.get(slug) ?? [],
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = { project, storage, board, tailer, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  const notices = () => createWakeDeliveryStore(storage.scope).listOpen().filter((d) => d.fenceId.startsWith("deadline-notice:"))
  return { dir, storage, snapshot, children, notices, router: createRouter(ctx), close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-10-06T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  }
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()
const asWorker = <T>(fn: () => T) => withDispatchCaller({ origin: undefined, userAgent: "node" }, fn)
const asBrowser = <T>(fn: () => T) => withDispatchCaller({ origin: "http://localhost:9393", userAgent: "Mozilla/5.0" }, fn)

test("the human sets a deadline: a new generation, set by the human, and the worker is told", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const at = inMs(2 * 3_600_000)
    const got = await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: at } }))
    assert.equal(got.deadline?.at, new Date(at).toISOString())
    assert.equal(got.deadline?.setBy, "human")
    const stored = h.storage.getSession("t")!
    assert.equal(stored.deadline_at, new Date(at).toISOString())
    assert.equal(stored.deadline_set_by, "human")
    assert.equal(stored.deadline_stage, null)
    const notices = h.notices()
    assert.equal(notices.length, 1)
    assert.match(notices[0]!.message, /set a time limit/)
    assert.equal(notices[0]!.fenceId, `deadline-notice:set:${stored.deadline_set_at}`)
  } finally {
    h.close()
  }
})

test("a worker's transport cannot use the human's control", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      asWorker(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3_600_000) } })),
      /`ntwinectl deadline`/,
    )
    assert.equal(h.storage.getSession("t")!.deadline_at ?? null, null)
  } finally {
    h.close()
  }
})

test("ONLY THE HUMAN moves or clears a deadline the human set; the worker may read it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3_600_000) } }))
    const read = await h.router.ownDeadline.handler({ input: { slug: "t", action: "read" } })
    assert.equal(read.deadline?.setBy, "human")
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "2h" } }), /only the user can extend/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "clear" } }), /only the user can remove/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "2h" } }), /only the user can move/)
    // Untouched by every refusal.
    assert.equal(h.storage.getSession("t")!.deadline_at, read.deadline?.at)
    // …and the human can.
    const moved = await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3 * 3_600_000) } }))
    assert.ok(Date.parse(moved.deadline!.at) > Date.parse(read.deadline!.at))
    assert.match(h.notices().at(-1)!.message, /extended your deadline/)
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: null } }))
    assert.equal(h.storage.getSession("t")!.deadline_at, null)
    assert.match(h.notices().at(-1)!.message, /removed your time limit/)
  } finally {
    h.close()
  }
})

test("a worker sets one where there is none, then moves and clears its own", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const set = await h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "1h 30m" } })
    assert.equal(set.deadline?.setBy, "worker")
    const ms = Date.parse(set.deadline!.at) - Date.now()
    assert.ok(ms > 89 * 60_000 && ms <= 90 * 60_000, String(ms))
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "2h" } }), /use `extend`/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "30m" } }), /moves a deadline later/)
    const moved = await h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "2h" } })
    assert.ok(Date.parse(moved.deadline!.at) > Date.parse(set.deadline!.at))
    assert.notEqual(moved.deadline!.setAt, set.deadline!.setAt, "a move is a new generation")
    const cleared = await h.router.ownDeadline.handler({ input: { slug: "t", action: "clear" } })
    assert.equal(cleared.deadline, null)
    // The worker made each change itself, so nothing is queued to tell it.
    assert.equal(h.notices().length, 0)
  } finally {
    h.close()
  }
})

test("bounds: under a minute and past a week are refused on both doors", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(20_000) } })), /at least 1m/)
    await assert.rejects(asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(8 * 86_400_000) } })), /at most 7d/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "30s" } }), /at least 1m/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "15:30" } }), /not a duration/)
  } finally {
    h.close()
  }
})

test("a re-dispatch over the slug drops the old session's deadline; a resume keeps it", () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setDeadline("t", { deadlineAt: inMs(3_600_000), setAt: new Date().toISOString(), setBy: "human" })
    h.storage.upsertSession(h.storage.getSession("t")!)
    assert.ok(h.storage.getSession("t")!.deadline_at, "same session spread back keeps it")
    h.storage.upsertSession({ ...row("t"), session_id: "sid-fresh" })
    assert.equal(h.storage.getSession("t")!.deadline_at, null)
  } finally {
    h.close()
  }
})

test("the machine-wide wrap-up: every Running thread gets the deadline and the note; queued, snoozed and done ones are left alone", async () => {
  const h = harness()
  try {
    for (const slug of ["run", "soon", "queued", "snoozed", "done"]) h.storage.upsertSession(row(slug))
    h.storage.setState("done", "archived")
    const view = (id: string, extra: Record<string, unknown>) => ({ id, kind: "session", state: "open", needsYou: false, ...extra }) as never
    h.snapshot.threads.push(
      view("run", {}),
      view("soon", {}),
      view("queued", { needsYou: true }),
      view("snoozed", { snoozedUntil: inMs(3_600_000), awaiting: { kind: "timer" } }),
      view("done", { state: "archived" }),
    )
    const soonAt = inMs(5 * 60_000)
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "soon", deadline: soonAt } }))
    const at = inMs(15 * 60_000)
    const got = await asBrowser(() => h.router.setRunningDeadlines.handler({ input: { deadline: at, note: "Restarting the machine in 15m.\nOptimize resumability." } }))
    assert.deepEqual(got, { threads: 2, projects: 1, children: 0 })
    assert.equal(h.storage.getSession("run")!.deadline_at, new Date(at).toISOString())
    assert.equal(h.storage.getSession("soon")!.deadline_at, new Date(soonAt).toISOString(), "a sooner deadline is kept")
    for (const slug of ["queued", "snoozed", "done"]) assert.equal(h.storage.getSession(slug)!.deadline_at ?? null, null, slug)
    const bySlug = new Map(h.notices().map((n) => [n.slug, n.message]))
    assert.match(bySlug.get("run")!, /set a time limit/)
    assert.match(bySlug.get("run")!, /> Restarting the machine in 15m\.\n> Optimize resumability\./)
    assert.match(bySlug.get("soon")!, /kept your deadline/)
    assert.match(bySlug.get("soon")!, /> Restarting the machine/)
  } finally {
    h.close()
  }
})

test("the machine-wide wrap-up called off: every Running thread's limit is removed and its worker told; others keep theirs", async () => {
  const h = harness()
  try {
    for (const slug of ["run", "free", "queued"]) h.storage.upsertSession(row(slug))
    const view = (id: string, extra: Record<string, unknown>) => ({ id, kind: "session", state: "open", needsYou: false, ...extra }) as never
    h.snapshot.threads.push(view("run", {}), view("free", {}), view("queued", { needsYou: true }))
    const at = inMs(15 * 60_000)
    for (const slug of ["run", "queued"]) await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug, deadline: at } }))
    const got = await asBrowser(() => h.router.setRunningDeadlines.handler({ input: { deadline: null } }))
    assert.deepEqual(got, { threads: 1, projects: 1, children: 0 }, "only a thread that had a limit counts")
    assert.equal(h.storage.getSession("run")!.deadline_at ?? null, null)
    assert.equal(h.storage.getSession("queued")!.deadline_at, new Date(at).toISOString(), "a queued thread keeps its limit")
    const bySlug = new Map(h.notices().map((n) => [n.slug, n.message]))
    assert.match(bySlug.get("run")!, /removed your time limit/)
    assert.equal(bySlug.get("free"), undefined)
    await assert.rejects(asWorker(() => h.router.setRunningDeadlines.handler({ input: { deadline: null } })), /Only the user/)
  } finally {
    h.close()
  }
})

test("the machine-wide wrap-up is the user's: a worker's transport is refused", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("run"))
    h.snapshot.threads.push({ id: "run", kind: "session", state: "open", needsYou: false } as never)
    await assert.rejects(asWorker(() => h.router.setRunningDeadlines.handler({ input: { deadline: inMs(15 * 60_000) } })), /Only the user/)
    assert.equal(h.storage.getSession("run")!.deadline_at ?? null, null)
  } finally {
    h.close()
  }
})

// ---- THE CHANGE REACHES RUNNING CHILDREN (router reachChildren → agent-inbox.ts) ----
// On 2026-10-08 four parents handed off within a minute of a 5m limit while their twelve children ran on
// unaware. Each child now gets its share of the limit in its deadline file and the user's note in its mailbox.

const childDeadline = (sessionDir: string, agentId: string) => JSON.parse(readFileSync(join(sessionDir, "ntwine-deadlines", `${agentId}.json`), "utf8"))
const childInbox = (sessionDir: string, agentId: string) =>
  readdirSync(join(sessionDir, "ntwine-inbox", agentId)).map((f) => JSON.parse(readFileSync(join(sessionDir, "ntwine-inbox", agentId, f), "utf8")))

test("the wrap-up reaches each running child — with a share that leaves the parent a reserve — and a queued thread's children without waking it", async () => {
  const h = harness()
  try {
    for (const slug of ["run", "resting", "quiet"]) h.storage.upsertSession(row(slug))
    const sessionDir = join(h.dir, "session")
    h.children.set("run", [{ agentId: "aaaaaaaaaaaaaaaa1", sessionDir, label: "impl" }, { agentId: "aaaaaaaaaaaaaaaa2", sessionDir, label: "review" }])
    h.children.set("resting", [{ agentId: "bbbbbbbbbbbbbbbb1", sessionDir, label: "drivers" }])
    h.snapshot.threads.push(
      { id: "run", kind: "session", state: "open", needsYou: false } as never,
      { id: "resting", kind: "session", state: "open", needsYou: true } as never,
      { id: "quiet", kind: "session", state: "open", needsYou: true } as never, // queued, no children: left alone
    )
    const at = inMs(15 * 60_000)
    const got = await asBrowser(() => h.router.setRunningDeadlines.handler({ input: { deadline: at, note: "Restarting the machine." } }))
    assert.deepEqual(got, { threads: 2, projects: 1, children: 3 })

    const share = childDeadline(sessionDir, "aaaaaaaaaaaaaaaa1")
    assert.equal(share.setBy, "user")
    assert.equal(share.announce, true)
    const reserve = Date.parse(at) - share.atMs
    assert.ok(reserve > 4.9 * 60_000 && reserve < 5.1 * 60_000, `a 15m limit leaves the parent its 5m reserve, got ${reserve}ms`)
    assert.match(childInbox(sessionDir, "bbbbbbbbbbbbbbbb1")[0].text, /> Restarting the machine\./)
    assert.equal(childInbox(sessionDir, "bbbbbbbbbbbbbbbb1")[0].from, "operator")

    assert.equal(h.storage.getSession("resting")!.deadline_at, new Date(at).toISOString(), "the queued thread carries the limit")
    assert.deepEqual(h.notices().map((n) => n.slug), ["run"], "but only the RUNNING worker is woken with a notice")
    assert.equal(h.storage.getSession("quiet")!.deadline_at ?? null, null)
  } finally {
    h.close()
  }
})

test("one thread's limit reaches its children too, and lifting it lifts theirs", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const sessionDir = join(h.dir, "session")
    h.children.set("t", [{ agentId: "ccccccccccccccccc", sessionDir, label: "child" }])
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3_600_000) } }))
    assert.equal(childDeadline(sessionDir, "ccccccccccccccccc").setBy, "user")
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: null } }))
    assert.deepEqual(childDeadline(sessionDir, "ccccccccccccccccc"), { none: true })
    assert.match(childInbox(sessionDir, "ccccccccccccccccc").at(-1).text, /removed the time limit/)
  } finally {
    h.close()
  }
})
