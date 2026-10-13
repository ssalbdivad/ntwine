// LIVE harness (not a unit test; excluded from the *.test.ts glob). Drives the REAL
// CodexAppServerBridge against the REAL `codex app-server` to prove that an EAGER per-thread sandbox
// change actually lands on a running thread. Run:
//   nub packages/server/src/backend/_live_appserver_sandbox_update.mts
//
// What it asserts, in order:
//   1. a thread started `read-only` reports `read-only`
//   2. bridge.setSandbox(danger-full-access) is confirmed by a `thread/settings/updated` notification
//   3. NEGATIVE CONTROL — the WRONG param spelling (`sandbox:` instead of `sandboxPolicy:`) returns a
//      successful-looking `{}` and changes NOTHING, so the pass above cannot be a silent no-op
//   4. approvalPolicy is NOT reset as a side effect of a sandboxPolicy-only update
//   5. the no-op case (same value twice) reports success instead of hanging
//   6. BEHAVIOURAL proof: the same write attempt is refused under read-only and succeeds under
//      danger-full-access, on one live thread, with only setSandbox in between
//   7. a cold resume carries the operator's persisted sandbox (the "next resume" promise)
import { spawn as spawnChild } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import {
  CodexAppServerBridge,
  codexSandboxPolicy,
  type CodexAppServerSpawn,
  type CodexSandboxMode,
} from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-live-sandbox-"))
const db = new Database(join(dir, "ui.db"))
db.pragma("journal_mode = WAL")
let iid = 0, cid = 0
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })

const spawnedPids: number[] = []
const spawn: CodexAppServerSpawn = (binary, args, options) => {
  const child = spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  if (child.pid) spawnedPids.push(child.pid)
  return child
}

// The operator's intent, exactly as ntwine's registry would hold it. The bridge reads it through
// `sandboxFor` on every cold resume — this is the seam that makes "saved for the next resume" true.
let operatorSandbox: CodexSandboxMode = "read-only"

let disconnects = 0
const bridge = new CodexAppServerBridge({
  projectId: "live-sandbox", projectDir: dir, db, interactions,
  codexBin: CODEX_BIN, spawn, now: () => new Date(), id: () => `c-${++cid}`,
  requestTimeoutMs: 30_000,
  sandboxFor: () => operatorSandbox,
  diagnostic: (e) => {
    const event = (e as { event?: string }).event
    if (event === "disconnected") disconnects += 1
    if (event !== "connected") console.log("[diag]", JSON.stringify(e))
  },
})

const slug = "live-sandbox", sessionId = "live-sandbox-session"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const turnId = () => bridge.binding(slug, sessionId)?.currentTurnId ?? null
let failures = 0
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
async function waitTurnClear(label: string, ms = 90_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (turnId() === null) { console.log(`  (${label}: turn cleared after ${Date.now() - t0}ms)`); return } await sleep(150) }
  console.log(`  (${label}: TIMEOUT waiting for turn to clear — still ${turnId()})`)
}

// A raw request on the bridge's own connection, so the negative control travels the exact same wire.
const rawRequest = async (method: string, params: unknown): Promise<unknown> => {
  const connection = (bridge as unknown as { connection: { request(m: string, p: unknown): Promise<unknown> } }).connection
  return connection.request(method, params)
}
const observedSandbox = (): string | undefined => bridge.binding(slug, sessionId)?.sandbox

// This harness needs ephemeral:false (a disposable thread cannot be cold-resumed), so it leaves a real
// rollout under CODEX_HOME. Find and delete it on the way out — no test thread survives the run.
function findRollout(codexSessionId: string): string | undefined {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith(`-${codexSessionId}.jsonl`)) hit = p
    }
  }
  try { walk(root) } catch {}
  return hit
}

const probeFile = join(dir, "sandbox-probe.txt")
const WRITE_PROMPT = [
  "Run exactly this shell command and nothing else, then reply with the single word DONE:",
  `  printf 'written' > ${probeFile}`,
  "Do not ask for approval. If the command fails, reply with the single word BLOCKED.",
].join("\n")

