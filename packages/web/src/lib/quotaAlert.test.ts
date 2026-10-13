import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProviderQuota, QuotaSnapshot, ThreadView } from "@ntwine/shared"
import { isQuotaAlertDismissed, quotaAlerts } from "./quotaAlert.ts"

const now = 1_800_000_000
const ok = (fiveHourUsed: number, weeklyUsed = 40, weeklyReset = now + 86_400): ProviderQuota => ({
  status: "ok",
  windows: [
    { key: "5h", label: "5h", usedPercent: fiveHourUsed, resetsAt: now + 2400 },
    { key: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt: weeklyReset },
  ],
})
const snap = (claude: ProviderQuota, codex: ProviderQuota = ok(10)): QuotaSnapshot => ({ claude, codex })
const thread = (over: Partial<ThreadView>): ThreadView => ({ kind: "session", id: "t", ...over }) as ThreadView
const running = thread({ backend: "claude" })

test("a low window alerts only while a thread on that provider is working", () => {
  const [alert, ...more] = quotaAlerts(snap(ok(93)), undefined, [running, thread({ backend: "codex" })], now)
  assert.equal(more.length, 0)
  assert.equal(alert?.backend, "claude")
  assert.equal(alert?.remaining, 7)
  assert.equal(alert?.running, 1)
  assert.equal(alert?.key, `claude:5h:${now + 2400}`)
  // Negative controls: nothing running, or only the other provider running, is no alert.
  assert.deepEqual(quotaAlerts(snap(ok(93)), undefined, [], now), [])
  assert.deepEqual(quotaAlerts(snap(ok(93)), undefined, [thread({ backend: "codex" })], now), [])
})

test("healthy quota, a queued thread, or a signed-out account raises nothing", () => {
  assert.deepEqual(quotaAlerts(snap(ok(89)), undefined, [running], now), [])
  assert.deepEqual(quotaAlerts(snap(ok(95)), undefined, [thread({ backend: "claude", needsYou: true })], now), [])
  assert.deepEqual(quotaAlerts(snap(ok(95)), { claude: "signed-out", codex: "authed" }, [running], now), [])
})

test("the tightest low window leads, and a window already past its reset is ignored", () => {
  assert.equal(quotaAlerts(snap(ok(92, 98)), undefined, [running], now)[0]?.window.key, "weekly")
  assert.equal(quotaAlerts(snap(ok(50, 99, now - 1)), undefined, [running], now).length, 0)
})

test("a thread with no recorded backend counts as Claude", () => {
  assert.equal(quotaAlerts(snap(ok(95)), undefined, [thread({})], now)[0]?.running, 1)
})

test("a dismissal holds through reset-time jitter but not into the next period", () => {
  const alert = quotaAlerts(snap(ok(95)), undefined, [running], now)[0]!
  assert.equal(isQuotaAlertDismissed(alert, [`claude:5h:${now + 2400 - 2}`]), true)
  assert.equal(isQuotaAlertDismissed(alert, [`claude:5h:${now + 2400 - 5 * 3600}`]), false)
  assert.equal(isQuotaAlertDismissed(alert, [`codex:5h:${now + 2400}`]), false)
  assert.equal(isQuotaAlertDismissed(alert, [`claude:weekly:${now + 2400}`]), false)
})
