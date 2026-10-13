// LIVE MEASUREMENT: does the bridge ADOPT a turn the codex app-server opens on its own?
//   nub packages/server/src/backend/_live_codex_goal_turn.mts
//
// Why: a codex THREAD GOAL (`thread/goal/set`, which a worker can arm through codex's own
// `create_goal` tool) makes the app-server start a continuation turn the instant the previous one
// completes, with no `turn/start` from the client. The bridge used to ignore that `turn/started`, so
// `current_turn_id` stayed null for the turn's whole life and the operator's follow-up was refused as an
// outside writer ("running in your terminal", live 2026-09-10). This drives the REAL app-server: one
// dispatched turn, a goal set on the thread, then it watches the binding for a turn id the bridge never
// requested, steers it through `followUp`, clears the goal and interrupts. The seam under test is the
// notification path, so nothing here is stubbed.
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-goal-turn-"))
const db = new Database(join(dir, "ui.db"))
db.pragma("journal_mode = WAL")
let iid = 0, cid = 0
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })
const spawn: CodexAppServerSpawn = (binary, args, options) =>
  spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
const bridge = new CodexAppServerBridge({
  projectId: "live", projectDir: dir, db, interactions,
  codexBin: CODEX_BIN, spawn, now: () => new Date(), id: () => `c-${++cid}`,
  requestTimeoutMs: 60_000, diagnostic: () => {},
})

// Log every turn-level notification the app-server sends us, on top of the bridge's own handling.
type Handle = (connection: unknown, method: string, params: unknown) => Promise<void>
const raw = bridge as unknown as { handleNotification: Handle; connection: { request(method: string, params: unknown): Promise<unknown> } | null }
const original = raw.handleNotification
raw.handleNotification = function (connection, method, params) {
  if (method.startsWith("turn/") || method.startsWith("thread/goal")) console.log(`${new Date().toISOString().slice(11, 23)} NOTIFY ${method} ${JSON.stringify(params).slice(0, 160)}`)
  return original.call(this, connection, method, params)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const slug = "goal-turn-probe", sessionId = "goal-turn-session"
  try {
    const spawned = await bridge.spawnDispatch({
      threadSlug: slug, sessionId, cwd: dir, sandbox: "read-only",
      prompt: "Reply with exactly the word: OK",
    })
    const threadId = spawned.binding.codexThreadId
    const firstTurn = spawned.turnId
    console.log(`dispatched turn: ${firstTurn}`)

    // Arm the goal while the first turn runs, so the app-server has something to continue toward.
    const shapes: unknown[] = [
      { threadId, goal: { objective: "Count from one to three, one number per turn, then stop." } },
      { threadId, objective: "Count from one to three, one number per turn, then stop." },
    ]
    let goalSet = false
    for (const params of shapes) {
      try {
        const result = await raw.connection!.request("thread/goal/set", params)
        console.log(`thread/goal/set OK with ${JSON.stringify(params).slice(0, 80)} → ${JSON.stringify(result).slice(0, 200)}`)
        goalSet = true
        break
      } catch (e) {
        console.log(`thread/goal/set rejected ${JSON.stringify(params).slice(0, 60)}: ${(e as Error).message.slice(0, 200)}`)
      }
    }
    if (!goalSet) throw new Error("could not set a thread goal; the probe cannot proceed")

    const current = () => bridge.binding(slug, sessionId)?.currentTurnId ?? null
    const live = () => bridge.turnLiveness(slug, sessionId)?.bridgeTurn ?? false
    // Wait for the dispatched turn to retire, then for a turn we never started to appear.
    const t0 = Date.now()
    let adopted: string | null = null
    let sawFirstEnd = false
    while (Date.now() - t0 < 180_000) {
      const id = current()
      if (id === null) sawFirstEnd = sawFirstEnd || true
      if (id !== null && id !== firstTurn) { adopted = id; break }
      await sleep(200)
    }
    console.log(`first turn ended: ${sawFirstEnd}`)
    console.log(`adopted turn:     ${adopted ?? "(none within 180s)"}`)
    console.log(`bridgeTurn:       ${live()}`)
    let steer: string | undefined
    if (adopted) {
      const result = await bridge.followUp({ threadSlug: slug, sessionId, text: "Stop counting and reply with exactly the word: DONE" })
      steer = `${result.mode} on ${result.turnId}`
      console.log(`followUp:         ${steer}`)
    }
    console.log(`\nVERDICT: ${adopted && live() && steer?.startsWith("steer on " + adopted) ? "PASS — the app-server's own turn was adopted and steered" : "FAIL"}`)
    try { await raw.connection!.request("thread/goal/clear", { threadId }) } catch (e) { console.log(`goal clear: ${(e as Error).message.slice(0, 120)}`) }
    if (current() !== null) {
      try { await bridge.interruptTurn(slug, sessionId) } catch (e) { console.log(`interrupt: ${(e as Error).message.slice(0, 120)}`) }
    }
    await sleep(1_000)
  } catch (e) {
    console.error("PROBE ERROR:", (e as Error).message)
  } finally {
    bridge.close(); interactions.dispose(); db.close()
    process.exit(0)
  }
})()
