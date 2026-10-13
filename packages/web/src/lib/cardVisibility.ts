// THE QUEUE BUILDS AND LAYS OUT ONLY THE CARDS NEAR THE SCREEN. Every card keeps its slot in the DOM, at its
// place and its height — `j`/`k`, the rail's scroll-to, the viewport lock (lib/viewportLock.ts), the ghost
// gap and the scrollspy all read slots, and every slot is there — but what is INSIDE a slot is paid for only
// near the screen:
//
//   1. A card far from the screen is not BUILT until it is needed: its slot holds a stand-in of the guessed
//      height (AllQueuesCard.tsx CardStandIn), and the card proper — its queries, its markdown, its reply
//      box — mounts the moment the slot comes within a viewport of the screen, or earlier, a card at a time
//      in idle time (`step`, below), so a page left alone ends up with every card built and find-in-page
//      reaching every word.
//   2. A built card far from the screen is SKIPPED by the browser: `content-visibility: auto` (styles.css
//      `.ntwine-card-slot`) — no style, layout or paint — and sized from the height it had the last time it
//      was drawn (`contain-intrinsic-size: auto`).
//
// WHY: with hundreds of cards the page was bound by building them and laying them out. Measured 2026-10-02
// on a 244-card mirror of the maintainer's machine, prod build, a loaded 16-core WSL box: a cold load spent
// 7s in ONE task mounting all 244 cards (React render + commit, 244 handoff fetches started from inside it),
// and a 15s trace of load + settle spent 4.9s in Layout and 2.6s in PrePaint, every forced layout — a
// composer snapping its height, a clamp checking its overflow — laying out all 244 cards.
//
// WHY NOT `content-visibility: auto` ON EVERY CARD, ALWAYS. It brings layout, style and PAINT containment
// with it even while the card is on screen, and paint containment clips everything a card draws outside
// its own box: its `shadow-lg`, the arrival ring's outline 2px outside the border (styles.css
// `[data-queue-flash]`), the leaving blur, and the reply box's `/` and `@` menus — which open BELOW the box
// when it sits near the top of the window and so hang past the card's bottom edge over the next one (it
// also makes each card a stacking context, so the next card would paint over that menu). So a card NEAR
// the screen — within a viewport of it — wears `data-near`, which turns content-visibility back off
// (styles.css): nothing a reader can see is ever contained. An IntersectionObserver keeps that mark
// current as the page scrolls.
//
// WHY NOT TRUE WINDOWING (unmounting what scrolls away, as @tanstack/react-virtual does). A card the reader
// has passed keeps its draft caret, its open "Show more", its focus, and its words for find-in-page; and the
// viewport lock, the ghost gap and the leaving fade all hold a card's slot at its real height. A card once
// built stays built, and content-visibility makes a built card that is off screen cost nothing to keep.
//
// A SKIPPED CARD STILL ANSWERS LAYOUT QUERIES — reading `scrollHeight` inside one makes the browser lay it
// out on the spot — so correctness never depends on any of this. Cost does: a composer snapping its
// height or a clamp measuring its body would force each far card's layout one at a time, which is the cost
// this exists to avoid. Those measurements wait for their card (`whenCardRendered`), and run before the
// frame in which the card is first drawn.
//
// AND EVERY CARD IS DRAWN ONCE, IN IDLE TIME (`step`). A card never drawn is sized from a 540px guess (the
// median card on that mirror: p10 315, p90 793), and a guess is wrong by hundreds of px either way. Left
// wrong, a glide to a far card (a rail click) would land and then snap by the sum of every guess it passed,
// the scrollbar would jitter as cards resolve, and scrolling UP through cards never seen would keep the
// viewport lock correcting for cards growing above the reader. So after load the far cards are built and
// drawn a card at a time — off screen, with their measurements — and kept for a couple of frames, long
// enough for `contain-intrinsic-size: auto` to remember their real height. From then on every skipped card
// is the height it really is, and nothing on the page can tell it is skipped — and it STAYS that height
// through the three things that change a skipped card without a frame drawing it: content arriving in it
// (`ensureMutations`), the column changing width (`ensureSizes`), and the card being unmounted and mounted
// again (`drawnHeights`).
//
// AND EVERY CARD'S DATA IS FETCHED AHEAD OF ITS BUILD (`prefetch`). A card fetches its handoff when it is
// built, and a handoff lands a round trip later and grows the card from the server's 200-character preview
// to its clamped body — so every card built on the spot (a jump to the bottom, a key landing far down) grew
// under the reader a moment after it was drawn: End left the last card pushed 1,234px off the bottom of the
// 243-card mirror (review 2026-10-02), and a key landing on a card never auto-pressed its "Show more", which
// did not exist yet. Fetching is cheap next to building — no render, no layout — so the handoffs are read a
// few at a time from the first idle moment, as main read them all at mount, and a card built later builds
// with its handoff in hand, at its real height in its first frame.
import { flushSync } from "react-dom"
import { glideTo, gliding } from "./viewportLock.ts"

