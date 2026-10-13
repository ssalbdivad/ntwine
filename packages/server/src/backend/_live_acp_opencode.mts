// Manual live probe, not CI: drive a REAL ACP agent through acp-rpc.ts exactly as the bridge will —
// initialize, session/new with a stdio MCP server, a prompt that must call that server's tool, then a
// cancelled turn. Run from the repo root:
//
//   nub packages/server/src/backend/_live_acp_opencode.mts [command] [args...]     default: opencode acp
//
// Prints every update kind and the two stop reasons. Exit 0 only when the MCP tool was called through
// the agent and the cancel returned `cancelled` (or the -32603 "aborted" shape some agents use).

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpConnection, AcpRemoteError, spawnAcpChild } from "./acp-rpc.ts"
import { ACP_PROTOCOL_VERSION, AcpInitializeResult, AcpNewSessionResult, AcpPromptResult, AcpRequestPermissionParams, AcpSessionNotification, parseSessionUpdate } from "./acp-types.ts"

const [command = "opencode", ...args] = process.argv.slice(2)
const argv = process.argv.length > 2 ? args : ["acp"]
const cwd = mkdtempSync(join(tmpdir(), "acp-live-"))

// A throwaway stdio MCP server with one tool, written beside the cwd so the probe is self-contained.
const mcpScript = join(cwd, "mini-mcp.mjs")
writeFileSync(mcpScript, `
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } });
  else if (m.method === "tools/list") reply({ tools: [{ name: "probe_echo", description: "Echo text back prefixed with PROBE-OK:", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "PROBE-OK:" + (m.params?.arguments?.text ?? "") }] });
  else if (m.id !== undefined) reply({});
} });
`)

const kinds: string[] = []
let mcpToolCalled = false
const proc = spawnAcpChild({ command, args: argv, cwd, env: process.env })
const conn = new AcpConnection(proc, {
  onRequest: async (method, params) => {
    if (method === "session/request_permission") {
      const p = AcpRequestPermissionParams.parse(params)
      const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options[0]
      console.log(`agent asked permission for ${p.toolCall.title ?? p.toolCall.toolCallId}; answering ${allow?.optionId}`)
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } }
    }
    throw new Error(`unsupported client method ${method}`)
  },
  onNotification: (method, params) => {
    if (method !== "session/update") return
    const n = AcpSessionNotification.parse(params)
    const u = parseSessionUpdate(n.update)
    kinds.push(u.sessionUpdate)
    if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && /probe_echo/.test(String(u.title ?? ""))) mcpToolCalled = true
    if (u.sessionUpdate === "agent_message_chunk") process.stdout.write((u.content as { text?: string }).text ?? "")
  },
  onDiagnostic: (d) => { if (d.kind !== "stderr") console.log(`[diagnostic ${d.kind}] ${d.message}`) },
})

const init = AcpInitializeResult.parse(await conn.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "ntwine", version: "0" } }, { timeoutMs: 30_000 }))
console.log(`agent: ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""} loadSession=${init.agentCapabilities?.loadSession}`)
const sess = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers: [{ name: "probe", command: process.execPath, args: [mcpScript], env: [] }] }))
console.log(`session ${sess.sessionId}; model=${String(sess.configOptions?.find((o) => o.category === "model")?.currentValue ?? "?")}`)

const t0 = Date.now()
const r1 = AcpPromptResult.parse(await conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "Call the MCP tool probe_echo with text 'hello' and reply with exactly what it returned." }] }))
console.log(`\nturn 1: ${r1.stopReason} in ${Date.now() - t0}ms; mcp tool called=${mcpToolCalled}`)

const turn = conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "Count slowly from 1 to 300, one number per line." }] })
setTimeout(() => conn.notify("session/cancel", { sessionId: sess.sessionId }), 2_500)
let cancelled = false
try { cancelled = AcpPromptResult.parse(await turn).stopReason === "cancelled" }
catch (err) { cancelled = err instanceof AcpRemoteError && err.error.code === -32603 && /abort/i.test(JSON.stringify(err.error.data ?? "")); console.log(`cancel came back as an error: ${(err as Error).message}`) }
console.log(`\nturn 2 cancelled=${cancelled}`)
console.log(`update kinds seen: ${[...new Set(kinds)].join(", ")}`)
await conn.close()
process.exit(mcpToolCalled && cancelled ? 0 : 1)
