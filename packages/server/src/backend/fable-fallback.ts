import type { ProviderQuota } from "@ntwine/shared"
import type { QuotaWindowLike } from "./usage-limit.ts"

// ---- The FABLE FALLBACK (the `fableFallback` setting, off by default) -----------------------------
//
// On a plan where Fable carries its own weekly cap (the endpoint's scoped `weekly-fable` window), the
// base windows — the 5-hour session and the all-models weekly — can run dry while Fable's own budget
// still has room. With the setting on, Ntwine spends that room rather than leaving work stalled:
//
//   - a NEW Claude thread dispatched while the base is nearly out launches on Fable (dispatch.ts), and
//   - a thread a base limit has paused restarts on Fable at once instead of waiting out the window
//     (scheduler.ts evalLimits) — the same cold-resume switch the Fable → Opus step-down already uses.
//
// It is the inverse of that step-down, and the two cannot ping-pong: this moves a thread ONTO Fable only
// while Fable reads below FABLE_FALLBACK_HEADROOM_PERCENT, and a thread already on Fable is never moved
// by it. A thread that then caps Fable writes a model-scoped fault, steps down to Opus, and — with the
// Fable window now full — waits for the base window like any other limit.
//
// The thresholds read the same 10%-remaining line the queue's quota warning draws (web quotaAlert.ts),
// so "close to running out" means the same thing on the card and here.

/** A base window at or above this percent used counts as nearly out. */
export const FABLE_FALLBACK_BASE_PERCENT = 90
/** Fable's own window must read BELOW this percent used to be worth falling back to. */
export const FABLE_FALLBACK_HEADROOM_PERCENT = 90

// The base windows, by the provider-neutral keys claude-quota.ts gives them. Everything else on the
// snapshot is a model-scoped `weekly-<model>` cap or a group nothing here reasons about.
const BASE_KEYS = new Set(["5h", "weekly"])

/** Fable's scoped weekly window — by exact name, never the single-scoped-window guess scopedQuotaWindow
 *  allows: an account whose only scoped cap is some other model has no Fable budget to fall back to. */
export function fableQuotaWindow(windows: readonly QuotaWindowLike[]): QuotaWindowLike | undefined {
  return windows.find((w) => w.key === "weekly-fable" || w.key.startsWith("weekly-fable-"))
}

/** Does Fable's scoped window still have room? Unknown (no window, no reading) is no. */
export function fableHasHeadroom(quota: ProviderQuota | undefined): boolean {
  if (quota?.status !== "ok") return false
  const w = fableQuotaWindow(quota.windows)
  return typeof w?.usedPercent === "number" && w.usedPercent < FABLE_FALLBACK_HEADROOM_PERCENT
}

/** Is a base window nearly out? */
export function baseNearlyOut(quota: ProviderQuota | undefined): boolean {
  if (quota?.status !== "ok") return false
  return quota.windows.some((w) => BASE_KEYS.has(w.key) && w.usedPercent >= FABLE_FALLBACK_BASE_PERCENT)
}

/** Should a new Claude dispatch on `model` launch on Fable instead? `model` undefined is the CLI's own
 *  default, which is not Fable on any plan that has a scoped Fable cap. */
export function dispatchFallsBackToFable(model: string | undefined, quota: ProviderQuota | undefined): boolean {
  return model !== "fable" && baseNearlyOut(quota) && fableHasHeadroom(quota)
}
