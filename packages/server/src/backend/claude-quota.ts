import { join } from "node:path"
import { frizzRoots } from "../frizz-paths.ts"
import { homedir, platform } from "node:os"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuota, QuotaWindow } from "@frizz/shared"
import { resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { log as frizzLog } from "../logging.ts"

const execFileAsync = promisify(execFile)

// Subscription quota is read from the OAuth usage endpoint — the same call Claude Code's own /usage
// command makes — authorized by the credential already on this machine (the on-disk
// ~/.claude/.credentials.json, or the macOS login Keychain). That is one ~200ms HTTPS GET, immune to
// local CPU load.
//
// `claude -p /usage` IS A WHOLE CLAUDE CODE PROCESS, AND IT STARTS FOR EXACTLY ONE REASON: a
// credential exists and the endpoint rejected it (401/403). Claude Code owns OAuth refresh and
// rotation, so it is the only thing that can turn an expired token back into a working one. Every
// other failure — no credential at all, the network down, a timeout, a 5xx, a malformed body — fails
// the refresh and starts nothing, because the CLI makes this same request with this same credential
// and fails the same way. Until 2026-10-11 all of those fell through to the CLI and nothing
// remembered that it had failed, so a machine that was not signed in to Claude started a Claude Code
// process on every refresh attempt, for as long as Frizz ran (maintainer: "That's fucking nuts. We
// can't do that."). Measured that day: a real signed-out server with an empty board started one every
// 30s off the heartbeat alone, and with a chip polling every 15s beside it the same reader started
// 362 in a simulated hour — six a minute. Offline and a dead credential cost the same. The one start
// that remains is bounded by a persisted backoff — see CLI_BACKOFF_BASE_MS.
//
// (Spawning Claude Code was once the PRIMARY path, and under heavy machine load — worker fleets
// pushing load-80+ — it reliably exceeded any sane exec timeout: every refresh died and the chip
// served the same stale reading for hours.)
//
//   GET https://api.anthropic.com/api/oauth/usage
//     Authorization: Bearer <oauth access token>
//     anthropic-beta: oauth-2025-04-20
//     User-Agent: claude-code/<version>      ← REQUIRED; without it the endpoint 429s aggressively
//   → { five_hour:{utilization 0..100, reset_at ISO}, seven_day:{…}, seven_day_opus, seven_day_sonnet }
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.0.0" // gates by product, not exact version
const ENDPOINT_TIMEOUT_MS = 5000
// A healthy reading is trusted for two minutes. The endpoint is one cheap ~200ms GET, and a proactive
// server-side heartbeat (refreshClaudeQuotaInBackground, wired in context.ts) already keeps this cache
// warm, so a lazy read reflects a value about as recent as the endpoint's rate limit allows (see
// RATE_LIMIT_DEFAULT_BACKOFF_MS — in practice ~5 minutes, not these 2). FAIL keeps its tight 10s retry.
const OK_TTL_MS = 2 * 60_000
const FAIL_TTL_MS = 10_000
const STALE_MAX_AGE_MS = 24 * 60 * 60_000
// The CLI fallback boots a full Claude Code process; under load-80 a cold boot alone can blow well
// past 12s, and a too-tight bound here is indistinguishable from a broken credential.
const CLI_TIMEOUT_MS = 30_000
// HOW OFTEN THAT PROCESS MAY START: once, then no sooner than 15m later, then 30m, 1h … doubling to
// one a day. The count is persisted beside the reading (`cli`), so it holds across every Frizz
// process on the machine and across a restart, it binds the heartbeat, a stale read and a forced
// recheck alike, and ONLY THE ENDPOINT ACCEPTING THE TOKEN resets it — a usage reading the CLI printed
// proves nothing about the token this reader holds. A refresh that worked buys hours of valid token,
// so the healthy case is one start per expiry. The doubling is for the credential Claude Code cannot
// repair (a revoked sign-in, a token without the usage scope), which would otherwise be retried at the
// base interval for ever.
const CLI_BACKOFF_BASE_MS = 15 * 60_000
const CLI_BACKOFF_MAX_MS = 24 * 60 * 60_000
// The lock must outlive the slowest refresh (the 30s CLI fallback), and followers must be willing to
// wait through most of that bound. Otherwise a merely slow first process would make every other Frizz
// window give up early.
const LOCK_STALE_MS = 40_000
const LOCK_WAIT_MS = 15_000
const LOCK_POLL_MS = 50
// THE ENDPOINT RATE-LIMITS PER ACCESS TOKEN, HARD: measured 2026-09-19, one success bought a 429 with
// `retry-after` counting down a fixed ~5-minute window, and every Claude Code session on the machine
// shares that token's budget (upstream: anthropics/claude-code#31637). A caller that ignores the header
// spends most of its requests on refusals — a 2-minute heartbeat landed one success in three, and every
// popover recheck inside the window failed, which is why "Could not refresh" was the popover's usual
// reading. So the refusal's deadline is PERSISTED beside the reading (`retryAt`) and nothing — heartbeat,
// stale-read kick, forced recheck — calls the endpoint before it. Upstream also reports 429s carrying
// `retry-after: 0` or no header at all; those get this default. The cap bounds an absurd header.
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 5 * 60_000
const RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60_000

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Pull the OAuth access token out of a Claude credentials blob. The shape has drifted across
// versions, so probe the known nests defensively; return undefined when absent.
export function tokenFromCredentialsJson(raw: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const root = doc as Record<string, unknown>
  const oauth = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? (root.claudeAiOauth as Record<string, unknown>) : root
  const token = oauth.accessToken ?? oauth.access_token
  return typeof token === "string" && token ? token : undefined
}

// Keychain path for a default macOS install (no .credentials.json on disk; `security -w` prints the
// same blob shape as the file). Defensive: darwin-only, short timeout, swallow any error → undefined.
// ASYNC on purpose: a Keychain ACL prompt can block until the timeout, and a synchronous exec would
// freeze the whole server event loop for that window.
async function readKeychainToken(): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim())
  } catch {
    return undefined
  }
}

