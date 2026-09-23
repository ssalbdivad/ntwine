import type { CommandThreadState, ThreadView } from "@frizz/shared"

// TERMINAL COMMAND THREADS on the rail — commands the human ran from the prompt box's Terminal tab.
// They are NOT part of the four Frizz bands: no agent, no queue card, no snooze, no Done. `sectionOf`
// already drops them (it keeps only `kind === "session"`), and they get a band of their own, the same
// way External sessions do.
export function commandThreads(threads: readonly ThreadView[]): ThreadView[] {
  return threads
    .filter((t) => t.kind === "command" && t.command !== undefined)
    // Newest run first: the command you just started is the one you are looking for.
    .sort((a, b) => (b.command!.startedAt).localeCompare(a.command!.startedAt) || a.id.localeCompare(b.id))
}

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
