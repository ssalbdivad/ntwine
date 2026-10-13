// How much of a tick a scheduled look is owed. The tick itself is level-triggered — it re-reads a
// thread whether or not anything happened to it — which is right for a thread in motion and pure cost
// for one at rest, and a board is mostly threads at rest. These pin the two spacings `poll` applies
// (QUIET_POLL_MS for a whole board with nothing in motion, DORMANT_SWEEP_MS for stopped-and-archived
// rows on any board) and, more to the point, everything that must END a wait at once.
//
// Driven through `poll()` on an injected monotonic clock: it is exactly what the poll timer runs, so
// nothing here waits on a timer and nothing depends on how loaded the machine is.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer, DORMANT_SWEEP_MS, QUIET_POLL_MS } from "./tailer.ts"

const at = (second: number) => `2026-07-01T00:00:${String(second).padStart(2, "0")}.000Z`
const prompt = (second: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: text } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })
// A background op launched and acknowledged: the tool call, then the launch ack that names its output.
const toolUse = (second: number, id: string, name: string, input: object) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name, id, input }] } })
const toolResult = (second: number, id: string, text: string) => JSON.stringify({ type: "user", timestamp: at(second), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } })
const watcherShell = [
  toolUse(1, "toolu_sh", "Bash", { command: "until npm view pkg@beta; do sleep 300; done", description: "Watching npm for a release", run_in_background: true }),
  toolResult(2, "toolu_sh", "Command running in background with ID: bWatch. Output is being written to: /tmp/tasks/bWatch.output. You will be notified when it completes."),
]
const helperAgent = [
  toolUse(1, "toolu_ag", "Agent", { description: "Auditing the parser", run_in_background: true, subagent_type: "ntwine:high" }),
  toolResult(2, "toolu_ag", "Async agent launched successfully.\nagentId: abc123\noutput_file: /tmp/tasks/abc123.output\nDo not read this file."),
]

function row(slug: string, sessionId: string): SessionRow {
  return { slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null }
}

