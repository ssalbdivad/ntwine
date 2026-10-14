import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signClaim, verifyClaim } from "@ntwine/shared";
import { claimIdentityFingerprint, claimIdentityPath, loadOrCreateClaimIdentity } from "./identity.ts";

// A SET XDG variable outranks the throwaway home in ntwine-paths.ts, so without this an XDG-configured
// machine would mint and chmod keys in the operator's real `$XDG_STATE_HOME/ntwine` (same as cloud.test.ts).
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name];

function sandbox() {
  return mkdtempSync(join(tmpdir(), "ntwine-identity-"));
}

test("the identity is minted once and reused, or a name changes owner every launch", async () => {
  const home = sandbox();
  try {
    const first = await loadOrCreateClaimIdentity(home);
    const second = await loadOrCreateClaimIdentity(home);
    assert.equal(await claimIdentityFingerprint(second), await claimIdentityFingerprint(first));
    assert.equal(readFileSync(claimIdentityPath(home)).byteLength, 48);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Whole-test gate, because the mode bits ARE this test — every other property of the identity file is
// pinned by the cases around it. Windows has no POSIX permission bits: NTFS access is an ACL, `fs.chmod`
// sets only the read-only flag, and node reports 0666 for any writable file. The 0o600 the writer asks
// for is inert there; making the file unreadable to other accounts would take an icacls ACL, which
// ntwine does not attempt.
test("the key file is 0600 — a readable identity is a name anyone on the box can take", { skip: process.platform === "win32" ? "no POSIX mode bits on win32" : false }, async () => {
  const home = sandbox();
  try {
    await loadOrCreateClaimIdentity(home);
    assert.equal(statSync(claimIdentityPath(home)).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a reloaded identity still signs claims the registry will accept", async () => {
  // The property that matters on every renewal: the key read back from disk must produce signatures
  // that verify against the same public key the registry recorded at claim time.
  const home = sandbox();
  try {
    const minted = await loadOrCreateClaimIdentity(home);
    const fingerprint = await claimIdentityFingerprint(minted);

    const reloaded = await loadOrCreateClaimIdentity(home);
    const now = 1_800_000_000_000;
    const request = await signClaim({ name: "dana", port: 9393, issuedAt: now }, reloaded);
    assert.equal(request.pubkey, fingerprint);

    const verdict = await verifyClaim(request, now);
    assert.ok(verdict.ok);
    assert.equal(verdict.payload.pubkey, fingerprint);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt identity is an ERROR, never silently replaced", async () => {
  // The session key regenerates when it is unreadable, because the cost is signing devices out. The
  // cost here is losing a name you own, so the file is never overwritten behind the operator's back.
  const home = sandbox();
  try {
    mkdirSync(join(home, ".ntwine"), { recursive: true });
    writeFileSync(claimIdentityPath(home), Buffer.alloc(4));
    await assert.rejects(loadOrCreateClaimIdentity(home), /not a usable ntwine identity key/);
    assert.equal(readFileSync(claimIdentityPath(home)).byteLength, 4, "the broken file is left for recovery");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
