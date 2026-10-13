import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AcpConnection, AcpConnectionClosed, AcpRemoteError, AcpRequestTimeout, spawnAcpChild,
  type AcpDiagnostic,
} from "./acp-rpc.ts"
import { ACP_PROTOCOL_VERSION, AcpInitializeResult, AcpNewSessionResult, AcpPromptResult, AcpRequestPermissionParams, AcpSessionNotification, parseSessionUpdate } from "./acp-types.ts"

// The transport against a REAL child over REAL stdio — the fake agent is a separate node process, so
// framing, backpressure, exit and spawn failure are the genuine article, not a mocked stream.

const FAKE = fileURLToPath(new URL("./acp.fixtures/fake-acp-agent.mjs", import.meta.url))

interface Harness {
  conn: AcpConnection
  updates: Array<{ sessionId: string; update: ReturnType<typeof parseSessionUpdate> }>
  diagnostics: AcpDiagnostic[]
  requests: Array<{ method: string; params: unknown }>
  logPath: string
}

function connect(mode = "", opts: { onRequest?: (method: string, params: unknown) => Promise<unknown>; maxLineBytes?: number; requestTimeoutMs?: number; command?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "acp-rpc-test-"))
  const logPath = join(dir, "frames.jsonl")
  const h: Harness = { updates: [], diagnostics: [], requests: [], logPath, conn: undefined as unknown as AcpConnection }
  const proc = spawnAcpChild({
    command: opts.command ?? process.execPath,
    args: opts.command ? [] : [FAKE],
    cwd: dir,
    env: { ...process.env, FAKE_ACP_MODE: mode, FAKE_ACP_LOG: logPath },
  })
  h.conn = new AcpConnection(proc, {
    onRequest: async (method, params) => {
      h.requests.push({ method, params })
      if (opts.onRequest) return opts.onRequest(method, params)
      throw new Error(`unexpected agent request ${method}`)
    },
    onNotification: (method, params) => {
      if (method !== "session/update") return
      const n = AcpSessionNotification.parse(params)
      h.updates.push({ sessionId: n.sessionId, update: parseSessionUpdate(n.update) })
    },
    onDiagnostic: (d) => h.diagnostics.push(d),
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
    ...(opts.maxLineBytes ? { maxLineBytes: opts.maxLineBytes } : {}),
  })
  return h
}

async function handshake(h: Harness, cwd = "/tmp") {
  const init = AcpInitializeResult.parse(await h.conn.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "ntwine-test", version: "0" } }))
  const sess = AcpNewSessionResult.parse(await h.conn.request("session/new", { cwd, mcpServers: [{ name: "ntwine", command: "/usr/bin/true", args: [], env: [{ name: "NTWINE_THREAD_SLUG", value: "t" }] }] }))
  return { init, sess }
}

const kinds = (h: Harness) => h.updates.map((u) => u.update.sessionUpdate)

test("acp-rpc: a well-behaved agent — initialize, session/new with an MCP server, a prompt turn, updates in order", async () => {
  const h = connect()
  try {
    const { init, sess } = await handshake(h, "/tmp/project")
    assert.equal(init.protocolVersion, 1)
    assert.equal(init.agentCapabilities?.loadSession, true)
    assert.equal(init.agentInfo?.name, "FakeAgent")
    assert.match(sess.sessionId, /^fake_/)
    assert.equal(sess.configOptions?.[0]?.id, "model")

    const result = AcpPromptResult.parse(await h.conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "ping" }] }))
    assert.equal(result.stopReason, "end_turn")
    // Every update that arrived before the response is already in the list: the fake writes them to
    // stdout ahead of the reply and the reader is one ordered stream.
    assert.deepEqual(kinds(h), [
      "unknown", // available_commands_update — not one Ntwine renders, classified rather than thrown
      "agent_thought_chunk", "agent_thought_chunk",
      "tool_call", "tool_call_update",
      "agent_message_chunk", "agent_message_chunk",
      "usage_update",
    ])
    const text = h.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text?: string } }).content.text).join("")
    assert.equal(text, "PONG")
    assert.deepEqual(h.diagnostics, [], "a clean agent produces no diagnostics — this is the control for the junk test")

    // What the client actually put on the wire, read back from the agent's own log.
    const frames = readFileSync(h.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const newSession = frames.find((f) => f.method === "session/new")
    assert.equal(newSession.params.cwd, "/tmp/project")
    assert.deepEqual(newSession.params.mcpServers[0].env, [{ name: "NTWINE_THREAD_SLUG", value: "t" }])
  } finally { await h.conn.close() }
})

