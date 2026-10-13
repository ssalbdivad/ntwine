// LIVE PROBE: does an interrupt kill the worker's BACKGROUND SUB-AGENTS, and does declaring the
// per-task stop affordance stop it doing so?
//   nub packages/server/src/backend/_live_broker_interrupt_subagent.mts
//
// WHY. ⌘-Enter on a running Claude thread is "interrupt and send": router.ts delivers the message and
// then calls `Query.interrupt()`. The maintainer observed that this also ended every sub-agent the
// worker had dispatched (2026-09-23). The SDK's `Options.perTaskStopAffordance` doc says the CLI
// FAILS CLOSED: without the declaration an interrupt kills background tasks; with it, an interrupt
// on an open-input session aborts only the turn and spares running background agents.
//
// THE DIFFERENTIAL, one variable, the same shape each time — the worker dispatches one background
// Agent (a child that sleeps ~45s) and then occupies its own turn with a ~60s Bash sleep; the probe
// interrupts once both are provably running, then watches the child's task_notification:
//   CONTROL — raw SDK, flag absent   → expect the child reported killed/stopped right after the interrupt
//   TEST    — raw SDK, flag true     → expect the child to run to `completed` after the turn was aborted
//   BROKER  — ntwine's own factory    → the same expectation as TEST, proving the plumbing carries it
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { query, type SDKMessage, type SDKUserMessage } from "@ntwine/claude-agent-sdk-runtime"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)

// The worker's job. A python sleep, not a bare `sleep`: Claude Code's tool policy refuses a standalone
// sleep (measured by _live_broker_interrupt_send.mts).
const PROMPT =
  `Do exactly this, in order, nothing else. ` +
  `1) Call the Agent tool ONCE with run_in_background: true, subagent_type "general-purpose", and this prompt: ` +
  `"Use the Bash tool once to run python3 -c \\"import time; time.sleep(45)\\" with a timeout of 90000ms, then reply CHILD-DONE and stop." ` +
  `2) Immediately after, without waiting for the agent, call the Bash tool ONCE to run python3 -c "import time; time.sleep(60)" with a timeout of 120000ms. ` +
  `3) When both are finished reply PARENT-DONE and stop.`

interface Outcome { childStarted?: number; childStatus?: string; childStatusAt?: number; interruptedAt?: number; parentResultAt?: number; parentBashAt?: number }

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }
    await sleep(25)
  }
  return true
}

// ── raw SDK run (control / test) ─────────────────────────────────────────────────────────────────
async function rawRun(label: string, perTaskStopAffordance: boolean | undefined): Promise<Outcome> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `intsub-${label}-`)))
  execFileSync("git", ["init", "-q", cwd])
  const out: Outcome = {}
  let resolveInput!: () => void
  const inputClosed = new Promise<void>((r) => { resolveInput = r })
  async function* input(): AsyncIterable<SDKUserMessage> {
    yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: PROMPT } } as SDKUserMessage
    await inputClosed
  }
  const q = query({
    prompt: input(),
    options: {
      cwd, env, pathToClaudeCodeExecutable: claudeBin,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      persistSession: false,
      ...(perTaskStopAffordance === undefined ? {} : { perTaskStopAffordance }),
    },
  })
  const consume = (async () => {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const raw = m as unknown as Record<string, any>
      if (raw.type === "system" && raw.subtype === "task_started") { out.childStarted ??= Date.now() - t0; console.log(`EVENT ${at()} ${label} task_started ${JSON.stringify(raw.task_id ?? raw.taskId ?? "")}`) }
      if (raw.type === "system" && raw.subtype === "task_notification") { out.childStatus = String(raw.status); out.childStatusAt = Date.now() - t0; console.log(`EVENT ${at()} ${label} task_notification status=${raw.status}`) }
      if (raw.type === "assistant") {
        const tools = (raw.message?.content ?? []).filter((c: any) => c.type === "tool_use").map((c: any) => c.name)
        if (tools.includes("Bash")) out.parentBashAt ??= Date.now() - t0
        if (tools.length) console.log(`EVENT ${at()} ${label} assistant tools=${tools.join(",")}`)
      }
      if (raw.type === "result") { out.parentResultAt = Date.now() - t0; console.log(`EVENT ${at()} ${label} result subtype=${raw.subtype}`) }
    }
  })()
  try {
    await waitFor(() => out.childStarted !== undefined && out.parentBashAt !== undefined, 120_000, `${label}: child + parent Bash both running`)
    await sleep(3_000)
    console.log(`SEND  ${at()} ${label} interrupt()`)
    out.interruptedAt = Date.now() - t0
    await q.interrupt()
    await waitFor(() => out.childStatus !== undefined, 90_000, `${label}: the child's task_notification`)
    await sleep(2_000)
  } finally {
    resolveInput()
    try { q.close?.() } catch {}
    await Promise.race([consume, sleep(10_000)])
    rmSync(cwd, { recursive: true, force: true })
  }
  return out
}

