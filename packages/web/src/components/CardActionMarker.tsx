// A BUTTON'S SEND, on the human's side of the conversation (shared parseCardAction): the resting card's
// Continue, the steps card's Done, Retry / Continue now, Restart agent. Its words are for the worker, so
// the chat draws one line the way "Asked for an update" is drawn (NtwineWake UpdateRequestedMarker):
// right-justified on the user bubble's surface, with the button's glyph and fixed wording so it never
// reads as something they typed. The queue card draws the same marker for the ask its handoff answers.
import type { ReactNode } from "react"
import { Check, Play, RefreshCw, RotateCcw, type LucideIcon } from "lucide-react"
import type { CardAction } from "@ntwine/shared"
import { CARD_ACTION_COPY } from "../lib/cardActions.ts"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

// Each glyph is the one on the button it stands for. Vertical: the cap-band centring every
// glyph-beside-text here uses. Horizontal: a lucide glyph paints only part of its 24-unit box, so on
// `gap-1.5` its ink sat further from the word than the 5–6px word space the label reads in; each margin
// takes that dead box back (sans, 13px, measured with scripts/ink-gaps.mjs 2026-11-18). Play's was
// measured 2026-10-14: its ink is 6–20 of 24 units, its tip 8.17px from the word untrimmed.
const GLYPHS: Record<CardAction, { icon: LucideIcon; trim: string }> = {
  "keep-working": { icon: Play, trim: "-mr-[0.2em]" },
  "steps-done": { icon: Check, trim: "-mr-[0.12em]" },
  retry: { icon: RotateCcw, trim: "-mr-[0.05em]" },
  "restart-worker": { icon: RefreshCw, trim: "-mr-[0.05em]" },
}

type CardActionMarkerProps = {
  kind: CardAction
  sourceId?: string
  /** A send not yet read, or one that failed, as the bubble it stands in for would be. */
  dimmed?: boolean
  /** What that bubble would carry under it (a failed send's row). */
  children?: ReactNode
}

export function CardActionMarker({ kind, sourceId, dimmed, children }: CardActionMarkerProps) {
  const { icon: Icon, trim } = GLYPHS[kind]
  return (
    <div data-ntwine-msg={sourceId} data-card-action={kind} className="flex max-w-[85%] flex-col items-end self-end">
      <div className={`flex items-baseline gap-1.5 ${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-2.5 text-[13px] leading-5 text-user-bubble-fg ${dimmed ? "opacity-50" : ""}`}>
        <Icon aria-hidden="true" className={`size-[1em] shrink-0 self-baseline ${trim} translate-y-[calc(0.5em_-_0.5cap)] opacity-70`} />
        <span>{CARD_ACTION_COPY[kind].marker}</span>
      </div>
      {children}
    </div>
  )
}
