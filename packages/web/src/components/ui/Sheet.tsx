import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode, type RefObject } from "react"
import { useSnapshot } from "valtio"
import { store, markDrawerClosing, removeDrawerAfterExit } from "../../store.ts"
import { registerDrawerClose } from "../../lib/overlays.ts"
import {
  SHEET_CLOSE_MS,
  SHEET_PANEL_CLASS,
  SHEET_SCRIM_CLASS,
  prefersReducedMotion,
  sheetWidth,
} from "../../lib/sheet.ts"

// The shared lifecycle of ONE drawer-stack layer: the slide-in-on-mount `shown` flag, the animated
// `close()` (mark the stack entry closing → slide out → remove after the transition), the Esc-handler
// registration (App unwinds topmost-first), and the rapid re-open re-arm (a second open cancels the
// store's exit; re-show the still-mounted sheet). Every plain right-sheet AND ThreadSheet's Radix
// variant drive their animation from this, so the timing/removal can never drift between them.
//
// `initiallyOpen` (URL/deep-link-created layers) begins visible — no slide-in — so a cold page never
// mounts a full-screen opacity-0 backdrop that swallows the first click. `closingRef` is exposed so a
// consumer deferring a heavy body (ThreadSheet) can skip revealing it once the layer is already exiting.
export function useSheetLayer(
  id: number,
  initiallyOpen = false,
): { shown: boolean; close: () => void; closingRef: MutableRefObject<boolean> } {
  const [shown, setShown] = useState(initiallyOpen)
  const closingRef = useRef(false)
  const snap = useSnapshot(store)

  // Slide-in on the next frame (interaction-opened only). A background/occluded tab can report
  // visibilityState "visible" while starving requestAnimationFrame entirely, so a 120ms timer backstops
  // the RAF — never leave an interaction-opened sheet an invisible, click-swallowing backdrop forever.
  useEffect(() => {
    if (initiallyOpen) return
    let done = false
    const show = () => {
      if (done || closingRef.current) return
      done = true
      setShown(true)
    }
    const raf = requestAnimationFrame(show)
    const fallback = window.setTimeout(show, 120)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(fallback)
    }
  }, [initiallyOpen])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    markDrawerClosing(id) // stop URL/topThreadSlug counting this layer the instant it slides out
    setShown(false)
    window.setTimeout(() => removeDrawerAfterExit(id), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }, [id])

  // Register the animated close for App's Esc handler (topmost-first unwinding).
  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
  }, [id, close])

  // A rapid second open cancels the exit in the store. Re-arm the mounted sheet and leave its old
  // timeout harmless (removeDrawerAfterExit only removes entries that are still closing).
  useEffect(() => {
    if (snap.drawers.find((drawer) => drawer.id === id)?.closing || !closingRef.current) return
    closingRef.current = false
    setShown(true)
  }, [snap.drawers, id])

  return { shown, close, closingRef }
}

// Portaled overlays a sheet's own body opens (a plan's Delete confirm Dialog; the model/effort matrix
// and every ui/Select, both RadixMenu.Portal) are NOT DOM descendants of the panel, so a click in one
// looks exactly like a click outside the sheet — and would slide the sheet away underneath its own
// dialog. Two signals cover them, because neither alone does:
//   • a MODAL Radix layer pins `body{pointer-events:none}` for as long as it is up, which catches its
//     BACKDROP as well as its content (the backdrop carries no role and no popper wrapper);
//   • a non-modal popper (Popover, a hover card) leaves the body alone, so match its wrapper directly.
const PORTALED_OVERLAY = "[data-radix-popper-content-wrapper],[role='menu'],[role='listbox'],[role='dialog']"

function overlayOwnsPointer(target: Element): boolean {
  return document.body.style.pointerEvents === "none" || target.closest(PORTALED_OVERLAY) !== null
}

// Outside-pointer dismissal for a plain sheet, holding to the SAME three rules ThreadSheet gets from
// Radix's `onPointerDownOutside` (the long note there is the canonical statement of why each exists):
// only the TOPMOST layer dismisses, a CLOSING layer still counts as "above" it, and a pointer that
// landed on one of this thread's own sub-agent rows is a drill-IN the store stacks rather than a
// dismissal. Capture-phase on window, so it settles before the clicked control's own handler runs —
// which is what lets a queued sidebar row find the drawer already closing and park its scroll landing
// for the unlock rather than fighting it.
function useOutsidePointerDismiss(id: number, panelRef: RefObject<HTMLElement | null>, close: () => void, subagentParent?: string): void {
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (panelRef.current?.contains(target) || overlayOwnsPointer(target)) return
      const idx = store.drawers.findIndex((drawer) => drawer.id === id)
      if (idx === -1 || idx < store.drawers.length - 1) return
      if (subagentParent && target.closest("[data-subagent-parent]")?.getAttribute("data-subagent-parent") === subagentParent) return
      close()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => window.removeEventListener("pointerdown", onPointerDown, true)
  }, [id, panelRef, close, subagentParent])
}

// A plain right-side sheet layer (thread doc / plan / sub-agent / background-shell). Owns the scrim,
// the sliding panel, and the stack geometry; the body is a render-prop so the caller can wire close()
// into its own header/actions. ThreadSheet does NOT use this — it needs a Radix focus-scope plus
// pointer/focus-outside exemptions the plain sheets don't — but it consumes useSheetLayer + the same
// class constants so nothing (timing, width, scrim) drifts.
//
// The scrim DIMS but does not CATCH: `pointer-events-none`, with dismissal moved to the hook above.
// It used to close on its own `onMouseDown`, which meant the click never reached the page — so with a
// plan/doc/sub-agent sheet open, clicking a queued row in the rail dismissed the sheet and nothing
// else, and clicking the prompt box dismissed the sheet without ever focusing it (maintainer
// 2026-08-11). ThreadSheet has always behaved this way on desktop, where Radix renders no overlay at
// all for a non-modal dialog; this is the plain sheets catching up to it, dim intact.
export function Sheet({
  id,
  depth,
  widthDepth,
  widthOffset = 0,
  subagentParent,
  children,
}: {
  id: number
  depth: number
  widthDepth: number
  widthOffset?: number
  /** This layer's thread slug, for sheets a sub-agent row can legitimately stack OVER (doc / thread). */
  subagentParent?: string
  children: (close: () => void) => ReactNode
}): ReactElement {
  const { shown, close } = useSheetLayer(id)
  const panelRef = useRef<HTMLDivElement>(null)
  useOutsidePointerDismiss(id, panelRef, close, subagentParent)
  return (
    <div
      className={`${SHEET_SCRIM_CLASS} pointer-events-none flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
    >
      <div
        ref={panelRef}
        // The keyboard runtime's handle on the TOP layer: thread commands (`r` to reply, …) press the
        // controls inside whichever layer store.drawers says is on top.
        data-drawer-layer={id}
        className={`${SHEET_PANEL_CLASS} pointer-events-auto ${shown ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: sheetWidth(widthDepth, widthOffset) }}
      >
        {children(close)}
      </div>
    </div>
  )
}
