// Seed a disposable adhoc stack with ONE resting thread that owns every kind of row the ops strip under
// the prompt box draws — a live sub-agent, a background shell, a saved link and a saved file, plus a
// STALE sub-agent and a shell whose process is gone — for fullscreenOpsInRail.e2e.test.ts. On /full
// beside its rail the strip must draw none of them, and the rail must draw all of them, each in its own
// state; below the split the strip is the only place they are.
//
// Follows the frizz-stack recipe: a broker session row + a JSONL the REAL tailer folds, then the saved
// links through the worker's own RPC (upsertOwnLink), the way `frizzctl link` creates them. The tailer
// drops a thread's shells the moment its owner looks gone, and for a broker row "gone" is an absent
// broker record — so, as in seed-resting-thread.mjs, the seed writes one naming a real live `sleep`.
// Kill both pids (printed as `daemonPid` and `shellPid`) when you tear the stack down.
//
// Usage: nub scripts/seed-full-rail-ops.mjs --port=<stack port> --home=<adhoc-stack HOME>
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-full-rail-ops.mjs --port=<stack port> --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "full-rail-ops"
const SESSION = "7c0110ff-0000-4000-8000-0000000f0001"
const now = () => new Date().toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
mkdirSync(join(sandbox.stateDir, "claude-broker"), { recursive: true })
writeFileSync(
  join(sandbox.stateDir, "claude-broker", `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.json`),
  JSON.stringify({ sessionId: SESSION, daemonPid: daemon.pid, socketPath: join(sandbox.stateDir, "claude-broker", `${SLUG}.sock`) }),
)

const AGENT = { id: "toolu_fro_agent", agent: "froA", type: "frizz:opus-xhigh", label: "Verify the rail carries every row" }
const SHELL = { id: "toolu_fro_sh1", op: "bgfro001", label: "Run the dev server" }
// The two rows the rail used to drop: a sub-agent quiet past its window, and a shell nobody holds open.
// Both were launched 25 minutes ago — past the shell probe's grace window, and far enough back that the
// child's transcript can be 20 minutes old.
const STALE_AGENT = { id: "toolu_fro_agent2", agent: "froB", type: "frizz:sonnet-low", label: "Audit the old projection" }
const DEAD_SHELL = { id: "toolu_fro_sh2", op: "bgfro002", label: "Tail the old log" }
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

// A FRESH mtime on the sub-agent's transcript is what makes the child read `running`.
const subagentsDir = join(jsonlDir, SESSION, "subagents")
mkdirSync(subagentsDir, { recursive: true })
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.meta.json`),
  JSON.stringify({ agentType: AGENT.type, description: AGENT.label, toolUseId: AGENT.id, spawnDepth: 1 }),
)
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.jsonl`),
  JSON.stringify({
    parentUuid: null, isSidechain: true, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { model: "claude-opus-5", id: `msg_${AGENT.agent}`, type: "message", role: "assistant", stop_reason: null, content: [{ type: "text", text: `Working on: ${AGENT.label}` }], usage: { input_tokens: 2, output_tokens: 20 } },
  }) + "\n",
)
// STALE: the same shape, but its transcript was last written 20 minutes ago and ends in no pending Bash
// wait, so the tailer's 15-minute window has run out (tailer quietPastWindow).
const staleTranscript = join(subagentsDir, `agent-${STALE_AGENT.agent}.jsonl`)
writeFileSync(
  join(subagentsDir, `agent-${STALE_AGENT.agent}.meta.json`),
  JSON.stringify({ agentType: STALE_AGENT.type, description: STALE_AGENT.label, toolUseId: STALE_AGENT.id, spawnDepth: 1 }),
)
writeFileSync(
  staleTranscript,
  JSON.stringify({
    parentUuid: null, isSidechain: true, type: "assistant", uuid: uuid(), timestamp: ago(20), session_id: SESSION, cwd,
    message: { model: "claude-sonnet-5", id: `msg_${STALE_AGENT.agent}`, type: "message", role: "assistant", stop_reason: null, content: [{ type: "text", text: `Working on: ${STALE_AGENT.label}` }], usage: { input_tokens: 2, output_tokens: 20 } },
  }) + "\n",
)
const twentyAgo = new Date(Date.now() - 20 * 60_000)
utimesSync(staleTranscript, twentyAgo, twentyAgo)

