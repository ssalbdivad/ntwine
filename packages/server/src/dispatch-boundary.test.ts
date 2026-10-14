import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DispatchInput, THREAD_SLUG_MAX_CHARS, ThreadSlug, threadIdentityName } from "@ntwine/shared"
import { createDispatcher, resolveLegacyThreadFile, resolveSlug, slugify } from "./dispatch.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { readBoard } from "./ntwine.ts"

// The dispatcher's input boundary: the one slug contract, what storage refuses, the legacy-file resolver
// the board reads through, and the provider preflight that runs before any thread state exists.

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `${slug}-owner`,
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
    ...over,
  }
}

function harness(options: {
  preflightAuth?: (kind: string) => Promise<"authed" | "signed-out" | "unknown">
  preflightCodexBinary?: () => Promise<"present" | "missing" | "unknown">
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-dispatch-boundary-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = {
    dir,
    id: "dispatch-boundary-test",
    name: "dispatch-boundary-test",
    label: "o/dispatch-boundary-test",
    stateDir: dir,
    cwdSlug: cwdSlug(dir),
  }
  const spawned: string[] = []
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => {},
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
    claudeBroker: {
      spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string }) => {
        spawned.push(input.threadSlug)
        return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
      },
      releaseSession: () => {},
    } as unknown as ClaudeAgentBrokerBridge,
    preflightAuth: options.preflightAuth,
    preflightCodexBinary: options.preflightCodexBinary,
  })
  return { dir, storage, dispatcher, spawned }
}

const HOSTILE_SLUGS = [
  "",
  ".",
  "..",
  "../outside",
  "/tmp/outside",
  "a/b",
  "a\\b",
  "C:\\outside",
  "%2e%2e",
  "Uppercase",
  "with_underscore",
  "with.dot",
  "é",
  "a\nb",
  "a\rb",
  "a\0b",
  "`touch-pwned`",
  "-leading-option",
  "a".repeat(THREAD_SLUG_MAX_CHARS + 1),
]

test("one canonical thread slug contract rejects path, control, option, Unicode, and oversized identities", () => {
  for (const valid of ["a", "0", "thread-2", "a".repeat(THREAD_SLUG_MAX_CHARS)]) {
    assert.equal(ThreadSlug.safeParse(valid).success, true, valid)
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: valid }).success, true, valid)
    assert.equal(threadIdentityName(valid), `ntwine-${valid}`)
  }
  for (const invalid of HOSTILE_SLUGS) {
    assert.equal(ThreadSlug.safeParse(invalid).success, false, JSON.stringify(invalid))
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: invalid }).success, false, JSON.stringify(invalid))
    assert.throws(() => threadIdentityName(invalid))
  }
})

test("derived and collision slugs remain canonical at the maximum length", () => {
  const max = slugify("a".repeat(THREAD_SLUG_MAX_CHARS + 50))
  assert.equal(max.length, THREAD_SLUG_MAX_CHARS)
  assert.equal(ThreadSlug.safeParse(max).success, true)
  const dir = mkdtempSync(join(tmpdir(), "ntwine-slug-bound-"))
  writeFileSync(join(dir, `${max}.md`), "taken")
  const collision = resolveSlug(dir, max)
  assert.equal(collision.length, THREAD_SLUG_MAX_CHARS)
  assert.match(collision, /-2$/)
  assert.equal(ThreadSlug.safeParse(collision).success, true)
})

test("the dispatcher rejects hostile slugs before spawn, scratch, or storage", async () => {
  const h = harness()
  for (const invalid of HOSTILE_SLUGS) {
    await assert.rejects(h.dispatcher.dispatch({ prompt: "safe", slug: invalid }))
  }
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.allSessions().length, 0)
  assert.equal(existsSync(join(h.dir, ".ntwine")), false)
})

test("storage rejects a noncanonical thread identity at its direct mutation boundary", () => {
  const h = harness()
  assert.throws(() => h.storage.upsertSession(sessionRow("-option")))
  assert.throws(() => h.storage.upsertSession(sessionRow("safe", { thread_name: "ntwine-someone-else" })))
  assert.equal(h.storage.allSessions().length, 0)
})

test("the real board reader omits unsafe ids and never follows markdown symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-board-safe-"))
  mkdirSync(join(dir, ".ntwine"))
  writeFileSync(join(dir, ".ntwine", "safe.md"), "---\ntitle: safe\nstatus: active\n---\n\n## Goal\n\nsafe\n")
  writeFileSync(join(dir, ".ntwine", "Upper.md"), "---\ntitle: Upper\nstatus: active\n---\n")
  const outside = join(mkdtempSync(join(tmpdir(), "ntwine-board-outside-")), "outside.md")
  writeFileSync(outside, "---\ntitle: linked\nstatus: active\n---\n")
  symlinkSync(outside, join(dir, ".ntwine", "linked.md"))

  const board = await readBoard(dir)
  assert.deepEqual(board.threads.map((thread) => thread.id), ["safe"])
  assert.ok(board.errors.some((error) => error.includes("unsafe filename stem") && error.includes("Upper")))

  const linkedRoot = mkdtempSync(join(tmpdir(), "ntwine-board-linked-root-"))
  symlinkSync(join(dir, ".ntwine"), join(linkedRoot, ".ntwine"))
  await assert.rejects(readBoard(linkedRoot), /unsafe or missing \.ntwine directory/)
})