test("acp-rpc: stdout pollution (a banner and an LSP Content-Length header) is skipped with a diagnostic, and the handshake still completes", async () => {
  const h = connect("junk")
  try {
    const { init } = await handshake(h)
    assert.equal(init.protocolVersion, 1)
    const junk = h.diagnostics.filter((d) => d.kind === "junk-line").map((d) => d.message)
    assert.equal(junk.length, 2, JSON.stringify(h.diagnostics))
    assert.match(junk[0]!, /Welcome to fake-agent/)
    assert.match(junk[1]!, /^Content-Length: 12/)
  } finally { await h.conn.close() }
})

test("acp-rpc: a line past maxLineBytes is dropped, not buffered, and the connection keeps working", async () => {
  const h = connect("oversized", { maxLineBytes: 64 * 1024 })
  try {
    const { init } = await handshake(h)
    assert.equal(init.protocolVersion, 1)
    assert.ok(h.diagnostics.some((d) => d.kind === "oversized-line"), JSON.stringify(h.diagnostics))
    assert.ok(!h.diagnostics.some((d) => d.kind === "junk-line"), "the dropped line's tail must not be parsed as a second junk line")
  } finally { await h.conn.close() }
})

test("acp-rpc: session/request_permission round-trips — the agent's optionId is echoed back and the tool call completes", async () => {
  const h = connect("ask-permission", {
    onRequest: async (method, params) => {
      assert.equal(method, "session/request_permission")
      const p = AcpRequestPermissionParams.parse(params)
      assert.equal(p.toolCall.toolCallId, "call_1")
      assert.equal(p.toolCall.kind, "execute")
      const allow = p.options.find((o) => o.kind === "allow_once")!
      return { outcome: { outcome: "selected", optionId: allow.optionId } }
    },
  })
  try {
    const { sess } = await handshake(h)
    const result = AcpPromptResult.parse(await h.conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "clean" }] }))
    assert.equal(result.stopReason, "end_turn")
    assert.equal(h.requests.length, 1)
    const done = h.updates.find((u) => u.update.sessionUpdate === "tool_call_update")!.update as { status?: string }
    assert.equal(done.status, "completed")
    const outcome = readFileSync(h.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.permissionOutcome)
    assert.deepEqual(outcome.permissionOutcome, { outcome: "selected", optionId: "opt-allow-once" })
  } finally { await h.conn.close() }
})

test("acp-rpc: a rejected permission fails the tool call (negative control for the round-trip)", async () => {
  const h = connect("ask-permission", { onRequest: async () => ({ outcome: { outcome: "selected", optionId: "opt-reject" } }) })
  try {
    const { sess } = await handshake(h)
    await h.conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "clean" }] })
    const done = h.updates.find((u) => u.update.sessionUpdate === "tool_call_update")!.update as { status?: string }
    assert.equal(done.status, "failed")
  } finally { await h.conn.close() }
})

test("acp-rpc: session/cancel ends a streaming turn with stopReason cancelled", async () => {
  const h = connect()
  try {
    const { sess } = await handshake(h)
    const turn = h.conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "count SLOW" }] })
    await new Promise((r) => setTimeout(r, 120))
    h.conn.notify("session/cancel", { sessionId: sess.sessionId })
    const result = AcpPromptResult.parse(await turn)
    assert.equal(result.stopReason, "cancelled")
    const streamed = h.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").length
    assert.ok(streamed >= 2 && streamed < 200, `streamed ${streamed} chunks before the cancel landed`)
  } finally { await h.conn.close() }
})

