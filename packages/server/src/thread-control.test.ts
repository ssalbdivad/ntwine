import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BoardSnapshot, Settings, ThreadView } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createRouter, type AppRouter } from "./router.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createTerminalRunner } from "./thread-terminals.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

const NTWINECTL = fileURLToPath(new URL("../../../cc-worker/bin/ntwinectl.mjs", import.meta.url))

type HarnessOpts = {
  id: string
  name: string
  telemetryBySlug?: Map<string, SessionTelemetry>
  liveDaemons?: Set<string>
}

type TenantHarness = {
  dir: string
  project: Project
  storage: Storage
  board: BoardManager
  ctx: AppContext
  router: AppRouter
  stoppedDaemons: string[]
  close: () => void
}

type CliRun = { code: number | null; stdout: string; stderr: string }

function sessionRow(slug: string, title: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    thread_name: `ntwine-${slug}`,
    spawned_at: new Date().toISOString(),
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title,
    state: "open",
    meta: null,
    seen_at: null,
    transcript_id: null,
    backend: "claude",
    claude_runtime: "broker",
    model: "opus",
    effort: "high",
    ...over,
  }
}

function threadViewFromRow(r: SessionRow, telemetry?: SessionTelemetry): ThreadView {
  const archived = r.state === "archived" || r.archived === 1
  const turn = telemetry?.turn ?? "idle"
  return {
    id: r.slug,
    kind: "session",
    title: r.title ?? r.slug,
    status: turn === "in-flight" ? "active" : "done",
    state: archived ? "archived" : "open",
    sessionId: r.session_id,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    pinnedAt: r.pinned_at ?? undefined,
    snoozedUntil: r.snoozed_until ?? undefined,
    subAgents: telemetry?.subAgents ?? [],
    bgShells: telemetry?.bgShells ?? [],
    questions: [],
    lastFence: telemetry?.lastFence,
  } satisfies Partial<ThreadView> as never
}

function makeCtx(partial: Partial<AppContext>): AppContext {
  return partial as never
}

function makeSettings(partial: Partial<Settings>): Settings {
  return partial as never
}

function makeHarness({ id, name, telemetryBySlug = new Map(), liveDaemons = new Set() }: HarnessOpts): TenantHarness {
  const dir = mkdtempSync(join(tmpdir(), `ntwine-ctrl-${name}-`))
  const project: Project = { dir, id, name, label: name, stateDir: dir, cwdSlug: name }
  const storage = createStorage(join(dir, "ui.db"), id)
  const terminals = createTerminalRunner({ storage, onChange: () => {} })
  const stoppedDaemons: string[] = []

  const snapshotNow = (): BoardSnapshot => ({
    projectDir: dir,
    projectName: name,
    projectLabel: name,
    projectSlug: name,
    threads: storage.allSessions().map((r) => threadViewFromRow(r, telemetryBySlug.get(r.slug))),
    errors: [],
    warnings: [],
  })

  const board: BoardManager = {
    snapshot: async () => snapshotNow(),
    currentSeq: () => 0,
    rebuild: async () => snapshotNow(),
    refresh: () => snapshotNow(),
    start: async () => {},
    stop: async () => {},
  }

  const tailer: Tailer = {
    get: (slug) => telemetryBySlug.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  }

  const claudeBroker: AppContext["claudeBroker"] = {
    isDaemonAlive: (sessionId: string) => liveDaemons.has(sessionId),
    releaseSession: (_threadSlug: string, sessionId: string) => {
      const had = liveDaemons.delete(sessionId)
      if (had) stoppedDaemons.push(sessionId)
      return had
    },
    retireDaemon: ({ sessionId }: { sessionId: string }) => {
      const had = liveDaemons.delete(sessionId)
      if (had) stoppedDaemons.push(sessionId)
      return had
    },
  } satisfies Partial<NonNullable<AppContext["claudeBroker"]>> as never

  const ctx = makeCtx({
    project,
    storage,
    board,
    tailer,
    terminalRunner: terminals,
    claudeBroker,
    scheduler: { kick: () => {} } satisfies Partial<AppContext["scheduler"]> as never,
    getSettings: () => makeSettings({ permissionMode: "bypassPermissions" }),
  })
  const router = createRouter(ctx)

  return {
    dir,
    project,
    storage,
    board,
    ctx,
    router,
    stoppedDaemons,
    close: () => {
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function linkTenants(tenants: readonly TenantHarness[]): void {
  const entries = tenants.map((t) => ({ project: t.project, board: t.board, ctx: t.ctx }))
  for (const t of tenants) {
    ;(t.ctx as { activeTenants?: unknown }).activeTenants = () => entries
  }
}

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NTWINE_/.test(k)))
}

