// THE THREADS, STRUNG ON THEIR PROJECTS — the cross-project page's rail, and one thread out of it.
//
// A two-strand cord in the accent — gold in the dark theme, blue in the light — hangs from each project's
// square down the rail's icon column, through the glyph of every band name and the indicator of every
// thread row under it, twisted once in each gap between two icons (lib/threadConnector.ts `twist`): a project reads as its threads twisted
// together, before any row says what state it is in. At 70% it is brighter than the thread out of the rail
// (55%) and still the lighter mark: it only ever paints short 1px stitches in the gaps between icons, where
// that thread is one long stroke (30% was tried first and read as olive, not gold). It passes BEHIND every
// icon — a mask cuts each icon's box out of it, so it never touches what an indicator says — and both its
// ends hide behind one: the project's square at the top, its last thread's indicator at the bottom. A
// project with no threads has no cord.
//
// Tried and dropped (2026-09-28), each on a seeded stack beside this one: a plain weave in the gutter
// between the rail and the cards, a stub out of every row across strands running down it, which read as a
// ruler and its ticks; one cord down that gutter, twisted at every row, which read as decoration beside the
// list rather than as the list; and one cord through every icon of every project, which drew its loudest
// crossings at the breaks between projects, where the rail should be quietest.
//
// ONE thread leaves the rail: the row the rail marks (the card being read, AllQueues.tsx useScrollspy) runs
// on out of its right end, just past its rest time, across the gutter to its card, in the accent the rail's
// scroll marker already wears. It ends in a knot on the card's left border and lights a short stretch of
// that border either side — the seam it is sewn into. While the pointer rests on another row that has a
// card, it slides over to THAT card — off the top or bottom of the window when the card is scrolled away,
// which says where it went.
//
// Where it lands is `landing`: level with the row whenever the card reaches that height, so the usual
// reading is one flat stroke. The rail is fixed and the cards scroll, so the knot slides down the card's
// edge as the card passes the row, and the stroke bends only once the card has gone by.
//
// One fixed SVG under the lane headers (z-10), which cover the card too, and under the drawers' scrim. It
// is moved imperatively, not rendered: it has to stay glued to the card on every scroll frame, and a React
// render per frame for a hairline would be the most expensive pixel on the page.
//
// IN AN EDITOR'S SIDEBAR (SidebarPage.tsx) there are no cards, so only the cords draw — at any width: the
// page is the desktop's left column alone, which is narrow by nature, not the stacked page the 800px rule
// below hides them on.
import { useEffect, useRef } from "react"
import { embedded } from "../lib/embed.ts"
import { OFFSCREEN, landing, snapToPixels, threadPath, twist, type ThreadGeometry } from "../lib/threadConnector.ts"

/** How far each strand bows out either side of the icon column: narrow, so a crossing reads as a twist of thread rather than as an x. */
const CORD_REACH = 2.5
/** Row pitch under which the bow narrows: the tier list's one-line rows (23px) leave ~4px between icons, where
 *  a 2.5px bow shows only its crossing, and reads as an x. */
const TIGHT_PITCH = 26
const TIGHT_REACH = 1
/** Past an icon's box, a strand passing behind it stays hidden for this much more, so it never touches the icon. */
const ICON_CLEAR = 1.5
/** Past the row's box, whose own 6px right padding already clears the rest time. */
const START_GAP = 1
/** Half the length of the lit stretch of the card's border, which fades out to either end. */
const SEAM = 56
/** The card's corner (BLOCK_RADIUS): the seam stops where the border starts to curve. */
const CORNER = 12
/** Sliding from one row to another, and the stroke drawing itself out of the row. */
const SLIDE_MS = 240
const DRAW_MS = 320

// THE ROW'S LINE, IN ITS INK. The thread leaves the row just past its rest time, so it sits on the middle of
// those digits — not on the middle of the 19px line box, 0.5px lower (sans: Chrome floors the
// half-leading). A row with no rest time takes its title's lowercase instead, which sits at the same height
// in sans. Read once per row off a baseline probe on the FIRST line (a wrapped title's last line would be a
// line too low) and kept as an offset from the row's top: the row moves when the rail scrolls, its text
// does not move within it.
let inkOffsets = new WeakMap<Element, number>()
let context: CanvasRenderingContext2D | null = null
function rowInk(row: HTMLElement): number {
  const top = row.getBoundingClientRect().top
  let offset = inkOffsets.get(row)
  if (offset === undefined) {
    offset = inkMiddle(row) - top
    inkOffsets.set(row, offset)
  }
  return top + offset
}
function inkMiddle(row: HTMLElement): number {
  const digits = row.querySelector<HTMLElement>("time, .tabular-nums")
  const text = digits ?? row.querySelector<HTMLElement>("button span.break-words, button .font-mono-keep")
  // AllQueues.tsx ROW_BUTTON_CLASS: pt-1, then a 19px first line.
  if (!text) return row.getBoundingClientRect().top + 4 + 9.5
  const probe = document.createElement("span")
  probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0"
  text.insertBefore(probe, text.firstChild)
  const baseline = probe.getBoundingClientRect().bottom
  probe.remove()
  const style = getComputedStyle(text)
  context ??= document.createElement("canvas").getContext("2d")
  if (!context) return baseline - parseFloat(style.fontSize) * 0.36
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return baseline - context.measureText(digits ? "0" : "x").actualBoundingBoxAscent / 2
}

