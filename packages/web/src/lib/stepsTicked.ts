import { useCallback, useMemo, useSyncExternalStore } from "react"

// WHICH OF A STEPS CARD'S STEPS THE HUMAN HAS TICKED OFF (2026-10-12, maintainer: "if this is supposed to
// be rendering like a classic to-do stepper, it's not doing that"). The ticks are the reader's own
// bookkeeping while they work through the list — nothing is sent, and the worker learns what happened
// from the reply, exactly as before.
//
// KEPT IN localStorage, KEYED BY THE STEPS THEMSELVES. The same steps draw on two surfaces at once (the
// queue card and the drawer's tail), the drawer is virtualized so a card unmounts when it scrolls away,
// and a reader who reloads halfway through a sign-in must not lose their place — so the state cannot
// live in a component. The key is the step text rather than a thread slug because a transcript fence
// reaches the card with no thread at all; two threads handing over word-for-word the same steps would
// share their ticks, which is harmless.
const PREFIX = "frizz-steps-ticked:"
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab ticking the same card.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

// FNV-1a, 32-bit: a short stable key for a list that can run to thousands of characters.
function keyOf(steps: readonly string[]): string {
  let h = 0x811c9dc5
  const text = steps.join("\u0000")
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${PREFIX}${steps.length}:${(h >>> 0).toString(36)}`
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

/** The ticked step indices for this list, and a toggle. The stored value is a comma list of indices, so
 *  the snapshot is a plain string and useSyncExternalStore compares it by value. */
export function useTickedSteps(steps: readonly string[]): [ReadonlySet<number>, (index: number) => void] {
  const key = useMemo(() => keyOf(steps), [steps])
  const raw = useSyncExternalStore(subscribe, () => read(key), () => "")
  const ticked = useMemo(() => new Set(raw.split(",").filter(Boolean).map(Number).filter((i) => i < steps.length)), [raw, steps.length])
  const toggle = useCallback((index: number) => {
    const next = new Set(read(key).split(",").filter(Boolean).map(Number))
    if (next.has(index)) next.delete(index)
    else next.add(index)
    try {
      if (next.size === 0) localStorage.removeItem(key)
      else localStorage.setItem(key, [...next].sort((a, b) => a - b).join(","))
    } catch {
      // storage full or blocked: the tick simply does not stick
    }
    for (const listener of listeners) listener()
  }, [key])
  return [ticked, toggle]
}
