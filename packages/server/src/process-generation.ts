import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface ProcessGeneration {
  pid: number
  processStart: string
}

export type ProcessGenerationConfidence = "exact" | "weak" | "unavailable"

export interface ProcessGenerationObservation {
  processStart?: string
  confidence: ProcessGenerationConfidence
}

export type ProcessGenerationMatch = "exact" | "weak" | "unavailable" | "dead" | "mismatch"

/**
 * Injectable OS boundary for ownership tests and platforms without a queryable process birth id.
 * `weak` observations may retain a lease, but must never authorize a signal. `unavailable` is
 * deliberately fail-closed: token-bound health/control is the only cross-process proof in that case.
 */
export interface ProcessPlatformAdapter {
  current(): ProcessGeneration
  observe(pid: number): ProcessGenerationObservation
  isAlive(pid: number): boolean
  now(): number
  sleep(ms: number): void
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function linuxGeneration(pid: number): ProcessGenerationObservation | null {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) return null
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim()
    // proc(5): comm is parenthesized and may itself contain spaces or ')'. Fields after its final
    // `) ` begin at field 3; starttime is field 22, hence index 19 in this suffix.
    const suffixAt = stat.lastIndexOf(") ")
    if (suffixAt < 0) return null
    const fields = stat.slice(suffixAt + 2).trim().split(/\s+/u)
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/u.test(startTicks)) return null
    return { processStart: `linux:${bootId}:${startTicks}`, confidence: "exact" }
  } catch {
    return null
  }
}

function fixedPsGeneration(pid: number): ProcessGenerationObservation | null {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().replace(/\s+/gu, " ")
    if (!value || value.length > 128 || /[\0\r\n]/u.test(value)) return null
    // Darwin exposes process birth only to the second through ps. Stable locale/TZ prevents live
    // owner theft, but equality remains weak: it can retain ownership, never authorize a PID signal.
    return { processStart: `ps-utc:${value}`, confidence: "weak" }
  } catch {
    return null
  }
}

/**
 * Windows has neither /proc nor `ps`, and `tasklist` reports no birth time at all, so the marker has
 * to come out of a spawn. `powershell.exe` is the only mechanism present on every supported Windows:
 * `wmic` still answers on Server 2022 but is deprecated and gone from current Windows, which would
 * silently return this branch to `unavailable` on exactly the newest machines. Of the two PowerShell
 * routes, `Get-Process` reads the value through .NET and measured 252-267ms warm (427ms on the first
 * spawn of a session) on Server 2022 20348, while `Get-CimInstance Win32_Process` cost 381-427ms for
 * the same answer — so it loses on both availability and speed.
 *
 * A quarter-second is affordable here because nothing per-request observes a generation: `observe()`
 * runs once per process, on the first `current()`, for `defaultSelf`, then only on lock acquisition, launcher
 * status reads and the deadline-bounded delegate/guard polls. `processAlive` short-circuits ahead of
 * it, so the ordinary stale lock — owner simply gone — never pays for PowerShell at all; only a lock
 * whose PID is still in use does, which is precisely the case this file exists to adjudicate.
 *
 * FORMAT `win32:<FILETIME>`, the creation time in 100ns units since 1601-01-01 UTC. `StartTime` is
 * that FILETIME rendered as a LOCAL DateTime, and `ToFileTimeUtc()` converts it straight back, so
 * the two conversions cancel and the marker survives a timezone or DST change unchanged. That
 * matters more than it looks: a marker that moved with the clock would read as `mismatch` and let
 * Ntwine steal a LIVE owner. The round trip is lossy only inside a fall-back's repeated hour, where
 * .NET resolves the ambiguity to standard time — deterministically, so the value is still stable;
 * the residue is that two creations exactly one hour apart could collide, which fails toward
 * RETAINING an owner.
 *
 * CONFIDENCE `exact`. The resolution is real 100ns, not the 15.6ms system-clock tick: four children
 * spawned back-to-back on Server 2022 produced four distinct FILETIMEs 5.6-6.4ms apart with
 * sub-millisecond digits. That is finer than the linux marker's 10ms clock ticks, and being absolute
 * UTC rather than boot-relative it needs no boot id to stay distinct across a reboot.
 */
