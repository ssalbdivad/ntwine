// LIVE REPRO, variant C: the SIMULTANEOUS-DEQUEUE shape — two follow-ups queued while the model is
// producing its final TEXT (no tool boundary to inject at), so Claude Code drains the whole queue at
// TURN END into ONE user record joining them with "\n" (N content-less `dequeue`s first).
//   nub packages/server/src/backend/_live_broker_coalesce.mts [same]
//
// This is the shape the maintainer described ("two messages queued at once … dequeued simultaneously")
// and the one the corpus proves ntwine mis-renders. Pass `same` to queue two IDENTICAL texts.
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

const IDENTICAL = process.argv.includes("same")
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bcoal-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bcoal-repo-")))
execFileSync("git", ["init", "-q", cwd])

const project: Project = { dir: cwd, id: "coal", name: "coal", label: "o/coal", stateDir, cwdSlug: cwdSlug(cwd) }
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
let sawAssistantText = false
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    if (event.kind === "result") results++
    if (event.kind === "assistant" && event.text.join("").length > 40) sawAssistantText = true
    ingest.onEvent(slug, sessionId, event)
  },
})
tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
})

const slug = "coal-live"
const sessionId = randomUUID()
const ALPHA = "FOLLOWUP-ONE: acknowledge this by replying with the single word ONE."
const BRAVO = IDENTICAL ? ALPHA : "FOLLOWUP-TWO: acknowledge this by replying with the single word TWO."

function page() { tailer.tick(); return readLatestThreadTranscriptPage(project, storage, slug, backendFor) }
function dump(phase: string): { a: number; b: number; gray: number; joined: number } {
  const p = page()
  const ledger = parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger)
  console.log(`\n──── ${phase}  (${at()}) ────`)
  console.log(`ledger: ${ledger.length ? ledger.map((i) => `${i.text.slice(9, 13)}:${i.state}`).join(" ") : "(empty)"}`)
  for (const m of p.messages) {
    console.log(`  ${(m.queued ? "QUEUED" : m.role.toUpperCase()).padEnd(9)} ${JSON.stringify((m.displayText ?? m.text).slice(0, 78))} src=${m.sourceId ?? "-"}`)
  }
  const users = p.messages.filter((m) => m.role === "user")
  const a = users.filter((m) => m.text.includes("FOLLOWUP-ONE")).length
  const b = users.filter((m) => m.text.includes(IDENTICAL ? "FOLLOWUP-ONE" : "FOLLOWUP-TWO")).length
  const gray = users.filter((m) => m.queued && m.text.includes("FOLLOWUP-")).length
  const joined = users.filter((m) => m.text.includes("FOLLOWUP-ONE") && m.text.includes(IDENTICAL ? "ONE." : "FOLLOWUP-TWO") && m.text.trim() !== ALPHA.trim()).length
  console.log(`  >>> ONE renders ${a}x, ${IDENTICAL ? "ONE(dup)" : "TWO"} renders ${b}x, still-gray=${gray}, joined-copies=${joined}`)
  return { a, b, gray, joined }
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

  console.log(`${at()} dispatch (${IDENTICAL ? "IDENTICAL" : "DISTINCT"} follow-up texts) — a long TEXT-ONLY turn`)
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd, permissionMode: "bypassPermissions",
    prompt: "Without using any tools at all, write me roughly 700 words explaining how a write-ahead log works. Just prose, no tools, no files.",
  })
  // Wait until the model is mid-PROSE — there is no tool boundary here, so anything queued now can
  // only be picked up when the turn ENDS: the coalesced shape.
  const d1 = Date.now() + 120_000
  while (!sawAssistantText && results < 1 && Date.now() < d1) { tailer.tick(); await new Promise((r) => setTimeout(r, 100)) }
  dump("mid-turn, before the follow-ups")

  console.log(`\n${at()} sending both follow-ups back to back`)
  const dA = randomUUID(), dB = randomUUID()
  const tSend = Date.now()
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: ALPHA })
  appendDelivery(storage, slug, { id: dA, text: ALPHA, state: "enqueued" })
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: BRAVO })
  appendDelivery(storage, slug, { id: dB, text: BRAVO, state: "enqueued" })
  dump("immediately after send")

  let realAt: number | null = null
  const d2 = Date.now() + 240_000
  while (Date.now() < d2) {
    const p = page()
    const stillGray = p.messages.some((m) => m.role === "user" && m.queued && m.text.includes("FOLLOWUP-"))
    const anyReal = p.messages.some((m) => m.role === "user" && !m.queued && m.text.includes("FOLLOWUP-"))
    if (anyReal && !stillGray) { realAt = Date.now(); break }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`\n${at()} pending→real latency: ${realAt ? `${realAt - tSend}ms` : "NEVER (still gray at timeout)"}`)

  const d3 = Date.now() + 240_000
  while (results < 2 && Date.now() < d3) { tailer.tick(); await new Promise((r) => setTimeout(r, 250)) }
  await new Promise((r) => setTimeout(r, 3_000))
  const c = dump("after the follow-up turn settles")

  ok("no follow-up bubble is still gray", c.gray === 0, `${c.gray} gray`)
  ok("no extra joined copy rendered", c.joined === 0, `${c.joined} joined`)
  ok("ONE renders exactly once", c.a === (IDENTICAL ? 2 : 1), `renders ${c.a}x`)
  if (!IDENTICAL) ok("TWO renders exactly once", c.b === 1, `renders ${c.b}x`)
  const leftover = parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger)
  ok("the delivery ledger is empty", leftover.length === 0, `${leftover.length} left`)

  console.log("\n──── raw queue/delivery records ────")
  const path = claudeBackend.transcriptPath(sessionId)!
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Record<string, unknown>
    const att = r.attachment as { type?: string; prompt?: unknown; source_uuid?: unknown } | undefined
    if (r.type === "queue-operation") console.log(`  ${String(r.timestamp).slice(11, 23)} queue/${String(r.operation)} ${JSON.stringify(String(r.content ?? "").slice(0, 80))}`)
    else if (att?.type === "queued_command") console.log(`  ${String(r.timestamp).slice(11, 23)} ATTACH source_uuid=${String(att.source_uuid)} ${JSON.stringify(String(att.prompt).slice(0, 60))}`)
    else if (r.type === "user" && typeof (r.message as { content?: unknown })?.content === "string") console.log(`  ${String(r.timestamp).slice(11, 23)} USER uuid=${String(r.uuid)} ${JSON.stringify(String((r.message as { content: string }).content).slice(0, 110))}`)
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
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
