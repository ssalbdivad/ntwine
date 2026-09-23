import type { CommandThreadState, ThreadView } from "@frizz/shared"

// TERMINAL COMMAND THREADS — commands the human ran from the prompt box's Terminal tab. They share the
// board's bands with agent threads (groups.ts sectionOf): running → Running, finished → the queue with
// a card of their own, marked done → Done. What sets them apart is the row (mono text, a terminal mark).

// How a run stands, in the rail and the drawer header alike.
export function commandStateLabel(command: CommandThreadState): string {
  if (command.state === "running") return "running"
  if (command.stopped) return "stopped"
  // No code means the server went away under the process (a Frizz restart takes its children with it).
  if (command.exitCode === undefined) return "interrupted"
  return command.exitCode === 0 ? "finished" : `exit ${command.exitCode}`
}

// Colour a run red only when it failed on its own. 130 and 143 are a shell's report of SIGINT and
// SIGTERM — Ctrl-C typed into the terminal, or a kill from outside — which is the human stopping it.
export function commandFailed(command: CommandThreadState): boolean {
  if (command.state !== "exited" || command.stopped || command.exitCode === undefined) return false
  return command.exitCode !== 0 && command.exitCode !== 130 && command.exitCode !== 143
}
