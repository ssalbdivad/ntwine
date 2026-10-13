// LIVE end-to-end test of SUB-AGENT PROGRESS, in two phases: a clean run that proves the data is real,
// then a HOSTILE run that proves the values a real agent produces cannot kill the session.
//
// LIVE end-to-end test of SUB-AGENT PROGRESS: a real claude session dispatching real background
// children → the SDK's task_* system messages → protocol mapper → claude-runtime-ingest → tailer →
// the SubAgentView the board renders.
//   nub packages/server/src/backend/_live_broker_subagents.mts
//
// WHY A LIVE HARNESS. Every claim this change rests on is a claim about VALUES A REAL PROVIDER SENDS:
// that `task_started` carries `tool_use_id` (the correlation key the whole design hangs on), that
// `task_progress` carries `last_tool_name` and `usage`, that `task_notification` actually arrives on
// the stream. Unit tests assert those against fixtures I wrote — which proves my fixtures agree with
// my code and nothing else. The entire bug history of this path (three separate phantom-sub-agent
// leaks, all in the prose fold) is things unit tests did not catch.
//
// So this prints the RAW task events first, then asserts against them. Read the dump before trusting
// the PASS lines.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bsub-state-"))
// REALPATH: claude slugifies the RESOLVED cwd, so a /var/folders temp dir lands under
// -private-var-folders-… . Skipping this points the tailer at an empty log dir and the fold silently
// sees nothing — which reads exactly like the bug under test.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bsub-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

// EXACTLY context.ts's construction order — ingest first, tailer late-bound.
let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })

type TaskEvent = Extract<ClaudeQueryEvent, { kind: "task" }>
const taskEvents: TaskEvent[] = []
const kinds = new Map<string, number>()
const dispatchedToolUseIds = new Set<string>()
const t0 = Date.now()

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)
    if (event.kind === "task") taskEvents.push(event)
    // Record what the AGENT actually dispatched, so the tool_use_id correlation can be checked
    // against the real dispatch rather than against whatever the task stream claims.
    if (event.kind === "assistant") {
      for (const use of event.toolUses) if (use.name === "Agent" || use.name === "Task") dispatchedToolUseIds.add(use.id)
    }
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

const slug = "subagents-live"
const sessionId = randomUUID()

