import { activeBandThread, agentParked, type AccountBackend, type AuthSnapshot, type QuotaSnapshot, type QuotaWindow, type ThreadView } from "@ntwine/shared"

// THE LOW-QUOTA ALERT — the queue card that warns, BEFORE a usage limit pauses anything, that a
// provider's subscription is nearly spent while threads on it are still working. The pause card
// (lib/limitPause.ts) is the after-the-fact half: by then every running thread on the account has
// already stopped. This is the half that still lets the operator do something about it — buy extra
// usage, upgrade, or let the work wind down on purpose.
//
// It speaks only when BOTH halves are true: a window is nearly out AND something on that provider is
// running. A low reading with nothing in flight interrupts nobody — the chip's red number already says
// it — and a card for it would be noise in a queue that is meant to hold only what wants the human.

/** Remaining % at or below which a window raises the alert. The chip's red tone starts at 8 (QuotaBar
 *  toneText); the alert leads it slightly, so the warning lands while there is still runway to act. */
export const QUOTA_ALERT_MAX_REMAINING = 10

export interface QuotaAlertLink {
  label: string
  href: string
}

/**
 * Where each provider sells more capacity. The billing pages, not the marketing ones: an operator mid-burn
 * wants the page that adds usage to THIS account. Claude's extra usage and Codex's credits both live on the
 * account's usage settings; the plan pages are the upgrade path.
 */
export const QUOTA_ALERT_LINKS: Record<AccountBackend, QuotaAlertLink[]> = {
  claude: [
    { label: "Buy extra usage", href: "https://claude.ai/settings/usage" },
    { label: "Upgrade plan", href: "https://claude.ai/upgrade" },
  ],
  codex: [
    { label: "Buy credits", href: "https://chatgpt.com/codex/settings/usage" },
    { label: "Upgrade plan", href: "https://chatgpt.com/pricing" },
  ],
}

export interface QuotaAlert {
  backend: AccountBackend
  /** The tightest low window — the one that runs out first. */
  window: QuotaWindow
  remaining: number
  /** Threads on this provider that are working right now. */
  running: number
  /** Identifies this alert for dismissal: one window, one reset period. */
  key: string
}

/** `${backend}:${window}:${resetsAt}` — a dismissal holds until the window resets, then a fresh run-down
 *  alerts again. A window that reports no reset is keyed without one, so its dismissal holds for good. */
export function quotaAlertKey(backend: AccountBackend, window: QuotaWindow): string {
  return `${backend}:${window.key}:${window.resetsAt ?? "-"}`
}

// How far apart two readings of one reset instant may sit and still be the same period. A provider
// reports the instant per read, and a source that derives it from "resets in N seconds" lands a second
// or two off each time; the shortest real window is 5h, so half an hour cannot join two periods.
const SAME_RESET_SEC = 30 * 60

/** Whether the operator already dismissed this alert's window for its current reset period. */
export function isQuotaAlertDismissed(alert: QuotaAlert, dismissed: readonly string[]): boolean {
  const prefix = `${alert.backend}:${alert.window.key}:`
  return dismissed.some((key) => {
    if (!key.startsWith(prefix)) return false
    const at = key.slice(prefix.length)
    if (at === "-" || alert.window.resetsAt === undefined) return at === String(alert.window.resetsAt ?? "-")
    return Math.abs(Number(at) - alert.window.resetsAt) < SAME_RESET_SEC
  })
}

/** The alerts to show, one per provider at most, given the poll, the auth read and every thread on the
 *  page (all projects — quota is account-global, so a focused view still warns about the others). */
export function quotaAlerts(
  quota: QuotaSnapshot | undefined,
  auth: AuthSnapshot | undefined,
  threads: readonly ThreadView[],
  nowSec = Date.now() / 1000,
): QuotaAlert[] {
  if (!quota) return []
  const alerts: QuotaAlert[] = []
  for (const backend of ["claude", "codex"] as const) {
    const q = quota[backend]
    if (q.status !== "ok" || auth?.[backend] === "signed-out") continue
    // A window whose reset has already passed is a stale reading: it has rolled over, whatever it says.
    const low = q.windows
      .filter((w) => !(w.resetsAt !== undefined && w.resetsAt <= nowSec))
      .map((w) => ({ window: w, remaining: Math.max(0, Math.round(100 - w.usedPercent)) }))
      .filter((w) => w.remaining <= QUOTA_ALERT_MAX_REMAINING)
    if (low.length === 0) continue
    const running = threads.filter((t) => activeBandThread(t) && !agentParked(t) && (t.backend ?? "claude") === backend).length
    if (running === 0) continue
    const tightest = low.reduce((a, b) => (b.remaining < a.remaining ? b : a))
    alerts.push({ backend, window: tightest.window, remaining: tightest.remaining, running, key: quotaAlertKey(backend, tightest.window) })
  }
  return alerts
}

// ---- Dismissal -------------------------------------------------------------------------------------
// Per browser, like the rest of the page's view state. Bounded so a long-lived tab cannot grow it: only
// the newest few keys matter, since an older one names a reset period that has already passed.

const DISMISSED_KEY = "ntwine.quotaAlert.dismissed"
const DISMISSED_CAP = 16

export function readDismissedQuotaAlerts(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]")
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

export function dismissQuotaAlert(key: string): string[] {
  const next = [...readDismissedQuotaAlerts().filter((k) => k !== key), key].slice(-DISMISSED_CAP)
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the dismissal still holds for this page's life.
  }
  return next
}
