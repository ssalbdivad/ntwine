import { useCallback, useEffect, useRef, useState } from "react"

// BACK CLOSES THE SHEET FIRST — a phone's back gesture (Android's edge swipe, the browser's own button)
// must dismiss whatever is floating over the page before it leaves the page. The thread under a phone
// sheet is already a history entry of its own (lib/router pushes one per opened thread layer), so a
// sheet that took no entry of its own would let Back skip straight past it and close the thread, with
// the sheet still up for the 200ms the drawer takes to slide away.
//
// So a sheet PUSHES ONE SAME-URL ENTRY while it is mounted, tagged with a token, and closes when the
// history moves off that entry. Three rules keep it from leaking entries or stepping on the router:
//
//   · SAME URL, router state copied. react-router keeps `{usr, key, idx}` in history.state; the entry
//     carries the router's current values plus our tag, so when Back lands on the router's entry the
//     router sees the location it already has and changes nothing (routes.tsx re-applies the URL only
//     when the PATHNAME changes). Written behind the router's back on purpose: its own navigate()
//     REPLACES on a same-path push, which is exactly the entry this needs.
//   · EVERY OTHER CLOSE GOES THROUGH BACK TOO. A scrim tap, Escape or an action row pops our own entry
//     (`dismiss`), and the popstate is what closes the sheet — so there is one close path, and the entry
//     is gone by the time the caller unmounts. `dismiss(then)` runs `then` only after the pop has
//     landed: an action that itself navigates (Mark as done closes the thread, which REPLACES the
//     current entry) must replace the thread's entry, not the sheet's, or Back would reopen the thread.
//   · NEVER POP AN ENTRY THAT IS NOT OURS. Every `back()` is guarded on the tag still being on top, so a
//     navigation that already replaced it (the thread closing under the sheet) is not answered with a
//     second, wrong step back.
//
// The drawer layers that stack over a phone thread (the file reader, the ntwine doc, a sub-agent, a
// background shell) take an entry the same way — `useBackClosesLayer` below — so Back peels them one at
// a time too. They share this file's tag and counter, so every entry either kind pushes is ordered
// against every other.
//
// The counter starts at the clock rather than at 0 because history.state OUTLIVES a reload: an entry
// tagged 5 by the previous document is still in the stack, and a fresh count from 1 would read it as
// pushed ABOVE this document's layers.
let seq = Date.now()
// Every token this document mints is above this; every token a previous document minted is below it.
const documentStart = seq

type LayerHistoryState = { ntwineLayer?: number } | null

function currentToken(): number | undefined {
  return (history.state as LayerHistoryState)?.ntwineLayer
}

/**
 * A RELOAD ON A LAYER ENTRY. history.state outlives a document load, so reloading with a sheet or a
 * reader up restores that layer's same-URL entry with nothing left to own it: the sheet is gone and its
 * entry stays. The page then sits one dead step above the router's own entry for the same URL. Back
 * did nothing visible, and the phone thread header's ← (which pops when the router pushed the entry,
 * lib/router appPushedCurrentEntry) popped onto the SAME thread and looked broken.
 *
 * No layer survives a document load, so any layer entry the document boots on is stale. Step off it
 * before anything else can push: a same-URL pop the router ignores (routes.tsx re-applies the URL
 * only when the pathname changes) and no listener here hears (nothing is mounted yet). Stacked layers
 * (a reader over a reader) left one entry each, so keep stepping while the entry under is another
 * stale one. main.tsx calls this once, at boot.
 *
 * A stale entry is still FORWARD of the page afterwards: a Forward press straight after the reload
 * lands on it as one dead step. The next push (opening anything) drops it from the history.
 */
export function stepOffStaleLayerEntries(): void {
  const stale = (token: number | undefined) => token !== undefined && token < documentStart
  if (!stale(currentToken())) return
  const onPop = () => {
    if (stale(currentToken())) history.back()
    else window.removeEventListener("popstate", onPop)
  }
  window.addEventListener("popstate", onPop)
  history.back()
}

// One same-URL entry carrying the router's state (so react-router sees the location it already has)
// plus a fresh tag. Returns the tag.
function pushLayerEntry(): number {
  const token = ++seq
  const base = history.state && typeof history.state === "object" ? history.state : {}
  history.pushState({ ...base, ntwineLayer: token }, "")
  return token
}

