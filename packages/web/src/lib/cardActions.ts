import { parseCardAction, type CardAction, type TranscriptMessage } from "@ntwine/shared"
import { KEEP_WORKING_LABEL, KEEP_WORKING_MARKER } from "./keepWorking.ts"
import { STEPS_DONE } from "./awaitingPresentation.ts"

// CARD ACTIONS in the transcript (shared parseCardAction): a message a button sent for the human — the
// resting card's Continue, the steps card's Done, Retry / Continue now, Restart agent. Each is drawn as
// their one-line marker (CardActionMarker.tsx), never as a bubble of the words the worker reads.

type CardActionCopy = {
  /** The one line the click leaves on the human's side of the conversation. */
  marker: string
  /** What Edit on a failed send puts in the prompt box: the button's words, not the worker's. */
  editText: string
}

export const CARD_ACTION_COPY: Record<CardAction, CardActionCopy> = {
  "keep-working": { marker: KEEP_WORKING_MARKER, editText: KEEP_WORKING_LABEL },
  "steps-done": { marker: "Marked the steps done", editText: STEPS_DONE },
  retry: { marker: "Retried", editText: "Continue where you left off." },
  "restart-worker": { marker: "Restarted the agent", editText: "Continue where you left off." },
}

/** Which card action this user turn is, if the chat draws it as one. `cardAction` (and the older
 *  `keepWorking`) is the server's tell (transcript.ts userProjection, delivery-ledger.ts); the text read
 *  covers the optimistic copy, which no projection has seen. */
export function cardActionOf(m: Pick<TranscriptMessage, "text" | "keepWorking" | "cardAction">): CardAction | undefined {
  return m.cardAction ?? (m.keepWorking ? "keep-working" : parseCardAction(m.text))
}
