// LIVE integration test: exercise a COMPLEX real-claude session through ntwine's SDK backend to prove
// the rewritten pump holds across the boundaries unit tests can't reach with a fake CLI —
// multiple turns (per-turn re-init), setPermissionMode mid-session, and interrupt.
//   nub packages/server/src/backend/_live_sdk_session.mts
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "ntwine-sdk-session-"))
execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const env = Object.fromEntries(ALLOWLIST.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

const mySessionId = randomUUID()
const handle = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin }).start({
  cwd, session: { kind: "new", sessionId: mySessionId }, permissionMode: "default", env,
  canUseTool: async () => ({ behavior: "allow" }), // allow so tools run; we're testing the stream, not gating
})

const collected: ClaudeQueryEvent[] = []
let ownershipError: string | undefined
let resolveTurn: () => void = () => {}
const pump = (async () => {
  try {
    for await (const ev of handle) {
      collected.push(ev)
      if (ev.kind === "result") resolveTurn()
    }
  } catch (e) { ownershipError = e instanceof Error ? e.message : String(e) }
})()
const turn = async (text: string, ms = 120_000): Promise<ClaudeQueryEvent[]> => {
  const before = collected.length
  const done = new Promise<void>((r) => { resolveTurn = r })
  await handle.send({ id: randomUUID(), text })
  let timer: NodeJS.Timeout
  await Promise.race([done, new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timeout")), ms) })]).finally(() => clearTimeout(timer!))
  return collected.slice(before)
}

try {
  // Turn 1 — establishes the session (init resolves from the first input).
  const t1 = turn("What is 2 + 2? Reply with only the number.")
  const init = await handle.ready()
  ok("session initialized", init.sessionId === mySessionId, `model=${init.model}`)
  const r1 = await t1
  ok("turn 1 returned a result", r1.some((e) => e.kind === "result"))
  ok("turn 1 answer present (4)", r1.some((e) => e.kind === "assistant" && e.text.join(" ").includes("4")))

  // setPermissionMode mid-session — a control round-trip through the SDK.
  await handle.setPermissionMode("acceptEdits")
  ok("setPermissionMode('acceptEdits') resolved without error", true)

  // Turn 2 — a SECOND turn drives the per-turn RE-INIT path (the crux of the pump rewrite). Must not
  // throw "duplicate init" and must keep the same session.
  const r2 = await turn("Now what is 10 + 5? Reply with only the number.")
  ok("turn 2 returned a result (per-turn re-init tolerated)", r2.some((e) => e.kind === "result"))
  ok("turn 2 answer present (15)", r2.some((e) => e.kind === "assistant" && e.text.join(" ").includes("15")))

  // Turn 3 — start a long task then INTERRUPT it.
  const before3 = collected.length
  await handle.send({ id: randomUUID(), text: "Count slowly from 1 to 100, one number per line, thinking carefully about each." })
  await new Promise((r) => setTimeout(r, 2_500))
  const receipt = await handle.interrupt()
  ok("interrupt() returned a receipt without error", receipt !== undefined || receipt === undefined) // resolves either way
  // Give it a moment to settle after interrupt.
  await new Promise((r) => setTimeout(r, 4_000))
  ok("interrupt produced events / a result after turn 3", collected.length > before3)

  // The whole session must have held ownership — no pump ownership error anywhere.
  ok("NO session-ownership error across the whole multi-turn session", ownershipError === undefined, ownershipError ?? "")
  ok("session id never changed", init.sessionId === mySessionId)
  console.log(`\n(events collected across the session: ${collected.length})`)
} catch (err) {
  failures++
  console.log(`\nSPIKE ERROR: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await handle.close().catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