;(async () => {
  try {
    console.log("=== 1. start a REAL thread at read-only ===")
    // `approvalPolicy: "never"` on purpose, for two reasons: it is NOT the config.toml default, so a
    // reset caused by our sandboxPolicy-only update would be plainly visible in check 4; and it makes a
    // sandbox denial fail back to the model instead of raising an approval card, which is what lets
    // checks 3/6 be a clean behavioural A/B on one thread.
    const binding = await bridge.startDisposableSession({
      threadSlug: slug, sessionId, cwd: dir, sandbox: "read-only", approvalPolicy: "never", ephemeral: false,
    })
    console.log("  thread:", binding.codexThreadId, " sandbox cache:", binding.sandbox)
    check("started thread caches sandbox=read-only", binding.sandbox === "read-only", String(binding.sandbox))

    console.log("\n=== 2. NEGATIVE CONTROL: the WRONG param spelling must change NOTHING ===")
    const wrong = await rawRequest("thread/settings/update", {
      threadId: binding.codexThreadId,
      sandbox: "danger-full-access", // thread/start's spelling — silently ignored here
    })
    console.log("  response to `sandbox:` (wrong spelling):", JSON.stringify(wrong))
    await sleep(1_200)
    check(
      "wrong spelling returns a successful-looking response",
      JSON.stringify(wrong) === "{}",
      JSON.stringify(wrong),
    )
    check(
      "wrong spelling did NOT change the observed sandbox",
      observedSandbox() === "read-only",
      `observed=${String(observedSandbox())}`,
    )

    console.log("\n=== 3. BEHAVIOURAL baseline: a write under read-only must be refused ===")
    await bridge.startTurn({ threadSlug: slug, sessionId, text: WRITE_PROMPT })
    await waitTurnClear("read-only write attempt")
    const wroteUnderReadOnly = existsSync(probeFile)
    check("probe file was NOT created under read-only", !wroteUnderReadOnly, `exists=${wroteUnderReadOnly}`)

    console.log("\n=== 4. EAGER: bridge.setSandbox(danger-full-access) ===")
    console.log("  request JSON-RPC params:", JSON.stringify({
      threadId: binding.codexThreadId, sandboxPolicy: codexSandboxPolicy("danger-full-access"),
    }))
    const applied = await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "danger-full-access" })
    console.log("  setSandbox ->", JSON.stringify(applied))
    check("setSandbox reports applied", applied.applied === true)
    check("confirmed by the thread/settings/updated notification", applied.confirmedBy === "notification", String(applied.confirmedBy))
    check("observed sandbox is now danger-full-access", observedSandbox() === "danger-full-access", `observed=${String(observedSandbox())}`)
    console.log("  approvalPolicy reported in the confirming notification:", JSON.stringify(applied.approvalPolicy))
    check(
      "approvalPolicy was NOT reset by a sandboxPolicy-only update (thread started `never`)",
      applied.approvalPolicy === "never",
      `reported=${JSON.stringify(applied.approvalPolicy)}`,
    )

    console.log("\n=== 5. NO-OP: setting the SAME value again reports success, does not hang ===")
    const t0 = Date.now()
    const again = await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "danger-full-access" })
    console.log(`  setSandbox (repeat) -> ${JSON.stringify(again)}  in ${Date.now() - t0}ms`)
    check("repeat reports applied", again.applied === true)
    check("repeat is reported as already-current, not a notification", again.confirmedBy === "already-current", String(again.confirmedBy))
    check("repeat returned promptly (no 8s confirm stall)", Date.now() - t0 < 4_000, `${Date.now() - t0}ms`)

    console.log("\n=== 6. BEHAVIOURAL proof: the SAME write now succeeds ===")
    await bridge.startTurn({ threadSlug: slug, sessionId, text: WRITE_PROMPT })
    await waitTurnClear("full-access write attempt")
    const wroteUnderFullAccess = existsSync(probeFile)
    check("probe file WAS created under danger-full-access", wroteUnderFullAccess, `exists=${wroteUnderFullAccess}`)
    check(
      "the sandbox change is REAL (refused before, allowed after, nothing else changed)",
      !wroteUnderReadOnly && wroteUnderFullAccess,
    )

    console.log("\n=== 7. MID-TURN: flip the sandbox WHILE a turn is in flight ===")
    // The operator's point: the terminal UI lets you retune permissions during a running turn, it just
    // queues. This is the protocol half of that claim — and it also settles the copy question, because
    // whether the RUNNING turn picks the change up decides whether "applied to the live session" is an
    // honest thing to say. midA is attempted under read-only, then we flip during the sleep, then midB
    // is attempted by the SAME turn under the new policy.
    operatorSandbox = "read-only"
    const back = await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "read-only" })
    check("dropped back to read-only", observedSandbox() === "read-only", `observed=${String(observedSandbox())} ${JSON.stringify(back)}`)
    const midA = join(dir, "mid-a.txt"), midB = join(dir, "mid-b.txt")
    const MID_PROMPT = [
      "Run these three shell commands in order. Do NOT stop if one of them fails — always continue to the next.",
      `  1. printf 'one' > ${midA}`,
      "  2. sleep 30",
      `  3. printf 'two' > ${midB}`,
      "Then reply with exactly one line, and nothing else:",
      "  RESULT step1=<ok|failed> step3=<ok|failed>",
      "Never ask for approval.",
    ].join("\n")
    await bridge.startTurn({ threadSlug: slug, sessionId, text: MID_PROMPT })
    await sleep(9_000)
    const inFlight = turnId()
    check("a turn really is in flight before the flip", inFlight !== null, `currentTurnId=${String(inFlight)}`)
    const midFlip = await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "danger-full-access" })
    console.log("  MID-TURN setSandbox ->", JSON.stringify(midFlip))
    check("mid-turn update is accepted and confirmed", midFlip.applied === true && midFlip.confirmedBy === "notification", JSON.stringify(midFlip))
    // Generous: this turn deliberately contains a 30s sleep, and the model's own latency rides on top.
    await waitTurnClear("mid-turn flip", 240_000)
    const midAExists = existsSync(midA), midBExists = existsSync(midB)
    console.log(`  step 1 (attempted under read-only) wrote=${midAExists}   step 3 (attempted after the flip) wrote=${midBExists}`)
    // An absent file alone would be weak evidence — the model could simply have given up after step 1.
    // Make it say so: the RESULT line proves step 3 was actually ATTEMPTED after the flip.
    const rollout = findRollout(binding.codexSessionId)
    const resultLine = rollout
      ? readFileSync(rollout, "utf8").split("\n")
          .flatMap((raw) => { try { return [JSON.parse(raw)] } catch { return [] } })
          .filter((r) => r?.type === "event_msg" && r?.payload?.type === "agent_message")
          .map((r) => String(r.payload.message ?? ""))
          .flatMap((m) => m.split("\n")).filter((l) => l.includes("RESULT step1=")).pop()
      : undefined
    console.log("  model's own report:", resultLine ?? "(not found)")
    check("the model actually ATTEMPTED step 3 after the flip", Boolean(resultLine?.includes("step3=")), resultLine ?? "no RESULT line")
    console.log(`  >>> SEMANTICS: the flip ${midBExists ? "AFFECTED the running turn" : "did NOT affect the running turn (next-turn only)"}`)
    check("the thread is not wedged by a mid-turn change", turnId() === null, `currentTurnId=${String(turnId())}`)
    const afterMid = await bridge.startTurn({ threadSlug: slug, sessionId, text: "Reply with the single word OK." })
    check("a new turn still starts after a mid-turn change", Boolean(afterMid.turnId), afterMid.turnId)
    await waitTurnClear("post-mid-turn")

    console.log("\n=== 8. COLD RESUME carries the operator's intent, even if the registry is reverted ===")
    operatorSandbox = "read-only"
    await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "read-only" })
    check("reset to read-only before the cold-resume probe", observedSandbox() === "read-only", `observed=${String(observedSandbox())}`)
    // Now flip the registry intent to full access WITHOUT telling the live thread, then SIGKILL the
    // app-server so the next connect gets a brand-new process that has never loaded this thread. Only
    // then is the resume genuinely COLD — closing the connection object is not enough, the daemon would
    // still hold the thread and silently ignore the override (finding 5).
    await bridge.setSandbox({ threadSlug: slug, sessionId, sandbox: "danger-full-access" })
    // THE HOSTILE CASE. ntwine's registry is NOT a reliable home for a codex row's sandbox intent: the
    // tailer overwrites `sessions.permission_mode` with the mode the ROLLOUT reports, and a change that
    // only takes effect next turn is still described by the old policy. Observed live on 2026-07-23 —
    // a confirmed mid-turn change to `plan` was reverted to `default` in the registry seconds later.
    // Simulate exactly that by pointing sandboxFor back at the OLD value, and require the cold resume
    // to carry the operator's change anyway.
    operatorSandbox = "read-only"
    const victim = spawnedPids[spawnedPids.length - 1]
    console.log("  SIGKILLing app-server pid", victim, "to force a cold resume")
    try { process.kill(victim, "SIGKILL") } catch {}
    for (let i = 0; i < 100 && disconnects === 0; i += 1) await sleep(100)
    check("app-server disconnect observed", disconnects > 0, `disconnects=${disconnects}`)
    const resumed = await bridge.resumeOwnedSession(slug, sessionId)
    console.log("  resumed binding sandbox (read back off the thread/resume response):", resumed.sandbox)
    check(
      "cold resume applied the operator's intent, not the reverted registry value",
      resumed.sandbox === "danger-full-access",
      `observed=${String(resumed.sandbox)} (registry was lying with read-only)`,
    )

    console.log(`\n==== LIVE SANDBOX HARNESS ${failures === 0 ? "OK" : `FAILED (${failures})`} ====`)
    await cleanup(binding.codexSessionId)
    process.exit(failures === 0 ? 0 : 1)
  } catch (e) {
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
    await cleanup(bridge.binding(slug, sessionId)?.codexSessionId)
    process.exit(2)
  }
})()

async function cleanup(codexSessionId?: string): Promise<void> {
  const rollouts = new Set<string>()
  for (const id of [codexSessionId, bridge.binding(slug, sessionId)?.codexSessionId]) {
    const path = id ? findRollout(id) : undefined
    if (path) rollouts.add(path)
  }
  try { await bridge.shutdown() } catch {}
  try { interactions.dispose() } catch {}
  try { db.close() } catch {}
  // Kill by EXACT pid — never a broad pkill, other agents are running their own app-servers here.
  for (const pid of spawnedPids) { try { process.kill(pid, "SIGKILL") } catch {} }
  for (const path of rollouts) { try { rmSync(path, { force: true }); console.log("[cleanup] removed rollout", path) } catch {} }
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
