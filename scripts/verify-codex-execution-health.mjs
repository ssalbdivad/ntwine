// macOS-only real-runtime regression: invalidate ONLY a throwaway child's bootstrap port, then
// drive dispatch through the built Ntwine artifact. Never disrupt WindowServer or the user's session.
// Usage: CODEX_BIN=/absolute/pinned/codex nub scripts/verify-codex-execution-health.mjs
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { WebSocket } from "ws"
import { buildNtwineArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { nativeListenCodexAppServerHost, readNativeRecord, stopNativeListener } from "../packages/server/src/backend/codex-app-server-native.ts"
import { probeHostMacOSServices } from "../packages/server/src/backend/codex-execution-health.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

assert.equal(process.platform, "darwin", "this harness requires macOS")
const codex = process.env.CODEX_BIN
assert.ok(codex?.startsWith("/"), "set CODEX_BIN to the absolute Codex binary")
assert.ok(await probeHostMacOSServices(), "the parent must have working local service access")
const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-health-e2e-")))
const projectDir = join(root, "project"), stateDir = join(root, "state"), home = join(root, "home")
for (const dir of [projectDir, stateDir, home]) mkdirSync(dir, { recursive: true })
execFileSync("git", ["init", "-q", projectDir])
const projectId = randomUUID()
const target = { projectId, projectDir, stateDir }
const port = Number(process.env.VERIFY_PORT ?? 4957)
const api = createRpcClient(`http://127.0.0.1:${port}`)
const owner = acquireProjectLaunchOwner(target, "launcher")
let child, output = ""
const sockets = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rpc(record) {
  const socket = new WebSocket(`ws+unix://${record.socketPath}:/`, { perMessageDeflate: false })
  sockets.add(socket)
  let id = 0
  const pending = new Map()
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString())
    const item = pending.get(msg.id)
    if (!item) return
    pending.delete(msg.id); clearTimeout(item.timer)
    msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result)
  })
  await once(socket, "open")
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`timed out: ${method}`)) }, 10_000)
    pending.set(key, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: key, method, params }))
  })
  // Codex latches the FIRST client's name as its user-agent originator for this process.
  await request("initialize", { clientInfo: { name: "ntwine", version: "1" }, capabilities: { experimentalApi: true } })
  socket.send(JSON.stringify({ method: "initialized" }))
  return { request, close: () => { socket.close(); sockets.delete(socket) } }
}

async function stopServer() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  await exited
  clearTimeout(timer)
}

