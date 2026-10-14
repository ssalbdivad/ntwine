// Unowned broker daemons — the ones a booting ntwine finds running under a project's state dir and does
// NOT adopt.
//
// A broker daemon is forked detached into its own process group, so it outlives the server on purpose:
// a restart rejoins it (`warmUp` binds every daemon whose session is an open broker row) and a running
// turn never notices. The cost of that design is that a daemon NO row claims is rejoined by nobody. The
// hibernation sweep skips it (it has no row to reason about), the orphan reaper never touches a session
// root, and the daemon's own six-hour idle timer is the only thing left to end it.
//
// Found on the maintainer's machine 2026-10-08: the supervisor force-stopped a wedged server one minute
// after it forked a dispatch's daemon. Dispatch writes the thread's row only once `spawnDispatch`
// resolves, so the row never landed; the human re-sent the prompt, which minted a new session under the
// SAME slug, and the first daemon sat there with its `claude` (~155 MB) and ntwine MCP server (~50 MB),
// unattached and unreferenced, with no transcript — it never received its prompt. Nothing logged it.
//
// So every boot now LISTS each unowned daemon in the server log — session id, pid, why no row claims it,
// age and last activity — and the same pass repeats on the hibernation sweep's cadence, logging only a
// daemon it has not listed before or whose verdict changed. It ENDS exactly one class: a daemon no row
// references AT ALL and that has never written a transcript. That one provably holds no conversation
// (Claude Code writes the transcript with the first message), no thread can ever reach it (no row means
// no board surface, no follow-up, no approval card), and so ending it loses nothing. Every other class
// is listed and left alone, because each can be a turn still running:
//   - `archived`: a thread archived while its worker ran keeps that worker until it rests (the Running
//     band documents it), and a daemon in the middle of a turn is never interrupted.
//   - `not-adopted`: a row names the session but is not an open broker row under that id (another
//     runtime, or the id is only its transcript's); a confused reading is not a licence to kill.
//   - `no-row` WITH a transcript: a hard-deleted or replaced thread's daemon. It may be mid-tool-call,
//     editing files; its own idle timer collects it once it stops.
// The pass is periodic, not boot-only, because of the age guard: a supervisor restarts a dead server in
// seconds, so the daemon that motivated this was 74s old when the next boot looked at it. It fails
// CLOSED like the hibernator and the orphan reaper: an enumeration that throws ends nothing, a transcript
// probe that cannot answer counts as a transcript, and a daemon under ten minutes old is left for
// whatever dispatch may still be about to write its row (the row lands once the daemon has taken the
// prompt, and a prompt it took is a transcript on disk within seconds).
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { formatElapsed } from "@ntwine/shared"
import type { BrokerRecord } from "./backend/claude-agent-broker.ts"
import { isBrokerClaudeRow, type SessionRow } from "./storage.ts"

/** Younger than this, a row-less daemon may be a dispatch whose row is a moment from landing. */
export const UNOWNED_MIN_AGE_MS = 10 * 60_000

export type UnownedReason = "no-row" | "archived" | "not-adopted"

/** What the transcript probe saw. `unknown` is a probe that could not answer, and it never permits an end. */
export type TranscriptReading = { kind: "absent" } | { kind: "present"; mtimeMs: number } | { kind: "unknown" }

export interface UnownedBroker {
  sessionId: string
  daemonPid: number
  reason: UnownedReason
  /** The slug of the row that references the session, when one does. */
  slug?: string
  ageMs: number
  /** Newest of the transcript's mtime and the daemon's birth; NaN when neither reads. */
  lastActivityMs: number
  /** Whether this boot ends it, and if not, why not. */
  verdict: { end: true } | { end: false; keptBecause: "row-references-it" | "has-a-transcript" | "transcript-unreadable" | "too-young" | "unknown-age" | "end-failed" }
}

/** Does this row claim the session under any of the ids a row can carry it by? */
function references(row: Pick<SessionRow, "session_id" | "transcript_id" | "agent_session_id">, sessionId: string): boolean {
  return row.session_id === sessionId || row.transcript_id === sessionId || row.agent_session_id === sessionId
}

/** Exactly the set `warmUp` binds (context.ts `ownedSessions`): an open, unarchived broker row. */
function adopts(row: SessionRow): boolean {
  return isBrokerClaudeRow(row) && row.state !== "archived" && row.archived !== 1
}

/** Classify every live daemon this boot will not adopt. Pure: every reading is passed in. */
export function classifyUnownedBrokers(input: {
  daemons: readonly Pick<BrokerRecord, "sessionId" | "daemonPid" | "createdAt">[]
  rows: readonly SessionRow[]
  transcript: (sessionId: string) => TranscriptReading
  nowMs: number
  minAgeMs?: number
}): UnownedBroker[] {
  const minAge = input.minAgeMs ?? UNOWNED_MIN_AGE_MS
  const out: UnownedBroker[] = []
  for (const daemon of input.daemons) {
    const claiming = input.rows.filter((row) => references(row, daemon.sessionId))
    if (claiming.some((row) => row.session_id === daemon.sessionId && adopts(row))) continue
    const born = Date.parse(daemon.createdAt)
    const ageMs = Number.isFinite(born) ? input.nowMs - born : Number.NaN
    let transcript: TranscriptReading
    try { transcript = input.transcript(daemon.sessionId) } catch { transcript = { kind: "unknown" } }
    const readings = [born, transcript.kind === "present" ? transcript.mtimeMs : Number.NaN].filter(Number.isFinite)
    const lastActivityMs = readings.length ? Math.max(...readings) : Number.NaN
    const row = claiming[0]
    const reason: UnownedReason = !row ? "no-row"
      : claiming.some((r) => r.state === "archived" || r.archived === 1) ? "archived"
      : "not-adopted"
    const verdict: UnownedBroker["verdict"] = row ? { end: false, keptBecause: "row-references-it" }
      : transcript.kind === "present" ? { end: false, keptBecause: "has-a-transcript" }
      : transcript.kind === "unknown" ? { end: false, keptBecause: "transcript-unreadable" }
      : Number.isNaN(ageMs) ? { end: false, keptBecause: "unknown-age" }
      : ageMs < minAge ? { end: false, keptBecause: "too-young" }
      : { end: true }
    out.push({ sessionId: daemon.sessionId, daemonPid: daemon.daemonPid, reason, ...(row ? { slug: row.slug } : {}), ageMs, lastActivityMs, verdict })
  }
  return out
}

