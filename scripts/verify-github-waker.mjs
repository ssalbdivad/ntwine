import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createStorage } from "../packages/server/src/storage.ts"

const refs = [
  ["github-waker-544", "nubjs/nub#544"],
  ["github-waker-549", "nubjs/nub#549"],
]
const root = mkdtempSync(join(tmpdir(), "ntwine-github-waker-"))
const storage = createStorage(join(root, "ui.db"))
const telemetry = new Map()
const logs = []
const fenceAt = new Date().toISOString()

try {
  for (const [slug, ref] of refs) {
    storage.upsertSession({
      slug,
      session_id: `sid-${slug}`,
      thread_name: `ntwine-${slug}`,
      spawned_at: fenceAt,
      last_read_at: null,
      unread: 0,
      exited: 0,
      archived: 0,
      rested_at: null,
      title_auto: 0,
      title: slug,
      state: "open",
      meta: null,
      seen_at: null,
      transcript_id: null,
    })
    telemetry.set(slug, {
      turn: "idle",
      permPrompt: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      lastActivityAt: fenceAt,
      lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr-watch", value: ref }] },
    })
  }

  const scheduler = createScheduler({
    storage,
    tailer: {
      get: (slug) => telemetry.get(slug),
      foreignIds: () => [],
      subAgent: () => undefined,
      forget: () => {},
      start: () => {},
      stop: () => {},
      tick: () => {},
    },
    resume: () => {
      throw new Error("a baseline-only verification tick must not wake a thread")
    },
    log: (message) => logs.push(message),
  })

  const startedAt = Date.now()
  await scheduler.tick()
  const elapsedMs = Date.now() - startedAt
  await scheduler.stop()

  const failures = logs.filter((message) => message.includes("GitHub review check failed"))
  if (failures.length > 0) throw new Error(failures.join("\n"))
  const registrations = storage.getSetting("waker.registrations.v1")
  const serialized = JSON.stringify(registrations)
  for (const [, ref] of refs) {
    if (!serialized.includes(`pr-watch:${ref}`)) throw new Error(`missing durable review cursor for ${ref}`)
  }
  console.log(JSON.stringify({
    ok: true,
    elapsedMs,
    refs: refs.map(([, ref]) => ref),
    durableBaselines: refs.length,
    failureLogs: failures.length,
  }))
} finally {
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
