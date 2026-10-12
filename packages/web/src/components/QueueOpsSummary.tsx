import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { ExternalLink, FileText } from "lucide-react"
import type { BgShellView, ThreadView } from "@frizz/shared"
import { CHILD_RESTED_DOT_CLASS, CHILD_STALE_DOT_CLASS, type TranscriptShellRecord } from "../lib/childOps.ts"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import { queueOpsCounts, type QueueOpsCount, type QueueOpsKind } from "../lib/queueOpsCounts.ts"
import { BackgroundOpsStrip } from "./ChatView.tsx"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"

// THE QUEUE CARD'S LIVE OPS, CONDENSED: one line of counts at the right, just above the docked prompt
// box — "● 2 agents  ● 1 shell  ● 1 PR  ▤ 2 files" — with the ⤷ rows themselves one hover away.
//
// Until 2026-10-05 every live op was its own ⤷ row hanging under the card's prompt box, then the
// lifecycle footer under those: on a busy thread the bottom of a card was a column of rows taller than
// the reply it carried, all of it scrolling away with the card. The prompt box now docks to the bottom
// of the screen while the card is on it, and a dock cannot carry a column of rows, so the rows fold into
// counts (maintainer: "the area where we list out all of the sub agents and the files and all of that
// should probably just show up as like a condensed view, like to the upper right of the prompt box,
// where it just lists out the number of subagents, the number of files, et cetera … Then you can hover
// over to see the details").
//
// EACH COUNT OPENS ITS OWN PANEL, holding that kind of row and no other (maintainer 2026-10-11: "there
// should be a popover for each of the different categories … If you hover over Files, it should show
// the files. If you hover over the pull request watchers, it should show the pull request"). Until then
// the whole line was one control over one panel listing every row, so the count the pointer was on said
// nothing about what opened. One panel is open at a time, and the pointer moving along the line swaps
// it the way a menu bar does.
//
// THE ROWS IN A PANEL ARE THE REAL ONES — the components that drew them under the box — so a row still
// opens its drawer, stops its child, and reads its CI the way it did. The COUNTS are taken from the same
// lists those components render, by the same filters, so a count and its panel cannot disagree about how
// many there are (lib/queueOpsCounts.ts). The fork's cross-project card composes its own rows (`counts`
// and `panel`): on that page the board is the FOCUSED project's, usually not the card's, so AllQueuesCard
// hands in rows drawn from its own project, one kind per panel. The drawer reads the page's own board, so
// it hands in the thread and this draws upstream's rows (QueueSubAgentLines, BackgroundOpsStrip `only`).
//
// THE DRAWER DRAWS THE SAME LINE, since 2026-10-09 (maintainer: "We should be using the condensed
// activity summary in the queue cards as well as in the drawer view"). Until then the drawer kept the
// ⤷ column under its prompt box, so one thread read as counts on its card and as a column of rows in
// its drawer. Both hand in the shells they read off the transcript (`transcriptShells`), which the board
// does not report for a Codex thread. The phone and /full
// beside its rail draw neither: the ⋯ sheet and the rail already list every row (ChatView).
//
// THE MARK IS THE ROWS' OWN LIVENESS DOT, in the row's hue (yellow agent, blue shell, violet watch), and
// it pulses only while at least one row of that kind is running. Otherwise it is the rows' own settled
// mark (lib/childOps.ts): the hollow ring when one of them rested, the flat dot when they went stale.

// How long a panel survives the pointer leaving its count. It opens on hover and holds buttons, so the
// pointer must be able to cross the gap between the two without it closing — the same grace
// ContextMeter's panel gives.
const HOVER_CLOSE_DELAY_MS = 150

// What a panel is called, since it holds one kind of row.
const PANEL_LABEL: Record<QueueOpsKind, string> = {
  agent: "Sub-agents running for this thread",
  workflow: "Workflows running for this thread",
  terminal: "Shells and terminals running for this thread",
  pr: "Pull requests this thread is watching",
  issue: "Issues this thread is watching",
  file: "Files saved for this thread",
  link: "Links saved for this thread",
}

type QueueOpsSummaryProps =
  // The caller's own counts and rows, one kind per panel — the cross-project card's form.
  | { counts: readonly QueueOpsCount[]; panel: (kind: QueueOpsKind) => ReactNode }
  // The page's own board — the drawer's form. `transcriptShells` are the shells read off its transcript.
  | { thread: ThreadView; transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[] }

