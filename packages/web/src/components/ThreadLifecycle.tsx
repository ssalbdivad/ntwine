import { useRef, useState, type ReactNode } from "react"
import { Bot, Check, Inbox, Loader2, SquareTerminal } from "lucide-react"
import type { CompletionHold, ThreadView } from "@ntwine/shared"
import { useThreadApi, useThreadIsForeignToPage } from "../api/threadApi.tsx"
import { futureSnoozedUntil } from "../groups.ts"
import { showToast } from "../store.ts"
import { threadLifecycleAvailability, completionArchivesImmediately, completionHoldSummary } from "../lib/threadLifecycle.ts"
import { markArchived, clearArchived } from "../lib/optimisticArchive.ts"
import { useAfterScopedWrite } from "../lib/scopedWrite.ts"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { AGENT_GLYPH_STROKE, CHILD_ARROW, CHILD_ARROW_CLASS } from "../lib/childOps.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { SnoozeMenu } from "./SnoozeMenu.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// THE WHOLE-THREAD LIFECYCLE VERBS, at the far right of a thread header's action strip: an alarm clock
// that snoozes and a check that marks the thread done. Both headers render it — the queue card's and the
// drawer's — so the two surfaces cannot drift.
//
// They lived in a footer strip under the prompt box until 2026-10-05, beside the context reading and
// the goal. The maintainer gave the thread's two edges one job each: the HEADER manages the thread as a
// whole (what it is, how full its context is, the views onto it, the verbs that park or finish it), and
// the BOTTOM steers the run (what is outstanding, the prompt box, the goal beside send). "Everything
// that's like chat management stuff … goes in the top, and then stuff that relates to the current
// running of the chat and ways to steer it go … in the prompt box at the bottom." So the context reading
// moved up beside "Last active" (ContextMeter), the goal moved into the prompt box's rail
// (RecurringPromptControl), and the footer went.
//
// BARE ICONS in the strip's own 28px squares, not the labelled buttons they replace — "those icons are
// both just incredibly clear what they are" — with their names one hover away like every other header
// icon. A hairline rule holds them apart from the view controls before them; `mx-2.5` puts 20px of ink
// before it and 19.5px after it on a real queue card, the strip's own icon-to-icon rhythm (20–21px;
// clock to check 18.25px), so the rule groups without crowding (scripts/ink-gaps.mjs, dsf 4,
// 2026-10-05). After the Retry PILL the left margin widens (styles.css, `[data-header-pill]`): a
// bordered pill has no dead space, and on `mx-2.5` it sat 12px off the rule against 19.5px on the other
// side. The check is LAST: it is the verb a resting card most often ends on.
//
// A DONE thread states the state instead of offering the verbs (DoneReadout), because there is no
// Reopen — a message reopens it. An unowned thread gets nothing at all: ntwine recorded no lifecycle for
// it to vouch for.
export function ThreadLifecycleActions({
  thread,
  onArchived,
  onDismissCancel,
  onCompleted,
  onSnoozed,
  onUnsnoozed,
  projectName,
  leading,
  className = "",
}: {
  thread: ThreadView
  onArchived?: () => void
  // Undo an OPTIMISTIC dismissal (see StateButton): the queue passes this so a card that faded on click
  // can be un-hidden the instant the server declines to complete (needs confirmation, or errors). Absent
  // ⇒ the button stays non-optimistic (the drawer, where there is no queue card to reinstate).
  onDismissCancel?: () => void
  // The server recorded Done (StateButton `onCompleted`).
  onCompleted?: () => void
  onSnoozed?: () => void
  // The snooze toast's Undo (SnoozeMenu `onUndone`).
  onUnsnoozed?: () => void
  // A cross-project card names its own project in the snooze toast (SnoozeMenu `projectName`).
  projectName?: string
  // A surface's own whole-thread verb, after the rule and before the clock — the cross-project queue
  // card's Mark as read (AllQueuesCard), a verb that, like these two, takes the card off the queue.
  leading?: ReactNode
  // The group's box, for the caller's edge trim when the cluster closes its header.
  className?: string
}) {
  const available = threadLifecycleAvailability(thread)
  if (!available.lifecycle) return null
  return (
    // A named group, as the footer this replaced was a named landmark: "Thread lifecycle actions" is
    // how a screen reader finds the verbs at the end of a header full of other icons.
    <span data-thread-lifecycle role="group" aria-label="Thread lifecycle actions" className={`flex shrink-0 items-center gap-0.5 ${className}`}>
      <span aria-hidden data-lifecycle-rule className="mx-2.5 h-4 w-px shrink-0 bg-border" />
      {!available.done && leading}
      {available.snooze && <SnoozeMenu thread={thread} projectName={projectName} onSnoozed={onSnoozed} onUndone={onUnsnoozed} />}
      {available.done ? (
        <MoveToReadyButton thread={thread} />
      ) : (
        /* `command`: THE copy the `d` shortcut presses (lib/keyboardRuntime.ts) — the header's, not the
            in-chat done card's second one. */
        <StateButton thread={thread} onArchived={onArchived} onDismissCancel={onDismissCancel} onCompleted={onCompleted} iconOnly command />
      )}
    </span>
  )
}

