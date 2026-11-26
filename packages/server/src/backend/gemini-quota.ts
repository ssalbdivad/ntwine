import { execFile, spawn } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { ProviderQuota, QuotaWindow } from "@ntwine/shared"
import { findOnPathAsync } from "./acp-agents.ts"

// THE GEMINI QUOTA — the Antigravity CLI account's 5-hour and weekly limits, as `agy` itself reports them.
//
// The one source: `agy -p "/usage" --output-format json`. Print mode answers its read-only slash
// commands itself, without starting an agent turn, spending quota or leaving a conversation behind
// (agy 1.1.11 changelog). Verified live 2026-11-20 against agy 1.5.11 on a Google AI Ultra account:
// `num_turns: 0`, every usage counter 0, the conversations directory unchanged, ~3s wall. Under it agy
// calls Cloud Code's `v1internal:retrieveUserQuotaSummary`; nothing is cached on disk to read instead
// (the token lives in the OS keyring or `~/.gemini/antigravity-cli/antigravity-oauth-token`).
//
//   {"conversation_id":"","status":"SUCCESS","num_turns":0, …, "command":{"name":"usage","data":{
//     "groups":[
//       {"name":"Gemini Models","buckets":[
//         {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.8255,"reset_time":"2026-11-26T18:59:16Z"},
//         {"id":"gemini-5h","window":"5h","remaining_fraction":0.8947,"reset_time":"2026-11-21T01:47:56Z"}]},
//       {"name":"Claude and GPT models","buckets":[
//         {"id":"3p-weekly","window":"weekly","remaining_fraction":0.1232,"reset_time":"…"},
//         {"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"…"}]}]}}}
//
// The GEMINI group's windows are the chip's own (`5h` / `weekly`, the keys QuotaBar leads with); the
// other groups are separate budgets the same account spends when an Antigravity thread runs Claude or
// GPT-OSS, so they ride along in the popover under their group's name (`group`, "Claude/GPT").

const MIN_VERSION: readonly [number, number, number] = [1, 1, 11]

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

// "Claude and GPT models" → "Claude/GPT". The group names are agy's copy, not an enum, so this only
// shortens them; anything it does not recognise passes through.
function groupShortName(name: string): string {
  return name.replace(/\s+models?$/i, "").replace(/\s+and\s+/gi, "/").trim() || name
}

function isGeminiGroup(group: Record<string, unknown>): boolean {
  const name = typeof group.name === "string" ? group.name : ""
  const buckets = Array.isArray(group.buckets) ? group.buckets : []
  return /^gemini\b/i.test(name) || buckets.some((b) => typeof (b as Record<string, unknown>)?.id === "string" && ((b as Record<string, unknown>).id as string).startsWith("gemini-"))
}

/** Parse `agy -p /usage --output-format json` into a ProviderQuota. Pure; undefined if unusable. */
export function parseAntigravityUsage(payload: unknown): ProviderQuota | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const top = payload as Record<string, unknown>
  const command = top.command && typeof top.command === "object" ? (top.command as Record<string, unknown>) : undefined
  if (command?.name !== "usage") return undefined
  const data = command.data && typeof command.data === "object" ? (command.data as Record<string, unknown>) : undefined
  const groups = Array.isArray(data?.groups) ? (data!.groups as unknown[]) : []
  const gemini: QuotaWindow[] = []
  const others: QuotaWindow[] = []
  for (const raw of groups) {
    if (!raw || typeof raw !== "object") continue
    const group = raw as Record<string, unknown>
    const own = isGeminiGroup(group)
    const short = groupShortName(typeof group.name === "string" ? group.name : "Other")
    for (const b of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!b || typeof b !== "object") continue
      const bucket = b as Record<string, unknown>
      // A bucket agy shows as "Disabled" carries no fraction; it has nothing to draw.
      const remaining = num(bucket.remaining_fraction)
      if (remaining === undefined) continue
      const window = bucket.window === "5h" || bucket.window === "weekly" ? bucket.window : undefined
      if (!window) continue
      const resetMs = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN
      const usedPercent = Math.max(0, Math.min(100, (1 - remaining) * 100))
      const resetsAt = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : undefined
      if (own) {
        gemini.push({ key: window, label: window === "5h" ? "5h" : "Weekly", usedPercent, resetsAt })
      } else {
        const id = typeof bucket.id === "string" && bucket.id ? bucket.id : `${short}-${window}`
        others.push({ key: id, label: window === "5h" ? "5h" : "Weekly", usedPercent, resetsAt, group: short })
      }
    }
  }
  // 5h before weekly in each group, the order the Claude and Codex popovers read in.
  const order = (w: QuotaWindow) => (w.key.endsWith("5h") ? 0 : 1)
  const windows = [...gemini.sort((a, b) => order(a) - order(b)), ...others.sort((a, b) => order(a) - order(b))]
  if (gemini.length === 0) return undefined
  return { status: "ok", windows }
}

