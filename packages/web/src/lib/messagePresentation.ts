import { BURIED_ANSWERS_HEADER, parseParkWake, userCommandDisplayText, type TranscriptMessage } from "@frizz/shared"

// Rendering-only text choice. The server keeps a generated prompt's full `text` for transcript logic
// and supplies `displayText` only when an exact presentation boundary was validated. A USER COMMAND
// reads as what was typed (`/commit fix the tests`), never as the prompt it expanded to — on every
// backend and on the optimistic bubble alike, which is why this is read here and not per transcript.
export function messagePresentationText(message: Pick<TranscriptMessage, "text" | "displayText">): string {
  const text = message.displayText ?? message.text
  return userCommandDisplayText(text) ?? text
}

// The CURRENT ASK: the most recent user turn the HUMAN is actually waiting on an answer to. It
// supplies the retry text after a provider fault, so "who wrote it" decides it — not the `user` role,
// which the transcript also uses for machine-written turns.
//
// Excluded: a QUEUED/optimistic follow-up (it has not landed yet), a SUB-AGENT's upward report
// (`peerFrom`), a coordinator/peer instruction delivered into a CHILD (`agentInstruction`), and another
// thread messaging this one (`sessionPeer`). None is
// an ask or anything to retry; a fault retry would resend another agent's words as the human's.
// -1 when the transcript holds no human turn yet.
export function lastAskIndex(messages: readonly Pick<TranscriptMessage, "role" | "queued" | "peerFrom" | "agentInstruction" | "sessionPeer">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && !m.peerFrom && !m.agentInstruction && !m.sessionPeer) return i
  }
  return -1
}

export type HumanTurnLike = Pick<TranscriptMessage, "role" | "text"> &
  Partial<Pick<TranscriptMessage, "displayText" | "kind" | "queued" | "wake" | "peerFrom" | "agentInstruction" | "spinoff" | "sessionPeer">>

// THE MOST RECENT INTERACTION — the last turn the human themself put into the thread. The QUEUE CARD
// opens here: its handoff quotes this message (server router.ts `handoffOf`), and its transcript, opened
// in place, starts at it, so everything before it is history behind "Load earlier messages".
//
// Upstream's own function (lib/messagePresentation.ts at 0a3b9139), restored 2026-10-06 when the card's
// transcript came back — and held to the SERVER's rule rather than upstream's copy of it, because the card
// shows both halves at once: the handoff the server cut and the transcript this cuts. The server's
// `isHumanTurn` has since grown three cases upstream's web copy never had, and a disagreement would open
// the transcript on a different message than the handoff it replaces:
//   • a `kind` row (an event line, a reasoning summary) is punctuation, never a turn;
//   • a SPINOFF request, and a turn with nothing in it, are not the human speaking here;
//   • an "Ask for update" click IS the human's turn, though it rides in as a park wake: the progress note
//     under it is the reply to the click (router.ts isUpdateRequest).
// Upstream's copy has since grown one of its own: a `sessionPeer` record is another thread messaging this
// one (upstream ed99e01c), not the operator.
//
// Anything frizz composed is out, not just anything frizz delivered. A `wake` user record is frizz writing
// as the user — the Goal delivery, the sign-off reminder, a watcher wake — and cutting there opened the card
// on frizz's own boilerplate with the human's task hidden above it (maintainer 2026-08-12: "queue cards
// STILL need to go all the way back to the last user message"). A `peerFrom` record is a SUB-AGENT
// reporting up, an `agentInstruction` a coordinator speaking into a CHILD, and a QUEUED send has not been
// delivered, so nothing after it is a reply to it.
//
// …EXCEPT THE ONE TURN FRIZZ DELIVERS THAT THE HUMAN WROTE: the answer to a REGISTERED question
// (`frizzctl ask`). It rides in as a scheduler wake because the human may have answered while the
// worker's process was down, so `wake` alone cannot decide the writer; the answers header (shared
// questionAnswerMessage) does (maintainer 2026-08-31: "the cue card should only go back to the most
// recent user interaction").
//
// 0 — the whole loaded transcript — when the human has written nothing in it yet.
export function lastHumanTurnIndex(messages: readonly HumanTurnLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user" || m.kind || m.queued || m.peerFrom || m.agentInstruction || m.spinoff || m.sessionPeer) continue
    const said = (m.displayText ?? m.text).trim()
    if (!said) continue
    if (m.wake && !said.startsWith(BURIED_ANSWERS_HEADER) && parseParkWake(said)?.kind !== "requested") continue
    return i
  }
  return 0
}
