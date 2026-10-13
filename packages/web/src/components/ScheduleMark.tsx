import { Repeat } from "lucide-react"
import type { ThreadScheduleRef } from "@ntwine/shared"

// THE REPEAT GLYPH on a thread that a SCHEDULE started, or will start (ARCHITECTURE.md § Scheduled threads): its
// pending next run, a held row in Snoozed, and every run it has started. One small mark after the title —
// the rail's rows are their titles and nothing else (Sidebar.tsx ThreadRow), so the schedule is a glyph with
// a tooltip, never a chip — saying "this came from a schedule", with the schedule and its rule one hover
// away: "From Triage issues · every Monday at 9am".
//
// lucide's `Repeat`, CROPPED TO ITS INK like the ACP plug (ProviderMark.tsx AcpMark): its paths span x 3–21
// and y 2–22 of the 24-unit box, plus half the 2.5 stroke a side, so the viewBox below is the ink box and the
// caller's `ml-1` is 4px of ink gap, the same gap the provider mark keeps beside it. Stroke 2.5, not lucide's
// 2: at a 10px box the default pen draws 0.9px lines, which read as a fainter mark than the filled provider
// glyph next to it.
//
// VERTICALLY the box IS the ink, and an inline box with no text in it sits its bottom edge on the title's
// baseline, so `translate-y-[calc(H/2 - 0.5cap)]` puts the ink's centre on the cap band's in any font at
// any size — the browser computes it, nothing to re-measure when the type moves. Measured on the real rows
// (visual-review cap-band probe, sans = system-ui, dsf 2; ink centre minus cap-band centre, + = low):
// a flat `translate-y-px` (the provider marks' nudge) read +0.77px on the 13px row and +0.76px on the 15px
// semibold card title; untranslated it is -0.23px; with the cap term, 0.00 on both. The Claude asterisk
// beside it reads +0.27px on the same probe, and is left alone.
//
// HORIZONTALLY, ink to ink (geometry plus the 2.5 stroke's half): title → mark 3.52px on the row, against
// 3.64px from a title straight to its provider mark; mark → Claude asterisk 4.00px. 4.97px after the
// card's 15px title (`ml-1.5`).
export const SCHEDULE_MARK_GEOMETRY = {
  /** Beside a 13px row title (Sidebar.tsx ThreadRow). */
  row: "h-[10px] w-[9.11px] translate-y-[calc(5px_-_0.5cap)]",
  /** Beside a queue card's 15px semibold title (AllQueuesCard.tsx). */
  title: "h-[11.5px] w-[10.48px] translate-y-[calc(5.75px_-_0.5cap)]",
  /** Beside a phone row's 15.5px medium title (PhonePage.tsx ThreadRow), the card's ratio to its title.
   *  Measured at 420px, sans, dsf 2 (H ink read at 10x canvas size — at 1x Chrome rounds it to whole px):
   *  ink 12.0px tall on an 11.3px cap band; centre -0.35px (high) where Chrome resolves `1cap` to 12.00 for
   *  this title, 0.00 on a load where it resolved 11.30. `ml-1`: 4.2-5.4px of ink after the title, by its
   *  last letter's bearing (ml-1.5 drew 6.2-7.4). */
  phoneRow: "h-[12px] w-[10.93px] translate-y-[calc(6px_-_0.5cap)]",
  /** Beside the phone thread header's 16.5px semibold title (MobileThreadHeader.tsx): ink 12.5px on a
   *  12.1px cap band, centre +0.03px, 5.09px of ink after the title with `ml-1`. */
  phoneHeader: "h-[12.5px] w-[11.39px] translate-y-[calc(6.25px_-_0.5cap)]",
} as const

export function scheduleMarkLabel(schedule: Pick<ThreadScheduleRef, "title" | "describe">): string {
  return `From ${schedule.title} · ${schedule.describe}`
}

export function ScheduleMark({ schedule, size = "row", className = "" }: { schedule: ThreadScheduleRef; size?: keyof typeof SCHEDULE_MARK_GEOMETRY; className?: string }) {
  const label = scheduleMarkLabel(schedule)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-schedule-mark={schedule.pending ? "next" : "run"}
      className={`inline-flex shrink-0 text-muted-65 ${SCHEDULE_MARK_GEOMETRY[size]} ${className}`}
    >
      <Repeat aria-hidden="true" focusable="false" className="size-full" strokeWidth={2.5} viewBox="1.75 0.75 20.5 22.5" />
    </span>
  )
}