type MoveToReadyOptions = {
  thread: ThreadView
  onMoved?: () => void
}

/** Shared Move-to-Ready mutation (reopen Done, wake Snoozed, or unpark Waiting) with toast + Undo. */
export function useMoveToReady({ thread, onMoved }: MoveToReadyOptions) {
  const api = useThreadApi()
  const overlayRail = !useThreadIsForeignToPage()
  const afterWrite = useAfterScopedWrite()
  const [busy, setBusy] = useState(false)

  async function moveToReady(): Promise<boolean> {
    const wasArchived = thread.state === "archived" || thread.archived === true
    const snoozedUntil = futureSnoozedUntil(thread)
    const previousSnooze = snoozedUntil ? { until: snoozedUntil, prompt: thread.snoozePrompt ?? null } : null
    const sessionId = thread.sessionId ?? ""
    setBusy(true)
    if (wasArchived && overlayRail) clearArchived(thread.id)
    try {
      await api.setThreadState({ slug: thread.id, state: "open" })
      afterWrite()
      const undo = wasArchived
        ? async () => {
            try {
              if (overlayRail) markArchived(thread.id)
              await api.setThreadState({ slug: thread.id, state: "archived" })
              afterWrite()
              showToast("Returned to Done")
            } catch (error) {
              if (overlayRail) clearArchived(thread.id)
              showToast((error instanceof Error ? error.message : "Undo failed").slice(0, 100))
            }
          }
        : previousSnooze
          ? async () => {
              try {
                if (Date.parse(previousSnooze.until) <= Date.now()) return
                await api.setThreadSnooze({ slug: thread.id, sessionId, ...previousSnooze })
                afterWrite()
                showToast("Snooze restored")
              } catch (error) {
                showToast((error instanceof Error ? error.message : "Undo failed").slice(0, 100))
              }
            }
          : undefined
      showToast("Moved to Ready", undo ? { action: { label: "Undo", run: () => void undo() } } : undefined)
      onMoved?.()
      return true
    } catch (error) {
      showToast(`Couldn’t move to Ready: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, moveToReady }
}

function MoveToReadyButton({ thread }: { thread: ThreadView }) {
  const { busy, moveToReady } = useMoveToReady({ thread })
  const label = "Move to Ready"
  return (
    <Tooltip label="Move to Ready (reopen)">
      <button
        type="button"
        data-thread-reopen
        disabled={busy}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void moveToReady()}
        className={HEADER_ICON_CLASS}
      >
        {busy ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <Inbox size={14} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}

type CompleteThreadOptions = {
  thread: ThreadView
  onArchived?: () => void
  onDismissCancel?: () => void
  onCompleted?: () => void
}

/** Shared Mark-as-done mutation + live-work confirmation dialog state, used by StateButton and ThreadCategoryMenu. */
export function useCompleteThread({ thread, onArchived, onDismissCancel, onCompleted }: CompleteThreadOptions) {
  const api = useThreadApi()
  const overlayRail = !useThreadIsForeignToPage()
  const afterWrite = useAfterScopedWrite()
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [hold, setHold] = useState<CompletionHold | undefined>(undefined)
  const lastUserAt = useRef(thread.lastUserAt)
  lastUserAt.current = thread.lastUserAt
  const [confirmUserAt, setConfirmUserAt] = useState<string | undefined>(undefined)
  const dialogOpen = confirmOpen && thread.lastUserAt === confirmUserAt
  const [stops, setStops] = useState<ReadonlySet<string>>(new Set())

  const complete = (terminateLive: boolean, optimistic = false) => {
    setPending(true)
    if (optimistic) onArchived?.()
    const expectsArchive = terminateLive || completionArchivesImmediately(thread)
    if (expectsArchive && overlayRail) markArchived(thread.id)
    api
      .completeThread({ slug: thread.id, sessionId: thread.sessionId ?? "", terminateLive, ...(terminateLive && stops.size > 0 ? { stopTerminals: [...stops] } : {}) })
      .then((result) => {
        if (result.needsConfirmation) {
          if (overlayRail) clearArchived(thread.id)
          if (optimistic) onDismissCancel?.()
          setHold(result.hold)
          setStops(new Set())
          setConfirmUserAt(lastUserAt.current)
          setConfirmOpen(true)
          setPending(false)
          return
        }
        setConfirmOpen(false)
        afterWrite()
        showToast("Done")
        if (!optimistic) onArchived?.()
        onCompleted?.()
      })
      .catch((error) => {
        if (overlayRail) clearArchived(thread.id)
        if (optimistic) onDismissCancel?.()
        showToast(`Couldn’t finish: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }

  const toggleStop = (id: string) =>
    setStops((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return {
    pending,
    dialogOpen,
    hold,
    stops,
    toggleStop,
    complete,
    closeDialog: () => {
      if (!pending) setConfirmOpen(false)
    },
  }
}

type CompletionConfirmDialogProps = {
  open: boolean
  pending: boolean
  hold: CompletionHold | undefined
  stops: ReadonlySet<string>
  onToggleStop: (id: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function CompletionConfirmDialog({ open, pending, hold, stops, onToggleStop, onClose, onConfirm }: CompletionConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
      // A cut-off worker has no session left to end; the question is whether an unfinished thread
      // should be filed as done at all (lib/threadLifecycle.ts completionHoldSummary).
      title={hold?.cutOff ? "Mark an unfinished thread done?" : "End this session?"}
      className="w-[390px] max-w-[92vw]"
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            {hold?.cutOff ? "Mark done anyway" : "End session & mark done"}
          </button>
        </>
      }
    >
      <CompletionHoldBody hold={hold} stops={stops} onToggle={onToggleStop} />
    </Dialog>
  )
}

// The header's check (ThreadLifecycleActions, `iconOnly`), and also rendered — deliberately redundant —
// as a white primary button at the bottom of the in-chat ```done card (see FenceCard) and as a row in
// the phone's ⋯ sheet. Same completion mutation and live-session confirmation flow; only the chrome
// differs, via `className` or `iconOnly`.
export function StateButton({
  thread,
  onArchived,
  onDismissCancel,
  onCompleted,
  className = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 hover:bg-panel-2 hover:text-fg",
  iconClassName = "",
  iconSize = 12,
  iconOnly = false,
  command = false,
}: {
  thread: ThreadView
  onArchived?: () => void
  onDismissCancel?: () => void
  onCompleted?: () => void
  className?: string
  iconClassName?: string
  iconSize?: number
  iconOnly?: boolean
  command?: boolean
}) {
  const { pending, dialogOpen, hold, stops, toggleStop, complete, closeDialog } = useCompleteThread({
    thread,
    onArchived,
    onDismissCancel,
    onCompleted,
  })
  const canOptimistic = !!onArchived && !!onDismissCancel && completionArchivesImmediately(thread)
  const doneKeys = useShortcutLabel("thread.done")
  const doneTitle = command ? withShortcut("Mark as done", doneKeys) : "Mark as done"
  return (
    <>
      {iconOnly ? (
        <Tooltip label={doneTitle}>
          <button
            type="button"
            onClick={() => complete(false, canOptimistic)}
            disabled={pending}
            aria-label="Mark as done"
            data-command={command ? "done" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            className={HEADER_ICON_CLASS}
          >
            <Check size={15} strokeWidth={2} />
          </button>
        </Tooltip>
      ) : (
        <button
          type="button"
          // The server owns the execution verdict. A live worker can be resting between turns, in
          // which case Done should immediately stop it and archive the thread.
          onClick={() => complete(false, canOptimistic)}
          disabled={pending}
          aria-label="Mark as done"
          title={doneTitle}
          data-command={command ? "done" : undefined}
          onMouseDown={(event) => event.preventDefault()}
          className={`flex items-center gap-1 font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45 ${className}`}
        >
          <Check size={iconSize} className={iconClassName} />
          Mark as done
        </button>
      )}
      <CompletionConfirmDialog
        open={dialogOpen}
        pending={pending}
        hold={hold}
        stops={stops}
        onToggleStop={toggleStop}
        onClose={closeDialog}
        onConfirm={() => complete(true, false)}
      />
    </>
  )
}

// The confirm dialog's body. Ending a session kills its whole process tree, so this names what is
// about to die: the executing turn and/or every live sub-agent, and every terminal on the thread still
// running — the agent's and yours, one group — counted and listed by label. The human clicked Done
// believing the thread was finished — the specific "2 terminals: `Watch CI`, `vite dev`" is the
// correction, and a bare "still running" was not.
//
// A TERMINAL'S OWNER is the strip's own mark: the bot for the agent's, the terminal square for yours
// (ThreadTerminals ProcessRow), after the ⤷, at the text's size. Baseline geometry, as the header's
// checkout token: the glyph's box stands on the baseline and `1cap` lifts its centre onto the cap band.
function HoldOwnerGlyph({ owner }: { owner: "agent" | "human" }) {
  const Glyph = owner === "agent" ? Bot : SquareTerminal
  return (
    <Glyph
      aria-label={owner === "agent" ? "The agent's" : "Yours"}
      data-hold-owner={owner}
      strokeWidth={owner === "agent" ? AGENT_GLYPH_STROKE : 2}
      className="h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted-60"
    />
  )
}

function CompletionHoldBody({ hold, stops, onToggle }: { hold: CompletionHold | undefined; stops: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const summary = completionHoldSummary(hold)
  return (
    <div data-completion-hold className="flex flex-col gap-2 p-4 text-[12px] leading-relaxed text-muted">
      <p>{summary.lead}</p>
      {summary.groups.map((group) => (
        <div key={group.kind} className="flex flex-col gap-0.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-fg/70">{group.heading}</div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex min-w-0 items-baseline gap-1.5">
                {/* The same ⤷ token every child row uses (lib/childOps.ts). This list is prose inside a
                    dialog, not an operations surface, so it stops at the arrow: no liveness mark, no
                    drill-in, no dismiss — hence the tokens rather than ChildOpRow itself. */}
                <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
                {item.owner ? <HoldOwnerGlyph owner={item.owner} /> : null}
                {/* A terminal THREAD (`id`) is named by its command, whoever started it, and a command is set in
                    mono on every surface (the strip, the rail, the drawer's title) — here too, a step smaller so
                    mono's wider face reads at the prose's size (the rail's 11.5-in-12). The agent's background
                    shells are named by description. */}
                <span className={`min-w-0 truncate text-fg/80 ${item.id ? "font-mono-keep text-[11.5px]" : ""}`}>{item.label}</span>
                {/* Stale is why we ask rather than proof of life: say so instead of implying either. */}
                {item.stale && <span className="shrink-0 text-[11px] text-muted-60">no recent output</span>}
                {/* A terminal this thread started outlives its Done unless ticked here. The box's `0.18em` puts its
                    centre on the word's cap band: `translate-y-[1px]` left it 1.00px high at 11px sans (dsf 6,
                    box mid vs baseline − cap/2), 0.00 after. */}
                {item.id ? (
                  <label data-hold-stop={item.id} className="ml-auto flex shrink-0 cursor-pointer items-baseline gap-1 pl-2 text-[11px] text-muted-70">
                    <input type="checkbox" checked={stops.has(item.id)} onChange={() => onToggle(item.id!)} className="translate-y-[0.18em] accent-[var(--color-fg)]" />
                    Stop
                  </label>
                ) : null}
              </li>
            ))}
            {group.overflow > 0 && <li className="pl-[15px] text-muted-60">+{group.overflow} more</li>}
          </ul>
        </div>
      ))}
      <p>{summary.trailer}</p>
    </div>
  )
}
