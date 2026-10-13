// LIVE spike: prove the Claude Agent SDK backend's PERMISSION ROUND-TRIP against real `claude`.
//   nub packages/server/src/backend/_live_sdk_permission.mts
//
// Drives the ACTUAL production factory (createClaudeQueryFactory -> the code that replaced the
// spawned-CLI path), not a reimplementation. Proves the thing that is fragile today: a tool-permission
// request arrives as a TYPED CALLBACK we answer synchronously (allow / deny) — no TUI scraping, no
// keystroke injection — and subscription/OAuth auth is preserved (it spawns the real `claude` binary).
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type { ClaudePermissionRequest, ClaudePermissionDecision, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "ntwine-sdk-perm-"))
execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

// Record every permission request and decide by the file the model wants to write: a Write to
// deny.txt is denied, anything else allowed. (Bash `echo` auto-allows and never prompts, so use a
// gated tool — Write — to actually exercise canUseTool. This is the allow/deny a UI callback returns.)
const requests: Array<{ req: ClaudePermissionRequest; decision: ClaudePermissionDecision }> = []
const canUseTool = async (req: ClaudePermissionRequest): Promise<ClaudePermissionDecision> => {
  const cmd = JSON.stringify(req.input)
  const decision: ClaudePermissionDecision = /deny\.txt/.test(cmd)
    ? { behavior: "deny", message: "Denied by the spike harness (proving the deny round-trip)." }
    : { behavior: "allow" }
  requests.push({ req, decision })
  console.log(`  » canUseTool fired: tool=${req.toolName} input=${cmd.slice(0, 80)} -> ${decision.behavior}`)
  return decision
}

const factory = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin })

// The backend VALIDATES the env against a strict allowlist (throws on anything else), so pass only
// allowlisted keys. HOME + PATH are enough for subscription/OAuth auth (claude reads its keychain/
// credentials from HOME); this deliberately excludes the child-session markers of the calling worker.
const ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]
const env = Object.fromEntries(ALLOWLIST.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>
console.log(`  (env passed to SDK: ${Object.keys(env).join(", ")})`)

const handle = factory.start({
  cwd,
  session: { kind: "new", sessionId: randomUUID() },
  permissionMode: "default", // so Bash actually requires permission -> canUseTool fires
  env,
  canUseTool,
  onDiagnostic: (d) => {
    if (d.kind === "lifecycle") console.log(`  [lifecycle ${d.phase}]${d.message ? " " + d.message : ""}`)
    else if (d.kind === "stderr") console.log(`  [claude stderr] ${d.message.slice(0, 300)}`)
  },
})

// Consume the event stream concurrently; resolve a barrier each time a turn's result lands.
const collected: ClaudeQueryEvent[] = []
let resolveTurn: () => void = () => {}
const pump = (async () => {
  for await (const ev of handle) {
    collected.push(ev)
    if (ev.kind === "assistant" && ev.text.length) console.log(`  claude: ${ev.text.join(" ").replace(/\s+/g, " ").slice(0, 160)}`)
    if (ev.kind === "result") resolveTurn()
  }
})()
const turn = async (text: string, ms = 120_000): Promise<ClaudeQueryEvent[]> => {
  const before = collected.length
  const done = new Promise<void>((r) => { resolveTurn = r })
  await handle.send({ id: randomUUID(), text })
  let timer: NodeJS.Timeout
  const guard = new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms waiting for turn result`)), ms) })
  try { await Promise.race([done, guard]) } finally { clearTimeout(timer!) }
  return collected.slice(before)
}

const withTimeout = async <T,>(label: string, p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout
  const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms) })
  try { return await Promise.race([p, guard]) } finally { clearTimeout(timer!) }
}

try {
  // Real claude in streaming-input mode emits `init` only AFTER the first user message arrives, so
  // send the first turn FIRST and let ready() resolve from it. (Awaiting ready() before sending
  // deadlocks — the fake-CLI unit tests emit init eagerly, which hid this against real claude.)
  console.log("  sending first turn (init resolves once claude receives it)…")
  const allowPath = join(cwd, "allow.txt")
  const denyPath = join(cwd, "deny.txt")
  const allowTurn = turn(`Use the Write tool to create the file at the absolute path ${allowPath} containing the text ok. Then stop.`)
  const init = await withTimeout("handle.ready()", handle.ready(), 45_000)
  ok("SDK session initialized (spawned real claude, auth OK)", !!init.sessionId, `model=${init.model}, claude=${init.claudeCodeVersion}, mode=${init.permissionMode}`)
  ok("Write is an available tool", init.tools.includes("Write"))

  // ---- ALLOW round-trip -------------------------------------------------------------------------
  await allowTurn
  const allowReq = requests.find((r) => /allow\.txt/.test(JSON.stringify(r.req.input)))
  ok("permission request arrived as a typed callback (ALLOW case)", !!allowReq && allowReq.req.toolName === "Write", allowReq ? `tool=${allowReq.req.toolName}, decision=allow` : "no request seen")
  ok("allowed Write actually executed (file written to disk)", existsSync(allowPath))

  // ---- DENY round-trip --------------------------------------------------------------------------
  const denyEvents = await turn(`Now use the Write tool to create the file at the absolute path ${denyPath} containing no. If you are blocked, reply with the single word BLOCKED and stop.`)
  const denyReq = requests.find((r) => r.decision.behavior === "deny")
  ok("permission request arrived as a typed callback (DENY case)", !!denyReq && denyReq.req.toolName === "Write", denyReq ? `tool=${denyReq.req.toolName}, decision=deny` : "no request seen")
  const sawDenial = denyEvents.some((e) => e.kind === "assistant" && /block|deny|denied|can'?t|not allowed|permission/i.test(e.text.join(" ")))
  ok("the DENY reached the model (it acknowledged being blocked)", sawDenial)
  ok("denied Write did NOT execute (file absent)", !existsSync(denyPath))

  console.log(`\nTotal permission round-trips handled via typed callback: ${requests.length}`)
  ok("spike ran all checks to completion", true)
} catch (err) {
  failures++
  console.log(`\nSPIKE ERROR (not a clean completion): ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await handle.close().catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
