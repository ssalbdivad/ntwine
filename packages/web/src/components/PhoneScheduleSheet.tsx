import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { ScheduleRunView, ScheduleView } from "@ntwine/shared"
import { useBackDismiss } from "../lib/backDismiss.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { formatSnoozeWake } from "../lib/snooze.ts"
import { proposedByLine, scheduleNextLabel } from "../lib/schedules.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { MobileBottomSheet } from "./MobileBottomSheet.tsx"
import { scheduleRunOpens, useScheduleActions, useScheduleProfileLabel, useScheduleQuery } from "./ScheduleDrawer.tsx"

// A SCHEDULE ON THE PHONE (ARCHITECTURE.md § Scheduled threads): the desktop drawer's reading in the phone's bottom
// sheet. Opened from the page's Schedules tab, from the repeat mark in a run's thread header, and from the
// line that opens a run's transcript.
//
// THE SAME DATA AND VERBS AS THE DRAWER (ScheduleDrawer.tsx useScheduleQuery / useScheduleActions), so the two
// never disagree on what Run now or Delete does or says. What the phone leaves out is the EDITING: no "Change
// when" and the prompt read-only — a rule re-read and a long prompt edited on a 390pt screen with the keyboard
// up is the desktop's job, and a schedule has no verb that cannot wait for it.
//
// MOUNTED MEANS OPEN, and the sheet takes its own history entry (lib/backDismiss), as the ⋯ sheet does: Back
// closes it first. A run opened from it closes the sheet and THEN opens the thread (`dismiss(then)`), so the
// thread's entry replaces nothing of the sheet's and Back from the thread lands where the sheet was opened.
//
// Its verbs are pinned under the reading (sticky at the sheet's bottom); Delete confirms in place — the sheet swaps to the question and its two answers — rather than over a
// dialog: a desktop dialog stacks under the sheet's layer on a phone, and the ⋯ sheet's sub-views swap the
// same way.

/** Section labels, the drawer's small caps at the phone's reading size. */
const LABEL = "text-[12px] font-medium uppercase tracking-wide text-muted-70"
/** The footer's buttons: the answer sheet's 46px pills, outlined. */
const OUTLINE = "flex h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-[12px] border border-border-strong px-4 text-[15px] font-medium outline-none active:bg-hover disabled:opacity-45"
const BUTTON = `${OUTLINE} text-fg`
const SOLID = "flex h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-[12px] bg-fg px-4 text-[15px] font-semibold text-bg outline-none active:opacity-90 disabled:opacity-40"

export function PhoneScheduleSheet({ scheduleId, projectId, onClose }: { scheduleId: string; projectId: string | undefined; onClose: () => void }) {
  const query = useScheduleQuery(scheduleId, projectId)
  const dismiss = useBackDismiss(onClose)
  const schedule = query.data?.schedule
  return (
    <MobileBottomSheet title={schedule?.title ?? "Schedule"} onRequestClose={() => dismiss()} dataAttr="data-mobile-schedule-sheet">
      {schedule ? (
        <ScheduleSheetBody schedule={schedule} history={query.data!.history} dismiss={dismiss} />
      ) : (
        <p className="px-[18px] pb-4 pt-1 text-[15px] text-muted">{query.isError ? "This schedule is gone." : "Loading…"}</p>
      )}
    </MobileBottomSheet>
  )
}

