// LIVE proof for A+B (not a unit test; excluded from the *.test.ts glob). The counterpart to
// _live_appserver_restart_repro.mts, which showed an ntwine runtime restart silently killing an
// in-flight codex turn. Run:
//   node packages/server/src/backend/_live_appserver_daemon_survival.mts
//
// A — the app-server now lives in a DETACHED daemon, so a runtime restart must leave the turn running
//     and the next generation must rejoin the SAME process and see the turn finish.
// B — when the app-server itself dies, the restarted runtime must notice the turn is unrecoverable and
//     re-issue one, instead of leaving the thread silent until a human pokes it.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge } from "./codex-app-server.ts"
import { killCodexAppServerDaemon, liveDaemonRecord } from "./codex-app-server-host.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "ntwine-daemon-survival-"))
const dbPath = join(root, "ui.db")
const PROJECT = "survival"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function rolloutStats(sessionId: string) {
  const base = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(`-${sessionId}.jsonl`)) hit = p
  } }
  try { walk(base) } catch {}
  if (!hit) return { started: 0, completed: 0, aborted: 0 }
  const kinds = readFileSync(hit, "utf8").trim().split("\n")
    .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
    .filter((r) => r.type === "event_msg").map((r) => r.payload?.type)
  return {
    started: kinds.filter((k) => k === "task_started").length,
    completed: kinds.filter((k) => k === "task_complete").length,
    aborted: kinds.filter((k) => k === "turn_aborted").length,
  }
}

function makeBridge(label: string) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    diagnostic: (e) => { const ev = (e as { event?: string }).event; if (ev !== "stderr") console.log(`    [diag:${label}]`, JSON.stringify(e)) },
  })
  return { bridge, interactions, db }
}

const bindingRow = () => {
  const probe = new Database(dbPath, { readonly: true })
  try { return probe.prepare("SELECT thread_slug, state, connection_epoch, current_turn_id, auto_resume_count FROM codex_app_server_session").all() }
  finally { probe.close() }
}

const LONG = "Count slowly from 1 to 30, one number per line, and after each number write a full sentence of commentary about it. Do not stop early."
let failures = 0
const check = (label: string, ok: boolean) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++ }

;(async () => {
  try {
    // ================= A: the turn survives an ntwine runtime restart =================
    console.log("\n======== A — runtime restart must NOT kill the turn ========")
    const slugA = "survive-a", sessionA = "session-a"
    const one = makeBridge("gen1")
    const bindingA = await one.bridge.startDisposableSession({
      threadSlug: slugA, sessionId: sessionA, cwd: root, sandbox: "read-only", ephemeral: false,
    })
    const { turnId } = await one.bridge.startTurn({ threadSlug: slugA, sessionId: sessionA, text: LONG })
    console.log(`  turn started: ${turnId}`)
    await sleep(5000)

    const record = liveDaemonRecord(root, PROJECT)!
    console.log(`  daemon pid=${record.daemonPid} app-server pid=${record.childPid} generation=${record.generation}`)
    console.log(`  MID-TURN rows: ${JSON.stringify(bindingRow())}`)

    console.log("  --- recycling the ntwine runtime (bridge.close() + drop the db handle) ---")
    one.bridge.close()
    await one.bridge.shutdown().catch(() => {})
    try { one.interactions.dispose(); one.db.close() } catch {}
    await sleep(1500)

    check("the daemon outlived the runtime", alive(record.daemonPid))
    check("the app-server outlived the runtime", alive(record.childPid))

    console.log("  --- new ntwine runtime generation boots and warms up ---")
    const two = makeBridge("gen2")
    await two.bridge.warmUp()
    const rejoined = two.bridge.binding(slugA, sessionA)
    console.log(`  after warmUp: ${JSON.stringify(rejoined)}`)
    check("rejoined the SAME app-server (record generation unchanged)", liveDaemonRecord(root, PROJECT)?.generation === record.generation)
    check("no new app-server was spawned", liveDaemonRecord(root, PROJECT)?.childPid === record.childPid)
    check("the binding is active again", rejoined?.state === "active")
    check("and it still owns the very turn that was running", rejoined?.currentTurnId === turnId)

    console.log("  --- waiting for that same turn to finish on its own ---")
    let cleared = false
    for (let i = 0; i < 240; i++) {
      if (two.bridge.binding(slugA, sessionA)?.currentTurnId === null) { cleared = true; break }
      await sleep(500)
    }
    const statsA = rolloutStats(bindingA.codexSessionId)
    console.log(`  rollout: ${JSON.stringify(statsA)}`)
    check("turn/completed arrived and cleared the turn", cleared)
    check("the rollout shows the turn actually COMPLETED (the old bug left this at 0)", statsA.completed >= 1)

    two.bridge.close()
    await two.bridge.shutdown().catch(() => {})
    try { two.interactions.dispose(); two.db.close() } catch {}
    killCodexAppServerDaemon(root, PROJECT)
    await sleep(1000)

    // ================= B: the app-server really dies -> auto-resume =================
    console.log("\n======== B — app-server death must be auto-recovered ========")
    const slugB = "survive-b", sessionB = "session-b"
    const three = makeBridge("gen3")
    const bindingB = await three.bridge.startDisposableSession({
      threadSlug: slugB, sessionId: sessionB, cwd: root, sandbox: "read-only", ephemeral: false,
    })
    const turnB = (await three.bridge.startTurn({ threadSlug: slugB, sessionId: sessionB, text: LONG })).turnId
    console.log(`  turn started: ${turnB}`)
    await sleep(5000)
    const recordB = liveDaemonRecord(root, PROJECT)!

    console.log("  --- killing the daemon outright (an app-server crash, not an ntwine restart) ---")
    killCodexAppServerDaemon(root, PROJECT)
    await sleep(1500)
    check("the app-server is gone", !alive(recordB.childPid))
    three.bridge.close()
    await three.bridge.shutdown().catch(() => {})
    try { three.interactions.dispose(); three.db.close() } catch {}

    console.log("  --- new runtime generation boots and warms up ---")
    const four = makeBridge("gen4")
    await four.bridge.warmUp()
    await sleep(2000)
    const afterB = four.bridge.binding(slugB, sessionB)
    console.log(`  after warmUp: ${JSON.stringify(afterB)}`)
    console.log(`  rows: ${JSON.stringify(bindingRow())}`)
    check("a NEW app-server was started", liveDaemonRecord(root, PROJECT)?.childPid !== recordB.childPid)
    check("the dead turn was retired", afterB?.currentTurnId !== turnB)
    check("a recovery turn was auto-issued", Boolean(afterB?.currentTurnId))

    let statsB = rolloutStats(bindingB.codexSessionId)
    for (let i = 0; i < 240 && statsB.started < 2; i++) { await sleep(500); statsB = rolloutStats(bindingB.codexSessionId) }
    console.log(`  rollout: ${JSON.stringify(statsB)}`)
    check("the rollout shows a second turn actually started (the thread is working again)", statsB.started >= 2)

    four.bridge.close()
    await four.bridge.shutdown().catch(() => {})
    try { four.interactions.dispose(); four.db.close() } catch {}

    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
    process.exit(failures === 0 ? 0 : 1)
  } catch (e) {
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
    process.exit(2)
  } finally {
    killCodexAppServerDaemon(root, PROJECT)
  }
})()
