// LIVE: the REAL `mcp__ntwine__timer` tool arming a REAL row and being DELIVERED by the REAL scheduler,
// through the whole chain a worker actually uses.
//   nub packages/server/src/backend/_live_timer_tool.mts
//
// The unit tests cover the two ENDS in isolation — ntwine-mcp.test.ts drives the real MCP server over real
// stdio and asserts the exact RPC body it emits, thread-timers.test.ts drives the real scheduler pass
// over real storage. What neither covers is the SEAM: the tool's HTTP call reaching ntwine's real router,
// landing on a real row, and that row then producing a real delivery. A wrong guard, a mistyped
// procedure name or a units mismatch (epoch ms vs ISO) would hide exactly there and would look to the
// worker like success.
//
// So this runs: the real ntwine MCP server process → its real stdio JSON-RPC → its real `fetch` at the port
// it reads out of a real `server.lock` → the real Hono app → the real router mutations → real SQLite →
// the real scheduler's own tick → the delivery a worker would receive. No model, because no model is
// needed to test a seam.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "../app.ts"
import { createStorage } from "../storage.ts"
import { createScheduler } from "../scheduler.ts"
import { resolveNtwineMcp } from "../dispatch.ts"
import type { AppContext } from "../context.ts"
import type { Tailer } from "../tailer.ts"

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const stateDir = mkdtempSync(join(tmpdir(), "timer-tool-"))
const storage = createStorage(join(stateDir, "ui.db"), "p")
const now = new Date().toISOString()
for (const slug of ["mine", "someone-else"]) {
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: now,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as Parameters<typeof storage.upsertSession>[0])
}

// Everything the timer routes do NOT touch is inert; storage and board.refresh are real/observed.
const inert = new Proxy({}, { get: () => () => {} })
const ctx = {
  bootId: "timer-tool",
  project: { id: "p", dir: stateDir, stateDir, cwdSlug: "-p", name: "p", label: "l/p" },
  bus: inert, transcriptChange: inert, storage,
  interactions: inert, tailer: inert, dispatcher: inert,
  board: { refresh: () => {} },
  backendFor: () => inert, scheduler: inert, permissionController: inert,
  getSettings: () => ({}), setSettings: (s: unknown) => s, resetSettings: () => ({}),
} as unknown as AppContext

// createApp returns an UNBOUND Hono app; the tool under test issues a real `fetch` at a real port, so
// bind it for real — that socket is half the seam this probe exists to exercise.
const PORT = 49_337
const app = createApp(ctx, { port: PORT })
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT })
writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: PORT }))

const descriptor = resolveNtwineMcp(stateDir)
if (!descriptor) throw new Error("the packaged ntwine MCP script must be resolvable")

/** Drive the REAL MCP server over its real stdio transport, as its worker does. */
function mcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [descriptor!.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, NTWINE_STATE_DIR: stateDir, ...env },
  })
  const pending = new Map<number, (v: any) => void>()
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  return {
    call: async (id: number, name: string, args: Record<string, unknown>) => {
      const reply = new Promise<any>((resolve) => pending.set(id, resolve))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n")
      return reply
    },
    init: async () => {
      const reply = new Promise<any>((resolve) => pending.set(0, resolve))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n")
      return reply
    },
    kill: () => child.kill(),
  }
}

const text = (reply: any): string => reply.result?.content?.[0]?.text ?? ""
const armed = (slug: string) => storage.listThreadTimers(slug, { armedOnly: true })

// The REAL scheduler over the REAL rows. Only the tailer is stubbed — it is the thread STATE being
// varied — and `now` is injected so an alarm can be made due without waiting for the wall clock.
let clock = Date.now()
let turn: "idle" | "in-flight" = "idle"
const delivered: { slug: string; message: string }[] = []
const scheduler = createScheduler({
  storage,
  now: () => clock,
  tailer: {
    get: () => ({
      turn, lastActivityAt: new Date(clock).toISOString(),
      subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
    }),
  } as unknown as Tailer,
  resume: async (slug, message) => { delivered.push({ slug, message }) },
  log: () => {},
})