// The OAuth access token, tried in the order Claude Code itself resolves it: the on-disk
// .credentials.json first (Linux, and macOS installs that opted out of the Keychain), then the macOS
// login Keychain. Returns undefined only when NEITHER source yields a token.
async function readAccessToken(configDir: string): Promise<string | undefined> {
  try {
    const fromFile = tokenFromCredentialsJson(await readFile(join(configDir, ".credentials.json"), "utf8"))
    if (fromFile) return fromFile
  } catch {
    // Missing/unreadable file is expected on a Keychain-backed macOS install — fall through.
  }
  return readKeychainToken()
}

function isoToUnix(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// Map one legacy usage window from the endpoint (utilization 0..100, reset_at/resets_at ISO).
function toWindow(raw: unknown, key: string, label: string): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined
  if (util === undefined) return undefined
  const resetsAt = isoToUnix(w.resets_at ?? w.reset_at)
  return { key, label, usedPercent: util, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Map one modern `limits[]` entry: { kind, group, percent, resets_at, scope: { model: { display_name } } }.
// A scoped weekly ("weekly_scoped" with a model name — e.g. the Fable weekly cap on a Fable plan) keeps
// its model identity so the chip's tightest-window pick can name the cap that actually binds.
function windowFromLimit(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const l = raw as Record<string, unknown>
  const percent = typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : undefined
  if (percent === undefined) return undefined
  const group = typeof l.group === "string" ? l.group : typeof l.kind === "string" ? l.kind : ""
  const scope = l.scope && typeof l.scope === "object" ? (l.scope as Record<string, unknown>) : undefined
  const model = scope?.model && typeof scope.model === "object" ? (scope.model as Record<string, unknown>) : undefined
  const scopeName = typeof model?.display_name === "string" && model.display_name ? model.display_name : undefined
  let key: string
  let label: string
  if (group === "session") {
    key = "5h"
    label = "5h"
  } else if (group === "weekly") {
    key = scopeName ? `weekly-${slugify(scopeName)}` : "weekly"
    label = scopeName ? `${scopeName} wk` : "Weekly"
  } else if (group) {
    // An unfamiliar future cap must not be invisible — it may be the one that binds.
    key = slugify(group)
    label = scopeName ? `${scopeName} ${group}` : group
  } else {
    return undefined
  }
  const resetsAt = isoToUnix(l.resets_at ?? l.reset_at)
  return { key, label, usedPercent: percent, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Parse the endpoint's JSON body → a ProviderQuota. Total: never throws. Exported for a fixture test.
// The modern body carries the authoritative windows in `limits[]` (session + weekly entries, scoped
// weeklies naming their model); older bodies used top-level five_hour / seven_day / seven_day_<model>
// objects. Read `limits[]` first and fill any window the legacy keys still uniquely describe — the
// model-scoped weekly caps matter because they are frequently the BINDING limit, and omitting one
// would let the chip show a rosy general weekly % while the user is actually near that wall.
export function parseClaudeUsage(body: unknown, planType?: string): ProviderQuota {
  if (!body || typeof body !== "object") return { status: "unavailable", windows: [], detail: "Malformed usage response" }
  const b = body as Record<string, unknown>
  const windows: QuotaWindow[] = []
  const seen = new Set<string>()
  const add = (w: QuotaWindow | undefined) => {
    if (w && !seen.has(w.key)) {
      seen.add(w.key)
      windows.push(w)
    }
  }
  if (Array.isArray(b.limits)) for (const entry of b.limits) add(windowFromLimit(entry))
  add(toWindow(b.five_hour, "5h", "5h"))
  add(toWindow(b.seven_day, "weekly", "Weekly"))
  add(toWindow(b.seven_day_opus, "weekly-opus", "Opus wk"))
  add(toWindow(b.seven_day_sonnet, "weekly-sonnet", "Sonnet wk"))
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: "No usage windows reported" }
  return { status: "ok", planType, windows }
}

type UsageExec = (claudeBin: string) => Promise<string>

/** The endpoint refused with 429/529. `retryAt` (ms) is when it said another request may succeed. */
class UsageRateLimited extends Error {
  constructor(status: number, readonly retryAt: number) {
    super(`Usage endpoint ${status}`)
  }
}

function retryAtFrom(res: Response, now: number): number {
  const seconds = Number(res.headers.get("retry-after"))
  const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_DEFAULT_BACKOFF_MS
  return now + Math.min(backoff, RATE_LIMIT_MAX_BACKOFF_MS)
}

/** Claude Code's starts since the endpoint last accepted the token, and the instant (ms) before which
 *  nothing starts it again. See CLI_BACKOFF_BASE_MS. */
interface CliRuns {
  runs: number
  retryAt: number
}

// With no cache directory there is nowhere to record that Claude Code ran, so nothing could bound it.
const CLI_NEVER: CliRuns = { runs: 0, retryAt: Infinity }

/** Claude Code was started to refresh a rejected credential and reported no quota. `cli` is the
 *  record of that start, which the caller must persist whatever else it does with the failure. */
class ClaudeCodeRefreshFailed extends Error {
  constructor(readonly cli: CliRuns, cause: unknown) {
    super("Claude Code could not refresh the rejected credential", { cause })
  }
}

export interface ClaudeQuotaDeps {
  now?: () => number
  execUsage?: UsageExec
  cacheDir?: string
  fetchImpl?: typeof fetch
  readToken?: (configDir: string) => Promise<string | undefined>
}

interface SharedQuota {
  at: number
  quota: ProviderQuota
  /** Set by a 429: no caller touches the endpoint before this instant (ms). A success clears it. */
  retryAt?: number
  /** Set by every start of Claude Code. Carried through every failure; an endpoint success clears it. */
  cli?: CliRuns
}

function cachePaths(cacheDir: string, configDir: string) {
  const profile = createHash("sha256").update(configDir).digest("hex").slice(0, 12)
  return {
    data: join(cacheDir, `claude-${profile}.json`),
    lock: join(cacheDir, `claude-${profile}.lock`),
  }
}

async function readShared(path: string): Promise<SharedQuota | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SharedQuota
    if (!Number.isFinite(parsed.at) || !parsed.quota || !Array.isArray(parsed.quota.windows)) return undefined
    // A malformed record must read as "never ran", not as NaN arithmetic that no deadline ever beats.
    if (!Number.isFinite(parsed.cli?.runs) || !Number.isFinite(parsed.cli?.retryAt)) delete parsed.cli
    return parsed
  } catch {
    return undefined
  }
}

async function writeShared(path: string, value: SharedQuota): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error("Claude quota refresh lock timed out")
      await delay(LOCK_POLL_MS)
    }
  }
}

