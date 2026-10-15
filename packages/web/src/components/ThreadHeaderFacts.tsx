import type { ReactNode } from "react"
import type { ThreadView } from "@ntwine/shared"
import { lastActiveLabelAt } from "../groups.ts"
import { goalLoopParts } from "../lib/goalLoop.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { LastActive } from "./LastActive.tsx"
import { ContextMeter, hasContextReading } from "./ContextMeter.tsx"
import { GoalMark } from "./RecurringPromptControl.tsx"
import { DeadlineFact } from "./DeadlineControl.tsx"

// A THREAD HEADER'S SECOND LINE: the facts about the thread as a whole, in words — "Last active 2m ago ·
// ◔ 74% context · ◎ run 7 of 20". The drawer's thread header renders it; the context reading
// joined "Last active" here on 2026-10-05 when the lifecycle footer that carried it went (see
// ThreadLifecycle.tsx for the top/bottom split).
//
// The fork's drawer line says more than that, and says it through this component rather than beside it:
// `lead` is what opens the line (the band stamp, BandLabel.tsx), and `children` is what follows the facts
// (where the agent works, a spinoff's parent, the live status line) — each child takes `<FactSep />` as its
// own `lead`, so a reading that renders nothing leaves no separator behind.
//
// The Goal's LOOP READING came with the context. It rode beside the goal mark in that footer (2026-09-29);
// the mark itself moved to the prompt box's rail, a row of fixed 28px squares whose text reserve cannot
// grow with a reading of varying width, so the reading — a fact about how far the thread has got, not a
// control — reads here, led by the same mark so it still names whose count it is.
//
// Hidden when no fact rendered: a thread with no timestamp and no reading draws nothing, and must not leave
// the line's height and 2px top margin behind. The line always holds its `Fact` groups, empty or not, so
// `:empty` cannot see that; `:has` asks whether any of them drew something.
//
// ONE ROW, AND A FACT THAT DOES NOT FIT IS DROPPED WHOLE (FACTS_LINE_CLASS, below). The line used to be a
// plain nowrap row, where the context dial never shrank and everything before it did: at a 420px queue card
// "acme-api · Ready 37m ago · ◔ 74% context" read "s · L. · ◔ 74% context", and narrower still the time went
// to nothing and the line opened on a bare "·" (2026-10-06).
export function ThreadHeaderFacts({ thread, lead, children }: { thread: ThreadView; lead?: ReactNode; children?: ReactNode }) {
  const held = thread.held !== undefined
  return (
    <div data-thread-header-facts data-facts-line className={`mt-0.5 ${FACTS_LINE_CLASS} text-[11px] leading-tight text-muted-75 [&:not(:has(>[data-fact]:not(:empty)))]:hidden`}>
      {/* `self-center`: the band stamp (BandLabel) is an `items-center` inline-flex whose baseline is its
          glyph's box bottom, so on this baseline row its WORDS rode 2.38px above the time's. Centred like
          the row it was drawn for, the two baselines match (0.00px, sans 11px, 2026-10-06). */}
      {lead && <Fact className="self-center">{lead}</Fact>}
      {/* The time limit in its last stretch or over: ahead of the time, so a narrow line drops the time first. */}
      <Fact><DeadlineFact thread={thread} slot="urgent" lead={<FactSep />} keepOverrun /></Fact>
      <Fact>
        <LastActive
          // A held thread has never been active: its time is when it was written down (the queue card's word too).
          at={held ? thread.spawnedAt : lastActiveLabelAt(thread)}
          {...(held ? { label: "Added" } : {})}
          fallbackAt={thread.spawnedAt}
          lead={<FactSep />}
          className="min-w-0 truncate"
        />
      </Fact>
      {/* The time limit while there is plenty of it, right after the time (DeadlineFact says why two slots). */}
      <Fact><DeadlineFact thread={thread} slot="quiet" lead={<FactSep />} keepOverrun /></Fact>
      <Fact><ContextFact thread={thread} lead={<FactSep />} /></Fact>
      <Fact><GoalLoopFact thread={thread} lead={<FactSep />} /></Fact>
      {children}
    </div>
  )
}

