import type { BgShellView, EndedShellView, ThreadTerminal, ThreadView, WorkCheckout } from "@ntwine/shared"
import { mergeBackgroundShells, visibleChildOps, type TranscriptShellRecord } from "./childOps.ts"
import { shellBudgetReading } from "./shellBudget.ts"
import { promptingTerminal, terminalFailed, terminalLive } from "./threadTerminals.ts"

// EVERY PROCESS ON A THREAD, AS ONE LIST — the terminals the human opened (server thread-terminals.ts, a
// pty each) and the ones the agent started (a background `Bash`, a `Monitor`, a Codex background exec;
// server tailer.ts bgShells). Until 2026-09-29 the two rendered as two strips with two row shapes, and only
// the human's opened anything. The maintainer asked for one place, told apart by an owner mark, and every
// row introspectable the same way — so the strip, the card and the sidebar mark all read this.
//
// An agent's shell is NOT a pty: its output is a file the harness writes, and its drawer reads that file by
// offset (read-only). The human's is the pty itself. The model says which by `owner` and nothing else.

export type ProcessOwner = "agent" | "human"
export type ProcessState = "running" | "quiet" | "prompt" | "finished" | "failed"
export type ShellBudgetReading = NonNullable<ReturnType<typeof shellBudgetReading>>

export interface ThreadProcess {
  /** `t:<terminalId>` for yours, `s:<shellId|launchId|label@startedAt>` for the agent's. */
  key: string
  owner: ProcessOwner
  /** Yours: the command line. The agent's: the tool call's own description of it. */
  label: string
  state: ProcessState
  startedAt?: string
  /** The absolute folder it started in. */
  cwd?: string
  /** That folder's checkout, only when it is off the project root (server liftCheckout). */
  checkout?: WorkCheckout
  /** The SERVER placed this row: it read the row's folder and lifted it (`checkout` off the root, `atRoot`
   *  in it), so an absent `checkout` means the project root rather than "unknown". False when it had no
   *  reading — a folder since removed, a Codex exec whose item named none, a transcript-only row (a
   *  sub-agent's shell, a tool call's own `workdir`) — and such a row claims no place at all. */
  placed: boolean
  /** The agent's only — what is left of the runtime budget it declared. */
  budget?: ShellBudgetReading
  monitor?: boolean
  /** A Codex exec: Codex keeps its output, so the drawer can show everything but that. */
  outputUnavailable?: boolean
  terminal?: ThreadTerminal
  shell?: BgShellView & TranscriptShellRecord
  /** A FINISHED agent terminal's row (ThreadView.endedShells): its drawer reads the retired log. */
  ended?: EndedShellView
}

type AgentShell = BgShellView & TranscriptShellRecord

function agentProcess(shell: AgentShell, now: number): ThreadProcess {
  const budget = shellBudgetReading(shell.budgetEndsAt, now)
  return {
    key: `s:${shell.id ?? shell.launchId ?? `${shell.label}@${shell.startedAt}`}`,
    owner: "agent",
    label: shell.label,
    // A tracked shell is a live process even when quiet; "stale" is the OS saying nobody holds its log.
    state: shell.state === "running" ? "running" : "quiet",
    startedAt: shell.startedAt,
    ...(shell.cwd ? { cwd: shell.cwd } : {}),
    ...(shell.checkout ? { checkout: shell.checkout } : {}),
    // The server's own reading (bgShellViews/codexBgShellViews), never the folder a transcript copy filled
    // in (mergeBackgroundShells): that one is the tool call's own words, and nothing lifted it. A cwd with
    // neither field is a folder the server could not read — gone, or never named.
    placed: Boolean(shell.checkout || shell.atRoot),
    ...(budget ? { budget } : {}),
    ...(shell.monitor ? { monitor: true } : {}),
    ...(shell.outputUnavailable ? { outputUnavailable: true } : {}),
    shell,
  }
}

// A FINISHED agent terminal, listed as a finished terminal of yours is — `failed` when it failed on its
// own, `finished` when it completed or was stopped (its row's state word tells those two apart).
function endedProcess(shell: EndedShellView): ThreadProcess {
  return {
    key: `s:${shell.id}`,
    owner: "agent",
    label: shell.label,
    state: shell.status === "failed" ? "failed" : "finished",
    ...(shell.startedAt ? { startedAt: shell.startedAt } : {}),
    ...(shell.cwd ? { cwd: shell.cwd } : {}),
    ...(shell.checkout ? { checkout: shell.checkout } : {}),
    placed: Boolean(shell.checkout || shell.atRoot),
    ...(shell.monitor ? { monitor: true } : {}),
    ended: shell,
  }
}

/** A finished agent terminal's state word, in your terminal's vocabulary (lib/threadTerminals.ts). */
export function endedShellStateLabel(shell: Pick<EndedShellView, "status">): string {
  return shell.status === "failed" ? "failed" : shell.status === "killed" ? "stopped" : "finished"
}

function humanState(terminal: ThreadTerminal): ProcessState {
  if (terminal.state === "running" && terminal.awaitingInput) return "prompt"
  if (terminalLive(terminal)) return "running"
  return terminalFailed(terminal) ? "failed" : "finished"
}

