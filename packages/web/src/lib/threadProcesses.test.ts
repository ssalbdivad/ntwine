import assert from "node:assert/strict"
import test from "node:test"
import type { BgShellView, ThreadTerminal } from "@ntwine/shared"
import { collapseFinished, FINISHED_SHOWN, threadProcesses } from "./threadProcesses.ts"

// ONE LIST for every process on a thread — yours and the agent's — in the order every surface draws it.

const at = (mm: string) => `2026-09-29T10:${mm}:00.000Z`
const NOW = Date.parse(at("30"))
const term = (over: Partial<ThreadTerminal>): ThreadTerminal => ({ id: "term", command: "npm run dev", cwd: "/repo", state: "running", runId: 1, startedAt: at("00"), ...over })
const shell = (over: Partial<BgShellView>): BgShellView => ({ label: "vite dev server", startedAt: at("00"), state: "running", ...over })

test("a prompt leads; the live rows of both owners interleave oldest first; your finished ones trail, newest first", () => {
  const list = threadProcesses({
    terminals: [
      term({ id: "done-old", state: "exited", exitCode: 0, startedAt: at("01"), exitedAt: at("02") }),
      term({ id: "live", startedAt: at("05") }),
      term({ id: "asking", awaitingInput: true, startedAt: at("20") }),
      term({ id: "done-new", state: "exited", exitCode: 1, startedAt: at("03"), exitedAt: at("09") }),
    ],
    bgShells: [shell({ id: "s-late", startedAt: at("10") }), shell({ id: "s-early", startedAt: at("04"), state: "stale" })],
  }, [], { now: NOW })
  assert.deepEqual(list.map((p) => [p.key, p.owner, p.state]), [
    ["t:asking", "human", "prompt"],
    ["s:s-early", "agent", "quiet"],
    ["t:live", "human", "running"],
    ["s:s-late", "agent", "running"],
    ["t:done-new", "human", "failed"],
    ["t:done-old", "human", "finished"],
  ])
})

// A FINISHED AGENT TERMINAL STAYS, as a finished one of yours does (2026-09-30: a 10-second shell left the
// strip before anyone could open it, while a finished terminal of yours sat there with Open). Both owners'
// finished rows trail the live ones, newest end first; a surface that lists only live work filters them out.
test("a finished agent terminal stays in the list with your finished ones, newest end first, and never twice", () => {
  const list = threadProcesses({
    terminals: [term({ id: "done-mine", state: "exited", exitCode: 0, startedAt: at("01"), exitedAt: at("06") })],
    bgShells: [shell({ id: "a" })],
    endedShells: [
      { id: "e-new", label: "quick build", status: "completed", startedAt: at("07"), finishedAt: at("08") },
      { id: "e-fail", label: "lint", status: "failed", startedAt: at("02"), finishedAt: at("04") },
      // Still on the board as live for a frame: the live row is the one listed.
      { id: "a", label: "vite dev server", status: "completed", finishedAt: at("09") },
    ],
  }, [], { now: NOW })
  assert.deepEqual(list.map((p) => [p.key, p.owner, p.state]), [
    ["s:a", "agent", "running"],
    ["s:e-new", "agent", "finished"],
    ["t:done-mine", "human", "finished"],
    ["s:e-fail", "agent", "failed"],
  ])
  assert.equal(list[1]!.ended?.id, "e-new", "a finished row carries what its drawer is addressed by")
  // A sub-agent's strip does not list the thread's finished shells either.
  assert.deepEqual(threadProcesses({ bgShells: [], endedShells: [{ id: "e", label: "x", status: "completed" }] }, [], { now: NOW, scopedToSubAgent: true }), [])
})

test("a Codex exec's board row and its transcript copy are ONE row, and the copy's folder fills in", () => {
  const board = shell({ id: "p1", label: "nub test --watch", command: "nub test --watch", stoppable: true, outputUnavailable: true })
  const transcript = [{ label: "Watching the tests", startedAt: at("01"), state: "running" as const, command: "nub test --watch", cwd: "/repo/.ntwine/worktrees/cx" }]
  const list = threadProcesses({ bgShells: [board] }, transcript, { now: NOW })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.key, "s:p1")
  assert.equal(list[0]!.cwd, "/repo/.ntwine/worktrees/cx")
  assert.equal(list[0]!.outputUnavailable, true)
})

test("a sub-agent's strip lists that child's own shells and none of yours", () => {
  const list = threadProcesses(
    { terminals: [term({ id: "mine" })], bgShells: [shell({ id: "parents" })] },
    [{ label: "child's watcher", startedAt: at("01"), state: "running", launchId: "toolu_child" }],
    { now: NOW, scopedToSubAgent: true },
  )
  assert.deepEqual(list.map((p) => [p.key, p.owner]), [["s:toolu_child", "agent"]])
})

test("a row carries what its surfaces read: the checkout, the budget, the monitor flag", () => {
  const [agent, human] = threadProcesses({
    terminals: [term({ id: "t", startedAt: at("10"), checkout: { dir: "/repo/.ntwine/worktrees/x", kind: "worktree" } })],
    bgShells: [shell({ id: "m", monitor: true, cwd: "/repo", budgetEndsAt: at("45") })],
  }, [], { now: NOW })
  assert.equal(agent!.monitor, true)
  assert.equal(agent!.budget?.text, "times out in 15m")
  assert.equal(agent!.checkout, undefined, "the root carries no checkout")
  assert.deepEqual(human!.checkout, { dir: "/repo/.ntwine/worktrees/x", kind: "worktree" })
})

test("a long strip folds its finished rows past the newest few; live rows never fold; one extra is drawn, not folded", () => {
  const done = (n: number) => term({ id: `done-${n}`, state: "exited", exitCode: 0, startedAt: at("01"), exitedAt: at(String(10 + n)) })
  const list = (finished: number) => threadProcesses({ terminals: [term({ id: "live" }), ...Array.from({ length: finished }, (_, i) => done(i))] }, [], { now: NOW })

  const many = list(10)
  const folded = collapseFinished(many, false)
  assert.equal(folded.hidden, 10 - FINISHED_SHOWN)
  assert.equal(folded.foldable, true)
  assert.deepEqual(folded.shown.map((p) => p.key), ["t:live", "t:done-9", "t:done-8", "t:done-7"], "live first, then the newest finished")
  assert.deepEqual(collapseFinished(many, true), { shown: many, hidden: 0, foldable: true }, "expanded draws all and keeps its toggle")

  const oneOver = list(FINISHED_SHOWN + 1)
  assert.deepEqual(collapseFinished(oneOver, false), { shown: oneOver, hidden: 0, foldable: false })
})
