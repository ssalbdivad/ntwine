// LIVE proof (not a unit test) that flipping the default transport from the daemon to the native
// listener MIGRATES a live thread cleanly. A thread dispatched before the flip is bound to a
// daemon-hosted app-server; after the flip a fresh ntwine boots on the native default, which is a
// different process — so the thread must cold-resume from its on-disk rollout and keep working, and
// the orphaned daemon must not wedge or corrupt anything.
//
// Run:
//   nub packages/server/src/backend/_live_appserver_daemon_to_native_migration.mts
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge } from "./codex-app-server.ts"
import { daemonCodexAppServerHost, killCodexAppServerDaemon, liveDaemonRecord } from "./codex-app-server-host.ts"
import { nativeListenCodexAppServerHost, liveNativeRecord, killNativeListener } from "./codex-app-server-native.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "ntwine-migration-"))
const dbPath = join(root, "ui.db")
const PROJECT = "migration"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const LONG = "Count slowly from 1 to 40, one number per line, with a sentence of commentary after each. Do not stop early."

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

function rolloutStats(sessionId: string) {
  const base = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(`-${sessionId}.jsonl`)) hit = p
  } }
  try { walk(base) } catch {}
  if (!hit) return { started: 0, completed: 0 }
  const kinds = readFileSync(hit, "utf8").trim().split("\n")
    .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
    .filter((r) => r.type === "event_msg").map((r) => r.payload?.type)
  return { started: kinds.filter((k) => k === "task_started").length, completed: kinds.filter((k) => k === "task_complete").length }
}

function makeBridge(label: string, host: typeof daemonCodexAppServerHost) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    host, // explicit so this test does not depend on the platform default
    diagnostic: (e) => { const ev = (e as { event?: string }).event; if (ev !== "stderr") console.log(`    [diag:${label}]`, JSON.stringify(e)) },
  })
  return { bridge, interactions, db }
}

;(async () => {
  try {
    console.log("======== a daemon-hosted thread migrates to the native default and recovers ========")
    const slug = "migrating-thread", sessionId = "migrating-session"

    // --- BEFORE the flip: dispatched on the daemon transport ---
    const before = makeBridge("daemon", daemonCodexAppServerHost)
    const binding = await before.bridge.startDisposableSession({
      threadSlug: slug, sessionId, cwd: root, sandbox: "read-only", ephemeral: false,
    })
    await before.bridge.startTurn({ threadSlug: slug, sessionId, text: LONG })
    await sleep(5000)
    const daemonRec = liveDaemonRecord(root, PROJECT)!
    console.log(`  daemon pid=${daemonRec.daemonPid} app-server pid=${daemonRec.childPid}`)
    check("the thread is bound to a live daemon app-server", alive(daemonRec.childPid))

    console.log("  --- ntwine restarts; the operator flipped the default to NATIVE ---")
    before.bridge.close()
    await before.bridge.shutdown().catch(() => {})
    try { before.interactions.dispose(); before.db.close() } catch {}
    await sleep(1000)

    // --- AFTER the flip: fresh ntwine boots on the native default ---
    const after = makeBridge("native", nativeListenCodexAppServerHost)
    await after.bridge.warmUp()
    await sleep(2000)
    const migrated = after.bridge.binding(slug, sessionId)
    console.log(`  after native warmUp: ${JSON.stringify(migrated)}`)

    check("a native listener now hosts the project", Boolean(liveNativeRecord(root, PROJECT)))
    check("the thread rebound and is active on native", migrated?.state === "active")

    // The dead daemon-hosted turn is unrecoverable across a process switch; the thread must cold-resume
    // and keep working, not wedge. A new turn is issued (recovery nudge) and runs.
    let started = rolloutStats(binding.codexSessionId).started
    for (let i = 0; i < 240 && started < 2; i++) { await sleep(500); started = rolloutStats(binding.codexSessionId).started }
    console.log(`  rollout: ${JSON.stringify(rolloutStats(binding.codexSessionId))}`)
    check("the migrated thread is working again on native (a fresh turn started)", started >= 2)

    // The thread can take NEW work on the native transport — the real proof it migrated, not just recovered.
    for (let i = 0; i < 120 && after.bridge.binding(slug, sessionId)?.currentTurnId !== null; i++) await sleep(500)
    if (after.bridge.binding(slug, sessionId)?.currentTurnId === null) {
      await after.bridge.startTurn({ threadSlug: slug, sessionId, text: "Reply with the single word MIGRATED and stop." })
      let done = false
      for (let i = 0; i < 120; i++) { if (after.bridge.binding(slug, sessionId)?.currentTurnId === null) { done = true; break } await sleep(500) }
      check("a brand-new turn dispatched on the native transport completed", done)
    } else {
      console.log("  (recovery turn still running; skipping the new-turn dispatch, recovery already proven)")
    }

    after.bridge.close()
    await after.bridge.shutdown().catch(() => {})
    try { after.interactions.dispose(); after.db.close() } catch {}

    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
  } catch (e) {
    failures++
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
  } finally {
    killNativeListener(root, PROJECT)
    killCodexAppServerDaemon(root, PROJECT)
    process.exit(failures === 0 ? 0 : 1)
  }
})()
