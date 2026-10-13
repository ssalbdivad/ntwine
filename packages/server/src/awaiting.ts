import { threadAwaitKey } from "./thread-mentions.ts"
import { AGENT_PARK_FOR_MAX_MS, AWAITING_FOR_MAX_MS, awaitingNeedsInput, COMMAND_WATCH_FOR_MAX_MS, awaitingQuestions, awaitingSteps, GithubIssueStatus, GithubWatchStatus, isAwaitingItemKind, parseAwaitingDurationRaw, PR_WATCH_FOR_MAX_MS, type AwaitingHint, type AwaitingItemKind } from "@ntwine/shared"

// The PR-reference vocabulary shared by the PR-watching scheduler and the board. It lives here rather
// than in scheduler.ts so a reader can resolve a ref without pulling in the whole waker; scheduler.ts
// re-exports parsePrRef/PrRef for its existing callers and tests.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// Parse a PR reference out of a hint value: `owner/repo#123` or a GitHub PR URL. Undefined when neither
// shape matches (e.g. an actions-run URL with no PR number) → that hint is simply not actionable.
// Deliberately NOT anchored (cf. the strict isValidGithubReviewTarget): a fence hint line legitimately
// carries trailing prose after the ref, and anchoring here would make those hints unparseable.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/

export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = Number.parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}

// The ISSUE twin: `owner/repo#123` or a GitHub issue URL (`/issues/N`). Same owner/repo/number shape
// as a PR ref — GitHub numbers issues and pull requests from one sequence, so the ref alone cannot say
// which it is; only the URL's path segment can, and a `/pull/` URL is refused here exactly as an
// `/issues/` URL is refused by PR_REF_RE. The bare `#N` form is accepted by both, and the registration
// probe (`gh issue view` vs `gh pr view`) is what settles it.
const ISSUE_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/issues\/|#)(\d+)/

export function parseIssueRef(value: string): PrRef | undefined {
  const m = value.trim().match(ISSUE_REF_RE)
  if (!m) return undefined
  const number = Number.parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}

// ---- THE PARK, READ OUT OF A FENCE AND CHECKED ----------------------------------------------------
// One reader for the 2026-08-15 grammar, used by BOTH the scheduler (which bumps) and the board (which
// decides Snoozed), so the two can never disagree about whether a thread is parked.

export interface AwaitingItem {
  kind: AwaitingItemKind
  /** The runtime handle or registry id as the worker wrote it. */
  value: string
}

export interface AwaitingPark {
  items: AwaitingItem[]
  /** `for:` in ms AS WRITTEN, uncapped, or null when it is missing or not a duration. NULL IS NOT A
   *  PARK. Uncapped here because the ceiling depends on what the park NAMES (parkForMaxMs), which this
   *  field alone cannot know — `parkExpiresAt` is the one place it is applied. */
  forMs: number | null
  /** `steps:` — what the HUMAN must perform. Non-empty means the park waits on them, which needs no
   *  item and no `for:`: their reply is the wake (see parkIsHonoured). */
  steps: string[]
  /** `questions:` — the worker's registered questions it is still waiting on, as lowercased ids (see
   *  awaitingQuestions). Like steps, a wait on the HUMAN: their answer is the wake. Whether every open
   *  question is named is checked against the question rows, which only the scheduler has (2026-10-05). */
  questions: string[]
}

/** Read the structural fence. Unknown keys are already dropped by the tailer's parse, so everything
 *  arriving here is an item kind or `for:`.
 *
 *  It used to collect a `reason` too, and nothing ever read it — the field outlived the one caller by
 *  long enough that `reason:` itself was retired underneath it (2026-08-24). Prose belongs to the fence
 *  BODY and is read there; a park is items and a duration. */
export function readAwaitingPark(hints: readonly AwaitingHint[]): AwaitingPark {
  const items: AwaitingItem[] = []
  let forMs: number | null = null
  for (const h of hints) {
    const value = h.value.trim()
    if (isAwaitingItemKind(h.kind)) {
      if (value) items.push({ kind: h.kind, value })
    } else if (h.kind === "for") {
      forMs = parseAwaitingDurationRaw(value)
    }
  }
  return { items, forMs, steps: awaitingSteps(hints), questions: awaitingQuestions(hints) }
}