try {
  // task_set_special_port changes only this child. The null port survives exec and reproduces the
  // incident's launchctl 141 even though the parent and network remain healthy.
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim()
  const wrapper = join(root, "invalid-bootstrap")
  writeFileSync(wrapper, `#!${python}\nimport ctypes, os, sys\nlib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')\ntask = ctypes.c_uint.in_dll(lib, 'mach_task_self_').value\nassert lib.task_set_special_port(task, 4, 0) == 0\nos.execv(${JSON.stringify(codex)}, [${JSON.stringify(codex)}] + sys.argv[1:])\n`, { mode: 0o755 })
  const attachment = await nativeListenCodexAppServerHost({
    projectId, stateDir, cwd: projectDir, codexBin: wrapper,
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex") },
    clientInfo: {}, capabilities: {},
  })
  attachment.process.kill() // detach only
  const stale = readNativeRecord(stateDir, projectId)
  const staleRpc = await rpc(stale)
  const probe = await staleRpc.request("command/exec", {
    command: ["/bin/launchctl", "print", "system/com.apple.configd"], cwd: "/", timeoutMs: 3000, sandboxPolicy: { type: "dangerFullAccess" },
  })
  assert.equal(probe.exitCode, 141, "negative control must reproduce the incident")
  staleRpc.close()
  console.log("PASS real Codex child reproduces launchctl 141 with a healthy parent")

  const artifact = buildNtwineArtifact(resolve(import.meta.dirname, ".."), join(root, "artifacts"))
  console.log("Artifact", artifact.digest)
  async function startServer() {
    child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
      cwd: projectDir,
      env: projectLaunchEnvironment({
        ...process.env, HOME: home, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        NTWINE_RUNTIMES: "path", PATH: `${join(codex, "..")}:${process.env.PATH}`,
        NTWINE_CODEX_NATIVE_LISTEN: "1", NTWINE_DEV_CHILD: "1", NTWINE_DEV_PORT: String(port),
        NTWINE_WAKERS_OFF: "1", NTWINE_ORPHAN_REAPER_OFF: "1", NTWINE_TENANT_PRIME_OFF: "1",
        NTWINE_STABLE_ARTIFACT: artifact.digest, NTWINE_STABLE_WEB_DIST: artifact.webDir,
        NTWINE_SCRIPTS_DIR: join(artifact.runtimeDir, "board"), NTWINE_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
      }, target, owner.token),
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (data) => { output += data })
    child.stderr.on("data", (data) => { output += data })
    assert.ok(await api.waitForHealth(30_000), output.slice(-4000))
  }
  await startServer()
  const auth = await api.query("authStatus")
  assert.equal(auth.codex, "authed", "test credentials must reach the artifact")
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(async () => {
      const result = await api.mutate("dispatch", { title: "Blocked health probe", prompt: "Do not run", backend: "codex" })
      console.log("Unexpected dispatch success", result, "record", readNativeRecord(stateDir, projectId))
    }, /Codex cannot access macOS system services/)
    assert.equal(readNativeRecord(stateDir, projectId).generation, stale.generation)
    process.kill(stale.listenerPid, 0)
  }
  console.log("PASS artifact rejects repeated new conversations without killing the stale listener")
  await stopServer()
  await stopNativeListener(stateDir, projectId)
  await startServer()
  const dispatched = await api.mutate("dispatch", {
    title: "Healthy service probe", backend: "codex", model: "gpt-5.6-luna", effort: "low",
    prompt: `Run /bin/launchctl print system/com.apple.configd and /usr/sbin/scutil --dns. If both succeed and DNS configuration is present, write exactly HEALTH_OK to ${join(projectDir, "health.txt")}. Then finish. Do not use sub-agents.`,
  })
  const fresh = readNativeRecord(stateDir, projectId)
  assert.notEqual(fresh.generation, stale.generation)
  assert.notEqual(fresh.listenerPid, stale.listenerPid)
  const deadline = Date.now() + 120_000
  for (;;) {
    try { if (readFileSync(join(projectDir, "health.txt"), "utf8").trim() === "HEALTH_OK") break } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`worker did not verify service access: ${output.slice(-4000)}`)
    await sleep(1000)
  }
  console.log("PASS a real dispatched worker on the replacement regains service and resolver access")
  const freshRpc = await rpc(fresh)
  const before = await freshRpc.request("thread/loaded/list", {})
  assert.ok(before.data.length > 0)
  freshRpc.close()
  await stopServer()
  await startServer()
  // warmUp is asynchronous; a read of the real bridge-owned thread forces the reattachment.
  await api.query("threadTranscript", { slug: dispatched.slug })
  const rejoined = readNativeRecord(stateDir, projectId)
  assert.equal(rejoined.listenerPid, fresh.listenerPid)
  assert.equal(rejoined.generation, fresh.generation)
  const afterRpc = await rpc(rejoined)
  for (const id of before.data) assert.equal((await afterRpc.request("thread/read", { threadId: id, includeTurns: false })).thread.id, id)
  afterRpc.close()
  console.log("PASS ordinary artifact restart preserves the healthy backend and conversation identities")
} catch (error) {
  console.error(output.slice(-6000))
  for (const file of readdirSync(root, { recursive: true }).filter((path) => /diagnostics\.log$|codex-app-server-native\/.*\.json$/.test(path))) {
    console.error(file, readFileSync(join(root, file), "utf8").slice(-4000))
  }
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await stopServer()
  await stopNativeListener(stateDir, projectId)
  owner.release()
  rmSync(root, { recursive: true, force: true })
  console.log("Cleaned up the isolated server, listener, and temporary files")
}