test("acp-rpc: an agent that answers a cancel with -32603 'aborted' surfaces it as a remote error the bridge can classify", async () => {
  const h = connect("cancel-error")
  try {
    const { sess } = await handshake(h)
    const turn = h.conn.requestOpenEnded("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "count SLOW" }] })
    await new Promise((r) => setTimeout(r, 80))
    h.conn.notify("session/cancel", { sessionId: sess.sessionId })
    await assert.rejects(turn, (err: unknown) => err instanceof AcpRemoteError && err.error.code === -32603 && /aborted/.test(String((err.error.data as { details?: string })?.details)))
  } finally { await h.conn.close() }
})

test("acp-rpc: session/load replays history before it responds", async () => {
  const h = connect()
  try {
    await handshake(h)
    const before = h.updates.length
    await h.conn.request("session/load", { sessionId: "fake_prior", cwd: "/tmp", mcpServers: [] })
    // The fake (like real opencode) sends `available_commands_update` AFTER the session/new reply, so it
    // may land inside this window; it classifies as `unknown` and is not part of the replay.
    const replayed = h.updates.slice(before).map((u) => u.update.sessionUpdate).filter((k) => k !== "unknown")
    assert.deepEqual(replayed, ["user_message_chunk", "agent_message_chunk"], "the replay is complete by the time the load response resolves")
  } finally { await h.conn.close() }
})

test("acp-rpc: a command that does not exist fails initialize with AcpConnectionClosed instead of an unhandled rejection", async () => {
  const h = connect("", { command: "/nonexistent/acp-agent-binary" })
  await assert.rejects(
    h.conn.request("initialize", { protocolVersion: 1 }),
    (err: unknown) => err instanceof AcpConnectionClosed && /ENOENT/.test(err.reason),
  )
  assert.equal(h.conn.closed, true)
})

test("acp-rpc: an agent that never answers initialize times out", async () => {
  const h = connect("slow-init", { requestTimeoutMs: 150 })
  try {
    await assert.rejects(h.conn.request("initialize", { protocolVersion: 1 }), (err: unknown) => err instanceof AcpRequestTimeout && err.method === "initialize")
  } finally { await h.conn.close() }
})

test("acp-rpc: every pending request settles when the agent exits", async () => {
  const h = connect("slow-init", { requestTimeoutMs: 10_000 })
  const p = h.conn.request("initialize", { protocolVersion: 1 })
  h.conn.process.kill("SIGKILL")
  await assert.rejects(p, (err: unknown) => err instanceof AcpConnectionClosed && /SIGKILL/.test(err.reason))
})

// Over the daemon transport stdin is a socket the daemon can hang up — it does, to the older client,
// the moment a newer one attaches — and a write that then fails does so ASYNCHRONOUSLY, as an `error`
// event on stdin. Nobody listened for it, so it was thrown out of the event loop and ended the server
// (scripts/verify-daemon-socket-takeover.mjs, scenario D). It must close the connection instead.
// Negative control: without the listener this test dies on the uncaught EPIPE.
test("acp-rpc: a stdin write that fails asynchronously closes the connection instead of escaping", async () => {
  const { PassThrough, Writable } = await import("node:stream")
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })))
    },
  })
  const proc = {
    stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 1,
    kill: () => true,
    on() { return proc },
  }
  const conn = new AcpConnection(proc as never, { onRequest: async () => ({}), onNotification: () => {}, requestTimeoutMs: 5_000 })
  await assert.rejects(conn.request("initialize", {}), (err: unknown) => err instanceof AcpConnectionClosed && /EPIPE/.test((err as Error).message))
  assert.equal(conn.closed, true)
})
