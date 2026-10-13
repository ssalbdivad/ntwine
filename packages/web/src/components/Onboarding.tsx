import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router"
import { Plus } from "lucide-react"
import type { ProjectCard } from "@ntwine/shared"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { homeOf, shortPath, useAddProject, warmProjectPicker } from "./ProjectActions.tsx"
import { projectViewHref } from "../lib/pageView.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { endTour, setTourStep, useTourStep } from "../lib/tour.ts"

// FIRST RUN (lib/tour.ts): a project to start in, then a short tour of its board.

// ---- The project pick ---------------------------------------------------------------------------------

/**
 * A bare `/` in a browser that has never been onboarded and has a project to show: which one to start in.
 * Choosing one opens its board, where the tour starts (routes.tsx). Adding one first lands back here with
 * it listed. With no project at all this is the welcome instead (ProjectActions.tsx Welcome).
 */
export function ProjectPick({ projects: cards }: { projects: readonly ProjectCard[] }) {
  const navigate = useNavigate()
  const add = useAddProject()
  const home = homeOf(cards)
  const projects = cards.filter((card) => !card.home && !card.stale)
  const homeCard = cards.find((card) => card.home && !card.stale)
  const list = useRef<HTMLUListElement>(null)
  const choose = (card: ProjectCard) => navigate(projectViewHref(card.slug))
  // The first project is focused, so Enter takes it and ↑/↓ walk the list.
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })
  }, [])
  const step = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]
    event.preventDefault()
    next?.focus()
  }
  return (
    <div className="flex min-h-dvh w-full">
      <div data-onboarding-pick className="m-auto flex w-full max-w-[420px] flex-col items-center gap-2.5 px-6 py-14 text-center">
        <img src="/favicon.svg" width={76} height={76} alt="" className="rounded-[17px]" />
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">Pick a project to start with</h1>
        <p className="text-[13px] leading-relaxed text-muted">You can add more and switch between them any time.</p>
        <ul ref={list} onKeyDown={step} className="mt-4 flex w-full max-w-[360px] flex-col gap-0.5 text-left">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                data-onboarding-project={project.slug}
                onClick={() => choose(project)}
                className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ink-60"
              >
                <span className="shrink-0"><ProjectSquare project={project} size={16} /></span>
                <span className="min-w-0 shrink-0 truncate font-medium text-fg">{project.name}</span>
                <span className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-muted-55">{shortPath(project.path, home)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onPointerEnter={warmProjectPicker}
          onFocus={warmProjectPicker}
          onClick={add.start}
          disabled={add.pending}
          className="mt-1 flex w-full max-w-[360px] items-center gap-2.5 rounded-md border border-dashed border-border-strong px-2.5 py-2 text-left text-[13px] text-muted outline-none transition-colors hover:border-fg/40 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-60"
        >
          <Plus size={16} aria-hidden className="shrink-0" />
          {add.pending ? "Choosing a folder…" : "Add a project"}
        </button>
        {homeCard && (
          <p className="mt-4 text-[11.5px] text-muted-70">
            Or{" "}
            <button
              type="button"
              data-onboarding-home
              onClick={() => choose(homeCard)}
              className="rounded-sm text-fg/85 underline decoration-muted/40 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            >
              start in {shortPath(homeCard.path, home)}
            </button>{" "}
            without a project.
          </p>
        )}
      </div>
    </div>
  )
}

// ---- The tour -----------------------------------------------------------------------------------------

interface Callout {
  /** What to point at. */
  target: () => Element | null
  label: string
}

interface TourStepSpec {
  title: string
  body: string
  /** What the card points at, and the spotlight's hole. None for the closing card, which points at nothing. */
  target?: () => Element | null
  /** A second hole in the spotlight, with no arrow of its own. */
  also?: () => Element | null
  /** Labelled arrows, for a step that names several parts at once. The card then draws none. */
  callouts?: Callout[]
}

const select = (selector: string) => () => document.querySelector(selector)

