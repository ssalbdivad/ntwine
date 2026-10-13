// A durable, append-only record of one Claude broker daemon's lifecycle, written BY THE DAEMON.
//
// The Claude twin of codex-app-server-diagnostics.ts, and it exists for the same reason that file
// gives: the one time death forensics were needed, the bridge's diagnostics were wired to nothing and
// a daemon death was an opaque "the thread went quiet."
//
// The broker had that gap twice over. `onDiagnostic` is plumbed all the way through
// claude-broker-client.ts, but the bridge never supplied a handler — so `{kind:"lifecycle",
// phase:"crashed", message}`, the single most useful line there is, went nowhere. And the daemon only
// wrote diagnostics to an ATTACHED client (`if (client) write(...)`, unlike events, which are
// backlogged), so a crash during an ntwine restart — exactly when a detached daemon is most likely to
// die unobserved — was guaranteed lost.
//
// So the DAEMON owns this file, not ntwine. A death is precisely when the process may be seconds from
// gone: an in-memory backlog dies with it and a relay needs a listener that a restarting ntwine does not
// have. Writing from inside the daemon is the only version that survives the event it is recording.
//
// Deliberately synchronous and best-effort — a logging failure must never perturb the session.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX, type ClaudeDiagnostic } from "./claude-agent-sdk-protocol.ts"

// Rotate at 4 MB and keep exactly one previous file — forensics want recent history, not an archive.
const MAX_BYTES = 4 * 1024 * 1024

export function claudeBrokerDiagnosticLogPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "claude-broker", `${sessionId}.diagnostics.log`)
}

export interface ClaudeBrokerDiagnosticRecord {
  at: string
  daemonPid: number
  generation: string
  diagnostic: ClaudeDiagnostic
}

/**
 * Why a broker daemon — and the claude process and every in-flight sub-agent inside it — ended.
 *
 * The codex daemon has carried this vocabulary since the 2026-07-24 six-sub-agent loss
 * (`app-server-exited-code-*`, `self-collected-*`, `signal-*`, `idle-timeout`); the broker's
 * `shutdown()` wrote nothing at all, so a daemon collected by its 6h idle timer, terminated by a
 * signal, or self-collected for unreachability all vanished identically and ntwine could only report the
 * generic "the thread went quiet". These are the named causes, one per exit path in
 * claude-agent-broker.ts:
 *
 *  - `ntwine-requested`               — RunningBroker.close(); ntwine asked for it.
 *  - `signal-SIG*`                  — SIGTERM/SIGINT/SIGHUP, i.e. killBroker or the operator/OS.
 *  - `session-stream-ended`         — the SDK's event stream ended normally (claude exited).
 *  - `session-stream-broken`        — EVENT_ERROR_TOLERANCE consecutive stream errors; genuinely broken.
 *  - `event-pump-failed`            — the pump itself threw outside the per-event guard.
 *  - `idle-timeout`                 — nobody attached for IDLE_EXIT_MS.
 *  - `self-collected-record-reassigned` — unattached and the record no longer names us (a successor
 *                                    stole it, or a sweep removed it): undiscoverable, so collected.
 *  - `self-collected-socket-lost`   — unattached and the socket PATH no longer leads to us (the file
 *                                    was deleted, or another daemon bound it): still recorded, but no
 *                                    client can ever connect again, so collected rather than left to
 *                                    squat on the record every later attach would adopt.
 *  - `socket-listen-failed`         — the listen() that makes this daemon reachable never succeeded.
 */
export type ClaudeBrokerExitReason =
  | "ntwine-requested"
  | "signal-SIGTERM"
  | "signal-SIGINT"
  | "signal-SIGHUP"
  | "session-stream-ended"
  | "session-stream-broken"
  | "event-pump-failed"
  | "idle-timeout"
  | "self-collected-record-reassigned"
  | "self-collected-socket-lost"
  | "socket-listen-failed"
  // The daemon threw where nothing was catching. Node's default for these is to print a stack and exit
  // — and the host spawns this daemon with stdio:"ignore", so that stack goes NOWHERE. Before these were
  // recorded, such a death was indistinguishable from a SIGKILL: both left the log ending on `started`.
  | "uncaught-exception"
  | "unhandled-rejection"

/** An exit breadcrumb, appended to the SAME log as the diagnostics so a death and the stderr that
 *  preceded it read as one story. It carries `exit` rather than `diagnostic`, which is exactly what
 *  keeps `readClaudeBrokerDiagnostics` (it requires `.diagnostic`) unchanged by this addition. */
export interface ClaudeBrokerExitRecord {
  at: string
  daemonPid: number
  generation: string
  exit: { reason: ClaudeBrokerExitReason; detail?: string }
}

