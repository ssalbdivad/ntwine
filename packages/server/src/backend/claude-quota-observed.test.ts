import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  observedQuotaPath,
  readObservedClaudeQuota,
  recordObservedClaudeQuota,
  resetObservedClaudeQuotaThrottle,
  windowsFromRateLimitInfo,
} from "./claude-quota-observed.ts"

// The frame Claude Code 2.1.296 sent on 2026-10-11, verbatim, while the usage endpoint answered
// 5h 65% (resets 1791757200) and weekly 76% (resets 1791792001) for the same account.
const CAPTURED = {
  status: "allowed_warning",
  resetsAt: 1791792000,
  rateLimitType: "seven_day",
  utilization: 0.76,
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.65, resetsAt: 1791757200 }, seven_day: { utilization: 0.76, resetsAt: 1791792000 } },
  overageEnabled: false,
}

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
// An instant before both captured windows reset.
const T0 = 1791750000 * SEC

async function withDir(run: (cacheDir: string) => Promise<void>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "frizz-observed-quota-"))
  resetObservedClaudeQuotaThrottle()
  try {
    await run(cacheDir)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test("observed quota: a real rate_limit_event names both windows, as the endpoint's percentages", () => {
  assert.deepEqual(windowsFromRateLimitInfo(CAPTURED), [
    { key: "5h", label: "5h", usedPercent: 65, resetsAt: 1791757200 },
    { key: "weekly", label: "Weekly", usedPercent: 76, resetsAt: 1791792000 },
  ])
})

test("observed quota: a frame with only the typed fields yields the one window that binds", () => {
  const { unifiedWindows: _dropped, ...typedOnly } = CAPTURED
  assert.deepEqual(windowsFromRateLimitInfo(typedOnly), [{ key: "weekly", label: "Weekly", usedPercent: 76, resetsAt: 1791792000 }])
  assert.deepEqual(windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.07 }), [{ key: "5h", label: "5h", usedPercent: 7 }])
})

// The scheduler resumes a limit-paused thread when the blown window reads below its floor. A refusal
// whose own response carried no fresh figure must not leave the number from BEFORE the wall standing.
test("observed quota: a refusal marks the window it names as spent, whatever number rides along", () => {
  assert.deepEqual(windowsFromRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1791757200 }), [
    { key: "5h", label: "5h", usedPercent: 100, resetsAt: 1791757200 },
  ])
  assert.deepEqual(
    windowsFromRateLimitInfo({ status: "rejected", rateLimitType: "seven_day", utilization: 0.4, resetsAt: 1791792000, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1791757200 }, seven_day: { utilization: 0.4, resetsAt: 1791792000 } } }),
    [
      { key: "5h", label: "5h", usedPercent: 20, resetsAt: 1791757200 },
      { key: "weekly", label: "Weekly", usedPercent: 100, resetsAt: 1791792000 },
    ],
  )
  // Past the cap stays past the cap, and a refusal for something that is not a plan window names none.
  assert.equal(windowsFromRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", utilization: 1.04 })[0]?.usedPercent, 104)
  assert.deepEqual(windowsFromRateLimitInfo({ status: "rejected", rateLimitType: "overage" }), [])
})

test("observed quota: anything that is not a plan window is not one", () => {
  for (const info of [undefined, null, "allowed", 7, [], {}, { status: "allowed" }, { rateLimitType: "overage", utilization: 0.5 }, { rateLimitType: "five_hour" }, { rateLimitType: "five_hour", utilization: "0.5" }, { rateLimitType: "five_hour", utilization: Number.NaN }, { unifiedWindows: { five_hour: null, seven_day: { utilization: -1 }, mystery: { utilization: 0.2 } } }]) {
    assert.deepEqual(windowsFromRateLimitInfo(info), [], JSON.stringify(info))
  }
})

