// READ-ONLY PROBE: replay REAL session transcripts through the REAL tailer fold and check that the
// dropped-report detector agrees, report for report, with an INDEPENDENT audit of the same file.
//   nub packages/server/src/_probe_report_replay.mts <session.jsonl> [more.jsonl …]
//
// This is the differential for the "sub-agent reports never reach the orchestrator" fix. The synthetic
// live repro could not be made to drop on demand (see _live_notify_delivery.mts), but the operator's
// own corpus already contains hundreds of real examples, so the corpus IS the test bed.
//
// TWO INDEPENDENT CLASSIFIERS, compared:
//   • AUDIT — this file, deliberately naive: scan every raw line, collect which task-ids appear in a
//     `user`/`attachment` record versus only in `queue-operation` records. It shares NO code with the
//     tailer, so agreement is real corroboration rather than a tautology.
//   • FOLD — the shipping tailer, driven exactly as the server drives it, reporting `droppedReports`.
//
// A false POSITIVE here is the expensive failure: it would make ntwine tell an agent that a report it
// actually read was lost. So the probe reports both directions separately and treats any false
// positive as fatal.
import { readFileSync, existsSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTailer } from "./tailer.ts"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import { cwdSlug, type Project } from "./project.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { MAX_TRACKED_REPORTS } from "./completion-relay.ts"
import type { AgentBackend } from "./backend/types.ts"

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("usage: _probe_report_replay.mts <session.jsonl> [more.jsonl …]")
  process.exit(2)
}

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const taskIds = (s: string): string[] =>
  [...s.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map((m) => m[1].trim()).filter((id) => id && !id.startsWith("__orphan_summary__"))

/** The naive, tailer-independent audit of one transcript. */
function audit(path: string): { queued: Map<string, number>; delivered: Set<string> } {
  const queued = new Map<string, number>()
  const delivered = new Set<string>()
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split("\n")) {
    if (!line.trim() || !line.includes("<task-notification>")) continue
    let r: Record<string, unknown>
    try { r = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const type = r.type
    // Only COMPLETED reports are in scope: a failed/killed notification is a status line with no
    // findings to lose, and the fix deliberately does not repair those.
    const carrier =
      type === "queue-operation" ? (typeof r.content === "string" ? r.content : "")
      : type === "user" ? (() => { const c = (r.message as { content?: unknown } | undefined)?.content; return typeof c === "string" ? c : JSON.stringify(c ?? "") })()
      : type === "attachment" ? JSON.stringify(r.attachment ?? "")
      : ""
    if (!carrier.includes("<task-notification>")) continue
    for (const block of carrier.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
      if (!/<status>completed<\/status>/.test(block)) {
        for (const id of taskIds(block)) { queued.delete(id); delivered.delete(id) }
        continue
      }
      const chars = block.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.length ?? 0
      // Scoped to AGENT reports the same way the fix is (a shell's exit line is not a lost report),
      // but spelled out inline rather than imported, so this stays an INDEPENDENT classifier.
      const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
      // Scoped to AGENT *and* SHELL notifications now — a lost shell wake strands a rested agent
      // just as surely as a lost report loses findings. Spelled out inline, sharing no code with the
      // tailer, so agreement stays real corroboration.
      const agentReport = summary
        ? (summary.startsWith('Agent "') || summary.startsWith("Background command") || summary.startsWith("Monitor"))
        : true
      for (const id of taskIds(block)) {
        if (type === "user" || type === "attachment") delivered.add(id)
        else if (agentReport && !queued.has(id)) queued.set(id, chars)
      }
    }
  }
  for (const id of delivered) queued.delete(id)
  return { queued, delivered }
}

/** Drive the SHIPPING tailer over one transcript, exactly as the server does. */
function fold(path: string): Set<string> {
  const stateDir = mkdtempSync(join(tmpdir(), "rreplay-"))
  try {
    const project: Project = { dir: stateDir, id: "replay", name: "replay", label: "o/replay", stateDir, cwdSlug: cwdSlug(stateDir) }
    const storage = createStorage(join(stateDir, "ui.db"), "p")
    // The BACKEND's logDir matters as much as the tailer's: `transcriptPath()` resolves the pinned
    // stem through it (tailer.ts ~3397). Pointed at the scratch dir it silently resolves to a file
    // that does not exist, the fold reads nothing, and every report reads as delivered.
    const backend = createClaudeBackend({ claudeBin: "claude", logDir: path.slice(0, path.lastIndexOf("/")) })
    const slug = "replay"
    const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "")
    storage.upsertSession({
      slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(), // NOT epoch: an ancient stamp trips the tailer boot-failure bail and the fold never reads a byte
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    })
    storage.setBackend(slug, "claude")
    storage.setClaudeRuntime(slug, "broker")
    // Pin the transcript explicitly. Without it the tailer runs its DISCOVERY path, which scans the
    // log dir for a fresh unregistered stem and — against a months-old corpus file in a scratch
    // project — finds nothing and reports `noTranscript`, so the fold never reads a byte and every
    // report reads as "not dropped". A silent 0, which is exactly the shape of a false PASS.
    storage.setTranscriptId(slug, sessionId)
    const tailer = createTailer({
      project, storage, bus: new Bus(), backendFor: (): AgentBackend => backend,
      onChange: () => {}, paneDead: () => false,
      // Point the fold straight at the real file rather than at a discovered one.
      sessionLogDir: path.slice(0, path.lastIndexOf("/")),
    })
    tailer.tick()
    tailer.tick()
    const tele = tailer.get(slug)
    const out = new Set((tele?.droppedReports ?? []).map((r) => r.taskId))
    tailer.stop()
    storage.close()
    return out
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

for (const path of files) {
  const name = path.split("/").pop()
  console.log(`\n══ ${name} ══`)
  if (!existsSync(path)) { ok(`${name} exists`, false); continue }
  const a = audit(path)
  const f = fold(path)
  // The fold bounds its tracking map at MAX_TRACKED_REPORTS, so replaying DAYS of history in one shot
  // legitimately evicts the oldest. Production never sees that — the repair pass drains the map every
  // tick — so the honest assertion is over the NEWEST window, with the eviction stated rather than
  // silently absorbed. (Insertion order in `a.queued` is enqueue order, so the tail is the newest.)
  const allDropped = [...a.queued.keys()]
  const evicted = Math.max(0, allDropped.length - MAX_TRACKED_REPORTS)
  const auditDropped = new Set(allDropped.slice(-MAX_TRACKED_REPORTS))
  // A FALSE POSITIVE is judged against the FULL audit set, never the window: the fold and the audit
  // evict on slightly different orders, so an id just outside one window is a windowing artifact, not
  // ntwine telling an agent it lost a report it read. The real error — flagging something the audit
  // never saw dropped at all — is exactly what this catches.
  const everDropped = new Set(allDropped)
  const falsePos = [...f].filter((id) => !everDropped.has(id))
  const falseNeg = [...auditDropped].filter((id) => !f.has(id))
  const withinWindow = falseNeg.length <= Math.ceil(MAX_TRACKED_REPORTS * 0.05) // window-edge slack
  console.log(`  completed reports delivered : ${a.delivered.size}`)
  console.log(`  completed reports DROPPED   : ${auditDropped.size}   (independent audit)`)
  console.log(`  tailer flagged              : ${f.size}`)
  if (evicted) console.log(`  aged out of the ${MAX_TRACKED_REPORTS}-entry window : ${evicted} (replay-only; the live pass drains this map every tick)`)
  if (auditDropped.size) {
    const sizes = [...a.queued.values()].sort((x, y) => x - y)
    console.log(`  dropped payload sizes       : ${sizes[0]}–${sizes[sizes.length - 1]} chars`)
  }
  ok(`${name}: NO false positives (never tell an agent it lost a report it read)`, falsePos.length === 0,
    falsePos.length ? `${falsePos.length}: ${falsePos.slice(0, 5).join(", ")}` : "")
  ok(`${name}: detects the audited drops (window-edge slack allowed)`, withinWindow,
    falseNeg.length ? `${falseNeg.length}: ${falseNeg.slice(0, 5).join(", ")}` : "")
  ok(`${name}: the audit itself found drops to detect (probe is not vacuous)`, auditDropped.size > 0,
    `${auditDropped.size} dropped`)
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
