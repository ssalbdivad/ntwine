// A TURN THAT HAS GONE SILENT — the server queues a thread whose turn is still in flight but has written
// nothing for a long stretch (board.ts quietTurnSince): a foreground call sitting at a prompt or a 2FA
// approval nobody can see, a wedged tool. The thread is still `running`, so the queue card's prompt box
// offers interrupt-and-send (⌘⏎), and that is the verb this card points at.
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { elapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

export function showsQuietTurnCard(thread: Pick<ThreadView, "kind" | "runtime" | "needsYou" | "quietTurnSince"> | undefined): boolean {
  return thread?.kind === "session" && thread.runtime === "running" && thread.needsYou === true && thread.quietTurnSince !== undefined
}

export function QuietTurnCard({ thread }: { thread: Pick<ThreadView, "quietTurnSince" | "backend"> }) {
  const now = useNowMs()
  const quiet = elapsedSince(thread.quietTurnSince, now)
  // Codex and ACP take no interrupt from Frizz (ThreadComposerBox canInterrupt); their card says so.
  const interruptible = thread.backend !== "codex" && thread.backend !== "acp"
  return (
    <TranscriptCard data-quiet-turn-card icon={Hourglass} label={quiet ? `No activity for ${quiet}` : "No activity"}>
      <p className={CARD_BODY}>
        The turn is blocked on one call and has written nothing since — often a command waiting at a prompt or a 2FA approval.
        {interruptible ? " ⌘⏎ in the box below interrupts it with your message." : " A reply here waits behind it."}
      </p>
    </TranscriptCard>
  )
}
