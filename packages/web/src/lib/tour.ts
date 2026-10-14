import { useSyncExternalStore } from "react"

// FIRST RUN — the tour a browser sees once (components/Onboarding.tsx Tour), over the first page it shows:
// All projects for a new browser, or whichever board a link opened.
//
// "Once" is per BROWSER, like the last view (crossProject.ts): `ntwine.onboarded` is written when the tour
// ends, however it ends. A browser that already has a view on record from before the onboarding existed
// gets it too, since the tour shows what the page has become since. Captured at module load, so the decision holds for the whole page.

const ONBOARDED_KEY = "ntwine.onboarded"

function read(): boolean {
  // An automated browser never gets it unasked: every e2e here runs a fresh profile, and a picker in front of
  // the board or an overlay over it would stand in the way of whatever it came to check.
  if (typeof navigator !== "undefined" && navigator.webdriver) return true
  try {
    return localStorage.getItem(ONBOARDED_KEY) !== null
  } catch {
    // Storage disabled: nothing could remember the tour was seen, so never start it on its own.
    return true
  }
}

let onboarded = read()

export function hasOnboarded(): boolean {
  return onboarded
}

function markOnboarded(): void {
  onboarded = true
  try {
    localStorage.setItem(ONBOARDED_KEY, "1")
  } catch {
    // Storage disabled: see read().
  }
}

// THE TOUR'S STEP, live across the page: null when no tour is showing. Module state rather than a store
// field, since the store is reset on every project switch (store.resetProjectState) and the tour starts
// exactly on one.
let step: number | null = null
const listeners = new Set<() => void>()

function set(next: number | null): void {
  if (step === next) return
  step = next
  for (const listener of listeners) listener()
}

/** Show the tour from its first step — on first arrival, and from the command palette's "Take the tour". */
export function startTour(): void {
  set(0)
}

/** Start the tour if this browser has never seen it. */
export function startTourOnFirstRun(): void {
  if (!onboarded) set(0)
}

export function setTourStep(next: number): void {
  set(next)
}

/** Close the tour, finished or skipped, and remember it was seen. */
export function endTour(): void {
  markOnboarded()
  set(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTourStep(): number | null {
  return useSyncExternalStore(subscribe, () => step, () => null)
}

/** The tour's step that holds the project switcher's menu open, so its arrows have the menu to point at.
 *  Last before the closing card (components/Onboarding.tsx STEPS): All projects is where a new browser
 *  lands, so the tour teaches it before the menu that leaves it. */
export const SWITCHER_STEP = 3

/** Whether the tour is holding the project switcher's menu open right now. */
export function useTourHoldsSwitcher(): boolean {
  return useTourStep() === SWITCHER_STEP
}
