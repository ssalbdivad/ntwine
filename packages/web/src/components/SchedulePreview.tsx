import { useMemo } from "react"
import { cityOfZone, compileSchedule, describeSchedule, scheduleEcho, type InterpretScheduleResult, type ScheduleEcho } from "@ntwine/shared"
import { spanUntil } from "../lib/activityTime.ts"
import { isFailedRead, type ModelReadOk, type ModelReadView } from "../lib/scheduleModelRead.ts"

// WHAT A RULE WILL DO, rebuilt in the browser from the rule itself — the drawer's Change when and the prompt box's
// strip under the box (ARCHITECTURE.md § Scheduled threads). Built from the COMPILED rule with the same `scheduleEcho`
// the server saves, never from the model's own summary, so it says what will fire; and the next runs come from
// the rule and the clock, so they move on with the time without another read.
//
//   Triage issues · every Monday at 9am          ← the echo
//   Next: Mon Oct 12, in 6d · Mon Oct 19 · …     ← the shared next line, with ", in {span}" after the first
//
// ", in 6d" is a web-only decoration on the shared echo's next line, so the saved echo is unchanged.

/** Below this the first run is close enough to be worth the warning tone. The theme has no `warning` token;
 *  `attention` is its amber warning hue. */
export const SOON_MS = 15 * 60_000

export interface SchedulePreviewSpec {
  title: string
  rrule: string
  dtstart: string
  tz: string
  condition?: string | null
}

export type SchedulePreviewModel =
  | {
      ok: true
      /** The rule in the house's words ("every Monday at 9am"), with no zone. */
      describe: string
      /** " New York time" when the schedule's zone is not the viewer's (the shared echo's suffix). */
      zone: string
      /** After the rule: the condition, "N runs a day". */
      tail: string[]
      /** The next runs as the shared echo's next line spells them. */
      next: string[]
      /** The first run, ISO. */
      firstAt?: string
    }
  | { ok: false; error: string }

// The engine walks 60 runs to check a rule; memoized per rule, zone and minute so a keystroke in the task
// costs one string compare.
const MEMO_MAX = 16
const memo = new Map<string, { echo: ScheduleEcho; describe: string } | { error: string }>()

function checked(spec: SchedulePreviewSpec, nowMs: number, viewerTz: string) {
  const key = [spec.rrule, spec.dtstart, spec.tz, viewerTz, Math.floor(nowMs / 60_000)].join("\0")
  const hit = memo.get(key)
  if (hit) {
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }
  const result = scheduleEcho({ title: "", rrule: spec.rrule, dtstart: spec.dtstart, tz: spec.tz }, nowMs, viewerTz)
  const value = result.ok
    ? { echo: (({ compiled: _c, ...echo }) => echo)(result.value), describe: describeSchedule(result.value.compiled, nowMs) }
    : { error: result.error }
  memo.set(key, value)
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
  return value
}

/** Everything the preview shows, or why the rule cannot be saved (checkSchedule's own words). Pure. */
export function schedulePreviewModel(spec: SchedulePreviewSpec, nowMs: number, viewerTz: string): SchedulePreviewModel {
  const c = checked(spec, nowMs, viewerTz)
  if ("error" in c) return { ok: false, error: c.error }
  const condition = spec.condition?.trim()
  const next = c.echo.nextLine ? c.echo.nextLine.replace(/^Next: /, "").split(" · ") : []
  return {
    ok: true,
    describe: c.describe,
    zone: viewerTz !== spec.tz ? ` ${cityOfZone(spec.tz)} time` : "",
    tail: [...(condition ? [condition] : []), ...(c.echo.perDay ? [`${c.echo.perDay} runs a day`] : [])],
    next,
    ...(c.echo.upcoming[0] ? { firstAt: c.echo.upcoming[0] } : {}),
  }
}

/** The browser's IANA zone — what the preview names a schedule's zone against. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function SchedulePreview({
  spec,
  nowMs,
  viewerTz = browserZone(),
  updating = false,
}: {
  spec: SchedulePreviewSpec
  nowMs: number
  viewerTz?: string
  /** The words have changed and are being read again: this is the last reading, until the new one lands. */
  updating?: boolean
}) {
  const model = useMemo(
    () => schedulePreviewModel(spec, nowMs, viewerTz),
    [spec.title, spec.rrule, spec.dtstart, spec.tz, spec.condition, nowMs, viewerTz],
  )
  if (!model.ok) {
    return <p data-schedule-preview-error className="text-[12px] leading-5 text-fg/85">{model.error}</p>
  }
  const span = model.firstAt ? spanUntil(model.firstAt, nowMs) : null
  const soon = model.firstAt !== undefined && Date.parse(model.firstAt) - nowMs < SOON_MS
  return (
    <div data-schedule-preview data-schedule-preview-updating={updating || undefined} className="flex min-w-0 flex-col">
      <p data-schedule-preview-echo className={`text-pretty text-[13px] leading-5 ${updating ? "shimmer-text" : "text-fg"}`}>
        {spec.title.trim()}
        {" · "}
        {model.describe}
        {model.zone}
        {model.tail.map((t) => ` · ${t}`).join("")}
      </p>
      {model.next.length > 0 && (
        <p data-schedule-preview-next className="text-pretty text-[12px] leading-5 text-muted">
          {"Next: "}
          {model.next[0]}
          {span && (
            <>
              {", "}
              <span data-soon={soon || undefined} className={soon ? "text-attention" : undefined}>in {span}</span>
            </>
          )}
          {model.next.slice(1).map((n) => ` · ${n}`).join("")}
        </p>
      )}
    </div>
  )
}

