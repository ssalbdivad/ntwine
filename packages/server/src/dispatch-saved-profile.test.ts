import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Settings } from "@frizz/shared"
import { createDispatcher } from "./dispatch.ts"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { BackendKind } from "./backend/types.ts"

// A dispatch that names no model launches on the operator's CURRENT profile — the machine-wide record
// the prompt box writes — never on the per-project Settings pair, which no surface has written since
// that record existed and which therefore held a months-old choice (or nothing) in every project.

function harness(saved: Partial<Record<BackendKind, { model?: string; effort?: Settings["effort"] }>>) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-saved-profile-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "saved-profile", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => {},
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const spawned: { model?: string; effort?: string }[] = []
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; model?: string; effort?: string }) => {
      spawned.push({ model: input.model, effort: input.effort })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    // The stale per-project pair a Settings blob can still carry: it must never be what launches.
    getSettings: () => ({ ...defaultSettings(), model: "haiku", effort: "low" }),
    dispatchProfile: (kind) => saved[kind] ?? {},
    claudeBroker,
  })
  return { storage, dispatcher, spawned }
}

test("a model-less dispatch launches on the saved profile, not the per-project Settings pair", async () => {
  const { storage, dispatcher, spawned } = harness({ claude: { model: "opus", effort: "xhigh" } })
  const { slug } = await dispatcher.dispatch({ prompt: "Do the thing" }, { backend: "claude" })
  assert.deepEqual(spawned, [{ model: "opus", effort: "xhigh" }])
  assert.equal(storage.getSession(slug)?.model, "opus")
  assert.equal(storage.getSession(slug)?.effort, "xhigh")
})

test("an explicit profile is never touched by the saved one", async () => {
  const { dispatcher, spawned } = harness({ claude: { model: "opus", effort: "xhigh" } })
  await dispatcher.dispatch({ prompt: "Do the thing", model: "sonnet", effort: "medium" }, { backend: "claude" })
  assert.deepEqual(spawned, [{ model: "sonnet", effort: "medium" }])
})

test("a model-only dispatch borrows the saved effort only when it names the saved model", async () => {
  const same = harness({ claude: { model: "opus", effort: "ultracode" } })
  await same.dispatcher.dispatch({ prompt: "Do the thing", model: "opus" }, { backend: "claude" })
  assert.deepEqual(same.spawned, [{ model: "opus", effort: "ultracode" }])

  // Ultracode does not exist on Haiku: pairing them would launch a profile no picker can show.
  const other = harness({ claude: { model: "opus", effort: "ultracode" } })
  await other.dispatcher.dispatch({ prompt: "Do the thing", model: "haiku" }, { backend: "claude" })
  assert.deepEqual(other.spawned, [{ model: "haiku", effort: undefined }])
})
