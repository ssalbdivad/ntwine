import { useEffect, useRef } from "react"
import { proxy, useSnapshot } from "valtio"

// HOW THE PROMPT BOX'S SEND GOES OUT while the agent is working (maintainer 2026-10-11). The button
// always reads "Send"; its caret menu ticks one of two rows:
//
//   steer — the message is handed to the agent now and read at its next step. The default, and what
//           every send was before the menu existed.
//   queue — Frizz keeps the message until the agent comes to rest, then delivers it as the next turn.
//
// A third way, the FORCED send that interrupts the turn, is deliberately not a row: it stays on
// ⌘/Ctrl-Enter and on the ↑ beside a waiting bubble.
//
// PER THREAD, IN MEMORY, AND BACK TO STEER WHEN THE AGENT RESTS. Queueing is a decision about the turn
// in front of the operator — "not now, after this" — so it ends with that turn: a tick that outlived it
// would silently hold the first message of some later turn, which nobody asked for. Module scope
// because one thread is steerable from several mounted prompt boxes at once (the queue card and the
// drawer), and they must agree.
export type SendMode = "steer" | "queue"

const modes = proxy({ of: {} as Record<string, SendMode> })

export function setSendMode(slug: string, mode: SendMode): void {
  if (mode === "steer") delete modes.of[slug]
  else modes.of[slug] = mode
}

/** The ticked row for this thread. `running` is "a turn is in flight" — the edge back to rest is what
 *  resets the tick. */
export function useSendMode(slug: string, running: boolean): SendMode {
  const mode = useSnapshot(modes).of[slug] ?? "steer"
  const was = useRef(running)
  useEffect(() => {
    if (was.current && !running) setSendMode(slug, "steer")
    was.current = running
  }, [running, slug])
  return mode
}

/** What the placeholder says an empty prompt box is for. A staged answer outranks everything: the box
 *  is then a note on the answers, whichever way they go. An open question with nothing staged makes
 *  the box the way AROUND it. Otherwise it names how the ticked row will send, which only differs from
 *  an ordinary reply while there is a turn to queue behind. */
export function sendPlaceholder(input: { staged: number; openQuestions: boolean; running: boolean; mode: SendMode }): string {
  if (input.staged > 0) return input.staged === 1 ? "Add a note to send with your answer…" : `Add a note to send with your ${input.staged} answers…`
  if (input.openQuestions) return "Or skip the questions and reply…"
  if (input.running && input.mode === "queue") return "Queue a message for when the agent rests…"
  return "Reply to the agent…"
}
