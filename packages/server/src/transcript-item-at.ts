import type { TranscriptMessage, TranscriptPart, TranscriptToolCall } from "@ntwine/shared"

type TimedTranscriptItem = TranscriptPart | TranscriptToolCall | NonNullable<TranscriptMessage["providerError"]>

// Server-side per-item timestamps for assistant message parts, tool calls, and provider errors.
//
// Codex and ACP fold a whole turn's tool calls (and interleaved prose) into one TranscriptMessage whose
// own `at` stays at its opening event; Claude can also merge streamed records of one `msg.id`. Without
// per-item instants, inserting an out-of-band timeline event by timestamp (a spinoff request or machine
// move divider in transcript.ts `insertAtInstants`) cannot tell where inside the message the event fell:
// the event lands AFTER the whole message, so every later tool call keeps accumulating above it as a
// settled `Ran N tool calls` count while the bottom slot shows nothing below the event.
//
// Held in a WeakMap rather than on the wire schema: only server-side insertion reads these instants,
// split slices inherit their first item's instant as their normal `TranscriptMessage.at`, and unsplit
// transcripts pay zero wire overhead or object-shape churn. Entries survive chained passes
// (`withSpinoffCards` → `withMoveDividers`) because slices keep the original part/call/error objects,
// and are collected automatically when retained folds or per-read projections are evicted.
const itemAt = new WeakMap<TimedTranscriptItem, string>()

export function stampTranscriptItemAt<T extends TimedTranscriptItem>(item: T, at: string | undefined): T {
  if (at) itemAt.set(item, at)
  return item
}

export function transcriptItemAt(item: TimedTranscriptItem): string | undefined {
  return itemAt.get(item)
}
