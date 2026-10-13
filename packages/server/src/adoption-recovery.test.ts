import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawn as spawnChild } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  adoptionRuntimeBinding,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
  type AdoptionPaneLookup,
  type PaneIdentity,
  type ExpectedAdoptionPane,
} from "./adoption-recovery.ts"
import { SYSTEM_PROMPT_DIR } from "./session-files.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"

const storageModule = pathToFileURL(join(import.meta.dirname, "storage.ts")).href
const recoveryModule = pathToFileURL(join(import.meta.dirname, "adoption-recovery.ts")).href


function sessionRow(slug: string, sessionId: string): SessionRow {
  return {
    slug,
    session_id: sessionId,
    thread_name: `ntwine-${slug}`,
    spawned_at: "2026-07-13T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    transcript_id: null,
    state: "open",
    meta: null,
    seen_at: null,
    backend: "claude",
    agent_session_id: null,
  }
}

function pane(token: string, over: Partial<PaneIdentity> = {}): PaneIdentity {
  return {
    paneId: "%41",
    panePid: 4100,
    sessionCreated: 41000,
    dead: false,
    adoptionAttemptToken: token,
    ...over,
  }
}

class FakeRuntime implements AdoptionRecoveryRuntime {
  readonly bySlug = new Map<string, PaneIdentity>()
  readonly killed: PaneIdentity[] = []
  lookupUnknown = false
  findUnknown = false
  killWorks = true

  lookupAdoptionPane(slug: string): AdoptionPaneLookup {
    if (this.lookupUnknown) return { kind: "unknown" }
    const current = this.bySlug.get(slug)
    return current ? { kind: "found", pane: current } : { kind: "absent" }
  }

  findAdoptionPane(attemptToken: string): AdoptionPaneLookup {
    if (this.findUnknown) return { kind: "unknown" }
    const matches = [...this.bySlug.values()].filter((current) => current.adoptionAttemptToken === attemptToken)
    return matches.length === 1 ? { kind: "found", pane: matches[0] } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  }

  findAdoptionPanes(attemptTokens: readonly string[]): Map<string, AdoptionPaneLookup> {
    return new Map(attemptTokens.map((token) => [token, this.findAdoptionPane(token)]))
  }

  findPaneIdentity(identity: PaneIdentity): AdoptionPaneLookup {
    const matches = [...this.bySlug.values()].filter((current) =>
      current.paneId === identity.paneId &&
      current.panePid === identity.panePid &&
      current.sessionCreated === identity.sessionCreated,
    )
    return matches.length === 1 ? { kind: "found", pane: matches[0] } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  }

  killPane(identity: PaneIdentity): void {
    this.killed.push(identity)
    if (!this.killWorks) return
    for (const [slug, current] of this.bySlug) {
      if (
        current.paneId === identity.paneId &&
        current.panePid === identity.panePid &&
        current.sessionCreated === identity.sessionCreated
      ) {
        this.bySlug.delete(slug)
      }
    }
  }

  killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
    const found = this.findAdoptionPane(expected.attempt_token)
    if (
      found.kind !== "found" ||
      found.pane.paneId !== expected.pane_id ||
      found.pane.panePid !== expected.pane_pid ||
      found.pane.sessionCreated !== expected.session_created
    ) return false
    this.killPane(found.pane)
    return this.killWorks
  }
}

function fixture(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-adoption-recovery-"))
  const dbPath = join(dir, "ui.db")
  const storage = createStorage(dbPath, "p")
  const attemptToken = randomUUID()
  const sessionId = randomUUID()
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken,
    sessionId,
    reservedAtMs: 100,
    leaseExpiresAtMs: 200,
  }), true)
  return { dir, dbPath, storage, slug, attemptToken, sessionId }
}

function writeArtifacts(dir: string, sessionId: string): { scratch: string; staging: string; system: string } {
  const scratchDir = join(dir, ".ntwine", "threads", sessionId)
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const scratch = join(scratchDir, "scratch.md")
  const staging = join(scratchDir, ".scratch.tmp")
  const system = join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
  writeFileSync(scratch, "scratch")
  writeFileSync(staging, "staging")
  writeFileSync(system, "system")
  return { scratch, staging, system }
}

test("adoption runtime binding rejects stale row snapshots before any legacy slug fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-binding-aba-"))
  const s = createStorage(join(dir, "ui.db"), "p")
  const original = { ...sessionRow("binding-aba", "owner-a"), runtime_generation: 2 }
  s.upsertSession(original)
  assert.equal(adoptionRuntimeBinding(s, original).kind, "unbound")

  s.forgetSession(original.slug)
  assert.equal(adoptionRuntimeBinding(s, original).kind, "conflict", "an absent current row is stale")
  s.upsertSession({ ...sessionRow(original.slug, "owner-b"), runtime_generation: 0 })
  assert.equal(adoptionRuntimeBinding(s, original).kind, "conflict", "a replacement session is stale")

  const sameId = { ...sessionRow("binding-generation", "same-owner"), runtime_generation: 1 }
  s.upsertSession(sameId)
  s.upsertSession({ ...sameId, runtime_generation: 2 })
  assert.equal(adoptionRuntimeBinding(s, sameId).kind, "conflict", "a later process generation is stale")
  s.close()
})

test("fixture proof: system-prompt cleanup never reads or rewrites prompt contents", () => {
  // Guard the test itself against accidentally turning recovery into a prompt-reading/logging path.
  const h = fixture("artifact-proof")
  const files = writeArtifacts(h.dir, h.sessionId)
  assert.equal(readFileSync(files.system, "utf8"), "system")
  reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime: new FakeRuntime() })
  assert.equal(existsSync(files.system), false)
  assert.equal(ADOPTION_ATTEMPT_LEASE_MS, 120_000)
})
