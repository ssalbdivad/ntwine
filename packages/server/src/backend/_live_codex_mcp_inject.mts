// LIVE PROBE: how does ntwine mount an MCP server into a CODEX worker?
//   nub packages/server/src/backend/_live_codex_mcp_inject.mts
//
// Why this exists. `NTWINE_MCP` is mounted only by `claudeMcpConfig` (dispatch.ts), so the codex dispatch
// config carries no `mcp_servers` at all — while workerPrompt.ts claims ntwine "injects the ONE unified
// `ntwine` MCP server into BOTH claude and codex workers" and WORKER_PROMPT.codex.golden.txt documents
// `mcp__ntwine__spawn_thread` to codex workers. Codex workers were told about a tool they did not have.
//
// MEASURED 2026-07-31 against codex-cli 0.146.0, three findings:
//
//   1. A `mcp_servers` entry in the `thread/start` CONFIG BAG does NOT mount anything. Driven through
//      the real CodexAppServerBridge, the model answered the literal word `NOTOOL` — its own report
//      that no such tool was in its registry. This is the same shape as the hooks trap recorded in
//      dispatch.ts: the config bag carries `bypass_hook_trust`/`hooks` fine, but MCP servers are
//      process-level, not per-conversation, so a per-thread override has nothing to attach to.
//
//   2. A `-c mcp_servers.<name>={...}` override on the app-server's OWN ARGV DOES mount a callable
//      tool. That is the channel this probe exercises, and the fix it justifies.
//
//   3. Under a restrictive approval policy with no approval channel the mounted call is CANCELLED,
//      not missing: the log reads `mcp: <server>/<tool> started` then `(failed)` +
//      `user cancelled MCP tool call`. Do not read that as a mounting failure — it is the approval
//      path, which ntwine already owns separately (see "a worker NEVER stalls on an approval").
//
// The load-bearing evidence is the MARKER FILE, not the model's prose: the probe MCP server writes a
// nonce to disk when its tool actually executes, so a model that merely CLAIMS to have called the tool
// cannot produce a pass.
//
// This probe drives `codex exec`, not the app-server bridge, deliberately: both resolve `-c` through
// the same config loader, and the bridge arm needs a live app-server per arm, which made the probe
// take >5min and hang on unrelated environment contention. A hanging probe is a bad regression
// artifact. The app-server path is covered end-to-end by a real ntwine dispatch instead.
//
// INSTRUMENT NOTE, because getting here cost two wrong turns.
//
//   - `codex exec` BLOCKS on an open stdin ("Reading additional input from stdin...") and never runs
//     the prompt. That surfaces as a bare timeout which reads exactly like the tool being absent.
//     Hence `stdio: ["ignore", ...]` in runCodex below — do not "simplify" it back to execFile.
//   - An earlier revision blamed its null reads on looking the rollout up by `codexSessionId` rather
//     than `codexThreadId`. That was WRONG; _live_codex_rollout_id.mts settles it — on a fresh
//     dispatch the two ids are IDENTICAL and either finds the file. The actual cause was that those
//     bridge-driven turns HUNG (150s, never cleared, so no agent_message was ever written). The retry
//     changed the id lookup AND the turn-wait together, so the pass credited the wrong fix. One
//     variable at a time: a confirming result from a confounded control is worse than no result.
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const CODEX_BIN = process.env.CODEX_BIN || "codex"

/**
 * Run codex to completion and return everything it printed.
 *
 * stdin is IGNORED, not inherited or piped: with an open stdin `codex exec` waits on
 * "Reading additional input from stdin..." and never runs the prompt, which surfaces as a bare
 * timeout that reads exactly like the tool being absent.
 */
function runCodex(args: string[], cwd: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (c: string) => { out += c })
    child.stderr.on("data", (c: string) => { out += c })
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* already gone */ } }, timeoutMs)
    timer.unref?.()
    child.on("close", () => { clearTimeout(timer); resolve(out) })
    child.on("error", (err) => { clearTimeout(timer); resolve(`${out}\nspawn error: ${err.message}`) })
  })
}
const nonce = `probe-${randomUUID().slice(0, 12)}`
const dir = mkdtempSync(join(tmpdir(), "ntwine-codex-mcp-"))
const markerPath = join(dir, "marker.txt")
const serverPath = join(dir, "probe-mcp.mjs")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

// A dependency-free stdio MCP server exposing ONE tool, written at runtime so the probe stays a single
// self-contained file. Mirrors cc-worker/bin/ntwine-mcp.mjs's hand-rolled NDJSON JSON-RPC surface.
writeFileSync(serverPath, `
import { writeFileSync } from "node:fs"
const TOOL = {
  name: "probe_ping",
  description: "Return the probe nonce. Call this tool with no arguments when asked for the nonce.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })
function handle(msg) {
  const { id, method, params } = msg ?? {}
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ntwineprobe", version: "0.0.1" },
      })
    case "notifications/initialized":
    case "initialized":
      return
    case "ping":
      return id == null ? undefined : reply(id, {})
    case "tools/list":
      return reply(id, { tools: [TOOL] })
    case "tools/call":
      if (params?.name !== "probe_ping") {
        return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } })
      }
      // The out-of-band proof: only a REAL invocation can write this.
      writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(nonce)} + "\\n")
      return reply(id, { content: [{ type: "text", text: ${JSON.stringify(nonce)} }] })
    default:
      return id == null ? undefined : send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
  }
}
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch { /* ignore unparseable */ }
  }
})
process.stdin.on("end", () => process.exit(0))
`)

// The exact override shape the fix installs on the app-server's argv.
const override = `mcp_servers.ntwineprobe={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(serverPath)}]}`

;(async () => {
  console.log(`probe dir: ${dir}`)
  console.log(`nonce:     ${nonce}`)
  console.log(`override:  ${override}\n`)

  // `--dangerously-bypass-approvals-and-sandbox` is scoped to this throwaway temp dir running a
  // trivial echo server, and is REQUIRED: finding 3 above — without an approval channel the mounted
  // call is cancelled, which would read as a mounting failure and hide the actual result.
  const stdout = await runCodex([
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c", override,
    "Call the probe_ping tool (no arguments) and reply with exactly what it returns. " +
    "If no such tool exists, reply NOTOOL.",
  ], dir)

  const started = /mcp:\s*ntwineprobe\/probe_ping\s+started/.test(stdout)
  const cancelled = /user cancelled MCP tool call/.test(stdout)
  const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : null
  console.log(`mounted(started)=${started}  cancelled=${cancelled}  marker=${marker ?? "(absent)"}\n`)

  ok("a -c mcp_servers override mounts the tool into the model's registry", started,
    started ? "" : "the model never saw `probe_ping` — grep the log for NOTOOL")
  ok("the mounted tool actually EXECUTES (out-of-band marker file)", marker === nonce,
    marker === nonce ? "" : cancelled ? "call was cancelled by the approval gate, not missing" : `marker=${marker ?? "absent"}`)

  console.log(`\n==== ${failures === 0 ? "CODEX MCP INJECTION VERIFIED" : "PROBE FAILED — read the tape above"} ====`)
  process.exit(failures === 0 ? 0 : 1)
})()
