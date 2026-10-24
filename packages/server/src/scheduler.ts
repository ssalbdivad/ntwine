import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { awaitingStatus, needsInputRequired, PARK_CORRECTION_NAMES_LEAD, PARK_CORRECTION_QUESTION_LEAD, PARK_CORRECTION_RETIRED_LEAD, interruptEndedSubAgentsMessage, type InterruptEndedSubAgent, parkExpiredWakeMessage, parkFinishedWakeMessage, prWatchExpiredWakeMessage, ownWatchExpiredWakeMessage, mergeAnswerMessages, commandWatchPassedWakeMessage, commandWatchExpiredWakeMessage, commandWatchCancelledWakeMessage, mergedWakeMessage, questionAnswerMessage, threadQuestionDefaults, questionsCancelledWakeMessage, type QuestionAnswer, type QuestionDismissal, RETIRED_AWAITING_REPLACEMENT, retiredAwaitingKindsIn, compactionPromptMessage, goalLimitMessage, limitResumeSteer, limitModelSwitchSteer, formatGithubWakeSteer, GithubWakeItem, type GithubWatchStatus, type GithubIssueStatus, prWatchWakeMessage, issueWatchWakeMessage, shellDoneMessage, terminalOutcome, terminalWakeMessage, terminalWatchExpiredWakeMessage, terminalControlWakeMessage, type ThreadTerminal, restPromptMessage, schedulePromptMessage, timerPromptMessage, signoffNudgeMessage, carriedQuestionsNudgeMessage, strayShellsMessage, type SignoffLiveOps, liveOpsLines, isDirectSubAgent, wakeDeliveryToken, wakeTimeHeader, stripWakeTimeHeader, type QuotaSnapshot, deadlineStageDue, type DeadlineStage } from "@ntwine/shared"
import { GITHUB_ISSUE_STATUS_SETTING, GITHUB_STATUS_SETTING, terminalLives, terminalAwaitKey, type TerminalLive, liveActivityOf, parkExpiresAt, parkIsHonoured, parkOnHuman, readAwaitingPark, unaccountedItems, type LiveActivity } from "./awaiting.ts"
import { isHeldRow, terminalNotesOf, type ThreadTerminalRow, type CommandWatchRow, type PrWatchRow, type SessionRow, type Storage, type ThreadQuestionRow } from "./storage.ts"
import type { CommandRunResult, CommandWatchService } from "./command-watch.ts"
import type { Tailer } from "./tailer.ts"
import type { SessionTelemetry } from "./tailer.ts"
import type { LimitFault } from "./backend/types.ts"
import { limitFaultResetKey, limitPauseIsStale, mayHaveLiveBackgroundWork, quotaWindowKeyFor, quotaWindowRecovered, scopedQuotaWindow, scopedQuotaWindowRecovered, textResetInstant } from "./backend/usage-limit.ts"
import { fableHasHeadroom } from "./backend/fable-fallback.ts"
import { claudeFallbackModel, claudeModelFromLimitName, claudeProfile, normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import { createWakeDeliveryStore, WAKE_QUIET_WINDOW_MS, type WakeDelivery } from "./wake-store.ts"
import { armedTimerKeys, replyWaitOf, threadAwaitKey } from "./thread-mentions.ts"
// The board owns the registered-done lifetime rule, and the waker must read it by exactly the same rule
// or the two disagree about whether a thread is finished.
import { withTerminals, answersInFlight, carriedQuestionRows, childJustReturned, heldQuestionRows, registeredDoneFence, rowPassedOver, safeQuestionAnswer, safeQuestionSpec, SIGNOFF_NUDGE_SETTING, signoffNudgeVerdict } from "./board.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { liveShellBudget, SHELL_BUDGET_GRACE_MS, shellBudgetWarningMessage, type ShellStopReason } from "./shell-budget.ts"
import { deadlineCheckInMessage, deadlineStageToSend, rowDeadline } from "./deadline.ts"
import { completionsDueForRelay, relayMessage } from "./completion-relay.ts"
import {
  createGithubReviewFetcher,
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
  type GithubReviewFetchResult,
  type GithubIssueSnapshot,
} from "./github-review.ts"
import { isNoisePrActivity } from "./pr-watch-noise.ts"

const execFileAsync = promisify(execFile)

export {
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
} from "./github-review.ts"
import { log as ntwineLog } from "./logging.ts"

// ---- THE DURABLE WAKER ---------------------------------------------------------------------------
// NOTHING IN AN ```awaiting FENCE WAKES A THREAD. A fence STATES what a thread is waiting on; every
// wait ntwine can actually fire is a REGISTRATION the worker made through a tool — a `thread_timer` row
// (`ntwinectl timer`), a `pr_watch` row (`ntwinectl watch-pr`, SOURCE 11), a background shell's own
// telemetry — or a condition the server itself observes: a provider limit lifting, a human's snooze
// coming due, a recurring prompt's schedule, a rest with nothing declared. The limb that polled
// `pr-watch:`/`pr:`/`ci:`/`timer:` hints out of the fence was hardwired off by the 2026-08-15 grammar
// cut and deleted on 2026-08-24, because a line ntwine cannot check is a wait that can silently never
// resolve. Any other automated wait should stay ACTIVE instead, through Bash/Monitor (Claude) or a
// blocking exec wait (Codex).
//
// ---- THE BOOT-MASS-FIRE SAFETY GUARD (critical — the maintainer has ~14 real sessions) ----
// We fire ONLY on a wait REGISTERED with this scheduler, and every registration is persisted before it
// can fire — so a timer crossing or PR activity during downtime still wakes after a restart, while a
// thread that merely inherited an old transcript has registered nothing and therefore wakes nothing.
// Once a condition fires, a deterministic SQLite outbox row is committed BEFORE terminal delivery.
// Atomic leases serialize multiple scheduler instances; delivery acknowledgement, transcript-token
// confirmation, and per-source supersession produce explicit terminal states. A crash leaves
// pending/leased work recoverable instead of burning a fired bit before the wake reached the worker.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// The distilled PR status we act on (from one `gh pr view … --json state,mergedAt,statusCheckRollup`).
export interface PrStatus {
  state: string // OPEN | CLOSED | MERGED
  mergedAt: string | null
  rollup: RollupEntry[] // statusCheckRollup entries (CheckRun and/or StatusContext shapes)
  // GitHub's own merge verdict, as the merge box states it. MERGEABLE | CONFLICTING | UNKNOWN, plus the
  // review gate (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "") — the two facts behind "can this
  // actually land", which the card renders and the queue rule reads.
  mergeable?: string
  reviewDecision?: string
  /** The head commit the rollup describes. Fetched all along to query workflow runs, and now KEPT: a
   *  verdict is only news against the commit it was reached on (see the pr-watch cursor). */
  head?: string
  // Workflow runs queried by the PR's exact head SHA. statusCheckRollup can omit a fork-gated
  // ACTION_REQUIRED run, so the exact-head runs are what let a watcher NAME the jobs that went red.
  //
  // ONLY THE `gh` FALLBACK FILLS THIS. The batched GraphQL poll reads the head's CHECK SUITES in the
  // same request instead (`checkSuites` below) — the same facts, one round trip, no subprocess.
  workflowRuns?: WorkflowRun[]
  /** The head's check suites, from the batched poll. Same role as `workflowRuns` and the same shape as
   *  far as anything here reads it: a conclusion and a workflow name. */
  checkSuites?: WorkflowRun[]
  /** Everything else the one query now brings back, for the triggers that read PR state rather than CI.
   *  Absent on the `gh` fallback, which does not ask for them. */
  labels?: string[]
  reviewRequests?: string[]
}

export interface WorkflowRun {
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  databaseId?: number
  event?: string
  createdAt?: string
}

interface RollupEntry {
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING | WAITING
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED | STALE
  state?: string // StatusContext: PENDING | SUCCESS | FAILURE | ERROR | EXPECTED
  name?: string // CheckRun's job name
  context?: string // StatusContext's context label
  workflowName?: string // CheckRun's parent workflow, when GitHub reports one
  // The two fields that make one FAILURE EVENT distinguishable from the next. `detailsUrl` carries the
  // run and job ids (`/actions/runs/<run>/job/<job>`), so a re-run of the same job on the same commit is
  // a different URL — which is exactly what "this failed AGAIN" has to be keyed on.
  detailsUrl?: string // CheckRun's job URL
  targetUrl?: string // StatusContext's equivalent
  completedAt?: string
}

// THE IDENTITY OF THE CURRENT FAILURES, so "CI is red" can be told apart from "CI is red AGAIN".
//
// A verdict word cannot express a second failure, and neither can the head commit alone: CI fails, the
// job is re-run on the SAME commit and fails again, or a slower job goes red minutes after the first —
// all real, all news, and all invisible to `failing === failing`. This digests what is failing RIGHT NOW
// into one short string, so any change in the failing set is a change in the stamp.
//
// Keyed on the job URL first because it carries the run and job ids and therefore changes on a re-run;
// `completedAt` is the fallback for a StatusContext that has no such URL, and the name alone is the last
// resort. Hashed because a rollup can carry 60+ entries and this string lives in a cursor column.
export function failureSignature(rollup: RollupEntry[]): string {
  const ids: string[] = []
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue
    if (!rollupEntryFailed(typeof c.conclusion === "string" ? c.conclusion : undefined, typeof c.state === "string" ? c.state : undefined)) continue
    const label = c.name ?? c.context ?? c.workflowName ?? "?"
    ids.push(`${label}@${c.detailsUrl ?? c.targetUrl ?? c.completedAt ?? ""}`)
  }
  if (ids.length === 0) return ""
  // SORTED, because GitHub's rollup order is not stable and an order flip is not a new failure.
  return createHash("sha1").update(ids.sort().join("\n")).digest("hex").slice(0, 12)
}

// Parse a PR reference: `owner/repo#123` or a GitHub PR URL. Undefined when neither shape matches
// (e.g. an actions-run URL with no PR number). Duplicated from `awaiting.ts`, which the board and the
// router parse with — the two are byte-identical and worth collapsing, but that is its own change.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/
export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}

// `gh pr view` does not accept owner/repo#N as its positional selector. Pin the CLI-compatible shape:
// numeric selector plus an explicit repository. Kept pure/exported so a regression cannot silently
// turn every healthy watcher poll into an "unavailable" result again.
export function ghPrViewArgs(ref: PrRef): string[] {
  return ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,mergedAt,statusCheckRollup,headRefOid,mergeable,reviewDecision"]
}

// Reduce a statusCheckRollup to a terminal verdict. `done` = every check has reached a terminal state
// (nothing queued/in-progress/pending); `ok` = none concluded in failure. An EMPTY rollup is treated as
// still-pending: no check has reported yet, which is not the same answer as green.
//
// This is the REFERENCE reading of a rollup. `githubWatchStatus` below re-derives the same verdict
// beside its counts rather than calling it, so this stays exported and unit-tested as the thing that
// reading must not be allowed to drift from.
//
// IT READS THE ROLLUP AND NOTHING ELSE, which is a real limit and not an oversight: a workflow held at
// `action_required` for a maintainer's approval produces NO check run, so it is absent from the rollup
// entirely and `done` here says true over CI that has not started. `githubWatchStatus` is given the
// head's workflow runs as well and can see it; this cannot. Anything that needs the true verdict must
// go through that one.
export function evalRollup(rollup: RollupEntry[]): { done: boolean; ok: boolean } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { done: false, ok: false }
  let pending = false
  let failed = false
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue
    const status = typeof c.status === "string" ? c.status : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    // An entry is terminal ONLY if it AFFIRMATIVELY says so: a CheckRun with status COMPLETED, or a
    // StatusContext whose state is a settled value. An entry we can't classify (no recognizable
    // status/state — a `{}` or a future/unknown shape) is treated as still-PENDING, never as
    // done+green — so a shape surprise can never launder an unknown check into a false "green" verdict.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) pending = true
    if (rollupEntryFailed(conclusion, state)) failed = true
  }
  return { done: !pending, ok: !failed }
}

// The single definition of "this check concluded badly", shared by the pass/fail verdict and by the
// steer that NAMES the failures — so the wake can never say "CI failed" and then list nothing.
function rollupEntryFailed(conclusion: string | undefined, state: string | undefined): boolean {
  return (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE" ||
    state === "FAILURE" ||
    state === "ERROR"
  )
}

// A check that reached a terminal state without asserting anything — GitHub's own `SKIPPED` (a path
// filter or an `if:` that did not match) and `STALE` (superseded before it ran). Neither is a failure,
// so neither may make the rollup pending; neither is evidence of a green build either, so neither may
// be counted as a pass. Both were counted as passes until 2026-09-04, which is half of how "15 checks
// green" got said about a commit nothing had built (see below).
function rollupEntrySkipped(conclusion: string | undefined): boolean {
  return conclusion === "SKIPPED" || conclusion === "STALE"
}

// WORKFLOWS HELD FOR A MAINTAINER'S APPROVAL, named. `action_required` on a workflow RUN is GitHub's
// "Approve and run" gate — the default for a first-time contributor and for any fork PR in a repo that
// requires approval. The gated run produces no check run at all, so nothing about it reaches the
// rollup: `statusCheckRollup` simply does not mention the eight workflows that are waiting.
//
// That is the other half of the false green. On nodejs/node#65795 (2026-09-04 15:12Z) the head carried
// 8 gated workflows — Test Linux, Test macOS, Linters, Coverage Windows, Build from tarball — and a
// rollup of 15 entries that were 12 `SKIPPED` no-ops plus 3 label bots. Every entry present was
// terminal and none had failed, so the poll reported "✅ CI PASSED — 15 checks green" about a commit
// whose real 29-check matrix had not been allowed to start and never did run on it.
//
// ntwine was already fetching the answer: `defaultFetchPr` lists the head's workflow runs to name failed
// jobs, and the gated ones are in that same list. `failedCheckNames` skips them because a pending
// approval is not a failure, which is right — but until this they were then dropped on the floor rather
// than reported as the distinct, and very actionable, state they are.
//
// READ IN GRAPHQL'S CASING, WHICHEVER FETCH PRODUCED THE RUN (2026-09-11). The batched poll's check
// suites conclude `ACTION_REQUIRED`; the `gh run list` fallback's runs conclude `action_required`,
// because that command prints the REST shape. Both readers here compared the raw string against the
// upper-case word, so a poll served by the fallback saw NO gated workflow and NO failed run at all — and
// a fork PR whose one rollup entry was a green `license/cla` CheckRun read as "✅ CI PASSED — 1 check
// green" on exactly the ticks the GraphQL batch failed. A batch fails as a unit (`fetch failed` on one
// request sends every armed ref down the fallback at once), and the next GraphQL poll read the same PR as
// gated again: two wakes per blip on every gated watcher, one of them false. microsoft/TypeScript#64172
// collected four such pairs in a week; typeorm/typeorm#12842 and Unitech/pm2#6151 flipped together at
// six instants over three days.
function runConclusion(run: WorkflowRun): string | undefined {
  return typeof run.conclusion === "string" ? run.conclusion.toUpperCase() : undefined
}

export function gatedWorkflowNames(runs: WorkflowRun[] = [], cap = 8): { names: string[]; total: number } {
  const names: string[] = []
  const seen = new Set<string>()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    if (runConclusion(run) !== "ACTION_REQUIRED") continue
    const name = (run.workflowName ?? run.name)?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { names: names.slice(0, cap), total: names.length }
}

// Which checks actually failed. "❌ CI failed on owner/repo#N" told a worker only that SOMETHING went
// red, so its first move was always another `gh pr checks` round-trip; naming the jobs it must look at
// costs nothing here and saves that turn. Deduplicated and bounded — a red matrix can be 40 entries.
export function failedCheckNames(rollup: RollupEntry[], runs: WorkflowRun[] = [], cap = 8): { names: string[]; omitted: number } {
  const names: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined) => {
    const name = raw?.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue
    if (!rollupEntryFailed(typeof c.conclusion === "string" ? c.conclusion : undefined, typeof c.state === "string" ? c.state : undefined)) continue
    push(c.name ?? c.context ?? c.workflowName)
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    // An unapproved fork run reads ACTION_REQUIRED but is a pending approval, not a failure, so it
    // must not be listed as a failed job.
    const conclusion = runConclusion(run)
    if (conclusion === "ACTION_REQUIRED") continue
    if (!rollupEntryFailed(conclusion, undefined)) continue
    push(run.workflowName ?? run.name)
  }
  return { names: names.slice(0, cap), omitted: Math.max(0, names.length - cap) }
}

// ---- WHAT A WATCHED PR'S CHECKS LOOK LIKE FROM OUTSIDE ------------------------------------------
// The `gh pr view` rollup, projected into the shape GitHub's own merge box states — because it DECIDES
// A QUEUE RULE and not just a readout (maintainer 2026-08-14: "if there is a GitHub watcher registered
// and the GitHub actions are still running, then that should remain in the running active rail. Only if
// CI has failed or completed successfully should it show up back in the queue").
//
// `none` and `running` are deliberately different answers. An EMPTY rollup means no check has reported
// yet, which `evalRollup` already treats as pending — but a PR with no CI at all would then wait
// forever for checks that are never coming, so the two are split here: `none` lets the thread queue
// immediately, `running` is what parks it.
//
// A PASS NOW REQUIRES SOMETHING TO HAVE ACTUALLY PASSED, and nothing may be waiting for approval
// (2026-09-04). Both halves are the same defect read twice: the old reading answered "did anything
// present go red?" when the question is "did this commit get built?". Skips and label bots are not a
// build, and a workflow nobody has approved has not run. `gated` folds into `running` rather than
// earning a fifth verdict word — the queue rule (board.ts, groups.ts) asks only whether CI has SETTLED,
// and a gated PR has not — but it is counted and named separately, because "waiting for a maintainer to
// press Approve and run" is a different instruction to the worker than "wait".
export function githubWatchStatus(pr: PrStatus, polledAt: string): GithubWatchStatus {
  const entries = Array.isArray(pr.rollup) ? pr.rollup.filter((c) => c && typeof c === "object") : []
  let running = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const c of entries) {
    const status = typeof c.status === "string" ? c.status : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    // Terminal ONLY if it AFFIRMATIVELY says so, exactly as `evalRollup` reads it: an unrecognizable
    // entry counts as still running, never as quietly green.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) running++
    else if (rollupEntryFailed(conclusion, state)) failed++
    else if (rollupEntrySkipped(conclusion)) skipped++
    else passed++
  }
  // The batched poll's check suites, or the `gh` fallback's workflow runs — whichever this reading came
  // from. They answer the same two questions (what is gated, what went red outside the rollup) with the
  // same two fields, so everything downstream reads one list and never asks which fetch produced it.
  const aux = pr.checkSuites ?? pr.workflowRuns ?? []
  const gate = gatedWorkflowNames(aux)
  const state = pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : "open" as const
  // FAILING WINS OVER GATED. A red job is news the worker acts on now; an unapproved workflow beside it
  // is context, and it is carried in `gating` either way rather than deciding the verdict.
  const checks: GithubWatchStatus["checks"] =
    failed > 0 ? "failing"
    : running > 0 || gate.total > 0 ? "running"
    : passed > 0 ? "passing"
    : "none" // no rollup at all, or one that is entirely skips: nothing has run and nothing is coming
  // MERGEABILITY, in GitHub's own three words plus the review gate. `blocked` is deliberately coarse:
  // a required review and a failing required check are reported the same way, and ntwine has no business
  // claiming to tell them apart.
  const merge: GithubWatchStatus["merge"] =
    pr.mergeable === "CONFLICTING" ? "conflicting"
    : pr.mergeable !== "MERGEABLE" ? "unknown"
    : checks === "failing" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED" ? "blocked"
    : "mergeable"
  return {
    checks,
    running,
    passed,
    failed,
    skipped,
    gated: gate.total,
    gating: gate.names,
    failing: failedCheckNames(entries, aux).names,
    merge,
    state,
    polledAt,
    head: pr.head,
    failureSig: failureSignature(entries),
  }
}

function wakeDeliveryId(slug: string, sessionId: string, fenceId: string): string {
  return createHash("sha256").update(slug).update("\0").update(sessionId).update("\0").update(fenceId).digest("hex")
}

// ---- SOURCE 2: SUBSCRIPTION-LIMIT AUTO-RESUME -----------------------------------------------------
// The waker's other wake source. Where the fence source asks "did the wait this agent DECLARED come
// true?", this one asks "did the wall the provider put in front of this agent come down?" — and the
// set of agents behind that wall needs no registry, because the tailer's `limitFault` standing on a
// thread's tail IS the record that this agent was mid-turn when the window ran dry. It clears the
// instant any user record lands, so the "continue" we deliver erases the very fault that selected the
// thread: one wake per interruption, with no bookkeeping to drift.
//
// Both sources share ONE durable outbox (lease → deliver → ack, backend-aware delivery, retry with
// exponential backoff, supersession). Only the identity differs, and these two prefixes are what keep
// a limit wake and a fence wake for the same session from ever colliding on a delivery id.
const LIMIT_FENCE_PREFIX = "limit"
const LIMIT_HINT_PREFIX = "limit:"
// Deliberate slack past the provider's stated reset. Their clock and ours are not the same clock, and
// resuming a whole fleet one second early just re-hits the wall and burns every thread's wake.
const LIMIT_RESUME_GRACE_MS = 60_000

// The ACCOUNT-AVAILABILITY resume trigger (independent of the original window's own clock): a
// limit-paused thread also resumes when the blown window is no longer near-full on the CURRENTLY
// signed-in account — a fresh sign-in or a raised cap frees up quota the original clock knows nothing
// about. Two stateless guards keep it from resuming straight back into the wall:
//   • the FLOOR — a limit fault only happens at ~100% of the window, so requiring the current reading to
//     sit at/below 85% is the genuine down-edge while ignoring tick-to-tick jitter near 100%.
//   • the MIN FAULT AGE — the served quota reading can lag the fault by up to its cache TTL, and during
//     a fast fleet burn the window climbs 85→100 in well under a minute, so a reading OLDER than the
//     fault could still show pre-burn headroom. Only trusting the signal once the fault is comfortably
//     older than that staleness guarantees the reading POST-dates the fault (a real recovery), not a
//     stale pre-fault value. It adds no delay to the real case — an account switched hours after the
//     fault clears this instantly — it only holds off the first couple of minutes.
const LIMIT_RESUME_HEADROOM_PERCENT = 85
const LIMIT_HEADROOM_MIN_FAULT_AGE_MS = 2 * 60_000

// The generation id for one interruption. The limit record's timestamp is what makes it a generation:
// a thread that resumes and gets cut off AGAIN produces a later `at`, hence a different delivery id,
// hence its own single wake.
function limitFenceId(fault: LimitFault): string {
  return `${LIMIT_FENCE_PREFIX}${fault.at}`
}
function isLimitFenceId(fenceId: string): boolean {
  return fenceId.startsWith(LIMIT_FENCE_PREFIX)
}

// The message the resumed worker actually receives now lives in @ntwine/shared (imported above), beside
// its parser and every other wake formatter — the chat rebuilds this delivery's hairline from the
// delivered text alone, so the pair has to sit in the one package both sides can reach.

// ---- SOURCE 4: DROPPED SUB-AGENT REPORT REPAIR ---------------------------------------------------
// Where the limit source asks "did the wall come down?", this one asks "is this agent missing findings
// it believes it already has?" — and like that one it needs no registry, because the tailer's
// `droppedReports` standing on a thread's tail IS the record (see report-delivery.ts for the corpus:
// 242 of 498 completed sub-agent reports on one production thread reached the runtime's queue and
// never reached the model).
//
// It rides the same durable outbox as the other three, which is the whole reason to put it here rather
// than in a bespoke timer: lease → deliver → ack, retry with backoff, and — the load-bearing part —
// a delivery id of hash(slug, sessionId, fenceId). With the TASK ID as the generation, one dropped
// report can produce exactly ONE repair for a session, no matter how many ticks observe it. Re-nagging
// an agent about the same lost report every minute would be its own denial of service.
const REPORT_FENCE_PREFIX = "report"
const REPORT_HINT_PREFIX = "report:"

function reportFenceId(taskId: string): string {
  return `${REPORT_FENCE_PREFIX}:${taskId}`
}
function isReportFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${REPORT_FENCE_PREFIX}:`)
}

// ---- SOURCE 3: THE USER SNOOZE ------------------------------------------------------------------
// A snooze that carries a prompt is the human's own `awaiting timer:` — park until an instant, then
// resume with a message — differing only in WHO authored the message. So it wakes over this same
// outbox rather than a private timer of its own, inheriting crash-safety, retry/backoff, supersession
// and every-backend delivery for free.
//
// Its record of intent is the session row itself (`snoozed_until` + `snooze_prompt`), exactly as the
// limit source's record is the tail's limit fault. That is why `clearExpiredSnoozes` deliberately
// leaves a prompt-carrying snooze standing past its deadline: the row must outlive the crossing so a
// wake-now, a human follow-up, or a re-snooze can be READ here as supersession. It is cleared only
// once this wake reaches a terminal state — and only while it still matches the delivery it armed.
//
// The prompt is delivered VERBATIM, with no "⏰ your snooze fired" preamble: the human scheduled a
// follow-up, so the worker should receive precisely the turn they wrote, not a paraphrase of it.
const SNOOZE_FENCE_PREFIX = "snooze"
const SNOOZE_HINT_PREFIX = "snooze:"

// The prompt is part of the generation id, not just the instant: editing the follow-up on an
// already-due snooze must mint a NEW delivery rather than collide with the enqueued one's message.
function snoozeFenceId(until: string, prompt: string): string {
  const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 16)
  return `${SNOOZE_FENCE_PREFIX}:${until}:${digest}`
}
function isSnoozeFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SNOOZE_FENCE_PREFIX}:`)
}

interface ArmedSnooze {
  until: string
  untilMs: number
  prompt: string
  fenceId: string
}
// A row's CURRENT scheduled bump, if it has one. A snooze without a prompt is the historical reminder
// (the board owns its expiry) and never reaches the waker.
function armedSnooze(row: Pick<SessionRow, "snoozed_until" | "snooze_prompt">): ArmedSnooze | undefined {
  const until = row.snoozed_until
  const prompt = row.snooze_prompt?.trim()
  if (!until || !prompt) return undefined
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs)) return undefined
  return { until, untilMs, prompt, fenceId: snoozeFenceId(until, prompt) }
}

// ---- SOURCE 4: THE RECURRING PROMPT, ON SCHEDULE --------------------------------------------------
// SOURCES 4 and 5 are two TRIGGERS on ONE stored prompt (`recurring_*`), not two features. They stayed
// two scheduler passes through the merge because they genuinely do not fold together: this one keys its
// delivery id on (generation, beat index) and must NOT filter on rest, while SOURCE 5 keys on
// (generation, rest instant) and must. One pass with a mode flag would be both of them wearing an if.
//
// THE DUMB TRIGGER: a prompt on a chosen clock. It consults nothing about the thread — not rest, not
// `--awaiting`, not sub-agents, not shells. If the interval has elapsed, a delivery is queued, and it
// GOES OUT whether or not the thread is mid-turn (`isDeliverableNow`, which carries the transport
// detail). It is the only source that does not wait for rest, and that is the feature.
//
// It is the sibling of SOURCE 5, not a rival: the rest trigger asks "you stopped — is there more?" and
// only a thread that stops ever hears it; this one asks "it has been an hour" and a thread hears it an
// hour later, working or not. An operator who needs a thread revisited on a schedule regardless of what
// the agent is doing needs this one.
//
// It also remains the only recurring wake a worker CAN have. Claude Code's own `CronCreate` /
// `ScheduleWakeup` cannot fire in the runtime ntwine spawns: their gate stays shut while ANY background
// task is outstanding, so the thread most in need of a nudge — one parked behind a sub-agent that will
// never report — is exactly the one whose cron is dead (measured 2026-08-01: 3 fires in 150s with no
// background work, 0 with a background shell alive). Riding ntwine's outbox sidesteps that entirely.
//
// Its record of intent is the session row, with `recurring_armed_at` as the GENERATION: re-arming mints
// a new one, so a delivery still in the outbox under the old settings reads as superseded.
//
// It never ABORTS the turn it lands in. Both transports accept a mid-turn message as an ordinary
// queued/steered input, so the running work finishes and the prompt is read at the next sampling
// boundary — which is what "fires on its cadence" means, and is also the only reading compatible with
// ntwine's completion invariant.
//
// THE FENCE PREFIXES ARE THE PRE-MERGE ONES, on purpose. They are internal delivery-id namespaces that
// nothing outside this file reads, and renaming them would reclassify every delivery already sitting in
// a live outbox as an unknown fence across the upgrade — real churn to buy a nicer string.
const HEARTBEAT_FENCE_PREFIX = "heartbeat"
const HEARTBEAT_HINT_PREFIX = "heartbeat:"

// The generation is (armed_at, beat index). The index advances only once the previous delivery is
// TERMINAL, so a thread accumulates exactly one pending scheduled prompt rather than one per interval —
// an agent handed an hour of backlog at once is its own denial of service.
function heartbeatFenceId(armedAt: string, beat: number): string {
  return `${HEARTBEAT_FENCE_PREFIX}:${armedAt}:${beat}`
}
function isHeartbeatFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:`)
}

interface ArmedSchedule {
  prompt: string
  intervalMs: number
  armedAt: string
  /** When the next one becomes due: an interval after the last delivered one, else after arming. */
  dueAtMs: number
}

type RecurringRow = Pick<
  SessionRow,
  | "recurring_prompt" | "recurring_on_rest" | "recurring_on_schedule" | "recurring_on_compact"
  | "recurring_interval_ms" | "recurring_armed_at"
  | "recurring_rest_fired_at" | "recurring_schedule_fired_at" | "recurring_compact_fired_at"
  | "recurring_runs" | "recurring_max_runs" | "recurring_until_at" | "recurring_stop_reason"
>

// ---- WHAT A PENDING QUESTION DOES TO THE THREE TRIGGERS -------------------------------------------
// NOTHING, as of 2026-08-16. A Goal fires over an unanswered question fence, a native ask and a
// permission prompt alike, on every trigger, and there is no setting that changes it.
//
// THAT IS A DELETION, not a default flip. The row carried a `recurring_pause_on_questions` column and the
// footer panel showed it inverted as an "Autonomous mode" switch; both are gone. Maintainer 2026-08-16:
// "I feel like the stop hook should just fire even when there are open questions, unconditionally, and we
// could just drop the AutonomousMode toggle… If somebody enables the stop hook goal, then that kind of
// implies to me that they don't really want to answer any more questions." Arming a Goal IS the consent
// the switch used to collect, so collecting it twice only bought a way to get it wrong — and the hold's
// original job (a half-finished thread resting silently, with nobody to bring it back) belongs to the
// built-in sign-off nudge now (SOURCE 9), which fires on exactly the rests that need it.
//
// WHAT STILL STOPS A BUMP is `restMessageIsSignedOff` below, and it is about the FENCE rather than about
// questions: the stop hook asks "you stopped — is there more?", and a ```done or an ```awaiting on a wait
// somebody else owns has already answered it in the very message that ENDED the turn. Firing over either
// is the trigger talking to itself. A ```question fence used to be a third limb of that rule and no
// longer is — it is an answer only for a thread that is waiting on a human, and a thread carrying a Goal
// is not.
//
// Its two surviving limbs reach different distances. A ```done fence ends the arrangement, so it also
// stops the HEARTBEAT (`saidDone`) — it is the successor to the ALLDONE sentinel and inherits its reach
// exactly. A parked ```awaiting stops the stop hook alone: the heartbeat asks "it has been an hour" and
// the compaction trigger asks "your context is gone", and a PR nobody has reviewed is an answer to
// neither. A `human:` gate stays held for the same reason it always did — bumping one is measured harm
// (see `parkedOnAWaitItCannotAdvance`) and the fix for it is the operator, not a bump.
//
// THE BUMP THAT CROSSES A QUESTION SAYS SO. A worker handed the bare goal on top of its own unanswered
// question re-asks it, correctly — so `restPromptMessage(prompt, {overQuestion:true})` tells it no answer
// is coming and to record the call instead. Without that clause this would produce the duplicate queue
// card the old hold existed to prevent, rather than the forward motion asked for.
//
// THE `done` CARVE-OUT IS THE LOOP'S OFF SWITCH, and is the one thing here that is not negotiable: the
// delivered trailer tells the worker to sign off with `done` to stop the prompts, so a goal that kept
// firing over a `done` fence would be a loop with no terminating condition that ntwine had also promised
// terminates. Predictability cuts the other way here — an unconditional trigger is only simpler until it
// is the thing reopening finished threads.

/** The thread SIGNED OFF: the message that ended the turn declares the work finished.
 *
 *  That is the ```done fence as of 2026-08-11, and the legacy `ALLDONE` sentinel for as long as sessions
 *  dispatched before the change are still running — they were told to reply it, and dropping the
 *  recogniser the same day would take their exit away and loop them forever.
 *
 *  Needs no stored state: both facts are folded off the FINAL assistant message, so either holds for
 *  exactly as long as that message is the thread's last word, and anything said afterwards re-opens the
 *  loop by itself. */
function saidDone(tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone">): boolean {
  return tele.lastFence?.kind === "done" || tele.lastAssistantAllDone === true
}

/** The same question, asked of a thread rather than of a message — because since 2026-08-27 a worker
 *  signs off by CALLING `done`, and a tool call cannot write the tailer's `lastFence`.
 *
 *  Without this the arrangement outlived the sign-off it was built to end: a worker that used the verb
 *  instead of the fence kept being woken at every rest, forever, by a Goal it had explicitly finished
 *  with. `registeredDoneFence` carries the same lifetime the board reads it by: the done stands through a
 *  prose-only human reply, and the loop reopens once the worker runs a tool after the human spoke, or
 *  once the turn that answered the human failed. */
function threadSaidDone(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone" | "lastUserAt" | "lastToolCallAt" | "lastAssistantAt" | "apiFault">,
  armedAt?: string | null,
): boolean {
  const registered = registeredDoneFence(storage.getThreadDone(slug), tele.lastUserAt, tele.lastToolCallAt, tele) !== undefined
  const fenced = saidDone(tele)
  if (!registered && !fenced) return false
  return !armReopenedTheLoop(storage, slug, tele, registered, fenced, armedAt)
}

/** ARMING A GOAL AFTER THE SIGN-OFF IS THE HUMAN REOPENING THE LOOP — and it is the one form of "new
 *  work from the human" that `threadSaidDone` could not see.
 *
 *  Both sign-off readings above take their lifetime from the human's last word in the TRANSCRIPT
 *  (`lastUserAt` for a registered done, the final assistant message for a fenced one). Arming a Goal
 *  writes no transcript record, so a human who armed one on a thread that had already signed off got a
 *  panel reading "Goal (on)" over a trigger that could never fire: the rest pass and the beat both
 *  declined, nothing in the UI said why, and the only way out was to type a message. Observed
 *  2026-09-05 on `design-nub-static-server` — the worker registered a done at 23:00:44Z, the human
 *  re-armed at 23:20:54Z, and the thread sat there while its operator read it as frozen.
 *
 *  The comparison is against the sign-off the arm is meant to override — the registered done's own
 *  instant, and (for a fenced one, which carries no instant of its own) the message that holds it,
 *  whichever is later. An arm OLDER than the sign-off changes nothing, which is the ordinary case and
 *  the one that keeps the loop terminable: a worker signs off under a Goal armed long before, and that
 *  done still ends the arrangement. Each re-arm reopens exactly once — the worker's next sign-off is
 *  necessarily later than it, so it silences the loop again. */
function armReopenedTheLoop(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastAssistantAt">,
  registered: boolean,
  fenced: boolean,
  armedAt: string | null | undefined,
): boolean {
  const armed = armedAt ? Date.parse(armedAt) : Number.NaN
  if (!Number.isFinite(armed)) return false
  let signedOffAt = Number.NEGATIVE_INFINITY
  if (registered) {
    const doneAt = storage.getThreadDone(slug)?.doneAt
    if (doneAt !== undefined) signedOffAt = Math.max(signedOffAt, doneAt)
  }
  if (fenced) {
    const fencedAt = Date.parse(tele.lastAssistantAt ?? "")
    // A fenced done with no readable instant cannot be dated, so it is never overridden — declining to
    // reopen is the direction that cannot loop.
    if (!Number.isFinite(fencedAt)) return false
    signedOffAt = Math.max(signedOffAt, fencedAt)
  }
  return Number.isFinite(signedOffAt) && armed > signedOffAt
}

/** This thread's ARMED timer ids — the other registry a \`timers:\` line is checked against — with the
 *  threads its reply waits are on, which a \`threads:\` line is checked against (armedTimerKeys). */
function armedTimerIdsOf(storage: Storage, slug: string): ReadonlySet<string> {
  return armedTimerKeys(storage.listThreadTimers(slug, { armedOnly: true }))
}

/** This thread's armed timers as the nudge and the corrections list them: a REPLY WAIT under the thread it
 *  waits on, by the `@handle` a \`threads:\` line names, and every other timer by its id. */
function timerOpsOf(storage: Storage, slug: string): Pick<SignoffLiveOps, "timers" | "threads"> {
  const timers: { id?: string; label: string }[] = []
  const threads: { id?: string; label: string }[] = []
  for (const t of storage.listThreadTimers(slug, { armedOnly: true })) {
    const reply = replyWaitOf(t.prompt)
    if (reply) threads.push({ id: `@${reply.handle}`, label: `a reply from @${reply.handle}` })
    else timers.push({ id: t.id, label: t.prompt.trim().replace(/\s+/g, " ").slice(0, 80) })
  }
  return { timers, threads }
}

