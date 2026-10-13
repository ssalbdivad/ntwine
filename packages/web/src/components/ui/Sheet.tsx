import * as RadixDialog from "@radix-ui/react-dialog"
import { cloneElement, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode, type RefObject } from "react"
import { RemoveScroll } from "react-remove-scroll"
import { useSnapshot } from "valtio"
import { store, markDrawerClosing, removeDrawerAfterExit } from "../../store.ts"
import { registerDrawerClose } from "../../lib/overlays.ts"
import { embedded } from "../../lib/embed.ts"
import { isToastPointer } from "../Toaster.tsx"
import { useBackClosesLayer } from "../../lib/backDismiss.ts"
import { useIsMobile } from "../../lib/mobile.ts"
import {
  SHEET_CLOSE_MS,
  SHEET_PANEL_CLASS,
  SHEET_SCRIM_CLASS,
  prefersReducedMotion,
  sheetWidth,
} from "../../lib/sheet.ts"

// Below 800px a drawer covers (nearly) the whole screen, so it behaves as a MODAL: ThreadSheet renders
// a modal Radix dialog there, and a plain Sheet takes the matching scroll lock (see Sheet below).
//
// ONE LAYER HOLDS THAT LOCK: the topmost live one. react-remove-scroll lets exactly one lock decide — the
// one that MOUNTED last — and it cancels every wheel and touchmove outside that lock's own element. A
// plain sheet stacked over a thread (a `.md` reader, a sub-agent, a shell, the ntwine-doc) is a sibling
// of the thread's Radix dialog, not inside it, so while the thread's lock was the deciding one the
// sheet on top rendered and would not scroll a pixel on a phone. Mount order cannot be trusted to put
// the right lock last: Radix mounts its lock a commit late (its Portal waits for a layout effect), so a
// thread that turns modal in the same commit as the sheet above it — a tablet rotated below 800px with
// a reader open — lands on top. Holding the lock in one layer at a time makes the order irrelevant.
//
// With no live layer left, the last one still sliding out keeps it until it unmounts: otherwise the
// final thread's close dropped the lock at the START of its 210ms exit, while it still covered the
// page. A closing layer above a live one never holds it — the live layer's lock must win.
export function useHoldsScrollLock(id: number): boolean {
  const snap = useSnapshot(store)
  const holder = [...snap.drawers].reverse().find((drawer) => !drawer.closing) ?? snap.drawers.at(-1)
  return holder?.id === id
}

// The topmost layer that is not on its way out.
export function useIsTopDrawer(id: number): boolean {
  const snap = useSnapshot(store)
  return [...snap.drawers].reverse().find((drawer) => !drawer.closing)?.id === id
}

