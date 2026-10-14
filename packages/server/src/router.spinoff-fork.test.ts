// WHICH ROUTE A SPINOFF TAKES (router.ts forkSource / forkSpinoff) — the real router and the real
// dispatcher against real SQLite, with only the provider bridges stubbed.
//
// A Claude broker thread with a transcript is FORKED: the dispatcher starts the child as a fork of the
// parent's session under a minted anchor, the edge is complete at birth, and the parent receives nothing
// at all. Everything else — a Codex or ACP parent, a cross-project target, a Claude parent with nothing
// on disk to fork yet — takes the SUMMARY route: a fresh child whose opening prompt carries the context
// ntwine assembled from the parent (spinoffContext), and again nothing reaches the parent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "ntwine-fork-router-home-"))
process.env.HOME = HOME
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }))

import { parseSpinoffChildPrompt, spinoffForkPrompt, type BoardSnapshot, type DispatchInput } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { Emitter } from "./bus.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createRouter } from "./router.ts"
import { createDispatcher, type Dispatcher } from "./dispatch.ts"

type DispatchOpts = Parameters<Dispatcher["dispatch"]>[1]
import { defaultSettings } from "./settings.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { ClaudeAgentBrokerBridge, ClaudeSpawnDispatchInput } from "./backend/claude-agent-broker-bridge.ts"

const slug = "parent"
const sessionId = "11111111-1111-4111-8111-111111111111"

