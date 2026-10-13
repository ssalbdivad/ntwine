import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// ── Boot progress, published for the launcher ──────────────────────────────────────────────────────
// A launcher spawns the control plane DETACHED and then waits for /health. Until this existed the wait
// was a flat 30s deadline against a process it could not see inside: a boot that was working fine but
// slow (a first-ever boot of a large board, or any boot on a loaded machine) hit the deadline, the
// launcher printed "Ntwine did not become healthy", and the child carried on booting and bound the port —
// so the operator got an error AND a stray control plane contending with their next attempt.
//
// The child now names what it is doing, as it does it. That converts the launcher's question from
// "has 30 seconds elapsed?" (which says nothing about whether anything is wrong) to "has this boot
// stopped making progress?" (which is the actual failure), and lets the give-up message say where it
// got stuck instead of just how long it waited.
//
// Transient IPC, not durable state: written without fsync, removed once the server is listening, and
// every read/write is best-effort. A missing or unparseable file simply means "no progress signal",
// which degrades the launcher to its historical flat deadline.

export const BOOT_PROGRESS_NAME = "boot.progress"
export const BOOT_STALL_TIMEOUT_MS = 30_000
/** Progress buys patience, but even a continuously reporting boot must eventually finish. */
export const BOOT_HARD_TIMEOUT_MS = 10 * 60_000

export interface BootProgress {
  /** The publishing process, so a launcher can tell a live boot from a leftover file. */
  pid: number
  /** Monotonically increasing within one boot; the launcher treats any increase as progress. */
  step: number
  /** Human-readable phase, e.g. "tailer producer 1200/5000". */
  phase: string
  /** ISO8601 publication instant. */
  at: string
}

export function bootProgressPath(stateDir: string): string {
  return join(stateDir, BOOT_PROGRESS_NAME)
}

export function readBootProgress(stateDir: string): BootProgress | null {
  try {
    const value = JSON.parse(readFileSync(bootProgressPath(stateDir), "utf8")) as Partial<BootProgress>
    if (
      !Number.isInteger(value.pid) || !Number.isInteger(value.step) ||
      typeof value.phase !== "string" || typeof value.at !== "string"
    ) return null
    return value as BootProgress
  } catch {
    return null
  }
}

export interface BootProgressPublisher {
  /** Record that the boot has reached `phase`. Rate-limited; a phase CHANGE always publishes. */
  (phase: string): void
  /** Remove the file — the boot is over, one way or the other. */
  done(): void
}

/**
 * A publisher for one boot. `minIntervalMs` throttles same-phase updates (the tailer's first pass
 * reports its row counter continuously) without ever suppressing a phase transition.
 */
export function createBootProgressPublisher(stateDir: string | undefined, minIntervalMs = 200): BootProgressPublisher {
  if (!stateDir) {
    const inert = Object.assign(() => {}, { done: () => {} })
    return inert
  }
  const path = bootProgressPath(stateDir)
  let step = 0
  let lastPhase = ""
  let lastAt = 0
  const write = (phase: string) => {
    const now = Date.now()
    if (phase === lastPhase && now - lastAt < minIntervalMs) return
    lastPhase = phase
    lastAt = now
    step++
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
      writeFileSync(temp, `${JSON.stringify({ pid: process.pid, step, phase, at: new Date(now).toISOString() })}\n`, "utf8")
      renameSync(temp, path)
    } catch {
      // Progress is an optimization for the launcher's patience; never a boot dependency.
    }
  }
  return Object.assign(write, {
    done: () => {
      try {
        rmSync(path, { force: true })
      } catch {
        // A leftover file is inert: its pid is checked, and a stale one simply stops advancing.
      }
    },
  })
}
