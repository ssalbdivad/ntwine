// THE SCROLL HALF of "the queue never moves a card the human is looking at" (David 2026-09-28:
// "it needs to be guaranteed that cards that I'm currently viewing on the screen don't move in their
// position"). lib/stableQueue.ts decides the ORDER — nothing is inserted between the cards on screen and
// none of them leaves on its own — which leaves every change either BELOW them, where it moves nothing,
// or ABOVE them, where it moves them in the document. This scrolls by exactly that much, before the
// frame paints, so on screen they have not moved.
//
// WHY NOT THE BROWSER'S OWN SCROLL ANCHORING, which exists to do exactly this: it fails in the places the
// queue puts the reader. Chrome does not anchor at scroll offset 0 — where the first card lands after
// every dismissal and every rail click to it — and it anchors on the first visible node in DOM order,
// which near the top is the READY header, ABOVE the insertion point. Both were probed (a card inserted
// above the reader moved it 840px in each), and FIFO puts the reader on the first card, so its normal
// working position was the one where anchoring never ran. So native anchoring is switched off on the
// document while a queue is on screen, and this does its job in every position.
//
// THE ANCHOR is the card the human is engaged with, in order: the one they are TYPING in (the text box
// itself is held, so the caret does not move — while the box is on screen; one scrolled away from is
// not being typed in), the one under the pointer (they are about to click something in it — until they
// use the keyboard, after which a mouse parked over one card says nothing about the card they are
// reading), else the one at the reading line a third of the way down the viewport (they are reading it). For the last two the card's first node visible from the top of the viewport is held, as
// the browser's own anchoring picks one — never the element under the pointer: a card that grows under
// it ("Show more", its own new content) must grow DOWNWARD, and holding a button at the bottom of a
// growing body would hold the bottom and push the card's top up off the screen. It is re-taken on every
// scroll, pointer move and focus change, and after every correction, so it always describes the page as
// the human last saw it; a change is measured against it and undone.
//
// WHICH CARDS ARE ON SCREEN (where lib/stableQueue.ts lets a card that left the queue hold its place) is
// measured with a margin of a quarter of the viewport either side: a render can land between a scroll and
// the re-measure it schedules, and a card that had just scrolled into view must already count. And when
// that set changes, the host is asked to render again once the scrolling settles, so a ghost or a fading
// card the reader has scrolled away from goes while nobody is looking at it — never mid-scroll, where the
// correction would be an instant scroll cancelling the human's own.
//
// A RELOAD is the one move this cannot absorb as it happens — the dev server's full reload, a new build's,
// a restart's — and it used to land the reader at the top of a queue re-laid from nothing. A REMOUNT is
// the same move without the reload: an edit hot-swapping the page's module, the queue's error boundary
// recovering from a torn build. So the card being read and its offset are written down as the page goes
// or the queue unmounts, and when it comes back the page is held on that card, at that offset, while the
// queue loads around it: until the human scrolls, or a few seconds after the card first appears.
//
// It runs after every render of the queue (a layout effect: after the DOM changed, before paint) and
// whenever the document's size changes (a ResizeObserver: a card that fetched its transcript, an image
// that loaded — also before paint). A human's own scroll is never fought: it re-takes the anchor.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { isPageScrollLocked, pageScrollY, pinPageAt } from "./pageScrollLock.ts"

// ---- native anchoring: one owner ------------------------------------------------------------------

// Reference-counted, because more than one owner can suspend native anchoring at once (this lock for as
// long as a queue is mounted — one per mounted queue — and whatever brackets a deliberate correction of
// its own): if each captured the prior value on its own, one could catch another's "none" as the value
// to restore and leave anchoring off for the rest of the session. The FIRST suspend captures the real
// prior policy, the LAST release restores it.
let anchorSuspendCount = 0
let anchorPrevPolicy = ""
export function suspendNativeAnchoring(): void {
  if (anchorSuspendCount++ === 0) {
    anchorPrevPolicy = document.documentElement.style.overflowAnchor
    document.documentElement.style.overflowAnchor = "none"
  }
}
export function resumeNativeAnchoring(): void {
  if (anchorSuspendCount > 0 && --anchorSuspendCount === 0) {
    document.documentElement.style.overflowAnchor = anchorPrevPolicy
  }
}

