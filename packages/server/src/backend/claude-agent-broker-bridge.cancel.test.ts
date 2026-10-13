// CI test for the broker bridge's UNQUEUE path — a real forked daemon over the fake claude CLI, no
// network and no credentials. It proves the parts that reading the code cannot:
//
//  1. the VERDICT survives the whole chain. A cancel crosses bridge → socket frame → daemon →
//     handle.cancelInput → the CLI's control channel, and comes back the other way through a
//     request/response pair bolted onto an otherwise fire-and-forget protocol. Every other frame in
//     that protocol is one-way, so nothing else in this repo exercises a reply at all — a correlation
//     bug would strand the caller until its deadline and read as a wedged session.
//  2. "not cancelled" is carried FAITHFULLY rather than being smoothed into a failure or a success.
//     The two answers have opposite meanings for the operator ("the agent will never read it" vs
//     "it is already on its way"), so a boolean lost anywhere in the chain is a lie either way.
//  3. the refusals hold: no live daemon, and a daemon too old to understand the frame.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, liveBrokerRecords, readBrokerRecord } from "./claude-broker-host.ts"
import { CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT } from "./claude-agent-sdk-protocol.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

type CaptureRow = { kind: string; uuid?: string; cancelled?: boolean; text?: string }
function capture(path: string): CaptureRow[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaptureRow)
  } catch {
    return []
  }
}

function harness(label: string, scenario = "hold-inputs") {
  const dir = mkdtempSync(join(tmpdir(), `cbrk-${label}-`))
  // `--hold-inputs` is what makes an input CANCELLABLE in the fixture: the fake never answers it, so
  // it stays in the queue exactly as a follow-up sent to a mid-turn agent does.
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const capturePath = join(dir, "capture.jsonl")
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir,
    executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NTWINE_FAKE_CLAUDE_CAPTURE: capturePath },
  })
  const waitFor = async (cond: () => boolean, ms = 12_000) => {
    const deadline = Date.now() + ms
    while (!cond()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(100) }
  }
  // Teardown has to END the daemon, not just drop the socket. `bridge.close()` closes the CLIENT half
  // only, and every test here forks a detached daemon whose CWD is this temp dir and whose record and
  // capture files live inside it — so on Windows, which cannot delete a directory any process still
  // holds open, the rm below is an EPERM while that daemon lives. Signal whatever the test actually
  // forked (the one test that forks nothing sweeps an empty list); the fake CLI under it exits on its
  // own the moment the daemon's stdin pipe closes.
  const cleanup = async () => {
    const daemons = liveBrokerRecords(dir)
    bridge.close()
    for (const record of daemons) { try { process.kill(record.daemonPid, "SIGTERM") } catch { /* already gone */ } }
    await rmEventually(dir)
  }
  return { dir, bridge, capturePath, waitFor, cleanup }
}

test("a queued follow-up is cancelled end to end, and a delivered one honestly refuses", { timeout: 30_000 }, async () => {
  const h = harness("cancel")
  const sessionId = randomUUID()
  const slug = "cancel-thread"
  try {
    await h.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: h.dir, prompt: "the dispatch", permissionMode: "default" })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input"))

    const queued = randomUUID()
    await h.bridge.followUp({ threadSlug: slug, sessionId, cwd: h.dir, text: "take me back", deliveryId: queued })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input" && r.uuid === queued))

    // The verdict makes the whole round trip: frame out, control request to the CLI, reply back.
    assert.equal(await h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: queued }), true)
    const seen = capture(h.capturePath).filter((r) => r.kind === "cancel-async-message")
    assert.deepEqual(seen.map((r) => [r.uuid, r.cancelled]), [[queued, true]], "the CLI saw exactly this uuid, and dropped it")

    // FALSE must survive the same trip intact. A second cancel of the same id is the real "already
    // dequeued" shape: the CLI no longer holds it, so it answers false rather than erroring.
    assert.equal(await h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: queued }), false)

    // …as does a uuid the session never received at all.
    assert.equal(await h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: randomUUID() }), false)
  } finally {
    await h.cleanup()
  }
})

