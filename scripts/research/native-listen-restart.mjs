// DECISIVE probe: does a turn started on connection A survive A's death, and can a LATER connection
// C rejoin it and observe `turn/completed`? This is exactly ntwine's Update & Restart case.
// One billed turn. Throwaway cwd.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire("/Users/colinmcd94/Documents/projects/ntwine/packages/server/index.js")
const WebSocket = require("ws")

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntwine-nl3-"))
const cwd = path.join(runDir, "work"); fs.mkdirSync(cwd)
const sock = path.join(runDir, "as.sock")
const logPath = path.join(runDir, "server.log")
const log = fs.openSync(logPath, "a")
const child = spawn("codex", ["app-server", "--listen", `unix://${sock}`], { stdio: ["ignore", log, log], env: process.env })
console.log("[p3] runDir", runDir, "serverPid", child.pid)
process.on("exit", () => { try { child.kill("SIGKILL") } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const INIT = { clientInfo: { name: "ntwine", title: "Ntwine", version: "0.0.1" }, capabilities: { experimentalApi: true } }

class Conn {
  constructor(tag) { this.tag = tag; this.notes = []; this.next = 1; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(`ws+unix://${sock}:/`, { perMessageDeflate: false })
    await new Promise((res, rej) => { this.ws.once("open", res); this.ws.once("error", rej) })
    this.ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()) } catch { return }
      if (m.id !== undefined && m.method === undefined) {
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) }
        return
      }
      this.notes.push(m)
      if (/^turn\/|^thread\/(started|error)/.test(m.method ?? "")) {
        console.log(`  [${this.tag} note] ${m.method} ${JSON.stringify(m.params).slice(0, 180)}`)
      }
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
  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params })) }
  kill() { this.ws.terminate() }
  methodCounts() {
    const c = {}
    for (const m of this.notes) c[m.method] = (c[m.method] ?? 0) + 1
    return c
  }
}
const brief = (m, n = 240) => JSON.stringify(m).slice(0, n)

const main = async () => {
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await sleep(100)

  const a = await new Conn("A").open()
  await a.request("initialize", INIT); a.notify("initialized", {})
  const ta = await a.request("thread/start", { cwd, model: null, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", ephemeral: false })
  const threadId = ta?.result?.thread?.id
  console.log("[p3] threadId", threadId)

  const turn = await a.request("turn/start", {
    threadId,
    clientUserMessageId: "probe-msg-1",
    input: [{ type: "text", text: "Count from 1 to 30. Put each number on its own line with a one-sentence fact about it. Do not use any tools.", text_elements: [] }],
  })
  const turnId = turn?.result?.turn?.id
  console.log("[p3] turn/start ->", brief(turn), "turnId", turnId)

  await sleep(6000)
  console.log("[p3] A notes before drop:", JSON.stringify(a.methodCounts()))

  // ---- simulate Update & Restart: hard-kill the client mid-turn ----
  a.kill()
  console.log("[p3] === client A TERMINATED mid-turn ===")
  await sleep(8000)
  console.log("[p3] server alive after client death:", alive(child.pid))

  // ---- new runtime attaches ----
  const c = await new Conn("C").open()
  await c.request("initialize", INIT); c.notify("initialized", {})
  console.log("[p3] C initialized; resuming thread")
  const res = await c.request("thread/resume", { threadId, excludeTurns: true, approvalsReviewer: "user" })
  console.log("[p3] C thread/resume ->", brief(res, 1200))

  console.log("[p3] waiting up to 180s on C for turn/completed ...")
  const deadline = Date.now() + 180000
  let completed = null
  while (Date.now() < deadline) {
    completed = c.notes.find((m) => m.method === "turn/completed" || m.method === "turn/failed" || m.method === "turn/aborted")
    if (completed) break
    await sleep(1000)
  }
  console.log("[p3] C notes:", JSON.stringify(c.methodCounts()))
  console.log("[p3] TURN TERMINAL EVENT ON C:", completed ? brief(completed, 500) : "*** NONE — events were NOT delivered to the reattached client ***")

  // Cross-check the ground truth: is the turn actually finished per the server?
  const listed = await c.request("thread/turns/list", { threadId, limit: 5, sortDirection: "desc" }, 20000)
  console.log("[p3] thread/turns/list ->", brief(listed, 900))
  console.log("[p3] runDir", runDir)
}

main().catch((e) => console.log("[p3] FATAL", e)).finally(async () => {
  await sleep(300)
  try { console.log("[p3] server WARN/ERROR:\n" + fs.readFileSync(logPath, "utf8").split("\n").filter((l) => /WARN|ERROR/.test(l)).slice(0, 20).join("\n")) } catch {}
  try { child.kill("SIGKILL") } catch {}
  process.exit(0)
})