// ---- deliberate moves: the lock stands aside ------------------------------------------------------

// A move the HUMAN asked for — a glide to a card they chose (glideTo, below) — must not be undone as if
// it were drift. It brackets itself with these; on the last release every mounted lock re-takes its
// anchor from wherever the move left the page.
let lockSuspendCount = 0
const resumeListeners = new Set<() => void>()
export function suspendViewportLock(): void {
  lockSuspendCount++
}
export function resumeViewportLock(): void {
  if (lockSuspendCount > 0 && --lockSuspendCount === 0) for (const listener of resumeListeners) listener()
}

// A deliberate SMOOTH scroll — a rail row, a `j`/`k`, back to the top. The lock stands aside for the
// glide: its corrections are instant scrolls, and an instant scroll cancels a smooth one wherever it has
// got to, stranding the reader halfway. Content that moved under the glide moved its target too, so when
// the glide ends it re-lands on where the target is NOW — unless the human took the scroll over (a wheel,
// a touch, a click, a key), in which case where they are is theirs. A new glide ends the one before it.
let endGlide: ((reland: boolean) => void) | null = null
const GLIDE_TIMEOUT_MS = 1_200

/** Whether a glide is still under way — for a caller holding its target as "the card being read" until
 *  the glide lands (AllQueues.tsx useQueueKeys), however far it has to travel. */
export function gliding(): boolean {
  return endGlide !== null
}

/** Smooth-scroll the page to `target()` (a page offset, read again when the glide ends). Returns the offset it set out for. */
export function glideTo(target: () => number): number {
  endGlide?.(false)
  const top = Math.max(0, target())
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  if (reduced || isPageScrollLocked()) {
    if (!isPageScrollLocked()) window.scrollTo({ top, left: 0, behavior: "instant" })
    return top
  }
  const started = performance.now()
  suspendViewportLock()
  const takeover = (event: Event) => {
    // The event that STARTED this glide (a `j`, a click on a row) is still propagating past these listeners.
    if (event.timeStamp < started) return
    end(false)
  }
  const end = (reland: boolean) => {
    if (endGlide !== end) return
    endGlide = null
    window.clearTimeout(timer)
    window.removeEventListener("scrollend", onEnd)
    for (const type of TAKEOVER) window.removeEventListener(type, takeover, true)
    if (reland) {
      const now = Math.max(0, target())
      if (Math.abs(now - pageScrollY()) > 0.5) window.scrollTo({ top: now, left: 0, behavior: "instant" })
    }
    resumeViewportLock()
  }
  const onEnd = () => end(true)
  endGlide = end
  window.addEventListener("scrollend", onEnd)
  for (const type of TAKEOVER) window.addEventListener(type, takeover, { capture: true, passive: true })
  // A glide that goes nowhere fires no `scrollend`.
  const timer = window.setTimeout(onEnd, GLIDE_TIMEOUT_MS)
  window.scrollTo({ top, left: 0, behavior: "smooth" })
  return top
}
const TAKEOVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const

// ---- geometry ---------------------------------------------------------------------------------------

interface Anchor {
  /** The element held still. */
  node: Element
  top: number
  /** Its card: held instead if the node itself is replaced by a re-render. */
  slot: HTMLElement
  slotTop: number
  /**
   * The page offset when it was taken. The anchor is re-taken a frame after a scroll, so a render can
   * land between the human's scroll and the re-take: measured against the offset, their scroll is theirs
   * and only what moved the content under them is undone.
   */
  scrollY: number
}

