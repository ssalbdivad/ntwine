import type { AwaitingStatus, TranscriptMessage } from "@ntwine/shared"
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
//
// THE HANDOFF, NOT JUST THE PROSE (2026-10-21). The writer read only the conversation, so a reply that
// said "unless you say otherwise, it becomes @ark/aot" — a decision the worker had TAKEN — came out as
// "Waiting on your pick of a name", and the card kept saying so through several later rests whose only
// text was a `status: working` fence (maintainer: "summary says waiting on my pick but it said it had made a
// choice unless I tell it otherwise"). Prose is ambiguous about who holds the thread; ntwine's own records
// are not. So every write is handed the rest's HANDOFF — the questions still holding the thread, and the
// sign-off it rested on — and the prompt treats it as the authority on whether the developer is needed.
// A rest whose handoff differs from the last write's is a move too, even with no new words: a question
// answered or withdrawn, or a park that went from `needs_input` to `working`, changes what the card must
// say. Stale is the worse failure here — a card that says "waiting on you" when it is not costs the human
// a trip, and a spare Sonnet one-shot costs little — so the triggers lean toward writing.
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

/** Where a rest's handoff stands, from ntwine's records rather than the reply's prose. */
export interface RestHandoff {
  /** The open questions still HOLDING the thread (not typed past), as their text. */
  questions: string[]
  /** The sign-off the rest ended on, if any. */
  signoff?:
    | { kind: "done" }
    | { kind: "awaiting"; status: AwaitingStatus | null; waitsOn: string[]; steps: string[] }
}

/** The handoff as the lines the status writer reads. */
export function describeHandoff(h: RestHandoff): string {
  const lines: string[] = []
  if (h.questions.length) {
    lines.push(`- The agent has ${h.questions.length} open question${h.questions.length === 1 ? "" : "s"} for the developer:`)
    for (const q of h.questions) lines.push(`  - ${q.length > 300 ? `${q.slice(0, 300)}…` : q}`)
  } else lines.push("- The agent has NO open question for the developer.")
  const s = h.signoff
  if (!s) lines.push("- It rested without a sign-off: a plain reply.")
  else if (s.kind === "done") lines.push("- It signed off as DONE: the work is finished.")
  else {
    if (s.steps.length) {
      lines.push("- It is waiting on the developer to do these steps:")
      for (const step of s.steps) lines.push(`  - ${step}`)
    }
    const meaning = s.status === "needs_input" ? "the developer has something to review or act on now"
      : s.status === "working" ? "its own work (sub-agents, shells, CI) is still running and finishes by itself; the developer is NOT needed"
      : s.status === "watching" ? "it is waiting on something outside the thread (a review, a release, a reply); the developer is NOT needed"
      : "no status given"
    lines.push(`- It parked with status ${s.status ?? "unset"}: ${meaning}.`)
    if (s.waitsOn.length) lines.push(`- It is waiting on: ${s.waitsOn.join(", ")}.`)
  }
  return lines.join("\n")
}

export interface PeriodicStatusDeps {
  storage: Pick<Storage, "getSession" | "setStatus">
  /** The status writer (thread-names.ts `ThreadNamer.status`). Absent ⇒ no status is ever written. */
  writeStatus?: (input: { name?: string; conversation: string; handoff?: string }) => Promise<string | undefined>
  /** The rest's handoff (describeHandoff). Absent ⇒ the writer reads the conversation alone. */
  handoffOf?: (row: SessionRow, messages: readonly TranscriptMessage[]) => RestHandoff | undefined
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
  // What each session's last WRITTEN status read, as a fingerprint: how many operator messages, the
  // newest agent reply, and the handoff. The conversation has moved when any of them differs. It was an
  // index into the message array until 2026-10-21 (`messages.slice(readTo)`), which goes blind whenever
  // the fold's count shrinks or reshapes under it — a compaction, coalesced units — and a long thread
  // then kept a status written an hour and six rests earlier. Recorded only once a status lands, so a
  // write that failed or came back empty is retried at the next rest instead of being counted as done.
  // In memory, so a restart costs at most one re-write at a thread's next rest — and rests fire only on
  // a live edge, never as a boot-time burst.
  const written = new Map<string, string>()
  const inFlight = new Set<string>()
  // A rest that lands while a write is in flight is not dropped: it re-runs once that write finishes, so
  // the card ends on the NEWEST rest rather than the one before it.
  const pending = new Map<string, boolean>()
  const api: PeriodicStatus = {
    onTurnDone(row, options) {
      // Broker Claude rows only: `readMessages` reads a Claude transcript.
      if (!deps.writeStatus || !isBrokerClaudeRow(row)) return
      const writeStatus = deps.writeStatus
      const key = `${row.slug}\0${row.session_id}`
      // In flight from the READ on, now that the read is awaited: a rest that lands meanwhile is held
      // and re-run once this write finishes.
      if (inFlight.has(key)) {
        pending.set(key, (pending.get(key) ?? false) || Boolean(options?.force))
        return
      }
      inFlight.add(key)
      void (async () => {
        // Awaited: the context hands in readTranscriptYielding, so a cold fold of a large transcript
        // yields the event loop instead of holding it for seconds (transcript.ts).
        const messages = await deps.readMessages(row.session_id, row.fork_anchor)
        const lastReply = messages.findLast((m) => m.role === "assistant" && !m.kind && !m.boundary && m.text.trim() !== "")
        const rest = deps.handoffOf?.(row, messages)
        const handoff = rest ? describeHandoff(rest) : undefined
        const seen = [operatorMessages(messages).length, lastReply?.at ?? "", lastReply?.text ?? "", handoff ?? ""].join("\0")
        if (seen === written.get(key) && !options?.force) return
        const conversation = recentConversation(messages)
        if (!conversation) return
        const status = await writeStatus({ name: deps.nameOf?.(row), conversation, ...(handoff ? { handoff } : {}) })
        if (!status) return
        written.set(key, seen)
        // Keyed on the session it was read from: a re-dispatch over the slug while the writer ran
        // must not inherit the old session's status.
        if (deps.storage.setStatus(row.slug, row.session_id, status)) deps.onStatus()
      })()
        .catch((error: unknown) => deps.onError?.(row.slug, error))
        .finally(() => {
          inFlight.delete(key)
          if (!pending.has(key)) return
          const force = pending.get(key)!
          pending.delete(key)
          const fresh = deps.storage.getSession(row.slug)
          if (fresh?.session_id === row.session_id) api.onTurnDone(fresh, { force })
        })
    },
  }
  return api
}