/** The stop hook asks "you stopped — is there more?", and this is the message that ALREADY ANSWERED it:
 *  the thread declared itself finished, or it parked on a wait somebody else owns. Firing over either is
 *  the trigger talking to itself.
 *
 *  A PENDING QUESTION IS NOT ONE OF THEM, since 2026-08-16 — see the header block. It was a third limb,
 *  switchable off by the panel's "Autonomous mode", and the switch and the limb went together.
 *
 *  `armedAt` is the Goal's own generation, and it reaches the done reading only — see
 *  `armReopenedTheLoop`. An `awaiting` fence is untouched by it: that park says what the rest is
 *  waiting for, which re-arming answers nothing about. */
function restMessageIsSignedOff(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone" | "bgShells" | "subAgents">,
  _registeredPrWatches: ReadonlySet<string> = new Set(),
  _armedTimerIds: ReadonlySet<string> = new Set(),
  armedAt?: string | null,
): boolean {
  // AN `awaiting` FENCE ENDS THE GOAL'S BUSINESS WITH THIS REST, honoured or not — and the "or not" is
  // the whole point of widening this from `parkIsHonoured` to the fence's mere presence.
  //
  // The scheduler already owns an awaiting rest in BOTH directions: a park it can honour needs nothing,
  // and one it cannot gets SOURCE 12, which names exactly what is wrong and how to fix it. The Goal
  // firing on top of that is a second bump for one rest, and its text is a generic "keep going" that says
  // nothing about fence grammar — so a worker whose fence is unhonourable cannot learn anything from it.
  //
  // MEASURED, and it is a tight loop rather than a nuisance (2026-08-17, thread
  // `we-need-to-unify-some-development`): a worker on the OLD contract wrote `pr-watch: pullfrog/app#1221`,
  // a kind the grammar cut deleted. Zero hints parse, so the park was never honourable, so the Goal fired
  // ~6s after every rest — three identical fences in 40 seconds, each one re-writing the same dead line
  // because nothing it received mentioned the grammar. Holding the Goal here leaves SOURCE 12 as the one
  // voice on that rest, which is the voice that can actually get the worker out.
  //
  // A worker that writes a garbage fence is therefore NOT left alone: it is bumped once per rest, by the
  // source whose message is about fences.
  if (tele.lastFence?.kind === "awaiting") return true
  return threadSaidDone(storage, slug, tele, armedAt)
}

/** The rest parked on a wait THIS TRIGGER CANNOT ADVANCE: an `awaiting` fence naming a durable wake the
 *  scheduler itself will deliver — a registered PR (`prs:`) or an armed timer (`timers:`).
 *
 *  IT USED TO FIRE OVER THESE, on the reasoning that the stop hook is the one thing that rescues a
 *  thread parked behind something that will never report. That rescue is real, and it is kept below —
 *  but it never applied to these two shapes, and firing over them was a self-feeding loop rather than a
 *  rescue. Measured on the maintainer's own board 2026-08-12 (project zod): a worker parked on
 *  `pr-watch:` on a Zod PR (#6382) was bumped 7 times in 46 minutes, each bump costing a turn whose only
 *  product was the SAME fence reworded, because "keep going" has no answer while a PR sits unreviewed. A
 *  second thread added `human: maintainer to merge — the task barred me from merging` and was bumped anyway,
 *  until it escaped the loop the only way left to it: a ```done fence on a PR nobody had merged. The
 *  trigger corrupted the signal it exists to produce.
 *
 *  WHAT STILL GETS THE RESCUE: an `awaiting` fence with no items at all, an unparseable PR ref, a timer
 *  id matching no armed row — every park ntwine has no way to fire. Those are the threads that genuinely
 *  wait forever, and this reads the SAME predicates the waker's own passes fire from, so the hold and the
 *  wake can never disagree about which is which.
 *
 *  A PR ENTRY IS THE ONE THAT NEEDS A SECOND FACT, since 2026-08-14: the fence no longer arms anything,
 *  so naming a PR says nothing about whether a wake is coming. A REGISTERED watcher
 *  (`ntwinectl watch-pr`) will fire, so the Goal holds; a `prs:` entry with no registration behind it
 *  is a park ntwine cannot honour, so it gets the rescue like any other unfireable item. Without the first
 *  half this reintroduces the measured loop above verbatim.
 *
 *  (The quoted incident keeps the spelling of its day: `pr-watch:` was the fence key until 2026-08-15,
 *  and the singular `pr:` until the YAML cutover on 2026-08-24. Both are retired — see
 *  RETIRED_AWAITING_KINDS — and neither parses now.) */
function parkedOnAWaitItCannotAdvance(
  tele: Pick<SessionTelemetry, "lastFence" | "bgShells" | "subAgents">,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
): boolean {
  const fence = tele.lastFence
  if (fence?.kind !== "awaiting") return false
  // A REAL PARK, checked, not merely asserted. Three things have to hold: it names at least one item, it
  // carries a usable `for:`, and EVERY item it names is something ntwine can currently see. Anything else
  // is a wait that cannot resolve, and gets the rescue — which is the whole reason the grammar became
  // structural. Before this, a worker could park indefinitely on `human: Alice` or on an instant already
  // in the past, and ntwine had no way to tell the difference from a healthy wait.
  return parkIsHonoured(readAwaitingPark(fence.hints), liveActivityOf(tele, registeredPrWatches, armedTimerIds))
}

/** The PRs a thread has actually registered, by `owner/repo#N`. Read where the Goal decides whether to
 *  bump, because a declaration alone no longer means a wake is coming. */
function registeredPrWatchesOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listPrWatches(slug, { armedOnly: true }).filter((w) => w.kind !== "issue").map((w) => `${w.owner}/${w.repo}#${w.number}`))
}

/** This thread's ARMED command watch ids (`ntwinectl watch-command`) — what a `commands:` entry is
 *  checked against. Only ARMED: a watch that passed has delivered its wake, and one that expired or was
 *  cancelled will never send one, so a park naming either is waiting on nothing. */
function armedCommandWatchIdsOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listCommandWatches(slug, { armedOnly: true }).map((w) => w.id))
}

/** The same set as the nudge and the corrections print it: the id, and the command as its label. */
function commandWatchOps(storage: Storage, slug: string): { id: string; label: string }[] {
  return storage.listCommandWatches(slug, { armedOnly: true })
    .map((w) => ({ id: w.id, label: w.command.trim().replace(/\s+/g, " ").slice(0, 80) }))
}

// A row's live ON SCHEDULE trigger, if it has one. A switched-off trigger deliberately reads as ABSENT
// here — off must stop new deliveries AND drop queued ones — while the row keeps the text and the
// cadence so switching it back on resumes the same schedule rather than making anyone re-enter it.
function armedSchedule(row: RecurringRow): ArmedSchedule | undefined {
  const prompt = row.recurring_prompt?.trim()
  const intervalMs = row.recurring_interval_ms
  const armedAt = row.recurring_armed_at
  if (!prompt || !intervalMs || intervalMs <= 0 || !armedAt) return undefined
  if (row.recurring_on_schedule !== 1) return undefined
  const anchor = Date.parse(row.recurring_schedule_fired_at ?? armedAt)
  if (!Number.isFinite(anchor)) return undefined
  return { prompt, intervalMs, armedAt, dueAtMs: anchor + intervalMs }
}

// ---- SOURCE 5: THE RECURRING PROMPT, ON REST -----------------------------------------------------
// The SAME stored text as SOURCE 4, delivered every time the thread STOPS — which is the event an
// operator actually means when they want one to keep going.
//
// There is no cadence here and nothing to get wrong. An earlier interval-based version of this idea was
// removed 2026-08-02 for exactly that reason: an operator who wants "keep going until X" has no idea
// what number to put in a box. A thread that stops gets the text, and one that never stops never needed
// it — that thread is SOURCE 4's job.
//
// The loop's OFF SWITCH belongs to the worker, and it is the one part of this that is not optional. A
// rest trigger with no terminating condition is an infinite bump generator, so the delivered text
// carries a trailer (shared `restPromptMessage`) teaching the worker to sign off with a ```done fence
// when the work is genuinely finished. The tailer folds that fence onto the final message (`lastFence`)
// and this pass simply declines to fire while it stands — no state to write, and it re-opens by itself
// the moment the thread produces any other final message. See `saidDone`, which also still honours the
// legacy `ALLDONE` sentinel for sessions dispatched before 2026-08-11.
//
// Same generation as SOURCE 4 (`recurring_armed_at`), because it is the same prompt: editing the text
// supersedes a delivery queued for the old words on BOTH triggers at once.
const STOP_HOOK_FENCE_PREFIX = "stophook"
const STOP_HOOK_HINT_KEY = "stophook:rest"

// The rest a delivery is bound to: the AGENT'S OWN last word.
//
// It was `lastActivityAt`, the thread's high-water mark over ANY record, and that was a self-feeding
// loop for a thread whose worker is gone. ntwine speaks as the USER, so a delivered bump lands in the
// transcript and advances the high-water mark — minting a new "rest" that nobody rested, and with it a
// new delivery id. Measured 2026-08-12 on a real stack with the worker absent: 10 bumps in 100 seconds,
// climbing. It was survivable while a Goal was something an operator opted into on one thread; it stopped
// being survivable when every dispatched thread started carrying one.
//
// `lastAssistantAt` keeps the property that made the old key work — a genuine new rest necessarily
// carries a new one, so "at most one per rest" still falls out of delivery-id uniqueness — and adds the
// one ntwine needs: nothing ntwine says can move it. A thread with no assistant output yet has never
// rested.
function stopHookFenceId(armedAt: string, restedAt: string): string {
  return `${STOP_HOOK_FENCE_PREFIX}:${armedAt}:${restedAt}`
}
function isStopHookFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:`)
}

interface ArmedRest {
  prompt: string
  armedAt: string
}

// A row's live ON REST trigger, if it has one. Switched off reads as ABSENT, exactly as for the
// schedule, and for the same reason.
function armedRest(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_rest !== 1) return undefined
  return { prompt, armedAt }
}

// ---- SOURCE 7: THE RECURRING PROMPT, ON COMPACTION -----------------------------------------------
// The THIRD trigger on the same stored text (2026-08-06), delivered every time the harness summarizes
// the thread's context away.
//
// WHY IT IS A TRIGGER AND NOT A HOOK. Compaction is the largest source of context loss there is, and
// ntwine used to answer it by having a worker-side hook splice the head of a canonical `scratch.md` into
// the emptied window. That made the pad a load-bearing file every worker had to maintain whether or not
// it wanted one. The recurring prompt already solves the same problem better: the worker writes whatever
// doc it likes in its scratch directory and LINKS it here, and the link comes back at exactly the moment
// the context is gone. The row is durable, it is visible in the thread's Goal panel, and the operator can edit
// it — none of which a hook injection was.
//
// IT DOES NOT WAIT FOR REST, and that is the one place it deliberately parts company with SOURCE 5. A
// compaction lands MID-TURN: the worker is still working, and the whole value is re-grounding it before
// its next tool call rather than after it has finished acting on a summary. So this takes the SCHEDULE
// trigger's delivery gate, not the rest trigger's.
//
// Same generation (`recurring_armed_at`) as its two siblings, because it is the same prompt.
const COMPACT_FENCE_PREFIX = "compact"
const COMPACT_HINT_KEY = "recurring:compaction"

// The compaction a delivery is bound to. A new compaction necessarily carries a new instant, so "at most
// one per compaction" falls out of delivery-id uniqueness — the same trick the rest trigger plays with
// `lastActivityAt`, and the reason neither needs a counter.
function compactFenceId(armedAt: string, compactedAt: string): string {
  return `${COMPACT_FENCE_PREFIX}:${armedAt}:${compactedAt}`
}
function isCompactFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:`)
}

// A row's live ON COMPACTION trigger, if it has one. Switched off reads as ABSENT, same as the others.
function armedCompact(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_compact !== 1) return undefined
  return { prompt, armedAt }
}

// ---- THE GOAL'S LIMITS: WHERE A LOOP ENDS ---------------------------------------------------------
// A Goal may carry a run cap and/or a time bound (2026-09-29; storage.ts SessionRow has the columns).
// Reaching either DISARMS it — every trigger off, the text kept — and the worker hears exactly ONE wake
// saying which limit ended it. Without limits nothing below applies and the Goal is as unbounded as it
// always was; the ```done fence and the worker's own `stop` remain the other two exits.
//
// WHERE THE COUNT IS CHECKED. The run count moves when a delivery is SENT to a live runtime or otherwise
// established as delivered (see `countGoalDelivery` for why the send itself has to count), and the cap
// is applied right there, in the same call — not on the next tick. That ordering is the whole guarantee of "exactly N": a sibling
// trigger's delivery already sitting in the outbox reaches `deliveryContext` after the disarm and reads
// as superseded, instead of slipping out as run N+1 later in the same tick. The time bound has no event
// to hang on, so `evalGoalLimits` checks it at the top of every tick, before any trigger's pass runs.
//
// THE WAKE IS ONE PER GENERATION BY CONSTRUCTION: its delivery id is keyed on the generation alone, and
// `stopRecurringAtLimit` only succeeds on a row not already stopped. It waits for REST like most wakes —
// the last run is still being worked when the cap is reached, and the news is for after that run, not an
// interruption of it.
const GOAL_END_FENCE_PREFIX = "goalend"
function goalEndFenceId(armedAt: string): string {
  return `${GOAL_END_FENCE_PREFIX}:${armedAt}`
}
function isGoalEndFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${GOAL_END_FENCE_PREFIX}:`)
}

/** Which limit this LIVE Goal has reached, if any. A row with every trigger off, no generation, or one
 *  already stopped has nothing left to stop. */
/** THE GOAL STOPS AT THE THREAD'S DEADLINE (ARCHITECTURE.md § Time limits). A stop-hook Goal that
 *  keeps saying "keep going" past the limit would undo the limit, so no trigger delivers once the
 *  deadline has passed — the rest, the clock and the compaction trigger alike. It is a HOLD, not a stop:
 *  the Goal stays armed and its own `for:` and run cap are untouched, so a human who extends the deadline
 *  has the Goal back as it was. */
function pastDeadline(row: Pick<SessionRow, "deadline_at" | "deadline_set_at">, nowMs: number): boolean {
  const atMs = row.deadline_at && row.deadline_set_at ? Date.parse(row.deadline_at) : Number.NaN
  return Number.isFinite(atMs) && nowMs >= atMs
}

function goalLimitHit(row: RecurringRow, nowMs: number): "runs" | "time" | undefined {
  if (!row.recurring_prompt?.trim() || !row.recurring_armed_at || row.recurring_stop_reason) return undefined
  if (row.recurring_on_rest !== 1 && row.recurring_on_schedule !== 1 && row.recurring_on_compact !== 1) return undefined
  const max = row.recurring_max_runs
  if (typeof max === "number" && max > 0 && (row.recurring_runs ?? 0) >= max) return "runs"
  const until = Date.parse(row.recurring_until_at ?? "")
  if (Number.isFinite(until) && nowMs >= until) return "time"
  return undefined
}

// ---- SOURCE 6: THE WORKER'S ONE-OFF TIMERS -------------------------------------------------------
// The heartbeat with the repetition taken out: text the worker asked to be handed back at ONE instant,
// once. A thread may hold arbitrarily many, so unlike every other source here the record of intent is a
// TABLE (`thread_timer`) rather than a column on the session row — a row can hold one arrangement, and
// "check the deploy in 10 min AND re-read the spec in an hour" is two.
//
// It inherits the SCHEDULE trigger's delivery gate rather than the snooze's, deliberately: a timer set
// for 15:00 that a busy thread only hears at 15:50 has not kept the promise it made, and "in ten
// minutes" is the instruction being obeyed. See `isDeliverableNow`.
//
// It does NOT inherit the sign-off opt-out. That exists because a recurring trigger is an
// infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, and a
// worker that scheduled an alarm and then said "nothing further right now" still wants the alarm.
//
// The GENERATION is the timer id itself — each row is armed once and never edited, so a delivery can
// only be superseded by the row leaving the `armed` state (the worker cancelled it, or it already
// fired). That is also what makes the row's own state, not the outbox, the durable "never twice" guard:
// terminal outbox rows are pruned past a cap, while `state = 'fired'` is permanent.
const TIMER_FENCE_PREFIX = "timer"
const TIMER_HINT_PREFIX = "timer:"

// Every delivery-id namespace here is safe against its neighbours: no prefix minted below is a prefix
// of another, and a source that mints an id outside all of them is superseded by `deliveryContext`'s
// tail rather than delivered. (A registered watcher is scheduler SOURCE 8; the built-in sign-off nudge
// is SOURCE 9, and it carries its own consecutive cap.)
/** A finished background shell's delivery namespace. The shell's own launch tool_use id is the whole
 *  key, so one shell can wake its thread exactly once, ever — no counter, no cursor, no way to loop. */
const SHELL_FENCE_PREFIX = "shell"
function shellFenceId(toolUseId: string): string {
  return `${SHELL_FENCE_PREFIX}:${toolUseId}`
}
function isShellFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SHELL_FENCE_PREFIX}:`)
}

/** A terminal-wait wake's namespaces (SOURCE 17): `terminal:<slug>:<run>:<event>` when a terminal its thread
 *  waits on reached a prompt or ended, `terminal-watch-expired:<trw_…>` when the watch lapsed first. */
const TERMINAL_FENCE_PREFIX = "terminal"
const TERMINAL_WATCH_EXPIRED_FENCE_PREFIX = "terminal-watch-expired"
/** `terminal:<id>:control-note:<at>` — a control move told to a thread mid-turn, rather than a wake. */
const TERMINAL_NOTE_MARK = ":control-note:"
function isTerminalWaitFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${TERMINAL_FENCE_PREFIX}:`) || fenceId.startsWith(`${TERMINAL_WATCH_EXPIRED_FENCE_PREFIX}:`)
}

/** An over-budget background shell's delivery namespace (SOURCE 13). Keyed on the DEADLINE as well as
 *  the shell, because the deadline is the generation: an `extend_shell` moves it, which both supersedes a
 *  warning still queued for the old one and earns the new one its own warning. The deadline leads so the
 *  shell id — an opaque runtime string — can hold anything. (`shell-budget:` is not a `shell:` prefix, so
 *  the completion namespace above never claims one of these.) */
const SHELL_BUDGET_FENCE_PREFIX = "shell-budget"
function shellBudgetFenceId(shellId: string, deadlineMs: number): string {
  return `${SHELL_BUDGET_FENCE_PREFIX}:${deadlineMs}:${shellId}`
}
function isShellBudgetFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SHELL_BUDGET_FENCE_PREFIX}:`)
}
function parseShellBudgetFenceId(fenceId: string): { shellId: string; deadlineMs: number } | undefined {
  const m = /^shell-budget:(\d+):(.+)$/.exec(fenceId)
  return m ? { deadlineMs: Number(m[1]), shellId: m[2]! } : undefined
}

/** The delivery namespace of an INTERRUPT that ended background sub-agents (SOURCE 10). Keyed on the
 *  interrupt's own instant: one interrupt, one note, however many children it took with it. The router
 *  enqueues it (followUp `interrupt` / deliverQueuedNow) once the tailer has confirmed the children are
 *  gone; the scheduler only delivers. Bound to a FACT, like a shell completion — nothing the thread
 *  writes can make "those sub-agents ended" untrue — and deliverable INTO the busy turn, because the
 *  worker is mid-turn on the very follow-up that killed them and would otherwise rest on a dead id. */
const INTERRUPT_ENDED_FENCE_PREFIX = "interrupt-ended"
function isInterruptEndedFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${INTERRUPT_ENDED_FENCE_PREFIX}:`)
}

export function enqueueInterruptEndedWake(
  storage: Storage,
  input: { slug: string; sessionId: string; interruptedAtMs: number; agents: readonly InterruptEndedSubAgent[]; nowMs?: number },
): void {
  if (input.agents.length === 0) return
  const fenceId = `${INTERRUPT_ENDED_FENCE_PREFIX}:${input.interruptedAtMs}`
  createWakeDeliveryStore(storage.scope).enqueue({
    id: wakeDeliveryId(input.slug, input.sessionId, fenceId),
    slug: input.slug,
    sessionId: input.sessionId,
    fenceId,
    hintKey: fenceId,
    message: interruptEndedSubAgentsMessage(input.agents),
    reason: `an interrupt ended ${input.agents.length} background sub-agent(s)`,
  }, input.nowMs ?? Date.now())
}

/** A message from ANOTHER THREAD (`ntwinectl message-thread`, thread-mentions.ts). Keyed on a fresh id
 *  per message, because every message is news of its own. Bound to a FACT — the other thread said it —
 *  so nothing this thread writes supersedes it, and deliverable INTO a busy turn exactly like a human's
 *  steer: the sender is often waiting on the answer, and the recipient's own work is not interrupted,
 *  only joined at its next sampling boundary. Exempt from the quiet window for the same reason. */
const THREAD_MESSAGE_FENCE_PREFIX = "thread-message"
function isThreadMessageFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${THREAD_MESSAGE_FENCE_PREFIX}:`)
}

export function enqueueThreadMessageWake(
  storage: Storage,
  input: { slug: string; sessionId: string; fromSlug: string; message: string; nowMs?: number },
): string {
  const fenceId = `${THREAD_MESSAGE_FENCE_PREFIX}:${randomUUID()}`
  const id = wakeDeliveryId(input.slug, input.sessionId, fenceId)
  createWakeDeliveryStore(storage.scope).enqueue({
    id,
    slug: input.slug,
    sessionId: input.sessionId,
    fenceId,
    hintKey: fenceId,
    message: input.message,
    reason: `a message from thread ${input.fromSlug}`,
  }, input.nowMs ?? Date.now())
  return id
}

/** THE HUMAN MOVED THE CLOCK (router setThreadDeadline → deadline.ts deadlineNoticeMessage). Bound to the
 *  change still standing: a set is keyed on the generation it minted (`set:<deadline_set_at>`) and
 *  superseded the moment the deadline moves again, a clear (`clear:<instant>`) the moment one is set
 *  again — so two quick edits deliver the second only. Deliverable INTO a busy turn like a typed steer,
 *  and exempt from the quiet window: it is the human's act, and the worker plans by it. */
const DEADLINE_NOTICE_FENCE_PREFIX = "deadline-notice"
function isDeadlineNoticeFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${DEADLINE_NOTICE_FENCE_PREFIX}:`)
}

export function enqueueDeadlineNoticeWake(
  storage: Storage,
  input: { slug: string; sessionId: string; setAt: string | null; message: string; nowMs?: number },
): void {
  const nowMs = input.nowMs ?? Date.now()
  const fenceId = `${DEADLINE_NOTICE_FENCE_PREFIX}:${input.setAt ? `set:${input.setAt}` : `clear:${nowMs}`}`
  // Every ntwine wake carries the clock line, and send re-reads it (restampedWakeMessage) — but only on a
  // message that already has one, so it is stamped here, with the deadline as it now stands.
  const clock = wakeTimeHeader(nowMs, null, rowDeadline(storage.getSession(input.slug))?.atMs)
  createWakeDeliveryStore(storage.scope).enqueue({
    id: wakeDeliveryId(input.slug, input.sessionId, fenceId),
    slug: input.slug,
    sessionId: input.sessionId,
    fenceId,
    hintKey: fenceId,
    message: `${input.message}\n\n${clock}`,
    reason: input.setAt ? `the human set the time limit (${input.setAt})` : "the human removed the time limit",
  }, nowMs)
}

/** A DEADLINE CHECK-IN (SOURCE 15, evalDeadlines): `deadline:<generation>:<stage>`. The generation is
 *  `deadline_set_at`, so moving the deadline supersedes a check-in still queued for the old one and earns
 *  the new one its own set. (`deadline:` is not a `deadline-notice:` prefix, nor the reverse.) */
const DEADLINE_FENCE_PREFIX = "deadline"
function deadlineFenceId(setAt: string, stage: DeadlineStage): string {
  return `${DEADLINE_FENCE_PREFIX}:${setAt}:${stage}`
}
function isDeadlineFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${DEADLINE_FENCE_PREFIX}:`)
}
/** The generation and stage a check-in id was minted for. Split at the LAST colon — the generation is an
 *  ISO instant and carries colons of its own. */
function parseDeadlineFenceId(fenceId: string): { setAt: string; stage: string } | undefined {
  if (!isDeadlineFenceId(fenceId)) return undefined
  const body = fenceId.slice(DEADLINE_FENCE_PREFIX.length + 1)
  const cut = body.lastIndexOf(":")
  return cut < 0 ? undefined : { setAt: body.slice(0, cut), stage: body.slice(cut + 1) }
}

/** A registered PR watcher's delivery namespace. The id plus a monotonically-increasing REPORT number,
 *  because this watcher fires many times over one PR's life — the id alone would dedupe every wake after
 *  the first, which is exactly the bug a one-shot namespace would hide. */
const PR_WATCH_FENCE_PREFIX = "prwatch"
/** The same watcher's LAST word — its registration ran out. A separate namespace because it is a
 *  different piece of news from a report, and one-shot: the watcher is settled by the time it is sent. */
const PR_WATCH_EXPIRED_FENCE_PREFIX = "prwatch-expired"
function prWatchFenceId(watchId: string, report: number): string {
  return `${PR_WATCH_FENCE_PREFIX}:${watchId}:${report}`
}
function prWatchExpiredFenceId(watchId: string): string {
  return `${PR_WATCH_EXPIRED_FENCE_PREFIX}:${watchId}`
}
// BOTH spellings, and the expired one is why this cannot be a bare `startsWith(prefix + ":")`:
// `prwatch-expired:…` does NOT start with `prwatch:`, so it fell past every branch in deliveryContext()
// and into the awaiting-fence tail, which supersedes unconditionally. 7 expiry reports were enqueued and
// 0 delivered on the live board before anyone looked (2026-08-18).
function isPrWatchFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PR_WATCH_FENCE_PREFIX}:`) || fenceId.startsWith(`${PR_WATCH_EXPIRED_FENCE_PREFIX}:`)
}
/** A REGISTERED WATCH that ran out of `for:` — the `thread_watch` twin of the PR expiry above, and a
 *  separate namespace for the same reason: it is one-shot news about a row that is settled by the time
 *  it is sent. There is no `watch:` REPORT prefix beside it, because a watch has no report to make —
 *  evalShellCompletions already wakes a resting thread when its shell finishes, and a second wake for
 *  the same fact would be the duplicate noise that pass exists to avoid. */
const OWN_WATCH_EXPIRED_FENCE_PREFIX = "watch-expired"
function ownWatchExpiredFenceId(watchId: string): string {
  return `${OWN_WATCH_EXPIRED_FENCE_PREFIX}:${watchId}`
}
function isOwnWatchExpiredFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${OWN_WATCH_EXPIRED_FENCE_PREFIX}:`)
}

/** A COMMAND WATCH's wakes (SOURCE 16), one namespace per piece of news: it PASSED, its `for` ran out,
 *  or ntwine stopped it because the thread may no longer have commands run for it. Each is one-shot — the
 *  row is settled by the time the wake is sent — so the id alone is the key, and three prefixes rather
 *  than one so a watch that is cancelled and later re-registered under the same id (it cannot be; ids are
 *  random) could never dedupe against the wrong news. Checked as THREE spellings for the reason
 *  isPrWatchFenceId is: `cmdwatch-expired:` does not start with `cmdwatch:`. */
const COMMAND_WATCH_FENCE_PREFIX = "cmdwatch"
const COMMAND_WATCH_EXPIRED_FENCE_PREFIX = "cmdwatch-expired"
const COMMAND_WATCH_CANCELLED_FENCE_PREFIX = "cmdwatch-cancelled"
function isCommandWatchFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${COMMAND_WATCH_FENCE_PREFIX}:`)
    || fenceId.startsWith(`${COMMAND_WATCH_EXPIRED_FENCE_PREFIX}:`)
    || fenceId.startsWith(`${COMMAND_WATCH_CANCELLED_FENCE_PREFIX}:`)
}

/** A batch of question settlements handed over as one message. The ids are IN the key so a second
 *  answer on the same thread is its own piece of news rather than a duplicate the outbox dedupes away. */
const QUESTION_ANSWER_FENCE_PREFIX = "answers"
function questionAnswerFenceId(ids: readonly string[]): string {
  return `${QUESTION_ANSWER_FENCE_PREFIX}:${createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16)}`
}
function isQuestionAnswerFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${QUESTION_ANSWER_FENCE_PREFIX}:`)
}

/** HOW LONG A FAILED BATCH OF ANSWERS WAITS before it is offered again with nothing to say the worker can
 *  take it now. An answer is only `delivered` once the wake carrying it lands (evalQuestionAnswers), so a
 *  wake that exhausts its attempts leaves the answer undelivered rather than spent — and something has to
 *  decide when to try again. A restart of this server or a turn the worker ran since the failure opens
 *  the gate at once (each is evidence the runtime that refused it has changed); this is the floor for a
 *  thread where neither happens, so a transient failure — the 2026-09-30 broker resume race was one —
 *  costs the human half an hour rather than the answer. One retry round is the outbox's own attempt cap
 *  (`maxDeliveryAttempts`), so a permanently broken runtime pays that many attempts per window, not a
 *  loop on every tick. */
export const ANSWER_REOFFER_BACKOFF_MS = 30 * 60_000

/** The reason the outbox records on a row `deliveryContext` superseded — the session moved, or the thread
 *  was archived — as opposed to a delivery `resume` abandoned. evalQuestionAnswers reads it: a batch of
 *  answers superseded this way before anything crossed the transport is re-offered at once, because
 *  nothing about the runtime refused it. */
const CONTEXT_SUPERSEDED = "the exact awaiting fence or session was superseded"

/** How often a registered watcher re-reads GitHub, per PR. The fence poller's floor, for the same
 *  reason: this is somebody else's API and the answer changes on a human's timescale. */
const PR_WATCH_POLL_MS = 60_000

/** How many `gh` children the STATUS FALLBACK may have in flight at once (2026-09-04).
 *
 *  THE BOUND IS ON THE SUBPROCESS, NOT ON THE FAN-OUT, and that is the whole design. The poll fans out
 *  over every armed PR at once and must keep doing so: the GraphQL half coalesces those calls in a
 *  microtask into batches of 20, so an unbounded fan-out is ONE request where a fan-out capped at 8
 *  would be three — paying more of somebody else's rate limit to fix a problem the batch does not have.
 *  What is genuinely unbounded is `defaultFetchPr`, which is two `gh` children per PR; and because the
 *  GraphQL half fails for the WHOLE batch at once (an expired token, a network blip, a shape surprise),
 *  every ref reaches the fallback in the same tick or none does. That is the storm: N armed watchers
 *  becoming 2N `gh` processes inside one second, each of them several forks, once a minute for as long
 *  as the cause stands. Four at a time turns it into a queue. */
const PR_STATUS_FALLBACK_LIMIT = 4

/** A slot allocator: `run(fn)` waits until fewer than `limit` calls are in flight. The released slot is
 *  handed STRAIGHT to the next waiter rather than counted down and re-acquired, so a caller arriving in
 *  the same tick as a release cannot slip past the limit. */
function concurrencyGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

const SIGNOFF_FENCE_PREFIX = "signoff"
const SIGNOFF_HINT_KEY = "signoff:rest"
/** SOURCE 12's cap on CORRECTIVE bumps (nameless / retired / dead). Three, not two: there are three
 *  distinct corrections and a worker may legitimately need to be told about more than one. `expired` is
 *  uncounted — re-parking on still-running work is unlimited by explicit decision (2026-08-15). */
const PARK_BUMP_MAX = 3
// The kill switch (SIGNOFF_NUDGE_SETTING, board.ts) is not in the UI — this lands on every live thread
// at once, so there has to be a way to stop it that is not a code change. Absent (the default) means ON.

function signoffFenceId(restedAt: string): string {
  return `${SIGNOFF_FENCE_PREFIX}:${restedAt}`
}
function isSignoffFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SIGNOFF_FENCE_PREFIX}:`)
}

/** SOURCE 14's delivery namespace — `stray-shells:<sorted shell ids>`. Keyed on the SET of shells and
 *  nothing else, deliberately not on the rest: a worker that keeps a dev server on purpose and says so
 *  rests again on the same set, and the dedupe is what stops it being asked a second time. A NEW shell
 *  changes the set, so it is asked about in turn. */
const STRAY_SHELLS_FENCE_PREFIX = "stray-shells"
function strayShellsFenceId(shellIds: readonly string[]): string {
  return `${STRAY_SHELLS_FENCE_PREFIX}:${JSON.stringify([...shellIds].sort())}`
}
/** The shell keys a SOURCE 14 id was minted for. JSON rather than a join: a key can be a shell's LABEL
 *  (before its launch ack names an id), and a label may hold any separator. */
function strayShellsOf(fenceId: string): string[] {
  try {
    const ids: unknown = JSON.parse(fenceId.slice(STRAY_SHELLS_FENCE_PREFIX.length + 1))
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}
function isStrayShellsFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${STRAY_SHELLS_FENCE_PREFIX}:`)
}

/** The question a `thread_question` row asks, as one short line for a correction's list — the worker
 *  never saw the id ntwine minted, so the id alone would not tell it which question is meant. */
function questionLine(spec: string): string {
  try {
    const q = String((JSON.parse(spec) as { question?: unknown }).question ?? "").replace(/\s+/g, " ").trim()
    return q.length > 120 ? `${q.slice(0, 117)}…` : q
  } catch {
    return "(unreadable question)"
  }
}

/** SOURCE 12's delivery namespace — `park:<cause>:<the rest it corrects>`. The cause is in the key so a
 *  fence bumped for a dead id and later for expiry is two pieces of news rather than one deduped away. */
const PARK_FENCE_PREFIX = "park"
function parkFenceId(cause: string, spokeAt: string): string {
  return `${PARK_FENCE_PREFIX}:${cause}:${spokeAt}`
}
function isParkFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PARK_FENCE_PREFIX}:`)
}
/** The rest instant a correction was minted for. Sliced past the SECOND colon, never `split(":")[2]` —
 *  the value is an ISO instant and carries colons of its own. */
function parkFenceRestOf(fenceId: string): string {
  const cut = fenceId.indexOf(":", PARK_FENCE_PREFIX.length + 1)
  return cut < 0 ? "" : fenceId.slice(cut + 1)
}


function timerFenceId(timerId: string): string {
  return `${TIMER_FENCE_PREFIX}:${timerId}`
}
function isTimerFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${TIMER_FENCE_PREFIX}:`)
}
function timerIdOf(fenceId: string): string {
  return fenceId.slice(TIMER_FENCE_PREFIX.length + 1)
}

// Default gh-backed PR fetcher. Uses the USER'S `gh` (their auth) via execFile — NO shell. Any failure
// (gh missing → ENOENT, not authed / rate-limited → nonzero exit, malformed JSON) resolves to undefined
// so the tick logs + skips and NEVER crashes. Timeout-bounded so a hung gh can't wedge the scheduler.
/** The first line gh printed on stderr, or the process-level reason — what a worker or an operator can
 *  act on. `gh` names the cause in one line ("Could not resolve to a Repository…", "authentication
 *  required", "HTTP 404"); everything after it is stack and hint. */
export function conciseGhError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return "the `gh` CLI is not installed on the PATH of the process ntwine runs as"
  if ((err as { killed?: unknown })?.killed || code === "ETIMEDOUT") return "`gh` did not answer within 15s"
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string" ? (err as { stderr: string }).stderr : ""
  const line = stderr.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (line) return line.slice(0, 300)
  const message = err instanceof Error ? err.message : String(err)
  return message.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) || "unknown error"
}

export type PrProbe = { ok: true } | { ok: false; reason: string }

/** CAN NTWINE READ THIS PR AT ALL — asked at registration, so a watcher that could never fire is refused
 *  on the spot rather than armed. Reported 2026-08-25: a worker parked 12h+ on a watcher, and among the
 *  ways that happens is a PR the server's own `gh` cannot see (signed out on github.com, an SSO-gated
 *  org, a repo that does not exist, no `gh` on the daemon's PATH) — every poll failed, silently, and the
 *  worker rested believing it was covered. One `gh pr view`, the same call the poll makes. */