const onScreen = (rect: DOMRect, viewport: number): boolean => rect.bottom > 0 && rect.top < viewport

// Stuck to the viewport rather than carried by the content, so useless as an anchor: a card's sticky
// header stays at the top of the window while the card scrolls under it.
function pinned(element: Element): boolean {
  const position = getComputedStyle(element).position
  return position === "sticky" || position === "fixed" || position === "absolute"
}
// A box that takes text, where a moved caret is a moved line under the human's eyes.
function typingIn(element: HTMLElement): boolean {
  if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true
  return element instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].includes(element.type)
}

// The browser's own pick, done where it would not: descend to the first element whose top is visible,
// passing over anything pinned or empty. Children in block flow are in vertical order, so the scan
// stops at the first one reaching into the viewport.
function firstVisibleNode(slot: HTMLElement): Element {
  let node: Element = slot
  for (let depth = 0; depth < 32; depth++) {
    let next: Element | null = null
    for (const child of node.children) {
      const rect = child.getBoundingClientRect()
      if (rect.height === 0 || rect.bottom <= 0) continue
      if (pinned(child)) continue
      next = child
      break
    }
    if (!next) return node
    if (next.getBoundingClientRect().top >= 0) return next
    node = next
  }
  return node
}

function scrollPage(delta: number): void {
  if (isPageScrollLocked()) {
    // A drawer holds the page with the body pinned at `top: -y` (App.tsx); the page's real offset is that
    // top, and App's unlock restores whatever it reads there — so the correction lands after the drawer
    // closes too, instead of the unlock returning to an offset the content has since moved away from.
    const top = Number.parseFloat(document.body.style.top) || 0
    pinPageAt(top - delta)
    return
  }
  window.scrollBy({ top: delta, left: 0, behavior: "instant" })
}

export interface ViewportLock {
  /** Keys of the cards on (or within a margin of) the screen at the last measurement — lib/stableQueue.ts's `onScreen`. */
  onScreen: RefObject<ReadonlySet<string>>
}

/** How far past each edge of the viewport a card still counts as on screen, as a share of the viewport. */
const ON_SCREEN_MARGIN = 0.25
/** How long the page must sit still after a scroll before the host is asked to render again. */
const SETTLE_MS = 250

// ---- across a reload ----------------------------------------------------------------------------------

const RELOAD_KEY = "ntwine.queueReading.v1"
/** A note older than this is from an earlier visit, not the reload that is loading now. */
const RELOAD_FRESH_MS = 60_000
/**
 * How long the page is held on the card after it first appears, while the cards around it load — and
 * after every correction since: a slow machine is still loading the cards above it when a fixed window
 * has run out, and the one the reader was on went down the page by what arrived late.
 */
const RELOAD_HOLD_MS = 3_000
const RELOAD_QUIET_MS = 1_000
/** How long to wait for the card at all. */
const RELOAD_GIVE_UP_MS = 20_000

interface Reading {
  path: string
  slots: string
  key: string
  /** The card's top, from the top of the viewport. */
  top: number
  at: number
}

function readReading(slots: string): Reading | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY)
    if (!raw) return null
    sessionStorage.removeItem(RELOAD_KEY)
    const reading = JSON.parse(raw) as Reading
    if (reading.slots !== slots || reading.path !== location.pathname || Date.now() - reading.at > RELOAD_FRESH_MS) return null
    return reading
  } catch {
    return null
  }
}

/**
 * Hold the queue's cards still on screen. `slots` selects every card slot of this queue; `keyOf` reads a
 * slot's key (the one lib/stableQueue.ts orders by). `repaint` asks the owner to render again, once the
 * page is still: when a ghost slot (`data-queue-ghost`) has left the screen, so it can be dropped now
 * that nobody sees it go, and when the cards on screen have changed, so the ones held back for the old
 * set can take their places.
 */
