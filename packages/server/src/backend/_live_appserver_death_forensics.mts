// LIVE proof (not a unit test; excluded from the *.test.ts glob) for the daemon-death OBSERVABILITY
// work: when the codex app-server child dies mid-turn, its death must become ATTRIBUTABLE instead of
// an opaque disconnect. This reproduces the 2026-07-24 class of loss — the app-server process ending
// under a live turn — and asserts the three new signals that make it diagnosable:
//   1. the dying daemon leaves an exit BREADCRUMB naming the cause (a killed/exited app-server child);
//   2. the next bridge emits a `daemon-replaced` diagnostic carrying that cause;
//   3. the persistent diagnostic LOG file captures the death.
// Run:
//   nub packages/server/src/backend/_live_appserver_death_forensics.mts
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerDiagnostic } from "./codex-app-server.ts"
import { killCodexAppServerDaemon, liveDaemonRecord, readDaemonExitBreadcrumb } from "./codex-app-server-host.ts"
import { createCodexDiagnosticSink, codexDiagnosticLogPath } from "./codex-app-server-diagnostics.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "ntwine-death-forensics-"))
const dbPath = join(root, "ui.db")
const PROJECT = "forensics"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const LONG = "Count slowly from 1 to 40, one number per line, with a sentence of commentary after each. Do not stop early."

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// Every bridge in the run shares ONE persistent diagnostic sink writing to the project log — exactly
// how context.ts wires it — plus a console echo, so we prove the real file path is populated.
const diagSink = createCodexDiagnosticSink(root, PROJECT)
const collected: CodexAppServerDiagnostic[] = []
function makeBridge(label: string) {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${label}-${++iid}` })
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    diagnostic: (e) => {
      collected.push(e)
      diagSink(e)
      const ev = (e as { event?: string }).event
      if (ev !== "stderr") console.log(`    [diag:${label}]`, JSON.stringify(e))
    },
  })
  return { bridge, interactions, db }
}

;(async () => {
  try {
    console.log("======== app-server child crash mid-turn must be ATTRIBUTABLE ========")
    const slug = "forensic-thread", sessionId = "forensic-session"
    const one = makeBridge("gen1")
    await one.bridge.startDisposableSession({
      threadSlug: slug, sessionId, cwd: root, sandbox: "read-only", ephemeral: false,
    })
    const { turnId } = await one.bridge.startTurn({ threadSlug: slug, sessionId, text: LONG })
    console.log(`  turn started: ${turnId}`)
    await sleep(5000)

    const record = liveDaemonRecord(root, PROJECT)!
    const priorGeneration = record.generation
    console.log(`  daemon pid=${record.daemonPid} app-server child pid=${record.childPid} generation=${priorGeneration}`)

    // Kill the codex app-server CHILD directly (SIGKILL) — a codex crash, NOT an ntwine restart. The
    // daemon observes child.on("exit") and self-terminates, leaving the breadcrumb behind.
    console.log("  --- SIGKILL the app-server child (simulated codex crash) ---")
    process.kill(record.childPid, "SIGKILL")
    await sleep(1500)
    check("the app-server child is gone", !alive(record.childPid))
    check("the daemon collected itself after its child died", !alive(record.daemonPid))

    const crumb = readDaemonExitBreadcrumb(root, PROJECT)
    console.log(`  breadcrumb: ${JSON.stringify(crumb)}`)
    check("a breadcrumb was written", Boolean(crumb))
    check("the breadcrumb names the dead generation", crumb?.generation === priorGeneration, crumb?.generation)
    check("the breadcrumb attributes the death to the app-server child ending",
      Boolean(crumb && /^app-server-(killed|exited)/.test(crumb.reason)), crumb?.reason)

    one.bridge.close()
    await one.bridge.shutdown().catch(() => {})
    try { one.interactions.dispose(); one.db.close() } catch {}

    console.log("  --- new runtime boots, warms up, forks a fresh daemon ---")
    const two = makeBridge("gen2")
    await two.bridge.warmUp()
    await sleep(2000)

    const replaced = collected.find((e) => e.event === "daemon-replaced") as
      | Extract<CodexAppServerDiagnostic, { event: "daemon-replaced" }> | undefined
    console.log(`  daemon-replaced diagnostic: ${JSON.stringify(replaced)}`)
    check("a daemon-replaced diagnostic was emitted", Boolean(replaced))
    check("it names the previous generation", replaced?.previousGeneration === priorGeneration, replaced?.previousGeneration)
    check("it carries the attributed death cause (not 'unknown')",
      Boolean(replaced && /^app-server-(killed|exited)/.test(replaced.deathReason)), replaced?.deathReason)
    check("a NEW app-server was started", liveDaemonRecord(root, PROJECT)?.childPid !== record.childPid)

    // The persistent log file — the thing that was missing when this actually happened.
    const logPath = codexDiagnosticLogPath(root, PROJECT)
    const logged = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
    check("the persistent diagnostic log file exists", existsSync(logPath), logPath)
    check("the log file captured the daemon-replaced death", logged.includes("daemon-replaced") && logged.includes(priorGeneration))

    two.bridge.close()
    await two.bridge.shutdown().catch(() => {})
    try { two.interactions.dispose(); two.db.close() } catch {}

    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
  } catch (e) {
    failures++
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
  } finally {
    killCodexAppServerDaemon(root, PROJECT)
    process.exit(failures === 0 ? 0 : 1)
  }
})()
