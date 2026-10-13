import { z } from "zod"
import { checkSchedule, describeSchedule, formatOccurrence, type CompiledSchedule, type ScheduleResult } from "./schedule-rule.ts"
import { threadHandle } from "./thread-handle.ts"
import { ThreadSlug } from "./thread-slug.ts"

// ---- SCHEDULED THREADS: THE CONTRACT ------------------------------------------------------------------
// A schedule is a saved prompt plus a recurrence; at each occurrence Ntwine starts a FRESH thread with that
// prompt (ARCHITECTURE.md § Scheduled threads). This module is everything both sides of the wire share: the views
// the web renders, every RPC's input and output, the echo the human confirms before saving, and the
// header a run's prompt opens with. The recurrence engine itself is schedule-rule.ts; nothing here turns
// a rule into instants on its own.
//
// Deliberately imports nothing from index.ts: index re-exports this module, and a value import the other
// way would read a zod schema before index had built it.

export const SCHEDULE_ID_RE = /^sch_[0-9a-f]{12}$/
export const ScheduleId = z.string().regex(SCHEDULE_ID_RE)

/** proposed + active + paused, per project. Each one starts a paid agent on its own clock. */
export const SCHEDULES_PER_PROJECT_MAX = 25
/** Run rows kept per schedule; older history goes. */
export const SCHEDULE_HISTORY_MAX = 200
/** Started runs the human has not reviewed (open, not marked done) before the schedule pauses itself. */
export const SCHEDULE_UNREVIEWED_MAX = 3
/** Failed starts in a row before the schedule pauses itself (a human resumes it). */
export const SCHEDULE_FAILURES_MAX = 3
/** Occurrences skipped in a row because the previous run was still working, before it pauses. */
export const SCHEDULE_OVERLAPS_MAX = 3

export const ScheduleState = z.enum(["proposed", "active", "paused", "ended"])
export type ScheduleState = z.infer<typeof ScheduleState>
export const SchedulePausedReason = z.enum(["human", "review", "failures", "stuck"])
export type SchedulePausedReason = z.infer<typeof SchedulePausedReason>
export const ScheduleRunState = z.enum(["starting", "started", "skipped", "failed"])
export type ScheduleRunState = z.infer<typeof ScheduleRunState>

// Mirrors of Backend and Settings.effort in index.ts, kept local for the reason in the header comment.
export const ScheduleBackend = z.enum(["claude", "codex", "acp"])
export const ScheduleEffort = z.enum(["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"])

// ---- copy ------------------------------------------------------------------------------------------------

export const SCHEDULE_NOT_FOUND_COPY = "Couldn't find a schedule in that. Try “every weekday at 9am”."
export const SCHEDULE_PRESENCE_COPY = "Ntwine can't tell when you're at the keyboard yet. Try hours instead, like “weekdays 9am–6pm”."
export const SCHEDULE_SPACING_COPY = "Runs can't be closer than 15m apart."
export const SCHEDULE_CAP_COPY = `A project can hold ${SCHEDULES_PER_PROJECT_MAX} schedules. Delete one first.`

/** "America/New_York" → "New York"; a zone with no city reads as itself. */
export function cityOfZone(tz: string): string {
  const last = tz.split("/").pop() ?? tz
  return /^[A-Z][A-Za-z_]+$/.test(last) && tz.includes("/") && !tz.startsWith("Etc/") ? last.replace(/_/g, " ") : tz
}

// ---- the echo ------------------------------------------------------------------------------------------

/** What the human confirms before a schedule is saved, built from the rule Ntwine will fire — never from
 *  the model's summary of it. */
