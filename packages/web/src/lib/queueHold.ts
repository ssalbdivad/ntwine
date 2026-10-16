import { useSyncExternalStore } from "react"

// HOLD IN QUEUE — a card the human keeps in the queue while they chat in it (David 2026-10-16: "I want
// a way to keep a card in the queue so that when I am interacting quickly with a chat I don't have to
// have it keep popping back and forth"). Without it a reply sent from a card fades the card out, its
// thread goes to Working, and the card comes back at the bottom of the queue when the thread rests:
// every exchange is a card leaving and returning. Held, the card stays where it is, drawn live, while
// its thread works and when it rests again (components/AllQueues.tsx reads the set; `h` and the card's ⋯
// menu toggle it, ThreadMenu.tsx).
//
// PER TAB, CLIENT-SIDE, AND NOT A PIN. Pinning is the thread's place in the list, shared by every tab
// and stored on the server; it does not touch the queue and must not. A hold is how THIS tab draws its
// queue for as long as the human is working through one card, so it lives in sessionStorage: a reload
// keeps it, another tab never sees it.
//
// It ends on `h` again, on Mark as done or snooze from the card (AllQueuesCard.tsx releases it before
// the card fades), and once the page sees the thread snoozed or finished by any other hand.
//
// Keyed by `threadKey(projectId, slug)` (lib/allQueues.ts): a slug is unique only within one project.

const STORAGE_KEY = "ntwine:queueHolds"

/** Every hold, by key, with its PLACE: the queue-order stamp (groups.ts queueKeyAt) its thread had when the
 *  hold began. A fresh draw — a reload — sorts the queue by each thread's live stamp, and a held thread
 *  has none worth reading by then: one still at work is not in the queue at all, and one that rested again
 *  entered it a moment ago. So a held card is placed by the stamp it was held at, where it stood. */
export type QueueHolds = ReadonlyMap<string, number>

function read(): QueueHolds {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const out = new Map<string, number>()
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        // A bare key is the first shape this took (2026-10-16, an hour old): no place, so it goes last.
        if (typeof entry === "string") out.set(entry, Number.POSITIVE_INFINITY)
        // JSON has no Infinity: a hold with no place is written as null.
        else if (Array.isArray(entry) && typeof entry[0] === "string") out.set(entry[0], typeof entry[1] === "number" ? entry[1] : Number.POSITIVE_INFINITY)
      }
    }
    return out
  } catch {
    return new Map()
  }
}

let holds: QueueHolds = read()
const listeners = new Set<() => void>()

function write(next: QueueHolds): void {
  holds = next
  try {
    if (next.size === 0) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Storage full or blocked: the hold still lasts for this page load.
  }
  for (const listener of listeners) listener()
}

/** Read synchronously, so a card put away in the same tick as its hold ends sees the hold gone. */
export function isHeldInQueue(key: string): boolean {
  return holds.has(key)
}

/** Hold `key` at the queue place `at` (its thread's queueKeyAt now), or let it go. */
export function setHeldInQueue(key: string, held: false): void
export function setHeldInQueue(key: string, held: true, at: number): void
export function setHeldInQueue(key: string, held: boolean, at?: number): void {
  if (holds.has(key) === held) return
  const next = new Map(holds)
  if (held) next.set(key, at ?? Number.POSITIVE_INFINITY)
  else next.delete(key)
  write(next)
}

export function toggleHeldInQueue(key: string, at: number): void {
  if (holds.has(key)) setHeldInQueue(key, false)
  else setHeldInQueue(key, true, at)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every hold; a new map on every change. */
export function useQueueHolds(): QueueHolds {
  return useSyncExternalStore(subscribe, () => holds, () => holds)
}

export function useHeldInQueue(key: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => key !== undefined && holds.has(key), () => false)
}

/**
 * The queue for a FRESH draw with every held card back in its place. `entries` is the queue's own order
 * (by each thread's live stamp, `stampOf`) followed by any held thread still at work; each held entry is
 * taken out and put back before the first unheld entry whose stamp is later than the one it was held at.
 * Only a fresh draw reads this order — once drawn, lib/stableQueue.ts keeps every card where it is.
 */
export function placeHeld<T>(entries: readonly T[], holds: QueueHolds, keyOf: (entry: T) => string, stampOf: (entry: T) => number): T[] {
  if (holds.size === 0) return [...entries]
  const out = entries.filter((entry) => !holds.has(keyOf(entry)))
  const held = entries
    .filter((entry) => holds.has(keyOf(entry)))
    .map((entry) => ({ entry, at: holds.get(keyOf(entry))! }))
    // Among themselves, by the place each was held at; the sort is stable, so ties keep the input order.
    .sort((a, b) => Number(a.at > b.at) - Number(a.at < b.at))
  let from = 0
  for (const { entry, at } of held) {
    while (from < out.length && (holds.has(keyOf(out[from]!)) || stampOf(out[from]!) <= at)) from++
    out.splice(from, 0, entry)
    from++
  }
  return out
}
