#!/usr/bin/env node
// Is either bundled runtime behind its vendor's latest release?
//
//   nub scripts/check-runtime-pins.mjs            a human-readable verdict
//   nub scripts/check-runtime-pins.mjs --json     the same thing for a script to read
//
// Ntwine pins ONE Claude Code and ONE Codex (packages/server/src/runtimes.ts) and provisions that exact
// binary from the vendor's own npm package. A stale pin is not a conservative one — it is a broken
// worker: the first provisioned Claude Code refused the default model outright because a model's
// minimum CLI is enforced server-side, and the 0.146 Codex pin could never offer gpt-6-astra because
// the catalogue server omits a model from clients below its `minimal_client_version`. So the pin has
// to be WATCHED, and this is the instrument that watches it.
//
// It reads the pins from the source of truth rather than a copy, asks the registry what the vendors
// have published, and — the part that is easy to forget — checks that the PLATFORM packages for that
// latest version are actually published too. The version tag and the per-platform tarballs do not
// land at the same instant, and provisioning fetches the platform package: bumping to a version whose
// tarball is not there yet breaks every machine that boots before it appears.
//
// THE AGE FLOOR NO LONGER GATES A BUMP, and the reason is arithmetic rather than appetite. `nub`
// refuses any version under 24 hours old (`minimumReleaseAge=1440`, its own default), and this check
// used to treat that as an eligibility test: behind, but hold until the release is a day old. On a
// dependency you did not choose today that is exactly right. On these two it never converges —
// Anthropic shipped 0.3.263 through 0.3.267 in two days, so every candidate was superseded BEFORE it
// cleared the floor, and the pin was not one day behind but permanently behind (maintainer, 2026-09-09:
// "I think we should ship these things as quickly as possible").
//
// It bought no safety the bump procedure does not already provide, either. Every pin move is verified
// against the real binary — the wire contract against the app-server's own generated schema, and the
// transcript format by folding a real session through the production parser — which is a stronger check
// on a first-party runtime than waiting to see whether anyone else complains first.
//
// So the age is REPORTED and never blocks. The gate stays on for the rest of the tree; the install a
// runtime bump performs passes `--minimum-release-age-exclude "@anthropic-ai/*"` to step around it for
// these packages only. Codex was never gated at all — Ntwine's own provisioner fetches it, not the
// package manager.
//
// EXIT CODES, so a caller can branch without parsing prose:
//   0   both pins are current
//   10  at least one pin is behind (`behind` in the JSON says which; `eligible` says which may move now)
//   1   the check itself failed (network, registry, a shape that moved)

import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, CODEX_VERSION } from "../packages/server/src/runtimes.ts"

const REGISTRY = process.env.NTWINE_NPM_REGISTRY ?? "https://registry.npmjs.org"
const json = process.argv.includes("--json")

/** The platform coordinates provisioning would fetch. Mirrors runtimeCoordinates(), which is not
 *  reusable here: it answers for THIS machine, and a pin has to be publishable for all of them. */
const CLAUDE_PLATFORMS = [
  "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl",
  "win32-x64", "win32-arm64",
]
const CODEX_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]

async function registry(path) {
  const response = await fetch(`${REGISTRY}/${path}`)
  if (!response.ok) throw new Error(`registry answered ${response.status} for ${path}`)
  return response.json()
}

/** Does this exact package@version exist? A HEAD-shaped existence probe, not a download. */
async function published(pkg, version) {
  const response = await fetch(`${REGISTRY}/${pkg.replace("/", "%2F")}/${version}`, { method: "GET" })
  return response.ok
}

/** The window the REPORT annotates against, so a reader knows when the install needs the exclude flag.
 *  Mirrors nub's `minimumReleaseAge` default; it is not a gate here — see the age note above. */
const AGE_FLOOR_MS = 24 * 60 * 60 * 1000

/** When npm first served this version, or undefined if the registry will not say.
 *  The publish time lives only in the FULL packument, so this is fetched lazily — only for a package
 *  that is actually behind — and a failure degrades to "age unknown" rather than failing the check.
 *
 *  BOTH backends read it from here, including Codex, whose packument is 13 MB because every platform
 *  build is another version of the same package. That size was why this first asked GitHub for the
 *  matching `rust-v<version>` release instead — which was wrong twice over. The unauthenticated API is
 *  rate-limited per IP and rejects a caller it does not like, so the lookup failed INTERMITTENTLY, and
 *  since an unknown age reads as not-eligible the check answered "hold, the registry would not say"
 *  for a release that was simply four hours short (observed 2026-09-05). A daily check that silently
 *  degrades to a permanent hold is worse than a slow one. The npm time is also the RIGHT clock: the
 *  floor is enforced by the installer against the npm publish, which trails the GitHub release by
 *  minutes. Measured cost of the honest source: 0.75 s. */
async function npmPublishedAt(pkg, version) {
  try {
    const doc = await registry(pkg.replace("/", "%2F"))
    const at = doc.time?.[version]
    return typeof at === "string" ? Date.parse(at) : undefined
  } catch {
    return undefined
  }
}

