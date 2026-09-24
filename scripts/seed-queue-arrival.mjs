// Seed a disposable adhoc stack with the shape that made the queue behave like a STACK (maintainer
// 2026-09-24: "when a new thread is ready, it moves to the top of the *stack* which can be jarring if
// you're reading/typing input on another thread"): a thread that came to rest LONG AGO but enters the
// queue only NOW, because something held it out in between. The hold here is the human's own snooze —
// the one hold with no wake behind it, so the thread stays queued once it lands and the order can be
// read at leisure. Every other hold (CI, a sub-agent, a park) enters the queue the same way.
//
//   rested-first   — rested 30m ago, queued since
//   rested-second  — rested 20m ago, queued since
//   snoozed-oldest — rested 60m ago, snoozed until ~45s after this script runs
//
// Keyed on rest time, `snoozed-oldest` lands ABOVE both the moment its snooze ends. Keyed on when it
// entered the queue (queue-clock.ts), it joins the bottom. scripts/verify-queue-arrival.mjs checks which.
//
// Simulated BROKER rows (claude_runtime='broker'), so board.deriveRuntime reads the tailer's turn state —
// the same reason seed-resting-thread.mjs gives. A plain rest has no background work, so no stand-in
// daemon is needed.
//
// Usage: node scripts/seed-queue-arrival.mjs --home=/abs/temp-home [--cwd=/abs/project] [--snooze-s=45]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
const snoozeS = Number(flags["snooze-s"] ?? 45)
if (!home) {
  console.error("usage: node scripts/seed-queue-arrival.mjs --home=/abs/temp-home [--cwd=/abs/project] [--snooze-s=45]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const now = Date.now()
const ago = (m) => new Date(now - m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

function seed({ slug, sessionId, title, restedMinutesAgo, snoozedUntil = null }) {
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ago(restedMinutesAgo + 5), session_id: sessionId, cwd,
      message: { role: "user", content: `TASK:\n${title}` },
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ago(restedMinutesAgo), session_id: sessionId, cwd,
      message: {
        model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: `${title} — done, over to you.` }], usage: { input_tokens: 2, output_tokens: 20 },
      },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at, snoozed_until)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${ago(restedMinutesAgo + 5)}', '${title}', 'claude', 'broker', 'opus', 'high', 'default', '${ago(restedMinutesAgo)}', ${snoozedUntil ? `'${snoozedUntil}'` : "NULL"})`,
  ])
  console.log(`seeded ${slug} → rested ${restedMinutesAgo}m ago${snoozedUntil ? `, snoozed until ${snoozedUntil}` : ""}`)
}

seed({ slug: "rested-first", sessionId: "9a3e0000-0000-4000-9000-00000000000a", title: "Fix the flaky login test", restedMinutesAgo: 30 })
seed({ slug: "rested-second", sessionId: "9a3e0000-0000-4000-9000-00000000000b", title: "Tidy the settings drawer", restedMinutesAgo: 20 })
seed({
  slug: "snoozed-oldest",
  sessionId: "9a3e0000-0000-4000-9000-00000000000c",
  title: "Bump the release pin",
  restedMinutesAgo: 60,
  snoozedUntil: new Date(now + snoozeS * 1000).toISOString(),
})
