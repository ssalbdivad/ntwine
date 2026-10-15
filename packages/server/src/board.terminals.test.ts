import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inActiveBand, sectionOf, type ThreadTerminal, type ThreadView } from "@ntwine/shared"
import { createBoard, endedShellViews, withThreadTerminals } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"
import { terminalThreadView } from "./thread-terminals.ts"

// TERMINAL THREADS ON THE BOARD (thread-terminals.ts, plans/terminal-threads.md): a terminal is a row of its
// own, banded by its process, and the thread that started it lists it in its strip — nothing more.

const at = (hhmm: string) => `2026-09-29T${hhmm}:00.000Z`
const terminal = (over: Partial<ThreadTerminal> = {}): ThreadTerminal => ({
  id: "term-1", command: "npm publish", cwd: "/repo", state: "running", runId: 1, startedAt: at("09:00"), ...over,
})
const view = (over: Partial<ThreadView> = {}) => ({ id: "fix-auth", state: "open", needsYou: false, ...over }) as ThreadView

test("withThreadTerminals: a thread's terminals ride its row for its strip, and never queue it", () => {
  const plain = view()
  assert.equal(withThreadTerminals(plain, undefined), plain, "no terminals leaves the view untouched")
  const prompting = withThreadTerminals(plain, [terminal({ awaitingInput: true, awaitingSince: at("09:05") })])
  assert.deepEqual(prompting.terminals?.map((t) => t.id), ["term-1"])
  assert.equal(prompting.needsYou, false, "a prompt queues the terminal's own row, not the thread that started it")
})

test("a terminal at a prompt is its own Ready row on the real board; its running parent stays out of the queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-board-terminals-"))
  const project: Project = { dir, id: "project-terminals", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  // The agent is mid-turn: on its own it is never in the queue.
  const telemetry: SessionTelemetry = { turn: "in-flight", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("09:00") }
  const tailer = {
    get: (slug: string) => (slug === "busy" ? telemetry : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const nowMs = Date.parse(at("10:00"))
  let process = terminal({ parent: "busy", awaitingInput: true, awaitingSince: at("09:58") })
  const termRow = { slug: "term-1", state: "open" as const, created_at: Date.parse(at("09:00")), pinned_at: null, snoozed_until: null }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const row: SessionRow = {
    slug: "busy", session_id: "busy-session", thread_name: "ntwine-busy", spawned_at: at("08:00"), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null,
  }
  storage.upsertSession(row)
  storage.setClaudeRuntime("busy", "broker")
  const board = createBoard(project, storage, new Bus(), tailer, "terminals-boot", {
    now: () => nowMs,
    threadTerminals: () => new Map([["busy", [process]]]),
    terminalThreads: (now) => [terminalThreadView(termRow, process, now)],
  })
  try {
    const threads = board.refresh().threads
    const own = threads.find((t) => t.id === "term-1")
    assert.deepEqual([own?.kind, own?.needsYou, sectionOf(own!), inActiveBand(own!)], ["terminal", true, "active", false], "the prompt queues the terminal itself: Ready")
    assert.ok(own?.queuedAt, "with a place in line")
    const parent = threads.find((t) => t.id === "busy")
    assert.equal(parent?.needsYou, false, "the parent keeps working")
    assert.deepEqual(parent?.terminals?.map((t) => t.id), ["term-1"], "and links to it from its strip")

    process = terminal({ parent: "busy" })
    const answered = board.refresh().threads.find((t) => t.id === "term-1")
    assert.deepEqual([answered?.needsYou, inActiveBand(answered!)], [false, true], "answered: it goes back to Working")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ONE RULE FOR THE FOLDER HINT, both owners: shown iff the row runs off the project root. A terminal is
// classified through the same lift as an agent's shell, and the agent's own checkout rides the row.
test("the board stamps each terminal's checkout, and carries the agent's own, only when off the root", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-board-checkout-")))
  mkdirSync(join(dir, ".git"))
  mkdirSync(join(dir, "packages", "web"), { recursive: true })
  const worktree = join(dir, ".ntwine", "worktrees", "probe")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), "gitdir: x\n")
  resetCheckoutMemo()
  // Pure: the lift decides, per terminal — the root is CLAIMED (`atRoot`) only for a folder that was read,
  // so a terminal left in a worktree removed since claims no place, rather than the root.
  const gone = join(dir, ".ntwine", "worktrees", "removed")
  const stamped = withThreadTerminals(view(), [terminal({ id: "t-root", cwd: join(dir, "packages", "web") }), terminal({ id: "t-wt", cwd: worktree }), terminal({ id: "t-gone", cwd: gone })], dir)
  assert.deepEqual(stamped.terminals?.map((t) => [t.id, t.checkout, t.atRoot]), [
    ["t-root", undefined, true],
    ["t-wt", { dir: worktree, kind: "worktree" }, undefined],
    ["t-gone", undefined, undefined],
  ])

  const project: Project = { dir, id: "project-checkout", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const telemetry: SessionTelemetry = { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: at("09:00"), workingDir: worktree, checkout: { dir: worktree, kind: "worktree" } }
  const tailer = {
    get: (slug: string) => (slug === "wt" ? telemetry : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({ slug: "wt", session_id: "wt-session", thread_name: "ntwine-wt", spawned_at: at("08:00"), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, transcript_id: null })
  const board = createBoard(project, storage, new Bus(), tailer, "checkout-boot", { now: () => Date.parse(at("10:00")), threadTerminals: () => new Map([["wt", [terminal({ cwd: worktree })]]]) })
  try {
    const row = board.refresh().threads.find((t) => t.id === "wt")
    assert.deepEqual(row?.checkout, { dir: worktree, kind: "worktree" }, "the agent's checkout rides its row")
    assert.deepEqual(row?.terminals?.[0]?.checkout, { dir: worktree, kind: "worktree" })
  } finally {
    await board.stop()
    storage.close()
    resetCheckoutMemo()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A FINISHED AGENT TERMINAL ON THE BOARD: the tailer's retired ring, newest first, minus the ones the operator
// cleared — the drawer's strip lists them as it lists your finished terminals, and nothing it does not draw
// (the command, the log path) rides along.
test("endedShellViews: the retired ring, newest first, without the cleared ones", () => {
  const ended = endedShellViews([
    { id: "old", label: "lint", status: "failed", startedAt: at("09:00"), finishedAt: at("09:01"), cwd: "/repo", atRoot: true },
    { id: "gone", label: "watcher", status: "killed", finishedAt: at("09:02"), dismissed: true },
    { id: "new", label: "quick build", status: "completed", taskId: "b1", monitor: true, finishedAt: at("09:03"), cwd: "/repo/.ntwine/worktrees/p", checkout: { dir: "/repo/.ntwine/worktrees/p", kind: "worktree" } },
  ])
  assert.deepEqual(ended.map((e) => e.id), ["new", "old"])
  assert.deepEqual(ended[0], { id: "new", label: "quick build", status: "completed", finishedAt: at("09:03"), taskId: "b1", monitor: true, cwd: "/repo/.ntwine/worktrees/p", checkout: { dir: "/repo/.ntwine/worktrees/p", kind: "worktree" } })
  assert.equal(ended[1]!.atRoot, true)
  assert.deepEqual(endedShellViews(undefined), [])
})
