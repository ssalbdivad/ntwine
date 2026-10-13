import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadTerminal, ThreadView } from "@ntwine/shared"
import { createBoard, endedShellViews, withThreadTerminals } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"

// A THREAD'S TERMINALS ON THE BOARD (thread-terminals.ts): they ride their thread's row, and one waiting
// at a prompt queues that THREAD — a terminal has no row of its own to queue.

const at = (hhmm: string) => `2026-09-29T${hhmm}:00.000Z`
const terminal = (over: Partial<ThreadTerminal> = {}): ThreadTerminal => ({
  id: "term-1", command: "npm publish", cwd: "/repo", state: "running", runId: 1, startedAt: at("09:00"), ...over,
})
const view = (over: Partial<ThreadView> = {}) => ({ id: "fix-auth", state: "open", needsYou: false, ...over }) as ThreadView

test("withThreadTerminals: terminals ride the row, and only one at a prompt queues it", () => {
  const plain = view()
  assert.equal(withThreadTerminals(plain, undefined), plain, "no terminals leaves the view untouched")
  assert.equal(withThreadTerminals(plain, []), plain)

  const running = withThreadTerminals(plain, [terminal()])
  assert.deepEqual(running.terminals?.map((t) => t.id), ["term-1"])
  assert.equal(running.needsYou, false, "a terminal that is merely running asks nothing of the human")

  const prompting = withThreadTerminals(plain, [terminal(), terminal({ id: "term-2", awaitingInput: true, awaitingSince: at("09:05") })])
  assert.equal(prompting.needsYou, true, "a password / OTP / [y/N] prompt queues the thread it hangs off")

  // Done is done, and a snooze the human set is theirs: neither is overridden by a prompt.
  assert.equal(withThreadTerminals(view({ state: "archived" }), [terminal({ awaitingInput: true })]).needsYou, false)
  assert.equal(withThreadTerminals(view({ snoozedUntil: at("12:00") }), [terminal({ awaitingInput: true })]).needsYou, false)
})

test("a terminal at a prompt queues its RUNNING thread through the real board, and leaves once answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-board-terminals-"))
  const project: Project = { dir, id: "project-terminals", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  // The agent is mid-turn: on its own it would never be in the queue.
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
  let terminals = new Map<string, ThreadTerminal[]>([["busy", [terminal({ awaitingInput: true, awaitingSince: at("09:58") })]]])
  const storage = createStorage(join(dir, "ui.db"), "p")
  const row: SessionRow = {
    slug: "busy", session_id: "busy-session", thread_name: "ntwine-busy", spawned_at: at("08:00"), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null,
  }
  storage.upsertSession(row)
  storage.setClaudeRuntime("busy", "broker")
  const board = createBoard(project, storage, new Bus(), tailer, "terminals-boot", { now: () => nowMs, threadTerminals: () => terminals })
  try {
    const queued = board.refresh().threads.find((t) => t.id === "busy")
    assert.ok(queued, "the thread is on the board")
    assert.equal(queued.needsYou, true, "the prompt queues the thread")
    assert.deepEqual(queued.terminals?.map((t) => [t.id, t.awaitingInput]), [["term-1", true]])
    assert.ok(queued.queuedAt, "and it holds a place in line")
    assert.ok(!board.refresh().threads.some((t) => t.id === "term-1"), "the terminal has no row of its own")

    terminals = new Map([["busy", [terminal()]]])
    const answered = board.refresh().threads.find((t) => t.id === "busy")
    assert.equal(answered?.needsYou, false, "answered: the thread goes back to working")
    assert.deepEqual(answered?.terminals?.map((t) => t.id), ["term-1"], "and still shows its terminal")
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