function harness(opts: { backend?: "claude" | "codex"; transcript?: boolean; failSpawn?: boolean; otherProject?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-fork-router-"))
  const cwdSlug = `fork-router-${Math.random().toString(16).slice(2)}`
  const project: Project = { dir, id: "fork-router", name: "test", label: "test", stateDir: dir, cwdSlug }
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot, refresh: () => snapshot,
    start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ turn: "idle", subAgents: [], bgShells: [], permPrompt: false, pendingQuestion: false }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const backend = createClaudeBackend({ logDir })
  const sent: string[] = []
  const spawned: ClaudeSpawnDispatchInput[] = []
  const claudeBroker = {
    followUp: async (input: { text: string }) => void sent.push(input.text),
    spawnDispatch: async (input: ClaudeSpawnDispatchInput) => {
      if (opts.failSpawn) throw new Error("the daemon did not start")
      spawned.push(input)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: "g", state: "active" } }
    },
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    followUp: async (input: { text: string }) => void sent.push(input.text),
  }
  const real = createDispatcher({ project, storage, board, getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "low" }), claudeBroker })
  // Every dispatch is recorded; a Claude one goes through the real dispatcher (into the stubbed broker),
  // and one for any other provider stands in for its bridge with a plain row.
  const dispatches: { project: string; input: DispatchInput; opts?: DispatchOpts }[] = []
  const recording = (id: string, onto: typeof storage | undefined) => ({
    ...real,
    dispatch: async (input: DispatchInput, o?: DispatchOpts) => {
      dispatches.push({ project: id, input, ...(o ? { opts: o } : {}) })
      if (onto && (o?.backend ?? "claude") === "claude") return real.dispatch(input, o)
      return { slug: `child-in-${id}`, sessionId: `sid-child-in-${id}` }
    },
  })
  const dispatcher = recording("fork-router", storage)
  const transcriptChange = new Emitter<string[]>()
  const changed: string[][] = []
  transcriptChange.on((slugs) => void changed.push(slugs))
  const otherProject = { id: "elsewhere", name: "Elsewhere", dir: join(dir, "other") }
  const other = { project: otherProject, ctx: { project: otherProject, board, dispatcher: recording("elsewhere", undefined) } }
  // A Codex parent's rollout, where the transcript readers look for it.
  const codexPath = join(dir, "rollout.jsonl")
  const codexBackend = { ...backend, transcriptPath: () => codexPath }
  const ctx = {
    project, storage, board, tailer, dispatcher, transcriptChange, claudeBroker, codexAppServer,
    backendFor: (kind?: string) => (kind === "codex" ? codexBackend : backend),
    getSettings: () => ({ permissionMode: "auto" }),
    ...(opts.otherProject ? { activeTenants: () => [other] } : {}),
  } as unknown as AppContext
  const row: SessionRow = {
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: "2026-09-30T08:00:00.000Z", last_read_at: "2026-09-30T09:00:00.000Z",
    unread: 0, exited: 0, archived: 0, rested_at: "2026-09-30T09:00:00.000Z", title_auto: 0, title: "Cache fix", state: "open", meta: null, seen_at: null,
    transcript_id: null, model: "opus[1m]", effort: "high",
  }
  storage.upsertSession(row)
  storage.setBackend(slug, opts.backend ?? "claude")
  if ((opts.backend ?? "claude") === "claude") storage.setClaudeRuntime(slug, "broker")
  else storage.setCodexRuntime(slug, "app-server")
  if (opts.transcript !== false) {
    writeFileSync(join(logDir, `${sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-30T08:00:01.000Z", message: { role: "user", content: "fix the cache" } }) + "\n")
    const codex = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-09-30T08:00:02.000Z", type: "event_msg", payload })
    writeFileSync(codexPath, [
      codex({ type: "task_started" }),
      codex({ type: "user_message", message: "fix the cache" }),
      codex({ type: "agent_message", phase: "final_answer", message: "Fixed the key; the resolver test passes." }),
      codex({ type: "task_complete", last_agent_message: "Fixed the key; the resolver test passes." }),
    ].join("\n") + "\n")
  }
  return {
    storage, sent, spawned, changed, dispatches, router: createRouter(ctx),
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }) },
  }
}

test("a Claude parent is forked: the child starts from its session, the edge is complete, and the parent hears nothing", async () => {
  const h = harness()
  try {
    const before = h.storage.getSession(slug)!
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "load test the fix" } })
    assert.deepEqual(h.sent, [], "no request reaches the parent's worker")
    assert.equal(h.spawned.length, 1)
    const spawn = h.spawned[0]!
    assert.equal(spawn.forkFrom, sessionId, "forked from the parent's session")
    assert.match(spawn.inputId ?? "", /^[0-9a-f-]{36}$/, "the opening prompt is sent under a minted anchor")
    assert.equal(spawn.model, "opus[1m]", "the parent's model: the prompt cache is per model")
    assert.equal(spawn.effort, "high")
    // The parent by the handle the board shows for "Cache fix" (the router's own name registry).
    assert.ok(spawn.prompt.includes(spinoffForkPrompt({ parentSlug: slug, parentTitle: "Cache fix", parentHandle: "cache-fix", instructions: "load test the fix" })), "the fork prompt, below ntwine's envelope")
    assert.deepEqual(parseSpinoffChildPrompt(spawn.prompt.slice(spawn.prompt.indexOf("A spinoff of"))), { instructions: "load test the fix", brief: "" })

    const edge = h.storage.spinoffsOf(slug).find((r) => r.id === id)!
    assert.equal(edge.forked, 1)
    assert.equal(edge.parent_slug, slug)
    assert.ok(edge.child_slug, "complete at birth")
    const child = h.storage.getSession(edge.child_slug!)!
    assert.equal(child.session_id, spawn.sessionId)
    assert.equal(child.fork_anchor, spawn.inputId, "the row carries the anchor its readers start at")

    const after = h.storage.getSession(slug)!
    for (const k of ["state", "rested_at", "unread", "last_read_at", "snoozed_until", "delivery_ledger", "session_id"] as const) {
      assert.equal(after[k] ?? null, before[k] ?? null, `the parent's ${k} is untouched`)
    }
    assert.deepEqual(h.changed, [[slug]], "the parent's chat is re-pushed so its card appears")
  } finally {
    h.close()
  }
})

test("a fork that fails to start leaves no edge behind and says so", async () => {
  const h = harness({ failSpawn: true })
  try {
    await assert.rejects(h.router.spinoff.handler({ input: { slug, sessionId, instructions: "x" } }), /could not start this thread/)
    assert.equal(h.storage.spinoffsBySlug().get(slug), undefined)
    assert.deepEqual(h.sent, [])
  } finally {
    h.close()
  }
})

// The parent's own state, which a spinoff must never move.
const PARENT_KEYS = ["state", "rested_at", "unread", "last_read_at", "snoozed_until", "delivery_ledger", "session_id"] as const

