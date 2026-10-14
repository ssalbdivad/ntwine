import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { release as osRelease } from "node:os"
import { win32 } from "node:path"
import type { SessionTelemetry } from "./tailer.ts"
import type { SessionRow } from "./storage.ts"
import { log as ntwineLog } from "./logging.ts"

// ── KEEP THE MACHINE AWAKE WHILE AN AGENT IS WORKING ─────────────────────────────────────────────────
//
// An agent left running overnight stopped for 8h 35m because the HOST idle-slept (arktype a627551f,
// 2026-10-02): Windows logged "entering sleep, Sleep Reason: System Idle" at 01:38 — its AC plan sleeps
// after an hour without input — and woke at 10:14 on a keypress. WSL froze with it, and so did every
// agent, sub-agent and benchmark it hosted. A background process does not count as activity to any
// desktop OS's idle timer, so a machine doing hours of agent work reads as idle to the one thing that
// decides whether it sleeps.
//
// So while any thread has work RUNNING on this machine, the server holds the OS's own "system required"
// request, and drops it the moment nothing is. Only IDLE sleep is blocked: closing the lid, the power
// button and an explicit Sleep still sleep, and the display still turns off. What counts as running is
// `keepsAwake` below — deliberately local compute only. A thread parked on a PR, an issue or a timer is
// waiting on the world, not on this machine; it catches up on wake, and holding a laptop awake for a
// 180-day PR watch would be absurd.
//
// The request is held by a CHILD PROCESS, never by this one, for two reasons: Node has no binding to
// any of the three platform APIs, and a child ties the request's lifetime to its own. Each helper
// below notices when its stdin closes — a release, a shutdown, a crash or a SIGKILL alike — and then
// keeps holding for WAKE_LOCK_LINGER_S before it exits, so the OS never sees an orphaned hold, only a
// bounded one. (On Windows and WSL a lingering helper also exits as soon as another one holds; see
// WINDOWS_HOLD_SCRIPT.)
//
// The linger is the fix for the second overnight stop (2026-10-03): with agents running and Windows
// past its idle timeout since 08:23, the dev supervisor restarted the control plane at 10:15:40 on
// another agent's edit. Shutdown released the hold, and Windows logged "entering sleep, Sleep Reason:
// System Idle" ONE SECOND later — before the new server could take it back — and slept until 11:35.
// Once the idle timer has run out, any gap in the request is a sleep, however short, so the hold has to
// bridge a restart (a slow drain plus a boot is ~20s; the linger allows minutes). The helper is spawned
// detached and unref'd so a Ctrl-C to the server's process group cannot cut the linger short either.

/** How often the server re-reads whether anything is running. Idle timers are minutes; this is plenty. */
export const WAKE_LOCK_POLL_MS = 30_000

/**
 * How long a helper keeps holding after its stdin closes: long enough to bridge a server restart and a
 * poll or two of a thread flickering idle between turns; short enough that a machine with nothing
 * running sleeps soon after anyway.
 */
export const WAKE_LOCK_LINGER_S = 300

/** The parts of a thread's telemetry that say whether it has work running on this machine. */
export type WakeTelemetry = Pick<SessionTelemetry, "turn" | "subAgents" | "bgShells" | "permPrompt" | "pendingAsk">

/**
 * Does this thread have work running on THIS machine right now?
 *
 * - A turn in flight — unless it is frozen on a permission prompt or a native question, which is a
 *   human the machine is waiting for, not work.
 * - Any sub-agent the tailer still tracks, `stale` included: staleness is "no transcript append for
 *   15m", and a child inside a two-hour benchmark is exactly that. A child whose process died is
 *   retired by the tailer (its owner probe), so it does not hold the machine forever.
 * - A background shell launched with a budget — a build, a test run, a poller: bounded work. An
 *   unbudgeted shell is how a dev server or a log tail is launched (the worker contract says so), and
 *   one of those must not keep a laptop awake for as long as it runs. A `Monitor` streams into a turn
 *   and is never budgeted, so it is excluded by the same rule.
 */