function ScheduleSheetBody({ schedule, history, dismiss }: { schedule: ScheduleView; history: ScheduleRunView[]; dismiss: (then?: () => void) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { setState, runNow, remove, busy } = useScheduleActions(schedule, () => dismiss())
  const profile = useScheduleProfileLabel(schedule)
  const openInPlace = useOpenThreadInPlace()
  // A run belongs to the schedule's project, which may not be the page's (All projects lists every one).
  const openRun = (slug: string, title?: string) =>
    dismiss(() => openInPlace({ slug: schedule.projectSlug, id: schedule.projectId, name: schedule.projectName }, slug, title))

  if (confirmDelete) {
    return (
      <div data-mobile-schedule-confirm className="flex flex-col gap-2 px-[18px] pb-1 pt-1">
        <p className="text-[16px] font-semibold leading-[22px] text-fg">{`Delete ${schedule.title}? Its past runs stay.`}</p>
        <p className="text-[14px] leading-5 text-muted">Its next run is removed with it. The threads it already started are not.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={remove.isPending} onClick={() => setConfirmDelete(false)} className={`${BUTTON} flex-1`}>
            Cancel
          </button>
          <button
            type="button"
            data-mobile-schedule-delete-confirm
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            className={`${SOLID} flex-1 !bg-danger-button/90 !text-white`}
          >
            {remove.isPending && <Loader2 size={15} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    )
  }

  const proposed = schedule.state === "proposed"
  const paused = schedule.state === "paused"
  return (
    <div data-mobile-schedule={schedule.id} data-mobile-schedule-state={schedule.state} className="flex flex-col">
      <div className="px-[18px] pb-3 pt-1">
        <h2 data-mobile-schedule-title className="m-0 text-[16px] font-semibold leading-[22px] text-fg">{schedule.title}</h2>
        <p className="m-0 truncate text-[13px] leading-[18px] text-muted">{`${schedule.projectName} · ${schedule.describe}`}</p>
      </div>

      <div className="flex flex-col gap-5 px-[18px] pb-4">
        {/* WHY IT IS NOT RUNNING, first, when it is not: the one thing here the human may need to act on. */}
        {proposed && (
          <Banner tone="attention" text={proposedByLine(schedule.createdBy) ?? "Proposed"}>
            <button type="button" data-mobile-schedule-turn-on className={SOLID} disabled={busy} onClick={() => setState.mutate("active")}>
              Turn on
            </button>
            <button type="button" data-mobile-schedule-discard className={BUTTON} disabled={busy} onClick={() => remove.mutate()}>
              Discard
            </button>
          </Banner>
        )}
        {paused && (
          <Banner tone={schedule.attention ? "attention" : "quiet"} text={schedule.pausedText ?? "Paused"}>
            <button type="button" data-mobile-schedule-resume className={BUTTON} disabled={busy} onClick={() => setState.mutate("active")}>
              Resume
            </button>
          </Banner>
        )}
        {schedule.state === "ended" && <Banner tone="quiet" text="Ended" />}

        <Echo schedule={schedule} openRun={openRun} />
        {schedule.condition && (
          <Section label="Condition">
            <p className="text-[14.5px] leading-[21px] text-fg/90">{schedule.condition}</p>
          </Section>
        )}
        <Section label="Prompt">
          <p data-mobile-schedule-prompt className="whitespace-pre-wrap break-words rounded-[10px] border border-border bg-bg px-3 py-2.5 text-[14.5px] leading-[21px] text-fg/90">
            {schedule.prompt}
          </p>
        </Section>
        <Section label="Runs on">
          <p className="text-[14.5px] leading-[21px] text-fg/90">{profile}</p>
        </Section>
        <History history={history} openRun={openRun} />
      </div>

      {/* Pinned to the sheet's bottom edge while the reading scrolls under it (sticky in the sheet's own
          scroller), so the verbs never sit below a long prompt and its history. */}
      <div data-mobile-schedule-actions className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-panel px-[18px] pt-3">
        <button type="button" data-mobile-schedule-run-now className={BUTTON} disabled={busy} onClick={() => runNow.mutate()}>
          {runNow.isPending ? "Starting…" : "Run now"}
        </button>
        {schedule.state === "active" && (
          <button type="button" data-mobile-schedule-pause className={BUTTON} disabled={busy} onClick={() => setState.mutate("paused")}>
            Pause
          </button>
        )}
        <span className="flex-1" />
        <button type="button" data-mobile-schedule-delete className={`${OUTLINE} text-danger-90`} disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={`m-0 ${LABEL}`}>{label}</h3>
      {children}
    </section>
  )
}

/** The drawer's banner, at the phone's size: its text over its buttons, which a 390pt row cannot hold beside it. */
function Banner({ tone, text, children }: { tone: "attention" | "quiet"; text: string; children?: ReactNode }) {
  return (
    <div
      data-mobile-schedule-banner={tone}
      className={`flex flex-col gap-2.5 rounded-[12px] border px-3.5 py-3 ${tone === "attention" ? "border-attention/35 bg-attention/[0.06]" : "border-border bg-panel-2/60"}`}
    >
      <p className={`m-0 text-[14.5px] leading-[21px] ${tone === "attention" ? "text-attention-soft" : "text-fg/85"}`}>{text}</p>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

/** The echo the human confirmed, the next few runs, and the next run itself — the held thread that stands
 *  for it, a tap away. */
function Echo({ schedule, openRun }: { schedule: ScheduleView; openRun: (slug: string, title?: string) => void }) {
  const now = useNowMs()
  const next = schedule.nextRun
  return (
    <section className="flex flex-col gap-0.5">
      <p data-mobile-schedule-echo className="m-0 text-[15.5px] leading-[22px] text-fg">{schedule.echo}</p>
      {schedule.nextLine && <p className="m-0 text-[13.5px] leading-[19px] text-muted">{schedule.nextLine}</p>}
      {next && schedule.state === "active" && (
        <p className="m-0 text-[13.5px] leading-[19px] text-muted">
          <button
            type="button"
            data-mobile-schedule-next-run
            onClick={() => openRun(next.slug, schedule.title)}
            className="-my-2.5 py-2.5 text-fg/85 underline decoration-border-strong underline-offset-2 outline-none active:text-fg"
          >
            Next run {scheduleNextLabel(schedule, now)}
          </button>
          {next.moved && ` · moved to ${formatSnoozeWake(next.at, now).replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}`}
        </p>
      )}
    </section>
  )
}

/** Every past run, newest first: its occurrence, then the server's line for it. A run whose thread still
 *  exists opens it; the rows are the phone's 44px tap targets, hairlined like the page's list. */
function History({ history, openRun }: { history: ScheduleRunView[]; openRun: (slug: string, title?: string) => void }) {
  return (
    <section className="flex flex-col">
      <h3 className={`m-0 pb-0.5 ${LABEL}`}>Runs</h3>
      {history.length === 0 ? (
        <p className="m-0 pt-1 text-[14.5px] leading-[21px] text-muted">No runs yet.</p>
      ) : (
        <ul data-mobile-schedule-history className="m-0 flex list-none flex-col p-0">
          {history.map((run, index) => {
            const quiet = run.state === "skipped" || run.state === "failed"
            const body = (
              <>
                <span className="shrink-0 tabular-nums text-muted">{run.when}</span>
                <span aria-hidden className="shrink-0 text-muted-50">·</span>
                <span className={`min-w-0 break-words ${quiet ? "text-muted" : run.threadState === "archived" ? "text-fg/70" : "text-fg/90"}`}>{run.label}</span>
              </>
            )
            // The line WRAPS rather than truncates: what it says after the run's handle ("started 2h late",
            // why it was skipped) is the part worth reading, and a phone's measure cut it to "start…".
            const row = `flex min-h-[44px] w-full min-w-0 items-baseline gap-2 py-[11px] text-left text-[14.5px] leading-[20px] ${index > 0 ? "border-t border-border/70" : ""}`
            return (
              <li key={run.id} data-mobile-schedule-run={run.state}>
                {scheduleRunOpens(run) ? (
                  <button type="button" onClick={() => openRun(run.threadSlug!, run.threadTitle)} title={run.reason ?? run.label} className={`${row} outline-none active:bg-hover`}>
                    {body}
                  </button>
                ) : (
                  <div className={row} title={run.reason ?? run.label}>{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
