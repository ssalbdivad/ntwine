// LIVE: the REAL `mcp__ntwine__recurring_prompt` tool arming a REAL session row, through the whole chain a
// worker actually uses.
//   nub packages/server/src/backend/_live_stop_hook_tool.mts
//
// The other two halves of this feature are already proven elsewhere and are NOT re-proven here:
// ntwine-mcp.test.ts drives the real MCP server over real stdio and asserts the exact RPC body it emits,
// and _live_stop_hook.mts drives a real Claude worker being bumped at rest and closing the loop with
// AWAITING. What neither covers is the SEAM between them — the tool's HTTP call reaching ntwine's real
// router and actually landing on the row — which is exactly where a wrong guard or a mistyped procedure
// name would hide, and would look to the worker like success.
//
// So this runs: the real ntwine MCP server process → its real stdio JSON-RPC → its real `fetch` at the
// port it reads out of a real `server.lock` → the real Hono app → the real router mutation → real
// SQLite. No model, because no model is needed to test a seam; the tool call is issued directly.
//
// The last assertion is the one that matters most: a worker can only ever arm ITS OWN thread. The tool
// exposes no thread parameter, and this proves an invented one cannot reach the server.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "../app.ts"
import { createStorage } from "../storage.ts"
import { resolveNtwineMcp } from "../dispatch.ts"
import type { AppContext } from "../context.ts"

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const stateDir = mkdtempSync(join(tmpdir(), "stophook-tool-"))
const storage = createStorage(join(stateDir, "ui.db"), "p")
const now = new Date().toISOString()
for (const slug of ["mine", "someone-else"]) {
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: now,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as Parameters<typeof storage.upsertSession>[0])
}

// Everything the stop-hook route does NOT touch is inert; storage and board.refresh are real/observed.
const inert = new Proxy({}, { get: () => () => {} })
let refreshes = 0
const ctx = {
  bootId: "stophook-tool",
  project: { id: "p", dir: stateDir, stateDir, cwdSlug: "-p", name: "p", label: "l/p" },
  bus: inert, transcriptChange: inert, storage,
  interactions: inert, tailer: inert, dispatcher: inert,
  board: { refresh: () => { refreshes++ } },
  backendFor: () => inert, scheduler: inert, permissionController: inert,
  getSettings: () => ({}), setSettings: (s: unknown) => s, resetSettings: () => ({}),
} as unknown as AppContext

// createApp returns an UNBOUND Hono app (its in-process `app.request` is what app.test.ts drives). The
// tool under test issues a real `fetch` at a real port, so bind it for real — that socket is the seam
// this probe exists to exercise.
const PORT = 49_331
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

const row = (slug: string) => storage.getSession(slug)!

try {
  const worker = mcp({ NTWINE_THREAD_SLUG: "mine" })
  await worker.init()

  // ---- ARM, through the whole real chain --------------------------------------------------------
  const armed = await worker.call(1, "recurring_prompt", { action: "start", prompt: "keep the migration moving" })
  ok("the tool call succeeded end to end", armed.result?.isError === undefined,
    armed.result?.content?.[0]?.text?.slice(0, 160) ?? JSON.stringify(armed).slice(0, 160))
  ok("the REAL row is armed and enabled",
    row("mine").recurring_prompt === "keep the migration moving" && row("mine").recurring_on_rest === 1,
    `recurring_prompt=${JSON.stringify(row("mine").recurring_prompt)} enabled=${row("mine").recurring_on_rest}`)
  ok("…with a generation stamped, so the scheduler can bind a bump to it", !!row("mine").recurring_armed_at)
  ok("the board was told to refresh", refreshes > 0, `${refreshes} refresh(es)`)

  // ---- RE-ARM with the same words keeps the generation (a worker re-registering on resume) -------
  const gen = row("mine").recurring_armed_at
  await worker.call(2, "recurring_prompt", { action: "start", prompt: "keep the migration moving" })
  ok("re-arming with the SAME text does not mint a new generation", row("mine").recurring_armed_at === gen)

  // ---- THE ASSERTION THAT MATTERS: a worker cannot arm anyone else's thread ----------------------
  const before = row("someone-else").recurring_prompt ?? null
  await worker.call(3, "recurring_prompt", {
    action: "start", prompt: "loop forever", slug: "someone-else", thread: "someone-else", threadSlug: "someone-else",
  })
  ok("an invented thread argument does NOT reach another thread's row",
    (row("someone-else").recurring_prompt ?? null) === before,
    `someone-else.recurring_prompt=${JSON.stringify(row("someone-else").recurring_prompt)}`)
  ok("…and the caller's OWN row took the text instead", row("mine").recurring_prompt === "loop forever")

  // ---- STOP, the worker ending its own loop deliberately ----------------------------------------
  const stopped = await worker.call(4, "recurring_prompt", { action: "stop" })
  ok("the disarm call succeeded", stopped.result?.isError === undefined)
  ok("the row is fully cleared",
    row("mine").recurring_prompt === null && row("mine").recurring_armed_at === null && row("mine").recurring_on_rest === 0,
    `recurring_prompt=${JSON.stringify(row("mine").recurring_prompt)} enabled=${row("mine").recurring_on_rest}`)

  worker.kill()

  // ---- A server with no thread identity must FAIL, never guess ----------------------------------
  const anonymous = mcp({ NTWINE_THREAD_SLUG: "", NTWINE_THREAD: "" })
  await anonymous.init()
  const refused = await anonymous.call(1, "recurring_prompt", { action: "start", prompt: "x" })
  ok("an MCP server with no stamped thread refuses rather than guessing",
    refused.result?.isError === true && /not told which thread it belongs to/.test(refused.result?.content?.[0]?.text ?? ""),
    refused.result?.content?.[0]?.text?.slice(0, 120) ?? "")
  anonymous.kill()
} finally {
  try { server.close?.() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
