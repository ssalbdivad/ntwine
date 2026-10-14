// THE QUEUE NEVER MOVES A CARD THE HUMAN IS LOOKING AT (David 2026-09-28: "it needs to be guaranteed
// that cards that I'm currently viewing on the screen don't move in their position"). This is the ORDER
// half of that guarantee; lib/viewportLock.ts is the SCROLL half, and neither is enough alone.
//
// ONCE A CARD IS DRAWN, IT KEEPS ITS PLACE, AND EVERYTHING THAT ENTERS THE QUEUE JOINS THE BOTTOM
// (maintainer, the same day: "they should always be added to the bottom"). The queue's own order
// (groups.ts orderQueue: when each thread entered the queue, oldest first) decides a FRESH draw — the
// page loading or a filter changing — and nothing after it. An arrival is appended below every card on
// the page whatever its stamp says, never slid in above the one being read.
//
// This used to be subtler, and every subtlety was a way to move something. Arrivals waited below the cards
// on screen and then crossed above them once off screen, the viewport lock absorbing the move — which
// still slid a stranger's tail into view where the top of the page had been, and still moved the page
// under the reader by exactly the card's height whenever the lock's accounting was a pixel off. An
// arrival's stamp can also sort it anywhere for reasons nobody acted on: another project's poll landing
// a few seconds late, a server restart re-listing its queue, a thread that woke itself on a finished
// shell coming back to its old place in line. None of those may reach the screen, so none of them
// reorders anything: appending moves nothing on screen, ever, and nothing else changes the order.
//
// A card whose thread leaves the queue while its card is on screen, without the human putting it away
// (it woke itself on a finished shell, a child's return, a timer; or someone acted on it from another
// tab), becomes a GHOST: an empty gap the card's height, holding its place until it scrolls off screen or the
// human next scrolls or presses a key (AllQueues.tsx) — or until the thread rests again, when it is simply
// the card again, in the same place. A card the human put away
// (done, snooze, a reply sent from its own box) is not a ghost; it leaves the ordinary way, and anything
// that follows it moving is the human's own doing. A card that leaves while OFF screen simply goes (the
// viewport lock holds the page if it was above), and should its thread come back, it is an arrival.

export interface QueueSlot<T> {
  key: string
  item: T
  /** The thread left the queue on its own while its card was on screen; the card holds its place. */
  ghost: boolean
}

export interface StableQueueInput<T> {
  /** What the last render drew, in order (ghosts included). Empty on first draw: the queue's own order. */
  prev: readonly QueueSlot<T>[]
  /** The queue's own order now. */
  target: readonly T[]
  keyOf: (item: T) => string
  /** Keys of the slots the last measurement found on screen (lib/viewportLock.ts measures them). */
  onScreen: ReadonlySet<string>
  /**
   * Whether a card that just left the queue may stay as a ghost. False for a thread the human put away
   * — archived, snoozed, answered from here — which leaves the ordinary way.
   */
  mayGhost: (key: string) => boolean
  /**
   * Keys still drawn as ordinary cards although the queue no longer lists them: a card the human
   * dismissed, fading out after the board dropped it. Only honoured on screen; off screen the fade is
   * invisible and the card simply goes.
   */
  keep?: ReadonlySet<string>
}

export function stableQueue<T>({ prev, target, keyOf, onScreen, mayGhost, keep }: StableQueueInput<T>): QueueSlot<T>[] {
  const live = new Map<string, T>()
  for (const item of target) live.set(keyOf(item), item)

  // Every card already drawn, where it was drawn.
  const drawn = new Set<string>()
  const out: QueueSlot<T>[] = []
  for (const slot of prev) {
    drawn.add(slot.key)
    const now = live.get(slot.key)
    if (now !== undefined) out.push({ key: slot.key, item: now, ghost: false })
    // Gone from the queue. On screen, a card the human is fading out holds its place, and one that left
    // on its own stays as a ghost; off screen — or put away by the human — it simply goes.
    else if (!onScreen.has(slot.key)) continue
    else if (keep?.has(slot.key)) out.push({ key: slot.key, item: slot.item, ghost: false })
    else if (mayGhost(slot.key)) out.push({ key: slot.key, item: slot.item, ghost: true })
  }
  // Then everything not drawn before, at the bottom, in the queue's own order among themselves — which,
  // on a first draw, is the whole queue.
  for (const item of target) {
    const key = keyOf(item)
    if (!drawn.has(key)) out.push({ key, item, ghost: false })
  }
  return out
}

