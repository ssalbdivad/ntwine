// WHERE THE FULLSCREEN MORPH STARTS: what the reader can SEE of the surface, not the whole of it.
//
// The door's view transition names the queue card (or drawer panel) `thread-chat` and lets the browser
// morph it into the /full thread column. The browser's own group animation runs from the OLD element's
// full border box to the new one's — which for a card that fits on screen is exactly right, and for a
// tall card scrolled to its middle is a disaster. Measured on a 24-turn card, 2869px tall, parked
// halfway down (maintainer 2026-09-12: "full screen animation is not smooth when scrolled to the
// middle of a tall card"): the group's keyframes ran from `translate(629px, -1020px) 720×2869` to
// `translate(190px, 0) 720×900`, so every pixel the reader had in front of them rushed 1020px DOWN
// the screen in 200ms while the new column cross-faded in over it — the card's sticky header, which
// had been 1020px above the viewport, swept through mid-screen at the 40ms frame. The scroll hand-off
// (fullscreenHandoff.ts) had put the same message at the same height on the other side, so the CONTENT
// was continuous and the ANIMATION was the only thing moving it.
//
// The fix keeps the browser's morph and changes only its starting box: the door measures the part of
// the surface inside the viewport and hands it to the group's `from` keyframe through custom
// properties (`--ntwine-vt-from-*`), gated by `data-vt-door` on the root so the reverse leg — whose old
// element is the /full column, always fully on screen — keeps the browser's own keyframes. The old
// snapshot is still the whole card; a negative top margin slides the reader's part up to the group's
// top edge. That margin is a PERCENTAGE of the group's width rather than a pixel count on purpose: the
// snapshot is `inline-size: 100%; block-size: auto`, so it scales with the group as the card's width
// morphs into the column's, and a percentage of the same width is the one unit that scales with it.
//
// Mid-card, top and bottom both off screen, the morph is now a horizontal slide of what the reader
// was looking at into the column's position, cross-fading onto the same text — measured after: from
// `translate(629px, 0) 720×900` to `translate(190px, 0) 720×900`. A card whose top is on screen
// still starts from that top edge, exactly as before: nothing is clipped that was visible.

export interface MorphBox {
  left: number
  top: number
  width: number
  height: number
}

export interface MorphStart {
  /** The starting box the group animates from: the surface's visible part, in viewport coordinates. */
  box: MorphBox
  /** How far the surface's own top sits above the visible part, as a fraction of its width (≤ 0), so
   *  the old snapshot can be slid up by a margin that tracks the group's width as it morphs. */
  oldShiftFraction: number
}

/**
 * The visible part of `rect` in a `viewport` of the given size — the whole decision as arithmetic, so
 * it can be tested without a browser. Null when none of the surface is on screen (or it has no size):
 * then there is nothing to morph from and the browser's own keyframes are the right answer.
 */
export function visibleMorphStart(rect: MorphBox, viewport: { width: number; height: number }): MorphStart | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const top = Math.max(rect.top, 0)
  const bottom = Math.min(rect.top + rect.height, viewport.height)
  const left = Math.max(rect.left, 0)
  const right = Math.min(rect.left + rect.width, viewport.width)
  if (bottom <= top || right <= left) return null
  return {
    // The width is kept whole even when the surface runs past a side edge: the snapshot is sized by the
    // group's inline size, and narrowing it would rescale the whole image. Only the vertical extent is
    // what a tall card scrolls, and only that is trimmed.
    box: { left: rect.left, top, width: rect.width, height: bottom - top },
    oldShiftFraction: (rect.top - top) / rect.width,
  }
}

/** The attribute the styles are gated on; present on `<html>` from the door press until the reverse
 *  leg is primed. */
export const MORPH_DOOR_ATTR = "data-vt-door"

/**
 * Measure `surface` and arm the forward morph to start from its visible part. Called by the door at
 * click time, BEFORE the navigation starts the transition: the custom properties must be in place when
 * the browser builds the transition's pseudo-elements, which happens after the new page renders.
 */
export function armFullscreenMorph(surface: HTMLElement): MorphStart | null {
  if (typeof window === "undefined") return null
  const rect = surface.getBoundingClientRect()
  const start = visibleMorphStart({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight })
  const root = document.documentElement
  if (!start) {
    disarmFullscreenMorph()
    return null
  }
  root.style.setProperty("--ntwine-vt-from-x", `${start.box.left}px`)
  root.style.setProperty("--ntwine-vt-from-y", `${start.box.top}px`)
  root.style.setProperty("--ntwine-vt-from-w", `${start.box.width}px`)
  root.style.setProperty("--ntwine-vt-from-h", `${start.box.height}px`)
  root.style.setProperty("--ntwine-vt-old-shift", `${start.oldShiftFraction * 100}%`)
  root.setAttribute(MORPH_DOOR_ATTR, "expand")
  return start
}

/**
 * Drop the forward morph's start box. Called render-phase by the board's return from /full
 * (store.primeFullscreenReturn), which runs inside the reverse transition's update callback — after
 * the old /full page is captured and BEFORE the browser builds the reverse leg's pseudo-elements — so
 * the reverse morph resolves to the browser's own keyframes. NOT a timer: the gated rules style LIVE
 * pseudo-elements, so removing the attribute while the forward animation is still running would
 * restart the group from the browser's keyframes mid-flight, which is the very jump this exists to
 * remove. (vtReturnTarget's timer is safe for the NAME, which the browser reads once at capture.)
 */
export function disarmFullscreenMorph(): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.removeAttribute(MORPH_DOOR_ATTR)
  for (const name of ["--ntwine-vt-from-x", "--ntwine-vt-from-y", "--ntwine-vt-from-w", "--ntwine-vt-from-h", "--ntwine-vt-old-shift"]) {
    root.style.removeProperty(name)
  }
}