/** What ntwine can see running for one thread, in the shape the check needs. Every id a fence may name
 *  comes from one of these four sets, and each is authoritative for its own kind. */
export interface LiveActivity {
  /** Every handle a live background shell answers to — its runtime task id, its launch id, its label. */
  shells: ReadonlySet<string>
  /** Same, for live sub-agents. */
  agents: ReadonlySet<string>
  /** Armed timer ids on this thread — and, for each reply wait among them, the `threadAwaitKey` of the
   *  thread it waits on (thread-mentions.armedTimerKeys), which is what a `threads:` entry is checked
   *  against: a reply wait IS a timer. */
  timers: ReadonlySet<string>
  /** Registered PR watcher refs on this thread, normalized (`owner/repo#N`). */
  prs: ReadonlySet<string>
  /** Registered ISSUE watcher refs on this thread, normalized the same way. Optional only so a caller
   *  written before issues existed still type-checks; absent reads as "none registered", which makes
   *  an `issues:` entry unaccounted — the safe direction. */
  issues?: ReadonlySet<string>
  /** Armed COMMAND WATCH ids on this thread (`cmw_…`, 2026-10-11). Optional for the reason `issues` is:
   *  absent reads as "none armed", which makes a `commands:` entry unaccounted — the safe direction. */
  commands?: ReadonlySet<string>
}

const LIVE_SET: Record<AwaitingItemKind, keyof LiveActivity> = {
  shell: "shells", agent: "agents", timer: "timers", pr: "prs", issue: "issues", thread: "timers", command: "commands",
}

/** One shell or sub-agent as the fold reports it — the handles it answers to and whether it still runs. */
interface LiveHandleRow {
  state: string
  id?: string
  taskId?: string
  label?: string
}

/** What ntwine can actually see running for this thread, in the shape `unaccountedItems` checks against.
 *  Here rather than in the scheduler since 2026-10-01, because the BOARD reads it too: a
 *  `status: working`/`watching` park keeps its thread out of the queue only while it is honoured, and the board
 *  and the scheduler's integrity pass must agree on what "honoured" means (needsInputParkHolds).
 *
 *  A shell and a sub-agent each answer to THREE handles, because the fence names whichever string the
 *  worker was shown: the runtime id it was handed ("Command running in background with ID: bzvtnt3ig";
 *  "agentId: a01b2d20b32feab11" in the Agent launch ack), the launch tool_use id, or the label it reads
 *  back in its own transcript. The runtime id is the one a worker actually has — the tool_use id never
 *  appears in its context — and until 2026-08-28 a sub-agent answered to only the latter two, so a
 *  worker that named the id it was handed was bumped "nothing by that name", then re-fenced with the id
 *  the correction printed and asked why there were two. Refusing a
 *  correct-but-label-shaped name would make the fence unusable for the case it exists for. */
export function liveActivityOf(
  tele: { bgShells?: readonly LiveHandleRow[]; subAgents?: readonly LiveHandleRow[] } | undefined,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
  registeredIssueWatches: ReadonlySet<string> = new Set(),
  armedCommandWatches: ReadonlySet<string> = new Set(),
): LiveActivity {
  const shells = new Set<string>()
  for (const sh of tele?.bgShells ?? []) {
    if (sh.state !== "running") continue
    for (const h of [sh.taskId, sh.id, sh.label]) if (h) shells.add(h)
  }
  const agents = new Set<string>()
  for (const a of tele?.subAgents ?? []) {
    if (a.state !== "running") continue
    for (const h of [a.taskId, a.id, a.label]) if (h) agents.add(h)
  }
  return { shells, agents, timers: armedTimerIds, prs: registeredPrWatches, issues: registeredIssueWatches, commands: armedCommandWatches }
}

/** The items this fence names that ntwine CANNOT account for — dead, unknown, or another thread's.
 *
 *  This is the whole safety property of the grammar. A park is honoured only when this comes back empty;
 *  anything in it means the worker declared a wait that cannot resolve, and gets bumped rather than
 *  parked. Three separate stalls in one day came from the old grammar having no equivalent (see the
 *  AwaitingHint doc block in @ntwine/shared). */
export function unaccountedItems(items: readonly AwaitingItem[], live: LiveActivity): AwaitingItem[] {
  return items.filter((i) => !live[LIVE_SET[i.kind]]?.has(liveKey(i)))
}