interface Rail {
  /** The rail's own scrolling list, which the cords and the thread's end in it are cut to. */
  box: DOMRect
  /** The icon column's centre line, which every cord hangs down. */
  x: number
  /** One cord per project with threads: where its strands cross, and the icon centres it runs between. */
  cords: { crossings: number[]; span: [number, number] }[]
  /** Every icon the cords pass behind. */
  icons: DOMRect[]
}

/**
 * The rail's icon column: the indicator of each thread row in a project's run (`data-xq-indicator`,
 * TierList.tsx and Sidebar.tsx). Only rows that TOUCH are strung together, so whatever sits between two of
 * them — a thread's sub-agents — cuts the cord there. Rows
 * scrolled out of the list count too: a cord runs on past the list's edge and is cut there, as the rows are.
 */
function readRail(dpr: number): Rail | null {
  const list = document.querySelector<HTMLElement>("[data-xq-rail]")
  if (!list) return null
  const cords: Rail["cords"] = []
  const icons: DOMRect[] = []
  let x = NaN
  let centres: number[] = []
  // Once in each gap, halfway between the two icons' centres, and on to the middle of the icon at either
  // end, where the strands meet and stop, hidden.
  const tie = () => {
    if (centres.length > 1) cords.push({ crossings: centres.slice(1).map((c, i) => (centres[i]! + c) / 2), span: [centres[0]!, centres.at(-1)!] })
    centres = []
  }
  for (const project of list.querySelectorAll<HTMLElement>("[data-xq-rail-project]")) {
    let bottom = NaN
    for (const row of project.querySelectorAll<HTMLElement>(":scope > [data-xq-project-row], :scope > [data-xq-band-label], :scope > [data-xq-thread-row]")) {
      const slot = row.querySelector<HTMLElement>("[data-xq-indicator]")
      const r = row.getBoundingClientRect()
      if (!slot || Math.abs(r.top - bottom) > 1) tie()
      bottom = r.bottom
      if (!slot) continue
      if (Number.isNaN(x)) {
        const s = slot.getBoundingClientRect()
        x = snapToPixels(s.left + s.width / 2, dpr)
      }
      // The icon itself where the slot holds one; an empty slot (a Done row draws its check in an overlay
      // above it) stands for the icon painted over it.
      const icon = (slot.firstElementChild ?? slot).getBoundingClientRect()
      icons.push(icon)
      centres.push(icon.top + icon.height / 2)
    }
    tie()
  }
  return { box: list.getBoundingClientRect(), x, cords, icons }
}

function measure(key: string, rail: Rail, dpr: number): ThreadGeometry | null {
  const row = document.querySelector<HTMLElement>(`[data-xq-rail] [data-xq-rail-row="${CSS.escape(key)}"]`)
  const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
  const card = slot?.querySelector<HTMLElement>(".ntwine-card-body")
  if (!row || !slot || !card || slot.dataset.queueLeaving === "true") return null
  const y1 = snapToPixels(rowInk(row), dpr)
  // A row scrolled out of the rail's own list has nowhere to leave from.
  if (y1 < rail.box.top || y1 > rail.box.bottom) return null
  const x1 = row.getBoundingClientRect().right + START_GAP
  const c = card.getBoundingClientRect()
  // Centred on the card's 1px border.
  const x2 = c.left + 0.5
  if (x2 - x1 < 8) return null
  const header = slot.closest("[data-xq-lane]")?.querySelector(":scope > header")?.getBoundingClientRect().bottom ?? -Infinity
  const vh = window.innerHeight
  const at = landing(y1, c, header, vh)
  if (at === "above") return { x1, y1, x2, y2: -OFFSCREEN, edge: null }
  if (at === "below") return { x1, y1, x2, y2: vh + OFFSCREEN, edge: null }
  return { x1, y1, x2, y2: snapToPixels(at, dpr), edge: [Math.max(c.top, header) + CORNER, c.bottom - CORNER] }
}

/** The page's columns: their sizes, and every mutation inside them, can move either end of a thread. */
const ROOTS = "#workpane, aside[aria-label='Projects'], [data-sidebar-page]"

