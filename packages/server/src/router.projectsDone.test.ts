import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"

// History (projectsDone) and the cross-project search (threadsSearch). Same stub as
// router.projectsQueues.test.ts: handlers are lazy, so the context carries what `createRouter` resolves up
// front plus `activeTenants`.
function harness(activeTenants: AppContext["activeTenants"]) {
  const ctx = {
    project: { dir: tmpdir(), stateDir: tmpdir(), id: "own" },
    storage: {},
    board: {},
    tailer: {},
    activeTenants,
  } as unknown as AppContext
  return createRouter(ctx)
}

const project = (id: string): Project => ({ id, dir: `/work/${id}`, stateDir: tmpdir(), name: id, label: id, cwdSlug: id })
const board = (threads: Partial<ThreadView>[], meta: Partial<BoardSnapshot> = {}): BoardManager =>
  ({ snapshot: async () => ({ threads, ...meta }) as unknown as BoardSnapshot }) as unknown as BoardManager
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString()
const done = (id: string, minute: number, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ id, kind: "session", state: "archived", runtime: "turn-idle", title: id, lastAssistantAt: at(minute), ...extra })
const open = (id: string, minute: number, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ id, kind: "session", state: "open", runtime: "turn-idle", title: id, lastAssistantAt: at(minute), ...extra })

const ids = (entries: { projectId: string; thread: { id: string } }[]) => entries.map((e) => `${e.projectId}/${e.thread.id}`)

test("merges every project's Done threads newest rest first, skipping open, running and foreign rows and a board that throws", async () => {
  const router = harness(() => [
    {
      project: project("a"),
      board: board(
        [
          done("a-old", 1),
          done("a-new", 9),
          open("a-open", 20),
          // Archived but its worker still running: Working until it rests, not History.
          done("a-wrapping", 30, { runtime: "running" }),
          done("a-foreign", 40, { foreign: true, state: undefined }),
          // No rest instant of its own: falls back to the last activity, then the spawn.
          done("a-fallback", 0, { lastAssistantAt: undefined, lastActivityAt: at(5) }),
        ],
        { projectSlug: "alpha", projectName: "Alpha" },
      ),
    },
    { project: project("b"), board: board([done("b-mid", 7)]) },
    { project: project("c"), board: { snapshot: async () => { throw new Error("board stopped") } } as unknown as BoardManager },
  ])
  const page = await router.projectsDone.handler({ input: {} })
  assert.deepEqual(ids(page.entries), ["a/a-new", "b/b-mid", "a/a-fallback", "a/a-old"])
  assert.equal(page.nextBefore, undefined, "one page holds everything")
  assert.deepEqual(
    { projectSlug: page.entries[0]!.projectSlug, projectName: page.entries[0]!.projectName },
    { projectSlug: "alpha", projectName: "Alpha" },
  )
  assert.deepEqual({ projectSlug: page.entries[1]!.projectSlug, projectName: page.entries[1]!.projectName }, { projectSlug: "b", projectName: "b" })
})

test("pages through rows that share one instant with no duplicate and no gap", async () => {
  // Five rows at minute 5 across two projects, with one older and one newer: every page boundary below
  // falls inside the tie.
  const router = harness(() => [
    { project: project("b"), board: board([done("t2", 5), done("t1", 5), done("newest", 9)]) },
    { project: project("a"), board: board([done("t3", 5), done("t1", 5), done("t2", 5), done("oldest", 1)]) },
  ])
  const seen: string[] = []
  let before: string | undefined
  for (let pages = 0; pages < 10; pages++) {
    const page = await router.projectsDone.handler({ input: { limit: 2, ...(before ? { before } : {}) } })
    seen.push(...ids(page.entries))
    before = page.nextBefore
    if (!before) break
  }
  assert.deepEqual(seen, ["b/newest", "a/t1", "a/t2", "a/t3", "b/t1", "b/t2", "a/oldest"])
})

test("a bare ISO instant as the cursor means strictly before it", async () => {
  const router = harness(() => [{ project: project("a"), board: board([done("x", 5), done("y", 5), done("z", 4)]) }])
  const page = await router.projectsDone.handler({ input: { before: at(5) } })
  assert.deepEqual(ids(page.entries), ["a/z"])
})

test("the project lens keeps only the named projects", async () => {
  const router = harness(() => [
    { project: project("a"), board: board([done("a1", 1)]) },
    { project: project("b"), board: board([done("b1", 2)]) },
    { project: project("c"), board: board([done("c1", 3)]) },
  ])
  const page = await router.projectsDone.handler({ input: { projectIds: ["a", "c"] } })
  assert.deepEqual(ids(page.entries), ["c/c1", "a/a1"])
  assert.deepEqual((await router.projectsDone.handler({ input: { projectIds: [] } })).entries, [], "an empty lens is empty, not everything")
})

test("External adds foreign sessions at rest, never a running one", async () => {
  const router = harness(() => [
    {
      project: project("a"),
      board: board([
        done("mine", 1),
        open("terminal-rested", 2, { foreign: true }),
        open("terminal-busy", 3, { foreign: true, runtime: "running" }),
      ]),
    },
  ])
  assert.deepEqual(ids((await router.projectsDone.handler({ input: {} })).entries), ["a/mine"])
  assert.deepEqual(ids((await router.projectsDone.handler({ input: { external: true } })).entries), ["a/terminal-rested", "a/mine"])
})

test("search matches any name or the slug, case-insensitively, across projects, open before Done", async () => {
  const router = harness(() => [
    {
      project: project("a"),
      board: board([
        done("cursor-fix", 9, { title: "Fix the cursor" }),
        open("pager", 1, { title: "Pager", aiTitle: "Rework the CURSOR" }),
        done("renamed", 5, { title: "Ties", formerTitles: ["cursorTies"] }),
        open("unrelated", 8, { title: "Docs" }),
        open("foreign-cursor", 9, { title: "cursor", foreign: true }),
      ]),
    },
    { project: project("b"), board: board([open("b-cursor", 3, { title: "Something" })]) },
  ])
  const hits = await router.threadsSearch.handler({ input: { query: "  Cursor " } })
  assert.deepEqual(
    hits.map((h) => [`${h.projectId}/${h.thread.id}`, h.done]),
    [["b/b-cursor", false], ["a/pager", false], ["a/cursor-fix", true], ["a/renamed", true]],
  )
  assert.deepEqual(await router.threadsSearch.handler({ input: { query: "   " } }), [], "a blank query finds nothing rather than everything")
  assert.equal((await router.threadsSearch.handler({ input: { query: "cursor", limit: 1 } })).length, 1)
})