/** The card slot (AllQueuesCard.tsx). */
const SLOT = ".ntwine-card-slot"
/** Set on a slot near the screen, where content-visibility is off (styles.css). Never rendered by React. */
const NEAR = "data-near"
/** How far past the top and bottom of the window a card counts as near. */
const MARGIN = "100% 0px"
/**
 * How long one idle step may keep working before it hands the thread back. Building a card costs 10–30ms
 * on the loaded mirror box and drawing one ~1–10ms, so a step builds ONE card, or draws several built ones.
 */
const STEP_BUDGET_MS = 8
/**
 * And at most this many cards a step. The budget above times only the BUILD: re-drawing a card already built
 * is one attribute in the step, and its whole layout lands in the next frame, where the budget cannot see
 * it. After a width change every built card is due a re-draw at once, and one step marked all 243 on the
 * mirror: the next frame laid out the whole page, 2.8s (2026-10-02). Four a step keeps a frame to a few cards.
 */
const STEP_MAX_CARDS = 4
/** How long a step may wait for an idle moment before running anyway, so a busy page still gets there. */
const STEP_IDLE_TIMEOUT_MS = 1_000

/** Handoffs fetched at once ahead of the build (`prefetch`): a few, so they never queue the page's own requests. */
const PREFETCH_CONCURRENCY = 4
/** How long input must have stopped before a step runs where `requestIdleCallback` is missing (`idle`). */
const INPUT_QUIET_MS = 150

const noop = () => {}
const waiters = new Map<HTMLElement, Set<() => void>>()
/** Each unbuilt slot's builder (its card's state setter); gone once the card is built. */
const builders = new Map<HTMLElement, () => void>()
/** Whether the observer last saw each slot within the margin. */
const inMargin = new WeakMap<HTMLElement, boolean>()
/** Slots mounted since the last placement (below). */
const unplaced = new Set<HTMLElement>()
/** Slots whose card has not been drawn as it is now, so sized by the guess or a stale height. */
const unprimed = new Set<HTMLElement>()
/** Slots drawn by `step` or `drawCardNow`, kept near until their height is remembered. */
const priming = new Set<HTMLElement>()
/** When each near slot's structure last changed (performance.now()), for `letGo`. */
const touched = new WeakMap<HTMLElement, number>()
/** Slots on their way to being skipped (`letGo`). */
const letting = new Set<HTMLElement>()
/** Every mounted slot, for the scroll-time pass (`drawOnScreen`). */
const mounted = new Set<HTMLElement>()
/** Each unbuilt slot's prefetch of its card's data; gone once it has run or the card is built. */
const prefetchers = new Map<HTMLElement, () => Promise<unknown>>()
let prefetching = 0
/** Each slot's inline size when the browser last sized it, to see the column change width (`ensureSizes`). */
const widths = new WeakMap<HTMLElement, number>()
/** Each card's height the last time it was drawn, by its slot's `data-xq-card` key (`drawnHeight`). */
const drawnHeights = new Map<string, number>()
let observer: IntersectionObserver | null = null
let stepScheduled = false

