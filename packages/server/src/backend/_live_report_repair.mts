// LIVE END-TO-END: a dropped sub-agent report is repaired, and the REAL agent acts on the repair.
//   nub packages/server/src/backend/_live_report_repair.mts
//
// This is the proof for the report-delivery fix. Everything in the chain is the shipping thing:
//   real `claude` broker session → real tailer fold → real scheduler pass → real broker followUp →
//   real agent turn.
//
// WHAT IS SIMULATED, AND WHY THAT IS THE RIGHT LINE. The DROP itself is injected: a
// `queue-operation` record carrying a completed `<task-notification>` is appended to the live
// session's JSONL and no model-facing carrier ever follows it. That is exactly the byte pattern the
// runtime produces when it discards a report (measured 242 times on one production thread, and
// raw-line audited — see report-delivery.ts), and appending to the JSONL is precisely how the runtime
// itself publishes these records. It is simulated because the CAUSE lives upstream in Claude Code's
// own queue, which ntwine neither owns nor can trigger on demand: three attempts to make a real fleet
// drop on command failed for harness reasons (see _live_notify_delivery.mts). What is under test here
// is everything ntwine owns — detect, enqueue, deliver, and whether the agent actually reads the file —
// and every one of those runs for real.
//
// The assertion that matters is the LAST one: not "ntwine sent a message" but "the agent went and read
// the report". A repair the agent ignores is not a fix.
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { createScheduler } from "../scheduler.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

// A token the agent can only produce by opening the report file. Nothing in the repair message
// contains it, so echoing it is proof of a READ rather than of clever inference from the prompt.
const SENTINEL = `REPORT-SENTINEL-${randomUUID().slice(0, 8).toUpperCase()}`
const FAKE_TASK_ID = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "rrepair-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rrepair-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)
const reportPath = join(cwd, "dropped-review.md")

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "rr", name: "rr", label: "o/rr", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
      .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
  ),
  onEvent: (slug, sid, event) => ingest.onEvent(slug, sid, event),
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sid) => ingest.liveness(sid),
  runtimeTasks: (sid) => ingest.tasks(sid),
})

const slug = "report-repair-live"
const delivered: string[] = []
const scheduler = createScheduler({
  storage, tailer,
  // The production seam, wired to the production broker follow-up.
  resume: async (s, message) => {
    delivered.push(message)
    await bridge.followUp({ threadSlug: s, sessionId, cwd, text: message })
  },
  log: (m) => console.log(`    ${m}`),
})

/** The exact record shape the runtime writes when it queues a completion notification. */
function injectDroppedReport(): void {
  const notification = [
    "<task-notification>",
    `<task-id>${FAKE_TASK_ID}</task-id>`,
    `<tool-use-id>toolu_${randomUUID().replace(/-/g, "").slice(0, 22)}</tool-use-id>`,
    `<output-file>${reportPath}</output-file>`,
    "<status>completed</status>",
    `<summary>Agent "Correctness review of the launcher diff" finished</summary>`,
    `<result>${"THE FULL REVIEW BODY. ".repeat(400)}</result>`,
    "</task-notification>",
  ].join("\n")
  appendFileSync(jsonlPath, `${JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    // Stamped in the past so it is immediately past REPORT_REPAIR_AFTER_MS — this probe is testing
    // the repair, not the age floor (which report-delivery.test.ts covers directly).
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    sessionId,
    content: notification,
  })}\n`)
}

try {
  writeFileSync(reportPath, [
    "# Correctness review of the launcher diff",
    "",
    "## Verdict: 2 blocking",
    "",
    `The unique finding token for this review is ${SENTINEL}.`,
    "",
    "1. The cache key omits the platform triple.",
    "2. The fetch path retries on a 404.",
  ].join("\n"))

  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: "Reply with exactly READY and nothing else. Do not use any tools.",
  })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  // Wait for the session to exist and come to rest.
  const bootBy = Date.now() + 180_000
  while (Date.now() < bootBy) {
    await sleep(2_000)
    tailer.tick()
    if (existsSync(jsonlPath) && tailer.get(slug)?.turn === "idle") break
  }
  ok("the live session booted and came to rest", tailer.get(slug)?.turn === "idle", `turn=${tailer.get(slug)?.turn}`)

  injectDroppedReport()
  await sleep(1_000)
  tailer.tick()
  const flagged = tailer.get(slug)?.droppedReports ?? []
  ok("the tailer FLAGGED the dropped report", flagged.some((r) => r.taskId === FAKE_TASK_ID),
    `droppedReports=${JSON.stringify(flagged.map((r) => r.taskId))}`)

  // The real scheduler pass: detect → enqueue → deliver over the real broker.
  await scheduler.tick()
  await sleep(1_000)
  await scheduler.tick()
  ok("the scheduler DELIVERED a repair naming the report file", delivered.some((m) => m.includes(reportPath)),
    delivered.length ? JSON.stringify(delivered[0].slice(0, 160)) : "nothing delivered")

  // THE ASSERTION THAT MATTERS: did the agent go and read it?
  const readBy = Date.now() + 240_000
  let transcript = ""
  while (Date.now() < readBy) {
    await sleep(3_000)
    tailer.tick()
    transcript = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : ""
    if (transcript.includes(SENTINEL)) break
  }
  ok("the AGENT read the report — it echoed a token found only inside the file", transcript.includes(SENTINEL),
    "the sentinel appears nowhere in the repair message, so this can only come from opening the file")

  // Idempotence, end to end: a re-fold of the same transcript must see the repair as delivery.
  tailer.tick()
  const after = tailer.get(slug)?.droppedReports ?? []
  ok("the report RESOLVED after repair — it is not flagged again", !after.some((r) => r.taskId === FAKE_TASK_ID),
    `still flagged: ${JSON.stringify(after.map((r) => r.taskId))}`)

  await scheduler.tick()
  ok("no SECOND repair is ever sent for the same report", delivered.filter((m) => m.includes(FAKE_TASK_ID)).length === 1,
    `${delivered.filter((m) => m.includes(FAKE_TASK_ID)).length} repairs`)

  console.log(`\nsession jsonl  ${jsonlPath}`)
  console.log(`report file    ${reportPath}`)
  console.log(`sentinel       ${SENTINEL}`)
} finally {
  try { await scheduler.stop() } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
