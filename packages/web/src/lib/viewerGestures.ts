import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react"
import { FIT, clampZoom, detailScale, maxScale, panBy, pinch, zoomAbout, type ZoomBounds, type ZoomState } from "./viewerZoom.ts"

// THE PICTURE VIEWERS' GESTURES — the zoom, the pan and the swipe, stated once for both of Ntwine's
// full-screen viewers: the lightbox a ```lightbox gallery opens (components/Lightbox.tsx, upstream's
// 0e81902b) and the picture viewer a click on any single picture opens (components/ImageViewer.tsx, the
// fork's). Each was written for one of them; the picture viewer had fit / actual size and ←/→ only, so a
// screenshot opened from a transcript could not be pinched on a phone, wheel-zoomed, dragged or swiped,
// while the same screenshot in a gallery could (parity ledger, 0e81902b: PARTIAL). One hook, so the two
// cannot drift into two zooms that answer the same finger differently.
//
// What it does, upstream's behaviour unchanged (0e81902b): a mouse click toggles fit and the picture's own
// pixels about the cursor (lib/viewerZoom.ts detailScale); ctrl/⌘ + wheel — a trackpad pinch — and
// Safari's gesture events zoom about the pointer; a plain wheel or a drag moves a magnified picture; the
// caller's + − 0 keys and buttons step it (`zoomBy`, `fit`, `zoomKey`). On a touch screen a pinch zooms and
// pans at once, a double tap toggles, one finger pans a magnified picture, and at fit a sideways swipe
// pages and a vertical one closes. The stage must be `touch-action: none` (the caller's style), so the
// browser claims none of those gestures for the page. Every move is one of the pure moves in
// lib/viewerZoom.ts, applied as ONE transform over the picture's fitted layout box (`pictureTransform`).

type Point = { x: number; y: number }
const ORIGIN: Point = { x: 0, y: 0 }

// What the viewer draws for the picture on screen. Keyed by its path, so paging always lands on the
// next picture at fit (`viewFor`). `pull` is a swipe in progress at fit — the picture follows the finger
// before the release pages or closes; `animate` eases a DISCRETE change (a click, a key, a button, a
// release) and is off for a live gesture, which must track the input frame for frame; `max` is the
// picture's zoom limit, known once a zoom has measured it; `panning` is a drag in progress, for the cursor.
export interface ViewState {
  path: string
  zoom: ZoomState
  pull: Point
  animate: boolean
  max: number
  panning: boolean
}

const viewFor = (path: string): ViewState => ({ path, zoom: FIT, pull: ORIGIN, animate: false, max: Infinity, panning: false })

// One gesture on the stage at a time. A `press` becomes a `pan` (magnified), a `swipe` (a finger at fit)
// or nothing (a mouse at fit) once it moves; a second finger turns anything into a `pinch`.
type Gesture =
  | { kind: "press"; id: number; x: number; y: number }
  | { kind: "pan"; id: number; x: number; y: number }
  | { kind: "swipe"; id: number; x: number; y: number; axis: "x" | "y" }
  | { kind: "pinch"; start: ZoomState; mid: Point; distance: number }

// How far a press travels before it is a drag rather than a click or a tap. A finger wobbles more than a
// mouse.
const DRAG_SLOP = { mouse: 4, touch: 10 }
// A horizontal swipe this long pages; a vertical one this long closes, as it does in a phone's photos.
const PAGE_SWIPE = 48
const CLOSE_SWIPE = 96
// Two taps closer than this in time and space are a double tap.
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 40
// One press of + / − or a zoom button.
export const ZOOM_STEP = 1.5
// A pinch released this close to fit settles AT fit, so a swipe pages again rather than panning 2px.
const FIT_SNAP = 1.1
const SETTLE = "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)"

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** The transform and its easing for the picture (or video) on show: the zoom, plus a swipe's pull. */
export function pictureTransform(view: ViewState, zoom = true): { transform: string; transition: string } {
  const { scale, x, y } = zoom ? view.zoom : FIT
  return {
    transform: zoom ? `translate(${x + view.pull.x}px, ${y + view.pull.y}px) scale(${scale})` : `translate(${view.pull.x}px, ${view.pull.y}px)`,
    transition: view.animate ? SETTLE : "none",
  }
}

