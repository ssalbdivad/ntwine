// Runtime gate for the eager-sandbox-pill fix. The pill is a direct render of the board snapshot's
// `permissionMode`, so proving that value flips IMMEDIATELY after an eager sandbox change — before any
// new turn — proves the pill does. Drives a REAL codex thread on an isolated stack booted from THIS
// worktree's source (which carries the fix).
//
//   nub scripts/verify-pill-converge.mjs
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const PORT = Number(process.env.VERIFY_PORT ?? 4949)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[pill]", ...a)
let failures = 0
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++ }

const home = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-pill-home-")))
mkdirSync(join(home, ".ntwine"), { recursive: true })
const api = createRpcClient(`http://127.0.0.1:${PORT}/`)
let child

try {
  log("booting an isolated stack from this worktree source…")
  child = spawn("nub", ["scripts/adhoc-stack.mjs", `--port=${PORT}`], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, HOME: home, CODEX_HOME: join(homedir(), ".codex") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", (c) => { out += c })
  child.stderr.on("data", (c) => { out += c })
  const healthy = await api.waitForHealth(40_000)
  check(healthy, "stack is serving", `port ${PORT}`)
  if (!healthy) throw new Error(`stack never came up:\n${out.slice(-3000)}`)

  const auth = await api.query("authStatus").catch((e) => ({ error: e.message }))
  if (auth?.codex !== "authed") throw new Error(`HARNESS ENV: server can't see codex creds (${JSON.stringify(auth)}); re-run`)

  log("dispatching a real codex thread (starts at danger-full-access)…")
  const { slug, sessionId } = await api.mutate("dispatch", {
    title: "pill converge", prompt: "Reply with exactly READY and nothing else. Do not use tools.", backend: "codex",
  })
  check(!!slug, "codex dispatch ok", `${slug}`)

  const pill = async () => (await api.query("board"))?.threads?.find((t) => t.id === slug)?.permissionMode
  const waitTurnIdle = async (ms) => {
    for (let i = 0; i < Math.ceil(ms / 500); i++) {
      const t = (await api.query("board"))?.threads?.find((x) => x.id === slug)
      if (t && t.runtime !== "running" && t.runtime !== "spawning") return t
      await sleep(500)
    }
    return null
  }

  // Let the first turn run and rest — that emits the turn_context whose observed sandbox is the value
  // the OLD code would keep showing after a change.
  log("waiting for the first turn to emit an observed sandbox…")
  await waitTurnIdle(90_000)
  const before = await pill()
  check(before === "bypassPermissions", "pill shows the dispatched sandbox (danger-full-access) after the first turn", `permissionMode=${before}`)

  // Eager change to read-only (codex plan → read-only sandbox), mid-rest — no new turn will run.
  log("changing the sandbox to read-only (eager, no new turn)…")
  const res = await api.mutate("setThreadPermission", { slug, permissionMode: "plan" }).catch((e) => ({ error: e.message }))
  check(!res?.error, "setThreadPermission accepted", res?.error ?? JSON.stringify(res))

  // THE FIX: the pill must reflect the change NOW, without a new turn_context.
  let after
  for (let i = 0; i < 12; i++) { after = await pill(); if (after !== before) break; await sleep(500) }
  check(after !== before, "the pill CHANGED immediately after the eager sandbox change", `before=${before} after=${after}`)
  check(after === "plan", "and it shows the just-set value (read-only), not the stale observed one", `permissionMode=${after}`)

  console.log("\n--- server tail ---"); console.log(out.slice(-1200))
} catch (error) {
  check(false, "harness completed without throwing", String(error?.stack ?? error?.message ?? error))
} finally {
  if (child?.pid) { try { process.kill(child.pid, "SIGTERM") } catch {} }
  await sleep(2000)
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL") } catch {} }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
