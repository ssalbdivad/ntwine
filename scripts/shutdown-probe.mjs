// Shutdown diagnosis harness: boots a REAL ntwine server on a fully-isolated stack, optionally puts
// live load on it (SSE board stream, /ws app socket, in-flight RPC), then closes it and reports how
// long the shutdown barrier took plus every diagnostic it emitted.
//
//   nub scripts/shutdown-probe.mjs --port=4941 --load=sse,ws,rpc
//
// --load= is a comma list of: none | sse | ws | rpc  (default: none)
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const port = Number(opt("port", "4941"))
const load = new Set((opt("load", "none")).split(",").map((s) => s.trim()).filter(Boolean))
const projectDir = process.cwd()

const home = mkdtempSync(join(tmpdir(), "ntwine-shutdown-probe-"))
mkdirSync(join(home, ".ntwine"), { recursive: true })
process.env.HOME = home
process.env.NTWINE_SANDBOX_TAG = `ntwine-probe-${port}-${process.pid}`
process.env.NTWINE_WAKERS_OFF = "1"
process.env.NTWINE_ORPHAN_REAPER_OFF = "1"
process.chdir(projectDir)

const origin = `http://127.0.0.1:${port}`
const diagnostics = []
const { startServer } = await import("../packages/server/src/index.ts")
const started = await startServer({
  dev: false,
  port,
  installSignalHandlers: false,
  shutdownDiagnostic: (event) => {
    diagnostics.push(event)
    console.log(`[probe] diagnostic phase=${event.phase} message=${event.message}`)
  },
})
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(`${origin}/health`)).ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 50))
}
console.log(`[probe] booted on ${origin} (load: ${[...load].join(",") || "none"})`)

const opened = []
if (load.has("sse")) {
  const res = await fetch(`${origin}/events`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  const reader = res.body.getReader()
  const first = await reader.read()
  console.log(`[probe] sse open, first frame ${first.value?.length ?? 0} bytes`)
  opened.push(reader)
  // Regression guard for the reader-cancel fix: the stream must still be LIVE afterwards. The
  // /events handler heartbeats every 10s, so a second frame proves nothing cancelled it early.
  if (process.env.PROBE_ASSERT_LIVE) {
    const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r("TIMEOUT"), 14_000))])
    if (next === "TIMEOUT") { console.error("[probe] FAIL: no heartbeat within 14s — the SSE stream died early"); process.exit(1) }
    console.log(`[probe] sse still live, heartbeat frame ${next.value?.length ?? 0} bytes`)
  }
}
if (load.has("ws")) {
  const wsmod = await import("../packages/server/node_modules/ws/index.js")
  const WebSocket = wsmod.WebSocket ?? wsmod.default?.WebSocket ?? wsmod.default
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } })
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j) })
  console.log("[probe] app socket open")
  opened.push(ws)
}
let rpcInFlight
if (load.has("rpc")) {
  // A handful of concurrent live RPC calls, fired and NOT awaited, so some are still in flight at the
  // moment shutdown starts.
  rpcInFlight = Promise.allSettled(Array.from({ length: 8 }, () =>
    fetch(`${origin}/rpc/board.snapshot`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.text()),
  ))
  console.log("[probe] 8 rpc calls in flight")
}

await new Promise((r) => setTimeout(r, 500))

const t0 = Date.now()
let outcome = "clean"
try {
  await started.close()
} catch (error) {
  outcome = `THREW ${error?.name}: ${error?.message}`
}
const closeMs = Date.now() - t0
let fenceMs = null
let fenceOutcome = null
try {
  const t1 = Date.now()
  await started.shutdownFence.whenSafe()
  fenceMs = Date.now() - t1
  fenceOutcome = "safe"
} catch (error) {
  fenceOutcome = `THREW ${error?.name}: ${error?.message}`
}

console.log(JSON.stringify({
  load: [...load],
  closeMs,
  outcome,
  fenceMs,
  fenceOutcome,
  diagnostics: diagnostics.map((d) => ({ phase: d.phase, message: d.message, error: d.error?.message })),
}, null, 2))

if (process.env.PROBE_LINGER_MS) await new Promise((r) => setTimeout(r, Number(process.env.PROBE_LINGER_MS)))
try { rmSync(home, { recursive: true, force: true }) } catch {}
// Report what is still holding the event loop open — a clean shutdown must leave nothing.
const handles = (process._getActiveHandles?.() ?? []).map((h) => h.constructor?.name ?? typeof h)
const requests = (process._getActiveRequests?.() ?? []).map((h) => h.constructor?.name ?? typeof h)
console.log(`[probe] active handles after close: ${JSON.stringify(handles)} requests: ${JSON.stringify(requests)}`)
process.exit(0)
