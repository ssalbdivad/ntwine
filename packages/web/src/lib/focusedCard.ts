import { useSyncExternalStore } from "react"

// THE QUEUE CARD HOLDING THE KEYBOARD FOCUS (maintainer 2026-11-16: "ensure a card doesn't move to the
// background if it is actively focused"). An automatic hold (lib/queueHold.ts, lib/foregroundTurn.ts) lets
// a replied-to card go once its turn reads as long work; a card whose prompt box, button or disclosure
// still has the focus is one the human is using, so its hold waits until the focus leaves it. Read off
// `document.activeElement`, which keeps the card while the window itself is in the background — coming
// back to the tab finds the caret where it was, in the card it was in.

const CARD_SELECTOR = "[data-xq-card]"

/** The key of the queue card (`data-xq-card`) holding the keyboard focus, if one does. */
export function focusedCardKey(): string | undefined {
  if (typeof document === "undefined") return undefined
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return undefined
  return active.closest<HTMLElement>(CARD_SELECTOR)?.dataset.xqCard
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener("focusin", onChange)
  document.addEventListener("focusout", onChange)
  return () => {
    document.removeEventListener("focusin", onChange)
    document.removeEventListener("focusout", onChange)
  }
}

/** `focusedCardKey`, re-rendering as the focus moves in or out of a card. */
export function useFocusedCardKey(): string | undefined {
  return useSyncExternalStore(subscribe, focusedCardKey, () => undefined)
}
