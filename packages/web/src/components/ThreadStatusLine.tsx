import type { ReactNode } from "react"
import { isActivelyRunning, type ThreadView } from "@ntwine/shared"
import { formatFixedDuration } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"

// THE THREAD'S LIVE STATUS — what is happening in it NOW (server periodic-status.ts), set beside a NAME
// that stays put (David 2026-09-29: the name is one or two words for the subject; what the thread is
// doing moves separately). Rendered at the END of a header's metadata line — the queue card's
// "project · Ready 9m ago" and the drawer's "READY · Last active 9m ago" — so it costs the header no
// height and the card nothing under it moves when the first status lands.
//
// It takes only the room the line has LEFT (`flex-1`, i.e. a zero flex-basis): the project chip and the
// time keep exactly the width they had before a status existed, and the status truncates into the rest.
// A shrink factor cannot say that — measured at 420px on the queue card, even `shrink-[100]` still took
// half a pixel off the project chip, which is enough to cut "names-proj" to "names-p…".
//
// NOT on the rail. A second line under a rail row is exactly what the rail refuses (Sidebar.tsx "A ROW
// IS ITS TITLE"); there the status rides the row indicator's tooltip.
//
// A shade stronger than the time beside it (fg/85, the project chip's weight, against the time's muted
// grey): the time is a reading ABOUT the thread, the status is what the thread is doing.
//
// WHILE THE THREAD WORKS the status names the task it is on (server live-status.ts) and carries how long
// it has been on it — `statusSince` only moves when the task does, so this is the task's clock, not the
// turn's. The clock never truncates: the status gives up its room first, and the clock sits right after
// the text rather than at the far end of the line.
// "Working" is the band's own reading (isActivelyRunning), so the clock shows exactly when the header's
// stamp says WORKING — a turn in flight, or a rest held open by a live shell or sub-agent.
type StatusThread = Pick<ThreadView, "statusLine" | "statusSince"> & Partial<ThreadView>

/** How long a WORKING thread has been on the task its status names (`4m`, `1h 12m`), else undefined. */
export function statusElapsed(thread: StatusThread, nowMs: number): string | undefined {
  if (!isActivelyRunning(thread as ThreadView) || !thread.statusLine?.trim() || !thread.statusSince) return undefined
  const since = Date.parse(thread.statusSince)
  if (!Number.isFinite(since)) return undefined
  return formatFixedDuration(Math.max(0, nowMs - since)) || undefined
}

export function ThreadStatusLine({ thread, lead }: { thread: StatusThread; lead?: ReactNode }) {
  const nowMs = useNowMs()
  const text = thread.statusLine?.trim()
  if (!text) return null
  const elapsed = statusElapsed(thread, nowMs)
  return (
    <>
      {lead}
      <span data-thread-status className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-fg/85" title={text}>{text}</span>
        {elapsed && <span data-thread-status-elapsed className="shrink-0 tabular-nums">{elapsed}</span>}
      </span>
    </>
  )
}
