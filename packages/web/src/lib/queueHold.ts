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

function read(): ReadonlySet<string> {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [])
  } catch {
    return new Set()
  }
}

let holds: ReadonlySet<string> = read()
const listeners = new Set<() => void>()

function write(next: ReadonlySet<string>): void {
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

export function setHeldInQueue(key: string, held: boolean): void {
  if (holds.has(key) === held) return
  const next = new Set(holds)
  if (held) next.add(key)
  else next.delete(key)
  write(next)
}

export function toggleHeldInQueue(key: string): void {
  setHeldInQueue(key, !holds.has(key))
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every held card's key; a new set on every change. */
export function useQueueHolds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => holds, () => holds)
}

export function useHeldInQueue(key: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => key !== undefined && holds.has(key), () => false)
}
