import { useEffect } from "react"
import { useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { innerPath, outerPath, projectSlug } from "../lib/base-path.ts"
import { SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, sheetWidth } from "../lib/sheet.ts"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// THE DRAWER'S FRAME, BEFORE THE DRAWER. Opening another project's thread from the queue moves the page to
// that project, and the real drawer (ThreadSheet) can only mount once that project's board has landed —
// seconds on a loaded machine (useOpenThreadInPlace). This draws the same scrim and panel at the same
// width from the click, with the thread's title over its project and a spinner where the transcript will
// be, so the drawer is open the moment it is asked for and fills in as its parts arrive.
//
// The slide-in is a CSS animation, not the state flip the real sheets use: a flip needs a second React
// render, and that render queues behind the rebind's — the very stall this exists to hide. An animation
// starts on the first paint and runs on the compositor however busy the page's thread is.
//
// store.resolveRoutedThread swaps the real drawer in, already open, in the same commit that clears this.
// Esc, the scrim and × abandon the open: before the page has moved, the move is cancelled (the click's
// deferred navigate checks store.pendingOpen); after, the address steps back off the thread so the
// parked slug never opens a drawer nobody wants.
export function PendingThreadSheet() {
  const snap = useSnapshot(store)
  const navigate = useNavigate()
  const pending = snap.pendingOpen
  const drawn = pending !== null && snap.drawers.some((d) => d.kind === "thread" && d.slug === pending.slug && !d.closing)

  function cancel() {
    const open = store.pendingOpen
    if (!open) return
    store.pendingOpen = null
    if (projectSlug() === open.projectSlug && innerPath(location.pathname).startsWith("/thread/")) {
      navigate(outerPath("/"), { replace: true })
    }
  }

  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      cancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (!pending || drawn) return null

  return (
    <>
      <div
        className={`${SHEET_SCRIM_CLASS} animate-[overlay-in_200ms_ease-out] motion-reduce:animate-none`}
        style={{ zIndex: 50 }}
        onMouseDown={cancel}
      />
      <div
        role="dialog"
        aria-label={`Thread: ${pending.title}`}
        data-pending-thread-sheet={pending.slug}
        className={`fixed right-0 top-0 overflow-hidden text-sm text-fg outline-none ${SHEET_PANEL_CLASS} animate-[ntwine-sheet-in_200ms_ease-out] motion-reduce:animate-none`}
        style={{ zIndex: 51, width: sheetWidth(0) }}
      >
        <SheetHeader title={pending.title} subtitle={pending.projectName} onClose={cancel} initialFocus />
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading the thread">
          <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
        </div>
      </div>
    </>
  )
}
