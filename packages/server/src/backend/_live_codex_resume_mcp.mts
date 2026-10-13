// LIVE repro (not a unit test; excluded from the *.test.ts glob). Does a codex thread KEEP ntwine's MCP
// tools across a Ntwine restart that replaces its app-server?
//
//   nub packages/server/src/backend/_live_codex_resume_mcp.mts
//   TRANSPORT=native nub …   — the production transport (`--listen unix://`, detached listener)
//   STALE_CWD=1 nub …        — rename the thread's cwd away before the restart (a project directory
//                               rename, as hypergres → porg on 2026-09-18)
//
// Incident 2026-09-18 (hypergres/this-is-a-fresh-project-i): the 0.13.9 restart rejected the running
// codex 0.154.0 daemon, forked a 0.155.0 one, and auto-resumed the interrupted turn. The worker's own
// registry probe afterwards listed the operator's config.toml MCP servers and NO `mcp__ntwine__*` at
// all, so it could not register a question or sign off ("The restart removed Ntwine's
// question-registration tool"). The app-server's argv carried the process-wide `-c mcp_servers.ntwine`
// mount the whole time.
//
// The flow below is the real one: a REAL CodexAppServerBridge over a REAL `codex app-server`, a thread
// started with the per-thread mount, a turn killed mid-flight by SIGKILLing the app-server, then a
// second bridge over the same SQLite db — the restarted runtime — whose warmUp() reconciles the
// mid-turn row through `thread/resume` and auto-resumes it. Before and after, the model is asked to
// call the probe tool. The probe MCP server is mounted under ntwine's own server name (`ntwine`), so
// `codexThreadMcpConfig` and `codexMcpConfigArgs` are the exact code under test; every probe
// instance appends its lifecycle to one events file, tagged with the NTWINE_THREAD_SLUG it was given,
// which tells the per-thread mount from the argv one.
//
// The load-bearing evidence is the CALL event written by the probe when its tool actually executes,
// plus the model's own answer (the nonce, or the literal NOTOOL). PASS = the tool is callable after
// the restart exactly as it was before.
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"
import { nativeListenCodexAppServerHost, readNativeRecord } from "./codex-app-server-native.ts"
import { codexMcpConfigArgs } from "./codex-mcp.ts"
import type { NtwineMcp } from "./types.ts"

const CODEX_BIN = process.env.CODEX_BIN
  || join(homedir(), ".ntwine/runtimes/codex/0.155.0/vendor/aarch64-apple-darwin/bin/codex")