/** `1.5.11` → [1, 5, 11]; undefined when `agy --version` printed something else. */
export function parseAgyVersion(out: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

function atLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!
  }
  return true
}

// THE GUARD AGAINST SPENDING QUOTA TO READ IT. Before 1.1.11 print mode had slash-command expansion but
// no answer of its own for `/usage`, so on an older CLI the same argv could start a real agent turn.
// `agy --version` is ~50ms and answers without signing in, so it is asked once per binary.
const versionOk = new Map<string, Promise<boolean>>()
function agySupportsUsage(bin: string): Promise<boolean> {
  let held = versionOk.get(bin)
  if (!held) {
    held = new Promise<boolean>((resolve) => {
      execFile(bin, ["--version"], { timeout: 5_000, windowsHide: true, env: agyEnv() }, (err, stdout) => {
        const v = err ? undefined : parseAgyVersion(String(stdout))
        resolve(!!v && atLeast(v, MIN_VERSION))
      })
    })
    versionOk.set(bin, held)
  }
  return held
}

// THE GUARD AGAINST A SIGN-IN PAGE ON THE OPERATOR'S SCREEN. A signed-out `agy -p` does not fail: it
// starts Google's OAuth flow, runs `open <accounts.google.com URL>`, and waits 60s for the login. No
// flag or environment turns that off — measured 2026-11-20 on agy 1.5.11 under an empty HOME with a
// stub `open` first on PATH: the stub was called with the URL both bare and with
// AGY_CLI_NONINTERACTIVE_HEADLESS=1, and a new session (no controlling terminal) did not stop it either.
// (The first, unstubbed run of that measurement opened a real browser tab.) So two bounds, either of
// which alone would do:
//
//   • NO CREDENTIAL, NO PROCESS. agy keeps its sign-in in the OS keyring via go-keyring — service
//     "gemini", account "antigravity" — and falls back to `~/.gemini/antigravity-cli/antigravity-oauth-token`
//     when no keyring daemon is available (headless Linux / WSL2, verified 2026-11-26 on agy 1.5.15).
//     On macOS, `security find-generic-password` without -w reads only that the item exists (no secret,
//     no prompt, ~10ms, exit 44 when absent). On Linux, we check the token file first and fall back to
//     Secret Service's `SearchItems` over D-Bus (which returns item object paths without unlocking the
//     keyring or reading any secret). On Windows neither store nor browser guard is verified, so there
//     is no Gemini chip there.
//   • NO BROWSER TO OPEN. Every run puts a directory first on PATH whose `open`, `xdg-open` and `wslview`
//     refuse, so a credential that exists but no longer works (revoked, expired past refresh) still cannot
//     reach the screen. agy resolves `open` (macOS) and `xdg-open` (Linux/WSL2, measured 2026-11-26)
//     through PATH, which is how the stub measurements saw them.
const KEYCHAIN_SERVICE = "gemini"
const KEYCHAIN_ACCOUNT = "antigravity"

