// Seed the fixture scripts/verify-ghost-floor.mjs drives: ONE simulated Claude worker whose follow-ups
// the RPC accepts and the provider never records, so an optimistic bubble has nothing to consume it.
//
// The verify script was written against a tmux-era fixture ("a thread whose pane is a dummy `sleep`"),
// and that fixture was never checked in. Its broker-era equivalent is the same idea one layer down:
//   • the row is `claude_runtime='broker'`, so board.ts deriveRuntime reads the tailed turn state
//     instead of calling it a dead pre-cutover row;
//   • a broker record names a LIVE stand-in `sleep`, the stand-in seed-resting-thread.mjs uses. With the
//     record's pid alive, the bridge's followUp ADOPTS that "daemon" rather than cold-resuming a real
//     `claude`, and its input frame goes to a socket nobody serves — the RPC returns, nothing is
//     recorded. That is exactly the stranded send the ghost floor exists for.
//
// Usage: node scripts/seed-ghost-floor.mjs --home=/abs/temp-home [--cwd=/abs/project]
// Prints one JSON line: {slug, jsonl, standInPid}. Pass the first two to verify-ghost-floor.mjs, and
// kill the stand-in by that exact pid when you are done (it is detached and outlives this script).
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node scripts/seed-ghost-floor.mjs --home=/abs/temp-home [--cwd=/abs/project]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const SLUG = "ghost-floor"
// Fresh per run: the verify script CONSUMES its seed (it appends to the transcript), and the server
// caches the projection per session.
const SESSION = randomUUID()
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

const T0 = Date.now() - 10 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const base = (ts) => ({ parentUuid: null, isSidechain: false, uuid: `9405f100-0000-4000-9000-${String(++n).padStart(12, "0")}`, timestamp: ts, session_id: SESSION, cwd })
const records = [
  { ...base(at(0)), type: "user", message: { role: "user", content: "TASK:\nTidy the ghost-floor fixture." } },
  { ...base(at(1)), type: "assistant", message: { model: "claude-opus-5", id: "msg_g1", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Tidied. Send a follow-up whenever you like." }], usage: { input_tokens: 2, output_tokens: 20 } } },
]
writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const standIn = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
standIn.unref()
const brokerDir = join(sandbox.stateDir, "claude-broker")
mkdirSync(brokerDir, { recursive: true })
// claude-broker-host.ts claudeBrokerRecordPath: sha256(sessionId)[0:16].json. `daemonPid` is the only
// field the liveness probe reads.
writeFileSync(join(brokerDir, `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.json`),
  JSON.stringify({ sessionId: SESSION, daemonPid: standIn.pid, socketPath: join(brokerDir, `${SLUG}.sock`) }))

execFileSync("sqlite3", [sandbox.db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode)
  VALUES (${vals}'${SLUG}', '${SESSION}', 'ntwine-${SLUG}', '${at(0)}', 'Ghost floor', 'claude', 'broker', 'opus', 'high', 'default')`])

console.log(JSON.stringify({ slug: SLUG, jsonl, standInPid: standIn.pid }))