// The steps, in order. Every target is on both a board and All projects, so the tour runs on either. The
// first holds the switcher's menu open (lib/tour.ts SWITCHER_STEP), so its arrows have its rows to point at;
// it must stay first. The last points at nothing: it is the closing card, and says how little there was.
const STEPS: TourStepSpec[] = [
  {
    title: "Switch projects",
    body: "This menu at the top of the page is how you move between projects.",
    target: () => document.querySelector('[data-tour="switcher-all"]')?.closest('[role="menu"]') ?? null,
    also: select("[data-xq-switcher]"),
    callouts: [
      { target: select('[data-tour="switcher-all"]'), label: "See every project on one page" },
      { target: select('[data-tour="switcher-projects"]'), label: "Go to another project" },
      { target: select('[data-tour="switcher-add"]'), label: "Add another folder as a project" },
    ],
  },
  {
    title: "Start a thread",
    body: "Describe a task and press Enter. An agent picks it up and works on it here.",
    target: select('[data-tour="composer"]'),
  },
  {
    title: "Your queue",
    body: "When a thread finishes or needs an answer from you, it waits here.",
    target: select("[data-inbox-header] h2"),
  },
  {
    title: "Your threads",
    body: "Every thread, grouped by where it stands: waiting on you, running, snoozed or done.",
    target: select("[data-xq-rail]"),
  },
  {
    title: "That's it!",
    body: "Describe a task, then answer what lands in your queue. That's the whole thing.",
  },
]

/** The steps that point at something, which the card counts: the closing card is not one of them. */
const POINTED = STEPS.filter((spec) => spec.target).length

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const PAD = 6
const CARD_W = 300
const GAP = 88

function boxOf(element: Element | null): Box | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 4 || rect.height < 4) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function sameBoxes(a: (Box | null)[], b: (Box | null)[]): boolean {
  return a.length === b.length && a.every((box, i) => {
    const other = b[i]
    if (!box || !other) return box === other
    return Math.abs(box.left - other.left) < 0.5 && Math.abs(box.top - other.top) < 0.5 && Math.abs(box.width - other.width) < 0.5 && Math.abs(box.height - other.height) < 0.5
  })
}

/** Every box a step draws around, re-read each frame while it shows: the menu animates in, the page reflows. */
function useStepBoxes(spec: TourStepSpec | undefined): { target: Box | null; also: Box | null; callouts: (Box | null)[] } | null {
  const [boxes, setBoxes] = useState<(Box | null)[] | null>(null)
  useLayoutEffect(() => {
    if (!spec) {
      setBoxes(null)
      return
    }
    let frame = 0
    let last: (Box | null)[] = []
    const read = () => {
      const next = [boxOf(spec.target?.() ?? null), boxOf(spec.also?.() ?? null), ...(spec.callouts ?? []).map((callout) => boxOf(callout.target()))]
      if (!sameBoxes(next, last)) {
        last = next
        setBoxes(next)
      }
      frame = requestAnimationFrame(read)
    }
    read()
    return () => cancelAnimationFrame(frame)
  }, [spec])
  if (!boxes) return null
  const [target = null, also = null, ...callouts] = boxes
  return { target, also, callouts }
}

/**
 * THE TOUR — a card per step and a drawn arrow from it to the part of the page it names, over a scrim with
 * a hole where that part is. Enter, →, Space or a click anywhere goes on; ← goes back; Escape ends it. The
 * page under it takes no input while it shows. Hosted by the layout (routes.tsx), since it starts on the
 * arrival a navigation makes.
 */
