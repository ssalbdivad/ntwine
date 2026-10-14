import { execFile } from "node:child_process"
import { promisify } from "node:util"

// gh-CLI wrapper. Design principles (matching project.ts / open-external.ts): every call is
// execFile with an ARGS ARRAY, NEVER a shell string, so a repo/number can never be reinterpreted
// as a command (no injection surface); the repo string comes from trusted detection and `number`
// is a validated positive integer; every gh call gets a hard TIMEOUT (keyring/network can stall);
// and DETECTION failures degrade gracefully (return false/null — never throw into a board build /
// boot).

const pexec = promisify(execFile)
const GH_TIMEOUT = 8000 // ms — every gh call (and the local git probe); a slow keyring/network must never wedge an RPC or boot
const GH_MAXBUF = 16 * 1024 * 1024 // 16MB — a wide `--json` list can be large

// Run gh with an args array (no shell) and return stdout. Throws on non-zero exit / timeout — the
// caller decides whether to degrade or surface it.
async function gh(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await pexec("gh", args, { timeout: GH_TIMEOUT, maxBuffer: GH_MAXBUF, cwd: opts.cwd })
  return stdout
}

// --- Detection (cached at boot; see context.ts) ---

// `gh --version` exit 0 → the binary is on PATH.
export async function ghInstalled(): Promise<boolean> {
  try {
    await gh(["--version"])
    return true
  } catch {
    return false
  }
}

// `gh auth status --active` exit 0 → signed in.
//
// It is NOT cheap, which this comment claimed until it was timed: `auth status` validates the token
// against api.github.com, so it is a network round trip — measured 345-394ms on a warm connection,
// 2026-09-04. githubStatus runs on every page load, where it was the single longest request of the
// load. So the POSITIVE answer is cached for GH_AUTHED_TTL_MS below.
//
// Its FAILURE, though, is NOT a reliable "signed out", so it is never trusted on its own. Two ways a
// genuinely signed-in user lands in the catch:
//  • `auth status` VALIDATES the token against the API, so any network trouble — offline, VPN, proxy,
//    rate limit, a GitHub outage — exits 1, and gh even blames the credential ("The token in keyring
//    is invalid"). Measured against a dead proxy 2026-08-04.
//  • `--active` only exists in gh ≥ 2.57.0 (checked against pkg/cmd/auth/status/status.go at v2.40 …
//    v2.57). An older distro-packaged gh — apt still ships 2.4.x — exits 1 with "unknown flag".
// Both hide the whole GitHub feature with no explanation anywhere in the UI, which is the worst
// outcome available. So a failure falls back to `gh auth token` (gh ≥ 2.17): purely LOCAL, no network,
// no version-new flag, and holding a credential is the question this gate is really asking. The cost
// of the false positive is small and self-explaining — a revoked token reads as signed in, and the
// first gh call that needs it surfaces gh's own error.
// Only the TRUE answer is cached, and that asymmetry is the whole design. Caching a false would make
// a mid-session `gh auth login` take up to a TTL to show up, which is the one thing the live re-check
// existed to guarantee; caching the true costs nothing anybody can observe, because a token revoked
// inside the window still surfaces gh's own error the moment a gh call needs it (see above). So a
// signed-in operator — the overwhelmingly common case — pays the round trip once per window, and an
// operator who is signing in right now still sees it on their very next query.
const GH_AUTHED_TTL_MS = 30_000
let ghAuthedUntil = 0
// One probe at a time. githubStatus is fired by every mounting tab, and without this a page load with
// three of them spawns three `gh` processes that all wait on the same network round trip.
let ghAuthedInFlight: Promise<boolean> | null = null

export async function ghAuthed(): Promise<boolean> {
  if (Date.now() < ghAuthedUntil) return true
  if (ghAuthedInFlight) return await ghAuthedInFlight
  const probe = (async () => {
    const authed = await (async () => {
      try {
        await gh(["auth", "status", "--active"])
        return true
      } catch {
        return await ghHasToken()
      }
    })()
    // Cache EITHER route to true, including the token fallback. The offline/VPN case is the slowest
    // one there is — `auth status` burns its way to GH_TIMEOUT before the fallback even starts — and
    // it is also the case where the answer is least likely to change.
    if (authed) ghAuthedUntil = Date.now() + GH_AUTHED_TTL_MS
    return authed
  })()
  ghAuthedInFlight = probe
  try {
    return await probe
  } finally {
    ghAuthedInFlight = null
  }
}

