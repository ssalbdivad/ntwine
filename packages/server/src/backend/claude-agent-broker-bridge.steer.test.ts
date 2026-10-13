// CI test for the broker bridge's SUB-AGENT STEER path — a real forked daemon over the fake claude
// CLI, no network. It proves the two halves that cannot be proven by reading the code:
//
//  1. the addressing SURVIVES the whole chain. A steer crosses bridge → socket frame → daemon →
//     handle.send → the CLI's stdin, and only the last hop actually decides where the message goes.
//     The fake CLI records `parent_tool_use_id` off the wire, so this asserts the child's dispatch id
//     arrived intact rather than being dropped somewhere in the middle as `null` — which would look
//     exactly like a working steer while silently retargeting the parent's main thread.
//  2. a steer NEVER cold-starts. `followUp` reattaches or resumes; a steer must not, because a
//     resumed session has no running child and the CLI answers an unknown tool_use id by falling the
//     message back onto the main thread (measured against a real session). So "no live daemon" has
//     to be a refusal, not a resume.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

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

type CaptureRow = { kind: string; text?: string; parentToolUseId?: string | null; taskId?: string }

function capture(path: string): CaptureRow[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaptureRow)
  } catch {
    return []
  }
}

test("a steer and a real task stop reach the CLI, while a follow-up stays a main-thread turn", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-steer-"))
  const exe = join(dir, "fake-claude--hold-inputs.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const capturePath = join(dir, "capture.jsonl")
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir,
    executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NTWINE_FAKE_CLAUDE_CAPTURE: capturePath },
  })
  const sessionId = randomUUID()
  const slug = "steer-thread"
  const waitFor = async (cond: () => boolean, ms = 12_000) => {
    const deadline = Date.now() + ms
    while (!cond()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(100) }
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "dispatch a child", permissionMode: "default" })
    await waitFor(() => capture(capturePath).some((row) => row.kind === "user-input"))

    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "an ordinary follow-up" })
    await bridge.steerSubAgent({ threadSlug: slug, sessionId, subAgentId: "toolu_child_01", text: "steer the child" })
    await waitFor(() => capture(capturePath).filter((row) => row.kind === "user-input").length >= 3)

    const inputs = capture(capturePath).filter((row) => row.kind === "user-input")
    const followUp = inputs.find((row) => row.text === "an ordinary follow-up")
    const steer = inputs.find((row) => row.text === "steer the child")
    assert.ok(followUp, "the follow-up reached the CLI")
    assert.ok(steer, "the steer reached the CLI")
    assert.equal(followUp?.parentToolUseId, null, "a follow-up is still an unaddressed main-thread turn")
    assert.equal(steer?.parentToolUseId, "toolu_child_01", "the steer arrived carrying the child's dispatch id")

    await bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId: "agent-runtime-01" })
    await waitFor(() => capture(capturePath).some((row) => row.kind === "stop-task"))
    assert.deepEqual(
      capture(capturePath).filter((row) => row.kind === "stop-task").map((row) => row.taskId),
      ["agent-runtime-01"],
      "the provider stopTask received the runtime id rather than the drawer's dispatch id",
    )
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch { /* already gone */ }
    await rmEventually(dir)
  }
})

test("a steer refuses a daemon from a build that predates addressing, instead of misdelivering to the parent", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-steer-legacy-"))
  const exe = join(dir, "fake-claude--hold-inputs.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const capturePath = join(dir, "capture.jsonl")
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir,
    executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NTWINE_FAKE_CLAUDE_CAPTURE: capturePath },
  })
  const sessionId = randomUUID()
  const slug = "legacy-daemon"
  const waitFor = async (cond: () => boolean, ms = 12_000) => {
    const deadline = Date.now() + ms
    while (!cond()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(100) }
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "dispatch a child", permissionMode: "default" })
    await waitFor(() => capture(capturePath).some((row) => row.kind === "user-input"))

    // A daemon forked by the PREVIOUS build wrote a record with no `capabilities` — the only signal
    // that its input validator will silently discard the addressing. Rewrite the live record to that
    // shape (the daemon itself keeps running, exactly as a surviving pre-upgrade one would).
    const recordPath = claudeBrokerRecordPath(dir, sessionId)
    const record = readBrokerRecord(recordPath)!
    const { capabilities: _dropped, ...legacy } = record
    writeFileSync(recordPath, JSON.stringify(legacy), { mode: 0o600 })

    const before = capture(capturePath).filter((row) => row.kind === "user-input").length
    await assert.rejects(
      () => bridge.steerSubAgent({ threadSlug: slug, sessionId, subAgentId: "toolu_child_01", text: "steer the child" }),
      /predates sub-agent steering/,
    )
    await assert.rejects(
      () => bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId: "agent-runtime-01" }),
      /predates sub-agent stopping/,
    )
    await sleep(400)
    assert.equal(
      capture(capturePath).filter((row) => row.kind === "user-input").length,
      before,
      "nothing was sent — an unaddressed steer would have landed on the parent's main turn",
    )
    assert.deepEqual(capture(capturePath).filter((row) => row.kind === "stop-task"), [], "an old daemon was never given an unknown stop frame")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch { /* already gone */ }
    await rmEventually(dir)
  }
})

test("a steer with no live daemon REFUSES rather than cold-starting one that has never heard of the child", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-steer-dead-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir,
    executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  try {
    await assert.rejects(
      () => bridge.steerSubAgent({ threadSlug: "never-dispatched", sessionId: randomUUID(), subAgentId: "toolu_child_01", text: "hello" }),
      /no longer running/,
    )
    // The refusal must be a refusal, not a side effect: nothing was forked, so no broker record exists.
    assert.deepEqual(capture(join(dir, "capture.jsonl")), [], "no daemon was started to receive it")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})
