import type { ComponentType } from "react"
import { Bot, ExternalLink, Inbox, Pin, SquareCheck } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { bandOf, type Band } from "../groups.ts"
import { optimisticallyArchived, useArchivingAt } from "../lib/optimisticArchive.ts"
import { optimisticallySteered, useSteeredAt } from "../lib/steering.ts"

// THE BAND TABLE — every rail band's name and icon, in ONE place, because three surfaces say them and
// the whole point is that all three say them IDENTICALLY:
//   · the rail's band headers (Sidebar SectionHeader);
//   · the inbox's own header over the queue cards (TodosView) — READY with the inbox, the name and
//     glyph of the rail band whose rows ARE those cards;
//   · the stamp in a thread's header (ChatView ThreadHeader) — WORKING with the bot on a drawer opened
//     from the Working band, flipping to READY the moment that thread rests into the inbox behind it.
// Together they make the rail's headers a legend for the whole screen: the middle column is the Ready
// band's cards, and a thread that opens on the side names its band too (maintainer 2026-09-24: make it
// obvious that the middle of the screen is the inbox and a running thread opens in the side panel).
// Change a name or an icon HERE and every surface moves with it; give one surface its own and the
// legend stops being one.
//
// Every band wears an icon (maintainer 2026-09-23), and above all the two whose names alone do not say
// whose move it is: Ready is an inbox (yours) and Working a bot (the agent's). A developer's face
// mirroring the bot was tried and dropped: at 11px a round head reads as an emoji, and every feature
// added to make it human (hair, glasses, pupils) fused with the next. The bot is static — the rows
// under it already spin, and a header is permanent chrome.
export type BandKey = Band | "pinned"

export const BANDS: Record<BandKey, { label: string; Icon: ComponentType<{ size?: number }> }> = {
  pinned: { label: "Pinned", Icon: Pin },
  ready: { label: "Ready", Icon: Inbox },
  working: { label: "Working", Icon: Bot },
  snoozed: { label: "Snoozed", Icon: SnoozeMark },
  done: { label: "Done", Icon: SquareCheck },
  external: { label: "External", Icon: ExternalLink },
}

/** The type the band names are set in — the rail's section-header face. */
export const BAND_LABEL_TYPE = "text-[11px] uppercase tracking-wide text-muted-70"

/**
 * A band's icon in its 11px slot, lifted onto the uppercase label's cap band. Box-centred at 11px sans,
 * every band icon measured 1.75px low (0.16em) — they all fill their viewBox symmetrically — and the
 * residual after the lift is ~0. Re-measure if an icon with off-centre ink joins. The lift is only right
 * beside an 11px UPPERCASE label on an `items-center` line, which is why the slot lives with the label.
 */
export function BandGlyph({ band }: { band: BandKey }) {
  const { Icon } = BANDS[band]
  return (
    <span className="flex w-[11px] shrink-0 -translate-y-[0.16em] justify-center" aria-hidden>
      <Icon size={11} />
    </span>
  )
}

/** A band's count, riding right beside its label: it is meaningful data, not a margin ornament. */
export function BandCount({ count }: { count: number }) {
  return <span className="ml-1.5 tabular-nums text-muted-60">{count}</span>
}

/**
 * The band, named: icon, NAME, and an optional count, in the rail header's own type. The inbox header
 * and the thread header's stamp render THIS; the rail's headers render the same three pieces around
 * their collapse caret (SectionHeader).
 */
export function BandLabel({ band, count, className = "", ...data }: { band: BandKey; count?: number; className?: string; [data: `data-${string}`]: string }) {
  return (
    <span {...data} className={`inline-flex items-center gap-1 ${BAND_LABEL_TYPE} ${className}`}>
      <BandGlyph band={band} />
      <span>{BANDS[band].label}</span>
      {count !== undefined && <BandCount count={count} />}
    </span>
  )
}

/**
 * The band a thread is in RIGHT NOW, named — the stamp on a thread header's second line. On a drawer
 * it is the drawer's half of the rhyme: a thread opened from the Working band says WORKING under its
 * title, beside the rail header with the same bot, and says READY the moment it rests into the inbox
 * behind the drawer. It reads the rail's own two optimistic overlays, in the rail's order, so a reply
 * sent from this drawer moves the stamp in the same frame it moves the row.
 */
export function ThreadBandStamp({ thread }: { thread: ThreadView }) {
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const band = bandOf(optimisticallyArchived(optimisticallySteered(thread, steeredAt[thread.id]), archivingAt[thread.id]))
  if (!band) return null
  return <BandLabel band={band} className="shrink-0" data-thread-band={band} />
}

// Snoozed's icon: "zzz", which lucide does not draw. Lucide's grid and pen (24 viewBox, stroke 2, round
// caps and joins) so it sits beside the lucide icons on the other bands as one family.
function SnoozeMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h8l-8 9h8" />
      <path d="M14 3h7l-7 7h7" />
    </svg>
  )
}
