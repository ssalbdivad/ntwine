import { useMemo, useState } from "react"
import { ArrowLeft, MoreHorizontal } from "lucide-react"
import { useBoard, useTranscript } from "../hooks.ts"
import { threadBySlug } from "../store.ts"
import { appPushedCurrentEntry } from "../lib/router.ts"
import { leaveFiledThread } from "../lib/mobileTriage.ts"
import { displayTitle } from "../groups.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { MOBILE_STATE_WORD, mobileThreadAge, mobileThreadState, turnStartedAt } from "../lib/mobileThread.ts"
import { ThreadActionsSheet, useModelEffortLabel } from "./MobileThreadActionsSheet.tsx"
import { ScheduleMark } from "./ScheduleMark.tsx"
import { PhoneScheduleSheet } from "./PhoneScheduleSheet.tsx"

// THE PHONE THREAD HEADER (mockup v2 §2). The desktop drawer's header is two rows — title and "Last
// active", then an icon strip and a bordered × — and at 390pt it spent 91.5px on controls a phone either
// cannot use or reaches more easily from a list. This is one 56px row: ← back, the
// title, a subtitle that says where the thread stands, and ⋯ for everything else.
//
// ← IS THE PLATFORM'S BACK. When the app pushed the thread's history entry (it was opened from the
// board, or anywhere else in this session) it pops that entry — `history.back()` — and the router's
// popstate unwinds the drawer exactly as the browser's own Back or Android's edge swipe would. So ←
// returns to whatever was under the thread, like Back does, and that is not always the board: a thread
// reached by a link inside another thread returns to that thread first. A reload keeps this true, because main.tsx steps off any history entry a
// sheet left behind (lib/backDismiss `stepOffStaleLayerEntries`). Reusing
// the desktop ×'s close here instead REPLACED the thread's entry with the board, which left two board
// entries in a row, so the next Back did nothing visible. Only a thread that arrived by a cold link (the
// entry the document loaded on — nothing of ours below it) closes the ×'s way and lands on the board.
// See `appPushedCurrentEntry` in lib/router.
//
// It does NOT take the drawer's initial focus the way × did (`data-dialog-initial-focus`): a
// programmatically focused button matches :focus-visible, so the page opened with a lit circle around ←.
// Focus falls back to the sheet itself, which draws nothing.
//
// The subtitle leads with the STATE because that is what a phone reader opens a thread to learn:
// "Needs you" in the accent (the one thing the accent is for), "Working" in the live green while a turn
// runs, "Snoozed" for any row the board files in Snoozed, otherwise "Rested" — then the age, then the
// model and effort. See lib/mobileThread.ts.
//
// Everything the desktop header and the prompt box's rail hold — Snooze, Goal, the registered files,
// Rename, Copy link, and Retry / Restart worker where the header offers them — is in the ⋯ sheet
// (ThreadActionsSheet).
export function MobileThreadHeader({ slug, onClose }: { slug: string; onClose: () => void }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const now = useNowMs()
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  // The same transcript query the conversation below already holds (one observer more, no extra read):
  // a running turn's age counts from the message that started it.
  const transcript = useTranscript(slug, { poll: running })
  const turnStart = useMemo(() => turnStartedAt(transcript.data?.messages ?? []), [transcript.data])
  const modelEffort = useModelEffortLabel(thread)
  if (!thread) return null
  const state = mobileThreadState(thread)
  const age = mobileThreadAge(thread, state, turnStart, now)
  const stateClass = state === "needs-you" ? "font-semibold text-accent" : state === "working" ? "font-semibold text-live" : ""
  const title = displayTitle(thread)
  return (
    <header
      data-thread-header
      data-mobile-thread-header
      // `pl-1` / `pr-[5px]` are measured: the ← paints 14.5px of its 21px glyph and the ⋯ 16px, so the
      // mockup's 4px / 6px put their ink 18.75px and 20px from the screen edges; 5px on the right brings
      // the pair within a pixel of each other (scripts/ink-gaps.mjs, dsf 4, sans).
      className="flex min-h-14 shrink-0 items-center gap-0.5 border-b border-border bg-panel py-1 pl-1 pr-[5px]"
    >
      <button
        type="button"
        aria-label="Back"
        data-mobile-thread-back
        onClick={() => {
          if (appPushedCurrentEntry()) history.back()
          else onClose()
        }}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <ArrowLeft size={21} strokeWidth={2.1} />
      </button>
      <div className="min-w-0 flex-1 pl-0.5 leading-[1.25]">
        {/* A schedule's run, or its next run: the repeat mark after the title, outside its ellipsis. A phone has
            no hover for the mark's tooltip, so the mark is a button that opens the schedule's sheet — the
            same door the desktop's run divider is. The type is on the row so the mark's `cap` is the title's. */}
        <div className="flex min-w-0 items-baseline text-[16.5px] font-semibold tracking-[-0.01em]">
          <div data-mobile-thread-title className="min-w-0 truncate" title={title}>{title}</div>
          {thread.schedule && (
            <button
              type="button"
              data-mobile-thread-schedule
              onClick={() => setScheduleOpen(true)}
              // The 12px mark, tappable across the 44px the header's other buttons give: the ::after
              // overhangs the box without moving it.
              className="relative ml-1 flex shrink-0 rounded-sm outline-none after:absolute after:-inset-x-2 after:-inset-y-4 after:content-[''] focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            >
              <ScheduleMark schedule={thread.schedule} size="phoneHeader" />
            </button>
          )}
        </div>
        <div data-mobile-thread-subtitle data-state={state} className="truncate text-[13px] text-muted">
          <span className={stateClass}>{MOBILE_STATE_WORD[state]}</span>
          {age && <> · {age}</>}
          {modelEffort && <> · {modelEffort}</>}
        </div>
      </div>
      <button
        type="button"
        aria-label="Thread actions"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        data-mobile-thread-more
        onClick={() => setSheetOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <MoreHorizontal size={21} strokeWidth={2.1} />
      </button>
      {/* Mark as done from the sheet leaves the thread the way the bottom bar's Done does — the next
          thread that needs you, or back to the board — not the desktop close (lib/mobileTriage). */}
      {scheduleOpen && thread.schedule && <PhoneScheduleSheet scheduleId={thread.schedule.id} projectId={undefined} onClose={() => setScheduleOpen(false)} />}
      {sheetOpen && <ThreadActionsSheet slug={slug} onClose={() => setSheetOpen(false)} onArchived={() => leaveFiledThread(slug)} />}
    </header>
  )
}