function windowsGeneration(pid: number): ProcessGenerationObservation | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    // Anchored to %SystemRoot% instead of resolved through PATH: Windows searches the CURRENT
    // DIRECTORY first, and that directory is a project checkout whose contents Ntwine does not own.
    const shell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    )
    const value = execFileSync(shell, [
      "-NoProfile", "-NonInteractive", "-NoLogo", "-Command",
      // A vanished PID, a protected process and an access-denied StartTime all throw. Exit non-zero
      // so execFileSync rejects, rather than letting PowerShell's error prose become a marker.
      `try{[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc())}catch{exit 1}`,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A wedged spawn must not hold a launcher's poll loop open forever; a timeout reads as
      // unavailable, which retains the owner.
      timeout: 5_000,
      windowsHide: true,
    }).trim()
    if (!/^\d{1,20}$/u.test(value)) return null
    return { processStart: `win32:${value}`, confidence: "exact" }
  } catch {
    return null
  }
}

function observeDefault(pid: number): ProcessGenerationObservation {
  if (!processAlive(pid)) return { confidence: "unavailable" }
  if (process.platform === "linux") {
    const linux = linuxGeneration(pid)
    if (linux) return linux
    const fallback = fixedPsGeneration(pid)
    return fallback ?? { confidence: "unavailable" }
  }
  if (process.platform === "darwin") return fixedPsGeneration(pid) ?? { confidence: "unavailable" }
  if (process.platform === "win32") return windowsGeneration(pid) ?? { confidence: "unavailable" }
  return { confidence: "unavailable" }
}

// LAZY, and memoized so the value (above all an `opaque:` fallback) is stable for the process's life.
// It was an eager IIFE, which made IMPORTING this module cost an observation: harmless on Linux (one
// /proc read) but a PowerShell spawn on Windows — and the Claude broker daemon imports this module
// only to stamp its own birth onto its record, which on Linux reads /proc directly and never needs
// `current()`. Eager, every daemon start on Windows would have paid ~0.3s for a value nothing asked for.
let defaultSelfMemo: ProcessGeneration | undefined
function defaultSelf(): ProcessGeneration {
  if (defaultSelfMemo) return defaultSelfMemo
  const observed = observeDefault(process.pid)
  defaultSelfMemo = {
    pid: process.pid,
    processStart: observed.processStart ?? `opaque:${randomUUID()}`,
  }
  return defaultSelfMemo
}

const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4))

export const defaultProcessPlatformAdapter: ProcessPlatformAdapter = {
  current: defaultSelf,
  observe: observeDefault,
  isAlive: processAlive,
  now: () => Date.now(),
  sleep: (ms) => {
    if (ms > 0) Atomics.wait(SYNC_WAIT, 0, 0, ms)
  },
}

export function observeProcessGeneration(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): ProcessGenerationMatch {
  if (!adapter.isAlive(generation.pid)) return "dead"
  const self = adapter.current()
  if (generation.pid === self.pid && generation.processStart === self.processStart) return "exact"
  if (generation.processStart.startsWith("opaque:")) return "unavailable"
  // Version-1 owners stored untagged, locale-dependent `ps` prose. It cannot be compared safely to
  // the canonical v2 marker: retain a live legacy owner until it exits instead of stealing from it.
  // A NEW platform tag must be added here and to the pin in project-launch.test.ts at the same time;
  // omit it here and that platform's own marker reads as v1 prose, so its branch silently does
  // nothing while every comparison it makes degrades to `unavailable`.
  if (!/^(?:linux|ps-utc|win32|opaque):/u.test(generation.processStart)) return "unavailable"
  const observed = adapter.observe(generation.pid)
  if (!observed.processStart || observed.confidence === "unavailable") return "unavailable"
  if (observed.processStart.split(":", 1)[0] !== generation.processStart.split(":", 1)[0]) {
    return "unavailable"
  }
  if (observed.processStart !== generation.processStart) return "mismatch"
  return observed.confidence
}

export function currentProcessGeneration(
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): ProcessGeneration {
  return adapter.current()
}

/** Back-compatible observer name; the value is now canonical/tagged rather than localized prose. */
export function processStartTime(
  pid: number,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): string | undefined {
  return adapter.observe(pid).processStart
}

export function exactProcessGenerationIsLive(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): boolean {
  return observeProcessGeneration(generation, adapter) === "exact"
}

export function processGenerationIsStale(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): boolean {
  const match = observeProcessGeneration(generation, adapter)
  return match === "dead" || match === "mismatch"
}
