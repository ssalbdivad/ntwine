import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { QuotaWindow } from "@frizz/shared"

// THE PLAN'S LIMITS AS CLAUDE CODE ITSELF REPORTS THEM, with no credential in Frizz's hands.
//
// claude-quota.ts reads the usage endpoint with the OAuth token it finds on this machine. Claude Code
// has more ways to be signed in than Frizz can read a token out of: an environment token a wrapper
// exports, a key helper, a descriptor a host passes it, a front-end that writes a base-URL/token pair
// into its settings — what people call a token broker. On such a machine Frizz's own read finds no
// credential at all while every worker runs signed in, and the chip had nothing to show.
//
// It does not need the token. Every API response a subscription session receives carries the account's
// unified rate-limit headers, and the Agent SDK surfaces them in the stream as a `rate_limit_event`:
//
//   { type: "rate_limit_event", rate_limit_info: {
//       status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.76, resetsAt: 1791792000,
//       unifiedWindows: { five_hour: { utilization: 0.65, resetsAt: 1791757200 },
//                         seven_day: { utilization: 0.76, resetsAt: 1791792000 } }, … } }
//
// (captured from Claude Code 2.1.296 on 2026-10-11, beside the usage endpoint's own answer for the same
// account a minute earlier: 5h 65% resetting 1791757200, weekly 76% resetting 1791792001 — the same
// numbers, as a 0..1 fraction instead of a percentage). `unifiedWindows` is not in the SDK's typings:
// the bundle describes it as @internal — both windows "as read from the anthropic-ratelimit-unified-*
// response headers", an event "emitted when a window's rounded percentage or reset time moves", and
// "always absent for API-key, Bedrock, and Vertex sessions, whose responses do not carry them". The
// typed fields describe only the ONE window that currently binds, so both shapes are read and the
// fuller one wins; if a later Claude Code drops the internal one, the binding window is still read.
// The readings are ACCOUNT-GLOBAL, like Codex's `rate_limits` (codex-quota.ts): any session of the
// account reports the same windows, so the latest one from any worker is the account's state. What no
// session reports is the per-model weekly breakdown, which only the endpoint names.
//
// The broker daemon is the process that sees the stream, and it outlives the Frizz server, so IT writes
// the reading — one small file beside the endpoint's cache, keyed by the same config directory — and
// the server only reads it. No frame, no protocol change, and nothing lost while no server is attached.

/** `rateLimitType` / a `unifiedWindows` key → the identity parseClaudeUsage gives that same limit. */
const WINDOW_IDENTITY: Record<string, readonly [key: string, label: string]> = {
  five_hour: ["5h", "5h"],
  seven_day: ["weekly", "Weekly"],
  seven_day_opus: ["weekly-opus", "Opus wk"],
  seven_day_sonnet: ["weekly-sonnet", "Sonnet wk"],
}

/** One window, with the instant (ms) a session last reported it. */
export type ObservedWindow = QuotaWindow & { at: number }

export interface ObservedClaudeQuota {
  /** The newest report in the record (ms). */
  at: number
  windows: ObservedWindow[]
}

// A window is only worth showing until its own reset — past it the number describes a window that no
// longer exists — and a report older than this is not a reading of anything.
const OBSERVED_MAX_AGE_MS = 24 * 60 * 60_000
// A daemon rewrites the file when a number moved, and otherwise at most this often: the stream carries
// one of these frames per API response, and a fleet of workers would turn that into a write storm for
// a reading that changes in whole percents.
const REWRITE_INTERVAL_MS = 30_000

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toWindow(name: string, utilization: unknown, resetsAt: unknown): QuotaWindow | undefined {
  const identity = WINDOW_IDENTITY[name]
  const fraction = finite(utilization)
  if (!identity || fraction === undefined || fraction < 0) return undefined
  const resets = finite(resetsAt)
  return {
    key: identity[0],
    label: identity[1],
    // 0..1 → the endpoint's 0..100, without the binary-float tail (0.65 * 100 is 65.00000000000001).
    usedPercent: Math.round(fraction * 10_000) / 100,
    ...(resets !== undefined && resets > 0 ? { resetsAt: Math.round(resets) } : {}),
  }
}

