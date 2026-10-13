// A detached daemon (acp-daemon.ts, codex-app-server-daemon.ts) multiplexes its own CONTROL lines — the
// hello, stderr, `adopt` — into the agent's JSON-RPC stream under one reserved top-level key. Everything
// without it is the agent's and passes through untouched.
export const DAEMON_CONTROL_KEY = "ntwine"

/**
 * LEGACY: the key every daemon spawned before the commit that introduced this file still writes, and the
 * only one such a daemon reads. Daemons outlive a server restart, so a current host must still recognise
 * an older daemon's hello and answer it in its own key.
 *
 * REMOVE once no ACP or Codex daemon started before that commit is alive
 * (`ps -o lstart= -p $(pgrep -f 'acp-daemon|codex-app-server-daemon')`).
 */
export const LEGACY_DAEMON_CONTROL_KEY = "frizz"

export type DaemonControlKey = typeof DAEMON_CONTROL_KEY | typeof LEGACY_DAEMON_CONTROL_KEY

/** The control key a line from a daemon opens with, or undefined for an agent's own line. */
export function daemonControlKey(trimmedLine: string): DaemonControlKey | undefined {
  for (const key of [DAEMON_CONTROL_KEY, LEGACY_DAEMON_CONTROL_KEY] as const) {
    if (trimmedLine.startsWith(`{"${key}":`)) return key
  }
  return undefined
}