export interface ViewerGestureOptions {
  /** The picture on show. A different one starts at fit. */
  path: string
  /** Where it is among the pictures the viewer pages through, and how many there are. */
  index: number
  count: number
  /** Page one picture either way (the caller's store clamps at the ends), and close the viewer. */
  step: (delta: 1 | -1) => void
  close: () => void
  /** The picture's own pixel width, where the element's `naturalWidth` is a stand-in: Chrome answers 300
   *  for an SVG that declares no absolute size (ImageViewer.tsx svgDeclaredSize). The zoom's limits are
   *  measured against it. */
  naturalWidth?: number
}

export interface ViewerGestures {
  /** The stage's ref callback: the element the gestures happen on, and the zoom's clipping box. */
  attachStage: (el: HTMLDivElement | null) => void
  /** The picture element the zoom measures. A video has none, which makes every zoom a no-op. */
  pictureRef: RefObject<HTMLImageElement | null>
  view: ViewState
  zoomed: boolean
  /** Zoom by `factor` about the middle of the stage — a key or a button, where the eye already is. */
  zoomBy: (factor: number) => void
  fit: () => void
  /** + / = zoom in, − / _ zoom out, 0 fits. Unmodified only: ⌘ + / ⌘ − stay the browser's page zoom.
   *  True when it took the key, so the caller prevents its default. */
  zoomKey: (e: KeyboardEvent) => boolean
  /** The stage's handlers. */
  stage: {
    onClick: (e: MouseEvent) => void
    onPointerDown: (e: PointerEvent) => void
    onPointerMove: (e: PointerEvent) => void
    onPointerUp: (e: PointerEvent) => void
    onPointerCancel: (e: PointerEvent) => void
  }
  /** A vertical swipe dims the viewer as it goes, so the release that closes it is already half done. */
  fade: number
}