export const ScheduleEcho = z.object({
  /** The rule in words: "every Monday at 9am", plus "New York time" when the schedule's zone is not the
   *  viewer's. The short rule a schedule's row shows. */
  describe: z.string(),
  /** "Triage issues · every Monday at 9am", with the condition when there is one. */
  echo: z.string(),
  /** "Next: Mon Oct 12 · Mon Oct 19 · Mon Oct 26" — times appear only for a rule that runs more than once
   *  a day. Empty when the rule never runs again. */
  nextLine: z.string(),
  /** The next few occurrences, ISO instants. */
  upcoming: z.array(z.string()),
  /** Runs a day, for a rule that runs more than once a day. */
  perDay: z.number().int().positive().optional(),
})
export type ScheduleEcho = z.infer<typeof ScheduleEcho>

export interface ScheduleEchoSpec {
  title: string
  rrule: string
  dtstart: string
  tz: string
  condition?: string | null
}

/** The day half of `formatOccurrence`: "Mon Oct 12", or "Sat Jan 2, 2027" in another year — only the
 *  last comma segment (the time) goes. */
function formatOccurrenceDay(ms: number, tz: string, nowMs?: number): string {
  const full = formatOccurrence(ms, tz, nowMs)
  const comma = full.lastIndexOf(",")
  return comma > 0 ? full.slice(0, comma) : full
}

/** Validate a schedule and build its echo. `viewerTz` is the zone the human reads in; the echo names the
 *  schedule's own zone only when the two differ. */
export function scheduleEcho(
  spec: ScheduleEchoSpec,
  nowMs: number,
  viewerTz?: string,
  preview = 3,
): ScheduleResult<ScheduleEcho & { compiled: CompiledSchedule }> {
  const checked = checkSchedule({ rrule: spec.rrule, dtstart: spec.dtstart, tz: spec.tz }, nowMs, preview)
  if (!checked.ok) return checked
  const { compiled, next, perDay } = checked.value
  return { ok: true, value: { ...echoOf(spec, compiled, next, perDay, viewerTz, nowMs), compiled } }
}

/** The echo of an already-compiled schedule (a stored one), from its next occurrences. `nowMs` puts the
 *  year on a run that is not in this year. */
export function echoOf(
  spec: Pick<ScheduleEchoSpec, "title" | "tz" | "condition">,
  compiled: CompiledSchedule,
  next: readonly number[],
  perDay: number | undefined,
  viewerTz?: string,
  nowMs?: number,
): ScheduleEcho {
  const zone = viewerTz && viewerTz !== spec.tz ? ` ${cityOfZone(spec.tz)} time` : ""
  const describe = `${describeSchedule(compiled, nowMs)}${zone}`
  const condition = spec.condition?.trim()
  const echo = [spec.title.trim(), describe, ...(condition ? [condition] : []), ...(perDay ? [`${perDay} runs a day`] : [])].join(" · ")
  // A date alone names a run only while no two runs share a day. `perDay` counts the 24h from the FIRST run,
  // so "every Monday at 8am and 5pm" asked on a Monday afternoon counts one (5pm, then next Monday 8am) and
  // read "Next: Mon Oct 5 · Mon Oct 12 · Mon Oct 12" until the times were added whenever a day repeats.
  const days = next.map((ms) => formatOccurrenceDay(ms, spec.tz, nowMs))
  const day = perDay || new Set(days).size < days.length ? formatOccurrence : formatOccurrenceDay
  return {
    describe,
    echo,
    nextLine: next.length ? `Next: ${next.map((ms) => day(ms, spec.tz, nowMs)).join(" · ")}` : "",
    upcoming: next.map((ms) => new Date(ms).toISOString()),
    ...(perDay ? { perDay } : {}),
  }
}

// ---- the run's opening prompt -------------------------------------------------------------------------

export const SCHEDULED_RUN_TAG = "scheduled-run"

