// Probe: the two properties ntwine's daemon queue exists to preserve.
// EXP-A: a turn that completes ENTIRELY while no client is attached — can a later client learn it ended?
// EXP-B: an approval request issued to a client that then dies — is it re-delivered, or is the turn wedged?
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire("/Users/me/Documents/projects/ntwine/packages/server/index.js")
const WebSocket = require("ws")

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntwine-nl4-"))
const cwd = path.join(runDir, "work"); fs.mkdirSync(cwd)
const sock = path.join(runDir, "as.sock")
const logPath = path.join(runDir, "server.log")
const log = fs.openSync(logPath, "a")
const child = spawn("codex", ["app-server", "--listen", `unix://${sock}`], { stdio: ["ignore", log, log], env: process.env })
console.log("[p4] runDir", runDir, "serverPid", child.pid)
process.on("exit", () => { try { child.kill("SIGKILL") } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const INIT = { clientInfo: { name: "ntwine", title: "Ntwine", version: "0.0.1" }, capabilities: { experimentalApi: true } }

class Conn {
  constructor(tag) { this.tag = tag; this.notes = []; this.serverRequests = []; this.next = 1; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(`ws+unix://${sock}:/`, { perMessageDeflate: false })
    await new Promise((res, rej) => { this.ws.once("open", res); this.ws.once("error", rej) })
    this.ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()) } catch { return }
      if (m.id !== undefined && m.method === undefined) {
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) }
        return
      }
      if (m.id !== undefined && m.method !== undefined) {   // server-initiated REQUEST
        this.serverRequests.push(m)
        console.log(`  [${this.tag} SERVER-REQ] id=${m.id} ${m.method} ${JSON.stringify(m.params).slice(0, 200)}`)
        return
      }
      this.notes.push(m)
      if (/^turn\//.test(m.method ?? "")) console.log(`  [${this.tag} note] ${m.method} status=${m.params?.turn?.status}`)
    })
    return this
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.next++
    return new Promise((res) => {
      const t = setTimeout(() => res({ TIMEOUT: true }), timeoutMs)
      this.pending.set(id, (m) => { clearTimeout(t); res(m) })
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  respond(id, result) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result })) }
  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params })) }
  kill() { this.ws.terminate() }
  counts() { const c = {}; for (const m of this.notes) c[m.method] = (c[m.method] ?? 0) + 1; return c }
}
const brief = (m, n = 300) => JSON.stringify(m).slice(0, n)
const newConn = async (tag) => { const c = await new Conn(tag).open(); await c.request("initialize", INIT); c.notify("initialized", {}); return c }

const expA = async () => {
  console.log("\n===== EXP-A: turn completes entirely while DETACHED =====")
  const a = await newConn("A1")
  const t = await a.request("thread/start", { cwd, model: null, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", ephemeral: false })
  const threadId = t.result.thread.id
  const turn = await a.request("turn/start", { threadId, clientUserMessageId: "m1", input: [{ type: "text", text: "Reply with exactly: OK", text_elements: [] }] })
  const turnId = turn.result.turn.id
  console.log("[A] threadId", threadId, "turnId", turnId)
  a.kill()                                   // die IMMEDIATELY, before the turn can finish
  console.log("[A] === client killed instantly; sleeping 75s so the turn finishes fully detached ===")
  await sleep(75000)

  const z = await newConn("A2")
  const res = await z.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })
  console.log("[A2] resume thread.status ->", brief(res.result?.thread?.status))
  await sleep(5000)
  console.log("[A2] notifications received after resume:", JSON.stringify(z.counts()))
  const term = z.notes.find((m) => m.method === "turn/completed")
  console.log("[A2] replayed turn/completed?", term ? brief(term, 300) : "NO")
  const list = await z.request("thread/turns/list", { threadId, limit: 3, sortDirection: "desc" })
  const turns = (list.result?.data ?? []).map((x) => ({ id: x.id, status: x.status, completedAt: x.completedAt }))
  console.log("[A2] thread/turns/list statuses ->", JSON.stringify(turns))
  z.kill()
}

const expB = async () => {
  console.log("\n===== EXP-B: approval request outstanding when the client dies =====")
  const b = await newConn("B1")
  const t = await b.request("thread/start", { cwd, model: null, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", ephemeral: false })
  const threadId = t.result.thread.id
  const turn = await b.request("turn/start", { threadId, clientUserMessageId: "m2", input: [{ type: "text", text: "Create a file named hello.txt containing the word hello in the current directory. Use a shell command.", text_elements: [] }] })
  console.log("[B] threadId", threadId, "turnId", turn.result?.turn?.id)

  const deadline = Date.now() + 150000
  while (Date.now() < deadline && b.serverRequests.length === 0) await sleep(500)
  if (b.serverRequests.length === 0) { console.log("[B] *** no approval request arrived; cannot run EXP-B ***"); b.kill(); return }
  console.log("[B] approval request arrived; killing client WITHOUT responding")
  b.kill()
  await sleep(8000)

  const z = await newConn("B2")
  const res = await z.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })
  console.log("[B2] resume thread.status ->", brief(res.result?.thread?.status))
  console.log("[B2] waiting 60s to see whether the approval is re-issued / the turn reaches rest ...")
  const d2 = Date.now() + 60000
  while (Date.now() < d2) {
    if (z.serverRequests.length || z.notes.some((m) => m.method === "turn/completed")) break
    await sleep(1000)
  }
  console.log("[B2] re-issued approval requests:", z.serverRequests.length)
  console.log("[B2] notifications:", JSON.stringify(z.counts()))
  const term = z.notes.find((m) => m.method === "turn/completed")
  console.log("[B2] turn/completed?", term ? brief(term, 300) : "NO")
  const list = await z.request("thread/turns/list", { threadId, limit: 3, sortDirection: "desc" })
  console.log("[B2] turns/list statuses ->", JSON.stringify((list.result?.data ?? []).map((x) => ({ id: x.id, status: x.status }))))
  z.kill()
}

const main = async () => {
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await sleep(100)
  await expA()
  await expB()
  console.log("\n[p4] runDir", runDir)
}
main().catch((e) => console.log("[p4] FATAL", e)).finally(async () => {
  await sleep(300)
  try { child.kill("SIGKILL") } catch {}
  process.exit(0)
})