async function runClaudeUsage(claudeBin: string): Promise<string> {
  const { stdout } = await execFileAsync(
    // Never a bare name: on Windows `execFile("claude")` is ENOENT and `execFile("claude.cmd")` is
    // EINVAL (node refuses .cmd/.bat without a shell since CVE-2024-27980), so this reader could
    // never reach the CLI there and every quota refresh threw. See auth-status.ts for the measurement.
    // A resolver throw is a refresh failure like any other — the callers' stale-serving catch owns it.
    resolveClaudeExecutableAbsolute(claudeBin),
    ["-p", "/usage", "--safe-mode", "--output-format", "json", "--no-session-persistence", "--tools", ""],
    { encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
  )
  return String(stdout)
}

// One live refresh: the endpoint, and Claude Code only for a credential the endpoint rejected. Returns
// ONLY a healthy quota; every failure shape throws so the callers' stale-serving catch handles them
// uniformly. `cli` is the persisted record of Claude Code's last start, read under the refresh lock; a
// result or a ClaudeCodeRefreshFailed that carries one means it was started again, and the caller
// persists it.
//
// `endpoint: false` is the human's refresh button while the endpoint's 429 window stands (see
// readClaudeQuota): it skips the refusing endpoint and reads through Claude Code — a deliberate start the
// operator asked for, still only with a credential on the machine and still inside Claude Code's backoff.
async function refreshQuota(
  claudeBin: string,
  deps: ClaudeQuotaDeps,
  now: number,
  cli: CliRuns | undefined,
  { endpoint = true }: { endpoint?: boolean } = {},
): Promise<{ quota: ProviderQuota; cli?: CliRuns }> {
  const doFetch = deps.fetchImpl ?? fetch
  const readToken = deps.readToken ?? readAccessToken
  let token: string | undefined
  try {
    token = await readToken(claudeConfigDir())
  } catch {
    token = undefined
  }
  // Signed out. Claude Code reads these same two sources, so it has no quota to report either.
  if (!token) throw new Error("Not signed in to Claude")
  if (!endpoint) {
    // A rejected credential Claude Code has already failed to repair is not worth another start, even
    // on a click. The record rides through untouched: only the endpoint accepting the token resets it,
    // and this start is not a repair of a rejection, so it does not count toward the backoff either.
    if (cli && now < cli.retryAt) throw new Error("Claude credential rejected")
    frizzLog.warn("quota", "a manual quota refresh inside the usage endpoint's rate-limit window; starting Claude Code to read it")
    const quota = parseClaudeUsageOutput(await (deps.execUsage ?? runClaudeUsage)(claudeBin), now)
    if (quota.status !== "ok") throw new Error(quota.detail)
    return { quota, ...(cli ? { cli } : {}) }
  }
  let res: Response
  try {
    res = await doFetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    })
  } catch {
    throw new Error("Usage endpoint unreachable")
  }
  if (res.ok) {
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
    const quota = parseClaudeUsage(body, typeof body?.plan_type === "string" ? body.plan_type : undefined)
    if (quota.status !== "ok") throw new Error(quota.detail)
    return { quota }
  }
  // The endpoint asked us to back off: fail this refresh and let the cached reading ride.
  if (res.status === 429 || res.status === 529) throw new UsageRateLimited(res.status, retryAtFrom(res, now))
  if (res.status !== 401 && res.status !== 403) throw new Error(`Usage endpoint ${res.status}`)
  if (cli && now < cli.retryAt) throw new Error("Claude credential rejected")
  const runs = (cli?.runs ?? 0) + 1
  const started: CliRuns = { runs, retryAt: now + Math.min(CLI_BACKOFF_BASE_MS * 2 ** (runs - 1), CLI_BACKOFF_MAX_MS) }
  // The only place a quota read costs a process, and rare by construction — so it always says so.
  frizzLog.warn("quota", `the usage endpoint rejected the Claude credential (${res.status}); starting Claude Code to refresh it (start ${runs} since the endpoint last accepted one)`)
  try {
    const quota = parseClaudeUsageOutput(await (deps.execUsage ?? runClaudeUsage)(claudeBin), now)
    if (quota.status !== "ok") throw new Error(quota.detail)
    return { quota, cli: started }
  } catch (err) {
    throw new ClaudeCodeRefreshFailed(started, err)
  }
}

