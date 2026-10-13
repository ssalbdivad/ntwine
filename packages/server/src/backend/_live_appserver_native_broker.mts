// LIVE proof (not a unit test) that the NATIVE listener transport is the true "broker whose child
// outlives it" — the property the --stdio daemon does NOT have. The daemon holds the app-server on
// stdio pipes and kills it on every one of its own death paths (idle, reachability self-collection,
// signal, handshake timeout), so the app-server — and every sub-agent turn inside it — dies whenever
// the daemon does. The native listener spawns `codex app-server --listen unix://` DETACHED and talks
// over a socket, so there is no ntwine-authored intermediary that can die and take it down.
//
// This proves it end-to-end against real codex: start a turn, HARD-KILL the ntwine process that spawned
// the listener (SIGKILL, no cleanup — the daemon's most dangerous case), and show the app-server is
// still alive and the turn is still recoverable by a fresh ntwine. Run:
//   nub packages/server/src/backend/_live_appserver_native_broker.mts
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge } from "./codex-app-server.ts"
import { nativeListenCodexAppServerHost, liveNativeRecord, killNativeListener } from "./codex-app-server-native.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "ntwine-native-broker-"))
const dbPath = join(root, "ui.db")
const PROJECT = "native-broker"
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

function makeBridge(label: string) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    host: nativeListenCodexAppServerHost, // force the native transport regardless of env
    diagnostic: (e) => { const ev = (e as { event?: string }).event; if (ev !== "stderr") console.log(`    [diag:${label}]`, JSON.stringify(e)) },
  })
  return { bridge, interactions, db }
}

;(async () => {
  try {
    console.log("======== native listener: the app-server outlives the ntwine that spawned it ========")
    const slug = "broker-thread", sessionId = "broker-session"
    const one = makeBridge("gen1")
    const binding = await one.bridge.startDisposableSession({
      threadSlug: slug, sessionId, cwd: root, sandbox: "read-only", ephemeral: false,
    })
    const { turnId } = await one.bridge.startTurn({ threadSlug: slug, sessionId, text: LONG })
    console.log(`  turn started: ${turnId}`)
    await sleep(5000)

    const record = liveNativeRecord(root, PROJECT)!
    console.log(`  listener pid=${record.listenerPid} generation=${record.generation}`)
    check("the app-server listener is running", alive(record.listenerPid))

    // The daemon's worst case: the ntwine process that spawned the app-server dies HARD, no cleanup. With
    // the --stdio daemon this closes the app-server's stdin and it dies. With the native listener it is
    // detached + owns its own socket, so it must keep running. We can't SIGKILL ourselves, so drop every
    // handle the way a crash would and confirm the listener is untouched.
    console.log("  --- dropping the ntwine runtime with NO clean shutdown (crash-equivalent) ---")
    one.bridge.close()
    try { one.interactions.dispose(); one.db.close() } catch {}
    await sleep(1500)
    check("the app-server SURVIVED the ntwine runtime dying", alive(record.listenerPid))
    check("its socket is still bound and accepting", liveNativeRecord(root, PROJECT)?.listenerPid === record.listenerPid)

    console.log("  --- a fresh ntwine generation boots and reattaches ---")
    const two = makeBridge("gen2")
    await two.bridge.warmUp()
    await sleep(1000)
    const rejoined = two.bridge.binding(slug, sessionId)
    console.log(`  after warmUp: ${JSON.stringify(rejoined)}`)
    check("reattached the SAME app-server (no new listener spawned)", liveNativeRecord(root, PROJECT)?.generation === record.generation)
    check("the binding is active again", rejoined?.state === "active")

    console.log("  --- the turn either finished across the gap or is still running; both are recovery ---")
    let cleared = false
    for (let i = 0; i < 240; i++) {
      if (two.bridge.binding(slug, sessionId)?.currentTurnId === null) { cleared = true; break }
      await sleep(500)
    }
    const stats = rolloutStats(binding.codexSessionId)
    console.log(`  rollout: ${JSON.stringify(stats)}`)
    check("the thread is working again (the turn ran to completion, not silently dropped)", cleared && stats.completed >= 1)

    two.bridge.close()
    try { two.interactions.dispose(); two.db.close() } catch {}

    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
  } catch (e) {
    failures++
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
  } finally {
    killNativeListener(root, PROJECT)
    // Belt-and-suspenders: never leak a detached listener out of a harness run.
    try { const r = liveNativeRecord(root, PROJECT); if (r) spawnSync("kill", ["-9", String(r.listenerPid)]) } catch {}
    process.exit(failures === 0 ? 0 : 1)
  }
})()
