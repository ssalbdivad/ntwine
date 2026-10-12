// LIVE probe: can frizz deliver an operator's message to a sub-agent that has already FINISHED,
// directly, without asking the parent model to relay it with SendMessage?
//
//   nub packages/server/src/backend/_live_broker_steer_rested.mts
//
// WHY. The model-side path works: a parent's `SendMessage` to a stopped child resumes it from its
// transcript ("Resuming agent …", `resumedAgentId`), and tailer.ts trackResumes folds that revival.
// The operator-side path is the addressed input frame (`parent_tool_use_id`) that `steerSubAgent`
// writes, and router.ts subAgentSteerable refuses it for a settled child because an earlier
// measurement saw the CLI fall it back onto the MAIN thread. The SDK exposes no control request that
// resumes a task (stop_task is the only per-task control), so the addressed frame is the one direct
// channel there is. This probe re-measures it on the CLI frizz runs today, with both handles the
// frame could carry:
//
//   · P1 — parent_tool_use_id = the child's DISPATCH tool_use id (what steerSubAgent sends today)
//   · P2 — parent_tool_use_id = the child's RUNTIME agent id (the id SendMessage addresses)
//
// Each probe asks for a distinct token written to a distinct file, so "who obeyed" is read off the
// transcripts claude wrote — the child's own `subagents/agent-*.jsonl` versus the parent's session
// file — rather than off prose. A probe "reaches the child" only when the token lands in the CHILD's
// transcript; a file written by the PARENT is the misdelivery the router's gate exists to prevent.
//
// MEASURED 2026-10-09 on Claude Code 2.1.295: BOTH probes misdeliver. Each token landed only in the
// parent's session file, the parent ran the command itself (it did not relay with SendMessage), the
// child's `agent-*.jsonl` did not grow by a byte, and the child never reappeared live. The child's
// transcript was present and carried its own CHILDREADY reply, so the zero is a real zero rather than
// a probe that looked in the wrong place. There is therefore no direct operator channel to a settled
// child: only the parent model's SendMessage resumes one.
//
// The one direct alternative that DID work is a FORK, not a steer: copying the child's records into a
// new session file (fresh sessionId, isSidechain false, agentId dropped) and `claude -p --resume <new>`
// continued the child's context — it named its own first command and final reply, where a fresh
// session with no history answered UNKNOWN. That copy is a different session: the parent never hears
// from it, a later SendMessage resume of the real child does not see what it did, and nothing carries
// the child's agent type, model or tool limits across. It also leans on the transcript's undocumented
// record shape; the SDK only reads sub-agent transcripts (getSubagentMessages, listSubagents).
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
const claudeVersion = execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "steer-rested-state-"))
// REALPATH: claude slugifies the RESOLVED cwd (see _live_broker_steer.mts).
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "steer-rested-repo-")))
execFileSync("git", ["init", "-q", cwd])

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

const slug = "steer-rested-live"
const sessionId = randomUUID()

const PROMPT = [
  "Use the Agent tool ONCE with subagent_type \"general-purpose\" and run_in_background true,",
  "description \"rested target\", prompt: \"Run the Bash command `sleep 6`, then reply CHILDREADY and stop.",
  "If you are later given a new instruction, carry it out exactly.\".",
  "After dispatching it, do NOT wait for it — reply \"dispatched\" and stop.",
  "When it later reports back, reply \"noted\" and stop. Do not message it yourself, ever.",
].join(" ")

const projects = join(process.env.HOME!, ".claude", "projects")
const walk = (p: string, depth = 0): string[] => {
  if (depth > 3 || !existsSync(p)) return []
  const out: string[] = []
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, depth + 1))
    else if (entry.name.endsWith(".jsonl")) out.push(full)
  }
  return out
}
const sessionFiles = () => readdirSync(projects).filter((d) => d === cwdSlug(cwd) || d.includes(cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, ""))).flatMap((d) => walk(join(projects, d)))
const childFiles = () => sessionFiles().filter((f) => f.includes("/subagents/"))
// Which transcripts carry a token, and does the parent's own record show it calling SendMessage?
function membership(token: string) {
  const out: { child: boolean; parent: boolean; parentUsedSendMessage: boolean } = { child: false, parent: false, parentUsedSendMessage: false }
  for (const file of sessionFiles()) {
    const body = readFileSync(file, "utf8")
    if (!body.includes(token)) continue
    if (file.includes("/subagents/")) out.child = true
    else {
      out.parent = true
      for (const line of body.split("\n")) if (line.includes(token) && line.includes("\"name\":\"SendMessage\"")) out.parentUsedSendMessage = true
    }
  }
  return out
}

