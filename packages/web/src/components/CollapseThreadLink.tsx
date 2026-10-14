import type { MouseEvent } from "react"
import { Minimize2 } from "lucide-react"
import { spaNavigate } from "../lib/router.ts"
import { basePath, outerPath } from "../lib/base-path.ts"
import { fullscreenOriginFor } from "../lib/fullscreenHandoff.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { isPlainLeftClick } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

// The href of the way out, shared by the icon below and by Escape (StandaloneThreadPage), so the key
// and the click can never land in two different places.
//
// BACK TO THE SURFACE THE DOOR WAS PRESSED IN, when the door noted one (lib/fullscreenHandoff).
// A thread read through a DRAWER has no surface on the page root, so landing there both stranded
// the reader and left the reverse morph with nothing named to shrink into — it cross-faded at every
// width. `/all/<project>/thread/<slug>` is that drawer's own address, and CrossProjectPage re-mounts
// and names it.
//
// A COLD arrival at /full — a deep link, a bookmark, a reload — noted no door, and gets the same
// drawer: fullscreen is a way of showing ONE thread, so leaving it shows that thread the ordinary
// way, on the page, rather than dropping the reader on a page it was never opened from. The
// launching project's unprefixed /full names no project to open a drawer in, so it goes home.
export function exitFullscreenHref(slug: string): string {
  return fullscreenOriginFor(slug) ?? (basePath() ? outerPath(`/thread/${encodeURIComponent(slug)}`) : "/")
}

// The fullscreen door's transition, played backwards: CrossProjectPage primes the reverse morph's target
// (store.primeFullscreenReturn), so this opts the navigation in the same way the door does. The
// browser Back button gets the same treatment for free — react-router re-arms the transition for
// the POP of a pair that transitioned.
export function exitFullscreen(slug: string): void {
  spaNavigate(exitFullscreenHref(slug), { viewTransition: !prefersReducedMotion() })
}

// THE FULLSCREEN DOOR, CLOSING — the counterpart of the drawer menu's "Open fullscreen" (ThreadMenu.tsx),
// in the /full page's own action strip (HeaderActions `collapse`). It stood in the queue card's expand
// slot while cards had one (maintainer 2026-09-02: "instead of a back arrow in the upper left, I think we
// should just have a collapse icon in the same place where the expand icon is in the cue card"); cards
// lost theirs on 2026-09-28, when /full became an option in the drawer rather than a door on every card.
//
// It replaced an ArrowLeft that sat before the TITLE, at the header's far left — a second, unrelated
// place to look for a whole-thread verb, and a glyph that says "previous page" about a control whose
// job is to change how this thread is being SHOWN.
//
// A real anchor, for the same reasons as the door out: ⌘/middle/right-click and "copy link address"
// need no code, and a plain left click becomes a react-router navigation through lib/router's
// registered navigator. `data-standalone-return` is kept from the arrow — it names the FUNCTION, which
// has not changed.
export function CollapseThreadLink({ slug, label = "Exit fullscreen" }: { slug: string; label?: string }) {
  const href = exitFullscreenHref(slug)
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    exitFullscreen(slug)
  }
  return (
    <Tooltip label={label}>
      <a
        href={href}
        aria-label={label}
        data-standalone-return
        // The strip's shared focus behaviour: a click on any icon here must not take the keyboard
        // away from the composer below it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={HEADER_ICON_CLASS}
      >
        <Minimize2 size={14} />
      </a>
    </Tooltip>
  )
}
