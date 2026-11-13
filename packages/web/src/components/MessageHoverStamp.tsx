import { useEffect, useState, type RefObject } from "react"
import { messageStampLabel } from "../lib/timeBreaks.ts"

// THE HOVERED MESSAGE'S TIME, in a pill pinned to the top of the transcript viewport (2026-11-12,
// maintainer: "some obvious way that I can see a timestamp associated with a given message — maybe I
// hover it and it appears in sidebar or something").
//
// It lives OUTSIDE the transcript's flow on purpose. A per-message hover stamp drawn beside its message
// shipped once and was dropped (730308e1): the gap between two bubbles is 14px against a 16px reading,
// so it drew over the next message. A sibling of the scroller cannot collide with any row, and the row
// itself lights up (`data-message-at` rows carry a hover tint) so the pill reads as that row's.
//
// One delegated listener on the scroller, not a handler per row: the virtualizer mounts and unmounts
// rows as the reader scrolls, and the row only has to carry its instant in `data-message-at`.
export function MessageHoverStamp({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<string | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const over = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest?.("[data-message-at]")
      setAt(row?.getAttribute("data-message-at") ?? null)
    }
    const leave = () => setAt(null)
    el.addEventListener("mouseover", over)
    el.addEventListener("mouseleave", leave)
    return () => {
      el.removeEventListener("mouseover", over)
      el.removeEventListener("mouseleave", leave)
    }
  }, [scroller])
  const label = at ? messageStampLabel(at) : null
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
      {label ? (
        <time
          data-message-hover-stamp
          dateTime={at!}
          className="rounded-full border border-border bg-elevated px-2.5 py-0.5 text-[11px] leading-4 text-muted shadow-sm shadow-shadow-ink/20 [font-variant-numeric:tabular-nums]"
        >
          <span className="text-fg/80">{label.when}</span>
          <span className="text-muted-60"> · {label.age}</span>
        </time>
      ) : null}
    </div>
  )
}
