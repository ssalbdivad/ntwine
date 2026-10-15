import { embedded } from "./embed.ts"
// THE TAB'S OWN REST MARK: a COUNT on the page's tab — how many cards its queue holds, in one project's view or
// All projects alike (David 2026-09-30: "more detailed favicon changes e.g. for the number of
// waiting threads instead of just a binary"). The count is what the retired project sidebar's badges
// said per project; with one tab per project, the tab strip is that sidebar. Several tabs are usually
// open at once and a tab strip shows a favicon and a few characters of title, so the favicon is the
// only place a background tab can say "this many are waiting on you" without being opened. The bare
// dot (`true`) marked a thread's fullscreen tab at rest (maintainer 2026-09-19) until that page went on
// 2026-10-15; nothing sets it now.
//
// DRAWN, NOT SHIPPED. The badged icon is the real favicon rasterized onto a canvas with the dot
// composited over it, so there is no second copy of the art to regenerate when the logo changes (the
// index.html `?v=` bump is the whole procedure, and this reads the href that bump produced). An SVG
// that wraps the favicon in an <image> is not an option: an SVG loaded AS an image fetches no
// external resources.

// 64px is 4x a tab's 16 CSS px, so the raster survives a dsf-2 tab strip and the pinned-tab size
// without the browser upscaling it.
const SIZE = 64
// The dot's geometry in that 64px space. At a tab's 16px: a 6px dot inside a 1px clear ring, which is
// what separates it from the tile on ANY tab-strip colour — the ring is punched out to transparency
// rather than painted, because the strip behind it is the browser theme's and cannot be known.
const DOT_RADIUS = 12
const RING = 4
// TOP RIGHT (maintainer 2026-09-19: "I feel like it should be in the top right") — where a notification
// badge sits on every icon the eye already knows. The mark has 180-degree rotational symmetry, so no
// corner covers less ink than another and the choice is convention alone. Inset so the ring's outer
// edge lands exactly on the canvas edge instead of being clipped flat.
const DOT_X = SIZE - DOT_RADIUS - RING
const DOT_Y = DOT_RADIUS + RING
// NOT the accent, though the accent is what says "attention" everywhere else. The mark itself is drawn
// in the accent's gold, so at 16px a gold dot reads as one more loop of the logo; the badge has to
// differ from the art in HUE to register as a badge at all. Compared at tab size on Chrome's four
// stock strip colours (favicon-badge-fixture.html): gold merged into the mark, --color-fg vanished on
// the light strips, red read as an error. This is the palette's azure (--color-shell), borrowed for
// its hue alone — a canvas cannot resolve a CSS variable, and a tab strip has no shell vocabulary.
const DOT_COLOR = "#4a9eff"

// THE COUNT'S PILL, in the same 64px space. It has to carry a digit, so it is bigger than the dot, but it
// must leave the logo readable: 44px tall (11 tab px) covered the whole mark (David 2026-09-30: "the
// number needs to be smaller and/or more top right aligned so it doesnt cover the whole logo"). 34px is
// 8.5 tab px, a bold digit inking ~6px, and the pill sits FLUSH in the corner — its own edge on the
// canvas edge, the clear ring surviving only on the two sides that face the tile, which are the only
// sides it separates anything from. Past MAX_COUNT it reads "9+" in a smaller face.
const PILL_HEIGHT = 34
const PILL_RING = 3
const MAX_COUNT = 9
// Azure is too light for white type (2.9:1), and the dot's own hue is what says "badge" here; this is the
// same azure darkened until white on it clears 4.5:1, so the numeral is the pill's contrast, not its ring.
const PILL_COLOR = "#1f6fd1"
const DIGIT_PX = 30
const digitFont = (px: number) => `700 ${px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`

/** What the tab shows: nothing, the bare rest dot, or a count of waiting cards. */
export type FaviconBadge = boolean | number

type IconLink = { link: HTMLLinkElement; href: string; type: string | null; sizes: string | null }

// The document's own icon links as index.html declared them, captured once — restoring means putting
// these exact attributes back, including the `?v=` cache-buster.
let originals: IconLink[] | undefined
let base: Promise<HTMLImageElement> | undefined
// One raster per label ("dot", "3", "9+"): a count that climbs and falls redraws nothing it has drawn.
const rasters = new Map<string, string>()
// What the caller last asked for. The raster is async, so a rest→working flip (or a count that moved)
// inside that window must not be overwritten by the late-arriving badge.
let wanted: string | undefined

