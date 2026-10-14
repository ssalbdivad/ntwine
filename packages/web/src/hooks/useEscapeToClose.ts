import { useLayoutEffect, useRef } from "react"
import { dismissOpenSelect } from "../lib/selectOverlay.ts"

// Escape closes ONE layer, and this hook is how an anchored settings popover claims its turn. The
// popovers it serves open from inside other Escape-sensitive surfaces — the model picker's menu
// (its own window-capture Escape) and the modal it sits in — and Radix's own Escape runs on
// document capture, AFTER the window, so left to the primitives one press would unwind two or three
// layers at once. Claiming the key at window capture
// while this popover is open, and stopping it there, leaves every parent untouched. A Select open
// inside the popover registered itself in the shared registry after this popover opened; it takes the
// press first and the popover stays.
export function useEscapeToClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useLayoutEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (!dismissOpenSelect()) closeRef.current()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [open])
}
