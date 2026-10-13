// LIVE end-to-end test of the seam the artifact e2e caught: broker daemon → socket → bridge.onEvent
//   → claude-runtime-ingest → tailer.nudge → a tick that folds the record.
//   nub packages/server/src/backend/_live_broker_ingest.mts
//
// The unit + integration tests cover ingest→tailer with a scripted provider, and
// _live_broker_bridge.mts covers daemon→bridge.onEvent with real claude. NOTHING covered the two
// joined together against a real session, and that is exactly where the promoted-artifact
// measurement showed the latency staying at the 1s poll cadence instead of dropping to the nudge.
//
// It wires the graph the way context.ts does — ingest constructed BEFORE the tailer, tailer late-bound
// — so a wiring-order bug reproduces here rather than only in a promoted build.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bingest-state-"))
// REALPATH: claude slugifies the resolved cwd, so a /var/folders temp dir lands under
// -private-var-folders-… . A fixture that skips this points the tailer at an empty log dir and the
// fold silently sees nothing — which reads exactly like the bug under test.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bingest-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (kind?: string): AgentBackend => claudeBackend

let ticks = 0
let nudges = 0
let nudgeErrors: unknown[] = []

// EXACTLY context.ts's construction order: the ingest is built first (the bridge takes its handler),
// and its nudge target is a tailer that does not exist yet.
let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({
  nudge: () => {
    nudges++
    try { tailer.nudge?.() } catch (e) { nudgeErrors.push(e) }
  },
})

const events: string[] = []
const trace: string[] = []
let tPathG: string | null = null
const sizeNow = () => { try { return statSync(tPathG!).size } catch { return -1 } }
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => { events.push(event.kind); trace.push(`t+${Date.now() - t0}ms event=${event.kind} transcriptBytes=${sizeNow()}`); ingest.onEvent(slug, sessionId, event) },
})

const allSessions = storage.allSessions.bind(storage)
storage.allSessions = ((...a: Parameters<typeof allSessions>) => { ticks++; return allSessions(...a) }) as typeof storage.allSessions

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {},
  paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
})

const slug = "ingest-live"
const sessionId = randomUUID()
const t0 = Date.now()
try {
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick() // prime
  ticks = 0

  tPathG = claudeBackend.transcriptPath(sessionId)!
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: "Reply with exactly LIVE-OK then stop. Do not use any tools." })

  // Wait for the SDK to report the turn settled — the event stream, not the disk.
  const deadline = Date.now() + 120_000
  while (ingest.liveness(sessionId)?.turn !== "settled" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  const tSettled = Date.now()
  console.log("      --- event vs disk trace ---")
  for (const line of trace) console.log("      " + line)
  console.log(`      t+${Date.now() - t0}ms (settled) transcriptBytes=${sizeNow()}`)
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 25)); console.log(`      t+${Date.now() - t0}ms transcriptBytes=${sizeNow()} foldedLast=${JSON.stringify(tailer.get(slug)?.lastAssistant)}`) }
  ok("events reached bridge.onEvent", events.length > 0, `${events.length} events: ${[...new Set(events)].join(",")}`)
  ok("ingest folded them", (ingest.liveness(sessionId)?.events ?? 0) > 0, `events=${ingest.liveness(sessionId)?.events}`)
  ok("ingest called nudge", nudges > 0, `${nudges} nudges`)
  ok("no nudge threw", nudgeErrors.length === 0, nudgeErrors.map(String).join("; "))

  // Give the nudge timer room to run its tick(s) — but far less than the 1000ms poll floor, so a
  // pass here cannot be the ordinary poll in disguise. This tailer was never start()ed, so the poll
  // loop is NOT running at all: any tick here came from a nudge.
  await new Promise((r) => setTimeout(r, 300))
  ok("nudge drove real ticks with no poll loop running", ticks > 0, `${ticks} registry reads`)

  // And the payoff: did the fold catch the finished turn within a nudge's worth of time?
  const tPath = claudeBackend.transcriptPath(sessionId)!
  const seen: string[] = []
  for (let i = 0; i < 40; i++) {
    const st = (() => { try { return statSync(tPath).size } catch { return -1 } })()
    seen.push(`+${Date.now() - tSettled}ms size=${st} turn=${tailer.get(slug)?.turn} last=${JSON.stringify(tailer.get(slug)?.lastAssistant)}`)
    if (st > 0 && tailer.get(slug)?.lastAssistant) break
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log("      transcript:", tPath)
  console.log("      " + seen.filter((_, i) => i % 4 === 0 || i === seen.length - 1).join("\n      "))
  const tele = tailer.get(slug)
  const elapsed = Date.now() - tSettled
  ok("tailer folded the turn to idle", tele?.turn === "idle", `turn=${tele?.turn} lastAssistant=${JSON.stringify(tele?.lastAssistant)} after ${elapsed}ms`)
  ok("the agent's reply reached telemetry", String(tele?.lastAssistant ?? "").includes("LIVE-OK"), JSON.stringify(tele?.lastAssistant))
} catch (e) {
  failures++
  console.log("FAIL  harness threw —", e)
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
