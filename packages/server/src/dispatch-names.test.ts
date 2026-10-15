import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatcher } from "./dispatch.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import { createThreadNamer, foldThreadName, type ThreadNamer } from "./thread-names.ts"

// THE DISPATCH-TIME NAME (thread-names.ts), through the real dispatcher: a thread with no caller title
// is minted a 1-2 word name once its row exists, the model is told which names are taken, Codex's own
// first-output marker is told the same, and a caller's hard-coded title is held to the same rule.

function harness(answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-dispatch-names-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "names", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => {},
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string }) => ({
      binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd },
    }),
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const developerInstructions: string[] = []
  const codexAppServer = {
    spawnDispatch: async (input: { developerInstructions: string }) => {
      developerInstructions.push(input.developerInstructions)
      return { binding: { codexSessionId: "codex-rollout-id" }, turnId: "turn-1" }
    },
    releaseSession: () => {},
  } as unknown as CodexAppServerBridge
  const prompts: string[] = []
  const inner = createThreadNamer({
    storage,
    complete: async ({ prompt }) => {
      prompts.push(prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error("the script ran out")
      return next
    },
  })
  const threadNamer: ThreadNamer = inner
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
    claudeBroker,
    codexAppServer,
    threadNamer,
  })
  // Every mint the dispatches set off, which run for the rows' writes (ensureNamed), not at dispatch's call.
  const settle = () => Promise.all(storage.allSessions().map((row) => inner.named(row.slug)))
  return { storage, dispatcher, prompts, developerInstructions, settle }
}

function openNamed(storage: ReturnType<typeof createStorage>, slug: string, title: string): void {
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-09-29T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1, title_locked: 0,
    title: "chop…", state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  assert.equal(storage.setMintedTitle(slug, `sid-${slug}`, title), true)
}

test("a dispatch with no caller title is MINTED a name, and the namer is told the names already taken", async () => {
  const { storage, dispatcher, prompts, settle } = harness(["Budget defaults"])
  openNamed(storage, "holder", "Shell budgets")
  const { slug } = await dispatcher.dispatch({ prompt: "fix the shell budget default so it is 30m not 10m" })
  await settle()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0]!, /Names already taken:\n- Shell budgets\n/)
  assert.match(prompts[0]!, /<request>\nfix the shell budget default so it is 30m not 10m\n<\/request>/)
  const row = storage.getSession(slug)!
  assert.equal(row.title, "Budget defaults")
  assert.equal(row.title_agent, 1, "persisted, so it outranks Claude's own transcript title on the board")
  assert.equal(row.title_locked, 0, "a human rename still records as the human's")
})

test("a caller's title that duplicates an open thread's name is given a distinguishing word; a distinct one is kept", async () => {
  const { storage, dispatcher, prompts, settle } = harness([])
  openNamed(storage, "holder", "Shell budgets")
  const dupe = await dispatcher.dispatch({ prompt: "raise the shell ceiling", title: "Shell budgets" })
  const kept = await dispatcher.dispatch({ prompt: "tune the rail", title: "Focus rail" })
  await settle()
  const dupeTitle = storage.getSession(dupe.slug)!.title!
  assert.notEqual(foldThreadName(dupeTitle), foldThreadName("Shell budgets"))
  assert.equal(dupeTitle, "Shell ceiling")
  assert.equal(storage.getSession(kept.slug)?.title, "Focus rail")
  assert.equal(prompts.length, 0, "a caller's title is the name; nothing is minted over it")
})

test("Codex's first-output title protocol lists the taken names and asks for a one-or-two-word subject", async () => {
  const { storage, dispatcher, developerInstructions, settle } = harness(["Queue focus"])
  openNamed(storage, "holder", "Shell budgets")
  await dispatcher.dispatch({ prompt: "keep focus in the queue" }, { backend: "codex" })
  await settle()
  assert.equal(developerInstructions.length, 1)
  assert.match(developerInstructions[0]!, /ONE or TWO words, sentence case, naming the SUBJECT/)
  assert.match(developerInstructions[0]!, /already taken: "Shell budgets"/)
})