test("a Codex parent gets a fresh child on ntwine's context, and hears nothing", async () => {
  const h = harness({ backend: "codex" })
  try {
    const before = h.storage.getSession(slug)!
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "load test the fix" } })
    assert.deepEqual(h.sent, [], "no request reaches the parent's worker")
    assert.equal(h.spawned.length, 0, "nothing is forked")
    assert.equal(h.dispatches.length, 1)
    const { input, opts } = h.dispatches[0]!
    assert.equal(opts?.backend, "codex", "the child runs on the parent's provider")
    assert.equal(input.model, "opus[1m]")
    assert.equal(input.effort, "high")
    const origin = parseSpinoffChildPrompt(input.prompt)
    assert.equal(origin?.instructions, "load test the fix")
    assert.equal(origin?.brief, [
      "@cache-fix's original request:",
      "",
      "> fix the cache",
      "",
      "@cache-fix's latest handoff:",
      "",
      "> Fixed the key; the resolver test passes.",
      "",
      "@cache-fix was not told about this thread and does not wait on it. Read more of its conversation with the `read_thread` tool on `cache-fix`.",
    ].join("\n"))
    assert.match(opts?.nameSource ?? "", /^load test the fix\n\n@cache-fix's original request:/, "named from the human's words, then the context")

    const edge = h.storage.spinoffsOf(slug).find((r) => r.id === id)!
    assert.deepEqual([edge.forked, edge.child_slug, edge.child_project_id], [0, "child-in-fork-router", null], "complete at birth")
    const after = h.storage.getSession(slug)!
    for (const k of PARENT_KEYS) assert.equal(after[k] ?? null, before[k] ?? null, `the parent's ${k} is untouched`)
    assert.deepEqual(h.changed, [[slug]], "the parent's chat is re-pushed so its card appears")
  } finally {
    h.close()
  }
})

test("a Claude parent with no transcript yet gets a fresh child on its registered done, and hears nothing", async () => {
  const h = harness({ transcript: false })
  try {
    h.storage.markThreadDone(slug, "The cache is fixed and released.", Date.now())
    const before = h.storage.getSession(slug)!
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "write the changelog" } })
    assert.deepEqual(h.sent, [], "no request reaches the parent's worker")
    assert.equal(h.spawned.length, 1, "a fresh Claude thread, through the real dispatcher")
    const spawn = h.spawned[0]!
    assert.equal(spawn.forkFrom, undefined, "nothing to fork")
    const prompt = spawn.prompt.slice(spawn.prompt.indexOf("A spinoff of"))
    assert.deepEqual(parseSpinoffChildPrompt(prompt), {
      instructions: "write the changelog",
      brief: [
        "@cache-fix's latest handoff:",
        "",
        "> The cache is fixed and released.",
        "",
        "@cache-fix was not told about this thread and does not wait on it. Read more of its conversation with the `read_thread` tool on `cache-fix`.",
      ].join("\n"),
    })
    assert.equal(h.storage.spinoffsOf(slug).find((r) => r.id === id)?.child_slug, h.storage.getSession(h.storage.spinoffsOf(slug)[0]!.child_slug!)?.slug)
    const after = h.storage.getSession(slug)!
    for (const k of PARENT_KEYS) assert.equal(after[k] ?? null, before[k] ?? null, `the parent's ${k} is untouched`)
    assert.ok(h.storage.getThreadDone(slug), "its done still stands")
  } finally {
    h.close()
  }
})

test("a cross-project spinoff starts fresh in the target, told where the parent lives, and the parent hears nothing", async () => {
  const h = harness({ otherProject: true })
  try {
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "port it", project: "elsewhere" } })
    assert.deepEqual(h.sent, [], "no request reaches the parent's worker")
    assert.equal(h.spawned.length, 0, "nothing is forked into another checkout")
    assert.deepEqual(h.dispatches.map((d) => d.project), ["elsewhere"], "dispatched by the target's own dispatcher")
    const origin = parseSpinoffChildPrompt(h.dispatches[0]!.input.prompt)
    assert.equal(origin?.instructions, "port it")
    assert.match(origin?.brief ?? "", /^@cache-fix's original request:\n\n> fix the cache\n\n@cache-fix is in the test project \(`[^`]+`\), not this one: its paths are relative to that checkout/)
    const edge = h.storage.spinoffsOf(slug).find((r) => r.id === id)!
    assert.deepEqual([edge.child_slug, edge.child_project_id], ["child-in-elsewhere", "elsewhere"])
  } finally {
    h.close()
  }
})