// The workload. Deliberately NOT a toy: two real background children that each run several tools, so
// the progress stream has something to report and the completion path has two entries to clear.
const PROMPT = [
  "Dispatch TWO background sub-agents at once using the Agent tool with run_in_background set to true.",
  "Give each a description. Agent 1's task: run `uname -a` and `date` with Bash, then reply DONE-ONE.",
  "Agent 2's task: run `pwd` and `ls -la` with Bash, then reply DONE-TWO.",
  "After dispatching both, WAIT for both to finish, then reply with exactly BOTH-DONE.",
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
  tailer.tick() // prime

  // Watch the LIVE sub-agent count rise and fall, ticking the tailer the way the server does.
  let peakLive = 0
  const seen: string[] = []
  const deadline = Date.now() + 300_000
  let settledFor = 0
  while (Date.now() < deadline) {
    tailer.tick()
    const tele = tailer.get(slug)
    const live = tele?.subAgents ?? []
    peakLive = Math.max(peakLive, live.length)
    const line = `t+${Math.round((Date.now() - t0) / 1000)}s turn=${tele?.turn} live=${live.length} ${live.map((v) => `[${v.label} | ${v.state} | act=${v.activity ?? "-"} | doing=${v.activityDetail ?? "-"} | tools=${v.toolUses ?? "-"} | tok=${v.tokens ?? "-"}]`).join(" ")}`
    if (seen.at(-1) !== line) seen.push(line)
    // Terminal condition: the turn has settled AND no children are live, held for a few ticks so a
    // momentary gap between dispatch and the first task event can't be mistaken for completion.
    if (tele?.turn === "idle" && live.length === 0 && peakLive > 0) { if (++settledFor >= 4) break } else settledFor = 0
    await sleep(1_000)
  }

  console.log("\n      --- live sub-agent timeline (deduped) ---")
  for (const line of seen) console.log("      " + line)

  console.log("\n      --- RAW task events off the SDK stream ---")
  console.log(`      event kinds seen: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(" ")}`)
  for (const e of taskEvents.slice(0, 40)) {
    console.log(`      ${e.phase.padEnd(12)} task=${e.taskId ?? "-"} toolUse=${e.toolUseId ?? "-"} status=${e.status ?? "-"} tool=${e.lastToolName ?? "-"} type=${e.subagentType ?? e.taskType ?? "-"} desc=${JSON.stringify(e.description ?? "").slice(0, 60)} sum=${JSON.stringify(e.summary ?? "").slice(0, 50)} usage=${JSON.stringify(e.usage ?? null)} tasks=${e.tasks ? JSON.stringify(e.tasks.map((t) => t.taskId)) : "-"}`)
  }
  if (taskEvents.length > 40) console.log(`      … and ${taskEvents.length - 40} more`)

  // ---- the assertions ----
  const byPhase = (phase: string) => taskEvents.filter((e) => e.phase === phase)
  ok("task events reach ntwine at all", taskEvents.length > 0, `${taskEvents.length} task events`)
  ok("task_started arrived", byPhase("started").length > 0, `${byPhase("started").length}`)
  ok("task_progress arrived", byPhase("progress").length > 0, `${byPhase("progress").length}`)
  ok("task_notification arrived", byPhase("notification").length > 0, `${byPhase("notification").length}`)

  // The correlation the whole design hangs on. If this fails, tool_use_id is not on the wire and the
  // tailer can only correlate via the prose-parsed task id — say so loudly rather than quietly.
  const startedWithToolUse = byPhase("started").filter((e) => e.toolUseId)
  ok("task_started carries tool_use_id (the primary correlation key)", startedWithToolUse.length > 0,
    `${startedWithToolUse.length}/${byPhase("started").length} started events carried one`)
  const matched = startedWithToolUse.filter((e) => dispatchedToolUseIds.has(e.toolUseId!))
  ok("that tool_use_id MATCHES a real Agent dispatch ntwine folded", matched.length > 0,
    `matched ${matched.length}; dispatched ids: ${[...dispatchedToolUseIds].join(",") || "(none seen)"}`)

  ok("progress carries a per-step description (the richest LIVE field)", byPhase("progress").some((e) => e.description),
    byPhase("progress").map((e) => e.description).filter(Boolean).slice(0, 3).join(" / "))
  ok("a live row showed the child's CURRENT STEP in words", seen.some((line) => /doing=(?!-)/.test(line)), "a `doing=` other than `-` appeared")
  ok("progress carries last_tool_name", byPhase("progress").some((e) => e.lastToolName), byPhase("progress").map((e) => e.lastToolName).filter(Boolean).slice(0, 6).join(","))
  ok("progress carries usage", byPhase("progress").some((e) => e.usage?.totalTokens !== undefined || e.usage?.toolUses !== undefined))
  ok("a notification reports a terminal status", byPhase("notification").some((e) => ["completed", "failed", "stopped"].includes(e.status ?? "")),
    byPhase("notification").map((e) => e.status).join(","))

  // The board-facing outcome.
  ok("real sub-agents became LIVE board rows", peakLive > 0, `peak live = ${peakLive}`)
  const enriched = seen.some((line) => /act=(?!-)/.test(line))
  ok("a live row showed WHAT THE CHILD WAS DOING", enriched, "an `act=` other than `-` appeared in the timeline")

  const finalTele = tailer.get(slug)
  ok("the live sub-agent count returned to ZERO with no phantoms", (finalTele?.subAgents.length ?? -1) === 0,
    `${finalTele?.subAgents.length} still live: ${JSON.stringify(finalTele?.subAgents.map((v) => v.label))}`)
  ok("the parent turn settled", finalTele?.turn === "idle", `turn=${finalTele?.turn}`)


  // ---- PHASE 2: HOSTILE SUB-AGENTS -------------------------------------------------------------
  // A happy-path prompt proves almost nothing about a provider integration: the risk lives in the
  // VALUES the provider sends back, and clean prompts only ever produce clean ones (ntwine-artifact-e2e
  // step 2b). Everything below rides the NEW path — a child's description and its final reply become
  // `task_started.description`, `task_progress.description` and `task_notification.summary`, all of
  // which now flow through mapTask. Each case is a shape that has broken a validator or sits directly
  // on a bound in claude-agent-sdk-protocol.ts.
  //
  // The assertion that matters is not "the answer was right" — it is "the session is still alive, no
  // event was dropped as unmappable, and no child is left phantom-running".
  const HOSTILE: Array<{ name: string; instruction: string }> = [
    {
      name: "a child whose DESCRIPTION carries ANSI escapes (the 2026-07-27 shape, on the new path)",
      instruction: String.raw`Dispatch ONE background sub-agent (Agent tool, run_in_background true) whose description is exactly: printf '\033[31mRED\033[0m' probe. Its task: run that printf with Bash and reply OK.`,
    },
    {
      name: "a child whose final reply is far past the 128KB event-text bound",
      instruction: String.raw`Dispatch ONE background sub-agent (Agent tool, run_in_background true) described "huge reply". Its task: run \`head -c 400000 /dev/zero | tr '\0' 'x'\` with Bash and reply with the FULL output.`,
    },
    {
      name: "a child whose reply is unicode the validators single out (bidi, zero-width, astral)",
      instruction: String.raw`Dispatch ONE background sub-agent (Agent tool, run_in_background true) described "unicode probe". Its task: run \`printf 'RTL:‮reversed‬ ZW:a​b astral:\U0001F600 comb:é\n'\` with Bash and reply with exactly that output.`,
    },
    {
      name: "a child emitting binary-ish non-UTF-8 bytes",
      instruction: String.raw`Dispatch ONE background sub-agent (Agent tool, run_in_background true) described "binary probe". Its task: run \`head -c 2048 /dev/urandom | base64 | head -c 400\` with Bash and reply with the output.`,
    },
    {
      name: "FOUR concurrent children (bounds the level set and the task table together)",
      instruction: "Dispatch FOUR background sub-agents at once (Agent tool, run_in_background true), described A, B, C and D. Each one's task: run `echo hi` with Bash and reply with its own letter.",
    },
  ]

  console.log("\n      --- PHASE 2: hostile sub-agent workloads ---")
  const taskEventsBefore = taskEvents.length
  for (const [index, testCase] of HOSTILE.entries()) {
    await bridge.followUp({
      threadSlug: slug, sessionId, cwd,
      text: `${testCase.instruction}\n\nWait for it to finish, then reply with only the word NEXT. If anything fails, say so and continue — do not stop.`,
    })
    // Tick throughout, the way the server does, so a phantom that appears MID-case is observed rather
    // than only sampled at the end.
    let phantomPeak = 0
    const caseDeadline = Date.now() + 120_000
    let quiet = 0
    while (Date.now() < caseDeadline) {
      tailer.tick()
      const tele = tailer.get(slug)
      phantomPeak = Math.max(phantomPeak, tele?.subAgents.length ?? 0)
      if (tele?.turn === "idle" && (tele?.subAgents.length ?? 0) === 0) { if (++quiet >= 5) break } else quiet = 0
      if (!bridge.isDaemonAlive(sessionId)) break
      await sleep(1_000)
    }
    const crashedNow = readClaudeBrokerDiagnostics(stateDir, sessionId).filter((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed")
    const droppedNow = readClaudeBrokerDiagnostics(stateDir, sessionId).filter((r) => r.diagnostic.kind === "stderr" && /unmappable event dropped|event stream error/.test(r.diagnostic.message))
    const stillLive = tailer.get(slug)?.subAgents ?? []
    ok(
      `hostile ${index + 1}: ${testCase.name}`,
      bridge.isDaemonAlive(sessionId) && crashedNow.length === 0 && droppedNow.length === 0 && stillLive.length === 0,
      [
        crashedNow.length ? `CRASHED: ${JSON.stringify(crashedNow.at(-1)?.diagnostic)}` : "",
        droppedNow.length ? `DROPPED: ${(droppedNow.at(-1)?.diagnostic as { message: string }).message.slice(0, 160)}` : "",
        stillLive.length ? `PHANTOM: ${JSON.stringify(stillLive.map((v) => `${v.label}:${v.state}`))}` : "",
        bridge.isDaemonAlive(sessionId) ? "" : "daemon died",
      ].filter(Boolean).join(" | ") || `peak live ${phantomPeak}, back to 0`,
    )
    if (!bridge.isDaemonAlive(sessionId)) break // everything after this is meaningless
  }
  console.log(`      hostile phase produced ${taskEvents.length - taskEventsBefore} further task events`)

  const crashed = readClaudeBrokerDiagnostics(stateDir, sessionId).filter((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed")
  ok("the session never crashed across BOTH phases", crashed.length === 0, JSON.stringify(crashed.at(-1)?.diagnostic ?? ""))
  const dropped = readClaudeBrokerDiagnostics(stateDir, sessionId).filter((r) => r.diagnostic.kind === "stderr" && /unmappable event dropped|event stream error/.test(r.diagnostic.message))
  ok("no event was dropped as unmappable across BOTH phases", dropped.length === 0, dropped.slice(0, 3).map((d) => (d.diagnostic as { message: string }).message.slice(0, 140)).join(" | "))
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { ingest.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