export function QueueOpsSummary(props: QueueOpsSummaryProps) {
  const { groups, panel } = "counts" in props
    ? { groups: props.counts, panel: props.panel }
    : threadOps(props.thread, props.transcriptShells ?? [])
  const [openKind, setOpenKind] = useState<QueueOpsKind | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const line = useRef<HTMLDivElement>(null)
  // The last row of a kind can end, or be stopped from its × in the panel, while its panel is open —
  // and nothing then says close: the count unmounts and its panel with it, so no pointer leaves either
  // and Radix sends no change. Left set, the panel sprang open by itself, over the transcript, the next
  // time the agent started anything of that kind. With nothing of that kind to count it is closed.
  const gone = openKind !== null && !groups.some((group) => group.key === openKind)
  useEffect(() => {
    if (!gone) return
    clearTimeout(closeTimer.current)
    setOpenKind(null)
  }, [gone])
  if (groups.length === 0) return null
  const openNow = (kind: QueueOpsKind) => {
    clearTimeout(closeTimer.current)
    setOpenKind(kind)
  }
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpenKind(null), HOVER_CLOSE_DELAY_MS)
  }
  return (
    // THE LINE FILLS THE DOCK'S TOP INSET AND SITS IN THE MIDDLE OF IT. `-mt-3 h-8`: the dock pads 12px
    // over its content (the drawer's footer pads the same), so the line starts on the rule and the prompt
    // box stands 32px under it, where it stood before. It was `-mt-2 h-7 items-center` until 2026-10-11,
    // which centred the counts in the lower 28px of those 32: 14.27px from the rule down to the cap band
    // and 9.63px from the baseline to the box (maintainer: "there's more space above the artifact chips
    // than below. The spacing looks off").
    //
    // THE BROWSER PLACES THE BASELINE, not a nudge fitted to one font. The strut is an empty box, whose
    // baseline is its bottom edge, and it is the tallest thing above the row's shared baseline — so the
    // baseline lands `16px + 0.5cap` under the rule, and the cap band's centre lands on 16px, half of the
    // 32. Measured after, sans: 11.94px above the cap band and 11.95px under the baseline, on the queue
    // card and in the drawer (queueOpsPanels.e2e.test.ts pins the pair). The size is set HERE so the
    // strut's `cap` is the counts' own.
    <div data-queue-ops-summary ref={line} className="-mt-3 flex h-8 min-w-0 items-baseline justify-end text-[11.5px]">
      <span aria-hidden className="h-[calc(16px_+_0.5cap)] w-0 shrink-0" />
      {groups.map((group) => (
        <OpsCount
          key={group.key}
          group={group}
          line={line}
          open={openKind === group.key}
          onOpen={() => openNow(group.key)}
          onCloseSoon={closeSoon}
          // A change Radix sends for one panel (a press outside it, Escape, focus moving on) closes only
          // that panel: by then the pointer or the focus may already have opened the next count's.
          onOpenChange={(next) => (next ? openNow(group.key) : setOpenKind((current) => (current === group.key ? null : current)))}
        >
          {panel(group.key)}
        </OpsCount>
      ))}
    </div>
  )
}

// The drawer's counts and rows, off the page's own board.
function threadOps(thread: ThreadView, transcriptShells: readonly (BgShellView & TranscriptShellRecord)[]) {
  const subAgents = thread.subAgents ?? []
  return {
    groups: queueOpsCounts(thread, { transcriptShells }),
    panel: (kind: QueueOpsKind): ReactNode =>
      kind === "agent" || kind === "workflow"
        ? <QueueSubAgentLines slug={thread.id} subAgents={subAgents.filter((child) => Boolean(child.workflow) === (kind === "workflow"))} className="" />
        : <BackgroundOpsStrip slug={thread.id} includeAgents={false} only={kind} transcriptShells={transcriptShells} className="" />,
  }
}

