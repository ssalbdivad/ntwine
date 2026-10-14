import type { EmbedTheme, EmbedThemeColors } from "@ntwine/shared"

// THE EDITOR'S COLOURS, WHERE CSS CANNOT DECIDE — the three tokens whose right value depends on a CONTRAST
// the theme does not promise. theme.css § The editor's colours maps everything else with plain var() and
// color-mix(); these three it reads from `--host-<token>` when the page computed one (lib/theme.ts sets
// them beside the theme's own colours), and falls back to a fixed mix for the instant before:
//
//  - muted (secondary text: ages, counts, hints). A theme's `descriptionForeground` is usually right, but
//    Light Modern — VS Code's default light theme — sets it to its foreground exactly (#3b3b3b both), and
//    the queue's whole hierarchy (a title over its age) went flat. So muted is the description colour
//    held inside a band: no closer to the text than 60% of the text's own contrast (ntwine's palette sits at
//    ~0.4–0.46 of it), and no fainter than WCAG AA's 4.5:1 — or, in a theme whose text itself is barely
//    past that (Solarized Light's #616161 on #eee8d5 is 5.05:1), 80% of the text's contrast.
//  - faint (the dimmest text: separators, a disabled count): 3.2:1 on a dark surface, as ntwine's own
//    #5f646d on #0d0e10 is; the muted colour on a light one, where ntwine's light palette flattens the two.
//  - accent — ntwine's focus colour, which is ALSO text (links, a selection's line count, RECOMMENDED):
//    the theme's `focusBorder`, lifted toward the text until it reads at 4.5:1. Most themes' focus colour
//    is a mid blue drawn as a 1px ring, never as type: Dark Modern's #0078d4 is 3.9:1 on its side bar,
//    Dark+'s 3.6, Solarized Dark's teal 2.8, Solarized Light's 2.3.
//
// Measured on a real VS Code 1.140's ten built-in themes (2026-10-02; the numbers are in the commit).

interface Rgba { r: number; g: number; b: number; a: number }

/** A colour as embed-protocol's EMBED_COLOR_VALUE admits it: hex, or rgb()/rgba() of numbers. */
export function parseColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(value)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    if (full.length !== 6 && full.length !== 8) return null
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^rgba?\(([^)]*)\)$/iu.exec(value)?.[1]
  if (!fn) return null
  const parts = fn.split(/[\s,/]+/u).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const channel = (part: string, scale: number) => (part.endsWith("%") ? (parseFloat(part) / 100) * scale : parseFloat(part))
  const [r, g, b] = parts.slice(0, 3).map((part) => channel(part, 255))
  const a = parts[3] === undefined ? 1 : channel(parts[3], 1)
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null
  return { r: r!, g: g!, b: b!, a: Math.min(1, Math.max(0, a)) }
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a)
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 }
}

const linear = (v: number) => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const gamma = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function luminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

type Lab = [number, number, number]

function toOklab(c: Rgba): Lab {
  const [r, g, b] = [linear(c.r), linear(c.g), linear(c.b)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function fromOklab([L, A, B]: Lab): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(gamma(v))))
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: 1,
  }
}

/** `from` moved toward `to` by `t` (0–1), in oklab — as CSS's `color-mix(in oklab, …)` moves it. */
function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const [a, b] = [toOklab(from), toOklab(to)]
  return fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
}

/**
 * `from` moved toward `to` just far enough that its contrast on `bg` reaches `target` (from either side),
 * or all the way when even `to` does not.
 */
function toContrast(from: Rgba, to: Rgba, bg: Rgba, target: number): Rgba {
  const start = contrast(from, bg)
  const rising = contrast(to, bg) > start
  if (rising ? start >= target : start <= target) return from
  let [lo, hi] = [0, 1]
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const reached = rising ? contrast(mix(from, to, mid), bg) >= target : contrast(mix(from, to, mid), bg) <= target
    if (reached) hi = mid
    else lo = mid
  }
  return mix(from, to, hi)
}

const css = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`

/** The `--host-*` values theme.css reads, or nothing when the colours are not enough to judge by. */
export function derivedTokens(colors: EmbedThemeColors, surface: "sideBar" | "editor", theme: EmbedTheme): { muted: string; faint: string; accent?: string } | null {
  const base: Rgba = theme === "light" ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }
  const raw = (name: keyof EmbedThemeColors) => {
    const value = colors[name]
    return value ? parseColor(value) : null
  }
  const surfaceColor = raw(surface === "editor" ? "editor-background" : "sideBar-background")
  const fgRaw = raw("sideBar-foreground") ?? raw("foreground")
  if (!surfaceColor || !fgRaw) return null
  const bg = over(surfaceColor, base)
  const fg = over(fgRaw, bg)
  const textContrast = contrast(fg, bg)
  const description = over(raw("descriptionForeground") ?? fgRaw, bg)
  const ceiling = Math.max(4.5, 0.6 * textContrast)
  const floor = Math.min(4.5, 0.8 * textContrast)
  let muted = toContrast(description, bg, bg, ceiling)
  muted = toContrast(muted, fg, bg, floor)
  const faint = theme === "light" ? muted : toContrast(muted, bg, bg, Math.min(3.2, contrast(muted, bg)))
  const focus = raw("focusBorder")
  const accent = focus ? toContrast(over(focus, bg), fg, bg, Math.min(4.5, 0.85 * textContrast)) : null
  return { muted: css(muted), faint: css(faint), ...(accent ? { accent: css(accent) } : {}) }
}
