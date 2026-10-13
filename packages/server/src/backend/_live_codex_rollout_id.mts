// LIVE MEASUREMENT: which codex id names the rollout file on disk — `codexThreadId` or
// `codexSessionId`?
//   nub packages/server/src/backend/_live_codex_rollout_id.mts
//
// Why: the live probes locate a rollout by `binding.codexSessionId`
// (_live_appserver_harness.mts's findRollout, _live_appserver_daemon_survival.mts and
// _live_appserver_daemon_to_native_migration.mts's rolloutStats). If that is the wrong key the lookup
// returns undefined/zero SILENTLY, which reads as "the turn never ran" rather than "I looked in the
// wrong place" — the exact misdiagnosis that cost a cycle while probing codex MCP injection.
//
// `codex_session_id` and `codex_thread_id` are distinct columns and the session id is REWRITTEN on
// resume (codex-app-server.ts), so they cannot be assumed interchangeable. This prints both against
// the real filename so the answer is measured, not inferred.
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync, readdirSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-rollout-id-"))
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every rollout filename under CODEX_HOME/sessions, newest first by mtime. */
function rolloutNames(): { name: string; mtimeMs: number }[] {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  const out: { name: string; mtimeMs: number }[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".jsonl")) {
        try { out.push({ name: e.name, mtimeMs: statSync(p).mtimeMs }) }
        catch { /* raced away between readdir and stat */ }
      }
    }
  }
  try { walk(root) } catch { /* no sessions dir */ }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

;(async () => {
  const slug = "rollout-id-probe", sessionId = "rollout-id-session"
  try {
    const spawned = await bridge.spawnDispatch({
      threadSlug: slug, sessionId, cwd: dir, sandbox: "read-only",
      prompt: "Reply with exactly the word: OK",
    })
    const threadId = spawned.binding.codexThreadId
    const sessId = spawned.binding.codexSessionId
    const turnId = () => bridge.binding(slug, sessionId)?.currentTurnId ?? null
    const t0 = Date.now()
    let saw = false
    while (Date.now() - t0 < 90_000) {
      const id = turnId()
      if (id !== null) saw = true
      else if (saw) break
      await sleep(250)
    }

    console.log(`codexThreadId:  ${threadId}`)
    console.log(`codexSessionId: ${sessId}`)
    console.log(`ids equal:      ${threadId === sessId}`)

    const names = rolloutNames().slice(0, 40).map((r) => r.name)
    const byThread = names.find((n) => n.endsWith(`-${threadId}.jsonl`))
    const bySession = names.find((n) => n.endsWith(`-${sessId}.jsonl`))
    console.log(`matched by THREAD id:  ${byThread ?? "(none)"}`)
    console.log(`matched by SESSION id: ${bySession ?? "(none)"}`)
    console.log(`\nVERDICT: rollout is keyed by ${byThread ? "codexThreadId" : bySession ? "codexSessionId" : "NEITHER (widen the search)"}`)
  } catch (e) {
    console.error("PROBE ERROR:", (e as Error).message)
  } finally {
    bridge.close(); interactions.dispose(); db.close()
    process.exit(0)
  }
})()
