// LIVE PROBE: a mid-turn follow-up on the BROKER path — how fast does the model SEE it, how fast does
// it ACT on it, and how fast does the transcript ntwine renders actually SHOW it?
//   nub packages/server/src/backend/_live_broker_steer_latency.mts
//
// THE COMPLAINT (maintainer, 2026-08-01): "a lot of times, there's a ton of tool calls that happen
// before it actually gets dequeued inside of claude code session."
//
// v1 of this probe measured only "when did the sentinel come back on the event stream" and answered
// 3.3s / zero tool calls — which CONTRADICTS the complaint, so the thing being measured was wrong.
// v1 also asked the model to interrupt itself ("reply with X as your very next output"), which is not
// what a real steer looks like. Three separable latencies hide behind one complaint, and this
// separates them against ONE long tool-heavy turn:
//
//   L1 SEEN     send → the CLI puts the input on the event stream (ntwine's own transport)
//   L2 ON DISK  send → the user record lands in the session JSONL (what the ntwine TRANSCRIPT reads;
//                      if this trails, the operator watches tool calls pile up above their message)
//   L3 ACTED    send → the model does the thing the message asked for (pure model behaviour)
//
// The steer is an ORDINARY instruction with an observable side effect (write a file), not a demand to
// interrupt — so L3 measures what a real follow-up gets, not what a shouted one gets.
import { execFileSync } from "node:child_process"
import { mkdtempSync, closeSync, existsSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "steerlat-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "steerlat-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)
const steerFile = join(cwd, "STEERED.txt")

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`

const STEER_TOKEN = "PINEAPPLE7742"
type Hit = { ms: number; tools: number }
let toolUses = 0
let results = 0
let seenOnStream: Hit | null = null
let seenOnDisk: Hit | null = null
let actedAt: Hit | null = null
let turnEnd: Hit | null = null

// ── JSONL tail: when does the operator's message become visible to ntwine's transcript? ─────────────
let offset = 0
let pendingText = ""
function drainDisk(): void {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return }
  if (size <= offset) return
  const fd = openSync(jsonlPath, "r")
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  offset = size
  pendingText += buf.toString("utf8")
  const lines = pendingText.split("\n")
  pendingText = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    if (!seenOnDisk && line.includes(STEER_TOKEN)) {
      let rec: Record<string, unknown> = {}
      try { rec = JSON.parse(line) } catch { /* still counts as visible bytes */ }
      seenOnDisk = { ms: Date.now() - t0, tools: toolUses }
      console.log(`DISK  ${at()} the steer is on disk (type=${String(rec.type)}) after ${toolUses} tool uses`)
    }
  }
}
const diskTimer = setInterval(drainDisk, 25)
const fileTimer = setInterval(() => {
  if (!actedAt && existsSync(steerFile)) {
    actedAt = { ms: Date.now() - t0, tools: toolUses }
    console.log(`ACTED ${at()} the model created STEERED.txt after ${toolUses} tool uses`)
  }
}, 25)

const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)
const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions" })

const client = connectClaudeBroker(record.socketPath, {
  onEvent: (event: ClaudeQueryEvent) => {
    const ms = Date.now() - t0
    if (event.kind === "result") results++
    if (event.kind === "assistant") toolUses += event.toolUses.length
    const anyEvent = event as unknown as Record<string, unknown>
    const text = Array.isArray(anyEvent.text) ? (anyEvent.text as string[]).join(" ") : ""
    if (!seenOnStream && event.kind === "user" && JSON.stringify(event).includes(STEER_TOKEN)) {
      seenOnStream = { ms, tools: toolUses }
      console.log(`SEEN  ${at()} the steer is on the event stream after ${toolUses} tool uses`)
    }
    if (!turnEnd && text.includes("BOOT-DONE")) {
      turnEnd = { ms, tools: toolUses }
      console.log(`END   ${at()} the original turn finished after ${toolUses} tool uses`)
    }
    const tools = event.kind === "assistant" && event.toolUses.length ? ` tools=${event.toolUses.map((t) => t.name).join(",")}` : ""
    if (event.kind !== "user") console.log(`EVENT ${at()} kind=${event.kind}${tools} text=${JSON.stringify(text.slice(0, 60))}`)
  },
  onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
  onDiagnostic: (d) => console.log(`DIAG  ${at()} ${JSON.stringify(d).slice(0, 160)}`),
})

const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

const LONG_TURN = "Using the Bash tool, run the command `date` twenty-four separate times — one Bash " +
  "call per invocation, never batched, no other tools. When all twenty-four are done, reply with " +
  "exactly BOOT-DONE and stop."

// An ORDINARY follow-up: a small concrete task, phrased the way an operator steers a running worker.
const STEER = `Also, while you are at it: write a file called STEERED.txt in the repo root ` +
  `containing exactly the word ${STEER_TOKEN}.`

try {
  console.log(`SEND  ${at()} BOOT (24-tool-call turn)`)
  client.sendInput({ id: randomUUID(), text: LONG_TURN })
  await waitFor(() => toolUses >= 4, 180_000, "the turn to reach 4 tool uses")

  const sentAt = Date.now() - t0
  const toolsAtSend = toolUses
  console.log(`\nSEND  ${at()} the steer (ordinary follow-up), at ${toolsAtSend} tool uses\n`)
  client.sendInput({ id: randomUUID(), text: STEER })

  await waitFor(() => actedAt !== null, 420_000, "the model to act on the steer")
  await waitFor(() => results >= 1, 300_000, "the turn to settle")
  await new Promise((r) => setTimeout(r, 2_000))
  drainDisk()

  console.log("\n──────── ANALYSIS ────────")
  console.log(`steer sent at t+${sentAt}ms, after ${toolsAtSend} tool uses`)
  const line = (label: string, hit: { ms: number; tools: number } | null): string =>
    hit ? `${label}: ${hit.ms - sentAt}ms, ${hit.tools - toolsAtSend} tool uses later` : `${label}: NEVER`
  console.log(line("L1 SEEN    (event stream)   ", seenOnStream))
  console.log(line("L2 ON DISK (ntwine transcript)", seenOnDisk))
  console.log(line("L3 ACTED   (model behaviour)", actedAt))
  console.log(line("   turn end (BOOT-DONE)     ", turnEnd))
  // Read through locals: these are assigned inside the event callback, so TS's control-flow analysis
  // still believes them null at this point and narrows the comparison to `never`.
  const acted = actedAt as Hit | null
  const ended = turnEnd as Hit | null
  if (ended && acted) {
    console.log(acted.ms < ended.ms
      ? "→ the model acted MID-TURN"
      : "→ the model waited for the turn boundary before acting")
  }
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  clearInterval(diskTimer)
  clearInterval(fileTimer)
  try { client.close() } catch {}
  try { killBroker(stateDir, sessionId) } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
