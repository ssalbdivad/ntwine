import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with the close
// button LEADING (SheetClose), an optional icon, the title (carrying optional inline `meta` — e.g. a
// background shell's "running 3 min" — and/or a stacked `subtitle` line — e.g. a doc drawer's
// "<slug>.md"), and optional trailing `actions` (settings' "● unsaved"). Replaces six near-identical
// hand-rolled headers that had drifted in height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title
// weight, and close-button padding.
export function SheetHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  onClose,
  initialFocus,
  titleMono,
  subtitleKeeps,
}: {
  title: string
  /** A string, or a node for a subtitle that must truncate somewhere other than its end (a path whose
   *  last folder is the part worth keeping — TerminalSheet's). Rendered inside the one truncating line. */
  subtitle?: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
  /** Stamps data-dialog-initial-focus on the close button, for a sheet whose focus manager queries it
   *  (PendingThreadSheet). Omitted — the default — the X takes no initial focus (see SheetClose). */
  initialFocus?: boolean
  /** The title is a COMMAND LINE (a terminal's), set in mono as every surface sets a command: a step
   *  smaller than the sans title (the strip's own 11-in-11.5 ratio), so mono's wider face reads at its size,
   *  and at the regular weight the strip and the rail set a command in — mono at the sans title's
   *  `font-medium` reads visibly bolder (measured on the fullscreen page's rail, 2026-09-29, dsf 3). */
  titleMono?: boolean
  /** The subtitle node declares a part it must KEEP (its min-content — TerminalSubtitle's `…/probe ·
   *  worktree`): under 28rem, where the meta shares its line, the meta gives way before that part does. */
  subtitleKeeps?: boolean
}): ReactElement {
  // THE TEXT BLOCK IS ONE WRAPPING LINE OF THREE PIECES — title, meta, subtitle — so a narrow drawer can move
  // the meta down beside the subtitle rather than squeeze the title to nothing. Wide: title and meta share
  // the first line (the subtitle, `basis-full`, is always the second). The title grows from zero up to its own
  // width (`basis-0 grow max-w-max`), so it never pushes the meta off the line; it truncates first, and the
  // meta keeps up to 70%. Under 28rem (a size container around the header — TerminalSheet's; without one
  // nothing here changes): the title takes the first line alone, and the meta leads the second. At 390px the
  // one-line header drew `read…` beside `waiting for input…` and `Test …` beside `running · 34m left · 2…`
  // (2026-09-30): neither what the drawer is nor a whole reading.
  //
  // THE SECOND LINE, UNDER 28rem, IS ITS OWN ROW that never wraps: the meta and the subtitle in one flex line
  // (a `contents` box wide, so nothing changes there). It was the same wrapping line as the title, the meta
  // `shrink-0` up to 70% and the subtitle sized from zero — so `waiting for input · 4m` took what it wanted
  // and the folder's path shrank to 0px, leaving an orphaned ` · worktree`, cut mid-word (`· workt`) at 390px
  // (2026-09-30). Now the meta keeps its natural width only while the subtitle's kept part fits beside it
  // (`subtitleKeeps`); past that it is the meta that gives way — its age wraps off whole, then its state
  // word ellipsizes (StateReading) — and the subtitle grows into whatever is left.
  //
  // BASELINES, not centres: the meta is a smaller run beside the title, and centring two sizes on one flex
  // line put the agent drawer's reading 1.06px under the title's baseline (sans 13px title) and your
  // terminal's 0.30px over it (mono 12.5px) — one header anatomy seating its reading two ways. `items-baseline`
  // puts every run on the title's baseline in any font, with nothing measured.
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4`}>
      <SheetClose onClose={onClose} initialFocus={initialFocus} />
      {icon}
      <div className="flex min-w-0 flex-1 flex-wrap content-center items-baseline gap-x-2">
        <span
          className={`min-w-0 max-w-max grow basis-0 truncate @max-[28rem]:max-w-full @max-[28rem]:basis-full ${titleMono ? "font-mono-keep text-[12.5px] font-normal" : "text-[13px] font-medium"}`}
          title={title}
        >
          {title}
        </span>
        {(meta || subtitle) && (
          <span data-sheet-second-line className="contents @max-[28rem]:flex @max-[28rem]:min-w-0 @max-[28rem]:basis-full @max-[28rem]:items-baseline @max-[28rem]:gap-x-2">
            {meta && <span data-sheet-meta className="flex min-w-0 max-w-[70%] shrink-0 @max-[28rem]:max-w-none @max-[28rem]:shrink">{meta}</span>}
            {subtitle && (
              <span className={`min-w-0 basis-full truncate text-[10px] text-muted-60 @max-[28rem]:grow @max-[28rem]:basis-0 ${subtitleKeeps ? "@max-[28rem]:min-w-min" : ""}`}>
                {subtitle}
              </span>
            )}
          </span>
        )}
      </div>
      {actions}
    </header>
  )
}

// Every sheet's close: a bare X and a hairline rule, LEADING the header. Every sheet slides out to the
// RIGHT, so the X sits at the edge it leaves from and the right end is left to the sheet's own
// controls; the rule marks the X as the sheet's chrome rather than the first word of the title
// (maintainer 2026-10-08). The thread drawer's header is not a SheetHeader, so it renders this too.
//
// Both headers place it in a `gap-2.5` row whose content starts 16px in (`px-4` here; `px-3` plus the
// title group's `pl-1` there), so one set of margins spaces it in both:
//   · `-ml-1` pulls the X's hover square 4px into that padding, so its INK sits 21.75px from the
//     sheet's edge, where the thread header's trailing check sits 21px from the other.
//   · the rule's `ml-px` / `mr-[9px]` put it 20.75px of ink from the X and 20.3px from the title's
//     first letter, against the 20.75 and 20.17 the action strip keeps either side of its own rule
//     (ThreadLifecycle). `mr-2.5` read 21.3.
// Ink measured 2026-10-08 on the real thread drawer: path rects of the 15px lucide X, the title's
// text range. Re-measure rather than re-guess if the gap, the padding or the glyph changes.
//
// NO EDGE: a hover fills the square and draws no outline, so nothing frames the X but the fill. It also
// takes no initial focus — a programmatically focused button matches :focus-visible, which lit a ring
// around the X whenever a drawer opened from the keyboard or a link — so the sheet itself takes focus
// on open, as MobileThreadHeader's ← does. Tab still reaches the X and draws the focus ring.
export function SheetClose({ onClose, initialFocus }: { onClose: () => void; initialFocus?: boolean }): ReactElement {
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        {...(initialFocus ? { "data-dialog-initial-focus": "" } : {})}
        className="-ml-1 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        <X size={15} />
      </button>
      <span aria-hidden data-close-rule className="ml-px mr-[9px] h-4 w-px shrink-0 bg-border" />
    </>
  )
}