/** Why NTWINE asked a daemon to end — written by the SERVER, into the daemon's log, before the signal.
 *
 *  The daemon cannot know who signalled it, so its own breadcrumb for every requested teardown is the
 *  same `signal-SIGTERM`. Across the whole 2026-09-23..10-01 corpus (292 daemon generations, 238
 *  sessions) that was the ONLY exit reason ever recorded — 277 of 277 — so a hibernation, a Stop, a Mark
 *  as done, a launch-flag retirement, a usage-limit fresh process and an operator's `kill` all read
 *  identically, and the one mark that did name a cause (`.retired`) is consumed by the resume it
 *  explains. On Windows it is worse: `taskkill /F` runs no handler, so a requested teardown there left no
 *  line at all. This record closes both: the signal's sender writes what it meant, with the daemon's
 *  generation, so a reader joins it to the `signal-SIGTERM` that follows. A `signal-SIGTERM` with NO
 *  preceding `terminate` for its generation is then genuinely external.
 *
 *  It carries `terminate`, not `diagnostic` or `exit`, so neither reader below changes. */
export type ClaudeBrokerTerminationCause =
  | "retire" | "fresh-process" | "hibernate"
  | "session-replaced" | "session-deleted" | "dispatch-replaced"
  // A boot found the daemon claimed by no row and holding no transcript (unowned-brokers.ts).
  | "unowned-never-prompted"
  | "unspecified"

export interface ClaudeBrokerTerminationRecord {
  at: string
  daemonPid: number
  generation: string
  terminate: { cause: ClaudeBrokerTerminationCause; requestedBy: number }
}

/** One synchronous, best-effort, rotating append. Every writer below funnels through here, so the
 *  "never throw, never perturb the session" guarantee is stated once. */
