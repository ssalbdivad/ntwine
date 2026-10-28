// Real-subsystem reproduction for a PR-watch wake that ntwine records as DELIVERED while the worker never
// receives it — the shape a user's board showed 2026-08-25: a thread parked on a registered PR watcher,
// CI green and three reviews posted, nothing woke the worker for 12h+, and the human's own message
// cold-resumed it fine afterwards.
//
// The seam under test, with no mocks on it: the real scheduler (durable outbox, delivery gate, ack), the
// real broker bridge, a real forked broker daemon, and a real `claude` child process — a stub speaking
// the stream-json protocol whose `--resume` can be made to die at startup, which is what a cold resume
// looks like when the session cannot be resumed (auth refresh, "No conversation found", a broken MCP boot).
//
// Timeline it replays: the worker rests → the hibernator retires its idle daemon → GitHub reports an
// event → the scheduler wakes the thread → that wake has to cold-resume → the resume dies.
//
// Assertions:
//   1. the healthy CONTROL: with a resume that works, the wake reaches the claude child (its capture
//      shows the input) and the outbox row reads `delivered`;
//   2. the FAILURE: with a resume that dies at startup, the claude child never receives the input, yet
//      the outbox row ALSO reads `delivered`, the watcher's cursor has advanced past the event, and no
//      later tick ever re-sends it. That is the lost wake.
//
// Usage: node scripts/verify-prwatch-wake-cold-resume.mjs   (exit 0 = the bug is FIXED, exit 1 = reproduced)
// Pass --expect-bug to invert: exit 0 when the bug reproduces (the pre-fix baseline).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const root = mkdtempSync(join(tmpdir(), "verify-prwatch-cold-resume-"))
const fixture = new URL("../packages/server/src/backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url).pathname
const capture = join(root, "capture.jsonl")
// The stub: a real child process on the real protocol. When `--resume` is present AND the flag file
// exists it dies the way a failed cold resume does — before initializing, before reading stdin.
// Named the way the fixture expects: it derives its scenario AND its capture file (`capture.jsonl` beside
// the executable) from this basename, because the daemon sanitizes the child env and drops anything else.
const exe = join(root, "fake-claude--basic.mjs")
const failFlag = join(root, "resume-fails")
writeFileSync(exe, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs"
const argv = process.argv.slice(2)
if (argv.includes("--resume") && existsSync(${JSON.stringify(failFlag)})) {
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ kind: "resume-died", argv }) + "\\n")
  process.stderr.write("No conversation found with session ID: " + argv[argv.indexOf("--resume") + 1] + "\\n")
  process.exit(1)
}
await import(${JSON.stringify(fixture)})
`)
chmodSync(exe, 0o700)

const events = () => {
  try { return readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const inputsWith = (needle) => events().filter((e) => e.kind === "user-input" && typeof e.text === "string" && e.text.includes(needle))
const waitFor = async (pred, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (pred()) return true; await sleep(50) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

const storage = createStorage(join(root, "ui.db"))
const bridge = createClaudeAgentBrokerBridge({
  stateDir: root, executablePath: exe,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
})
const logs = []
const telemetry = new Map()
const tailer = {
  get: (slug) => telemetry.get(slug),
  subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
}
const idle = () => ({
  turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
  lastActivityAt: new Date().toISOString(), lastAssistantAt: new Date().toISOString(),
  lastFence: undefined,
})
// A virtual clock the scheduler reads, so a second poll of the same PR is not throttled by the real
// 60s per-ref cadence and the retry/lease windows come due when the harness says they do.
let offset = 0
const now = () => Date.now() + offset
const later = (ms) => { offset += ms }

// GitHub, stubbed at the fetcher boundary only — the seam under test is downstream of it. `head` and
// `checks` are per-ref so the two threads get one event each.
const github = new Map()
const scheduler = createScheduler({
  storage, tailer, now,
  // The production probe (context.ts), verbatim in shape: the daemon record on disk, pid-checked.
  wakeRuntimeState: (slug, sessionId) => {
    const row = storage.getSession(slug)
    if (!row || row.session_id !== sessionId) return "unknown"
    return liveBrokerRecords(root).some((r) => r.sessionId === sessionId) ? "alive" : "dead"
  },
  // Shortened windows: a real resume that is going to die does so in seconds, so 1.5s of grace is the
  // same experiment at harness speed.
  confirmGraceMs: 1_500,
  resume: (slug, message, deliveryId) => {
    const row = storage.getSession(slug)
    return deliverClaudeBrokerWake({
      bridge, slug, cwd: root,
      row: { session_id: row.session_id, model: null, effort: null, permission_mode: "auto" },
      deliveryMessage: `${message}\n\n${wakeDeliveryToken(deliveryId)}`,
    })
  },
  fetchPr: async (ref) => github.get(`${ref.owner}/${ref.repo}#${ref.number}`),
  fetchGithubReview: async () => [],
  log: (m) => { logs.push(m); if (process.env.VERBOSE) console.log(`  waker> ${m}`) },
  tickMs: 60_000, deliveryLeaseMs: 1_000, retryBaseMs: 1_000, retryMaxMs: 2_000,
})