export function humanProcess(terminal: ThreadTerminal): ThreadProcess {
  return {
    key: `t:${terminal.id}`,
    owner: "human",
    label: terminal.command,
    state: humanState(terminal),
    startedAt: terminal.startedAt,
    cwd: terminal.cwd,
    ...(terminal.checkout ? { checkout: terminal.checkout } : {}),
    // The board lifts every terminal's folder (board.ts withThreadTerminals); a folder since removed has
    // neither field, and claims nothing.
    placed: Boolean(terminal.checkout || terminal.atRoot),
    terminal,
  }
}

const time = (iso: string | undefined) => {
  const ms = Date.parse(iso ?? "")
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/**
 * The thread's processes in the order every surface lists them:
 *   1. a terminal of yours waiting at a prompt — the reason a card is in the queue;
 *   2. everything running or quiet, BOTH owners mixed, oldest first — one list, not two;
 *   3. every finished terminal, BOTH owners, newest end first, until cleared — its exit is why you open it.
 * A finished AGENT terminal left the list the moment it ended until 2026-09-30, so a 10-second shell could
 * not be opened from anywhere while a finished one of yours sat here with Open. It now stays as yours do,
 * bounded by the server's retired ring (ThreadView.endedShells). A surface that lists only live work (the
 * queue card, the sidebar mark) filters with processIsLive, as it always did for yours.
 * `scopedToSubAgent` is a sub-agent drawer's strip: only that child's own transcript shells, and none of
 * yours — nobody opens a terminal on a sub-agent.
 */
export function threadProcesses(
  thread: Pick<ThreadView, "terminals" | "bgShells"> & Partial<Pick<ThreadView, "endedShells">>,
  transcriptShells: readonly AgentShell[],
  opts: { scopedToSubAgent?: boolean; now: number },
): ThreadProcess[] {
  const shells = opts.scopedToSubAgent ? [...transcriptShells] : mergeBackgroundShells<AgentShell>(thread.bgShells ?? [], transcriptShells)
  const agents = visibleChildOps(shells, "sheet").map((shell) => agentProcess(shell, opts.now))
  const humans = opts.scopedToSubAgent ? [] : (thread.terminals ?? []).map(humanProcess)
  const prompt = humans.filter((p) => p.state === "prompt")
  const live = [...agents, ...humans.filter((p) => p.state === "running")]
    // Stable: equal instants keep their source order (the agent's first, as launched).
    .map((p, i) => ({ p, i }))
    .sort((a, b) => time(a.p.startedAt) - time(b.p.startedAt) || a.i - b.i)
    .map(({ p }) => p)
  // A finished agent row whose shell is still on the board as live (the two arrive a frame apart) is the
  // live row's; it never lists twice.
  const liveKeys = new Set(agents.map((p) => p.key))
  const endedAgents = opts.scopedToSubAgent ? [] : (thread.endedShells ?? []).map(endedProcess).filter((p) => !liveKeys.has(p.key))
  const ended = (p: ThreadProcess) => time(p.terminal?.exitedAt ?? p.ended?.finishedAt ?? p.startedAt)
  const finished = [...humans.filter((p) => p.state === "finished" || p.state === "failed"), ...endedAgents]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => ended(b.p) - ended(a.p) || a.i - b.i)
    .map(({ p }) => p)
  return [...prompt, ...live, ...finished]
}

/** How many FINISHED rows a collapsed strip keeps (newest end first, per threadProcesses' order). */
export const FINISHED_SHOWN = 3

/**
 * The rows a collapsed strip draws, and how many it folds away. Every live row stays: it is work happening
 * now. Finished rows past FINISHED_SHOWN fold behind one "Show N more" row — a docs session left 21 TERM
 * rows under the prompt box (maintainer 2026-10-06: "this looks cooked"). Folding a single row would trade
 * one row for another, so a strip one over the limit draws it.
 */
export function collapseFinished(processes: readonly ThreadProcess[], expanded: boolean): { shown: ThreadProcess[]; hidden: number; foldable: boolean } {
  const finished = processes.filter((p) => !processIsLive(p))
  const foldable = finished.length - FINISHED_SHOWN > 1
  if (expanded || !foldable) return { shown: [...processes], hidden: 0, foldable }
  const kept = new Set(finished.slice(0, FINISHED_SHOWN))
  return { shown: processes.filter((p) => processIsLive(p) || kept.has(p)), hidden: finished.length - FINISHED_SHOWN, foldable }
}

/** Whether a process is alive — what the sidebar mark counts and the strip folds finished ones by. */
export function processIsLive(p: ThreadProcess): boolean {
  return p.state === "running" || p.state === "quiet" || p.state === "prompt"
}

/** A queue card lists only what is live, and never the terminal its prompt pane already shows. */
export function onCard(thread: Pick<ThreadView, "terminals">): (p: ThreadProcess) => boolean {
  const prompting = promptingTerminal(thread)
  return (p) => processIsLive(p) && !(prompting && p.terminal?.id === prompting.id)
}

/** The rows a queue card's strip draws, and what its counts line counts as terminals. The card gates its
 *  strip on this, so a card whose terminals have all finished — or whose only one is the prompt it shows
 *  above — draws no empty inset and counts nothing. `transcriptShells` is the drawer's: the shells read off
 *  the transcript, which the board reports none of for a Codex thread (see mergeBackgroundShells). */
export function cardProcesses(thread: Pick<ThreadView, "terminals" | "bgShells">, now: number, transcriptShells: readonly AgentShell[] = []): ThreadProcess[] {
  return threadProcesses(thread, transcriptShells, { now }).filter(onCard(thread))
}
