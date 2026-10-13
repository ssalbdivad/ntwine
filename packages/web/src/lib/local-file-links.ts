import type { FilePosition } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { openImageViewer, pushFileReader, showToast } from "../store.ts"
import { copyTextToClipboard } from "./clipboard.ts"
import { codeFilesGoToEditor, codeFilesMayGoToEditor } from "./editorBridge.ts"
import { embedded, postToHost } from "./embed.ts"
import { baseName, runExternalOpen } from "./externalOpen.ts"
import { localViewerFor } from "./localViewer.ts"
import { localPositionOf } from "./localFilePosition.ts"
import type { MarkdownScope } from "./useMarkdown.ts"
import { isMobileViewport } from "./mobile.ts"

// One delegated listener covers every sanitized markdown surface (chat, the doc drawer, and
// drawers). It never follows file:// or an accidental same-origin pathname: only explicit data
// attributes emitted by markdown.ts reach the server's canonical-path allowlist gate.
export function installLocalFileLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
    const path = source?.dataset.localPath
    if (!source || !path) return
    event.preventDefault()
    event.stopPropagation()
    openLocalPath(path, source)
  }
  document.addEventListener("click", handler)
  const failed = imageFailureHandler()
  // `error` does NOT bubble, so the delegated listener has to run in the CAPTURE phase.
  document.addEventListener("error", failed, true)
  return () => {
    document.removeEventListener("click", handler)
    document.removeEventListener("error", failed, true)
  }
}

// A markdown screenshot whose file is gone — a /tmp shot that was cleaned up, a removed worktree,
// a path from another machine. `/local-image` 404s, and Chrome then paints its own broken-image glyph
// beside the alt text, which reads as a rendering fault in Ntwine rather than as a missing file. Swap the
// dead <img> for the plain path, exactly as BlockImage's onError fallback does for the React-rendered
// case — nothing is silently swallowed, and the replacement holds one stable line instead of the
// zero-height-then-glyph box that made the whole message reflow.
//
// One delegated listener for the same reason the click handler is delegated: prose is injected as raw
// sanitized HTML on several surfaces (chat, question cards, fence cards, doc and plan drawers),
// so there is no React element to hang an onError on.
//
// SCOPED TO THOSE SURFACES ON PURPOSE. `data-local-image` is also carried by BlockImage's <img>, which
// React owns and which already has its own onError fallback; swapping that node out from under React
// would corrupt the tree it thinks it is reconciling. `.md-body`/`.md-inline` are set only by our own
// components around sanitized markdown, so they mark exactly the images React does NOT manage.
function imageFailureHandler(): (event: Event) => void {
  return (event) => {
    const img = event.target
    if (!(img instanceof HTMLImageElement) || img.dataset.localImage !== "true") return
    if (!img.closest(".md-body, .md-inline")) return
    const path = img.dataset.localPath ?? img.getAttribute("src") ?? ""
    const missing = document.createElement("span")
    missing.className = "md-image-missing font-mono-keep"
    missing.textContent = path
    // The author's alt text is the only description of what the picture showed; keep it reachable.
    if (img.alt && img.alt !== path) missing.title = img.alt
    // Take the FRAME with it when there is one (markdown.ts frames block images). Replacing only the
    // `<img>` would leave a bordered, matted box standing around a line of muted path text — a frame
    // advertising a picture that isn't there. BlockImage drops its frame on the same failure.
    ;(img.closest(".md-image-frame") ?? img).replaceWith(missing)
  }
}

