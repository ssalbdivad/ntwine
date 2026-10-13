import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadTerminal } from "@ntwine/shared"
import { composerTerminalLine, promptingTerminal, runningTerminals, terminalFailed, terminalStateLabel } from "./threadTerminals.ts"

const run = (over: Partial<ThreadTerminal>): ThreadTerminal => ({ id: "term-1", command: "npm run dev", cwd: "/repo", state: "exited", runId: 1, startedAt: "2026-09-23T10:00:00.000Z", ...over })

test("a run's label says how it stands, and only a failure of its own is red", () => {
  assert.equal(terminalStateLabel(run({ state: "running" })), "running")
  assert.equal(terminalStateLabel(run({ state: "running", awaitingInput: true })), "waiting for input")
  assert.equal(terminalStateLabel(run({ exitCode: 0 })), "finished")
  assert.equal(terminalStateLabel(run({ exitCode: 1 })), "exit 1")
  assert.equal(terminalStateLabel(run({ exitCode: 143, stopped: true })), "stopped")
  assert.equal(terminalStateLabel(run({})), "interrupted")
  assert.equal(terminalFailed(run({ exitCode: 1 })), true)
  assert.equal(terminalFailed(run({ exitCode: 130 })), false) // Ctrl-C in the terminal
  assert.equal(terminalFailed(run({ exitCode: 2, stopped: true })), false)
  assert.equal(terminalFailed(run({ state: "running", exitCode: 1 })), false)
})

test("a thread's row counts only live terminals, and names the one at a prompt", () => {
  const thread = { terminals: [run({ id: "term-a", state: "running" }), run({ id: "term-b", exitCode: 0 }), run({ id: "term-c", state: "running", awaitingInput: true })] }
  assert.deepEqual(runningTerminals(thread).map((t) => t.id), ["term-a", "term-c"])
  assert.equal(promptingTerminal(thread)?.id, "term-c")
  assert.deepEqual(runningTerminals({}), [])
})

test("the composer's `$` line opens a terminal, and nothing that merely starts with a dollar does", () => {
  assert.deepEqual(composerTerminalLine("$ npm test"), { command: "npm test" })
  assert.deepEqual(composerTerminalLine("  $   git status  "), { command: "git status" })
  assert.deepEqual(composerTerminalLine("$"), {})
  // A message to the agent, not a command.
  assert.equal(composerTerminalLine("$5 a month is too much"), undefined)
  assert.equal(composerTerminalLine("$PATH is wrong"), undefined)
  assert.equal(composerTerminalLine("$ npm test\nand then tell me why it fails"), undefined)
  assert.equal(composerTerminalLine("run $ npm test"), undefined)
})