const LINE_WINDOWS: Array<[RegExp, string, string]> = [
  [/^Current session$/i, "5h", "5h"],
  [/^Current week \(all models\)$/i, "weekly", "Weekly"],
  [/^Current week \(Opus only\)$/i, "weekly-opus", "Opus wk"],
  [/^Current week \(Sonnet only\)$/i, "weekly-sonnet", "Sonnet wk"],
]

function windowIdentity(title: string): [string, string] | undefined {
  for (const [pattern, key, label] of LINE_WINDOWS) {
    if (pattern.test(title)) return [key, label]
  }
  const scoped = /^Current week \((.+)\)$/i.exec(title)
  if (!scoped) return undefined
  const name = scoped[1]!.replace(/\s+only$/i, "")
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return slug ? [`weekly-${slug}`, `${name} wk`] : undefined
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function parseResetLabel(label: string | undefined, now: number): number | undefined {
  if (!label) return undefined
  // Claude Code and Frizz run on the same machine, so its explicit IANA suffix names the local timezone
  // already in effect here. Remove only that redundant suffix; never reinterpret it as UTC.
  const text = label.replace(/\s+\([^)]+\)\s*$/, "").trim()
  // The live label shapes: "3pm", "Jul 23 at 3pm", "Jul 27 at 12:59am", optionally with a year.
  // Date.parse cannot handle the "<Mon> <D> at <clock>" form (and resolves a year-less "<Mon> <D>" to
  // 2001), so assemble these from local-time parts directly.
  const parts = /^(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?)?\s*(?:at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i.exec(text)
  const month = parts?.[1] ? MONTH_INDEX[parts[1].slice(0, 3).toLowerCase()] : undefined
  const hasClock = parts?.[6] !== undefined
  if (parts && (month !== undefined || hasClock) && (parts[1] === undefined || month !== undefined)) {
    const date = new Date(now)
    if (hasClock) {
      let hour = Number(parts[4]) % 12
      if (parts[6]!.toLowerCase() === "pm") hour += 12
      date.setHours(hour, Number(parts[5] ?? 0), 0, 0)
    } else {
      date.setHours(0, 0, 0, 0)
    }
    if (month !== undefined) {
      date.setMonth(month, Number(parts[2]))
      // A year-less date must resolve forward: a weekly reset labeled "Jan 2" in late December is next
      // year's Jan 2, not the one eleven+ months past.
      if (parts[3]) date.setFullYear(Number(parts[3]))
      else if (date.getTime() <= now) date.setFullYear(date.getFullYear() + 1)
    } else if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1)
    }
    return Math.round(date.getTime() / 1000)
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  const date = new Date(parsed)
  if (!/\b\d{4}\b/.test(text) && date.getTime() <= now) date.setFullYear(date.getFullYear() + 1)
  return Math.round(date.getTime() / 1000)
}

