// THE SNOOZE, STATED WHERE THE TRANSCRIPT ENDS. A wall-clock snooze (`snoozedUntil`) was legible only
// on hover — the rail hourglass's popover, the footer's presence glyph, the Wake button's title — so an
// opened thread said nothing about WHY it was parked in Snoozed or when it would come back (maintainer
// 2026-08-24: "it doesn't say that it's been snoozed. It doesn't say when the snooze expires"). This
// card sits at the bottom of the transcript, in the same runtime-status slot as the resting card, and
// it reads as a COUNTDOWN (same maintainer, same day): the remaining time is the headline, ticking
// live, with the wake instant and the one useful verb under it.
//
// It renders whenever the thread carries a FUTURE snooze, and it loses the slot to every harder state
// above it in ChatView's chain (a provider fault, a limit pause, a pending ask, a permission prompt,
// the working indicator) — a snooze on a running thread has not taken effect yet, and a snoozed thread
// holding an answerable question should show the question. It WINS the slot over the resting card: once
// the human has parked the thread, "awaiting background work" is not the state the park is about
// (same rule showsRestingCard already applies to the event-snooze).
import { useEffect, useState } from "react"
import { AlarmClock } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { futureSnoozedUntil } from "../groups.ts"
import { formatCountdown } from "../lib/durationLabels.ts"
import { formatSnoozeWake, snoozePromptPreview } from "../lib/snooze.ts"
import { showToast } from "../store.ts"
import { CARD_BODY, CARD_PRIMARY_ACTION, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

/** Does the CHAT show the snooze card at the bottom of this thread? A future wall-clock snooze is the
 *  whole gate — precedence against the working indicator, the ask cards and the resting card is the
 *  chain's job (ChatView), so this stays one fact both render paths and the row builder agree on. */
export function showsSnoozeCard(
  thread: Pick<ThreadView, "snoozedUntil"> | undefined,
  nowMs = Date.now(),
): boolean {
  return thread !== undefined && futureSnoozedUntil(thread, nowMs) !== undefined
}

// The card's own 1s clock. The shared useNowMs ticks at 30s, which is right for "4m ago" captions and
// wrong for a countdown — under an hour this card shows seconds, and a seconds digit that updates twice
// a minute reads as broken rather than as counting. One interval for the one card a thread view mounts.
function useCountdownNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return nowMs
}

export function SnoozeCard({ thread }: {
  thread: Pick<ThreadView, "id" | "sessionId" | "foreign" | "snoozedUntil" | "snoozePrompt">
}) {
  const nowMs = useCountdownNowMs()
  const [busy, setBusy] = useState(false)
  const until = futureSnoozedUntil(thread, nowMs)
  // The tick crossing the deadline unmounts the countdown on its own, without waiting for the server's
  // wake to land as a board delta — a card counting up past zero is the one state it must never show.
  if (!until) return null
  const wakeAt = Date.parse(until)
  // Sentence-position wake phrase — formatSnoozeWake capitalizes "Today"/"Tomorrow" for label use, and
  // this is the same fold snooze.ts's wakePhrase applies for the rail popover's sentences.
  const wake = formatSnoozeWake(until, nowMs).replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
  const prompt = thread.snoozePrompt?.trim()

  // Same RPC and same toast as the header snooze menu's Wake now — two doors, one action.
  async function wakeNow(): Promise<void> {
    setBusy(true)
    try {
      await rpc.setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId ?? "", until: null, prompt: null })
      showToast("Snooze cleared")
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Wake failed").slice(0, 100))
    } finally {
      setBusy(false)
    }
  }

  // The alarm clock, not the hourglass (2026-09-19): this is the human's own park, and the rail's row
  // for it wears the same mark (Sidebar.tsx alarmMark). The hourglass stays the worker's timer.
  return (
    <TranscriptCard data-snooze-card icon={AlarmClock} label="Snoozed">
      {/* The countdown IS the card (maintainer: "it should basically look like a countdown"), so it
          takes the headline scale. `tabular-nums` holds the digits to one width and formatCountdown
          holds the SHAPE (padded trailing unit), so the line ticks in place instead of reflowing. The
          title attribute carries the exact local instant for the reader who wants the precision the
          prose rounds off. */}
      <div
        data-snooze-countdown
        title={new Date(wakeAt).toLocaleString()}
        className="text-[22px] font-semibold leading-8 tracking-tight text-fg tabular-nums"
      >
        {formatCountdown(wakeAt - nowMs)}
      </div>
      <p className={CARD_BODY}>
        {prompt ? (
          // A snooze carrying a prompt is a scheduled BUMP — the wake resumes the agent with that text
          // (router.setThreadSnooze), so the follow-up is the fact worth a line, exactly as the rail's
          // "— then:" gloss treats it.
          <>Resumes {wake} and sends: “{snoozePromptPreview(prompt)}”</>
        ) : (
          // A plain snooze only re-surfaces the card for the human — the server's own description of
          // the deadline ("the card re-surfaces and the human acts").
          <>Returns to the queue {wake}.</>
        )}
      </p>
      {/* A foreign session's snooze is not editable (router.setThreadSnooze refuses it), so the verb
          would be a lie there — the card states the park and offers nothing. */}
      {thread.foreign !== true && (
        <CardActions>
          <button
            type="button"
            data-snooze-wake-now
            disabled={busy}
            onClick={() => void wakeNow()}
            className={`${CARD_PRIMARY_ACTION} disabled:cursor-not-allowed disabled:opacity-45`}
          >
            Wake now
          </button>
        </CardActions>
      )}
    </TranscriptCard>
  )
}
