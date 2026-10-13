// ADVERSARIAL live proof (not a unit test) for the native-default flip. It targets the scenarios the
// earlier harnesses did NOT: the ones most likely to be a regression now that native is the default and
// EVERY reattach is forced through the "cold" reconcile (the native host reports droppedWhileDetached>=1,
// so sameProcess is always false). Run:
//   nub packages/server/src/backend/_live_appserver_native_adversarial.mts
//
// A. A LIVE turn must SURVIVE a ntwine restart UNTOUCHED — same turn id, NO recovery nudge, no second
//    turn. If native's forced-cold reconcile retired or re-nudged a running turn, every ntwine restart
//    (which happens constantly) would disrupt every live codex turn. This is the highest-risk case.
// B. Approvals must never STALL on native (Phase 1's guarantee, on the new default): an out-of-workspace
//    write under danger-full-access must succeed with ZERO approval cards.
// C. A follow-up turn after a restart must work — sustained interaction, not just first contact.
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerDiagnostic } from "./codex-app-server.ts"
import { nativeListenCodexAppServerHost, liveNativeRecord, killNativeListener } from "./codex-app-server-native.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "ntwine-native-adv-"))
const dbPath = join(root, "ui.db")
const PROJECT = "native-adv"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const LONG = "Count slowly from 1 to 60, one number per line, and after each number write two full sentences of commentary. Do not stop early or skip any."

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

const children: import("node:child_process").ChildProcess[] = []
function makeBridge(label: string, collect?: CodexAppServerDiagnostic[]) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    host: nativeListenCodexAppServerHost,
    diagnostic: (e) => { collect?.push(e); const ev = (e as { event?: string }).event; if (ev !== "stderr") console.log(`    [diag:${label}]`, JSON.stringify(e)) },
  })
  return { bridge, interactions, db }
}