// A SKIPPED CARD THAT CHANGES is re-drawn in idle time too. Its height was remembered as it last drew, and
// content that arrives while it is skipped — above all its handoff, which each card fetches after it is
// built and which is often still loading when it is first drawn (a 315px preview remembered for a card
// that clamps at ~600px) — is laid out by nobody. Structure only: a ticking "2m ago" changes text, not
// height, and would re-draw every card every minute. Structure includes a `style` or `class` change, though:
// a key's "Show more" closed again from afar (keyboardRuntime.ts releaseAutoOpened collapses the card a key
// opened once the reader moves on, wherever that card now is) changes only the clamp's style and the
// toggle's class and text, and the card would keep its open height for good. A card near the screen is laid
// out live already, but the time of its change is noted: a frame has to draw it before the card may be
// skipped (`letGo`).
let mutations: MutationObserver | null = null
function ensureMutations(): MutationObserver {
  mutations ??= new MutationObserver((records) => {
    let changed = false
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      const slot = target?.closest<HTMLElement>(SLOT)
      if (!slot || !slot.isConnected) continue
      if (slot.hasAttribute(NEAR)) {
        touched.set(slot, performance.now())
        continue
      }
      if (unprimed.has(slot)) continue
      unprimed.add(slot)
      changed = true
    }
    if (changed) scheduleStep()
  })
  return mutations
}

/** Build the slot's card now, synchronously, if it is not built yet. Never called during React's own render
 *  or commit: from a microtask after it, an observer callback, an idle callback, or an event handler. */
function build(slot: HTMLElement): void {
  const builder = builders.get(slot)
  if (!builder) return
  builders.delete(slot)
  // The card fetches its own from here (deduplicated with a prefetch already in flight).
  prefetchers.delete(slot)
  flushSync(builder)
}

function markNear(slot: HTMLElement): void {
  unprimed.delete(slot)
  if (!slot.hasAttribute(NEAR)) slot.setAttribute(NEAR, "")
  // Built with the mark already on, so the card's measurements run as it mounts (whenCardRendered).
  build(slot)
  const waiting = waiters.get(slot)
  if (!waiting) return
  waiters.delete(slot)
  for (const fn of waiting) fn()
}

// LET A CARD BE SKIPPED only once a frame has drawn it as it is now: `contain-intrinsic-size: auto`
// remembers the height a FRAME last laid out, not the one the DOM has. Measured 2026-10-02 on the 60-card
// fixture: a card's handoff landed 5ms before its idle draw ended, the card was skipped before any frame
// laid the handoff out, and it sat at 259px — its height without the handoff — against a real 621px, for
// good, since a change made while a card is near is nobody's to re-draw. So the mark comes off in an
// animation frame, and only if the card has not changed since the frame before it began: that frame drew
// everything done before it. Changed since, it waits for the next frame and asks again.
function letGo(slot: HTMLElement): void {
  if (priming.has(slot) || letting.has(slot) || !slot.hasAttribute(NEAR)) return
  letting.add(slot)
  let drawnFrom = Infinity
  const check = () => {
    const now = performance.now()
    // Wanted near again meanwhile (scrolled back, or drawn by a step), or gone.
    if (!slot.isConnected || priming.has(slot) || inMargin.get(slot) === true) {
      letting.delete(slot)
      return
    }
    if ((touched.get(slot) ?? -Infinity) < drawnFrom) {
      letting.delete(slot)
      slot.removeAttribute(NEAR)
      return
    }
    drawnFrom = now
    requestAnimationFrame(check)
  }
  requestAnimationFrame(() => {
    drawnFrom = performance.now()
    requestAnimationFrame(check)
  })
}

