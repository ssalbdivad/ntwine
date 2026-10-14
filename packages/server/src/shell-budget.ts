import { formatElapsed } from "@ntwine/shared"
import type { ShellBudgetRow, Storage } from "./storage.ts"

// THE BACKGROUND-SHELL RUNTIME BUDGET — a shell ends on a clock only when somebody DECLARED one.
//
// History, because the rule has already moved once. The original design built background shells
// with NO clock, on purpose (tailer.bgShellViews: "NO clock is a correct clock"): ntwine cannot tell a
// CI watcher from a dev server from outside, and some shells legitimately run for days. On 2026-09-29 the maintainer
// found a shell 16 hours old ("background shells running for 16 hours makes no sense") and 4e5eaca1
// gave EVERY shell a budget — its Bash `timeout`, else a 1h default. Within the day the default killed a
// real arktype shell at 17h that its worker had registered under a 20h `watch`: the clock was
// universal, and a universal clock is exactly the rule upstream had rejected.
//
// So the budget is OPT-IN (David 2026-09-29), and the question is asked of the one party that CAN
// tell a poller from a server — the worker, at the moment it launches the shell:
//
//  · AT SPAWN. A Claude worker sizes a shell with the Bash tool's own `timeout` on its
//    `run_in_background` call — the knob it already has, already in ms, already capped at 24h by
//    BASH_MAX_TIMEOUT_MS (backend/types.ts). NO `timeout` ⇒ NO budget: the shell runs until it ends or
//    is stopped. The worker is prompted to choose, not forced: the contract says so, and the
//    PreToolUse hook (cc-worker/hooks/bash-background.mjs) adds one line of context to a background
//    call that carries no `timeout` — a poller, build or check gets one; a server or watcher does not.
//  · IN THE MOMENT. `mcp__ntwine__extend_shell` sets or moves a budget on ANY running shell, including
//    one launched without — which is also the only way a codex background exec (no launch-time knob)
//    ever gets one.
//  · ENFORCED only once declared: past the deadline the worker gets ONE wake (scheduler SOURCE 13),
//    mid-turn if busy — keep it (`extend_shell`) or stop it — and silence for SHELL_BUDGET_GRACE_MS
//    after that wake REACHES the worker ends it through the operator's own × path.
//
// WHAT KEEPS AN UNBUDGETED SHELL HONEST is visibility, not a clock: every running shell is on the
// thread's drawer strip and its queue card, with its age and a Stop control (web ThreadProcessStrip /
// BackgroundOpsStrip), and a worker coming to rest behind a question is nudged about strays.
//
// A `watch` on the shell MOVES its deadline to the watch's own expiry — see resolveShellBudget.
//
// The numbers:
//  · GRACE 10m after the warning is DELIVERED — not after the deadline, and not after it was queued: a
//    server that was down across the deadline, or a wake that sat in the outbox, must still leave the
//    worker its full ten minutes to answer before anything is killed (scheduler shellBudgetGraceFrom).
//  · MAX 24h per declaration — the same ceiling as BASH_MAX_TIMEOUT_MS and a `watch`'s `for:`
//    (AWAITING_FOR_MAX_MS). A shell that must outlive a day is re-declared, one day at a time — or
//    launched without a budget at all.
//
// A `Monitor` carries NO budget and cannot be given one: a persistent one is itself a declaration that
// it runs for the session, and a non-persistent one ends at its own `timeout_ms` (Claude caps it at 1h).
export const SHELL_BUDGET_GRACE_MS = 10 * 60_000
export const SHELL_BUDGET_MAX_MS = 24 * 60 * 60_000
/** The floor on a DECLARED budget. The scheduler resolves budgets at its tick (10s), so a budget of
 *  seconds is not a budget it can keep, and it is always a mis-sized `timeout` rather than intent. */
export const SHELL_BUDGET_MIN_MS = 60_000

/** The budget a launch DECLARED through the Bash tool's `timeout`, clamped — or undefined when the
 *  call carried none (or something that is not a positive number), which means NO budget. */
export function declaredShellBudgetMs(timeout: unknown): number | undefined {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined
  return Math.min(SHELL_BUDGET_MAX_MS, Math.max(SHELL_BUDGET_MIN_MS, Math.round(timeout)))
}

