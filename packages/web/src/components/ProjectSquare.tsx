import { useState, type CSSProperties } from "react"
import { House } from "lucide-react"
import type { ProjectCard } from "@ntwine/shared"
import { useMonogram } from "../lib/monograms.ts"

// A PROJECT'S SQUARE — its icon, its monogram, or Home's house — at any size, wherever a project is
// named by picture: the dock, the project list, the All projects cards, the prompt box's picker.

/**
 * A stable hue per project, from its id.
 *
 * A monogram is what a project with no icon gets, and forty grey squares would defeat the point
 * entirely — colour is doing the identifying. The id is a UUID and never changes, so a project's
 * colour is stable across machines, renames and moves; hashing the NAME would reshuffle the colours
 * whenever someone renamed something.
 */
function monogramHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360
  return hash
}

/** The icon URL for a project, versioned so a replaced icon is a different URL. See ProjectCard. */
export function projectIconSrc(project: ProjectCard): string {
  const version = project.iconVersion ? `&v=${encodeURIComponent(project.iconVersion)}` : ""
  return `/_ntwine/project-icon?id=${encodeURIComponent(project.id)}${version}`
}

/** The square for any card: the Home workspace's house, or a project's icon or monogram. */
export function ProjectSquare({ project, size }: { project: ProjectCard; size: number }) {
  return project.home ? <HomeSquare size={size} /> : <IconSquare key={projectIconSrc(project)} project={project} size={size} />
}

/**
 * The Home workspace's square — a house, on the monogram's own tile with the hue taken out.
 *
 * Home has no folder of its own to find an icon in and no name worth two letters, and it is the one
 * square that is ntwine's rather than the operator's, so it is the one without a colour. The glyph is
 * 60% of the tile where a monogram's letters are 40%: a house's ink is a thin outline in a square box,
 * and at 40% it read as a speck beside the letters. Its stroke is set in PIXELS (`absoluteStrokeWidth`)
 * so the outline holds its weight from a 40px square down to the picker's 12px one.
 */
function HomeSquare({ size }: { size: number }) {
  return (
    <span
      className="relative flex items-center justify-center overflow-hidden rounded-[30%]"
      style={{ width: size, height: size, background: "hsl(0 0% 24%)", color: "hsl(0 0% 80%)" }}
    >
      <House aria-hidden size={Math.round(size * 0.6)} strokeWidth={size >= 24 ? 1.75 : 1.25} absoluteStrokeWidth />
    </span>
  )
}

/**
 * What each icon URL turned out to be, for the life of the page: loaded (and whether it fills its
 * tile), or failed. A square mounted for a URL already known here draws its final state on the FIRST
 * frame instead of starting transparent and fading in on `onLoad`.
 *
 * That start is what stepping the prompt box's project picker (⌥↑/⌥↓, All projects) showed: every step
 * re-keys the prompt box (AllQueues FocusedComposer), so the pill's square is a fresh mount each time,
 * and even with the bytes in the HTTP cache it sat as a bare dark tile for the async decode, the
 * `onLoad` task and a 150ms opacity fade — long enough to read as a black square on every step.
 */
const iconOutcomes = new Map<string, { fills: boolean } | "failed">()

/**
 * Fetch and decode an icon before anything draws it, and remember the outcome. The `Image` is kept on
 * the pending map until it settles, so the decode is not collected away; afterwards Chrome's memory
 * cache holds the decoded bitmap for the URL.
 */
const iconWarming = new Map<string, HTMLImageElement>()
export function warmProjectIcon(project: ProjectCard): void {
  if (project.home || project.iconStatus === "none") return
  const src = projectIconSrc(project)
  if (iconOutcomes.has(src) || iconWarming.has(src)) return
  const img = new Image()
  iconWarming.set(src, img)
  img.src = src
  img.decode().then(
    () => iconOutcomes.set(src, { fills: fillsTile(img) }),
    () => { if (!img.complete || img.naturalWidth === 0) iconOutcomes.set(src, "failed") },
  ).finally(() => iconWarming.delete(src))
}

// A near-square mark fills the tile; a genuinely letterboxed one is contained and padded. Measured:
// a 372x368 screenshot is 1.1% off square and looked WRONG contained — object-contain letterboxed
// it and the 6% padding inset it again, so a full-bleed square read as a stamp with a gap around it.
// A real logo (.github/logo.webp, 300x331) is 9.4% off, so 5% separates the two cleanly.
function fillsTile(img: HTMLImageElement): boolean {
  return img.naturalWidth > 0 && img.naturalHeight > 0 && Math.abs(img.naturalWidth / img.naturalHeight - 1) <= 0.05
}

