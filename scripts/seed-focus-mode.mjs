#!/usr/bin/env node
// Seed the rest of a BUSY project on top of seed-all-queues.mjs, so the project list's bands can be judged
// (and measured) with every band populated: the launcher gets a pinned thread, two snoozed ones, a third
// Working one, more Done, and two external terminal sessions; marketing-site gets a snoozed one. Run it
// AFTER seed-all-queues.mjs against the same stack.
//
// The same recipe as seed-all-queues.mjs: a session row plus a JSONL the REAL tailer reads. A pin is the
// row's `pinned_at`, a snooze its `snoozed_until`; an external session is a transcript in the project's
// directory with NO session row, which the tailer surfaces as a foreign thread (server/board.ts).
//
// Usage: node scripts/seed-focus-mode.mjs --stack=/abs/stack.log
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
if (!flags.stack) {
  console.error("usage: node scripts/seed-focus-mode.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const home = stack.home
const db = join(home, ".ntwine", "ui.db")
const WAIT_FOR_LOCK = ["-cmd", ".timeout 10000"]
const projects = [
  { id: stack.launcher.id, slug: stack.launcher.slug, dir: stack.launcher.dir },
  ...stack.tenants.map((t) => ({ id: t.id, slug: t.slug, dir: t.dir })),
]
const daemon = spawn("sleep", ["14400"], { detached: true, stdio: "ignore" })
daemon.unref()

const now = Date.now()
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`)
function sessionIdFor(projectSlug, slug) {
  const h = createHash("sha256").update(`fm/${projectSlug}/${slug}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function transcript(project, t, sessionId) {
  const dir = realpathSync(project.dir)
  const transcriptDir = join(home, ".claude", "projects", dir.replace(/[/.]/g, "-"))
  mkdirSync(transcriptDir, { recursive: true })
  const started = t.rest + 12
  const records = [
    { type: "user", sessionId, cwd: dir, timestamp: ago(started), message: { role: "user", content: [{ type: "text", text: t.prompt ?? t.title }] } },
    t.inFlight
      ? { type: "assistant", sessionId, cwd: dir, timestamp: ago(t.rest), message: { role: "assistant", id: `m-${t.slug}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `b-${t.slug}`, name: "Bash", input: { command: "pnpm test", description: t.gerund ?? "Running the test suite" } }] } }
      : { type: "assistant", sessionId, cwd: dir, timestamp: ago(t.rest), message: { role: "assistant", id: `m-${t.slug}`, stop_reason: "end_turn", content: [{ type: "text", text: t.closing ?? "Done." }], usage: { input_tokens: 2, output_tokens: 40 } } },
  ]
  if (t.external) records.unshift({ type: "ai-title", sessionId, aiTitle: t.title })
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
}

function seed(project, t) {
  const sessionId = sessionIdFor(project.slug, t.slug)
  transcript(project, t, sessionId)
  if (t.external) return console.log(`seeded ${project.slug}/${t.slug} (external)`)
  const live = !t.archived
  if (live) {
    const stateDir = join(home, ".ntwine", "projects", project.id)
    mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    writeFileSync(join(stateDir, "claude-broker", `${key}.json`), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${t.slug}.sock`) }))
  }
  execFileSync("sqlite3", [
    ...WAIT_FOR_LOCK,
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at, snoozed_until, pinned_at)
     VALUES (${q(project.id)}, ${q(t.slug)}, ${q(sessionId)}, ${q(`ntwine-${t.slug}`)}, ${q(ago(t.rest + 13))}, ${q(t.title)}, 0, 'claude', ${live ? "'broker'" : "NULL"}, 'opus', 'high', 'default', ${t.archived ? "'archived'" : "'open'"}, 0, 0, ${t.archived ? 1 : 0}, ${t.inFlight ? "NULL" : q(ago(t.rest))}, ${q(t.snoozedUntil ?? null)}, ${q(t.pinned ? ago(t.rest + 5) : null)})`,
  ])
  console.log(`seeded ${project.slug}/${t.slug}`)
}

const later = (hours) => new Date(now + hours * 3_600_000).toISOString()
const SCRIPTS = {
  "acme-api": [
    { slug: "api-style-guide", title: "Keep the API style guide current", rest: 90, pinned: true, closing: "The guide is current as of this morning's merges." },
    { slug: "audit-log-retention", title: "Decide the audit log retention window", rest: 40, snoozedUntil: later(20), closing: "Parked until legal replies." },
    { slug: "sdk-typegen", title: "Regenerate the SDK types after the schema lands", rest: 70, snoozedUntil: later(3), closing: "Waiting on the schema PR." },
    { slug: "idempotency-keys", title: "Accept idempotency keys on POST", rest: 1, inFlight: true, gerund: "Writing the replay store" },
    { slug: "cors-preflight", title: "Cache CORS preflight responses", rest: 900, archived: true },
    { slug: "health-endpoint", title: "Add a deep health endpoint", rest: 1300, archived: true },
    { slug: "tenant-quota", title: "Enforce per-tenant request quotas", rest: 2000, archived: true },
    { slug: "terminal-migrations", title: "Check the migration order by hand", rest: 25, external: true },
    { slug: "terminal-bench", title: "Benchmark the JSON encoder", rest: 200, external: true },
  ],
  "marketing-site": [
    { slug: "a11y-audit", title: "Run the accessibility audit on the new nav", rest: 30, snoozedUntil: later(6), closing: "Parked until the nav ships." },
  ],
}
for (const project of projects) for (const thread of SCRIPTS[project.slug] ?? []) seed(project, thread)
console.log(JSON.stringify({ seeded: Object.keys(SCRIPTS), daemonPid: daemon.pid }))
