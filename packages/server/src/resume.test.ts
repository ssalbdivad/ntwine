import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type ProfileHandoffJournal, type Storage, type SessionRow } from "./storage.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { Bus } from "./bus.ts"
import {
  resumeThread,
} from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import type { AgentBackend } from "./backend/types.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { Settings, ThreadView, BoardSnapshot } from "@ntwine/shared"
import type { PaneIdentity as PaneSnapshot } from "./adoption-recovery.ts"

// bump-unarchives: BUMPING (followUp/resume) an ARCHIVED thread must UN-ARCHIVE it so it moves from the
// sidebar's Inactive section back to Active. The move is server-driven: resumeThread flips the row's
// `state` back to "open" (clearing the legacy `archived` flag) and refreshes the board; the SSE delta
// re-sections it because the client's sectionOf keys purely on `state`. These tests pin that the SERVER
// side (state flip + board re-emit) fires on both the live-inject and the dead-resume path.

// A local mirror of packages/web/src/groups.ts sectionOf's ONE rule (kept in-package so the server test
// stays hermetic): a session thread is Inactive iff its state is "archived", else Active.
function sectionOf(t: ThreadView): "active" | "inactive" | null {
  if (t.kind !== "session") return null
  return t.state === "archived" ? "inactive" : "active"
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakeProject(dir: string): Project {
  return { dir, id: "test-id", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
}

// A Tailer stub with no telemetry (get → undefined, no foreign ids): the board derives runtime from the
// registry row alone, which is fine here — sectioning keys on `state`, not runtime.
const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

const settings = { permissionMode: "auto" } as unknown as Settings

function profileHandoff(
  nativeSessionId: string,
  previous: { model: string; effort: string },
  requested: { model: string; effort: string },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId,
    previous: {
      ...previous,
      binding: { kind: "standalone", paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 },
    },
    requested,
  }
}

const PRIOR_PANE = { paneId: "%11", panePid: 111, sessionCreated: 1_750_000_011 }
const TARGET_PANE = { paneId: "%12", panePid: 112, sessionCreated: 1_750_000_012 }
const ROLLBACK_PANE = { paneId: "%13", panePid: 113, sessionCreated: 1_750_000_013 }

function armRecovery(
  storage: Storage,
  slug: string,
  phase: "armed" | "target-spawned" | "target-ready",
): { journal: ProfileHandoffJournal; targetToken?: string } {
  const requested = { model: "sonnet", effort: "max" }
  let journal: ProfileHandoffJournal = {
    version: 1,
    phase: "armed",
    nativeSessionId: `sid-${slug}`,
    previous: { model: "opus", effort: "high", binding: { kind: "standalone", ...PRIOR_PANE } },
    requested,
  }
  const owned = storage.armProfileChange(slug, {
    sessionId: `sid-${slug}`,
    nativeSessionId: null,
    generation: 0,
  }, requested, journal)
  assert.ok(owned)
  if (phase === "armed") return { journal }

  const generation = storage.beginRuntimeGeneration(slug, {
    sessionId: `sid-${slug}`,
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-01T00:01:00.000Z")
  assert.equal(generation, 1)
  const targetToken = randomUUID()
  journal = {
    ...journal,
    phase,
    target: {
      generation: 1,
      handoffToken: targetToken,
      binding: { kind: "standalone", ...TARGET_PANE, handoffToken: targetToken },
    },
  }
  const serialized = storage.checkpointProfileChange(slug, {
    sessionId: `sid-${slug}`,
    nativeSessionId: null,
    generation: 1,
    profileRevision: owned.profileRevision,
    controlRevision: owned.controlRevision,
    model: requested.model,
    effort: requested.effort,
    profileHandoff: owned.profileHandoff,
  }, journal)
  assert.ok(serialized)
  return { journal, targetToken }
}

function harness(): { storage: Storage; board: BoardManager; dir: string } {
  const dir = tmpDir("ntwine-resume-")
  const storage = createStorage(join(dir, "ui.db"), "p")
  const board = createBoard(fakeProject(dir), storage, new Bus(), noopTailer, "test-boot")
  return { storage, board, dir }
}

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    thread_name: `ntwine-${slug}`,
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: `Thread ${slug}`,
    state: "open",
    meta: null,
    seen_at: null,
    transcript_id: null,
    ...over,
  }
}

function threadIn(snap: BoardSnapshot, slug: string): ThreadView {
  const t = snap.threads.find((x) => x.id === slug)
  assert.ok(t, `expected thread ${slug} in the board snapshot`)
  return t
}


test("resumeThread fails closed when its row snapshot is replaced before runtime binding", () => {
  const { storage, board, dir } = harness()
  const slug = "resume-stale-row"
  const stale = sessionRow(slug, {
    session_id: "owner-a",
    runtime_generation: 3,
    archived: 1,
    state: "archived",
  })
  storage.upsertSession(stale)
  storage.upsertSession(sessionRow(slug, {
    session_id: "owner-b",
    runtime_generation: 0,
    archived: 1,
    state: "archived",
  }))
  storage.setState(slug, "archived")
  let first = true
  const staleStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "getSession") {
        return (value: string) => {
          if (value === slug && first) {
            first = false
            return stale
          }
          return target.getSession(value)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage: staleStorage, board, getSettings: () => settings }, slug, "do not send"),
    /competing adoption attempt|no worker was contacted/,
  )
  assert.equal(storage.getSession(slug)?.state, "archived", "stale A cannot unarchive replacement B")
})

