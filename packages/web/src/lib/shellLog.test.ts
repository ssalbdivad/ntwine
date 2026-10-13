import assert from "node:assert/strict"
import test from "node:test"
import type { BackgroundShellOutputResult } from "@ntwine/shared"
import { GONE_RECHECKS, ShellLogStream, nextShellLogDelay, shellLogHead, type ShellLogEvent } from "./shellLog.ts"

// The agent-terminal drawer's stream: what a poll reply becomes on the read-only xterm. The rules a browser
// would only show by accident — a resume appends, a shrink starts over, a pane that mounts late still sees
// everything — are pinned here instead.

const reply = (over: Partial<BackgroundShellOutputResult> = {}): BackgroundShellOutputResult => ({
  command: "npm run dev",
  output: "",
  truncated: false,
  state: "running",
  stoppable: true,
  stopNote: null,
  ...over,
})

const record = (stream: ShellLogStream) => {
  const seen: ShellLogEvent[] = []
  const detach = stream.attach((e) => seen.push(e))
  return { seen, detach }
}

test("the first reply is a fresh start with the command's head; later replies append from its end", () => {
  const stream = new ShellLogStream()
  const { seen } = record(stream)
  assert.equal(stream.apply(reply({ output: "ready\n", end: 6 })), true)
  assert.equal(stream.from, 6)
  assert.equal(stream.apply(reply({ output: "GET /\n", end: 12 })), true)
  assert.equal(stream.from, 12)
  assert.equal(stream.apply(reply({ output: "", end: 12 })), false, "an empty resume writes nothing")
  assert.deepEqual(seen, [
    { kind: "reset", command: "npm run dev", truncated: false },
    { kind: "data", text: "ready\n" },
    { kind: "data", text: "GET /\n" },
  ])
  assert.equal(stream.received, 12)
})

test("a reset starts the pane over rather than appending under the old output", () => {
  const stream = new ShellLogStream()
  const { seen } = record(stream)
  stream.apply(reply({ output: "one\ntwo\n", end: 8 }))
  stream.apply(reply({ output: "fresh\n", end: 6, reset: true }))
  assert.deepEqual(seen.slice(2), [
    { kind: "reset", command: "npm run dev", truncated: false },
    { kind: "data", text: "fresh\n" },
  ])
  assert.equal(stream.received, 6, "the empty state counts only what is on screen now")
  assert.equal(stream.from, 6)
})

test("a server with no offsets makes every reply a fresh start, never a duplicate", () => {
  const stream = new ShellLogStream()
  const { seen } = record(stream)
  stream.apply(reply({ output: "a\n" }))
  stream.apply(reply({ output: "a\nb\n" }))
  assert.equal(stream.from, undefined)
  assert.deepEqual(seen.map((e) => e.kind), ["reset", "data", "reset", "data"])
})

// A MONITOR'S LOG CAN BE A WHILE COMING: a running shell whose file does not exist yet answers with no bytes
// and no `end`, every poll. Taken as a fresh start each time, the pane reset and rewrote its head every 1.5s.
test("a running shell with no log yet resets the pane once, not on every poll", () => {
  const stream = new ShellLogStream()
  const { seen } = record(stream)
  for (let i = 0; i < 4; i++) stream.apply(reply({ output: "" }))
  assert.deepEqual(seen.map((e) => e.kind), ["reset"], "the head once, while nothing has arrived")
  assert.equal(stream.from, undefined)
  // The first bytes start it over once more, so the head can say the read began mid-file.
  stream.apply(reply({ output: "tick 1\n", end: 7, truncated: true }))
  stream.apply(reply({ output: "tick 2\n", end: 14 }))
  assert.deepEqual(seen, [
    { kind: "reset", command: "npm run dev", truncated: false },
    { kind: "reset", command: "npm run dev", truncated: true },
    { kind: "data", text: "tick 1\n" },
    { kind: "data", text: "tick 2\n" },
  ])
  // A later reply with nothing readable (the file gone) leaves what is on screen.
  stream.apply(reply({ output: "", missing: true }))
  assert.equal(seen.length, 4)
  assert.equal(stream.received, 14)
})

