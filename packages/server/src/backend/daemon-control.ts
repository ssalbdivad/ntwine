// A detached daemon (acp-daemon.ts, codex-app-server-daemon.ts) multiplexes its own CONTROL lines — the
// hello, stderr, `adopt` — into the agent's JSON-RPC stream under one reserved top-level key. Everything
// without it is the agent's and passes through untouched.
import { LEGACY_DAEMON_CONTROL_KEY } from "../legacy-frizz.ts"

export const DAEMON_CONTROL_KEY = "ntwine"

export type DaemonControlKey = typeof DAEMON_CONTROL_KEY | typeof LEGACY_DAEMON_CONTROL_KEY

/** The control key a line from a daemon opens with, or undefined for an agent's own line. */
export function daemonControlKey(trimmedLine: string): DaemonControlKey | undefined {
  for (const key of [DAEMON_CONTROL_KEY, LEGACY_DAEMON_CONTROL_KEY] as const) {
    if (trimmedLine.startsWith(`{"${key}":`)) return key
  }
  return undefined
}
