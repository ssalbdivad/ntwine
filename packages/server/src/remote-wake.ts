import { execFile } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { release as osRelease } from "node:os"
import { join } from "node:path"
import { log as ntwineLog } from "./logging.ts"
import { createWakeLock, isWsl, wakeLockCommand, type WakeLock, type WakeLockPlatform } from "./wake-lock.ts"

// ── KEEP A PLUGGED-IN MACHINE AWAKE WHILE REMOTE ACCESS IS ON ────────────────────────────────────────
//
// wake-lock.ts holds the machine awake only while an agent is working. That left remote access dark on
// every quiet night (2026-10-07): the last turn ended at 23:11, the control plane logged "nothing running;
// the machine may sleep", Windows idle-slept at 00:47 on its one-hour AC timeout, and
// the maintainer's hosted name reported the board as not running until a keypress woke the laptop at 09:27. A
// board that is reachable from a phone is only useful if the machine behind it is up.
//
// So while a public origin is declared — a relay name, a tunnel, any remote setup — the SUPERVISOR holds
// the same "system required" request, but only while the machine is on AC power: on battery it may
// sleep as before, because draining a laptop overnight to keep a URL answering is not a trade the
// maintainer chose (2026-10-07, "Only while plugged in"). Unknown power state counts as battery, for the
// same reason. The supervisor rather than the control plane, because it is the process that owns the
// public origin and it outlives every control-plane restart, so the hold has no restart gap to bridge.

/** How often the power source is re-read. A helper lingers 5m after release, so this need not be tight. */
export const REMOTE_WAKE_POLL_MS = 60_000

export type PowerSource = "ac" | "battery" | "unknown"

// PowerLineStatus reads GetSystemPowerStatus: "Online" on AC (a desktop with no battery included),
// "Offline" on battery, "Unknown" when Windows cannot tell.
const WINDOWS_POWER_SCRIPT =
  `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus`

/** Map PowerLineStatus or `pmset -g ps` output to a power source. */
export function parsePowerSource(platform: "windows" | "darwin", stdout: string): PowerSource {
  if (platform === "windows") {
    const status = stdout.trim()
    return status === "Online" ? "ac" : status === "Offline" ? "battery" : "unknown"
  }
  // First line: "Now drawing from 'AC Power'" or "Now drawing from 'Battery Power'".
  const match = /drawing from '([^']+)'/.exec(stdout)
  return match?.[1] === "AC Power" ? "ac" : match?.[1] === "Battery Power" ? "battery" : "unknown"
}

/**
 * Linux reads sysfs directly: any online `Mains` supply is AC; a machine with no battery at all is a
 * desktop, so AC too; otherwise battery. (WSL exposes no supplies here, which is why it asks Windows.)
 */
export function linuxPowerSource(root = "/sys/class/power_supply"): PowerSource {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return "unknown"
  }
  const read = (name: string, file: string) => {
    try {
      return readFileSync(join(root, name, file), "utf8").trim()
    } catch {
      return ""
    }
  }
  let battery = false
  for (const name of names) {
    const type = read(name, "type")
    if (type === "Mains" && read(name, "online") === "1") return "ac"
    if (type === "Battery") battery = true
  }
  return battery ? "battery" : "ac"
}

type Exec = (command: string, args: string[]) => Promise<string>

const execText: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

/** Read this machine's power source. Never throws: a probe that fails reads as unknown. */
export async function readPowerSource(p: WakeLockPlatform, exec: Exec = execText, sysfsRoot?: string): Promise<PowerSource> {
  try {
    if (p.platform === "win32" || isWsl(p)) {
      const command = p.platform === "win32" ? join(p.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe"
      return parsePowerSource("windows", await exec(command, ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", WINDOWS_POWER_SCRIPT]))
    }
    if (p.platform === "darwin") return parsePowerSource("darwin", await exec("pmset", ["-g", "ps"]))
    if (p.platform === "linux") return linuxPowerSource(sysfsRoot)
  } catch {
    // Fall through: a broken probe must not hold a laptop awake on battery.
  }
  return "unknown"
}

export interface RemoteWake {
  /** Remote access was turned on or off. Idempotent. */
  setRemote(on: boolean): void
  /** Release for good — shutdown. */
  stop(): void
  /** Exposed for tests; the interval calls it otherwise. */
  tick(): Promise<void>
}

export function startRemoteWake(
  probe: () => Promise<PowerSource> = () => readPowerSource({ platform: process.platform, env: process.env, kernelRelease: osRelease() }),
  lock: WakeLock = createWakeLock(wakeLockCommand({ platform: process.platform, env: process.env, kernelRelease: osRelease() })),
  intervalMs = REMOTE_WAKE_POLL_MS,
  log: Pick<typeof ntwineLog, "info"> = ntwineLog,
): RemoteWake {
  let remote = false
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const tick = async () => {
    if (!remote || stopped) return
    const source = await probe()
    if (!remote || stopped) return // turned off while the probe ran
    const was = lock.held
    lock.set(source === "ac")
    if (lock.held !== was) {
      log.info("wake-lock", lock.held ? "remote access is on and the machine is plugged in; keeping it awake" : `remote access is on but the machine is on ${source === "battery" ? "battery" : "an unknown power source"}; it may sleep`)
    }
  }
  return {
    tick,
    setRemote(on) {
      if (stopped || on === remote) return
      remote = on
      if (on) {
        timer = setInterval(() => void tick(), intervalMs)
        timer.unref()
        void tick()
      } else {
        clearInterval(timer)
        timer = undefined
        if (lock.held) log.info("wake-lock", "remote access is off; the machine may sleep")
        lock.set(false)
      }
    },
    stop() {
      stopped = true
      clearInterval(timer)
      lock.stop()
    },
  }
}
