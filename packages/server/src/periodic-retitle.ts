import type { TranscriptMessage } from "@frizz/shared"
import { isBrokerClaudeRow, sessionTitleLocked, type SessionRow, type Storage } from "./storage.ts"

// Every Nth operator message on a thread, re-title it from the RECENT conversation.
//
// A thread's name is minted once, from its opening prompt, and a long thread drifts: by its twentieth
// exchange the operator is usually steering something the opening prompt never mentioned, and the
// board still names the first ask (maintainer 2026-09-24: "every x messages on a single thread (maybe
// 5?), update the summary title … to focus on the recent conversation"). This is the deliberate
// counterpart of `aiRenameThread`, which names from the OPENING request for the reason recorded there
// (issue #22: a titler fed only the newest reply names the last agent action). The window here is the
// last few EXCHANGES — the operator's own words plus the agent's replies — not the newest line alone.
//
// What counts is the OPERATOR's messages, not every user-role record: frizz's wakes, a child's upward
// `SendMessage`, completion boundaries and still-queued bubbles are all user-side turns nobody typed,
// and counting them would retitle a quiet thread every few watcher ticks.
//
// The name lands through `setAgentTitle` — the same unlocked write `mcp__frizz__title` uses — so a
// HUMAN rename still outranks it both before and after, and it outranks the transcript's spawn-time
// `aiTitle` on the board (board.ts resolveSessionTitle).
export const RETITLE_EVERY_MESSAGES = 5
// Enough to name what the conversation is about, bounded well under the SDK's 64KiB control frame.
const PER_MESSAGE_CHARS = 1_500
const DESCRIPTION_CHARS = 12_000

export function operatorMessages(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((m) =>
    m.role === "user" && !m.wake && !m.peerFrom && !m.agentInstruction && !m.boundary && !m.kind && !m.queued &&
    (m.displayText ?? m.text).trim() !== "")
}

/** The last `window` operator messages and every agent reply among them, as a transcript the titler
 *  can summarize. Undefined when there is nothing to name from. */
export function recentConversation(messages: readonly TranscriptMessage[], window = RETITLE_EVERY_MESSAGES): string | undefined {
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
  let body = lines.join("\n\n")
  if (body.length > DESCRIPTION_CHARS) body = `…${body.slice(body.length - DESCRIPTION_CHARS)}`
  return `Name this thread after what the RECENT conversation below is about — not the first request.\n\n${body}`
}

export interface PeriodicRetitlerDeps {
  storage: Pick<Storage, "getSession" | "setAgentTitle">
  /** The provider's titler (the broker's `generateSessionTitle`). Absent ⇒ nothing is retitled. */
  generateTitle?: (input: { threadSlug: string; sessionId: string; description: string }) => Promise<string | undefined>
  readMessages: (sessionId: string) => TranscriptMessage[]
  onTitled: () => void
  onError?: (slug: string, error: unknown) => void
  every?: number
}

export interface PeriodicRetitler {
  /** Call at every live rest. Fire-and-forget: a title never delays anything. */
  onTurnDone(row: SessionRow): void
}

export function createPeriodicRetitler(deps: PeriodicRetitlerDeps): PeriodicRetitler {
  const every = deps.every ?? RETITLE_EVERY_MESSAGES
  // The last multiple-of-`every` each session was titled at. In memory on purpose: the first rest a
  // session shows this process only RECORDS its count, because this process cannot know whether the
  // previous one already titled that window — so a restart costs at most one missed window and never
  // a burst of retitles across every live thread.
  const titledAt = new Map<string, number>()
  const inFlight = new Set<string>()
  return {
    onTurnDone(row) {
      if (!deps.generateTitle || !isBrokerClaudeRow(row)) return
      if (sessionTitleLocked(row)) return
      const key = `${row.slug}\0${row.session_id}`
      if (inFlight.has(key)) return
      const messages = deps.readMessages(row.session_id)
      const bucket = Math.floor(operatorMessages(messages).length / every)
      const prev = titledAt.get(key)
      titledAt.set(key, Math.max(bucket, prev ?? 0))
      if (prev === undefined || bucket <= prev || bucket === 0) return
      const description = recentConversation(messages, every)
      if (!description) return
      inFlight.add(key)
      void deps.generateTitle({ threadSlug: row.slug, sessionId: row.session_id, description })
        .then((title) => {
          const clean = title?.trim()
          if (!clean) return
          // Re-read: a human may have renamed it, or the slug been re-dispatched, while the titler ran.
          const current = deps.storage.getSession(row.slug)
          if (!current || current.session_id !== row.session_id || sessionTitleLocked(current)) return
          if (deps.storage.setAgentTitle(row.slug, clean)) deps.onTitled()
        })
        .catch((error: unknown) => deps.onError?.(row.slug, error))
        .finally(() => inFlight.delete(key))
    },
  }
}