function iconLinks(): IconLink[] {
  // `~=` matches the `icon` TOKEN, so `apple-touch-icon` (a different token) is left alone: it is the
  // home-screen art, not the tab's.
  originals ??= [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((link) => ({
    link,
    href: link.getAttribute("href") ?? "",
    type: link.getAttribute("type"),
    sizes: link.getAttribute("sizes"),
  }))
  return originals
}

/** The label a badge draws, or undefined for none. A count of 0 is no badge, not a "0". */
export function badgeLabel(badge: FaviconBadge): string | undefined {
  if (badge === true) return "dot"
  if (badge === false || !Number.isFinite(badge) || badge < 1) return undefined
  return badge > MAX_COUNT ? `${MAX_COUNT}+` : String(Math.floor(badge))
}

function punch(ctx: CanvasRenderingContext2D, draw: () => void) {
  ctx.globalCompositeOperation = "destination-out"
  ctx.beginPath()
  draw()
  ctx.fill()
  ctx.globalCompositeOperation = "source-over"
}

function pill(ctx: CanvasRenderingContext2D, right: number, top: number, width: number, height: number) {
  ctx.roundRect(right - width, top, width, height, height / 2)
}

/** The favicon with `label` composited over its top-right corner: "dot" for the rest dot, else a count. */
export function drawBadgedIcon(base: CanvasImageSource, label = "dot"): string {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(base, 0, 0, SIZE, SIZE)
  if (label === "dot") {
    punch(ctx, () => ctx.arc(DOT_X, DOT_Y, DOT_RADIUS + RING, 0, Math.PI * 2))
    ctx.fillStyle = DOT_COLOR
    ctx.beginPath()
    ctx.arc(DOT_X, DOT_Y, DOT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    return canvas.toDataURL("image/png")
  }
  // The widest the pill may grow — three quarters of the tile, so "9+" still leaves the mark its left side.
  const maxWidth = SIZE * 0.75
  const sideBearing = 5
  let fontPx = DIGIT_PX
  ctx.font = digitFont(fontPx)
  let ink = ctx.measureText(label)
  // "9+" at the single digit's size is wider than the tile, so a wider label SHRINKS to fit rather than
  // hanging off the left edge; a single digit never needs to.
  const measured = ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight
  if (measured > maxWidth - sideBearing * 2) {
    fontPx = Math.floor(fontPx * (maxWidth - sideBearing * 2) / measured)
    ctx.font = digitFont(fontPx)
    ink = ctx.measureText(label)
  }
  const inkWidth = ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight
  // A single digit gets a circle; more get a pill as wide as its ink plus the side bearing.
  const width = Math.min(maxWidth, Math.max(PILL_HEIGHT, inkWidth + sideBearing * 2))
  const right = SIZE
  const top = 0
  punch(ctx, () => pill(ctx, right + PILL_RING, top - PILL_RING, width + PILL_RING * 2, PILL_HEIGHT + PILL_RING * 2))
  ctx.fillStyle = PILL_COLOR
  ctx.beginPath()
  pill(ctx, right, top, width, PILL_HEIGHT)
  ctx.fill()
  // Centred by INK, not by the em box: a digit has no descender, so the box's centre sits below the
  // numeral's and a box-centred digit rides visibly high in an 11px pill.
  const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent
  const x = right - width / 2 - inkWidth / 2 + ink.actualBoundingBoxLeft
  const y = top + PILL_HEIGHT / 2 + inkHeight / 2 - ink.actualBoundingBoxDescent
  ctx.fillStyle = "#ffffff"
  ctx.fillText(label, x, y)
  return canvas.toDataURL("image/png")
}

function baseIcon(links: readonly IconLink[]): Promise<HTMLImageElement> {
  base ??= new Promise<HTMLImageElement>((resolve, reject) => {
    // The SVG is the sharpest source at any raster size; the PNG fallbacks are 16/32px.
    const source = links.find((l) => l.type === "image/svg+xml") ?? links[0]
    if (!source) return reject(new Error("no favicon link"))
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("favicon did not load"))
    img.src = source.href
  })
  return base
}

/**
 * Show a badge on this tab's favicon — `true` for the rest dot, a number for a count — or clear it with
 * `false` / `0`. Idempotent, and safe to call before the icon has loaded. EVERY icon link is repointed
 * rather than just the preferred one: a browser picks among several `rel="icon"` candidates by its own
 * rules, and leaving the unbadged PNGs declared lets it pick one of those.
 */
export function setFaviconBadge(badge: FaviconBadge): void {
  // In an editor's sidebar there is no tab to wear it (lib/embed.ts): the extension badges its own view.
  if (embedded()) return
  const label = badgeLabel(badge)
  wanted = label
  const links = iconLinks()
  if (label === undefined) {
    for (const { link, href, type, sizes } of links) {
      link.href = href
      if (type === null) link.removeAttribute("type"); else link.type = type
      if (sizes === null) link.removeAttribute("sizes"); else link.setAttribute("sizes", sizes)
    }
    return
  }
  baseIcon(links).then((img) => {
    if (wanted !== label) return
    let url = rasters.get(label)
    if (!url) rasters.set(label, url = drawBadgedIcon(img, label))
    for (const { link } of links) {
      link.type = "image/png"
      link.removeAttribute("sizes")
      link.href = url
    }
  }).catch(() => {
    // No icon to draw on (a bare fixture page, a blocked image): the tab keeps its plain favicon.
    base = undefined
  })
}