// A JUMP IS DRAWN BEFORE IT PAINTS. The observer reports after a frame has painted, so a jump past the
// margin it watches — the scrollbar dragged, End, Page Down, a scroll restored — painted the cards it landed
// on as stand-ins (a frame and title) for a frame, then re-laid the page around the built cards, which are
// rarely the 540px guessed: measured 2026-10-02 on the 244-card mirror, a jump to the middle before the
// page was built showed 2 stand-ins in the first painted frame, and the next frame put a different card
// under the reading line (the card read moved from -132px to 158px). A scroll event is dispatched in the
// rendering step BEFORE animation frames, layout and the ResizeObserver the viewport lock corrects from,
// so building what is on screen here means the first frame painted after a jump is the real cards, and the
// lock takes its anchor (in its own animation frame) on the page as it will be drawn. Only the window
// itself, not the observer's margin: a scrollbar drag fires this every frame, and each card built costs
// 10–30ms on a loaded box, so this builds what must be seen now and leaves the rest to the observer.
// Cheap once nothing is left to do: one box read per slot not already near, from a layout a scroll does not
// dirty.
//
// AGAIN UNTIL NOTHING NEW IS ON SCREEN: a card built at its real height rarely keeps the 540px it was
// guessed at, so building one moves the cards after it — and at the bottom of the page, where a shorter page
// clamps the scroll, the cards before it — and can bring another stand-in on screen (the 60-card fixture:
// one of three after a single pass). Each pass is one layout, which the frame pays anyway; bounded, so a
// page that keeps changing under it cannot hold the frame.
//
// AND A JUMP TO THE END STAYS AT THE END. The cards it lands on were guessed at 540px and are built at their
// real height, so the page's end moves; the viewport lock then holds the card at its reading line, a third
// of the way down, and every px the cards below that line gained pushed the end off screen — End showed the
// second-last card cut off, 1,234px short on the 243-card mirror (review 2026-10-02). So a page that was at
// its end before this built anything is put back at its new end, here, before the lock re-takes its anchor
// in its animation frame. Only then: a page merely scrolled to its end, building nothing, is left alone, and
// cards built later — the observer's, a viewport out — sit above the reading line, where the lock's hold
// keeps the end where it is.
//
// AND HELD THERE FOR A MOMENT (`holdEnd`): the cards a jump to the end lands on are built at once, but a
// card's handoff can still be on its way — the prefetch below reads them in page order, so the end of a long
// page comes last (on the loaded mirror every handoff had landed only ~25s after load) — and it grows the
// card by hundreds of px a round trip later, below the reading line again: End landed on the end, then
// slid 246px, then 493px, off it. So for END_HOLD_MS after a jump to the end, a card changing height puts
// the page back at its end (in the slots' ResizeObserver, after layout and before paint, so it is never
// seen off it). The reader's own move ends the hold at once: a wheel, a touch, a press, a key, or a scroll UP
// from where the hold last left the page. Not merely being off the end: a card growing below moves the end,
// not the page, and a scroll event can see that before the observer has put the page back.
const DRAW_PASSES = 4
const END_HOLD_MS = 8_000
let endHoldUntil = 0
let endHoldY = 0
const scrollerOf = () => document.scrollingElement ?? document.documentElement
function holdEnd(): void {
  endHoldUntil = performance.now() + END_HOLD_MS
  endHoldY = window.scrollY
}
function keepAtEnd(): void {
  if (endHoldUntil === 0 || gliding()) return
  if (performance.now() > endHoldUntil) {
    endHoldUntil = 0
    return
  }
  const end = scrollerOf().scrollHeight - window.innerHeight
  if (window.scrollY < end - 1) window.scrollTo({ top: end, left: 0, behavior: "instant" })
  endHoldY = window.scrollY
}
/** Build every unbuilt slot inside the window, again until a pass finds none (DRAW_PASSES, above). `read`
 *  runs inside each pass after its box reads, so a caller can read layout without forcing another. True
 *  when anything was built. */