/** The value to test against the live set. A PR is a kind whose registry key is NORMALIZED
 *  (`owner/repo#N` — registeredPrWatchesOf) while the fence holds whatever the worker wrote, and
 *  `watch_pr` itself advertises "owner/repo#123 or a PR URL". A raw string match called a registered
 *  PR named by URL unaccounted, so the worker was bumped "NOT REGISTERED", re-registered (idempotent),
 *  re-fenced the same spelling, and went round again. Every other kind's id is minted by ntwine and
 *  matches byte-for-byte or not at all. */
function liveKey(i: AwaitingItem): string {
  if (i.kind === "pr") {
    const ref = parsePrRef(i.value)
    return ref ? githubStatusKey(ref) : i.value
  }
  if (i.kind === "issue") {
    const ref = parseIssueRef(i.value)
    return ref ? githubStatusKey(ref) : i.value
  }
  // A thread is named by its `@handle` (or its slug), folded as every handle is.
  if (i.kind === "thread") return threadAwaitKey(i.value)
  return i.value
}

/** Is this a park ntwine will honour — at least one item, every item live, and a usable `for:`?
 *
 *  AT LEAST ONE ITEM is not pedantry. An awaiting fence naming nothing is a worker claiming to wait with
 *  no way to be woken, which is precisely the silent stall the grammar exists to make impossible.
 *
 *  STEPS ARE THE ONE WAIT THAT NEEDS NEITHER (2026-10-03). A fence listing `steps:` waits on the HUMAN,
 *  and the human is the one party ntwine never has to watch: the thread sits in their queue
 *  (awaitingNeedsInput reads steps as `true`), and their reply — the card's Done, or anything they
 *  type — is itself the wake. Any item named beside the steps must still be live, and a
 *  `for:` beside them still runs out (parkExpiresAt), as a re-check the worker asked for.
 *
 *  QUESTIONS ARE THE SAME WAIT (2026-10-05): `questions:` names registered questions the worker still
 *  needs answered, and the answer is the wake. That every open question is named is the scheduler's
 *  check (evalParkIntegrity), not this one's — it needs the question rows. */
export function parkIsHonoured(park: AwaitingPark, live: LiveActivity): boolean {
  const onHuman = parkOnHuman(park)
  if (park.items.length === 0 && !onHuman) return false
  if (park.forMs === null && !onHuman) return false
  return unaccountedItems(park.items, live).length === 0
}

/** Does the park wait on the HUMAN — steps to perform, or questions to answer? Either needs no item and
 *  no `for:`, because the human's reply is the wake and the thread sits in their queue meanwhile. */
export function parkOnHuman(park: AwaitingPark): boolean {
  return park.steps.length > 0 || park.questions.length > 0
}

/** Does this fence keep a NEW-CONTRACT thread out of the queue (see `needsInputRequired` in
 *  @ntwine/shared)? The worker answered `status: working` or `status: watching` (or the older
 *  `needs_input: false`), and the park is one ntwine can honour and has not run out. Anything less —
 *  `needs_input`, no answer, a dead name, an elapsed `for:` — and the thread queues, which is the safe
 *  direction: a wrong answer must never be a way to disappear. Which band it sits in once out of the
 *  queue is board.deriveWaitStatus's call, not this one's.
 *
 *  `fenceAtMs` is when the fence landed (the worker's last word). An unknown instant does NOT hold —
 *  without it there is no `for:` to run out, and a park that cannot run out is the stall this grammar
 *  was built to make impossible. */
export function needsInputParkHolds(hints: readonly AwaitingHint[], live: LiveActivity, fenceAtMs: number, nowMs: number): boolean {
  if (awaitingNeedsInput(hints) !== false) return false
  const park = readAwaitingPark(hints)
  if (!parkIsHonoured(park, live)) return false
  const expiresAt = parkExpiresAt(park, fenceAtMs)
  return expiresAt !== null && nowMs < expiresAt
}

