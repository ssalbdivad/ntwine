import { randomBytes, randomUUID } from "node:crypto"
import {
  SCHEDULES_PER_PROJECT_MAX,
  SCHEDULE_CAP_COPY,
  SCHEDULE_FAILURES_MAX,
  SCHEDULE_HISTORY_MAX,
  SCHEDULE_OVERLAPS_MAX,
  SCHEDULE_UNREVIEWED_MAX,
  compileSchedule,
  echoOf,
  isActivelyRunning,
  isValidTimeZone,
  occurrencesAfter,
  occurrencesBetween,
  scheduleEcho,
  scheduledRunHeader,
  scheduledRunPrompt,
  threadHandle,
  wallToInstant,
  formatLateness,
  formatOccurrence,
  type CompiledSchedule,
  type CreateScheduleInput,
  type GetScheduleResult,
  type OwnScheduleInput,
  type OwnScheduleResult,
  type ProjectSchedules,
  type ScheduleEcho,
  type ScheduleRunView,
  type ScheduleView,
  type ThreadScheduleRef,
  type ThreadView,
  type UpdateScheduleInput,
} from "@ntwine/shared"
import type { AwakeClock } from "./awake-clock.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import type { Dispatcher } from "./dispatch.ts"
import { homeWorkspaceSlug, isHomeWorkspace } from "./home-workspace.ts"
import type { HeldStartProfile, HeldThreadStarter } from "./held-start.ts"
import type { Project } from "./project.ts"
import { findByPath } from "./project-registry.ts"
import type { ThreadScheduleRow, ThreadScheduleRunRow } from "./schedule-store.ts"
import { isHeldRow, isScheduleHeldRow, SCHEDULES_HOLDER, type SessionRow, type Storage } from "./storage.ts"
import { threadNameProblem } from "./thread-names.ts"

// ---- SCHEDULED THREADS: THE SERVER HALF ------------------------------------------------------------------
// ARCHITECTURE.md § Scheduled threads is the design; this module is all of it that is not storage, the RPC surface
// or the interpreter's model call (schedule-interpreter.ts):
//
//   · create / validate / echo, the per-project cap, update, pause / resume / Turn on, delete, Run now;
//   · the materialized next run — ONE held thread per active schedule (held by `schedules`, SessionRow.held_by),
//     snoozed until its occurrence, so
//     the upcoming run sits in the Snoozed band where the human already looks and every per-occurrence act
//     (skip = Mark as done, move = snooze, run now = send, edit = its note) is one they already know (§4);
//   · the scheduler pass, `evalDue` (§6): reconcile the human's acts on the next run, claim an occurrence
//     synchronously with the revision guard, launch it OFF the tick, settle a dead process's claims, cap
//     lateness, skip on overlap, pause on back-pressure / failures / a stuck run, resume on review;
//   · every start of a held row, whoever makes it — so a schedule's run the HUMAN sends early still opens
//     with the run header and still lands in the history (`startHeldRow`).

/** The owner stamped on a `starting` claim. ONE per process: the global lease means one Ntwine process
 *  per machine, so a claim whose owner is not this value was cut off by a process that is gone. */
export const SCHEDULE_PROCESS_OWNER = randomUUID()

/** After a (re)start, nothing fires until this has passed: the tailer must vouch for the previous run's
 *  state before an overlap check can be trusted, and an overdue run must not fire on first sight. */
export const SCHEDULE_POST_BOOT_GRACE_MS = 60_000
/** The ceiling on how late an occurrence may still run. */
export const SCHEDULE_LATE_CAP_MS = 12 * 3_600_000
/** Lateness below this is a slow tick, not worth a line in the header. */
const LATE_MENTION_MS = 2 * 60_000
/** Wall time the awake clock must be short by before a late run blames sleep. */
const SLEEP_SLACK_MS = 60_000
/** A moved next run must start at least this far ahead. */
const MOVE_MIN_LEAD_MS = 60_000

/** At most this many scheduled starts in flight at once, across every project (a Monday 9:00 with five
 *  schedules would otherwise start five agents in the same second). The rest go a tick late, not skipped. */
export interface StartCap {
  acquire(): boolean
  release(): void
  inFlight(): number
}

export function createStartCap(limit: number): StartCap {
  let n = 0
  return {
    acquire: () => (n < limit ? (n++, true) : false),
    release: () => { n = Math.max(0, n - 1) },
    inFlight: () => n,
  }
}

/** The machine-wide cap. Module state on purpose: one process serves every project on the machine. */
export const MACHINE_START_CAP = createStartCap(2)

export interface ScheduleServiceDeps {
  project: Project
  storage: Storage
  dispatcher: Pick<Dispatcher, "createHeldThread">
  starter: HeldThreadStarter
  board?: { refresh(): unknown }
  /** The project's open thread already carrying `name` (thread-names.ts) — what numbers a run's title. */
  nameHolder?: (name: string, exceptSlug?: string) => unknown
  /** The board's reading of a thread and whether the tailer vouches for it — the overlap check's input.
   *  Never raw telemetry: a dead daemon's row reads `turn: "in-flight"` forever (board.ts deriveRuntime). */
  threadView?: (slug: string) => { view?: ThreadView; vouched: boolean }
  /** The zone the human's browser last reported (reportClientZone). */
  clientZone?: () => string | undefined
  setClientZone?: (tz: string) => void
  now?: () => number
  owner?: string
  awake?: Pick<AwakeClock, "awakeBetween">
  /** When this process started serving the project — the post-boot grace and "Ntwine was off". */
  bootAtMs?: number
  postBootGraceMs?: number
  startCap?: StartCap
  log?: (message: string) => void
  /** The THREAD NAMER's `name` (thread-names.ts): one or two words for `source` from the model, held to
   *  the project's open-thread names other than `exceptSlug`. What renames a `titleAuto` create. Absent
   *  (NTWINE_THREAD_NAMER=0, or no model) ⇒ such a schedule keeps its provisional
   *  title. Read at each save, so the setting takes effect without a restart. */
  nameFor?: (source: string, exceptSlug?: string) => Promise<string>
}

export interface ScheduleService {
  list(): ScheduleView[]
  get(id: string): GetScheduleResult
  /** The project row's count, or undefined when there are none. */
  summary(): ProjectSchedules | undefined
  /** The repeat glyph's data for a thread row (board.ts). */
  threadRef(row: SessionRow): ThreadScheduleRef | undefined
  /** The zone new schedules default to: the browser's last report, else the server's. */
  defaultZone(): string
  reportClientZone(tz: string): void
  create(input: CreateScheduleInput, createdBy?: string): ScheduleView
  update(input: UpdateScheduleInput): ScheduleView
  /** Turn on a proposal, resume, or pause (by the human). */
  setState(id: string, state: "active" | "paused"): ScheduleView
  runNow(id: string): Promise<{ slug: string; sessionId: string }>
  remove(id: string): void
  /** The worker's `schedule` tool. */
  own(input: OwnScheduleInput): OwnScheduleResult
  /** Start a held row, whoever asks: a schedule's next run gets its header and its history line. */
  startHeldRow(row: SessionRow, prompt: string, profile?: HeldStartProfile): Promise<{ slug: string; sessionId: string }>
  /** `done` with `quiet: true` — refuses on a thread that is not a run of a schedule. */
  quietDone(slug: string, body: string): void
  /** The scheduler pass (scheduler.ts runTick). Synchronous: launches run off the tick. */
  evalDue(nowMs: number): void
  /** Resolves once every launch this service started has settled. scheduler.stop() awaits it. */
  drain(): Promise<void>
}

