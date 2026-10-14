// A detached daemon (acp-daemon.ts, codex-app-server-daemon.ts) multiplexes its own CONTROL lines — the
// hello, stderr, `adopt` — into the agent's JSON-RPC stream under one reserved top-level key. Everything
// without it is the agent's and passes through untouched.
export const DAEMON_CONTROL_KEY = "ntwine"

/** Whether a line from a daemon is its own control line rather than the agent's. */
export function isDaemonControlLine(trimmedLine: string): boolean {
  return trimmedLine.startsWith(`{"${DAEMON_CONTROL_KEY}":`)
}
