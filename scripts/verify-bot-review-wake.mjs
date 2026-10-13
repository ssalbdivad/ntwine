// Real-subsystem proof that `pr-watch` has NO actor filter: the live scheduler, the live GitHub
// GraphQL fetcher, and a real PR whose entire review history is bots (nubjs/nub#555 — Copilot and
// Pullfrog reviews, a vercel conversation comment, zero humans).
//
// Phase 1 baselines the PR for real. Phase 2 drops ONE id from the durable cursor — the vercel BOT
// COMMENT — which is exactly the state the watcher is in the instant that comment is posted, and
// ticks again: the wake must fire and name the bot. The old rule (`kind === "review" || !isBot`) is
// evaluated over the same real payload to show it would have stayed asleep.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createStorage } from "../packages/server/src/storage.ts"

const REF = process.env.PR_REF ?? "nubjs/nub#555"
const SLUG = "bot-review-wake"
const root = mkdtempSync(join(tmpdir(), "ntwine-bot-wake-"))
const storage = createStorage(join(root, "ui.db"))
const fenceAt = new Date().toISOString()
const resumes = []
const logs = []

const telemetry = new Map([[SLUG, {
  turn: "idle",
  permPrompt: false,
  subAgents: [],
  bgShells: [],
  pendingQuestion: false,
  lastActivityAt: fenceAt,
  lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr-watch", value: REF }] },
}]])

const tailer = {
  get: (slug) => telemetry.get(slug),
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

function scheduler() {
  return createScheduler({
    storage,
    tailer,
    resume: (slug, message, deliveryId) => { resumes.push({ slug, message, deliveryId }) },
    log: (message) => logs.push(message),
  })
}

try {
  storage.upsertSession({
    slug: SLUG, session_id: `sid-${SLUG}`, thread_name: `ntwine-${SLUG}`, spawned_at: fenceAt,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })

  // ---- Phase 1: baseline the live PR ------------------------------------------------------------
  const first = scheduler()
  await first.tick()
  await first.stop()
  const failures = logs.filter((m) => m.includes("GitHub review check failed"))
  if (failures.length) throw new Error(failures.join("\n"))
  if (resumes.length) throw new Error("baselining an existing PR must not wake the thread")

  const registrations = storage.getSetting("waker.registrations.v1")
  const cursor = registrations.flatMap((r) => Object.entries(r.reviews ?? {}))
    .find(([hintKey]) => hintKey === `pr-watch:${REF}`)?.[1]
  if (!cursor) throw new Error(`no durable cursor persisted for ${REF}`)

  // The live payload, re-fetched through the same public parser the scheduler uses, so the differential
  // below is computed over exactly what GitHub returned.
  const { createGithubReviewFetcher } = await import("../packages/server/src/github-review.ts")
  const [owner, rest] = REF.split("/")
  const [repo, number] = rest.split("#")
  const live = await createGithubReviewFetcher()({ owner, repo, number: Number(number) })
  if (live.status !== "ok") throw new Error(`live fetch failed: ${JSON.stringify(live)}`)

  const botComment = live.activity.find((a) => a.kind === "comment" && (a.actorType === "Bot" || a.actor.endsWith("[bot]")))
  if (!botComment) throw new Error(`${REF} has no bot conversation comment to test with`)

  // ---- Phase 2: that bot comment is brand new ---------------------------------------------------
  const withoutBotComment = registrations.map((r) => ({
    ...r,
    reviews: Object.fromEntries(Object.entries(r.reviews ?? {}).map(([k, v]) => [
      k, k === `pr-watch:${REF}` ? { ...v, seen: v.seen.filter((id) => id !== botComment.id) } : v,
    ])),
  }))
  storage.setSetting("waker.registrations.v1", withoutBotComment)

  const second = scheduler()
  await second.tick()
  await second.tick()
  await second.stop()

  if (resumes.length !== 1) throw new Error(`expected exactly one wake, got ${resumes.length}`)
  const steer = resumes[0].message
  if (!steer.includes(`@${botComment.actor}`)) throw new Error(`steer does not name the bot: ${steer}`)
  if (!steer.includes("🤖")) throw new Error(`steer must not imply a person filed it: ${steer}`)

  // The rule this change removed, evaluated over the same live payload.
  const oldRule = (a) => a.kind === "review" || !(a.actorType?.toLowerCase() === "bot" || a.actor.toLowerCase().endsWith("[bot]"))
  console.log(JSON.stringify({
    ok: true,
    ref: REF,
    liveActivity: live.activity.map((a) => `${a.kind}:${a.actor}${a.actorType === "Bot" ? " (Bot)" : ""}`),
    humanActivityOnThisPr: live.activity.filter((a) => a.actorType !== "Bot" && !a.actor.endsWith("[bot]")).length,
    wokeOn: `${botComment.kind} by @${botComment.actor}`,
    steer,
    oldRuleWouldHaveWoken: oldRule(botComment),
  }, null, 2))
} finally {
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