// …and in an editor's sidebar at ANY width (lib/embed.ts): its drawers are the frame's full width
// (styles.css `html[data-embed] .ntwine-sheet-panel`), so they cover the page as a phone's do and must take
// the modal's lock and focus trap with them — a sidebar dragged past 800px otherwise scrolled the list
// under an open thread.
export function useNarrowDrawer(): boolean {
  const [narrow, setNarrow] = useState(() => embedded() || (typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 800px)").matches))
  useEffect(() => {
    if (embedded()) return
    const query = window.matchMedia?.("(max-width: 800px)")
    if (!query) return
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return narrow
}

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
//   • an overlay drawn ABOVE the whole drawer stack (Settings: `data-over-drawers`) owns its scrim as well as
//     its panel — a click on it closes that overlay, never the sheet beneath.
const PORTALED_OVERLAY = "[data-radix-popper-content-wrapper],[role='menu'],[role='listbox'],[role='dialog'],[data-over-drawers]"

function overlayOwnsPointer(target: Element): boolean {
  return document.body.style.pointerEvents === "none" || target.closest(PORTALED_OVERLAY) !== null
}

// Outside-pointer dismissal for a plain sheet, holding to the SAME rules ThreadSheet gets from
// Radix's `onPointerDownOutside` (the long note there is the canonical statement of why each exists):
// a pointer on the toast is the toast's own, only the TOPMOST layer dismisses, a CLOSING layer still
// counts as "above" it, and a pointer that landed on one of this thread's own sub-agent rows is a
// drill-IN the store stacks rather than a dismissal. Capture-phase on window, so it settles before the clicked control's own handler runs —
// which is what lets a queued sidebar row find the drawer already closing and park its scroll landing
// for the unlock rather than fighting it.
function useOutsidePointerDismiss(id: number, panelRef: RefObject<HTMLElement | null>, close: () => void, subagentParent?: string): void {
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (panelRef.current?.contains(target) || overlayOwnsPointer(target) || isToastPointer(target)) return
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
  const narrow = useNarrowDrawer()
  const holdsLock = useHoldsScrollLock(id)
  useOutsidePointerDismiss(id, panelRef, close, subagentParent)
  const focus = useNarrowSheetFocus(panelRef)
  // On the phone this layer takes a history entry of its own, so Back closes it and not the thread
  // under it (lib/backDismiss). The desktop's history is untouched.
  const closing = useSnapshot(store).drawers.find((drawer) => drawer.id === id)?.closing === true
  useBackClosesLayer(useIsMobile(), closing, close)
  // The panel's own scroll lock while it is the top layer on a narrow screen — the lock the thread
  // sheet below hands over (see useHoldsScrollLock). Pinch-zoom stays allowed, as Radix's lock allows it.
  const panel = (
    <RemoveScroll ref={panelRef} enabled={narrow && holdsLock} allowPinchZoom forwardProps>
      <NarrowFocusLayer narrow={narrow} focus={focus}>
        <div
          // The keyboard runtime's handle on the TOP layer: thread commands (`r` to reply, …) press the
          // controls inside whichever layer store.drawers says is on top.
          data-drawer-layer={id}
          className={`${SHEET_PANEL_CLASS} pointer-events-auto outline-none ${shown ? "translate-x-0" : "translate-x-full"}`}
          style={{ width: sheetWidth(widthDepth, widthOffset) }}
        >
          {children(close)}
        </div>
      </NarrowFocusLayer>
    </RemoveScroll>
  )
  return (
    <div
      className={`${SHEET_SCRIM_CLASS} pointer-events-none flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
    >
      {narrow ? (
        // Outside RemoveScroll, which hands its props and ref to its ONE child: the Root takes neither.
        <RadixDialog.Root open modal={false}>
          {panel}
        </RadixDialog.Root>
      ) : panel}
    </div>
  )
}

// FOCUS, on a narrow screen. There a thread is a MODAL Radix dialog (ThreadSheet), whose focus scope traps
// focus inside the thread — and a plain sheet stacked on it (your terminal, a sub-agent, a reader) is a
// sibling outside that scope. So the trap pulled every focus straight back into the thread: the terminal's
// "Run another command" box never took focus on open, a click on the xterm left focus on the thread's ✕, and
// letters typed "into the terminal" fired the thread's single-key shortcuts (`echo hello` raised "Signed out
// of Claude" through `r`). Below 800px in a browser, and at every width in an editor's sidebar (2026-10-01).
//
// The fix is to be on the SAME focus-scope stack: Radix keeps one module-level stack and pauses every scope
// but the newest, so a scope of the sheet's own pauses the thread's trap for exactly as long as the sheet is
// mounted, and resumes it when the sheet goes. That stack belongs to the one copy of
// @radix-ui/react-focus-scope that react-dialog bundles, which this package does not depend on directly — so
// the scope comes from react-dialog itself: a NON-modal Dialog content, `asChild` on the panel. Non-modal,
// because a modal one would also pin `body{pointer-events:none}` and aria-hide the page, which on a phone
// with no thread under the sheet would stop a tap beside it from closing it (useOutsidePointerDismiss). Its
// scope LOOPS Tab at the panel's edges and does not trap, which is enough: the trap it pauses was the only
// thing pulling focus out, and in the sidebar the sheet covers the frame. Every dismissal Radix would add is
// refused — the sheet keeps its own (DrawerStack's Escape, useOutsidePointerDismiss) — and only a narrow
// screen gets it, so the desktop's sheets are exactly what they were (crossing 800px remounts the panel, as
// ThreadSheet's `modal` does).
function NarrowFocusLayer({ narrow, focus, children, ...slotProps }: { narrow: boolean; focus: NarrowSheetFocus; children: ReactElement }) {
  // RemoveScroll's ref and scroll handlers arrive in `slotProps` (forwardProps) and must reach the panel.
  if (!narrow) return cloneElement(children, slotProps)
  return (
    <RadixDialog.Content
      asChild
      {...slotProps}
      aria-describedby={undefined}
      onOpenAutoFocus={focus.onOpenAutoFocus}
      onCloseAutoFocus={focus.onCloseAutoFocus}
      // Escape stays DrawerStack's, which unwinds the top layer (refusing here leaves the key to it), and a
      // field that claims it (the terminal's command box) still stops it first.
      onEscapeKeyDown={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => event.preventDefault()}
      onFocusOutside={(event) => event.preventDefault()}
    >
      {children}
    </RadixDialog.Content>
  )
}

/**
 * The same focus layer for an overlay that is NOT a drawer-stack layer but paints above the whole stack —
 * Settings (SettingsDrawer.tsx), opened over an open thread by ⌘, or an editor's title row. At every width,
 * not only a narrow one: it must be the NEWEST Radix layer, or the thread's dialog below keeps the things
 * Radix gives only the top layer — a narrow thread's focus trap pulled every focus out of Settings back
 * into the thread, and at any width Radix handed Escape to the thread's dialog, which closed the thread
 * and left Settings standing over the queue. `panelRef` is the element that becomes the layer.
 */
export function OverDrawersFocusLayer({ panelRef, children }: { panelRef: RefObject<HTMLElement | null>; children: ReactElement }): ReactElement {
  const focus = useNarrowSheetFocus(panelRef)
  return (
    <RadixDialog.Root open modal={false}>
      <NarrowFocusLayer narrow focus={focus}>
        {children}
      </NarrowFocusLayer>
    </RadixDialog.Root>
  )
}

interface NarrowSheetFocus {
  onOpenAutoFocus: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
}

// Where focus goes as the scope above mounts and unmounts. A sheet's OWN first focus (TerminalSheet's
// command box) is a React `autoFocus`, which runs in the same commit as the panel — BEFORE the scope's
// effect has paused the thread's trap, which therefore pulls it straight back — and inside the commit,
// where React's own event system is switched off, so no `onFocus` on the panel ever sees it. The element
// never even gets its `focusin`: the trap refocuses the thread from the `focusout` that precedes it. So a
// native capture listener notes the last few elements focus was moving TO (the `focusout`'s relatedTarget
// as well as every `focusin`), and the scope's mount hands focus back to the newest one inside this panel.
// A sheet that asked for nothing gets the panel itself, so its keys are its own. On the way out, focus
// returns to the opener only if nothing else claimed it meanwhile (ThreadSheet's rule: a click that
// dismissed the sheet may have put focus somewhere on purpose).
const recentFocus: Element[] = []
let focusRecorderInstalled = false
function installFocusRecorder(): void {
  if (focusRecorderInstalled || typeof document === "undefined") return
  focusRecorderInstalled = true
  const note = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    recentFocus.push(target)
    if (recentFocus.length > 8) recentFocus.shift()
  }
  document.addEventListener("focusout", (event) => note(event.relatedTarget), true)
  document.addEventListener("focusin", (event) => note(event.target), true)
}

function useNarrowSheetFocus(panelRef: RefObject<HTMLElement | null>): NarrowSheetFocus {
  // In render, not an effect: it must be listening before this commit's autoFocus runs.
  installFocusRecorder()
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  return {
    onOpenAutoFocus: (event) => {
      event.preventDefault()
      const panel = panelRef.current
      if (!panel) return
      const asked = [...recentFocus].reverse().find((el) => el !== panel && el.isConnected && panel.contains(el))
      ;(asked instanceof HTMLElement ? asked : panel).focus({ preventScroll: true })
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault()
      const active = document.activeElement
      if (active && active !== document.body) return
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true })
    },
  }
}
