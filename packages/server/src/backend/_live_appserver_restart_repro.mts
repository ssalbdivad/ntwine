// LIVE repro (not a unit test; excluded from the *.test.ts glob). Reproduces the "codex threads stop
// spontaneously" failure against the REAL `codex app-server`: a ntwine runtime restart kills the shared
// app-server child mid-turn, and NOTHING ever resumes the interrupted turn.
//
//   nub packages/server/src/backend/_live_appserver_restart_repro.mts
//
// Two death modes are exercised, matching the two real ones:
//   A. graceful  — bridge.close() (what a clean ntwine shutdown / update-restart drain does)
//   B. hard kill — SIGKILL the app-server child (what a SIGKILLed or crashed ntwine runtime does)
// After each, a SECOND bridge is constructed over the SAME SQLite db — i.e. the restarted ntwine
// runtime — and we observe what it does about the in-flight turn.
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-restart-repro-"))
const dbPath = join(dir, "ui.db")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

// Terminal turn events codex writes when a turn really ends. Their ABSENCE is the bug.
function rolloutTail(sessionId: string) {
  const f = rolloutFor(sessionId)
  if (!f) return { file: undefined, started: 0, completed: 0, aborted: 0, last: "n/a" }
  const rows = readFileSync(f, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  const kinds = rows.filter((r) => r.type === "event_msg").map((r) => r.payload?.type)
  const last = rows.at(-1)
  return {
    file: f.split("/").pop(),
    started: kinds.filter((k) => k === "task_started").length,
    completed: kinds.filter((k) => k === "task_complete").length,
    aborted: kinds.filter((k) => k === "turn_aborted").length,
    last: `${last?.timestamp} ${last?.type}/${last?.payload?.type ?? ""}`,
  }
}

const bindingRow = () => {
  const probe = new Database(dbPath, { readonly: true })
  try {
    return probe.prepare("SELECT thread_slug, state, connection_epoch, current_turn_id FROM codex_app_server_session").all()
  } finally { probe.close() }
}

let spawned: { pid: number; child: ChildProcessWithoutNullStreams }[] = []
const spawn: CodexAppServerSpawn = (binary, args, options) => {
  const child = spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  spawned.push({ pid: child.pid!, child })
  console.log(`    [spawned codex app-server pid=${child.pid}]`)
  return child
}

function makeBridge(label: string) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0, cid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: "repro", projectDir: dir, db, interactions,
    codexBin: CODEX_BIN, spawn, now: () => new Date(), id: () => `c-${label}-${++cid}`,
    requestTimeoutMs: 30_000,
    diagnostic: (e) => console.log(`    [diag:${label}]`, JSON.stringify(e)),
  })
  return { bridge, interactions, db }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const LONG_PROMPT = "Count slowly from 1 to 40. Put each number on its own line, and after each number write one full sentence of commentary about that number. Do not stop early."

async function scenario(label: string, kill: (b: CodexAppServerBridge) => Promise<void>) {
  const slug = `repro-${label}`, sessionId = `session-${label}`
  console.log(`\n======== SCENARIO ${label} ========`)
  const one = makeBridge(`${label}1`)
  const binding = await one.bridge.startDisposableSession({
    threadSlug: slug, sessionId, cwd: dir, sandbox: "read-only", ephemeral: false,
  })
  console.log(`  bound thread=${binding.codexThreadId} codexSession=${binding.codexSessionId}`)

  const { turnId } = await one.bridge.startTurn({ threadSlug: slug, sessionId, text: LONG_PROMPT })
  console.log(`  turn started: ${turnId}`)
  await sleep(6000) // let the model actually produce work so the interruption is genuinely mid-turn

  const liveBefore = one.bridge.turnLiveness(slug, sessionId)
  console.log(`  MID-TURN liveness: ${JSON.stringify(liveBefore)}`)
  console.log(`  MID-TURN db rows: ${JSON.stringify(bindingRow())}`)
  const childPid = spawned.at(-1)!.pid

  console.log(`  --- killing the runtime's app-server (${label}) ---`)
  await kill(one.bridge)
  await sleep(1500)
  console.log(`  app-server pid ${childPid} alive after kill? ${alive(childPid)}`)
  try { one.interactions.dispose(); one.db.close() } catch {}

  console.log(`  db rows AFTER death: ${JSON.stringify(bindingRow())}`)

  // ---- the "restarted ntwine runtime": a brand-new bridge over the same durable db ----
  console.log(`  --- restarting the ntwine runtime (new bridge, same db) ---`)
  const two = makeBridge(`${label}2`)
  await sleep(4000) // give a hypothetical auto-recovery every chance to fire
  console.log(`  after restart, spawned app-servers so far: ${spawned.length}`)
  console.log(`  after restart, binding known to new bridge: ${JSON.stringify(two.bridge.binding(slug, sessionId))}`)
  console.log(`  after restart, turnLiveness: ${JSON.stringify(two.bridge.turnLiveness(slug, sessionId))}`)
  console.log(`  after restart, db rows: ${JSON.stringify(bindingRow())}`)

  await sleep(8000) // ...and keep waiting: does the turn ever resume on its own?
  const tail = rolloutTail(binding.codexSessionId)
  console.log(`  ROLLOUT after restart+wait: ${JSON.stringify(tail)}`)
  console.log(`  >>> turn terminal event present? ${tail.completed + tail.aborted > 0 ? "YES" : "NO — turn died silently"}`)
  console.log(`  >>> app-server respawned by itself? ${spawned.length > 1 && alive(spawned.at(-1)!.pid) && spawned.at(-1)!.pid !== childPid ? "YES" : "NO"}`)

  try { two.bridge.close(); two.interactions.dispose(); two.db.close() } catch {}
  return { binding, tail }
}

;(async () => {
  try {
    await scenario("a-graceful", async (b) => { b.close(); await sleep(500) })
    spawned = []
    await scenario("b-hardkill", async () => { process.kill(spawned.at(-1)!.pid, "SIGKILL"); await sleep(500) })
    console.log("\n==== REPRO COMPLETE ====")
    process.exit(0)
  } catch (e) {
    console.error("REPRO ERROR:", (e as Error).message, (e as Error).stack)
    process.exit(2)
  } finally {
    for (const s of spawned) { try { s.child.kill("SIGKILL") } catch {} }
  }
})()