const turnOf = () => tailer.get(slug)?.turn
async function waitRest(label: string, ms = 240_000) {
  const deadline = Date.now() + ms
  let restedFor = 0
  while (Date.now() < deadline) {
    tailer.tick()
    restedFor = turnOf() === "in-flight" ? 0 : restedFor + 1
    const live = (tailer.get(slug)?.subAgents ?? []).filter((v) => v.state === "running")
    if (restedFor >= 4 && live.length === 0) return true
    await sleep(1_500)
  }
  console.log(`${el()} ${label}: did not come to rest (turn=${turnOf()})`)
  return false
}

const results: Record<string, unknown> = { claudeVersion }
try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  // ---- capture BOTH handles while the child is live ----
  let dispatchId: string | undefined
  let taskId: string | undefined
  const findDeadline = Date.now() + 180_000
  while (Date.now() < findDeadline && !(dispatchId && taskId)) {
    tailer.tick()
    const c = (tailer.get(slug)?.subAgents ?? []).find((v) => v.id)
    if (c?.id) { dispatchId = c.id; taskId = c.taskId ?? taskId }
    await sleep(1_000)
  }
  console.log(`${el()} child dispatch=${dispatchId} task=${taskId}`)
  if (!dispatchId || !taskId) throw new Error("never saw the child with both handles")
  results.dispatchId = dispatchId
  results.taskId = taskId

  // ---- let it FINISH, and let the parent take its notification turn and rest ----
  if (!(await waitRest("after child completion"))) throw new Error("thread never rested after the child finished")
  const settled = tailer.subAgent(slug, dispatchId)
  console.log(`${el()} child settled: state=${settled?.state} outcome=${settled?.outcome} direct=${settled?.direct}`)
  results.settled = settled

  for (const [name, handle] of [["P1-dispatch-id", dispatchId], ["P2-agent-id", taskId]] as const) {
    const token = `RESTED${name.replace(/[^A-Z0-9]/g, "")}${Math.floor(Math.random() * 9000 + 1000)}`
    const file = join(cwd, `${name}.txt`)
    const childSizes = new Map(childFiles().map((f) => [f, statSync(f).size]))
    let sendError: string | undefined
    try {
      await bridge.steerSubAgent({
        threadSlug: slug, sessionId, subAgentId: handle,
        text: `${token}: run this Bash command now, then reply with the word done: echo ${token} > ${file}`,
      })
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err)
    }
    console.log(`${el()} ${name} sent (handle ${handle})${sendError ? ` — REFUSED: ${sendError}` : ""}`)
    // Did the child come back to life on the board?
    let revived = false
    const effDeadline = Date.now() + 120_000
    while (Date.now() < effDeadline && !sendError) {
      tailer.tick()
      if ((tailer.get(slug)?.subAgents ?? []).some((v) => v.state === "running")) revived = true
      if (existsSync(file) && turnOf() !== "in-flight") break
      await sleep(1_500)
    }
    await waitRest(`${name} settle`)
    const grew = childFiles().filter((f) => statSync(f).size > (childSizes.get(f) ?? 0)).length
    const m = membership(token)
    const r = { sendError, fileWritten: existsSync(file), tokenInChildTranscript: m.child, tokenInParentTranscript: m.parent, parentRelayedWithSendMessage: m.parentUsedSendMessage, childTranscriptsGrew: grew, childReappearedLive: revived }
    console.log(`${el()} ${name}:`, JSON.stringify(r))
    results[name] = r
  }
} finally {
  console.log(`\nRESULTS ${JSON.stringify(results, null, 2)}\n(stateDir ${stateDir}, cwd ${cwd})`)
  bridge.releaseSession(slug, sessionId, "session-deleted")
  bridge.close()
  tailer.stop?.()
}
process.exit(0)
