// Ending a detached daemon AND everything under it, on both platforms.
//
// ntwine's two daemon families — the Claude session broker (claude-broker-host.ts) and the Codex
// app-server daemon (codex-app-server-host.ts) — are forked `detached` into their own process group,
// and each runs the provider CLI as a CHILD: `claude` under the broker, `codex app-server` under the
// daemon. An explicit teardown has to end the child too, or a "stopped" worker keeps editing files
// and spending quota until its own turn ends.
//
// On POSIX that is one signal and nothing more: both daemons install SIGTERM/SIGINT/SIGHUP handlers
// that kill their child, write the exit breadcrumb and exit, and the Claude Agent SDK's own
// `process.on("exit")` cleanup ends `claude` behind the broker.
//
// Windows has no deliverable signals. `process.kill(pid, "SIGTERM")` there is a straight
// TerminateProcess, so the handler NEVER runs, neither daemon's breadcrumb is written, and the child
// — `codex app-server` at ~150 MB, or `claude.exe` mid-turn with tools still executing — is orphaned
// with nobody left who could ever collect it: the daemon was forked `detached`, so it is in no job
// object of ours, and the orphan reaper both keys on NTWINE_THREAD (which a per-PROJECT daemon does
// not carry) and explicitly PROTECTS any process named `claude` or `codex`. There are no process
// groups to kill either — `process.kill(-pid, …)` is rejected outright with EINVAL. `taskkill /T`
// instead walks the live parent/child snapshot, so it reaches exactly the child the signal handler
// would have killed; `/F` because without it `/T` only sends the polite WM_CLOSE, which a console
// process with no window ignores. `taskkill.exe` is a real executable on PATH, so the CVE-2024-27980
// ban on spawning `.bat`/`.cmd` without a shell does not apply and no shell — hence no interpolation
// of the pid — is involved.
//
// The cost on win32 is the breadcrumb: a force-killed daemon cannot write its `.exit` file, so an
// explicit teardown there is attributed only by the record's disappearance. It never gated anything.
//
// Written for the Codex daemon in f76da134 and lifted here 2026-09-11 when the Windows audit (finding
// 5) found the Claude side still signalling the daemon alone — `claude.exe` observed only the EOF on
// its stdin pipe once the OS closed the dead daemon's handles, and Claude Code finishes the current
// turn before it exits on EOF.
import { spawnSync } from "node:child_process"

export interface EndDaemonTreeDeps {
  platform?: NodeJS.Platform
  /** `process.kill` — the POSIX path, and the win32 fallback when taskkill is absent or refuses. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** `spawnSync` — how taskkill is run on win32. */
  spawnSync?: (file: string, args: string[], options: { stdio: "ignore"; windowsHide: true }) => { error?: Error; status: number | null }
}

const defaultKill = (pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal) }

/** End a daemon and the provider process underneath it (see the header). Never throws. */
export function endDaemonTree(pid: number, signal: NodeJS.Signals, deps: EndDaemonTreeDeps = {}): void {
  const kill = deps.kill ?? defaultKill
  if ((deps.platform ?? process.platform) !== "win32") {
    try { kill(pid, signal) } catch {}
    return
  }
  const killed = (deps.spawnSync ?? spawnSync)("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  // taskkill absent (a stripped PATH) or refusing: still end the daemon itself. An orphaned provider
  // process is bad; a live daemon still holding the named pipe — serving a stale handshake to every
  // connect, or a session the board believes is gone — is the wedge this whole stop path exists to
  // break.
  if (killed.error || killed.status !== 0) { try { kill(pid, signal) } catch {} }
}
