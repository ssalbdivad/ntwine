// Seed an adhoc stack with a thread that received messages from ANOTHER thread through Claude Code's
// cross-session channel — the hairline SessionMessageLine draws. No provider is dispatched.
//
//   nub scripts/seed-session-peer.mjs --home=<adhoc-stack HOME>
//
// Three messages land in the watcher thread: one from the coordinator thread (a fake live-session
// registry entry traces its socket to that thread, so the line links it), one that arrived while the
// watcher was idle (the wrapped delivery shape), and one from a session Frizz cannot place (no
// registry entry, so the line names the session without a link).
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const home = process.argv.find((a) => a.startsWith("--home="))?.slice(7)
if (!home) throw new Error("Pass --home=<disposable adhoc-stack HOME>")
const project = process.cwd()
const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", project.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const t0 = Date.now() - 20 * 60_000
const at = (min) => new Date(t0 + min * 60_000).toISOString()

const coordinator = { slug: "security-coordinator", sessionId: randomUUID(), title: "Coordinate the implant sweep" }
const watcher = { slug: "implant-watcher", sessionId: randomUUID(), title: "Read-only implant watcher" }
const pid = 990000 + Math.floor(Math.random() * 9000)
const socket = `/tmp/cc-socks/${pid}.sock`
mkdirSync(join(home, ".claude", "sessions"), { recursive: true })
writeFileSync(join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({
  pid, sessionId: coordinator.sessionId, cwd: project, kind: "interactive", messagingSocketPath: socket, name: "frizz-11", nameSource: "derived", status: "idle",
}))

const wrap = (body, from = `uds:${socket}`, name = "frizz-11") =>
  `<cross-session-message from="${from}" from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`
const steer = "Remove `sfltool dumpbtm` from your watcher pass (`pass.sh` line 33) now: it puts a macOS admin-password dialog on the maintainer's screen every pass.\n\n- Never run a command that asks for a password or admin rights (`sfltool`, `sudo`, `security`).\n- Keep the BTM baseline you already captured; for later passes, watch the LaunchAgents/LaunchDaemons folders' mtimes only."
const idle = "Second pass is clean on my side too. Rest until the next timer fires."
const stranger = "Heads-up from the nub repo: the shared `/tmp/cc-socks` cleanup ran at 22:40."
const guidance = "This came from another Claude session — not typed by your user, but very likely working on their behalf."

const text = (id, s, ts) => ({ type: "assistant", timestamp: ts, message: { id, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: s }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 10 } } })
const watcherRecords = [
  { type: "user", timestamp: at(0), message: { role: "user", content: "You are a read-only security watcher. Run pass.sh every 10 minutes and report anything new." } },
  text("w1", "First pass done: no new launch agents, BTM baseline captured. I'll first confirm the second run has no attacker IOCs.", at(1)),
  { type: "queue-operation", operation: "enqueue", timestamp: at(2), content: wrap(steer) },
  { type: "attachment", timestamp: at(2), isSidechain: false, attachment: { type: "queued_command", prompt: wrap(steer), commandMode: "prompt", isMeta: true, origin: { kind: "peer", from: `uds:${socket}`, verifiedPeerPid: pid, name: "frizz-11", fromMode: "bypass", body: steer } } },
  { type: "queue-operation", operation: "remove", timestamp: at(2.2), content: wrap(steer), reason: "absorbed_mid_turn" },
  text("w2", "Removed `sfltool dumpbtm` from `pass.sh`; later passes read folder mtimes only.", at(3)),
  { type: "queue-operation", operation: "enqueue", timestamp: at(8), content: wrap(idle) },
  { type: "user", isMeta: true, isSidechain: false, timestamp: at(8), message: { role: "user", content: `Another Claude session sent a message:\n${wrap(idle)}\n\n${guidance}` } },
  text("w3", "Resting until the next timer.", at(9)),
  { type: "queue-operation", operation: "enqueue", timestamp: at(12), content: wrap(stranger, "uds:/tmp/cc-socks/1.sock", "nub-d1") },
  { type: "user", isMeta: true, isSidechain: false, timestamp: at(12), message: { role: "user", content: `Another Claude session sent a message:\n${wrap(stranger, "uds:/tmp/cc-socks/1.sock", "nub-d1")}\n\n${guidance}` } },
  text("w4", "Noted; it does not touch this watcher.", at(13)),
]
const coordinatorRecords = [
  { type: "user", timestamp: at(0), message: { role: "user", content: "Coordinate the implant sweep across the machine." } },
  text("c1", "Spawned the read-only watcher and sent it the sfltool correction.", at(3)),
]
const write = (t, records) => writeFileSync(join(jsonlDir, `${t.sessionId}.jsonl`), records.map((r) => JSON.stringify({ uuid: randomUUID(), parentUuid: null, cwd: project, sessionId: t.sessionId, ...r })).join("\n") + "\n")
write(watcher, watcherRecords)
write(coordinator, coordinatorRecords)
const insert = (t) => `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
  VALUES (${vals}'${t.slug}', '${t.sessionId}', 'frizz-${t.slug}', '${at(0)}', '${t.title}', 'claude', 'opus', 'high', 'default', '${at(13)}');`
execFileSync("sqlite3", [sandbox.db, insert(coordinator) + insert(watcher)])
console.log(JSON.stringify({ watcher: watcher.slug, coordinator: coordinator.slug, socket }))
