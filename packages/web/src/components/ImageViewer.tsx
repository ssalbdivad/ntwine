import * as RadixDialog from "@radix-ui/react-dialog"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { closeImageViewer, stepImageViewer, store } from "../store.ts"
import { useBackClosesLayer } from "../lib/backDismiss.ts"
import { localFileQuery } from "../lib/localFileQuery.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { pictureTransform, useViewerGestures } from "../lib/viewerGestures.ts"
import { isRasterImagePath } from "../lib/localViewer.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { basename } from "../lib/paths.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { OpenAction } from "./FileReaderDrawer.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// THE PICTURE VIEWER: a click on any picture ntwine renders — a tool's screenshot, a delivered image, a
// path a worker wrote on its own line, a Markdown `![](…)`, an attachment — opens it HERE, over
// whatever page or drawer it was clicked in, instead of handing the file to the desktop opener (which on
// a WSL box meant a browser tab; see lib/localViewer.ts). Esc, the close button or a click anywhere off
// the picture puts it away and leaves everything beneath exactly as it was.
//
//   · FIT FIRST. The picture opens as large as the stage allows without being enlarged past its own
//     size — a 40px crop blown up to the viewport is noise.
//   · THEN IT ZOOMS, exactly as a ```lightbox gallery's viewer does, because it is the same code
//     (lib/viewerGestures.ts, upstream's 0e81902b): a click toggles fit and the picture's actual pixels
//     (one image pixel per CSS pixel, the browser's own image tab, held between 2× and 4× so even a
//     picture that fits at full size visibly zooms) about the cursor; ctrl/⌘ + wheel or a trackpad pinch
//     zooms about the pointer; a plain wheel or a drag moves a magnified picture; + − 0 step it. On a
//     phone a pinch zooms and pans at once, a double tap toggles, one finger pans, and at fit a sideways
//     swipe pages and a vertical one closes. Until 2026-10-06 this viewer had fit / actual size and ←/→
//     only, so the same screenshot zoomed under a finger in a gallery and not when opened on its own.
//   · ←/→ step through the pictures rendered beside it — the same card, drawer or page (the store's
//     `imageViewer.paths`), so a worker's before/after shots compare in place.
//   · "Open" is the way out to the OS's own viewer, as a click on a picture used to be — in an editor's
//     sidebar, to that editor's window, which previews pictures itself (FileReaderDrawer OpenAction). It
//     closes this first: its answer can be a toast (a copied path, an opener that failed), and toasts sit
//     below every modal layer.
//
// OVER the page, not instead of it: the page stays in view under the app's own scrim, the one its
// dialogs and drawers dim with (here at full strength, since the picture is the only thing in focus),
// because a page you can still see is what says a click off the picture goes back to it (maintainer
// 2026-09-28). It was opaque for a day, after a 95% veil ghosted the transcript into blurred shapes
// that read as rendering noise; the scrim keeps the page legible as a page.
//
// A Radix MODAL dialog, which is what keeps it the top of every stack without extra bookkeeping: its
// focus trap, its scroll lock, and its Escape — observed on document capture and stopped there by
// handleDialogEscape, so one press closes this and never also a drawer beneath. The keyboard runtime
// reads an open `aria-modal` dialog as "not the page", so a plain key typed here drives no card.
export function ImageViewer() {
  const snap = useSnapshot(store)
  const viewer = snap.imageViewer
  if (!viewer) return null
  return <OpenViewer paths={viewer.paths} index={viewer.index} project={viewer.project} />
}

function OpenViewer({ paths, index, project }: { paths: readonly string[]; index: number; project?: string }) {
  // On a phone the viewer takes a history entry of its own, so Back closes it and not the thread under it
  // (lib/backDismiss) — what the gallery's viewer does (Lightbox.tsx), and every sheet over a phone thread.
  useBackClosesLayer(useIsMobile(), false, closeImageViewer)
  // How far a vertical swipe toward closing has dimmed the scrim (lib/viewerGestures.ts `fade`). Held
  // here because the scrim outlives each picture's content, which is keyed by its path.
  const [fade, setFade] = useState(1)
  const path = paths[index]!
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) closeImageViewer() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay data-image-viewer-scrim className="overlay-in fixed inset-0 z-[200] bg-scrim backdrop-blur-[1px]" style={{ opacity: fade }} />
        <ViewerContent key={path} path={path} index={index} count={paths.length} project={project} onFade={setFade} />
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

// The stage's inset around the fitted picture, per side.
const STAGE_PAD = 24
// With more than one picture, the sides clear the step buttons (12px in, 36px wide) and a little air, so
// a picture as wide as the stage is never partly under one. Not on a phone, where the width is worth more
// than an unobstructed edge — the buttons sit over it there, as they do in every phone gallery.
const STEP_GUTTER = 64
const GUTTER_MIN_STAGE = 640

type Size = { width: number; height: number }