try {
  const worker = mcp({ NTWINE_THREAD_SLUG: "mine" })
  await worker.init()

  // ---- SET, through the whole real chain ---------------------------------------------------------
  const set = await worker.call(1, "timer", { action: "set", prompt: "re-check the deploy", in_seconds: 600 })
  ok("the tool call succeeded end to end", set.result?.isError === undefined, text(set).slice(0, 160))
  const rows = armed("mine")
  ok("ONE real row is armed on the caller's own thread", rows.length === 1, `armed=${rows.length}`)
  ok("…carrying the worker's exact text", rows[0]?.prompt === "re-check the deploy", JSON.stringify(rows[0]?.prompt))
  ok("…at the instant the tool resolved, stored as epoch ms ~10 min out",
    Math.abs(rows[0].fire_at - (Date.now() + 600_000)) < 30_000,
    `fire_at=${rows[0] && new Date(rows[0].fire_at).toISOString()}`)
  ok("the reply names the id the worker needs to cancel it", text(set).includes(rows[0].id), text(set).slice(0, 120))

  // ---- ARBITRARILY MANY: a second set does not replace the first ---------------------------------
  await worker.call(2, "timer", { action: "set", prompt: "re-read the spec", in_seconds: 3600 })
  ok("a second timer is ADDED, not a replacement (unlike the recurring prompt)", armed("mine").length === 2,
    `armed=${armed("mine").length}`)
  const listed = await worker.call(3, "timer", { action: "list" })
  ok("`list` reads both back", armed("mine").every((t) => text(listed).includes(t.id)), text(listed).slice(0, 200))

  // ---- THE ASSERTION THAT MATTERS: a worker cannot touch anyone else's thread --------------------
  await worker.call(4, "timer", {
    action: "set", prompt: "not yours", in_seconds: 60, slug: "someone-else", thread: "someone-else",
  })
  ok("an invented thread argument does NOT arm another thread", armed("someone-else").length === 0)
  ok("…and the caller's OWN thread took it instead", armed("mine").length === 3)

  // ---- CANCEL --------------------------------------------------------------------------------
  const doomed = armed("mine").find((t) => t.prompt === "not yours")!
  const cancelled = await worker.call(5, "timer", { action: "cancel", id: doomed.id })
  ok("the cancel call succeeded", cancelled.result?.isError === undefined, text(cancelled).slice(0, 160))
  ok("the row is CANCELLED, not deleted", storage.getThreadTimer(doomed.id)?.state === "cancelled")
  ok("…and it is gone from the armed set", armed("mine").length === 2)
  const stale = await worker.call(6, "timer", { action: "cancel", id: doomed.id })
  ok("cancelling it twice is honest rather than an error", /No ARMED timer/.test(text(stale)), text(stale).slice(0, 100))

  // ---- THE SCHEDULER SEAM: an alarm actually reaching the worker ---------------------------------
  // Mid-turn on purpose. This is the property the feature was asked for ("like a heartbeat"), and the
  // one that a hold-until-rest gate would silently break.
  turn = "in-flight"
  clock = Date.now() + 601_000
  await scheduler.tick()
  ok("the due alarm was DELIVERED to the right thread, mid-turn", delivered.length === 1 && delivered[0]?.slug === "mine",
    JSON.stringify(delivered).slice(0, 200))
  ok("…with the worker's own words first, verbatim",
    !!delivered[0]?.message.startsWith("re-check the deploy\n\n(One-off timer, set for "),
    JSON.stringify(delivered[0]?.message).slice(0, 200))
  ok("…and the row it came from is now FIRED", armed("mine").length === 1 && armed("mine")[0].prompt === "re-read the spec")

  // ---- ONE-OFF: later ticks never deliver it again -----------------------------------------------
  clock = Date.now() + 1_200_000
  await scheduler.tick()
  await scheduler.tick()
  ok("a fired alarm never rings twice", delivered.length === 1, `${delivered.length} deliveries`)

  // A cancelled alarm whose instant has now passed must stay silent.
  clock = Date.now() + 4_000_000
  await scheduler.tick()
  const forCancelled = delivered.filter((d) => d.message.includes("not yours"))
  ok("a cancelled alarm never fires, even once its instant passes", forCancelled.length === 0)
  ok("…while the OTHER armed alarm did fire on its own instant", delivered.some((d) => d.message.includes("re-read the spec")))

  worker.kill()

  // ---- A server with no thread identity must FAIL, never guess ----------------------------------
  const anonymous = mcp({ NTWINE_THREAD_SLUG: "", NTWINE_THREAD: "" })
  await anonymous.init()
  const refused = await anonymous.call(1, "timer", { action: "set", prompt: "x", in_seconds: 60 })
  ok("an MCP server with no stamped thread refuses rather than guessing",
    refused.result?.isError === true && /not told which thread it belongs to/.test(text(refused)),
    text(refused).slice(0, 120))
  anonymous.kill()
} finally {
  await scheduler.stop()
  try { server.close?.() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
