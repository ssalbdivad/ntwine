// LIVE harness (not a unit test; excluded from the *.test.ts glob). Proves the ACTUAL user-facing
// claim end-to-end against the REAL `codex app-server`: a ntwine-dispatched Codex thread never stalls on
// an approval, and it never silently loses its sandbox across a cold resume.
//
// It reproduces the exact live incident (2026-07-24, thread `we-need-to-revisit-the-sandboxing`): a
// worker whose write target lives OUTSIDE its cwd behind a symlink — `<project>/wiki` →
// `<elsewhere>/wiki`, which `workspace-write` denies. Under the old defaults that produced a
// `command failed; retry without sandbox?` approval per patch, forever.
//
// Run:
//   nub packages/server/src/backend/_live_appserver_approvals.mts
import { spawn as spawnChild } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-live-approvals-"))
const project = join(dir, "project")
const outside = join(dir, "outside")
mkdirSync(project, { recursive: true })
mkdirSync(join(outside, "wiki"), { recursive: true })
// The incident's shape exactly: a path inside the workspace that RESOLVES outside it.
symlinkSync(join(outside, "wiki"), join(project, "wiki"))

const db = new Database(join(dir, "ui.db"))
db.pragma("journal_mode = WAL")
let iid = 0, cid = 0
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })
const children: import("node:child_process").ChildProcess[] = []
const spawn: CodexAppServerSpawn = (binary, args, options) => {
  const child = spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)
  return child
}
const wire: unknown[] = []
const bridge = new CodexAppServerBridge({
  projectId: "live", projectDir: project, db, interactions,
  codexBin: CODEX_BIN, spawn, now: () => new Date(), id: () => `c-${++cid}`,
  requestTimeoutMs: 60_000,
  diagnostic: (e) => { wire.push(e); const ev = (e as { event?: string }).event; if (ev && ev !== "connected") console.log("[diag]", JSON.stringify(e)) },
})

const slug = "live-approvals", sessionId = "live-approvals-session"
const scope = { projectId: "live", threadSlug: slug, sessionId }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const target = join(project, "wiki", "audit.md")
let failures = 0
const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

async function waitTurnClear(ms = 180_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (bridge.binding(slug, sessionId)?.currentTurnId == null) return
    await sleep(250)
  }
  console.log("  TIMEOUT waiting for the turn to clear")
}

;(async () => {
  try {
    console.log("=== dispatch a worker exactly as ntwine's dispatch path does ===")
    const { binding } = await bridge.spawnDispatch({
      threadSlug: slug,
      sessionId,
      cwd: project,
      // dispatch.ts passes codexSandbox(WORKER_DISPATCH_PERMISSION.codex) — assert the resulting policy
      // rather than restating it, so a change to that mapping fails here too.
      sandbox: "danger-full-access",
      prompt: `Write the file ${target} containing exactly the line "sandbox ok". Use apply_patch. Then reply with the single word DONE and stop. Do not ask any questions.`,
      model: "gpt-5.6-sol",
      effort: "low",
    })
    console.log("bound:", binding.codexThreadId, "sandbox:", binding.sandbox)
    check(binding.sandbox === "danger-full-access", "thread/start applied danger-full-access", binding.sandbox)

    await waitTurnClear()
    const pending = interactions.listPending(scope)
    const journalled = db.prepare("SELECT kind, lifecycle FROM interaction_journal").all()
    check(journalled.length === 0, "NO approval was ever requested for an out-of-workspace write", journalled)
    check(pending.length === 0, "no interaction is left pending", pending.length)
    check(existsSync(target), "the write through the out-of-workspace symlink SUCCEEDED", existsSync(target))
    if (existsSync(target)) console.log("  file contents:", JSON.stringify(readFileSync(target, "utf8").trim()))

    console.log("\n=== kill the app-server, then COLD resume (the path that used to downgrade) ===")
    for (const child of children) { try { child.kill("SIGKILL") } catch {} }
    await sleep(1_500)
    const resumed = await bridge.resumeOwnedSession(slug, sessionId)
    console.log("resumed sandbox:", resumed.sandbox)
    // The regression this guards: with no override on the wire the app-server applies its config.toml
    // defaults (workspace-write + on-request), and the thread comes back sandboxed AND interactive.
    check(resumed.sandbox === "danger-full-access", "a COLD resume kept danger-full-access", resumed.sandbox)

    const second = join(project, "wiki", "audit-2.md")
    await bridge.startTurn({
      threadSlug: slug, sessionId,
      text: `Write the file ${second} containing exactly the line "still ok". Use apply_patch. Then reply DONE and stop.`,
    })
    await waitTurnClear()
    const afterResume = db.prepare("SELECT kind, lifecycle FROM interaction_journal").all()
    check(afterResume.length === 0, "still NO approval after the resume", afterResume)
    check(existsSync(second), "the post-resume out-of-workspace write SUCCEEDED", existsSync(second))

    console.log("\n=== the ACTUAL incident shape: a LEGACY row with no recorded intent ===")
    // `intended_sandbox` arrived as an additive ALTER, so every thread dispatched before it exists with
    // the column NULL — which is exactly what the incident row looked like. The old override returned
    // `{}` for those, handing the decision to config.toml (workspace-write + on-request).
    db.prepare("UPDATE codex_app_server_session SET intended_sandbox = NULL, sandbox = NULL WHERE project_id = 'live' AND ntwine_session_id = ?").run(sessionId)
    for (const child of children) { try { child.kill("SIGKILL") } catch {} }
    await sleep(1_500)
    const legacy = await bridge.resumeOwnedSession(slug, sessionId)
    console.log("legacy-row resumed sandbox:", legacy.sandbox)
    check(legacy.sandbox === "danger-full-access", "a legacy row with NO intent still resumes at full access", legacy.sandbox)

    const third = join(project, "wiki", "audit-3.md")
    await bridge.startTurn({
      threadSlug: slug, sessionId,
      text: `Write the file ${third} containing exactly the line "legacy ok". Use apply_patch. Then reply DONE and stop.`,
    })
    await waitTurnClear()
    const afterLegacy = db.prepare("SELECT kind, lifecycle FROM interaction_journal").all()
    check(afterLegacy.length === 0, "a legacy row never stalls on an approval either", afterLegacy)
    check(existsSync(third), "the legacy-row out-of-workspace write SUCCEEDED", existsSync(third))
  } catch (error) {
    failures++
    console.error("HARNESS ERROR", error)
  } finally {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
    try { await bridge.close() } catch {}
    for (const child of children) { try { child.kill("SIGKILL") } catch {} }
    process.exit(failures === 0 ? 0 : 1)
  }
})()
