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
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import type { PaneIdentity } from "./adoption-recovery.ts"
import type { ThreadNamer } from "./thread-names.ts"

// TITLE PROVENANCE ACROSS EVERY TRANSPORT.
//
// A title a dispatch CALLER hard-coded — `Investigate acme/app#391` from the GitHub batch, a parent
// agent's guess through spawn_thread — is a real name (title_auto 0, so the UI shows it verbatim
// instead of "Spinning up…") that no human authored (title_locked 0, so the worker's own aiTitle
// supersedes it). Both halves matter and they live on DIFFERENT columns, which is exactly how the
// Claude broker path lost one: it was added a day before the flags were split, so the split patched
// the spawned-CLI and codex writers and left the broker's registry row without `title_locked` at all.
// An absent value is not a type error and normalises to LOCKED (sessionTitleLocked fails safe), so
// every GitHub-dispatched thread froze on `Investigate owner/repo#N` while the far better title the
// worker had already reported sat unread in its transcript.
//
// So this asserts the invariant TRANSPORT BY TRANSPORT rather than through whichever one happens to
// be the default — a fourth transport has to answer the same question before it can ship.

function harness(threadNamer?: Pick<ThreadNamer, "distinct" | "mint">) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-title-lock-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "title-lock", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
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
  const codexAppServer = {
    spawnDispatch: async () => ({ binding: { codexSessionId: "codex-rollout-id" }, turnId: "turn-1" }),
    releaseSession: () => {},
  } as unknown as CodexAppServerBridge
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
    claudeBroker,
    codexAppServer,
    ...(threadNamer ? { threadNamer: threadNamer as ThreadNamer } : {}),
  })
  return { dir, storage, dispatcher }
}

const CALLER_TITLE = "Acme issue"

for (const transport of ["claude-broker", "claude-cli", "codex"] as const) {
  test(`${transport}: a caller's dispatch title is shown as a name but never locked against the worker's own`, async (t) => {
    // The broker is the DEFAULT claude transport (opt out with NTWINE_CLAUDE_BROKER_BRIDGE=0), so the
    // spawned-CLI case has to switch it off for the length of its own dispatch.
    if (transport === "claude-cli") {
      const prior = process.env.NTWINE_CLAUDE_BROKER_BRIDGE
      process.env.NTWINE_CLAUDE_BROKER_BRIDGE = "0"
      t.after(() => {
        if (prior === undefined) delete process.env.NTWINE_CLAUDE_BROKER_BRIDGE
        else process.env.NTWINE_CLAUDE_BROKER_BRIDGE = prior
      })
    }
    const { storage, dispatcher } = harness()
    const { slug } = await dispatcher.dispatch(
      { prompt: "Investigate this issue and make recommendations", title: CALLER_TITLE },
      { backend: transport === "codex" ? "codex" : "claude" },
    )
    const row = storage.getSession(slug)
    assert.equal(row?.title, CALLER_TITLE)
    assert.equal(row?.title_auto, 0, "a caller's title is a real name, not the prompt chop — no 'Spinning up…' placeholder")
    assert.equal(row?.title_locked, 0, "…and no human authored it, so the worker's own aiTitle must still win")
  })
}

test("a caller's title too long to TYPE as a handle is dropped for the prompt chop, and the thread is minted instead", async () => {
  const { storage, dispatcher } = harness()
  const { slug } = await dispatcher.dispatch({ prompt: "scope the spinoff feature", title: "Spinoff feature scope and UI" })
  const row = storage.getSession(slug)
  assert.notEqual(row?.title, "Spinoff feature scope and UI")
  assert.equal(row?.title_auto, 1, "it falls back exactly as a dispatch with no caller title does")
})

test("a dispatch with NO caller title stores a guess that is likewise replaceable", async () => {
  const { storage, dispatcher } = harness()
  const { slug } = await dispatcher.dispatch({ prompt: "fix the flaky resolver test" })
  const row = storage.getSession(slug)
  assert.equal(row?.title_auto, 1, "the prompt chop is a machine guess the UI must not present as a name")
  assert.equal(row?.title_locked, 0)
})

// A SPINOFF's prompt opens with ntwine's own "A spinoff of @parent…" line, so naming the child from the
// prompt minted `a-spinoff-of-shell-budgets-thread-…` whenever the parent's worker gave no title or one
// too long to type as a handle (2026-09-30). The router names it from the human's instructions and the
// brief instead (`nameSource`), which feeds the fallback title, the slug, and the async mint alike.
test("a dispatch NAMED from another text takes its fallback title, slug and mint from that text, not the prompt", async () => {
  const minted: string[] = []
  const { storage, dispatcher } = harness({
    distinct: (name: string) => name,
    mint: async (_slug: string, _sessionId: string, source: string) => void minted.push(source),
  })
  const nameSource = "investigate perf\n\nBrief: the N+1 in loadUsers"
  const { slug } = await dispatcher.dispatch(
    { prompt: "A spinoff of @shell-budgets, at the human's request. Their instructions:\n\n> investigate perf\n\nContext from @shell-budgets:\n\nBrief: the N+1 in loadUsers", title: "Visualization distinctions" },
    { nameSource },
  )
  assert.equal(slug, "investigate-perf")
  assert.equal(storage.getSession(slug)?.title, "investigate perf")
  assert.deepEqual(minted, [nameSource])
})