// The largest size `natural` takes inside `box` at its own aspect ratio, never enlarged past `natural`
// itself: a 40px crop blown up to the viewport is noise, and a 240px diagram blown up six times drew its
// 2px strokes 12px thick.
export function fitSize(natural: Size, box: Size): Size & { scale: number } {
  // Nothing to scale by (a picture that reports no size at all): the stage's own box.
  if (!(natural.width > 0 && natural.height > 0)) return { ...box, scale: 1 }
  const scale = Math.max(0, Math.min(box.width / natural.width, box.height / natural.height, 1))
  return { width: natural.width * scale, height: natural.height * scale, scale }
}

// The size an SVG declares for itself. Chrome answers `naturalWidth` with 300×150 — the default object
// size — for any SVG whose root lacks an absolute width AND height, whatever its viewBox says, so a
// square icon measured 2:1 and a mermaid diagram (`width="100%"`) measured 300 wide. Absolute
// width/height are left to the browser, which already converts `pt` and friends; otherwise the viewBox
// is the drawing's own coordinate size. null when the file declares neither.
//
// DOMParser builds an INERT document: nothing in it runs or fetches.
export function svgDeclaredSize(text: string): Size | "absolute" | null {
  const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement
  if (root.localName !== "svg") return null
  const absolute = (value: string | null) => !!value && /^\s*[\d.]+\s*(?:px|pt|pc|mm|cm|in)?\s*$/i.test(value)
  if (absolute(root.getAttribute("width")) && absolute(root.getAttribute("height"))) return "absolute"
  const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! }
  return null
}

// An SVG as an image the browser draws but never runs: a `data:` URL in an <img>, where scripts,
// external fetches and event handlers are all off — which is why SVG may be shown here at all while the
// `/local-image` proxy refuses to serve one (a navigable same-origin SVG IS a script).
function svgDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
}