function buildOnScreen(read?: () => void): boolean {
  let built = false
  for (let pass = 0; pass < DRAW_PASSES; pass++) {
    const viewport = window.innerHeight
    const due: HTMLElement[] = []
    for (const slot of mounted) {
      if (slot.hasAttribute(NEAR)) continue
      const rect = slot.getBoundingClientRect()
      if (rect.bottom > 0 && rect.top < viewport) due.push(slot)
    }
    read?.()
    if (due.length === 0) break
    for (const slot of due) markNear(slot)
    built = true
  }
  return built
}
function drawOnScreen(): void {
  const scroller = scrollerOf()
  if (endHoldUntil !== 0 && !gliding()) {
    const atEndNow = window.scrollY >= scroller.scrollHeight - window.innerHeight - 1
    // Up, and off the end: the reader's scroll. (A page that got shorter is clamped up, but onto its end.)
    if (!atEndNow && window.scrollY < endHoldY - 1) endHoldUntil = 0
    else if (atEndNow) endHoldY = window.scrollY
  }
  let atEnd: boolean | undefined
  const built = buildOnScreen(() => {
    // Read with the layout the first pass's box reads just made: no extra layout.
    atEnd ??= window.scrollY >= scroller.scrollHeight - window.innerHeight - 1
  })
  // At the end with nothing built here, but cards still to be re-drawn (a width change, content that arrived
  // while they were skipped): those heights are about to change too, so the end is held all the same.
  // Not during a glide: it owns the scroll. A glide to a card whose target was reckoned on guessed heights can
  // touch the end on its way and then re-land on the card, and a hold taken here would put the page back at
  // the end in the next ResizeObserver report, before the re-landing's scroll event could end the hold. (End's
  // own glide sets its hold itself.) Reasoned, not reproduced: the rail click to the last card on the mirror
  // lands on the page's end either way, since the last cards are shorter than the window.
  if (!atEnd || gliding() || (!built && unprimed.size === 0)) return
  const end = scroller.scrollHeight - window.innerHeight
  if (window.scrollY < end - 1) window.scrollTo({ top: end, left: 0, behavior: "instant" })
  holdEnd()
}

// A WIDTH CHANGE re-wraps every card and mutates nothing, so `ensureMutations` cannot see it, and every
// skipped card kept the height it had at the old width: measured 2026-10-02 (review), a 243-card mirror built
// at 1440px and narrowed to 900px was laid out 112,777px tall against a real 221,348px, and End stopped
// 1,006px short of the last card. The window, an editor's sidebar dragged, the column's own `max-w-[62vw]`
// — whatever narrows it, every slot's own box narrows, and a ResizeObserver on the slots sees it on a
// skipped card too (its box is laid out; only its contents are skipped). Each skipped card whose width moved
// is re-drawn in idle time like any other changed card. The same reports remember each card's drawn height
// (`drawnHeights`), and run no layout of their own: a ResizeObserver reads sizes the frame computed anyway.
let sizes: ResizeObserver | null = null
function ensureSizes(): ResizeObserver {
  sizes ??= new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const slot = entry.target as HTMLElement
      const box = entry.borderBoxSize[0]
      if (!box || !slot.isConnected) continue
      const was = widths.get(slot)
      widths.set(slot, box.inlineSize)
      // A stand-in: nothing in it wraps, and its height is the guess.
      if (builders.has(slot)) continue
      if (was !== undefined && Math.abs(box.inlineSize - was) > 0.5 && !slot.hasAttribute(NEAR)) {
        if (!unprimed.has(slot)) {
          unprimed.add(slot)
          changed = true
        }
        continue
      }
      // Any other report is a height the browser laid out: a card near the screen, one the browser drew early
      // within its own margin for `auto` content, or the drawn height a skipped card is sized from. Even for a
      // card marked unprimed — the browser may have drawn its change already, and the step that re-draws it
      // then changes nothing, so nothing would report it again (measured: 1 card in 60 left 170px short).
      const key = slot.dataset.xqCard
      if (key && box.blockSize > 0) drawnHeights.set(key, box.blockSize)
    }
    keepAtEnd()
    if (changed) scheduleStep()
  })
  return sizes
}