/** Whether agy's on-disk fallback OAuth token file holds a token (Linux/WSL2 without a keyring daemon). */
export async function hasAgyTokenFile(home = homedir()): Promise<boolean> {
  try {
    const raw = await readFile(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8")
    const doc = JSON.parse(raw) as Record<string, unknown> | null
    if (!doc || typeof doc !== "object") return false
    const tok = doc.token && typeof doc.token === "object" ? (doc.token as Record<string, unknown>) : doc
    return (typeof tok.refresh_token === "string" && tok.refresh_token.length > 0)
      || (typeof tok.access_token === "string" && tok.access_token.length > 0)
  } catch {
    return false
  }
}

/** Parse `gdbus call … org.freedesktop.Secret.Service.SearchItems` output (unlocked + locked item paths). */
export function parseSecretServiceSearch(stdout: string): boolean {
  return /'\/org\/freedesktop\/secrets\/[^']+'/.test(stdout)
}

function hasLinuxSecretServiceItem(): Promise<boolean> {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.secrets",
        "--object-path",
        "/org/freedesktop/secrets",
        "--method",
        "org.freedesktop.Secret.Service.SearchItems",
        `{"service": "${KEYCHAIN_SERVICE}", "username": "${KEYCHAIN_ACCOUNT}"}`,
      ],
      { timeout: 5_000 },
      (err, stdout) => resolve(!err && parseSecretServiceSearch(String(stdout))),
    )
  })
}

export async function hasAgySignIn(): Promise<boolean> {
  if (process.platform === "darwin") {
    if (await hasAgyTokenFile()) return true
    return new Promise((resolve) => {
      execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], { timeout: 5_000 }, (err) => resolve(!err))
    })
  }
  if (process.platform === "linux") {
    if (await hasAgyTokenFile()) return true
    return hasLinuxSecretServiceItem()
  }
  return false
}

let noBrowserDir: string | undefined
function noBrowserPath(): string {
  if (!noBrowserDir) {
    const dir = join(tmpdir(), "ntwine-agy-no-browser")
    mkdirSync(dir, { recursive: true })
    for (const name of ["open", "xdg-open", "wslview"]) {
      const file = join(dir, name)
      writeFileSync(file, "#!/bin/sh\nexit 1\n")
      chmodSync(file, 0o755)
    }
    noBrowserDir = dir
  }
  return noBrowserDir
}

// The poll must never update the CLI: the Homebrew cask's own wrapper sets this, a curl install does not.
function agyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }
  try {
    env.PATH = [noBrowserPath(), process.env.PATH ?? ""].filter(Boolean).join(delimiter)
  } catch {
    /* a read-only tmpdir: the credential check above still stands */
  }
  return env
}

/** Set once a `/usage` read comes back having run an agent turn; the reader then never runs again. */
let turnSpent = false

// One short-lived `agy -p /usage`. Bounded by `timeoutMs` and total — resolves undefined on a missing
// binary, a CLI waiting on a sign-in, an API-key sign-in (exit 2, it has no account quota), a protocol
// change or a hang. A healthy read takes ~3s, so 15s is a hang. `detached` makes the child a process
// group of its own, so the timeout takes down the language server agy starts along with it.
export function queryAntigravityUsage(bin: string, timeoutMs = 15_000): Promise<ProviderQuota | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ["-p", "/usage", "--output-format", "json"], {
        cwd: tmpdir(),
        stdio: ["ignore", "pipe", "ignore"],
        env: agyEnv(),
        detached: process.platform !== "win32",
        windowsHide: true,
      })
    } catch {
      resolve(undefined)
      return
    }
    let settled = false
    let out = ""
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
    const finish = (quota: ProviderQuota | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(quota)
    }
    const timer = setTimeout(() => {
      kill()
      finish(undefined)
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8")
      if (out.length > 1024 * 1024) {
        kill()
        finish(undefined)
      }
    })
    child.on("error", () => finish(undefined))
    child.on("close", (code) => {
      if (code !== 0) return finish(undefined)
      let payload: unknown
      try {
        payload = JSON.parse(out.trim())
      } catch {
        return finish(undefined)
      }
      const turns = num((payload as Record<string, unknown> | null)?.num_turns)
      if (turns !== undefined && turns > 0) {
        turnSpent = true
        return finish(undefined)
      }
      finish(parseAntigravityUsage(payload))
    })
  })
}