// ---- the words a reading cannot be shown in ------------------------------------------------------------------

/** What the strip or a Change when shows for a model reading `describeSchedule` cannot put into words: the
 *  human is never asked to confirm RRULE text. */
export const UNPHRASABLE_COPY = "That schedule is too intricate to show here. Try saying it more simply, like “every Friday at 9am”."

/** A rule `describeSchedule` cannot phrase: it falls back to the RRULE itself (`on the rule FREQ=…`). */
export function unphrasableRule(rrule: string, dtstart: string, tz: string): boolean {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok && describeSchedule(c.value).startsWith("on the rule")
}

/** The house's words for a rule, or the rule itself when it does not compile. */
export function describeRule(rrule: string, dtstart: string, tz: string): string {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok ? describeSchedule(c.value) : rrule
}

// ---- the drawer's Change when, its pure half ------------------------------------------------------------------
//
// What the preview under a schedule's When field shows for the words on screen. It lives here, beside the preview
// it decides, rather than in ScheduleDrawer.tsx, which a node test cannot load (it reaches a `.css` import) — so
// it is pinned in SchedulePreview.test.ts.
//
// The field means nothing but WHEN, so every answer the model gives is said: a refusal of the words ("doesn't say
// when it should run") is the answer to show, not a reason to keep quiet as the prompt box does.

export const CHANGE_WHEN_FAILED_COPY = "Couldn't read that just now. Press Enter to try again."
export const CHANGE_WHEN_BUDGET_COPY = "Press Enter to read it."

export type ChangeWhenView =
  /** Nothing to show yet: the words are waiting for the idle, or no read was ever made of them. */
  | { kind: "none" }
  /** The first read of these words is out, with nothing before it to show. */
  | { kind: "reading" }
  /** A reading: `fresh` for exactly the words on screen, else the last one, shown while they are read again. */
  | { kind: "model"; result: ModelReadOk; fresh: boolean }
  | { kind: "copy"; copy: string }

/** A model answer as the field shows it. */
function changeWhenAnswer(result: InterpretScheduleResult): ChangeWhenView {
  if (!result.ok) return { kind: "copy", copy: isFailedRead(result) ? CHANGE_WHEN_FAILED_COPY : result.error }
  // A rule the house cannot put into words would preview as `on the rule FREQ=…` with Save enabled, and once saved
  // the drawer's header and the project row would read it too: the copy instead, and no Save.
  if (unphrasableRule(result.rrule, result.dtstart, result.tz)) return { kind: "copy", copy: UNPHRASABLE_COPY }
  return { kind: "model", result, fresh: true }
}

/**
 * What the preview shows for the words on screen: their own answer, or — while they are read — the newest answer
 * before them (stale-while-revalidate), which the new one replaces in place. Save is only ever offered on a
 * `fresh` reading.
 *
 * `shown`: the panel is already up for this edit. It then never goes while the words are waited on — the reading
 * line holds its place until there is something else to say. Without this it opened at every word's end (a read
 * out) and closed at the next letter (words not asked about yet): five flashes of 132–215ms typing "every
 * Tuesday at 10am" before the first answer, the section under it jumping each time (fix round 2026-10-06, F2).
 */
export function changeWhenView({ view, stale, shown = false }: {
  /** What the reader knows about exactly the words on screen. */
  view: ModelReadView
  /** The newest answer known for earlier words of this edit (`useNewestAnswer`). */
  stale: InterpretScheduleResult | undefined
  shown?: boolean
}): ChangeWhenView {
  if (view.status === "answered") return changeWhenAnswer(view.result)
  if (view.status === "failed") return { kind: "copy", copy: CHANGE_WHEN_FAILED_COPY }
  if (view.status === "budget") return { kind: "copy", copy: CHANGE_WHEN_BUDGET_COPY }
  const before = stale ? changeWhenAnswer(stale) : undefined
  if (before?.kind === "model") return { ...before, fresh: false }
  return view.status === "reading" || shown ? { kind: "reading" } : { kind: "none" }
}
