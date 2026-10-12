import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import { SEND_SPLIT_CARET_WIDTH, SEND_SPLIT_LABEL_WIDTH, SEND_SPLIT_SEAM_WIDTH, SEND_SPLIT_WIDTH } from "../lib/iconRhythm.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import type { SendMode } from "../lib/sendMode.ts"

// THE THREAD PROMPT BOX'S SEND (maintainer 2026-10-11). One button for everything the box can send —
// the typed message, the answers staged on the question cards above it, or both as one turn — so it
// always reads "Send": "broad enough to encapsulate the fact that it may also be sending question
// answers". The caret beside it opens the two ways a send can go out while the agent is working; the
// ticked one is what the button and Enter do. The third way, the forced send that interrupts the
// turn, is not a row: it stays on ⌘/Ctrl-Enter and on the ↑ beside a waiting bubble.
//
// IT IS WHITE WHENEVER THERE IS SOMETHING TO SEND, which includes an answer staged on a card with the
// box still empty. The caret stays live when the button is dim: choosing how the next message goes
// does not need a message.
//
// THE SPACING IS MEASURED, not padded to taste. The four gaps the eye reads are ink distances and
// none of them is a padding: the word wears ~0.7px of side bearing and the 13px chevron paints ~7.8px
// of its box. The maintainer chose this set from eight drawn candidates (steer-button-mockup-fixture,
// candidate C), after "it looks like there's more space to the left of 'send' than to the right of
// it" and then, of the correction, "overcompensated". What it paints, read from pixels in sans with
// the button right-anchored and drawn as a 2x screen draws it:
//
//     left edge → S   9.6px      d → hairline   8.0px
//     hairline → chevron   7.1px      chevron → right edge   8.1px
//
// Every box value is on the half-pixel grid, so on a 2x screen the hairline and the chevron land on
// device pixels. The three widths live in lib/iconRhythm.ts, beside the rail that has to clear them;
// the word's left padding and the chevron's are the two below. Re-measure (scripts/ink-gaps.mjs) if
// the font, the type size or the glyph changes.
const LABEL_PAD_LEFT = 9
const CARET_PAD_LEFT = 4.5

const ROWS: readonly { mode: SendMode; name: string; says: string }[] = [
  { mode: "steer", name: "Send as steer", says: "The agent reads it at its next step." },
  { mode: "queue", name: "Send to queue", says: "Frizz holds it until the agent comes to rest." },
]
const ROW_NAME: Record<SendMode, string> = { steer: "Send as steer", queue: "Send to queue" }

export function SendSplitButton({
  armed,
  busy,
  mode,
  running,
  right,
  onMode,
  onSend,
  onMenuClosed,
}: {
  /** There is something to send: typed text, or an answer staged on any card. */
  armed: boolean
  busy?: boolean
  mode: SendMode
  /** A turn is in flight — the only time the two rows differ. */
  running: boolean
  /** The rail offset (lib/iconRhythm composerRail). */
  right: number | undefined
  onMode: (mode: SendMode) => void
  onSend: () => void
  /** The menu closed: put the caret back in the prompt box, where the next keystroke belongs. */
  onMenuClosed?: () => void
}) {
  const tone = armed ? "bg-fg text-bg" : "bg-panel-2 text-muted"
  return (
    <span data-send-split data-send-mode={mode} className="absolute bottom-2 flex h-7" style={{ right, width: SEND_SPLIT_WIDTH }}>
      <button
        type="button"
        data-send
        // Never blur the textarea on the click path (the repo's idiom for every submit affordance that
        // sits beside a live input).
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSend}
        disabled={!armed}
        // The shut button names its way of sending here and in the placeholder, never on its face.
        title={running ? `${ROW_NAME[mode]} (Enter · ⌘⏎ sends now)` : "Send (Enter)"}
        aria-label="Send"
        style={{ width: SEND_SPLIT_LABEL_WIDTH, paddingLeft: LABEL_PAD_LEFT }}
        // Never `transition-all`: it animates box-shadow, which holds the hover edge back (styles.css).
        className={`flex items-center rounded-l-lg text-[12px] font-medium leading-none outline-none transition-[color,background-color,opacity,scale] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${tone} ${armed ? "hover:opacity-90 active:scale-95" : ""}`}
      >
        {/* The word never changes, so nothing beside the button moves when the way of sending does. */}
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <span data-send-label>Send</span>}
      </button>
      {/* The hairline is its own 1px column wearing the button's fill, so the two halves read as one
          surface with a short rule on it rather than as two buttons with a gap between them. */}
      <span aria-hidden className={`flex items-center ${armed ? "bg-fg" : "bg-panel-2"}`} style={{ width: SEND_SPLIT_SEAM_WIDTH }}>
        <span className={`h-3.5 w-px ${armed ? "bg-bg/25" : "bg-fg/15"}`} />
      </span>
      <RadixMenu.Root modal={false}>
        <RadixMenu.Trigger asChild>
          <button
            type="button"
            data-send-menu
            aria-label="Choose how this is sent"
            style={{ width: SEND_SPLIT_CARET_WIDTH, paddingLeft: CARET_PAD_LEFT }}
            className={`flex items-center rounded-r-lg outline-none transition-[color,background-color,opacity] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${tone} ${armed ? "hover:opacity-90" : "hover:text-fg"}`}
          >
            <ChevronDown data-send-caret size={13} strokeWidth={2.5} />
          </button>
        </RadixMenu.Trigger>
        <RadixMenu.Portal>
          <RadixMenu.Content
            data-send-modes
            side="top"
            align="end"
            sideOffset={6}
            onCloseAutoFocus={(e) => {
              if (!onMenuClosed) return
              e.preventDefault()
              onMenuClosed()
            }}
            className={`${OPAQUE_PORTAL_SURFACE_CLASS} w-[304px] rounded-lg p-1`}
          >
            <RadixMenu.RadioGroup value={mode} onValueChange={(next) => onMode(next as SendMode)}>
              {ROWS.map((row) => {
                const on = row.mode === mode
                return (
                  <RadixMenu.RadioItem
                    key={row.mode}
                    value={row.mode}
                    data-send-mode-row={row.mode}
                    className="flex cursor-pointer select-none items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors data-[highlighted]:bg-panel-2"
                  >
                    <span className="flex h-[18px] w-3.5 shrink-0 items-center justify-center text-fg">{on && <Check size={13} strokeWidth={2.5} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-4 leading-[18px]">
                        <span className="text-[12px] font-medium text-fg">{row.name}</span>
                        {/* Enter sends the ticked row. */}
                        {on && <span className="text-[11px] text-muted-70">⏎</span>}
                      </span>
                      <span className="block text-[11.5px] leading-[16px] text-muted">{row.says}</span>
                    </span>
                  </RadixMenu.RadioItem>
                )
              })}
            </RadixMenu.RadioGroup>
            {!running && <div className="px-2 pb-1 pt-1.5 text-[11px] leading-[15px] text-muted-70">The agent is at rest, so both send now.</div>}
          </RadixMenu.Content>
        </RadixMenu.Portal>
      </RadixMenu.Root>
    </span>
  )
}