;(async () => {
  try {
    // ================= A: a LIVE turn survives a ntwine restart UNTOUCHED =================
    console.log("======== A — a LIVE turn survives a ntwine restart with NO disruption ========")
    const slugA = "live-turn", sessionA = "live-turn-session"
    const one = makeBridge("gen1")
    const bindA = await one.bridge.startDisposableSession({ threadSlug: slugA, sessionId: sessionA, cwd: root, sandbox: "read-only", ephemeral: false })
    const codexSessionA = bindA.codexSessionId // the rollout filename uses the CODEX session id, not ntwine's
    const started = await one.bridge.startTurn({ threadSlug: slugA, sessionId: sessionA, text: LONG })
    const originalTurn = started.turnId
    console.log(`  long turn started: ${originalTurn}`)
    await sleep(4000) // let it be genuinely mid-turn
    const bindingBefore = one.bridge.binding(slugA, sessionA)
    check("the turn is running before the restart", bindingBefore?.currentTurnId === originalTurn, bindingBefore?.currentTurnId)

    console.log("  --- ntwine restarts WHILE the turn is running ---")
    one.bridge.close(); await one.bridge.shutdown().catch(() => {})
    try { one.interactions.dispose(); one.db.close() } catch {}
    await sleep(1000)

    const diagsA: CodexAppServerDiagnostic[] = []
    const two = makeBridge("gen2", diagsA)
    await two.bridge.warmUp()
    await sleep(1500)
    const bindingAfter = two.bridge.binding(slugA, sessionA)
    console.log(`  after warmUp: currentTurnId=${bindingAfter?.currentTurnId}`)
    check("the SAME turn is still current (not retired)", bindingAfter?.currentTurnId === originalTurn, bindingAfter?.currentTurnId)
    check("NO recovery nudge was issued (turn-auto-resumed absent)", !diagsA.some((e) => e.event === "turn-auto-resumed"), diagsA.map((e) => e.event))

    console.log("  --- letting the ORIGINAL turn finish on its own ---")
    for (let i = 0; i < 300 && two.bridge.binding(slugA, sessionA)?.currentTurnId !== null; i++) await sleep(500)
    const statsA = rolloutStats(codexSessionA)
    console.log(`  rollout: ${JSON.stringify(statsA)}`)
    check("exactly ONE turn ran (no spurious second turn from a nudge)", statsA.started === 1, statsA)
    check("that turn COMPLETED", statsA.completed >= 1, statsA)
    check("the turn was NOT aborted by the restart", statsA.aborted === 0, statsA)
    two.bridge.close(); await two.bridge.shutdown().catch(() => {})
    try { two.interactions.dispose(); two.db.close() } catch {}
    killNativeListener(root, PROJECT)
    await sleep(800)

    // ================= B: approvals never stall on native =================
    console.log("\n======== B — approvals never stall on the native transport ========")
    const proj = join(root, "b-project"); const outside = join(root, "b-outside")
    mkdirSync(proj, { recursive: true }); mkdirSync(join(outside, "wiki"), { recursive: true })
    symlinkSync(join(outside, "wiki"), join(proj, "wiki")) // in-workspace path that RESOLVES outside
    const slugB = "approvals", sessionB = "approvals-session"
    const three = makeBridge("gen3")
    const target = join(proj, "wiki", "audit.md")
    const bindingB = await three.bridge.spawnDispatch({
      threadSlug: slugB, sessionId: sessionB, cwd: proj, sandbox: "danger-full-access",
      prompt: `Write the file ${target} containing exactly the line "native ok". Use apply_patch. Then reply DONE and stop. Do not ask questions.`,
      model: "gpt-5.6-sol", effort: "low",
    })
    check("dispatched at danger-full-access on native", bindingB.binding.sandbox === "danger-full-access", bindingB.binding.sandbox)
    for (let i = 0; i < 300 && three.bridge.binding(slugB, sessionB)?.currentTurnId !== null; i++) await sleep(500)
    const scopeB = { projectId: PROJECT, threadSlug: slugB, sessionId: sessionB }
    const pendingB = three.interactions.listPending(scopeB)
    const journalledB = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) AS n FROM interaction_journal WHERE thread_slug = ?").get(slugB)
    check("ZERO approval cards were ever requested on native", (journalledB as { n: number }).n === 0, journalledB)
    check("nothing is left pending", pendingB.length === 0, pendingB.length)
    check("the out-of-workspace write SUCCEEDED", existsSync(target), existsSync(target))
    three.bridge.close(); await three.bridge.shutdown().catch(() => {})
    try { three.interactions.dispose(); three.db.close() } catch {}
    killNativeListener(root, PROJECT)
    await sleep(800)

    // ================= C: a follow-up after a restart works =================
    console.log("\n======== C — a follow-up turn after a restart works on native ========")
    const slugC = "followup", sessionC = "followup-session"
    const four = makeBridge("gen4")
    const dispatchC = await four.bridge.spawnDispatch({
      threadSlug: slugC, sessionId: sessionC, cwd: root, sandbox: "read-only",
      prompt: "Reply with the single word ONE and stop.", model: "gpt-5.6-sol", effort: "low",
    })
    const codexSessionC = dispatchC.binding.codexSessionId
    for (let i = 0; i < 200 && four.bridge.binding(slugC, sessionC)?.currentTurnId !== null; i++) await sleep(500)
    four.bridge.close(); await four.bridge.shutdown().catch(() => {})
    try { four.interactions.dispose(); four.db.close() } catch {}
    await sleep(1000)
    const five = makeBridge("gen5")
    await five.bridge.warmUp()
    await five.bridge.followUp({ threadSlug: slugC, sessionId: sessionC, text: "Now reply with the single word TWO and stop." })
    for (let i = 0; i < 200 && five.bridge.binding(slugC, sessionC)?.currentTurnId !== null; i++) await sleep(500)
    const statsC = rolloutStats(codexSessionC)
    console.log(`  rollout: ${JSON.stringify(statsC)}`)
    check("both the initial and the post-restart follow-up turn ran", statsC.started >= 2 && statsC.completed >= 2, statsC)
    five.bridge.close(); await five.bridge.shutdown().catch(() => {})
    try { five.interactions.dispose(); five.db.close() } catch {}

    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
  } catch (e) {
    failures++
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
  } finally {
    killNativeListener(root, PROJECT)
    for (const c of children) { try { c.kill("SIGKILL") } catch {} }
    process.exit(failures === 0 ? 0 : 1)
  }
})()
