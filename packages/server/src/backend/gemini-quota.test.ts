import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderQuota } from "@ntwine/shared"
import { hasAgyTokenFile, parseAgyVersion, parseAntigravityUsage, parseSecretServiceSearch, readGeminiQuota, resetGeminiQuotaMemo } from "./gemini-quota.ts"

// `agy -p "/usage" --output-format json`, captured from agy 1.5.11 on 2026-11-20 (descriptions trimmed).
const CAPTURED = {
  conversation_id: "",
  status: "SUCCESS",
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.8255125284194946, reset_time: "2026-11-26T18:59:16Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.8947048783302307, reset_time: "2026-11-21T01:47:56Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.1232549175620079, reset_time: "2026-11-27T07:05:09Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-21T05:50:34Z" },
          ],
        },
      ],
    },
  },
}

test("gemini: the captured /usage payload — Gemini's windows lead, 5h first, the other group rides along", () => {
  const q = parseAntigravityUsage(CAPTURED)
  assert.deepEqual(
    q?.windows.map((w) => [w.key, w.group, w.label, Math.round(w.usedPercent * 10) / 10, w.resetsAt]),
    [
      ["5h", undefined, "5h", 10.5, Date.parse("2026-11-21T01:47:56Z") / 1000],
      ["weekly", undefined, "Weekly", 17.4, Date.parse("2026-11-26T18:59:16Z") / 1000],
      ["3p-5h", "Claude/GPT", "5h", 0, Date.parse("2026-11-21T05:50:34Z") / 1000],
      ["3p-weekly", "Claude/GPT", "Weekly", 87.7, Date.parse("2026-11-27T07:05:09Z") / 1000],
    ],
  )
  assert.equal(q?.status, "ok")
})

test("gemini: a disabled bucket (no fraction) is left out, not drawn as full", () => {
  const payload = structuredClone(CAPTURED)
  delete (payload.command.data.groups[0]!.buckets[0] as { remaining_fraction?: number }).remaining_fraction
  assert.deepEqual(parseAntigravityUsage(payload)?.windows.map((w) => w.key), ["5h", "3p-5h", "3p-weekly"])
})

test("gemini: no Gemini group, or an answer to another command, is no reading", () => {
  const thirdPartyOnly = structuredClone(CAPTURED)
  thirdPartyOnly.command.data.groups.shift()
  assert.equal(parseAntigravityUsage(thirdPartyOnly), undefined)
  assert.equal(parseAntigravityUsage({ ...CAPTURED, command: { name: "credits", data: { remaining_credits: 0 } } }), undefined)
})

test("gemini: version gate parses agy's own --version", () => {
  assert.deepEqual(parseAgyVersion("1.5.11\n"), [1, 5, 11])
  assert.equal(parseAgyVersion("antigravity dev build"), undefined)
})

const OK: ProviderQuota = { status: "ok", windows: [{ key: "5h", label: "5h", usedPercent: 10 }] }

test("gemini reader: no agy, no reading and no process", async () => {
  resetGeminiQuotaMemo()
  let ran = 0
  // An empty `bin` is what a PATH lookup that found nothing hands over.
  const q = await readGeminiQuota({ bin: "", query: async () => (ran++, OK), supports: async () => true, signedIn: async () => true })
  assert.equal(q, undefined)
  assert.equal(ran, 0)
})

test("gemini reader: a stale reading answers at once while the next is fetched", async () => {
  resetGeminiQuotaMemo()
  let now = 0
  const reads: Array<(q: ProviderQuota) => void> = []
  const opts = { bin: "/x/agy", now: () => now, supports: async () => true, signedIn: async () => true, query: () => new Promise<ProviderQuota>((r) => reads.push(r)) }
  const first = readGeminiQuota(opts)
  await new Promise((r) => setImmediate(r))
  reads[0]!(OK)
  assert.equal(await first, OK)
  now = 61_000
  const later: ProviderQuota = { status: "ok", windows: [{ key: "5h", label: "5h", usedPercent: 50 }] }
  assert.equal(await readGeminiQuota(opts), OK, "the stale reading, not a wait on agy")
  await new Promise((r) => setImmediate(r))
  assert.equal(reads.length, 2, "and a refresh started behind it")
  reads[1]!(later)
  await new Promise((r) => setImmediate(r))
  assert.equal(await readGeminiQuota(opts), later)
})

