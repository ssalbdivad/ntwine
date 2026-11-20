// The ACP daemon's socket ownership, driven against the REAL daemon process over its REAL socket with
// the fake agent standing in for `opencode acp`. The rest of the daemon's wire (reattach, adopt,
// replay) is exercised through the bridge in acp-bridge.test.ts; these two are about which socket FILE
// a daemon may consider its own — the question that lost a Claude thread's messages on 2026-09-30
// (socket-ownership.ts). The end-to-end reproduction, for codex and ACP both, is
// scripts/verify-daemon-socket-takeover.mjs.
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { acpDaemonRecordPath, acpDaemonSocketPath, daemonAcpHost, liveAcpDaemonRecord, stopAcpDaemon, type AcpHostOptions } from "./acp-host.ts"

const FAKE = fileURLToPath(new URL("./acp.fixtures/fake-acp-agent.mjs", import.meta.url))
const SESSION = "s1"
const NO_UNIX_SOCKET = process.platform === "win32" && "a named pipe has no file to lose and no inode to compare"

function options(stateDir: string, extra: Partial<AcpHostOptions> = {}): AcpHostOptions {
  return { stateDir, threadSlug: "t1", sessionId: SESSION, command: process.execPath, args: [FAKE], cwd: stateDir, env: process.env, timeoutMs: 15_000, ...extra }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitForExit(pid: number, withinMs: number, what: string): Promise<void> {
  const deadline = Date.now() + withinMs
  for (;;) {
    if (!alive(pid)) return
    if (Date.now() > deadline) assert.fail(`${what} (pid ${pid}) was still alive after ${withinMs}ms`)
    await delay(25)
  }
}

/** The generation in the `hello` a fresh connection to `socketPath` is greeted with, or null. */
function helloGeneration(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    let buf = ""
    const done = (value: string | null): void => { sock.destroy(); resolve(value) }
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      const i = buf.indexOf("\n")
      if (i < 0) return
      try { done((JSON.parse(buf.slice(0, i)) as { generation?: string }).generation ?? null) } catch { done(null) }
    })
    sock.on("error", () => done(null))
  })
}

// Discoverable takes BOTH halves: the record naming the daemon and the socket path it names still
// leading there. Negative control: against the pre-fix daemon it never exits here.
test("acp daemon: a recorded daemon whose socket file is gone collects itself as socket-lost", { skip: NO_UNIX_SOCKET }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-test-"))
  const attachment = await daemonAcpHost(options(stateDir, { reachabilityCheckMs: 150 }))
  const record = liveAcpDaemonRecord(stateDir, SESSION)!
  try {
    attachment.process.kill() // detach, the way a recycled runtime does
    await delay(200)
    assert.ok(alive(record.daemonPid), "alive while record and socket both lead to it")

    unlinkSync(acpDaemonSocketPath(stateDir, SESSION))

    await waitForExit(record.daemonPid, 5_000, "the daemon nobody can reach")
    await waitForExit(record.childPid, 5_000, "its agent")
    const exit = JSON.parse(readFileSync(`${acpDaemonRecordPath(stateDir, SESSION)}.exit`, "utf8")) as { reason: string }
    assert.equal(exit.reason, "self-collected-socket-lost")
    assert.equal(existsSync(acpDaemonRecordPath(stateDir, SESSION)), false, "it removed its own record, so the next open forks at once")
  } finally {
    await stopAcpDaemon(stateDir, SESSION)
  }
})