export function useBackDismiss(onDismissed: () => void): (then?: () => void) => void {
  const dismissedRef = useRef(onDismissed)
  dismissedRef.current = onDismissed
  const tokenRef = useRef(0)
  const doneRef = useRef(false)
  const thenRef = useRef<(() => void) | null>(null)
  // A pop that never arrives (a browser that ignores back() on an entry it considers its own) must not
  // leave the sheet stuck open; the fallback finishes it by hand.
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    clearTimeout(fallbackRef.current)
    dismissedRef.current()
    const then = thenRef.current
    thenRef.current = null
    then?.()
  }, [])

  useEffect(() => {
    const token = pushLayerEntry()
    tokenRef.current = token
    const onPop = () => {
      if (currentToken() !== token) finish()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      clearTimeout(fallbackRef.current)
      // Unmounted by its owner without a Back (the page under it went away): take our entry off if it
      // is still the current one, so it does not sit in the history as a dead step.
      if (currentToken() === token) history.back()
    }
  }, [finish])

  return useCallback((then?: () => void) => {
    if (doneRef.current) return
    thenRef.current = then ?? null
    if (currentToken() !== tokenRef.current) {
      finish()
      return
    }
    history.back()
    fallbackRef.current = setTimeout(finish, 400)
  }, [finish])
}

/**
 * BACK CLOSES THE DRAWER FIRST — the same rule for a drawer-stack layer on the phone.
 *
 * A thread layer has a history entry of its own because it has a URL (lib/router pushes one per opened
 * thread). The layers that stack over it do not: a reader opened from the Files and links sheet, the
 * ntwine doc, a sub-agent's transcript, a background shell. With no entry of their own, Back popped the
 * THREAD's entry and closed the thread and the reader over it in one step. So each of those layers
 * pushes one tagged same-URL entry while it is open (the `useBackDismiss` entry above, the same tag),
 * and closes when the history moves below it.
 *
 * Unlike the bottom sheet, a drawer is also closed by paths that never see this hook — its ×, Escape,
 * the store unwinding the stack for a lateral open — so it does not route every close through Back.
 * It watches its own `closing` flag instead, and when the layer starts to close with its entry still on
 * top, it takes the entry off. That step is DEFERRED a task and re-checked: a close that is part of a
 * navigation (another thread opening pushes its own URL in the same turn) has put a newer entry on top
 * by then, and a `back()` would pop THAT one. The entry is left behind in that case as one dead step,
 * which is the lesser harm.
 *
 * "Below it" is a token comparison, not an equality: a reader stacked over another reader pushed a
 * newer entry, and Back from the top one must close it and leave the one under it alone.
 *
 * `enabled` is read once, at open: the phone is where this belongs (a desktop drawer never had an
 * entry, and the desktop's history must not change); a window resized across the breakpoint while a
 * drawer is up keeps the behaviour it opened with.
 */
export function useBackClosesLayer(enabled: boolean, closing: boolean, close: () => void): void {
  const [active] = useState(enabled)
  const closeRef = useRef(close)
  closeRef.current = close
  const closingRef = useRef(closing)
  closingRef.current = closing
  const tokenRef = useRef(0)
  // Set once this layer has asked for its entry to be popped, so the close path and the unmount path
  // (which arrive one task apart when reduced motion removes the layer at once) never pop twice.
  const poppedRef = useRef(false)

  const popLater = useCallback((onlyWhileClosing: boolean) => {
    const token = tokenRef.current
    window.setTimeout(() => {
      if (poppedRef.current || (onlyWhileClosing && !closingRef.current)) return
      if (currentToken() !== token) return
      poppedRef.current = true
      history.back()
    }, 0)
  }, [])

  useEffect(() => {
    if (!active) return
    tokenRef.current = pushLayerEntry()
    const onPop = () => {
      const current = currentToken()
      if (current === undefined || current < tokenRef.current) closeRef.current()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      popLater(false)
    }
  }, [active, popLater])

  useEffect(() => {
    if (!active || !tokenRef.current) return
    if (closing) {
      popLater(true)
      return
    }
    // A rapid re-open cancelled the close after the entry had already gone: take a fresh one.
    const current = currentToken()
    if (poppedRef.current || current === undefined || current < tokenRef.current) {
      poppedRef.current = false
      tokenRef.current = pushLayerEntry()
    }
  }, [active, closing, popLater])
}