const NATIVE = process.env.TRANSPORT === "native"
const STALE_CWD = process.env.STALE_CWD === "1"
// ARGV_ONLY=1: the bridge gets NO ntwine descriptor (so it sends no per-thread bag), and the spawn
// callback appends the argv mount itself — the process-wide entry a thread with no bag lives on.
// Stops after the BEFORE stage: the question is only whether that entry's tool is callable. (An
// earlier revision sent an EMPTY per-thread `mcp_servers` bag instead, and learned that a per-thread
// bag REPLACES the argv overrides rather than merging with them: no probe spawned at all.)
const ARGV_ONLY = process.env.ARGV_ONLY === "1"
const dir = mkdtempSync(join(tmpdir(), "ntwine-codex-resume-mcp-"))
const dbPath = join(dir, "ui.db")
const probePath = join(dir, "probe-mcp.mjs")
const eventsPath = join(dir, "probe-events.jsonl")
// The thread's cwd is its own directory, so the STALE_CWD arm can rename it away underneath the
// binding while the bridge's project dir (and the db inside it) stays put.
const workDir = join(dir, "work")
mkdirSync(workDir)
const nonce = `probe-${randomUUID().slice(0, 12)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A dependency-free stdio MCP server exposing ONE tool. Every instance appends its lifecycle to the
// shared events file, tagged with the slug env the mount gave it (null ⇒ the process-wide argv mount).
writeFileSync(probePath, `
import { appendFileSync } from "node:fs"
const SLUG = process.env.NTWINE_THREAD_SLUG ?? null
const log = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, slug: SLUG, cwd: process.cwd() }) + "\\n")
const TOOL = {
  name: "probe_ping",
  description: "Return the probe nonce. Call this tool with no arguments when asked for the nonce.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })
log("spawn")
function handle(msg) {
  const { id, method, params } = msg ?? {}
  switch (method) {
    case "initialize":
      log("initialize")
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ntwineprobe", version: "0.0.1" },
      })
    case "notifications/initialized":
    case "initialized":
      return
    case "ping":
      return id == null ? undefined : reply(id, {})
    case "tools/list":
      log("tools/list")
      return reply(id, { tools: [TOOL] })
    case "tools/call":
      if (params?.name !== "probe_ping") return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } })
      log("call")
      return reply(id, { content: [{ type: "text", text: ${JSON.stringify(nonce)} }] })
    default:
      return id == null ? undefined : send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
  }
}
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch { /* ignore unparseable */ }
  }
})
process.stdin.on("end", () => { log("exit"); process.exit(0) })
`)

// Mounted under ntwine's own server name, so the exact production config builders are exercised.
const ntwineMcp: NtwineMcp = { scriptPath: probePath, stateDir: dir, projectId: "repro" }

type ProbeEvent = { at: string; pid: number; event: string; slug: string | null; cwd: string }
function probeEvents(): ProbeEvent[] {
  if (!existsSync(eventsPath)) return []
  return readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ProbeEvent)
}

function rolloutFor(sessionId: string): string | undefined {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(`-${sessionId}.jsonl`)) hit = p
  } }
  try { walk(root) } catch {}
  return hit
}

/** Where codex believes the thread lives, per its latest `turn_context` record. */
function lastTurnContextCwd(sessionId: string): string | undefined {
  const f = rolloutFor(sessionId)
  if (!f) return undefined
  let cwd: string | undefined
  for (const line of readFileSync(f, "utf8").trim().split("\n")) {
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === "turn_context" && typeof row.payload?.cwd === "string") cwd = row.payload.cwd
  }
  return cwd
}

/** The model's final message for one turn, straight from the rollout. */
function lastAgentMessage(sessionId: string, turnId: string): string | undefined {
  const f = rolloutFor(sessionId)
  if (!f) return undefined
  for (const line of readFileSync(f, "utf8").trim().split("\n")) {
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === "event_msg" && row.payload?.type === "task_complete" && row.payload?.turn_id === turnId) {
      return row.payload.last_agent_message ?? ""
    }
  }
  return undefined
}

let spawned: { pid: number; child: ChildProcessWithoutNullStreams }[] = []
const spawn: CodexAppServerSpawn = (binary, rawArgs, options) => {
  // ARGV_ONLY: the bridge was given no descriptor, so mount the argv entry here — the exact override
  // codexAppServerArgv would have put on the app-server's argv.
  const args = ARGV_ONLY ? [rawArgs[0]!, ...codexMcpConfigArgs(ntwineMcp), ...rawArgs.slice(1)] : [...rawArgs]
  const child = spawnChild(binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  spawned.push({ pid: child.pid!, child })
  // Production discards the app-server's stderr; keep it here, because an MCP child that fails to
  // start is reported ONLY there.
  child.stderr.pipe(createWriteStream(join(dir, `app-server-${child.pid}.stderr.log`)))
  console.log(`    [spawned codex app-server pid=${child.pid}] argv has mcp_servers.ntwine: ${args.some((a) => a.startsWith("mcp_servers.ntwine="))}`)
  return child
}

function makeBridge(label: string) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0, cid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: "repro", projectDir: dir, stateDir: dir, db, interactions, ...(ARGV_ONLY ? {} : { ntwineMcp }),
    codexBin: CODEX_BIN, ...(NATIVE ? { host: nativeListenCodexAppServerHost } : { spawn }),
    now: () => new Date(), id: () => `c-${label}-${++cid}`,
    requestTimeoutMs: 90_000,
    diagnostic: (e) => console.log(`    [diag:${label}]`, JSON.stringify(e)),
  })
  return { bridge, interactions, db }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** The app-server behind the current bridge: the stdio child we spawned, or the native listener's record. */
function appServerPid(): number {
  if (!NATIVE) return spawned.at(-1)!.pid
  return readNativeRecord(dir, "repro")!.listenerPid
}
const slug = "resume-mcp", sessionId = "session-resume-mcp"

async function waitTurnClear(bridge: CodexAppServerBridge, label: string, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (bridge.binding(slug, sessionId)?.currentTurnId == null) { console.log(`  ${label}: turn cleared after ${Date.now() - t0}ms`); return true }
    await sleep(250)
  }
  console.log(`  ${label}: TIMEOUT after ${ms}ms (turn still ${bridge.binding(slug, sessionId)?.currentTurnId})`)
  return false
}

const PROBE_PROMPT = "Call the probe_ping tool (no arguments) and reply with exactly what it returns, nothing else. " +
  "If no such tool exists in your tool registry, reply with exactly the single word NOTOOL."
const LONG_PROMPT = "Count slowly from 1 to 40. Put each number on its own line, and after each number write one full sentence of commentary about that number. Do not stop early."

/** Ask the model to call the probe tool; return what it said and whether the probe recorded a call. */
async function probeTurn(bridge: CodexAppServerBridge, codexSessionId: string, label: string) {
  const callsBefore = probeEvents().filter((e) => e.event === "call").length
  const { turnId } = await bridge.startTurn({ threadSlug: slug, sessionId, text: PROBE_PROMPT })
  console.log(`  ${label}: probe turn ${turnId}`)
  const cleared = await waitTurnClear(bridge, label, 240_000)
  const answer = cleared ? lastAgentMessage(codexSessionId, turnId) : undefined
  const called = probeEvents().filter((e) => e.event === "call").length > callsBefore
  const sawNonce = answer?.includes(nonce) ?? false
  console.log(`  ${label}: answer=${JSON.stringify(answer?.slice(0, 200))} called=${called} sawNonce=${sawNonce}`)
  return { called, sawNonce, answer }
}

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const fmt = (events: ProbeEvent[]) => JSON.stringify(events.map((e) => `${e.event}@${e.slug}`))

;(async () => {
  console.log(`dir:       ${dir}\nnonce:     ${nonce}\ncodex:     ${CODEX_BIN}\ntransport: ${NATIVE ? "native --listen" : "stdio"}\nstale cwd: ${STALE_CWD}`)
  try {
    // ---- 1. the thread as ntwine dispatches it ------------------------------------------------
    console.log("\n======== BEFORE: fresh app-server, thread/start with the per-thread mount ========")
    const one = makeBridge("1")
    const binding = await one.bridge.startDisposableSession({ threadSlug: slug, sessionId, cwd: workDir, sandbox: "read-only", ephemeral: false })
    console.log(`  bound thread=${binding.codexThreadId} codexSession=${binding.codexSessionId} app-server pid=${appServerPid()}`)
    await sleep(1500)
    console.log(`  probe events after thread/start: ${fmt(probeEvents())}`)
    const before = await probeTurn(one.bridge, binding.codexSessionId, "before")
    if (ARGV_ONLY) {
      console.log("\n======== VERDICT (argv mount only) ========")
      ok("the thread got the process-wide argv probe (no slug) and nothing else",
        probeEvents().some((e) => e.event === "initialize" && e.slug === null) && !probeEvents().some((e) => e.slug === slug), fmt(probeEvents()))
      ok("the argv-mounted tool is CALLABLE, not merely listed", before.called && before.sawNonce, before.answer?.slice(0, 120))
      try { one.bridge.close(); one.interactions.dispose(); one.db.close() } catch {}
      console.log(`\n==== ${failures === 0 ? "ARGV MOUNT CALLABLE" : "ARGV MOUNT REFUSED — read the tape above"} ====`)
      process.exit(failures === 0 ? 0 : 1)
    }

    // ---- 2. kill the app-server mid-turn: the restart the incident had -----------------------
    console.log("\n======== RESTART: SIGKILL the app-server mid-turn, then a new bridge over the same db ========")
    const { turnId: longTurn } = await one.bridge.startTurn({ threadSlug: slug, sessionId, text: LONG_PROMPT })
    console.log(`  long turn started: ${longTurn}`)
    await sleep(6000)
    const childPid = appServerPid()
    process.kill(childPid, "SIGKILL")
    await sleep(1500)
    console.log(`  app-server ${childPid} alive after SIGKILL? ${alive(childPid)}`)
    try { one.bridge.close() } catch {}
    try { one.interactions.dispose(); one.db.close() } catch {}
    if (STALE_CWD) {
      renameSync(workDir, `${workDir}-renamed`)
      console.log(`  renamed the thread's cwd away: ${workDir} → ${workDir}-renamed (binding still records the old path)`)
    }
    const eventsBeforeRestart = probeEvents().length

    const two = makeBridge("2")
    await two.bridge.warmUp()   // reconcile the mid-turn row + auto-resume it, exactly as boot does
    console.log(`  after warmUp: app-server pid=${appServerPid()} binding=${JSON.stringify(two.bridge.binding(slug, sessionId))}`)
    await waitTurnClear(two.bridge, "auto-resume nudge", 240_000)
    const sinceRestart = probeEvents().slice(eventsBeforeRestart)
    console.log(`  probe events since restart: ${fmt(sinceRestart)}`)
    const resumedCwd = lastTurnContextCwd(binding.codexSessionId)
    console.log(`  thread cwd per the rollout's latest turn_context: ${resumedCwd}  (binding: ${two.bridge.binding(slug, sessionId)?.cwd})`)
    if (STALE_CWD) {
      ok("a thread whose recorded cwd is gone was retargeted at the project's current directory", resumedCwd === dir, `rollout says ${resumedCwd}, project dir is ${dir}`)
    }

    // ---- 3. the same question, on the resumed thread ---------------------------------------
    console.log("\n======== AFTER: the resumed thread ========")
    const after = await probeTurn(two.bridge, binding.codexSessionId, "after")

    console.log("\n======== VERDICT ========")
    ok("BEFORE the restart the model can call the ntwine-mounted probe tool", before.called && before.sawNonce, before.answer?.slice(0, 120))
    ok("the fresh app-server spawned a probe for the resumed thread at all",
      sinceRestart.some((e) => e.event === "initialize"), fmt(sinceRestart))
    ok("the resumed thread got a probe instance carrying its slug (per-thread mount on thread/resume)",
      sinceRestart.some((e) => e.event === "initialize" && e.slug === slug))
    ok("AFTER the restart the model can still call the ntwine-mounted probe tool", after.called && after.sawNonce, after.answer?.slice(0, 120))

    for (const s of spawned) {
      const log = join(dir, `app-server-${s.pid}.stderr.log`)
      if (!existsSync(log)) continue
      const lines = readFileSync(log, "utf8").split("\n").filter((l) => /ntwine|mcp/i.test(l) && !/codex_apps|gmail|openaiDeveloperDocs/.test(l))
      if (lines.length) console.log(`\n  app-server ${s.pid} stderr (mcp/ntwine lines):\n    ${lines.slice(0, 20).join("\n    ")}`)
    }
    try { two.bridge.close(); two.interactions.dispose(); two.db.close() } catch {}
    console.log(`\n==== ${failures === 0 ? "MCP MOUNT SURVIVES THE RESTART" : "MOUNT LOST ACROSS THE RESTART — read the tape above"} ====`)
    process.exit(failures === 0 ? 0 : 1)
  } catch (e) {
    console.error("REPRO ERROR:", (e as Error).message, (e as Error).stack)
    process.exit(2)
  } finally {
    for (const s of spawned) { try { s.child.kill("SIGKILL") } catch {} }
    if (NATIVE) { try { process.kill(appServerPid(), "SIGKILL") } catch {} }
  }
})()