/** Probe every Claude Code transcript bucket for `<sessionId>.jsonl`. A daemon runs in its project's
 *  work dir, but a thread born before a rename lives in its original cwd's bucket (discover.ts), so the
 *  probe looks in all of them. Unlike `discoverTranscriptDir` it fails CLOSED: a listing that throws is
 *  `unknown`, never `absent`, and an EMPTY file still counts as present. */
export function probeClaudeTranscript(sessionId: string, root = join(homedir(), ".claude", "projects")): TranscriptReading {
  if (!existsSync(root)) return { kind: "absent" }
  let buckets: string[]
  try { buckets = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return { kind: "unknown" } }
  let newest: number | undefined
  for (const bucket of buckets) {
    const path = join(root, bucket, `${sessionId}.jsonl`)
    try {
      const st = statSync(path)
      newest = Math.max(newest ?? 0, st.mtimeMs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unknown" }
    }
  }
  return newest === undefined ? { kind: "absent" } : { kind: "present", mtimeMs: newest }
}

export function describeUnownedBroker(entry: UnownedBroker, nowMs: number): string {
  const who = entry.slug ? `${entry.sessionId} (${entry.slug})` : entry.sessionId
  const why = entry.reason === "no-row" ? "no thread claims it"
    : entry.reason === "archived" ? "its thread is done"
    : "its thread is not an open broker thread under this id"
  const last = Number.isFinite(entry.lastActivityMs) ? `last activity ${formatElapsed(nowMs - entry.lastActivityMs)} ago` : "last activity unknown"
  const fate = entry.verdict.end ? "ended: it never received a prompt"
    : `kept: ${entry.verdict.keptBecause}`
  return `unowned broker daemon ${who}, pid ${entry.daemonPid}: ${why}; up ${formatElapsed(entry.ageMs)}, ${last}; ${fate}`
}

export interface UnownedAuditDeps {
  liveDaemons: () => readonly Pick<BrokerRecord, "sessionId" | "daemonPid" | "createdAt">[]
  rows: () => readonly SessionRow[]
  transcript?: (sessionId: string) => TranscriptReading
  /** End the daemon. Returns whether a live one was actually ended. */
  end: (sessionId: string) => boolean
  log: (msg: string) => void
  now?: () => number
  minAgeMs?: number
}

function verdictKey(entry: UnownedBroker): string {
  return entry.verdict.end ? "ended" : `${entry.reason}:${entry.verdict.keptBecause}`
}

/** One pass: classify, end the never-prompted, and log every daemon `listed` has not seen with this
 *  verdict (pass a fresh map to log them all). Never throws. */
export function auditUnownedBrokersOnce(deps: UnownedAuditDeps, listed: Map<string, string> = new Map()): UnownedBroker[] {
  let entries: UnownedBroker[]
  const nowMs = deps.now?.() ?? Date.now()
  try {
    entries = classifyUnownedBrokers({
      daemons: deps.liveDaemons(),
      rows: deps.rows(),
      transcript: deps.transcript ?? ((id) => probeClaudeTranscript(id)),
      nowMs,
      minAgeMs: deps.minAgeMs,
    })
  } catch {
    return [] // cannot see the daemons or the board ⇒ touch nothing
  }
  const live = new Set(entries.map((e) => e.sessionId))
  for (const id of [...listed.keys()]) if (!live.has(id)) listed.delete(id)
  for (const entry of entries) {
    if (entry.verdict.end) {
      let ended = false
      try { ended = deps.end(entry.sessionId) } catch {}
      if (!ended) entry.verdict = { end: false, keptBecause: "end-failed" }
    }
    const key = verdictKey(entry)
    if (listed.get(entry.sessionId) === key) continue
    if (entry.verdict.end) listed.delete(entry.sessionId)
    else listed.set(entry.sessionId, key)
    try { deps.log(describeUnownedBroker(entry, nowMs)) } catch {}
  }
  return entries
}

/** Run a pass now (the boot listing) and then every `intervalMs`. Returns a stop handle; the timer is
 *  unref'd, so housekeeping never holds the event loop open. */
export function startUnownedBrokerAudit(deps: UnownedAuditDeps & { intervalMs: number }): () => void {
  const listed = new Map<string, string>()
  auditUnownedBrokersOnce(deps, listed)
  const timer = setInterval(() => {
    try { auditUnownedBrokersOnce(deps, listed) } catch { /* never escape the timer */ }
  }, deps.intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
