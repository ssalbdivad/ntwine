import { isInjectedNoise, isNtwineOwnTool, isParkCorrection, parseMergedWake, parseOwnWatchExpiredWake, parseRecurringPrompt, parseTerminalWatchExpiredWake, stripWakeTrailer, type TranscriptToolCall } from "@ntwine/shared"
import type { ChatMessage } from "../hooks.ts"

// WHAT THE TRANSCRIPT DROPS BECAUSE IT IS ntwine TALKING TO ITS OWN WORKER.
//
// The maintainer, 2026-10-24, with a screenshot of a sign-off nudge, the worker's `ntwinectl done`, and
// its "Signed off." stacked under an answer he already had: "dumb shit like this that happens because of
// weird principles should go away". Each thing here is the worker protocol drawn at the human, whose
// effect is already on screen somewhere better:
//
//   · A SIGN-OFF NUDGE (every variant that opens with SIGNOFF_NUDGE_MARKER, which also covers the stray-
//     shells and carried-questions reminders). The answer is above it and the done card or question card
//     below it; the hairline said "ntwine asked for a sign-off", which is worker-contract vocabulary
//     telling the human nothing they can act on. The rest hairline above one is dropped by the rest pass
//     (a rest above a wake is redundant), so the reply reads as the tail of the turn it signs off, which
//     is how router.handoffOf already reads it for the queue card.
//   · A LAPSED WATCH on the worker's own shell, sub-agent or terminal. The worker registered it, the
//     worker re-decides; the human never made it and cannot renew it.
//   · An `ntwinectl` CALL that worked (`done`, `ask`, `title`, `watch`, …). Its effect is the done card,
//     the question card, the Waiting band, the process strip. Drawn, it inflated "Ran N tool calls" and
//     could name the live shimmer. A FAILED one stays: a refused `done` (exit 2, `is_error`) is why the
//     thread did not finish.
//
// Presentation only. The server still projects every one of these: router.handoffOf and
// signedOffInPlace read the nudges, and the fold reads the calls.

/** A wake that draws nothing at all, by itself or as a part of a merged delivery. */
export function isHiddenWake(text: string): boolean {
  return parseRecurringPrompt(text)?.kind === "signoff" || parseOwnWatchExpiredWake(text) !== null || parseTerminalWatchExpiredWake(text) !== null
}

/** The parts of a merged delivery that draw, trailer off, in order (NtwineWake's MergedWake). A fence
 *  correction and relay plumbing are dropped exactly as the server drops them arriving alone. */
export function shownMergedParts(bodies: readonly string[]): string[] {
  return bodies.map(stripWakeTrailer).filter((body) => !isParkCorrection(body) && !isInjectedNoise(body) && !isHiddenWake(body))
}

/** Does this wake delivery draw nothing? NtwineWake returns null for exactly these, and the row
 *  builders must agree, or a hidden wake still spends a spacer. */
export function wakeRendersNothing(text: string): boolean {
  const merged = parseMergedWake(text)
  return merged ? shownMergedParts(merged.map((part) => part.body)).length === 0 : isHiddenWake(text)
}

const keepsCall = (tool: TranscriptToolCall) => tool.status === "failed" || !isNtwineOwnTool(tool)

// Keyed on the message object: a transcript message is never mutated (lib/transcript-sync
// preserveMessageIdentity), so the stripped copy can be shared across renders, which keeps the
// incremental tool-run fold (toolActivity coalesceFrom) resuming where it left off.
const stripped = new WeakMap<ChatMessage, ChatMessage>()
const originals = new WeakMap<ChatMessage, ChatMessage>()

/** The message without its successful ntwine calls, or the message itself when it has none. A message
 *  left with no calls and no prose renders nothing (ChatView computeRendersNothing). */
export function withoutNtwineOwnCalls(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || message.tools.every(keepsCall)) return message
  let out = stripped.get(message)
  if (!out) {
    const parts = message.parts
      ?.map((part) => (part.kind === "tools" ? { ...part, tools: part.tools.filter(keepsCall) } : part))
      .filter((part) => part.kind !== "tools" || part.tools.length > 0)
    out = { ...message, tools: message.tools.filter(keepsCall), ...(parts ? { parts } : {}) }
    stripped.set(message, out)
    originals.set(out, message)
  }
  return out
}

/** The message as the transcript served it, before withoutNtwineOwnCalls — what the shared exchange
 *  passes read, since a nudge's reply is recognized BY its ntwine calls. */
export function servedMessage(message: ChatMessage): ChatMessage {
  return originals.get(message) ?? message
}