function fixture() {
  // Nested one level, like `~/.claude/projects/<cwdSlug>/`: the tailer's cross-directory recovery
  // sweeps the PARENT, and rooted at tmpdir() that would be every other test's fixtures.
  const root = mkdtempSync(join(tmpdir(), "ntwine-quiet-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const storage = createStorage(join(root, "ui.db"), "p")
  const clock = { ms: 1_000 }
  const changes = { n: 0 }
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    onChange: () => { changes.n++ },
    sessionLogDir: logDir,
    monotonicNow: () => clock.ms,
    brokerDaemonAlive: () => true,
    shellAlive: () => true, // the inline seam: no `lsof` for a fixture's shell
    mtimeMs: () => Date.now(), // a child whose transcript was just written is running, not stale
  })
  return {
    storage, tailer, clock, changes, logDir,
    /** A thread ntwine dispatched: a broker row with a transcript. */
    thread(slug: string, lines: string[], over: { stopped?: boolean; archived?: boolean } = {}) {
      const sessionId = `sid-${slug}`
      storage.upsertSession(row(slug, sessionId))
      storage.setBackend(slug, "claude")
      storage.setClaudeRuntime(slug, "broker")
      if (over.stopped) storage.setExited(slug, true)
      if (over.archived) storage.setState(slug, "archived")
      writeFileSync(join(logDir, `${sessionId}.jsonl`), lines.map((line) => line + "\n").join(""))
    },
    /** Somebody resumed the session from a terminal: the transcript grows and nothing tells ntwine. */
    appendFromATerminal(slug: string, line: string) {
      appendFileSync(join(logDir, `sid-${slug}.jsonl`), line + "\n")
    },
    /** Prime, then one more tick: the prime itself is a change, and quiet takes a tick that moved nothing. */
    settle() {
      tailer.tick()
      tailer.tick()
    },
    look(afterMs: number) {
      clock.ms += afterMs
      return tailer.poll!()
    },
    close() {
      tailer.stop()
      storage.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a quiet board is read every QUIET_POLL_MS, not at every look", () => {
  const f = fixture()
  try {
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.settle()
    assert.equal(f.tailer.get("rested")?.turn, "idle")

    f.appendFromATerminal("rested", reply(9, "resumed elsewhere"))
    for (let waited = 1000; waited < QUIET_POLL_MS; waited += 1000) {
      assert.equal(f.look(1000), "skipped", `${waited}ms into the wait`)
    }
    assert.equal(f.tailer.get("rested")?.lastAssistant, "all done", "nothing has read the file yet")

    assert.equal(f.look(1000), "ticked", "the wait is over")
    assert.equal(f.tailer.get("rested")?.lastAssistant, "resumed elsewhere")
    // …and what that tick found is a change, so the looks after it are prompt again.
    assert.equal(f.look(1000), "ticked", "the tick after a change is not spaced out")
  } finally { f.close() }
})

test("a registry write ends a quiet board's wait at the very next look", () => {
  const f = fixture()
  try {
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.settle()
    assert.equal(f.look(1000), "skipped")

    // A dispatch: ntwine writes the row before the worker has written a byte.
    f.thread("fresh", [prompt(0, "start")])
    assert.equal(f.look(1000), "ticked", "the new row is seen one look after it lands")
    assert.equal(f.tailer.get("fresh")?.turn, "in-flight")
  } finally { f.close() }
})

test("a write that leaves the threads as they were does not end the wait", () => {
  const f = fixture()
  try {
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.storage.setWorkerSurface("rested", "cli")
    f.settle()
    const snapshot = f.storage.allSessions()
    assert.equal(f.look(1000), "skipped")

    // The registry snapshot is re-read after a write that can touch a session row, and comes back as an
    // equal one in a new array when the write changed nothing. (This fork's session cache survives writes
    // to the other tables, so the write here is one to the session table that leaves the row as it was.)
    f.storage.setWorkerSurface("rested", "cli")
    assert.notEqual(f.storage.allSessions(), snapshot, "the snapshot really was replaced")
    assert.equal(f.look(1000), "skipped", "an equal snapshot is not a change")
  } finally { f.close() }
})

test("a board with a turn in flight is read at every look", () => {
  const f = fixture()
  try {
    f.thread("working", [prompt(0)])
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.settle()
    assert.equal(f.tailer.get("working")?.turn, "in-flight")

    f.appendFromATerminal("rested", reply(9, "resumed elsewhere"))
    assert.equal(f.look(1000), "ticked")
    assert.equal(f.tailer.get("rested")?.lastAssistant, "resumed elsewhere", "a resting thread on a busy board is still read every tick")
  } finally { f.close() }
})

test("a thread parked on a background shell is at rest, and one with a sub-agent at work is not", () => {
  const parked = fixture()
  try {
    parked.thread("watching", [prompt(0), ...watcherShell, reply(3, "parked on the watcher")])
    parked.settle()
    assert.equal(parked.tailer.get("watching")?.bgShells.length, 1, "the shell is live")
    assert.equal(parked.look(1000), "skipped", "and the board it is parked on is still a quiet one")
  } finally { parked.close() }

  const working = fixture()
  try {
    working.thread("delegating", [prompt(0), ...helperAgent, reply(3, "waiting on the helper")])
    working.settle()
    assert.equal(working.tailer.get("delegating")?.subAgents.length, 1, "the helper is live")
    assert.equal(working.look(1000), "ticked", "a sub-agent is the daemon working, so every look is a real one")
  } finally { working.close() }
})

test("a thread waiting on a follow-up it has not seen land is not at rest", () => {
  const f = fixture()
  try {
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.settle()
    assert.equal(f.look(1000), "skipped")

    // The router opens a ledger entry the moment a follow-up is accepted; the turn it starts has not
    // written anything yet. Until it does, every look has to be a real one.
    const accepted = new Date().toISOString()
    f.storage.setDeliveryLedger("rested", JSON.stringify([{ id: "d1", text: "one more thing", state: "pending", at: accepted, updatedAt: accepted }]))
    assert.equal(f.look(1000), "ticked", "the ledger write is a registry write")
    // The tick above projected the new entry, which is a change; the one after it changes nothing. Only
    // the send still being outstanding keeps the look after THAT a real one.
    assert.equal(f.look(1000), "ticked")
    assert.equal(f.look(1000), "ticked", "an undelivered send keeps the board from going quiet")
  } finally { f.close() }
})

test("a stopped, archived thread is left alone between sweeps, even on a busy board", () => {
  const f = fixture()
  try {
    f.thread("working", [prompt(0)])
    f.thread("filed", [prompt(0), reply(2, "all done")], { stopped: true, archived: true })
    f.settle()

    f.appendFromATerminal("filed", reply(9, "resumed elsewhere"))
    assert.equal(f.look(1000), "ticked", "the board is busy, so the look is a tick")
    assert.equal(f.tailer.get("filed")?.lastAssistant, "all done", "but not one that reads a dormant row")

    assert.equal(f.look(DORMANT_SWEEP_MS), "swept")
    assert.equal(f.tailer.get("filed")?.lastAssistant, "resumed elsewhere", "the sweep is where a terminal resume is noticed")
  } finally { f.close() }
})

test("a filed thread that is reopened is read at the next tick, not the next sweep", () => {
  const f = fixture()
  try {
    f.thread("working", [prompt(0)])
    f.thread("filed", [prompt(0), reply(2, "all done")], { stopped: true, archived: true })
    f.settle()
    f.appendFromATerminal("filed", reply(9, "resumed elsewhere"))
    assert.equal(f.look(1000), "ticked")
    assert.equal(f.tailer.get("filed")?.lastAssistant, "all done")

    f.storage.setState("filed", "open")
    assert.equal(f.look(1000), "ticked")
    assert.equal(f.tailer.get("filed")?.lastAssistant, "resumed elsewhere")
  } finally { f.close() }
})

test("a direct tick always reads the whole board", () => {
  const f = fixture()
  try {
    f.thread("working", [prompt(0)])
    f.thread("filed", [prompt(0), reply(2, "all done")], { stopped: true, archived: true })
    f.settle()
    f.appendFromATerminal("filed", reply(9, "resumed elsewhere"))
    f.tailer.tick()
    assert.equal(f.tailer.get("filed")?.lastAssistant, "resumed elsewhere")
  } finally { f.close() }
})
