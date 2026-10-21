import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage } from "./storage.ts"
import { createTerminalHost, liveTerminalHostRecords, readTerminalClaims, type TerminalHost } from "./backend/terminal-host.ts"
import { claimRowAction, createTerminalRunner, terminalThreadView, type TerminalRunner } from "./thread-terminals.ts"
import { endedReport, planDevTerminal, readDevTerminalMemo, startDevTerminal } from "./dev-terminal.ts"

// The desktop window's dev board (dev-terminal.ts): a terminal daemon forked BEFORE any server, which the
// first server to boot turns into a terminal thread. Real daemons and a real SQLite file throughout; the
// command stands in for `nub run dev` (a line, then a long sleep, as a dev server prints and stays).

const posix = process.platform !== "win32"
const runners: TerminalRunner[] = []
const dirs: string[] = []
after(() => {
  for (const runner of runners) runner.shutdown()
  for (const dir of dirs) {
    const host = createTerminalHost({ stateDir: dir })
    for (const record of host.live()) host.end(record.id)
  }
})

function sandbox(): { dir: string; storage: Storage } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-devterm-")))
  dirs.push(dir)
  return { dir, storage: createStorage(join(dir, "ui.db"), "p") }
}

/** A server booting on this state dir: what each control plane's context does. */
function boot(dir: string, storage: Storage, takenHandles: string[] = []): TerminalRunner {
  const host: TerminalHost = createTerminalHost({ stateDir: dir, stopGraceMs: 1_000 })
  const runner = createTerminalRunner({ storage, host, onChange: () => {}, env: { ...process.env, SHELL: "/bin/sh" }, stopGraceMs: 1_000, takenHandles: () => takenHandles })
  runners.push(runner)
  return runner
}

