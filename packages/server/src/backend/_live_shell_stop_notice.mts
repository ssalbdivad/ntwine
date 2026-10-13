// LIVE PROBE 2: after ntwine kills a background shell, is the AGENT told — and if not, does a
// ntwine-authored notice actually reach it?
//   nub packages/server/src/backend/_live_shell_stop_notice.mts
//
// `_live_shell_stop.mts` established the first half: `stopTask` on a background Bash's task id kills
// the OS process within a second and the row leaves the board. It also produced the FAILURE this probe
// exists to characterise — asked afterwards, the model said the shell was "presumably still running …
// I have received no completion notification". That is the model's account of its own context, which
// is not authoritative, so:
//
//   Q1. Does the CLI write ANYTHING into the session transcript when a task is stopped by the client?
//       Read the raw JSONL records straddling the stop. This is the authoritative answer, not the
//       model's self-report.
//   Q2. Does a `[ntwine] …` notice delivered as a follow-up reach the model and change what it believes?
//       `[ntwine]`-prefixed user records are already ntwine's channel for machine notices to a worker
//       (transcript.ts NOISE_PREFIXES hides them from the human's chat), so this is the shipping
//       mechanism, tested as it would ship rather than as a mock.
//   Q3. Same question for a stopped SUB-AGENT: today the × stops one silently too. Whether that path
//       needs the same notice is decided here rather than assumed either way.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "shnote-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "shnote-repo-"))); execFileSync("git", ["init", "-q", cwd])
const MARKER = `NTWINE_SHELL_NOTICE_PROBE_${randomUUID().slice(0, 8)}`

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const livePids = (): string[] => { try { return execFileSync("pgrep", ["-f", MARKER], { encoding: "utf8" }).trim().split("\n").filter(Boolean) } catch { return [] } }

// The session JSONL claude writes, found by SESSION ID rather than by re-deriving the slug — the slug
// rule has bitten this harness family before (see the realpath note in _live_broker_subagents.mts).
function transcriptPath(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects")
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    try { readFileSync(candidate); return candidate } catch { /* not this project */ }
  }
  return undefined
}
function records(sessionId: string): Array<Record<string, any>> {
  const path = transcriptPath(sessionId)
  if (!path) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}
// One line per record, short enough to read a whole window of them at once.
function describe(rec: Record<string, any>): string {
  const blocks = Array.isArray(rec.message?.content) ? rec.message.content : []
  const kinds = blocks.map((b: any) => b?.type).join("+") || (typeof rec.message?.content === "string" ? "text" : "-")
  const text = blocks.map((b: any) => b?.text ?? b?.content ?? "").map((t: any) => (typeof t === "string" ? t : JSON.stringify(t))).join(" ") || (typeof rec.message?.content === "string" ? rec.message.content : "")
  return `${String(rec.timestamp ?? "").slice(11, 23)} ${String(rec.type ?? "?").padEnd(9)} ${kinds.padEnd(18)} ${JSON.stringify(text).slice(0, 220)}`
}

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
type TaskEvent = Extract<ClaudeQueryEvent, { kind: "task" }>
const taskEvents: TaskEvent[] = []
let assistantText: string[] = []

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    if (event.kind === "task") taskEvents.push(event)
    if (event.kind === "assistant") assistantText.push(...event.text)
    ingest.onEvent(slug, sessionId, event)
  },
})
tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "shellnotice-live"
const sessionId = randomUUID()

// Wait for a turn's worth of assistant text, then hand back everything it said.
async function awaitAnswer(ms = 120_000): Promise<string> {
  assistantText = []
  const deadline = Date.now() + ms
  while (Date.now() < deadline && assistantText.length === 0) { tailer.tick(); await sleep(1_000) }
  await sleep(5_000)
  return assistantText.join("\n")
}