export function useViewerGestures({ path, index, count, step, close, naturalWidth }: ViewerGestureOptions): ViewerGestures {
  // The stage is held in STATE as well as in a ref, because the effect that wires its native listeners
  // has to run again once it exists: Radix's portal mounts the dialog's content a render AFTER the
  // component that owns it, so on the first pass there is no stage yet, and an effect keyed on anything
  // else never learned that it had arrived — the first picture opened took no wheel at all.
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const attachStage = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el
    setStage(el)
  }, [])
  const pictureRef = useRef<HTMLImageElement>(null)
  // Read through a ref by the native listeners below, which are wired once per stage and path.
  const natural = useRef(naturalWidth)
  natural.current = naturalWidth
  const actions = useRef({ step, close })
  actions.current = { step, close }

  // The view lives in a ref as well as in state: pointer and wheel events arrive faster than React
  // renders, and each must build on the one before it, not on the last render's copy.
  const viewRef = useRef<ViewState>(viewFor(path))
  const [view, setViewState] = useState<ViewState>(viewRef.current)
  const current = () => (viewRef.current.path === path ? viewRef.current : viewFor(path))
  const commit = (patch: Partial<Omit<ViewState, "path">>) => {
    const next = { ...current(), ...patch }
    viewRef.current = next
    setViewState(next)
  }
  const shown = view.path === path ? view : viewFor(path)

  const pointers = useRef(new Map<number, Point>())
  const pointerType = useRef("mouse")
  const gesture = useRef<Gesture | null>(null)
  // Set when a press turned into a drag, a pinch or a double tap, so the `click` the browser fires after
  // it is not ALSO read as a click (which would zoom, or close the viewer).
  const suppressClick = useRef(false)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)

  // The picture's geometry, read from the DOM when a gesture needs it. Coordinates are relative to the
  // centre of the picture's FITTED layout box, which a transform does not move (lib/viewerZoom.ts).
  //
  // That box is recovered from the DRAWN box by undoing the transform the picture wears at this instant
  // — mid-ease included, since the computed transform is the animated one — rather than read from
  // `offsetWidth`/`offsetLeft`, which round to whole pixels: at 2× a rounded centre moved the pixel
  // under the cursor by up to a pixel, and further at higher magnifications.
  const geometry = (): { bounds: ZoomBounds; centre: Point; detail: number } | null => {
    const img = pictureRef.current
    const el = stageRef.current
    const own = natural.current ?? img?.naturalWidth
    if (!img || !el || !own) return null
    const drawn = img.getBoundingClientRect()
    const m = new DOMMatrixReadOnly(getComputedStyle(img).transform)
    const width = drawn.width / m.a
    const height = drawn.height / m.d
    if (!width || !height) return null
    const centre = { x: drawn.left + drawn.width / 2 - m.e, y: drawn.top + drawn.height / 2 - m.f }
    const box = el.getBoundingClientRect()
    return {
      centre,
      bounds: {
        width,
        height,
        left: box.left - centre.x,
        right: box.right - centre.x,
        top: box.top - centre.y,
        bottom: box.bottom - centre.y,
        max: maxScale(width, own),
      },
      detail: detailScale(width, own),
    }
  }
  const local = (client: Point, centre: Point): Point => ({ x: client.x - centre.x, y: client.y - centre.y })

  const setZoom = (zoom: (z: ZoomState, g: NonNullable<ReturnType<typeof geometry>>) => ZoomState, animate: boolean) => {
    const g = geometry()
    if (!g) return
    commit({ zoom: zoom(current().zoom, g), animate, max: g.bounds.max })
  }
  // Fit ⇄ the picture's actual pixels, about the point that was clicked or tapped.
  const toggleZoom = (client: Point) =>
    setZoom((z, g) => (z.scale > 1 ? FIT : zoomAbout(FIT, g.detail, local(client, g.centre), g.bounds)), true)
  const zoomBy = (factor: number) =>
    setZoom((z, g) => zoomAbout(z, factor, { x: (g.bounds.left + g.bounds.right) / 2, y: (g.bounds.top + g.bounds.bottom) / 2 }, g.bounds), true)
  const fit = () => commit({ zoom: FIT, animate: true })

  // The wheel is a NATIVE listener because it must be able to preventDefault, and React registers wheel
  // listeners passive. A trackpad pinch arrives as a wheel with ctrlKey set (Chrome, Firefox, Edge), so
  // ctrl/⌘ + wheel zooms about the cursor — and without the preventDefault the browser would zoom the
  // whole page. A plain wheel or two-finger scroll moves a magnified picture.
  useEffect(() => {
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // A trackpad pinch sends a stream of small deltas and a wheel notch one large one; the clamp
        // keeps a notch to one comfortable step (×1.65) rather than a jump straight to the limit.
        const factor = Math.exp(clamp(-e.deltaY * unit * 0.01, -0.5, 0.5))
        setZoom((z, g) => zoomAbout(z, factor, local({ x: e.clientX, y: e.clientY }, g.centre), g.bounds), false)
      } else if (current().zoom.scale > 1) {
        e.preventDefault()
        setZoom((z, g) => panBy(z, -e.deltaX * unit, -e.deltaY * unit, g.bounds), false)
      }
    }
    // Safari reports a trackpad pinch as its own gesture events instead. Mobile Safari fires them too,
    // alongside the touches the pointer handlers already pinch with, so they are only read with no
    // finger down; they are always prevented, which is what stops the page zooming under the viewer.
    let gestureStart: ZoomState | null = null
    const onGesture = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      if (e.type === "gesturestart") gestureStart = current().zoom
      else if (e.type === "gesturechange" && gestureStart && pointers.current.size === 0) {
        const start = gestureStart
        setZoom((_, geo) => zoomAbout(start, g.scale, local({ x: g.clientX, y: g.clientY }, geo.centre), geo.bounds), false)
      }
    }
    // A stage that changes size (a phone rotated, a window resized) re-fits the picture under the zoom.
    const resized = new ResizeObserver(() => {
      if (current().zoom.scale > 1) setZoom((z, g) => clampZoom(z, g.bounds), false)
    })
    stage.addEventListener("wheel", onWheel, { passive: false })
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) stage.addEventListener(type, onGesture)
    resized.observe(stage)
    return () => {
      stage.removeEventListener("wheel", onWheel)
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) stage.removeEventListener(type, onGesture)
      resized.disconnect()
    }
    // The stage and `path` are the only inputs the handlers close over that a later render can change:
    // everything else they read through refs.
  }, [stage, path])

  const zoomKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP)
    else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP)
    else if (e.key === "0") fit()
    else return false
    return true
  }

  // ── the stage's gestures ──────────────────────────────────────────────────────────────────────────
  // Pointer events, so one set of handlers serves a mouse, a pen and a finger.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    // A press on a control (the paging arrows) is the control's, and so is one on a video: its timeline,
    // volume and play button are the player's, and a scrub must never turn into a swipe that pages away.
    if ((e.target as Element).closest("button, video")) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      pointerType.current = e.pointerType
      suppressClick.current = false
      gesture.current = { kind: "press", id: e.pointerId, x: e.clientX, y: e.clientY }
    } else if (pointers.current.size === 2) {
      const g = geometry()
      const [a, b] = [...pointers.current.values()]
      suppressClick.current = true
      lastTap.current = null
      gesture.current = g ? { kind: "pinch", start: current().zoom, mid: local(midpoint(a!, b!), g.centre), distance: distance(a!, b!) } : null
      if (current().pull !== ORIGIN) commit({ pull: ORIGIN, animate: true })
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    let active = gesture.current
    if (active?.kind === "pinch") {
      const start = active
      const [a, b] = [...pointers.current.values()]
      setZoom((_, g) => pinch(start.start, start.mid, start.distance, local(midpoint(a!, b!), g.centre), distance(a!, b!), g.bounds), false)
      return
    }
    if (!active || active.id !== e.pointerId) return
    if (active.kind === "press") {
      const moved = Math.hypot(e.clientX - active.x, e.clientY - active.y)
      if (moved < (e.pointerType === "mouse" ? DRAG_SLOP.mouse : DRAG_SLOP.touch)) return
      suppressClick.current = true
      lastTap.current = null
      if (current().zoom.scale > 1) active = { kind: "pan", id: active.id, x: active.x, y: active.y }
      else if (e.pointerType !== "mouse") {
        const dx = e.clientX - active.x
        const dy = e.clientY - active.y
        active = { kind: "swipe", id: active.id, x: active.x, y: active.y, axis: Math.abs(dx) > Math.abs(dy) ? "x" : "y" }
      } else active = null // a mouse drag at fit has nothing to move
      gesture.current = active
      if (!active) return
      stageRef.current?.setPointerCapture(e.pointerId)
      if (active.kind === "pan") commit({ panning: true })
    }
    if (active.kind === "pan") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      active.x = e.clientX
      active.y = e.clientY
      setZoom((z, g) => panBy(z, dx, dy, g.bounds), false)
    } else if (active.kind === "swipe") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      // Past either end the picture still follows the finger, at a quarter of its travel, so a swipe
      // into the wall is answered rather than ignored.
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === count - 1)
      commit({ pull: active.axis === "x" ? { x: edge ? dx / 4 : dx, y: 0 } : { x: 0, y: dy }, animate: false })
    }
  }

  const onPointerEnd = (e: PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const active = gesture.current
    if (active?.kind === "pinch") {
      // One finger still down carries on as a pan from where it is now; none settles the picture.
      const [rest] = [...pointers.current.entries()]
      if (current().zoom.scale < FIT_SNAP) fit()
      gesture.current = rest && current().zoom.scale > 1 ? { kind: "pan", id: rest[0], x: rest[1].x, y: rest[1].y } : null
      return
    }
    if (!active || active.id !== e.pointerId) return
    gesture.current = null
    const cancelled = e.type === "pointercancel"
    if (active.kind === "pan") commit({ panning: false })
    if (active.kind === "swipe") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      commit({ pull: ORIGIN, animate: true })
      if (cancelled) return
      if (active.axis === "x" && Math.abs(dx) > PAGE_SWIPE) actions.current.step(dx < 0 ? 1 : -1)
      else if (active.axis === "y" && Math.abs(dy) > CLOSE_SWIPE) actions.current.close()
      return
    }
    // A finger's tap: a second one hard on the first toggles the zoom about it, the way a phone's own
    // photo viewer does. (A mouse zooms on a single click; see onClick.)
    if (active.kind === "press" && !cancelled && e.pointerType !== "mouse") {
      const prev = lastTap.current
      if (prev && e.timeStamp - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX) {
        lastTap.current = null
        suppressClick.current = true
        toggleZoom({ x: e.clientX, y: e.clientY })
      } else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY }
    }
  }

  // A mouse click on the picture zooms in about the cursor, and back out. Off the picture — the backdrop
  // — it closes the viewer at fit, as a click outside any dialog does, and first returns a magnified
  // picture to fit. A finger's single tap on the backdrop closes at fit too; on the picture it waits to
  // see whether it is the first of a double tap.
  const onClick = (e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if ((e.target as Element).closest("button, video")) return
    const mouse = pointerType.current === "mouse"
    if (e.target === pictureRef.current) {
      if (mouse) toggleZoom({ x: e.clientX, y: e.clientY })
    } else if (current().zoom.scale > 1) {
      if (mouse) fit()
    } else actions.current.close()
  }

  return {
    attachStage,
    pictureRef,
    view: shown,
    zoomed: shown.zoom.scale > 1,
    zoomBy,
    fit,
    zoomKey,
    stage: { onClick, onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
    fade: 1 - Math.min(Math.abs(shown.pull.y) / (CLOSE_SWIPE * 3), 0.6),
  }
}