export function keepsAwake(t: WakeTelemetry): boolean {
  if (t.turn === "in-flight" && !t.permPrompt && !t.pendingAsk) return true
  if (t.subAgents.length > 0) return true
  return t.bgShells.some((shell) => !shell.monitor && shell.budgetMs !== undefined)
}

/** The tenants' sessions and their telemetry, as the server-wide loop reads them. */
export interface WakeSource {
  sessions(): readonly Pick<SessionRow, "slug" | "archived">[]
  telemetry(slug: string): WakeTelemetry | undefined
}

/** The slug of one thread keeping the machine awake, for the log line — or undefined when none is. */
export function firstLiveThread(sources: Iterable<WakeSource>): string | undefined {
  for (const source of sources) {
    for (const row of source.sessions()) {
      if (row.archived) continue
      const t = source.telemetry(row.slug)
      if (t && keepsAwake(t)) return row.slug
    }
  }
  return undefined
}

export interface WakeLockPlatform {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** `os.release()` — the only place a WSL kernel says so when WSL_DISTRO_NAME was not inherited. */
  kernelRelease: string
}

export function isWsl(p: Pick<WakeLockPlatform, "platform" | "env" | "kernelRelease">): boolean {
  return p.platform === "linux" && (p.env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(p.kernelRelease))
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001): hold "the system is in use" on this thread until it
// is cleared or the thread exits — and nothing ever clears it, so it lasts exactly as long as the
// process. Measured on the maintainer's machine with CallNtPowerInformation(SystemExecutionState):
// 0x0 before, 0x1 while held, 0x0 once the process exited. ES_DISPLAY_REQUIRED is left out on purpose.
//
// The linger ends early once ANOTHER helper holds, because then nothing is bridged by it. Every
// control-plane generation left one lingering helper behind, so a dev session recycling on each commit
// to main stacked them up (four at once on 2026-10-13) — each holding a request already held by its
// successor. A new holder sets a named session-wide event right after taking its request; a lingering
// helper resets the event when its stdin closes and waits on it instead of sleeping. The one race —
// a successor's Set landing between a lingerer's Reset and its wait — costs a full linger, never a gap.
const WINDOWS_HOLD_SCRIPT = (lingerS: number) =>
  `$k=Add-Type -Name WakeLock -Namespace Ntwine -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
  `[void]$k::SetThreadExecutionState([uint32]2147483649);` +
  `$h=New-Object System.Threading.EventWaitHandle($false,[System.Threading.EventResetMode]::ManualReset,'Local\\NtwineWakeLockHolder');` +
  `[void]$h.Set();` +
  `[void][Console]::In.ReadToEnd();` +
  `[void]$h.Reset();` +
  `[void]$h.WaitOne(${lingerS * 1000})`

/** The POSIX helpers' body: wait for stdin to close, then linger. */
const POSIX_HOLD_SCRIPT = `cat >/dev/null; sleep ${WAKE_LOCK_LINGER_S}`

/**
 * The helper that holds the request on this platform, or undefined where there is none to hold.
 *
 * - Windows and WSL: PowerShell calling SetThreadExecutionState. In WSL the host is what sleeps, so a
 *   Linux inhibitor would guard a kernel nobody suspends — the request has to reach Windows. The
 *   script goes over -EncodedCommand because WSL interop re-quotes arguments and mangles the double
 *   quotes the P/Invoke signature needs. On native Windows the path is anchored to %SystemRoot%,
 *   never resolved through PATH, for the reason tailer.ts windowsShellHolderCommand gives.
 * - macOS: `caffeinate -i`, which prevents idle system sleep only, for as long as the shell it runs
 *   does. (`-w <pid>` would end it the instant the server died, which is the gap the linger exists for.)
 * - Linux: `systemd-inhibit --what=idle` around the same shell. `idle` and not `sleep`: a sleep
 *   inhibitor would also block a suspend the human asks for.
 */
export function wakeLockCommand(p: WakeLockPlatform, lingerS = WAKE_LOCK_LINGER_S): [string, string[]] | undefined {
  const encoded = Buffer.from(WINDOWS_HOLD_SCRIPT(lingerS), "utf16le").toString("base64")
  const psArgs = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded]
  if (p.platform === "win32") {
    return [win32.join(p.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), psArgs]
  }
  if (isWsl(p)) return ["powershell.exe", psArgs]
  if (p.platform === "darwin") return ["caffeinate", ["-i", "/bin/sh", "-c", POSIX_HOLD_SCRIPT]]
  if (p.platform === "linux") {
    return ["systemd-inhibit", ["--what=idle", "--who=Ntwine", "--why=An agent is working", "--mode=block", "/bin/sh", "-c", POSIX_HOLD_SCRIPT]]
  }
  return undefined
}

export interface WakeLock {
  /** Hold or release the request. Idempotent; cheap to call on every poll. */
  set(held: boolean): void
  readonly held: boolean
  /** Release for good — shutdown. */
  stop(): void
}

type Spawn = (command: string, args: string[]) => ChildProcess

/** A helper that dies this soon after starting, this many times in a row, is broken here; stop trying. */
const QUICK_EXIT_MS = 10_000
const QUICK_EXITS_MAX = 3

export function createWakeLock(
  command: [string, string[]] | undefined,
  spawn: Spawn = (cmd, args) => {
    const c = nodeSpawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true })
    c.unref()
    return c
  },
  log: Pick<typeof ntwineLog, "info" | "warn"> = ntwineLog,
): WakeLock {
  let child: ChildProcess | undefined
  let disabled = command === undefined
  let quickExits = 0
  const release = () => {
    const c = child
    child = undefined
    if (!c) return
    // Closing stdin is the release; the helper lingers and then exits on its own. Never kill it — a
    // killed helper drops the request NOW, and the gap is the sleep (see the header).
    c.stdin?.end()
  }
  const acquire = () => {
    if (child || disabled || !command) return
    const startedAt = Date.now()
    let c: ChildProcess
    try {
      c = spawn(command[0], command[1])
    } catch (error) {
      disabled = true
      log.warn("wake-lock", `cannot keep the machine awake: ${error instanceof Error ? error.message : error}`)
      return
    }
    child = c
    // EPIPE when the helper is already gone; the exit handler below is what reports it.
    c.stdin?.on("error", () => {})
    c.on("error", (error) => {
      if (child === c) child = undefined
      disabled = true
      log.warn("wake-lock", `cannot keep the machine awake (${command[0]}): ${error.message}`)
    })
    c.on("exit", (code, signal) => {
      if (child !== c) return // released on purpose
      child = undefined
      quickExits = Date.now() - startedAt < QUICK_EXIT_MS ? quickExits + 1 : 0
      if (quickExits >= QUICK_EXITS_MAX) {
        disabled = true
        log.warn("wake-lock", `${command[0]} keeps exiting (${signal ?? `code ${code}`}); no longer keeping the machine awake`)
      }
    })
  }
  return {
    set(held) {
      if (held) acquire()
      else release()
    },
    get held() {
      return child !== undefined
    },
    stop() {
      disabled = true
      release()
    },
  }
}

export interface WakeLockLoop {
  stop(): void
  /** Exposed for tests; the interval calls it otherwise. */
  tick(): void
}

/**
 * Poll every open project and hold the request while any thread keeps the machine awake. One loop for
 * the whole server — the request is machine-wide, and so is the question.
 */
export function startWakeLockLoop(
  sources: () => Iterable<WakeSource>,
  lock: WakeLock = createWakeLock(wakeLockCommand({ platform: process.platform, env: process.env, kernelRelease: osRelease() })),
  intervalMs = WAKE_LOCK_POLL_MS,
  log: Pick<typeof ntwineLog, "info"> = ntwineLog,
): WakeLockLoop {
  let was = false
  const tick = () => {
    let live: string | undefined
    try {
      live = firstLiveThread(sources())
    } catch {
      // A tenant closing under the read is not a reason to sleep through running work; keep what we had.
      return
    }
    lock.set(live !== undefined)
    const now = lock.held
    if (now !== was) log.info("wake-lock", now ? `keeping the machine awake while ${live} works` : "nothing running; the machine may sleep")
    was = now
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return {
    tick,
    stop() {
      clearInterval(timer)
      lock.stop()
    },
  }
}
