import { useSyncExternalStore } from "react"

// WHEN THE PROJECT LIST HOLDS ITS LAYOUT — lib/heldLayout.ts is WHAT holding means; this is when.
//
// HELD WHILE THE POINTER IS OVER THE LIST, and for a moment after a press in it ends. Over the list is the
// only time a row can be aimed at, and the hazard is a move landing between the human's last look at a row
// and their click on it (the incident in heldLayout.ts). The press's grace covers a click whose pointer
// leaves the instant it lets go: the click lands on the row the human saw, and the drawer it opens renders
// before the moves the hold kept back.
//
// RELEASED WHEN THE POINTER LEAVES — not after it has been still for a while. A still pointer over a row is
// what reading a title before clicking it looks like, and any idle threshold is a moment a row can still
// swap just before the click. What a parked pointer costs is a list a beat stale in its ORDER only — every
// row's spinner, status and rest time stay live, and the queue beside it is not held at all — so the trade
// favours holding. Also released when the window loses focus or is hidden: a pointer cannot be aiming at a
// page the human has left, and the list they come back to is already current.
//
// AND RELEASED AT ONCE BY THE HUMAN RESHAPING THE LIST: folding a project, opening or closing a quiet band,
// showing more Done, dragging a project — any control marked `data-xq-reshape`. Those move the list under
// the pointer by the human's own hand, and what they bring in (a band's rows loading, the drop's new order)
// lands within SETTLE_MS, so the list follows the live layout until then rather than holding the very
// change the human asked for. Single rows the human moves (pin, reopen, Retry, a reply) do not need this:
// heldLayout moves just that row, through lib/humanActs.ts.

/** The list's own scroll box — both of them: beside the queue, and stacked under it. */
const LIST = "[data-xq-rail]"
/** A control that reshapes the list rather than acting on one thread. */
const RESHAPE = "[data-xq-reshape]"
/** After a press in the list ends: past the click, the drawer it opens, and the frame that draws it. */
export const PRESS_GRACE_MS = 500
/** After a reshape: past the round trip of what it loads (a band's board, the reorder's answer). */
export const RESHAPE_SETTLE_MS = 1_500

export interface HoldClock {
  now: () => number
  later: (fn: () => void, ms: number) => () => void
}

const realClock: HoldClock = {
  now: () => performance.now(),
  later: (fn, ms) => {
    const id = window.setTimeout(fn, ms)
    return () => window.clearTimeout(id)
  },
}

/** The hold as a state machine over pointer facts, so it is tested without a DOM. */
export function createListHold(onChange: (held: boolean) => void, clock: HoldClock = realClock) {
  let inside = false
  let pressed = false
  let reshaping = false
  let graceUntil = 0
  let settleUntil = 0
  let held = false
  let cancel: (() => void) | null = null

  const settle = () => {
    const now = clock.now()
    const next = !reshaping && now >= settleUntil && (inside || pressed || now < graceUntil)
    cancel?.()
    cancel = null
    // The next instant the answer can change on its own: a grace or a settle running out.
    const wake = [graceUntil, settleUntil].filter((at) => at > now)
    if (wake.length) cancel = clock.later(settle, Math.min(...wake) - now)
    if (next !== held) {
      held = next
      onChange(held)
    }
  }

  return {
    held: () => held,
    /** The pointer is now over this element (or, given false, over nothing of the page's). */
    over(inList: boolean) {
      inside = inList
      settle()
    },
    down(inList: boolean, reshape: boolean) {
      if (!inList) return
      pressed = true
      reshaping = reshape
      settle()
    },
    up() {
      if (!pressed) return
      pressed = false
      graceUntil = clock.now() + PRESS_GRACE_MS
      if (reshaping) settleUntil = clock.now() + RESHAPE_SETTLE_MS
      reshaping = false
      settle()
    },
    /** A key on a reshaping control — Alt+Arrow moving a project, Enter on a fold. */
    reshapeKey() {
      settleUntil = clock.now() + RESHAPE_SETTLE_MS
      settle()
    },
    away() {
      inside = false
      pressed = false
      reshaping = false
      graceUntil = 0
      settle()
    },
    dispose() {
      cancel?.()
    },
  }
}

// ONE hold for the page, read by every part of the list that draws rows (TierList.tsx's tiers,
// Sidebar.tsx's sub-agent rows), so they hold and release as one.
const listeners = new Set<() => void>()
let machine: ReturnType<typeof createListHold> | null = null
let detach: (() => void) | null = null

function attach() {
  const hold = createListHold(() => {
    for (const listener of listeners) listener()
  })
  const inList = (target: EventTarget | null) => target instanceof Element && target.closest(LIST) !== null
  const reshapes = (target: EventTarget | null) => target instanceof Element && target.closest(`${LIST} ${RESHAPE}`) !== null
  const onOver = (event: PointerEvent) => hold.over(inList(event.target))
  const onOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) hold.over(false)
  }
  const onDown = (event: PointerEvent) => hold.down(inList(event.target), reshapes(event.target))
  const onUp = () => hold.up()
  const onKey = (event: KeyboardEvent) => {
    if (reshapes(event.target)) hold.reshapeKey()
  }
  const onAway = () => hold.away()
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hold.away()
  }
  const options = { capture: true, passive: true }
  document.addEventListener("pointerover", onOver, options)
  document.addEventListener("pointerout", onOut, options)
  document.addEventListener("pointerdown", onDown, options)
  document.addEventListener("pointerup", onUp, options)
  document.addEventListener("pointercancel", onUp, options)
  document.addEventListener("keydown", onKey, options)
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("blur", onAway)
  machine = hold
  detach = () => {
    document.removeEventListener("pointerover", onOver, options)
    document.removeEventListener("pointerout", onOut, options)
    document.removeEventListener("pointerdown", onDown, options)
    document.removeEventListener("pointerup", onUp, options)
    document.removeEventListener("pointercancel", onUp, options)
    document.removeEventListener("keydown", onKey, options)
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("blur", onAway)
    hold.dispose()
    machine = null
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) attach()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      detach?.()
      detach = null
    }
  }
}

/** Whether the project list's layout is held right now. */
export function useListHold(): boolean {
  return useSyncExternalStore(subscribe, () => machine?.held() ?? false, () => false)
}
