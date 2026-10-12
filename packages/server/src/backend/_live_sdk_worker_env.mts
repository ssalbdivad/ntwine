// LIVE integration test: prove CLAUDE_WORKER_ENV survives the BROKER/SDK spawn path and actually
// changes behavior there.
//   nub packages/server/src/backend/_live_sdk_worker_env.mts
//
// WHY THIS IS THE HARNESS THAT MATTERS: frizz dispatches on the broker path by default, and both
// observed early-quit sessions ran on it (`entrypoint: "sdk-ts"`). It is also a DIFFERENT chain from
// the spawned-CLI path, with one extra gate that can silently drop a variable — the bridge's `workerEnv` map.
// (buildEnvironment's EXPLICIT_CLAUDE_ENV_KEYS allowlist was the second gate until 2026-08-02; a
// worker now inherits frizz's environment minus frizz's own control plane — see worker-env.ts.)
//
// Each check is paired with the same run WITHOUT the variable. A green result with no failing control
// is not evidence.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import { CLAUDE_WORKER_ENV } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "frizz-sdk-worker-env-"))
execFileSync("git", ["init", "-q", cwd])
const BLOCK = "<total_tokens>Infinite tokens left</total_tokens>"
const BUDGET_KEY = "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

// Mirror the broker's own env construction: ambient values it allowlists, plus the per-thread
// `workerEnv` overrides merged on top. See claude-agent-broker.ts and the bridge's `workerEnv`.
const AMBIENT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const ambient = Object.fromEntries(AMBIENT.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

type Rec = Record<string, any>
const recordsFor = (sessionId: string): { path?: string; records: Rec[] } => {
  const projects = join(process.env.HOME!, ".claude", "projects")
  const path = readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
  if (!path) return { records: [] }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Rec] } catch { return [] }
  })
  return { path, records }
}
const reminderBlocks = (records: Rec[]) => records.flatMap((r) =>
  JSON.stringify(r.attachment ?? r.attachments ?? "").match(/<total_tokens>[^<]*<\/total_tokens>/g) ?? [])
const blocksOfType = (records: Rec[], type: string, name?: string) => records.flatMap((r) => {
  const content = r.message?.content
  return Array.isArray(content) ? content.filter((b: Rec) => b?.type === type && (name === undefined || b.name === name)) : []
})
const runTurn = async (env: Record<string, string>, prompt: string, ms = 300_000): Promise<string> => {
  const sessionId = randomUUID()
  const handle = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin }).start({
    cwd, session: { kind: "new", sessionId }, permissionMode: "default", env,
    persistSession: true, // the reminder is an ATTACHMENT; only the transcript carries it
    canUseTool: async () => ({ behavior: "allow" }),
  })
  let resolveTurn: () => void = () => {}
  const done = new Promise<void>((r) => { resolveTurn = r })
  const pump = (async () => {
    try {
      for await (const ev of handle as AsyncIterable<ClaudeQueryEvent>) if (ev.kind === "result") resolveTurn()
    } catch { /* the harness asserts on the transcript, not on stream teardown */ }
  })()
  await handle.send({ id: randomUUID(), text: prompt })
  let timer: NodeJS.Timeout
  await Promise.race([done, new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timeout")), ms) })]).finally(() => clearTimeout(timer!))
  await handle.close?.()
  await pump
  return sessionId
}

try {
  // No separate assertion for an override allowlist: there is none any more (worker-env.ts). What can
  // still drop a variable here is the bridge's workerEnv map, which is what the cases below exercise.

  // ---- A. The token budget reaches the model ----------------------------------------------------
  // The reminder rides a tool-result batch, so the turn must force a tool call. The control drops
  // ONLY the variable under test and keeps every other entry.
  const budgetPrompt = "Run exactly one Bash command: echo hello. Then reply DONE and stop."
  const withoutBudget = Object.fromEntries(Object.entries(CLAUDE_WORKER_ENV).filter(([key]) => key !== BUDGET_KEY))
  for (const run of [
    { name: "budget-with", label: "a broker-path worker SEES the token budget", env: { ...ambient, ...CLAUDE_WORKER_ENV }, want: true },
    { name: "budget-without", label: "the control WITHOUT the variable sees no block", env: { ...ambient, ...withoutBudget }, want: false },
  ]) {
    const { path, records } = recordsFor(await runTurn(run.env, budgetPrompt, 180_000))
    const blocks = reminderBlocks(records)
    ok(`${run.name}: a tool call actually ran (so an attachment batch existed)`, blocksOfType(records, "tool_use").length > 0)
    ok(run.label, run.want ? blocks.includes(BLOCK) : blocks.length === 0, `blocks=${blocks.length ? [...new Set(blocks)].join(" ") : "<none>"}`)
    if (path) console.log(`   transcript: ${path}`)
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
