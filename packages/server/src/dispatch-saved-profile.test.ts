import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderQuota, Settings } from "@ntwine/shared"
import { createDispatcher } from "./dispatch.ts"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { BackendKind } from "./backend/types.ts"
import type { ChooseEffort, ChooseEffortInput } from "./effort-chooser.ts"

// A dispatch that names no model launches on the operator's CURRENT profile — the machine-wide record
// the prompt box writes — never on the per-project Settings pair, which no surface has written since
// that record existed and which therefore held a months-old choice (or nothing) in every project.

function harness(
  saved: Partial<Record<BackendKind, { model?: string; effort?: Settings["effort"] }>>,
  chooseEffort?: ChooseEffort,
  extra: { settings?: Partial<Settings>; readClaudeQuota?: () => Promise<ProviderQuota> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-saved-profile-"))
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
    getSettings: () => ({ ...defaultSettings(), model: "haiku", effort: "low", ...extra.settings }),
    dispatchProfile: (kind) => saved[kind] ?? {},
    claudeBroker,
    ...(chooseEffort ? { chooseEffort } : {}),
    ...(extra.readClaudeQuota ? { readClaudeQuota: extra.readClaudeQuota } : {}),
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

// "auto" is a dispatch value only: the chooser turns it into a level off the model's own ladder before
// launch, and both the spawn and the persisted row carry that level — never "auto".
test("an auto effort launches on the level the chooser reads off the prompt", async () => {
  const asked: ChooseEffortInput[] = []
  const { storage, dispatcher, spawned } = harness({ claude: { model: "opus", effort: "auto" } }, async (input) => {
    asked.push(input)
    return "ultracode"
  })
  const { slug } = await dispatcher.dispatch({ prompt: "Audit every package" }, { backend: "claude" })
  assert.equal(asked[0]?.prompt, "Audit every package")
  assert.deepEqual(asked[0]?.efforts, ["low", "medium", "high", "xhigh", "max", "ultracode"])
  assert.deepEqual(spawned, [{ model: "opus", effort: "ultracode" }])
  assert.equal(storage.getSession(slug)?.effort, "ultracode")
})

test("an auto effort on Haiku is offered no ultracode, and without a chooser launches on high", async () => {
  const asked: ChooseEffortInput[] = []
  const haiku = harness({}, async (input) => (asked.push(input), input.fallback))
  await haiku.dispatcher.dispatch({ prompt: "Rename foo", model: "haiku", effort: "auto" }, { backend: "claude" })
  assert.deepEqual(asked[0]?.efforts, ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(haiku.spawned, [{ model: "haiku", effort: "high" }])

  const bare = harness({})
  await bare.dispatcher.dispatch({ prompt: "Rename foo", model: "opus", effort: "auto" }, { backend: "claude" })
  assert.deepEqual(bare.spawned, [{ model: "opus", effort: "high" }])
})

// The `fableFallback` setting: while a base window is nearly out and Fable's own window has room, a new
// Claude thread launches on Fable — whatever model was chosen, and keeping the chosen effort.
test("with the Fable fallback on and the base nearly out, a Claude dispatch launches on Fable", async () => {
  const lowBase = async (): Promise<ProviderQuota> => ({ status: "ok", windows: [
    { key: "5h", label: "5h", usedPercent: 93 },
    { key: "weekly", label: "Weekly", usedPercent: 50 },
    { key: "weekly-fable", label: "Fable wk", usedPercent: 20 },
  ] })
  const on = harness({ claude: { model: "opus", effort: "xhigh" } }, undefined, { settings: { fableFallback: true }, readClaudeQuota: lowBase })
  const { slug } = await on.dispatcher.dispatch({ prompt: "Do the thing" }, { backend: "claude" })
  assert.deepEqual(on.spawned, [{ model: "fable", effort: "xhigh" }])
  assert.equal(on.storage.getSession(slug)?.model, "fable", "the row records what actually launched")

  const off = harness({ claude: { model: "opus", effort: "xhigh" } }, undefined, { readClaudeQuota: lowBase })
  await off.dispatcher.dispatch({ prompt: "Do the thing" }, { backend: "claude" })
  assert.deepEqual(off.spawned, [{ model: "opus", effort: "xhigh" }], "off by default")

  const failing = harness({ claude: { model: "opus", effort: "xhigh" } }, undefined, {
    settings: { fableFallback: true },
    readClaudeQuota: async () => { throw new Error("endpoint down") },
  })
  await failing.dispatcher.dispatch({ prompt: "Do the thing" }, { backend: "claude" })
  assert.deepEqual(failing.spawned, [{ model: "opus", effort: "xhigh" }], "an unreadable quota launches as chosen")
})