// Act on a vetted local path, in Ntwine whenever Ntwine can show it (lib/localViewer.ts): a picture opens
// in the picture viewer, stepping through the pictures rendered beside the one clicked; a `.md` file in
// the reader, rendered; any other text file in the reader as source (the split panel beside the thread
// on /full, a drawer everywhere else). Only a format the page cannot draw — a PDF, a spreadsheet, an
// archive — goes to the server, which realpath-gates it and hands it to the opener the
// `localFileOpener` setting names; every in-app viewer carries that same opener as its "Open". The
// decision lives HERE, in the one place every local-path activation passes through, rather than in
// each producer — markdown links, resolved inline-code paths, attachment chips, the Codex file rows,
// the tool-header path links and the saved links all get the same routing from this single branch.
//
// Components that own their own click (PathLink, whose row swallows the event before it can reach the
// delegated listener below) call this directly; everything that only tags itself `data-local-path`
// arrives through the interceptor, which passes the clicked element as `from` so a picture knows which
// pictures it was shown among. `scope` names the project the link belongs to when that is not the
// page's — a card on the everything page, or a reader opened from one — and every read and open then
// goes through that project's gate, whose roots include its own checkout wherever it lives.
//
// `position` is the place in the file the link names (`a.ts:12`, `#L12-L20`). The external app is handed
// it; the reader is handed the bare path. Absent, it is read off `from` (lib/localFilePosition.ts), which is
// how every DELEGATED reader of `data-local-path` — this module's, the everything page's card scope, the
// reader's own scoped links — carries a line without each one knowing the attributes exist.
export function openLocalPath(path: string, from?: Element | null, scope?: MarkdownScope | null, position?: FilePosition): void {
  const at = position ?? localPositionOf(from)
  const viewer = localViewerFor(path)
  if (viewer === "image") {
    openImageViewer(path, from ? imageGalleryFor(from) : [], scope?.projectId)
    return
  }
  // IN AN EDITOR'S SIDEBAR a code file opens in that editor, at the place the link names, whatever the
  // Local file links setting says: the human is sitting in the editor they want it in
  // (embed-protocol.ts `ntwine:open-file`). Not through the server, whose opener would
  // pick a window by its own rules, and not into the reader, which a sidebar has no room beside.
  if (viewer === "text" && embedded()) {
    openInHostEditor(path, at)
    return
  }
  // ON A PHONE the external app is the wrong machine: it launches on the computer Ntwine runs on, which
  // from a phone is somewhere else entirely, and the tap appears to do nothing. So every other file opens
  // in Ntwine's own reader instead, as source when it is not one the reader renders.
  if (isMobileViewport()) {
    pushFileReader(path, scope)
    return
  }
  // With an editor connected, a code file goes there when Local file links names that editor
  // (lib/editorWindows.ts codeFilesDestination), and to the reader otherwise — or when the app cannot
  // start. Settled before anything opens, so one click never shows both. With no editor connected this is
  // the reader, synchronously, as always.
  if (viewer === "text" && codeFilesMayGoToEditor()) {
    void codeFilesGoToEditor().then((toEditor) => {
      if (toEditor) void openExternally(path, scope?.projectId, () => pushFileReader(path, scope), at)
      else pushFileReader(path, scope)
    })
    return
  }
  if (viewer) {
    pushFileReader(path, scope)
    return
  }
  void openExternally(path, scope?.projectId, undefined, at)
}

/** Hand a file to the editor framing this page, at a place in it (lib/embed.ts). */
export function openInHostEditor(path: string, position?: FilePosition): void {
  postToHost({ type: "ntwine:open-file", path, ...(position ? { line: position.line, ...(position.column ? { column: position.column } : {}), ...(position.endLine ? { endLine: position.endLine } : {}) } : {}) })
}

// The surfaces a picture's gallery stays inside: a queue card, a drawer, the /full page's reader slot,
// the /full transcript. ←/→ stepping from one thread's screenshot into the next card's would show a
// picture from a conversation the reader is not in.
const GALLERY_SCOPE = "[data-queue-card], [data-xq-card], [data-drawer-layer], [data-file-viewer-slot], main[data-standalone-thread]"

// The pictures rendered in the same surface as `from`, in reading (document) order, each path once.
// Only what is on the page: a virtualized transcript keeps just the rows near the viewport mounted, and
// a picture inside a collapsed disclosure is not one the reader has seen. The clicked picture is always
// in it, even when collapsed (openImageViewer opens a path missing from its gallery on its own).
export function imageGalleryFor(from: Element): string[] {
  const scope = from.closest(GALLERY_SCOPE) ?? from.ownerDocument.body
  const paths: string[] = []
  for (const img of scope.querySelectorAll<HTMLImageElement>('img[data-local-image="true"][data-local-path]')) {
    const path = img.dataset.localPath
    if (!path || paths.includes(path)) continue
    if (img !== from && img.getClientRects().length === 0) continue
    paths.push(path)
  }
  return paths
}

/** Open a file in the machine's own app for it, skipping the reader and the image viewer — the
 *  lightbox's "Open in default viewer" (components/Lightbox.tsx). */
export function openLocalPathExternally(path: string, project?: string): void {
  void openExternally(path, project)
}

// The cooldown key carries the line: a second link into the same file at ANOTHER line, clicked within
// the cooldown, is a new place to go, not a double-click to swallow (lib/externalOpen.ts).
async function openExternally(path: string, project?: string, fallback?: () => void, position?: FilePosition) {
  await runExternalOpen(
    position ? `file:${path}:${position.line}` : `file:${path}`,
    `Opening ${baseName(path)}…`,
    () => (project ? projectRpc(project) : rpc).openLocalFile({ path, ...position }),
    (result) => settleLocalFileOpen(result),
    (message) => {
      fallback?.()
      return `Could not open local file: ${message}`
    },
  )
}

/** What a finished local-file open leaves behind: the copied path for Copy path; an opened file's
 *  window is its own confirmation. */
export async function settleLocalFileOpen(result: { action: string; path: string }): Promise<void> {
  if (result.action !== "copy") return
  await copyTextToClipboard(result.path)
  showToast("Copied local path")
}