// A FEW AT A TIME, in page order, from the first idle moment on (`place`). Starting a fetch renders nothing:
// the handoff lands in the query cache with no card subscribed to it yet.
function prefetch(): void {
  while (prefetching < PREFETCH_CONCURRENCY) {
    const next = prefetchers.entries().next()
    if (next.done) return
    const [slot, fetch] = next.value
    prefetchers.delete(slot)
    prefetching++
    void fetch().finally(() => {
      prefetching--
      prefetch()
    })
  }
}

// CARDS MOVED ON SCREEN WITHOUT A SCROLL OR A MOUNT — a project filter hiding every card above them, a batch
// dismissed — were painted as stand-ins for a frame: the observer reports after a paint. A slot unmounting
// is what moves them, so the slots are re-checked in a microtask after the commit that unmounted it, before
// paint, the same moment `place` builds a newly mounted one.
let drawQueued = false
function queueDrawOnScreen(): void {
  if (drawQueued) return
  drawQueued = true
  queueMicrotask(() => {
    drawQueued = false
    if (mounted.size > 0) drawOnScreen()
  })
}

// THE END KEY IS A SMOOTH SCROLL whose target the browser fixes when it starts: the page's end as it was then.
// The cards it passes on the way down are built as they come on screen (above), at their real height rather
// than the guess, so the end moves while the animation runs, and it stopped short of it — the last card
// 1,277px below the window on the 243-card mirror, measured 2026-10-02 after the instant-jump re-pin above (a
// scrollbar drag lands on the end in one scroll event, which the re-pin catches; an animation never does).
// So while any card is unbuilt, End is the page's glide (viewportLock.ts glideTo, as a rail click lands a
// card): it re-reads its target when it ends and lands on the end the page has THEN. The cards at the end of
// the page are built first, from the last up, until they fill a viewport and a half, so that landing moves
// as little as it can. With every card built, End is the browser's own again.
const END_FILL = 1.5
function onEndKey(event: KeyboardEvent): void {
  if (event.key !== "End" || event.defaultPrevented || event.altKey || event.shiftKey) return
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))) return
  const slots = [...mounted].filter((slot) => slot.isConnected)
  // Nothing unbuilt and nothing waiting to be re-drawn: every height is real, and the browser's End is right.
  if (unprimed.size === 0 && !slots.some((slot) => builders.has(slot))) return
  event.preventDefault()
  slots.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  let filled = 0
  for (let index = slots.length - 1; index >= 0 && filled < window.innerHeight * END_FILL; index--) {
    const slot = slots[index]!
    if (builders.has(slot)) drawCardNow(slot)
    filled += slot.getBoundingClientRect().height
  }
  const scroller = scrollerOf()
  glideTo(() => scroller.scrollHeight - window.innerHeight)
  holdEnd()
}

function ensureObserver(): IntersectionObserver {
  if (!observer) {
    window.addEventListener("scroll", drawOnScreen, { passive: true })
    window.addEventListener("keydown", onEndKey)
    for (const type of ["keydown", "pointerdown", "wheel", "touchstart"] as const) window.addEventListener(type, noteInput, { capture: true, passive: true })
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const slot = entry.target as HTMLElement
      inMargin.set(slot, entry.isIntersecting)
      if (entry.isIntersecting) markNear(slot)
      else letGo(slot)
    }
    // `root: document`, not the implicit root: in a cross-origin iframe — an editor's sidebar hosts the page
    // in one (packages/vscode/src/sidebar-html.ts) — the implicit root is the TOP page's viewport, and the
    // browser ignores `rootMargin` there, so no card was ever built a viewport ahead (review 2026-10-02).
    // The document as root is this frame's own viewport, margin and all; at top level the two are the same.
  }, { root: document, rootMargin: MARGIN })
  return observer
}

