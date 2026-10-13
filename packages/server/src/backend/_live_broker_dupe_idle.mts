// LIVE REPRO, variant B: the maintainer's EXACT scenario — two messages queued at once against an
// IDLE session, which Claude Code dequeues SIMULTANEOUSLY.
//   nub packages/server/src/backend/_live_broker_dupe_idle.mts
//
// Variant A (_live_broker_dupe.mts, mid-turn) passes: the two sends become two `queued_command`
// attachments and render once each. This one exercises the OTHER delivery shape the parser knows
// about — "SHAPE 1", N content-less dequeues followed by ONE user record joining the N queued texts.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { appendDelivery, parseDeliveryLedger } from "../delivery-ledger.ts"
import { readLatestThreadTranscriptPage } from "../transcript.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bdupei-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bdupei-repo-")))
execFileSync("git", ["init", "-q", cwd])

const project: Project = { dir: cwd, id: "dupei", name: "dupei", label: "o/dupei", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (): AgentBackend => claudeBackend

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`
let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch {} } })
let results = 0
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => { if (event.kind === "result") results++; ingest.onEvent(slug, sessionId, event) },
})
tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
})

const slug = "dupei-live"
const sessionId = randomUUID()
const ALPHA = "FOLLOWUP-ALPHA: when you get to this, reply with exactly ALPHA-SEEN."
const BRAVO = "FOLLOWUP-BRAVO: when you get to this, reply with exactly BRAVO-SEEN."

function dump(phase: string): { a: number; b: number } {
  tailer.tick()
  const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
  const ledger = parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger)
  console.log(`\n──── ${phase}  (${at()}) ────`)
  console.log(`ledger: ${ledger.length ? ledger.map((i) => `${i.text.slice(9, 14)}:${i.state}`).join(" ") : "(empty)"}`)
  for (const m of page.messages) {
    console.log(`  ${(m.queued ? "QUEUED" : m.role.toUpperCase()).padEnd(9)} ${JSON.stringify((m.displayText ?? m.text).slice(0, 76))} src=${m.sourceId ?? "-"}`)
  }
  const a = page.messages.filter((m) => m.role === "user" && m.text.includes("FOLLOWUP-ALPHA")).length
  const b = page.messages.filter((m) => m.role === "user" && m.text.includes("FOLLOWUP-BRAVO")).length
  console.log(`  >>> ALPHA renders ${a}x, BRAVO renders ${b}x`)
  return { a, b }
}

try {
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  console.log(`${at()} dispatch a SHORT first turn`)
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd, permissionMode: "bypassPermissions",
    prompt: "Reply with exactly BOOT-DONE and stop. Do not use any tools.",
  })
  const d1 = Date.now() + 120_000
  while (results < 1 && Date.now() < d1) { tailer.tick(); await new Promise((r) => setTimeout(r, 200)) }
  await new Promise((r) => setTimeout(r, 2_000))
  dump("session idle, before the follow-ups")

  // THE SCENARIO: two follow-ups queued at once against an IDLE session.
  console.log(`\n${at()} sending ALPHA + BRAVO back to back (session idle)`)
  const dA = randomUUID(), dB = randomUUID()
  const tSend = Date.now()
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: ALPHA })
  appendDelivery(storage, slug, { id: dA, text: ALPHA, state: "enqueued" })
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: BRAVO })
  appendDelivery(storage, slug, { id: dB, text: BRAVO, state: "enqueued" })
  dump("immediately after send")

  let realAt: number | null = null
  const d2 = Date.now() + 180_000
  while (Date.now() < d2) {
    tailer.tick()
    const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
    const realA = page.messages.some((m) => m.role === "user" && !m.queued && m.text.includes("FOLLOWUP-ALPHA"))
    const realB = page.messages.some((m) => m.role === "user" && !m.queued && m.text.includes("FOLLOWUP-BRAVO"))
    if (realA && realB) { realAt = Date.now(); break }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`\n${at()} pending→real latency: ${realAt ? `${realAt - tSend}ms` : "NEVER (timed out)"}`)

  const d3 = Date.now() + 180_000
  while (results < 2 && Date.now() < d3) { tailer.tick(); await new Promise((r) => setTimeout(r, 200)) }
  await new Promise((r) => setTimeout(r, 3_000))
  const counts = dump("after the turn settles")

  ok("ALPHA renders exactly once", counts.a === 1, `renders ${counts.a}x`)
  ok("BRAVO renders exactly once", counts.b === 1, `renders ${counts.b}x`)
  const leftover = parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger)
  ok("the delivery ledger is empty", leftover.length === 0, `${leftover.length} left: ${leftover.map((i) => i.state).join(",")}`)

  // The raw evidence, so the delivery SHAPE is on the record either way.
  console.log("\n──── raw queue/user records ────")
  const path = claudeBackend.transcriptPath(sessionId)!
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Record<string, unknown>
    if (r.type === "queue-operation" || (r.type === "attachment" && (r.attachment as { type?: string })?.type === "queued_command") ||
        (r.type === "user" && typeof (r.message as { content?: unknown })?.content === "string")) {
      console.log("  " + JSON.stringify(r).slice(0, 420))
    }
  }
  console.log(`\ntranscript: ${path}`)
} catch (err) {
  failures++
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch {}
  try { bridge.close() } catch {}
  try { ingest.close() } catch {}
  try { tailer.stop() } catch {}
  try { storage.close() } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