export interface ScheduledRunHeaderInput {
  scheduleId: string
  title: string
  /** `describeSchedule` of the rule (the echo's rule half). */
  describe: string
  condition?: string | null
  /** The occurrence this run is for, and the schedule's zone to say it in. */
  occurrenceAt: number
  tz: string
  /** Set when the run starts late enough to mention, with why when Ntwine knows. */
  late?: { ms: number; cause?: "off" | "asleep" }
  /** The previous run, so "since the last run" works. */
  previous?: { title?: string | null; slug: string; at: number }
  /** Started by the human ("Run now", or sending the next run early) rather than by the clock. */
  byHuman?: boolean
}

/** The header a scheduled run's prompt opens with (ARCHITECTURE.md § Scheduled threads), wrapped in a tag the
 *  chat can recognise (`parseScheduledRunPrompt`). The saved prompt follows it verbatim. Durations are
 *  in the house grammar (`2h 10m`). */
export function scheduledRunHeader(input: ScheduledRunHeaderInput): string {
  const lines: string[] = []
  lines.push(`This is a scheduled run of "${input.title}" (${input.scheduleId}), ${input.describe}. It is a fresh thread: it starts with no memory of earlier runs.`)
  const condition = input.condition?.trim()
  if (condition) {
    lines.push(`It has a condition — check it FIRST: "${condition}". If it rules this run out, finish quietly (below) and give the reason.`)
  }
  const when = formatOccurrence(input.occurrenceAt, input.tz)
  if (input.byHuman) lines.push(`This run is for ${when}; the user started it early.`)
  else if (input.late) {
    const cause = input.late.cause === "off" ? ", because Ntwine was off" : input.late.cause === "asleep" ? ", because the computer was asleep" : ""
    lines.push(`This run is for ${when}. It started ${formatLateness(input.late.ms)} late${cause}.`)
  } else lines.push(`This run is for ${when}.`)
  if (input.previous) {
    const handle = (input.previous.title && threadHandle(input.previous.title)) || input.previous.slug
    lines.push(`The previous run was @${handle} for ${formatOccurrence(input.previous.at, input.tz)}. \`read_thread\` it when "since the last run" matters.`)
  } else lines.push("This is the schedule's first run.")
  lines.push(
    "If you find nothing that needs the user, finish with `done` and `quiet: true`: the thread goes straight to Done and your body's first line becomes this run's line in the schedule's history. " +
      "If the NEXT run should not happen as planned, the `schedule` tool's `skip_next` and `move_next` change that one occurrence.",
  )
  return `<${SCHEDULED_RUN_TAG} schedule="${input.scheduleId}">\n${lines.join("\n")}\n</${SCHEDULED_RUN_TAG}>`
}

/** The header plus the saved prompt — what a run's worker receives as its first message. */
export function scheduledRunPrompt(header: string, prompt: string): string {
  return `${header}\n\n${prompt}`
}

const RUN_TAG_RE = new RegExp(`^<${SCHEDULED_RUN_TAG} schedule="(sch_[0-9a-f]{12})">\\n([\\s\\S]*?)\\n</${SCHEDULED_RUN_TAG}>(?:\\n\\n)?`)

/** Split a run's first message back into its header and the saved prompt, so the chat can show the
 *  prompt with a schedule chip instead of the machinery. Undefined for any other message. */
export function parseScheduledRunPrompt(text: string): { scheduleId: string; header: string; prompt: string } | undefined {
  const m = RUN_TAG_RE.exec(text)
  if (!m) return undefined
  return { scheduleId: m[1]!, header: m[2]!, prompt: text.slice(m[0].length) }
}

