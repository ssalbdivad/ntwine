// Who a detached daemon's discovery record names — the PROCESS, not just its pid.
//
// ntwine's three daemon families (the Claude session broker, the Codex app-server daemon, the ACP daemon)
// each publish a record carrying `daemonPid`, and each host used to treat "that pid is alive" as "that
// daemon is alive". A pid is not an identity. A reboot kills every daemon without a breadcrumb and
// leaves its record on disk — 8 broker daemons died exactly that way in the 2026-09-23..10-01
// diagnostics corpus — and the next boot restarts the pid counter: the brokers alive on 2026-10-01 sat
// at pids 4555 and 4774, precisely what a fresh boot hands out in its first hour. A stale record whose
// pid a stranger now holds then reads as live, and every consumer acts on it: a reattach to a socket
// that no longer exists, a hibernation sweep that retires it, a Stop that SIGTERMs it — and the Codex
// host escalates to SIGKILL when the "daemon" ignores the TERM.
//
// So a daemon stamps its own birth marker (process-generation.ts) on its record, and a host disowns a
// record only on an EXACT mismatch or a dead pid. Everything weaker keeps the old pid-alive answer,
// because the two mistakes are not symmetric: a wrongly disowned LIVE daemon self-collects within a
// minute (its record no longer names it) and takes any in-flight turn with it.
import { processGenerationIsStale, processStartTime } from "../process-generation.ts"

/** This process's birth marker, for its own record — or undefined where it is not cheap to read.
 *
 *  Linux only, where it is one /proc read. Windows can produce an exact marker too, but only through a
 *  PowerShell spawn measured at 252-427ms, and the record is a daemon's READINESS signal: that cost
 *  would sit on every dispatch's critical path. macOS's `ps` marker is second-resolution and therefore
 *  "weak" — it may retain a record but must never authorize a signal — so it adds nothing here. */
export function daemonBirthMarker(): string | undefined {
  return process.platform === "linux" ? processStartTime(process.pid) : undefined
}

/** Does a record naming `pid` (stamped with `processStart`, if any) still name a live daemon? */
export function recordedDaemonIsLive(pid: number, processStart: unknown, pidAlive: (pid: number) => boolean): boolean {
  if (!pidAlive(pid)) return false
  // A record from a daemon that predates the marker, or a platform that does not stamp one.
  if (typeof processStart !== "string" || processStart === "") return true
  return !processGenerationIsStale({ pid, processStart })
}
