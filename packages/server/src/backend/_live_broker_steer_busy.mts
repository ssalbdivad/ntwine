// LIVE measurement of the MID-TURN steer misdelivery — the regime `_live_broker_steer.mts` never
// covered, and the one the operator actually hit (2026-09-02, thread 537f480c on nub: a steer typed
// into a running child's drawer landed in the PARENT's conversation).
//
//   nub packages/server/src/backend/_live_broker_steer_busy.mts
//
// The original script proved addressed routing with the parent IDLE ("reply 'dispatched' and stop"),
// and that is the only regime it proved. This one holds the parent MID-TURN: it dispatches the same
// background child, then keeps the parent busy in a work loop while the steer goes out. What the CLI
// (2.1.251) does with an addressed input while a main-thread turn is in flight is the entire question:
//
//   · measured here: the frame is ENQUEUED on the main input queue (`queue-operation` enqueue in the
//     parent JSONL) and then ABSORBED into the parent's own running turn (`reason:"absorbed_mid_turn"`)
//     — the `parent_tool_use_id` addressing is dropped, the PARENT obeys the text, and the child never
//     sees a byte of it.
//
// This script calls `bridge.steerSubAgent` DIRECTLY — deliberately below the router's
// `subAgentSteerable` gate — so it stays a measurement of provider truth even after that gate learns
// to refuse the mid-turn case. If a future CLI starts routing the addressed frame to the child
// mid-turn, this script is what proves the gate can be relaxed.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs"
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
const stateDir = mkdtempSync(join(tmpdir(), "steerbusy-state-"))
// REALPATH: claude slugifies the RESOLVED cwd — see _live_broker_steer.mts.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "steerbusy-repo-")))
execFileSync("git", ["init", "-q", cwd])

const STEER_TOKEN = "MIDTURNSTEER4471"
const childFile = join(cwd, "child-obeyed.txt")
const parentFile = join(cwd, "parent-obeyed.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const el = () => `t+${Math.round((Date.now() - t0) / 1000)}s`

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })

