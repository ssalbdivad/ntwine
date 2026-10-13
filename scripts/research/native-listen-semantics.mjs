// Probe: transport semantics of `codex app-server --listen unix://PATH`.
// Q1 does the process survive the client disconnecting?
// Q2 is `initialize` per-connection or per-process?
// Q3 does thread state created on connection A survive onto connection B/C?
// Q4 can two connections be attached at once?
// NO billed turn here — thread/start only.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire("/Users/me/Documents/projects/ntwine/packages/server/index.js")
const WebSocket = require("ws")

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntwine-nl2-"))
const cwd = path.join(runDir, "work"); fs.mkdirSync(cwd)
const sock = path.join(runDir, "as.sock")
const logPath = path.join(runDir, "server.log")
const log = fs.openSync(logPath, "a")
const child = spawn("codex", ["app-server", "--listen", `unix://${sock}`], { stdio: ["ignore", log, log], env: process.env })
console.log("[p2] runDir", runDir, "pid", child.pid)
process.on("exit", () => { try { child.kill("SIGKILL") } catch {} })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const INIT = { clientInfo: { name: "ntwine", title: "Ntwine", version: "0.0.1" }, capabilities: { experimentalApi: true } }

class Conn {
  constructor(tag) { this.tag = tag; this.msgs = []; this.next = 1; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(`ws+unix://${sock}:/`, { perMessageDeflate: false })
    await new Promise((res, rej) => { this.ws.once("open", res); this.ws.once("error", rej) })
    this.ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()) } catch { return }
      this.msgs.push(m)
      if (m.id !== undefined && m.method === undefined) {
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) }
      }
    })
    this.ws.on("close", (c) => console.log(`[p2] ${this.tag} closed code=${c}`))
    return this
  }
  request(method, params, timeoutMs = 20000) {
    const id = this.next++
    return new Promise((res) => {
      const t = setTimeout(() => res({ TIMEOUT: true }), timeoutMs)
      this.pending.set(id, (m) => { clearTimeout(t); res(m) })
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params })) }
  kill() { this.ws.terminate() }
}
const brief = (m) => JSON.stringify(m).slice(0, 260)

const main = async () => {
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await sleep(100)

  const a = await new Conn("A").open()
  console.log("[p2] A initialize ->", brief(await a.request("initialize", INIT)))
  a.notify("initialized", {})
  const ta = await a.request("thread/start", { cwd, model: null, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", ephemeral: false })
  console.log("[p2] A thread/start ->", brief(ta))
  const threadId = ta?.result?.thread?.id
  console.log("[p2] threadId", threadId)

  // Q4: a SECOND simultaneous connection
  const b = await new Conn("B").open()
  console.log("[p2] B (concurrent) opened")
  console.log("[p2] B request BEFORE initialize ->", brief(await b.request("thread/list", {}, 5000)))
  console.log("[p2] B initialize ->", brief(await b.request("initialize", INIT)))
  b.notify("initialized", {})
  console.log("[p2] B thread/resume of A's thread ->", brief(await b.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })))
  console.log("[p2] B initialize AGAIN (same conn) ->", brief(await b.request("initialize", INIT, 8000)))

  // Q1: hard-kill both connections (simulates a SIGKILLed runtime)
  a.kill(); b.kill()
  await sleep(2500)
  console.log("[p2] after both clients terminated: process alive =", alive(child.pid), "socket exists =", fs.existsSync(sock))

  const c = await new Conn("C").open()
  console.log("[p2] C reconnected ok")
  console.log("[p2] C request BEFORE initialize ->", brief(await c.request("thread/list", {}, 5000)))
  console.log("[p2] C initialize ->", brief(await c.request("initialize", INIT)))
  c.notify("initialized", {})
  console.log("[p2] C thread/resume of A's thread ->", brief(await c.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })))
  c.kill()
  await sleep(500)
  console.log("[p2] final: process alive =", alive(child.pid))
}

main().catch((e) => console.log("[p2] FATAL", e)).finally(async () => {
  await sleep(200)
  try { console.log("[p2] server WARN/ERROR:\n" + fs.readFileSync(logPath, "utf8").split("\n").filter((l) => /WARN|ERROR/.test(l)).slice(0, 25).join("\n")) } catch {}
  try { child.kill("SIGKILL") } catch {}
  process.exit(0)
})
