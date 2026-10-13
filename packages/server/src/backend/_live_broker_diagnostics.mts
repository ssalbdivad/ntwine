// LIVE proof that a REALLY-FORKED broker daemon writes its own death forensics to disk:
//   nub packages/server/src/backend/_live_broker_diagnostics.mts
//
// claude-broker-diagnostics.test.ts proves the writer. This proves the DAEMON is actually handed the
// path and uses it — the seam that was silently missing before (onDiagnostic was plumbed all the way
// through claude-broker-client.ts and the bridge never supplied a handler).
//
// The load-bearing assertion is the third one. `lifecycle:started` is emitted while the SDK query
// spins up, which is BEFORE the daemon's socket is listening and long before ntwine can attach — so the
// socket relay is structurally incapable of carrying it, and the `if (client) write(...)` the daemon
// used to do meant it went nowhere at all. Only a write from inside the daemon catches it.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "diag-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "diag-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const relayed: string[] = []
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onDiagnostic: (_slug, _sessionId, diagnostic) => relayed.push(diagnostic.kind),
})

const slug = "diag-live"
const sessionId = randomUUID()
try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: "Reply with exactly DIAG-OK then stop. Do not use any tools." })
  await new Promise((r) => setTimeout(r, 8_000))

  const records = readClaudeBrokerDiagnostics(stateDir, sessionId)
  const shape = records.map((r) => r.diagnostic.kind + (r.diagnostic.kind === "lifecycle" ? `:${r.diagnostic.phase}` : "")).join(", ")
  ok("the forked daemon wrote its own diagnostics to disk", records.length > 0, `${records.length} record(s): ${shape}`)
  ok("records carry the daemon pid + generation", records.every((r) => r.daemonPid > 0 && Boolean(r.generation)), JSON.stringify(records[0] ?? null))
  ok(
    "a diagnostic emitted BEFORE any client could attach is still captured",
    records.some((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "started"),
    `relay saw [${relayed.join(",") || "nothing"}] — which is the point: the socket cannot carry a pre-connect diagnostic`,
  )

  // Kill the daemon and confirm the record of it outlives it.
  bridge.releaseSession(slug, sessionId, "session-deleted")
  await new Promise((r) => setTimeout(r, 1_500))
  ok("the log survives the daemon it recorded", readClaudeBrokerDiagnostics(stateDir, sessionId).length >= records.length)
} catch (e) {
  failures++
  console.log("FAIL  harness threw —", e)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch {}
  try { bridge.close() } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