test("gemini reader: a failed read backs off instead of re-running agy every poll; force skips the backoff", async () => {
  resetGeminiQuotaMemo()
  let now = 0
  let ran = 0
  const opts = { bin: "/x/agy", now: () => now, supports: async () => true, signedIn: async () => true, query: async () => (ran++, undefined) }
  assert.equal((await readGeminiQuota(opts))?.status, "unavailable")
  // Past the 1m TTL on the second failure's clock: the backoff is now 2m, so a poll at 61s and one at
  // 3m both stay off agy until it has passed.
  now = 61_000
  await readGeminiQuota(opts)
  await new Promise((r) => setImmediate(r))
  assert.equal(ran, 2, "the first backoff (1m) has passed")
  now = 150_000
  await readGeminiQuota(opts)
  await new Promise((r) => setImmediate(r))
  assert.equal(ran, 2, "inside the second backoff (2m from 61s), agy is not run again")
  await readGeminiQuota({ ...opts, force: true })
  assert.equal(ran, 3)
})

test("gemini reader: an agy too old to answer /usage itself is never run", async () => {
  resetGeminiQuotaMemo()
  let ran = 0
  const q = await readGeminiQuota({ bin: "/x/agy", signedIn: async () => true, supports: async () => false, query: async () => (ran++, OK) })
  assert.equal(ran, 0)
  assert.equal(q?.detail, "Update Antigravity CLI to see Gemini usage")
})

// A signed-out `agy -p` opens Google's sign-in page in the operator's browser (gemini-quota.ts), so
// without a credential the reader must not start it at all — on any poll, forced or not.
test("gemini reader: signed out, agy is never run", async () => {
  resetGeminiQuotaMemo()
  let ran = 0
  const opts = { bin: "/x/agy", signedIn: async () => false, supports: async () => true, query: async () => (ran++, OK) }
  assert.equal((await readGeminiQuota(opts))?.status, "unavailable")
  await readGeminiQuota({ ...opts, force: true })
  assert.equal(ran, 0)
})

test("gemini sign-in: on-disk token file (Linux/WSL2) requires a non-empty OAuth token", async () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-agy-tok-"))
  try {
    assert.equal(await hasAgyTokenFile(home), false)
    const dir = join(home, ".gemini", "antigravity-cli")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "antigravity-oauth-token")
    writeFileSync(file, "{}")
    assert.equal(await hasAgyTokenFile(home), false)
    writeFileSync(file, "not json")
    assert.equal(await hasAgyTokenFile(home), false)
    writeFileSync(file, JSON.stringify({ token: { access_token: "", refresh_token: "" }, auth_method: "oauth" }))
    assert.equal(await hasAgyTokenFile(home), false)
    writeFileSync(file, JSON.stringify({ token: { access_token: "ya29.test", refresh_token: "1//test" }, auth_method: "oauth" }))
    assert.equal(await hasAgyTokenFile(home), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("gemini sign-in: Linux Secret Service SearchItems matches unlocked or locked items, never empty", () => {
  assert.equal(parseSecretServiceSearch("(@ao [], @ao [])\n"), false)
  assert.equal(parseSecretServiceSearch("([objectpath '/org/freedesktop/secrets/collection/login/42'], @ao [])\n"), true)
  assert.equal(parseSecretServiceSearch("(@ao [], [objectpath '/org/freedesktop/secrets/collection/login/42'])\n"), true)
})