/** A durable budget row (storage `shell_budget`) as the deadline needs it. `startedAt` is the shell's own
 *  launch instant, and a row whose `startedAt` disagrees with the live shell's belongs to a DIFFERENT
 *  shell that reused the id (a codex `processId` can recur across sessions) — it is ignored. */
export interface ShellBudgetRecord {
  startedAt: string
  deadlineAtMs: number | null
  warnedAtMs: number | null
  warnedDeadlineMs: number | null
}

/** The wake a shell earns by outliving its budget. Written for the model, which has no clock of its own
 *  (see wakeTimeHeader): it says how long the shell has run, what it was allowed, and the two verbs that
 *  answer it — with the exact argument to pass, because a worker that has to look the id up first is a
 *  worker that spends its grace doing it. `stoppable:false` is a shell ntwine holds no handle for (a
 *  pre-broker row); it is warned and never killed, so the message must not threaten a kill that will not
 *  come. Durations in the house grammar (`1h 5m`), via the same formatter as the wake's clock line. */
export function shellBudgetWarningMessage(input: {
  handle: string
  label: string
  ranMs: number
  budgetMs: number
  stoppable: boolean
  backend: "claude" | "codex" | "other"
}): string {
  const { handle, label } = input
  const stopVerb = input.backend === "claude"
    ? `\`TaskStop\` with task id \`${handle}\``
    : input.backend === "codex" ? "end its process yourself" : "kill it yourself"
  const consequence = input.stoppable
    ? ` ntwine stops it in ${formatElapsed(SHELL_BUDGET_GRACE_MS)} unless you extend it.`
    : " ntwine cannot stop this one for you, so it keeps running until you do."
  return (
    `\u23f0 Your background shell \`${handle}\` (${label}) has been running ${formatElapsed(input.ranMs)}, past its ` +
    `${formatElapsed(input.budgetMs)} budget.${consequence}\n\n` +
    `If it must keep running, run \`ntwinectl extend-shell ${handle} --for <duration>\` ` +
    `(\`30m\`, \`2h\`, max 24h). If you no longer need it, stop it now (${stopVerb}).`
  )
}

/** Why a shell was stopped — the one thing the kill notice must get right, because the worker reads it
 *  cold and decides from it whether to relaunch. */
export type ShellStopReason =
  | { kind: "operator" }
  | { kind: "budget"; ranMs: number; budgetMs: number }

/** What the worker is told when ntwine kills one of its background commands. Neither provider tells its
 *  agent (see router.noticeShellStopped / codex terminateBackgroundExec for the measurements), so this
 *  is the only account of the kill it will ever get. `[ntwine]` keeps it out of the human's chat
 *  (transcript.ts NOISE_PREFIXES). */
export function shellStopNotice(label: string, reason: ShellStopReason = { kind: "operator" }): string {
  const tail = "It is no longer running and will never report a result — do not wait on it or poll it again."
  if (reason.kind === "operator") {
    return `[ntwine] The operator stopped your background command ${JSON.stringify(label)} from the ntwine dashboard. ${tail}`
  }
  return (
    `[ntwine] ntwine stopped your background command ${JSON.stringify(label)} after ${formatElapsed(reason.ranMs)}: it ran ` +
    `past its ${formatElapsed(reason.budgetMs)} budget and was not extended with \`ntwinectl extend-shell\` after the ` +
    `warning. ${tail} If you still need it, relaunch it — with a Bash \`timeout\` sized to it, or none if it must run until you stop it.`
  )
}

/** The durable row, in the shape the deadline reads — see ShellBudgetRecord. */
export function shellBudgetRecordOf(row: ShellBudgetRow | undefined): ShellBudgetRecord | undefined {
  if (!row) return undefined
  return { startedAt: row.started_at, deadlineAtMs: row.deadline_at, warnedAtMs: row.warned_at, warnedDeadlineMs: row.warned_deadline }
}

