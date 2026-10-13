// A TIME LIMIT SET AT DISPATCH (ARCHITECTURE.md § Time limits): the row carries it, set by the human, and the
// worker's system prompt says what it means. Without one, neither.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatcher } from "./dispatch.ts"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-dispatch-deadline-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "dispatch-deadline", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = {
    snapshot: async () => ({}), currentSeq: () => 0, rebuild: async () => {}, refresh: () => ({}), start: async () => {}, stop: async () => {},
  } as unknown as BoardManager
  const systems: string[] = []
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; appendSystemPrompt: string }) => {
      systems.push(input.appendSystemPrompt)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const dispatcher = createDispatcher({
    project, storage, board, claudeBroker,
    getSettings: () => defaultSettings(),
    dispatchProfile: () => ({ model: "sonnet", effort: "medium" }),
  })
  return { storage, dispatcher, systems }
}

test("a dispatch with a time limit stores it as the human's and tells the worker", async () => {
  const { storage, dispatcher, systems } = harness()
  const at = new Date(Date.now() + 2 * 3_600_000).toISOString()
  const before = Date.now()
  const { slug } = await dispatcher.dispatch({ prompt: "Port the parser", deadline: at }, { backend: "claude" })
  const row = storage.getSession(slug)!
  assert.equal(row.deadline_at, at)
  assert.equal(row.deadline_set_by, "human")
  assert.ok(Date.parse(row.deadline_set_at!) >= before, "the budget runs from the dispatch")
  assert.equal(systems.length, 1)
  assert.match(systems[0]!, /## Your time limit/)
  assert.match(systems[0]!, /a 2h budget/)
  assert.match(systems[0]!, /only the user can move or remove it/)
  assert.match(systems[0]!, /Time limit: 20m/)
})

test("a dispatch without one carries no limit and no section", async () => {
  const { storage, dispatcher, systems } = harness()
  const { slug } = await dispatcher.dispatch({ prompt: "Port the parser" }, { backend: "claude" })
  assert.equal(storage.getSession(slug)!.deadline_at ?? null, null)
  assert.doesNotMatch(systems[0]!, /Your time limit/)
})

test("a limit already under a minute away refuses the dispatch and leaves no thread", async () => {
  const { storage, dispatcher, systems } = harness()
  await assert.rejects(
    dispatcher.dispatch({ prompt: "Port the parser", deadline: new Date(Date.now() + 10_000).toISOString() }, { backend: "claude" }),
    /at least 1m/,
  )
  assert.equal(systems.length, 0)
  assert.equal(storage.allSessions().length, 0)
})
