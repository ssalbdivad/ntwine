import type { QuotaSnapshot, ProviderQuota } from "@frizz/shared"
import { readCodexQuota } from "./backend/codex-quota.ts"
import { readClaudeQuota } from "./backend/claude-quota.ts"
import { log as frizzLog } from "./logging.ts"

// The polled provider-quota snapshot the sidebar status bar renders. Codex comes from the app-server's
// live `account/rateLimits/read` (the rollout JSONL frizz tails is only its offline fallback, since a
// rollout cannot say which account wrote it). Claude reads the OAuth usage endpoint with the
// credential already on the machine, and starts Claude Code only to refresh a token that endpoint
// rejected — never for a machine that is signed out or offline (claude-quota.ts has the bound).
//
// FIXTURE SEAM: set FRIZZ_QUOTA_FIXTURE to one of the named states below to return deterministic data
// instead of touching the live sources. This lets the UI be exercised (and screenshotted) across all
// visual states without invoking a real provider CLI or reading real credentials.

async function fixture(name: string): Promise<QuotaSnapshot | undefined> {
  const hour = 3600
  const now = Math.floor(Date.now() / 1000)
  const claudeOk: ProviderQuota = {
    status: "ok",
    planType: "max",
    windows: [
      { key: "5h", label: "5h", usedPercent: 34, resetsAt: now + 2 * hour + 900 },
      { key: "weekly", label: "Weekly", usedPercent: 61, resetsAt: now + 3 * 24 * hour },
    ],
  }
  const codexOk: ProviderQuota = {
    status: "ok",
    planType: "pro",
    windows: [
      { key: "5h", label: "5h", usedPercent: 12, resetsAt: now + 4 * hour },
      { key: "weekly", label: "Weekly", usedPercent: 47, resetsAt: now + 5 * 24 * hour },
    ],
  }
  switch (name) {
    case "ok":
      return { claude: claudeOk, codex: codexOk }
    case "near-limit":
      return {
        claude: { ...claudeOk, windows: [
          { key: "5h", label: "5h", usedPercent: 92, resetsAt: now + 40 * 60 },
          { key: "weekly", label: "Weekly", usedPercent: 78, resetsAt: now + 2 * 24 * hour },
        ] },
        codex: { ...codexOk, windows: [
          { key: "5h", label: "5h", usedPercent: 99, resetsAt: now + 12 * 60 },
          { key: "weekly", label: "Weekly", usedPercent: 88, resetsAt: now + 6 * 24 * hour },
        ] },
      }
    case "fable-fallback":
      // The base 5h window nearly out while Fable's own weekly has room — the state the `fableFallback`
      // setting acts on (backend/fable-fallback.ts).
      return {
        claude: { ...claudeOk, windows: [
          { key: "5h", label: "5h", usedPercent: 94, resetsAt: now + 50 * 60 },
          { key: "weekly", label: "Weekly", usedPercent: 71, resetsAt: now + 2 * 24 * hour },
          { key: "weekly-fable", label: "Fable wk", usedPercent: 22, resetsAt: now + 4 * 24 * hour },
        ] },
        codex: codexOk,
      }
    case "claude-unavailable":
      return { claude: { status: "unavailable", windows: [], detail: "Not logged in to Claude" }, codex: codexOk }
    case "claude-endpoint-down":
      // The authed-but-provider-failing case (the user-reported "Usage endpoint unreachable"): the chip
      // is signed in yet has no window data, so the popover shows the failure detail + the recheck spinner.
      return { claude: { status: "unavailable", windows: [], detail: "Usage endpoint unreachable" }, codex: codexOk }
    case "codex-real":
      // REAL Codex quota (live app-server read, rollout tail as fallback), with Claude stubbed
      // unavailable so QA never invokes the user's Claude CLI. Proves the Codex path end-to-end in the UI.
      return { claude: { status: "unavailable", windows: [], detail: "Live call disabled for QA" }, codex: await readCodexQuota() }
    default:
      return undefined
  }
}

// `codexBin` must be the runtime Frizz dispatches with, never a bare `codex`: each live read starts a
// `codex app-server`, which refreshes the machine-wide ~/.codex/models_cache.json with ITS OWN version's
// catalogue. An older CLI on PATH, polled every ~20s, overwrote the pinned runtime's catalogue and made
// newer models (gpt-6-sol, gpt-6.1-sol) flicker out of the model picker.
export async function readQuota(opts: { claudeBin?: string; codexBin?: string; force?: boolean } = {}): Promise<QuotaSnapshot> {
  // The fixture seam is a DEV/QA affordance only — never honor it in a production build, so an env var
  // leaking into a real deploy can't silently paint fabricated quota numbers.
  const fx = process.env.FRIZZ_QUOTA_FIXTURE
  if (fx && process.env.NODE_ENV !== "production") {
    const snap = await fixture(fx)
    if (snap) {
      frizzLog.warn("quota", `serving FIXTURE "${fx}" (FRIZZ_QUOTA_FIXTURE set; dev-only seam)`)
      return snap
    }
  }
  const [claude, codex] = await Promise.all([
    readClaudeQuota(opts.claudeBin, {}, { force: opts.force }),
    readCodexQuota(undefined, opts.codexBin),
  ])
  return { claude, codex }
}