// Claude Code intentionally formats this output as a small line-oriented contract for non-interactive
// callers. Preserve its percentages and turn its local reset labels back into the unix instants Frizz's
// display and subscription-limit scheduler already consume.
export function parseClaudeUsageOutput(stdout: string, now = Date.now()): ProviderQuota {
  let text = stdout
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>
    if (typeof envelope.result === "string") text = envelope.result
  } catch {
    // Plain-text output is accepted too, which keeps this parser compatible with simple test doubles.
  }
  const windows: QuotaWindow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(Current (?:session|week \(.+?\))):\s*(\d+(?:\.\d+)?)%\s+used\b(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line)
    if (!match) continue
    const identity = windowIdentity(match[1]!)
    if (!identity) continue
    const resetsAt = parseResetLabel(match[3], now)
    windows.push({
      key: identity[0],
      label: identity[1],
      usedPercent: Number(match[2]),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    })
  }
  if (windows.length === 0) {
    return { status: "unavailable", windows: [], detail: "Claude Code did not report subscription quota" }
  }
  return { status: "ok", windows }
}

// One non-blocking lock attempt for a BACKGROUND refresh: if another process holds the lock, someone
// is already refreshing and this process's next poll will read their result — give up instantly
// instead of parking a waiter.
async function tryAcquireLock(path: string): Promise<(() => Promise<void>) | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined
      try {
        if (Date.now() - (await stat(path)).mtimeMs <= LOCK_STALE_MS) return undefined
        await rm(path, { recursive: true, force: true })
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const UNAVAILABLE = { status: "unavailable", windows: [], detail: "Claude Code usage unavailable" } satisfies ProviderQuota

function rateLimited(shared: SharedQuota | undefined, now: number): shared is SharedQuota & { retryAt: number } {
  return shared?.retryAt !== undefined && now < shared.retryAt
}

// What a caller gets INSTEAD of a request while the endpoint's refusal stands. This is not a failure —
// the reading is as fresh as the provider allows — so it says when the next one is due rather than
// "Could not refresh". House duration grammar (`3m`), minutes floored at 1 so it never reads `0m`.
function serveRateLimited(shared: SharedQuota & { retryAt: number }, now: number): ProviderQuota {
  if (shared.quota.status !== "ok" || now - shared.at >= STALE_MAX_AGE_MS) return UNAVAILABLE
  const minutes = (ms: number, round: (n: number) => number) => Math.max(1, round(ms / 60_000))
  return {
    ...shared.quota,
    detail: `Next refresh in ${minutes(shared.retryAt - now, Math.ceil)}m · last updated ${minutes(now - shared.at, Math.round)}m ago`,
  }
}

// In-process guard so overlapping polls from one server start at most one background refresh.
const backgroundRefreshes = new Map<string, Promise<void>>()

function refreshSharedInBackground(paths: { data: string; lock: string }, claudeBin: string, deps: ClaudeQuotaDeps, now: number): void {
  if (backgroundRefreshes.has(paths.data)) return
  const task = (async () => {
    if (rateLimited(await readShared(paths.data), now)) return
    const release = await tryAcquireLock(paths.lock)
    if (!release) return
    try {
      const refreshed = await refreshQuota(claudeBin, deps, now, (await readShared(paths.data))?.cli)
      await writeShared(paths.data, { at: now, ...refreshed })
    } catch (err) {
      // Keep the reading and its age; record only the deadline the failure set, so the next tick does
      // not ask the endpoint (or start Claude Code) again before it.
      const deadline =
        err instanceof UsageRateLimited ? { retryAt: err.retryAt } : err instanceof ClaudeCodeRefreshFailed ? { cli: err.cli } : undefined
      if (!deadline) throw err
      const current = await readShared(paths.data)
      await writeShared(paths.data, { ...(current ?? { at: now, quota: UNAVAILABLE }), ...deadline })
    } finally {
      await release().catch(() => {})
    }
  })().catch(() => {})
    .finally(() => backgroundRefreshes.delete(paths.data))
  backgroundRefreshes.set(paths.data, task)
}

/** Test seam: resolves once any in-flight background refreshes have settled. */
export async function claudeQuotaRefreshSettled(): Promise<void> {
  await Promise.all([...backgroundRefreshes.values()])
}

// Proactively refresh the shared quota cache on a fixed schedule, independent of whether any browser is
// polling. The freshness of the sidebar chip (and the scheduler's weekly-reset check) used to be a
// side effect of someone READING the cache: with a 3-minute stale-while-revalidate TTL and a 60s
// browser poll, the displayed reading could lag 3–4 minutes — long enough to blow past a limit during
// a fast fleet burn without the chip ever warning. A server-side heartbeat ticking this every 30s
// keeps the cache as warm as the endpoint allows: a tick is a no-op while the reading is inside its
// TTL or the endpoint's `retryAt` has not passed.
//
// It uses the SAME non-blocking background path a stale read kicks — one in-flight refresh per process,
// a cross-process lock so N Frizz processes make one request per window per account, and Claude Code
// started only for a rejected credential, inside its own backoff. It NEVER blocks the caller and
// swallows every failure (the last known-good reading rides until the next success). On a machine that
// is not signed in to Claude a tick is one credential lookup and nothing else.
export async function refreshClaudeQuotaInBackground(claudeBin = "claude", deps: ClaudeQuotaDeps = {}): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    return // No shared cache dir → nothing to warm; a lazy read still has its own no-cache fallback.
  }
  const paths = cachePaths(cacheDir, configDir)
  // The heartbeat ticks faster than the TTL so a refresh lands soon after the endpoint's `retryAt`
  // rather than up to a whole interval late; a reading still inside its TTL needs nothing.
  const current = await readShared(paths.data)
  if (current?.quota.status === "ok" && now - current.at < OK_TTL_MS) return
  refreshSharedInBackground(paths, claudeBin, deps, now)
}