/** The ceiling this park's `for:` may reach, which depends on WHAT IT NAMES.
 *
 *  A park is one sentence about every item in it, so it can only be as long as its shortest-lived kind:
 *  a shell or a sub-agent dies with the session, and a day is already generous for one. A park naming
 *  nothing but PULL REQUESTS is a different object — an external PR sits unreviewed for as long as its
 *  maintainers take — and capping that one at a day is what woke a thread daily for four days against a
 *  PR nobody had touched. Mixed ⇒ the low ceiling, because the shell in the list is still a shell.
 *
 *  A SUB-AGENT anywhere in the list caps it at 30 minutes: that wake is the parent's check-in on its
 *  children, not a timeout (AGENT_PARK_FOR_MAX_MS). */
export function parkForMaxMs(park: AwaitingPark): number {
  // Steps or questions alone move on the HUMAN's clock, which is no more a day's than a maintainer's
  // review is.
  if (park.items.length === 0) return parkOnHuman(park) ? PR_WATCH_FOR_MAX_MS : AWAITING_FOR_MAX_MS
  if (park.items.some((i) => i.kind === "agent")) return AGENT_PARK_FOR_MAX_MS
  // An issue earns the PR's ceiling for the PR's reason: it sits on its maintainers' clock too.
  if (park.items.every((i) => i.kind === "pr" || i.kind === "issue")) return PR_WATCH_FOR_MAX_MS
  // A COMMAND WATCH earns its own registration's ceiling, a week (2026-10-11): it is a server-run check
  // with its own `for`, not a process of the session's, so the day a shell gets is the wrong clock for
  // it — a park on an npm version stuck in review would be bumped daily for a wait that is healthy. A
  // park mixing it with PRs or issues takes the week too, the shorter of the two.
  if (park.items.every((i) => i.kind === "command" || i.kind === "pr" || i.kind === "issue")) return COMMAND_WATCH_FOR_MAX_MS
  return AWAITING_FOR_MAX_MS
}

/** When a park that landed at `fenceAtMs` runs out. Capped by `parkForMaxMs`, so this cannot return an
 *  instant beyond the ceiling the park's own items earn. */
export function parkExpiresAt(park: AwaitingPark, fenceAtMs: number): number | null {
  if (park.forMs === null || !Number.isFinite(fenceAtMs)) return null
  return fenceAtMs + Math.min(park.forMs, parkForMaxMs(park))
}

// ---- THE WATCHED-PR STATUS BOOK -------------------------------------------------------------------
// One reading per PR, published by the scheduler's poller and read by the board. It lives in a setting
// rather than a table because it is a pure CACHE of GitHub's own answer: every entry is replaceable,
// nothing reconciles against it, and an entry for a PR nobody watches any more is a few stale bytes.
//
// The KEY and the parser live here, beside `parsePrRef`, so the board can read the book without pulling
// in the whole waker — the same reason `parsePrRef` moved here in the first place.
export const GITHUB_STATUS_SETTING = "waker.github.status.v1"

export type GithubStatusBook = Record<string, GithubWatchStatus>

/** The book as stored, validated entry by entry. A malformed entry is DROPPED rather than failing the
 *  whole read: this decides a queue rule, and one bad row must not take a whole board's worth of PR
 *  status with it. An older ntwine's book simply reads as fewer entries. */
export function readGithubStatusBook(raw: unknown): GithubStatusBook {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: GithubStatusBook = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = GithubWatchStatus.safeParse(value)
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

/** The book's key for a ref — the same `owner/repo#N` string the fence's watch row is targeted by, so
 *  the card, the queue rule and the poller all name one PR one way. */
export function githubStatusKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

// ---- THE WATCHED-ISSUE STATUS BOOK ----------------------------------------------------------------
// The issue twin of the PR book above: its own setting, because the two entries have different shapes
// and `readGithubStatusBook` validates every entry against the PR one — an issue reading in that book
// would be dropped as malformed. Keyed by the same `owner/repo#N`; a PR and an issue never share a
// number in one repo, and even if a worker registered #7 both ways, each book only ever holds its own.
export const GITHUB_ISSUE_STATUS_SETTING = "waker.github.issue.status.v1"

export type GithubIssueStatusBook = Record<string, GithubIssueStatus>

export function readGithubIssueStatusBook(raw: unknown): GithubIssueStatusBook {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: GithubIssueStatusBook = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = GithubIssueStatus.safeParse(value)
    if (parsed.success) out[key] = parsed.data
  }
  return out
}