// PLACEMENT, before the first paint of a newly mounted slot. The observer's first report is delivered
// after a frame has painted, so a card mounted on screen would be painted once as its stand-in (and a built
// one contained, its shadow cut off, its composer and clamp unmeasured) and corrected the frame after. So
// the slots a commit mounted are placed in a microtask — after React's commit, still before paint — from
// one read of their boxes: one layout, and a cheap one, since every unplaced slot is a stand-in or skipped.
// The near ones are built there and then (`build`, synchronously), so the first frame shows real cards.
function place(): void {
  const slots = [...unplaced].filter((slot) => slot.isConnected)
  unplaced.clear()
  const viewport = window.innerHeight
  const near = slots.filter((slot) => {
    const rect = slot.getBoundingClientRect()
    return rect.bottom > -viewport && rect.top < viewport * 2
  })
  for (const slot of near) markNear(slot)
  // The near set was read off stand-ins at the 540px guess, and the cards just built are rarely that tall:
  // shorter ones pull the next stand-in onto the screen, where the first frame would paint it as a stand-in.
  // So the same until-nothing-new pass a jump takes (`buildOnScreen`), still before paint. Exposed when the
  // lifecycle footer left the card (2026-10-06, upstream's header redesign): ~45px shorter per card, and
  // the 60-card fixture's fifth card came on screen unbuilt at 1440x900 (queueCardVisibility.e2e).
  buildOnScreen()
  scheduleStep()
  if (prefetchers.size > 0) idle(prefetch)
}

/**
 * The slot's ref (React 19 ref callback, so it returns its own cleanup): registers a card slot with the
 * observer and places it before its first paint. `build` is how the card is told to mount its content —
 * omitted for a slot whose content is always built — and `prefetchCard` fetches what the card will show
 * (resolving when it has landed or failed), run ahead of the build.
 */
export function observeCardSlot(slot: HTMLElement | null, buildCard?: () => void, prefetchCard?: () => Promise<unknown>): (() => void) | undefined {
  if (!slot) return undefined
  if (unplaced.size === 0) queueMicrotask(place)
  unplaced.add(slot)
  unprimed.add(slot)
  mounted.add(slot)
  if (buildCard) builders.set(slot, buildCard)
  if (buildCard && prefetchCard) prefetchers.set(slot, prefetchCard)
  ensureObserver().observe(slot)
  // Disconnected with the slot: a node's registrations go with the node.
  ensureMutations().observe(slot, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] })
  ensureSizes().observe(slot)
  return () => {
    observer?.unobserve(slot)
    mounted.delete(slot)
    unplaced.delete(slot)
    unprimed.delete(slot)
    priming.delete(slot)
    letting.delete(slot)
    waiters.delete(slot)
    builders.delete(slot)
    prefetchers.delete(slot)
    sizes?.unobserve(slot)
    queueDrawOnScreen()
  }
}

/**
 * The height the card keyed `key` had the last time it was drawn, if it has been — for a slot mounting again
 * (a project filter switched away and back), which would otherwise start from the 540px guess and leave
 * every far jump and End landing wrong until the page had built it again.
 */
export function drawnHeight(key: string): number | undefined {
  return drawnHeights.get(key)
}

/** Whether `el` sits in a card the browser is currently skipping (or about to: not yet placed). */
export function inSkippedCard(el: Element): boolean {
  const slot = el.closest<HTMLElement>(SLOT)
  return slot !== null && !slot.hasAttribute(NEAR)
}

/**
 * Run `fn` once `el`'s card is drawn — now, if it is near the screen or is not in a card at all (a drawer's
 * composer). For a measurement that would otherwise force a skipped card's layout. Returns a cancel.
 */
export function whenCardRendered(el: Element, fn: () => void): () => void {
  const slot = el.closest<HTMLElement>(SLOT)
  if (!slot || slot.hasAttribute(NEAR)) {
    fn()
    return noop
  }
  const once = () => fn()
  let set = waiters.get(slot)
  if (!set) waiters.set(slot, (set = new Set()))
  set.add(once)
  return () => {
    const current = waiters.get(slot)
    current?.delete(once)
    if (current?.size === 0) waiters.delete(slot)
  }
}