test("resumeThread blocks every durable permission handoff before live injection or unarchive", () => {
  for (const [pending, slug] of [["bypassPermissions", "pending-bypass-permissions"], ["future-mode", "pending-future-mode"]]) {
    const { storage, board } = harness()
    storage.upsertSession(sessionRow(slug, { permission_pending: pending }))
    storage.setState(slug, "archived")
        assert.throws(
      () => resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings }, slug, "must not overtake"),
      /permission change.*in progress/i,
    )
    assert.equal(storage.getSession(slug)?.state, "archived", "a blocked resume has no lifecycle side effect")
  }
})

// ── replay safety ────────────────────────────────────────────────────────────────────────────────
// A follow-up refused by a contention gate is REPLAYABLE, and the client relies on that verdict to
// retry instead of handing the operator's message back. The licence is delivery safety, so what these
// pin is not the message but the pairing: marked retryable AND provably nothing injected.
test("a lost runtime-control CAS is marked retryable and injects nothing", () => {
  const { storage, board } = harness()
  const slug = "resume-cas-retryable"
  storage.upsertSession(sessionRow(slug))
  // A competing writer (the wakers scheduler, another tab, the submit-confirmer) already owns the row.
  const owned = storage.getSession(slug)!
  storage.beginRuntimeControl(slug, {
    sessionId: owned.session_id,
    nativeSessionId: owned.agent_session_id ?? null,
    generation: owned.runtime_generation ?? 0,
  }, "follow-up")

    let injected = 0

  let raised: unknown
  try {
    resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings }, slug, "continue")
  } catch (error) { raised = error }

  assert.equal(injected, 0, "a contention refusal must happen strictly upstream of the first delivery write")
  assert.equal((raised as { retryableDelivery?: unknown })?.retryableDelivery, true,
    "the client may only replay a send it is told took no effect")
})

test("a permission handoff refusal is retryable too — the send simply arrived mid-handoff", () => {
  const { storage, board } = harness()
  const slug = "resume-perm-retryable"
  storage.upsertSession(sessionRow(slug))
  const owned = storage.getSession(slug)!
  storage.armProfileChange(slug, {
    sessionId: owned.session_id,
    nativeSessionId: owned.agent_session_id ?? null,
    generation: owned.runtime_generation ?? 0,
  }, { model: "opus", effort: "max" }, profileHandoff(
    owned.agent_session_id ?? owned.session_id,
    { model: owned.model ?? "sonnet", effort: owned.effort ?? "high" },
    { model: "opus", effort: "max" },
  ))

    let injected = 0

  let raised: unknown
  try {
    resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings }, slug, "continue")
  } catch (error) { raised = error }

  assert.equal(injected, 0)
  assert.equal((raised as { retryableDelivery?: unknown })?.retryableDelivery, true)
})
