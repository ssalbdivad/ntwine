// LIVE PROBE: can ntwine actually KILL one running BACKGROUND SHELL, and does the AGENT hear about it?
//   nub packages/server/src/backend/_live_shell_stop.mts
//
// WHY. `router.ts subAgentStoppable()` refuses a background shell categorically —
//   "Ntwine tracks a background shell by reading the worker's transcript and holds no handle on its
//    process, so it can't be stopped from here."
// — which is why a running SHELL row carries no ×. The maintainer (2026-08-01): shells get stuck for a
// day at a time and there is no way to clear one. The refusal is a claim about the PROVIDER, and the
// SDK's own typings contradict it: `Query.backgroundTasks()` is documented as backgrounding "Bash
// commands and subagents", so a background Bash is a TASK, and `Query.stopTask(taskId)` stops a task
// and emits a `task_notification` with status 'stopped'.
//
// Reading typings is not evidence. This probe settles four things against a REAL claude session,
// through ntwine's OWN production path (broker bridge → daemon → SDK), never a hand-rolled SDK call:
//
//   Q1. Does ntwine hold a task id for a background SHELL at all? (`tailer.subAgent(slug,id).taskId` —
//       the exact lookup the router would do, on an entry whose kind is "shell".)
//   Q2. Does `bridge.stopSubAgent({taskId})` — the production stop path — actually kill the OS
//       process? Checked by grepping the process table for a unique marker baked into the command.
//   Q3. Does the provider emit a terminal task event for it, so the tailer retires the row?
//   Q4. Does the AGENT get told? A follow-up turn asks the model what happened to its shell; if the
//       CLI never surfaced the stop, the model cannot answer and the second half of the ask is unmet.
//
// It prints the raw event tape and the raw model answer first. Read those; PASS/FAIL is a summary.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
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
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "shstop-state-"))
// REALPATH: claude slugifies the RESOLVED cwd, so a /var/folders temp dir lands under
// -private-var-folders-… . Skipping it points the tailer at an empty log dir and the fold sees nothing.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "shstop-repo-"))); execFileSync("git", ["init", "-q", cwd])

// The marker is how the process table is searched. Unique per run so a concurrent probe (or another
// agent on this machine) can never be matched — and so this probe can never kill anything it did not
// start, which is the one hard rule of running here.
const MARKER = `NTWINE_SHELL_STOP_PROBE_${randomUUID().slice(0, 8)}`

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The OS truth, independent of anything the provider says. `pgrep -f` matches the full command line;
// the marker appears in the shell's own argv because the agent is told to echo it in the loop.
function livePids(): string[] {
  try {
    return execFileSync("pgrep", ["-f", MARKER], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
  } catch {
    return [] // pgrep exits 1 with no matches
  }
}

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })

type TaskEvent = Extract<ClaudeQueryEvent, { kind: "task" }>
const taskEvents: TaskEvent[] = []
const assistantText: string[] = []
const t0 = Date.now()
const rel = () => `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    if (event.kind === "task") taskEvents.push(event)
    if (event.kind === "assistant" && event.text) assistantText.push(`${rel()} ${event.text}`)
    ingest.onEvent(slug, sessionId, event)
  },
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {},
  paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "shellstop-live"
const sessionId = randomUUID()

const PROMPT = [
  "Use the Bash tool with run_in_background set to true to run exactly this command:",
  `  while true; do echo "${MARKER} tick"; sleep 2; done`,
  "Give it the description 'Ticking forever'.",
  "Then reply with exactly STARTED and stop. Do not check on it, do not run anything else.",
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

  // ---- PHASE 1: wait for a live SHELL the tailer is tracking, and for its OS process ----------
  let shellId: string | undefined
  let taskId: string | undefined
  const armed = Date.now() + 180_000
  while (Date.now() < armed) {
    tailer.tick()
    const tele = tailer.get(slug)
    const shell = (tele?.bgShells ?? []).find((s) => s.state === "running" && s.id)
    if (shell?.id) {
      shellId = shell.id
      // EXACTLY the router's lookup. A shell lives in the same op map as a sub-agent, so `subAgent()`
      // resolves it — and this is the field the categorical refusal claims does not exist.
      taskId = tailer.subAgent(slug, shell.id)?.taskId
      if (taskId && livePids().length > 0) break
    }
    await sleep(1_000)
  }

  console.log(`\n      shellId = ${shellId ?? "(none)"}   taskId = ${taskId ?? "(none)"}`)
  const pidsBefore = livePids()
  console.log(`      pids matching ${MARKER} before the stop: ${pidsBefore.join(", ") || "(none)"}`)
  ok("Q1 ntwine tracks the shell as a live op with an id", Boolean(shellId), shellId ?? "")
  ok("Q1 ntwine holds a provider TASK ID for that shell", Boolean(taskId), taskId ?? "the refusal's premise would hold")
  ok("the shell's OS process is actually running", pidsBefore.length > 0, `${pidsBefore.length} pid(s)`)
  // A shell that never started is not a probe of stopping, and the OS-level assertions below would
  // pass vacuously. Bail loudly instead of reporting a green run that measured nothing.
  if (!taskId || pidsBefore.length === 0) throw new Error("preconditions unmet — nothing to stop")

  // ---- PHASE 2: the production stop path -------------------------------------------------------
  const stopAt = Date.now()
  let stopError: unknown
  try {
    await bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId })
  } catch (error) { stopError = error }
  ok("Q2 stopSubAgent resolved without throwing", !stopError, stopError instanceof Error ? stopError.message : "")

  // The OS is the authority on whether the work ended. Poll briefly — a signal is not instant.
  let pidsAfter = livePids()
  for (let i = 0; i < 20 && pidsAfter.length > 0; i++) { await sleep(500); pidsAfter = livePids() }
  console.log(`      pids after the stop (+${Math.round((Date.now() - stopAt) / 1000)}s): ${pidsAfter.join(", ") || "(none)"}`)
  ok("Q2 the shell's OS process is GONE after the stop", pidsAfter.length === 0, pidsAfter.join(", "))

  // ---- PHASE 3: does the row leave ntwine's live surfaces? ---------------------------------------
  let cleared = false
  for (let i = 0; i < 20 && !cleared; i++) {
    tailer.tick()
    cleared = !(tailer.get(slug)?.bgShells ?? []).some((s) => s.id === shellId && s.state === "running")
    if (!cleared) await sleep(1_000)
  }
  ok("Q3 the shell row leaves the board's live set on its own", cleared)

  // ---- PHASE 4: was the AGENT told? ------------------------------------------------------------
  // Deliberately a question the model can only answer from something the CLI put in its context. It is
  // asked WITHOUT restating what happened, so an affirmative answer cannot be an echo of the prompt.
  assistantText.length = 0
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "In one sentence: what is the current state of the background shell you started earlier, and how do you know? Do not run any tools — answer only from what you have been told.",
  })
  const answered = Date.now() + 120_000
  while (Date.now() < answered && assistantText.length === 0) { tailer.tick(); await sleep(1_000) }
  await sleep(4_000)

  console.log("\n      --- the model's own account of its shell ---")
  for (const line of assistantText) console.log("      " + line.replace(/\n/g, "\n      "))

  const account = assistantText.join("\n").toLowerCase()
  ok("Q4 the agent knows its shell is no longer running", /stopped|killed|terminated|no longer|not running|ended|shut down|aborted/.test(account), account.slice(0, 200))

  console.log("\n      --- RAW task events (shell-relevant) ---")
  for (const e of taskEvents) {
    console.log(`      ${e.phase.padEnd(12)} task=${e.taskId ?? "-"} toolUse=${e.toolUseId ?? "-"} status=${e.status ?? "-"} type=${e.taskType ?? e.subagentType ?? "-"} desc=${JSON.stringify(e.description ?? "").slice(0, 50)} tasks=${e.tasks ? JSON.stringify(e.tasks.map((t) => t.taskId)) : "-"}`)
  }
  const terminal = taskEvents.filter((e) => e.taskId === taskId && (e.phase === "notification" || e.status))
  console.log(`\n      terminal events for task ${taskId}: ${JSON.stringify(terminal.map((e) => ({ phase: e.phase, status: e.status })))}`)
} finally {
  // Belt and braces: if the stop did NOT work, this probe must not leave a forever-loop running on the
  // maintainer's machine. Only ever pids matching THIS run's marker.
  for (const pid of livePids()) { try { process.kill(Number(pid), "SIGKILL") } catch { /* already gone */ } }
  bridge.close()
  try { tailer.stop() } catch { /* not started */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