// Two daemons for one session bind ONE socket path. A loser dying while the record is ABSENT — which
// forkDaemon makes it on purpose right before it spawns — took "no owner" for "mine" and unlinked the
// successor's socket file. Negative control: against the pre-fix daemon the existsSync below fails.
test("acp daemon: a loser dying while the record is absent leaves its successor's socket alone", { skip: NO_UNIX_SOCKET }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-test-"))
  const recordFile = acpDaemonRecordPath(stateDir, SESSION)
  const socketPath = acpDaemonSocketPath(stateDir, SESSION)
  // Default reachability interval (30s): neither daemon may collect itself while the test runs.
  const first = await daemonAcpHost(options(stateDir))
  const loser = liveAcpDaemonRecord(stateDir, SESSION)!
  first.process.kill()
  unlinkSync(recordFile)
  const second = await daemonAcpHost(options(stateDir))
  const survivor = liveAcpDaemonRecord(stateDir, SESSION)!
  try {
    assert.equal(second.reattached, false)
    assert.notEqual(survivor.daemonPid, loser.daemonPid, "two daemons for one session, one socket path")

    unlinkSync(recordFile) // the window: a host about to fork has removed the record
    process.kill(loser.daemonPid, "SIGTERM")
    await waitForExit(loser.daemonPid, 5_000, "the loser")

    assert.ok(existsSync(socketPath), "the survivor's socket file outlived the loser's teardown")
    second.process.kill()
    assert.equal(await helloGeneration(socketPath), survivor.generation, "and a new connection reaches the survivor")
  } finally {
    for (const pid of [loser.daemonPid, survivor.daemonPid]) { try { process.kill(pid, "SIGTERM") } catch {} }
    await waitForExit(survivor.daemonPid, 5_000, "the survivor, at teardown")
  }
})

// Window B: the client reconnects and receives `hello` with `session/prompt` still outstanding, then
// the agent finishes `session/prompt` BEFORE the client's `adopt` control frame reaches the daemon.
// Pre-fix, the daemon rewrote the response to the dead client's id and deleted it from pending, so the
// subsequent `adopt` was a silent no-op and the turn hung forever.
test("acp daemon: a session/prompt finishing after hello but before adopt is delivered on adopt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-test-"))
  const first = await daemonAcpHost(options(stateDir))
  const record = liveAcpDaemonRecord(stateDir, SESSION)!
  const readFrames = (stream: NodeJS.ReadableStream) => {
    const lines: Array<Record<string, unknown>> = []
    let buf = ""
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      for (;;) {
        const nl = buf.indexOf("\n")
        if (nl < 0) break
        const raw = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!raw) continue
        try { lines.push(JSON.parse(raw) as Record<string, unknown>) } catch {}
      }
    })
    const waitFor = async (pred: (f: Record<string, unknown>) => boolean, ms = 5_000): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const hit = lines.find(pred)
        if (hit) return hit
        await delay(15)
      }
      assert.fail(`timed out waiting for frame; saw ${JSON.stringify(lines.slice(-5))}`)
    }
    return { lines, waitFor }
  }
  try {
    const f1 = readFrames(first.process.stdout!)
    first.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
    await f1.waitFor((m) => m.id === 1)
    first.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: stateDir, mcpServers: [] } })}\n`)
    const opened = await f1.waitFor((m) => m.id === 2)
    const acpSessionId = (opened.result as { sessionId: string }).sessionId
    // Start a prompt that finishes in 300ms, then immediately detach client 1.
    first.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/prompt", params: { sessionId: acpSessionId, prompt: [{ type: "text", text: "WAIT:300" }] } })}\n`)
    await delay(50)
    first.process.kill()

    // Reattach client 2 while the prompt is STILL running, but delay sending `adopt` until AFTER the
    // 300ms prompt has finished inside the agent.
    const second = await daemonAcpHost(options(stateDir))
    assert.equal(second.reattached, true)
    const outstanding = second.hello.outstanding.find((o) => o.method === "session/prompt")
    assert.ok(outstanding, "session/prompt is listed as outstanding in hello")
    const f2 = readFrames(second.process.stdout!)

    await delay(500) // agent finishes WAIT:300 and writes its response BEFORE client 2 sends adopt
    assert.equal(f2.lines.some((m) => m.id === 77), false, "response was NOT sent under the dead client's id 77")

    second.adopt(outstanding.daemonId, 99)
    const reply = await f2.waitFor((m) => m.id === 99)
    assert.equal((reply.result as { stopReason?: string })?.stopReason, "end_turn", "adopt immediately delivered the held response under id 99")
    second.process.kill()
  } finally {
    await stopAcpDaemon(stateDir, SESSION)
    assert.ok(record)
  }
})