const recordOf = (session) => readBrokerRecord(claudeBrokerRecordPath(root, session))
const outboxRow = (slug) => storage.db.prepare(
  "SELECT state, attempts, last_error FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'prwatch%' ORDER BY created_at",
).all(slug)
const cursorOf = (id) => JSON.parse(storage.getPrWatch(id)?.cursor ?? "null")

async function thread(slug, ref) {
  const session = randomUUID()
  storage.upsertSession({
    slug, session_id: session, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  telemetry.set(slug, idle())
  // A real dispatch: daemon + child, one turn answered.
  await bridge.spawnDispatch({ threadSlug: slug, sessionId: session, cwd: root, prompt: `start ${slug}`, permissionMode: "auto" })
  check(`${slug}: the dispatch prompt reached the claude child`, await waitFor(() => inputsWith(`start ${slug}`).length === 1, 10_000, "dispatch input"))
  // The worker rests; the hibernator retires the idle daemon (the real call, the real reason). Wait for
  // the PROCESS to be gone, not just its record: the record is unlinked on the way out, and a wake that
  // lands in that gap reconnects to a daemon that is still draining instead of cold-resuming.
  const daemonPid = recordOf(session)?.daemonPid
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  check(`${slug}: the idle daemon is retired, as the hibernator would`, bridge.retireDaemon({ threadSlug: slug, sessionId: session, reason: "hibernate" }))
  check(`${slug}: …and its record and process are gone`, await waitFor(() => !recordOf(session) && !(daemonPid && pidAlive(daemonPid)), 10_000, "daemon exit"))
  // The watcher, registered the way the tool registers it, with CI still running.
  const watchId = `prw_${slug}`
  const [owner, rest] = ref.split("/"); const [repo, number] = rest.split("#")
  storage.armPrWatch({ id: watchId, slug, owner, repo, number: Number(number), createdAtMs: Date.now(), expiresAtMs: Date.now() + 6 * 3_600_000 })
  github.set(ref, { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS", conclusion: null }], head: "aaaaaaa", workflowRuns: [] })
  later(61_000); await scheduler.tick()
  check(`${slug}: a running CI is not news — no wake queued`, outboxRow(slug).length === 0)
  return { session, watchId, ref }
}

const startupsWithResume = () => events().filter((e) => (e.kind === "startup" && e.argv?.includes("--resume")) || e.kind === "resume-died")

try {
  // ---- CONTROL: a cold resume that works ------------------------------------------------------------
  const ok = await thread("healthy-thread", "acme/app#1")
  github.set(ok.ref, { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], head: "aaaaaaa", workflowRuns: [] })
  later(61_000); await scheduler.tick()
  check("CONTROL: the CI-passing event queues one wake", outboxRow("healthy-thread").length === 1, JSON.stringify(outboxRow("healthy-thread")))
  check("CONTROL: the wake cold-resumes a fresh claude", await waitFor(() => startupsWithResume().length >= 1, 10_000, "resume startup"))
  check("CONTROL: …and the wake text reaches it", await waitFor(() => inputsWith("CI PASSED on acme/app#1").length >= 1, 10_000, "wake input"))
  // Delivered is declared AFTER the confirmation window, not on the socket write.
  await sleep(1_600); await scheduler.tick()
  check("CONTROL: the outbox reads delivered once the confirmation window closed on a live process", outboxRow("healthy-thread")[0]?.state === "delivered", JSON.stringify(outboxRow("healthy-thread")))

  // ---- THE FAILURE: a cold resume that dies at startup ---------------------------------------------
  const bad = await thread("stalled-thread", "acme/app#2")
  writeFileSync(failFlag, "")
  const resumesBefore = startupsWithResume().length
  github.set(bad.ref, { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], head: "bbbbbbb", workflowRuns: [] })
  later(61_000); await scheduler.tick()
  check("the CI-passing event queues one wake for the stalled thread", outboxRow("stalled-thread").length === 1, JSON.stringify(outboxRow("stalled-thread")))
  check("the wake attempts a cold resume", await waitFor(() => startupsWithResume().length > resumesBefore, 10_000, "resume attempt"))
  check("…which dies at startup (the staged failure)", events().some((e) => e.kind === "resume-died"))
  // Past the confirmation window and one retry: enough for the scheduler to notice the death.
  for (let i = 0; i < 5; i++) { await sleep(500); later(61_000); await scheduler.tick() }
  const received = inputsWith("CI PASSED on acme/app#2").length
  const row = outboxRow("stalled-thread")[0]
  const cursor = cursorOf(bad.watchId)
  console.log(`  outbox: ${JSON.stringify(row)}  cursor: ${JSON.stringify(cursor)}  inputs received: ${received}`)
  check("the claude child never received the wake", received === 0, `received=${received}`)
  const lost = row?.state === "delivered" && received === 0
  check(expectBug ? "REPRODUCED: ntwine recorded the wake as delivered anyway" : "ntwine does NOT record an unreceived wake as delivered",
    expectBug ? lost : !lost, `state=${row?.state} attempts=${row?.attempts} error=${row?.last_error ?? "-"}`)
  check(expectBug ? "REPRODUCED: the watcher's cursor moved past the event, so it can never be re-reported" : "the event is still reportable or was retried",
    expectBug ? cursor?.checks?.startsWith("bbbbbbb:passing") === true && received === 0 : received > 0 || row?.state !== "delivered",
    `cursor.checks=${cursor?.checks}`)
  // Recovery: the failure was transient (the human's message later resumed the same session fine).
  rmSync(failFlag, { force: true })
  for (let i = 0; i < 16; i++) { await sleep(500); later(61_000); await scheduler.tick() }
  const recovered = inputsWith("CI PASSED on acme/app#2").length
  check(expectBug ? "REPRODUCED: once resume works again, nothing re-sends the lost wake" : "once resume works again, the wake is re-sent and received",
    expectBug ? recovered === 0 : recovered >= 1, `received after recovery=${recovered}`)
  const finalRow = outboxRow("stalled-thread")[0]
  check(expectBug ? "REPRODUCED: the outbox never learned the wake was lost" : "…and the outbox reads delivered only after it actually was",
    expectBug ? !logs.some((m) => m.includes("wake LOST")) : finalRow?.state === "delivered" && logs.some((m) => m.includes("wake LOST")),
    `state=${finalRow?.state} attempts=${finalRow?.attempts}`)
} finally {
  console.log(`  capture: ${events().map((e) => e.kind === "user-input" ? `input(${String(e.text).slice(0, 24)}…)` : e.kind === "startup" ? `startup(${e.argv.includes("--resume") ? "resume" : "fresh"})` : e.kind).join(" ")}`)
  try { await scheduler.stop() } catch {}
  for (const slug of ["healthy-thread", "stalled-thread"]) {
    const row = storage.getSession(slug)
    if (!row) continue
    try { bridge.releaseSession(slug, row.session_id, "session-deleted") } catch {}
    try { const r = recordOf(row.session_id); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
  }
  try { bridge.close() } catch {}
  try { storage.close() } catch {}
  await sleep(300)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${results.length} checks${expectBug ? " (baseline mode: green = bug reproduced)" : ""}`)
process.exit(failed === 0 ? 0 : 1)
