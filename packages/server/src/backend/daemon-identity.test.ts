// A daemon record names a PROCESS, not a pid — see daemon-identity.ts for the reboot that makes the
// difference matter. Each host's reader is driven against a real live stranger process, the shape a
// stale record takes after the next boot hands its pid to someone else.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { daemonBirthMarker, recordedDaemonIsLive } from "./daemon-identity.ts"
import { processStartTime } from "../process-generation.ts"
import { liveDaemonRecord, readDaemonRecord } from "./codex-app-server-host.ts"
import { acpDaemonRecordPath, liveAcpDaemonRecord } from "./acp-host.ts"
import { claudeBrokerRecordPath, liveBrokerRecord } from "./claude-broker-host.ts"

const linuxOnly = { skip: process.platform !== "linux" && "the birth marker is stamped on Linux only" }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" } }

/** A live process that is NOT the daemon a record was written for, and that daemon's (other) birth. */
async function strangerOnTheRecordedPid(): Promise<{ pid: number; deadDaemonBirth: string; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  await new Promise((r) => child.once("spawn", r))
  const own = processStartTime(child.pid!)
  assert.ok(own, "control: the stranger's birth is observable")
  // Same boot, earlier start tick: exactly what a pre-reboot daemon's marker cannot be, but a
  // same-boot predecessor's would be — either way, not this process.
  const ticks = Number(own.split(":").at(-1)) - 1
  return { pid: child.pid!, deadDaemonBirth: own.replace(/:\d+$/u, `:${ticks}`), stop: () => child.kill("SIGKILL") }
}

test("daemonBirthMarker is this process's own marker on Linux, and nothing elsewhere", () => {
  if (process.platform === "linux") assert.equal(daemonBirthMarker(), processStartTime(process.pid))
  else assert.equal(daemonBirthMarker(), undefined)
})

test("recordedDaemonIsLive: the pid and its birth, with every weaker reading keeping the old answer", linuxOnly, async () => {
  const s = await strangerOnTheRecordedPid()
  try {
    assert.equal(recordedDaemonIsLive(s.pid, processStartTime(s.pid), alive), true, "same pid, same birth: live")
    assert.equal(recordedDaemonIsLive(s.pid, s.deadDaemonBirth, alive), false, "same pid, other birth: a stranger")
    assert.equal(recordedDaemonIsLive(s.pid, undefined, alive), true, "no marker (older daemon, other platform): pid-alive stands")
    assert.equal(recordedDaemonIsLive(s.pid, "opaque:x", alive), true, "an incomparable marker never disowns")
    assert.equal(recordedDaemonIsLive(s.pid, processStartTime(s.pid), () => false), false, "a dead pid is dead")
  } finally {
    s.stop()
  }
})

test("all three hosts disown a record whose pid now belongs to a stranger, and prune it", linuxOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-daemon-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const s = await strangerOnTheRecordedPid()
  t.after(s.stop)
  const base = { generation: "g1", daemonPid: s.pid, childPid: 0, socketPath: join(dir, "sock"), createdAt: new Date().toISOString() }

  const codexPath = join(dir, "codex-app-server", "p1.json")
  const acpPath = acpDaemonRecordPath(dir, "s1")
  const brokerPath = claudeBrokerRecordPath(dir, "11111111-2222-4333-8444-555555555555")
  for (const path of [codexPath, acpPath, brokerPath]) mkdirSync(join(path, ".."), { recursive: true })
  const write = (processStart?: string) => {
    const extra = processStart ? { processStart } : {}
    writeFileSync(codexPath, JSON.stringify({ projectId: "p1", ...base, ...extra }))
    writeFileSync(acpPath, JSON.stringify({ threadSlug: "t", sessionId: "s1", ...base, ...extra }))
    writeFileSync(brokerPath, JSON.stringify({ sessionId: "11111111-2222-4333-8444-555555555555", ...base, ...extra }))
  }

  // CONTROL: a marker-less record on the stranger's pid is still read as live by all three — the
  // pre-marker behaviour, and proof the harness sees a "live" stale record when there is one.
  write()
  assert.ok(liveDaemonRecord(dir, "p1") && liveAcpDaemonRecord(dir, "s1") && liveBrokerRecord(brokerPath))

  // The daemon's own birth round-trips through each reader.
  write(processStartTime(s.pid))
  assert.equal(readDaemonRecord(dir, "p1")?.processStart, processStartTime(s.pid))
  assert.ok(liveDaemonRecord(dir, "p1") && liveAcpDaemonRecord(dir, "s1") && liveBrokerRecord(brokerPath))

  write(s.deadDaemonBirth)
  assert.equal(liveDaemonRecord(dir, "p1"), null, "codex")
  assert.equal(liveAcpDaemonRecord(dir, "s1"), null, "acp")
  assert.equal(liveBrokerRecord(brokerPath), null, "claude broker")
  for (const path of [codexPath, acpPath, brokerPath]) assert.equal(existsSync(path), false, `${path} was pruned`)
  assert.ok(alive(s.pid), "and nobody signalled the stranger")
})