/**
 * EVERY BOX WHOSE SIZE CAN MOVE THE RAIL'S ROWS, which the cords are drawn from. The cords are measured, not
 * laid out, so they move only when something says the rows did — and a row moves without a scroll, a resize
 * of the window, or any mutation whenever a box ABOVE it changes height on its own: the prompt box's
 * schedule strip folding open (a 140ms `grid-template-rows` transition, which mounts its contents one frame
 * and grows for the next 200ms), the box growing a line, a project's rows growing. The columns themselves
 * never change size for any of that — the rail's column is `h-screen` — so observing them alone measured the
 * strip at the height it had when it mounted and left every crossing a strip's height (51px) off, behind the
 * row icons, until something unrelated re-measured (2026-10-07).
 *
 * A box's place is the sizes of the boxes before it, at every level up to the page: so the rail list, each
 * project in it, and every earlier sibling of the list and of each of its ancestors. A ResizeObserver
 * reports each of those once per frame while it changes, so the cords follow a transition frame by frame
 * (threadCords.e2e.test.ts, on thread-cords-fixture.html).
 */
function movers(): Set<Element> {
  const out = new Set<Element>(document.querySelectorAll(ROOTS))
  for (const list of document.querySelectorAll("[data-xq-rail]")) {
    out.add(list)
    for (const project of list.querySelectorAll("[data-xq-rail-project]")) out.add(project)
    for (let el: Element | null = list; el && el !== document.body; el = el.parentElement) {
      for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) out.add(sibling)
    }
  }
  return out
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** Write an attribute only when it changed: most frames move the thread and leave the cords alone. */
function set(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

export function ThreadConnector({ activeKey }: { activeKey: string | null }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const strandRefs = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)] as const
  const listRef = useRef<SVGRectElement>(null)
  const iconsRef = useRef<SVGPathElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const knotRef = useRef<SVGCircleElement>(null)
  const seamRef = useRef<SVGRectElement>(null)
  const seamGradientRef = useRef<SVGLinearGradientElement>(null)
  const active = useRef(activeKey)
  active.current = activeKey
  const scheduleRef = useRef<() => void>(() => {})

  useEffect(() => {
    const [svg, strandA, strandB, list, icons] = [svgRef.current, strandRefs[0].current, strandRefs[1].current, listRef.current, iconsRef.current]
    const [path, knot, seam, seamGradient] = [pathRef.current, knotRef.current, seamRef.current, seamGradientRef.current]
    if (!svg || !strandA || !strandB || !list || !icons || !path || !knot || !seam || !seamGradient) return
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    let frame = 0
    let hovered: string | null = null
    // What is on screen, and for which thread: where a slide starts when the thread changes.
    let drawn: ThreadGeometry | null = null
    let drawnKey: string | null = null
    let slide: { from: ThreadGeometry; start: number } | null = null

    const render = (now: number) => {
      frame = 0
      const dpr = window.devicePixelRatio || 1
      const rail = readRail(dpr)
      const key = hovered ?? active.current
      const target = rail && key ? measure(key, rail, dpr) : null

      // The cords: there whenever a project has threads, whether or not a thread leaves the rail. The mask
      // is the rail's list with every icon's box cut out of it.
      const cords = rail?.cords.map((cord) => twist(cord.crossings, cord.span, rail.x, pitchOf(cord.crossings, cord.span) < TIGHT_PITCH ? TIGHT_REACH : CORD_REACH)) ?? []
      set(strandA, "d", cords.map((cord) => cord[0]).join(""))
      set(strandB, "d", cords.map((cord) => cord[1]).join(""))
      if (rail) {
        set(list, "y", String(rail.box.top))
        set(list, "height", String(rail.box.height))
        const d = ICON_CLEAR
        set(icons, "d", rail.icons.map((r) => `M${r.left - d} ${r.top - d}h${r.width + 2 * d}v${r.height + 2 * d}h${-(r.width + 2 * d)}Z`).join(""))
      }

      if (!target) {
        set(svg, "data-shown", "false")
        drawn = null
        drawnKey = null
        slide = null
        return
      }
      if (key !== drawnKey) {
        // From another thread it SLIDES; from nothing it DRAWS itself out of the row, and the knot and the
        // seam arrive with its tip.
        if (!reduced?.matches) {
          if (drawn) slide = { from: drawn, start: now }
          else {
            const land = { delay: DRAW_MS - 120, fill: "backwards" as const }
            path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: "cubic-bezier(0.3, 0, 0, 1)" })
            knot.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], { ...land, duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1.4)" })
            seam.animate([{ opacity: 0 }, { opacity: 1 }], { ...land, duration: 240, easing: "ease-out" })
          }
        }
        drawnKey = key
      }
      let g = target
      if (slide) {
        const t = Math.min(1, (now - slide.start) / SLIDE_MS)
        const e = 1 - (1 - t) ** 3
        const from = slide.from
        g = { x1: mix(from.x1, g.x1, e), y1: mix(from.y1, g.y1, e), x2: mix(from.x2, g.x2, e), y2: mix(from.y2, g.y2, e), edge: g.edge }
        if (t >= 1) slide = null
      }
      drawn = g
      set(path, "d", threadPath(g))
      set(knot, "cx", String(g.x2))
      set(knot, "cy", String(g.y2))
      const edge = g.edge
      set(knot, "visibility", edge ? "visible" : "hidden")
      set(seam, "visibility", edge ? "visible" : "hidden")
      if (edge) {
        // Cut to the straight run of the border, so it never draws past a rounded corner; the gradient
        // stays centred on the knot, so a cut seam just fades less on that side.
        const top = Math.max(g.y2 - SEAM, edge[0])
        set(seam, "x", String(g.x2 - 0.5))
        set(seam, "y", String(top))
        set(seam, "height", String(Math.max(0, Math.min(g.y2 + SEAM, edge[1]) - top)))
        set(seamGradient, "y1", String(g.y2 - SEAM))
        set(seamGradient, "y2", String(g.y2 + SEAM))
      }
      set(svg, "data-shown", "true")
      if (slide) schedule()
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render)
    }
    scheduleRef.current = schedule

    const onOver = (event: PointerEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-xq-rail-row]") : null
      const next = row?.dataset.xqRailRow ?? null
      if (next === hovered) return
      hovered = next
      schedule()
    }
    const onLeave = () => {
      if (hovered === null) return
      hovered = null
      schedule()
    }
    const onResize = () => {
      inkOffsets = new WeakMap()
      schedule()
    }
    // Capture, so the rail's own scrolling list moves the cords too, not only the page.
    window.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", onResize)
    document.addEventListener("pointerover", onOver)
    document.documentElement.addEventListener("pointerleave", onLeave)
    // Anything that moves either end without a scroll: a card growing ("Show more", a question answered),
    // rows coming and going, a card starting to leave — and everything that moves the rail's rows (`movers`),
    // re-collected whenever the DOM changes, since a mutation can mount a new box above them.
    const resize = new ResizeObserver(schedule)
    let observed = new Set<Element>()
    const track = () => {
      const next = movers()
      for (const el of next) if (!observed.has(el)) resize.observe(el)
      for (const el of observed) if (!next.has(el)) resize.unobserve(el)
      observed = next
    }
    const mutations = new MutationObserver(() => {
      track()
      schedule()
    })
    for (const el of document.querySelectorAll(ROOTS)) {
      mutations.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue-leaving"] })
    }
    track()
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", onResize)
      document.removeEventListener("pointerover", onOver)
      document.documentElement.removeEventListener("pointerleave", onLeave)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [])

  useEffect(() => scheduleRef.current(), [activeKey])

  return (
    <svg
      ref={svgRef}
      aria-hidden
      data-thread-connector
      data-shown="false"
      className={`group/thread pointer-events-none fixed inset-0 z-[5] h-full w-full overflow-visible ${embedded() ? "" : "max-[800px]:hidden"}`}
    >
      <defs>
        <mask id="ntwine-thread-cords" maskUnits="userSpaceOnUse" x={-1e4} y={-1e4} width={2e4} height={2e4}>
          <rect ref={listRef} x={-1e4} width={2e4} fill="white" />
          <path ref={iconsRef} fill="black" />
        </mask>
        <linearGradient ref={seamGradientRef} id="ntwine-thread-seam" gradientUnits="userSpaceOnUse" x1="0" x2="0">
          <stop offset="0" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
          <stop offset="0.5" className="[stop-color:var(--color-accent)] [stop-opacity:0.7]" />
          <stop offset="1" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
        </linearGradient>
      </defs>
      <g data-thread-cords fill="none" strokeWidth={1} mask="url(#ntwine-thread-cords)" className="stroke-accent opacity-70">
        <path ref={strandRefs[0]} />
        <path ref={strandRefs[1]} />
      </g>
      <g className="opacity-0 transition-opacity duration-150 group-data-[shown=true]/thread:opacity-100">
        <rect ref={seamRef} width={1} fill="url(#ntwine-thread-seam)" />
        <path ref={pathRef} pathLength={1} strokeDasharray="1 1" fill="none" strokeWidth={1} strokeLinecap="round" className="stroke-accent/55" />
        <circle ref={knotRef} r={2.25} className="fill-accent [transform-box:fill-box] [transform-origin:center]" />
      </g>
    </svg>
  )
}

/** A cord's row pitch: twice the distance from its first icon to its first crossing. */
function pitchOf(crossings: readonly number[], span: readonly [number, number]): number {
  return crossings.length > 0 ? 2 * (Math.min(...crossings) - span[0]) : Infinity
}
