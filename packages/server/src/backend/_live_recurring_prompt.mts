// LIVE END-TO-END: an operator's stop hook bumps a REAL resting agent at every rest, and the
// agent's own AWAITING stops it.
//   nub packages/server/src/backend/_live_stop_hook.mts
//
// This is the proof for the feature, and the THIRD assertion is the one that matters. A stop hook
// with no terminating condition is an infinite bump generator, so what has to be shown is not "ntwine can
// re-send text" but the whole handshake: bump at rest → agent works → bump again at the NEXT rest →
// agent says there is nothing left → ntwine goes quiet and STAYS quiet.
//
// Everything in the chain is the shipping thing: real `claude` broker session → real tailer fold (which
// is where the sentinel is recognized) → real scheduler pass → real broker followUp → real agent turn.
//
// WHAT IS SIMULATED, AND WHY THAT IS THE RIGHT LINE. The prompt is armed by writing the session row
// directly (storage.setStopHookIfCurrent) rather than by clicking the footer popover. The click →
// RPC half is a typed router mutation checked by the rpc-contract drift gate and by stop-hook
// tests; what only a live run can prove is the half below — that a real agent receives the bump at rest,
// acts on it, receives another at its next rest, and that its own sentinel closes the loop.
//
// The rate floor is defeated deliberately (each stage re-arms with a fresh generation, which drops the
// last-fired stamp) so the probe does not spend 30s per bump proving a constant.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "stophook-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "stophook-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const workFile = join(cwd, "work.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Lines the agent has appended — one per bump it acted on. Read from OUTSIDE the agent. */
const lines = (): string[] =>
  existsSync(workFile) ? readFileSync(workFile, "utf8").trim().split("\n").filter(Boolean) : []

const project: Project = { dir: cwd, id: "sp", name: "sp", label: "o/sp", stateDir, cwdSlug: cwdSlug(cwd) }
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

const slug = "stophook-live"
const delivered: string[] = []
const scheduler = createScheduler({
  storage, tailer,
  resume: async (s, message) => {
    delivered.push(message)
    await bridge.followUp({ threadSlug: s, sessionId, cwd, text: message })
  },
  log: (m) => console.log(`    ${m}`),
})

// A stop-hook instruction with a REAL exhaustion point, so the sentinel is the agent's own judgement
// rather than something the probe told it to print on a schedule. Three items, one per bump.
const RECURRING_TEXT = [
  `There is a checklist at ${join(cwd, "todo.txt")}.`,
  `Do the FIRST unfinished item on it: append that item's line to ${workFile}, then mark it done in the checklist by prefixing its line with DONE.`,
  "Do exactly one item, then stop. If every item is already marked DONE, do nothing at all.",
].join(" ")

/** Arm (or re-arm) the ON REST trigger as of NOW, which also drops its last-fired stamp. */
const arm = (): void => {
  storage.setRecurringPromptIfCurrent(slug, sessionId, 0, {
    prompt: RECURRING_TEXT,
    stopHook: true,
    heartbeat: false,
    postCompaction: false,
    intervalMs: null,
    armedAt: new Date().toISOString(),
  })
}
/** Drive the real scheduler until it has delivered `want` bumps, or the window closes. */
const pump = async (want: number, windowMs: number): Promise<void> => {
  const by = Date.now() + windowMs
  while (Date.now() < by && delivered.length < want) {
    tailer.tick()
    await scheduler.tick()
    await sleep(2_000)
  }
}
/** Wait for the thread to be folded as resting. */
const restBy = async (windowMs: number): Promise<boolean> => {
  const by = Date.now() + windowMs
  while (Date.now() < by) {
    tailer.tick()
    if (tailer.get(slug)?.turn === "idle") return true
    await sleep(2_000)
  }
  return false
}

try {
  execFileSync("bash", ["-c", `printf '%s\\n' alpha bravo > ${join(cwd, "todo.txt")}`])

  // Boot a real session that comes to rest having done nothing — the state an operator is looking at
  // when they reach for this control.
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: "Reply with exactly READY and do nothing else. Do not read or write any files.",
  })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  ok("the live session booted and came to rest", await restBy(180_000), `turn=${tailer.get(slug)?.turn}`)

  // ---- 1. A bump lands at REST, with no interval anywhere in it -----------------------------------
  arm()
  await pump(1, 60_000)
  ok("the scheduler delivered a bump the moment the thread was at rest",
    delivered.length === 1 && delivered[0].includes("checklist"),
    `${delivered.length} delivered`)
  ok("…carrying the operator's words first and the AWAITING trailer after",
    delivered[0]?.startsWith("There is a checklist") && delivered[0]?.includes("AWAITING"),
    JSON.stringify(delivered[0]?.slice(0, 60) ?? ""))

  ok("the AGENT acted on it", await (async () => {
    const by = Date.now() + 240_000
    while (Date.now() < by) {
      await sleep(3_000)
      tailer.tick()
      if (lines().length >= 1) return true
    }
    return false
  })(), `work file: ${JSON.stringify(lines())}`)

  // ---- 2. The NEXT rest bumps again — this is what an interval could never express ----------------
  ok("the thread came to a new rest", await restBy(120_000))
  arm()
  await pump(2, 120_000)
  ok("a SECOND bump was delivered at the next rest", delivered.length >= 2, `${delivered.length} delivered`)
  ok("…and the agent did the second item too", await (async () => {
    const by = Date.now() + 240_000
    while (Date.now() < by) {
      await sleep(3_000)
      tailer.tick()
      if (lines().length >= 2) return true
    }
    return false
  })(), `work file: ${JSON.stringify(lines())}`)

  // ---- 3. THE ASSERTION THAT MATTERS: the agent's own AWAITING stops the loop ----------------------
  // Nothing is left on the checklist, so the next bump must draw an AWAITING — and once the fold sees
  // it, further ticks must deliver NOTHING even though the row is still armed and enabled.
  ok("the thread came to rest again", await restBy(120_000))
  arm()
  await pump(3, 120_000)
  const beforeQuiet = delivered.length

  const closed = await (async () => {
    const by = Date.now() + 240_000
    while (Date.now() < by) {
      await sleep(3_000)
      tailer.tick()
      if (tailer.get(slug)?.lastAssistantAllDone) return true
    }
    return false
  })()
  ok("the agent answered AWAITING once the checklist was exhausted", closed,
    `lastAssistant=${JSON.stringify(tailer.get(slug)?.lastAssistant?.slice(0, 80) ?? "")}`)

  // Re-arm (fresh generation, no rate floor) and pump hard: a stop hook that keeps firing past
  // the sentinel is the failure this whole design exists to prevent.
  arm()
  const quietBy = Date.now() + 45_000
  while (Date.now() < quietBy) {
    tailer.tick()
    await scheduler.tick()
    await sleep(2_000)
  }
  ok("…and ntwine delivered NOTHING further while that AWAITING stood",
    delivered.length === beforeQuiet,
    `${delivered.length - beforeQuiet} bump(s) after the sentinel`)
  ok("the work file holds exactly one line per bump acted on — no runaway",
    lines().length <= 2, JSON.stringify(lines()))

  console.log(`\nrepo        ${cwd}`)
  console.log(`work file   ${workFile}`)
  console.log(`bumps       ${delivered.length}`)
} finally {
  try { await scheduler.stop() } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