function start(dir: string, command: string) {
  return startDevTerminal({ stateDir: dir, projectId: "p", cwd: dir, command, env: { ...process.env, SHELL: "/bin/sh" }, pollMs: 25, servedBy: () => undefined })
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

function threads(runner: TerminalRunner) {
  return runner.terminals().map(({ row, terminal }) => ({ view: terminalThreadView(row, terminal), terminal, row }))
}

test("the window's dev board becomes a top-level terminal thread at the first boot, and every later boot adopts it without a second", { skip: !posix }, async () => {
  const { dir, storage } = sandbox()
  const starting = start(dir, "echo dev board up; sleep 600")
  const daemon = await until(() => liveTerminalHostRecords(dir)[0], "the daemon")
  assert.equal(readTerminalClaims(dir).length, 1, "the claim waits for a server")

  const first = boot(dir, storage, ["echo-dev-board"])
  assert.deepEqual(await starting, { kind: "claimed", id: daemon.id, runId: 1 })
  const [made] = threads(first)
  assert.deepEqual(
    { id: made!.row.slug, parent: made!.row.parent_slug, startedBy: made!.row.started_by, state: made!.terminal.state, kind: made!.view.kind },
    { id: daemon.id, parent: null, startedBy: "human", state: "running", kind: "terminal" },
  )
  // Named from the moment it is a thread, clear of a handle another open thread carries.
  assert.equal(made!.row.handle, "echo-dev-board-2")
  await until(() => (/dev board up/.test(first.screenTail(daemon.id)) ? true : undefined), "its output in the drawer")
  assert.deepEqual(readTerminalClaims(dir), [])

  // The dev supervisor's recycle: this control plane goes, the next boots on the same files.
  first.shutdown()
  const next = boot(dir, storage)
  assert.deepEqual(threads(next).map((t) => [t.row.slug, t.terminal.state, t.terminal.runId]), [[daemon.id, "running", 1]])
  assert.ok(alive(daemon.daemonPid), "the same daemon, never reaped or restarted")
  await until(() => (/dev board up/.test(next.screenTail(daemon.id)) ? true : undefined), "the screen it printed before the recycle")
  await next.stop(daemon.id)
})

test("the next start is a fresh run of the same thread, and a start while it still runs starts nothing", { skip: !posix }, async () => {
  const { dir, storage } = sandbox()
  const firstStart = start(dir, "echo first run; sleep 600")
  await until(() => liveTerminalHostRecords(dir)[0], "the first daemon")
  const board = boot(dir, storage)
  const { id } = (await firstStart) as { id: string }

  // Still running: a second window's start waits on it, and forks nothing.
  assert.deepEqual(await start(dir, "sleep 600"), { kind: "claimed", id, runId: 1 })
  assert.equal(liveTerminalHostRecords(dir).length, 1)

  // Stopped from its drawer (or lost to a reboot): the next start reruns that thread.
  await until(() => (/first run/.test(board.screenTail(id)) ? true : undefined), "the board attached")
  await board.stop(id)
  board.shutdown()
  const again = start(dir, "echo second run; sleep 600")
  await until(() => liveTerminalHostRecords(dir)[0], "the second daemon")
  const after = boot(dir, storage)
  assert.deepEqual(await again, { kind: "claimed", id, runId: 2 })
  assert.deepEqual(threads(after).map((t) => [t.row.slug, t.row.state, t.terminal.state, t.terminal.runId]), [[id, "open", "running", 2]])
  assert.deepEqual(readDevTerminalMemo(dir), { id, runId: 2, command: "echo second run; sleep 600" })
  await until(() => (/second run/.test(after.screenTail(id)) ? true : undefined), "the second run's screen")
  await after.stop(id)
})

test("a dev board that dies before any server boots says why, and the next server files it as a failure on its thread", { skip: !posix }, async () => {
  const { dir, storage } = sandbox()
  const outcome = await start(dir, "echo 'SyntaxError: Unexpected token'; exit 3")
  assert.equal(outcome.kind, "ended")
  const report = endedReport(outcome as Extract<typeof outcome, { kind: "ended" }>)
  assert.match(report, /exit code 3/)
  assert.match(report, /SyntaxError: Unexpected token/)

  const board = boot(dir, storage)
  const [failed] = threads(board)
  assert.deepEqual([failed!.terminal.state, failed!.terminal.exitCode, failed!.view.needsYou], ["exited", 3, true])
  assert.match(board.screenTail(failed!.row.slug), /SyntaxError/)
})

test("a dev board whose end nobody filed (the supervisor itself died) hands its last screen to the next run of the thread", { skip: !posix }, async () => {
  const { dir, storage } = sandbox()
  const crashed = await start(dir, "echo 'TypeError: boom in the supervisor'; exit 1")
  assert.equal(crashed.kind, "ended")
  // Try again, before any server came back.
  const retry = start(dir, "echo second attempt; sleep 600")
  const { id } = await until(() => liveTerminalHostRecords(dir)[0], "the retry's daemon")
  const board = boot(dir, storage)
  assert.deepEqual(await retry, { kind: "claimed", id, runId: 2 })
  await until(() => (/second attempt/.test(board.screenTail(id)) ? true : undefined), "the retry's output")
  // The crash, then the new run's own line, then its output — one session, as a follow-up line reads.
  assert.match(board.screenTail(id), /TypeError: boom in the supervisor[\s\S]*\$ echo second attempt; sleep 600[\s\S]*second attempt/)
  assert.equal(threads(board).length, 1)
  await board.stop(id)
})

test("a claim makes a row, reruns one on another run or one whose run is over, and leaves the row it already made", () => {
  assert.equal(claimRowAction(undefined, { runId: 1 }), "insert")
  assert.equal(claimRowAction({ runs: 1, exited_at: 5 }, { runId: 2 }), "rerun")
  // A Restart from the board advanced the row past what the starter remembered.
  assert.equal(claimRowAction({ runs: 4, exited_at: 5 }, { runId: 2 }), "rerun")
  // The same number, but that run ended: a stale memo, not this claim's row.
  assert.equal(claimRowAction({ runs: 2, exited_at: 5 }, { runId: 2 }), "rerun")
  // Made by a server that died before dropping the claim.
  assert.equal(claimRowAction({ runs: 2, exited_at: null }, { runId: 2 }), "none")
})

test("the starter defers to a running board, waits on a live terminal, and numbers a new run past every one it has seen", () => {
  const mint = () => "term-000000000000"
  assert.deepEqual(planDevTerminal({ servedBy: 42, memo: { id: "term-aaaaaaaaaaaa", runId: 1 }, mint }), { kind: "served", pid: 42 })
  assert.deepEqual(planDevTerminal({ mint }), { kind: "start", id: "term-000000000000", runId: 1 })
  assert.deepEqual(planDevTerminal({ memo: { id: "term-aaaaaaaaaaaa", runId: 1 }, live: { runId: 3 }, mint }), { kind: "running", id: "term-aaaaaaaaaaaa", runId: 3 })
  assert.deepEqual(planDevTerminal({ memo: { id: "term-aaaaaaaaaaaa", runId: 1 }, seenRunIds: [4], mint }), { kind: "start", id: "term-aaaaaaaaaaaa", runId: 5 })
})
