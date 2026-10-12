// Chrome 155 and 156 on macOS drop a paste that starts just after another app wrote the clipboard. The
// page still gets its `paste` event with the text readable; then `beforeinput` arrives with
// `data: null` and nothing is inserted. A dictation tool hits it on nearly every paste, because it
// writes the clipboard and synthesizes Cmd+V about 20ms later: Wispr Flow lost 8 of 9 pastes here on
// 2026-10-10, into a bare `<textarea>` as often as into the composer, which is what ruled out the
// controlled input.
//
// The cause is in Chrome. Since 155, Blink abandons a paste whose clipboard sequence token changes
// while the paste runs (chromium 4f9d868279), and on macOS the browser minted a second token for the
// SAME pasteboard change whenever its asynchronous change notification landed mid-paste
// (crbug.com/568453825). The fix (chromium fc5529f522) first shipped in 157.0.8090.0.
//
// So on those two versions the app inserts pasted plain text itself, from the `paste` event's own
// data, through `insertText`: that keeps the field's native undo stack and fires the `input` event a
// controlled field needs. Every other browser keeps its native paste, and this file can go once
// Chrome 156 is no longer in use.

/** True for the Chromium builds on macOS that drop a paste arriving right after a clipboard write. */
export function dropsQuickPastes(userAgent: string): boolean {
  // Every Chromium browser (Edge, Brave, Arc) reports the engine's major version as `Chrome/155.0.0.0`.
  // Chrome on iOS is WebKit and says `CriOS/`, so it never matches.
  return /Macintosh/.test(userAgent) && /\bChrome\/15[56]\./.test(userAgent)
}

type PasteEventLike = Pick<ClipboardEvent, "defaultPrevented" | "target" | "clipboardData" | "preventDefault">

/**
 * Insert a plain-text paste into the focused text field ourselves. `insertText` reports whether the
 * browser took the text; when it did not (a read-only field), the native paste is left to run.
 */
export function createPasteFallbackHandler(insertText: (text: string) => boolean): (event: PasteEventLike) => void {
  return (event) => {
    // A component that claimed the paste — the composer does, for files — keeps it.
    if (event.defaultPrevented) return
    const tag = (event.target as Element | null)?.tagName
    if (tag !== "TEXTAREA" && tag !== "INPUT") return
    const data = event.clipboardData
    if (!data || data.types.includes("Files")) return
    const text = data.getData("text/plain").replace(/\r\n?/g, "\n")
    if (!text) return
    if (insertText(text)) event.preventDefault()
  }
}

// On `document`, so it runs after React's own listener on the root: by then a component's `onPaste`
// has had its say, and `defaultPrevented` tells the two apart.
export function installPasteFallback(): () => void {
  if (!dropsQuickPastes(navigator.userAgent)) return () => {}
  const handler = createPasteFallbackHandler((text) => document.execCommand("insertText", false, text))
  document.addEventListener("paste", handler)
  return () => document.removeEventListener("paste", handler)
}
