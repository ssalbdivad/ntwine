// EVERY THREAD HAS A NAME (thread-names.ts MINT_WINDOW_MS, ensureNamed). A name is what a thread is referenced
// by, so the guarantee is checked across every way a thread comes into existence or starts, through the real
// dispatcher and real SQLite, under each way the model can let the namer down: switched off, failing, and
// never answering. Whatever the path, the row ends with a name (rowThreadName), within the window.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatcher } from "./dispatch.ts"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import type { AcpBridge } from "./backend/acp-bridge.ts"
import type { ClaudeOneShot } from "./backend/claude-oneshot.ts"
import { createThreadNamer, nameEveryThread, rowThreadName } from "./thread-names.ts"

const WINDOW_MS = 150

function harness(complete: ClaudeOneShot | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-name-guarantee-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "names", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = { snapshot: async () => ({}), currentSeq: () => 0, rebuild: async () => {}, refresh: () => ({}), start: async () => {}, stop: async () => {} } as unknown as BoardManager
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string }) => ({ binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }),
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const codexAppServer = {
    spawnDispatch: async () => ({ binding: { codexSessionId: "codex-rollout-id" }, turnId: "turn-1" }),
    releaseSession: () => {},
  } as unknown as CodexAppServerBridge
  const acpBridge = { spawnDispatch: async () => ({ acpSessionId: "acp-session" }), releaseSession: () => {} } as unknown as AcpBridge
  const threadNamer = createThreadNamer({ storage, complete, windowMs: WINDOW_MS })
  nameEveryThread(storage, threadNamer)
  // A second, model-less namer on the same storage — what the router builds for name lookups — must not
  // name anything: with the model answering, the name is the model's (the last test).
  createThreadNamer({ storage })
  const dispatcher = createDispatcher({
    project, storage, board, claudeBroker, codexAppServer, acpBridge, threadNamer,
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
  })
  const nameOf = async (slug: string) => {
    await threadNamer.named(slug)
    return rowThreadName(storage.getSession(slug)!)
  }
  return { storage, dispatcher, nameOf, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// Every start path, each returning the slug of the thread it started.
const paths: Record<string, (h: ReturnType<typeof harness>) => Promise<string>> = {
  "a fresh dispatch": async ({ dispatcher }) => (await dispatcher.dispatch({ prompt: "fix the flaky resolver test" })).slug,
  "a Codex dispatch": async ({ dispatcher }) => (await dispatcher.dispatch({ prompt: "tune the queue focus ring" }, { backend: "codex" })).slug,
  "an ACP dispatch": async ({ dispatcher }) => (await dispatcher.dispatch({ prompt: "audit the release workflow", model: "acp:gemini" }, { backend: "acp" })).slug,
  "a spinoff, named from its instructions": async ({ dispatcher }) =>
    (await dispatcher.dispatch({ prompt: "A spinoff of @shell-budgets. Their instructions:\n\n> profile the board" }, { nameSource: "profile the board" })).slug,
  "a caller title too long to be a name": async ({ dispatcher }) =>
    (await dispatcher.dispatch({ prompt: "check the sidebar budget", title: "a caller title that is far too many words" })).slug,
  "a to-do written down": async ({ dispatcher }) => dispatcher.createHeldThread({ prompt: "plan next steps for my job search" }, { holder: "todo" }).slug,
  "a schedule's run written down with no title": async ({ dispatcher }) =>
    dispatcher.createHeldThread({ prompt: "triage new issues" }, { holder: "schedules", scheduleRun: { scheduleId: "sch_aaaaaaaaaaaa", snoozedUntil: null, title: "" } }).slug,
  "a to-do started": async ({ dispatcher, storage, nameOf }) => {
    const { slug } = dispatcher.createHeldThread({ prompt: "draft the cover letter" }, { holder: "todo" })
    await nameOf(slug)
    await dispatcher.dispatch({ prompt: "draft the cover letter, attached" }, { onto: storage.getSession(slug)! })
    return slug
  },
}

const models: Record<string, ClaudeOneShot | undefined> = {
  "with the namer switched off": undefined,
  "with a model that fails": async () => { throw new Error("the model is down") },
  "with a model that never answers": () => new Promise<string>(() => {}),
}

for (const [model, complete] of Object.entries(models)) {
  test(`every start path ends named ${model}`, async () => {
    const h = harness(complete)
    try {
      const unnamed: string[] = []
      for (const [path, start] of Object.entries(paths)) {
        const slug = await start(h)
        const name = await h.nameOf(slug)
        if (!name) unnamed.push(path)
      }
      assert.deepEqual(unnamed, [])
    } finally { h.close() }
  })
}

// The held-start case on its own terms: the name the to-do was minted is the name the started thread keeps,
// rather than any second name being minted for it.
test("a started to-do keeps the name it was minted, and a model's answer is the name when it comes in time", async () => {
  const h = harness(async () => "Job search")
  try {
    const { slug } = h.dispatcher.createHeldThread({ prompt: "Plan next steps for my job search" }, { holder: "todo" })
    assert.equal(await h.nameOf(slug), "Job search")
    await h.dispatcher.dispatch({ prompt: "analyze, pick up where I left off" }, { onto: h.storage.getSession(slug)! })
    assert.equal(await h.nameOf(slug), "Job search")
    assert.equal(h.storage.getSession(slug)?.title_agent, 1)
  } finally { h.close() }
})