const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
const iso = (ms: number) => new Date(ms).toISOString()
const newScheduleId = () => `sch_${randomBytes(6).toString("hex")}`
const newRunId = () => `run_${randomBytes(8).toString("hex")}`

/** Why a start failed, in the words the history shows after "Didn't start:". */
export function scheduleStartFailure(error: unknown): string {
  if (error instanceof ProviderAuthRequiredError) return `${error.backend === "codex" ? "Codex" : "Claude"} is signed out`
  const message = error instanceof Error ? error.message : String(error)
  if (/AUTH_REQUIRED:codex/.test(message)) return "Codex is signed out"
  if (/AUTH_REQUIRED/.test(message)) return "Claude is signed out"
  if (/ENOENT|no such file or directory/i.test(message)) return "the project folder is missing"
  const line = message.split("\n")[0]!.trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || "the agent could not start"
}

function titleProblem(title: string): string | undefined {
  const problem = threadNameProblem(title.trim())
  return problem ? `The title "${title.trim()}" ${problem}. Use one or two short words, like "Triage issues".` : undefined
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const { storage, starter } = deps
  const now = deps.now ?? Date.now
  const owner = deps.owner ?? SCHEDULE_PROCESS_OWNER
  const bootAtMs = deps.bootAtMs ?? now()
  const graceMs = deps.postBootGraceMs ?? SCHEDULE_POST_BOOT_GRACE_MS
  const startCap = deps.startCap ?? MACHINE_START_CAP
  const log = deps.log ?? (() => {})
  const inFlight = new Set<Promise<void>>()
  const refresh = () => { try { deps.board?.refresh() } catch { /* a board mid-teardown */ } }

  const viewerZone = () => {
    const tz = deps.clientZone?.()
    return tz && isValidTimeZone(tz) ? tz : serverZone()
  }

  // ---- reading a stored schedule -------------------------------------------------------------------

  function compiledOf(sch: Pick<ThreadScheduleRow, "rrule" | "dtstart" | "tz">): CompiledSchedule | undefined {
    const c = compileSchedule({ rrule: sch.rrule, dtstart: sch.dtstart, tz: sch.tz })
    return c.ok ? c.value : undefined
  }

  // The echo is memoized per schedule revision, zone and minute: the engine's spacing check walks 60
  // occurrences (~14ms for a weekly rule), and a list of 25 schedules is read on every drawer open.
  const echoMemo = new Map<string, { key: string; echo: ScheduleEcho }>()

  /** The echo of a stored schedule, from now (or its last consumed occurrence, if later). */
  function echoNow(sch: ThreadScheduleRow, nowMs: number): ScheduleEcho {
    const from = Math.max(nowMs, sch.last_occurrence_at ?? -Infinity)
    const key = `${sch.revision}|${Math.floor(from / 60_000)}|${viewerZone()}`
    const memo = echoMemo.get(sch.id)
    if (memo?.key === key) return memo.echo
    const echo = computeEcho(sch, from)
    echoMemo.set(sch.id, { key, echo })
    return echo
  }

  function computeEcho(sch: ThreadScheduleRow, from: number): ScheduleEcho {
    const checked = scheduleEcho({ title: sch.title, rrule: sch.rrule, dtstart: sch.dtstart, tz: sch.tz, condition: sch.condition }, from, viewerZone())
    if (checked.ok) {
      const { compiled: _c, ...echo } = checked.value
      return echo
    }
    // A rule that never fires again (ended) still has words.
    const compiled = compiledOf(sch)
    if (compiled) return echoOf(sch, compiled, [], undefined, viewerZone())
    return { describe: sch.rrule, echo: `${sch.title} · ${sch.rrule}`, nextLine: "", upcoming: [] }
  }

  // The repeat glyph is drawn for every run row on every board assemble, so its data is cached until a
  // schedule is written (the scope's per-table write counter — project-scope.ts) or the zone changes.
  let refCache: { key: string; byId: Map<string, { title: string; describe: string; nextSlug: string | null }> } | undefined
  function refsById() {
    const key = `${storage.scope.writes("thread_schedule")}|${viewerZone()}`
    if (refCache?.key === key) return refCache.byId
    const byId = new Map<string, { title: string; describe: string; nextSlug: string | null }>()
    for (const sch of storage.listSchedules()) {
      const compiled = compiledOf(sch)
      const describe = compiled ? echoOf(sch, compiled, [], undefined, viewerZone()).describe : sch.when_text
      byId.set(sch.id, { title: sch.title, describe, nextSlug: sch.next_slug })
    }
    refCache = { key, byId }
    return byId
  }

  function numberedTitle(title: string): string {
    const clean = title.trim()
    const holder = deps.nameHolder
    if (!holder || !holder(clean)) return clean
    for (let n = 2; ; n++) {
      const candidate = `${clean} ${n}`
      if (!holder(candidate)) return candidate
    }
  }

  // ---- writing ------------------------------------------------------------------------------------------

  /** Read-modify-write under the revision guard, retried on a lost race. `change` may throw to refuse. */
  function mutate(id: string, change: (sch: ThreadScheduleRow) => ThreadScheduleRow | undefined): ThreadScheduleRow | undefined {
    for (let attempt = 0; attempt < 5; attempt++) {
      const sch = storage.getSchedule(id)
      if (!sch) return undefined
      const next = change(sch)
      if (!next) return sch
      if (storage.writeSchedule(next, sch.revision, now())) return storage.getSchedule(id)
    }
    throw new Error("This schedule kept changing while Ntwine wrote it. Try again.")
  }

  function requireSchedule(id: string): ThreadScheduleRow {
    const sch = storage.getSchedule(id)
    if (!sch) throw new Error("That schedule no longer exists.")
    return sch
  }

  /** The schedule's pending next run, when it still is one: a held row of THIS schedule that is not
   *  starting and not filed under Done. */
  function pendingRow(sch: ThreadScheduleRow): SessionRow | undefined {
    if (!sch.next_slug) return undefined
    const row = storage.getSession(sch.next_slug)
    if (!row || !isScheduleHeldRow(row) || row.schedule_id !== sch.id) return undefined
    if (row.state === "archived" || row.archived === 1) return undefined
    return row
  }

  /** Remove the pending next run (a pause, a delete, an end). It is a note nobody has started: nothing
   *  runs, nothing is lost. A row mid-launch is left alone — it becomes an ordinary run. */
  function dropPending(sch: ThreadScheduleRow): void {
    const row = pendingRow(sch)
    if (row && !starter.isStarting(row.slug)) storage.forgetSession(row.slug)
  }

  /**
   * Point the schedule at its next occurrence: the first one after max(now, every occurrence it has
   * consumed). The pending held row is REUSED when there is one (a skip, a failed start, a rule change),
   * re-snoozed to the new instant; otherwise a fresh one is written. A rule with no next occurrence ends.
   *
   * `at` points it at one occurrence the caller already chose instead — the overdue catch-up in evalOne,
   * which may be in the past. Only ever FORWARD of everything consumed: an `at` at or before that is
   * ignored, so the never-twice record cannot be walked back.
   */
  function materialize(id: string, nowMs: number, consumed?: number, at?: number): ThreadScheduleRow | undefined {
    for (let attempt = 0; attempt < 5; attempt++) {
      const sch = storage.getSchedule(id)
      if (!sch || sch.state !== "active") return sch
      const last = consumed === undefined ? sch.last_occurrence_at : Math.max(sch.last_occurrence_at ?? consumed, consumed)
      const compiled = compiledOf(sch)
      const [next] = at !== undefined && at > (last ?? -Infinity) ? [at]
        : compiled ? occurrencesAfter(compiled, Math.max(nowMs, last ?? -Infinity), 1) : []
      const reuse = pendingRow(sch)
      if (next === undefined) {
        if (reuse && !starter.isStarting(reuse.slug)) storage.forgetSession(reuse.slug)
        if (storage.writeSchedule({ ...sch, state: "ended", paused_reason: null, next_slug: null, next_occurrence_at: null, last_occurrence_at: last }, sch.revision, nowMs)) {
          refresh()
          return storage.getSchedule(id)
        }
        continue
      }
      let slug: string
      let created = false
      if (reuse && !starter.isStarting(reuse.slug)) {
        slug = reuse.slug
        if (reuse.snoozed_until !== iso(next)) storage.setSnoozedUntil(slug, iso(next), null)
        // When an occurrence was CONSUMED (a skip, a failed start), the note a human edited was for the
        // occurrence that just went, so the next one starts from the schedule's prompt again. When nothing
        // was consumed — an edit re-pointing the same pending run at a new rule — the note is still for
        // this run and stays (§6 "Edits": "keeping a per-run prompt edit the human made").
        if (consumed !== undefined && reuse.lazy_prompt !== sch.prompt) storage.setHeldPrompt(slug, reuse.session_id, sch.prompt)
      } else {
        const made = deps.dispatcher.createHeldThread(
          {
            prompt: sch.prompt,
            ...(sch.model ? { model: sch.model } : {}),
            ...(sch.effort ? { effort: sch.effort as CreateScheduleInput["effort"] } : {}),
            backend: sch.backend === "codex" || sch.backend === "acp" ? sch.backend : "claude",
          },
          { holder: SCHEDULES_HOLDER, scheduleRun: { scheduleId: sch.id, snoozedUntil: iso(next), title: numberedTitle(sch.title) } },
        )
        slug = made.slug
        created = true
      }
      if (storage.writeSchedule({ ...sch, next_slug: slug, next_occurrence_at: next, last_occurrence_at: last }, sch.revision, nowMs)) {
        refresh()
        return storage.getSchedule(id)
      }
      // Someone wrote the schedule between the read and this write. A row made for the stale read is
      // removed rather than left to queue as an orphan; the loop reads again.
      if (created) storage.forgetSession(slug)
    }
    return storage.getSchedule(id)
  }

  function record(sch: ThreadScheduleRow, occurrenceAt: number, state: "skipped" | "failed" | "started", reason: string | null, extra: Partial<ThreadScheduleRunRow> = {}): void {
    storage.insertScheduleRun({
      id: newRunId(),
      schedule_id: sch.id,
      occurrence_at: occurrenceAt,
      started_at: extra.started_at ?? null,
      state,
      reason,
      thread_slug: extra.thread_slug ?? null,
      session_id: extra.session_id ?? null,
      owner: null,
      created_at: now(),
    })
    storage.pruneScheduleRuns(sch.id, SCHEDULE_HISTORY_MAX)
  }

  // ---- back-pressure and the previous run -------------------------------------------------------------

  /** Started runs whose thread still exists and is not marked done. A deleted thread counts as reviewed;
   *  a run parked on CI counts as unreviewed (it is still open). */
  function unreviewed(sch: ThreadScheduleRow): number {
    let n = 0
    for (const run of storage.listScheduleRuns(sch.id, 60)) {
      if (run.state !== "started" || !run.thread_slug) continue
      const row = storage.getSession(run.thread_slug)
      if (row && row.session_id === run.session_id && !isHeldRow(row) && row.state !== "archived" && row.archived !== 1) n++
    }
    return n
  }

  function previousRun(sch: ThreadScheduleRow): ThreadScheduleRunRow | undefined {
    return storage.listScheduleRuns(sch.id, 20).find((run) => run.state === "started" && run.thread_slug)
  }

  function pause(id: string, reason: "human" | "review" | "failures" | "stuck"): ThreadScheduleRow | undefined {
    const sch = storage.getSchedule(id)
    if (sch) dropPending(sch)
    const after = mutate(id, (s) => (s.state === "paused" && s.paused_reason === reason) ? undefined : {
      ...s, state: "paused", paused_reason: reason, next_slug: null, next_occurrence_at: null,
    })
    refresh()
    return after
  }

  /** Turn on or resume. Never catches up: the next run is the first occurrence after now. */
  function activate(id: string, nowMs: number): ThreadScheduleRow | undefined {
    mutate(id, (s) => s.state === "active" ? undefined : {
      ...s, state: "active", paused_reason: null, consecutive_failures: 0, consecutive_overlaps: 0, next_slug: null, next_occurrence_at: null,
    })
    return materialize(id, nowMs)
  }

  // ---- the run header -------------------------------------------------------------------------------

  function header(sch: ThreadScheduleRow, occurrenceAt: number, opts: { lateMs?: number; dueAt?: number; byHuman?: boolean }): string {
    const compiled = compiledOf(sch)
    const describe = compiled ? echoOf(sch, compiled, [], undefined, undefined).describe : sch.when_text
    const prev = previousRun(sch)
    const prevRow = prev?.thread_slug ? storage.getSession(prev.thread_slug) : undefined
    let late: { ms: number; cause?: "off" | "asleep" } | undefined
    if (!opts.byHuman && opts.lateMs !== undefined && opts.lateMs >= LATE_MENTION_MS && opts.dueAt !== undefined) {
      const nowMs = opts.dueAt + opts.lateMs
      const asleep = deps.awake ? deps.awake.awakeBetween(opts.dueAt, nowMs) < opts.lateMs - SLEEP_SLACK_MS : false
      late = { ms: opts.lateMs, ...(opts.dueAt < bootAtMs ? { cause: "off" as const } : asleep ? { cause: "asleep" as const } : {}) }
    }
    return scheduledRunHeader({
      scheduleId: sch.id,
      title: sch.title,
      describe,
      condition: sch.condition,
      occurrenceAt,
      tz: sch.tz,
      ...(late ? { late } : {}),
      ...(prev?.thread_slug ? { previous: { title: prevRow?.title ?? null, slug: prev.thread_slug, at: prev.occurrence_at } } : {}),
      ...(opts.byHuman ? { byHuman: true } : {}),
    })
  }

  // ---- starts ------------------------------------------------------------------------------------------

  /** After a run of this schedule's occurrence started or failed: counters, the failure pause, and the
   *  next run. */
  function afterStart(id: string, occurrenceAt: number, ok: boolean): void {
    const nowMs = now()
    const sch = mutate(id, (s) => ok
      ? (s.consecutive_failures === 0 && s.consecutive_overlaps === 0 ? undefined : { ...s, consecutive_failures: 0, consecutive_overlaps: 0 })
      : { ...s, consecutive_failures: s.consecutive_failures + 1 })
    if (!sch) return
    if (!ok && sch.consecutive_failures >= SCHEDULE_FAILURES_MAX) {
      pause(id, "failures")
      return
    }
    // Only a schedule still pointing at this occurrence moves on; an edit or a pause meanwhile has already
    // decided what comes next.
    if (sch.state === "active" && sch.next_occurrence_at === occurrenceAt) materialize(id, nowMs, occurrenceAt)
    else if (sch.state === "active" && !sch.next_slug) materialize(id, nowMs)
  }

  /** A human start of the pending next run (send, Wake now, Run now): this occurrence, run now. */
  async function humanStart(sch: ThreadScheduleRow, row: SessionRow, prompt: string, profile: HeldStartProfile = {}): Promise<{ slug: string; sessionId: string }> {
    if (starter.isStarting(row.slug)) throw new Error("This run is already starting")
    const occurrenceAt = sch.next_occurrence_at ?? now()
    const nowMs = now()
    const runId = newRunId()
    const claimed = storage.claimScheduleRun({
      id: runId, schedule_id: sch.id, occurrence_at: occurrenceAt, started_at: null, state: "starting", reason: null,
      thread_slug: row.slug, session_id: row.session_id, owner, created_at: nowMs,
    }, sch.revision, nowMs)
    if (!claimed) {
      if (storage.scheduleRunAt(sch.id, occurrenceAt)) throw new Error("This run has already started")
      throw new Error("The schedule changed just now. Try again.")
    }
    const dueAt = row.snoozed_until ? Date.parse(row.snoozed_until) : occurrenceAt
    const text = scheduledRunPrompt(header(sch, occurrenceAt, { byHuman: nowMs < dueAt }), prompt)
    let started: { slug: string; sessionId: string }
    try {
      started = await starter.start(row, text, profile)
    } catch (error) {
      // A failed launch leaves the held row untouched (held-start.ts), and the occurrence with
      // it: the claim goes, so the scheduler can still start this run at its time.
      storage.dropScheduleRunClaim(runId)
      throw error
    }
    storage.settleScheduleRun(runId, { state: "started", startedAt: now(), reason: "started by you", threadSlug: started.slug, sessionId: started.sessionId })
    afterStart(sch.id, occurrenceAt, true)
    refresh()
    return started
  }

  /** Run now on a schedule with no pending next run (paused, a proposal, ended): a one-off run that
   *  consumes no occurrence. */
  async function manualRun(sch: ThreadScheduleRow): Promise<{ slug: string; sessionId: string }> {
    const nowMs = now()
    const made = deps.dispatcher.createHeldThread(
      {
        prompt: sch.prompt,
        ...(sch.model ? { model: sch.model } : {}),
        ...(sch.effort ? { effort: sch.effort as CreateScheduleInput["effort"] } : {}),
        backend: sch.backend === "codex" || sch.backend === "acp" ? sch.backend : "claude",
      },
      { holder: SCHEDULES_HOLDER, scheduleRun: { scheduleId: sch.id, snoozedUntil: null, title: numberedTitle(sch.title) } },
    )
    const row = storage.getSession(made.slug)
    if (!row) throw new Error("Ntwine could not write this run down")
    const runId = newRunId()
    storage.insertScheduleRun({
      id: runId, schedule_id: sch.id, occurrence_at: nowMs, started_at: null, state: "starting", reason: null,
      thread_slug: row.slug, session_id: row.session_id, owner, created_at: nowMs,
    })
    let started: { slug: string; sessionId: string }
    try {
      started = await starter.start(row, scheduledRunPrompt(header(sch, nowMs, { byHuman: true }), sch.prompt))
    } catch (error) {
      storage.dropScheduleRunClaim(runId)
      storage.forgetSession(made.slug)
      throw error
    }
    storage.settleScheduleRun(runId, { state: "started", startedAt: now(), reason: "started by you", threadSlug: started.slug, sessionId: started.sessionId })
    refresh()
    return started
  }

  // ---- the scheduler pass ----------------------------------------------------------------------------

  /** A claim left `starting` by a process that is gone (the global lease means a different owner is a
   *  dead one). Its thread tells what happened: no longer held means the start got through. */
  function settleOrphanClaims(): void {
    for (const run of storage.startingScheduleRuns()) {
      if (run.owner === owner) continue
      const row = run.thread_slug ? storage.getSession(run.thread_slug) : undefined
      const started = row !== undefined && row.session_id === run.session_id && !isHeldRow(row)
      storage.settleScheduleRun(run.id, started
        ? { state: "started", startedAt: run.created_at }
        : { state: "failed", reason: "Ntwine stopped" })
      // A hard kill can land after the daemon took the prompt but before the row stopped being held, so
      // that session id may have a live worker behind it. Never hand it to the next occurrence: drop the
      // held row and let the pass write the next run down under a fresh session id.
      if (!started && row && row.session_id === run.session_id && isHeldRow(row)) storage.forgetSession(row.slug)
      log(`schedule ${run.schedule_id}: settled a claim from a stopped process as ${started ? "started" : "failed"}`)
    }
  }

  /** How late an occurrence may still run: half the gap to the one after it, capped at 12h (12h when
   *  there is none). */
  function lateCap(compiled: CompiledSchedule | undefined, occurrenceAt: number): number {
    const [following] = compiled ? occurrencesAfter(compiled, occurrenceAt, 1) : []
    return following === undefined ? SCHEDULE_LATE_CAP_MS : Math.min((following - occurrenceAt) / 2, SCHEDULE_LATE_CAP_MS)
  }

  function evalOne(id: string, nowMs: number): void {
    let sch = storage.getSchedule(id)
    if (!sch) return
    // BACK-PRESSURE RESUMES ITSELF: the human's act — reviewing the runs — is the resume.
    if (sch.state === "paused" && sch.paused_reason === "review") {
      if (unreviewed(sch) === 0) {
        activate(id, nowMs)
        log(`schedule ${id}: resumed — its runs were reviewed`)
      }
      return
    }
    if (sch.state !== "active") return
    if (unreviewed(sch) >= SCHEDULE_UNREVIEWED_MAX) {
      pause(id, "review")
      log(`schedule ${id}: paused until ${SCHEDULE_UNREVIEWED_MAX} runs are reviewed`)
      return
    }
    if (!sch.next_slug || sch.next_occurrence_at === null) {
      materialize(id, nowMs)
      return
    }
    const occurrenceAt = sch.next_occurrence_at
    const row = storage.getSession(sch.next_slug)
    const existing = storage.scheduleRunAt(sch.id, occurrenceAt)
    if (existing?.state === "starting") return // a launch in flight, ours or the human's
    // RECONCILE THE HUMAN'S ACTS ON THE NEXT RUN FIRST.
    if (!row || row.schedule_id !== sch.id) {
      if (!existing) record(sch, occurrenceAt, "skipped", "you deleted it")
      materialize(id, nowMs, occurrenceAt)
      return
    }
    if (!isHeldRow(row)) {
      // Started by some path that did not come through startHeldRow (it always does today); write the
      // history line it would have.
      if (!existing) record(sch, occurrenceAt, "started", "started by you", { thread_slug: row.slug, session_id: row.session_id, started_at: nowMs })
      materialize(id, nowMs, occurrenceAt)
      return
    }
    if (row.state === "archived" || row.archived === 1) {
      if (!existing) record(sch, occurrenceAt, "skipped", "you marked it done")
      materialize(id, nowMs, occurrenceAt)
      return
    }
    if (existing) {
      // The occurrence is already spent (a failed start a dead process left, a skip): move on.
      materialize(id, nowMs, occurrenceAt)
      return
    }
    // DUE? The held row's own instant is the truth — the human may have snoozed it elsewhere. A row with
    // NO instant lost it to something that was not a move: archiving clears a snooze (storage setState),
    // so a Mark as done the human then Undid, before this pass reconciled the skip, hands the run back
    // bare. That is not "run now" (Wake now starts the run itself, router setThreadSnooze): its
    // occurrence is its time, and the row is parked there again so the board shows it.
    if (!row.snoozed_until) {
      storage.setSnoozedUntil(row.slug, iso(occurrenceAt), null)
      refresh()
    }
    const dueAt = row.snoozed_until ? Date.parse(row.snoozed_until) : occurrenceAt
    if (!Number.isFinite(dueAt) || dueAt > nowMs) return
    if (starter.isStarting(row.slug)) return
    // NEVER ON FIRST SIGHT: wait out the post-boot grace so the tailer has vouched for the last run.
    if (nowMs - bootAtMs < graceMs) return
    const compiled = compiledOf(sch)
    const lateMs = nowMs - dueAt
    // MISSED: one materialized run means a week asleep wakes ONE overdue run — and only within the cap.
    // The materialized run is the OLDEST one missed, so past its cap the newest occurrence that came due
    // meanwhile is judged on its OWN lateness: it becomes that one overdue run when it is still inside its
    // cap, and only the ones before it are skipped. Without this a daily 9am schedule that was off from
    // Friday to Monday 9:20 skipped Monday's run too — twenty minutes late — because Saturday's was not.
    if (lateMs > lateCap(compiled, occurrenceAt)) {
      const since = compiled ? occurrencesBetween(compiled, occurrenceAt, nowMs) : []
      const newest = since.at(-1)
      const catchUp = newest !== undefined && nowMs - newest <= lateCap(compiled, newest) ? newest : undefined
      const missed = since.length - (catchUp === undefined ? 0 : 1)
      const cause = dueAt < bootAtMs ? "Ntwine was off"
        : deps.awake && deps.awake.awakeBetween(dueAt, nowMs) < lateMs - SLEEP_SLACK_MS ? "the computer was asleep"
        : "it was too late to run"
      record(sch, occurrenceAt, "skipped", missed > 0 ? `${cause}; ${missed + 1} runs missed` : cause)
      const after = materialize(id, nowMs, occurrenceAt, catchUp)
      // The catch-up is inside its cap by construction, so this second pass starts it (or defers it on an
      // overlap or the start cap) and cannot come back here.
      if (catchUp !== undefined && after?.next_occurrence_at === catchUp) evalOne(id, nowMs)
      return
    }
    // OVERLAP: the previous run still WORKING (the board's predicate, on a vouched reading) skips this one.
    const prev = previousRun(sch)
    if (prev?.thread_slug && deps.threadView) {
      const reading = deps.threadView(prev.thread_slug)
      if (reading.view && isActivelyRunning(reading.view)) {
        if (!reading.vouched) return // unvouched: defer, never skip and never fire on a guess
        record(sch, occurrenceAt, "skipped", "the last run was still working")
        const after = mutate(id, (s) => ({ ...s, consecutive_overlaps: s.consecutive_overlaps + 1 }))
        if (after && after.consecutive_overlaps >= SCHEDULE_OVERLAPS_MAX) {
          pause(id, "stuck")
          return
        }
        materialize(id, nowMs, occurrenceAt)
        return
      }
    }
    // CLAIM synchronously, LAUNCH off the tick.
    if (!startCap.acquire()) return // a few seconds late, not skipped
    const runId = newRunId()
    sch = storage.getSchedule(id)!
    const claimed = storage.claimScheduleRun({
      id: runId, schedule_id: sch.id, occurrence_at: occurrenceAt, started_at: null, state: "starting", reason: null,
      thread_slug: row.slug, session_id: row.session_id, owner, created_at: nowMs,
    }, sch.revision, nowMs)
    if (!claimed) {
      startCap.release()
      return // an edit landed meanwhile; the next tick reads it
    }
    const prompt = scheduledRunPrompt(header(sch, occurrenceAt, { lateMs, dueAt }), row.lazy_prompt?.trim() || sch.prompt)
    const lateNote = lateMs >= LATE_MENTION_MS ? `ran ${formatLateness(lateMs)} late` : null
    const task: Promise<void> = starter.start(row, prompt)
      .then(
        (started) => {
          storage.settleScheduleRun(runId, { state: "started", startedAt: now(), reason: lateNote, threadSlug: started.slug, sessionId: started.sessionId })
          log(`schedule ${id}: started ${started.slug} for ${iso(occurrenceAt)}`)
          afterStart(id, occurrenceAt, true)
        },
        (error: unknown) => {
          storage.settleScheduleRun(runId, { state: "failed", reason: scheduleStartFailure(error) })
          log(`schedule ${id}: could not start the run for ${iso(occurrenceAt)}: ${error instanceof Error ? error.message : String(error)}`)
          afterStart(id, occurrenceAt, false)
        },
      )
      .catch((error: unknown) => log(`schedule ${id}: settling a run failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        startCap.release()
        inFlight.delete(task)
        refresh()
      })
    inFlight.add(task)
  }

  // ---- views ---------------------------------------------------------------------------------------------

  function runView(sch: ThreadScheduleRow, run: ThreadScheduleRunRow): ScheduleRunView {
    const row = run.thread_slug ? storage.getSession(run.thread_slug) : undefined
    const live = row && row.session_id === run.session_id ? row : undefined
    // The slug, not a handle derived from the title: runs share their schedule's title, so the second
    // "Daily ok" run is `daily-ok-2` on the board and its history row must say so.
    const handle = run.thread_slug || (live?.title ? threadHandle(live.title) : "")
    const threadState = run.thread_slug ? (live ? (live.state === "archived" || live.archived === 1 ? "archived" : "open") : "deleted") : undefined
    const label = run.summary?.trim() ? run.summary.trim()
      : run.state === "started" ? `@${handle}${run.reason ? ` · ${run.reason}` : ""}`
      : run.state === "skipped" ? `Skipped: ${run.reason ?? "no reason given"}`
      : run.state === "failed" ? `Didn't start: ${run.reason ?? "unknown error"}`
      : "Starting…"
    return {
      id: run.id,
      occurrenceAt: iso(run.occurrence_at),
      when: formatOccurrence(run.occurrence_at, sch.tz),
      ...(run.started_at !== null ? { startedAt: iso(run.started_at) } : {}),
      state: run.state,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
      ...(run.thread_slug && live ? { threadSlug: run.thread_slug } : {}),
      ...(live?.title ? { threadTitle: live.title } : {}),
      ...(threadState ? { threadState } : {}),
      label,
    }
  }

  function pausedText(sch: ThreadScheduleRow): string | undefined {
    if (sch.state !== "paused") return undefined
    if (sch.paused_reason === "review") {
      const n = Math.max(1, unreviewed(sch))
      return `Paused until you review ${n} run${n === 1 ? "" : "s"}`
    }
    if (sch.paused_reason === "failures") {
      const last = storage.listScheduleRuns(sch.id, 5).find((r) => r.state === "failed")
      const signedOut = last?.reason?.match(/^(Claude|Codex) is signed out$/)
      return `Paused: couldn't start ${SCHEDULE_FAILURES_MAX} times. ${signedOut ? `Sign in to ${signedOut[1]}, then resume.` : last?.reason === "the project folder is missing" ? "The project folder is missing." : "Resume to try again."}`
    }
    if (sch.paused_reason === "stuck") return `Paused: the last run was still working ${SCHEDULE_OVERLAPS_MAX} times in a row.`
    return undefined
  }

  function projectInfo() {
    const project = deps.project
    let slug: string | undefined
    try {
      slug = isHomeWorkspace(project.id) ? homeWorkspaceSlug() : findByPath(project.dir)?.slug
    } catch {
      slug = undefined
    }
    return { projectId: project.id, projectSlug: slug ?? project.id, projectName: project.name }
  }

  function view(sch: ThreadScheduleRow): ScheduleView {
    const nowMs = now()
    const echo = echoNow(sch, nowMs)
    const runs = storage.listScheduleRuns(sch.id, SCHEDULE_HISTORY_MAX)
    const pending = sch.state === "active" ? pendingRow(sch) : undefined
    const nextRun = pending && sch.next_occurrence_at !== null
      ? {
        slug: pending.slug,
        sessionId: pending.session_id,
        at: pending.snoozed_until ?? iso(sch.next_occurrence_at),
        occurrenceAt: iso(sch.next_occurrence_at),
        moved: pending.snoozed_until !== null && pending.snoozed_until !== undefined && Date.parse(pending.snoozed_until) !== sch.next_occurrence_at,
      }
      : undefined
    const paused = pausedText(sch)
    return {
      id: sch.id,
      ...projectInfo(),
      title: sch.title,
      whenText: sch.when_text,
      prompt: sch.prompt,
      ...(sch.condition ? { condition: sch.condition } : {}),
      rrule: sch.rrule,
      dtstart: sch.dtstart,
      tz: sch.tz,
      ...echo,
      ...(sch.model ? { model: sch.model } : {}),
      ...(sch.effort ? { effort: sch.effort as ScheduleView["effort"] } : {}),
      backend: sch.backend === "codex" || sch.backend === "acp" ? sch.backend : "claude",
      state: sch.state,
      ...(sch.paused_reason && sch.state === "paused" ? { pausedReason: sch.paused_reason } : {}),
      ...(paused ? { pausedText: paused } : {}),
      attention: sch.state === "proposed" || (sch.state === "paused" && sch.paused_reason !== "human" && sch.paused_reason !== null),
      ...(nextRun ? { nextRun } : {}),
      ...(runs[0] ? { lastRun: runView(sch, runs[0]) } : {}),
      counts: {
        started: runs.filter((r) => r.state === "started").length,
        skipped: runs.filter((r) => r.state === "skipped").length,
        failed: runs.filter((r) => r.state === "failed").length,
        unreviewed: unreviewed(sch),
      },
      createdBy: sch.created_by,
      createdAt: iso(sch.created_at),
      updatedAt: iso(sch.updated_at),
      revision: sch.revision,
    }
  }

  // ---- validation shared by every creator ---------------------------------------------------------------

  interface Spec {
    title: string
    prompt: string
    whenText: string
    rrule: string
    dtstart: string
    tz: string
    condition: string | null
    model: string | null
    effort: string | null
    backend: string
  }

  function validate(spec: Spec, nowMs: number): ScheduleEcho {
    const titled = titleProblem(spec.title)
    if (titled) throw new Error(titled)
    if (!isValidTimeZone(spec.tz)) throw new Error(`"${spec.tz}" is not an IANA time zone like America/New_York.`)
    if (spec.backend !== "acp" && !spec.effort) throw new Error("Pick an effort for the runs.")
    const checked = scheduleEcho({ title: spec.title, rrule: spec.rrule, dtstart: spec.dtstart, tz: spec.tz, condition: spec.condition }, nowMs, viewerZone())
    if (!checked.ok) throw new Error(checked.error)
    const { compiled: _c, ...echo } = checked.value
    return echo
  }

  function insert(spec: Spec, state: "active" | "proposed", createdBy: string): ThreadScheduleRow {
    if (storage.countLiveSchedules() >= SCHEDULES_PER_PROJECT_MAX) throw new Error(SCHEDULE_CAP_COPY)
    const nowMs = now()
    validate(spec, nowMs)
    const row: ThreadScheduleRow = {
      id: newScheduleId(),
      title: spec.title.trim(),
      when_text: spec.whenText.trim(),
      prompt: spec.prompt,
      condition: spec.condition?.trim() || null,
      rrule: spec.rrule.trim(),
      dtstart: spec.dtstart.trim(),
      tz: spec.tz,
      model: spec.model,
      effort: spec.effort,
      backend: spec.backend,
      state,
      paused_reason: null,
      revision: 0,
      next_slug: null,
      next_occurrence_at: null,
      last_occurrence_at: null,
      consecutive_failures: 0,
      consecutive_overlaps: 0,
      created_by: createdBy,
      created_at: nowMs,
      updated_at: nowMs,
    }
    storage.insertSchedule(row)
    if (state === "active") materialize(row.id, nowMs)
    refresh()
    return storage.getSchedule(row.id)!
  }

  // ---- the provisional title's rename (ARCHITECTURE.md § Scheduled threads) --------------------------------------
  //
  // A schedule made in the prompt box from a reading the model gave no title arrives titled by
  // `provisionalScheduleTitle` (the cut prompt's verb and head noun, "Triage issues") with `titleAuto: true`.
  // Once it exists, the thread namer names it the way it names a dispatch — same completer (Haiku), same
  // `namingRequest`, same uniqueness against the project's open threads — and the name is written through
  // `applyUpdate`, so the pending next run's title follows exactly as it does for a human rename.
  //
  // COMPARE-AND-SET, so a human always wins: the write happens only if the row's `revision` AND `title`
  // are what `create` left. Anything that touched the row while the model answered (a rename, a rule edit,
  // a pause, even a scheduler pass) means the provisional title stands. The check and the write are one
  // synchronous span (applyUpdate runs no awaits), so nothing can land between them in this process.
  // A namer failure is logged and costs nothing: the provisional title already satisfies threadNameProblem.

  function autoTitle(created: ThreadScheduleRow): void {
    const nameFor = deps.nameFor
    if (!nameFor) return
    void (async () => {
      let name: string
      try {
        name = (await nameFor(created.prompt, created.next_slug ?? undefined)).trim()
      } catch (error) {
        log(`naming schedule ${created.id} failed; it keeps "${created.title}": ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      try {
        const sch = storage.getSchedule(created.id)
        if (!sch) return
        if (sch.revision !== created.revision || sch.title !== created.title) {
          log(`schedule ${created.id} changed before its name arrived; it keeps "${sch.title}" over "${name}"`)
          return
        }
        if (!name || name === sch.title || titleProblem(name)) return
        applyUpdate(sch.id, { title: name }, sch.revision)
      } catch (error) {
        log(`renaming schedule ${created.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  /** Apply edited fields; re-point the pending next run at the result (§6 "Edits"). */
  function applyUpdate(id: string, patch: Partial<Spec>, expectedRevision?: number): ThreadScheduleRow {
    const nowMs = now()
    const before = requireSchedule(id)
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      throw new Error("This schedule changed while you were editing it. Reopen it and try again.")
    }
    const spec: Spec = {
      title: patch.title ?? before.title,
      prompt: patch.prompt ?? before.prompt,
      whenText: patch.whenText ?? before.when_text,
      rrule: patch.rrule ?? before.rrule,
      dtstart: patch.dtstart ?? before.dtstart,
      tz: patch.tz ?? before.tz,
      condition: patch.condition !== undefined ? (patch.condition?.trim() || null) : before.condition,
      model: patch.model ?? before.model,
      effort: patch.effort ?? before.effort,
      backend: patch.backend ?? before.backend,
    }
    // Only a new RULE has to fire again; an ended schedule keeps the words it had.
    const ruleChanged = spec.rrule !== before.rrule || spec.dtstart !== before.dtstart || spec.tz !== before.tz
    if (ruleChanged || spec.title !== before.title || spec.backend !== before.backend || spec.effort !== before.effort) validate(spec, nowMs)
    const after = mutate(id, (s) => ({
      ...s,
      title: spec.title.trim(),
      prompt: spec.prompt,
      when_text: spec.whenText.trim(),
      rrule: spec.rrule.trim(),
      dtstart: spec.dtstart.trim(),
      tz: spec.tz,
      condition: spec.condition,
      model: spec.model,
      effort: spec.effort,
      backend: spec.backend,
      // A new rule may fire again even if the old one had run out.
      ...(ruleChanged && s.state === "ended" ? { state: "active" as const } : {}),
    }))
    if (!after) throw new Error("That schedule no longer exists.")
    const pending = pendingRow(after)
    if (pending && !starter.isStarting(pending.slug)) {
      // The human's per-run edit to the next run's note is kept; an untouched note follows the prompt.
      if (pending.lazy_prompt === before.prompt && spec.prompt !== before.prompt) storage.setHeldPrompt(pending.slug, pending.session_id, spec.prompt)
      if (spec.title !== before.title) storage.setTitle(pending.slug, numberedTitle(spec.title))
      if (spec.backend !== before.backend) storage.setBackend(pending.slug, spec.backend)
      if ((spec.model !== before.model || spec.effort !== before.effort) && spec.model && spec.effort) storage.setProfile(pending.slug, spec.model, spec.effort)
    }
    // The pending row is re-snoozed to the new rule's next occurrence (materialize reuses it).
    if (after.state === "active" && (ruleChanged || !after.next_slug)) materialize(id, nowMs)
    refresh()
    return storage.getSchedule(id)!
  }

  function own(input: OwnScheduleInput): OwnScheduleResult {
    const caller = storage.getSession(input.slug)
    if (!caller) throw new Error(`thread ${input.slug} is not registered`)
    const handle = (caller.title && threadHandle(caller.title)) || input.slug
    const nowMs = now()
    const lines = (v: ScheduleView) => [v.echo, ...(v.nextLine ? [v.nextLine] : [])].join("\n")
    switch (input.action) {
      case "dry_run":
      case "create": {
        const spec: Spec = {
          title: input.title, prompt: input.prompt, whenText: input.when, rrule: input.rrule, dtstart: input.dtstart,
          tz: input.tz ?? viewerZone(), condition: input.condition ?? null, model: input.model,
          effort: input.effort ?? null, backend: input.backend ?? "claude",
        }
        if (input.action === "dry_run") {
          const echo = validate(spec, nowMs)
          return { text: `Dry run — nothing was saved. This is what the user would confirm:\n\n${[echo.echo, ...(echo.nextLine ? [echo.nextLine] : [])].join("\n")}` }
        }
        const sch = insert(spec, "proposed", input.slug)
        const v = view(sch)
        return {
          text: `Proposed ${sch.id}. It does NOT run until the user clicks Turn on. Relay this to them verbatim:\n\n${lines(v)}`,
          schedule: v,
        }
      }
      case "update": {
        const sch = requireSchedule(input.id)
        if (sch.created_by !== input.slug || sch.state !== "proposed") {
          throw new Error("You can only change a schedule you proposed that is still waiting to be turned on. On an active schedule you may `skip_next`, `move_next` or `pause`.")
        }
        const after = applyUpdate(input.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.when !== undefined ? { whenText: input.when } : {}),
          ...(input.rrule !== undefined ? { rrule: input.rrule } : {}),
          ...(input.dtstart !== undefined ? { dtstart: input.dtstart } : {}),
          ...(input.tz !== undefined ? { tz: input.tz } : {}),
          ...(input.condition !== undefined ? { condition: input.condition } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
          ...(input.backend !== undefined ? { backend: input.backend } : {}),
        })
        const v = view(after)
        return { text: `Updated ${after.id}; it still waits for the user's Turn on. Relay this to them verbatim:\n\n${lines(v)}`, schedule: v }
      }
      case "list": {
        const all = storage.listSchedules().map(view)
        if (all.length === 0) return { text: "This project has no schedules.", schedules: [] }
        const text = all.map((v) => {
          const status = v.state === "active" ? (v.nextRun ? `next ${formatOccurrence(Date.parse(v.nextRun.at), v.tz)}` : "active") : v.pausedText ?? v.state
          return `${v.id} · ${v.echo} · ${status}${v.createdBy !== "human" ? ` · proposed by @${v.createdBy}` : ""}`
        }).join("\n")
        return { text, schedules: all }
      }
      case "pause": {
        const sch = requireSchedule(input.id)
        if (sch.state !== "active") return { text: `${sch.id} is ${sch.state}; nothing to pause.`, schedule: view(sch) }
        const after = pause(input.id, "human")!
        return { text: `Paused ${sch.id}. Only the user can resume it.`, schedule: view(after) }
      }
      case "skip_next": {
        const sch = requireSchedule(input.id)
        const pending = sch.state === "active" ? pendingRow(sch) : undefined
        if (!pending || sch.next_occurrence_at === null) throw new Error(`${sch.id} has no upcoming run to skip (it is ${sch.state}).`)
        if (starter.isStarting(pending.slug)) throw new Error("That run is starting right now; it can no longer be skipped.")
        const skipped = sch.next_occurrence_at
        record(sch, skipped, "skipped", input.reason?.trim() || `@${handle} skipped it`)
        const after = materialize(input.id, nowMs, skipped)!
        const v = view(after)
        return { text: `Skipped the run for ${formatOccurrence(skipped, sch.tz)}.${v.nextRun ? ` The next one is ${formatOccurrence(Date.parse(v.nextRun.at), v.tz)}.` : " The schedule has no more runs."}`, schedule: v }
      }
      case "move_next": {
        const sch = requireSchedule(input.id)
        const pending = sch.state === "active" ? pendingRow(sch) : undefined
        if (!pending || sch.next_occurrence_at === null) throw new Error(`${sch.id} has no upcoming run to move (it is ${sch.state}).`)
        if (starter.isStarting(pending.slug)) throw new Error("That run is starting right now; it can no longer be moved.")
        const to = parseMoveTarget(input.to, sch.tz)
        if (to === undefined) throw new Error("`to` must be a local time in the schedule's zone like 2026-10-15T10:00, or an ISO instant.")
        if (to < nowMs + MOVE_MIN_LEAD_MS) throw new Error("`to` must be at least a minute from now.")
        const compiled = compiledOf(sch)
        const [following] = compiled ? occurrencesAfter(compiled, sch.next_occurrence_at, 1) : []
        if (following !== undefined && to >= following) {
          throw new Error(`That is at or past the run after it (${formatOccurrence(following, sch.tz)}). Use \`skip_next\` to drop this one instead.`)
        }
        storage.setSnoozedUntil(pending.slug, iso(to), null)
        refresh()
        return {
          text: `Moved the run for ${formatOccurrence(sch.next_occurrence_at, sch.tz)} to ${formatOccurrence(to, sch.tz)}. The rule is unchanged.`,
          schedule: view(storage.getSchedule(sch.id)!),
        }
      }
    }
  }

  const service: ScheduleService = {
    list: () => storage.listSchedules().map(view),
    get(id) {
      const sch = requireSchedule(id)
      return { schedule: view(sch), history: storage.listScheduleRuns(id, SCHEDULE_HISTORY_MAX).map((run) => runView(sch, run)) }
    },
    summary() {
      const all = storage.listSchedules().filter((s) => s.state !== "ended")
      if (all.length === 0) return undefined
      return {
        count: all.length,
        attention: all.some((s) => s.state === "proposed" || (s.state === "paused" && s.paused_reason !== "human" && s.paused_reason !== null)),
      }
    },
    threadRef(row) {
      if (!row.schedule_id) return undefined
      const ref = refsById().get(row.schedule_id)
      if (!ref) return undefined
      return { id: row.schedule_id, title: ref.title, describe: ref.describe, pending: isHeldRow(row) && ref.nextSlug === row.slug }
    },
    defaultZone: viewerZone,
    reportClientZone(tz) {
      if (!isValidTimeZone(tz)) throw new Error(`"${tz}" is not an IANA time zone`)
      if (deps.clientZone?.() !== tz) deps.setClientZone?.(tz)
    },
    create(input, createdBy = "human") {
      const sch = insert({
        title: input.title, prompt: input.prompt, whenText: input.whenText, rrule: input.rrule, dtstart: input.dtstart,
        tz: input.tz ?? viewerZone(), condition: input.condition ?? null, model: input.model,
        effort: input.effort ?? null, backend: input.backend ?? "claude",
      }, "active", createdBy)
      if (input.titleAuto) autoTitle(sch)
      return view(sch)
    },
    update(input) {
      return view(applyUpdate(input.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.whenText !== undefined ? { whenText: input.whenText } : {}),
        ...(input.rrule !== undefined ? { rrule: input.rrule } : {}),
        ...(input.dtstart !== undefined ? { dtstart: input.dtstart } : {}),
        ...(input.tz !== undefined ? { tz: input.tz } : {}),
        ...(input.condition !== undefined ? { condition: input.condition } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.backend !== undefined ? { backend: input.backend } : {}),
      }, input.revision))
    },
    setState(id, state) {
      const sch = requireSchedule(id)
      if (state === "paused") {
        if (sch.state === "proposed") throw new Error("A proposal is not running; turn it on or discard it.")
        if (sch.state === "ended") throw new Error("This schedule has no more runs.")
        return view(pause(id, "human")!)
      }
      if (sch.state === "ended") throw new Error("This schedule has no more runs. Change when it runs to start it again.")
      return view(activate(id, now()) ?? sch)
    },
    async runNow(id) {
      const sch = requireSchedule(id)
      const pending = sch.state === "active" ? pendingRow(sch) : undefined
      if (pending) return humanStart(sch, pending, pending.lazy_prompt?.trim() || sch.prompt)
      return manualRun(sch)
    },
    remove(id) {
      const sch = storage.getSchedule(id)
      if (!sch) return
      dropPending(sch)
      storage.deleteSchedule(id)
      refresh()
    },
    own,
    async startHeldRow(row, prompt, profile) {
      const sch = row.schedule_id ? storage.getSchedule(row.schedule_id) : undefined
      // Only the schedule's PENDING next run is a scheduled run; any other held row (a leftover lazy thread,
      // or one left behind by a deleted schedule) starts plainly on its prompt.
      if (!sch || sch.next_slug !== row.slug || !isHeldRow(row)) return starter.start(row, prompt, profile)
      return humanStart(sch, row, prompt, profile)
    },
    quietDone(slug, body) {
      const row = storage.getSession(slug)
      if (!row) throw new Error(`thread ${slug} is not registered`)
      if (!row.schedule_id) {
        throw new Error("`quiet` is only for a scheduled run, and this thread is not one. Call `done` without it — your card stays in the user's queue.")
      }
      storage.markThreadDone(slug, body, now())
      storage.setState(slug, "archived")
      const run = storage.scheduleRunForThread(slug)
      const first = body.split("\n").map((line) => line.replace(/^[\s>*#-]+/, "").replace(/\*\*/g, "").trim()).find(Boolean) ?? ""
      if (run && first) storage.setScheduleRunSummary(run.id, first.length > 200 ? `${first.slice(0, 199)}…` : first)
      refresh()
    },
    evalDue(nowMs) {
      settleOrphanClaims()
      for (const sch of storage.listSchedules()) {
        if (sch.state !== "active" && !(sch.state === "paused" && sch.paused_reason === "review")) continue
        try {
          evalOne(sch.id, nowMs)
        } catch (error) {
          log(`schedule ${sch.id}: pass failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
  return service
}

/** `move_next`'s `to`: a local wall time in the schedule's zone, or an ISO instant with a zone. */
function parseMoveTarget(text: string, tz: string): number | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim())
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1).map(Number) as [number, number, number, number, number]
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined
    return wallToInstant({ y, mo, d, h, mi }, tz)
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text.trim())) return undefined
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : undefined
}
