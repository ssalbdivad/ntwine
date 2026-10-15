import * as RadixDialog from "@radix-ui/react-dialog"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { registerDrawerFocus } from "../lib/overlays.ts"
import { useHoldsScrollLock, useIsTopDrawer, useNarrowDrawer, useSheetLayer } from "./ui/Sheet.tsx"
import { SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, sheetWidth } from "../lib/sheet.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { DrawerInitialScrollCoordinator } from "../lib/drawerInitialScroll.ts"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { ThreadView } from "./ChatView.tsx"
import { isToastPointer } from "./Toaster.tsx"
import { useIsMobile } from "../lib/mobile.ts"

// One THREAD layer of the side-drawer stack: a right sheet (same slide/backdrop family as settings)
// showing a thread's FULL view as an OVERLAY — the queue (and any layers below) keep their scroll and
// state; closing just reveals what's underneath. Chat/Terminal is LOCAL to the layer. `depth` insets
// each successive layer a step further from the right edge so the stack reads as a stack.

export function ThreadSheet({ id, slug, depth, widthDepth, initiallyOpen }: { id: number; slug: string; depth: number; widthDepth: number; initiallyOpen?: boolean }) {
  // URL-created sheets exist before the first React paint. They must begin visible (initiallyOpen):
  // waiting for a post-mount animation frame left a full-screen opacity-0 backdrop mounted indefinitely
  // on a cold page, so the first apparent sidebar click actually closed that invisible sheet.
  // useSheetLayer owns the slide-in/close/re-arm/Esc-registration exactly as the plain sheets do.
  const { shown, close, closingRef } = useSheetLayer(id, initiallyOpen === true)
  // INSTANT OPEN: the sheet frame + spinner paint immediately; the heavy body (ChatView — a 100KB+
  // transcript, markdown, diff highlighting) is deferred until AFTER the first paint so click→visible
  // isn't gated on rendering it. The spinner covers the one-frame gap.
  const [bodyReady, setBodyReady] = useState(initiallyOpen === true)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const initialScrollRef = useRef<DrawerInitialScrollCoordinator | null>(null)
  const drawerSnap = useSnapshot(store)
  const isTopDrawer = useIsTopDrawer(id)
  const holdsScrollLock = useHoldsScrollLock(id)
  const narrow = useNarrowDrawer()
  const isMobile = useIsMobile()
  // Sheets are store/route-mounted rather than opened by RadixDialog.Trigger. Preserve the focused
  // row/button (or the control in the layer below) so closing this stack layer restores it exactly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const restoreOpener = useCallback(() => {
    const opener = openerRef.current
    // ONLY when the sheet took focus WITH it. Both restore paths fire ~0ms after the layer unmounts,
    // which is the far end of a ~210ms slide-out — and the click that STARTED that slide-out very often
    // put focus somewhere deliberate on the way past (the sidebar's prompt box is the case that
    // reported it: you click in, you type, and a fifth of a second later the sheet you dismissed yanks
    // the caret back to the row you opened it from). Focus resting on <body> means nothing else claimed
    // it — the sheet really did leave a hole, and restoring the opener fills it. Anything else is the
    // reader's own choice and outranks us.
    const active = document.activeElement
    if (active && active !== document.body) return
    if (opener?.isConnected) opener.focus({ preventScroll: true })
  }, [])
  useEffect(() => () => { window.setTimeout(restoreOpener, 0) }, [restoreOpener])

  // Opening a thread IS reading it: record seen/read telemetry without acknowledging its lifecycle
  // handoff (resting queue cards stay present until follow-up, Snooze, or Archive). Re-fire only when
  // new activity reaches rest while the drawer is open so last_read_at reflects what was actually on
  // screen; mid-turn tailer churn is excluded. Idempotent and fire-and-forget.
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const t = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir
  const atRestNow = t ? t.runtime === "turn-idle" || t.runtime === "exited" || t.runtime === "none" : false
  const activityAt = atRestNow ? t?.lastActivityAt : undefined
  useEffect(() => {
    if (!t || !atRestNow) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [slug, atRestNow, activityAt])

  // THE PHONE LANDS A RESTED THREAD ON ITS LAST MESSAGE, NOT ITS TAIL. The transcript does that itself
  // (VirtualizedThreadTranscript's `openAtLastMessage`, which ChatView sets for exactly this case), so
  // the tail-settling below must stand down or it would haul the reader back to the bottom on every
  // layout change for the first few hundred milliseconds. Decided once, at open, like the landing is.
  const phoneOpensAtMessageRef = useRef<boolean | null>(null)
  if (phoneOpensAtMessageRef.current === null && t) {
    phoneOpensAtMessageRef.current = isMobile && t.runtime !== "running" && t.runtime !== "spawning"
  }

  // Initial tail focus is a one-shot settling phase. The sheet's direct flex child stays viewport-
  // height even while its scrollHeight grows, so observing that child misses async transcript render.
  // Observe the transcript surface itself plus subtree commits, and yield permanently on user intent.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !bodyReady) return
    const content = () => el.querySelector<HTMLElement>("[data-drawer-scroll-ready]")
    const transcriptScroller = () => el.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")
    const coordinator = new DrawerInitialScrollCoordinator({
      isActive: () => [...store.drawers].reverse().find((drawer) => !drawer.closing)?.id === id,
      isContentReady: () => content()?.dataset.drawerScrollReady === "true",
      scrollToBottom: () => {
        const scroller = transcriptScroller()
        if (!scroller) return false
        scroller.scrollTop = scroller.scrollHeight
        return true
      },
      preserveAnchor: () => location.hash.length > 1 || phoneOpensAtMessageRef.current === true,
    })
    initialScrollRef.current = coordinator

    let observedContent: HTMLElement | null = null
    const ro = new ResizeObserver(() => coordinator.layoutChanged())
    const observeContent = () => {
      const next = content()
      if (next !== observedContent) {
        if (observedContent) ro.unobserve(observedContent)
        observedContent = next
        if (next) ro.observe(next)
      }
      coordinator.layoutChanged()
    }
    const mo = new MutationObserver(observeContent)
    mo.observe(el, { attributes: true, attributeFilter: ["data-drawer-scroll-ready"], childList: true, subtree: true })

    const userIntent = () => coordinator.userIntent()
    const keyIntent = (event: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) userIntent()
    }
    el.addEventListener("wheel", userIntent, { capture: true, passive: true })
    el.addEventListener("touchstart", userIntent, { capture: true, passive: true })
    el.addEventListener("pointerdown", userIntent, true)
    el.addEventListener("keydown", keyIntent, true)
    observeContent()

    return () => {
      coordinator.dispose()
      if (initialScrollRef.current === coordinator) initialScrollRef.current = null
      el.removeEventListener("wheel", userIntent, true)
      el.removeEventListener("touchstart", userIntent, true)
      el.removeEventListener("pointerdown", userIntent, true)
      el.removeEventListener("keydown", keyIntent, true)
      ro.disconnect()
      mo.disconnect()
    }
  }, [bodyReady, id])

  useEffect(() => {
    initialScrollRef.current?.activationChanged()
  }, [isTopDrawer])

  // Defer the heavy body (ChatView) one frame past the shell's own slide-in (useSheetLayer flips
  // `shown` on the first frame) so click→visible isn't gated on rendering a 100KB+ transcript. Same
  // 120ms RAF-starvation backstop as the shell: a background/occluded tab can report visibilityState
  // "visible" while starving requestAnimationFrame, and the body must still reveal.
  useEffect(() => {
    if (initiallyOpen) return
    let done = false
    const reveal = () => {
      if (done || closingRef.current) return
      done = true
      setBodyReady(true)
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(reveal)
    })
    const fallback = window.setTimeout(reveal, 120)
    return () => {
      window.clearTimeout(fallback)
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [initiallyOpen])

  // The SHEET takes focus — on open and whenever the stack hands focus back to this layer — never its
  // close button. A programmatically focused button matches :focus-visible, so focusing the X lit a
  // ring around it whenever a drawer opened from the keyboard or a link (see SheetClose).
  useEffect(() => {
    registerDrawerFocus(id, () => scrollerRef.current?.focus({ preventScroll: true }))
    return () => registerDrawerFocus(id, null)
  }, [id])

  // A CLOSING layer lets go of the keyboard and the page. Radix ties a modal dialog's focus trap and its
  // `body{pointer-events:none}` to `open`, and this layer stays mounted for the ~210ms of its slide-out —
  // so with `open` held true the trap outlived the close: New thread pressed right after Back to queue (VS
  // Code's title row over an editor's sidebar, where every drawer is modal) focused the page's prompt box,
  // the departing thread's trap pulled focus straight back to its ✕, the ✕ unmounted with the layer, and
  // focus fell to <body> — the caret lost 3 runs of 3 (scripts/e2e-sidebar.ts c2). `open` follows the
  // store's closing flag instead, and `forceMount` on the Portal keeps the Overlay and the Content mounted
  // through the exit exactly as before; a rapid re-open clears the flag and re-arms the trap.
  const closing = drawerSnap.drawers.find((drawer) => drawer.id === id)?.closing === true
  return (
    <RadixDialog.Root modal={narrow} open={!closing} onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal forceMount>
        {/* The modal Overlay is what carries Radix's scroll lock, so a thread covered by another layer
            renders the same scrim WITHOUT it and lets the layer on top hold the lock (useHoldsScrollLock).
            The Content stays modal either way: toggling `modal` would remount the whole transcript. */}
        {narrow && !holdsScrollLock ? (
          <div className={`${SHEET_SCRIM_CLASS} ${shown ? "opacity-100" : "opacity-0"}`} style={{ zIndex: 50 + depth * 2, pointerEvents: "auto" }} />
        ) : (
          <RadixDialog.Overlay
            className={`${SHEET_SCRIM_CLASS} ${shown ? "opacity-100" : "opacity-0"}`}
            style={{ zIndex: 50 + depth * 2 }}
          />
        )}
        <RadixDialog.Content
          ref={scrollerRef}
          aria-modal={narrow || undefined}
          aria-describedby={undefined}
          tabIndex={-1}
          onEscapeKeyDown={(event) => {
            // An Escape typed INTO a field that claims the key — the composer's climb-out blur, the
            // title editor's cancel — is that field's, never this sheet's dismiss. Radix observes
            // the key at document CAPTURE, ahead of the field's own handler, so the field's
            // stopPropagation arrives too late: refusing the dismiss here is the only way the
            // composer's promise ("must not also pop a drawer") ever held. Measured 2026-09-13:
            // Escape in a drawer's composer blurred it AND closed the drawer.
            if (event.target instanceof Element && event.target.closest("[data-claims-escape]")) {
              event.preventDefault()
              return
            }
            // Plain sheets are invisible to Radix's layer stack. Defer to DrawerStack when one
            // sits above this dialog, including its exit animation, or one Escape closes BOTH.
            // Do not stop propagation here: the top plain sheet still needs this key.
            if (store.drawers.at(-1)?.id !== id) {
              event.preventDefault()
              return
            }
            handleDialogEscape(event)
          }}
          // A non-modal Radix layer also dismisses on any pointer-down OUTSIDE its content. Four cases
          // must not self-dismiss: (0) the pointer landed on the TOAST, whose buttons are its own
          // (isToastPointer — a snooze's Undo closed this drawer); (1) this sheet is BURIED under another
          // drawer layer (a sub-agent/doc sheet stacked over it, or a lateral swap in flight) — only the
          // TOPMOST live layer owns outside-pointer dismissal, otherwise a click inside the child sheet
          // silently closes the parent underneath it; (2) the pointer landed on one of THIS thread's own
          // sub-agent rows (sidebar child rows / queue card lines carry data-subagent-parent) — that click
          // is a drill-IN, and the drawer policy in openOrRaiseDrawer stacks the child over this sheet
          // instead of dismissing it; (3) the pointer landed in a hovercard or other popper this sheet
          // did not open (below). Every other outside pointer (backdrop, blank sidebar, sibling rows)
          // dismisses as before — sibling opens also route through the store policy, which closes this
          // layer anyway.
          onPointerDownOutside={(event) => {
            if (isToastPointer(event.target)) {
              event.preventDefault()
              return
            }
            // (3) the pointer landed in a POPPER that is not this sheet's React descendant — the GitHub
            // hovercard is one global Popover (GithubHovercards.tsx), so Radix cannot tell a click on it from
            // a click on the page, and clicking a PR title in the card over a thread's link closed the
            // thread (sidebar and desktop, 2026-10-01; Radix defers a left click's outside-dismiss to the
            // `click`, so the drawer went as the link went out). ui/Sheet.tsx PORTALED_OVERLAY exempts the
            // same wrapper for the plain sheets. A menu or select opened from inside this sheet is a React
            // descendant, which Radix already counts as inside.
            // (4) The same for an overlay drawn above the whole drawer stack (Settings, `data-over-drawers`):
            // a click in it, or on its scrim, belongs to it — with Settings open over this thread, every
            // click in Settings closed the thread beneath it.
            if (event.target instanceof Element && event.target.closest("[data-radix-popper-content-wrapper],[data-over-drawers]")) {
              event.preventDefault()
              return
            }
            // CLOSING layers still count as "above": Radix dispatches this event AFTER the
            // backdrop's own onMouseDown has already marked the top sheet closing (verified in the
            // real event order), so a live-only check would see this buried sheet as topmost during
            // exactly the backdrop-click unwind it must survive.
            const idx = store.drawers.findIndex((drawer) => drawer.id === id)
            if (idx !== -1 && idx < store.drawers.length - 1) {
              event.preventDefault()
              return
            }
            const target = event.target instanceof Element ? event.target.closest("[data-subagent-parent]") : null
            if (target?.getAttribute("data-subagent-parent") === slug) event.preventDefault()
          }}
          // A non-modal Radix layer dismisses on focus-OUTSIDE by default. That fired the self-close
          // bug: opening a second thread from the sidebar dismisses THIS layer via pointer-down-outside
          // (expected), and ~210ms later its close restores focus to its opener row — a focusin OUTSIDE
          // the newly-opened layer, which Radix read as focus-outside and dismissed the new drawer too,
          // leaving nothing open. Focus movement must never close a drawer (modal layers preventDefault
          // this for the same reason); only the backdrop/outside POINTER and Esc do.
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreOpener()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            scrollerRef.current?.focus({ preventScroll: true })
          }}
          // The keyboard runtime's handle on this layer (see ui/Sheet.tsx) — `d` / `s` / `r` / `f`
          // press the controls inside the top one.
          data-drawer-layer={id}
          // `text-sm text-fg`: the app root's type, which a portal to <body> escapes. Without it every line
          // here that sets no leading of its own inherited body's 13px at 1.5 — a one-line user bubble 1px
          // taller than the same bubble in every non-portaled sheet. It went unseen while a Ready thread opened as an inline card inside the
          // app root; since 2026-09-28 every thread opens here.
          className={`fixed right-0 top-0 overflow-hidden text-sm text-fg outline-none ${SHEET_PANEL_CLASS} ${shown ? "translate-x-0" : "translate-x-full"}`}
          style={{ zIndex: 51 + depth * 2, width: sheetWidth(widthDepth), }}
        >
          <RadixDialog.Title className="sr-only">
            {route.kind === "found" ? `Thread: ${displayTitle(route.thread)}` : `Thread: ${slug}`}
          </RadixDialog.Title>
          {bodyReady && route.kind === "found" ? (
            // Mark-as CONFIRMED (any status) → the drawer closes: the thread just left the state the
            // human was looking at it for (maintainer directive).
            // `virtualized`: the drawer renders the transcript through the windowed renderer instead of
            // mounting all ~300 messages eagerly. Opening a long chat used to build 6k+ DOM nodes and burn
            // a ~300ms long task on the main thread before the sheet was usable.
            <ThreadView slug={slug} onStatusApplied={close} onClose={close} virtualized />
          ) : bodyReady && route.kind === "missing" ? (
            <MissingThread slug={slug} onClose={close} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function MissingThread({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader title="Thread unavailable" onClose={onClose} />
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted" role="status">
        Thread “{slug}” was not found in this project.
      </div>
    </div>
  )
}
