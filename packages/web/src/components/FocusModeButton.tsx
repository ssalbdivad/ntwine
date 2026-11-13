import { useSnapshot } from "valtio"
import { Maximize2, Minimize2 } from "lucide-react"
import { store } from "../store.ts"
import { embedded } from "../lib/embed.ts"
import { enterFocus, exitFocus } from "../lib/focusMode.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

// Focus mode's door, both directions in one slot (lib/focusMode.ts): ⤢ grows the drawer to fill the
// window, ⤡ shrinks it back. The old fullscreen page's door had the same two glyphs in the same strip.
//
// Not in an editor's sidebar: the drawer there is already the frame's whole width.
export function FocusModeButton({ slug }: { slug: string }) {
  const { focusSlug } = useSnapshot(store)
  if (embedded()) return null
  const focused = focusSlug === slug
  const label = focused ? "Exit focus" : "Focus on this thread"
  const Icon = focused ? Minimize2 : Maximize2
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={focused}
        data-focus-mode-toggle={slug}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (focused ? exitFocus() : enterFocus(slug))}
        className={HEADER_ICON_CLASS}
      >
        <Icon size={14} strokeWidth={2} />
      </button>
    </Tooltip>
  )
}
