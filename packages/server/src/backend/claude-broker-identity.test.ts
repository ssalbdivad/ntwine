// What the broker diagnostics corpus (2026-09-23..10-01: 292 daemon generations, 238 sessions) showed
// the record/teardown path getting wrong, pinned against a REAL forked daemon driven by the fake CLI.
//
//  1. A pid is not an identity. 8 daemons in that corpus died to machine reboots with no breadcrumb and
//     left their records behind; the next boot restarts the pid counter, and the live daemons that day
//     sat at pids 4555 and 4774 — exactly the range a fresh boot hands out in its first hour. A record
//     that a stranger's pid keeps "alive" is then adopted, hibernated, or SIGTERMed on Stop.
//  2. Every one of the 277 recorded exits read `signal-SIGTERM`, so a Stop, a hibernation and an
//     operator's `kill` were indistinguishable. ntwine now says why before it signals.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, liveBrokerRecord, readBrokerRecord } from "./claude-broker-host.ts"
import { claudeBrokerDiagnosticLogPath } from "./claude-broker-diagnostics.ts"
import { processStartTime } from "../process-generation.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout")
    await sleep(50)
  }
}

async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

function fakeExe(dir: string, scenario: string): string {
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  return exe
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

function logRecords(dir: string, sessionId: string): Array<Record<string, any>> {
  return readFileSync(claudeBrokerDiagnosticLogPath(dir, sessionId), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

test("a record whose pid now belongs to a stranger is not adopted, not signalled, and the thread cold-starts", {
  timeout: 30_000,
  // The birth marker is stamped only where it is a /proc read; elsewhere the pid-alive answer stands.
  skip: process.platform !== "linux" && "the daemon stamps its birth marker on Linux only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-pid-reuse-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "pid-reuse-thread"
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: fakeExe(dir, "basic"), env })
  // Stands in for whatever the next boot started on the dead daemon's pid.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "go", permissionMode: "default" })
    const recordPath = claudeBrokerRecordPath(dir, sessionId)
    const record = readBrokerRecord(recordPath)
    assert.ok(record, "the daemon published a record")
    assert.equal(record.processStart, processStartTime(record.daemonPid), "the record carries its daemon's own birth marker")

    // The reboot: the daemon dies with no breadcrumb, and its pid comes back as somebody else.
    bridge.close()
    process.kill(record.daemonPid, "SIGKILL")
    await waitFor(() => !alive(record.daemonPid))
    assert.ok(stranger.pid && alive(stranger.pid))
    const reused = { ...record, daemonPid: stranger.pid }

    // CONTROL: without the marker the old reading still applies — a live pid IS the daemon. This is the
    // failure the marker exists to prevent, and it shows the harness can see a "live" stale record.
    writeFileSync(recordPath, JSON.stringify({ ...reused, processStart: undefined }))
    assert.ok(liveBrokerRecord(recordPath), "control: a marker-less record on a live pid reads as live")

    writeFileSync(recordPath, JSON.stringify(reused))
    assert.equal(liveBrokerRecord(recordPath), null, "a live pid with a different birth is not this daemon")
    assert.equal(readBrokerRecord(recordPath), null, "and the stale record is pruned")

    // End to end: a follow-up cold-starts a NEW daemon instead of reattaching to the stranger, and the
    // Stop that follows signals that new daemon — never the stranger.
    writeFileSync(recordPath, JSON.stringify(reused))
    const second = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: fakeExe(dir, "basic"), env })
    try {
      await second.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "still there?" })
      const fresh = readBrokerRecord(recordPath)
      assert.ok(fresh && fresh.generation !== record.generation, "the follow-up forked a fresh daemon")
      assert.notEqual(fresh.daemonPid, stranger.pid)
      second.releaseSession(slug, sessionId, "session-deleted")
      await waitFor(() => !alive(fresh.daemonPid))
      assert.ok(alive(stranger.pid), "the stranger survived every teardown")
    } finally {
      second.close()
    }
  } finally {
    bridge.close()
    stranger.kill("SIGKILL")
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r && r.daemonPid !== stranger.pid) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

test("a requested teardown says why in the daemon's log, ahead of the daemon's own signal-SIGTERM", {
  timeout: 30_000,
  skip: process.platform === "win32" && "no POSIX signals on win32 — the daemon writes no signal breadcrumb to pair with",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-cause-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "cause-thread"
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: fakeExe(dir, "basic"), env })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "go", permissionMode: "default" })
    const first = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))!
    assert.equal(bridge.retireDaemon({ threadSlug: slug, sessionId, reason: "hibernate" }), true)
    await waitFor(() => logRecords(dir, sessionId).some((r) => r.generation === first.generation && r.exit))

    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "wake up" })
    const second = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))!
    assert.notEqual(second.generation, first.generation)
    bridge.releaseSession(slug, sessionId, "session-deleted")
    await waitFor(() => logRecords(dir, sessionId).some((r) => r.generation === second.generation && r.exit))

    const story = logRecords(dir, sessionId)
      .filter((r) => r.terminate || r.exit)
      .map((r) => [r.generation === first.generation ? "g1" : "g2", r.terminate ? `terminate:${r.terminate.cause}` : `exit:${r.exit.reason}`])
    assert.deepEqual(story, [
      ["g1", "terminate:hibernate"], ["g1", "exit:signal-SIGTERM"],
      ["g2", "terminate:session-deleted"], ["g2", "exit:signal-SIGTERM"],
    ])
    const terminate = logRecords(dir, sessionId).find((r) => r.terminate)!
    assert.equal(terminate.daemonPid, first.daemonPid, "it names the daemon it was about to signal")
    assert.equal(terminate.terminate.requestedBy, process.pid, "and the process that asked")
  } finally {
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