/** House-grammar lateness: "12m", "2h 10m", "3d 4h". */
export function formatLateness(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

// ---- views ---------------------------------------------------------------------------------------------

/** What a thread row carries when it is a run of a schedule — enough for the repeat glyph and its
 *  tooltip ("From Triage issues · every Monday at 9am"). */
export const ThreadScheduleRef = z.object({
  id: z.string(),
  title: z.string(),
  describe: z.string(),
  /** True on the schedule's pending next run (a held row in Snoozed), false on a run that started. */
  pending: z.boolean(),
})
export type ThreadScheduleRef = z.infer<typeof ThreadScheduleRef>

/** One line of a schedule's history. */
export const ScheduleRunView = z.object({
  id: z.string(),
  /** The occurrence the row is for, ISO. */
  occurrenceAt: z.string(),
  /** "Mon Oct 12, 9am" in the schedule's zone — the line's date half. */
  when: z.string(),
  startedAt: z.string().optional(),
  state: ScheduleRunState,
  /** Why it was skipped or did not start ("Ntwine was off", "the last run was still working"), or a note
   *  on a started run ("ran 2h 10m late", "started by you"). */
  reason: z.string().optional(),
  /** A quiet finish's first line. */
  summary: z.string().optional(),
  threadSlug: ThreadSlug.optional(),
  threadTitle: z.string().optional(),
  /** Where the run's thread is now. `deleted` once its row is gone. */
  threadState: z.enum(["open", "archived", "deleted"]).optional(),
  /** The line's text half, ready to render after `when`: "@triage-issues", "Nothing new — no issues since
   *  Oct 5", "Skipped: Ntwine was off", "Didn't start: Claude is signed out". */
  label: z.string(),
})
export type ScheduleRunView = z.infer<typeof ScheduleRunView>

/** The materialized next run: a held thread in the project's Snoozed band. */
export const ScheduleNextRun = z.object({
  slug: ThreadSlug,
  sessionId: z.string(),
  /** When it starts — the held row's snooze instant, which the human may have moved. ISO. */
  at: z.string(),
  /** The rule occurrence it stands for. ISO. */
  occurrenceAt: z.string(),
  /** The human (or a run's `move_next`) moved it off its occurrence. */
  moved: z.boolean(),
})
export type ScheduleNextRun = z.infer<typeof ScheduleNextRun>

export const ScheduleView = z.object({
  id: ScheduleId,
  projectId: z.string(),
  projectSlug: z.string(),
  projectName: z.string(),
  title: z.string(),
  /** The human's words for when. */
  whenText: z.string(),
  /** The saved prompt, verbatim. */
  prompt: z.string(),
  condition: z.string().optional(),
  rrule: z.string(),
  dtstart: z.string(),
  tz: z.string(),
  ...ScheduleEcho.shape,
  model: z.string().optional(),
  effort: ScheduleEffort.optional(),
  backend: ScheduleBackend,
  state: ScheduleState,
  pausedReason: SchedulePausedReason.optional(),
  /** The paused line when NTWINE paused it ("Paused until you review 3 runs"); absent for a human pause. */
  pausedText: z.string().optional(),
  /** Paused by Ntwine, or a proposal waiting for Turn on — what turns the project row's count to warning. */
  attention: z.boolean(),
  nextRun: ScheduleNextRun.optional(),
  lastRun: ScheduleRunView.optional(),
  counts: z.object({
    started: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Started runs whose thread is still open — what back-pressure counts. */
    unreviewed: z.number().int().nonnegative(),
  }),
  /** `human`, or the slug of the thread that proposed it. */
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
})
export type ScheduleView = z.infer<typeof ScheduleView>

/** The project row's fourth count. */
export const ProjectSchedules = z.object({
  count: z.number().int().nonnegative(),
  attention: z.boolean(),
})
export type ProjectSchedules = z.infer<typeof ProjectSchedules>

// ---- the human's RPCs -----------------------------------------------------------------------------------

export const ListSchedulesInput = z.object({
  /** Every open project's schedules (the command palette), not just this one's. */
  allProjects: z.boolean().optional(),
}).strict()
export type ListSchedulesInput = z.infer<typeof ListSchedulesInput>

export const ScheduleIdInput = z.object({ id: ScheduleId }).strict()
export type ScheduleIdInput = z.infer<typeof ScheduleIdInput>

export const GetScheduleResult = z.object({
  schedule: ScheduleView,
  /** Newest first. */
  history: z.array(ScheduleRunView),
}).strict()
export type GetScheduleResult = z.infer<typeof GetScheduleResult>

export const InterpretScheduleInput = z.object({
  /** What the human typed: the schedule phrase and the prompt together ("every Monday at 9am triage new
   *  issues"), or — with `scheduleId` — only the new WHEN ("Change when"). */
  text: z.string().trim().min(1).max(20_000),
  scheduleId: ScheduleId.optional(),
  /** The browser's zone; defaults to the last one reported (reportClientZone), then the server's. */
  tz: z.string().min(1).max(64).optional(),
}).strict()
export type InterpretScheduleInput = z.infer<typeof InterpretScheduleInput>

export const InterpretScheduleResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** The schedule phrase exactly as it appears in `text`, and where. */
    phrase: z.string(),
    phraseStart: z.number().int().nonnegative(),
    phraseEnd: z.number().int().nonnegative(),
    /** `text` with the phrase cut out, otherwise VERBATIM — never a model's rewrite. Empty for a
     *  "Change when". */
    prompt: z.string(),
    /** The words to store as the schedule's WHEN. */
    whenText: z.string(),
    rrule: z.string(),
    dtstart: z.string(),
    tz: z.string(),
    condition: z.string().optional(),
    title: z.string(),
    preview: ScheduleEcho,
  }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
])
export type InterpretScheduleResult = z.infer<typeof InterpretScheduleResult>