/**
 * Build and draw a card NOW, wherever it is — for a move that is about to take the reader to it (a rail
 * row, `j`/`k`): what lands must be the card, with its root to ring and its real height, not a stand-in.
 * Held near for a couple of frames like a primed card, then handed back to the observer.
 */
export function drawCardNow(slot: HTMLElement): void {
  priming.add(slot)
  markNear(slot)
  releaseAfterDraw([slot])
}

// Two frames and a task: the first frame lays the cards out, React commits whatever a measurement set (a
// clamp turning on is a state update), and the second frame lays THAT out, which is the height
// `contain-intrinsic-size: auto` must remember. Then any the reader is not near go back to the observer,
// through `letGo`, which holds one still changing (a handoff landing) until a frame has drawn it.
function releaseAfterDraw(slots: HTMLElement[]): void {
  requestAnimationFrame(() => window.setTimeout(() => requestAnimationFrame(() => window.setTimeout(() => {
    for (const slot of slots) {
      priming.delete(slot)
      if (slot.isConnected && inMargin.get(slot) !== true) letGo(slot)
    }
  }, 0)), 0))
}

// WHERE `requestIdleCallback` IS MISSING (Safari) a step waits until input has stopped for INPUT_QUIET_MS,
// up to the same deadline, rather than running on a bare timer: a card costs 10–30ms to build, and a step every
// 50ms whatever the page was doing would land in the middle of typing and scrolling.
let lastInput = -Infinity
function noteInput(): void {
  lastInput = performance.now()
  // The reader acting ends a hold at the end (`holdEnd`); End itself sets a new one after this runs.
  endHoldUntil = 0
}
function idle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: STEP_IDLE_TIMEOUT_MS })
    return
  }
  const deadline = performance.now() + STEP_IDLE_TIMEOUT_MS
  const wait = () => {
    const now = performance.now()
    if (now < deadline && now - lastInput < INPUT_QUIET_MS) window.setTimeout(wait, INPUT_QUIET_MS)
    else fn()
  }
  window.setTimeout(wait, 50)
}

// NOT WHILE THE TAB IS HIDDEN: a drawn card is let go in animation frames, and a hidden tab runs none, so each
// step there left its cards near — unskipped — for good: 45 near cards became 73 over 40s in the background
// (review 2026-10-02), each one more for the frame that brings the tab back to lay out. The steps resume as
// it comes back.
let waitingVisible = false
function resumeWhenVisible(): void {
  if (waitingVisible) return
  waitingVisible = true
  const onVisible = () => {
    if (document.hidden) return
    document.removeEventListener("visibilitychange", onVisible)
    waitingVisible = false
    scheduleStep()
  }
  document.addEventListener("visibilitychange", onVisible)
}

function scheduleStep(): void {
  if (stepScheduled || unprimed.size === 0) return
  stepScheduled = true
  idle(step)
}

// One idle step: build and draw the next cards down the page — at least one, and more while the step is
// within its budget and its count — and hold them drawn until their heights are remembered. The next step is asked for
// at once rather than after that hold, so the page is built as fast as it is idle. (An unbuilt slot is
// always unprimed too: a slot is both from the moment it mounts, and `markNear` builds what it draws.)
function step(): void {
  stepScheduled = false
  if (document.hidden) return resumeWhenVisible()
  const started = performance.now()
  const batch: HTMLElement[] = []
  for (const slot of [...unprimed]) {
    if (batch.length >= STEP_MAX_CARDS || (batch.length > 0 && performance.now() - started > STEP_BUDGET_MS)) break
    if (!slot.isConnected) { unprimed.delete(slot); builders.delete(slot); continue }
    batch.push(slot)
    priming.add(slot)
    markNear(slot)
  }
  if (batch.length > 0) releaseAfterDraw(batch)
  scheduleStep()
}
