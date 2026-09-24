import { useEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { Loader2 } from "lucide-react"
import { store, pushDrawer } from "../store.ts"

// Minimal toast (no dep): rises in at the BOTTOM RIGHT, holds, then sinks back down and fades.
// Each showToast bumps the id, which re-arms the timer so a repeat message (the same failure twice
// running, say) flashes again. Variants: `spinner` (in-flight feel), `sticky` (no auto-hide — replaced by the
// next toast, e.g. "Starting agent…" → the started confirmation), and `link` (a button that opens
// the named thread in the side drawer).
export function Toaster() {
  const snap = useSnapshot(store)
  const toast = snap.toast
  const [visible, setVisible] = useState(false)
  // A thread drawer's lifecycle footer (Snooze / Mark as done) also anchors bottom-right, one layer
  // BELOW this toast (footer z-20 inside a z-51 drawer; toast z-70). At the resting bottom-4 the toast
  // sat directly on top of those buttons, and a `link` toast — whose pill used to be pointer-events-auto
  // — swallowed every click meant for them for its full (5s) life. So: keep the strip click-through and
  // only let the explicit action button intercept (below), AND lift the whole toast above the footer
  // whenever a drawer is open so it never covers those controls in the first place.
  const drawerOpen = snap.drawers.some((drawer) => !drawer.closing)

  useEffect(() => {
    if (!toast) return
    setVisible(true)
    if (toast.sticky) return
    const t = setTimeout(() => setVisible(false), toast.duration ?? (toast.link ? 5000 : 1600))
    return () => clearTimeout(t)
  }, [toast?.id])

  if (!toast) return null
  return (
    <div className={`pointer-events-none fixed right-4 z-[70] flex justify-end ${drawerOpen ? "bottom-20" : "bottom-4"}`}>
      <div
        data-toast
        role="status"
        aria-live="polite"
        aria-atomic="true"
        // Capped, because a toast is a STRIP and nothing may turn it into a panel. An unbounded one
        // stretched edge to edge across a 1440px viewport and four lines deep the first time a caller
        // passed it a supervisor's raw build log — the text has to wrap inside a strip-sized box
        // instead. `break-words` covers the other half of that failure: a long unbroken token (an
        // absolute path, a URL) would otherwise push straight past the cap.
        className={`flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-2.5 break-words rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[13px] font-medium text-fg shadow-xl shadow-shadow-ink/40 transition-all duration-200 ease-out ${
          visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
      >
        {toast.spinner && <Loader2 size={13} className="animate-spin text-muted" />}
        {toast.text}
        {toast.link && (
          <button
            onClick={() => {
              pushDrawer(toast.link!.drawer ?? "thread", toast.link!.slug)
              store.toast = null
            }}
            className="pointer-events-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-[12px] text-fg/90 transition-colors hover:bg-panel-2"
          >
            {toast.link.label}
          </button>
        )}
      </div>
    </div>
  )
}