export function useViewportLock(slots: string, keyOf: (slot: HTMLElement) => string | undefined, repaint: () => void): ViewportLock {
  const onScreenRef = useRef<ReadonlySet<string>>(new Set())
  const anchor = useRef<Anchor | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const latest = useRef({ slots, keyOf, repaint })
  latest.current = { slots, keyOf, repaint }
  // What the last repaint request was for, so a page that has not changed asks for nothing.
  const asked = useRef({ keys: "", ghostGone: false })
  const settle = useRef({ timer: 0, pending: false })
  // The card to hold after a reload (Reading), until `until` — pushed out to RELOAD_HOLD_MS once it is found.
  // The note a reload or remount leaves (Reading), kept current on every measurement: by the time the queue
  // unmounts its cards are already gone from the page and cannot be measured.
  const note = useRef<Reading | null>(null)
  // `y`: the page offset the restore last left, so any other scroll — the human's, or the app's own landing
  // on a card the address names — is seen as taking the page over.
  const restoring = useRef<{ key: string; top: number; until: number; giveUp: number; found: boolean; y: number } | null>(null)
  const requestRepaint = useRef(() => {})
  requestRepaint.current = () => {
    settle.current.pending = true
    window.clearTimeout(settle.current.timer)
    settle.current.timer = window.setTimeout(() => {
      settle.current.pending = false
      latest.current.repaint()
    }, SETTLE_MS)
  }

  // Measure the page as the human sees it now: which cards are on screen, and what to hold still.
  const take = useRef(() => {})
  take.current = () => {
    const { slots, keyOf } = latest.current
    const restore = restoring.current
    if (restore) {
      // The card goes back FIRST, and only then is the restore asked whether it is over. The other way
      // round, the render that ended it handed the lock a page it had not put back: under load the cards
      // above lay out at their real height seconds late, the restore timed out on exactly that render,
      // and the lock held whatever the moved page put at the reading line — a node low in the first
      // card, whose body then clamped and carried the page up 576px (measured 2026-09-28).
      const slot = [...document.querySelectorAll<HTMLElement>(slots)].find((candidate) => keyOf(candidate) === restore.key)
      const now = performance.now()
      let next = restore
      if (slot) {
        const delta = slot.getBoundingClientRect().top - restore.top
        let until = restore.found ? restore.until : now + RELOAD_HOLD_MS
        if (Math.abs(delta) > 0.5) {
          scrollPage(delta)
          until = Math.min(restore.giveUp, Math.max(until, now + RELOAD_QUIET_MS))
        }
        next = { ...restore, y: pageScrollY(), found: true, until }
      }
      restoring.current = now > next.until ? null : next
    }
    const viewport = window.innerHeight
    const margin = viewport * ON_SCREEN_MARGIN
    const visible: HTMLElement[] = []
    const keys = new Set<string>()
    let ghostGone = false
    for (const slot of document.querySelectorAll<HTMLElement>(slots)) {
      const rect = slot.getBoundingClientRect()
      if (rect.bottom > -margin && rect.top < viewport + margin) {
        const key = keyOf(slot)
        if (key) keys.add(key)
      }
      if (onScreen(rect, viewport)) visible.push(slot)
      else if (slot.hasAttribute("data-queue-ghost") && !keys.has(keyOf(slot) ?? "")) ghostGone = true
    }
    onScreenRef.current = keys
    const next = pick(visible, viewport)
    const was = anchor.current
    // The same node still held, within a pixel of where it is SUPPOSED to be: keep the supposed place. A
    // change under half a pixel is left alone (a scroll cannot draw it), and re-reading the position after
    // each one would bank it — two renders of 0.49px each and the caret had moved a whole pixel. Only that
    // residue is carried: anything larger is on screen already (a reload's restore, a move nothing
    // corrected), and "correcting" it at the next render would be a second jump, not a hold.
    if (next && was && next.node === was.node) {
      const scrolled = next.scrollY - was.scrollY
      if (Math.abs(next.top - (was.top - scrolled)) <= 1) {
        next.top = was.top - scrolled
        if (next.slot === was.slot) next.slotTop = was.slotTop - scrolled
      }
    }
    anchor.current = next
    const noteKey = next && keyOf(next.slot)
    note.current = next && noteKey ? { path: location.pathname, slots, key: noteKey, top: next.slot.getBoundingClientRect().top, at: 0 } : null
    const signature = [...keys].join("\n")
    if (signature !== asked.current.keys || (ghostGone && !asked.current.ghostGone)) requestRepaint.current()
    asked.current = { keys: signature, ghostGone }
  }

  const pick = (visible: HTMLElement[], viewport: number): Anchor | null => {
    if (visible.length === 0) return null
    const scrollY = pageScrollY()
    const hold = (slot: HTMLElement, node: Element): Anchor => ({ node, top: node.getBoundingClientRect().top, slot, slotTop: slot.getBoundingClientRect().top, scrollY })
    const focused = document.activeElement
    if (focused instanceof HTMLElement && typingIn(focused) && onScreen(focused.getBoundingClientRect(), viewport)) {
      const slot = visible.find((candidate) => candidate.contains(focused))
      if (slot) return hold(slot, focused)
    }
    const at = pointer.current
    if (at) {
      const under = document.elementFromPoint(at.x, at.y)
      const slot = under && visible.find((candidate) => candidate.contains(under))
      if (slot) return hold(slot, firstVisibleNode(slot))
    }
    const line = viewport / 3
    const reading = visible.find((slot) => { const rect = slot.getBoundingClientRect(); return rect.top <= line && rect.bottom >= line }) ?? visible[0]!
    return hold(reading, firstVisibleNode(reading))
  }

  // Undo whatever moved the anchor since it was taken.
  const hold = useRef(() => {})
  hold.current = () => {
    const held = anchor.current
    // Restoring a reload holds the page on its own card (take), which this would fight.
    if (!held || lockSuspendCount > 0 || restoring.current) return
    // THE BROWSER'S CLAMP IS NOT A SCROLL. A page at its end that gets shorter has its offset clamped to the
    // new end by the browser, and that clamp already holds everything below the shrink where it was; read as
    // the human's scroll, it was undone a second time, and the page scrolled UP by the shrink — measured
    // 2026-10-02 on the 60-card fixture at its end, a card above the reader built 111px shorter than its
    // guess left a 111px gap under the last card, for good. So the offset the anchor was taken at counts
    // only as far as the page still reaches. (A drawer pins the page instead of scrolling it: nothing clamps.)
    const reach = isPageScrollLocked() ? held.scrollY : Math.min(held.scrollY, Math.max(0, (document.scrollingElement ?? document.documentElement).scrollHeight - window.innerHeight))
    const scrolled = pageScrollY() - reach
    let delta = 0
    if (held.node.isConnected) delta = held.node.getBoundingClientRect().top - (held.top - scrolled)
    else if (held.slot.isConnected) delta = held.slot.getBoundingClientRect().top - (held.slotTop - scrolled)
    // The card itself is gone — the human put it away, and the dismissal landing owns what comes next.
    else return
    if (Math.abs(delta) <= 0.5) return
    const from = pageScrollY()
    scrollPage(delta)
    // The correction is not the human's scroll: the anchor is where it was supposed to be again, at the
    // new offset (take reads the gap between the two as their scroll).
    held.scrollY += pageScrollY() - from
  }

  // After every render of the queue: the DOM has changed, the frame has not painted.
  useLayoutEffect(() => {
    hold.current()
    take.current()
  })

  useEffect(() => {
    suspendNativeAnchoring()
    // The browser's own restore would put back a pixel offset into a page that has not loaded yet; the
    // note below puts back the CARD.
    const restorationWas = history.scrollRestoration
    history.scrollRestoration = "manual"
    const reading = readReading(latest.current.slots)
    if (reading) {
      const giveUp = performance.now() + RELOAD_GIVE_UP_MS
      restoring.current = { key: reading.key, top: reading.top, until: giveUp, giveUp, found: false, y: pageScrollY() }
    }
    const stopRestoring = (event: Event) => {
      if (event.isTrusted) restoring.current = null
    }
    const leaveNote = () => {
      if (!note.current) return
      try {
        sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ ...note.current, at: Date.now() }))
      } catch {
        // Storage full or blocked: the page comes back where the browser puts it.
      }
    }
    const onHide = () => {
      restoring.current = null
      take.current()
      leaveNote()
    }
    // A key is the keyboard reading: the pointer stops counting until it moves again.
    const onKey = () => {
      pointer.current = null
    }
    let frame = 0
    // UNDO FIRST, THEN RE-TAKE. A re-take in an animation frame runs BEFORE that frame's layout and the
    // ResizeObserver below, so anything that moved the cards since the last frame — a card above the reader
    // built or laid out at its real height, its handoff landing — was taken as the page "as the human last
    // saw it" and never undone, whenever a scroll event fell in the same frame. And the lock's own
    // correction is a scroll, so its next frame always has one. Holding first undoes such a move (net of
    // any scroll since: `hold` measures against the offset the anchor was taken at), and only then is the
    // page re-read. Measured 2026-10-02 on the 244-card mirror, a jump to the middle while the page was
    // still building its cards (lib/cardVisibility.ts): the card being read moved 106-250px within 3s
    // without this, 0.7-0.9px with it.
    const retake = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        hold.current()
        take.current()
      })
    }
    // Still scrolling: the repaint waits for the page to sit still. And a scroll the restore did not make
    // ends it.
    const onScroll = () => {
      const restore = restoring.current
      if (restore && Math.abs(pageScrollY() - restore.y) > 1) restoring.current = null
      if (settle.current.pending) requestRepaint.current()
      retake()
    }
    const onPointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
      retake()
    }
    const onLeave = () => {
      pointer.current = null
      retake()
    }
    // Layout that changed without the queue re-rendering: a card's own transcript arriving, an image.
    // ResizeObserver delivers after layout and before paint, so the correction is never seen.
    const observer = new ResizeObserver(() => {
      hold.current()
      take.current()
    })
    observer.observe(document.body)
    const onResume = () => take.current()
    resumeListeners.add(onResume)
    window.addEventListener("pagehide", onHide)
    window.addEventListener("keydown", onKey, true)
    for (const type of TAKEOVER) window.addEventListener(type, stopRestoring, { capture: true, passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", retake)
    document.addEventListener("pointermove", onPointer, { passive: true })
    document.documentElement.addEventListener("pointerleave", onLeave)
    window.addEventListener("blur", onLeave)
    document.addEventListener("focusin", retake)
    document.addEventListener("focusout", retake)
    take.current()
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle.current.timer)
      observer.disconnect()
      resumeListeners.delete(onResume)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", retake)
      document.removeEventListener("pointermove", onPointer)
      document.documentElement.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("blur", onLeave)
      document.removeEventListener("focusin", retake)
      document.removeEventListener("focusout", retake)
      window.removeEventListener("pagehide", onHide)
      window.removeEventListener("keydown", onKey, true)
      // Unmounted with the page still here: a hot swap or a recovering error boundary, and the queue that
      // mounts next finds the note. (A navigation to another page leaves one too; it is only read back on
      // this same address, within the minute.)
      if (!restoring.current) leaveNote()
      for (const type of TAKEOVER) window.removeEventListener(type, stopRestoring, true)
      history.scrollRestoration = restorationWas
      resumeNativeAnchoring()
    }
  }, [])

  return { onScreen: onScreenRef }
}
