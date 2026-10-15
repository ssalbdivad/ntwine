// Shared side-sheet primitives — the timing, width curve, scrim, and panel classes that the whole
// right-side drawer family (thread / doc / plan / sub-agent / background-shell) and the settings drawer
// render with. Extracted so these can never drift apart again: they had been copied near-identically
// across six files, and small divergences crept in (settings' scrim was bg-scrim-55, the rest /40).
// One scrim darkness, one slide duration, one width formula, one reduced-motion check.

// Slide-out duration. A layer is removed from the drawer stack (or the settings panel unmounts) after
// this elapses — kept ~10ms past the 200ms CSS transition so removal lands just after the slide ends.
export const SHEET_CLOSE_MS = 210

// The full-screen backdrop: one uniform scrim darkness (bg-scrim-40) that fades with the panel. Layout
// is the consumer's: a plain sheet parks its panel against the right edge by adding `flex justify-end`,
// while ThreadSheet's Radix overlay is a bare scrim whose content is a separately-positioned portal
// sibling — so this string is exactly ThreadSheet's overlay className minus the opacity toggle.
export const SHEET_SCRIM_CLASS =
  "fixed inset-0 bg-scrim-40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none"

// The sliding panel: right-anchored, full-height, bordered, elevated; slides along the X axis. The
// consumer appends the translate toggle (translate-x-0 / translate-x-full) and its own width.
export const SHEET_PANEL_CLASS =
  "ntwine-sheet-panel flex h-full flex-col border-l border-border bg-panel shadow-2xl shadow-shadow-ink/50 transition-transform duration-200 ease-out motion-reduce:transition-none"

// The depth-0 panel width.
const SHEET_BASE_WIDTH = 720

// The stack width curve: each STAYING layer below steps the panel 28px / 4vw narrower so the stack
// reads as a stack. `offset` pulls the effective depth back — ThreadDrawer passes 1 because the ntwine-doc
// is a "flip surface" of the chat drawer for the same thread, not a genuine extra layer, so it must
// render at the width of the drawer beneath it (depth-1) rather than one step narrower.
export function sheetWidth(widthDepth: number, offset = 0): string {
  const depth = Math.max(0, widthDepth - offset)
  return `min(${SHEET_BASE_WIDTH - depth * 28}px, ${80 - depth * 4}vw)`
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}
