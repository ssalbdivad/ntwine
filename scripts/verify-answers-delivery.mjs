// Real-subsystem harness for QUESTION ANSWERS that read as delivered while the worker never has them.
//
// The bug (found 2026-09-30, fixed 2026-10-01): `thread_question.delivered` flipped when the scheduler
// QUEUED the answers wake, not when the worker received it. A wake that then failed every attempt left
// the answers reading delivered, and nothing ever offered them again — the human had answered, the
// board said so, and the worker sat waiting on questions it would never hear back on. (2026-09-30: four
// answers on one thread, lost to the broker resume race fixed in 0dc073b7.)
//
// The seam under test, with no mocks on it: the real scheduler (durable outbox, delivery gate, retry,
// exhaustion), the real SQLite storage, the real broker bridge, a real forked broker daemon, and a real
// `claude` child process — the repo's stream-json stub, which can be made to die at startup (a flag
// file the harness writes after the dispatch), which is what a broken worker binary looks like. Only the tailer is stubbed
// (an idle reading), as in verify-prwatch-wake-cold-resume.mjs, whose shape this copies.
//
// Timeline: a worker is dispatched and rests → the hibernator retires its idle daemon → the human
// answers its registered question → every cold resume the answers wake attempts dies → the outbox
// exhausts it → the server restarts with a working runtime.
//
// Assertions:
//   1. while every attempt fails, the claude child never receives the answers, the wake exhausts, and
//      the answer reads UNDELIVERED (the bug: it read delivered from the moment it was queued);
//   2. no further attempts are made with nothing to say the runtime has changed (not a hot loop);
//   3. after a restart with a working runtime, the answer is offered again, reaches the child exactly
//      once, and only then reads delivered.
//
// Usage: node scripts/verify-answers-delivery.mjs     (exit 0 = fixed, exit 1 = a check failed)
// Pass --expect-bug to invert the two bug checks: exit 0 when the pre-fix behaviour reproduces.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStorage } from "../packages/server/src/storage.ts"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createClaudeAgentBrokerBridge } from "../packages/server/src/backend/claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, liveBrokerRecords, readBrokerRecord } from "../packages/server/src/backend/claude-broker-host.ts"
import { deliverClaudeBrokerWake } from "../packages/server/src/context.ts"
import { wakeDeliveryToken } from "../packages/shared/src/index.ts"