const tasksDir = join(home, "tasks")
mkdirSync(tasksDir, { recursive: true })
writeFileSync(join(tasksDir, `${SHELL.op}.output`), "listening on :5173\n")
// The shell's LIVENESS is an open handle on its output file (tailer.shellIsGone asks lsof), so a real
// process holds it — without one the board demotes the shell to "stale" once its grace window passes,
// which is exactly what DEAD_SHELL below is for.
const outFd = openSync(join(tasksDir, `${SHELL.op}.output`), "a")
const shellProc = spawn("sleep", ["7200"], { detached: true, stdio: ["ignore", outFd, "ignore"] })
shellProc.unref()
closeSync(outFd)

// GONE: the same kind of output file with NOTHING holding it open — the probe's positive "dead" verdict
// (tailer shellIsGone), which arrives a tick after the first board read and turns the row stale.
writeFileSync(join(tasksDir, `${DEAD_SHELL.op}.output`), "tailing app.log\n")

// The harness's own auto-background ack — LAUNCH_ACK_RE in tailer.ts turns it into a TRACKED shell.
const autoBgFor = (op) =>
  `Command did not complete within its 590s timeout and was moved to the background (ID: ${op}). ` +
  `Output is being written to: ${join(tasksDir, `${op}.output`)}. ` +
  "You will be notified when it completes. To check interim output, use Read on that file path."
const autoBg = autoBgFor(SHELL.op)

const records = [
  { type: "user", timestamp: ago(26), message: { role: "user", content: "TASK:\nMove the ops rows into the rail." } },
  {
    type: "assistant",
    timestamp: ago(25),
    message: {
      model: "claude-opus-5", id: "msg_fro_dispatch_old", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "Agent", id: STALE_AGENT.id, input: { description: STALE_AGENT.label, prompt: `${STALE_AGENT.label}. Report back.`, run_in_background: true, subagent_type: STALE_AGENT.type } },
        { type: "tool_use", name: "Bash", id: DEAD_SHELL.id, input: { command: `# ${DEAD_SHELL.label}\ntail -f app.log`, description: DEAD_SHELL.label, timeout: 590000 } },
      ],
      usage: { input_tokens: 2, output_tokens: 120 },
    },
  },
  {
    type: "user",
    timestamp: ago(25),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: STALE_AGENT.id, content: `Async agent launched successfully.\nagentId: ${STALE_AGENT.agent}\noutput_file: ${staleTranscript}` },
        { type: "tool_result", tool_use_id: DEAD_SHELL.id, content: autoBgFor(DEAD_SHELL.op) },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_fro_dispatch", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "Agent", id: AGENT.id, input: { description: AGENT.label, prompt: `${AGENT.label}. Report back.`, run_in_background: true, subagent_type: AGENT.type } },
        { type: "tool_use", name: "Bash", id: SHELL.id, input: { command: `# ${SHELL.label}\nsleep 7200`, description: SHELL.label, timeout: 590000 } },
      ],
      usage: { input_tokens: 2, output_tokens: 120 },
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: AGENT.id, content: `Async agent launched successfully.\nagentId: ${AGENT.agent}\noutput_file: ${join(subagentsDir, `agent-${AGENT.agent}.jsonl`)}` },
        { type: "tool_result", tool_use_id: SHELL.id, content: autoBg },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_fro_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "The sub-agent is verifying the rail and the dev server is up; both are saved below." }],
      usage: { input_tokens: 2, output_tokens: 30 },
    },
  },
].map((r) => ({ ...r, parentUuid: null, isSidechain: false, uuid: uuid(), timestamp: r.timestamp ?? now(), session_id: SESSION, cwd }))
writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  sandbox.db,
  `INSERT OR REPLACE INTO session (${cols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${vals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Move the ops rows into the rail', 0, 'claude', 'broker', 'opus', 'xhigh', 'default', 'open', 0, 0, 0, '${now()}')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
await api.mutate("upsertOwnLink", { slug: SLUG, label: "Open dev server", target: "http://127.0.0.1:5173/project/demo" })
await api.mutate("upsertOwnLink", { slug: SLUG, label: "Working plan", target: join(cwd, "README.md") })
console.log(JSON.stringify({ slug: SLUG, session: SESSION, daemonPid: daemon.pid, shellPid: shellProc.pid }))