export async function probePrReadable(ref: PrRef): Promise<PrProbe> {
  try {
    await execFileAsync(
      "gh",
      ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state"],
      { timeout: 15_000, maxBuffer: 1_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: conciseGhError(err) }
  }
}

/** The issue twin of `probePrReadable`: one `gh issue view`, asked when the done card's Watch
 *  (router.watchDoneRef) finds its ref is not a pull request, so a watch on something the server's own
 *  `gh` cannot see is refused rather than armed.
 *
 *  AND A PULL REQUEST NUMBER IS REFUSED HERE TOO. `gh issue view` answers for a PR number (measured
 *  2026-09-14 against a Zod PR (#6382): `{"state":"CLOSED","url":".../pull/6382"}`), while the poll's
 *  `issue(number:)` GraphQL field does not — so a PR registered as an issue would pass a bare probe and
 *  then fail every poll in silence, the exact dead watcher the probe exists to prevent. The URL is the
 *  tell, and the refusal names the right tool. */
export async function probeIssueReadable(ref: PrRef): Promise<PrProbe> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,url"],
      { timeout: 15_000, maxBuffer: 1_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const url = (JSON.parse(stdout) as { url?: unknown })?.url
    if (typeof url === "string" && /\/pull\/\d+$/.test(url)) {
      return { ok: false, reason: `#${ref.number} is a pull request, not an issue — register it with \`ntwinectl watch-pr add\`` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: conciseGhError(err) }
  }
}

// THROWS on a failed `gh`, so the poll can SAY why — it returned undefined for everything until
// 2026-08-25, which made a PR the server could not read (signed out, SSO, no such repo, no `gh` on the
// PATH) indistinguishable from a PR with nothing to report: no log line, no wake, ever. `undefined` is
// kept for the one honest case, a response ntwine cannot interpret (below).
async function defaultFetchPr(ref: PrRef): Promise<PrStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ghPrViewArgs(ref),
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const j = JSON.parse(stdout) as {
      state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; headRefOid?: unknown
      mergeable?: unknown; reviewDecision?: unknown
    }
    // A SHAPE SURPRISE (valid JSON, but no string `state`) is INDETERMINATE, not "OPEN with no
    // checks" — returning a fabricated `{state:"", rollup:[]}` would read as UNMET and ARM the hint,
    // so a later accurate read could then fire an already-merged PR. Undefined = try again next poll.
    if (typeof j.state !== "string" || !j.state) return undefined
    if (typeof j.headRefOid !== "string" || !j.headRefOid) return undefined
    const runs = await execFileAsync(
      "gh",
      ["run", "list", "--repo", `${ref.owner}/${ref.repo}`, "--commit", j.headRefOid, "--limit", "100", "--json", "name,workflowName,status,conclusion,databaseId,event,createdAt"],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const workflowRuns = JSON.parse(runs.stdout)
    if (!Array.isArray(workflowRuns)) return undefined
    return {
      state: j.state,
      mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
      rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
      head: j.headRefOid,
      mergeable: typeof j.mergeable === "string" ? j.mergeable : undefined,
      reviewDecision: typeof j.reviewDecision === "string" ? j.reviewDecision : undefined,
      workflowRuns: workflowRuns as WorkflowRun[],
    }
  } catch (err) {
    throw new Error(conciseGhError(err))
  }
}

/** How many PRs' readings the book keeps. Shared by ref, so two threads watching one PR see one reading
 *  and cost one fetch. The key itself lives in awaiting.ts, beside the parser the board reads it with. */
const GITHUB_STATUS_CAP = 200
const REVIEW_SEEN_CAP = 300
// How many fresh activities a single wake steer enumerates. One poll interval can collect a whole
// review app's burst; naming ten of them is already a long steer, and the count line tells the worker
// how many it did not get named individually.
const REVIEW_STEER_CAP = 10

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  // Resume/steer a thread (prod: the shared resumeThread; tests: a spy). `deliveryId` is a stable
  // idempotency key for the exact session + awaiting-fence generation. Implementations must carry it
  // through durable downstream queues and append wakeDeliveryToken(id) to terminal input so transcript
  // recovery can prove a crash-window delivery before retrying (the production composition does both).
  resume: (slug: string, message: string, deliveryId: string) => void | Promise<void>
  now?: () => number
  // The provider quota snapshot, used ONLY to decide whether an exhausted window has rolled when the
  // limit message's own text can't say (every weekly limit, since its clock carries no date). Absent
  // in tests that exercise the text path; a read that throws is treated as indeterminate.
  readQuota?: () => Promise<QuotaSnapshot>
  // The operator's `fableFallback` setting, read per tick so a toggle takes effect without a restart.
  // Absent (tests) ⇒ off. See fableFallbackFor.
  fableFallback?: () => boolean
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  // Tests may keep injecting the historical bare array/undefined result. Production uses the
  // structured result so the scheduler can distinguish auth, timeout, network, API, and shape faults.
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | GithubReviewFetchResult | undefined>
  // SOURCE 16's runner and gate (command-watch.ts), bound to this project. Absent ⇒ no command watch is
  // ever RUN (expiry still settles and wakes), which is what a test that is not about them wants.
  commandWatches?: CommandWatchService
  // THE TERMINALS (thread-terminals.ts): every terminal thread with its row — its starter, and the starter's
  // `watch terminal` — and its process. SOURCE 17 wakes a thread when one it started and waits
  // on reaches a prompt or ends; the park check reads them too. Absent ⇒ no terminals (tests not about them).
  terminals?: () => readonly { row: ThreadTerminalRow; terminal: ThreadTerminal }[]
  /** A terminal's screen so far, escape sequences dropped (thread-terminals.ts screenTail). */
  terminalScreen?: (id: string) => string
  // A thread's `@handle` by slug, for a wake that names who drives a terminal. Absent ⇒ the slug.
  threadHandle?: (slug: string) => string | undefined
  log?: (msg: string) => void
  // After `resume` has handed a wake to the worker's runtime: is the process that took it still there?
  // A broker daemon now ACKNOWLEDGES the input (input-ack-v1), so `resume` returning means the session
  // queued it — but a daemon forked by an older build only proves the frame was written, and a cold
  // resume that dies at startup takes its queued input with it either way — so "resume returned" is
  // still SENT, not delivered. Answering "alive" or "dead" lets the
  // scheduler hold the wake as sent and confirm or re-send it later; "unknown" (or no hook at all) keeps
  // the old behaviour, delivered on return. See deliverDue and reconcileOutbox.
  wakeRuntimeState?: (slug: string, sessionId: string) => "alive" | "dead" | "unknown"
  // How long a sent wake waits for its transcript token before the runtime's survival alone confirms it.
  confirmGraceMs?: number
  // The per-thread quiet window (wake-store.ts WAKE_QUIET_WINDOW_MS): how long after a wake is handed
  // to a thread its next wake waits, so a burst of events costs one turn. Tests pass 0 to pin the
  // behaviour of each source without the window in the way; production takes the constant.
  wakeQuietWindowMs?: number
  tickMs?: number // how often to check (timers resolve at this cadence)
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxDeliveryAttempts?: number
  deliveryBatchSize?: number
  // THE RUNTIME BUDGET'S TEETH (SOURCE 13, shell-budget.ts): whether ntwine can end one live shell, and
  // the ONE stop that ends it — shell-stop.ts, the operator's × path, so a budget kill tells the worker
  // exactly as that one does. Absent ⇒ every over-budget shell is warned and none is ever stopped, which
  // is also the honest behaviour for a composition with no control channel.
  shellControl?: {
    stoppable(slug: string, shellId: string): boolean
    stop(slug: string, shellId: string, reason: ShellStopReason, opts: { notify: boolean }): Promise<{ stopped: boolean; note: string | null } | undefined>
  }
  // Re-project the board after a pass changed what it shows without a tailer event to trigger it — today
  // only evalQuestionDefaults' answers. Absent ⇒ the board's own reconcile picks the change up.
  refreshBoard?: () => void
  // Deterministic hard-crash fault injection. Throwing here escapes tick without compensating writes,
  // exactly like process death at the named durability boundary. Never configured in production.
  crashPoint?: (point: SchedulerCrashPoint, delivery: WakeDelivery) => void
  // SCHEDULED THREADS (schedules.ts, ARCHITECTURE.md § Scheduled threads): the pass that starts a schedule's next
  // run when its time comes. `evalDue` claims synchronously and launches OFF the tick, so an auth preflight
  // or a cold daemon never holds up this project's other wakes; `drain` is what `stop` awaits so no launch
  // outlives the scheduler that started it. Absent ⇒ no schedule ever fires (tests of other sources).
  scheduledThreads?: { evalDue(nowMs: number): void; drain(): Promise<void> }
}

export type SchedulerCrashPoint = "after-enqueue" | "after-claim" | "after-delivery" | "after-ack"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
  tick(): Promise<void> // exposed for tests + boot
  /** RUN THE NEXT PASS NOW, for a caller that just created work the sweep would otherwise find up to a
   *  whole `tickMs` later. Fire-and-forget: it never throws and never blocks the caller's response.
   *
   *  It is a no-op unless the scheduler was actually STARTED — a disposable stack boots with
   *  NTWINE_WAKERS_OFF and never calls `start()`, and a kick that ran the sweep anyway would deliver
   *  wakes the operator explicitly turned off. `tick()` stays the unconditional one, for tests and boot. */
  kick(): void
  /** THE HUMAN'S "Ask for update" (router.requestParkCheckIn): treat the park this thread rested on at
   *  `restedAt` as expired NOW, so SOURCE 12 sends the same check-in wake the 30-minute expiry would — early, and
   *  headed as the human's request. Keyed on the rest, so a new rest makes a stale request inert; held
   *  in memory, so a restart before the next pass drops the click rather than replaying it later. */
  requestCheckIn(slug: string, restedAt: string): void
  /** Resolves once every command-watch check in flight has finished and been recorded (SOURCE 16 starts
   *  them without awaiting, so a two-minute check never holds up the tick). Tests await it between ticks. */
  commandRunsIdle?(): Promise<void>
}

/** The FENCE key a wire kind is written as. The wire kinds stayed SINGULAR through the 2026-08-24 YAML
 *  cutover; the grammar the worker writes did not, so every message that quotes a fence line back at a
 *  worker has to translate — printing `i.kind` raw teaches a spelling the parser now refuses. */
const AWAITING_KEY_OF: Record<"shell" | "agent" | "timer" | "pr" | "thread" | "command" | "terminal", string> = {
  shell: "shells", agent: "agents", timer: "timers", pr: "prs", thread: "threads", command: "commands", terminal: "terminals",
}

// ---- THE MID-TURN HOLD'S BOUND ------------------------------------------------------------------
// A wake that is not clock-driven waits for the thread to come to rest (`isDeliverableNow`), and that
// wait used to be unbounded: a thread whose turn reading never returned to idle — a fold that stalled, a
// runtime whose last record is a tool_use that will never be answered — starved every wake queued behind
// it, silently, for as long as the row lived. This is the ceiling. A held wake older than this goes out
// even while the thread reads busy, into the runtime's queue exactly as a heartbeat does — which neither
// aborts the running turn nor opens a new one (the CLI drains its queue at the next sampling boundary).
// Ten minutes is long enough that an ordinary turn ends first and the rest-time delivery stays the rule;
// short enough that a stuck reading costs one wake ten minutes rather than a thread its whole wait.
export const MID_TURN_HOLD_MAX_MS = 10 * 60_000

