// LIVE REPRO of the maintainer's report, at the ntwine SERVER level (real broker + real tailer + real
// delivery ledger + real transcript projection):
//   nub packages/server/src/backend/_live_broker_dupe.mts
//
// "When two messages are queued at once and they get dequeued simultaneously … they both show up as
//  dequeued in the chat, but also the enqueued versions stick around as well."
//
// Wires exactly what router.followUp does for a broker row: bridge.followUp(...) then
// appendDelivery(state:"enqueued"). Then ticks the tailer (which folds the JSONL into the ledger) and
// dumps readLatestThreadTranscriptPage after each phase, counting how many times each message renders.
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
const stateDir = mkdtempSync(join(tmpdir(), "bdupe-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bdupe-repo-")))
execFileSync("git", ["init", "-q", cwd])

const project: Project = { dir: cwd, id: "dupe", name: "dupe", label: "o/dupe", stateDir, cwdSlug: cwdSlug(cwd) }
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

const slug = "dupe-live"
const sessionId = randomUUID()
const ALPHA = "FOLLOWUP-ALPHA: when you get to this, reply with exactly ALPHA-SEEN."
const BRAVO = "FOLLOWUP-BRAVO: when you get to this, reply with exactly BRAVO-SEEN."

function dump(phase: string): void {
  tailer.tick()
  const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
  const row = storage.getSession(slug)
  const ledger = parseDeliveryLedger(row?.delivery_ledger)
  console.log(`\n──── ${phase}  (${at()}) ────`)
  console.log(`ledger: ${ledger.length ? ledger.map((i) => `${i.text.slice(9, 14)}:${i.state}`).join(" ") : "(empty)"}`)
  for (const m of page.messages) {
    const tag = m.queued ? "QUEUED" : m.role.toUpperCase().padEnd(6)
    console.log(`  ${tag} ${JSON.stringify((m.displayText ?? m.text).slice(0, 70))} src=${m.sourceId ?? "-"}${m.deliveryId ? ` delivery=${m.deliveryId.slice(0, 8)}` : ""}`)
  }
  const count = (needle: string): number => page.messages.filter((m) => m.role === "user" && m.text.includes(needle)).length
  console.log(`  >>> ALPHA renders ${count("FOLLOWUP-ALPHA")}x, BRAVO renders ${count("FOLLOWUP-BRAVO")}x`)
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

  console.log(`${at()} dispatch`)
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd, permissionMode: "bypassPermissions",
    prompt: "Use the Bash tool with run_in_background:true to run `sleep 30`, then use Monitor or repeated Read on the output file until it finishes, then reply with exactly BOOT-DONE.",
  })
  // Wait until the turn is provably mid-tool.
  const deadline = Date.now() + 120_000
  while (results < 1 && Date.now() < deadline) {
    tailer.tick()
    if ((tailer.get(slug)?.turn) === "in-flight" && Date.now() - t0 > 12_000) break
    await new Promise((r) => setTimeout(r, 250))
  }
  dump("before the follow-ups")

  // EXACTLY what router.followUp does for a broker row, twice, back to back.
  console.log(`\n${at()} sending ALPHA + BRAVO back to back`)
  const dA = randomUUID(), dB = randomUUID()
  const tSend = Date.now()
  // deliveryId rides through to the SDK as this input's uuid — exactly what router.followUp does now.
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: ALPHA, deliveryId: dA })
  appendDelivery(storage, slug, { id: dA, text: ALPHA, state: "enqueued" })
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: BRAVO, deliveryId: dB })
  appendDelivery(storage, slug, { id: dB, text: BRAVO, state: "enqueued" })

  dump("immediately after send")

  // Poll until each message has rendered as a REAL (non-queued) bubble — measuring pending→real latency.
  let realAt: number | null = null
  const pollDeadline = Date.now() + 240_000
  while (Date.now() < pollDeadline) {
    tailer.tick()
    const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
    const realA = page.messages.some((m) => m.role === "user" && !m.queued && m.text.includes("FOLLOWUP-ALPHA"))
    const realB = page.messages.some((m) => m.role === "user" && !m.queued && m.text.includes("FOLLOWUP-BRAVO"))
    if (realA && realB) { realAt = Date.now(); break }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`\n${at()} pending→real latency: ${realAt ? `${realAt - tSend}ms` : "NEVER (timed out)"}`)
  dump("once both render as real")

  // Let the whole thing settle, then look again — the duplicate is a STEADY-STATE defect.
  const settleDeadline = Date.now() + 180_000
  while (results < 2 && Date.now() < settleDeadline) { tailer.tick(); await new Promise((r) => setTimeout(r, 250)) }
  await new Promise((r) => setTimeout(r, 3_000))
  dump("after the turn settles")

  const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
  const nA = page.messages.filter((m) => m.role === "user" && m.text.includes("FOLLOWUP-ALPHA")).length
  const nB = page.messages.filter((m) => m.role === "user" && m.text.includes("FOLLOWUP-BRAVO")).length
  ok("ALPHA renders exactly once", nA === 1, `renders ${nA}x`)
  ok("BRAVO renders exactly once", nB === 1, `renders ${nB}x`)
  const leftover = parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger)
  ok("the delivery ledger is empty", leftover.length === 0, `${leftover.length} left: ${leftover.map((i) => i.state).join(",")}`)

  // THE IDENTITY CLAIM, verified end to end through the real bridge: ntwine's deliveryId must come back
  // as the queued_command attachment's source_uuid. That is what makes correlation exact.
  const path = claudeBackend.transcriptPath(sessionId)!
  const echoed = new Map<string, string>()
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Record<string, unknown>
    const att = r.attachment as { type?: string; prompt?: unknown; source_uuid?: unknown } | undefined
    if (att?.type === "queued_command" && typeof att.source_uuid === "string" && typeof att.prompt === "string") {
      echoed.set(att.prompt, att.source_uuid)
    }
    if (r.type === "user" && typeof (r.message as { content?: unknown })?.content === "string" && typeof r.uuid === "string") {
      echoed.set((r.message as { content: string }).content, r.uuid)
    }
  }
  ok("ALPHA's deliveryId came back as the delivery record's id", echoed.get(ALPHA) === dA, `source_uuid=${echoed.get(ALPHA)} deliveryId=${dA}`)
  ok("BRAVO's deliveryId came back as the delivery record's id", echoed.get(BRAVO) === dB, `source_uuid=${echoed.get(BRAVO)} deliveryId=${dB}`)
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
