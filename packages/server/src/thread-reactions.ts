import { stripFollowUpRiders, stripWakeDeliveryToken, type ReactionLine, type ThreadReactionView, type TranscriptMessage } from "@ntwine/shared"
import type { ThreadReactionRow } from "./storage.ts"

// REACTIONS (2026-11-09) — see ThreadReactionView in @ntwine/shared for the model.

/** The newest reactions a board frame carries per thread. A frame holds every thread, so an unbounded list
 *  would let one long, emoji-happy thread grow every frame; a reaction older than this many is history
 *  nobody is reading. */
export const BOARD_REACTIONS_PER_THREAD = 200

export function threadReactionViews(rows: readonly ThreadReactionRow[]): ThreadReactionView[] {
  const recent = rows.length > BOARD_REACTIONS_PER_THREAD ? rows.slice(-BOARD_REACTIONS_PER_THREAD) : rows
  return recent.map((r) => ({ sourceId: r.source_id, emoji: r.emoji, by: r.author, at: r.created_at }))
}

export function reactionLine(r: ThreadReactionRow): ReactionLine {
  return { sourceId: r.source_id, emoji: r.emoji, by: r.author, excerpt: r.excerpt, at: r.created_at }
}

/** What a reaction is read against: the message's first words, on one line. A fenced block (an agent's
 *  ```awaiting or ```done card, a code sample) is not words anyone reads it by, so it comes out first —
 *  unless it is all the message has. */
export function reactionExcerpt(text: string, max = 200): string {
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, " ").trim()
  const flat = (prose || text).replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A message the HUMAN typed and the transcript has recorded — the only kind an agent reacts to. A wake,
 *  another thread's message, a sub-agent's report, a spinoff card and a send still waiting to be read are
 *  all user-role records the human did not type (or that have no stable id yet). */
export function isHumanMessage(m: TranscriptMessage): boolean {
  return m.role === "user" && !m.kind && !m.wake && !m.sessionPeer && !m.peerFrom && !m.spinoff && !m.spinoffOrigin &&
    !m.commandOutput && !m.providerError && !m.queued && !m.deliveryState && typeof m.sourceId === "string"
}

/** The human's words in a recorded message, without what ntwine appended for the worker. */
export function humanMessageText(m: TranscriptMessage): string {
  return stripFollowUpRiders(stripWakeDeliveryToken(m.displayText ?? m.text))
}