// The reason a deferred row carries while it is held. It is what tells `reconcileOutbox` that an
// expired lease was NEVER SENT — a deferral happens before `resume` is called — as opposed to an
// attempt that died with the socket write in flight, which is the one case a re-open on a busy thread
// must never guess at.
export const WAKE_HOLD_DEFERRAL = "delivery deferred until exact awaiting telemetry is idle and available"

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const fetchGithubReview = deps.fetchGithubReview ?? createGithubReviewFetcher({ now })
  const log = deps.log ?? ((m: string) => ntwineLog.info("scheduler", m))
  const tickMs = deps.tickMs ?? 10_000
  const deliveryLeaseMs = Math.max(1, deps.deliveryLeaseMs ?? 30_000)
  const retryBaseMs = Math.max(1, deps.retryBaseMs ?? 5_000)
  const retryMaxMs = Math.max(retryBaseMs, deps.retryMaxMs ?? 5 * 60_000)
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 6)
  // A `claude --resume` that is going to die does so within seconds (a missing session, a refused
  // credential) to tens of seconds (an MCP server that will not boot); one that is alive a minute after
  // taking the frame has read it, whether or not the transcript check can see the token yet.
  const confirmGraceMs = Math.max(1, deps.confirmGraceMs ?? 60_000)
  const deliveryBatchSize = Math.max(0, deps.deliveryBatchSize ?? 50)
  const deliveryOwner = randomUUID()
  // When this scheduler came up: a failed delivery older than this was refused by a previous process, and
  // a restart is the usual place a broken runtime gets fixed (answerReofferDue).
  const startedAtMs = now()
  const outbox = createWakeDeliveryStore(deps.storage.scope, { quietWindowMs: deps.wakeQuietWindowMs ?? WAKE_QUIET_WINDOW_MS })

  const reviewFailures = new Map<string, { signature: string; loggedAt: number; suppressed: number }>()
  let timer: NodeJS.Timeout | null = null
  let activeTick: Promise<void> | null = null // guard + shutdown drain for a slow poll/delivery
  // A kick that landed while a tick was already running — see `kick`.
  let rerun = false
  let stopped = false

  // ---- THE WATCHED-PR STATUS LEDGER ---------------------------------------------------------------
  // The poller is the only thing here that talks to GitHub, and the BOARD is what has to render the
  // result and decide the queue rule from it. So the poll publishes into a setting keyed by PR ref, and
  // the board reads it — one shared reading per PR, however many threads are watching it.
  //
  // A setting rather than a table because there is nothing to reconcile: it is a pure CACHE of GitHub's
  // own answer, every entry is replaceable, and an entry for a PR nobody watches any more is stale data
  // that costs a few bytes until it is evicted. Bounded like the ledgers beside it.
  function publishGithubStatus(key: string, pr: PrStatus, nowMs: number): void {
    const raw = deps.storage.getSetting(GITHUB_STATUS_SETTING)
    const book = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    book[key] = githubWatchStatus(pr, new Date(nowMs).toISOString())
    const keys = Object.keys(book)
    // Newest-wins eviction on insertion order, which for this book is poll order — the entry evicted is
    // the one longest unpolled, i.e. the PR nobody is watching any more.
    for (const stale of keys.slice(0, Math.max(0, keys.length - GITHUB_STATUS_CAP))) delete book[stale]
    deps.storage.setSetting(GITHUB_STATUS_SETTING, book)
  }

  /** The issue twin of `publishGithubStatus`, into its own book (see GITHUB_ISSUE_STATUS_SETTING). */
  function publishGithubIssueStatus(key: string, issue: GithubIssueSnapshot, nowMs: number): void {
    const raw = deps.storage.getSetting(GITHUB_ISSUE_STATUS_SETTING)
    const book = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    const reading: GithubIssueStatus = {
      state: issue.state.toUpperCase() === "CLOSED" ? "closed" : "open",
      ...(issue.stateReason ? { stateReason: issue.stateReason.toLowerCase() } : {}),
      ...(issue.title ? { title: issue.title } : {}),
      comments: issue.comments,
      polledAt: new Date(nowMs).toISOString(),
    }
    book[key] = reading
    const keys = Object.keys(book)
    for (const stale of keys.slice(0, Math.max(0, keys.length - GITHUB_STATUS_CAP))) delete book[stale]
    deps.storage.setSetting(GITHUB_ISSUE_STATUS_SETTING, book)
  }

  class InjectedSchedulerCrash extends Error {
    constructor(cause: unknown) {
      super("simulated scheduler hard crash", { cause })
    }
  }

  function checkpoint(point: SchedulerCrashPoint, item: WakeDelivery): void {
    if (!deps.crashPoint) return
    try {
      deps.crashPoint(point, item)
    } catch (error) {
      throw new InjectedSchedulerCrash(error)
    }
  }

  function retryDelay(attempts: number): number {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, Math.min(30, attempts - 1)))
  }

  type DeliveryContext = "confirmed" | "superseded" | "current-idle" | "current-busy" | "unknown"

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return "superseded"
    if (row.state === "archived" || row.archived === 1) return "superseded"
    const tele = deps.tailer.get(item.slug)
    if (!tele) return "unknown"
    if (tele.lastUserText?.includes(wakeDeliveryToken(item.id))) return "confirmed"
    // A limit wake is bound to its interruption, not to a fence: it stays deliverable exactly as long
    // as THAT limit fault is still the thread's live tail state. The fault clears on the first user
    // record, so a delivery that reached the worker before the process died reads as superseded on the next
    // pass instead of being sent twice — the same supersession safety the fence path gets, obtained
    // from the fold rather than from anything the scheduler had to persist.
    if (isLimitFenceId(item.fenceId)) {
      const fault = tele.limitFault
      if (!fault || limitFenceId(fault) !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A snooze wake is bound to the exact (instant, prompt) the human armed. Wake-now (clears the row),
    // a re-snooze (a different fence id) and an ordinary follow-up (clears the row too — see
    // resume.wakeParkedThreadForFollowUp) therefore all read as supersession here: each one is the human
    // replacing the promise we were holding. Reprompting a thread means "now", which is precisely the
    // instruction a bump scheduled for later no longer describes.
    // A SHELL-COMPLETION WAKE CANNOT BE SUPERSEDED BY ANYTHING THE THREAD SAYS. It is bound to a fact
    // that has already happened — this shell finished, and its agent was resting when it did — and no
    // later fence, rest or edit makes that untrue. So the only question is whether the thread is free to
    // receive it. (Without this branch it fell through to the awaiting-fence logic below, which compares
    // the delivery against the thread's CURRENT fence and superseded every wake for a bare rest: queued
    // on every tick, delivered never.)
    if (isShellFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A CONTROL NOTE sent because its thread was WORKING is for that turn: one that has ended since (the
    // quiet window can hold a row past it) does not get a turn of its own for it — the note is owed again
    // and rides the next wake (reoweTerminalNote).
    if (item.fenceId.includes(TERMINAL_NOTE_MARK) && tele.turn === "idle") return "superseded"
    // A TERMINAL'S PROMPT OR EXIT is the same kind of fact (SOURCE 17), and so is its watch lapsing.
    if (isTerminalWaitFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // The interrupt note is the same shape: sub-agents that ended have ended, whatever the thread says next.
    if (isInterruptEndedFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // So is a message from another thread: it was said, whatever this thread says next.
    if (isThreadMessageFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // An over-budget warning is bound to its shell STILL RUNNING under the SAME deadline. The worker
    // stopping the shell, or extending it, between enqueue and delivery each make the warning untrue —
    // and nothing the thread SAYS does. Without this branch it would fall to the fence logic below and
    // be superseded on every pass: queued, never delivered.
    if (isShellBudgetFenceId(item.fenceId)) {
      const key = parseShellBudgetFenceId(item.fenceId)
      const shell = key ? tele.bgShells?.find((sh) => sh.state === "running" && sh.id === key.shellId) : undefined
      if (!key || !shell || liveShellBudget(deps.storage, item.slug, shell)?.deadlineMs !== key.deadlineMs) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A DEADLINE CHECK-IN is bound to its GENERATION still being the thread's deadline, to being the
    // latest stage due (a later one is enqueued in its place — the worker hears where it stands now, not
    // a history), and to the thread not resting on a handoff: a worker that signed off, asked the human,
    // or parked on them has already handed over, and waking it to say "hand over" is noise. The next
    // stage, or the wake header's clock, reaches it when it runs again.
    if (isDeadlineFenceId(item.fenceId)) {
      const key = parseDeadlineFenceId(item.fenceId)
      const d = rowDeadline(row)
      if (!key || !d || d.setAt !== key.setAt) return "superseded"
      if (deadlineStageDue(d.setAtMs, d.atMs, now()) !== key.stage) return "superseded"
      if (restsOnHandoff(item.slug, tele)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // The human's notice is bound to its change still standing (DEADLINE_NOTICE_FENCE_PREFIX), and goes
    // nowhere a thread that has signed off.
    if (isDeadlineNoticeFenceId(item.fenceId)) {
      const body = item.fenceId.slice(DEADLINE_NOTICE_FENCE_PREFIX.length + 1)
      if (body.startsWith("set:") ? row.deadline_set_at !== body.slice(4) : Boolean(row.deadline_at)) return "superseded"
      if (tele.turn === "idle" && threadSaidDone(deps.storage, item.slug, tele)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A REGISTERED PR WATCHER's report is bound to something that happened on GitHub, not to anything
    // this thread wrote, so no fence, rest or edit can supersede it either. Same reasoning as the shell
    // wake directly above, and the same bug if it is missing.
    if (isPrWatchFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A REGISTERED WATCH's expiry is bound to a clock, not to anything the thread wrote — the row is
    // already settled by the time this is enqueued, so no fence, rest or edit can make it untrue.
    // Same reasoning as the two above, and the same silent never-delivered bug if it is missing.
    if (isOwnWatchExpiredFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A COMMAND WATCH's wake is bound to a check that already ran (or a clock that already ran out, or a
    // gate that already closed) — and its row is settled before the wake can be sent, so the worker has
    // nothing left to withdraw. No fence, rest or edit makes it untrue. Same branch, same reason, and
    // the same silent never-delivered bug if it is missing.
    if (isCommandWatchFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // AN ANSWER IS BOUND TO WHAT THE HUMAN SAID, not to anything the thread wrote, so no fence, rest or
    // edit supersedes it. Same reasoning as the three above, and the same silent never-delivered bug if
    // it is missing — this is the one delivery a worker is actually waiting on.
    if (isQuestionAnswerFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    if (isSnoozeFenceId(item.fenceId)) {
      if (armedSnooze(row)?.fenceId !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A scheduled delivery is bound to the exact GENERATION that queued it. Switching the trigger off, re-arming it
    // with different settings, and either side switching it off all read as
    // supersession here — each one means the queued text no longer describes what the thread wants.
    // Disabling therefore drops a beat already waiting, rather than delivering it on re-enable.
    // THE GOAL'S END is bound to the generation it ended STILL BEING STOPPED. The human (or the worker)
    // re-arming before it lands makes "your loop stopped" untrue, so it supersedes rather than arriving
    // on top of a loop that is running again.
    if (isGoalEndFenceId(item.fenceId)) {
      if (!row.recurring_armed_at || !row.recurring_stop_reason || item.fenceId !== goalEndFenceId(row.recurring_armed_at)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    if (isHeartbeatFenceId(item.fenceId)) {
      const armed = armedSchedule(row)
      if (!armed || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armed.armedAt}:`)) return "superseded"
      if (pastDeadline(row, now())) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A rest delivery is bound to the exact GENERATION that queued it AND to the exact REST it
    // was queued for. Disabling the toggle, editing the text, and the thread moving on to a new rest
    // all read as supersession here — and so does an AWAITING that landed between enqueue and delivery,
    // which is the case that matters: a worker that closed the loop while a bump sat in the outbox must
    // not be handed it anyway.
    if (isStopHookFenceId(item.fenceId)) {
      if (tele.authFault || tele.apiFault) return "superseded"
      const armed = armedRest(row)
      if (!armed || item.fenceId !== stopHookFenceId(armed.armedAt, tele.lastAssistantAt ?? "")) return "superseded"
      if (pastDeadline(row, now())) return "superseded"
      if (restMessageIsSignedOff(deps.storage, item.slug, tele, registeredPrWatchesOf(deps.storage, item.slug), armedTimerIdsOf(deps.storage, item.slug), armed.armedAt)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A post-compaction delivery is bound to the generation AND to the exact compaction it was queued
    // for — a SECOND compaction between enqueue and delivery supersedes the first, because re-grounding
    // on the older window is not what the operator asked for. Unlike the rest trigger it does NOT check
    // whether the thread signed off: `done` answers "you stopped, is there more?", and a compaction is
    // not that question.
    if (isCompactFenceId(item.fenceId)) {
      const armed = armedCompact(row)
      if (!armed || item.fenceId !== compactFenceId(armed.armedAt, tele.lastCompactionAt ?? "")) return "superseded"
      if (pastDeadline(row, now())) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A one-off timer is bound to its own row still being ARMED. The worker cancelling it, and a
    // previous attempt having already settled it as fired, both read as supersession here — which is
    // what makes "exactly once" hold even after the outbox has pruned this delivery's terminal row.
    if (isTimerFenceId(item.fenceId)) {
      if (deps.storage.getThreadTimer(timerIdOf(item.fenceId))?.state !== "armed") return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A registered watcher is bound to its own row still being ARMED, exactly as a timer is — and for
    // the same two reasons. The worker DROPPING it between enqueue and delivery must cancel the wake
    // (that is the whole point of a dismissable wait), and a previous attempt having already settled it
    // as fired is what makes "exactly once" hold after the outbox prunes this delivery's terminal row.
    //
    // This branch is load-bearing in a way the others are not: without it the fallthrough below reads
    // every watcher delivery as an awaiting fence, finds none, and supersedes it — the watcher enqueues
    // on every tick and never delivers, which looks exactly like a watcher that does not work.
    // The built-in nudge is bound to the exact rest it was queued for, and to that rest still being
    // fenceless. A worker that signed off between enqueue and delivery must not then be told how to
    // sign off — which is both useless and, arriving after a ```done, actively confusing.
    if (isSignoffFenceId(item.fenceId)) {
      if (tele.authFault || tele.apiFault) return "superseded"
      if (item.fenceId !== signoffFenceId(tele.lastAssistantAt ?? "")) return "superseded"
      if (tele.lastFence || tele.pendingQuestion) return "superseded"
      // A child that returned after this rest is about to wake the parent with its report, so the rest
      // this nudge was for is over in all but the transcript (board.childJustReturned has the timing).
      if (childJustReturned(tele, tele.lastAssistantAt, now())) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // SOURCE 14 is bound to its shells still running: the worker stopping them between enqueue and
    // delivery is the outcome it asks for, and telling it about shells that are gone would be noise.
    // A question answered in the meantime does not supersede it — the shells are stray either way.
    if (isStrayShellsFenceId(item.fenceId)) {
      const ids = strayShellsOf(item.fenceId)
      if (!(tele.bgShells ?? []).some((sh) => sh.state === "running" && ids.includes(sh.id ?? sh.label))) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A report repair is bound to a report that is STILL missing from the model's context. If the
    // runtime delivered it late — between the tick that queued this repair and the tick that would
    // send it — the fold drops it out of `droppedReports` and the repair reads as superseded here.
    // That is what keeps a slow delivery from producing a repair for a report the agent has now read,
    // and it is obtained from the fold rather than from anything the scheduler had to persist.
    if (isReportFenceId(item.fenceId)) {
      const stillMissing = tele.droppedReports?.some((r) => reportFenceId(r.taskId) === item.fenceId)
      if (!stillMissing) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // SOURCE 12's correction is bound to the exact REST it was minted for, and to that rest still being
    // the thread's last word — a follow-up or a new turn means the worker is no longer looking at the
    // fence being corrected. Nothing else can supersede it: whether the fence is still wrong is settled
    // at ENQUEUE, and re-deciding it here would race the very bump that fixes it.
    //
    // THIS BRANCH IS WHY THE SOURCE WORKED AT ALL. Without it a `park:…` id fell to the tail below,
    // which supersedes everything that reaches it — so every correction read as superseded, at zero
    // attempts, and the one voice that can get a worker out of a bad fence was silent. Measured on the
    // maintainer's own board 2026-08-18: 2034 corrections enqueued across four projects, 0 delivered,
    // ever, while every kind that HAS a branch here ran at ~100%. The thread that surfaced it wrote
    // `timer: none` and sat for three hours.
    //
    // THE GENERAL SHAPE OF THAT BUG: a fallthrough that supersedes is a fallthrough that fails CLOSED, so
    // a source minting a new prefix without a branch here is silently undeliverable and the enqueue-side
    // tests still pass. Any new wake source needs its branch here and a test that asserts `resume` ran.
    if (isParkFenceId(item.fenceId)) {
      if (parkFenceRestOf(item.fenceId) !== (tele.lastAssistantAt ?? "")) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // NOTHING ROUTES TO THE TAIL ANY MORE, so everything that reaches it supersedes. Every live source
    // above claims its own prefix; an id arriving here belongs to a source that mints one nobody routes,
    // and a fallthrough that supersedes is a fallthrough that fails CLOSED — that source is silently
    // undeliverable while its enqueue-side tests stay green. Both bugs found on 2026-08-18 were exactly
    // this, and neither was visible without querying the database. It still supersedes (failing open
    // would deliver an id we cannot reason about), but it SAYS SO.
    //
    // The one id shape that is NOT a bug is a fence identity from a pre-cutover scheduler, still sitting
    // in an old outbox. That source was deleted on 2026-08-24 and nothing mints those ids now, so
    // superseding one is the right answer and it needs no alarm — hence the separator check below.
    if (!item.fenceId.includes("\u0001")) {
      log(`waker: UNROUTED wake prefix ${item.fenceId.split(":")[0]} for ${item.slug} — no deliveryContext branch, superseding`)
    }
    return "superseded"
  }

  // May this item go out RIGHT NOW? Most sources wait for the thread to come to rest, because they are
  // answering a question about a thread that has stopped — an elapsed awaiting fence, a PR review, a bump
  // for a worker that just rested. Delivering those mid-turn would interrupt work the worker is already
  // doing about the very thing that woke it.
  //
  // THE CLOCK-DRIVEN PAIR ARE THE EXCEPTION — the recurring prompt's SCHEDULE trigger and the worker's
  // own ONE-OFF TIMER — and it is the whole point of both. What follows is written about the heartbeat
  // because that is where the behavior was settled; a timer is the same promise made once, so holding one
  // until rest would break it in exactly the same way.
  //
  // It fires on its cadence
  // regardless of what the thread is doing (maintainer 2026-08-03 — "my intention was for the heartbeat
  // to fire on its regular cadence, regardless of whether the agent is currently running or not"). It
  // used to be held here like everything else, which quietly made it a second rest trigger: one due at
  // 14:00 on a thread that stayed busy until 14:50 arrived at 14:50, so the cadence the operator set
  // described nothing.
  //
  // Both transports take a mid-turn message natively, so this is a gate change and not a new channel.
  // Claude's broker queues it into the running CLI's command queue, which Claude Code drains at its
  // first sampling boundary (see the bridge's `interruptTurn` contract for the measured latency); the
  // codex app-server steers the live turn through `turn/steer`. Neither ABORTS what is running, which is
  // the correct reading of "fires on its cadence" — the beat is delivered, the in-flight work is not
  // cut off, and ntwine's completion invariant stays intact.
  //
  // `unknown` still defers on every source, this one included: telemetry we cannot read is not a thread
  // we can safely address.
  //
  // AND THE HOLD HAS A CEILING (MID_TURN_HOLD_MAX_MS): a wake that has waited that long behind a busy
  // reading goes out anyway, so a turn that never ends — or a reading that never says so — cannot starve
  // the thread's whole queue. Measured from the row's creation, which is the instant the news existed.
  function isDeliverableNow(item: WakeDelivery, context: DeliveryContext, nowMs: number): boolean {
    if (context === "current-idle") return true
    if (context !== "current-busy") return false
    // The post-compaction trigger joins the mid-turn pair for the reason it exists at all: a compaction
    // happens WHILE the worker is working, and a re-grounding that waits for it to stop has missed the
    // window it was written for.
    if (isHeartbeatFenceId(item.fenceId) || isTimerFenceId(item.fenceId) || isCompactFenceId(item.fenceId)) return true
    // The interrupt note too: the worker is BUSY precisely because the interrupt just opened a turn on
    // the human's follow-up, and that turn is where it decides to wait on the child that no longer exists.
    if (isInterruptEndedFenceId(item.fenceId)) return true
    // Another thread's message joins a running turn the way a human's typed steer does — see
    // THREAD_MESSAGE_FENCE_PREFIX.
    if (isThreadMessageFenceId(item.fenceId)) return true
    // A terminal changing hands is news to the thread working on it NOW: it may be about to type into it.
    if (isTerminalWaitFenceId(item.fenceId) && (item.fenceId.includes(":control:") || item.fenceId.includes(TERMINAL_NOTE_MARK))) return true
    // The budget warning is "in the moment" by definition: its grace clock is already running, and a
    // worker mid-turn is the one most likely to still be using the shell — it has ten minutes to say so.
    if (isShellBudgetFenceId(item.fenceId)) return true
    // A deadline check-in is the clock speaking, like a heartbeat: "you have 12m left" held until the
    // turn ends has missed the turn it was for. The human's notice joins a running turn as a steer does.
    if (isDeadlineFenceId(item.fenceId) || isDeadlineNoticeFenceId(item.fenceId)) return true
    // AN ANSWER IS THE HUMAN'S OWN WORDS, and it goes out mid-turn exactly as their typed steer does
    // (router followUp queues one into the running turn). Answers arrive ONE QUESTION AT A TIME since
    // 2026-09-29 — the worker starts on the first while the human reads the rest — so the second usually
    // lands while the worker is busy with the first. Held for the rest, it opened a turn of its own after
    // the worker had already written a handoff without it, and a third opened a third: one turn per card,
    // and a handoff per card the human had to read. Delivered now, it joins the turn already running at
    // its next sampling boundary. It interrupts nothing, and the questions of one `ask` are independent by
    // contract, so an answer arriving mid-work never changes the premise of the work in flight.
    if (isQuestionAnswerFenceId(item.fenceId)) return true
    return nowMs - item.createdAt >= MID_TURN_HOLD_MAX_MS
  }

  // The re-open gate's reading of the same ceiling. Only a row the scheduler itself DEFERRED qualifies —
  // never one whose lease died around a `resume` call — because that is the one expired lease whose
  // input provably never crossed the transport (see the reconcile branch that calls this).
  function heldPastBound(item: WakeDelivery, context: DeliveryContext, nowMs: number): boolean {
    return context === "current-busy"
      && item.sentAt === null
      && item.lastError === WAKE_HOLD_DEFERRAL
      && nowMs - item.createdAt >= MID_TURN_HOLD_MAX_MS
  }

  // Name the activity for the bump steer. A review carries a GitHub `state`, so an APPROVAL or a
  // CHANGES_REQUESTED is called out specifically (the two the worker most needs to act on); a plain
  // review or a conversation comment reads generically. Falls back to "activity" for an unknown state.
  // Every label fills a NOUN slot ("New GitHub ___ on owner/repo#N"), so GitHub's own verb-phrase
  // wording for CHANGES_REQUESTED is nominalized rather than pasted in.
  function activityLabel(a: GithubReviewActivity): string {
    if (a.kind === "comment") return "comment"
    switch (a.reviewState?.toUpperCase()) {
      case "APPROVED": return "approval"
      case "CHANGES_REQUESTED": return "change request"
      case "COMMENTED": return "review comment"
      case "DISMISSED": return "dismissed review"
      default: return "review"
    }
  }

  function normalizeReviewResult(
    result: GithubReviewActivity[] | GithubReviewFetchResult | undefined,
  ): GithubReviewFetchResult {
    if (Array.isArray(result)) return { status: "ok", activity: result }
    return result ?? {
      status: "error",
      failure: { kind: "shape", message: "GitHub review fetcher returned no result" },
    }
  }

  function recordReviewFailure(key: string, slug: string, result: Extract<GithubReviewFetchResult, { status: "error" }>, at: number): void {
    const signature = `${result.failure.kind}:${result.failure.message}`
    const prior = reviewFailures.get(key)
    if (prior?.signature === signature && at - prior.loggedAt < 15 * 60_000) {
      prior.suppressed++
      return
    }
    const suppressed = prior?.suppressed ? ` (${prior.suppressed} identical repeats suppressed)` : ""
    log(`waker: GitHub review check failed for ${key} (${slug}) [${result.failure.kind}] — ${result.failure.message}${suppressed}`)
    reviewFailures.set(key, { signature, loggedAt: at, suppressed: 0 })
  }

  // The status poll's twin of the pair above: one line per distinct `gh` failure per PR, repeats
  // counted, recovery said. Without it (before 2026-08-25) the poll swallowed every failure and a PR
  // the server could not read looked exactly like a quiet one.
  const statusFailures = new Map<string, { signature: string; loggedAt: number; suppressed: number }>()
  function recordStatusFailure(key: string, message: string, at: number): void {
    const prior = statusFailures.get(key)
    if (prior?.signature === message && at - prior.loggedAt < 15 * 60_000) {
      prior.suppressed++
      return
    }
    const suppressed = prior?.suppressed ? ` (${prior.suppressed} identical repeats suppressed)` : ""
    log(`waker: PR status check failed for ${key} — ${message}${suppressed}; CI and merge wakes cannot fire until \`gh\` can read it`)
    statusFailures.set(key, { signature: message, loggedAt: at, suppressed: 0 })
  }
  function recordStatusSuccess(key: string): void {
    const prior = statusFailures.get(key)
    if (!prior) return
    statusFailures.delete(key)
    log(`waker: PR status check recovered for ${key}${prior.suppressed ? `; ${prior.suppressed} identical repeats were suppressed` : ""}`)
  }

  function recordReviewSuccess(key: string, slug: string): void {
    const prior = reviewFailures.get(key)
    if (!prior) return
    const suppressed = prior.suppressed ? `; ${prior.suppressed} identical repeats were suppressed` : ""
    log(`waker: GitHub review check recovered for ${key} (${slug})${suppressed}`)
    reviewFailures.delete(key)
  }

  // ---- The limit auto-resume pass ------------------------------------------------------------------
  // Every non-archived thread whose tail still carries a limit fault and has come to rest. `turn` must
  // be idle: a thread that has already started moving again was resumed by someone else, and stepping
  // on a live turn is exactly what the fence path refuses to do too.
  interface LimitCandidate {
    slug: string
    sessionId: string
    backend: "claude" | "codex"
    fault: LimitFault
  }
  function limitCandidates(nowMs: number): LimitCandidate[] {
    const out: LimitCandidate[] = []
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const fault = tele?.limitFault
      if (!fault || tele?.turn !== "idle") continue
      // The boot guard, and the same age policy the board renders — so a card never promises a wake
      // the waker has already written off.
      if (limitPauseIsStale(fault.window, Date.parse(fault.at), nowMs)) continue
      out.push({
        slug: row.slug,
        sessionId: row.session_id,
        backend: row.backend === "codex" ? "codex" : "claude",
        fault,
      })
    }
    return out
  }

  // The wall each thread has already spent its ONE early (account-headroom) resume on — see the guard
  // in limitRecovered. Keyed by slug, valued by limitFaultResetKey.
  //
  // The headroom trigger reads the ACCOUNT while the wall belongs to the THREAD's own process, so when
  // an early resume bounces off that wall the trigger's premise is untouched: the account still shows
  // headroom, so it fires again, and again. Each bounce writes a new fault, whose new `at` mints a new
  // fence id, so the once-per-interruption dedupe in evalLimits never bites either. Live on 2026-07-30
  // that ran every 2 minutes (exactly LIMIT_HEADROOM_MIN_FAULT_AGE_MS) for half an hour and buried a
  // worker's transcript under 184 limit records — a self-inflicted context burn on a thread that was
  // already stuck.
  //
  // In memory on purpose: an ntwine restart costs one extra attempt per thread, and a durable table for a
  // guard this cheap would be a migration in exchange for nothing.
  const spentEarlyResume = new Map<string, string>()

  // Has this fault's window come back? Two independent triggers, whichever fires first:
  //   (1) the ORIGINAL window RESET — its own reset clock (5-hour session: exact, local, free) or, for a
  //       weekly whose text carries no date, the endpoint's window-identity roll.
  //   (2) quota FREED UP on the current account — the blown window now reads below the headroom floor,
  //       so a fresh sign-in or a raised cap made room even though the original clock hasn't passed
  //       (guarded by the floor + min-fault-age; see LIMIT_RESUME_HEADROOM_PERCENT).
  // `undefined` = indeterminate: wait for a later tick rather than guessing, since guessing "recovered"
  // resumes the fleet into a wall.
  function limitRecovered(
    c: LimitCandidate,
    quota: QuotaSnapshot | undefined,
    nowMs: number,
  ): boolean | undefined {
    const faultAtMs = Date.parse(c.fault.at)
    const provider = quota?.[c.backend]

    // (2) Account-availability: the blown window is no longer near-full on the signed-in account. Only
    // trusted once the fault is old enough that a warmed reading necessarily post-dates it (so we read a
    // real recovery, not a stale pre-fault value) and only when the window sits below the floor (so
    // jitter near 100% can't resume the fleet straight back into the wall).
    if (provider?.status === "ok" && Number.isFinite(faultAtMs) && nowMs - faultAtMs >= LIMIT_HEADROOM_MIN_FAULT_AGE_MS) {
      const key = quotaWindowKeyFor(c.fault.window)
      // A MODEL-scoped fault has no static key: its window is the endpoint's `weekly-<model>` scoped
      // entry, found by name. This trigger is the one that actually revives a model-capped fleet —
      // buying credits or a raised cap frees the scoped window's percent long before its weekly roll
      // (observed live 2026-08-31: the killed fleet's `weekly-fable` read 62% within the hour).
      const w = key
        ? provider.windows.find((x) => x.key === key)
        : c.fault.window === "model"
          ? scopedQuotaWindow(provider.windows, c.fault.model)
          : undefined
      const wall = limitFaultResetKey(c.fault)
      // One early resume per wall. A second fault naming the same reset instant is this thread bouncing
      // off the same wall, not a new interruption, so it gets no second attempt — it waits for trigger
      // (1), its own clock, below.
      if (w && typeof w.usedPercent === "number" && w.usedPercent <= LIMIT_RESUME_HEADROOM_PERCENT && spentEarlyResume.get(c.slug) !== wall) {
        spentEarlyResume.set(c.slug, wall)
        return true
      }
    }

    // (1) Original-window reset. Text first — exact, local, free, covers the common 5-hour session case.
    const textAt = c.fault.resetClock
      ? textResetInstant({ window: c.fault.window, resetClock: c.fault.resetClock }, faultAtMs)
      : undefined
    if (textAt !== undefined) return nowMs >= textAt + LIMIT_RESUME_GRACE_MS
    if (!provider || provider.status !== "ok") return undefined
    // A model-scoped fault rolls with its `weekly-<model>` scoped window — same identity-roll logic,
    // resolved by name instead of a static key.
    const rolled = c.fault.window === "model"
      ? scopedQuotaWindowRecovered(provider.windows, c.fault.model, faultAtMs, nowMs)
      : quotaWindowRecovered(provider.windows, c.fault.window, faultAtMs, nowMs)
    if (rolled !== true) return rolled
    return nowMs >= faultAtMs + LIMIT_RESUME_GRACE_MS
  }

  // ---- The MODEL-SCOPED cap: step down a rung instead of waiting out the week ----------------------
  //
  // A model-scoped limit is NOT the account running dry, and the provider's own message says so —
  // "You've reached your Fable 5 limit. Switch to another model, or manage usage credits … to
  // continue." Parking the thread behind that cap's `weekly-<model>` window costs up to seven days of
  // capacity the account still has, so ntwine takes the provider's advice on the thread's behalf:
  // persist the next model down as the thread's profile and resume it now. The resume is a COLD one
  // (the fault has no resolvable clock, so needsFreshProcessForLimit is true), and a cold resume forks
  // `claude` with `row.model` — which is what carries the new model into argv, and the reason this
  // cannot be done by steering the live process: the SDK takes the model at query start.
  //
  // IT TERMINATES BY CONSTRUCTION, which is what makes it safe to fire without the once-per-wall guard
  // the headroom trigger needs. Every step names a DIFFERENT model, so a thread that re-caps on the
  // rung below writes a fault naming THAT model and steps down again — Fable → Opus → Sonnet → Haiku,
  // where the ladder ends and it waits out the window like any other limit. A step that fails to take
  // effect cannot loop either: the persisted model no longer matches the fault's, so the
  // same-model guard below declines and the thread falls back to waiting.
  function modelFallbackFor(c: LimitCandidate): { model: string; effort: string; label: string; capped: string } | undefined {
    if (c.backend !== "claude" || c.fault.window !== "model" || !c.fault.model) return undefined
    const row = deps.storage.getSession(c.slug)
    // Broker rows only. The cold fork is the thing that applies a new model, and only the broker
    // transport has one; a legacy row would be downgraded on paper and resumed on the old model.
    if (!row || row.claude_runtime !== "broker") return undefined
    // Restarting is how the switch happens at all, so a thread ntwine may not restart cannot be
    // switched — the same fail-closed reading, on the same predicate, as the resume's own freshProcess
    // decision. Such a thread keeps the ordinary wait-for-the-window behaviour.
    const tele = deps.tailer.get(c.slug)
    if (mayHaveLiveBackgroundWork(tele)) return undefined
    const capped = claudeModelFromLimitName(c.fault.model)
    if (!capped) return undefined
    // The cap must be on the model THIS thread is running. Another thread — or a sub-agent dispatched
    // onto a model of its own — can exhaust one this thread never touched, and stepping an Opus thread
    // down to Sonnet because Fable ran dry is a downgrade that buys nothing. Read the value the resume
    // will actually spawn with (the persisted target), falling back to the observed model only where
    // the row never recorded one.
    const current = row.model?.trim() || (tele?.model ? normalizeObservedThreadModel("claude", tele.model) : undefined)
    if (!current || current !== capped) return undefined
    const next = claudeFallbackModel(capped)
    const option = next ? claudeProfile(next) : undefined
    if (!next || !option) return undefined // bottom rung: nothing left to fall to
    // Carry the thread's own effort across when the target offers it (ultracode rides only the
    // xhigh-capable models), else that model's default — the pair a fresh dispatch of it would use.
    const effort = row.effort?.trim()
    return {
      model: next,
      effort: effort && option.efforts.includes(effort) ? effort : option.defaultEffort,
      label: option.label,
      capped: c.fault.model,
    }
  }

  // ---- The BASE cap with Fable budget left: step UP to Fable instead of waiting ---------------------
  //
  // The `fableFallback` setting (backend/fable-fallback.ts). A session or all-models weekly limit stops
  // every thread on the base budget, but on a plan where Fable carries its own weekly cap, Fable may
  // still have room — so a thread paused by a base limit restarts on Fable now, through the same cold
  // resume modelFallbackFor uses, rather than waiting out the window.
  //
  // It terminates for the same reason the step-down does: a thread already on Fable is never moved, so
  // one that re-caps on Fable either writes a model-scoped fault (and steps down, with the Fable window
  // now full and this path closed) or a base fault, and waits like any other limit.
  function fableFallbackFor(c: LimitCandidate, quota: QuotaSnapshot | undefined): { model: string; effort: string; label: string; capped: string } | undefined {
    if (c.backend !== "claude" || (c.fault.window !== "session" && c.fault.window !== "weekly")) return undefined
    if (!deps.fableFallback?.() || !fableHasHeadroom(quota?.claude)) return undefined
    const row = deps.storage.getSession(c.slug)
    // Broker rows only, and only a thread ntwine may restart — the same gates modelFallbackFor states.
    if (!row || row.claude_runtime !== "broker") return undefined
    const tele = deps.tailer.get(c.slug)
    if (mayHaveLiveBackgroundWork(tele)) return undefined
    const current = row.model?.trim() || (tele?.model ? normalizeObservedThreadModel("claude", tele.model) : undefined)
    if (current === "fable") return undefined
    const option = claudeProfile("fable")
    if (!option) return undefined
    const effort = row.effort?.trim()
    return {
      model: "fable",
      effort: effort && option.efforts.includes(effort) ? effort : option.defaultEffort,
      label: option.label,
      capped: c.fault.window,
    }
  }

  async function evalLimits(nowMs: number): Promise<void> {
    const candidates = limitCandidates(nowMs)
    if (candidates.length === 0) return
    // Read the quota-warmed usage snapshot. The account-availability trigger needs it for EVERY
    // candidate — a session limit included, now that a fresh sign-in or raised cap can free it before
    // its own clock — and the weekly window-roll check needs it too. This is a cached read (the server
    // keeps it warm on its own cadence), so a fleet parked on a limit doesn't hammer the endpoint.
    let quota: QuotaSnapshot | undefined
    if (deps.readQuota) {
      try {
        quota = await deps.readQuota()
      } catch (err) {
        log(`waker: quota read failed while checking limit resumes: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const c of candidates) {
      const fenceId = limitFenceId(c.fault)
      const deliveryId = wakeDeliveryId(c.slug, c.sessionId, fenceId)
      if (outbox.get(deliveryId)) continue // this interruption already has its one wake
      // A model-scoped cap the thread can simply step down from needs no recovery at all — the account
      // is not out of capacity, this model is. Everything else waits for its window.
      // So does a base limit the thread can sidestep onto Fable's own budget (the opt-in fableFallback).
      const fallback = modelFallbackFor(c) ?? fableFallbackFor(c, quota)
      if (!fallback && limitRecovered(c, quota, nowMs) !== true) continue
      // Persist the new pair BEFORE the wake is enqueued: the delivery forks `claude` from this row, so
      // a wake that raced ahead of the write would restart the thread on the model that just capped.
      if (fallback) deps.storage.setProfile(c.slug, fallback.model, fallback.effort)
      const item = outbox.enqueue({
        id: deliveryId,
        slug: c.slug,
        sessionId: c.sessionId,
        fenceId,
        hintKey: fallback ? `${LIMIT_HINT_PREFIX}model-switch` : `${LIMIT_HINT_PREFIX}${c.fault.window}`,
        message: fallback ? limitModelSwitchSteer(fallback.capped, fallback.label) : limitResumeSteer(c.fault.window),
        reason: fallback
          ? `${fallback.capped} limit — restarting on ${fallback.label} (interrupted ${c.fault.at})`
          : `${c.fault.window} usage limit reset (interrupted ${c.fault.at})`,
      }, nowMs).delivery
      log(`waker: queued ${c.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The dropped-report repair pass --------------------------------------------------------------
  // `turn === "idle"` is not a courtesy here, it is the CORRECTNESS condition. The runtime hands a
  // queued notification to the model at a turn boundary, so while a turn is in flight the report may
  // still be about to arrive and a repair would be a lie. Once the agent has come to rest without it,
  // the delivery that was going to happen already didn't.
  function repairDroppedReports(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const dropped = tele?.droppedReports
      if (!dropped?.length || tele?.turn !== "idle") continue
      // No cap and no ordering games: the watermark in completion-relay.ts means only completions
      // dropped during THIS process are eligible, so the due set is the handful a live thread actually
      // lost — not the hundreds of historical drops sitting in a long transcript.
      for (const report of completionsDueForRelay(dropped, { nowMs, atRest: true })) {
        const fenceId = reportFenceId(report.taskId)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this report already has its one repair
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${REPORT_HINT_PREFIX}${report.taskId}`,
          message: relayMessage(report),
          reason: `sub-agent report never reached the model (${report.summary ?? report.taskId})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
      }
    }
  }

  // ---- The user-snooze bump pass -------------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` the way the fence pass does. A snooze deadline is
  // a promise to the human, so a thread that happens to be mid-turn when it crosses must not LOSE its
  // follow-up — the delivery gate below holds the item until the thread comes to rest instead.
  //
  // Unlike an unregistered legacy timer, an overdue snooze found at boot DOES fire: the DB row is
  // itself the durable registration, so a deadline that crossed while ntwine was down is exactly the case
  // this is meant to honor. The blast radius stays bounded by the handful of threads a human snoozed.
  function evalSnoozes(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSnooze(row)
      if (!armed || armed.untilMs > nowMs) continue
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, armed.fenceId)
      if (outbox.get(deliveryId)) continue // this snooze already has its one wake
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId: armed.fenceId,
        hintKey: `${SNOOZE_HINT_PREFIX}${armed.until}`,
        message: armed.prompt,
        reason: `snooze elapsed (${armed.until})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The one-off TIMER pass ----------------------------------------------------------------------
  // One indexed read for every due alarm on every thread, rather than the row-per-session walk the other
  // passes do: timers live in their own table precisely because a thread may hold many, and most threads
  // hold none.
  //
  // Like the snooze pass, an alarm that came due while ntwine was DOWN still fires when it comes back —
  // the row is its own durable registration, and "you asked to be woken at 15:00" does not stop being
  // true because the server restarted at 14:59. Unlike the snooze pass, it does not wait for rest.
  // ---- SOURCE 9: THE BUILT-IN SIGN-OFF NUDGE ---------------------------------------------------
  // ntwine's own stop hook. Always on, not disableable per-thread, and invisible in the UI — orthogonal
  // to the operator's Goal, which keeps its own three triggers.
  //
  // THE PER-THREAD OFF SWITCH WAS TRIED AND REVERTED (2026-08-13 → 2026-08-14): the Goal's then-existing
  // "Autonomous mode" silenced this for a day, on the argument that a thread told to keep going should not
  // also be handed a menu of ways to stop. What killed it is that the reminder no longer IS that menu — it
  // opens by sending a half-finished thread back to the work — and that suppressing it took the
  // ```awaiting park with it, which nothing else on that thread's deliveries names. That switch is gone
  // entirely now (2026-08-16), so re-deriving the exemption would silence this on EVERY thread with a Goal.
  // The maintainer's 2026-08-12 call stands: keep it separate from the Goal, enabled all the time. (Until
  // 2026-08-28 that meant paying one extra transcript record per rest, both going out together; the
  // record turned out to arrive stale and draw a second ```done. Now the GOAL stands down on the rest
  // this takes — evalRestPrompts — and this never stands down for the Goal.)
  //
  // It fires on a rest that carried NO FENCE AT ALL, and its message is the sign-off protocol itself.
  // The rules therefore arrive at the one moment they are about to be used, rather than 200k tokens
  // earlier in a system prompt the agent stopped attending to (maintainer 2026-08-11: "the agent seems
  // to often forget about this stuff when it's added to the additional system prompt anyway"). A thread
  // that signs off correctly never sees it, so the mechanism costs nothing except on exactly the rests
  // that were about to produce an item nobody can triage.
  //
  // THE CAP IS CONSECUTIVE AND IT IS NOT OPTIONAL. An agent that rests bare, is told how to sign off,
  // and rests bare again would otherwise be told forever — a nag loop ntwine itself generates. After
  // SIGNOFF_NUDGE_MAX in a row with no fence appearing, it gives up and the item sits in the queue as a
  // plain bare rest, which is exactly today's behaviour.
  //
  // ONLY A FENCE GIVES THE ALLOWANCE BACK. This used to say a new word from the HUMAN did too, on the
  // reasoning that their message is a new task and the count was about the old one — but that was written
  // before the delivery-id fix below, and the code has never done it. It cannot: ntwine's own nudge lands
  // as a USER record, so "the human spoke" is a condition the nudge satisfies by nudging, which is the
  // 22-deliveries-in-four-minutes loop that fix exists to close. The consequence is worth stating plainly
  // rather than leaving as a footnote — on a thread with a Goal armed, two bare rests exhaust this
  // permanently, and everything after is the Goal alone.
  //
  // TOP-LEVEL THREADS ONLY — a sub-agent's final message is a report to its parent, not a queue item.
  // That falls out of this pass reading session rows, which sub-agents do not have.
  function evalSignoffNudges(nowMs: number): void {
    if (deps.storage.getSetting(SIGNOFF_NUDGE_SETTING) === "off") return
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      // EVERY GUARD BELOW IS signoffNudgeVerdict's (board.ts), shared with the queue rule so the queue can
      // hold a rest out while this nudge is on its way (signoffNudgeDue). The reasoning stays here, in
      // the order the predicate checks it.
      const tele = deps.tailer.get(row.slug)
      // THE AGENT MUST HAVE SPOKEN LAST, and this is the load-bearing guard rather than a nicety.
      //
      // ntwine's own delivery lands in the transcript as a USER record, so it advances `lastActivityAt`
      // AND `lastUserAt`. Keying on either meant the nudge minted a fresh delivery id for a rest that
      // had not happened, and reset its own consecutive counter with its own message: measured on a real
      // stack, 22 deliveries in four minutes to one thread. The cap could not save it, because the thing
      // being counted was resetting the count.
      //
      // `lastAssistantAt > lastUserAt` is the honest question — did the AGENT end the exchange? — and it
      // is immune to anything ntwine says, because ntwine only ever speaks as the user. A thread whose last
      // word is ntwine's own nudge is a thread that has not answered it yet.
      // Same trap as the stop hook's: a signed-out provider answers instantly, so the failure LOOKS like
      // a fenceless rest and satisfies every guard above. Teaching it to sign off cannot help — it never
      // reached the model.
      // AND THE GENERAL CASE OF IT, which the auth guard above is one instance of. A FAILED TURN IS NOT A
      // REST: a synthetic API-error record is written as an assistant record, so it advances the rest
      // instant and satisfies every guard above, and a thread whose every turn fails therefore presents
      // as an agent that keeps resting without a fence. The nudge cannot be answered — nothing the agent
      // writes reaches the model — so it is pure burn, and on the error this matters most for it is
      // WORSE than pure burn: a 400 for a conversation that has outgrown the model's context window is
      // made permanent by anything that appends to the conversation, which is exactly what the nudge
      // does. Observed unbounded in the field before the cap was fixed to bind at all; both fixes are
      // needed, because the cap alone still spends two deliveries on a thread that can never use them.
      // ANY fence means the thread already said where it stands — including `awaiting`, which is still
      // a legitimate sign-off until the registry replaces it. Nothing to teach, AND the allowance comes
      // back: signing off is the only event that proves the nudge worked, and the only one ntwine cannot
      // cause by nudging. (Guarded on a non-zero count in storage, so this is a transition, not a write
      // on every tick.)
      //
      // A REGISTRATION SAYS IT JUST AS LOUDLY, and since 2026-08-27 it is how a worker is meant to say
      // it: `done` records a row, `ask` records a row, `watch` records a row, and none of the three can
      // write the tailer's `lastFence`. Reading only the fence would nudge a worker for not writing a
      // sentence it was told to replace with a tool call — which is the protocol reminder teaching the
      // OLD protocol, on exactly the threads that adopted the new one.
      //
      // AND AN ANSWER ON ITS WAY COUNTS TOO, which is the case this guard read wrong for a day. Every
      // registration test above opens the INSTANT the human answers — the row leaves `open` and nothing
      // has replaced it yet — so the very next tick nudged a worker for resting without a fence while its
      // answer was still in the outbox. The transcript then read: the worker's rest, "NTWINE ASKED FOR A
      // SIGN-OFF", then the human's answer (maintainer 2026-08-27, on exactly that sequence). It also
      // spent one of the two nudges this thread will ever get on a thread that had done nothing wrong.
      //
      // A CANCELLATION ON ITS WAY IS THE SAME CASE FROM THE OTHER DIRECTION (2026-09-02): arming a Goal
      // dismisses the open questions wholesale, which turned a rest that had signed off WITH a question
      // into what this pass reads as a bare one — so the nudge took the rest ("you rested without a
      // fence", to a worker whose question ntwine itself had just cancelled) and the Goal stood down for
      // it. The armed-rest flag scopes it to exactly the threads whose dismissals wake on their own.
      //
      // AN OPEN QUESTION IS A SIGN-OFF ONLY AT THE REST THAT ASKED IT (upstream 2026-10-05). A question
      // CARRIED from an earlier rest is not this rest's sign-off: its card stays where it was asked, so the
      // worker names it under `questions:` in an awaiting fence (evalParkIntegrity) or withdraws it, and is
      // told so below (carriedQuestionsNudgeMessage). A question the human TYPED PAST is not carried: it
      // holds nothing, so it needs neither (board.heldQuestionRows, shared questionPassedOver).
      // A native ask is a question by another route: the thread is frozen on a modal the human has to
      // answer, and telling it to write a ```question fence is telling it to do what it already did.
      // The sentinel still ends the arrangement for sessions that predate the fence (see `saidDone`).
      // IT DOES NOT YIELD TO THE GOAL, and that is a deliberate reversal (maintainer 2026-08-12: "we
      // should keep it separate from goal… It should just be enabled all the time"). The reminder used
      // to ride the Goal's at-rest trailer so a rest produced one delivery instead of two — but that
      // made the protocol a thing a thread only learned if an operator had armed a Goal, and put a copy
      // of it in the trailer, which is its own kind of repetition. It is ntwine's own hook now: identical
      // on every thread, whatever the operator has configured.
      // THE GOAL YIELDS TO IT INSTEAD (2026-08-28). "The second delivery costs one transcript record"
      // was the accounting here until then, and it was wrong: the two went out in one tick, 5 ms apart,
      // the runtime queued the Goal's turn first, and this message — "you rested without a fence" —
      // reached a worker that had just answered the Goal WITH one. It fenced again; two Done cards. The
      // supersession check in `deliveryContext` exists for exactly that and could not fire, because it
      // ran at send. So this pass mints first in the tick and SOURCE 5 declines the rest it took.
      // AND NO GOAL-SHAPED EXEMPTION HERE — see the SOURCE 9 header for the day it had one.
      // THE CONSECUTIVE CAP. It counts fenceless rests and is cleared ONLY by a fence (above) — never by
      // a user record, because ntwine's own delivery is one, and anchoring on that let the nudge reset its
      // own counter with its own message.
      //
      // UNDER THE ANSWER-REQUIRED CONTRACT (2026-10-01; `status:` since 10-05) the fence decides the queue, so the reminder
      // teaches the key (signoffNudgeMessage) and a running child no longer excuses the rest from it
      // (board.signoffNudgeVerdict), and neither does a registered `watch`: it says when the worker wakes,
      // not whether the human is needed meanwhile.
      const needsInput = needsInputRequired(row.spawned_at)
      const verdict = signoffNudgeVerdict(row, tele, {
        questionRows: () => deps.storage.listThreadQuestions(row.slug),
        done: () => deps.storage.getThreadDone(row.slug),
        armedWatchCount: () => deps.storage.listThreadWatches(row.slug, { armedOnly: true }).length,
      }, nowMs)
      if (verdict === "signed-off") {
        if ((row.signoff_nudges ?? 0) > 0) deps.storage.resetSignoffNudges(row.slug)
        continue
      }
      if (verdict !== "nudge" || !tele?.lastAssistantAt) continue
      const spokeAt = tele.lastAssistantAt
      const fenceId = signoffFenceId(spokeAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Bound to the AGENT'S OWN last word, so one nudge per rest falls out of delivery-id uniqueness.
      // Deliberately NOT `lastActivityAt`, which ntwine's own delivery advances — see the guard above.
      if (outbox.get(deliveryId)) continue
      // THIS THREAD's live ops and their ids, so the agent can write a correct fence without going looking
      // for an id it cannot see. Shells are named by `taskId` — the handle the runtime actually showed the
      // worker — because that is the string it will naturally reach for, and the one the fence's own
      // integrity check matches on. RUNNING WORK SELECTS THE SHORT WAITING VARIANT
      // (signoffWaitingNudgeMessage): the shells (and, on a Goal thread, the children) and their fence,
      // already written, instead of sixty lines about unfinished work.
      const ops: SignoffLiveOps = {
        shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
        // DIRECT children only — the only ones an `agents:` line can name (board.liveWaitHandles); this
        // listed a Workflow's own agents and a retired child's grandchildren too, ids a fence that
        // copied them would have been refused for. Empty except on a thread with a Goal armed at rest: a
        // running direct child parks any other thread, so the verdict never reaches a send behind one,
        // while a Goal thread is asked for the `agents:` fence because only a fence holds its Goal.
        subAgents: (tele.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").map((a) => ({ id: a.taskId ?? a.id, label: a.label })),
        // The other registries, so the nudge lists EVERY kind an awaiting fence can name rather than the
        // two the fold happens to know about — a worker told about half its work writes half a fence, and
        // the half it left out is not what gets it bumped. A reply wait is listed as its thread.
        ...timerOpsOf(deps.storage, row.slug),
        prs: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind !== "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        commands: commandWatchOps(deps.storage, row.slug),
      }
      // A question CARRIED from an earlier rest takes the carried variant instead (upstream 2026-10-05):
      // the worker names it under `questions:` or withdraws it (board.carriedQuestionRows).
      const carried = carriedQuestionRows(deps.storage.listThreadQuestions(row.slug), tele)
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: SIGNOFF_HINT_KEY,
        message: withClock(carried.length > 0 ? carriedQuestionsNudgeMessage(carried.map((q) => ({ id: q.id, question: questionLine(q.spec) })), ops, needsInput) : signoffNudgeMessage(ops, needsInput), spokeAt),
        reason: carried.length > 0 ? `rested with ${carried.length} earlier question(s) neither named nor withdrawn` : "rested without signing off",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Count a nudge against the consecutive cap. Called at SEND — the only path a wake to a live runtime
  // takes — and again when the same item is confirmed later; the storage write is idempotent per
  // anchor, so the second call for one item is a no-op rather than a double count.
  function settleSignoffNudge(item: WakeDelivery): void {
    if (!isSignoffFenceId(item.fenceId)) return
    // Anchored on the REST this nudge was for (the agent's own last word, which is the fence id), so a
    // retry of the same delivery cannot count twice while a genuinely new fenceless rest does.
    deps.storage.countSignoffNudge(item.slug, item.fenceId)
  }

  // AN UNANSWERED QUESTION TAKES ITS RECOMMENDED OPTION once its card has sat in the queue for
  // QUESTION_DEFAULT_AFTER_MS (2026-10-05). The clock starts at the later of the ask and the
  // REST — a question asked mid-turn is not in front of anybody until the thread stops, and a thread
  // that wakes again (a sub-agent returning) puts it back in the Active band, where nobody is prompted.
  // The human working on the card holds it off, and the countdown's × turns it off (questionDefaultAtMs).
  // A thread's open questions go together (threadQuestionDefaults): one that waits holds them all.
  // The answer is stored exactly as the card would store it, so evalQuestionAnswers delivers it; its
  // `text` says it was ntwine's default, not the human's pick. A recommendation marked `external` (it
  // files, posts, merges or publishes) is never taken: the first option that stays on this machine is,
  // and with none the question waits. A question with nothing to take — free
  // text, `multi`, no recommendation, `danger` — waits for the human as before, and so does one they
  // typed past: it holds nothing and waits for them (shared questionPassedOver).
  function evalQuestionDefaults(nowMs: number): void {
    let answered = 0
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      const restedMs = Date.parse(tele.lastAssistantAt ?? "")
      if (!Number.isFinite(restedMs)) continue
      const open = deps.storage.listThreadQuestions(row.slug, { openOnly: true }).flatMap((q) => {
        const spec = safeQuestionSpec(q.spec)
        return spec ? [{ ...q, spec }] : []
      })
      // Together or not at all: one question that waits for the human holds the thread's others.
      const defaults = threadQuestionDefaults(open, restedMs, tele.lastHumanAt)
      if (!defaults || nowMs < defaults.atMs) continue
      for (const [id, answer] of defaults.answers) {
        if (deps.storage.answerThreadQuestion(id, JSON.stringify(answer), nowMs)) answered++
      }
    }
    if (answered > 0) {
      log(`waker: took the recommended option on ${answered} unanswered question(s)`)
      deps.refreshBoard?.()
    }
  }

  // ---- SOURCE 14: BACKGROUND SHELLS LEFT RUNNING BEHIND A QUESTION ------------------------------
  // See `strayShellsMessage` for the case that produced it. Scoped to a rest on a QUESTION because that
  // is the one rest whose card hides live shells: a bare rest already lists them in SOURCE 9's nudge, an
  // awaiting park draws them in its own table, and a done card's "Mark as done" ends the session, and
  // every shell with it, the moment the human archives it.
  //
  // A shell under an armed `watch` is kept on purpose and is not listed. Nothing is killed here — a dev
  // server the human is about to open looks exactly like a forgotten poller from outside, so the worker,
  // which knows which one it is, decides.
  function evalStrayShellNudges(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      // Claude only: the remedy it names is `TaskStop`, which a Codex worker does not have.
      if ((row.backend ?? "claude") !== "claude") continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      if (tele.authFault || tele.apiFault) continue
      // A fence beside the question names its shells or is SOURCE 12's to correct (a park must name every
      // open question under `questions:`), so only a bare rest on a question is this case.
      if (tele.lastFence) continue
      // …and only a rest the question SIGNS OFF: one carried from an earlier rest draws SOURCE 9's carried
      // reminder instead (board.carriedQuestionRows), which lists the live shells itself.
      const questionRows = deps.storage.listThreadQuestions(row.slug)
      const onQuestion = Boolean(tele.pendingQuestion) || (heldQuestionRows(questionRows, tele).length > 0 && carriedQuestionRows(questionRows, tele).length === 0)
      if (!onQuestion) continue
      const watched = deps.storage.listThreadWatches(row.slug, { armedOnly: true }).filter((w) => w.kind === "shell").map((w) => w.target)
      const stray = (tele.bgShells ?? []).filter((sh) => sh.state === "running" && ![sh.id, sh.taskId, sh.label].some((h) => h !== undefined && watched.includes(h)))
      if (stray.length === 0) continue
      const fenceId = strayShellsFenceId(stray.map((sh) => sh.id ?? sh.label))
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(strayShellsMessage(stray.map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label }))), spokeAt),
        reason: `rested on a question with ${stray.length} background shell(s) running`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }


  // ---- SOURCE 12: A PARK THAT RAN OUT, OR THAT NAMED SOMETHING DEAD -------------------------------
  //
  // The two ways an ```awaiting fence stops being true, and neither may pass silently — that is the whole
  // lesson of the three stalls this grammar replaced (see the AwaitingHint doc block in @ntwine/shared).
  //
  //  1. IT NAMED SOMETHING THAT IS NOT RUNNING. Checked the moment the fence lands. The bump says WHICH,
  //     because "your fence is wrong" sends a worker to re-read its own transcript for an id it has
  //     already lost, and that is exactly how it got the id wrong the first time.
  //  2. IT RAN OUT. `for:` elapsed and nothing resolved. The worker is brought back to re-check
  //     everything rather than the wait simply continuing, and re-parking on the same still-running
  //     items is UNLIMITED (maintainer 2026-08-15) — a three-hour build under a one-hour estimate is a
  //     bad estimate, not a failure, and each bump is a real checkpoint where it could decide otherwise.
  /** ntwine's own message, with the clock on it. Used ONLY where ntwine is the author — never on an
   *  operator-authored prompt (a Goal, a heartbeat, a snooze), whose text is delivered verbatim by
   *  invariant. A broker-run worker is told neither the date nor the time by its runtime, so without this
   *  it cannot tell a four-minute park from a four-hour one. */
  function withClock(message: string, spokeAt?: string | null, row?: Pick<SessionRow, "slug">): string {
    return `${message}\n\n${clockLine(now(), spokeAt, row?.slug)}`
  }

  /** The wake's clock line, with the thread's time left when it has a deadline (deadline.ts). Read at
   *  SEND as well as at enqueue (restampedWakeMessage), so "42m left" is the time left when the worker
   *  reads it, not when the wake was queued. */
  function clockLine(atMs: number, spokeAt: string | null | undefined, slug: string | undefined): string {
    const d = slug ? rowDeadline(deps.storage.getSession(slug)) : undefined
    return wakeTimeHeader(atMs, spokeAt, d?.atMs)
  }

  /** Rests the human asked to hear from early (requestCheckIn): slug → the rest instant it was asked of. */
  const checkInRequests = new Map<string, string>()

  function evalParkIntegrity(nowMs: number): void {
    const terminalsOf = terminalsNow()
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = withTerminals(deps.tailer.get(row.slug), terminalsOf)
      if (!tele || tele.turn !== "idle") continue
      if (tele.lastFence?.kind !== "awaiting") continue
      // The agent must have spoken last — same guard as the sign-off nudge, and for the same measured
      // reason: ntwine's own delivery lands as a USER record, so keying on activity would let this reset
      // its own dedupe and bump in a loop.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      // A failed turn is not a rest — the same guard as SOURCES 5 and 9, in both its forms. (In practice
      // the error record's own text has already cleared `lastFence`, so this rarely binds; it is here so
      // the four passes that read "the agent spoke last" agree on what a failed turn is.)
      if (tele.authFault || tele.apiFault) continue

      // AN OPEN QUESTION THE FENCE DOES NOT NAME REFUSES THE PARK, before any look at the rest of it.
      //
      // Until 2026-10-05 ANY open question refused it outright. A question outranks a wait everywhere —
      // deriveNeedsYou queues the thread on the open row before any park excusal — and a fence beside one
      // drew a parked-looking card above the ask (maintainer 2026-08-28: "Weird that there's both an
      // awaiting block and open questions"; then "it should not be allowed, basically"). That rule had a
      // cost nobody priced: it forced every later rest of a thread with an old question open to be a bare
      // one, and the old card was redrawn under it as the sign-off, whatever the worker had actually said
      // (maintainer 2026-10-05: "the pending questions that may or may not be relevant kind of supersede
      // how the agent actually signed off").
      //
      // So the fence may stand beside open questions by NAMING every one under `questions:` — which is
      // the worker saying it still needs those answers — and the cards it names are drawn at this rest.
      // One it leaves out is refused here, and the worker either names it or withdraws it with `unask`:
      // nothing stale survives a rest silently. A name that is not an open question of this thread is
      // refused too, unless it settled AFTER the rest — answered or withdrawn while the park stood, which
      // its own wake carries. Counted against PARK_BUMP_MAX like the other corrections, keyed on the rest
      // so one fence draws one bump, and checked BEFORE the honoured-park reset below on purpose.
      //
      // A QUESTION THE HUMAN TYPED PAST (2026-10-14) needs no name, and a name on one is refused like a
      // name on a settled one: it holds nothing, so a fence cannot wait on it, and a claim would move its
      // card down under this rest — the pull to the bottom of the dialog the maintainer ruled out ("I don't
      // like it staying at the bottom of the dialog"). Ignoring the name silently was the alternative; it
      // was rejected because a fence naming only passed-over questions would then still read as a wait on
      // the human and queue the thread on nothing. The card stays answerable where it was asked.
      const park = readAwaitingPark(tele.lastFence.hints)
      const questionRows = deps.storage.listThreadQuestions(row.slug)
      const heldQuestions = heldQuestionRows(questionRows, tele)
      const named = new Set(park.questions)
      const unnamed = heldQuestions.filter((q) => !named.has(q.id.toLowerCase()))
      const spokeMs = Date.parse(spokeAt)
      const passedOver: string[] = []
      const notOpen = park.questions.filter((id) => {
        const q = questionRows.find((r) => r.id.toLowerCase() === id)
        if (q && rowPassedOver(q, tele)) {
          passedOver.push(id)
          return false
        }
        if (q?.state === "open") return false
        return !q || q.settled_at === null || q.settled_at <= spokeMs
      })
      if (unnamed.length > 0 || notOpen.length > 0 || passedOver.length > 0) {
        if ((row.park_bumps ?? 0) >= PARK_BUMP_MAX) continue
        const fenceId = parkFenceId("question", spokeAt)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue
        const one = unnamed.length === 1
        const head = unnamed.length > 0
          ? `${one ? "a question of yours was" : `${unnamed.length} questions of yours were`} still OPEN and it does not name ${one ? "it" : "them"}, so ntwine refused the park.`
          : notOpen.length > 0
          ? `it names ${notOpen.length === 1 ? "a question that is" : "questions that are"} not open, so ntwine refused the park.`
          : `it names ${passedOver.length === 1 ? "a question" : "questions"} the user typed past, so ntwine refused the park.`
        const message = [
          `${PARK_CORRECTION_QUESTION_LEAD}${head}`,
          ...(unnamed.length > 0 ? ["", "Open, and not named under `questions:`:", ...unnamed.map((q) => `- \`${q.id}\` — ${questionLine(q.spec)}`)] : []),
          ...(notOpen.length > 0 ? ["", "Named, but not an open question of yours:", ...notOpen.map((id) => `- \`${id}\``)] : []),
          ...(passedOver.length > 0 ? ["", "Named, but the user typed past it — drop it; its card stays answerable where you asked it:", ...passedOver.map((id) => `- \`${id}\``)] : []),
          "",
          "A fence beside open questions names EVERY one you still need answered — `questions: [qst_…]` —",
          "and you withdraw the rest with `ntwinectl unask <id>`. A named question's card is drawn at this rest;",
          "an unnamed one stays where you asked it. Fix the list (or unask), re-send the fence, and the park",
          "takes. A fence on questions needs no other name and no `for:`.",
        ].join("\n")
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: fenceId,
          message: `${message}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
          reason: `awaiting fence leaves ${unnamed.length} open question(s) unnamed${notOpen.length ? `, names ${notOpen.length} that are not open` : ""}${passedOver.length ? `, names ${passedOver.length} typed past` : ""}`,
        }, nowMs).delivery
        deps.storage.countParkBump(row.slug, fenceId)
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        continue
      }

      const live = liveActivityOf(
        tele,
        registeredPrWatchesOf(deps.storage, row.slug),
        armedTimerIdsOf(deps.storage, row.slug),
        armedCommandWatchIdsOf(deps.storage, row.slug),
      )
      // A command watch's settled rows, by id: one that PASSED has already woken the thread, the way a
      // fired timer has, and one that expired or was cancelled is a wait that is over for another reason.
      const settledCommands = new Map(
        deps.storage.listCommandWatches(row.slug).filter((w) => w.state !== "armed").map((w) => [w.id, w.state] as const),
      )
      const deadAll = unaccountedItems(park.items, live)
      // A COMMAND WATCH THAT SETTLED UNDER THIS REST HAS ITS OWN WAKE ON THE WAY (2026-10-11). SOURCE 16
      // enqueues the pass / expiry / cancellation wake before it settles the row, so the moment the row
      // leaves `armed` the news is already queued — and a correction here would repeat it. Measured in the
      // e2e: the two went out merged as ONE delivery, the second half telling the worker "already PASSED —
      // its wake was delivered" in the same breath as the wake itself. So a settled watch whose own wake is
      // still in flight counts as accounted. Once that wake lands the worker's turn moves past this rest,
      // and a later fence naming the spent id is corrected as usual.
      const ownWakeInFlight = (i: { kind: string; value: string }): boolean => {
        if (i.kind !== "command") return false
        const settled = settledCommands.get(i.value)
        const prefix = settled === "passed" ? COMMAND_WATCH_FENCE_PREFIX
          : settled === "expired" ? COMMAND_WATCH_EXPIRED_FENCE_PREFIX
          : settled === "cancelled" ? COMMAND_WATCH_CANCELLED_FENCE_PREFIX
          : undefined
        if (!prefix) return false
        const wake = outbox.get(wakeDeliveryId(row.slug, row.session_id, `${prefix}:${i.value}`))
        // …or already delivered, when that wake was queued after this rest: this fork's outbox can send it
        // inside the same pass, before this check runs, and the rest it answers is still the last word.
        return wake?.state === "pending" || wake?.state === "leased" || (wake !== undefined && wake.createdAt > Date.parse(spokeAt))
      }
      const dead = deadAll.filter((i) => !ownWakeInFlight(i))
      const expiresAt = parkExpiresAt(park, Date.parse(spokeAt))
      const requested = checkInRequests.get(row.slug) === spokeAt
      // A PARK ON NOTHING BUT RUNNING SUB-AGENTS NEVER EXPIRES (maintainer 2026-10-24). Each child's return
      // wakes the parent, and one that stalls goes `stale`, leaves the live set and is corrected as dead
      // below. Until then this woke the parent every 30 minutes to check in: 791 wakes over 2026-10-10..24
      // (586 on one thread), each re-reading ~290k tokens of context to write a progress note nobody was
      // queued to read. The human's own "Ask for update" still sends one (`requested`).
      const onRunningChildren = park.items.length > 0 && park.items.every((i) => i.kind === "agent") && dead.length === 0
      const expired = requested || (!onRunningChildren && expiresAt !== null && nowMs >= expiresAt)
      // NAMES NOTHING — the loudest case, and it was the silent one. A fence carrying only `for:` and
      // `reason:` is a worker declaring a wait with NOTHING that can wake it: ntwine refuses the park, the
      // thread queues, and until 2026-08-16 nobody told the worker why. It was routed to the sign-off
      // nudge, which only fires on a rest carrying NO fence — so this exact shape got nothing at all.
      //
      // Observed in the wild, which is why it is now the most explicit bump of the three: `for: 24h` plus
      // "TypeScript legs still running on 1a5d0804 … waiting on the checks and your merge" — a worker
      // that could have registered a PR watcher and been told the moment CI settled, waiting on nothing
      // for a day instead.
      //
      // `steps:` NAME THE HUMAN (2026-10-03), so a fence carrying only steps is not this case: it waits on
      // the one party whose reply wakes the thread, from the queue it is already in. With no `for:` it
      // falls through the malformed-fence skip below and is simply honoured; with one, it expires.
      // `questions:` name the human the same way (2026-10-05), and the answer is the wake.
      const nameless = park.items.length === 0 && !parkOnHuman(park)
      // HONOURED ⇒ the corrective allowance comes back. A park ntwine can actually honour is the one
      // event that proves a correction landed, and — unlike any activity signal — not one ntwine can
      // cause by correcting. Guarded on a non-zero count so this is a transition, not a write on every
      // tick, exactly as the sign-off nudge's reset is. It deliberately does NOT `continue`: an honoured
      // park can still have run out, and that bump is owed.
      //
      // NO "WHERE DOES THIS SIT?" CORRECTION ANY MORE (2026-10-24). From 2026-10-01 a new-contract fence
      // with no readable `status:` was refused here and the worker told to re-send it with the line added.
      // ntwine now derives the answer from what the fence names (awaitingStatus in @ntwine/shared), so a
      // fence that names something always has one, and the only fence left without one names nothing —
      // which the `nameless` correction below already covers.
      if (parkIsHonoured(park, live) && (row.park_bumps ?? 0) > 0) deps.storage.resetParkBumps(row.slug)
      if (dead.length === 0 && !expired && !nameless) continue
      // A park with no `for:` here is one on the human alone (steps or questions): it has no clock, so
      // nothing below applies. Every park naming an item has one — written, or its items' default.
      if (park.forMs === null && !nameless) continue

      // FINISHED IS NOT THE SAME AS MISSING, and conflating them is what drove the worst churn observed.
      // `read-the-file-read-up` wrote 284 awaiting fences: it parked on a build, the build FINISHED, and
      // ntwine answered "NOT RUNNING" — which reads as "your fence is broken", so the worker relaunched
      // instead of reading the output it was waiting for, and went round again. ntwine knows the
      // difference (the fold retires a shell with its finish instant), so it should say which.
      const finishedHandles = new Set<string>()
      for (const sh of tele.retiredShells ?? []) {
        for (const h of [sh.taskId, sh.id, sh.label]) if (h) finishedHandles.add(h)
      }
      // FINISHED-not-MISSING holds for every kind, not only shells (it shipped shell-only). A sub-agent
      // that RETURNED reads `rested` in telemetry, and a timer that FIRED keeps its settled row — ntwine
      // can tell all three apart from a typo'd id, and the note below spends that knowledge. `stale`
      // stays out: it means "completion signal lost", which is genuinely ambiguous, not finished.
      for (const a of tele.subAgents ?? []) {
        if (a.state !== "rested") continue
        for (const h of [a.taskId, a.id, a.label]) if (h) finishedHandles.add(h)
      }
      // A DEMOTED shell is a third case, neither finished nor missing: ntwine has its launch, saw no
      // completion notice, and can no longer find its process (tailer.ts probeShellsAlive). Calling that
      // "nothing by that name" sent a worker hunting for a typo in an id it had copied exactly — and,
      // before 2026-10-05, said so of a shell that was still running.
      const staleShellHandles = new Set<string>()
      for (const sh of tele.bgShells ?? []) {
        if (sh.state !== "stale") continue
        for (const h of [sh.taskId, sh.id, sh.label]) if (h) staleShellHandles.add(h)
      }
      const firedTimers = new Set(
        deps.storage.listThreadTimers(row.slug).filter((t) => t.state === "fired").map((t) => t.id),
      )
      // A REPLY WAIT that is no longer armed: the answer CANCELS it (router messageThread), and one nobody
      // answered lapses by firing. Keyed the way a `threads:` entry is checked, newest wait per thread.
      const settledReplyWaits = new Map<string, { state: string; settledAt: number }>()
      for (const t of deps.storage.listThreadTimers(row.slug)) {
        const reply = t.state === "armed" ? undefined : replyWaitOf(t.prompt)
        if (!reply) continue
        for (const name of [reply.handle, reply.slug]) {
          const key = threadAwaitKey(name)
          const settledAt = t.settled_at ?? t.fire_at
          if ((settledReplyWaits.get(key)?.settledAt ?? -Infinity) < settledAt) settledReplyWaits.set(key, { state: t.state, settledAt })
        }
      }
      const replyWaitOfItem = (i: { kind: string; value: string }) => (i.kind === "thread" ? settledReplyWaits.get(threadAwaitKey(i.value)) : undefined)
      const answeredItem = (i: { kind: string; value: string }) => replyWaitOfItem(i)?.state === "cancelled"
      // A TERMINAL, by the name the fence gives it under `threads:` (or `terminals:`, its first spelling) —
      // and whether it has stopped moving (a prompt or an exit), which SOURCE 17 wakes it for.
      const terminalOf = (i: { kind: string; value: string }): TerminalLive | undefined =>
        i.kind === "terminal" || i.kind === "thread" ? tele.terminals?.find((t) => [t.id, t.handle].some((h) => h && terminalAwaitKey(h) === terminalAwaitKey(i.value))) : undefined
      const terminalSettled = (i: { kind: string; value: string }) => {
        const t = terminalOf(i)
        return t !== undefined && t.outcome !== "running"
      }
      const terminalEnded = (i: { kind: string; value: string }) => terminalSettled(i) && terminalOf(i)!.outcome !== "prompt"
      const finishedItem = (i: { kind: string; value: string }) =>
        finishedHandles.has(i.value) || (i.kind === "timer" && firedTimers.has(i.value)) || answeredItem(i) ||
        (i.kind === "command" && settledCommands.get(i.value) === "passed") || terminalEnded(i)
      // SILENT IS NOT MISSING EITHER. A sub-agent that has written nothing for longer than its allowance —
      // 15 minutes of awake time, counted from the deadline of a Bash wait it declared (tailer.ts
      // pendingCallDeadline) — reads `stale`. The id is right and the child may well be alive; what ntwine
      // knows is that it has gone quiet past what it said it would. Saying "nothing by that name" sent the parent hunting for a typo. This wake IS the
      // regular-update expectation on a child: nothing is stopped, the parent is told, and it decides.
      const silentSince = new Map<string, string | undefined>()
      for (const a of tele.subAgents ?? []) {
        if (a.state !== "stale") continue
        for (const h of [a.taskId, a.id, a.label]) if (h) silentSince.set(h, a.lastActivityAt)
      }
      const silentItem = (i: { kind: string; value: string }) => i.kind === "agent" && silentSince.has(i.value)
      const status = park.items.map((i) => {
        const gone = deadAll.some((d) => d.kind === i.kind && d.value === i.value)
        // AN UNREGISTERED PR GETS ITS OWN NOTE, because "nothing by that name" is true but useless for
        // this one kind. A shell or a sub-agent is unaccounted because it FINISHED or the id is wrong;
        // a PR is unaccounted because the worker never registered it — a different mistake with a
        // different fix, and naming the fix here is the whole basis of the maintainer's 2026-08-24
        // decision to keep declaring and registering separate ("the worker learns to call the tool
        // first"). Without this line the correction sends it to `ntwinectl activity`, which will
        // faithfully report that it has no PRs — true, and no help at all.
        const note = !gone
          ? "still running"
          // A fired timer's "result" is the wake itself, already delivered as a user turn — so the
          // note points back at the transcript rather than at a result that is not a thing.
          : i.kind === "timer" && firedTimers.has(i.value)
          ? "already FIRED — its wake was delivered; there is nothing left to wait on"
          : answeredItem(i)
          ? "ANSWERED — its reply was delivered to you; there is nothing left to wait on"
          : i.kind === "thread" && replyWaitOfItem(i)?.state === "fired"
          ? "LAPSED — no reply came while the wait stood; read where it is with `ntwinectl read-thread`"
          : i.kind === "command" && settledCommands.get(i.value) === "passed"
          ? "already PASSED — its wake was delivered; there is nothing left to wait on"
          : i.kind === "command" && settledCommands.has(i.value)
          ? `no longer armed (${settledCommands.get(i.value)}) — register it again with \`ntwinectl watch-command add\` if you still need the wait`
          : terminalOf(i)?.outcome === "prompt"
          ? `WAITING FOR INPUT — read it with \`ntwinectl read-thread ${i.value}\` and answer with \`ntwinectl message-thread ${i.value}\``
          : terminalEnded(i)
          ? `ENDED — read how with \`ntwinectl read-thread ${i.value}\``
          : finishedItem(i)
          ? "FINISHED — its result is waiting for you"
          : silentItem(i)
          ? `SILENT — nothing from it since ${silentSince.get(i.value) ?? "it started"}, longer than any call it has pending declared. It may be hung; ntwine stopped nothing. Read its transcript, then wait on it again or \`TaskStop\` it`
          : i.kind === "shell" && staleShellHandles.has(i.value)
          ? "GONE WITHOUT A COMPLETION NOTICE — ntwine knows this shell, but nothing holds its output file and no process it could be is still running; read its output to see how it ended"
          : i.kind === "pr"
          ? "NOT REGISTERED — register it with `ntwinectl watch-pr add` first, then name it here"
          : i.kind === "thread"
          ? "NOT AWAITED — ask it with `ntwinectl message-thread` and `--await-reply` first, then name it here"
          : i.kind === "command"
          ? "NOT REGISTERED — register it with `ntwinectl watch-command add` first, then name the id it gives you here"
          : "NOT RUNNING (nothing by that name)"
        // The PLURAL key, because that is what the worker has to write. `i.kind` is the internal wire
        // kind and stayed singular through the 2026-08-24 YAML cutover; printing it raw taught a
        // spelling the parser now refuses.
        return `- \`${AWAITING_KEY_OF[i.kind]}: [${i.value}]\` — ${note}`
      })
      // A park on `steps:` that ran out is the only status line here ntwine cannot read off a registry:
      // the human may have done the steps without pressing anything, so the line sends the worker to
      // check the world rather than to re-post the same steps blind.
      if (park.steps.length > 0) {
        status.push(`- \`steps:\` (${park.steps.length}) — the user has not replied; check whether they were done anyway before you post them again`)
      }
      if (park.questions.length > 0) {
        status.push(`- \`questions:\` (${park.questions.length}) — not answered yet; name the ones you still need in your next fence and withdraw the rest`)
      }
      // When EVERY dead name simply finished, the news is not "your fence is wrong" — it is "the thing
      // you were waiting for is done". Different fact, different next action.
      const allFinished = dead.length > 0 && dead.every(finishedItem)
      // ONE EVENT, ONE WAKE. A shell that finished AFTER this rest gets its own wake from SOURCE "shell
      // completions" (evalShellCompletions), which is the same news. Sending this one too delivered both,
      // merged under two headings — "the work you parked on has FINISHED" and "your background shell
      // finished" — for the one shell (observed 2026-10-01 on wsl-cleanup). So when every dead name is
      // such a shell, that wake speaks and this one stays quiet. A shell that finished BEFORE the rest
      // gets no completion wake (the runtime folded it into the turn), so the park still says it here.
      const finishedAfterRest = new Set<string>()
      const restedAtMs = Date.parse(tele.lastAssistantAt ?? "")
      for (const sh of tele.retiredShells ?? []) {
        if (!(Date.parse(sh.finishedAt ?? "") > restedAtMs)) continue
        for (const h of [sh.taskId, sh.id, sh.label]) if (h) finishedAfterRest.add(h)
      }
      const retired = retiredAwaitingKindsIn(tele.lastFence.body ?? "")
      // The same for a thread that ANSWERED after this rest: the answer is its own wake.
      const answeredAfterRest = (i: { kind: string; value: string }) => answeredItem(i) && replyWaitOfItem(i)!.settledAt > restedAtMs
      // …and for a terminal that reached a prompt or ended after it: SOURCE 17 carries that.
      const terminalSettledAfterRest = (i: { kind: string; value: string }) => terminalSettled(i) && Date.parse(terminalOf(i)!.at ?? "") > restedAtMs
      // (Each of the three implies its item finished, so this is the `allFinished` case — a terminal at a
      // prompt included, which is news but not "finished".)
      if (dead.length > 0 && retired.length === 0 && dead.every((i) => (i.kind === "shell" && finishedAfterRest.has(i.value)) || answeredAfterRest(i) || terminalSettledAfterRest(i))) continue
      const head = retired.length > 0
        ? [
          // The LEAD comes from shared so the transcript can recognise this delivery as a correction and
          // drop it (isParkCorrection) — one string, written and read in one place, never two that drift.
          `${PARK_CORRECTION_RETIRED_LEAD}${retired.length === 1 ? "a line kind" : "line kinds"} that no longer exist, so ntwine ignored ${retired.length === 1 ? "it" : "them"} — the`,
          "fence named nothing and your thread stayed in the queue.",
          "",
          ...retired.map((k) => `- \`${k}:\` is GONE → ${RETIRED_AWAITING_REPLACEMENT[k]}`),
          "",
          "THE FRONTMATTER IS YAML, and every key is checked against something ntwine can see:",
          "",
          "```awaiting",
          "shells: [<runtime task id>]   background shells you launched",
          "agents: [<runtime agent id>]  sub-agents you dispatched",
          "timers: [tmr_…]               timers from `ntwinectl timer set`",
          "prs:    [owner/repo#123]      PRs registered with `ntwinectl watch-pr add`",
          "commands: [cmw_…]             command watches from `ntwinectl watch-command add`",
          "threads: [@handle]            threads asked with `--await-reply`, or terminals",
          "for:    2h                    optional — a DURATION, never an instant",
          "---",
          "only when the user can act now: one or two sentences on what to look at",
          "```",
          "",
          "Keep the keys you need and drop the rest. There is NO prose above the `---`: a colon or a ` #`",
          "in a sentence breaks the YAML, which is why `reason:` is gone.",
          "",
          "`ntwinectl activity` lists everything you have running, and prints it back as a ready-to-paste",
          "fence. If you are not waiting on anything, you are not awaiting — end with ```done, or register",
          "a question with `ntwinectl ask`.",
        ].join("\n")
        : nameless
        ? [
          `${PARK_CORRECTION_NAMES_LEAD}nothing to wait on, so it is not a park — your thread is still`,
          "in the queue, and nothing will wake you.",
          "",
          "A wait has to be something ntwine can SEE. Register one, then name it:",
          "",
          "- a pull request → `ntwinectl watch-pr add` (it wakes you on CI going green or red, and on every",
          "  later review and comment) → `prs: [owner/repo#123]`",
          "- a wall-clock check → `ntwinectl timer set` → `timers: [tmr_…]`",
          "- an outside condition a command can check (a package version, a release run, a URL coming up)",
          "  → `ntwinectl watch-command add` → `commands: [cmw_…]`",
          "- work you already launched → `shells: [<the id your runtime gave you>]` or `agents: [<id>]`",
          "- a terminal, yours or the user's → `threads: [@handle]`",
          "",
          "The frontmatter is YAML: PLURAL keys, each taking a list, and your prose below the `---`.",
          "Use `ntwinectl activity` to read it all back as a ready-to-paste fence.",
          "",
          "AND IF YOU ARE NOT WAITING ON ANYTHING, you are not awaiting — you are done. End with ```done,",
          "or register a question with `ntwinectl ask` if you need the user.",
        ].join("\n")
        // THESE TWO LIVE IN @ntwine/shared, beside the parsers that read them back. Same rule as
        // `limitResumeSteer`: a formatter the chat cannot parse falls through NtwineWake's legacy
        // fallback and prints its agent-facing body verbatim as a bordered card. The wording is
        // unchanged — only its address is.
        : expired
        ? parkExpiredWakeMessage(status, park.items.some((i) => i.kind === "agent"), requested)
        : allFinished
        ? parkFinishedWakeMessage(status, dead.length !== 1)
        : dead.every(silentItem)
        ? [
          `${PARK_CORRECTION_NAMES_LEAD}${dead.length === 1 ? "a sub-agent that has" : "sub-agents that have"} gone silent past what ${dead.length === 1 ? "it" : "they"} declared, so ntwine woke you instead of holding the park.`,
          "",
          ...status,
          "",
          "A child blocked in a long foreground call is judged against that call's own `timeout`; this one has",
          "outlived it. Check it before waiting again: a re-park naming it wakes you the same way while it stays silent.",
        ].join("\n")
        : [
          `${PARK_CORRECTION_NAMES_LEAD}${dead.length === 1 ? "something that is" : "things that are"} not running, so it is not a park and your thread stayed in the queue.`,
          "",
          ...status,
          "",
          "Use `ntwinectl activity` to read back what you actually have out, with the exact id each line",
          "needs, then re-fence naming only those — or end in ```done or a registered question",
          "(`ntwinectl ask`) if there is nothing left to wait for.",
        ].join("\n")

      const cause = retired.length > 0 ? "retired" : nameless ? "nameless" : expired ? "expired" : "dead"
      // THE IDS, INLINE — not a tool name. Every correction here used to end at "use
      // `mcp__ntwine__activity`", which a worker dispatched before that tool existed cannot call: its MCP
      // server is frozen at dispatch. Those are precisely the threads still writing fences this check
      // refuses, so the one remedy on offer was unreachable by the population that needed it. The lines
      // below can be copied straight into a fence, and the tool remains the on-demand form of the same
      // list. `expired` is excluded: its status list already names every item, by definition still live.
      const ops = cause === "expired" ? [] : liveOpsLines({
        shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
        subAgents: (tele.subAgents ?? []).filter((a) => a.state === "running").map((a) => ({ id: a.taskId ?? a.id, label: a.label })),
        ...timerOpsOf(deps.storage, row.slug),
        prs: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind !== "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        commands: commandWatchOps(deps.storage, row.slug),
      })
      // NOTHING RUNNING is itself the answer, and the most common one for a nameless fence: a worker
      // waiting on nothing is not awaiting, it is done. Said plainly rather than left as an empty list.
      // THE CLOCK, on ntwine's own correction. A broker-run worker is told neither the date nor the time by
      // its runtime (measured: zero date injections across an entire session), so it cannot tell that the
      // `for: 1h` it keeps writing has never once been reached — its last four parks each lasted minutes.
      // Elapsed is the feedback that turns the next `for:` into a judgement instead of a guess.
      const clock = wakeTimeHeader(nowMs, spokeAt)
      const message = ops.length > 0
        ? `${head}\n${ops.join("\n")}`
        // A wait that FINISHED is not a fence naming nothing: its head already says "read the result and
        // carry on", and the "nothing could wake you, finish in done" tail contradicted it.
        : cause === "expired" || allFinished
        ? head
        : `${head}\n\nYou have NOTHING running right now — no shell, no sub-agent, no timer, no registered\npull request. There is nothing that could wake you, so this thread is not awaiting: finish in\n\`\`\`done, or register a question with \`ntwinectl ask\`.`
      // THE CONSECUTIVE CAP, and the reason SOURCE 12 needed one. A correction is only worth sending to a
      // worker that can act on it, and a worker whose contract froze before this grammar existed cannot:
      // no fence it knows how to write will pass the check. Uncapped, that is a closed loop — bump, wake,
      // rest on the same bad fence under a new instant, bump — and it ran on the live board for 4h45m at
      // 617 bumps to a single thread, one every ~28 seconds, before anyone counted them (2026-08-17).
      //
      // `expired` is exempt because it is not a correction: the fence was right, the clock ran out, and
      // re-parking on still-running work is unlimited by explicit decision (maintainer 2026-08-15, "a
      // three-hour build under a one-hour estimate is a bad estimate, not a failure").
      if (cause !== "expired" && (row.park_bumps ?? 0) >= PARK_BUMP_MAX) continue
      // Keyed on the REST plus which failure it is, so one fence gets one bump per cause: a park that is
      // bumped for a dead id and later expires is two different pieces of news.
      // A requested check-in keys apart from the natural expiry of the same rest: one click, one wake,
      // and the hour still owes its own if the worker somehow never re-rests.
      const fenceId = parkFenceId(requested && cause === "expired" ? "requested" : cause, spokeAt)
      if (requested) checkInRequests.delete(row.slug)
      const messageWithClock = `${message}\n\n${clock}`
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: messageWithClock,
        reason: retired.length > 0 ? `awaiting fence uses retired kind(s): ${retired.join(", ")}` : nameless ? "awaiting park names nothing" : requested ? "the human asked for an update" : expired ? "awaiting park expired" : allFinished ? "the work you parked on finished" : `awaiting park named ${dead.length} dead item(s)`,
      }, nowMs).delivery
      // COUNTED AT ENQUEUE, not at delivery — the one place the sign-off nudge's idiom does not transfer.
      // A nudge counts when it lands because it fires on a rest the thread is dispatchable for; a
      // correction is enqueued whenever a bad fence is seen, and that can outrun the delivery loop. Pinned
      // by the loop test: settling on delivery left the cap unreached and 12 unlearning rests drew 12
      // bumps, which is the runaway this exists to stop.
      if (cause !== "expired") deps.storage.countParkBump(row.slug, fenceId)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- SOURCE 11: THE REGISTERED PR WATCHERS ------------------------------------------------------
  // A worker registers a pull request with `ntwinectl watch-pr` and ntwine brings it back whenever
  // something happens on it (maintainer 2026-08-14: "The agent should have a tool to register a PR
  // watcher… it should get notified when CI either succeeds or failed and on follow-up reviews and
  // comments").
  //
  // IT REPORTS REPEATEDLY, which is what makes it unlike every other source here. A timer rings once and
  // is spent; this one stays armed across CI going red, a fix, CI going green and a reviewer's comment —
  // four wakes from one registration. So the delivery id carries a REPORT NUMBER: keyed on the watcher
  // id alone, the outbox would dedupe every wake after the first and the watcher would look broken from
  // the second event onward.
  //
  // ONLY A CHANGE FIRES. The cursor holds what has already been reported — the review activity ids, and
  // the last check verdict announced — so a poll that finds the same red CI and the same three comments
  // says nothing. A watcher that re-reported its own last message on every tick is a nag loop with an
  // API bill.
  //
  // THE FENCE IS NOT CONSULTED HERE, deliberately. Registration is a tool call and watching is a fact;
  // the ```awaiting fence separately STATES what the thread waits on, and a thread with no fence at all
  // is woken exactly the same way.
  type PrWatchChecks = NonNullable<Parameters<typeof prWatchWakeMessage>[0]["checks"]>
  /** WHAT THE WATCHER'S LATEST REPORT SAYS, structurally — the inputs its message was built from — so a
   *  poll that finds more news while that report is still waiting can mint one that says all of it
   *  (see the re-mint in evalPrWatches). Written at every mint; read only while a report is undelivered. */
  interface PrWatchHeld { items: GithubWakeItem[]; omitted: number; checks?: PrWatchChecks; changes?: string[] }
  /** `merge`, `labels` and `reviewers` are the PR's own state as of the last poll, and they are a
   *  BASELINE before they are a trigger: absent (a watcher armed before 2026-09-04, or a poll that fell
   *  back to `gh`, which does not fetch them) means "not known", so the next poll records them and says
   *  nothing. Reporting a PR's existing labels as news the first time ntwine looks at them would spend a
   *  turn on facts the worker put there itself — the same rule the review baseline already follows. */
  interface PrWatchCursor {
    seen: string[]
    checks?: string
    report?: number
    held?: PrWatchHeld
    merge?: string
    labels?: string[]
    reviewers?: string[]
    /** Issue watchers only: who was assigned as of the last poll, the same baseline rule as `labels`. */
    assignees?: string[]
  }
  const prWatchPolledAt = new Map<string, number>() // refKey → last fetch, shared across threads
  /** The poll's key for a row — the ref, prefixed for an issue (see the refs loop in evalPrWatches). */
  const watchKey = (w: Pick<PrWatchRow, "kind" | "owner" | "repo" | "number">): string =>
    `${w.kind === "issue" ? "issue:" : ""}${w.owner}/${w.repo}#${w.number}`
  const prStatusFallback = concurrencyGate(PR_STATUS_FALLBACK_LIMIT)

  function readPrWatchHeld(raw: unknown): PrWatchHeld | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const h = raw as Record<string, unknown>
    if (!Array.isArray(h.items)) return undefined
    const items = h.items.flatMap((i: unknown) => (GithubWakeItem.safeParse(i).success ? [i as GithubWakeItem] : []))
    const c = h.checks && typeof h.checks === "object" ? h.checks as Record<string, unknown> : undefined
    const checks: PrWatchChecks | undefined = c && (c.verdict === "passing" || c.verdict === "failing" || c.verdict === "gated")
      ? {
        verdict: c.verdict,
        passed: Number(c.passed) || 0,
        failed: Number(c.failed) || 0,
        failing: Array.isArray(c.failing) ? c.failing.filter((x: unknown): x is string => typeof x === "string") : [],
        // Absent on a report held across the 2026-09-04 upgrade. Read as 0/[] rather than defaulted at
        // the formatter, so a folded-forward report says exactly what its own poll saw and no more.
        skipped: Number(c.skipped) || 0,
        gated: Number(c.gated) || 0,
        gating: Array.isArray(c.gating) ? c.gating.filter((x: unknown): x is string => typeof x === "string") : [],
      }
      : undefined
    const changes = Array.isArray(h.changes) ? h.changes.filter((x: unknown): x is string => typeof x === "string") : undefined
    return { items, omitted: Number(h.omitted) || 0, ...(checks ? { checks } : {}), ...(changes?.length ? { changes } : {}) }
  }

  /** A list of strings off a cursor, or `undefined` for "this poll never knew" — which is a third state
   *  and not the same as an empty list. A PR with no labels and a poll that could not read them must not
   *  compare equal, or the first real reading would announce every label as newly added. */
  const readCursorList = (raw: unknown): string[] | undefined =>
    Array.isArray(raw) ? raw.filter((x: unknown): x is string => typeof x === "string") : undefined

  /** What changed about the PR ITSELF since the last poll — everything the watcher now sees that is
   *  neither CI nor a comment. Each entry is one clause of the wake's own sentence.
   *
   *  ONLY THE DIRECTIONS THAT ARE ACTIONABLE, deliberately. A PR that starts conflicting is work the
   *  worker must do; one that stops conflicting stopped because somebody did that work, and telling them
   *  is a wake spent on their own commit. A review REQUESTED names who is now expected to look; a
   *  request withdrawn does not need a turn. Labels go both ways because on a real project they are the
   *  state machine — `needs-ci`, `blocked`, `author ready`, `commit-queue-failed` — and losing one is as
   *  much news as gaining it. */
  function prStateChanges(
    cursor: PrWatchCursor,
    merge: string | undefined,
    labels: string[] | undefined,
    reviewers: string[] | undefined,
  ): string[] {
    const out: string[] = []
    if (merge === "conflicting" && cursor.merge !== undefined && cursor.merge !== "conflicting") {
      out.push("now CONFLICTS with the base branch")
    }
    if (labels && cursor.labels) {
      const added = labels.filter((l) => !cursor.labels!.includes(l))
      const removed = cursor.labels.filter((l) => !labels.includes(l))
      // The minus is U+2212, matching the plus in width so a list of both reads as one column.
      const parts = [...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)]
      if (parts.length) out.push(`labels ${parts.join(", ")}`)
    }
    if (reviewers && cursor.reviewers) {
      const added = reviewers.filter((r) => !cursor.reviewers!.includes(r))
      if (added.length) out.push(`review requested from ${added.join(", ")}`)
    }
    return out
  }

  function readPrWatchCursor(raw: string | null): PrWatchCursor {
    try {
      const parsed = raw ? JSON.parse(raw) : null
      if (!parsed || typeof parsed !== "object") return { seen: [] }
      const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((x: unknown): x is string => typeof x === "string") : []
      const held = readPrWatchHeld(parsed.held)
      const labels = readCursorList(parsed.labels)
      const reviewers = readCursorList(parsed.reviewers)
      const assignees = readCursorList(parsed.assignees)
      return {
        seen,
        checks: typeof parsed.checks === "string" ? parsed.checks : undefined,
        report: Number(parsed.report) || 0,
        ...(held ? { held } : {}),
        ...(typeof parsed.merge === "string" ? { merge: parsed.merge } : {}),
        ...(labels ? { labels } : {}),
        ...(reviewers ? { reviewers } : {}),
        ...(assignees ? { assignees } : {}),
      }
    } catch {
      return { seen: [] }
    }
  }

  /** The verdict word a checks stamp carries — `<head>:<verdict>:<failing jobs>` — or the bare word a
   *  pre-stamp cursor holds. Only the gated rule in `evalPrWatches` reads it; every other verdict
   *  compares the whole stamp, head and all. */
  function stampVerdict(stamp: string | undefined): string | undefined {
    if (!stamp) return undefined
    const parts = stamp.split(":")
    return parts.length >= 2 ? parts[1] : parts[0]
  }

  async function evalPrWatches(nowMs: number): Promise<void> {
    // EXPIRY FIRST, so an expired watcher is never polled again and never fires one last time on its way
    // out. A PR nobody touches would otherwise be polled forever, and a thread parked on it would wait
    // forever with it — the unbounded wait this whole grammar exists to end (maintainer 2026-08-15).
    // The worker is TOLD, because a watcher that vanishes silently is the same stall in a new costume:
    // it would rest believing it is covered.
    //
    // AND THE WAKE STAYS, even though the wake is what the noise was made of. The fix was the CEILING,
    // not this branch: an expiry now means the worker's own chosen duration genuinely ran out, which is
    // real news and rare. Muting it instead would have bought quiet by making the failure silent —
    // exactly the trade the paragraph above refuses.
    for (const w of deps.storage.expiredPrWatches(nowMs)) {
      const row = deps.storage.getSession(w.thread_slug)
      deps.storage.settlePrWatch(w.id, nowMs)
      const ref = `${w.owner}/${w.repo}#${w.number}`
      log(`waker: settled ${w.thread_slug} — ${w.kind === "issue" ? "issue" : "pr"} watcher ${w.id} expired (${ref})`)
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = prWatchExpiredFenceId(w.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        // In @ntwine/shared beside `parsePrWatchExpiredWake`, for the reason above.
        message: prWatchExpiredWakeMessage(ref, w.kind === "issue" ? "issue" : "pull"),
        reason: `${w.kind === "issue" ? "issue" : "pr"} watcher ${w.id} expired (${ref})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
    const armed = deps.storage.armedPrWatches()
    if (armed.length === 0) return
    // ONE FETCH PER PR, however many threads watch it. Two workers on the same PR is the ordinary shape
    // of a review round, and paying GitHub twice for one answer is how a rate limit arrives.
    //
    // AND NOT AT ALL FOR AN ARCHIVED THREAD (2026-09-04). The row stays ARMED, deliberately — an archived
    // thread can be reopened and the watch is still the worker's own outstanding intent, which is why the
    // loop below skips rather than settles it. But the fetch that fed that skip was already made: every
    // reading for an archived thread's PR was computed and thrown away. Nothing gates archiving the way
    // `done` is gated (markOwnDone REFUSES while a watcher is armed; archiving does not), so a thread
    // parked on a 180d watcher can be archived and go on polling GitHub for six months for readings no
    // thread can receive. Skipped per WATCHER, not per ref, so a PR a live thread also watches still
    // costs exactly one fetch.
    const threadLive = new Map<string, boolean>()
    const isThreadLive = (slug: string): boolean => {
      const cached = threadLive.get(slug)
      if (cached !== undefined) return cached
      const row = deps.storage.getSession(slug)
      const live = !!row && row.state !== "archived" && row.archived !== 1
      threadLive.set(slug, live)
      return live
    }
    const refs = new Map<string, PrRef & { kind: "pull" | "issue" }>()
    for (const w of armed) {
      if (!isThreadLive(w.thread_slug)) continue
      // An ISSUE's key carries its kind (2026-09-14), so an issue and a PR that happen to share a number
      // in one repo — impossible on GitHub, but a worker can register #7 both ways — are two fetches
      // with two answers, and neither reading is ever filed under the other.
      const key = watchKey(w)
      const last = prWatchPolledAt.get(key) ?? 0
      if (nowMs - last < PR_WATCH_POLL_MS) continue
      refs.set(key, { owner: w.owner, repo: w.repo, number: w.number, kind: w.kind === "issue" ? "issue" : "pull" })
    }
    const status = new Map<string, GithubWatchStatus>()
    const activity = new Map<string, GithubReviewActivity[]>()
    /** The ISSUE's own reading, for the refs that are issues. Nothing else in this poll touches them:
     *  the CI status book, the `gh` fallback and the merge/reviewer baselines are all PR facts. */
    const issues = new Map<string, GithubIssueSnapshot>()
    /** The PR's own state, which `GithubWatchStatus` does not carry — it is a CI projection, and these
     *  are triggers rather than a readout. `undefined` for a ref the `gh` fallback served, which does not
     *  ask for them; that is the "not known" the baseline rule turns on. */
    const meta = new Map<string, { labels?: string[]; reviewRequests?: string[] }>()
    await Promise.all([...refs].map(async ([key, ref]) => {
      prWatchPolledAt.set(key, nowMs)
      if (ref.kind === "issue") {
        // AN ISSUE RIDES THE SAME BATCHED REQUEST as the PRs beside it and has no `gh` fallback: it was
        // born on the GraphQL path, so a shape surprise is logged through the same failure ledger and
        // the next poll simply asks again.
        try {
          const result = normalizeReviewResult(await fetchGithubReview(ref))
          if (result.status === "ok") {
            activity.set(key, result.activity)
            if (result.issue) {
              issues.set(key, result.issue)
              publishGithubIssueStatus(`${ref.owner}/${ref.repo}#${ref.number}`, result.issue, nowMs)
            }
            recordReviewSuccess(key, "issue-watch registry")
          } else if (result.status === "error") recordReviewFailure(key, "issue-watch registry", result, nowMs)
        } catch (err) {
          recordReviewFailure(key, "issue-watch registry", {
            status: "error",
            failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
          }, nowMs)
        }
        return
      }
      // ONE REQUEST FOR BOTH HALVES (2026-09-04). The review fetch and the status fetch used to be two
      // independent trips per PR — a batched GraphQL query, plus `gh pr view` and `gh run list` as
      // subprocesses — which on this machine's 7 armed watchers meant 14 children a minute for facts that
      // hang off the same pull request and price at the same 1 GraphQL point together as apart. The
      // status now rides the query that was already being made, so a poll of 20 PRs is one HTTP request
      // and no children.
      //
      // `fetchPr` REMAINS THE FALLBACK, and it is not vestigial: an injected fetcher (every scheduler
      // test that predates this) returns activity with no `pr`, and so does a response ntwine cannot
      // interpret, or a rollup longer than one page that it could not read to the end. Falling back
      // there keeps a watcher polling rather than going quiet on a shape
      // surprise — which is the failure mode this whole source exists to prevent. It runs through
      // `prStatusFallback` because it is the poll's only subprocess and a batch fails all at once; see
      // PR_STATUS_FALLBACK_LIMIT.
      let snapshot: PrStatus | undefined
      let deferred = false
      try {
        const result = normalizeReviewResult(await fetchGithubReview(ref))
        if (result.status === "deferred") deferred = true
        if (result.status === "ok") {
          activity.set(key, result.activity)
          if (result.pr) snapshot = { ...result.pr, rollup: result.pr.rollup as PrStatus["rollup"] }
          // RECOVERY IS SAID OUT LOUD, and it also clears the suppression counter. Without this the
          // failure entry for a ref lives forever, so a PR that failed once and then healed keeps
          // suppressing its own diagnostics and the operator is never told the outage ended.
          recordReviewSuccess(key, "pr-watch registry")
        } else if (result.status === "error") recordReviewFailure(key, "pr-watch registry", result, nowMs)
      } catch (err) {
        recordReviewFailure(key, "pr-watch registry", {
          status: "error",
          failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
        }, nowMs)
      }
      // A DEFERRED BATCH IS NOT A FALLBACK CASE. `deferred` is the fetcher's rate-limit budget guard
      // saying "do not spend on GitHub this tick" — so shelling out to `gh` for the same PR spends the
      // very allowance the guard just protected, through two subprocesses instead of a share of one
      // batched request. Silence is what a defer is FOR; `st`/`acts` are both absent, the loop below
      // skips the ref, and the next poll asks again once the budget recovers.
      try {
        const pr = snapshot ?? (deferred ? undefined : await prStatusFallback(() => fetchPr(ref)))
        if (pr) {
          status.set(key, githubWatchStatus(pr, new Date(nowMs).toISOString()))
          meta.set(key, { labels: pr.labels, reviewRequests: pr.reviewRequests })
          publishGithubStatus(key, pr, nowMs)
          recordStatusSuccess(key)
        }
      } catch (err) {
        // Once per distinct failure, then a count — the same rule the review check uses, because a
        // status poll that cannot read the PR fails identically every 60s for as long as the cause
        // stands, and a log that repeats it 1,440 times a day is one nobody reads.
        recordStatusFailure(key, err instanceof Error ? err.message : String(err), nowMs)
      }
    }))

    for (const w of armed) {
      const row = deps.storage.getSession(w.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left ARMED rather than settled — an
      // archived thread can be reopened, and the watch is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const key = watchKey(w)
      if (w.kind === "issue") {
        evalIssueWatch(row, w, issues.get(key), activity.get(key), nowMs)
        continue
      }
      const st = status.get(key)
      const acts = activity.get(key)
      if (!st && !acts) continue // nothing fetched for this PR this tick
      const cursor = readPrWatchCursor(w.cursor)
      // ONE UNDELIVERED REPORT PER WATCHER (2026-08-28). A report is not deliverable mid-turn, so a
      // watcher whose PR kept moving while its thread worked minted one per poll and the outbox held
      // them all: eleven went to one thread within two seconds the moment it rested (thread
      // `yeah-we-definitely-don-t-do-enough`, 2026-08-27 00:53), three of them "CI FAILED" with job
      // lists the later ones had already replaced — the same stale-second-wake shape as the Goal after
      // the sign-off nudge (evalRestPrompts). A merge or close supersedes the waiting report outright,
      // below, because a worker that reads "CI failed" and then "merged" back to back starts fixing a
      // PR that is gone.
      //
      // AND THE WAITING REPORT IS RE-MINTED, NOT HELD (2026-09-03). Until then this poll held the cursor
      // while a report waited and minted nothing, so the report that followed delivery carried the
      // delta — nothing lost, nothing said twice, but TWO TURNS for one stretch of activity, the first of
      // them saying only what it knew when it was minted. With the quiet window (wake-store.ts) a report
      // now routinely waits minutes, which made that second turn the common case rather than the busy-
      // thread edge. So a poll that finds news while a report waits SUPERSEDES it and mints the next
      // number saying everything since the last report the worker actually read: the union of what the
      // waiting one said (`cursor.held`, its own structural inputs) and what is new — the LATEST verdict
      // (a green run on the new head is the news; the red one it replaces is not), every review item
      // either knew, capped the way one poll's burst is capped. The cursor advances on every poll as it
      // always has, so nothing is re-evaluated and the report after delivery starts from what was sent.
      const waiting = undeliveredPrWatchReport(row.slug, w.id)

      // A MERGED OR CLOSED PR ends the watch. Report it once, then settle: there is nothing further to
      // say, and an armed row on a finished PR is a poll that can never produce another wake.
      if (st && st.state !== "open") {
        deps.storage.settlePrWatch(w.id, nowMs)
        if (waiting) outbox.supersede(waiting.id, nowMs, `replaced by the watcher's ${st.state} report`)
        enqueuePrWatchWake(row, w.id, nextReport(cursor), prWatchWakeMessage({
          target: key, merged: st.state === "merged", closed: st.state === "closed",
        }), `pr-watch ${key} ${st.state}`, nowMs)
        continue
      }
      // A waiting report minted BEFORE the re-mint existed carries no `held`, so its words cannot be
      // folded forward; that one is held the old way — no report, no cursor write — until it is sent, and
      // the report after it carries the delta as before. Exactly the pre-upgrade behaviour, for exactly
      // the rows written before the upgrade.
      if (waiting && !cursor.held) continue

      // CI reaching a TERMINAL verdict, and only on the transition to it. `running` and `none` are not
      // news; going from either to green or red is the whole reason CI is watched.
      //
      // KEYED ON THE HEAD COMMIT, not on the verdict word alone — that was a silent miss, reported
      // 2026-08-17 against `investigate-nubjs-nub-728` watching nubjs/nub#761. The cursor held the bare
      // string "failing", so the SECOND failure never fired: CI goes red (reported, cursor = "failing"),
      // the worker pushes a fix, CI runs and goes red AGAIN — same word, `checksChanged` false, nothing
      // said. The worker sat waiting on a watcher that had already spent its only transition, which is
      // the exact class of dead wait this whole grammar exists to make impossible. Red again on a NEW
      // commit is the most actionable news a watcher has, and it was the one thing it could not say.
      //
      // AND `gated` IS A THIRD REPORTABLE STATE (2026-09-04). It is not a verdict — nothing has run — but
      // it is the one CI reading that will never resolve on its own, so silence about it is the dead wait
      // this grammar exists to prevent: the workflows sit unapproved until a maintainer presses the
      // button, and the worker's only move is to go and ask. It ranks BELOW a real verdict: a red job
      // beside a gated workflow is still the news, and `githubWatchStatus` already resolves that.
      const terminal = st && (st.checks === "passing" || st.checks === "failing")
        ? st.checks
        : st && st.gated > 0 ? "gated" as const : undefined
      // `<head>:<verdict>:<failing jobs>`, so EVERY distinct failure speaks and only an unchanged reading
      // is quiet. The commit alone was not enough: a job re-run on the same head, or a slower job going
      // red after the first, is a second failure the worker has to hear about and neither moves the SHA.
      //
      // A LEGACY CURSOR (the bare word, written before this) can never equal a stamp, so every armed
      // watcher re-announces its current verdict ONCE on the first poll after the upgrade and is
      // correctly keyed forever after. That is the whole migration, and it is deliberate rather than
      // tolerated: there were 7 armed watchers in total when this landed, one of them the failing PR that
      // prompted the report. Special-casing the legacy shape to suppress those 7 messages would have left
      // the reported bug live on exactly the thread that reported it, until its CI happened to flip
      // colour — buying silence at the cost of the fix.
      const stamp = terminal !== undefined ? `${st?.head ?? "?"}:${terminal}:${st?.failureSig ?? ""}` : undefined
      // EXCEPT THAT A GATE IS THE SAME GATE ON ANY COMMIT (2026-09-11). `passing` and `failing` are keyed
      // on the head because a verdict is reached per commit, and a new commit's verdict is new news. A
      // gated reading is not a verdict: it says the workflows have not been allowed to start, and the
      // worker's move — ask a maintainer for the approval — is identical whatever the head is. A worker
      // that force-pushes a fork PR moves the head while the gate stays shut, and the watcher said
      // "WAITING FOR APPROVAL" again for the new SHA one poll after saying it for the old one
      // (microsoft/TypeScript#64248: registered 18:21:20Z, reported 18:21:27Z, force-pushed 18:22:47Z,
      // reported again 18:24:30Z; the worker's reply to the second: "same wake as before, nothing
      // changed"). So gated-after-gated is quiet on any commit, while gated after a REAL verdict still
      // speaks — that worker pushed onto a PR whose last run was approved, and is otherwise waiting on
      // CI it believes is running. The stamp keeps its shape and the cursor still advances to the new
      // head; only the comparison relaxes, so a cursor written before this reads exactly the same way.
      // A HUMAN'S WATCH TAKES TODAY'S VERDICT AS ITS BASELINE (2026-10-07). It is armed from a done card,
      // after the worker already reported the CI it saw, so a verdict standing at the first poll is old
      // news and a wake for it is a turn that says nothing. A worker's own watch keeps announcing it: the
      // worker registers as it pushes, and the run it is waiting on is the news.
      const humanBaseline = w.cursor === null && w.registered_by === "human"
      const checksChanged = stamp !== undefined && cursor.checks !== stamp && !humanBaseline
        && !(terminal === "gated" && stampVerdict(cursor.checks) === "gated")
      // NEW review activity, against everything already reported. On the FIRST poll there is nothing
      // reported yet, so the baseline is the REGISTRATION INSTANT: a worker registers when it opens or
      // pushes a PR, so anything already there is its own news and telling it would spend a turn — while
      // anything arriving in the up-to-60s before the first poll is real and must not be swallowed.
      // (Registering on an OLD PR is the same rule read the other way: the review you never read is
      // yours to go and read, and only what lands afterwards is a wake.)
      const seen = new Set(cursor.seen)
      const firstPoll = w.cursor === null
      // NEWEST FIRST, and it is load-bearing twice over: the cap must keep the items that matter MOST,
      // and the steer must then read in the order the conversation was written. The fetcher's own order
      // is neither — `parseGithubReviewActivities` returns every review, then every comment — so slicing
      // its front would enumerate a burst out of order AND, past the cap, drop the newest activity while
      // keeping the oldest. Same three lines as the fence path this replaced, for the same reasons.
      const newestFirst = [...(acts ?? [])].sort((a, b) => {
        const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
        return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
      })
      // NOISE IS FILTERED HERE, after `seen` and before the steer: a deploy-preview table, a coverage
      // badge, a "trial ended" banner is a poll result, never a wake (`pr-watch-noise.ts` — measured
      // list, 2026-08-28). The cursor below folds in ALL of `acts`, muted included, so a muted item is
      // never re-evaluated; and when a poll finds ONLY muted activity, `reviewSteer` stays undefined,
      // so the existing "nothing to say, but the baseline moved" branch advances the cursor silently.
      const fresh = newestFirst.filter((a) => {
        if (seen.has(a.id) || isNoisePrActivity(a)) return false
        if (!firstPoll) return true
        const landed = Date.parse(a.at ?? "")
        return Number.isFinite(landed) && landed > w.created_at
      })
      const named = fresh.slice(0, REVIEW_STEER_CAP)
      // Oldest first from here on: the steer reads in the order the conversation was written.
      const freshItems: GithubWakeItem[] = [...named].reverse().map((a) => ({
        label: activityLabel(a),
        actor: a.actor,
        bot: isBotGithubActor(a),
        ...(a.at ? { at: a.at } : {}),
        ...(a.url ? { url: a.url } : {}),
      }))

      // THE PR ITSELF — a conflict appearing, a label moving, a reviewer being asked — read against the
      // same baseline discipline as the review activity above. On the FIRST poll, and on the first poll
      // after this landed (an older cursor carries none of these), the reading is RECORDED and nothing is
      // said: a PR's existing labels are not news, and announcing them would spend a turn re-telling the
      // worker what it did itself.
      const prMeta = meta.get(key)
      const changes = firstPoll ? [] : prStateChanges(cursor, st?.merge, prMeta?.labels, prMeta?.reviewRequests)

      const nextCursor: PrWatchCursor = {
        seen: acts ? [...new Set([...cursor.seen, ...acts.map((a) => a.id)])].slice(-REVIEW_SEEN_CAP) : cursor.seen,
        // The STAMP, so the next poll compares against the commit as well as the colour.
        checks: stamp ?? cursor.checks,
        report: cursor.report ?? 0,
        // Each of these advances only when this poll actually READ it. A `gh`-fallback poll knows the
        // merge verdict but not the labels, and overwriting a known baseline with "not known" would make
        // the poll after it announce every label on the PR.
        ...(st?.merge ? { merge: st.merge } : cursor.merge ? { merge: cursor.merge } : {}),
        ...(prMeta?.labels ? { labels: prMeta.labels } : cursor.labels ? { labels: cursor.labels } : {}),
        ...(prMeta?.reviewRequests ? { reviewers: prMeta.reviewRequests } : cursor.reviewers ? { reviewers: cursor.reviewers } : {}),
      }
      if (!checksChanged && fresh.length === 0 && changes.length === 0) {
        // Nothing to say, but the baseline moved: record what was seen so the FIRST poll's backlog is
        // never re-reported, and so a later comment is measured against today rather than against the
        // registration.
        if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) {
          deps.storage.setPrWatchCursor(w.id, JSON.stringify(nextCursor))
        }
        continue
      }
      // "PR watcher armed": if the human parked this thread's card with a user snooze, news on the PR is
      // exactly the thing it was hiding UNTIL — so clear it here, the moment we enqueue, and the card
      // re-surfaces. A no-op when nothing was snoozed. (Ported from the fence poller this replaced.)
      deps.storage.setSnoozedUntil(row.slug, null)
      // WHAT THIS REPORT SAYS: the fresh news on top of whatever the waiting report it replaces was going
      // to say (nothing, when no report waits). The newest REVIEW_STEER_CAP items are named and the rest
      // counted, exactly as one poll's own burst is.
      const held = waiting ? cursor.held : undefined
      const items = [...(held?.items ?? []), ...freshItems]
      const carried: PrWatchHeld = {
        items: items.slice(-REVIEW_STEER_CAP),
        omitted: (held?.omitted ?? 0) + (fresh.length - named.length) + Math.max(0, items.length - REVIEW_STEER_CAP),
        ...(checksChanged && terminal
          ? {
            checks: {
              verdict: terminal,
              passed: st!.passed,
              failed: st!.failed,
              failing: st!.failing,
              skipped: st!.skipped,
              gated: st!.gated,
              gating: st!.gating,
            },
          }
          : held?.checks ? { checks: held.checks } : {}),
        // The state clauses fold forward the same way the review items do, and are DEDUPED on the way:
        // a report superseded before delivery may already have said "now CONFLICTS", and the poll that
        // replaces it re-derives that clause from a cursor the superseded report never got to advance.
        ...((() => {
          const all = [...(held?.changes ?? []), ...changes]
          const merged = [...new Set(all)]
          return merged.length ? { changes: merged } : {}
        })()),
      }
      const review = carried.items.length > 0
        ? formatGithubWakeSteer({ ref: key, items: carried.items, omitted: carried.omitted })
        : undefined
      const report = nextReport(cursor)
      if (waiting) outbox.supersede(waiting.id, nowMs, `folded into report ${report}, which says this and everything since`)
      enqueuePrWatchWake(row, w.id, report, prWatchWakeMessage({
        target: key,
        ...(carried.checks ? { checks: carried.checks } : {}),
        ...(carried.changes?.length ? { changes: carried.changes } : {}),
        ...(review ? { review } : {}),
        ...(w.registered_by === "human" ? { byHuman: true } : {}),
      }), `pr-watch ${key}${carried.checks ? ` CI ${carried.checks.verdict}` : ""}${carried.changes?.length ? " state" : ""}${review ? " review" : ""}`, nowMs)
      deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report, held: carried }))
    }
  }

  /** An ISSUE's own state moving — labels either way, for the reason `prStateChanges` gives, and a new
   *  assignee, which on an issue is the "someone picked this up" event a worker waiting on triage wants.
   *  An unassignment is quiet, as a withdrawn review request is. */
  function issueStateChanges(cursor: PrWatchCursor, labels: string[] | undefined, assignees: string[] | undefined): string[] {
    const out: string[] = []
    if (labels && cursor.labels) {
      const added = labels.filter((l) => !cursor.labels!.includes(l))
      const removed = cursor.labels.filter((l) => !labels.includes(l))
      const parts = [...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)]
      if (parts.length) out.push(`labels ${parts.join(", ")}`)
    }
    if (assignees && cursor.assignees) {
      const added = assignees.filter((a) => !cursor.assignees!.includes(a))
      if (added.length) out.push(`assigned to ${added.map((a) => `@${a}`).join(", ")}`)
    }
    return out
  }

  /** The issue half of the poll loop above — one registered ISSUE watcher, given what this tick fetched
   *  for it. Same cursor, same report numbering, same one-undelivered-report rule and the same re-mint as
   *  the PR path, because the row IS a `pr_watch` row; what differs is what can move (comments, labels,
   *  assignees, the close) and what is said about it (`issueWatchWakeMessage`). Kept as its own function
   *  rather than folded into the PR loop with `if (issue)` guards, because the PR loop's shape is its CI
   *  verdict and an issue has none. */
  function evalIssueWatch(
    row: SessionRow,
    w: PrWatchRow,
    snap: GithubIssueSnapshot | undefined,
    acts: GithubReviewActivity[] | undefined,
    nowMs: number,
  ): void {
    if (!snap && !acts) return // nothing fetched for this issue this tick
    const target = `${w.owner}/${w.repo}#${w.number}`
    const cursor = readPrWatchCursor(w.cursor)
    const waiting = undeliveredPrWatchReport(row.slug, w.id)
    // A CLOSED ISSUE ends the watch, as a merged or closed PR does. Reported once with GitHub's reason —
    // "not planned" is a different next step from "completed" — then settled.
    if (snap && snap.state.toUpperCase() === "CLOSED") {
      deps.storage.settlePrWatch(w.id, nowMs)
      if (waiting) outbox.supersede(waiting.id, nowMs, "replaced by the watcher's closed report")
      const reason = snap.stateReason ? snap.stateReason.toLowerCase().replace(/_/g, " ") : undefined
      enqueuePrWatchWake(row, w.id, nextReport(cursor), issueWatchWakeMessage({
        target, closed: reason ? { reason } : {},
      }), `issue-watch ${target} closed`, nowMs)
      return
    }
    if (waiting && !cursor.held) return
    const seen = new Set(cursor.seen)
    const firstPoll = w.cursor === null
    const newestFirst = [...(acts ?? [])].sort((a, b) => {
      const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
      return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
    })
    // The registration-instant baseline and the noise filter, exactly as the PR path reads them: a
    // worker registers an issue it has just read, so what is already there is not news.
    const fresh = newestFirst.filter((a) => {
      if (seen.has(a.id) || isNoisePrActivity(a)) return false
      if (!firstPoll) return true
      const landed = Date.parse(a.at ?? "")
      return Number.isFinite(landed) && landed > w.created_at
    })
    const named = fresh.slice(0, REVIEW_STEER_CAP)
    const freshItems: GithubWakeItem[] = [...named].reverse().map((a) => ({
      label: activityLabel(a),
      actor: a.actor,
      bot: isBotGithubActor(a),
      ...(a.at ? { at: a.at } : {}),
      ...(a.url ? { url: a.url } : {}),
    }))
    const changes = firstPoll ? [] : issueStateChanges(cursor, snap?.labels, snap?.assignees)
    const nextCursor: PrWatchCursor = {
      seen: acts ? [...new Set([...cursor.seen, ...acts.map((a) => a.id)])].slice(-REVIEW_SEEN_CAP) : cursor.seen,
      report: cursor.report ?? 0,
      ...(snap?.labels ? { labels: snap.labels } : cursor.labels ? { labels: cursor.labels } : {}),
      ...(snap?.assignees ? { assignees: snap.assignees } : cursor.assignees ? { assignees: cursor.assignees } : {}),
    }
    if (fresh.length === 0 && changes.length === 0) {
      if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) {
        deps.storage.setPrWatchCursor(w.id, JSON.stringify(nextCursor))
      }
      return
    }
    deps.storage.setSnoozedUntil(row.slug, null)
    const held = waiting ? cursor.held : undefined
    const items = [...(held?.items ?? []), ...freshItems]
    const mergedChanges = [...new Set([...(held?.changes ?? []), ...changes])]
    const carried: PrWatchHeld = {
      items: items.slice(-REVIEW_STEER_CAP),
      omitted: (held?.omitted ?? 0) + (fresh.length - named.length) + Math.max(0, items.length - REVIEW_STEER_CAP),
      ...(mergedChanges.length ? { changes: mergedChanges } : {}),
    }
    const review = carried.items.length > 0
      ? formatGithubWakeSteer({ ref: target, items: carried.items, omitted: carried.omitted })
      : undefined
    const report = nextReport(cursor)
    if (waiting) outbox.supersede(waiting.id, nowMs, `folded into report ${report}, which says this and everything since`)
    enqueuePrWatchWake(row, w.id, report, issueWatchWakeMessage({
      target,
      ...(carried.changes?.length ? { changes: carried.changes } : {}),
      ...(review ? { review } : {}),
      ...(w.registered_by === "human" ? { byHuman: true } : {}),
    }), `issue-watch ${target}${carried.changes?.length ? " state" : ""}${review ? " comment" : ""}`, nowMs)
    deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report, held: carried }))
  }

  /** The next report number for a watcher — ONE derivation, used both for the delivery id and for the
   *  cursor that records it. They were computed separately at two call sites and had to be kept in step
   *  by hand, which is a silent double-report waiting to happen. */
  function nextReport(cursor: { report?: number }): number {
    return (cursor.report ?? 0) + 1
  }
  /** This watcher's report that is minted but not yet handed to the runtime — pending, or leased and
   *  deferred behind a busy thread. A SENT report (leased with `sentAt`, awaiting confirmation) is not
   *  one: the worker has it, and the next poll may say what happened since. */
  function undeliveredPrWatchReport(slug: string, watchId: string): WakeDelivery | undefined {
    const prefix = `${PR_WATCH_FENCE_PREFIX}:${watchId}:`
    return outbox.listOpen().find((d) => d.slug === slug && d.sentAt === null && d.fenceId.startsWith(prefix))
  }

  function enqueuePrWatchWake(
    row: SessionRow,
    watchId: string,
    report: number,
    message: string,
    reason: string,
    nowMs: number,
  ): void {
    const fenceId = prWatchFenceId(watchId, report)
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    const item = outbox.enqueue({
      id: deliveryId, slug: row.slug, sessionId: row.session_id, fenceId,
      // ntwine's own words about someone else's PR, so the clock rides along: a watcher wake is the one
      // most likely to land on a thread that has been parked for hours without knowing it.
      hintKey: `${PR_WATCH_FENCE_PREFIX}:${watchId}`, message: withClock(message, deps.tailer.get(row.slug)?.lastAssistantAt), reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  // ---- SOURCE 10: A BACKGROUND SHELL FINISHED WHILE ITS AGENT WAS RESTING -------------------------
  // AUTOMATIC, for every thread, with nothing to register and nothing to declare. Maintainer 2026-08-14:
  // "the agent just uses the built-in tool from the harness to start a background shell. It should be
  // watched automatically: every time a background shell completes, the agent should be woken up. That's
  // how it should always work."
  //
  // It is not redundant with the runtime's own notification, and the split is the entire reason this
  // exists. Measured over this machine's whole session history (3972 shells): all 3011 delivered
  // notifications landed on an assistant record with stop_reason "tool_use" — i.e. MID-TURN — while 1601
  // shells outlived their worker's rest and 1191 of those were never delivered at all, though the session
  // provably kept writing for minutes to days afterwards. The runtime covers the running turn; this
  // covers the rest, and only the rest.
  //
  // WHICH IS EXACTLY WHAT `finishedAt` DECIDES. A shell that finished BEFORE the agent's last word was
  // reported to it by the runtime and folded into that turn; waking again would tell it twice. A shell
  // that finished AFTER it has nobody to tell. So the test is `finishedAt > lastAssistantAt`, and a
  // retirement carrying no instant (an older tail state) never fires — the safe direction.
  //
  // THE AWAITING FENCE HAS NOTHING TO DO WITH THIS. It does not register the wait and never did; it is
  // how an agent comes to REST and states what it is waiting on (see hasDeclaredBackgroundPark). A
  // thread with no fence at all is woken here exactly the same way, which is the point.
  function evalShellCompletions(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele) continue
      // AT REST ONLY. Mid-turn the runtime's own notification is the delivery, and ntwine adding a second
      // one would land while the agent is still working — the noise this pass exists to avoid.
      if (tele.turn !== "idle") continue
      // A signed-out provider answers in milliseconds and every reply is a "rest", which makes it a
      // perfect loop generator for anything that re-prompts. Same guard as SOURCES 5 and 9 — and its
      // general form: ANY failed turn is written as an assistant record, so it reads as a rest here too.
      if (tele.authFault || tele.apiFault) continue
      // A THREAD THAT SAID DONE IS NOT WOKEN FOR A SHELL IT WALKED AWAY FROM (2026-08-28). The contract
      // lets a worker sign off with a background process still running — a dev server, a poller it has
      // moved on from — naming it in the body. Waking that thread when the process exits hands a
      // finished worker news it declared it did not need, and it answers the only way it can: by saying
      // done again — a second Done card, and a wake whose turn runs any tool withdraws the registered done
      // until it does (registeredDoneFence: a done stands through a prose-only reply to a newer user
      // record, not through a tool call or a failed turn after it). SOURCES 4 and 5 already decline
      // a done thread; this is the same guard. The one exception is a shell the worker REGISTERED a wait
      // on (`ntwinectl watch`): a registration trumps a done on the board, so it trumps it here too —
      // the wake is the thing it registered for. Matched by ROW, in any state but dropped, because
      // evalOwnWatches has already settled that row silently by the time this pass runs (it runs first
      // in the tick, and "target ended" is its silent case — the wake is this pass's to send). Once the
      // human's next message turns into work (a tool call) or dies (a failed turn), the done stops
      // standing, and by then the exit is folded into the turn that answers it.
      const walkedAway = threadSaidDone(deps.storage, row.slug, tele)
      const registeredShells = walkedAway ? deps.storage.listThreadWatches(row.slug).filter((w) => w.kind === "shell" && w.state !== "dropped") : []
      const restedAt = Date.parse(tele.lastAssistantAt ?? "")
      if (!Number.isFinite(restedAt)) continue
      for (const shell of tele.retiredShells ?? []) {
        const finishedAt = Date.parse(shell.finishedAt ?? "")
        if (!Number.isFinite(finishedAt) || finishedAt <= restedAt) continue
        if (walkedAway && !registeredShells.some((w) => [shell.id, shell.taskId, shell.label].includes(w.target))) continue
        const fenceId = shellFenceId(shell.id)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this shell has already had its one wake
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${SHELL_FENCE_PREFIX}:${shell.id}`,
          message: withClock(shellDoneMessage(shell), tele.lastAssistantAt),
          reason: `background shell finished (${shell.taskId ?? shell.label})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        break // one durable wake per thread per pass; the next tick takes the next shell
      }
    }
  }

  // ---- SOURCE 17: A TERMINAL STOPPED MOVING, OR CHANGED HANDS (2026-10-15) --------------------------------
  // A terminal thread (a dev server, a log tail, a shell) lives in a detached host the worker's runtime knows
  // nothing about, so ntwine is the only thing that can say it reached a prompt, ended, or moved between
  // drivers (plans/terminal-threads.md § Control). Any thread may wait on any terminal, as on any thread:
  // an armed `ntwinectl watch terminal` fires on the first event after it was armed (a registration trumps a
  // done, as for a shell), and a resting fence naming it under `threads:` (or `terminals:`, its first
  // spelling) is woken for an event after that rest. ONE wake per event, keyed on the terminal and the event
  // — a prompt answered and reached again is news again, an exit and a control move are told once.
  //
  // A CONTROL MOVE is also owed to the threads it touched (control_notes, written by the router): the one
  // that lost the terminal and the one that got it. Each is told at once when it is working (mid-turn, as a
  // steer: it may be about to type) or waiting on the terminal; otherwise the note stays owed and rides the
  // next wake ntwine delivers to it (deliverDue), so a control move never costs an idle thread a turn.
  function terminalsNow(): TerminalLive[] {
    return terminalLives((deps.terminals?.() ?? []).map(({ terminal }) => terminal))
  }

  /** Does this resting telemetry's fence name the terminal (by handle or slug, under threads: or terminals:)? */
  function fenceNamesTerminal(tele: SessionTelemetry | undefined, terminal: Pick<ThreadTerminal, "id" | "handle">): boolean {
    if (tele?.turn !== "idle" || tele.lastFence?.kind !== "awaiting") return false
    const keys = [terminal.id, terminal.handle].flatMap((h) => (h ? [terminalAwaitKey(h)] : []))
    return readAwaitingPark(tele.lastFence.hints).items.some((i) => (i.kind === "terminal" || i.kind === "thread") && keys.includes(terminalAwaitKey(i.value)))
  }

  /** Queue one terminal wake; false when this very wake was queued before and superseded (nothing new went). */
  function enqueueTerminalWake(slug: string, fenceId: string, message: string, reason: string, nowMs: number): boolean {
    const session = deps.storage.getSession(slug)
    if (!session || session.state === "archived" || session.archived === 1) return true
    const deliveryId = wakeDeliveryId(slug, session.session_id, fenceId)
    const prior = outbox.get(deliveryId)
    if (prior) return prior.state !== "superseded"
    const item = outbox.enqueue({
      id: deliveryId, slug, sessionId: session.session_id, fenceId, hintKey: fenceId,
      message: withClock(message, deps.tailer.get(slug)?.lastAssistantAt), reason,
    }, nowMs).delivery
    log(`waker: queued ${slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
    return true
  }

  function evalTerminalWaits(nowMs: number): void {
    const handleOf = (slug: string) => deps.threadHandle?.(slug) ?? slug
    for (const { row: held, terminal } of deps.terminals?.() ?? []) {
      const handle = terminal.handle ?? terminal.id
      const outcome = terminalOutcome(terminal)
      const controller = terminal.controller ?? "human"
      const controlFenceId = `${TERMINAL_FENCE_PREFIX}:${terminal.id}:control:${held.control_changed_at ?? 0}`
      // 1. What a control move owes the threads it touched: now, when they are working or waiting on it.
      const notes = terminalNotesOf(held)
      const owed = notes.filter((note) => {
        const session = deps.storage.getSession(note.to)
        if (!session || session.state === "archived" || session.archived === 1) return false
        const tele = deps.tailer.get(note.to)
        const busy = tele !== undefined && tele.turn !== "idle"
        const watching = held.watch_id && held.watch_slug === note.to
        if (!busy && !watching && !fenceNamesTerminal(tele, terminal)) return true
        if (watching) deps.storage.setThreadTerminalWatch(held.slug, null)
        // Working and not waiting on it: told in this turn, or owed again if the turn ends first.
        const fenceId = busy && !watching && !fenceNamesTerminal(tele, terminal) ? controlFenceId.replace(":control:", TERMINAL_NOTE_MARK) : controlFenceId
        // A note that already went out mid-turn once and was handed back (reoweTerminalNote) stays owed: it
        // now rides the next wake rather than another turn's steer.
        return !enqueueTerminalWake(note.to, fenceId, note.text, `control of @${handle} moved`, nowMs)
      })
      if (owed.length !== notes.length) deps.storage.setThreadTerminalNotes(held.slug, owed)
      // 2. Its events, each with when it happened.
      const events: { key: string; atMs: number; reason: string; message: (slug: string) => string }[] = []
      if (outcome !== "running") {
        const changedAt = terminal.awaitingSince ?? terminal.exitedAt ?? terminal.startedAt
        events.push({
          key: `${TERMINAL_FENCE_PREFIX}:${terminal.id}:${terminal.runId}:${outcome === "prompt" ? `prompt:${changedAt}` : "end"}`,
          atMs: Date.parse(changedAt),
          reason: `terminal @${handle} ${outcome === "prompt" ? "is waiting for input" : "ended"}`,
          message: (slug) => terminalWakeMessage({
            handle, command: terminal.command, outcome,
            ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
            screen: (deps.terminalScreen?.(terminal.id) ?? "").split("\n").slice(-30).join("\n"),
            driving: controller === slug, controller: controller === "human" ? "human" : handleOf(controller),
          }),
        })
      }
      if (held.control_changed_at) {
        events.push({
          key: controlFenceId, atMs: held.control_changed_at, reason: `control of @${handle} moved`,
          message: () => terminalControlWakeMessage({ event: "moved", handle, other: controller === "human" ? "human" : handleOf(controller) }),
        })
      }
      // 3. A lapsed watch on a terminal still running quietly: cancelled, and the watcher re-decides.
      const watcher = held.watch_id ? held.watch_slug ?? held.started_by ?? undefined : undefined
      const due = watcher ? events.filter((e) => e.atMs >= (held.watch_armed_at ?? 0)) : []
      if (watcher && due.length === 0 && (held.watch_expires_at ?? Infinity) <= nowMs) {
        deps.storage.setThreadTerminalWatch(held.slug, null)
        log(`waker: settled ${watcher} — terminal watch ${held.watch_id} expired (@${handle})`)
        enqueueTerminalWake(watcher, `${TERMINAL_WATCH_EXPIRED_FENCE_PREFIX}:${held.watch_id}`, terminalWatchExpiredWakeMessage(handle), `terminal watch ${held.watch_id} expired (@${handle})`, nowMs)
      }
      // 4. An armed watch fires on the first events after it was armed, whatever the fence says.
      if (watcher && due.length > 0) {
        deps.storage.setThreadTerminalWatch(held.slug, null)
        for (const e of due) enqueueTerminalWake(watcher, e.key, e.message(watcher), e.reason, nowMs)
      }
      // 5. Every resting thread whose fence names it, for each event after its rest.
      if (events.length === 0) continue
      for (const row of deps.storage.allSessions()) {
        if (row.state === "archived" || row.archived === 1 || row.slug === watcher) continue
        const tele = deps.tailer.get(row.slug)
        if (!fenceNamesTerminal(tele, terminal)) continue
        const restedAt = Date.parse(tele?.lastAssistantAt ?? "")
        for (const e of events) if (e.atMs > restedAt) enqueueTerminalWake(row.slug, e.key, e.message(row.slug), e.reason, nowMs)
      }
    }
  }

  /** A mid-turn control note whose turn ended before it went out is owed again, unless a newer note for the
   *  same thread already replaced it, or the thread is gone. */
  function reoweTerminalNote(item: WakeDelivery): void {
    const m = /^terminal:(.+):control-note:\d+$/.exec(item.fenceId)
    if (!m) return
    const session = deps.storage.getSession(item.slug)
    if (!session || session.session_id !== item.sessionId || session.state === "archived" || session.archived === 1) return
    const row = (deps.terminals?.() ?? []).find(({ row }) => row.slug === m[1])?.row
    if (!row) return
    const notes = terminalNotesOf(row)
    if (notes.some((n) => n.to === item.slug)) return
    deps.storage.setThreadTerminalNotes(row.slug, [...notes, { to: item.slug, text: stripWakeTimeHeader(item.message).trim() }])
  }

  /** The control notes still owed to `slug`, to ride a wake going out to it now (deliverDue). */
  function owedTerminalNotes(slug: string): { terminal: string; text: string }[] {
    return (deps.terminals?.() ?? []).flatMap(({ row }) => terminalNotesOf(row).filter((n) => n.to === slug).map((n) => ({ terminal: row.slug, text: n.text })))
  }

  function settleTerminalNotes(slug: string, notes: readonly { terminal: string }[]): void {
    for (const id of new Set(notes.map((n) => n.terminal))) {
      const row = (deps.terminals?.() ?? []).find(({ row }) => row.slug === id)?.row
      if (row) deps.storage.setThreadTerminalNotes(id, terminalNotesOf(row).filter((n) => n.to !== slug))
    }
  }

  // ---- SOURCE 13: A BACKGROUND SHELL OUTLIVED ITS RUNTIME BUDGET ----------------------------------
  // Maintainer 2026-09-29: "background shells running for 16 hours makes no sense." A shell carries a
  // budget only when one was DECLARED (shell-budget.ts — its launch `timeout`, or an `extend_shell`; there
  // is no default, and an armed `watch` holds the deadline to its own expiry). An unbudgeted shell is
  // never looked at here. For a budgeted one, two steps, both keyed on the durable `shell_budget` row,
  // so neither is lost to a restart nor repeated by one:
  //
  //  1. PAST THE DEADLINE → one warning wake, delivered mid-turn if the worker is busy, and the row
  //     marked warned FOR THIS DEADLINE. An extension moves the deadline, so the next overrun is warned
  //     afresh; the same deadline is never warned twice, however many passes or restarts see it.
  //  2. GRACE AFTER THE WARNING REACHED THE WORKER, deadline unmoved → the shell is stopped through the
  //     operator's own × path, and the worker told why. Grace counts from the warning's DELIVERY — not
  //     the deadline, and not the instant it was queued — so neither a server that was down across the
  //     deadline nor a wake that waited in the outbox eats into the worker's window to answer. See
  //     shellBudgetGraceFrom for how "delivered" is read.
  //
  // A shell ntwine cannot stop (a pre-broker row, or no task id yet) is warned and never killed — the
  // warning says so. An ARCHIVED thread is nobody's to wake: it gets no warning and no kill notice, but
  // its shell still ends on the same clock, because a forgotten shell on a shelved thread is exactly the
  // 16-hour case. A kill that fails is retried, spaced, rather than every tick.
  const SHELL_BUDGET_STOP_RETRY_MS = 5 * 60_000
  const shellBudgetStopAttempts = new Map<string, number>()

  // WHEN THE WARNING REACHED THE WORKER — the instant its grace runs from, or null while it is still on
  // its way (nothing may be stopped yet). Read off the warning's own outbox row, which is durable, so a
  // restart reads the same answer. Until 2026-09-29 the grace ran from `warned_at`, the instant the
  // warning was QUEUED: two shells due 8s apart on a real stack had their warnings delivered ~5m apart
  // (the quiet window, since exempted — wake-store.ts), and the second worker got ~5 of its 10 minutes.
  //
  //  · SENT to a live runtime, or DELIVERED → the handoff instant (`sentAt`, else `deliveredAt`). A sent
  //    row is still leased awaiting confirmation; the worker has it, so its clock is running.
  //  · PENDING, or leased and not yet sent → null. That includes a frame that was sent and LOST (its
  //    runtime died with no token) and is going round again: the worker never read it.
  //  · TERMINAL without reaching the worker (exhausted, abandoned), or NO ROW (an archived thread is
  //    never warned; a pruned row) → `warned_at`. Nobody can be told, and a shell whose worker cannot
  //    be reached is exactly the forgotten one the budget exists for, so it ends on the original clock
  //    rather than living forever behind a wake that will never land.
  //
  // Looked up under the thread's CURRENT session: a warning queued under an earlier one is not found
  // and falls to `warned_at`, the old behaviour, for a thread that restarted mid-grace.
  function shellBudgetGraceFrom(slug: string, sessionId: string, shellId: string, deadlineMs: number, warnedAtMs: number): number | null {
    const d = outbox.get(wakeDeliveryId(slug, sessionId, shellBudgetFenceId(shellId, deadlineMs)))
    if (!d) return warnedAtMs
    if (d.state === "delivered") return Math.max(warnedAtMs, d.sentAt ?? d.deliveredAt ?? warnedAtMs)
    if (d.state === "leased") return d.sentAt === null ? null : Math.max(warnedAtMs, d.sentAt)
    if (d.state === "pending") return null
    return warnedAtMs
  }

  async function evalShellBudgets(nowMs: number): Promise<void> {
    for (const row of deps.storage.allSessions()) {
      const tele = deps.tailer.get(row.slug)
      if (!tele?.bgShells?.length) continue
      const archived = row.state === "archived" || row.archived === 1
      for (const shell of tele.bgShells) {
        if (shell.state !== "running") continue
        const budget = liveShellBudget(deps.storage, row.slug, shell)
        if (!budget || nowMs < budget.deadlineMs) continue
        const startedAtMs = Date.parse(shell.startedAt)
        const stoppable = deps.shellControl?.stoppable(row.slug, budget.shellId) ?? false
        const warnedAtMs = budget.record?.warnedDeadlineMs === budget.deadlineMs ? budget.record.warnedAtMs : null
        if (warnedAtMs === null) {
          const handle = shell.taskId ?? budget.shellId
          if (!archived) {
            const fenceId = shellBudgetFenceId(budget.shellId, budget.deadlineMs)
            const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
            if (!outbox.get(deliveryId)) {
              const item = outbox.enqueue({
                id: deliveryId,
                slug: row.slug,
                sessionId: row.session_id,
                fenceId,
                hintKey: fenceId,
                message: withClock(shellBudgetWarningMessage({
                  handle,
                  label: shell.label,
                  ranMs: nowMs - startedAtMs,
                  budgetMs: budget.deadlineMs - startedAtMs,
                  stoppable,
                  backend: row.backend === "codex" ? "codex" : row.backend === "claude" || !row.backend ? "claude" : "other",
                }), tele.lastAssistantAt),
                reason: `background shell over budget (${handle})`,
              }, nowMs).delivery
              log(`waker: queued ${row.slug} — ${item.reason}`)
              checkpoint("after-enqueue", item)
            }
          }
          deps.storage.markShellBudgetWarned({ slug: row.slug, shellId: budget.shellId, startedAt: shell.startedAt, deadlineMs: budget.deadlineMs, nowMs })
          continue
        }
        if (!stoppable || !deps.shellControl) continue
        const graceFromMs = archived ? warnedAtMs : shellBudgetGraceFrom(row.slug, row.session_id, budget.shellId, budget.deadlineMs, warnedAtMs)
        if (graceFromMs === null || nowMs < graceFromMs + SHELL_BUDGET_GRACE_MS) continue
        const attemptKey = `${row.slug}\u0000${budget.shellId}`
        const lastAttempt = shellBudgetStopAttempts.get(attemptKey)
        if (lastAttempt !== undefined && nowMs - lastAttempt < SHELL_BUDGET_STOP_RETRY_MS) continue
        shellBudgetStopAttempts.set(attemptKey, nowMs)
        try {
          const result = await deps.shellControl.stop(
            row.slug,
            budget.shellId,
            { kind: "budget", ranMs: nowMs - startedAtMs, budgetMs: budget.deadlineMs - startedAtMs },
            { notify: !archived },
          )
          if (result?.stopped) {
            deps.storage.markShellBudgetStopped({ slug: row.slug, shellId: budget.shellId, startedAt: shell.startedAt, nowMs })
            shellBudgetStopAttempts.delete(attemptKey)
            log(`waker: stopped ${row.slug} — background shell ${shell.taskId ?? budget.shellId} ran past its budget${result.note ? ` (${result.note})` : ""}`)
          } else {
            log(`waker: could not stop ${row.slug} — background shell ${shell.taskId ?? budget.shellId}: ${result?.note ?? "not stoppable"}`)
          }
        } catch (err) {
          log(`waker: stopping ${row.slug}'s over-budget shell ${shell.taskId ?? budget.shellId} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // ---- SOURCE 15: THE THREAD'S TIME LIMIT -------------------------------------------------------
  // ARCHITECTURE.md § Time limits. A thread with a deadline is checked in with at fixed points in its budget —
  // half-time, 80%, shortly before and at the deadline (@ntwine/shared deadlineStageFraction) — each
  // asking for a different behaviour (deadline.ts deadlineCheckInMessage). Delivered MID-TURN at the
  // worker's next tool boundary, as a Goal heartbeat is; a resting thread is woken by it.
  //
  // ONLY THE LATEST DUE STAGE, and each at most once per generation: `deadline_stage` is the durable
  // ledger (like `shell_budget`'s warned deadline), written in the same tick as the enqueue, so a restart
  // — or an outbox that pruned the row — never sends a stage twice, and a server that was down across two
  // stages sends the second alone.
  //
  // NOTHING IS EVER STOPPED. Past the deadline the worker is told once that its next stop is the handoff,
  // and the board shows the thread over time; there is no second nag (the plan's "After over").
  //
  // A thread RESTING ON A HANDOFF is not woken (restsOnHandoff): one that signed off, asked the human or
  // parked on them has already handed over. The stage is left unqueued rather than spent, so if the human
  // answers and the worker runs again it hears where its clock stands — if that stage is still the latest.
  function evalDeadlines(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1 || isHeldRow(row)) continue
      const d = rowDeadline(row)
      if (!d) continue
      const stage = deadlineStageToSend(d, nowMs)
      if (!stage) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele) continue
      if (restsOnHandoff(row.slug, tele)) continue
      const fenceId = deadlineFenceId(d.setAt, stage)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (!outbox.get(deliveryId)) {
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: fenceId,
          message: withClock(deadlineCheckInMessage(stage, d, nowMs), tele.lastAssistantAt, row),
          reason: `time limit check-in: ${stage} (deadline ${new Date(d.atMs).toISOString()})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
      }
      deps.storage.markDeadlineStage(row.slug, d.setAt, stage)
    }
  }

  /** HAS THIS THREAD ALREADY HANDED OVER? Resting, and the rest is one the human now owns: a sign-off
   *  (`done`, fenced or registered), a question it asked (registered or native), or a park on the human
   *  (`status: needs_input`, `steps:`, `questions:`). A check-in there would ask for a handoff the
   *  worker has already made. A quiet park (`working` / `watching`) and a bare rest are not handoffs — the
   *  worker is waiting on its own work, and the clock is exactly what it needs to hear. */
  function restsOnHandoff(slug: string, tele: SessionTelemetry): boolean {
    if (tele.turn !== "idle") return false
    if (threadSaidDone(deps.storage, slug, tele)) return true
    if (tele.pendingQuestion) return true
    if (heldQuestionRows(deps.storage.listThreadQuestions(slug, { openOnly: true }), tele).length > 0) return true
    const fence = tele.lastFence
    if (fence?.kind === "awaiting") {
      if (awaitingStatus(fence) === "needs_input") return true
      if (parkOnHuman(readAwaitingPark(fence.hints))) return true
    }
    return false
  }

  /** THE REGISTERED-WATCH REGISTRY PASS. Two settle conditions, and only one of them is news.
   *
   *  EXPIRED → settled + a wake. The expiry is the whole reason a registration cannot outlive its own
   *  relevance: the worker chose a duration once, and when it runs out it is put back in front of that
   *  decision rather than left parked on a wait it no longer holds. Told, because a wait that vanishes
   *  silently is the same stall in a new costume — the worker would rest believing it is covered.
   *
   *  TARGET ENDED → settled, SILENTLY. This is the wait completing, which is exactly the thing the
   *  worker asked to be woken for, and evalShellCompletions already delivers that wake off the retired
   *  shell itself. A second one here would be two notifications for one fact. The board stops parking on
   *  the row the moment the target stops resolving (hasRegisteredBackgroundPark), so settling it is
   *  bookkeeping — it keeps the worker's own read-back from listing a wait that is over.
   */
  function evalOwnWatches(nowMs: number): void {
    for (const w of deps.storage.expiredThreadWatches(nowMs)) {
      const row = deps.storage.getSession(w.thread_slug)
      deps.storage.settleThreadWatch(w.id, nowMs, "expired")
      log(`waker: settled ${w.thread_slug} — watch ${w.id} expired (${w.kind}: ${w.target})`)
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = ownWatchExpiredFenceId(w.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(ownWatchExpiredWakeMessage(w.kind, w.target), deps.tailer.get(row.slug)?.lastAssistantAt),
        reason: `watch ${w.id} expired (${w.kind}: ${w.target})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
    // The second condition. Read per thread rather than per row so one telemetry lookup covers a
    // thread's whole armed set.
    const bySlug = new Map<string, ReturnType<typeof deps.storage.expiredThreadWatches>>()
    for (const w of deps.storage.armedThreadWatches()) {
      const list = bySlug.get(w.thread_slug) ?? []
      list.push(w)
      bySlug.set(w.thread_slug, list)
    }
    for (const [slug, watches] of bySlug) {
      const tele = deps.tailer.get(slug)
      // NO TELEMETRY IS NOT "NOT LIVE". A thread whose transcript ntwine cannot read right now says
      // nothing about its shells, and settling on that reading would cancel a healthy wait — the same
      // shape as `probeShellAlive`'s rule that an undefined verdict is never treated as dead.
      if (!tele) continue
      // The SAME liveness the park integrity pass reads, so a row cannot be settled here while the fence
      // beside it still counts the identical handle as live. (It reads a hair wider than the board's
      // rule — it counts a DESCENDANT sub-agent, where board.resolveLiveWatchTarget counts direct
      // children only. Unreachable in practice: registration goes through the board's rule, so a
      // descendant handle is refused before a row can exist for it.)
      const live = liveActivityOf(tele, new Set(), new Set())
      for (const w of watches) {
        if (live[w.kind === "shell" ? "shells" : "agents"].has(w.target)) continue
        deps.storage.settleThreadWatch(w.id, nowMs)
        log(`waker: settled ${slug} — watch ${w.id} finished (${w.kind}: ${w.target})`)
      }
    }
  }

  // ---- SOURCE 16: THE WORKER'S COMMAND WATCHES ------------------------------------------------------
  // `ntwinectl watch-command add` (2026-10-11): a shell command the server re-runs every `every` until it
  // exits 0, so a wait on an outside condition holds nothing in the thread's own process tree and the
  // thread can hibernate under it. See command-watch.ts for the process and the gate.
  //
  // ONE-SHOT, like a timer and unlike a PR watcher: the first passing check settles the row and wakes the
  // thread once. Expiry settles it and wakes the thread to re-decide. A gate that closes (the thread left
  // `bypassPermissions`, the sandbox came on) cancels it and wakes the thread to use a background shell.
  //
  // RUNS ARE STARTED, NOT AWAITED. A check may take two minutes and the tick is serialized: awaiting it
  // would hold every other source behind somebody's `curl`. So the pass starts what is due and returns;
  // each check records itself when it finishes and kicks the next tick, which delivers the wake.
  //
  // NEVER TWO CHECKS OF ONE WATCH AT ONCE: `commandRuns` holds the one in flight, and a watch with a
  // check in flight is not due. The SERVER-WIDE bound on checks at once lives in the service
  // (command-watch.ts), shared by every project's scheduler.
  //
  // CADENCE FROM THE FINISH: the next check is due `every` after the last one ENDED, so a check slower
  // than its cadence cannot stack up behind itself.
  //
  // THE FENCE IS NOT CONSULTED, as with a PR watcher: registration is the fact, and a thread that is not
  // resting on the watch is woken exactly the same way (held until it rests, like every non-clock wake).
  const commandRuns = new Map<string, { abort: AbortController; done: Promise<void> }>()

  function kick(): void {
    if (stopped || !timer) return
    // A KICK DURING A TICK RUNS ONE MORE AFTER IT. `tick` joins a running pass rather than starting a
    // second, and that pass may already be past the part the kick was for — so the kick used to be
    // swallowed, and the work it announced waited a whole interval. It bit the case kicks exist for:
    // answers arrive a question at a time (2026-09-29), and the second one is stored while the first
    // one's delivery is still awaiting its `resume`. Coalesced: however many kicks land during one
    // pass, one more pass follows it, and that pass finds all of them together.
    if (activeTick) {
      if (rerun) return
      rerun = true
      void activeTick.then(
        () => {
          rerun = false
          if (stopped || !timer) return
          void tick().catch((error) => log(`waker: kick failed: ${error instanceof Error ? error.message : String(error)}`))
        },
        () => { rerun = false },
      )
      return
    }
    void tick().catch((error) => log(`waker: kick failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  async function commandRunsIdle(): Promise<void> {
    while (commandRuns.size > 0) await Promise.all([...commandRuns.values()].map((r) => r.done))
  }

  function threadIsLive(row: SessionRow | undefined): row is SessionRow {
    return !!row && row.state !== "archived" && row.archived !== 1
  }

  function enqueueCommandWatchWake(row: SessionRow, fenceId: string, message: string, reason: string, nowMs: number): void {
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    const item = outbox.enqueue({
      id: deliveryId,
      slug: row.slug,
      sessionId: row.session_id,
      fenceId,
      hintKey: fenceId,
      message: withClock(message, deps.tailer.get(row.slug)?.lastAssistantAt),
      reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  function lastRunOf(w: CommandWatchRow): { outcome: "exit" | "timeout" | "signal" | "error"; exitCode: number | null; output: string } | undefined {
    if (w.last_run_at === null || !w.last_outcome) return undefined
    return { outcome: w.last_outcome, exitCode: w.last_exit, output: w.last_output ?? "" }
  }

  function evalCommandWatches(nowMs: number): void {
    // EXPIRY FIRST, so an expired watch never runs once more on its way out. Wake THEN settle: a crash
    // between the two leaves the row armed and expired, and the next pass re-enqueues under the same
    // delivery id, which the outbox dedupes — so the wake goes out exactly once either way.
    for (const w of deps.storage.expiredCommandWatches(nowMs)) {
      commandRuns.get(w.id)?.abort.abort()
      const row = deps.storage.getSession(w.thread_slug)
      if (threadIsLive(row)) {
        enqueueCommandWatchWake(
          row,
          `${COMMAND_WATCH_EXPIRED_FENCE_PREFIX}:${w.id}`,
          commandWatchExpiredWakeMessage({ id: w.id, command: w.command, lastRun: lastRunOf(w) }),
          `command watch ${w.id} expired after ${w.runs} check(s)`,
          nowMs,
        )
      }
      deps.storage.settleCommandWatch(w.id, "expired", nowMs)
      log(`waker: settled ${w.thread_slug} — command watch ${w.id} expired`)
    }
    const armed = deps.storage.armedCommandWatches()
    // A check whose row left `armed` under it — dropped by the worker, or the thread forgotten — is
    // killed now rather than left to finish a question nobody is asking.
    const armedIds = new Set(armed.map((w) => w.id))
    for (const [id, run] of commandRuns) if (!armedIds.has(id)) run.abort.abort()
    const service = deps.commandWatches
    if (!service) return
    for (const w of armed) {
      if (commandRuns.has(w.id)) continue
      const dueAt = w.last_run_at !== null ? w.last_run_at + w.every_ms : w.created_at
      if (nowMs < dueAt) continue
      const row = deps.storage.getSession(w.thread_slug)
      // AN ARCHIVED THREAD's watch stays ARMED and is not run, the PR watcher's rule: it can be reopened,
      // and the watch is still its worker's outstanding intent — but no check runs for a thread nothing
      // can wake. Its `for` still runs out above.
      if (!threadIsLive(row)) continue
      // THE GATE, AGAIN, AT EVERY CHECK. Registration asked it once; a thread whose permission mode or
      // sandbox changed since must stop getting commands run for it, and must be told — a watch that
      // silently stops is a worker resting on coverage it does not have.
      const refusal = service.refusal(row)
      if (refusal) {
        enqueueCommandWatchWake(
          row,
          `${COMMAND_WATCH_CANCELLED_FENCE_PREFIX}:${w.id}`,
          commandWatchCancelledWakeMessage({ id: w.id, command: w.command, reason: refusal }),
          `command watch ${w.id} cancelled: ${refusal}`,
          nowMs,
        )
        deps.storage.settleCommandWatch(w.id, "cancelled", nowMs)
        log(`waker: settled ${w.thread_slug} — command watch ${w.id} cancelled: ${refusal}`)
        continue
      }
      startCommandRun(service, w)
    }
  }

  function startCommandRun(service: CommandWatchService, w: CommandWatchRow): void {
    const abort = new AbortController()
    const done = (async () => {
      let result: Pick<CommandRunResult, "outcome" | "exitCode" | "output">
      try {
        result = await service.run(w.thread_slug, w.command, { signal: abort.signal })
      } catch (err) {
        result = { outcome: "error", exitCode: null, output: err instanceof Error ? err.message : String(err) }
      }
      // Aborted ⇒ the row left `armed`, ran out, or the server is stopping. Nothing is recorded: the
      // first two have nothing to record onto, and the third leaves the row for the next server to run.
      if (abort.signal.aborted || stopped) return
      finishCommandRun(w, result)
    })()
      .catch((err) => log(`waker: command watch ${w.id} check failed to record: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { if (commandRuns.get(w.id)?.done === done) commandRuns.delete(w.id) })
    commandRuns.set(w.id, { abort, done })
  }

  function finishCommandRun(w: CommandWatchRow, result: Pick<CommandRunResult, "outcome" | "exitCode" | "output">): void {
    const atMs = now()
    // Recorded only onto a row still ARMED (the statement's own guard): a drop that landed while this
    // check ran wins, and nothing it found is reported.
    if (!deps.storage.recordCommandWatchRun(w.id, { atMs, outcome: result.outcome, exitCode: result.exitCode, output: result.output })) return
    if (result.outcome !== "exit" || result.exitCode !== 0) return
    const current = deps.storage.getCommandWatch(w.id)
    const row = deps.storage.getSession(w.thread_slug)
    // PASSED. Wake THEN settle, for the expiry's reason: a crash between leaves the row armed, the next
    // server runs the check again, and the second pass's wake dedupes against the first by its id.
    if (threadIsLive(row)) {
      enqueueCommandWatchWake(
        row,
        `${COMMAND_WATCH_FENCE_PREFIX}:${w.id}`,
        commandWatchPassedWakeMessage({
          id: w.id,
          command: w.command,
          output: result.output,
          runs: current?.runs ?? w.runs + 1,
          armedMs: Math.max(0, atMs - w.created_at),
        }),
        `command watch ${w.id} passed`,
        atMs,
      )
    }
    deps.storage.settleCommandWatch(w.id, "passed", atMs)
    log(`waker: settled ${w.thread_slug} — command watch ${w.id} passed`)
    kick()
  }

  /** THE ANSWER DELIVERY PASS. The human answered on the board; this is what puts it in front of the
   *  worker, and it is a separate act from answering on purpose — an answer given while the worker's
   *  process was down has to survive the gap, or it is lost in exactly the silence the fenced question
   *  used to lose the QUESTION in.
   *
   *  ONLY AN ANSWER WAKES. A dismissal is real news ("decide it yourself") but it wakes nobody: the
   *  human dismissing questions is almost always dismissing several in a row and is sitting right there,
   *  so a wake per x would be a turn per click. Dismissals RIDE the next answer's message instead, and
   *  a thread with nothing but dismissals simply keeps them queued — the worker sees them gone in its
   *  own `ask` read-back.
   *
   *  MARKED DELIVERED WHEN THE WORKER HAS IT, not when the outbox does (2026-10-01). This used to flip
   *  `delivered` at ENQUEUE, on the reasoning that the outbox is durable and owns retry from there — but
   *  the outbox's retry is capped, and a wake that exhausts its attempts is filed and forgotten. On
   *  2026-09-30 four answers on one thread were flagged delivered and never reached its worker (a broker
   *  resume race, fixed in 0dc073b7); had every attempt failed, nothing anywhere would ever have offered
   *  them again. Now each settlement records the wake carrying it (`delivery_id`), `delivered` flips only
   *  when that wake reaches the outbox's `delivered` state (settleQuestionAnswers), and a settlement whose
   *  wake ended any other way is offered again:
   *    - IN FLIGHT (its wake pending or leased): skipped, so a second answer on the same thread is its
   *      own wake and never re-carries the first — the double-send the enqueue-time flag used to prevent.
   *    - LANDED but not yet marked (a process that died between the outbox's confirm and the mark): marked
   *      here.
   *    - FAILED (exhausted, abandoned, or superseded): offered again under a NEW fence id (the old one
   *      is spent — the outbox dedupes on it), when there is a reason to think it can land now. A wake
   *      superseded before it crossed the transport (the session moved; the thread was archived and is
   *      back) goes at once; a wake the runtime refused waits for this process to be newer than the
   *      failure, for the worker to have run a turn since, or for ANSWER_REOFFER_BACKOFF_MS. A brand-new
   *      settlement on the thread is a delivery opportunity too: the failed ones ride it.
   *
   *  ANSWERS ARRIVE A QUESTION AT A TIME (2026-09-29) and are delivered as they come, so the worker starts
   *  on the first while the human reads the rest. Three things keep that from costing a turn per card:
   *  every undelivered answer a pass finds for a thread goes as ONE message (below); an answer goes out
   *  mid-turn like a typed steer instead of waiting for the rest and opening its own turn
   *  (isDeliverableNow); and answer rows that piled up while none could go fold into one message at
   *  claim (adoptCompanions). A kick that lands during a pass runs one more pass after it (`kick`), so an
   *  answer stored while the previous one's delivery is in flight is picked up at once.
   */
  function evalQuestionAnswers(nowMs: number): void {
    const bySlug = new Map<string, ThreadQuestionRow[]>()
    for (const q of deps.storage.undeliveredSettlements()) {
      const list = bySlug.get(q.thread_slug) ?? []
      list.push(q)
      bySlug.set(q.thread_slug, list)
    }
    for (const [slug, settled] of bySlug) {
      const row = deps.storage.getSession(slug)
      // An archived thread is told nothing, and its rows stay undelivered: reopening it should still
      // hand the worker what the human said, rather than having spent it on a thread nobody was reading.
      if (!row || row.state === "archived" || row.archived === 1) continue
      // Sort each settlement by what its last offer came to. `rows` is what this pass may offer.
      const rows: ThreadQuestionRow[] = []
      const failed: WakeDelivery[] = []
      let fresh = false
      let reofferDue = false
      for (const q of settled) {
        if (!q.delivery_id) {
          rows.push(q)
          fresh = true
          continue
        }
        const carrier = outbox.get(q.delivery_id)
        if (carrier?.state === "pending" || carrier?.state === "leased") continue
        if (carrier?.state === "delivered") {
          deps.storage.markSettlementDelivered(q.id)
          continue
        }
        rows.push(q)
        if (carrier && !failed.some((d) => d.id === carrier.id)) failed.push(carrier)
        if (!carrier || answerReofferDue(carrier, row, nowMs)) reofferDue = true
      }
      if (rows.length === 0 || (!fresh && !reofferDue)) continue
      const answers: QuestionAnswer[] = []
      const dismissed: QuestionDismissal[] = []
      // The ids are kept alongside for the delivery key ONLY. The MESSAGE names each dismissed question
      // by its text, because the worker never saw an id — ntwine minted it — so a list of ids names
      // nothing it can act on. (The human's Answers card leaves these rows out — see answersForDisplay.)
      const dismissedIds: string[] = []
      for (const q of rows) {
        if (q.state === "dismissed") {
          dismissedIds.push(q.id)
          const spec = safeQuestionSpec(q.spec)
          if (spec) dismissed.push({ question: spec.question })
          continue
        }
        const parsed = safeQuestionAnswer(q.answer)
        if (parsed) answers.push(parsed)
      }
      // DISMISSALS ALONE WAKE NOBODY — UNLESS NOTHING ELSE WILL EVER CARRY THEM. The rule exists because
      // a human dismissing questions is almost always dismissing several in a row and is sitting right
      // there, so a wake per x would be a turn per click; they ride the next answer or the next steer.
      //
      // An AUTONOMOUS thread has neither. Its whole premise is that nobody is about to send it anything,
      // and its questions get cancelled wholesale the moment the Goal is armed — so on that thread the
      // "it rides the next steer" half of the rule is a promise nothing keeps, and the worker would
      // simply never learn that questions it is still waiting on have been taken away from it.
      if (answers.length === 0 && !(row.recurring_on_rest === 1 && row.recurring_prompt?.trim())) continue
      // A dismissed row whose spec no longer parses is still real news: it leaves the delivery queue and
      // counts toward the cancellation wake, it just cannot be quoted. Counting from `dismissedIds`
      // rather than `dismissed` is what keeps that row from silently disappearing.
      const cancelledCount = dismissedIds.length
      // One delivery per BATCH, keyed by the ids in it, so a second answer on the same thread is its own
      // piece of news rather than a duplicate deduped away. A RE-OFFER keys on the failed deliveries too:
      // the outbox dedupes on the fence id, and the failed row still holds the plain one.
      const fenceId = questionAnswerFenceId([
        ...answers.map((a) => a.questionId), ...dismissedIds,
        ...rows.flatMap((q) => (q.delivery_id ? [`after:${q.delivery_id}`] : [])),
        // A CHANGED answer is news the first delivery's key already names, so it keys on when it changed
        // too: the outbox would otherwise dedupe it into the delivery that carried the old answer.
        ...answers.flatMap((a) => (a.changed ? [`changed:${a.questionId}@${rows.find((q) => q.id === a.questionId)?.settled_at ?? ""}`] : [])),
      ])
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // CLAIM THE ROWS BEFORE THE WAKE EXISTS. A process that dies between the two leaves rows naming a
      // delivery the outbox never had — read above as a failed one that never crossed the transport,
      // and re-offered at once. The other order would leave a wake whose landing marks nothing.
      for (const q of rows) deps.storage.assignSettlementDelivery(q.id, deliveryId)
      const reoffer = failed.length > 0 || rows.some((q) => q.delivery_id)
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(
          answers.length === 0 ? questionsCancelledWakeMessage(cancelledCount) : questionAnswerMessage(answers, dismissed),
          deps.tailer.get(row.slug)?.lastAssistantAt,
        ),
        reason: (answers.length === 0
          ? `${cancelledCount} question(s) cancelled — autonomous`
          : `${answers.length} question answer(s)${cancelledCount ? ` + ${cancelledCount} dismissed` : ""}`)
          + (reoffer ? " — offered again: the last wake carrying them did not land" : ""),
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  /** May a batch of answers whose last wake FAILED be offered again now? See evalQuestionAnswers. */
  function answerReofferDue(carrier: WakeDelivery, row: SessionRow, nowMs: number): boolean {
    // Nothing crossed the transport and nothing about the runtime refused it: the session moved under
    // the queued wake, or the thread was archived and is back (the caller already skips archived rows).
    if (carrier.state === "superseded" && carrier.sentAt === null && carrier.lastError?.startsWith(CONTEXT_SUPERSEDED)) return true
    const failedAt = carrier.terminalAt ?? carrier.updatedAt
    // This process never tried it. A restart is where a broken binary, credential or config gets fixed.
    if (failedAt < startedAtMs) return true
    // The worker ran a turn after the failure — a human steer reached it, say — so the runtime that
    // refused the wake takes input again.
    const tele = deps.tailer.get(row.slug)
    const ranAt = Math.max(Date.parse(tele?.lastAssistantAt ?? "") || 0, Date.parse(tele?.lastUserAt ?? "") || 0)
    if (ranAt > failedAt) return true
    return nowMs - failedAt >= ANSWER_REOFFER_BACKOFF_MS
  }

  // Mark the settlements an answers wake carried as RECEIVED — the one place `thread_question.delivered`
  // flips (evalQuestionAnswers). Called from every path that files a wake as delivered.
  function settleQuestionAnswers(item: WakeDelivery): void {
    if (!isQuestionAnswerFenceId(item.fenceId)) return
    deps.storage.markSettlementsDeliveredBy(item.id)
  }

  // Said, because nothing else says it: the outbox files a failed wake and moves on, and the answers it
  // carried now wait for evalQuestionAnswers to offer them again.
  function noteAnswersUndelivered(item: WakeDelivery): void {
    if (!isQuestionAnswerFenceId(item.fenceId)) return
    log(`waker: answers for ${item.slug} stay UNDELIVERED — offered again once this server restarts, the worker runs a turn, or ${Math.round(ANSWER_REOFFER_BACKOFF_MS / 60_000)}m pass`)
  }

  // ---- SCHEDULED THREADS --------------------------------------------------------------------------------
  // A schedule starts a NEW thread, which nothing else here does: every other source resumes an existing
  // one through the outbox. So this pass owns no outbox rows — its never-twice record is the schedule's own
  // run row (thread_schedule_run), claimed in this tick and launched outside it (schedules.ts evalDue).
  //
  // THE ONE EXCEPTION TO "NEVER FIRES ON FIRST SIGHT" (start, below): an occurrence that came due while
  // ntwine was off does fire after a restart — once, and only within its lateness cap. It waits out a
  // post-boot grace first, so the tailer has vouched for the previous run before the overlap check reads it.
  function evalScheduledThreads(nowMs: number): void {
    deps.scheduledThreads?.evalDue(nowMs)
  }

  function evalTimers(nowMs: number): void {
    for (const timer of deps.storage.dueThreadTimers(nowMs)) {
      const row = deps.storage.getSession(timer.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left armed rather than settled — an
      // archived thread can be reopened, and the alarm is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = timerFenceId(timer.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue // this alarm already has its one wake
      const fireAt = new Date(timer.fire_at).toISOString()
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${TIMER_HINT_PREFIX}${timer.id}`,
        message: timerPromptMessage(timer.prompt, fireAt),
        reason: `one-off timer elapsed (${fireAt})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Settle the timer a wake came from — the row's OWN "never again" record, which outlives the pruning
  // of the terminal outbox row that would otherwise dedupe it.
  //
  // Called from every terminal path EXCEPT SUPERSESSION, which is the one distinction that matters here.
  // A timer supersedes for two reasons: its row already left `armed` (the worker cancelled it, or a
  // previous attempt settled it) — where this would be a no-op anyway, since the write is guarded on
  // `armed` — or the SESSION moved underneath the queued delivery. In that second case the alarm has not
  // rung and the thread still exists, so leaving the row armed is what lets the next tick re-queue it
  // against the current session. Settling there would silently swallow the alarm mid-resume.
  //
  // A delivery that exhausted its attempts or was abandoned DOES settle: it has had its one shot, and an
  // alarm resurrected days later when the outbox prunes is worse than one that failed.
  function settleTimer(item: WakeDelivery): void {
    if (!isTimerFenceId(item.fenceId)) return
    deps.storage.markThreadTimerFired(timerIdOf(item.fenceId), now())
  }

  // ---- The ON SCHEDULE pass -----------------------------------------------------------------
  // Like the snooze pass, this does NOT filter on `turn === "idle"`. Unlike the snooze pass, the
  // delivery gate does not hold the result either: a beat due mid-turn goes out mid-turn
  // (`isDeliverableNow`). Being able to reach a thread that is NOT going quiet is the whole point —
  // it is exactly what Claude Code's own cron cannot do (see SOURCE 4 above).
  //
  // At most ONE beat is ever outstanding per thread: a new one is queued only when the previous has
  // reached a terminal state, and the beat clock runs from the last DELIVERED beat. So an interval that
  // elapses while an undelivered beat is still open is skipped rather than stacked — a thread cannot
  // accumulate a backlog and then be handed all of it at once.
  function evalSchedulePrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSchedule(row)
      if (!armed || armed.dueAtMs > nowMs) continue
      if (goalLimitHit(row, nowMs) || goalCapReserved(row)) continue // never deliver past a limit
      if (pastDeadline(row, nowMs)) continue // nor past the thread's time limit (pastDeadline)
      // The ONE thing that silences a beat. Everything else about this source is unconditional — rest,
      // sub-agents, shells, all irrelevant — but a worker that has said there is no further work has
      // ended the arrangement, and a "permanently stalled" run that keeps being woken every interval is
      // not stalled at all. Needs no stored state: the flag is folded off the FINAL assistant message,
      // so anything the thread says or receives afterwards reopens it.
      const beatTele = deps.tailer.get(row.slug)
      if (beatTele && threadSaidDone(deps.storage, row.slug, beatTele, armed.armedAt)) continue
      // NOTHING ELSE SILENCES A BEAT — not a pending question, not a rest fence. A beat asks "it has been
      // an hour", which neither of those answers. The operator's question hold used to reach here and was
      // deleted with the switch that armed it (2026-08-16, see the header block).
      // One in flight at a time. Any open scheduled delivery for this thread — whatever its
      // generation — means the previous beat has not landed yet, so this interval is skipped rather
      // than stacked behind it.
      if (openSchedulePrompt(row.slug, row.session_id)) continue
      const beat = beatIndex(row.recurring_schedule_fired_at ?? null, armed)
      const fenceId = heartbeatFenceId(armed.armedAt, beat)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${HEARTBEAT_HINT_PREFIX}${armed.intervalMs}`,
        message: schedulePromptMessage(armed.prompt, Math.round(armed.intervalMs / 1000)),
        reason: `recurring prompt every ${Math.round(armed.intervalMs / 1000)}s`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Is a beat for this thread still open (pending/leased)? Scanning the open set is cheap — the outbox
  // holds only live work — and it is the one check that makes "at most one beat outstanding" true
  // across restarts, since it reads the durable rows rather than in-memory arming.
  function openSchedulePrompt(slug: string, sessionId: string): boolean {
    return outbox.listOpen().some(
      (item) => item.slug === slug && item.sessionId === sessionId && isHeartbeatFenceId(item.fenceId),
    )
  }

  // A monotonic-enough beat number so consecutive beats get distinct delivery ids. Derived from elapsed
  // intervals rather than a stored counter: the row already carries everything needed, and a delivery
  // id only has to be unique per (session, generation), not meaningful.
  function beatIndex(lastFiredAt: string | null, armed: ArmedSchedule): number {
    const armedMs = Date.parse(armed.armedAt)
    const lastMs = Date.parse(lastFiredAt ?? armed.armedAt)
    if (!Number.isFinite(armedMs) || !Number.isFinite(lastMs)) return 0
    return Math.max(0, Math.round((lastMs - armedMs) / armed.intervalMs)) + 1
  }

  // Stamp the beat clock once a beat has genuinely REACHED the worker, so the next one is due an
  // interval after it actually landed. Called from the points that establish delivery — the send to a
  // live runtime (`stampGoalSent`), the acknowledgement, the transcript or grace confirmation — and
  // deliberately NOT from the superseded/exhausted/abandoned ones the snooze settles on. A beat dropped
  // because the human pressed pause, or one that never crossed the transport, never fired, and
  // advancing the clock for it would silently swallow the next interval.
  //
  // Guarded on the generation for the same reason as the snooze: a beat that settles after the worker
  // re-armed or switched off the trigger must not write a schedule onto settings it no longer describes.
  function settleSchedulePrompt(item: WakeDelivery, atMs = goalSentAtMs(item)): void {
    if (!isHeartbeatFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringScheduleFired(item.slug, armedAt, new Date(atMs).toISOString())
  }

  // WHEN A GOAL PROMPT WAS SENT — the one instant all three triggers' stamps record (2026-09-29). The
  // stamps are the panel's "Last sent …" reading and, for the schedule, the beat clock, and both mean
  // the moment the prompt crossed to the worker. A delivery a live runtime took carries that instant as
  // `sentAt`, and it survives confirmation, so the confirmation a grace later re-writes the SAME value
  // instead of sliding the reading (and the next beat) by the grace. One acknowledged on return (Codex,
  // ACP, a runtime that cannot say) has no `sentAt`: its acknowledgement IS the send, so it is now.
  // The injected clock rather than `new Date()`, so the stamps sit on the same timeline as everything
  // else the scheduler decides with — the beat's due time is computed from this.
  function goalSentAtMs(item: WakeDelivery): number {
    return item.sentAt ?? now()
  }

  // STAMP AT THE SEND, for the reason the run count is taken there (see countGoalDelivery). The stamps
  // were written only when a delivery SETTLED, and a stop-hook bump to a live Claude worker never
  // settles as delivered: the worker's answer is a new rest, `deliveryContext` reads the bump
  // superseded, and the superseded branch stamps nothing. So "Last sent at rest" never appeared on a
  // Claude thread at all, while a Codex thread — acknowledged on return — always showed it. The
  // heartbeat and the post-compaction bump are not bound to a rest, so they did settle, a confirmation
  // grace late. Called with the send's own instant because the in-memory row predates `markSent`.
  function stampGoalSent(item: WakeDelivery, sentAtMs: number): void {
    settleSchedulePrompt(item, sentAtMs)
    settleRestPrompt(item, sentAtMs)
    settleCompactPrompt(item, sentAtMs)
  }

  // ---- The GOAL'S LIMITS (see the block above goalLimitHit) ------------------------------------
  // One run counted per DELIVERED Goal prompt, whichever trigger sent it, and the cap applied in the
  // same breath — see "WHERE THE COUNT IS CHECKED".
  //
  // COUNTED AT SEND, not only at settlement, and a real stack is why (2026-09-29). A wake written to a
  // LIVE runtime is left leased as "sent" and settled later by reconcileOutbox — and a stop-hook
  // delivery is bound to the rest it was queued for, so the moment the worker answers it (a one-word
  // reply takes two seconds; the confirmation grace is longer) `deliveryContext` reads it SUPERSEDED,
  // and the superseded branch settles nothing. Counted only there, five real deliveries to a real Claude
  // worker counted zero and a cap of 3 never stopped anything. The signoff nudge's cap hit the same wall
  // and is spent at send for the same reason. So every point that establishes a delivery calls this —
  // the send to a live runtime, the acknowledgement, the transcript confirmation — and storage counts
  // each delivery once, by fence id. The cost is a frame lost with a runtime that died mid-read: it
  // counts, and is re-sent under the same fence id, which does not count again.
  function countGoalDelivery(item: WakeDelivery): void {
    const prefix = isStopHookFenceId(item.fenceId) ? STOP_HOOK_FENCE_PREFIX
      : isHeartbeatFenceId(item.fenceId) ? HEARTBEAT_FENCE_PREFIX
      : isCompactFenceId(item.fenceId) ? COMPACT_FENCE_PREFIX
      : undefined
    if (!prefix) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${prefix}:${armedAt}:`)) return
    if (deps.storage.countRecurringRun(item.slug, armedAt, item.fenceId) === undefined) return
    const counted = deps.storage.getSession(item.slug)
    if (counted) applyGoalLimit(counted, now())
  }

  // Disarm a Goal that has reached a limit, and queue the one wake that says so. Returns nothing: the
  // storage guard is what makes this idempotent, so every caller can simply call it.
  function applyGoalLimit(row: SessionRow, nowMs: number): void {
    const reason = goalLimitHit(row, nowMs)
    const armedAt = row.recurring_armed_at
    if (!reason || !armedAt) return
    if (!deps.storage.stopRecurringAtLimit(row.slug, armedAt, reason, new Date(nowMs).toISOString())) return
    const runs = row.recurring_runs ?? 0
    log(`waker: ${row.slug} goal stopped at its ${reason === "runs" ? `run limit (${runs}/${row.recurring_max_runs})` : "time limit"}`)
    const fenceId = goalEndFenceId(armedAt)
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    // Archived: the loop is still stopped (a re-opened thread must not find it running), but nobody is
    // there to tell.
    if (row.state === "archived" || row.archived === 1) return
    const item = outbox.enqueue({
      id: deliveryId,
      slug: row.slug,
      sessionId: row.session_id,
      fenceId,
      hintKey: fenceId,
      message: goalLimitMessage({
        reason,
        runs,
        maxRuns: row.recurring_max_runs,
        forSeconds: row.recurring_for_ms ? Math.round(row.recurring_for_ms / 1000) : null,
      }),
      reason: `goal reached its ${reason === "runs" ? "run" : "time"} limit`,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  // THE CAP IS RESERVED AT ENQUEUE, not only counted at settle. Two triggers can each have a delivery
  // open at once (a beat due on the same tick as a rest), and the outbox MERGES a thread's ready wakes
  // into one frame — so both would go out together, and counting them afterwards would already be
  // N+1. A Goal whose delivered runs plus its still-open deliveries reach the cap queues nothing more.
  function goalCapReserved(row: SessionRow): boolean {
    const max = row.recurring_max_runs
    if (typeof max !== "number" || max <= 0) return false
    const open = outbox.listOpen().filter((item) =>
      item.slug === row.slug && item.sessionId === row.session_id &&
      (isHeartbeatFenceId(item.fenceId) || isStopHookFenceId(item.fenceId) || isCompactFenceId(item.fenceId)),
    ).length
    return (row.recurring_runs ?? 0) + open >= max
  }

  // The TIME bound's check, and the catch-all for a cap LOWERED under a count already past it (the
  // settle path only fires on a delivery). Runs first in the tick, so no trigger's pass sees a Goal
  // that should already have ended.
  function evalGoalLimits(nowMs: number): void {
    for (const row of deps.storage.allSessions()) applyGoalLimit(row, nowMs)
  }

  // ---- The ON REST pass -----------------------------------------------------------------------
  // Unlike every other pass here this one DOES filter on `turn === "idle"`, because rest is not a
  // deadline it can queue against — it IS the trigger. Queueing a bump for a busy thread would bind it
  // to an activity stamp that is still moving, and the delivery gate would then supersede it on the
  // very next line the worker wrote.
  function evalRestPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedRest(row)
      if (!armed) continue
      if (goalLimitHit(row, nowMs) || goalCapReserved(row)) continue // never deliver past a limit
      if (pastDeadline(row, nowMs)) continue // nor past the thread's time limit (pastDeadline)
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      // THE AGENT MUST HAVE SPOKEN LAST. `turn === "idle"` alone is not "the agent rested": a thread
      // whose worker is gone is idle forever, and ntwine's own bump keeps landing in its transcript. This
      // is the guard that makes the trigger mean "you stopped" rather than "nothing is happening" — see
      // `stopHookFenceId`. It costs the feature nothing: an agent that genuinely takes a turn and rests
      // again produces a NEW assistant timestamp, which is exactly when the Goal should fire.
      const restedAt = tele.lastAssistantAt
      if (!restedAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(restedAt)) continue
      // A SIGNED-OUT PROVIDER ANSWERS INSTANTLY, and that is a loop this trigger cannot see any other
      // way. The worker replies "Not logged in · Please run /login" in milliseconds, which is a genuine
      // new assistant message and therefore a genuine new rest — so every guard above is satisfied and
      // the bump fires again, ten times in a hundred seconds (measured 2026-08-12). Nothing the operator
      // has not done can change the outcome, so re-prompting is pure burn: the thread already cards its
      // auth fault and the sign-in recovery in the queue.
      if (tele.authFault) continue
      // AND EVERY OTHER FAILED TURN, for the same reason — and here it matters MORE than for the sign-off
      // reminder, because this trigger has no cap of its own. A synthetic API-error record of any kind
      // (a 400 for a conversation that has outgrown the context window, a 500, a dropped connection) is
      // an assistant record, so it advances `lastAssistantAt`: a fresh rest instant, a fresh
      // `stopHookFenceId`, and the per-rest dedupe below never fires. Without this guard a thread with
      // an armed Goal whose every turn fails is bumped once per tick indefinitely, and on a context-window
      // 400 each bump is what keeps the conversation over the limit (the loop measured in the field on
      // the reminder, 2026-08-27, is open here by the same mechanism). The cost is deliberate: a turn
      // that failed TRANSIENTLY is no longer blind-retried by the Goal either — the operator bumps it, or
      // the next real event on the thread does — because this trigger cannot tell the two apart and an
      // unbounded retry of a terminal error is the worse failure.
      if (tele.apiFault) continue
      // WHAT THIS DELIBERATELY DOES NOT CONSULT: live sub-agents and background shells. A hold on them
      // shipped briefly and was removed the same day (maintainer 2026-08-02: "the status of any
      // sub-agents or background shells is irrelevant"). The SCHEDULE trigger is the whole rate story — a
      // thread parked behind children is bumped on the same schedule as any other, which is also what
      // makes this able to rescue one parked behind a child that will never report. A worker that
      // genuinely has nothing to do until something returns says AWAITING — and an AWAITING naming a
      // wait the scheduler itself will fire is honoured, not bumped (`parkedOnAWaitItCannotAdvance`).
      // THE REST ALREADY ANSWERED THIS TRIGGER'S QUESTION — the thread signed off as done, or parked on a
      // wait it cannot advance by working. A ```question fence does NOT answer it: a thread carrying a
      // Goal is not waiting on the human, so the bump fires over it and is worded for it (see
      // `restMessageIsSignedOff` and the header block).
      // Per-rest, and that is what makes it free: every fact it reads rides the FINAL assistant message,
      // so the next word on the thread re-opens the trigger with nothing stored to clear.
      if (restMessageIsSignedOff(deps.storage, row.slug, tele, registeredPrWatchesOf(deps.storage, row.slug), armedTimerIdsOf(deps.storage, row.slug), armed.armedAt)) continue
      // A SETTLEMENT WAKE OWNS THIS REST (2026-09-02). An answer the human just gave, or the questions
      // this very Goal's arming cancelled, is already on its way through evalQuestionAnswers — a wake
      // that ends the rest by itself, and whose message is the news. The Goal firing beside it is the
      // two-deliveries-in-one-tick shape the reminder hold below exists for ("Redundant Dones"), so it
      // stands down the same way and fires on the first rest the worker takes AFTER hearing the news.
      // The flag may be hard true: this pass only runs for rows whose armed rest Goal is exactly the
      // gate evalQuestionAnswers wakes dismissal-only settlements on. Bounded like the answer card is —
      // the wake landing advances `lastUserAt` past the settlement, which both spends this hold and
      // closes the rest above.
      if (answersInFlight(deps.storage.listThreadQuestions(row.slug), tele.lastUserAt, true) !== undefined) continue
      // THE REMINDER TOOK THIS REST (2026-08-28). SOURCE 9 mints before this pass runs, and a rest it
      // claimed gets no Goal on top. The two used to go out in the same tick, 5 ms apart; the runtime
      // queued the second behind the first's turn, so a worker that answered the Goal with a ```done
      // fence then read "you rested without a fence" and fenced again — two Done cards for one sign-off
      // (thread `wrong-agent-id-re-fencing`, maintainer: "Redundant Dones"). The reminder's own
      // supersession check in `deliveryContext` could not catch it: it ran at send, before any reply
      // existed. The long reminder opens by sending a half-finished thread back to the work, so the
      // operator's words lose little on that rest; the short waiting variant (a rest with a shell or, on
      // this Goal thread, a child still running) leads with that work and its fence instead, and keeps
      // only a closing "if work is left, do it now" — a deliberate trade, since a worker waiting on a
      // build is better served by the fence than by "keep going". The operator's words reach the worker
      // on the first bare rest the reminder does not take (its cap spent, or the setting off). A
      // DELIVERED reminder holds this too, which is what makes it per-rest rather than per-tick — in
      // production its record closes the rest anyway (`lastUserAt` moves past `restedAt`, above).
      // Superseded means the worker moved on and
      // exhausted means the runtime could not be reached; the Goal for that rest is dead or doomed alike,
      // so neither holds it.
      const reminder = outbox.get(wakeDeliveryId(row.slug, row.session_id, signoffFenceId(restedAt)))
      if (reminder && reminder.state !== "superseded" && reminder.state !== "exhausted") continue
      const fenceId = stopHookFenceId(armed.armedAt, restedAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a rest bump EXACTLY once: the same
      // rest yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: STOP_HOOK_HINT_KEY,
        message: restPromptMessage(armed.prompt, { overQuestion: tele.pendingQuestion === true }),
        reason: "recurring prompt at rest",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The ON COMPACTION pass -----------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` (see SOURCE 7): the point is to reach the worker
  // in the emptied window, and a compaction happens while it is working. Nor does it consult whether the
  // thread signed off — a ```done fence answers "you stopped, is there more?", which is not the question
  // a compaction asks. A worker that genuinely wants these to stop clears the Goal, or the operator does
  // it in the Goal panel.
  function evalCompactPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedCompact(row)
      if (!armed) continue
      if (goalLimitHit(row, nowMs) || goalCapReserved(row)) continue // never deliver past a limit
      if (pastDeadline(row, nowMs)) continue // nor past the thread's time limit (pastDeadline)
      const tele = deps.tailer.get(row.slug)
      if (!tele?.lastCompactionAt) continue
      // NEVER fire for a compaction that predates the arming. Without this, switching the trigger on for
      // a thread that compacted an hour ago delivers immediately for an event the operator never saw —
      // and a thread that has compacted before is the common case, not the exotic one.
      if (tele.lastCompactionAt <= armed.armedAt) continue
      // NOTHING HOLDS THIS ONE. Re-grounding a worker whose context was just emptied is worth doing
      // whether or not it is mid-turn, whether or not it is waiting on an answer, and a fence it wrote
      // before the compaction says nothing about whether it still remembers what it was doing.
      const fenceId = compactFenceId(armed.armedAt, tele.lastCompactionAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a compaction bump EXACTLY once: the
      // same compaction yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: COMPACT_HINT_KEY,
        message: compactionPromptMessage(armed.prompt),
        reason: "recurring prompt after compaction",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Stamp the POST-COMPACTION readout once its delivery is terminal. Cosmetic (the panel's "last sent"),
  // guarded on the generation for the same reason as its siblings: a bump settling after the operator
  // edited the text must not write onto words it no longer describes.
  function settleCompactPrompt(item: WakeDelivery, atMs = goalSentAtMs(item)): void {
    if (!isCompactFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringCompactFired(item.slug, armedAt, new Date(atMs).toISOString())
  }

  // Stamp the rest trigger's "last sent" once a bump has genuinely REACHED the worker — at the send to a
  // live runtime (`stampGoalSent`; for a Claude worker nothing later ever settles it as delivered) or at
  // the acknowledgement / confirmation. Guarded on the generation so a bump settling after the operator
  // edited the text cannot write onto words it no longer describes.
  function settleRestPrompt(item: WakeDelivery, atMs = goalSentAtMs(item)): void {
    if (!isStopHookFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringRestFired(item.slug, armedAt, new Date(atMs).toISOString())
  }

  // Disarm the row a snooze wake came from, once that wake is terminal. Guarded on the fence id still
  // matching so a human who re-snoozed (or snoozed again) between enqueue and settlement keeps their
  // NEW deadline — the stale delivery must never erase state it no longer describes.
  function settleSnooze(item: WakeDelivery): void {
    if (!isSnoozeFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    if (armedSnooze(row)?.fenceId !== item.fenceId) return
    deps.storage.setSnoozedUntil(item.slug, null)
  }

  function reconcileOutbox(nowMs: number): void {
    for (const item of outbox.listOpen()) {
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, nowMs)
        settleDelivered(item)
        confirmFrame(item, nowMs)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, nowMs, CONTEXT_SUPERSEDED)
        reoweTerminalNote(item)
        settleSnooze(item)
        continue
      }
      if (item.state !== "leased" || item.leaseUntil === null || item.leaseUntil > nowMs) continue
      // A SENT wake whose confirmation window has closed without the token showing up (that case was
      // `confirmed`, above). The runtime that took the frame decides: still alive, it read the wake and
      // the transcript check is merely blind to it (a message the CLI has queued, a text the fold has
      // not reached) — delivered. Dead, and the frame died with it — a lost wake, which goes round
      // again exactly as a lease that expired before delivery does, under the same idle-only rule and
      // the same attempt cap, and is SAID when the cap runs out rather than filed as done.
      if (item.sentAt !== null) {
        const runtime = deps.wakeRuntimeState?.(item.slug, item.sessionId) ?? "unknown"
        if (runtime !== "dead") {
          if (outbox.confirm(item.id, nowMs)) {
            settleSnooze(item)
            settleSchedulePrompt(item)
            settleRestPrompt(item)
            settleCompactPrompt(item)
            settleTimer(item)
            settleQuestionAnswers(item)
            settleSignoffNudge(item)
            countGoalDelivery(item)
            log(`waker: delivered ${item.slug} — ${item.reason}${item.attempts > 1 ? ` (on attempt ${item.attempts})` : ""}`)
          }
          continue
        }
        if (context !== "current-idle") continue
        const recovered = outbox.recoverExpired(
          item.id, nowMs, nowMs + retryDelay(item.attempts), maxDeliveryAttempts,
          "the worker's process died before it read this wake",
        )
        if (!recovered) continue
        if (recovered.state === "exhausted") {
          settleSnooze(item)
          settleTimer(item)
          log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
          noteAnswersUndelivered(item)
        } else {
          log(`waker: wake LOST for ${item.slug} — ${item.reason}: the worker's process died before it read it; sending again (attempt ${item.attempts} of ${maxDeliveryAttempts} spent)`)
        }
        continue
      }
      // An expired lease is an interrupted/uncertain attempt. Re-open it only while the exact session
      // generation is still idly awaiting the exact fence. Busy or not-yet-loaded telemetry is held:
      // retrying there could duplicate an input that crossed the transport just before process death.
      //
      // DELIBERATELY NOT `isDeliverableNow`: a scheduled prompt may be SENT to a busy thread, but not
      // RE-sent to one on a guess. This branch runs precisely when we do not know whether the previous
      // attempt landed, and the transcript check that would tell us (`confirmed`, above) cannot see a
      // message still sitting in the CLI's queue. A beat that arrives one rest late is the old
      // behaviour; a beat that arrives twice mid-turn is a new defect.
      //
      // THE ONE EXCEPTION IS A ROW THIS SCHEDULER DEFERRED and has now held past the ceiling: its
      // `lastError` is the deferral's own text and `sentAt` is null, so nothing ever crossed the
      // transport and re-opening it is not a guess. It is re-opened so `deliverDue` can send it into the
      // busy thread's queue (isDeliverableNow's ceiling), which is the whole point of the bound.
      if (context !== "current-idle" && !heldPastBound(item, context, nowMs)) continue
      const recovered = outbox.recoverExpired(
        item.id,
        nowMs,
        nowMs,
        maxDeliveryAttempts,
        item.lastError ?? "delivery lease expired before acknowledgement",
      )
      if (recovered?.state === "exhausted") {
        settleSnooze(item)
        settleTimer(item)
        log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
        noteAnswersUndelivered(item)
      }
    }
  }

  // Every settle a DELIVERED wake owes its source. Repeated verbatim at the confirm, ack and frame
  // paths below, so it is one list.
  function settleDelivered(item: WakeDelivery): void {
    settleSnooze(item)
    settleSchedulePrompt(item)
    settleRestPrompt(item)
    settleCompactPrompt(item)
    settleTimer(item)
    countGoalDelivery(item)
    settleQuestionAnswers(item)
  }

  // ---- THE MERGE: ONE THREAD, ONE TURN --------------------------------------------------------------
  // A delivery is a turn, and a turn is the expensive unit (wake-store.ts, WAKE_QUIET_WINDOW_MS, for the
  // numbers: $2–3 each at today's context sizes, 32% of a day's spend). The quiet window makes a thread's
  // wakes WAIT together; this is what makes them GO together. When a claim passes its gates, every other
  // pending row for the same thread and session is examined on its own terms — its own `deliveryContext`,
  // so a row whose fence or rest was superseded settles as superseded and one already confirmed by the
  // transcript settles as confirmed, exactly as they would have alone — and every row that could go out
  // right now is LEASED beside the carrier (`adopt`, which ignores the quiet window: the carrier is
  // leaving anyway) and folded into the carrier's message under its own reason line, in creation order.
  //
  // THE ROWS STAY SEPARATE. Only the message is merged: each companion keeps its own row, attempts,
  // lease and terminal state, and every outcome of the one `resume` — deferred, abandoned, sent, acked
  // — is applied to the whole frame, row by row. That is what keeps the two invariants that matter
  // intact without a new state or column: the per-fence dedupe (a merged-away timer's row reaches
  // `delivered` under its own fence id, so `evalTimers` finds it and never re-mints; a merged-away
  // report's row is there for `undeliveredPrWatchReport` to see), and the settle hooks (a merged-away
  // timer is marked fired, a merged-away snooze disarmed, by the same `settleDelivered` the carrier gets).
  // A frame that is LOST — the process died before it read the frame — goes round again row by row and
  // is simply re-merged by the next claim; nothing is delivered on the strength of a message that was
  // composed and never read.
  //
  // AN ANSWER NEVER MERGES WITH ANYTHING BUT ANOTHER ANSWER. `questionAnswerMessage` is the human's own
  // words in a shape the chat parses by position — its first line must be the answers header and every
  // trailing line is read as the last answer's continuation — so wrapping it in a heading or appending
  // anything after it would render ntwine's prose inside the human's answer chip. It is exempt from the
  // quiet window for the same reason it cannot wait.
  //
  // BUT ANSWERS FOLD INTO ONE ANOTHER (2026-09-29). They arrive a question at a time now, and every
  // answer the scheduler found at once already went as one message (evalQuestionAnswers groups a
  // thread's undelivered answers); what that missed is answers that piled up as SEPARATE rows while none
  // could go — the worker's process down, its telemetry unreadable, a delivery failing and retrying. Each
  // went out alone, a turn apiece. An answer carrier now adopts every other pending answer row and the
  // frame goes as ONE answers message, rows renumbered in order (shared mergeAnswerMessages).
  function adoptCompanions(carrier: WakeDelivery, claimedAt: number): WakeDelivery[] {
    const answers = isQuestionAnswerFenceId(carrier.fenceId)
    const adopted: WakeDelivery[] = []
    for (const sibling of outbox.pendingFor(carrier.slug, carrier.sessionId)) {
      if (sibling.id === carrier.id || isQuestionAnswerFenceId(sibling.fenceId) !== answers) continue
      // An answers carrier takes only what folds into the human's form: a cancellation wake is ntwine's
      // own voice (questionsCancelledWakeMessage) and goes on its own.
      if (answers && (mergeAnswerMessages([carrier.message, sibling.message]) === undefined)) continue
      const context = deliveryContext(sibling)
      if (context === "confirmed") {
        outbox.confirm(sibling.id, now())
        settleDelivered(sibling)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(sibling.id, now(), `${CONTEXT_SUPERSEDED} before delivery`)
        reoweTerminalNote(sibling)
        settleSnooze(sibling)
        continue
      }
      if (!isDeliverableNow(sibling, context, claimedAt)) continue
      const leased = outbox.adopt(sibling.id, deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (leased) adopted.push(leased)
    }
    return adopted
  }

  // The merged body is composed by `mergedWakeMessage` in @ntwine/shared, beside the splitter the chat
  // reads it back with. Same rule as `limitResumeSteer` and the park wakes: a formatter the chat cannot
  // parse falls through NtwineWake's fallback and prints its agent-facing body verbatim as a bordered
  // card, and this one did for five weeks.

  // A LONE wake's clock is re-read at SEND, for the same reason the merged one is: the stamp was taken at
  // enqueue, and the quiet window can hold a row for five minutes, across a turn the worker finished in
  // the meantime. Observed 2026-09-25: a PR-merged wake queued at 14:55 went out at 14:59 still saying
  // "you last spoke 14m ago" to a worker that had spoken 39 seconds earlier. Only a message that ends in
  // a clock gets a new one; the token is appended downstream, so this cannot disturb confirmation.
  function restampedWakeMessage(message: string, spokeAt: string | null | undefined, slug: string): string {
    const bare = stripWakeTimeHeader(message)
    return bare === message ? message : `${bare}\n\n${clockLine(now(), spokeAt, slug)}`
  }

  // A frame confirmed by its carrier's token is confirmed whole. The merged delivery is ONE user record
  // carrying ONE token — the carrier's — so a companion can never be confirmed by the transcript on its
  // own; left to itself it would wait out the grace and be confirmed by the runtime's survival, or, if
  // the process died inside the grace AFTER reading the frame, be sent again as lost. The companions are
  // the rows still leased and marked sent at the same instant as the carrier: `deliverDue` stamps the
  // whole frame with one `sentAt`.
  function confirmFrame(carrier: WakeDelivery, nowMs: number): void {
    if (carrier.sentAt === null) return
    for (const d of outbox.listOpen()) {
      if (d.id === carrier.id || d.slug !== carrier.slug || d.sessionId !== carrier.sessionId) continue
      if (d.state !== "leased" || d.sentAt !== carrier.sentAt) continue
      if (!outbox.confirm(d.id, nowMs)) continue
      settleDelivered(d)
      log(`waker: delivered ${d.slug} — ${d.reason} (in the same frame as: ${carrier.reason})`)
    }
  }

  async function deliverDue(): Promise<void> {
    for (let delivered = 0; delivered < deliveryBatchSize; delivered++) {
      // Condition polling can take seconds. Never derive a lease from the tick-start timestamp: a
      // sufficiently slow GitHub request would make a brand-new claim already expired to another
      // scheduler process. Every external-delivery boundary gets a fresh clock read instead.
      const claimedAt = now()
      const item = outbox.claim(deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (!item) return
      checkpoint("after-claim", item)

      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, now())
        settleDelivered(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), `${CONTEXT_SUPERSEDED} before delivery`)
        reoweTerminalNote(item)
        settleSnooze(item)
        continue
      }
      if (!isDeliverableNow(item, context, claimedAt)) {
        const deferredAt = now()
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          deferredAt,
          deferredAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          WAKE_HOLD_DEFERRAL,
        )
        continue
      }

      // The frame: the carrier plus everything else waiting for this thread that may go out now, in
      // creation order. One `resume`, one turn; see adoptCompanions.
      const companions = adoptCompanions(item, claimedAt)
      // A TERMINAL'S CONTROL MOVE still owed to this thread rides along (SOURCE 17): never with the human's
      // own answers, which fold into one form and go on their own.
      const riders = isQuestionAnswerFenceId(item.fenceId) ? [] : owedTerminalNotes(item.slug)
      const frame = [...companions, item].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const spokeAt = deps.tailer.get(item.slug)?.lastAssistantAt
      const message = riders.length > 0
        ? mergedWakeMessage([...frame, ...riders.map((r) => ({ reason: "a terminal changed hands", message: r.text }))], now(), spokeAt, rowDeadline(deps.storage.getSession(item.slug))?.atMs)
        : companions.length === 0
        ? restampedWakeMessage(item.message, spokeAt, item.slug)
        : isQuestionAnswerFenceId(item.fenceId)
          ? withClock(mergeAnswerMessages(frame.map((d) => d.message))!, spokeAt)
          : mergedWakeMessage(frame, now(), spokeAt, rowDeadline(deps.storage.getSession(item.slug))?.atMs)
      if (companions.length > 0) {
        log(`waker: merged ${frame.length} wakes for ${item.slug} into one delivery — ${frame.map((d) => d.reason).join("; ")}`)
      }

      try {
        // THE CLOCK RIDES ON EVERY DELIVERY. A broker-run worker is told neither the date nor the time
        // by its runtime (measured: zero date injections across a whole session), so it has no way to
        // judge how long its own parks actually last — which is why `for:` values are guesses. This is
        // the one place every ntwine wake passes through, so one line here reaches all of them.
        await deps.resume(item.slug, message, item.id)
        if (riders.length > 0) settleTerminalNotes(item.slug, riders)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedAt = now()
        // A TERMINAL delivery verdict (a live worker owns this conversation but its exact identity
        // can't be confirmed for safe re-entry) will never change by retrying — retrying only burns
        // every attempt to a silent exhaustion. Abandon the item now, preserving the reason for the
        // human, instead of deferring it back into the retry pool. Duck-typed so the scheduler stays
        // decoupled from resume.ts (see TerminalDeliveryError).
        if ((error as { terminalDelivery?: unknown })?.terminalDelivery === true) {
          for (const d of frame) {
            outbox.supersede(d.id, failedAt, message)
            settleSnooze(d)
            settleTimer(d)
          }
          log(`waker: delivery ABANDONED for ${item.slug} (terminal, no retry): ${message}`)
          for (const d of frame) noteAnswersUndelivered(d)
          continue
        }
        // A thrown non-terminal operation can still be ambiguous (for example, text reached the worker
        // before a later storage write failed). Keep the item leased through a confirmation window; recovery
        // checks the token/fence before making it retryable.
        for (const d of frame) {
          outbox.deferFailure(
            d.id,
            deliveryOwner,
            failedAt,
            failedAt + Math.max(deliveryLeaseMs, retryDelay(d.attempts)),
            message,
          )
        }
        log(`waker: delivery FAILED for ${item.slug} (attempt ${item.attempts} of ${maxDeliveryAttempts}): ${message}`)
        continue
      }

      // SENT IS NOT DELIVERED, when the runtime can tell us which. Reproduced 2026-08-25
      // (scripts/verify-prwatch-wake-cold-resume.mjs) against a real daemon: a thread parked on a PR
      // watcher, its idle daemon long since hibernated, the wake cold-resumes a `claude` that dies at
      // startup — and this branch used to file the wake as delivered the instant the socket write
      // returned. The PR-watch cursor had already moved past the event, so nothing ever said it again;
      // the worker sat 12h+ on a watcher that had "fired". Now the row stays leased as SENT and
      // reconcileOutbox decides: the token in the transcript confirms it, a runtime still alive after
      // the grace confirms it, a runtime that died with no token sends it round again.
      const runtime = deps.wakeRuntimeState?.(item.slug, item.sessionId) ?? "unknown"
      if (runtime !== "unknown") {
        const sentAt = now()
        if (outbox.markSent(item.id, deliveryOwner, sentAt, sentAt + confirmGraceMs)) {
          // The same stamp on every companion — it is what confirmFrame recognises the frame by.
          for (const d of companions) outbox.markSent(d.id, deliveryOwner, sentAt, sentAt + confirmGraceMs)
          // THE NUDGE'S CAP IS SPENT AT SEND, not at confirmation, and this branch is why the cap
          // existed on paper only. Every wake to a live runtime leaves here, so the settle below was
          // unreachable in production — and the confirm path this hands to cannot make up for it,
          // because `deliveryContext` reads a signoff item as SUPERSEDED the instant the agent's next
          // assistant record lands (an API-error record is one), and the superseded branch counts
          // nothing. `signoff_nudges` therefore stayed 0 forever while SIGNOFF_NUDGE_MAX was 2.
          // Counting here is also the honest anchor: the tokens are spent when the message is sent,
          // and confirmation is exactly what a thread failing every turn can never supply.
          for (const d of frame) settleSignoffNudge(d)
          // …and a Goal run is counted here for the same reason (see countGoalDelivery), and its
          // "last sent" stamp written with this send's instant (see stampGoalSent).
          for (const d of frame) {
            stampGoalSent(d, sentAt)
            countGoalDelivery(d)
          }
          log(`waker: sent ${item.slug} — ${item.reason}; confirming within ${Math.round(confirmGraceMs / 1000)}s`)
          checkpoint("after-delivery", item)
          continue
        }
      }
      // The happy path logs exactly one line, and it CONFIRMS something that already happened. A
      // pre-flight "delivering … (attempt 1)" reads like a retry counter — as if a previous try had
      // failed — on the first-and-only attempt every ordinary wake takes. Attempt counts belong on the
      // failure lines above, where they carry information; here one is worth printing only when the
      // delivery genuinely did take more than one.
      const retried = item.attempts > 1 ? ` (on attempt ${item.attempts})` : ""
      log(`waker: delivered ${item.slug} — ${item.reason}${retried}`)
      checkpoint("after-delivery", item)
      // Each row's ack is guarded on its own lease, so a companion whose lease another process took in
      // the meantime keeps that process's authoritative state, exactly as the carrier does.
      const acked = frame.filter((d) => outbox.acknowledge(d.id, deliveryOwner, now()))
      if (!acked.includes(item)) {
        log(`waker: delivery acknowledgement lost ownership for ${item.slug}; preserving the authoritative terminal state`)
      }
      for (const d of acked) {
        settleDelivered(d)
        settleSignoffNudge(d)
      }
      if (!acked.includes(item)) continue
      const acknowledged = outbox.get(item.id)
      if (acknowledged) checkpoint("after-ack", acknowledged)
    }
  }

  async function runTick(): Promise<void> {
    try {
      await evalLimits(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: limit-resume pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalGoalLimits(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: goal-limit pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSnoozes(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: snooze-bump pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSchedulePrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt schedule pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // THE REMINDER MINTS BEFORE THE GOAL'S REST PASS (2026-08-28): SOURCE 5 stands down on a rest the
    // reminder took, and it reads that off the outbox — so the reminder has to be there first. Before
    // this the two went out in one tick, 5 ms apart, and the second arrived stale (see evalRestPrompts).
    try {
      evalSignoffNudges(now())
      // SOURCE 12, beside the nudge because they are the same job from two directions: the nudge catches
      // a rest that declared NOTHING, this catches one whose declaration stopped being true.
      evalParkIntegrity(now())
      evalStrayShellNudges(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: sign-off nudge pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalRestPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt rest pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalCompactPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt compaction pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await evalPrWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: pr-watch registry pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      // Defaults first, so a question this pass answers on the human's behalf goes out in the same tick.
      evalQuestionDefaults(now())
      evalQuestionAnswers(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: question-answer pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalOwnWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: watch registry pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalCommandWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: command-watch pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalShellCompletions(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: shell-completion pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalTerminalWaits(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: terminal-wait pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await evalShellBudgets(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: shell-budget pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalDeadlines(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: time-limit pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalTimers(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: one-off timer pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalScheduledThreads(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: scheduled-thread pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      repairDroppedReports(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: report-repair pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    reconcileOutbox(now())
    await deliverDue()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.reject(new ProducerStoppedError("wake scheduler"))
    if (activeTick) return activeTick
    const task = runTick()
    activeTick = task
    task.then(
      () => { if (activeTick === task) activeTick = null },
      () => { if (activeTick === task) activeTick = null },
    )
    return task
  }

  const scheduler: Scheduler = {
    start() {
      if (timer) return
      if (stopped) throw new ProducerStoppedError("wake scheduler")
      // Derive current state immediately (arms live waits; boot-safe — never fires on first sight).
      void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, tickMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      const draining = activeTick
      if (draining) await draining
      // A scheduled run launched off the tick settles its run row and materializes the next one when it
      // lands; the storage it writes must still be open, so the launch is awaited here like a tick.
      await deps.scheduledThreads?.drain()
      // A check in flight is killed, group and all, and its result discarded: the row stays armed with
      // its last recorded check, so the next server runs it again on the same cadence.
      for (const run of commandRuns.values()) run.abort.abort()
      await commandRunsIdle()
    },
    tick,
    requestCheckIn(slug, restedAt) {
      checkInRequests.set(slug, restedAt)
      kick()
    },
    kick,
    commandRunsIdle,
  }
  return scheduler
}