const ScheduleFields = {
  title: z.string().trim().min(1).max(60),
  prompt: z.string().trim().min(1).max(100_000),
  whenText: z.string().trim().min(1).max(500),
  rrule: z.string().trim().min(1).max(500),
  dtstart: z.string().trim().min(1).max(32),
  tz: z.string().trim().min(1).max(64),
  condition: z.string().trim().max(500),
  model: z.string().trim().min(1).max(200),
  effort: ScheduleEffort,
  backend: ScheduleBackend,
}

/** A human's new schedule — the interpreter's result, confirmed. `tz` defaults to the reported zone. */
export const CreateScheduleInput = z.object({
  title: ScheduleFields.title,
  prompt: ScheduleFields.prompt,
  whenText: ScheduleFields.whenText,
  rrule: ScheduleFields.rrule,
  dtstart: ScheduleFields.dtstart,
  tz: ScheduleFields.tz.optional(),
  condition: ScheduleFields.condition.optional(),
  model: ScheduleFields.model,
  effort: ScheduleFields.effort.optional(),
  backend: ScheduleFields.backend.optional(),
  /** The title is the browser's provisional one (`provisionalScheduleTitle`) — the model named no task — so
   *  the server may rename it once through the thread namer, only while nobody has touched the row since
   *  (ARCHITECTURE.md § Scheduled threads). */
  titleAuto: z.literal(true).optional(),
}).strict()
export type CreateScheduleInput = z.infer<typeof CreateScheduleInput>

/** Any subset of a schedule's fields. `revision` guards against a concurrent edit; `condition: null`
 *  removes the condition. A change to the rule or its zone moves the next run to the new rule's next
 *  occurrence; a prompt change reaches the next run unless the human already edited that run's note. */
export const UpdateScheduleInput = z.object({
  id: ScheduleId,
  revision: z.number().int().nonnegative().optional(),
  title: ScheduleFields.title.optional(),
  prompt: ScheduleFields.prompt.optional(),
  whenText: ScheduleFields.whenText.optional(),
  rrule: ScheduleFields.rrule.optional(),
  dtstart: ScheduleFields.dtstart.optional(),
  tz: ScheduleFields.tz.optional(),
  condition: ScheduleFields.condition.nullable().optional(),
  model: ScheduleFields.model.optional(),
  effort: ScheduleFields.effort.optional(),
  backend: ScheduleFields.backend.optional(),
}).strict()
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInput>