/** The shell as the budget needs it — a BgShellView, or anything carrying its handles. */
export interface BudgetedShell {
  id?: string
  taskId?: string
  label: string
  startedAt: string
  /** The DECLARED launch budget (clamped `timeout`); absent ⇒ none was declared. */
  budgetMs?: number
  /** A `Monitor`: never budgeted, never extendable. */
  monitor?: boolean
}

/** An armed `watch` as the budget reads it — kind, the handle it was registered against, its expiry. */
export interface BudgetWatch {
  kind: string
  target: string
  expiresAtMs: number
}

export interface ResolvedShellBudget {
  shellId: string
  /** When the budget runs out — the instant SOURCE 13 warns at. */
  deadlineMs: number
  /** The durable row, when it belongs to THIS shell. */
  record?: ShellBudgetRecord
  /** Set when an armed `watch` is what holds the deadline where it is (it outlasts the budget). */
  watchUntilMs?: number
}

/** THE ONE ANSWER to "when does this shell's time run out", for every reader — the scheduler, `activity`,
 *  `extend_shell`, the board's `budgetEndsAt` — so none of them can disagree. Undefined ⇒ unbudgeted:
 *  nothing is ever warned about or stopped.
 *
 *  The BASE is an `extend_shell` deadline recorded for THIS shell, else launch + its declared budget,
 *  else nothing at all — there is no default.
 *
 *  AN ARMED WATCH EXTENDS, it does not exempt. The worker that registers `watch {shell, for: 20h}` has
 *  declared, in the one place it declares a wait's length, that it expects the shell to be worth
 *  waiting on for 20h; killing it at 17h (the arktype shell, 2026-09-29) betrays that declaration. So
 *  the deadline becomes max(base, the watch's expiry). Extending rather than exempting because:
 *   · every reader then sees the TRUE end — the `activity` readout, the card's "2h left" — where an
 *     exemption would report a deadline long past while nothing happened at it;
 *   · it is still bounded: a watch expires (≤24h) and wakes its worker (evalOwnWatches), and if the
 *     shell is still running past a budget it DECLARED, the ordinary warning follows at that instant;
 *   · `unwatch` hands the shell straight back to the budget it had, with no special case;
 *   · arming a watch after a warning moves the deadline, which re-arms the warning and cancels the
 *     pending kill exactly as `extend_shell` does — the same mechanism, not a second one.
 *  A watch never CREATES a budget on an unbudgeted shell: the watch's `for:` is how long the WAIT is
 *  registered, not how long the process may live. */
export function resolveShellBudget(
  shell: BudgetedShell,
  record: ShellBudgetRecord | undefined,
  watches: readonly BudgetWatch[] = [],
): ResolvedShellBudget | undefined {
  if (shell.monitor || !shell.id) return undefined
  const own = record && record.startedAt === shell.startedAt ? record : undefined
  const base = own?.deadlineAtMs ?? (shell.budgetMs !== undefined ? Date.parse(shell.startedAt) + shell.budgetMs : undefined)
  if (base === undefined || !Number.isFinite(base)) return undefined
  const handles = new Set([shell.id, shell.taskId, shell.label].filter((h): h is string => !!h))
  let watchUntilMs: number | undefined
  for (const w of watches) {
    if (w.kind !== "shell" || !handles.has(w.target)) continue
    if (watchUntilMs === undefined || w.expiresAtMs > watchUntilMs) watchUntilMs = w.expiresAtMs
  }
  const held = watchUntilMs !== undefined && watchUntilMs > base
  return {
    shellId: shell.id,
    deadlineMs: held ? watchUntilMs! : base,
    ...(own ? { record: own } : {}),
    ...(held ? { watchUntilMs } : {}),
  }
}

/** resolveShellBudget off live storage — its row and the thread's ARMED watches. */
export function liveShellBudget(
  storage: Pick<Storage, "getShellBudget" | "listThreadWatches">,
  slug: string,
  shell: BudgetedShell,
): ResolvedShellBudget | undefined {
  if (shell.monitor || !shell.id) return undefined
  const record = shellBudgetRecordOf(storage.getShellBudget(slug, shell.id))
  const watches = storage.listThreadWatches(slug, { armedOnly: true }).map((w) => ({ kind: w.kind, target: w.target, expiresAtMs: w.expires_at }))
  return resolveShellBudget(shell, record, watches)
}
