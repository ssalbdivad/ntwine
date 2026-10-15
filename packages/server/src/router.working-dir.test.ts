import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouter } from "./router.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"
import type { AppContext } from "./context.ts"

// WHERE A NEW TERMINAL OPENS, and the Codex half of the agent-terminal drawer. The folder comes from the
// tailer's FOLD first — the same reading the header's and the card's checkout token show — so the dialog's
// prefill and a `$ cmd` terminal can never name a different place than the token beside them.

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-router-wd-")))
  const project = join(root, "repo")
  mkdirSync(join(project, ".git"), { recursive: true })
  const worktree = join(project, ".ntwine", "worktrees", "probe")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), "gitdir: x\n")
  resetCheckoutMemo()
  return { root, project, worktree, cleanup: () => { resetCheckoutMemo(); rmSync(root, { recursive: true, force: true }) } }
}

function router(w: ReturnType<typeof world>, over: { workingDir?: string; backend?: string; execs?: { processId: string; command?: string; startedAtMs: number; cwd?: string }[] } = {}) {
  const started: { parent?: string; startedBy: string; command?: string; cwd: string }[] = []
  const ctx = {
    project: { dir: w.project, stateDir: w.root, cwdSlug: "-ntwine-router-wd-test-none" },
    // `setInteractedAt`: terminalStart is a human verb, so createRouter's wrapper stamps the thread first.
    storage: { getSession: (slug: string) => (slug === "t" ? { slug, session_id: "sid", backend: over.backend ?? "claude" } : undefined), setInteractedAt: () => {}, allSessions: () => [] },
    board: {},
    tailer: {
      get: (slug: string) => (slug === "t" && over.workingDir ? { workingDir: over.workingDir } : undefined),
      backgroundShell: () => undefined,
      subAgent: () => undefined,
    },
    codexAppServer: over.execs ? { backgroundExecs: (slug: string, sessionId: string) => (slug === "t" && sessionId === "sid" ? over.execs : []), binding: () => undefined } : undefined,
    terminalRunner: { start: ({ takenHandles: _taken, ...input }: { parent?: string; startedBy: string; takenHandles?: unknown; command?: string; cwd: string }) => { started.push(input); return { id: "term-1", handle: "npm-test" } } },
    backendFor: () => ({}),
  } as unknown as AppContext
  return { rpc: createRouter(ctx), started }
}

test("threadWorkingDir reads the fold first, and says what the folder is", async () => {
  const w = world()
  try {
    assert.deepEqual(await router(w, { workingDir: w.worktree }).rpc.threadWorkingDir.handler({ input: { slug: "t" } }), { dir: w.worktree, source: "transcript", kind: "worktree" })
    assert.deepEqual(await router(w, { workingDir: w.project }).rpc.threadWorkingDir.handler({ input: { slug: "t" } }), { dir: w.project, source: "transcript", kind: "root" })
    // A folded folder that has since been removed is no reading; with no transcript either, the root.
    assert.deepEqual(await router(w, { workingDir: join(w.project, "gone") }).rpc.threadWorkingDir.handler({ input: { slug: "t" } }), { dir: w.project, source: "project", kind: "root" })
  } finally {
    w.cleanup()
  }
})

test("a terminal started with no folder opens where the fold says the agent is", async () => {
  const w = world()
  try {
    const r = router(w, { workingDir: w.worktree })
    await r.rpc.terminalStart.handler({ input: { slug: "t", command: "npm test" } })
    assert.deepEqual(r.started, [{ parent: "t", startedBy: "human", command: "npm test", cwd: w.worktree }])
  } finally {
    w.cleanup()
  }
})

test("a Codex exec's drawer answers with everything but the output, which Codex keeps", async () => {
  const w = world()
  try {
    const r = router(w, { backend: "codex", execs: [{ processId: "p1", command: "/bin/zsh -lc 'nub test --watch'", startedAtMs: 0, cwd: w.worktree }] })
    assert.deepEqual(await r.rpc.backgroundShellOutput.handler({ input: { slug: "t", id: "p1" } }), {
      command: "nub test --watch",
      output: "",
      truncated: false,
      state: "running",
      stoppable: true,
      stopNote: null,
      outputUnavailable: true,
      end: 0,
      cwd: w.worktree,
      checkout: { dir: w.worktree, kind: "worktree" },
    })
    // Scoped to the thread's own binding: an unknown id is simply gone.
    assert.equal((await r.rpc.backgroundShellOutput.handler({ input: { slug: "t", id: "p2" } })).state, "gone")
    // …and a Claude thread never consults the app-server at all.
    const claude = router(w, { backend: "claude", execs: [{ processId: "p1", startedAtMs: 0 }] })
    assert.equal((await claude.rpc.backgroundShellOutput.handler({ input: { slug: "t", id: "p1" } })).state, "gone")
  } finally {
    w.cleanup()
  }
})
