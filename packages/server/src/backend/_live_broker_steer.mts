// LIVE end-to-end test of STEERING A SUB-AGENT through ntwine's OWN chain: a real claude session
// dispatched by the real broker bridge, a real background child, then `bridge.steerSubAgent()` — the
// exact call the subAgentSteer RPC makes — and an assertion that the CHILD (not the parent) obeyed it.
//
//   nub packages/server/src/backend/_live_broker_steer.mts
//
// WHY LIVE. Every claim under this feature is a claim about what a REAL CLI does with a
// `parent_tool_use_id` on an input frame. Unit tests can only prove that ntwine put the id on the wire
// (claude-agent-broker-bridge.steer.test.ts does exactly that against a fake CLI). They cannot prove
// the CLI ROUTES it, and the routing is the entire feature.
//
// SCOPE: this proves routing with the parent AT REST ("reply 'dispatched' and stop" below), which is
// the only regime where the CLI honors the addressing at all. The other regime — the parent MID-TURN,
// where the CLI absorbs the addressed frame into the parent's own running turn — is measured by
// `_live_broker_steer_busy.mts`, and is why subAgentSteerable refuses while the thread is in-flight.
//
// The differential is the point, and it is one variable:
//   · the STEER carries parent_tool_use_id = the child's dispatch tool_use id  → must reach the CHILD
//   · the CONTROL is an ordinary followUp, unaddressed                          → must reach the PARENT
// Each writes a distinct token to a distinct file, so "who obeyed" is a filesystem fact rather than a
// reading of prose. A run where BOTH tokens land in the same place is a FAILURE even if both files
// exist — that is the misdelivery this feature's gate exists to prevent.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
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
const stateDir = mkdtempSync(join(tmpdir(), "steer-state-"))
// REALPATH: claude slugifies the RESOLVED cwd, so a /var/folders temp dir lands under
// -private-var-folders-… . Skipping this points the tailer at an empty log dir and the fold silently
// sees nothing — which reads exactly like the bug under test.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "steer-repo-")))
execFileSync("git", ["init", "-q", cwd])

const CHILD_TOKEN = "CHILDSTEER7742"
const PARENT_TOKEN = "PARENTSTEER9931"
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

// EXACTLY context.ts's construction order — ingest first, tailer late-bound.
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

const slug = "steer-live"
const sessionId = randomUUID()

const CHILD_TASK = [
  "Repeat 20 times: run the Bash command `date`, then run `sleep 4`.",
  "If you receive a NEW message while working, obey it immediately before continuing the loop.",
  "When the loop finishes, reply DONE.",
].join(" ")

const PROMPT = [
  "Use the Agent tool ONCE with subagent_type \"general-purpose\" and run_in_background true,",
  `description "steer target", prompt: "${CHILD_TASK}".`,
  "After dispatching it, do NOT wait for it and do NOT dispatch anything else — reply \"dispatched\" and stop.",
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

  // ---- wait until the TAILER itself reports a live, direct child (the RPC's own precondition) ----
  let childId: string | undefined
  const findDeadline = Date.now() + 180_000
  while (Date.now() < findDeadline) {
    tailer.tick()
    const live = tailer.get(slug)?.subAgents ?? []
    const candidate = live.find((v) => v.id && v.state === "running")
    if (candidate?.id) {
      // The gate the router applies, asserted here against the real tailer rather than a stub.
      const info = tailer.subAgent(slug, candidate.id)
      if (info?.direct && info.state === "running") { childId = candidate.id; break }
    }
    await sleep(1_000)
  }
  ok("ntwine's tailer surfaces a live DIRECT child to steer", Boolean(childId), childId ?? "none found")
  if (!childId) throw new Error("no live child appeared")
  console.log(`${el()} steering child ${childId}`)

  // Let the child get properly into its loop, so the steer lands mid-work rather than during startup.
  await sleep(6_000)

  // ---- THE STEER: the exact call subAgentSteer makes ----
  await bridge.steerSubAgent({
    threadSlug: slug, sessionId, subAgentId: childId,
    text: `${CHILD_TOKEN}: stop the loop right now and run this Bash command immediately: echo ${CHILD_TOKEN} > ${childFile}`,
  })
  console.log(`${el()} steer sent`)

  // ---- THE CONTROL: an ordinary follow-up, unaddressed ----
  await sleep(12_000)
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: `${PARENT_TOKEN}: run this Bash command immediately: echo ${PARENT_TOKEN} > ${parentFile}`,
  })
  console.log(`${el()} control follow-up sent`)

  // ---- wait for both side effects (or the deadline) ----
  const effectDeadline = Date.now() + 150_000
  while (Date.now() < effectDeadline && !(existsSync(childFile) && existsSync(parentFile))) {
    tailer.tick()
    await sleep(1_500)
  }

  console.log(`\n${el()} --- side effects ---`)
  console.log(`  ${childFile}: ${existsSync(childFile) ? readFileSync(childFile, "utf8").trim() : "absent"}`)
  console.log(`  ${parentFile}: ${existsSync(parentFile) ? readFileSync(parentFile, "utf8").trim() : "absent"}`)

  ok("the STEERED child obeyed the addressed message", existsSync(childFile))
  ok("the unaddressed control reached the PARENT", existsSync(parentFile))

  // ---- WHOSE transcript carried which token? The differential, read off the files claude wrote. ----
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
  let childSawControl = false
  console.log("\n  --- transcript membership ---")
  for (const dir of dirs) {
    for (const file of walk(join(projects, dir))) {
      const body = readFileSync(file, "utf8")
      const hasSteer = body.includes(CHILD_TOKEN)
      const hasControl = body.includes(PARENT_TOKEN)
      const isSubagent = file.includes("/subagents/")
      if (hasSteer || hasControl) console.log(`  ${isSubagent ? "CHILD " : "PARENT"} ${file.replace(projects, "…")} (${statSync(file).size}B) steer=${hasSteer} control=${hasControl}`)
      if (isSubagent && hasSteer) childSawSteer = true
      if (isSubagent && hasControl) childSawControl = true
    }
  }
  ok("the steer appears in the CHILD's own transcript", childSawSteer)
  ok("the CONTROL never leaked into the child", !childSawControl)
} finally {
  bridge.releaseSession(slug, sessionId, "session-deleted")
  bridge.close()
  tailer.stop?.()
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}  (stateDir ${stateDir}, cwd ${cwd})`)
}
process.exit(failures === 0 ? 0 : 1)