export function Tour() {
  const step = useTourStep()
  const phone = useIsMobile()
  const spec = step === null || phone ? undefined : STEPS[step]
  const boxes = useStepBoxes(spec)
  // A step whose part is not on the page (an empty list) is passed over in the direction of travel, after a
  // moment for the page to draw it. On a phone, whose page has none of these parts, nothing shows until the
  // page is wide again.
  const direction = useRef(1)
  useEffect(() => {
    if (step === null || !spec?.target || boxes?.target) return
    const timer = window.setTimeout(() => go(step + direction.current), 1200)
    return () => window.clearTimeout(timer)
  }, [step, spec, boxes?.target])

  function go(next: number) {
    direction.current = next < (step ?? 0) ? -1 : 1
    if (next < 0) return
    if (next >= STEPS.length) endTour()
    else setTourStep(next)
  }

  const showing = step !== null && spec !== undefined && (!spec.target || boxes?.target != null)
  useEffect(() => {
    if (step === null || !showing) return
    // Window CAPTURE, ahead of everything — the switcher's menu takes Enter and Escape from a document
    // capture listener, and a held-open menu must not act on the keys that drive the tour.
    const onKey = (event: KeyboardEvent) => {
      const forward = event.key === "Enter" || event.key === "ArrowRight" || event.key === " "
      const back = event.key === "ArrowLeft"
      if (!forward && !back && event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === "Escape") endTour()
      else go(step + (forward ? 1 : -1))
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })

  if (step === null || !spec || !showing) return null
  if (!spec.target) return createPortal(<Finale spec={spec} onGo={go} step={step} />, document.body)
  if (!boxes?.target) return null
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  // The callouts' parts sit inside the target, so only the target and `also` cut the scrim.
  const holes = [boxes.target, boxes.also].filter((box): box is Box => box !== null)
  const spot = unionOf(holes)
  const callouts = (spec.callouts ?? []).flatMap((callout, i) => {
    const box = boxes.callouts[i]
    return box ? [{ label: callout.label, box }] : []
  })
  const layout = callouts.length > 0 ? calloutLayout(spot, callouts, viewport) : cardLayout(boxes.target, viewport)
  return createPortal(
    <div
      data-tour-overlay
      role="dialog"
      aria-modal="true"
      aria-label={`Tour, step ${step + 1} of ${POINTED}: ${spec.title}`}
      className="fixed inset-0 z-[400] cursor-pointer select-none"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => go(step + 1)}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full" width={viewport.width} height={viewport.height} aria-hidden>
        <defs>
          <mask id="ntwine-tour-holes">
            <rect width="100%" height="100%" fill="white" />
            {holes.map((hole, i) => (
              <rect key={i} x={hole.left - PAD} y={hole.top - PAD} width={hole.width + 2 * PAD} height={hole.height + 2 * PAD} rx={10} fill="black" />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" className="fill-scrim-55" mask="url(#ntwine-tour-holes)" />
        {holes.map((hole, i) => (
          <rect key={i} x={hole.left - PAD} y={hole.top - PAD} width={hole.width + 2 * PAD} height={hole.height + 2 * PAD} rx={10} fill="none" className="stroke-accent" strokeOpacity={0.55} strokeWidth={1.5} />
        ))}
        {/* Keyed on the step, so each step's arrows draw themselves in afresh. */}
        <g key={step}>
          {layout.arrows.map((arrow, i) => (
            <DrawnArrow key={i} from={arrow.from} to={arrow.to} bend={arrow.bend} delay={i * 140} />
          ))}
        </g>
      </svg>
      {layout.labels.map((label, i) => (
        <div
          key={`${step}-${i}`}
          data-tour-label
          className="tour-fade-in pointer-events-none absolute max-w-[240px] rounded-md bg-panel px-2.5 py-1.5 text-[12.5px] font-medium leading-snug text-fg shadow-lg ring-1 ring-border"
          style={{ left: label.left, top: label.top, transform: "translateY(-50%)", animationDelay: `${i * 140 + 220}ms` }}
        >
          {label.text}
        </div>
      ))}
      <TourCard step={step} spec={spec} left={layout.card.left} top={layout.card.top} onGo={go} />
    </div>,
    document.body,
  )
}

function TourCard({ step, spec, left, top, onGo }: { step: number; spec: TourStepSpec; left: number; top: number; onGo: (next: number) => void }) {
  const last = step === STEPS.length - 1
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <div
      data-tour-card
      onClick={stop}
      className="absolute cursor-default rounded-xl bg-panel p-4 text-left shadow-2xl ring-1 ring-border"
      style={{ left, top, width: CARD_W }}
    >
      <div className="text-[11px] font-medium tabular-nums text-muted-55">
        {step + 1} of {POINTED}
      </div>
      <h2 className="mt-1 text-[15px] font-semibold text-fg">{spec.title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{spec.body}</p>
      <div className="mt-4 flex items-center gap-2">
        <button type="button" onClick={() => endTour()} className="rounded-md px-1.5 py-1 text-[12px] text-muted-70 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
          Skip tour
        </button>
        <span className="flex-1" />
        {step > 0 && (
          <button type="button" onClick={() => onGo(step - 1)} className="rounded-md px-2.5 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Back
          </button>
        )}
        <button
          type="button"
          data-tour-next
          onClick={() => onGo(step + 1)}
          className="rounded-md bg-accent-fill px-3 py-1 text-[12px] font-semibold text-on-accent outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {last ? "Done" : "Next"}
        </button>
      </div>
      <p className="mt-3 text-[11px] text-muted-55">
        <Key>→</Key> or <Key>Enter</Key> for next, <Key>Esc</Key> to skip
      </p>
    </div>
  )
}

/**
 * THE CLOSING CARD — no arrow and no hole: the page is the point by now. The mark in the middle of a burst of
 * strokes drawn in the arrows' hand, then the line that says how little there was to learn. Enter, → or a
 * click closes it; ← goes back to the last step.
 */
function Finale({ spec, step, onGo }: { spec: TourStepSpec; step: number; onGo: (next: number) => void }) {
  // Eight strokes around a 56px mark, each from 40px out to 54px, drawn in one after another.
  const rays = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2
    const from = 42
    const to = i % 2 === 0 ? 56 : 51
    return { x1: 64 + Math.cos(angle) * from, y1: 64 + Math.sin(angle) * from, x2: 64 + Math.cos(angle) * to, y2: 64 + Math.sin(angle) * to }
  })
  return (
    <div
      data-tour-overlay
      role="dialog"
      aria-modal="true"
      aria-label={`Tour: ${spec.title}`}
      className="tour-fade-in fixed inset-0 z-[400] flex cursor-pointer select-none items-center justify-center bg-scrim-55"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onGo(step + 1)}
    >
      <div
        data-tour-card
        data-tour-finale
        onClick={(event) => event.stopPropagation()}
        className="flex w-[340px] cursor-default flex-col items-center rounded-xl bg-panel px-6 pb-5 pt-4 text-center shadow-2xl ring-1 ring-border"
      >
        <div className="relative h-[128px] w-[128px]">
          <svg className="absolute inset-0" width={128} height={128} aria-hidden>
            <g className="stroke-accent" strokeWidth={2.25} strokeLinecap="round">
              {rays.map((ray, i) => (
                <line key={i} {...ray} pathLength={1} className="tour-draw" style={{ animationDelay: `${120 + i * 45}ms` }} />
              ))}
            </g>
          </svg>
          <img src="/favicon.svg" width={56} height={56} alt="" className="absolute left-[36px] top-[36px] rounded-[13px]" />
        </div>
        <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">{spec.title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{spec.body}</p>
        <div className="mt-5 flex w-full items-center gap-2">
          <button type="button" onClick={() => onGo(step - 1)} className="rounded-md px-2.5 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Back
          </button>
          <span className="flex-1" />
          <button
            type="button"
            data-tour-next
            onClick={() => onGo(step + 1)}
            className="rounded-md bg-accent-fill px-3 py-1 text-[12px] font-semibold text-on-accent outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-bg px-1 font-sans text-[10.5px] text-muted">{children}</kbd>
}

// ---- Layout ---------------------------------------------------------------------------------------------

interface Point {
  x: number
  y: number
}

interface Arrow {
  from: Point
  to: Point
  /** How far the curve bows from the straight line, in px; the sign picks the side. */
  bend: number
}

interface Layout {
  card: { left: number; top: number }
  arrows: Arrow[]
  labels: { left: number; top: number; text: string }[]
}

/** The card's height, near enough to place it: its title and two lines of body. */
const CARD_H = 176
const EDGE = 16

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function unionOf(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.left + box.width))
  const bottom = Math.max(...boxes.map((box) => box.top + box.height))
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * One card and one arrow: the card on the side of the target with the most room — right, then left, then
 * below, then above — and the arrow from the card's near edge to the target's.
 */
function cardLayout(target: Box, viewport: { width: number; height: number }): Layout {
  const right = viewport.width - (target.left + target.width)
  const left = target.left
  const below = viewport.height - (target.top + target.height)
  const middleY = target.top + target.height / 2
  const cardTop = clamp(middleY - CARD_H / 2 + 24, EDGE, viewport.height - CARD_H - EDGE)
  if (right >= CARD_W + GAP + EDGE || right >= left) {
    const cardLeft = Math.min(target.left + target.width + PAD + GAP, viewport.width - CARD_W - EDGE)
    return {
      card: { left: cardLeft, top: cardTop },
      arrows: [{ from: { x: cardLeft - 10, y: cardTop + 34 }, to: { x: target.left + target.width + PAD + 6, y: clamp(middleY, target.top + 8, target.top + target.height - 8) }, bend: -28 }],
      labels: [],
    }
  }
  if (left >= CARD_W + GAP + EDGE) {
    const cardLeft = target.left - PAD - GAP - CARD_W
    return {
      card: { left: cardLeft, top: cardTop },
      arrows: [{ from: { x: cardLeft + CARD_W + 10, y: cardTop + 34 }, to: { x: target.left - PAD - 6, y: clamp(middleY, target.top + 8, target.top + target.height - 8) }, bend: 28 }],
      labels: [],
    }
  }
  const middleX = target.left + target.width / 2
  const cardLeft = clamp(middleX - CARD_W / 2 + 60, EDGE, viewport.width - CARD_W - EDGE)
  if (below >= CARD_H + GAP || below >= target.top) {
    const cardTop = Math.min(target.top + target.height + PAD + GAP, viewport.height - CARD_H - EDGE)
    return {
      card: { left: cardLeft, top: cardTop },
      arrows: [{ from: { x: cardLeft + 40, y: cardTop - 10 }, to: { x: middleX, y: target.top + target.height + PAD + 6 }, bend: 28 }],
      labels: [],
    }
  }
  const cardTopAbove = Math.max(EDGE, target.top - PAD - GAP - CARD_H)
  return {
    card: { left: cardLeft, top: cardTopAbove },
    arrows: [{ from: { x: cardLeft + 40, y: cardTopAbove + CARD_H + 10 }, to: { x: middleX, y: target.top - PAD - 6 }, bend: -28 }],
    labels: [],
  }
}

/**
 * Several labelled arrows, one per part: the labels in a column right of the spotlit area, each level with
 * its part, its arrow drawn from the label back to the part's right edge. The card sits under the labels.
 */
function calloutLayout(spot: Box, callouts: { label: string; box: Box }[], viewport: { width: number; height: number }): Layout {
  const column = Math.min(spot.left + spot.width + PAD + GAP, viewport.width - 240 - EDGE)
  // Each label level with its part, but never closer than 36px to the one above, so short rows don't stack
  // their labels into each other.
  let floor = -Infinity
  const labels = callouts.map((callout) => {
    const y = Math.max(callout.box.top + callout.box.height / 2, floor + 36)
    floor = y
    return { left: column, top: y, text: callout.label }
  })
  const arrows = callouts.map((callout, i): Arrow => ({
    from: { x: column - 10, y: labels[i]!.top },
    to: { x: spot.left + spot.width + PAD + 6, y: callout.box.top + callout.box.height / 2 },
    bend: i % 2 === 0 ? -16 : 16,
  }))
  const cardTop = clamp(floor + 44, EDGE, viewport.height - CARD_H - EDGE)
  return { card: { left: column, top: cardTop }, arrows, labels }
}

// ---- The arrow ------------------------------------------------------------------------------------------

/**
 * A hand-drawn arrow: a quadratic curve bowed to one side, drawn in over 380ms from its tail, then its head.
 * `pathLength={1}` lets one stroke-dash animation (styles.css `tour-draw`) draw any length.
 */
function DrawnArrow({ from, to, bend, delay }: { from: Point; to: Point; bend: number; delay: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  // The control point: the midpoint, pushed `bend` px along the normal.
  const control = { x: (from.x + to.x) / 2 - (dy / length) * bend, y: (from.y + to.y) / 2 + (dx / length) * bend }
  // The head follows the curve's tangent at its end, which runs from the control point to the tip.
  const angle = Math.atan2(to.y - control.y, to.x - control.x)
  const head = 9
  const wing = (side: number) => ({ x: to.x - head * Math.cos(angle + side * 0.5), y: to.y - head * Math.sin(angle + side * 0.5) })
  const a = wing(1)
  const b = wing(-1)
  return (
    <g className="stroke-accent" fill="none" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
      <path d={`M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`} pathLength={1} className="tour-draw" style={{ animationDelay: `${delay}ms` }} />
      <path d={`M ${a.x} ${a.y} L ${to.x} ${to.y} L ${b.x} ${b.y}`} className="tour-fade-in" style={{ animationDelay: `${delay + 340}ms` }} />
    </g>
  )
}