// One count and the panel it opens.
function OpsCount({ group, line, open, onOpen, onCloseSoon, onOpenChange, children }: {
  group: QueueOpsCount
  line: RefObject<HTMLDivElement | null>
  open: boolean
  onOpen: () => void
  onCloseSoon: () => void
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const word = group.n === 1 ? group.one : group.many
  // THE KEYBOARD'S WAY IN. Focus opens the panel the way hover does, but it is portaled to the end of the
  // page, so Tab from a count goes to the next count and then the prompt box, and the panel closes — its
  // rows (open a drawer, stop a child) were Tab stops when they hung under the box. Enter, Space or ↓ on
  // a count moves focus to its panel's first control; Escape there brings it back to the count.
  const focusPanel = () => {
    onOpen()
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])")?.focus())
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-ops-count={group.key}
          aria-label={`${group.n} ${word} — show ${group.n === 1 ? "it" : "them"}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseEnter={onOpen}
          onMouseLeave={onCloseSoon}
          onFocus={onOpen}
          ref={button}
          onClick={(event) => {
            // The line sits inside a queue card; the click is this control's, not the card's. A click
            // OPENS, never toggles: with a mouse the hover already opened the panel. A keyboard click
            // (Enter or Space, `detail` 0) carries focus into it.
            event.stopPropagation()
            if (event.detail === 0) focusPanel()
            else onOpen()
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return
            event.preventDefault()
            focusPanel()
          }}
          onMouseDown={(event) => event.preventDefault()}
          // `px-1.5` and no gap between the counts: two neighbours stand 12px apart, box to box, which is
          // what the one control's `gap-3` drew, and each count's hover square reaches halfway to the next.
          // Ink, scripts/ink-gaps.mjs at dsf 6, sans: 8.00–9.42px from a mark to its digit and
          // 13.57–14.64px from one count's word to the next count's mark, dots and icons alike.
          className={`flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${open ? "bg-panel-2 text-fg/85" : "text-muted-70 hover:bg-panel-2 hover:text-fg/85"}`}
        >
          {/* ON THE CAP BAND, computed by the browser (the ThreadLinks icon idiom): a 1em slot whose
              bottom sits on the baseline, lifted so its centre lands at half the cap height — the
              count beside it is digits, which are cap-height ink. The mark is ABSOLUTELY centred in
              the slot, never a flex child of it: a flex slot takes its baseline from its first
              child, so a 6px dot's bottom edge (not the slot's) landed on the baseline and the dot
              rode ~2px low. An empty block synthesizes its baseline from its own bottom edge. */}
          <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
            <span className="absolute inset-0 flex items-center justify-center"><CountMark kind={group.key} states={group.states} /></span>
          </span>
          <span><span className="tabular-nums text-fg/85">{group.n}</span> {word}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={4}
        data-queue-ops-panel={group.key}
        aria-label={PANEL_LABEL[group.key]}
        onMouseEnter={onOpen}
        onMouseLeave={onCloseSoon}
        // Hover opened it, so focus stays where the operator left it — the caret in the prompt box.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A press on a count, or focus arriving on one, is the line's own gesture, and the line decides
        // what it opens. Without this Radix reads either as an interaction OUTSIDE the panel and shuts
        // it: a press closed the panel under the click that then had to reopen it, and Tab onto a count
        // opened its panel and closed it inside the same focus event — the panel mounts while that event
        // is still on its way to the document, where Radix has just started listening for it.
        onInteractOutside={(event) => {
          if (line.current?.contains(event.target as Node)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          // Replaces the wrapper's handler, so it keeps that handler's one job: this Escape is the
          // panel's, not the window's (App, or /full's exit).
          event.stopPropagation()
          if (panel.current?.contains(document.activeElement)) button.current?.focus()
        }}
        ref={panel}
        onClick={(event) => event.stopPropagation()}
        className="flex w-[440px] max-w-[calc(100vw-1.5rem)] flex-col px-3 py-2"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

function CountMark({ kind, states }: { kind: QueueOpsKind; states: readonly (string | undefined)[] }) {
  switch (kind) {
    case "agent":
    case "workflow": return <Dot hue="agent" states={states} />
    case "terminal": return <Dot hue="shell" states={states} />
    case "pr":
    case "issue": return <Dot hue="github" states={states} />
    case "file": return <FileText aria-hidden className="h-[1em] w-[1em] text-muted-45" />
    case "link": return <ExternalLink aria-hidden className="h-[1em] w-[1em] text-muted-45" />
  }
}

function Dot({ hue, states }: { hue: "agent" | "shell" | "github"; states: readonly (string | undefined)[] }) {
  if (states.some(isRunningOperation)) return <span className={`frizz-live-dot frizz-live-dot--${hue}`} />
  return <span className={states.includes("rested") ? CHILD_RESTED_DOT_CLASS : CHILD_STALE_DOT_CLASS} />
}