// ── ntwine broker run (the real path) ─────────────────────────────────────────────────────────────
async function brokerRun(label: string): Promise<Outcome> {
  const stateDir = mkdtempSync(join(tmpdir(), `intsub-${label}-state-`))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `intsub-${label}-repo-`)))
  execFileSync("git", ["init", "-q", cwd])
  const sessionId = randomUUID()
  const out: Outcome = {}
  const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions" })
  const client = connectClaudeBroker(record.socketPath, {
    onEvent: (event: ClaudeQueryEvent) => {
      if (event.kind === "task" && event.phase === "started") { out.childStarted ??= Date.now() - t0; console.log(`EVENT ${at()} ${label} task started ${event.taskId ?? ""}`) }
      if (event.kind === "task" && event.phase === "notification") { out.childStatus = String(event.status); out.childStatusAt = Date.now() - t0; console.log(`EVENT ${at()} ${label} task notification status=${event.status}`) }
      if (event.kind === "assistant" && event.toolUses.length) {
        if (event.toolUses.some((t) => t.name === "Bash")) out.parentBashAt ??= Date.now() - t0
        console.log(`EVENT ${at()} ${label} assistant tools=${event.toolUses.map((t) => t.name).join(",")}`)
      }
      if (event.kind === "result") { out.parentResultAt = Date.now() - t0; console.log(`EVENT ${at()} ${label} result`) }
    },
    onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
    onDiagnostic: (d) => console.log(`DIAG  ${at()} ${JSON.stringify(d).slice(0, 160)}`),
  })
  try {
    client.sendInput({ id: randomUUID(), text: PROMPT })
    await waitFor(() => out.childStarted !== undefined && out.parentBashAt !== undefined, 120_000, `${label}: child + parent Bash both running`)
    await sleep(3_000)
    console.log(`SEND  ${at()} ${label} interrupt`)
    out.interruptedAt = Date.now() - t0
    client.interrupt()
    await waitFor(() => out.childStatus !== undefined, 90_000, `${label}: the child's task notification`)
    await sleep(2_000)
  } finally {
    try { client.close() } catch {}
    try { killBroker(stateDir, sessionId) } catch {}
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  return out
}

const survived = (o: Outcome) => o.childStatus === "completed"
const describe = (o: Outcome) => `child=${o.childStatus ?? "NEVER"} ${o.childStatusAt !== undefined && o.interruptedAt !== undefined ? `${((o.childStatusAt - o.interruptedAt) / 1000).toFixed(1)}s after the interrupt` : ""}`

try {
  console.log(`\n──────── CONTROL: raw SDK, flag absent ────────`)
  const control = await rawRun("CONTROL", undefined)
  console.log(`\n──────── TEST: raw SDK, perTaskStopAffordance:true ────────`)
  const test = await rawRun("TEST", true)
  console.log(`\n──────── BROKER: ntwine factory (the fix as shipped) ────────`)
  const broker = await brokerRun("BROKER")

  console.log("\n──────── ANALYSIS ────────")
  console.log(`CONTROL  ${describe(control)}`)
  console.log(`TEST     ${describe(test)}`)
  console.log(`BROKER   ${describe(broker)}`)
  ok("CONTROL: without the flag the interrupt ends the child (the harness can fail)", control.childStatus !== undefined && !survived(control), describe(control))
  ok("TEST: with the flag the child runs to completed after the interrupt", survived(test), describe(test))
  ok("TEST: the parent's turn was actually aborted before the child finished", test.parentResultAt !== undefined && test.childStatusAt !== undefined && test.parentResultAt < test.childStatusAt)
  ok("BROKER: ntwine's own factory carries the flag — the child survives", survived(broker), describe(broker))
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
  failures++
}
process.exit(failures === 0 ? 0 : 1)
