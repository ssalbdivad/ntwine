#!/usr/bin/env node
// A fake ACP agent for the acp-rpc / acp-bridge tests: newline-delimited JSON-RPC on stdio, the shape
// `opencode acp` was measured to speak (plans/acp-backend.md). It is deliberately small and its
// misbehaviours are switched by FAKE_ACP_MODE so a test can pick exactly one failure to exercise:
//
//   (unset)         well-behaved
//   junk            a banner and an LSP `Content-Length:` header on stdout before the first reply
//   oversized       one 200 KiB non-JSON line on stdout before the first reply
//   slow-init       never answers `initialize`
//   ask-permission  every prompt runs one `execute` tool call gated on session/request_permission
//   cancel-error    session/cancel makes the in-flight prompt FAIL with -32603 "aborted" (Gemini does this)
//   no-load         advertises loadSession:false
//   shell           a prompt line `RUN: <command>` is run by `sh -c` in the agent's OWN environment, which
//                   is what a real agent's shell tool does; the result goes to FAKE_ACP_LOG
//
// FAKE_ACP_LOG, when set, receives one JSON line per inbound frame so a test can assert what the client
// actually sent (the mcpServers it passed, the prompt text, the cwd).

import { appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const mode = process.env.FAKE_ACP_MODE ?? ""
const logPath = process.env.FAKE_ACP_LOG
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n")
const notify = (sessionId, update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nextOutId = 1
const pendingOut = new Map()
const ask = (method, params) => {
  const id = nextOutId++
  out({ jsonrpc: "2.0", id, method, params })
  return new Promise((resolve) => pendingOut.set(id, resolve))
}

if (mode === "junk") {
  process.stdout.write("Welcome to fake-agent 0.0.1 — a banner nobody asked for\n")
  process.stdout.write("Content-Length: 12\n")
}
if (mode === "oversized") process.stdout.write("x".repeat(200 * 1024) + "\n")

const sessions = new Map() // sessionId -> { cancelled: boolean, promptId: id|undefined }
let sessionSeq = 0

function modelOptions(current) {
  return [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: [{ value: "fake/small", name: "Fake Small" }, { value: "fake/large", name: "Fake Large" }] }]
}

async function handle(msg) {
  if (logPath) appendFileSync(logPath, JSON.stringify(msg) + "\n")
  // A response to something we asked (a permission outcome).
  if (msg.id !== undefined && msg.method === undefined) {
    pendingOut.get(msg.id)?.(msg)
    pendingOut.delete(msg.id)
    return
  }
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result })
  const fail = (code, message, data) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message, ...(data ? { data } : {}) } })
  const p = msg.params ?? {}
  switch (msg.method) {
    case "initialize": {
      if (mode === "slow-init") return
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: mode !== "no-load", mcpCapabilities: { http: true, sse: true }, promptCapabilities: { embeddedContext: true, image: false }, sessionCapabilities: { list: {}, resume: {} } },
        authMethods: [{ id: "fake-login", name: "Log in with fake", description: "Run `fake login` in the terminal" }],
        agentInfo: { name: "FakeAgent", version: "0.0.1" },
      })
      return
    }
    case "session/new": {
      const sessionId = `fake_${process.pid}_${++sessionSeq}`
      sessions.set(sessionId, { cancelled: false })
      reply({ sessionId, configOptions: modelOptions("fake/small") })
      notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "n/a" }] })
      return
    }
    case "session/load": {
      if (mode === "no-load") return fail(-32601, "Method not found")
      const sessionId = p.sessionId
      sessions.set(sessionId, { cancelled: false })
      // The replay: history first, the response only after it.
      notify(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier prompt" } })
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } })
      await sleep(10)
      reply({})
      return
    }
    case "session/prompt": {
      const sessionId = p.sessionId
      const s = sessions.get(sessionId)
      if (!s) return fail(-32602, "unknown session")
      s.cancelled = false
      s.promptId = msg.id
      const text = (p.prompt ?? []).map((b) => b.text ?? "").join("")
      notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about " }, messageId: "m1" })
      notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "it" }, messageId: "m1" })
      if (mode === "shell") {
        const command = /^RUN: (.+)$/m.exec(text)?.[1]
        if (command) {
          const ran = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" })
          if (logPath) appendFileSync(logPath, JSON.stringify({ shell: { command, code: ran.status, stdout: ran.stdout, stderr: ran.stderr } }) + "\n")
        }
      }
      if (mode === "ask-permission") {
        notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } })
        const answer = await ask("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "call_1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } },
          options: [
            { optionId: "opt-allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
          ],
        })
        const outcome = answer.result?.outcome
        if (logPath) appendFileSync(logPath, JSON.stringify({ permissionOutcome: outcome }) + "\n")
        if (outcome?.outcome === "selected" && outcome.optionId.startsWith("opt-allow")) {
          notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "removed" } }], rawOutput: { output: "removed" } })
        } else {
          notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed", content: [{ type: "content", content: { type: "text", text: "permission denied" } }] })
        }
      } else {
        notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_w", title: "write", kind: "edit", status: "pending", locations: [], rawInput: {} })
        notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_w", status: "completed", title: "hello.txt", locations: [{ path: "/tmp/hello.txt" }], rawInput: { filePath: "/tmp/hello.txt", content: "hi" }, content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }] })
      }
      if (text.includes("SLOW")) {
        // Stream until cancelled — the shape a long turn has when the human presses stop.
        for (let i = 1; i <= 200; i++) {
          if (s.cancelled) break
          notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${i}\n` }, messageId: "m2" })
          await sleep(25)
        }
        if (s.cancelled) {
          if (mode === "cancel-error") return fail(-32603, "Internal error", { details: "The user aborted a request." })
          return reply({ stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
        }
      }
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "P" }, messageId: "m2" })
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ONG" }, messageId: "m2" })
      notify(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0, currency: "USD" } })
      reply({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
      return
    }
    case "session/set_config_option": {
      const known = ["fake/small", "fake/large"]
      if (p.configId !== "model") return fail(-32602, `unknown config option ${p.configId}`)
      if (!known.includes(p.value)) return fail(-32602, `unknown model ${p.value}`)
      const s = sessions.get(p.sessionId)
      if (s) s.model = p.value
      reply({ configOptions: modelOptions(p.value) })
      return
    }
    case "session/cancel": {
      const s = sessions.get(p.sessionId)
      if (s) s.cancelled = true
      return
    }
    case "authenticate": return reply({})
    default:
      if (msg.id !== undefined) fail(-32601, "Method not found")
  }
}

let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
