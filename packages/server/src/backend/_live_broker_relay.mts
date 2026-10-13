// LIVE validation of the broker RELAY design against real claude:
//   nub packages/server/src/backend/_live_broker_relay.mts
// Proves the parts the raw PoC skipped, with the SDK's typed payloads:
//   1. a permission request relays over the socket as a typed ClaudePermissionRequest; deny reaches the model
//   2. a PENDING permission survives ntwine dying + a fresh reconnect (re-delivered), then the session continues
// The broker runs DETACHED so "ntwine" (this harness's socket) can drop and a new socket can reconnect.
import net from "node:net"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const here = dirname(fileURLToPath(import.meta.url))
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "cb-repo-")); execFileSync("git", ["init", "-q", cwd])
const socketPath = join(tmpdir(), `cb${process.pid}.sock`)
const sessionId = randomUUID()
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const config = { socketPath, cwd, sessionId, executablePath: claudeBin, permissionMode: "default", env: process.env }
const broker = spawn(process.execPath, ["--experimental-strip-types", join(here, "claude-agent-broker.ts")], {
  cwd: join(here, "..", "..", ".."), env: { ...process.env, NTWINE_CLAUDE_BROKER: JSON.stringify(config) }, stdio: ["ignore", "inherit", "inherit"], detached: true,
})

interface Client { send: (o: unknown) => void; input: (text: string) => void; answer: (requestId: string, decision: unknown) => void; waitFor: (pred: (f: any) => boolean, ms?: number) => Promise<any>; close: () => void }
function connect(): Promise<Client> {
  return new Promise((resolveConn, reject) => {
    const sock = net.connect(socketPath)
    const frames: any[] = []; const waiters: { pred: (f: any) => boolean; resolve: (f: any) => void }[] = []
    let buf = ""
    sock.on("data", (d) => {
      buf += d
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue
        const f = JSON.parse(line); frames.push(f)
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1) }
      }
    })
    sock.on("error", reject)
    sock.on("connect", () => resolveConn({
      send: (o) => sock.write(JSON.stringify(o) + "\n"),
      input: (text) => sock.write(JSON.stringify({ t: "input", message: { id: randomUUID(), text } }) + "\n"),
      answer: (requestId, decision) => sock.write(JSON.stringify({ t: "permission", requestId, decision }) + "\n"),
      waitFor: (pred, ms = 90_000) => new Promise((res, rej) => {
        const hit = frames.find(pred); if (hit) return res(hit)
        const timer = setTimeout(() => rej(new Error("waitFor timeout")), ms)
        waiters.push({ pred: (f) => { if (pred(f)) { clearTimeout(timer); return true } return false }, resolve: res })
      }),
      close: () => sock.destroy(),
    }))
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
try {
  await wait(2_500) // let the broker bind + the SDK session init
  const denyPath = join(cwd, "deny.txt"); const allowPath = join(cwd, "allow.txt")

  // ---- 1. Typed permission round-trip over the socket: DENY reaches the model --------------------
  const c1 = await connect()
  await c1.waitFor((f) => f.t === "hello", 20_000)
  c1.input(`Use the Write tool to create the file at ${denyPath} with the text no. If you are blocked, reply with the single word BLOCKED.`)
  const preq = await c1.waitFor((f) => f.t === "permission-request")
  ok("permission relayed over the socket as a typed request", preq.request?.toolName === "Write" && typeof preq.requestId === "string", `tool=${preq.request?.toolName}`)
  c1.answer(preq.requestId, { behavior: "deny", message: "denied by the relay test" })
  const blocked = await c1.waitFor((f) => f.t === "event" && f.event.kind === "assistant" && /BLOCK/i.test((f.event.text || []).join(" ")))
  ok("DENY reached the model over the relay (BLOCKED)", !!blocked)
  ok("denied Write did not execute", !existsSync(denyPath))

  // ---- 2. A pending permission survives ntwine dying + reconnect -----------------------------------
  c1.input(`Now use the Write tool to create the file at ${allowPath} with the text ok.`)
  const preq2 = await c1.waitFor((f) => f.t === "permission-request" && /allow\.txt/.test(JSON.stringify(f.request?.input)))
  ok("second permission request arrived (for allow.txt)", !!preq2)
  console.log("  » dropping the socket WITHOUT answering (ntwine 'dies' mid-permission)…")
  c1.close()
  await wait(2_000)
  const c2 = await connect() // ntwine "restarts"
  await c2.waitFor((f) => f.t === "hello", 20_000)
  const preq2b = await c2.waitFor((f) => f.t === "permission-request" && /allow\.txt/.test(JSON.stringify(f.request?.input)), 20_000)
  ok("the pending permission was RE-DELIVERED to the reconnected client", !!preq2b, `requestId=${preq2b.requestId}`)
  c2.answer(preq2b.requestId, { behavior: "allow" })
  await c2.waitFor((f) => f.t === "event" && f.event.kind === "result", 90_000)
  ok("session CONTINUED across the reconnect (allowed Write executed)", existsSync(allowPath))
  c2.close()
} catch (err) {
  failures++; console.log(`\nERROR: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  try { process.kill(-broker.pid!, "SIGKILL") } catch {}
  try { broker.kill("SIGKILL") } catch {}
  rmSync(cwd, { recursive: true, force: true }); rmSync(socketPath, { force: true })
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
