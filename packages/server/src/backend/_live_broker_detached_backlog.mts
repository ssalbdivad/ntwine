// LIVE proof of the property a concurrent session's plan note (fe4bdf3) claimed ntwine does NOT have:
//   nub packages/server/src/backend/_live_broker_detached_backlog.mts
//
// That note says "the daemon does not buffer: claude-agent-broker.ts:81 drops every event when no
// client is attached, and there is no backlog or replay cursor," and concludes item 1 must not be
// attempted without a resume-from-sequence handshake first. The line it cites is the DIAGNOSTIC
// relay, which really did drop when detached (fixed by claude-broker-diagnostics.ts — the daemon now
// writes its own). The EVENT path a few lines above has always had a 20,000-frame backlog
// (claude-agent-broker.ts emitEvent) that is replayed in full on the next connect.
//
// Source-reading is not proof of behavior, so this drives it: attach, start a turn, DISCONNECT while
// it is still running, let the turn finish with nothing attached, then reconnect and check that the
// events emitted during the detached window arrive.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker, resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = resolveClaudeExecutableAbsolute(execFileSync("which", ["claude"], { encoding: "utf8" }).trim(), process.env as Record<string, string>)
const stateDir = mkdtempSync(join(tmpdir(), "backlog-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "backlog-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sessionId = randomUUID()
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]))
try {
  const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, permissionMode: "default", env })

  // ---- client A: start a turn, then LEAVE ---------------------------------------------------------
  const beforeDisconnect: ClaudeQueryEvent["kind"][] = []
  const a = connectClaudeBroker(record.socketPath, { onEvent: (e) => beforeDisconnect.push(e.kind) })
  await sleep(1_500)
  a.sendInput({ id: randomUUID(), text: "Count slowly from 1 to 5, one number per line, then reply DETACHED-OK and stop. Do not use any tools." })
  await sleep(500) // just long enough for the turn to be underway
  a.close()
  const seenWhileAttached = [...beforeDisconnect]

  // ---- nothing is attached; the turn runs to completion in here -----------------------------------
  await sleep(25_000)

  // ---- client B: a "restarted ntwine" reconnecting to the live session ------------------------------
  const afterReconnect: ClaudeQueryEvent[] = []
  const b = connectClaudeBroker(record.socketPath, { onEvent: (e) => afterReconnect.push(e) })
  await sleep(3_000)

  ok("the daemon was still alive with nobody attached", afterReconnect.length > 0 || seenWhileAttached.length > 0)
  ok(
    "events emitted while DETACHED were replayed on reconnect",
    afterReconnect.length > 0,
    `${afterReconnect.length} replayed: ${[...new Set(afterReconnect.map((e) => e.kind))].join(",")}`,
  )
  const result = afterReconnect.find((e) => e.kind === "result")
  ok("the turn's `result` — completed with nothing attached — survived", Boolean(result), result ? `subtype=${(result as { subtype: string }).subtype}` : "no result event replayed")
  const text = afterReconnect.filter((e) => e.kind === "assistant").flatMap((e) => (e as { text: string[] }).text).join(" ")
  ok("the agent's own reply came back through the backlog", text.includes("DETACHED-OK"), JSON.stringify(text.slice(0, 200)))
  console.log(`      (client A saw [${[...new Set(seenWhileAttached)].join(",") || "nothing"}] before it left)`)
  b.close()
} catch (e) {
  failures++
  console.log("FAIL  harness threw —", e)
} finally {
  try { killBroker(stateDir, sessionId) } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