/** Pause, Resume, or Turn on a proposal (`active`). Resume never catches up: the next run is the first
 *  occurrence after now. */
export const SetScheduleStateInput = z.object({
  id: ScheduleId,
  state: z.enum(["active", "paused"]),
}).strict()
export type SetScheduleStateInput = z.infer<typeof SetScheduleStateInput>

export const RunScheduleNowResult = z.object({ slug: ThreadSlug, sessionId: z.string() }).strict()
export type RunScheduleNowResult = z.infer<typeof RunScheduleNowResult>

/** The browser's IANA zone, reported on load. The latest report is the default zone for new schedules. */
export const ReportClientZoneInput = z.object({ tz: z.string().min(1).max(64) }).strict()
export type ReportClientZoneInput = z.infer<typeof ReportClientZoneInput>

// ---- the worker's RPC (the `schedule` MCP tool) -------------------------------------------------------
// One procedure with an `action`, like the tool. Keyed by the caller's own slug, which the MCP server
// reads from its environment — never from the model's arguments. What a worker may do is narrower than
// what the human may (ARCHITECTURE.md § Scheduled threads): it may PROPOSE a schedule (it waits for the human's
// Turn on), refine its own proposal, and on any schedule in the project skip or move the next run or pause
// it. It cannot turn anything on, resume, edit an active schedule's rule, or delete.

const WorkerScheduleSpec = {
  title: ScheduleFields.title,
  prompt: ScheduleFields.prompt,
  /** The human's own words for when. */
  when: ScheduleFields.whenText,
  rrule: ScheduleFields.rrule,
  dtstart: ScheduleFields.dtstart,
  tz: ScheduleFields.tz.optional(),
  condition: ScheduleFields.condition.optional(),
  model: ScheduleFields.model,
  effort: ScheduleFields.effort.optional(),
  backend: ScheduleFields.backend.optional(),
}

export const OwnScheduleInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), slug: ThreadSlug, ...WorkerScheduleSpec }).strict(),
  z.object({ action: z.literal("dry_run"), slug: ThreadSlug, ...WorkerScheduleSpec }).strict(),
  z.object({
    action: z.literal("update"),
    slug: ThreadSlug,
    id: ScheduleId,
    title: WorkerScheduleSpec.title.optional(),
    prompt: WorkerScheduleSpec.prompt.optional(),
    when: WorkerScheduleSpec.when.optional(),
    rrule: WorkerScheduleSpec.rrule.optional(),
    dtstart: WorkerScheduleSpec.dtstart.optional(),
    tz: ScheduleFields.tz.optional(),
    condition: ScheduleFields.condition.nullable().optional(),
    model: WorkerScheduleSpec.model.optional(),
    effort: ScheduleFields.effort.optional(),
    backend: ScheduleFields.backend.optional(),
  }).strict(),
  z.object({ action: z.literal("list"), slug: ThreadSlug }).strict(),
  z.object({ action: z.literal("pause"), slug: ThreadSlug, id: ScheduleId }).strict(),
  z.object({ action: z.literal("skip_next"), slug: ThreadSlug, id: ScheduleId, reason: z.string().trim().max(200).optional() }).strict(),
  z.object({
    action: z.literal("move_next"),
    slug: ThreadSlug,
    id: ScheduleId,
    /** The new start: a local wall time in the schedule's zone (`2026-10-15T10:00`) or an ISO instant. */
    to: z.string().trim().min(1).max(40),
  }).strict(),
])
export type OwnScheduleInput = z.infer<typeof OwnScheduleInput>

/** `text` is the server-built reply the tool relays VERBATIM — the echo the worker must pass on to the
 *  human — so the shim has nothing to compose. */
export const OwnScheduleResult = z.object({
  text: z.string(),
  schedule: ScheduleView.optional(),
  schedules: z.array(ScheduleView).optional(),
}).strict()
export type OwnScheduleResult = z.infer<typeof OwnScheduleResult>