/**
 * A HEADER FACTS LINE: one row of facts in priority order, left to right, where a fact that does not fit is
 * DROPPED WHOLE — with its separator — rather than squeezed. Each fact is a `Fact` group holding its own
 * leading `FactSep`; the row wraps, is exactly one line tall (`h-[1lh]`, 13.75px at the line's 11px
 * leading-tight — measured equal to the old nowrap row), and clips, so a group that would not fit wraps onto
 * a second row nobody sees. A wrapped group takes every group after it along, so the row always shows a
 * prefix of the facts, never one with a hole in it. `gap-y-4` puts that hidden row far outside the 3px clip
 * margin, which is there for focus rings and the chip's hover underline.
 *
 * A group that should TRUNCATE rather than drop (`give`: the project chip, a held card's status, the live
 * status line — each ends in an ellipsis of its own) claims only its `give` width while the row decides what
 * fits, then grows back toward its own width (`max-w-max`) out of whatever room is left. The `give` is the
 * narrowest the group may READ at, so it covers the parts that never shrink — the separator, and the status
 * line's elapsed clock (up to `2h 35m`) — plus a few letters: a group squeezed under them would draw its
 * separator and clock beside an empty ellipsis, which is the "squeezed to nothing" this line exists to stop
 * (measured 2026-10-06 at a 2.5em give: the status text drew 0px at a 560px drawer, leaving "· 4m").
 * A group whose content cannot truncate — the band stamp, a context dial — never takes a `give`: squeezed,
 * it would paint over its neighbour.
 *
 * A cap on a fact (`className="max-w-[50%]"`, the spinoff's) goes on the `Fact`, where a percentage is a
 * share of the LINE. Inside a fact it is a share of the fact's own width, which is the content's width —
 * so it truncated a spinoff handle at half its length with the whole row free.
 *
 * `items-baseline`, for the cap-band glyphs on this line (the context ring, the goal mark, a checkout
 * glyph): each stands on the baseline and lifts itself by `0.5em - 0.5cap`, which needs a baseline to
 * stand on.
 */
export const FACTS_LINE_CLASS = "flex h-[1lh] min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-4 overflow-clip [overflow-clip-margin:3px]"

/** One fact on a facts line, with its own leading separator inside it (FACTS_LINE_CLASS). Empty — the fact
 *  had nothing to say — it takes no room and no gap. `give`: it truncates down to that width rather than
 *  dropping (see FACTS_LINE_CLASS for what the width must cover). */
export function Fact({ give, className = "", children }: { give?: `${number}em`; className?: string; children?: ReactNode }) {
  return (
    <span
      data-fact
      className={`flex min-w-0 items-baseline gap-1.5 empty:hidden ${give ? "max-w-max grow" : ""} ${className}`}
      style={give ? { flexBasis: give } : undefined}
    >
      {children}
    </span>
  )
}

/** The line's separator, the first thing inside its `Fact`. It shows only where it SEPARATES — when a fact
 *  that rendered comes before its own — so the line never opens on a "·", whichever facts are empty: a
 *  thread with no timestamp draws no time, a thread with no band no stamp. */
export function FactSep() {
  return <span aria-hidden data-fact-sep className="hidden shrink-0 opacity-60 [[data-fact]:not(:empty)~[data-fact]>&]:inline">·</span>
}

/** The context dial and its percent (ContextMeter), only when the thread has a reading. */
export function ContextFact({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  if (!hasContextReading(thread)) return null
  return (
    <>
      {lead}
      <ContextMeter thread={thread} />
    </>
  )
}

// THE GOAL'S LOOP COUNTER: `run 7 of 20 · 1h 12m left`, or why it stopped (lib/goalLoop.ts). Nothing for a
// Goal with nothing to count toward. Its own component so only it subscribes to the ticking clock.
//
// The mark sits on the digits' cap band the way the context ring does (ContextMeter): `self-baseline`
// stands the 1em svg on the baseline, the translate lifts its centre half a cap, and `-mt-[1em]` keeps the
// svg out of the line's height. Amber while the loop is live, the line's own grey once it has stopped —
// the rail's mark carries the same "something is armed" tone, and this repeats it rather than inventing
// another.
export function GoalLoopFact({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  const nowMs = useNowMs()
  const armed = thread.recurringPrompt
  const reading = goalLoopParts(armed, nowMs)
  if (!reading) return null
  const live = !armed?.stopped && (armed?.stopHook === true || armed?.heartbeat === true || armed?.postCompaction === true)
  const text = reading.tail ? `${reading.lead} · ${reading.tail}` : reading.lead
  return (
    <>
      {lead}
      <span data-goal-loop title={`Goal: ${text}`} className="flex min-w-0 shrink items-baseline gap-1 whitespace-nowrap tabular-nums">
        <GoalMark size={11} className={`-mt-[1em] h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] ${live ? "text-attention-90" : ""}`} />
        <span className="min-w-0 truncate">{text}</span>
      </span>
    </>
  )
}