const expectBug = process.argv.includes("--expect-bug")
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), "verify-answers-delivery-"))
const fixture = new URL("../packages/server/src/backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url).pathname
const capture = join(root, "capture.jsonl")
const exe = join(root, "fake-claude--basic.mjs")
const failFlag = join(root, "resume-fails")
writeFileSync(exe, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs"
const argv = process.argv.slice(2)
if (existsSync(${JSON.stringify(failFlag)})) {
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ kind: "resume-died", argv }) + "\\n")
  process.stderr.write("claude: cannot execute\\n")
  process.exit(1)
}
await import(${JSON.stringify(fixture)})
`)
chmodSync(exe, 0o700)

const events = () => {
  try { return readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const ANSWER_NEEDLE = "“SQLite or a JSON file?” → SQLite"
const answersReceived = () => events().filter((e) => e.kind === "user-input" && typeof e.text === "string" && e.text.includes(ANSWER_NEEDLE)).length
// Every child the daemon tried to start: a cold resume does not necessarily pass `--resume` on argv.
const resumeAttempts = () => events().filter((e) => e.kind === "startup" || e.kind === "resume-died").length
const waitFor = async (pred, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (pred()) return true; await sleep(50) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

const storage = createStorage(join(root, "ui.db"), "verify-answers")
const bridge = createClaudeAgentBrokerBridge({
  stateDir: root, executablePath: exe,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
})
const logs = []
const telemetry = new Map()
const tailer = { get: (slug) => telemetry.get(slug), subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} }
// An idle reading whose last turn predates everything below, so "the worker ran a turn since the
// failure" never opens the re-offer gate by accident — the restart is the only thing that may.
const restedAt = new Date(Date.now() - 3_600_000).toISOString()
const idle = () => ({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastActivityAt: restedAt, lastAssistantAt: restedAt, lastFence: undefined })
let offset = 0
const now = () => Date.now() + offset
const later = (ms) => { offset += ms }

// One scheduler per "server process". The production probe and resume, verbatim in shape (context.ts).
function makeScheduler() {
  return createScheduler({
    storage, tailer, now,
    wakeRuntimeState: (slug, sessionId) => {
      const row = storage.getSession(slug)
      if (!row || row.session_id !== sessionId) return "unknown"
      return liveBrokerRecords(root).some((r) => r.sessionId === sessionId) ? "alive" : "dead"
    },
    confirmGraceMs: 1_500,
    resume: (slug, message, deliveryId) => {
      const row = storage.getSession(slug)
      return deliverClaudeBrokerWake({
        bridge, slug, cwd: root,
        row: { session_id: row.session_id, model: null, effort: null, permission_mode: "auto" },
        settings: { permissionMode: "auto" },
        deliveryMessage: `${message}\n\n${wakeDeliveryToken(deliveryId)}`,
      })
    },
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    log: (m) => { logs.push(m); if (process.env.VERBOSE) console.log(`  waker> ${m}`) },
    tickMs: 60_000, deliveryLeaseMs: 1_000, retryBaseMs: 1_000, retryMaxMs: 2_000, maxDeliveryAttempts: 3,
  })
}

const SLUG = "answered-thread"
const session = randomUUID()
const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(root, session))
const answerWakes = () => storage.db.prepare(
  "SELECT id, state, attempts, last_error FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'answers:%' ORDER BY created_at",
).all(SLUG)
const question = () => storage.getThreadQuestion("qst_harness")

let first
let second
try {
  storage.upsertSession({
    slug: SLUG, session_id: session, thread_name: `ntwine-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  telemetry.set(SLUG, idle())

  // A real dispatch: daemon + child, one turn answered. Then the hibernator retires the idle daemon, so
  // the answers wake has to cold-resume — the path the 2026-09-30 incident took.
  await bridge.spawnDispatch({ threadSlug: SLUG, sessionId: session, cwd: root, prompt: `start ${SLUG}`, permissionMode: "auto" })
  check("the dispatch prompt reached the claude child", await waitFor(() => events().some((e) => e.kind === "user-input" && String(e.text).includes(`start ${SLUG}`)), 10_000, "dispatch input"))
  const daemonPid = recordOf()?.daemonPid
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  check("the idle daemon is retired, as the hibernator would", bridge.retireDaemon({ threadSlug: SLUG, sessionId: session, reason: "hibernate" }))
  check("…and its record and process are gone", await waitFor(() => !recordOf() && !(daemonPid && pidAlive(daemonPid)), 10_000, "daemon exit"))

  // The worker asked; the human answers — the two storage writes the `ask` tool and answerQuestions make.
  storage.askThreadQuestion({ id: "qst_harness", slug: SLUG, spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON" }] }), askedAtMs: now() })
  storage.answerThreadQuestion("qst_harness", JSON.stringify({ questionId: "qst_harness", question: "SQLite or a JSON file?", chosen: ["SQLite"] }), now())

  // ---- EVERY ATTEMPT FAILS ------------------------------------------------------------------------
  writeFileSync(failFlag, "")
  first = makeScheduler()
  await first.tick()
  check("the answer queues one wake", answerWakes().length === 1, JSON.stringify(answerWakes()))
  check("its cold resume is attempted and dies", await waitFor(() => events().some((e) => e.kind === "resume-died"), 10_000, "resume attempt"))
  for (let i = 0; i < 12 && answerWakes()[0]?.state !== "exhausted"; i++) { await sleep(500); later(3_000); await first.tick() }
  const exhausted = answerWakes()[0]
  check("the wake EXHAUSTS its attempts", exhausted?.state === "exhausted", JSON.stringify(exhausted))
  check("the claude child never received the answer", answersReceived() === 0, `received=${answersReceived()}`)
  const delivered = question()?.delivered
  check(expectBug ? "REPRODUCED: the answer reads DELIVERED anyway" : "the answer reads UNDELIVERED", expectBug ? delivered === 1 : delivered === 0, `delivered=${delivered}`)

  // ---- NOT A LOOP ---------------------------------------------------------------------------------
  const attemptsBefore = resumeAttempts()
  for (let i = 0; i < 5; i++) { await sleep(200); later(10_000); await first.tick() }
  check("nothing retries it on every tick", resumeAttempts() === attemptsBefore && answerWakes().length === 1, `resume attempts ${attemptsBefore} → ${resumeAttempts()}, wakes=${answerWakes().length}`)

  // ---- THE SERVER RESTARTS, WITH A WORKING RUNTIME ------------------------------------------------
  rmSync(failFlag, { force: true })
  later(1_000)
  second = makeScheduler()
  for (let i = 0; i < 10 && question()?.delivered !== 1; i++) { await second.tick(); await sleep(500); later(1_000) }
  const received = answersReceived()
  check(expectBug ? "REPRODUCED: after the restart nothing offers the answer again" : "after the restart the answer reaches the claude child", expectBug ? received === 0 : received === 1, `received=${received}`)
  if (!expectBug) {
    check("…under a NEW delivery, beside the exhausted one", answerWakes().length === 2 && answerWakes()[1].state === "delivered", JSON.stringify(answerWakes()))
    check("…and only now reads delivered", question()?.delivered === 1, `delivered=${question()?.delivered}`)
    for (let i = 0; i < 4; i++) { await sleep(200); later(10_000); await second.tick() }
    check("it is never sent twice", answersReceived() === 1, `received=${answersReceived()}`)
  }
} finally {
  console.log(`  capture: ${events().map((e) => e.kind === "user-input" ? `input(${String(e.text).slice(0, 24)}…)` : e.kind === "startup" ? `startup(${e.argv.includes("--resume") ? "resume" : "fresh"})` : e.kind).join(" ")}`)
  for (const s of [first, second]) { try { await s?.stop() } catch {} }
  try { bridge.releaseSession(SLUG, session, "session-deleted") } catch {}
  try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
  try { bridge.close() } catch {}
  try { storage.close() } catch {}
  await sleep(300)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${results.length} checks${expectBug ? " (baseline mode: green = bug reproduced)" : ""}`)
process.exit(failed === 0 ? 0 : 1)
