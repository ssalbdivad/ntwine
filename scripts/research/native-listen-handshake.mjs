// Step 1 probe: can a competent `ws` client complete the WS upgrade over
// `codex app-server --listen unix://PATH` and run a real JSON-RPC exchange?
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire("/Users/me/Documents/projects/ntwine/packages/server/index.js")
const WebSocket = require("ws")

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntwine-native-listen-"))
const sock = path.join(runDir, "as.sock")
const logPath = path.join(runDir, "server.log")
const log = fs.openSync(logPath, "a")

console.log("[probe] runDir", runDir)

const child = spawn("codex", ["app-server", "--listen", `unix://${sock}`], {
  stdio: ["ignore", log, log],
  env: { ...process.env, RUST_LOG: "codex_app_server_transport=trace,debug" },
})
console.log("[probe] pid", child.pid)

const cleanup = () => {
  try { child.kill("SIGKILL") } catch {}
}
process.on("exit", cleanup)

async function waitForSocket(ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const dumpLog = () => {
  try { console.log("[probe] --- server log ---\n" + fs.readFileSync(logPath, "utf8")) } catch {}
}

function tryConnect(pathname, extra = {}) {
  return new Promise((resolve) => {
    const url = `ws+unix://${sock}:${pathname}`
    const ws = new WebSocket(url, extra.protocols, { perMessageDeflate: false, ...extra.options })
    const frames = []
    const t = setTimeout(() => { resolve({ pathname, extra: JSON.stringify(extra), outcome: "timeout", frames }); try { ws.terminate() } catch {} }, 6000)
    ws.on("upgrade", (res) => { frames.push(["upgrade", res.statusCode, JSON.stringify(res.headers)]) })
    ws.on("open", () => {
      clearTimeout(t)
      resolve({ pathname, extra: JSON.stringify(extra), outcome: "OPEN", ws, frames })
    })
    ws.on("error", (err) => {
      clearTimeout(t)
      resolve({ pathname, extra: JSON.stringify(extra), outcome: "error: " + err.message, frames })
      try { ws.terminate() } catch {}
    })
    ws.on("unexpected-response", (_req, res) => {
      let body = ""
      res.on("data", (d) => (body += d))
      res.on("end", () => {
        clearTimeout(t)
        resolve({ pathname, extra: JSON.stringify(extra), outcome: `http ${res.statusCode}`, headers: res.headers, body: body.slice(0, 400), frames })
      })
    })
  })
}

const main = async () => {
  if (!(await waitForSocket())) {
    console.log("[probe] socket never appeared")
    dumpLog()
    return
  }
  console.log("[probe] socket present:", fs.statSync(sock).mode.toString(8))

  const attempts = [
    ["/", {}],
    ["/app-server", {}],
    ["/app-server", { protocols: ["codex-app-server"] }],
    ["/", { protocols: ["codex-app-server"] }],
    ["/app-server", { options: { origin: "http://localhost" } }],
  ]
  let openResult = null
  for (const [p, extra] of attempts) {
    const r = await tryConnect(p, extra)
    console.log("[probe] attempt", p, JSON.stringify(extra), "->", r.outcome, r.body ?? "", JSON.stringify(r.frames))
    if (r.outcome === "OPEN") { openResult = r; break }
  }
  dumpLog()
  if (!openResult) {
    console.log("[probe] RESULT: no upgrade completed")
    return
  }
  console.log("[probe] RESULT: upgrade completed on", openResult.pathname)
  const ws = openResult.ws
  ws.on("message", (d) => console.log("[recv]", d.toString().slice(0, 600)))
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { clientInfo: { name: "ntwine-probe", title: "Ntwine probe", version: "0.0.1" }, capabilities: { experimentalApi: true } },
  }))
  await new Promise((r) => setTimeout(r, 4000))
  ws.close()
  await new Promise((r) => setTimeout(r, 300))
  dumpLog()
}

main().finally(() => { cleanup(); setTimeout(() => process.exit(0), 200) })
