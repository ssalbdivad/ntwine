// LIVE harness (not a unit test; excluded from the *.test.ts glob). Drives the REAL CodexAppServerBridge
// against the REAL `codex app-server` 0.144.6 to observe steer/interrupt behavior end-to-end and learn
// the ACTUAL error semantics of a stale turn/steer. Run:
//   nub packages/server/src/backend/_live_appserver_harness.mts
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"
import { codexFirstOutputTitleInstructions } from "./codex.ts"

function findRollout(sessionId: string): string | undefined {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith(`-${sessionId}.jsonl`)) hit = p
  } }
  try { walk(root) } catch {}
  return hit
}

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-live-appserver-"))
const db = new Database(join(dir, "ui.db"))
db.pragma("journal_mode = WAL")
let iid = 0, cid = 0
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })
const spawn: CodexAppServerSpawn = (binary, args, options) =>
  spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
const bridge = new CodexAppServerBridge({
  projectId: "live", projectDir: dir, db, interactions,
  codexBin: CODEX_BIN, spawn, now: () => new Date(), id: () => `c-${++cid}`,
  requestTimeoutMs: 30_000, diagnostic: (e) => { if ((e as { event?: string }).event !== "connected") console.log("[diag]", JSON.stringify(e)) },
})

const slug = "live-thread", sessionId = "live-session"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const turnId = () => bridge.binding(slug, sessionId)?.currentTurnId ?? null
async function waitTurnClear(label: string, ms = 40_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (turnId() === null) { console.log(`  ${label}: turn cleared after ${Date.now() - t0}ms`); return } await sleep(150) }
  console.log(`  ${label}: TIMEOUT waiting for turn to clear (still ${turnId()})`)
}

;(async () => {
  try {
    console.log("=== startDisposableSession (ephemeral:false) + config injection (M2) ===")
    const binding = await bridge.startDisposableSession({
      threadSlug: slug, sessionId, cwd: dir, sandbox: "read-only", ephemeral: false,
      developerInstructions: codexFirstOutputTitleInstructions([]),
      config: { model_reasoning_summary: "detailed" },
    })
    console.log("thread bound:", binding.codexThreadId, " codexSessionId:", binding.codexSessionId)

    console.log("=== startTurn (long-ish so we can steer mid-flight) ===")
    const t1 = await bridge.startTurn({ threadSlug: slug, sessionId, text: "Write a careful ~250 word explanation of how a hash map handles collisions. Take your time." })
    console.log("turn started:", t1.turnId, " current_turn_id:", turnId())

    await sleep(400)
    console.log("=== steerTurn WHILE turn active ===")
    try { const s = await bridge.steerTurn({ threadSlug: slug, sessionId, text: "Also, briefly compare open addressing vs chaining." }); console.log("  STEER OK ->", s.turnId) }
    catch (e) { console.log("  STEER FAILED (unexpected):", (e as Error).message) }

    await waitTurnClear("post-steer")

    console.log("=== M2 CHECK: rollout has reasoning + ntwine title comment? ===")
    const rollout = findRollout(binding.codexSessionId)
    if (rollout) {
      const lines = readFileSync(rollout, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l) } catch { return {} } })
      const hasReasoning = lines.some((r) => r.type === "response_item" && r.payload?.type === "reasoning")
      const firstAgent = lines.find((r) => r.type === "event_msg" && r.payload?.type === "agent_message")
      const titleComment = typeof firstAgent?.payload?.message === "string" && /<!--\s*ntwine title=/.test(firstAgent.payload.message)
      console.log(`  rollout=${rollout.split("/").pop()}  reasoning=${hasReasoning}  ntwineTitleComment=${titleComment}`)
      if (titleComment) console.log("  title line:", (firstAgent.payload.message as string).split("\n")[0].slice(0, 120))
    } else console.log("  ROLLOUT NOT FOUND for", binding.codexSessionId)

    console.log("=== steerTurn AFTER turn ended (expect failure — learn the REAL error) ===")
    try { const s = await bridge.steerTurn({ threadSlug: slug, sessionId, text: "This should fail: no active turn." }); console.log("  STEER unexpectedly OK ->", s.turnId) }
    catch (e) { const err = e as Error & { code?: number }; console.log(`  STEER FAILED as expected. code=${err.code} message=${JSON.stringify(err.message)}`) }

    console.log("=== interruptTurn: start a turn then interrupt it ===")
    const t2 = await bridge.startTurn({ threadSlug: slug, sessionId, text: "Write an extremely long, exhaustive 1000-word essay about the history of sorting algorithms." })
    console.log("turn started:", t2.turnId, " current_turn_id:", turnId())
    await sleep(500)
    const ir = await bridge.interruptTurn(slug, sessionId)
    console.log("  interrupt ->", JSON.stringify(ir))
    await waitTurnClear("post-interrupt")

    console.log("=== followUp on IDLE session -> expect mode=start ===")
    const f1 = await bridge.followUp({ threadSlug: slug, sessionId, text: "Say the single word: ALPHA", deliveryId: "d-alpha" })
    console.log("  followUp ->", JSON.stringify(f1), " current_turn_id:", turnId())
    console.log("=== followUp again while that turn is ACTIVE -> expect mode=steer ===")
    await sleep(300)
    const f2 = await bridge.followUp({ threadSlug: slug, sessionId, text: "Also say: BETA", deliveryId: "d-beta" })
    console.log("  followUp ->", JSON.stringify(f2))
    console.log("=== followUp with a REPEATED deliveryId -> expect deduped=true, same turnId ===")
    const f2again = await bridge.followUp({ threadSlug: slug, sessionId, text: "Also say: BETA", deliveryId: "d-beta" })
    console.log("  followUp(dup) ->", JSON.stringify(f2again), " dedup-correct:", f2again.deduped === true && f2again.turnId === f2.turnId)
    await waitTurnClear("post-followup")

    console.log("\n==== LIVE HARNESS OK ====")
    bridge.close(); interactions.dispose(); db.close(); process.exit(0)
  } catch (e) {
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
    try { bridge.close(); interactions.dispose(); db.close() } catch {}
    process.exit(2)
  }
})()
