import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  claudeBrokerDiagnosticLogPath,
  createClaudeBrokerDiagnosticWriter,
  describeClaudeBrokerDiagnostic,
  droppedDeliveryId,
  droppedDeliveryReason,
  readClaudeBrokerDiagnostics,
} from "./claude-broker-diagnostics.ts"
import { CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX } from "./claude-agent-sdk-protocol.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "ntwine-brokerdiag-"))
const meta = { daemonPid: 4242, generation: "gen-1" }

test("the writer creates its directory and appends one JSON line per diagnostic", () => {
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  const write = createClaudeBrokerDiagnosticWriter(path, meta, () => new Date("2026-07-01T00:00:00.000Z"))
  write({ kind: "lifecycle", phase: "started" })
  write({ kind: "stderr", message: "something went wrong", truncated: false })
  write({ kind: "lifecycle", phase: "crashed", message: "claude exited 1" })

  const lines = readFileSync(path, "utf8").trim().split("\n")
  assert.equal(lines.length, 3)
  const first = JSON.parse(lines[0])
  assert.deepEqual(first, { at: "2026-07-01T00:00:00.000Z", daemonPid: 4242, generation: "gen-1", diagnostic: { kind: "lifecycle", phase: "started" } })
})

test("stderr is KEPT — for Claude it carries the error text, not a byte-count ping", () => {
  // The codex sink drops `stderr` because those are high-frequency pings. Claude's is the CLI's own
  // (credential-redacted, 4KB-capped) error output, which is the whole point of the log.
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  createClaudeBrokerDiagnosticWriter(path, meta)({ kind: "stderr", message: "Error: not logged in", truncated: false })
  const records = readClaudeBrokerDiagnostics(dir, "sess")
  assert.equal(records.length, 1)
  assert.equal(records[0].diagnostic.kind, "stderr")
})

test("readClaudeBrokerDiagnostics returns nothing for a session that never wrote one", () => {
  assert.deepEqual(readClaudeBrokerDiagnostics(tmp(), "never"), [])
})

test("a truncated final line — the normal shape of a killed writer — is skipped, not thrown", () => {
  // This is the case the log exists for: the daemon died mid-append. Refusing to read the file then
  // would lose exactly the forensics it was written to preserve.
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ at: "2026-07-01T00:00:00.000Z", daemonPid: 1, generation: "g", diagnostic: { kind: "lifecycle", phase: "started" } }) + "\n")
  appendFileSync(path, '{"at":"2026-07-01T00:00:01.000Z","daemonPid":1,"gener')

  const records = readClaudeBrokerDiagnostics(dir, "sess")
  assert.equal(records.length, 1)
  assert.equal(records[0].diagnostic.kind, "lifecycle")
})

test("the rotated file is read BEFORE the current one, so history stays in order", () => {
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  mkdirSync(dirname(path), { recursive: true })
  const line = (msg: string) => JSON.stringify({ at: "2026-07-01T00:00:00.000Z", daemonPid: 1, generation: "g", diagnostic: { kind: "stderr", message: msg, truncated: false } }) + "\n"
  writeFileSync(`${path}.1`, line("older"))
  writeFileSync(path, line("newer"))
  const messages = readClaudeBrokerDiagnostics(dir, "sess").map((r) => (r.diagnostic as { message: string }).message)
  assert.deepEqual(messages, ["older", "newer"])
})

test("a write failure never throws back into the session it is observing", () => {
  // The directory path is occupied by a FILE, so mkdirSync and appendFileSync both fail.
  const dir = tmp()
  writeFileSync(join(dir, "claude-broker"), "not a directory")
  const write = createClaudeBrokerDiagnosticWriter(claudeBrokerDiagnosticLogPath(dir, "sess"), meta)
  assert.doesNotThrow(() => write({ kind: "lifecycle", phase: "crashed", message: "boom" }))
})

// The two diagnostics worth waking an operator for, and the noise floor between them. The DROP case is
// here because its absence cost over two hours of silence on 2026-08-05: the daemon relayed the drop,
// the server discarded it as "not a crash", and the board went on showing a healthy heartbeat for a
// thread that could no longer receive a single message.
test("a dropped input and a daemon death earn a log line; ordinary provider stderr does not", () => {
  const drop = `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}: Claude outstanding input limit exceeded`
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "stderr", message: drop, truncated: false }), drop)
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "lifecycle", phase: "crashed", message: "boom" }), "boom")
  assert.equal(
    describeClaudeBrokerDiagnostic({ kind: "lifecycle", phase: "crashed" }),
    "died without a recorded cause",
    "a death with no cause still reports — the silence IS the finding",
  )
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "stderr", message: "npm warn deprecated", truncated: false }), undefined)
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "lifecycle", phase: "started" }), undefined)
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "lifecycle", phase: "closed" }), undefined)
})

// A log line told ntwine that SOMETHING was thrown away; it could not say WHICH, so the ledger could not
// act on the row and the operator's message sat at `enqueued` for the hour `ageDeliveries` grants a
// queue entry — un-clickable, because unqueue asks the current daemon to cancel an id the dead one held.
test("a drop names the delivery id it killed, so the ledger can mark exactly that row failed", () => {
  const id = "a57251eb-7683-457c-9055-f6814679f9db"
  const drop = `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}: id=${id} Claude outstanding input limit exceeded`
  assert.equal(droppedDeliveryId({ kind: "stderr", message: drop, truncated: false }), id)
  // …and the refusal alone, which is what the operator reads under the failed bubble.
  assert.equal(droppedDeliveryReason({ kind: "stderr", message: drop, truncated: false }), "Claude outstanding input limit exceeded")
  // Still a loggable drop — naming the id must not change which diagnostics earn their line.
  assert.equal(describeClaudeBrokerDiagnostic({ kind: "stderr", message: drop, truncated: false }), drop)
})

test("only a real drop yields an id — noise, deaths, and a pre-id daemon yield none", () => {
  // A detached daemon outlives an ntwine upgrade by hours, so the drop with no id is a shape that WILL be
  // seen in production. It must degrade to the old behaviour (log + slow age-out), never to a wrong id.
  const old = `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}: Claude outstanding input limit exceeded`
  assert.equal(droppedDeliveryId({ kind: "stderr", message: old, truncated: false }), undefined)
  assert.equal(droppedDeliveryReason({ kind: "stderr", message: old, truncated: false }), "Claude outstanding input limit exceeded")
  assert.equal(droppedDeliveryReason({ kind: "stderr", message: "npm warn deprecated", truncated: false }), "")
  assert.equal(droppedDeliveryId({ kind: "stderr", message: "npm warn deprecated id=nope", truncated: false }), undefined)
  assert.equal(droppedDeliveryId({ kind: "lifecycle", phase: "crashed", message: "boom" }), undefined)
  // A non-UUID id is not a delivery id, and acting on it would match nothing (or worse, guess).
  const bogus = `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}: id=12345 Claude outstanding input limit exceeded`
  assert.equal(droppedDeliveryId({ kind: "stderr", message: bogus, truncated: false }), undefined)
})
