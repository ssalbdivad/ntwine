// The steering-latency report: what the operator actually feels, measured against a REAL running stack.
//
//   node scripts/measure-steer-latency.mjs <url> [slug] [sessionId]
//
// Three numbers, in the order they explain each other:
//   1. loopMs      — /health round-trip percentiles with the server otherwise IDLE. /health does no work,
//                    so this IS the event-loop blocking the tailer tick imposes on every other request.
//   2. rpcMs       — click → the lifecycle mutation's own reply.
//   3. sidebarMs   — click → the board-delta carrying that thread's new state, i.e. when the SIDEBAR row
//                    can re-section. The queue card dismisses optimistically at 0ms; this is the gap the
//                    operator sees as "the sidebar won't update for a number of seconds".
//   4. transcriptMs— a JSONL record appended → the server's transcript RPC rendering it. This is the
//                    "enqueued bubble stayed for 50 seconds" symptom, measured without Claude Code in
//                    the loop (the fixture appends the exact records Claude Code writes).
import { appendFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const [url, slug = "worker-3", sessionId = "00000003-2222-3333-4444-555555555555", home] = process.argv.slice(2)
if (!url) {
  console.error("usage: node measure-steer-latency.mjs <url> [slug] [sessionId] [tempHome]")
  process.exit(1)
}
const api = createRpcClient(url)
if (!(await api.waitForHealth())) throw new Error("server never became healthy")

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const round = (n) => (n === null || n === undefined ? null : +n.toFixed(1))

// ── 1. event-loop blocking ────────────────────────────────────────────────────────────────────────
const health = []
for (let i = 0; i < 60; i++) {
  const t = performance.now()
  try { await fetch(new URL("/_ntwine/health", url)) } catch {}
  health.push(performance.now() - t)
  await new Promise((r) => setTimeout(r, 50))
}

// ── SSE subscription (before any mutation, so no delta can be missed) ──────────────────────────────
const res = await fetch(new URL("/_ntwine/events", url), { headers: { origin: new URL(url).origin } })
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ""
let keyframeSeen = false
const watchers = new Set()
void (async () => {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      if (!data) continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      if (event.type === "board") { keyframeSeen = true; continue }
      if (event.type !== "board-delta") continue
      for (const w of watchers) w(event)
    }
  }
})()
for (let i = 0; i < 200 && !keyframeSeen; i++) await new Promise((r) => setTimeout(r, 25))
if (!keyframeSeen) throw new Error("no board keyframe on /events")

const awaitDelta = (match, timeoutMs = 30_000) => {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const timer = setTimeout(() => { watchers.delete(w); resolve(null) }, timeoutMs)
    const w = (event) => {
      const hit = (event.upserts ?? []).find((t) => match(t)) || ((event.removed ?? []).includes(slug) ? true : null)
      if (!hit) return
      clearTimeout(timer)
      watchers.delete(w)
      resolve(performance.now() - t0)
    }
    watchers.add(w)
  })
}

// ── 2/3. mark-as-done: RPC reply vs. the sidebar's board delta ─────────────────────────────────────
// Five different threads, because ONE sample just measures whether the click happened to land in a gap
// between blocking ticks — the operator's complaint is about the ones that don't.
const runs = []
let rpcError = null
for (const n of [3, 5, 7, 11, 13]) {
  const s = `worker-${n}`
  const sid = `${String(n).padStart(8, "0")}-2222-3333-4444-555555555555`
  const deltaP = awaitDelta((t) => t.id === s && (t.state === "archived" || t.archived === true))
  const t0 = performance.now()
  try {
    await api.mutate("completeThread", { slug: s, sessionId: sid, terminateLive: true })
  } catch (error) { rpcError ??= String(error.message ?? error) }
  const rpc = performance.now() - t0
  runs.push({ slug: s, rpcMs: round(rpc), sidebarMs: round(await deltaP) })
  await new Promise((r) => setTimeout(r, 400))
}
const rpcMs = runs.map((r) => r.rpcMs)
const sidebarMs = runs.map((r) => r.sidebarMs)

// ── 4. JSONL record appended → transcript RPC renders it ──────────────────────────────────────────
// Reproduces a MID-TURN follow-up exactly as Claude Code writes it: the queue-operation enqueue when
// the message is accepted, then the queued_command attachment when the agent actually consumes it.
let transcript = { enqueuedMs: null, deliveredMs: null, note: "skipped (no tempHome given)" }
if (home) {
  const projects = join(home, ".claude", "projects")
  const dir = join(projects, readdirSync(projects)[0])
  const target = "worker-9"
  const targetSession = "00000009-2222-3333-4444-555555555555"
  const path = join(dir, `${targetSession}.jsonl`)
  const text = `mid-turn steer probe ${Date.now()}`
  const waitForTranscript = async (predicate, timeoutMs = 30_000) => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      try {
        const t = await api.query("threadTranscript", { slug: target })
        if (predicate(t)) return performance.now() - start
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }
  appendFileSync(path, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), content: text }) + "\n")
  const enqueuedMs = await waitForTranscript((t) => (t.messages ?? []).some((m) => m.text === text && m.queued))
  appendFileSync(path, JSON.stringify({
    type: "attachment",
    timestamp: new Date().toISOString(),
    // origin.kind "human" is REQUIRED by the transcript projection (a task-notification carries
    // origin:null + commandMode "task-notification" and is plumbing). Verified against a real
    // Claude Code transcript 2026-07-23 — every human follow-up's attachment has exactly this shape.
    attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: text },
  }) + "\n")
  const deliveredMs = await waitForTranscript((t) => (t.messages ?? []).some((m) => m.text === text && !m.queued))
  transcript = { enqueuedMs: round(enqueuedMs), deliveredMs: round(deliveredMs), note: undefined }
}

console.log(JSON.stringify({
  loopMs: { p50: round(pct(health, 0.5)), p90: round(pct(health, 0.9)), max: round(Math.max(...health)) },
  markAsDone: {
    rpcMs: { p50: round(pct(rpcMs, 0.5)), max: round(Math.max(...rpcMs)) },
    sidebarMs: { p50: round(pct(sidebarMs.filter((x) => x !== null), 0.5)), max: round(Math.max(...sidebarMs)) },
    runs, rpcError,
  },
  transcript,
}, null, 2))
try { await reader.cancel() } catch {}
process.exit(0)
