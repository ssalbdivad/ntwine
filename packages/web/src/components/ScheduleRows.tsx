import { useQuery } from "@tanstack/react-query"
import { Repeat } from "lucide-react"
import type { ScheduleView } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"
import type { QueuesProject } from "../lib/allQueues.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { pushScheduleDrawer } from "../store.ts"

// The thread row's geometry (Sidebar.tsx ThreadRow), so a schedule reads as more of the same list.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 py-0.5 pl-5 pr-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"

/**
 * A project's SCHEDULES, listed in place under its row when its fourth count is open (plans/scheduled-
 * threads.md §8) — not a dialog: every count on the row opens its rows here, and this one does too. Read
 * when the band opens, through the project's own client, and again whenever the poll's count for it moves.
 *
 * A row is the thread row's anatomy (Sidebar.tsx ThreadRow) so the band reads as more of the same list: the
 * repeat glyph in the indicator column, the title, the rule inline in grey after it the way a working
 * thread's status sits, and the next run in the rest-time column — `in 3h`, or `Paused` / `Proposed` when it
 * will not run on its own, warning-toned when that is ntwine's doing or a proposal's. A click opens the
 * schedule's drawer.
 */
export function ScheduleRows({ project, count, attention }: { project: QueuesProject; count: number; attention: boolean }) {
  const list = useQuery({
    // The poll's count and attention ride the key, so the list is read again the moment either moves.
    queryKey: [...scheduleKeys.list(project.id), count, attention],
    queryFn: () => projectRpc(project.id).listSchedules({}),
    enabled: project.open,
    // The next-run column counts down on the shared clock; the instants themselves move only when a run
    // starts, which the poll's count does not see.
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
  if (!list.data) {
    return <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">Loading…</div>
  }
  return <>{list.data.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />)}</>
}

function ScheduleRow({ schedule }: { schedule: ScheduleView }) {
  const now = useNowMs()
  const next = scheduleNextLabel(schedule, now)
  // Dimmed like a Snoozed row when it will not run on its own — unless that wants the human, which is the
  // one reading on this band that must not recede.
  const dim = schedule.state !== "active" && !schedule.attention
  return (
    <div data-xq-schedule-row={schedule.id} data-xq-schedule-state={schedule.state} className={`${ROW_CLASS} ${dim ? "sidebar-row-dim" : ""}`}>
      <button
        type="button"
        onClick={() => pushScheduleDrawer(schedule.id, schedule.projectId)}
        title={schedule.pausedText ?? schedule.echo}
        className={ROW_BUTTON_CLASS}
      >
        <span className={`${INDICATOR_SLOT} text-muted-60`}>
          <Repeat size={11} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className={`min-w-0 max-w-full shrink-0 break-words text-[13px] leading-[19px] ${dim ? "text-fg/75" : "text-fg/90"}`}>{schedule.title}</span>
            <span data-xq-schedule-rule className="min-w-0 flex-1 truncate text-[12px] leading-[19px] text-muted-70">{schedule.describe}</span>
          </span>
          <span data-xq-schedule-next className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] ${schedule.attention ? "text-attention-soft" : "text-muted-55"}`}>
            {next}
          </span>
        </span>
      </button>
    </div>
  )
}
