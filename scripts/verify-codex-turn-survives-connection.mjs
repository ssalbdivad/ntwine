// DECISIVE real-binary experiment behind the "stuck in running" fix: does an in-flight codex
// app-server TURN survive the death of the connection running it?
//
// The bridge used to carry `current_turn_id` across a reconnect, which wedged a thread permanently
// (steer a phantom turn → startTurn refuses "already has an active turn"). Whether that was right
// hinges on one protocol fact, so measure it against the REAL `codex app-server` rather than the
// in-repo fake: start a long turn, SIGKILL the process mid-turn, `thread/resume` the same thread on a
// FRESH process, and watch whether the turn keeps producing (rollout grows / turn notifications
// arrive) or is simply gone.
//
//   node scripts/verify-codex-turn-survives-connection.mjs
//
// Needs a signed-in `codex` (0.144.x) on PATH. Spends a small amount of real model usage.
import { spawn } from "node:child_process"
import { mkdtempSync, statSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const CODEX = process.env.CODEX_BIN ?? "codex"
const cwd = mkdtempSync(join(tmpdir(), "codex-turn-survival-"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
}

// Minimal JSONL-RPC client over the app-server's stdio, mirroring the bridge's framing.
function connect(label) {
  const child = spawn(CODEX, ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] })
  let buffer = ""
  let nextId = 0
  const pending = new Map()
  const notifications = []
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const nl = buffer.indexOf("\n")
      if (nl < 0) return
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (!waiter) continue
        if (message.error) waiter.reject(new Error(`${label} ${JSON.stringify(message.error)}`))
        else waiter.resolve(message.result)
      } else if (message.method) {
        notifications.push({ method: message.method, params: message.params })
        // Server->client REQUESTS (approvals) must be answered or the turn blocks. Deny everything:
        // this experiment only needs the turn to be RUNNING, never to succeed.
        if (message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`)
        }
      }
    }
  })
  child.stderr.resume()
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${label} ${method} timed out`)) }, 60_000)
  })
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  return { child, request, notify, notifications }
}

async function initialize(conn) {
  const initialized = await conn.request("initialize", {
    clientInfo: { name: "ntwine", title: "Ntwine", version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
  })
  conn.notify("initialized")
  return initialized
}

// The rollout file the app-server writes for a codex session id, and its current size.
function rolloutPath(codexSessionId) {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { const hit = walk(full); if (hit) return hit }
      else if (entry.name.includes(codexSessionId)) return full
    }
    return null
  }
  return walk(root)
}
const sizeOf = (path) => { try { return statSync(path).size } catch { return -1 } }

const first = connect("A")
let second
try {
  await initialize(first)
  const started = await first.request("thread/start", {
    cwd,
    ephemeral: false,
    sandbox: "read-only",
    approvalsReviewer: "user",
  })
  const threadId = started.thread.id
  const codexSessionId = started.thread.sessionId
  console.log(`thread ${threadId} session ${codexSessionId}`)

  const turn = await first.request("turn/start", {
    threadId,
    clientUserMessageId: "verify-turn-survival",
    input: [{
      type: "text",
      // Long enough to still be streaming when we kill the process.
      text: "Count from 1 to 200. Write each number on its own line with a short remark about it. Do not use any tools.",
      text_elements: [],
    }],
  })
  const turnId = turn.turn.id
  console.log(`turn ${turnId} started`)

  // Let it stream, then measure the rollout so growth is attributable.
  await sleep(12_000)
  const path = rolloutPath(codexSessionId)
  check(Boolean(path), "rollout file located", path ?? "not found")
  const sizeBeforeKill = sizeOf(path)
  const streamingNotifications = first.notifications.length
  check(sizeBeforeKill > 0 && streamingNotifications > 0, "turn is genuinely in flight before the kill",
    `rollout ${sizeBeforeKill}B, ${streamingNotifications} notifications`)

  // Kill the process mid-turn — no turn/completed is ever delivered. This is the live incident.
  first.child.kill("SIGKILL")
  await sleep(1_500)
  const sizeAfterKill = sizeOf(path)

  // A FRESH process resumes the same persisted thread, exactly as the bridge does on reconnect.
  second = connect("B")
  await initialize(second)
  const resumed = await second.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })
  check(resumed.thread.id === threadId, "fresh process resumed the same thread", resumed.thread.id)

  // THE QUESTION: with the thread resumed, does the interrupted turn keep running?
  await sleep(15_000)
  const sizeAfterResume = sizeOf(path)
  const turnNotifications = second.notifications.filter((n) => String(n.method).startsWith("turn/"))
  console.log(`rollout: ${sizeBeforeKill}B before kill → ${sizeAfterKill}B after kill → ${sizeAfterResume}B after resume`)
  console.log(`post-resume notifications: ${JSON.stringify(second.notifications.map((n) => n.method))}`)
  check(sizeAfterResume === sizeAfterKill, "the interrupted turn produced NOTHING after the resume",
    `${sizeAfterResume - sizeAfterKill}B written`)
  check(turnNotifications.length === 0, "the resumed connection saw no turn activity for the dead turn",
    JSON.stringify(turnNotifications.map((n) => n.method)))

  // And the thread must still be usable: a brand-new turn starts on the fresh connection.
  const next = await second.request("turn/start", {
    threadId,
    clientUserMessageId: "verify-turn-survival-2",
    input: [{ type: "text", text: "Reply with exactly: ok", text_elements: [] }],
  })
  check(Boolean(next.turn.id), "a fresh turn starts on the resumed thread", next.turn.id)
  check(next.turn.id !== turnId, "the fresh turn is a NEW turn, not the dead one", `${turnId} → ${next.turn.id}`)
} finally {
  first.child.kill("SIGKILL")
  second?.child.kill("SIGKILL")
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