test("observed quota: a report is kept per window — a frame naming only the binding one does not erase the other", () => withDir(async (cacheDir) => {
  const where = { cacheDir, configDir: "/home/a/.claude" }
  assert.equal(await recordObservedClaudeQuota(CAPTURED, { ...where, now: T0 }), true)
  assert.equal(await recordObservedClaudeQuota({ rateLimitType: "five_hour", utilization: 0.7, resetsAt: 1791757200 }, { ...where, now: T0 + 5 * MIN }), true)
  const read = await readObservedClaudeQuota(cacheDir, where.configDir, T0 + 6 * MIN)
  assert.equal(read?.at, T0 + 5 * MIN)
  assert.deepEqual(read?.windows, [
    { key: "5h", label: "5h", usedPercent: 70, resetsAt: 1791757200, at: T0 + 5 * MIN },
    { key: "weekly", label: "Weekly", usedPercent: 76, resetsAt: 1791792000, at: T0 },
  ])
  // Another account's config directory is another record entirely.
  assert.equal(await readObservedClaudeQuota(cacheDir, "/home/b/.claude", T0 + 6 * MIN), undefined)
  assert.equal(((await stat(observedQuotaPath(cacheDir, where.configDir))).mode & 0o777).toString(8), "600")
}))

test("observed quota: a window is shown only until its own reset, and a report only for a day", () => withDir(async (cacheDir) => {
  const where = { cacheDir, configDir: "/home/a/.claude" }
  await recordObservedClaudeQuota(CAPTURED, { ...where, now: T0 })
  const keys = async (now: number) => (await readObservedClaudeQuota(cacheDir, where.configDir, now))?.windows.map((w) => w.key)
  assert.deepEqual(await keys(1791757200 * SEC - 1), ["5h", "weekly"])
  assert.deepEqual(await keys(1791757200 * SEC), ["weekly"], "the 5-hour window has reset: its last number describes a window that is gone")
  assert.deepEqual(await keys(T0 + 24 * HOUR - 1), undefined, "and so has the weekly, 11h 40m after T0")
  // A window with no reset time stands on the age bound alone.
  resetObservedClaudeQuotaThrottle()
  await recordObservedClaudeQuota({ rateLimitType: "five_hour", utilization: 0.1 }, { ...where, now: T0 })
  assert.deepEqual(await keys(T0 + 24 * HOUR - 1), ["5h"])
  assert.deepEqual(await keys(T0 + 24 * HOUR), undefined)
}))

test("observed quota: a daemon rewrites the file when a number moved, and otherwise once per 30s", () => withDir(async (cacheDir) => {
  const where = { cacheDir, configDir: "/home/a/.claude" }
  const record = (info: unknown, now: number) => recordObservedClaudeQuota(info, { ...where, now })
  assert.equal(await record(CAPTURED, T0), true)
  assert.equal(await record(CAPTURED, T0 + SEC), false, "one frame per API response, all saying the same thing")
  assert.equal(await record(CAPTURED, T0 + 29 * SEC), false)
  assert.equal(await record({ ...CAPTURED, unifiedWindows: { ...CAPTURED.unifiedWindows, five_hour: { utilization: 0.66, resetsAt: 1791757200 } } }, T0 + 2 * SEC), true, "a number moved")
  assert.equal(await record(CAPTURED, T0 + 3 * SEC), true, "and moved back")
  assert.equal(await record(CAPTURED, T0 + 33 * SEC), true, "the same reading is re-stamped once the interval has passed, so its age stays honest")
  assert.equal(await record({ status: "allowed" }, T0 + 5 * MIN), false, "a frame with no window writes nothing")
  assert.equal((await readObservedClaudeQuota(cacheDir, where.configDir, T0 + 5 * MIN))?.at, T0 + 33 * SEC)
}))

test("observed quota: a damaged record reads as no record, and recording never throws", () => withDir(async (cacheDir) => {
  const configDir = "/home/a/.claude"
  for (const body of ["", "not json", "null", "{}", '{"windows":7}', '{"windows":[null,{"key":"5h"},{"key":"5h","label":"5h","usedPercent":"9","at":1}]}']) {
    await writeFile(observedQuotaPath(cacheDir, configDir), body)
    assert.equal(await readObservedClaudeQuota(cacheDir, configDir, T0), undefined, body)
  }
  // A record that cannot be read is replaced rather than merged into.
  assert.equal(await recordObservedClaudeQuota(CAPTURED, { cacheDir, configDir, now: T0 }), true)
  assert.equal(JSON.parse(await readFile(observedQuotaPath(cacheDir, configDir), "utf8")).windows.length, 2)
  // Nowhere to write: a file where the cache directory should be.
  resetObservedClaudeQuotaThrottle()
  assert.equal(await recordObservedClaudeQuota(CAPTURED, { cacheDir: join(observedQuotaPath(cacheDir, configDir), "nested"), configDir, now: T0 }), false)
}))