// The healthy cache is shared under ~/.frizz so three project windows make one usage request, not
// three simultaneous requests to the same account. A failed refresh serves the last known-good
// reading (clearly labeled in the popover) for at most one day instead of erasing useful data.
//
// Ordinary (non-force) reads are STALE-WHILE-REVALIDATE: any known-good reading newer than a day is
// returned immediately and the refresh happens in the background. The poll must never block on the
// CLI + cross-process lock (~27s worst case) — responses that slow straddle dev-server restarts and
// leave the browser's fetch hung, which is exactly how the chip froze into an em dash. Only `force`
// (the popover's refresh button) waits for a live refresh.
export async function readClaudeQuota(
  claudeBin = "claude",
  deps: ClaudeQuotaDeps = {},
  options: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  const paths = cachePaths(cacheDir, configDir)
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    try {
      return (await refreshQuota(claudeBin, deps, now, CLI_NEVER)).quota
    } catch {
      return { status: "unavailable", windows: [], detail: "Claude usage unavailable" }
    }
  }
  const initial = await readShared(paths.data)
  if (!options.force && initial && now - initial.at < (initial.quota.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS)) {
    return initial.quota
  }
  if (!options.force && initial?.quota.status === "ok" && now - initial.at < STALE_MAX_AGE_MS) {
    refreshSharedInBackground(paths, claudeBin, deps, now)
    const ageMs = now - initial.at
    if (ageMs >= 10 * 60_000 && rateLimited(initial, now)) return serveRateLimited(initial, now)
    // Freshly-expired data is normal churn; only label the reading once it is meaningfully old.
    if (ageMs < 10 * 60_000) return initial.quota
    return { ...initial.quota, detail: `Refreshing · last updated ${Math.round(ageMs / 60_000)}m ago` }
  }

  // A FORCED recheck is the human pressing refresh, and inside the endpoint's refusal window it goes
  // through the `claude -p /usage` CLI instead of serving the cached reading. Measured 2026-10-02: with
  // the endpoint refusing for another 32m, the CLI answered in ~8s — and the reading it replaced was 89m
  // old and had missed a weekly reset (41% used cached, 0% live). The endpoint's deadline is KEPT
  // beside the fresh reading, so the heartbeat still leaves the endpoint alone until it passes; only a
  // manual recheck ever pays for a CLI process.
  let retryAt = rateLimited(initial, now) ? initial.retryAt : undefined
  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireLock(paths.lock)
    const afterLock = await readShared(paths.data)
    if (rateLimited(afterLock, now)) retryAt = afterLock.retryAt
    // Another Frizz process may have completed the requested refresh while this process waited.
    if (afterLock && afterLock.at !== initial?.at && now - afterLock.at < OK_TTL_MS) return afterLock.quota

    let refreshed: { quota: ProviderQuota; cli?: CliRuns }
    try {
      refreshed = await refreshQuota(claudeBin, deps, now, afterLock?.cli, { endpoint: retryAt === undefined })
    } catch (err) {
      if (!(err instanceof UsageRateLimited)) throw err
      retryAt = err.retryAt
      refreshed = await refreshQuota(claudeBin, deps, now, afterLock?.cli, { endpoint: false })
    }
    await writeShared(paths.data, { at: now, ...refreshed, ...(retryAt === undefined ? {} : { retryAt }) }).catch(() => {})
    return refreshed.quota
  } catch (err) {
    const fallback = await readShared(paths.data)
    if (retryAt !== undefined) {
      const refused = { ...(fallback ?? { at: now, quota: UNAVAILABLE }), retryAt }
      await writeShared(paths.data, refused).catch(() => {})
      return serveRateLimited(refused, now)
    }
    // Claude Code's backoff outlives every failure, this one's write included: only an endpoint
    // success clears it, or the next rejected read would start the CLI all over again.
    const cli = err instanceof ClaudeCodeRefreshFailed ? err.cli : fallback?.cli
    if (fallback?.quota.status === "ok" && now - fallback.at < STALE_MAX_AGE_MS) {
      if (err instanceof ClaudeCodeRefreshFailed) await writeShared(paths.data, { ...fallback, cli }).catch(() => {})
      return {
        ...fallback.quota,
        detail: `Could not refresh · last updated ${Math.max(1, Math.round((now - fallback.at) / 60_000))}m ago`,
      }
    }
    await writeShared(paths.data, { at: now, quota: UNAVAILABLE, ...(cli ? { cli } : {}) }).catch(() => {})
    return UNAVAILABLE
  } finally {
    await release?.().catch(() => {})
  }
}
