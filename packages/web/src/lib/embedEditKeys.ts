// THE EDITING KEYS IN A MAC EDITOR'S SIDEBAR — ⌘A, ⌘C, ⌘X, ⌘V, ⌘Z and ⌘⇧Z, done by the page itself.
//
// On macOS those chords are the editor's menu accelerators, and VS Code runs them on a webview by
// executing the command in the webview's OWN document. The sidebar's page is a cross-origin iframe inside
// that document, so the command lands on the frame's wrapper and nothing happens in the text box the
// human is typing in (David, 2026-11-12: "all the ctrl+a, ctrl+c etc. shortcuts dont work in there").
// The keydown still reaches the page first, so the page does each one on its focused text field and
// prevents the default, which keeps the accelerator from running too. ⌘C also copies text selected
// anywhere else on the page (a message, a code block), for the same reason. Copies go through the
// extension (lib/embedClipboard.ts): the editor refuses this frame `navigator.clipboard`.
//
// Mac only: elsewhere these are Ctrl chords Chromium handles in the focused frame, and taking paste over
// there would only lose what a native paste carries. Installed only in embed mode (lib/embedHost.ts).

import type { EmbedClipboardImage } from "@ntwine/shared"
import { copyTextToClipboard } from "./clipboard.ts"
import { hostClipboard } from "./embedClipboard.ts"

type TextField =HTMLInputElement | HTMLTextAreaElement

function focusedTextField(): TextField | HTMLElement | null {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement && /^(text|search|url|email|tel|password|)$/u.test(el.type)) return el
  if (el instanceof HTMLElement && el.isContentEditable) return el
  return null
}

function selectedText(field: TextField | HTMLElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
  }
  return document.getSelection()?.toString() ?? ""
}

/** Decode a host-supplied clipboard image into a `File` the composer's `onPaste` can upload. */
export function clipboardImageToFile(image: EmbedClipboardImage): File | null {
  try {
    const binary = atob(image.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const sub = image.mime.slice("image/".length)
    const ext = sub === "jpeg" ? "jpg" : sub
    return new File([bytes], image.name || `pasted.${ext}`, { type: image.mime })
  } catch {
    return null
  }
}

/**
 * Paste the way a native paste would: a `paste` event carrying the clipboard's text AND files, so the
 * composer's own `onPaste` still turns a pasted image into an attachment; only when nothing took it is the
 * text inserted, with `insertText` so it joins the field's undo history and React hears the input.
 */
async function paste(field: TextField | HTMLElement): Promise<void> {
  const data = new DataTransfer()
  try {
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        const blob = await item.getType(type)
        if (type === "text/plain") data.setData("text/plain", await blob.text())
        else if (type.startsWith("image/")) data.items.add(new File([blob], `pasted.${type.slice(6)}`, { type }))
      }
    }
  } catch {
    // The webview refuses the read (David, 2026-11-12: ⌘V did nothing), so the extension reads it.
    const clip = await hostClipboard()
    if (clip.text) data.setData("text/plain", clip.text)
    if (clip.image) {
      const file = clipboardImageToFile(clip.image)
      if (file) data.items.add(file)
    }
  }
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
  if (!field.dispatchEvent(event)) return
  const text = data.getData("text/plain")
  if (text) document.execCommand("insertText", false, text)
}

/** Text selected on the page outside any text field — a message, a code block — or "". */
function pageSelection(): string {
  const selection = document.getSelection()
  return selection && !selection.isCollapsed ? selection.toString() : ""
}

/** Does the page's own edit for a ⌘ editing chord on a focused text field; true when it took the key. */
function handle(event: KeyboardEvent): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing) return false
  const field = focusedTextField()
  if (!field) {
    // ⌘C on text selected in the transcript: VS Code's copy would run on its own document, not this frame.
    if (event.shiftKey || event.key.toLowerCase() !== "c") return false
    const text = pageSelection()
    if (!text) return false
    void copyTextToClipboard(text).catch(() => {})
    return true
  }
  const key = event.key.toLowerCase()
  if (event.shiftKey) {
    if (key !== "z") return false
    document.execCommand("redo")
    return true
  }
  switch (key) {
    case "a":
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select()
      else document.execCommand("selectAll")
      return true
    case "c":
    case "x": {
      const text = selectedText(field)
      if (!text) return true
      void copyTextToClipboard(text).catch(() => {})
      // Deleted in the keydown itself: done once the write resolved, the cut copied and left the text.
      if (key === "x") document.execCommand("delete")
      return true
    }
    case "v":
      void paste(field)
      return true
    case "z":
      document.execCommand("undo")
      return true
  }
  return false
}

export function installEmbedEditKeys(): void {
  if (!/Mac/u.test(navigator.platform)) return
  // Bubble phase on the window: after every element's own handler, so a box that already does something
  // with one of these (and prevents it) keeps doing it.
  window.addEventListener("keydown", (event) => {
    if (handle(event)) event.preventDefault()
  })
}
