import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ghAuthed,
  resetGhAuthedCache,
  gitGithubRemote,
  githubRemoteNameWithOwner,
} from "./github.ts"

// ---- ghAuthed (shelled out through a stub `gh` on PATH) ----
//
// This gate decides whether the whole GitHub feature is visible, and its historic failure mode was a
// FALSE NEGATIVE that hid everything with no explanation. So it is exercised against a real execFile
// against a real (stubbed) binary rather than a mock: the seam under test IS the subprocess.

// Write a `gh` stub whose behavior per subcommand is driven by GH_STUB_MODE, prepend it to PATH, run
// the probe, restore PATH. POSIX-only (a shell script isn't executable via execFile on Windows).
const stubScript = `#!/bin/sh
case "$GH_STUB_MODE:$1 $2" in
  *":auth status")
    case "$GH_STUB_MODE" in
      status-ok) exit 0 ;;
      old-gh) echo "unknown flag: --active" >&2; exit 1 ;;
      *) echo "not logged in" >&2; exit 1 ;;
    esac ;;
  *":auth token")
    case "$GH_STUB_MODE" in
      old-gh|offline) echo "gho_stubtoken"; exit 0 ;;
      blank-token) echo "   "; exit 0 ;;
      *) echo "no oauth token" >&2; exit 1 ;;
    esac ;;
esac
exit 1
`

async function withStubGh<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gh-stub-"))
  writeFileSync(join(dir, "gh"), stubScript, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ""}`
  process.env.GH_STUB_MODE = mode
  // ghAuthed caches its positive answer process-wide, so without this every scenario after the first
  // signed-in one would read that cache instead of this stub and pass for the wrong reason.
  resetGhAuthedCache()
  try {
    return await run()
  } finally {
    resetGhAuthedCache()
    process.env.PATH = path
    delete process.env.GH_STUB_MODE
    rmSync(dir, { recursive: true, force: true })
  }
}

// The same stub, but it neither clears the cache on the way in nor on the way out — the two caching
// tests below are precisely about what SURVIVES a call, so they cannot use the isolating variant.
async function withStubGhLeavingCache<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gh-stub-"))
  writeFileSync(join(dir, "gh"), stubScript, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ""}`
  process.env.GH_STUB_MODE = mode
  try {
    return await run()
  } finally {
    process.env.PATH = path
    delete process.env.GH_STUB_MODE
    rmSync(dir, { recursive: true, force: true })
  }
}

const posixOnly = { skip: process.platform === "win32" ? "the stub is a POSIX shell script" : false }

test("ghAuthed: `gh auth status --active` exit 0 → signed in", posixOnly, async () => {
  assert.equal(await withStubGh("status-ok", ghAuthed), true)
})

test("ghAuthed: an older gh with no --active flag still reads as signed in (falls back to `gh auth token`)", posixOnly, async () => {
  // --active landed in gh 2.57.0; apt still ships 2.4.x. The credential is right there in the keyring.
  assert.equal(await withStubGh("old-gh", ghAuthed), true)
})

test("ghAuthed: a network-failed `auth status` (offline/VPN/rate limit) still reads as signed in", posixOnly, async () => {
  // `auth status` VALIDATES the token against the API and blames the credential when it can't reach it.
  assert.equal(await withStubGh("offline", ghAuthed), true)
})

test("ghAuthed: genuinely signed out — both probes fail → false", posixOnly, async () => {
  assert.equal(await withStubGh("signed-out", ghAuthed), false)
})

test("ghAuthed: a blank `gh auth token` is NOT a credential → false", posixOnly, async () => {
  assert.equal(await withStubGh("blank-token", ghAuthed), false)
})

// `gh auth status` is a NETWORK round trip (345-394ms measured 2026-09-04) and githubStatus runs it on
// every page load. These two pin the asymmetry that makes caching it safe.

test("ghAuthed: the TRUE answer is cached, so a signed-in operator pays the round trip once", posixOnly, async () => {
  // Arm the cache against a signed-in gh, then ask again against a gh that reports signed OUT and holds
  // no token. Only the cache can return true through that, so this fails the moment the caching goes.
  resetGhAuthedCache()
  assert.equal(await withStubGhLeavingCache("status-ok", ghAuthed), true)
  assert.equal(await withStubGhLeavingCache("signed-out", ghAuthed), true, "the cached positive must answer without shelling out")
  resetGhAuthedCache()
})