test("a pane that attaches late replays everything since the last fresh start, then follows", () => {
  const stream = new ShellLogStream()
  stream.apply(reply({ output: "old\n", end: 4 }))
  stream.apply(reply({ output: "new\n", end: 4, reset: true, truncated: true }))
  stream.apply(reply({ output: "more\n", end: 9 }))
  const { seen, detach } = record(stream)
  assert.deepEqual(seen, [
    { kind: "reset", command: "npm run dev", truncated: true },
    { kind: "data", text: "new\n" },
    { kind: "data", text: "more\n" },
  ])
  detach()
  stream.apply(reply({ output: "after\n", end: 15 }))
  assert.equal(seen.length, 3, "a detached pane hears nothing")
})

test("the replay keeps its head and drops the oldest output past the cap", () => {
  const stream = new ShellLogStream()
  const chunk = "x".repeat(1024 * 1024)
  stream.apply(reply({ output: chunk, end: chunk.length }))
  stream.apply(reply({ output: chunk, end: chunk.length * 2 }))
  stream.apply(reply({ output: "tail", end: chunk.length * 2 + 4 }))
  const { seen } = record(stream)
  assert.equal(seen[0]?.kind, "reset")
  assert.deepEqual(seen.at(-1), { kind: "data", text: "tail" })
  assert.equal(seen.length, 3, "one chunk dropped, the head and the newest kept")
})

test("the poll asks again at once when more is waiting, on a beat while running, never after", () => {
  assert.equal(nextShellLogDelay({ state: "running", more: true }), 0)
  assert.equal(nextShellLogDelay({ state: "running" }), 1_500)
  assert.equal(nextShellLogDelay({ state: "running", outputUnavailable: true }), 5_000)
  assert.equal(nextShellLogDelay({ state: "done" }), undefined)
  assert.equal(nextShellLogDelay({ state: "gone" }), undefined)
  // A shell that wrote past one delta read in its last poll window and then EXITED: the rest — usually the
  // summary a test runner prints last — is still on disk, so the poll drains it before it stops.
  assert.equal(nextShellLogDelay({ state: "done", more: true }), 0)
})

// A `gone` can be transient — a session re-register hides a shell for a tick — and stopping on the first
// one froze a still-running shell's drawer as "unavailable" until it was reopened.
test("a gone after the shell was running is asked about again, a bounded number of times", () => {
  assert.equal(nextShellLogDelay({ state: "gone" }, 0), undefined, "gone from the first reply: nothing to wait for")
  assert.equal(nextShellLogDelay({ state: "gone" }, 1), 5_000)
  assert.equal(nextShellLogDelay({ state: "gone" }, GONE_RECHECKS), 5_000)
  assert.equal(nextShellLogDelay({ state: "gone" }, GONE_RECHECKS + 1), undefined, "then it is believed")
})

test("a gone reply after output leaves the log on screen", () => {
  // The server forgets a shell (its retired ring moved on, a session re-register hid it for a tick). The
  // reply has no bytes and no cursor, and read as a fresh start it cleared the pane.
  const stream = new ShellLogStream()
  const { seen } = record(stream)
  stream.apply(reply({ output: "tick 1\ntick 2\n", end: 14 }))
  assert.equal(stream.apply(reply({ state: "gone", command: null })), false)
  assert.equal(stream.received, 14)
  assert.equal(stream.from, 14)
  assert.deepEqual(seen.map((e) => e.kind), ["reset", "data"], "no second reset")
  // Before anything arrived there is nothing to keep: the drawer shows "closed", not a blank log.
  const fresh = new ShellLogStream()
  fresh.apply(reply({ state: "gone", command: null }))
  assert.equal(fresh.received, 0)
})

test("the head is the command as a dim $ line, and says when earlier output is cut", () => {
  assert.equal(shellLogHead({ kind: "reset", command: "npm test", truncated: false }), "\x1b[2m$ npm test\x1b[0m\r\n")
  const cut = shellLogHead({ kind: "reset", command: "a\nb", truncated: true })
  assert.match(cut, /\$ a\r\n {2}b/, "a multi-line command keeps its lines, indented under the $")
  assert.match(cut, /Earlier output not shown — showing the latest 512 KB/)
  assert.equal(shellLogHead({ kind: "reset", command: null, truncated: false }), "")
})
