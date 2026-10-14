import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { createWakeLock, firstLiveThread, keepsAwake, startWakeLockLoop, wakeLockCommand, type WakeSource, type WakeTelemetry } from "./wake-lock.ts"

const idle: WakeTelemetry = { turn: "idle", subAgents: [], bgShells: [], permPrompt: false }
const child = { label: "bench", startedAt: "2026-10-02T01:00:00.000Z", id: "toolu_1" }
const shell = { label: "nub run test", startedAt: "2026-10-02T01:00:00.000Z" }

test("a turn in flight keeps the machine awake; one frozen on a human does not", () => {
  assert.equal(keepsAwake(idle), false)
  assert.equal(keepsAwake({ ...idle, turn: "in-flight" }), true)
  assert.equal(keepsAwake({ ...idle, turn: "in-flight", permPrompt: true }), false)
  assert.equal(keepsAwake({ ...idle, turn: "in-flight", pendingAsk: { toolUseId: "t", questions: [] } as never }), false)
})

// The overnight case: the parent rested on its awaiting card while a workflow sub-agent ran for hours.
test("a resting thread with a tracked sub-agent keeps the machine awake, stale included", () => {
  assert.equal(keepsAwake({ ...idle, subAgents: [{ ...child, state: "running" }] }), true)
  assert.equal(keepsAwake({ ...idle, subAgents: [{ ...child, state: "stale" }] }), true)
})

test("only a budgeted background shell keeps the machine awake — never a dev server or a Monitor", () => {
  assert.equal(keepsAwake({ ...idle, bgShells: [{ ...shell, state: "running", budgetMs: 600_000 }] }), true)
  assert.equal(keepsAwake({ ...idle, bgShells: [{ ...shell, state: "running" }] }), false)
  assert.equal(keepsAwake({ ...idle, bgShells: [{ ...shell, state: "running", monitor: true, budgetMs: 1 }] }), false)
})

test("archived rows and rows with no telemetry are skipped", () => {
  const live: WakeTelemetry = { ...idle, turn: "in-flight" }
  const source = (rows: Array<[string, number, WakeTelemetry | undefined]>): WakeSource => ({
    sessions: () => rows.map(([slug, archived]) => ({ slug, archived })),
    telemetry: (slug) => rows.find(([s]) => s === slug)?.[2],
  })
  assert.equal(firstLiveThread([source([["a", 1, live], ["b", 0, undefined], ["c", 0, idle]])]), undefined)
  assert.equal(firstLiveThread([source([["a", 0, idle]]), source([["d", 0, live]])]), "d")
})

test("each platform gets the helper that reaches the thing that actually sleeps", () => {
  const base = { env: {}, kernelRelease: "6.8.0-generic" }
  const [winCmd, winArgs] = wakeLockCommand({ ...base, platform: "win32", env: { SystemRoot: "D:\\Win" } })!
  assert.equal(winCmd, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  const script = Buffer.from(winArgs.at(-1)!, "base64").toString("utf16le")
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/) // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  // Announces its hold, then lingers after stdin closes — until the linger runs out or another helper announces.
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\);\$h=New-Object System\.Threading\.EventWaitHandle\(\$false,\[System\.Threading\.EventResetMode\]::ManualReset,'Local\\NtwineWakeLockHolder'\);\[void\]\$h\.Set\(\);/)
  assert.match(script, /ReadToEnd\(\);\[void\]\$h\.Reset\(\);\[void\]\$h\.WaitOne\(300000\)$/)
  // WSL: the HOST sleeps, so the request goes to Windows through interop — by kernel string or by env.
  assert.equal(wakeLockCommand({ ...base, platform: "linux", kernelRelease: "5.15.153.1-microsoft-standard-WSL2" })![0], "powershell.exe")
  assert.equal(wakeLockCommand({ ...base, platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })![0], "powershell.exe")
  assert.deepEqual(wakeLockCommand({ ...base, platform: "darwin" }), ["caffeinate", ["-i", "/bin/sh", "-c", "cat >/dev/null; sleep 300"]])
  const [linuxCmd, linuxArgs] = wakeLockCommand({ ...base, platform: "linux" })!
  assert.equal(linuxCmd, "systemd-inhibit")
  assert.ok(linuxArgs.includes("--what=idle"), "idle only, so a suspend the human asks for still happens")
  assert.equal(wakeLockCommand({ ...base, platform: "freebsd" }), undefined)
})

class FakeChild extends EventEmitter {
  killed = false
  stdinEnded = false
  stdin = Object.assign(new EventEmitter(), { end: () => { this.stdinEnded = true } })
  kill() {
    this.killed = true
    return true
  }
}

const quiet = { info: () => {}, warn: () => {} }

test("the lock spawns one helper while held and releases it by closing stdin, never by killing it", () => {
  const spawned: FakeChild[] = []
  const lock = createWakeLock(["helper", []], () => {
    const c = new FakeChild()
    spawned.push(c)
    return c as unknown as ChildProcess
  }, quiet)
  lock.set(true)
  lock.set(true)
  assert.equal(spawned.length, 1, "idempotent while held")
  assert.equal(lock.held, true)
  lock.set(false)
  assert.equal(lock.held, false)
  assert.equal(spawned[0]!.stdinEnded, true)
  assert.equal(spawned[0]!.killed, false, "a kill drops the request at once; the linger is what bridges a restart")
  lock.set(true)
  assert.equal(spawned.length, 2, "re-acquires after a release")
  lock.stop()
  lock.set(true)
  assert.equal(spawned.length, 2, "stopped for good")
})

test("a helper that cannot start, or keeps dying, disables the lock instead of respawning forever", () => {
  let spawns = 0
  const missing = createWakeLock(["nope", []], () => {
    spawns++
    const c = new FakeChild()
    queueMicrotask(() => c.emit("error", Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" })))
    return c as unknown as ChildProcess
  }, quiet)
  missing.set(true)
  return new Promise<void>((resolve) => setImmediate(() => {
    missing.set(true)
    assert.equal(spawns, 1)
    assert.equal(missing.held, false)

    let crashes = 0
    const flaky = createWakeLock(["flaky", []], () => {
      crashes++
      const c = new FakeChild()
      queueMicrotask(() => c.emit("exit", 1, null))
      return c as unknown as ChildProcess
    }, quiet)
    const step = (n: number) => {
      flaky.set(true)
      if (n === 0) {
        assert.equal(crashes, 3)
        return resolve()
      }
      setImmediate(() => step(n - 1))
    }
    step(5)
  }))
})

test("the loop holds the lock exactly while some open project has live work", () => {
  let held = false
  let stopped = false
  const lock = { set: (h: boolean) => { held = h }, get held() { return held }, stop: () => { stopped = true } }
  let t: WakeTelemetry = idle
  const loop = startWakeLockLoop(() => [{ sessions: () => [{ slug: "wave-y", archived: 0 }], telemetry: () => t }], lock, 60_000, quiet)
  assert.equal(held, false)
  t = { ...idle, subAgents: [{ ...child, state: "running" }] }
  loop.tick()
  assert.equal(held, true)
  t = idle
  loop.tick()
  assert.equal(held, false)
  loop.stop()
  assert.equal(stopped, true)
})
