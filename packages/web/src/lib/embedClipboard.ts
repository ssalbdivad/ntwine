// THE CLIPBOARD IN AN EDITOR FRAME, through the extension. VS Code's Electron session grants the clipboard
// permissions ("clipboard-read", "clipboard-sanitized-write") only to its own `vscode-webview://` and
// workbench URLs (configureSession in its main process, read from VS Code 1.147 and Cursor bundles 2026-11-20), and
// the sidebar's page is a frame at ntwine's origin inside the webview — so `navigator.clipboard` refuses
// both reads and writes there, and every copy button did nothing (David 2026-11-20). The extension reads
// and writes it instead with `env.clipboard` (packages/vscode/src/framed-page.ts actOnPage).

import { EMBED_CLIPBOARD_MAX_TEXT_CHARS, type EmbedClipboardImage, type EmbedClipboardMessage, type EmbedClipboardWrittenMessage } from "@ntwine/shared"
import { embedded, postToHost } from "./embed.ts"

export interface HostClipboard {
  text: string
  image?: EmbedClipboardImage
}

const pendingReads = new Map<string, (clip: HostClipboard) => void>()
const pendingWrites = new Map<string, (ok: boolean | undefined) => void>()

/** The clipboard's text and optional image as the extension reads them; empty if it never answers (an older extension). */
export function hostClipboard(): Promise<HostClipboard> {
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    const done = (clip: HostClipboard) => {
      pendingReads.delete(id)
      resolve(clip)
    }
    pendingReads.set(id, done)
    setTimeout(() => done({ text: "" }), 5000)
    postToHost({ type: "ntwine:read-clipboard", id })
  })
}

export function takeHostClipboard(message: EmbedClipboardMessage): void {
  pendingReads.get(message.id)?.({ text: message.text, ...(message.image ? { image: message.image } : {}) })
}

/**
 * The extension's origin, when this frame's parent is a VS Code webview: the one target a copied text is
 * posted to. Unlike the rest of the page's messages it is the human's own text, and `"*"` would hand it to
 * any page that framed ntwine with the embed flag on.
 */
function webviewParentOrigin(): string | undefined {
  const origin = typeof location !== "undefined" ? location.ancestorOrigins?.[0] : undefined
  return origin?.startsWith("vscode-webview://") ? origin : undefined
}

/**
 * Put `text` on the clipboard through the extension: true once it is there, false when the editor refused
 * it, undefined when this page is not in an editor frame or the extension never answered (one older than
 * `ntwine:write-clipboard`), which leaves the caller to try the page's own ways.
 */
export function hostWriteClipboard(text: string): Promise<boolean | undefined> {
  const origin = embedded() && window.parent !== window ? webviewParentOrigin() : undefined
  if (!origin || text.length > EMBED_CLIPBOARD_MAX_TEXT_CHARS) return Promise.resolve(undefined)
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    const done = (ok: boolean | undefined) => {
      pendingWrites.delete(id)
      resolve(ok)
    }
    pendingWrites.set(id, done)
    // Short: a copy button's check waits on it, and an extension that predates the message never answers.
    setTimeout(() => done(undefined), 1500)
    window.parent.postMessage({ type: "ntwine:write-clipboard", id, text }, origin)
  })
}

export function takeHostClipboardWritten(message: EmbedClipboardWrittenMessage): void {
  pendingWrites.get(message.id)?.(message.ok)
}
