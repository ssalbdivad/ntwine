import { test } from "node:test"
import assert from "node:assert/strict"
import type { CommandThreadState, ThreadView } from "@frizz/shared"
import { commandFailed, commandStateLabel, commandThreads } from "./commandThreads.ts"

const run = (over: Partial<CommandThreadState>): CommandThreadState => ({ command: "npm run dev", state: "exited", runId: 1, startedAt: "2026-09-23T10:00:00.000Z", ...over })

test("a run's label says how it stands, and only a failure of its own is red", () => {
  assert.equal(commandStateLabel(run({ state: "running" })), "running")
  assert.equal(commandStateLabel(run({ exitCode: 0 })), "finished")
  assert.equal(commandStateLabel(run({ exitCode: 1 })), "exit 1")
  assert.equal(commandStateLabel(run({ exitCode: 143, stopped: true })), "stopped")
  assert.equal(commandStateLabel(run({})), "interrupted")
  assert.equal(commandFailed(run({ exitCode: 1 })), true)
  assert.equal(commandFailed(run({ exitCode: 130 })), false) // Ctrl-C in the terminal
  assert.equal(commandFailed(run({ exitCode: 2, stopped: true })), false)
  assert.equal(commandFailed(run({ state: "running", exitCode: 1 })), false)
})

test("the band lists only command rows, newest run first", () => {
  const row = (id: string, kind: ThreadView["kind"], startedAt?: string) =>
    ({ id, kind, ...(startedAt ? { command: run({ startedAt }) } : {}) }) as ThreadView
  const out = commandThreads([row("a", "session"), row("old", "command", "2026-09-23T09:00:00.000Z"), row("new", "command", "2026-09-23T11:00:00.000Z")])
  assert.deepEqual(out.map((t) => t.id), ["new", "old"])
})