test("legacy source resolution rejects a symlinked file and a symlinked .ntwine root", () => {
  const externalDir = mkdtempSync(join(tmpdir(), "ntwine-legacy-outside-"))
  const externalFile = join(externalDir, "outside.md")
  writeFileSync(externalFile, "---\ntitle: outside\nstatus: active\n---\n")

  const fileLink = harness()
  mkdirSync(join(fileLink.dir, ".ntwine"))
  symlinkSync(externalFile, join(fileLink.dir, ".ntwine", "linked.md"))
  assert.equal(resolveLegacyThreadFile(fileLink.dir, "linked"), null)

  const ntwineLink = harness()
  const externalNtwine = join(externalDir, "ntwine-root")
  mkdirSync(externalNtwine)
  writeFileSync(join(externalNtwine, "linked-root.md"), "---\ntitle: linked-root\nstatus: active\n---\n")
  symlinkSync(externalNtwine, join(ntwineLink.dir, ".ntwine"))
  assert.equal(resolveLegacyThreadFile(ntwineLink.dir, "linked-root"), null)
})

// ---- Dispatch auth preflight (claude-auth plan, Slice A) ----

test("signed-out preflight rejects dispatch before scratch, spawn, and storage", async () => {
  const seen: string[] = []
  const h = harness({
    preflightAuth: async (kind) => {
      seen.push(kind)
      return "signed-out"
    },
  })
  await assert.rejects(h.dispatcher.dispatch({ prompt: "do the thing" }), /AUTH_REQUIRED:claude$/)
  assert.deepEqual(seen, ["claude"])
  assert.equal(h.spawned.length, 0)
  // Zero trace: no scratchpad tree, no registry row.
  assert.equal(existsSync(join(h.dir, ".ntwine")), false)
})

test("a missing codex binary rejects a codex dispatch early, before any thread state", async () => {
  const probed: number[] = []
  const h = harness({
    preflightAuth: async () => "authed", // credential is fine; the BINARY is what's missing
    preflightCodexBinary: async () => { probed.push(1); return "missing" },
  })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "start a codex thread" }, { backend: "codex" }),
    /Codex is not installed.*not on PATH/,
  )
  assert.equal(probed.length, 1, "the binary was probed")
  assert.equal(h.spawned.length, 0)
  // Zero trace, exactly like the signed-out gate: no scratchpad, no registry row.
  assert.equal(existsSync(join(h.dir, ".ntwine")), false)
})

test("codex dispatch proceeds when the binary probe is uncertain — fail OPEN, never trap a working user", async () => {
  // "unknown" (a timeout, a permission error, anything short of ENOENT) must NOT block. It reaches the
  // bridge, which is absent in this harness, so it fails THERE — proving the binary gate let it past.
  const h = harness({
    preflightAuth: async () => "authed",
    preflightCodexBinary: async () => "unknown",
  })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "start a codex thread" }, { backend: "codex" }),
    /Codex app-server is unavailable|could not start/,
  )
})

test("the codex binary probe is codex-only — a claude dispatch never runs it", async () => {
  let probed = false
  const h = harness({
    preflightAuth: async () => "authed",
    preflightCodexBinary: async () => { probed = true; return "missing" },
  })
  // A claude dispatch with an available binary path should not consult the codex probe at all.
  await h.dispatcher.dispatch({ prompt: "claude thread" }).catch(() => {})
  assert.equal(probed, false, "the codex binary probe must not run for a claude dispatch")
})

test("signed-out preflight names the codex backend when the dispatch targets codex", async () => {
  const h = harness({ preflightAuth: async () => "signed-out" })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "do the thing", backend: "codex" }, { backend: "codex" }),
    /AUTH_REQUIRED:codex$/,
  )
  assert.equal(h.spawned.length, 0)
})

test("unknown preflight fails OPEN — dispatch proceeds", async () => {
  const h = harness({ preflightAuth: async () => "unknown" })
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})

test("a preflight that itself throws fails OPEN — dispatch proceeds", async () => {
  const h = harness({
    preflightAuth: async () => {
      throw new Error("keychain exploded")
    },
  })
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})

test("no injected preflight (unit-test composition) leaves dispatch untouched", async () => {
  const h = harness()
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})