// HOW OFTEN THAT PROCESS MAY START — the same four bounds as Codex's live read (codex-quota.ts), for the
// same reasons: no CLI, no process; a good reading lasts TTL_MS; a failed read backs off 1m doubling to
// 30m (a signed-out or API-key CLI fails identically every time); concurrent callers share one read.
// One more: a reading past its TTL is SERVED while the next is fetched (stale-while-revalidate), because
// agy takes ~3s to answer and the status row's poll waits on every provider at once — without it the
// chip's whole quota read stalled on Gemini once a minute.
const TTL_MS = 60_000
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000

interface GeminiQuotaState {
  memo?: { at: number; quota: ProviderQuota }
  inFlight?: Promise<ProviderQuota>
  failures: number
  retryAt: number
}
const state: GeminiQuotaState = { failures: 0, retryAt: 0 }

/** Test seam: forget every reading, backoff and version verdict. */
export function resetGeminiQuotaMemo(): void {
  state.memo = undefined
  state.inFlight = undefined
  state.failures = 0
  state.retryAt = 0
  turnSpent = false
  versionOk.clear()
}

export interface GeminiQuotaOptions {
  force?: boolean
  now?: () => number
  /** The `agy` to run; PATH's when absent. */
  bin?: string
  /** Test seam for the live read. */
  query?: (bin: string) => Promise<ProviderQuota | undefined>
  /** Test seam for the version gate. */
  supports?: (bin: string) => Promise<boolean>
  /** Test seam for the sign-in check. */
  signedIn?: () => Promise<boolean>
}

/**
 * The Gemini provider quota (RPC-facing), or undefined when `agy` is not installed — a machine with no
 * Antigravity CLI has no Gemini chip to draw, which is different from one whose read failed. Never throws.
 */
export async function readGeminiQuota(options: GeminiQuotaOptions = {}): Promise<ProviderQuota | undefined> {
  // Only macOS and Linux have verified sign-in checks and browser-open guards; elsewhere there is no chip.
  if (process.platform !== "darwin" && process.platform !== "linux" && !options.signedIn) return undefined
  const bin = options.bin ?? (await findOnPathAsync("agy"))
  if (!bin) return undefined
  const now = (options.now ?? Date.now)()
  const fresh = state.memo && now - state.memo.at < TTL_MS
  if (!options.force && fresh) return state.memo!.quota
  if (!state.inFlight) {
    state.inFlight = refresh(bin, now, options).finally(() => {
      state.inFlight = undefined
    })
  }
  // A stale reading answers now; the refresh lands for the next poll. Forced and first reads wait.
  if (!options.force && state.memo) return state.memo.quota
  return state.inFlight
}

async function refresh(bin: string, now: number, options: GeminiQuotaOptions): Promise<ProviderQuota> {
  let quota: ProviderQuota | undefined
  let detail = "Gemini usage unavailable"
  if (turnSpent) {
    detail = "This Antigravity CLI cannot report usage without starting a turn"
  } else if (!(await (options.signedIn ?? hasAgySignIn)())) {
    // Signed out is no reading, not a failure: nothing to back off from, and nothing to show.
    state.memo = undefined
    return { status: "unavailable", windows: [], detail: "Not signed in to Antigravity" }
  } else if (!(await (options.supports ?? agySupportsUsage)(bin))) {
    detail = "Update Antigravity CLI to see Gemini usage"
  } else if (options.force || now >= state.retryAt) {
    try {
      quota = await (options.query ?? queryAntigravityUsage)(bin)
    } catch {
      quota = undefined
    }
    if (quota) {
      state.failures = 0
      state.retryAt = 0
    } else {
      state.failures++
      state.retryAt = now + Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS)
    }
  } else if (state.memo) {
    // Backing off: keep what we had rather than replacing it with a failure we did not re-ask.
    return state.memo.quota
  }
  const result = quota ?? { status: "unavailable" as const, windows: [], detail }
  state.memo = { at: now, quota: result }
  return result
}