test("ghAuthed: the FALSE answer is NOT cached, so a mid-session `gh auth login` shows up at once", posixOnly, async () => {
  // Signing in is exactly the transition the live re-check exists to catch. A cache that stored the
  // boolean rather than only the positive would swallow it for a whole TTL, so the second call must
  // genuinely re-probe. No reset between the two — that is the point.
  resetGhAuthedCache()
  assert.equal(await withStubGhLeavingCache("signed-out", ghAuthed), false)
  assert.equal(await withStubGhLeavingCache("status-ok", ghAuthed), true, "a signed-out result must not be remembered")
  resetGhAuthedCache()
})

// ---- githubRemoteNameWithOwner (the local, no-network half of the same gate) ----

test("githubRemoteNameWithOwner: every spelling git writes a github.com remote in", () => {
  const expected = "ssalbdivad/ntwine"
  assert.equal(githubRemoteNameWithOwner("git@github.com:ssalbdivad/ntwine.git"), expected)
  assert.equal(githubRemoteNameWithOwner("git@github.com:ssalbdivad/ntwine"), expected)
  assert.equal(githubRemoteNameWithOwner("ssh://git@github.com/ssalbdivad/ntwine.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/ssalbdivad/ntwine.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/ssalbdivad/ntwine"), expected)
  assert.equal(githubRemoteNameWithOwner("https://user@github.com/ssalbdivad/ntwine.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/ssalbdivad/ntwine/"), expected)
  assert.equal(githubRemoteNameWithOwner("  git@github.com:ssalbdivad/ntwine.git\n"), expected) // trailing newline from git
  assert.equal(githubRemoteNameWithOwner("git@GitHub.com:ssalbdivad/ntwine.git"), expected) // host is case-insensitive
})

test("githubRemoteNameWithOwner: a non-github host is not a GitHub repo — including hosts that merely CONTAIN github.com", () => {
  // The whole point of this probe is to open a feature door, so a near-miss host must read as null
  // rather than as github.com.
  assert.equal(githubRemoteNameWithOwner("git@gitlab.com:ssalbdivad/ntwine.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://bitbucket.org/ssalbdivad/ntwine.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://github.com.evil.com/ssalbdivad/ntwine.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://evil.com/github.com/ssalbdivad/ntwine"), null)
  assert.equal(githubRemoteNameWithOwner("git@github.enterprise.co:ssalbdivad/ntwine.git"), null)
})

test("githubRemoteNameWithOwner: anything that is not exactly owner/repo → null, never throws", () => {
  assert.equal(githubRemoteNameWithOwner(""), null)
  assert.equal(githubRemoteNameWithOwner("   "), null)
  assert.equal(githubRemoteNameWithOwner("not a url"), null)
  assert.equal(githubRemoteNameWithOwner("https://github.com/dana"), null) // owner only
  assert.equal(githubRemoteNameWithOwner("https://github.com/a/b/c"), null) // too deep
  assert.equal(githubRemoteNameWithOwner("https://github.com/"), null)
  assert.equal(githubRemoteNameWithOwner("/Users/me/some/local/path"), null)
})

// The regression this whole fallback exists for: gh cannot reach the network, so `gh repo view` fails
// exactly as it does for a gitlab origin — and the trigger's `inRepo && authed` gate hid the feature.
// Run against a REAL git repo with a REAL remote, because the seam under test is the subprocess.
test("gitGithubRemote: reads a real repo's origin with no network and no gh at all", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-remote-"))
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    run(["init", "-q"])
    run(["remote", "add", "origin", "git@github.com:ssalbdivad/ntwine.git"])
    assert.equal(await gitGithubRemote(dir), "ssalbdivad/ntwine")
    // Negative control: the same real probe on the same real repo must FAIL when origin is not GitHub,
    // otherwise the test above proves nothing about the host check.
    run(["remote", "set-url", "origin", "git@gitlab.com:ssalbdivad/ntwine.git"])
    assert.equal(await gitGithubRemote(dir), null)
    // …and a repo with no remote at all.
    run(["remote", "remove", "origin"])
    assert.equal(await gitGithubRemote(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