/**
 * A registered project's square: its icon, or its monogram until we know there isn't one.
 *
 * The `<img>` is laid over the tile and revealed only on load. That ordering is deliberate — a list of
 * forty squares fetches forty icons, and the alternative (drawn as they arrive) is a list that
 * assembles itself in front of you. An icon this page has already loaded skips the reveal
 * (iconOutcomes).
 */
function IconSquare({ project, size }: { project: ProjectCard; size: number }) {
  const src = projectIconSrc(project)
  const known = iconOutcomes.get(src)
  const [loaded, setLoaded] = useState(known !== undefined && known !== "failed")
  const [fills, setFills] = useState(known !== undefined && known !== "failed" && known.fills)
  const hue = monogramHue(project.id)
  const letters = useMonogram(project)
  // Draw the image unless we KNOW there is nothing to draw. Skipping it for a project that has simply
  // never been scanned deadlocks the feature — the image request is what triggers the lazy scan, so
  // no request means no scan means never any icon. `iconVersion` cannot decide this on its own: it is
  // stamped whenever a scan RAN, found or not. See ProjectCard.iconStatus.
  const hasIcon = project.iconStatus !== "none"
  // The URL that failed, not a flag (upstream ba0cdcf2). A flag outlived the failure: once one request
  // 404'd, the square drew no image for the rest of its life, so a later rescan, an upload or a found icon
  // never showed until a reload. A new `iconVersion` is a new URL, and gets its own request.
  const [failedSrc, setFailedSrc] = useState(known === "failed" ? src : undefined)
  const failed = failedSrc === src
  const showMonogram = !hasIcon || failed
  // Already on screen once: no fade, and a synchronous decode so the first frame has the pixels.
  const [instant] = useState(loaded)
  return (
    <span
      className="relative block overflow-hidden rounded-[30%] bg-elevated"
      style={{
        width: size,
        height: size,
        // Low saturation and lightness: these sit against a near-black surface and must read as a
        // surface with a letter on it, not as a colour chip. The letter carries the same hue at full
        // brightness so the pairing stays legible at any hue.
        background: hasIcon && !failed ? undefined : `hsl(${hue} 32% 24%)`,
      }}
    >
      {showMonogram && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center font-semibold leading-none"
          // 0.4em of the square: the same proportion Slack's initials use, and small enough that two
          // letters still clear the rounded corners.
          style={{ fontSize: size * 0.4, color: `hsl(${hue} 55% 78%)` }}
        >
          {/*
            `items-center` centres the LINE BOX, and a line box is half-leading plus a descender the
            monogram never uses — so where the ink lands depends entirely on the font's metrics. THIS
            APP RENDERS IN TWO (html[data-font]), and measured on this tile the same two letters sat
            0.50px BELOW centre in the sans stack and 1.02px ABOVE it in mono: a 1.5px spread, and no
            single constant is right in both.

            `text-box: trim-both cap alphabetic` makes the box the CAP BAND itself — baseline to cap
            height, which for A-Z is exactly the ink — so the browser recomputes it per font and the
            centring is correct in both with nothing to re-measure. Where it is unsupported the line
            box is used as before, which is the ≤1px placement this replaced rather than a broken one.
          */}
          <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>
            {letters}
          </span>
        </span>
      )}
      {hasIcon && !failed && (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        // Not lazy: these are small and usually on screen, and deferring them is
        // half of what the swap looked like.
        loading="eager"
        decoding={instant ? "sync" : "async"}
        onLoad={(event) => {
          const fill = fillsTile(event.currentTarget)
          iconOutcomes.set(src, { fills: fill })
          setFills(fill)
          setLoaded(true)
        }}
        onError={() => {
          iconOutcomes.set(src, "failed")
          setFailedSrc(src)
        }}
        // object-contain, never cover: a logo cropped to fill its square is a mangled logo, and the
        // scan admits some non-square marks (a 300×331 `.github/logo.webp` is a real case). The
        // padding keeps a full-bleed icon off the rounded corners without shrinking a letterboxed one
        // into a stamp.
        className={`relative h-full w-full ${instant ? "" : "transition-opacity"} ${
          fills ? "object-cover" : "object-contain p-[6%]"
        } ${loaded ? "opacity-100" : "opacity-0"}`}
      />
      )}
    </span>
  )
}