try {
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: [
      "Use the Bash tool with run_in_background set to true to run exactly this command:",
      `  while true; do echo "${MARKER} tick"; sleep 2; done`,
      "Give it the description 'Ticking forever'.",
      "Then reply with exactly STARTED and stop. Do not check on it, do not run anything else.",
    ].join("\n"),
  })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude"); storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  let shellId: string | undefined
  let taskId: string | undefined
  const armed = Date.now() + 180_000
  while (Date.now() < armed) {
    tailer.tick()
    const shell = (tailer.get(slug)?.bgShells ?? []).find((s) => s.state === "running" && s.id)
    if (shell?.id) { shellId = shell.id; taskId = tailer.subAgent(slug, shell.id)?.taskId }
    if (taskId && livePids().length > 0) break
    await sleep(1_000)
  }
  if (!taskId || livePids().length === 0) throw new Error("preconditions unmet — no live shell to stop")
  console.log(`\n      shell=${shellId} task=${taskId} pids=${livePids().join(",")}`)

  const before = records(sessionId).length
  await bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId })
  await sleep(8_000) // give the CLI every chance to write a notification of its own

  // ---- Q1: what did the CLI write, if anything? ------------------------------------------------
  const after = records(sessionId)
  const written = after.slice(before)
  console.log(`\n      --- transcript records written in the 8s AFTER the stop (${written.length}) ---`)
  for (const rec of written) console.log("      " + describe(rec))
  // Look for the ONE thing that would make ntwine's notice redundant: an injected `<task-notification>`
  // user record naming this task. Matching on the words "stop"/"kill" anywhere in the record does not
  // work — an assistant record carries `stop_reason`, which matches every time.
  const notified = (recs: Array<Record<string, any>>, task: string) =>
    recs.some((rec) => rec.type === "user" && JSON.stringify(rec.message ?? "").includes("<task-notification>") && JSON.stringify(rec.message ?? "").includes(task))
  ok("Q1 the CLI injects NO task-notification when a background SHELL is stopped", !notified(written, taskId),
    notified(written, taskId) ? "it does — ntwine's notice would be redundant" : "confirmed silent; the worker is never told")

  // ---- Q2: does ntwine's own notice land? --------------------------------------------------------
  // The wording under test is the wording that would ship. It must be unambiguous about three things
  // the worker acts on: which shell, that it is gone for good, and that waiting on it is now futile.
  const NOTICE = `[ntwine] The operator stopped your background shell "Ticking forever" from the Ntwine dashboard. It is no longer running and will never report a result — do not wait on it. Its output up to the kill is still readable.`
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: NOTICE })
  const answer = await awaitAnswer()
  console.log("\n      --- what the model said after ntwine's notice ---")
  console.log("      " + answer.replace(/\n/g, "\n      ").slice(0, 1200))
  ok("Q2 the model acts on ntwine's notice (acknowledges the shell is dead)",
    /stopped|killed|no longer|not running|won't wait|will not wait|dead|terminated/i.test(answer), answer.slice(0, 160))

  // The notice must NOT show up as a human-authored bubble in the chat — it is machine plumbing.
  const noticeRec = records(sessionId).find((rec) => JSON.stringify(rec.message ?? "").includes("[ntwine] The operator stopped"))
  ok("Q2 the notice is a real user record in the transcript", Boolean(noticeRec))

  // ---- Q3: a stopped SUB-AGENT — is the parent told? -------------------------------------------
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "Now dispatch ONE background sub-agent with the Agent tool (run_in_background true), description 'Long sleeper', whose task is: run `sleep 600` with Bash and then reply DONE. Reply with exactly DISPATCHED and stop; do not wait for it.",
  })
  let agentId: string | undefined
  let agentTask: string | undefined
  const armed2 = Date.now() + 180_000
  while (Date.now() < armed2) {
    tailer.tick()
    const agent = (tailer.get(slug)?.subAgents ?? []).find((a) => a.state === "running" && a.id)
    if (agent?.id) { agentId = agent.id; agentTask = tailer.subAgent(slug, agent.id)?.taskId }
    if (agentTask) break
    await sleep(1_000)
  }
  if (!agentTask) {
    ok("Q3 a background sub-agent was dispatched to stop", false, "never appeared")
  } else {
    console.log(`\n      sub-agent=${agentId} task=${agentTask}`)
    const beforeAgent = records(sessionId).length
    await bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId: agentTask })
    await sleep(8_000)
    const writtenAgent = records(sessionId).slice(beforeAgent)
    console.log(`\n      --- transcript records after the SUB-AGENT stop (${writtenAgent.length}) ---`)
    for (const rec of writtenAgent) console.log("      " + describe(rec))
    // The ASYMMETRY this probe exists to pin down: the provider DOES inject a task-notification for a
    // stopped sub-agent. So the missing notice is a shell-only gap, and ntwine must not add a second
    // notice on the sub-agent path — that would tell the worker the same thing twice.
    ok("Q3 the CLI DOES inject a task-notification when a SUB-AGENT is stopped", notified(writtenAgent, agentTask),
      "the sub-agent path already notifies natively — ntwine's notice is shell-only")
  }

  console.log("\n      --- RAW task events ---")
  for (const e of taskEvents) console.log(`      ${e.phase.padEnd(12)} task=${e.taskId ?? "-"} toolUse=${e.toolUseId ?? "-"} status=${e.status ?? "-"} type=${e.taskType ?? e.subagentType ?? "-"}`)
} finally {
  for (const pid of livePids()) { try { process.kill(Number(pid), "SIGKILL") } catch { /* gone */ } }
  bridge.close()
  try { tailer.stop() } catch { /* not started */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