function ViewerContent({ path, index, count, project, onFade }: { path: string; index: number; count: number; project?: string; onFade: (fade: number) => void }) {
  const raster = isRasterImagePath(path)
  // A vector reads through the reader's text gate (the /local-image route refuses SVG) and becomes a
  // `data:` image. A read cut at the reader's 1 MiB ceiling is a broken drawing, so it counts as failed.
  // Through the card's project when the picture was on another project's card, as the reader does.
  const svg = useQuery({ ...localFileQuery(path, project), enabled: !raster })
  const svgText = !raster && svg.data && !svg.data.truncated ? svg.data.markdown : null
  const declared = useMemo(() => (svgText === null ? null : svgDeclaredSize(svgText)), [svgText])
  const src = raster ? localImageUrl(path) : svgText !== null ? svgDataUrl(svgText) : null
  const readFailure = raster ? null
    : svg.error ? (svg.error as Error).message
      : svg.data?.truncated ? "this drawing is too large to show"
        : null

  const contentRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [broken, setBroken] = useState(false)
  // The zoom, the pan and the swipe — the gallery viewer's own (lib/viewerGestures.ts). Its limits are
  // measured against the picture's real pixels: for a drawing that declares none, Chrome's 300×150
  // stand-in would set them, so the declared size is passed in.
  const gestures = useViewerGestures({ path, index, count, step: stepImageViewer, close: closeImageViewer, naturalWidth: natural?.width })
  const { view, zoomed, fade } = gestures
  useLayoutEffect(() => onFade(fade), [fade, onFade])
  // The stage, as a ref callback the gestures share: they wire the wheel to it; this measures it. Stable,
  // so React does not detach and re-attach it on every render.
  const stageEl = useRef<HTMLDivElement | null>(null)
  const attachGestures = gestures.attachStage
  const attachStage = useCallback((el: HTMLDivElement | null) => {
    stageEl.current = el
    attachGestures(el)
  }, [attachGestures])

  // The stage, tracked live: the fitted size follows a window resize or a rotated phone.
  useLayoutEffect(() => {
    const el = stageEl.current
    if (!el) return
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const padX = count > 1 && stage && stage.width >= GUTTER_MIN_STAGE ? STEP_GUTTER : STAGE_PAD
  const box = stage ? { width: Math.max(0, stage.width - padX * 2), height: Math.max(0, stage.height - STAGE_PAD * 2) } : null
  const fitted = natural && box ? fitSize(natural, box) : null

  const name = basename(path)
  // Pixels and the scale they are drawn at — the two numbers a screenshot is judged by. A drawing that
  // declares no size of its own has neither: its "natural" size is the browser's 300×150 stand-in.
  const measured = raster || declared !== null
  const readout = measured && natural && fitted ? `${natural.width} × ${natural.height} · ${Math.round(fitted.scale * view.zoom.scale * 100)}%` : null
  const failure = readFailure ?? (broken ? "the file may have moved or been cleaned up" : null)

  return (
    <RadixDialog.Content
      ref={contentRef}
      aria-modal="true"
      aria-describedby={undefined}
      data-image-viewer
      onEscapeKeyDown={handleDialogEscape}
      // Focus the dialog itself, not its first button: the arrows work at once, and no control wears a
      // focus ring the pointer never asked for.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        contentRef.current?.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        // + − 0 zoom (lib/viewerGestures.ts zoomKey); ←/→ step. Either is the viewer's alone: stopped
        // here, so a key that zoomed the picture never also reaches the page under it.
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey
        const step = plain && (event.key === "ArrowLeft" || event.key === "ArrowRight")
        if (step) stepImageViewer(event.key === "ArrowLeft" ? -1 : 1)
        else if (!gestures.zoomKey(event)) return
        event.preventDefault()
        event.stopPropagation()
      }}
      className="overlay-in fixed inset-0 z-[200] flex flex-col outline-none"
    >
      <RadixDialog.Title className="sr-only">{name}</RadixDialog.Title>
      {/* A vertical swipe dims the chrome with the scrim, and leaves the picture it is carrying alone. */}
      <div style={{ opacity: fade }}>
        <SheetHeader
          title={name}
          subtitle={path}
          // The file's name is what a phone's header has room for; its pixels are a desktop's detail. It sits
          // on the name's baseline (SheetHeader aligns its runs by baseline; it centred them until 2026-09-30,
          // when this run needed a measured 0.045em nudge to get there).
          meta={readout ? <span className="shrink-0 text-[11px] tabular-nums text-muted-60 max-sm:hidden">{readout}</span> : undefined}
          actions={
            <>
              {count > 1 && <span data-image-viewer-counter className="shrink-0 text-[12px] tabular-nums text-muted">{index + 1} / {count}</span>}
              {/* -mr-2: the close glyph's hover square carries 9px of dead space, so on the header's even
                  gap "Open" sat 19.06px of ink from the ✕ but 11.21px from the counter. Pulled in, the
                  three read as one evenly spaced cluster (ink gaps 11.21 / 11.06px). */}
              <OpenAction path={path} image={raster} project={project} onOpen={closeImageViewer} className="-mr-2" />
            </>
          }
          onClose={closeImageViewer}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {/* The backdrop: a click on it closes the viewer at fit (and first returns a magnified picture to
            fit). `touch-action: none` hands every touch to the gestures, so a pinch zooms the PICTURE
            rather than the page; `overflow-hidden` clips a magnified picture to the stage. Magnified, the
            whole stage offers the drag — on the STAGE rather than the picture because a drag captures the
            pointer to the stage, and a captured pointer wears its captor's cursor. */}
        <div
          ref={attachStage}
          data-viewer-backdrop
          {...gestures.stage}
          className={`absolute inset-0 flex items-center justify-center overflow-hidden ${zoomed ? (view.panning ? "cursor-grabbing" : "cursor-grab") : ""}`}
          style={{ touchAction: "none" }}
        >
          {failure ? (
            <div className="px-6 text-center text-[13px] text-muted">Couldn’t show this picture: {failure}.</div>
          ) : src ? (
            <img
              ref={gestures.pictureRef}
              src={src}
              alt={name}
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget
                setNatural(declared && declared !== "absolute" ? declared : { width: img.naturalWidth, height: img.naturalHeight })
              }}
              onError={() => setBroken(true)}
              // The fitted box, magnified by one transform. Until it has loaded there is no size to fit, so
              // it waits invisibly rather than flashing at its raw size.
              style={{
                ...(fitted ? { width: fitted.width, height: fitted.height } : { maxWidth: "100%", maxHeight: "100%" }),
                ...pictureTransform(view),
                // Magnified, the ring and the corner are drawn at 1/scale, so the transform paints them at the
                // same 1px and 2px at every magnification instead of a 4px rule at 4× (the gallery viewer's
                // ViewerPicture does the same with its hairline).
                ...(zoomed ? { borderRadius: 2 / view.zoom.scale, boxShadow: `0 0 0 ${1 / view.zoom.scale}px var(--color-border)` } : {}),
              }}
              // The transparency grid is behind EVERY picture, not only SVG: it shows nowhere a picture
              // paints, so a screenshot is untouched, while an icon's black strokes on nothing stay
              // visible over the dimmed page. At fit the cursor offers the zoom; magnified, it inherits the
              // stage's drag.
              className={`ntwine-transparency-grid block select-none rounded-sm shadow-2xl shadow-shadow-ink/40 ring-1 ring-border ${
                natural ? "" : "opacity-0"
              } ${zoomed ? "" : natural ? "cursor-zoom-in" : ""}`}
            />
          ) : null}
        </div>
        {count > 1 && (
          <>
            <StepButton step={-1} disabled={index === 0} />
            <StepButton step={1} disabled={index === count - 1} />
          </>
        )}
      </div>
    </RadixDialog.Content>
  )
}

function StepButton({ step, disabled }: { step: 1 | -1; disabled: boolean }) {
  const Icon = step === -1 ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => stepImageViewer(step)}
      aria-label={step === -1 ? "Previous picture" : "Next picture"}
      className={`absolute top-1/2 ${step === -1 ? "left-3" : "right-3"} flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-panel/85 text-fg/80 shadow-lg shadow-shadow-ink/30 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:pointer-events-none disabled:opacity-0`}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  )
}