/** How old a release is, for the report. `belowFloor` is context a reader may want — it is NOT a
 *  verdict, and nothing branches on it: see the age note at the top for why the floor stopped gating. */
function ageVerdict(publishedAt) {
  if (publishedAt === undefined) return { ageHours: undefined, belowFloor: false }
  const age = Date.now() - publishedAt
  return { ageHours: Math.floor(age / 3_600_000), belowFloor: age < AGE_FLOOR_MS }
}

/** Numeric semver compare. An unparseable version sorts BELOW everything, so it never reads as newer. */
function compare(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? "")
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

async function claudeLine() {
  // The SDK is the pin; the Claude Code build is whatever that SDK names in its own manifest. They
  // move together and neither is chooseable on its own — see runtimes.ts.
  const latest = await registry("@anthropic-ai%2Fclaude-agent-sdk/latest")
  const sdk = latest.version
  const cli = latest.claudeCodeVersion
  if (typeof sdk !== "string" || typeof cli !== "string") {
    throw new Error("@anthropic-ai/claude-agent-sdk's manifest no longer carries version + claudeCodeVersion")
  }
  const behind = compare(CLAUDE_AGENT_SDK_VERSION, sdk) < 0
  const [missing, age] = behind
    ? await Promise.all([
        Promise.all(CLAUDE_PLATFORMS.map(async (p) => (await published(`@anthropic-ai/claude-agent-sdk-${p}`, sdk)) ? null : p)).then((r) => r.filter(Boolean)),
        npmPublishedAt("@anthropic-ai/claude-agent-sdk", sdk).then(ageVerdict),
      ])
    : [[], ageVerdict(undefined)]
  return {
    backend: "claude",
    pinned: `${CLAUDE_AGENT_SDK_VERSION} (Claude Code ${CLAUDE_CODE_VERSION})`,
    latest: `${sdk} (Claude Code ${cli})`,
    pinnedSdk: CLAUDE_AGENT_SDK_VERSION,
    latestSdk: sdk,
    latestClaudeCode: cli,
    behind,
    unpublishedPlatforms: missing,
    ...age,
  }
}

async function codexLine() {
  const latest = await registry("@openai%2Fcodex/latest")
  const version = latest.version
  if (typeof version !== "string") throw new Error("@openai/codex's manifest no longer carries a version")
  const behind = compare(CODEX_VERSION, version) < 0
  // Codex publishes each platform as a VERSION SUFFIX of the same package, not a separate package.
  const [missing, age] = behind
    ? await Promise.all([
        Promise.all(CODEX_PLATFORMS.map(async (p) => (await published("@openai/codex", `${version}-${p}`)) ? null : p)).then((r) => r.filter(Boolean)),
        npmPublishedAt("@openai/codex", version).then(ageVerdict),
      ])
    : [[], ageVerdict(undefined)]
  return {
    backend: "codex",
    pinned: CODEX_VERSION,
    latest: version,
    pinnedSdk: CODEX_VERSION,
    latestSdk: version,
    behind,
    unpublishedPlatforms: missing,
    ...age,
  }
}

let lines
try {
  lines = await Promise.all([claudeLine(), codexLine()])
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  else console.error(`✖ could not check the runtime pins: ${message}`)
  process.exit(1)
}

const behind = lines.filter((line) => line.behind)
// A pin may move when it is behind AND every platform tarball it would provision is published. The age
// is not one of the conditions any more; the one thing that still genuinely blocks a bump is a version
// whose per-platform tarballs have not landed yet, because provisioning fetches those and a machine
// that boots before they appear gets nothing.
const eligible = behind.filter((line) => line.unpublishedPlatforms.length === 0)

if (json) {
  console.log(JSON.stringify({
    ok: true,
    behind: behind.map((l) => l.backend),
    eligible: eligible.map((l) => l.backend),
    runtimes: lines,
  }, null, 2))
} else {
  for (const line of lines) {
    console.log(`${line.behind ? "→" : "✓"} ${line.backend.padEnd(6)} pinned ${line.pinned}`)
    console.log(`  ${" ".repeat(7)}latest ${line.latest}`)
    if (!line.behind) continue
    if (line.unpublishedPlatforms.length > 0) {
      console.log(`  ⚠ NOT YET PUBLISHED for ${line.unpublishedPlatforms.join(", ")} — provisioning would fail there; wait for the tarballs`)
    }
    const age = line.ageHours === undefined ? "age unknown" : `released ${line.ageHours}h ago`
    if (line.unpublishedPlatforms.length > 0) console.log(`  HOLD — ${age}, but not every platform is published yet`)
    else console.log(`  ready to bump (${age}${line.belowFloor ? ", inside the 24h age gate — the install excludes it" : ""})`)
  }
  if (behind.length === 0) console.log("\nboth pins are current.")
  else if (eligible.length === 0) console.log(`\n${behind.map((l) => l.backend).join(" and ")} behind, but waiting on platform tarballs — re-check shortly.`)
  else console.log(`\nbump now: ${eligible.map((l) => l.backend).join(", ")} — see plans/runtime-pin-bumps.md for what each bump requires.`)
}

process.exit(behind.length > 0 ? 10 : 0)
