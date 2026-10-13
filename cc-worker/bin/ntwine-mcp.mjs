#!/usr/bin/env node
// @ts-check
import '../lib/legacy-frizz.mjs';
/**
 * ntwine-mcp — the worker registry (../lib/ntwine-tools.mjs) over MCP stdio, mounted as `ntwine` so its
 * tools are `mcp__ntwine__<tool>`. The command line (`ntwinectl`, beside this file) is the worker
 * surface; this front-end answers the same commands for a client that speaks MCP.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification, and send
 * one notification of our own, `notifications/tools/list_changed` (GATED_TOOLS). Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs (no build/bundle/resolution concerns), and it matches this repo's own hand-rolled-RPC
 * aesthetic. The server NEVER crashes on a bad tool call: failures come back as an isError tool
 * result so the worker sees a message instead of a dead tool.
 */
import { GATED_TOOLS, HANDLERS, Refused, TOOLS, rpcPath, serverLockPort } from "../lib/ntwine-tools.mjs"

const PROTOCOL_FALLBACK = "2025-06-18"

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
/** @param {string|number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}
/** @param {string|number} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}
/** @param {string|number} id @param {string} text @param {boolean} [isError] */
function replyTool(id, text, isError) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })
}

// A TOOL IS LISTED ONLY WHILE ITS CAPABILITY EXISTS (2026-10-06, plans/upstream-superset.md §5). Every
// listed tool is paid for on every turn, and a tool whose feature is absent can only answer "there is
// nothing here" — the 2026-08-26 browser decision's "a capability nobody asked for, charged per turn, is
// an opinion" (cc-worker/DECISIONS.md). GATED_TOOLS (../lib/ntwine-tools.mjs) maps a tool to the
// capability the server reports for it. `ntwinectl` has no per-turn cost and lists every command.
//
// LIVE, NOT ONCE. Claude Code (2.1.287, the SDK's headless path included) re-lists a server that
// declares `tools.listChanged` when it sends `notifications/tools/list_changed`, and a worker's ntwine
// tools are deferred, so a change costs one "now available" line rather than a rewritten prefix. So the
// list follows the human: this server asks at the first `tools/list`, then polls and announces each
// change. A client that ignores the notification keeps the list it read at session start, which is
// the same moment the contract's sections were chosen, so the two still agree.
//
// How often the poll asks. The bridge drops a window the moment its socket closes, and a window reloading
// is gone for a few seconds, so a capability must read absent at TWO polls in a row before its tool is
// withdrawn (CAPABILITY_ABSENT_POLLS); one that appears is listed at once.
// NTWINE_CAPABILITY_POLL_MS shortens it for ntwine-mcp.test.ts, which would otherwise wait out three polls.
const CAPABILITY_POLL_MS = Number(process.env.NTWINE_CAPABILITY_POLL_MS) || 10_000
const CAPABILITY_ABSENT_POLLS = 2
// One attempt, briefly: this runs inside the client's `tools/list`, where the registry's restart wait
// would stall the worker's startup. A failed read leaves the list as it was.
const CAPABILITY_TIMEOUT_MS = 2_000

/** What the last `tools/list` answered under: the server's capability report, `{}` when it could not be
 * read (every tool listed, as before gating). Undefined until the first `tools/list`.
 * @type {Record<string, unknown> | undefined} */
let listedCapabilities
/** @type {Record<string, number>} consecutive polls each listed capability has read absent */
const absentPolls = {}

/** The capability report for this thread, or undefined when it cannot be read — no server, a timeout,
 * or an Ntwine from before `workerCapabilities` (404). Never waits out a restart. */
async function readCapabilities() {
  try {
    const slug = process.env.NTWINE_THREAD_SLUG || process.env.NTWINE_THREAD
    const res = await fetch(`http://127.0.0.1:${serverLockPort()}${rpcPath("workerCapabilities")}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(slug ? { slug } : {}),
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const result = (await res.json())?.result
    return result && typeof result === "object" ? result : undefined
  } catch {
    return undefined
  }
}

/** Whether `capability` counts as present: only an explicit `false` hides a tool, so a capability the
 * server does not report (an older Ntwine) keeps its tool listed. @param {Record<string, unknown> | undefined} caps
 * @param {string} capability */
function hasCapability(caps, capability) {
  return caps?.[capability] !== false
}

/** The tools to list under `caps`. @param {Record<string, unknown> | undefined} caps */
function listedTools(caps) {
  return TOOLS.filter((tool) => !GATED_TOOLS[tool.name] || hasCapability(caps, GATED_TOOLS[tool.name]))
}

/** One poll: re-read the report and, when a gated capability has come or gone, change what is listed
 * and tell the client to list again. */
async function pollCapabilities() {
  const caps = await readCapabilities()
  if (!caps || !listedCapabilities) return
  const next = { ...listedCapabilities }
  let changed = false
  for (const capability of new Set(Object.values(GATED_TOOLS))) {
    const now = hasCapability(caps, capability)
    if (now === hasCapability(listedCapabilities, capability)) {
      absentPolls[capability] = 0
      continue
    }
    if (!now && (absentPolls[capability] = (absentPolls[capability] ?? 0) + 1) < CAPABILITY_ABSENT_POLLS) continue
    absentPolls[capability] = 0
    next[capability] = now
    changed = true
  }
  if (!changed) return
  listedCapabilities = next
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
}

/** `tools/list`: the first one reads the report and starts the poll; later ones answer what the poll
 * has settled, so a re-list right after a notification lists exactly what the notification announced. */
async function toolsList() {
  if (!listedCapabilities) {
    listedCapabilities = (await readCapabilities()) ?? {}
    let polling = false
    setInterval(() => {
      if (polling) return
      polling = true
      void pollCapabilities().finally(() => { polling = false })
    }, CAPABILITY_POLL_MS).unref()
  }
  return listedTools(listedCapabilities)
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
        // `listChanged`: the tool list follows the capabilities the server reports (GATED_TOOLS).
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "ntwine", version: "0.1.0" },
      })
      return
    }
    case "notifications/initialized":
    case "initialized":
      return // notification — no reply
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: await toolsList() })
      return
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : ""
      const handler = HANDLERS[name]
      if (!handler) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        // A refusal is an ordinary answer here, exactly as it was before the command line gave it an
        // exit code of its own: a gate doing its job, not a fault.
        const answer = await handler(params?.arguments ?? {})
        replyTool(id, answer instanceof Refused ? answer.text : answer)
      } catch (err) {
        replyTool(id, `\`${name}\` failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
      return
  }
}

// NDJSON reader: buffer stdin, dispatch each complete line. Messages never contain raw newlines.
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore unparseable lines
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
