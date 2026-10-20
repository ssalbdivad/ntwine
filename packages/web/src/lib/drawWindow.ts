// WHICH OF A THREAD'S LOADED MESSAGES THE DRAWER DRAWS (2026-10-20).
//
// The drawer pages a thread's whole history in behind the reader (ChatView EAGER HISTORY), and everything
// it derives — coalescing, rows, answers, question placement — walks the list it is handed. On
// @precompile-design that list reached 8,648 messages, and each live update then cost ~300ms at 4x CPU
// spread over ~15 whole-list passes: keystroke p90 216–296ms while the thread streamed. So the drawer
// draws a SUFFIX of what is loaded, from an anchor message:
//
// - While fewer than DRAW_LIMIT messages are drawn, the window takes in history as it is prepended, so a
//   thread under the limit draws exactly what it drew before.
// - Past it, a prepended page leaves the drawn list as it was — the same objects, in the same array — so
//   paging the rest of the history in costs the drawer nothing, and the loaded history is there the
//   moment the reader wants it.
// - The reader reaching the top widens the window by DRAW_STEP, at once, from memory.
//
// A window starts on a human turn, the boundary the server's own pages start on (transcript.ts
// pageProjectedTranscript), so no tool run, answer or question is cut from the ask above it. The anchor is
// a sourceId, never an index: every prepend shifts every index.
//
// Pure — ChatView holds the anchor across renders.

export const DRAW_LIMIT = 2_000
export const DRAW_STEP = 1_000
// How far back a window start looks for a human turn before it settles for where it is.
const TURN_LOOKBACK = 500

type DrawnLike = {
  sourceId?: string
  role: string
  queued?: boolean
  wake?: unknown
  agentInstruction?: unknown
  spinoff?: unknown
  keepWorking?: unknown
  sessionPeer?: unknown
  peerFrom?: unknown
}

// A turn the human started — the server's turnStart predicate, plus a peer's message.
function startsTurn(m: DrawnLike): boolean {
  return m.role === "user" && !m.wake && !m.queued && !m.agentInstruction && !m.spinoff && !m.keepWorking && !m.sessionPeer && !m.peerFrom && m.sourceId !== undefined
}

/** `at`, moved back to the nearest human turn within TURN_LOOKBACK — or to 0 when that reaches it. */
export function alignToTurn(messages: readonly DrawnLike[], at: number): number {
  if (at <= 0) return 0
  for (let i = at; i >= 0 && at - i <= TURN_LOOKBACK; i--) if (i === 0 || startsTurn(messages[i])) return i
  // No human turn that close: any message with a sourceId can anchor.
  for (let i = at; i > 0; i--) if (messages[i].sourceId !== undefined) return i
  return 0
}

/**
 * Where the drawn window starts. `anchor` is the sourceId the window started at last time (null before
 * the first draw); `widen` asks for DRAW_STEP more above it. Returns the start and the anchor to keep.
 */
export function drawWindowStart(
  messages: readonly DrawnLike[],
  anchor: string | null,
  widen = false,
  limit = DRAW_LIMIT,
  step = DRAW_STEP,
): { start: number; anchor: string | null } {
  let start = anchor === null ? -1 : messages.findIndex((m) => m.sourceId === anchor)
  // First draw, or the anchor is gone (the transcript was replaced, or the message re-keyed): the newest
  // `limit`, as if the window had grown to it.
  if (start < 0) start = alignToTurn(messages, Math.max(0, messages.length - limit))
  // Under the limit, take in what was prepended since — never giving back anything already drawn.
  else if (start > 0 && messages.length - start < limit) start = Math.min(start, alignToTurn(messages, Math.max(0, messages.length - limit)))
  if (widen && start > 0) start = alignToTurn(messages, Math.max(0, start - step))
  // Anchored even at 0: history prepended under a window that starts at the head must stay below it
  // rather than re-deriving "the newest `limit`", which would slide off the rows the reader is on.
  return { start, anchor: messages[start]?.sourceId ?? null }
}