function runCli(argv: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NTWINECTL, ...argv], {
      cwd: mkdtempSync(join(tmpdir(), "ntwinectl-e2e-cwd-")),
      env: { ...hostEnv(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("controlThread `done` archives a resting thread, refuses a running thread until `--force`, and records optional `--body`", async () => {
  const telemetry = new Map<string, SessionTelemetry>()
  const live = new Set<string>(["sid-idle", "sid-busy"])
  const h = makeHarness({ id: "proj-1", name: "slash", telemetryBySlug: telemetry, liveDaemons: live })
  try {
    h.storage.upsertSession(sessionRow("caller", "Migration PRs"))
    h.storage.upsertSession(sessionRow("idle", "Catalog price"))
    h.storage.upsertSession(sessionRow("busy", "Cross field"))
    h.storage.setClaudeRuntime("idle", "broker")
    h.storage.setClaudeRuntime("busy", "broker")

    telemetry.set("idle", { turn: "idle", subAgents: [], bgShells: [] } satisfies Partial<SessionTelemetry> as never)
    telemetry.set("busy", {
      turn: "in-flight",
      subAgents: [{ id: "sa-1", label: "port-cross-field", state: "running", startedAt: new Date().toISOString() }],
      bgShells: [],
    } satisfies Partial<SessionTelemetry> as never)

    // Resting thread with idle daemon → stops daemon, archives to Done, stores optional body.
    const doneIdle = await h.router.controlThread.handler({
      input: { slug: "caller", action: "done", handle: "@catalog-price", body: "Folded into #25329." },
    })
    assert.equal(doneIdle.ok, true)
    assert.equal(h.storage.getSession("idle")?.state, "archived")
    assert.equal(h.storage.getSession("idle")?.exited, 1)
    assert.equal(h.storage.getThreadDone("idle")?.body, "Folded into #25329.")
    assert.deepEqual(h.stoppedDaemons, ["sid-idle"])

    // Idempotent when already done.
    const again = await h.router.controlThread.handler({
      input: { slug: "caller", action: "done", handle: "@catalog-price" },
    })
    assert.equal(again.ok, true)
    assert.match(again.text, /already done/)

    // Running thread without --force → refused with hold details.
    const held = await h.router.controlThread.handler({
      input: { slug: "caller", action: "done", handle: "@cross-field" },
    })
    assert.equal(held.ok, false)
    assert.equal(held.refused, true)
    assert.equal(held.hold?.turnInFlight, true)
    assert.equal(held.hold?.subAgentCount, 1)
    assert.match(held.text, /port-cross-field/)
    assert.match(held.text, /--force/)
    assert.equal(h.storage.getSession("busy")?.state, "open")

    // With --force → stops live daemon and archives to Done.
    const forced = await h.router.controlThread.handler({
      input: { slug: "caller", action: "done", handle: "@cross-field", force: true },
    })
    assert.equal(forced.ok, true)
    assert.equal(h.storage.getSession("busy")?.state, "archived")
    assert.ok(h.stoppedDaemons.includes("sid-busy"))
  } finally {
    h.close()
  }
})

test("controlThread supports reopen, pin/unpin, snooze/unsnooze, rename, deadline, answer/dismiss questions, and delete", async () => {
  const telemetry = new Map<string, SessionTelemetry>()
  const h = makeHarness({ id: "proj-1", name: "slash", telemetryBySlug: telemetry })
  try {
    h.storage.upsertSession(sessionRow("caller", "Migration PRs"))
    h.storage.upsertSession(sessionRow("target", "Invite states", { state: "archived", archived: 1 }))
    telemetry.set("target", { turn: "idle", subAgents: [], bgShells: [] } satisfies Partial<SessionTelemetry> as never)

    // Reopen.
    const reopened = await h.router.controlThread.handler({ input: { slug: "caller", action: "reopen", handle: "@invite-states" } })
    assert.equal(reopened.ok, true)
    assert.equal(h.storage.getSession("target")?.state, "open")

    // Pin & unpin.
    const pinned = await h.router.controlThread.handler({ input: { slug: "caller", action: "pin", handle: "@invite-states" } })
    assert.equal(pinned.ok, true)
    assert.ok(h.storage.getSession("target")?.pinned_at)
    const unpinned = await h.router.controlThread.handler({ input: { slug: "caller", action: "unpin", handle: "@invite-states" } })
    assert.equal(unpinned.ok, true)
    assert.equal(h.storage.getSession("target")?.pinned_at, null)

    // Snooze & unsnooze.
    const snoozed = await h.router.controlThread.handler({
      input: { slug: "caller", action: "snooze", handle: "@invite-states", for: "2h", prompt: "Re-check invite modal" },
    })
    assert.equal(snoozed.ok, true)
    assert.ok(h.storage.getSession("target")?.snoozed_until)
    assert.equal(h.storage.getSession("target")?.snooze_prompt, "Re-check invite modal")
    const woke = await h.router.controlThread.handler({ input: { slug: "caller", action: "unsnooze", handle: "@invite-states" } })
    assert.equal(woke.ok, true)
    assert.equal(h.storage.getSession("target")?.snoozed_until, null)

    // Rename (and duplicate refusal).
    const renamed = await h.router.controlThread.handler({ input: { slug: "caller", action: "rename", handle: "@invite-states", title: "Invite modal" } })
    assert.equal(renamed.ok, true)
    assert.equal(h.storage.getSession("target")?.title, "Invite modal")
    const dup = await h.router.controlThread.handler({ input: { slug: "caller", action: "rename", handle: "@invite-modal", title: "Migration PRs" } })
    assert.equal(dup.ok, false)
    assert.equal(dup.refused, true)

    // Deadline set & clear.
    const dlSet = await h.router.controlThread.handler({ input: { slug: "caller", action: "deadline", handle: "@invite-modal", for: "1h" } })
    assert.equal(dlSet.ok, true)
    assert.ok(h.storage.getSession("target")?.deadline_at)
    const dlClear = await h.router.controlThread.handler({ input: { slug: "caller", action: "deadline", handle: "@invite-modal", clear: true } })
    assert.equal(dlClear.ok, true)
    assert.equal(h.storage.getSession("target")?.deadline_at, null)

    // Ask on target, then answer and dismiss from caller.
    const asked = await h.router.ask.handler({
      input: {
        slug: "target",
        questions: [
          { question: "Ship now?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] },
          { question: "Also clean up?", kind: "question", options: [{ label: "Sure" }] },
        ],
      },
    })
    const [q1, q2] = asked.registered
    const ans = await h.router.controlThread.handler({
      input: { slug: "caller", action: "answer", handle: "@invite-modal", questionId: q1.id, answer: "Yes" },
    })
    assert.equal(ans.ok, true)
    assert.match(ans.text, /Answered 1 question/)
    const dis = await h.router.controlThread.handler({
      input: { slug: "caller", action: "dismiss_questions", handle: "@invite-modal" },
    })
    assert.equal(dis.ok, true)
    assert.match(dis.text, new RegExp(q2.id))

    // Delete removes the row and frees the handle.
    const del = await h.router.controlThread.handler({ input: { slug: "caller", action: "delete", handle: "@invite-modal" } })
    assert.equal(del.ok, true)
    assert.equal(h.storage.getSession("target"), undefined)
  } finally {
    h.close()
  }
})

test("messageThread --reopen reopens an archived thread and delivers the wake; ownTerminal take/give transfers control", async () => {
  const h = makeHarness({ id: "proj-1", name: "slash" })
  try {
    h.storage.upsertSession(sessionRow("caller", "Migration PRs"))
    h.storage.upsertSession(sessionRow("archived-one", "Local stack", { state: "archived", archived: 1 }))

    const refused = await h.router.messageThread.handler({
      input: { slug: "caller", handle: "@local-stack", message: "Come back" },
    })
    assert.equal(refused.sent, false)
    assert.match(refused.refusal ?? "", /--reopen/)

    const sent = await h.router.messageThread.handler({
      input: { slug: "caller", handle: "@local-stack", message: "Come back", reopen: true },
    })
    assert.equal(sent.sent, true)
    assert.equal(h.storage.getSession("archived-one")?.state, "open")
    const wakes = createWakeDeliveryStore(h.storage.scope).list()
    assert.ok(wakes.some((w) => w.slug === "archived-one"))

    // Terminal take & give regardless of current driver.
    h.storage.insertThreadTerminal({
      slug: "term-1",
      startedBy: "human",
      handle: "dev-server",
      command: "pnpm run dev",
      cwd: h.dir,
      shell: false,
      createdAtMs: Date.now(),
    })
    const took = await h.router.ownTerminal.handler({ input: { slug: "caller", action: "take", handle: "@dev-server" } })
    assert.equal(took.refused, undefined)
    assert.equal(took.driving, true)

    const gave = await h.router.ownTerminal.handler({ input: { slug: "caller", action: "give", handle: "@dev-server", to: "@local-stack" } })
    assert.equal(gave.refused, undefined)
    assert.equal(gave.controller, "local-stack")
  } finally {
    h.close()
  }
})

test("end-to-end: real `ntwinectl` CLI controls threads across projects via `thread` and `--thread @handle`", async () => {
  const slashTel = new Map<string, SessionTelemetry>()
  const arkTel = new Map<string, SessionTelemetry>()
  const slash = makeHarness({ id: "proj-slash", name: "slash", telemetryBySlug: slashTel })
  const arktype = makeHarness({ id: "proj-arktype", name: "arktype", telemetryBySlug: arkTel })
  linkTenants([slash, arktype])

  slash.storage.upsertSession(sessionRow("mig", "Migration PRs"))
  arktype.storage.upsertSession(sessionRow("aot", "AOT bytes"))
  slashTel.set("mig", { turn: "idle", subAgents: [], bgShells: [] } satisfies Partial<SessionTelemetry> as never)
  arkTel.set("aot", { turn: "idle", subAgents: [], bgShells: [] } satisfies Partial<SessionTelemetry> as never)

  const routers = new Map<string, AppRouter>([
    ["proj-slash", slash.router],
    ["proj-arktype", arktype.router],
  ])

  const http: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", async () => {
      const m = /^\/_ntwine\/([^/]+)\/rpc\/([^/]+)$/.exec(req.url ?? "")
      const router = m ? routers.get(decodeURIComponent(m[1])) : undefined
      const proc = m && router ? (router as Record<string, { handler: (args: { input: unknown }) => Promise<unknown> }>)[m[2]] : undefined
      if (!proc) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `not found: ${req.url}` }))
        return
      }
      try {
        const input = raw ? JSON.parse(raw) : {}
        const result = await proc.handler({ input })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ result }))
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = join(mkdtempSync(join(tmpdir(), "ntwine-e2e-root-")), "projects", "proj-slash")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const env = { NTWINE_STATE_DIR: stateDir, NTWINE_THREAD: "mig", NTWINE_PROJECT_ID: "proj-slash" }

  try {
    // 1. List threads across all open projects.
    const listed = await runCli(["thread", "list", "--all-projects"], env)
    assert.equal(listed.code, 0, listed.stderr)
    assert.match(listed.stdout, /@migration-prs/)
    assert.match(listed.stdout, /@aot-bytes/)
    assert.match(listed.stdout, /#arktype/)

    // 2. Use universal `--thread @aot-bytes` from #slash to arm a goal in #arktype!
    const armed = await runCli(["--thread", "@aot-bytes", "goal", "start", "--prompt", "Finish rc checks", "--stop-hook"], env)
    assert.equal(armed.code, 0, armed.stderr)
    assert.ok(arktype.storage.getSession("aot")?.recurring_prompt?.includes("Finish rc checks"))

    // 3. Inspect `@aot-bytes` from #slash.
    const info = await runCli(["thread", "info", "@aot-bytes"], env)
    assert.equal(info.code, 0, info.stderr)
    assert.match(info.stdout, /@aot-bytes \(aot\)/)
    assert.match(info.stdout, /Finish rc checks/)

    // 4. Mark `@aot-bytes` done (archived) from #slash.
    const marked = await runCli(["thread", "done", "@aot-bytes"], env)
    assert.equal(marked.code, 0, marked.stderr)
    assert.equal(arktype.storage.getSession("aot")?.state, "archived")

    // 5. Reopen `@aot-bytes` from #slash.
    const reopened = await runCli(["thread", "reopen", "@aot-bytes"], env)
    assert.equal(reopened.code, 0, reopened.stderr)
    assert.equal(arktype.storage.getSession("aot")?.state, "open")
  } finally {
    http.close()
    slash.close()
    arktype.close()
  }
})