test("a non-UUID deliveryId is refused rather than cancelling some other message", { timeout: 30_000 }, async () => {
  // followUp substitutes a random uuid when the browser's id is not uuid-shaped (the no-crypto
  // fallback), and nothing records that substitute — so there is no id to cancel. Minting a fresh one
  // here would address a message the CLI has never heard of and answer a misleading "already
  // delivered", so this has to refuse.
  const h = harness("cancel-nonuuid")
  const sessionId = randomUUID()
  const slug = "cancel-nonuuid-thread"
  try {
    await h.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: h.dir, prompt: "the dispatch", permissionMode: "default" })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input"))
    await h.bridge.followUp({ threadSlug: slug, sessionId, cwd: h.dir, text: "sent without a uuid", deliveryId: "browser-1700000000000-1" })
    await assert.rejects(
      () => h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: "browser-1700000000000-1" }),
      /cancellable id/,
    )
    assert.deepEqual(capture(h.capturePath).filter((r) => r.kind === "cancel-async-message"), [], "nothing was addressed at the CLI")
  } finally {
    await h.cleanup()
  }
})

test("no live daemon is a refusal, never a cold resume", { timeout: 30_000 }, async () => {
  // Same rule as steerSubAgent, for the same reason: a queue lives inside a running CLI process. A
  // daemon that died took its queue with it (so the message was never read), and forking a fresh one
  // to cancel a uuid it has never heard of would answer FALSE — the one answer that means "your
  // message is on its way".
  const h = harness("cancel-dead")
  const sessionId = randomUUID()
  try {
    await assert.rejects(
      () => h.bridge.cancelFollowUp({ threadSlug: "never-dispatched", sessionId, deliveryId: randomUUID() }),
      /no longer running/,
    )
    assert.equal(readBrokerRecord(claudeBrokerRecordPath(h.dir, sessionId)), null, "and nothing was forked")
  } finally {
    await h.cleanup()
  }
})

test("a daemon too old to understand the frame is refused instead of waited out", { timeout: 30_000 }, async () => {
  // A detached daemon outlives ntwine upgrades by six hours, so the process on the other end may predate
  // `cancel-input` entirely — it would answer NOTHING, and the call would hang to its deadline and
  // then read as a wedged session. The capability the daemon stamped into its own record is what tells
  // the two apart.
  const h = harness("cancel-oldrecord")
  const sessionId = randomUUID()
  const slug = "cancel-old-thread"
  try {
    await h.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: h.dir, prompt: "the dispatch", permissionMode: "default" })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input"))
    const recordPath = claudeBrokerRecordPath(h.dir, sessionId)
    const record = readBrokerRecord(recordPath)!
    assert.ok(record.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT), "this build's daemon advertises it")
    // Rewrite the record as a pre-upgrade daemon's, leaving the live daemon itself untouched.
    writeFileSync(recordPath, JSON.stringify({ ...record, capabilities: ["subagent-steer-v1"] }))
    await assert.rejects(
      () => h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: randomUUID() }),
      /predates unqueueing/,
    )
    assert.deepEqual(capture(h.capturePath).filter((r) => r.kind === "cancel-async-message"), [], "nothing reached the CLI")
  } finally {
    await h.cleanup()
  }
})

test("an unreadable answer is an ERROR, never a silent 'already delivered'", { timeout: 30_000 }, async () => {
  // The failure this exists to prevent: if the provider's answer stops being a boolean and ntwine
  // coerces it, every cancel reads as false. The operator is told the agent already has their message
  // while the CLI has in fact dropped it — and because a refusal writes no tombstone, the retracted
  // send goes on rendering as one the human sent. Refusing to guess is the only safe reading.
  const h = harness("cancel-unreadable", "cancel-unreadable")
  const sessionId = randomUUID()
  const slug = "cancel-unreadable-thread"
  try {
    await h.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: h.dir, prompt: "the dispatch", permissionMode: "default" })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input"))
    await assert.rejects(
      () => h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: randomUUID() }),
      /unreadable answer/,
    )
  } finally {
    await h.cleanup()
  }
})

test("a provider-side failure surfaces as an error rather than a hang", { timeout: 30_000 }, async () => {
  // The daemon ALWAYS answers, including on failure — the caller is blocked on that reply, and a
  // silent drop would be indistinguishable from a wedged daemon until the deadline expired.
  const h = harness("cancel-failure", "cancel-failure")
  const sessionId = randomUUID()
  const slug = "cancel-failure-thread"
  try {
    await h.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: h.dir, prompt: "the dispatch", permissionMode: "default" })
    await h.waitFor(() => capture(h.capturePath).some((r) => r.kind === "user-input"))
    const started = Date.now()
    await assert.rejects(() => h.bridge.cancelFollowUp({ threadSlug: slug, sessionId, deliveryId: randomUUID() }), /cancellation unavailable/)
    // Well inside the client's 10s deadline: this is the daemon reporting, not the timeout firing.
    assert.ok(Date.now() - started < 5_000, "answered promptly instead of timing out")
  } finally {
    await h.cleanup()
  }
})
