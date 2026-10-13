import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linuxPowerSource, parsePowerSource, readPowerSource, startRemoteWake, type PowerSource } from "./remote-wake.ts"
import type { WakeLock } from "./wake-lock.ts"

test("PowerLineStatus and pmset readings map to a power source; anything else is unknown", () => {
  assert.equal(parsePowerSource("windows", "Online\r\n"), "ac")
  assert.equal(parsePowerSource("windows", "Offline\r\n"), "battery")
  assert.equal(parsePowerSource("windows", "Unknown\r\n"), "unknown")
  assert.equal(parsePowerSource("darwin", "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;"), "ac")
  assert.equal(parsePowerSource("darwin", "Now drawing from 'Battery Power'\n"), "battery")
  assert.equal(parsePowerSource("darwin", ""), "unknown")
})

test("Linux: an online Mains supply is AC, a battery without one is battery, no battery at all is a desktop", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-power-"))
  const supply = (name: string, files: Record<string, string>) => {
    mkdirSync(join(root, name), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), `${text}\n`)
  }
  try {
    assert.equal(linuxPowerSource(root), "ac") // no supplies: a desktop
    supply("BAT0", { type: "Battery" })
    supply("AC", { type: "Mains", online: "0" })
    assert.equal(linuxPowerSource(root), "battery")
    writeFileSync(join(root, "AC", "online"), "1\n")
    assert.equal(linuxPowerSource(root), "ac")
    assert.equal(linuxPowerSource(join(root, "missing")), "unknown")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WSL asks Windows, because the Linux side sees no power supply; a failing probe reads unknown", async () => {
  const calls: string[] = []
  const wsl = { platform: "linux" as const, env: {}, kernelRelease: "5.15.153.1-microsoft-standard-WSL2" }
  assert.equal(await readPowerSource(wsl, async (command) => (calls.push(command), "Online\r\n")), "ac")
  assert.deepEqual(calls, ["powershell.exe"])
  assert.equal(await readPowerSource(wsl, async () => { throw new Error("interop off") }), "unknown")
})

function fakeLock(): WakeLock & { stopped: boolean } {
  let held = false
  return {
    stopped: false,
    set(next) { held = next },
    get held() { return held },
    stop() { this.stopped = true; held = false },
  }
}

const quiet = { info() {} }

test("the hold follows remote access AND AC power: on battery or unknown the machine may sleep", async () => {
  let source: PowerSource = "ac"
  const lock = fakeLock()
  const wake = startRemoteWake(async () => source, lock, 60_000, quiet)
  await wake.tick()
  assert.equal(lock.held, false, "nothing held before remote access is on")

  wake.setRemote(true)
  await wake.tick()
  assert.equal(lock.held, true)
  source = "battery"
  await wake.tick()
  assert.equal(lock.held, false)
  source = "unknown"
  await wake.tick()
  assert.equal(lock.held, false)
  source = "ac"
  await wake.tick()
  assert.equal(lock.held, true)

  wake.setRemote(false)
  assert.equal(lock.held, false, "turning remote access off releases at once")
  await wake.tick()
  assert.equal(lock.held, false)

  wake.setRemote(true)
  await wake.tick()
  wake.stop()
  assert.equal(lock.stopped, true)
  assert.equal(lock.held, false)
})

test("a probe that lands after remote access was turned off does not re-take the hold", async () => {
  let resolveProbe!: (source: PowerSource) => void
  const lock = fakeLock()
  const wake = startRemoteWake(() => new Promise((resolve) => (resolveProbe = resolve)), lock, 60_000, quiet)
  wake.setRemote(true)
  const pending = wake.tick()
  wake.setRemote(false)
  resolveProbe("ac")
  await pending
  assert.equal(lock.held, false)
  wake.stop()
})
