// Seed the fixture scripts/verify-open-ask-composer.mjs drives: ONE Ready thread that asks two REGISTERED
// questions at its rest (A./B. each, the first offering "A. Key the cache…"), so its queue card on the one
// page carries the question chips, their answer textareas, Send answers AND the free-form reply box.
// The verify script's header always asked for "an open-ask thread" and none was ever checked in.
//
// Registered, not ```question fences. The fence was retired as a way to ask on 2026-09-11 (a worker asks
// with `mcp__ntwine__ask`, which writes a `thread_question` row), and the one page's card draws a fence
// read-only: only the drawer still answers one. So the ask a worker can actually make today is two rows
// in `thread_question`, written here the way scripts/seed-all-queues.mjs writes its own, because no
// human-facing RPC registers a question — only a worker's MCP call does.
//
// A broker row with a live stand-in daemon (a `sleep`), the same stand-in seed-resting-thread.mjs
// uses. At rest the stand-in changes nothing; it is there for the verify
// script's step 4, a real followUp. With no live daemon record the bridge would COLD-RESUME, i.e. start
// a real `claude` from this sandbox; with one it adopts the stand-in, the RPC returns 200, and the steer
// lands in the thread through the delivery ledger without any provider process being touched.
//
// Usage: nub scripts/seed-open-ask.mjs --home=/abs/temp-home [--cwd=/abs/project] [--slug=open-ask]
// Prints one JSON line: {slug, standInPid}. The run CONSUMES the seed (its steer is a newer human turn,
// after which the questions are no longer owed), so re-seed before each run; kill the stand-in by that
// exact pid when you are done.
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, cwd = process.cwd(), slug = "open-ask" } = flags
if (!home) {
  console.error("usage: nub scripts/seed-open-ask.mjs --home=/abs/temp-home [--cwd=/abs/project] [--slug=open-ask]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const SESSION = randomUUID()
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 20 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const base = (ts) => ({ parentUuid: null, isSidechain: false, uuid: `0a5c0000-0000-4000-9000-${String(++n).padStart(12, "0")}`, timestamp: ts, session_id: SESSION, cwd })
const handoff = "The flaky cache test reproduces 1 in 12 runs. Two calls before I change anything."
const QUESTIONS = [
  {
    question: "How should the build cache be invalidated?",
    header: "Cache key", kind: "question",
    options: [
      { label: "Key the cache on the lockfile hash", description: "It is what actually changes the output", recommended: true },
      { label: "Expire it on a timer", description: "Simpler, but rebuilds when nothing changed" },
    ],
  },
  {
    question: "Where should the fix land?",
    header: "Rollout", kind: "question",
    options: [
      { label: "On main directly", description: "The test is the only consumer", recommended: true },
      { label: "Behind a flag for a week first", description: "One more release before it is the default" },
    ],
  },
]
const records = [
  { ...base(at(0)), type: "user", message: { role: "user", content: "TASK:\nFix the flaky cache test." } },
  { ...base(at(5)), type: "assistant", message: { model: "claude-opus-5", id: "msg_ask", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: handoff }], usage: { input_tokens: 2, output_tokens: 120 } } },
]
writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const standIn = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
standIn.unref()
const brokerDir = join(sandbox.stateDir, "claude-broker")
mkdirSync(brokerDir, { recursive: true })
writeFileSync(join(brokerDir, `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.json`),
  JSON.stringify({ sessionId: SESSION, daemonPid: standIn.pid, socketPath: join(brokerDir, `${slug}.sock`) }))

execFileSync("sqlite3", ["-cmd", ".timeout 10000", sandbox.db, `DELETE FROM session WHERE slug = '${slug}';`])
execFileSync("sqlite3", ["-cmd", ".timeout 10000", sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
  VALUES (${vals}'${slug}', '${SESSION}', 'ntwine-${slug}', '${at(0)}', 'Fix the flaky cache test', 'claude', 'broker', 'opus', 'high', 'default', '${at(5)}')`])
// Asked AT the rest (the handoff's own timestamp), after the task: a question asked before the human's
// latest turn is one they already replied past, and the card draws only the ones still owed.
execFileSync("sqlite3", ["-cmd", ".timeout 10000", sandbox.db, `DELETE FROM thread_question WHERE thread_slug = '${slug}';`])
QUESTIONS.forEach((spec, i) => {
  const id = `qst_${createHash("sha256").update(`${slug}/${SESSION}/${i}`).digest("hex").slice(0, 8)}`
  const json = JSON.stringify(spec).replaceAll("'", "''")
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", sandbox.db, `INSERT INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
    VALUES ('${id}', '${sandbox.projectId}', '${slug}', '${json}', 'open', NULL, 0, ${T0 + 5 * 60_000 + i}, NULL)`])
})

console.log(JSON.stringify({ slug, standInPid: standIn.pid }))
