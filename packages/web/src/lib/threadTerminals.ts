import type { ThreadTerminal, ThreadView } from "@ntwine/shared"

// A THREAD'S TERMINALS — ptys the human opened on a thread, running in the folder its agent works in
// (server thread-terminals.ts). They are not threads: no row, no card of their own. They ride
// `ThreadView.terminals` and show inside their thread — the drawer's terminals strip, the card's, and a
// mark on the thread's row (ThreadTerminals.tsx). They replaced the prompt box's Terminal tab and its
// top-level command threads on 2026-09-29.

// How a run stands, on its strip row and its drawer's header alike.
export function terminalStateLabel(terminal: ThreadTerminal): string {
  // Alive, but silent at a prompt — a password, an OTP, a [y/N]. It queues its thread.
  if (terminal.state === "running" && terminal.awaitingInput) return "waiting for input"
  if (terminal.state === "running") return "running"
  if (terminal.stopped) return "stopped"
  // No code means the server went away under the process (an ntwine restart takes its children with it).
  if (terminal.exitCode === undefined) return "interrupted"
  return terminal.exitCode === 0 ? "finished" : `exit ${terminal.exitCode}`
}

// The live dot: a run that is actually moving. One sitting at a prompt is waiting on the human, so it
// wears the attention mark instead.
export function terminalLive(terminal: ThreadTerminal): boolean {
  return terminal.state === "running" && !terminal.awaitingInput
}

// Colour a run red only when it failed on its own. 130 and 143 are a shell's report of SIGINT and
// SIGTERM — Ctrl-C typed into the terminal, or a kill from outside — which is the human stopping it.
export function terminalFailed(terminal: ThreadTerminal): boolean {
  if (terminal.state !== "exited" || terminal.stopped || terminal.exitCode === undefined) return false
  return terminal.exitCode !== 0 && terminal.exitCode !== 130 && terminal.exitCode !== 143
}

/** What a terminal is called on its row: the line it runs, or — for an interactive shell — the shell. */
export function terminalLabel(terminal: ThreadTerminal): string {
  return terminal.command
}

/** The thread's terminals whose process is alive — what its row's mark counts. */
export function runningTerminals(thread: Pick<ThreadView, "terminals">): ThreadTerminal[] {
  return (thread.terminals ?? []).filter((terminal) => terminal.state === "running")
}

/** The terminal a thread is queued on, when one is waiting at a prompt. */
export function promptingTerminal(thread: Pick<ThreadView, "terminals">): ThreadTerminal | undefined {
  return thread.terminals?.find((terminal) => terminal.awaitingInput === true)
}

/** The thread's terminal with this id — the terminal drawer's lookup. */
export function terminalOf(thread: Pick<ThreadView, "terminals"> | undefined, id: string): ThreadTerminal | undefined {
  return thread?.terminals?.find((terminal) => terminal.id === id)
}

/**
 * The thread composer's `$` line (ThreadComposerBox): `$ npm test` opens a terminal on the thread running
 * that command, and a bare `$` opens an interactive shell. One line only, and the `$` must stand alone
 * before the command, so a message that merely STARTS with a price or a variable (`$5 a month`, `$PATH is
 * wrong`) still goes to the agent. Undefined ⇒ the text is a message.
 */
export function composerTerminalLine(text: string): { command?: string } | undefined {
  const line = text.trim()
  if (line === "$") return {}
  if (line.includes("\n")) return undefined
  const match = /^\$\s+(\S.*)$/.exec(line)
  return match ? { command: match[1]!.trim() } : undefined
}