/** Drop the cached positive — for tests, and for anything that knows the credential just changed. */
export function resetGhAuthedCache(): void {
  ghAuthedUntil = 0
  ghAuthedInFlight = null
}

// Does gh hold a credential for the active host? stdout here is the TOKEN ITSELF — only its emptiness
// is ever read; never log it, never fold it into an error message.
async function ghHasToken(): Promise<boolean> {
  try {
    return (await gh(["auth", "token"])).trim().length > 0
  } catch {
    return false
  }
}

// The authoritative GitHub signal: `gh repo view` in `dir` succeeds ONLY for a gh-resolvable GitHub
// repo (a gitlab/bitbucket origin fails → null). Uses the dir's own git remote (no -R), so it must
// run with cwd=dir. Returns "owner/repo" or null. Never throws.
export async function ghRepo(dir: string): Promise<string | null> {
  try {
    const out = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: dir })
    const s = out.trim()
    return s || null
  } catch {
    return null
  }
}

// The purely LOCAL answer to "is this a GitHub repo", read off the git remote — no network, no gh.
//
// It exists because `gh repo view` is a GraphQL call to api.github.com, so a network blip answers
// "this is not a GitHub repo" for a repo that plainly is, and the trigger's `inRepo && authed` gate
// then hides the whole feature with no explanation. That is the same false negative ghAuthed's
// `gh auth token` fallback was added to kill (2026-08-04) — the auth half got a local fallback and
// the repo half did not, so a GitHub outage still hid the icon. Measured 2026-08-11 against a dead
// proxy: `gh --version` 0, `gh auth token` 0, `gh auth status --active` 1, `gh repo view` 1. The
// server log had named the same window nine minutes earlier ("GitHub GraphQL request failed").
//
// Deliberately narrower than gh: only `origin`, only github.com. gh resolves forks/`gh-resolved`/
// multiple remotes and can name a different repo than origin — so this answer is used to KEEP THE
// DOOR OPEN during an outage, never cached (see resolveRepo in router.ts), and the next query
// re-probes gh and self-corrects. A GHE host is not github.com, so it reads null exactly as today.
export async function gitGithubRemote(dir: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["remote", "get-url", "origin"], { timeout: GH_TIMEOUT, cwd: dir })
    return githubRemoteNameWithOwner(stdout)
  } catch {
    return null
  }
}

// "owner/repo" for a github.com remote URL, else null. Pure, so the host-spoof cases are unit-tested:
// `github.com.evil.com` and `evil.com/github.com/o/r` are NOT github.com and must not open the door.
export function githubRemoteNameWithOwner(remoteUrl: string): string | null {
  const url = remoteUrl.trim()
  if (!url) return null
  let host: string
  let path: string
  if (url.includes("://")) {
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  } else {
    // scp-like: [user@]host:owner/repo — git's other remote spelling, and the one `git@github.com:`
    // uses, which `new URL()` does not accept.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  if (host.toLowerCase() !== "github.com") return null
  const segments = path.replace(/\.git$/, "").split("/").filter((s) => s.length > 0)
  if (segments.length !== 2) return null
  const [owner, repo] = segments
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null
  return `${owner}/${repo}`
}

// The stable (process-lifetime) detection triple, resolved once at boot and cached on ctx.github.
export interface GithubDetection {
  installed: boolean
  inRepo: boolean
  nameWithOwner: string | null
}

// Resolve installed + inRepo/nameWithOwner. Never throws (each probe swallows its own failure), so
// it is safe to call at boot without wedging startup on a broken/absent gh. NOTE: `gh repo view`
// needs auth, so a boot done while signed out caches inRepo:false — the router does NOT trust a
// cached-negative inRepo and re-resolves live (see resolveRepo in router.ts) so a post-boot
// `gh auth login` lights up the feature without a restart. A POSITIVE result is stable.
export async function detectGithub(dir: string): Promise<GithubDetection> {
  const installed = await ghInstalled()
  if (!installed) return { installed: false, inRepo: false, nameWithOwner: null }
  const nameWithOwner = await ghRepo(dir)
  return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner }
}

// The full status is composed in the router (githubStatus handler), which owns the ctx.github cache
// and warms it via resolveRepo — `authed` is re-checked live there so a mid-session sign-in reflects.
