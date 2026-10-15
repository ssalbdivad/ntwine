import type { TranscriptMessage } from "@ntwine/shared"
import { isBrokerClaudeRow, type SessionRow, type Storage } from "./storage.ts"

// At every rest where the conversation has moved, write the thread's STATUS from the RECENT conversation.
//
// This began (a7be3046, 2026-09-24) as a periodic RETITLE: a long thread drifts, and by its twentieth
// exchange the operator is steering something the opening prompt never mentioned (maintainer: "every x
// messages on a single thread (maybe 5?), update the summary title … to focus on the recent
// conversation"). That was the right signal in the wrong field. A name that moves every five messages is
// not a name — the reader loses which card is which — so on 2026-09-29 the maintainer split the two: the
// NAME is one or two stable words for the subject (thread-names.ts), and what is happening NOW is a
// separate `status` this pass writes. It NEVER writes the name, whoever set it.
//
// The window is the last few EXCHANGES — the operator's own words plus the agent's replies — not the
// newest line alone (issue #22: a summary fed only the newest reply describes the last agent action).
//
// It ran every 5th operator message until 2026-09-30, and a rested card went on saying "Waiting on npm
// 2FA trust command" for exchanges after the human had run it and the agent had moved on (maintainer:
// "statuses are updated with each interaction so that stale indicators like this dont linger around and
// make users think they need to act when they don't. seems like minimal cost"). So now every rest whose
// transcript gained an agent reply or an operator message since the last write gets one Sonnet one-shot;
// a rest that added nothing — a watcher tick the agent answered with no text — reuses the standing status.
//
// The WINDOW is still the last few operator exchanges. What counts there is the OPERATOR's messages, not every user-role record: ntwine's wakes, a child's upward
// `SendMessage`, completion boundaries and still-queued bubbles are all user-side turns nobody typed,
// and counting them would rewrite a quiet thread's status every few watcher ticks. A SPINOFF REQUEST is not
// one either (2026-09-30), though the human asked for it: it is about the NEW thread, so it neither moves
// this thread's conversation on nor names the request live-status.ts should describe this one's work by.
// Nor is a Keep working click: it only sends the worker back to the wait it was already on.
export const STATUS_WINDOW_MESSAGES = 5
// Enough to say what the conversation is doing, bounded well under anything a one-shot should carry.
const PER_MESSAGE_CHARS = 1_500
const CONVERSATION_CHARS = 12_000

export function operatorMessages(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((m) =>
    m.role === "user" && !m.wake && !m.peerFrom && !m.agentInstruction && !m.boundary && !m.kind && !m.queued && !m.spinoff && !m.keepWorking &&
    (m.displayText ?? m.text).trim() !== "")
}

/** The last `window` operator messages and every agent reply among them, as a transcript the status
 *  writer can read. Undefined when there is nothing to read. */
export function recentConversation(messages: readonly TranscriptMessage[], window = STATUS_WINDOW_MESSAGES): string | undefined {
  const ops = operatorMessages(messages)
  if (ops.length === 0) return undefined
  const from = messages.indexOf(ops[Math.max(0, ops.length - window)]!)
  const opSet = new Set(ops)
  const lines: string[] = []
  for (const m of messages.slice(from)) {
    const isOp = opSet.has(m)
    if (!isOp && (m.role !== "assistant" || m.kind || m.boundary)) continue
    const text = (isOp ? m.displayText ?? m.text : m.text).trim()
    if (!text) continue
    const clipped = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text
    lines.push(`${isOp ? "User" : "Assistant"}: ${clipped}`)
  }
  // Keep the NEWEST end when the window overflows — the recent turns are the point.
  const body = lines.join("\n\n")
  return body.length > CONVERSATION_CHARS ? `…${body.slice(body.length - CONVERSATION_CHARS)}` : body
}

export interface PeriodicStatusDeps {
  storage: Pick<Storage, "getSession" | "setStatus">
  /** The status writer (thread-names.ts `ThreadNamer.status`). Absent ⇒ no status is ever written. */
  writeStatus?: (input: { name?: string; conversation: string }) => Promise<string | undefined>
  /** The thread's current NAME, handed to the writer only so the status does not repeat it. */
  nameOf?: (row: SessionRow) => string | undefined
  /** `forkAnchor` is the row's SessionRow.fork_anchor — a forked thread is read from its fork point. */
  readMessages: (sessionId: string, forkAnchor?: string | null) => TranscriptMessage[] | Promise<TranscriptMessage[]>
  onStatus: () => void
  onError?: (slug: string, error: unknown) => void
}

export interface PeriodicStatus {
  /** Call at every live rest. Fire-and-forget: a status never delays anything. `force` writes one even
   *  when the conversation has not moved — live-status.ts asks for it when the turn that just ended wore
   *  a WORKING status, which would otherwise sit on the rested card still saying "Running the tests". */
  onTurnDone(row: SessionRow, options?: { force?: boolean }): void
}

export function createPeriodicStatus(deps: PeriodicStatusDeps): PeriodicStatus {
  // How many messages of the transcript each session's last status read: the conversation has moved
  // when an operator message or agent reply sits past it. In memory, so a restart costs at most one
  // re-write at a thread's next rest — and rests fire only on a live edge, never as a boot-time burst.
  const readTo = new Map<string, number>()
  const inFlight = new Set<string>()
  return {
    onTurnDone(row, options) {
      // Broker Claude rows only: `readMessages` reads a Claude transcript.
      if (!deps.writeStatus || !isBrokerClaudeRow(row)) return
      const writeStatus = deps.writeStatus
      const key = `${row.slug}\0${row.session_id}`
      // In flight from the READ on, now that the read is awaited: a rest that lands meanwhile is dropped,
      // exactly as one landing during the model call always was — the next rest reads past it.
      if (inFlight.has(key)) return
      inFlight.add(key)
      void (async () => {
        // Awaited: the context hands in readTranscriptYielding, so a cold fold of a large transcript
        // yields the event loop instead of holding it for seconds (transcript.ts).
        const messages = await deps.readMessages(row.session_id, row.fork_anchor)
        const ops = new Set(operatorMessages(messages))
        const prev = readTo.get(key) ?? 0
        const moved = messages.slice(prev).some((m) =>
          ops.has(m) || (m.role === "assistant" && !m.kind && !m.boundary && m.text.trim() !== ""))
        if (!moved && !options?.force) return
        readTo.set(key, messages.length)
        const conversation = recentConversation(messages)
        if (!conversation) return
        const status = await writeStatus({ name: deps.nameOf?.(row), conversation })
        if (!status) return
        // Keyed on the session it was read from: a re-dispatch over the slug while the writer ran
        // must not inherit the old session's status.
        if (deps.storage.setStatus(row.slug, row.session_id, status)) deps.onStatus()
      })()
        .catch((error: unknown) => deps.onError?.(row.slug, error))
        .finally(() => inFlight.delete(key))
    },
  }
}