const bridge = createClaudeAgentBrokerBridge({
  stateDir,
  executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => ingest.onEvent(slug, sessionId, event),
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {},
  paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "steer-busy-live"
const sessionId = randomUUID()

const CHILD_TASK = [
  "Repeat 20 times: run the Bash command `date`, then run `sleep 4`.",
  "If you receive a NEW message while working, obey it immediately before continuing the loop.",
  "When the loop finishes, reply DONE.",
].join(" ")

// The one variable versus _live_broker_steer.mts: the parent KEEPS WORKING after the dispatch, so the
// steer arrives while its main-thread turn is in flight.
const PROMPT = [
  "Use the Agent tool ONCE with subagent_type \"general-purpose\" and run_in_background true,",
  `description "steer target", prompt: "${CHILD_TASK}".`,
  "After dispatching it, do NOT wait for it. Instead, YOU must keep working: repeat 25 times — run the",
  "Bash command `date`, then `sleep 4`. Do not stop early. When your own loop finishes, reply DONE.",
].join(" ")

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

  // ---- wait until the tailer reports a live, direct child (the RPC's own precondition) ----
  let childId: string | undefined
  const findDeadline = Date.now() + 180_000
  while (Date.now() < findDeadline) {
    tailer.tick()
    const live = tailer.get(slug)?.subAgents ?? []
    const candidate = live.find((v) => v.id && v.state === "running")
    if (candidate?.id) {
      const info = tailer.subAgent(slug, candidate.id)
      if (info?.direct && info.state === "running") { childId = candidate.id; break }
    }
    await sleep(1_000)
  }
  ok("ntwine's tailer surfaces a live DIRECT child to steer", Boolean(childId), childId ?? "none found")
  if (!childId) throw new Error("no live child appeared")

  // Let both loops get going, then confirm the regime under test actually holds: the PARENT's own
  // main-thread turn must be in flight when the steer goes out — this reading is the exact signal the
  // router's gate consults, so asserting it here also proves the gate has a signal to read.
  await sleep(6_000)
  tailer.tick()
  const turnAtSteer = tailer.get(slug)?.turn
  ok("the parent's main thread reads in-flight at steer time", turnAtSteer === "in-flight", `turn=${turnAtSteer}`)

  // ---- THE STEER, addressed to the child, while the parent is mid-turn ----
  await bridge.steerSubAgent({
    threadSlug: slug, sessionId, subAgentId: childId,
    text: `${STEER_TOKEN}: stop your loop right now and run this Bash command immediately: echo ${STEER_TOKEN} > ${childFile}. Do not create ${parentFile}.`,
  })
  console.log(`${el()} steer sent (parent mid-turn)`)

  // ---- watch for either side effect, and give the absorb time to play out ----
  const effectDeadline = Date.now() + 200_000
  while (Date.now() < effectDeadline && !existsSync(childFile) && !existsSync(parentFile)) {
    tailer.tick()
    await sleep(1_500)
  }
  // Whoever obeyed writes childFile (only the CHILD was told to); the parent absorbing the text tends
  // to run the echo too — either way the transcripts below say who actually received it.
  await sleep(10_000)

  console.log(`\n${el()} --- side effects ---`)
  console.log(`  ${childFile}: ${existsSync(childFile) ? readFileSync(childFile, "utf8").trim() : "absent"}`)
  console.log(`  ${parentFile}: ${existsSync(parentFile) ? readFileSync(parentFile, "utf8").trim() : "absent"}`)

  // ---- WHERE did the steer land? Read the transcripts claude wrote. ----
  const projects = join(process.env.HOME!, ".claude", "projects")
  const dirs = readdirSync(projects).filter((d) => d.includes(cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "")))
  const walk = (p: string, depth = 0): string[] => {
    if (depth > 3) return []
    const out: string[] = []
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) out.push(...walk(full, depth + 1))
      else if (entry.name.endsWith(".jsonl")) out.push(full)
    }
    return out
  }
  let childSawSteer = false
  let parentEnqueued = false
  let parentAbsorbed = false
  console.log("\n  --- transcript membership ---")
  for (const dir of dirs) {
    for (const file of walk(join(projects, dir))) {
      const body = readFileSync(file, "utf8")
      const isSubagent = file.includes("/subagents/")
      if (!body.includes(STEER_TOKEN)) continue
      if (isSubagent) childSawSteer = true
      else {
        for (const line of body.split("\n")) {
          if (!line.includes(STEER_TOKEN)) continue
          if (line.includes('"queue-operation"') && line.includes('"enqueue"')) parentEnqueued = true
          if (line.includes("absorbed_mid_turn")) parentAbsorbed = true
        }
      }
      console.log(`  ${isSubagent ? "CHILD " : "PARENT"} ${file.replace(projects, "…")} carries the steer token`)
    }
  }

  // THE MEASUREMENT. These assert the CLI's current (broken) behavior, so a run where the child DOES
  // get the steer is a "failure" here — and the best possible news: it means the CLI routes addressed
  // frames mid-turn now, and the router's mid-turn refusal can be retired.
  ok("MISDELIVERY: the parent's main queue enqueued the addressed steer", parentEnqueued)
  ok("MISDELIVERY: the steer was absorbed into the parent's own turn", parentAbsorbed)
  ok("MISDELIVERY: the child never saw the steer", !childSawSteer)
} finally {
  bridge.releaseSession(slug, sessionId, "session-deleted")
  bridge.close()
  tailer.stop?.()
  console.log(`\n${failures === 0 ? "ALL PASS (misdelivery reproduced — the mid-turn gate is justified)" : `${failures} FAILURE(S) — re-measure before trusting the gate`}  (stateDir ${stateDir}, cwd ${cwd})`)
}
process.exit(failures === 0 ? 0 : 1)