/** The windows one `rate_limit_info` names. Total: anything it cannot read is simply not a window. */
export function windowsFromRateLimitInfo(info: unknown): QuotaWindow[] {
  if (!info || typeof info !== "object") return []
  const raw = info as Record<string, unknown>
  const windows = new Map<string, QuotaWindow>()
  if (raw.unifiedWindows && typeof raw.unifiedWindows === "object") {
    for (const [name, value] of Object.entries(raw.unifiedWindows as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const w = value as Record<string, unknown>
      const window = toWindow(name, w.utilization, w.resetsAt)
      if (window) windows.set(window.key, window)
    }
  }
  // The typed half: the one window that binds. Only for a window the fuller shape did not carry.
  if (typeof raw.rateLimitType === "string") {
    const window = toWindow(raw.rateLimitType, raw.utilization, raw.resetsAt)
    if (window && !windows.has(window.key)) windows.set(window.key, window)
    // A REFUSAL names the window that is spent, whatever number rides along with it (the SDK notes that
    // a refused request's own response is not always read into the per-window figures). Recording it
    // as full is what stops a number from before the wall being read as headroom after it — the
    // scheduler resumes a limit-paused thread on exactly that reading (evalLimits, trigger 2).
    const identity = WINDOW_IDENTITY[raw.rateLimitType]
    if (raw.status === "rejected" && identity) {
      const standing = windows.get(identity[0])
      const resets = finite(raw.resetsAt)
      windows.set(identity[0], {
        key: identity[0],
        label: identity[1],
        usedPercent: Math.max(100, standing?.usedPercent ?? 0),
        ...(standing?.resetsAt !== undefined ? { resetsAt: standing.resetsAt } : resets !== undefined && resets > 0 ? { resetsAt: Math.round(resets) } : {}),
      })
    }
  }
  return [...windows.values()]
}

export function observedQuotaPath(cacheDir: string, configDir: string): string {
  const profile = createHash("sha256").update(configDir).digest("hex").slice(0, 12)
  return join(cacheDir, `claude-observed-${profile}.json`)
}

function live(window: ObservedWindow, now: number): boolean {
  if (now - window.at >= OBSERVED_MAX_AGE_MS) return false
  return window.resetsAt === undefined || window.resetsAt * 1000 > now
}

/** What sessions last reported, minus every window that has since reset or gone stale. Never throws. */
export async function readObservedClaudeQuota(cacheDir: string, configDir: string, now = Date.now()): Promise<ObservedClaudeQuota | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(observedQuotaPath(cacheDir, configDir), "utf8"))
  } catch {
    return undefined
  }
  const list = (parsed as { windows?: unknown } | null)?.windows
  if (!Array.isArray(list)) return undefined
  const windows: ObservedWindow[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const w = entry as Record<string, unknown>
    const at = finite(w.at)
    const usedPercent = finite(w.usedPercent)
    const resetsAt = finite(w.resetsAt)
    if (typeof w.key !== "string" || typeof w.label !== "string" || at === undefined || usedPercent === undefined) continue
    const window: ObservedWindow = { key: w.key, label: w.label, usedPercent, at, ...(resetsAt === undefined ? {} : { resetsAt }) }
    if (live(window, now)) windows.push(window)
  }
  if (windows.length === 0) return undefined
  return { at: Math.max(...windows.map((w) => w.at)), windows }
}

// What this process last wrote, per file — the throttle's whole memory.
const lastWritten = new Map<string, { at: number; signature: string }>()

/** Test seam: forget the throttle so a test can observe a write. */
export function resetObservedClaudeQuotaThrottle(): void {
  lastWritten.clear()
}

/**
 * Record what one `rate_limit_event` said. Returns whether the file was written. NEVER throws and never
 * rejects: this runs inside a worker's event pump, where a telemetry failure must not cost a session.
 */
export async function recordObservedClaudeQuota(
  info: unknown,
  where: { cacheDir: string; configDir: string; now?: number },
): Promise<boolean> {
  try {
    const now = where.now ?? Date.now()
    const reported = windowsFromRateLimitInfo(info)
    if (reported.length === 0) return false
    const path = observedQuotaPath(where.cacheDir, where.configDir)
    const signature = JSON.stringify(reported)
    const last = lastWritten.get(path)
    if (last && last.signature === signature && now - last.at < REWRITE_INTERVAL_MS) return false
    // A frame that names only the binding window must not erase the others a fuller frame left, so
    // the record is merged per window; each keeps the instant it was itself reported.
    const standing = await readObservedClaudeQuota(where.cacheDir, where.configDir, now)
    const windows = new Map<string, ObservedWindow>((standing?.windows ?? []).map((w) => [w.key, w]))
    for (const window of reported) windows.set(window.key, { ...window, at: now })
    await mkdir(where.cacheDir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await writeFile(tmp, JSON.stringify({ at: now, windows: [...windows.values()] }), { mode: 0o600 })
      await rename(tmp, path)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
    lastWritten.set(path, { at: now, signature })
    return true
  } catch {
    return false
  }
}
