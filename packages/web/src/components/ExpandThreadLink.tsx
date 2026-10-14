import type { MouseEvent } from "react"
import { ExternalLink, Maximize2 } from "lucide-react"
import { embedded } from "../lib/embed.ts"
import { openExternalUrl } from "../lib/external-links.ts"
import { isPlainLeftClick, standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { openFullscreen } from "./ThreadMenu.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE FULLSCREEN DOOR, ⤢ — the one-click way into a thread's /full page, on the queue card's header and in
// the drawer header's action strip. Recovered from 7a20f425, where it was upstream's door on every surface a
// thread appeared on (it replaced the ↗ "Open in new tab" arrow on 2026-08-28: the fullscreen view is the
// ordinary way to focus on a thread, in THIS tab, with the address bar following — and a new tab only on
// the gestures a browser already reserves for that). The fork moved fullscreen into the drawer's ⋯ menu
// on 2026-09-28 and deleted this; it came back on 2026-09-29 because a verb one click deep in a menu is not
// the same as a door you can see, and the menu's duplicate entry went the same day. It
// had the `f` key until 2026-10-14, when the maintainer judged fullscreen too niche to spend one on.
//
// It stands in HeaderActions' fullscreen slot in the drawer — the slot the /full page's ⤡ closing half
// (CollapseThreadLink) occupies, so the icon that takes the reader in and the one that brings them back
// share one position (maintainer 2026-09-02).
//
// A real anchor, so ⌘/middle/right-click and "copy link address" need no code; a plain left click
// navigates in place through the drawer menu's own openFullscreen, so both doors take one path — the view
// transition from the drawer's panel, the reader's place, and the way back out.
//
// IN AN EDITOR'S SIDEBAR IT OPENS THE THREAD IN THE BROWSER (lib/embed.ts). The drawer there is already
// the frame's whole width, so /full in the frame would be the same thread with the list gone from behind
// it — fullscreen in name only. The room the door is for is a browser tab's, so it opens the same /full
// page there (`ntwine:open-external`; a webview cannot open a window), says so in its icon and tooltip. The ↗ is the door's own earlier icon: it was "Open in new tab" until
// 2026-08-28.
export function ExpandThreadLink({
  slug,
  href = standaloneThreadHref(slug),
  size = 14,
  className,
  label = "Open fullscreen",
}: {
  slug: string
  /** The /full address. Defaults to the PAGE project's; a card of another project passes its own. */
  href?: string
  size?: number
  className?: string
  label?: string
}) {
  const browser = embedded()
  const tip = browser ? "Open in browser" : label
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // Never let the click reach the card or row underneath, which would open the drawer as well.
    event.stopPropagation()
    if (browser) {
      event.preventDefault()
      openExternalUrl(new URL(href, location.href).toString())
      return
    }
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    openFullscreen(slug, event.currentTarget, href)
  }
  return (
    <Tooltip label={tip}>
      <a
        href={href}
        aria-label={tip}
        data-expand-thread={slug}
        // Focus must not leave a card's composer, as with every other icon verb in the strip.
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={onClick}
        className={className ?? HEADER_ICON_CLASS}
      >
        {browser ? <ExternalLink size={size} /> : <Maximize2 size={size} />}
      </a>
    </Tooltip>
  )
}
