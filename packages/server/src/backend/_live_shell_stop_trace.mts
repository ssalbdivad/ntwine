// LIVE PROBE: does a STOPPED background shell leave a durable trace on disk?
//   nub packages/server/src/backend/_live_shell_stop_trace.mts
//
// WHY THIS EXISTS. The × kills the process (backend/_live_shell_stop.mts) and the row leaves the board
// — but the row CAME BACK on the maintainer's real instance two days later, and reproducing it took one
// cold fold of their transcript: the kill writes NOTHING to the session JSONL, so the tailer's
// retirement is in-memory only and any re-prime (an ntwine restart, which is exactly what happened)
// resurrects the shell as live, forever, because its tool_use never gets a tool_result.
//
// Fixing that needs a signal the fold can read off DISK. There is a candidate: on the maintainer's
// session the killed task's `<taskId>.output` file was gone while 303 sibling output files remained.
// That is suggestive, not proof — a file could be missing because the task simply FINISHED, in which
// case "missing ⇒ stopped" would retire every completed shell's row for the wrong reason and, worse,
// would say nothing about a still-running one.
//
// So this probe measures the two cases side by side, which is the only way the inference is worth
// anything:
//
//   STOPPED   — launched, killed through the provider control. Does its output file disappear?
//   FINISHED  — launched, allowed to exit on its own. Does its output file SURVIVE?
//
// A "yes/yes" makes file-absence a sound kill signal. A "yes/no" (both vanish) makes it useless, and
// the fix has to be durable state instead.
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

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "shtrace-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "shtrace-repo-"))); execFileSync("git", ["init", "-q", cwd])
const MARKER = `NTWINE_SHELL_TRACE_${randomUUID().slice(0, 8)}`

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const livePids = (): string[] => { try { return execFileSync("pgrep", ["-f", MARKER], { encoding: "utf8" }).trim().split("\n").filter(Boolean) } catch { return [] } }

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => ingest.onEvent(slug, sessionId, event),
})
tailer = createTailer({
  project, storage, bus: new Bus(), backendFor: () => claudeBackend,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "shelltrace-live"
const sessionId = randomUUID()

// Wait for a live shell whose output file the tailer has resolved, ignoring any already seen.
async function nextShell(seen: Set<string>): Promise<{ id: string; taskId?: string; outputFile?: string }> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    tailer.tick()
    for (const view of tailer.get(slug)?.bgShells ?? []) {
      if (!view.id || seen.has(view.id)) continue
      const info = tailer.subAgent(slug, view.id)
      const file = tailer.backgroundShell?.(slug, view.id)?.outputFile
      if (file) { seen.add(view.id); return { id: view.id, taskId: info?.taskId, outputFile: file } }
    }
    await sleep(1_000)
  }
  throw new Error("no new background shell appeared")
}

try {
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: [
      "Use the Bash tool with run_in_background set to true, TWICE, in this order:",
      `1. description "Forever", command: while true; do echo "${MARKER} forever"; sleep 2; done`,
      `2. description "Brief", command: for i in 1 2 3; do echo "${MARKER} brief"; sleep 1; done`,
      "Then reply with exactly STARTED and stop. Do not check on them, do not run anything else.",
    ].join("\n"),
  })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude"); storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  const seen = new Set<string>()
  const first = await nextShell(seen)
  const second = await nextShell(seen)
  // The prompt fixes the order, but the fold does not promise it, so identify them by their COMMAND.
  const commandOf = (id: string) => tailer.backgroundShell?.(slug, id)?.command ?? ""
  const forever = commandOf(first.id).includes("while true") ? first : second
  const brief = forever === first ? second : first
  console.log(`      forever: ${forever.id} task=${forever.taskId} file=${forever.outputFile}`)
  console.log(`      brief:   ${brief.id} task=${brief.taskId} file=${brief.outputFile}`)
  ok("both shells launched with an output file each", Boolean(forever.outputFile && brief.outputFile))
  ok("both output files exist while they run", existsSync(forever.outputFile!) && existsSync(brief.outputFile!))

  // ---- THE CONTROL: a shell that ENDS ON ITS OWN ------------------------------------------------
  // Runs for ~3s. Give it a wide margin, then read its file. If this file vanishes too, absence means
  // "not running" rather than "killed" — a much weaker signal, and one that would clear a finished
  // shell's row for a reason the code would be describing wrongly.
  await sleep(20_000)
  const briefAlive = existsSync(brief.outputFile!)
  console.log(`      brief shell has exited; its output file exists: ${briefAlive}`)
  ok("CONTROL: a shell that finished NORMALLY keeps its output file", briefAlive,
    briefAlive ? "so absence is not merely 'not running'" : "absence cannot distinguish killed from finished")

  // ---- THE CASE: a shell that is STOPPED --------------------------------------------------------
  ok("the forever shell is still running", livePids().length > 0)
  await bridge.stopSubAgent({ threadSlug: slug, sessionId, taskId: forever.taskId! })
  let gone = false
  for (let i = 0; i < 30 && !gone; i++) { await sleep(500); gone = !existsSync(forever.outputFile!) }
  console.log(`      after the stop, the forever shell's output file exists: ${existsSync(forever.outputFile!)}`)
  ok("a STOPPED shell's output file is REMOVED", gone,
    gone ? "file-absence is a durable on-disk trace of the kill" : "the kill leaves no disk trace at all — the fix must be durable state")

  // And the brief one must be untouched by the stop, so the signal is per-shell and not a dir wipe.
  ok("the finished shell's file is untouched by the other's stop", existsSync(brief.outputFile!))
} catch (error) {
  failures++
  console.log(`FATAL: ${(error as Error).message}`)
} finally {
  for (const pid of livePids()) { try { process.kill(Number(pid), "SIGKILL") } catch { /* gone */ } }
  bridge.close()
  try { tailer.stop() } catch { /* not started */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