function appendRecord(path: string, record: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true })
    try { if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`) } catch { /* first write */ }
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {
    // best-effort: never let observability perturb the session it is observing
  }
}

/** Build the daemon's own diagnostic writer. Unlike the codex sink this keeps `stderr`: for Claude
 *  that carries the CLI's actual error text (already credential-redacted and capped at 4 KB by the
 *  protocol), which IS the forensics — not a byte-count ping. Rotation bounds the cost. */
export function createClaudeBrokerDiagnosticWriter(
  path: string,
  meta: { daemonPid: number; generation: string },
  now: () => Date = () => new Date(),
): (diagnostic: ClaudeDiagnostic) => void {
  return (diagnostic) => {
    const record: ClaudeBrokerDiagnosticRecord = { at: now().toISOString(), ...meta, diagnostic }
    appendRecord(path, record)
  }
}

/** Build the daemon's exit-breadcrumb writer.
 *
 *  Called from inside every terminal path in claude-agent-broker.ts, with the process seconds (or
 *  microseconds — a signal handler) from gone. Synchronous for that reason, and best-effort for the
 *  reason every informational path in this subsystem is: a logging failure must never be what takes a
 *  session down. It is deliberately callable more than once — a signal arriving mid-`shutdown()` should
 *  leave BOTH marks, and a reader takes the newest. */
export function createClaudeBrokerExitWriter(
  path: string,
  meta: { daemonPid: number; generation: string },
  now: () => Date = () => new Date(),
): (reason: ClaudeBrokerExitReason, detail?: string) => void {
  return (reason, detail) => {
    const record: ClaudeBrokerExitRecord = {
      at: now().toISOString(),
      ...meta,
      exit: detail ? { reason, detail } : { reason },
    }
    appendRecord(path, record)
  }
}

/** Record, from the server, that it is about to end this daemon and why. Best-effort like every
 *  writer here: a teardown never waits on, or fails because of, its own forensics. */
export function recordClaudeBrokerTermination(
  path: string,
  meta: { daemonPid: number; generation: string },
  cause: ClaudeBrokerTerminationCause,
  now: () => Date = () => new Date(),
): void {
  const record: ClaudeBrokerTerminationRecord = { at: now().toISOString(), ...meta, terminate: { cause, requestedBy: process.pid } }
  appendRecord(path, record)
}

/** The exit this session's log records for a NAMED daemon, or null when it recorded none for that one.
 *
 *  The log is per SESSION, not per daemon, so a resumed thread's file holds every death across every
 *  generation it has had. "The newest record" is therefore NOT the same question as "how did the daemon
 *  we just lost die" — they diverge exactly when the lost daemon wrote nothing (SIGKILL, OOM, a reboot),
 *  which is the case an operator is most likely to be investigating. Reading the newest anyway attributed
 *  the PREVIOUS generation's cause and timestamp to the current death: measured 2026-08-19, a 21:57:54
 *  SIGKILL reported as "exited (signal-SIGTERM) at 21:55:46" — a wrong answer, in the confident voice of
 *  a right one.
 *
 *  So `generation` is required, and a record that does not carry it is not an answer about this daemon.
 *  Null then means "this daemon left no breadcrumb", which describeClaudeBrokerExit says in as many words
 *  — the honest reading, and the one that sends nobody hunting a cause that belongs to a dead predecessor.
 *  Never gates anything: pure post-hoc attribution for what the bridge would otherwise report as "the
 *  thread went quiet."
 *
 *  An EMPTY generation means the caller could not identify the daemon it lost (an ntwine restart with no
 *  record left on disk). That is not a licence to guess: it returns null for the same reason. */
export function readClaudeBrokerExit(stateDir: string, sessionId: string, generation: string): ClaudeBrokerExitRecord | null {
  if (!generation) return null
  let newest: ClaudeBrokerExitRecord | null = null
  for (const path of [`${claudeBrokerDiagnosticLogPath(stateDir, sessionId)}.1`, claudeBrokerDiagnosticLogPath(stateDir, sessionId)]) {
    let text: string
    try { text = readFileSync(path, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Partial<ClaudeBrokerExitRecord>
        if (typeof parsed?.at !== "string" || typeof parsed.exit?.reason !== "string") continue
        if (parsed.generation !== generation) continue
        newest = {
          at: parsed.at,
          daemonPid: typeof parsed.daemonPid === "number" ? parsed.daemonPid : 0,
          generation: typeof parsed.generation === "string" ? parsed.generation : "",
          exit: parsed.exit as ClaudeBrokerExitRecord["exit"],
        }
      } catch { /* truncated tail of a killed writer */ }
    }
  }
  return newest
}

/** One operator-facing line for a recorded death. `unknown` is itself informative — it means the
 *  daemon died without reaching any of its own exit paths (SIGKILL, OOM, a machine reboot). */
export function describeClaudeBrokerExit(record: ClaudeBrokerExitRecord | null): string {
  if (!record) return "the broker daemon is gone and left no exit record (killed outright, or it predates exit breadcrumbs)"
  const detail = record.exit.detail ? `: ${record.exit.detail}` : ""
  return `the broker daemon exited (${record.exit.reason}${detail}) at ${record.at}`
}

/**
 * The one operator-facing line a relayed diagnostic is worth, or `undefined` for the ones that are not.
 *
 * Exactly two clear the bar, and the second was learned the hard way. A daemon DEATH has always been
 * here. A DROPPED INPUT joined it on 2026-08-05, after thread `are-taking-over-an-in-flight-epic`
 * refused every input for over two hours — 21 heartbeats and the operator's own messages alike — while
 * the server's handler discarded every diagnostic that was not a crash. The `input` frame carries no
 * reply by design (see claude-agent-broker-bridge.ts), so this relay is the ONLY way ntwine can learn
 * that a message it already recorded as `delivered` was in fact thrown away.
 *
 * The rest of `stderr` is ordinary provider noise, which is why this matches the daemon's own drop
 * prefix rather than widening to the kind. A line per drop is what turns that afternoon into one grep.
 */
/**
 * The DELIVERY id a drop diagnostic names, when it names one.
 *
 * This is what turns the drop from a log line into something ntwine can act on: the id is the ledger row
 * the operator's message is sitting in, so the server can mark exactly that row failed (text kept, with
 * Retry / Edit / Dismiss) instead of leaving it to `ageDeliveries`, which holds a queue entry for an hour
 * on the (here false) premise that an enqueue proves the provider is holding it.
 *
 * Returns undefined for a drop from a daemon too old to carry the id — those still log, still surface,
 * and still age out the slow way, which is the pre-existing behaviour rather than a regression.
 */
export function droppedDeliveryId(diagnostic: ClaudeDiagnostic): string | undefined {
  if (diagnostic.kind !== "stderr") return undefined
  if (!diagnostic.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX)) return undefined
  return diagnostic.message.match(/\bid=([0-9a-fA-F-]{36})\b/)?.[1]
}

/** Why the daemon dropped the input — the session's own refusal, after the prefix and the id ("Claude
 *  outstanding input limit exceeded", "input UUID is already outstanding"). Shown to the operator under
 *  the failed bubble, so it is the refusal alone, not the log line. Empty for anything but a drop. */
export function droppedDeliveryReason(diagnostic: ClaudeDiagnostic): string {
  if (diagnostic.kind !== "stderr" || !diagnostic.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX)) return ""
  return diagnostic.message.slice(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX.length).replace(/^:\s*/, "").replace(/^id=\S+\s*/, "").trim()
}

export function describeClaudeBrokerDiagnostic(diagnostic: ClaudeDiagnostic): string | undefined {
  if (diagnostic.kind === "stderr") {
    return diagnostic.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX) ? diagnostic.message : undefined
  }
  if (diagnostic.phase !== "crashed") return undefined
  return diagnostic.message ?? "died without a recorded cause"
}

/** Read back a session's diagnostics, newest last. Missing/garbage lines are skipped, never thrown —
 *  a truncated final line is the NORMAL shape of a log whose writer was killed mid-append. */
export function readClaudeBrokerDiagnostics(stateDir: string, sessionId: string): ClaudeBrokerDiagnosticRecord[] {
  const out: ClaudeBrokerDiagnosticRecord[] = []
  for (const path of [`${claudeBrokerDiagnosticLogPath(stateDir, sessionId)}.1`, claudeBrokerDiagnosticLogPath(stateDir, sessionId)]) {
    let text: string
    try { text = readFileSync(path, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ClaudeBrokerDiagnosticRecord
        if (parsed && typeof parsed.at === "string" && parsed.diagnostic) out.push(parsed)
      } catch { /* truncated tail of a killed writer */ }
    }
  }
  return out
}
