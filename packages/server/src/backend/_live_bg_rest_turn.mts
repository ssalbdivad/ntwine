// LIVE PROBE: what does the TURN look like when the parent dispatches a BACKGROUND sub-agent and then
// RESTS immediately — the exact shape a ntwine worker uses, and the one the board renders as a shimmer?
//   nub packages/server/src/backend/_live_bg_rest_turn.mts
//
// Reported symptom (2026-07-30): a thread whose own turn ended ~55 min ago (`stop_reason: "end_turn"`,
// `rested_at` set) with two live sub-agents renders `runtime: "running"` — the "Working…" shimmer —
// instead of the AwaitingBackgroundCard. `deriveAwaitingBackground` needs `turn-idle`, so the card can
// never appear while the turn is wrongly in-flight.
//
// The suspected mechanism is `turnSignal` in claude-runtime-ingest.ts: EVERY assistant/user event maps
// to "running", including a CHILD's (parentToolUseId set), and `resolveRuntimeTurn` lets a runtime
// "running" override a folded "idle". This probe settles the two things reading cannot:
//
//   Q1. Does the SDK emit `result` (→ "settled") when the parent's turn ends while a background child
//       is still running, or does it withhold it until the child finishes?
//   Q2. After that `result`, do the child's own assistant/user events flip liveness back to "running"
//       and drag the folded `idle` back to `in-flight`?
//
// It prints the raw event tape first. Read the tape; the PASS/FAIL lines are only a summary.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
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

const RUN_MS = Number(process.env.PROBE_RUN_MS ?? 210_000)

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bgrest-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bgrest-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const logDir = defaultLogDir(project)
const claudeBackend = createClaudeBackend({ claudeBin, logDir })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })

const t0 = Date.now()
const rel = () => `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`

// The raw event tape: every event, in ARRIVAL order (pushed synchronously so the order is the wire
// order), with the ONE field the hypothesis turns on — and the liveness the fold produced for it,
// filled in once the ingest worker has drained.
interface TapeEntry { at: string; kind: string; parent: string; extra: string; liveness?: string }
const tape: TapeEntry[] = []

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    const entry: TapeEntry = {
      at: rel(),
      kind: event.kind,
      parent: (event as { parentToolUseId?: string }).parentToolUseId ?? "(main)",
      extra: event.kind === "task"
        ? ` phase=${event.phase} status=${event.status ?? "-"} desc=${JSON.stringify(event.description ?? "").slice(0, 40)}`
        : event.kind === "assistant"
          ? ` tools=${event.toolUses.map((u) => u.name).join(",") || "-"}`
          : "",
    }
    tape.push(entry)
    ingest.onEvent(slug, sessionId, event)
    // The ingest worker folds asynchronously, so read the reading it produced after a drain rather
    // than before — otherwise every line reports the PREVIOUS event's state.
    void ingest.drain().then(() => { entry.liveness = ingest.liveness(sessionId)?.turn })
  },
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "bgrest-live"
const sessionId = randomUUID()

// THE WORKLOAD — the ntwine worker shape verbatim: background dispatch, then REST without waiting.
const PROMPT = [
  "Dispatch ONE sub-agent with the Agent tool and `run_in_background: true`, description exactly `SLOW-CHILD`.",
  "Its task, verbatim: \"Run `sleep 100` with Bash (set the timeout parameter to 150000), then run `date`, then reply exactly CHILD-DONE.\"",
  "Do NOT wait for it and do NOT poll it. The moment the dispatch tool returns, reply with exactly DISPATCHED-AND-RESTING and end your turn.",
].join("\n")

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  // THE WINDOW under test: from the parent's own `result` (it rested) until its child goes away. Every
  // sample taken inside it is what the board would have rendered for a rested thread with live children.
  const timeline: string[] = []
  const window: Array<{ at: string; turn: string | undefined }> = []
  const deadline = Date.now() + RUN_MS
  while (Date.now() < deadline) {
    tailer.tick()
    const tele = tailer.get(slug)
    const live = (tele?.subAgents ?? []).filter((v) => v.state === "running")
    const body = `boardTurn=${tele?.turn} liveness=${ingest.liveness(sessionId)?.turn ?? "-"} lastAssistantAt=${tele?.lastAssistantAt ?? "-"} liveChildren=${live.length}`
    if (timeline.at(-1)?.slice(7) !== body) timeline.push(`${rel()} ${body}`)
    if (tape.some((e) => e.kind === "result") && live.length > 0) window.push({ at: rel(), turn: tele?.turn })
    await sleep(1_000)
  }

  await ingest.drain()
  console.log("\n      --- RAW EVENT TAPE (wire order) ---")
  for (const e of tape) console.log(`      ${e.at} ${e.kind.padEnd(10)} parent=${e.parent}${e.extra}  → liveness=${e.liveness ?? "-"}`)

  console.log("\n      --- BOARD TIMELINE (deduped) ---")
  for (const line of timeline) console.log("      " + line)

  // ---- the questions ----
  const resultIdx = tape.findIndex((e) => e.kind === "result")
  ok("Q1 the SDK emits `result` while a background child is still running",
    resultIdx >= 0, resultIdx >= 0 ? `first result at tape index ${resultIdx} (${tape[resultIdx].at})` : "no result event ever arrived")
  const afterResult = resultIdx >= 0 ? tape.slice(resultIdx + 1) : []
  const childAfterResult = afterResult.filter((e) => e.parent !== "(main)" && (e.kind === "assistant" || e.kind === "user"))
  ok("Q2 CHILD assistant/user events keep arriving AFTER the parent's result",
    childAfterResult.length > 0, `${childAfterResult.length} such events`)
  // Q2b is the fix itself, at the ingest. On the 2026-07-30 control run (before the turnSignal change)
  // EVERY one of these flipped the reading back to "running" — the first only 40ms after the parent's
  // own `result`. They must now leave it settled: a child says nothing about its parent's turn.
  ok("Q2b …and they leave the parent's reading SETTLED",
    childAfterResult.every((e) => e.liveness === "settled"),
    `${childAfterResult.filter((e) => e.liveness !== "settled").length} of ${childAfterResult.length} moved it`)
  // THE FIX, stated as the board reading the operator actually sees. BEFORE the turnSignal fix this
  // window was 100% "in-flight" (118 consecutive samples in the 2026-07-30 run, saved alongside as the
  // control); AFTER it every sample must read "idle" — the rest that lets deriveAwaitingBackground fire.
  const inFlight = window.filter((s) => s.turn === "in-flight")
  console.log(`\n      window samples (parent rested + child live): ${window.length}, of which in-flight: ${inFlight.length}`)
  ok("the board rests while a background child runs (no shimmer)",
    window.length > 0 && inFlight.length === 0,
    window.length === 0 ? "the window never opened — the workload did not reproduce the shape" : `first bad sample ${JSON.stringify(inFlight[0] ?? null)}`)
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { ingest.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  console.log(`\n      (log dir left in place for inspection: ${logDir}${existsSync(logDir) ? "" : " — MISSING"})`)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
