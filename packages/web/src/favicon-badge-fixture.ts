// A tab strip cannot be screenshotted, so this page draws what one shows: the plain and the badged
// favicon at a tab's 16px (and the 32px a pinned/dsf-2 surface uses) on the four backgrounds Chrome's
// stock themes put behind a favicon. `setFaviconBadge` is exposed so the e2e test drives the real swap.
import { drawBadgedIcon, setFaviconBadge } from "./lib/faviconBadge.ts"

declare global {
  interface Window { setFaviconBadge: typeof setFaviconBadge; specimenReady?: boolean }
}
window.setFaviconBadge = setFaviconBadge

const STRIPS = [
  ["light, background tab", "#dee1e6", "#202124"],
  ["light, active tab", "#ffffff", "#202124"],
  ["dark, background tab", "#202124", "#e8eaed"],
  ["dark, active tab", "#35363a", "#e8eaed"],
] as const

const root = document.getElementById("root")!
root.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:16px;font:12px system-ui"

const base = new Image()
base.onload = () => {
  // The rest dot, then the counts a queue actually reaches: one digit, the widest digit, and the cap.
  const badges = ["dot", "1", "3", "8", "12"].map((n) => drawBadgedIcon(base, n === "12" ? "9+" : n))
  for (const [label, background, color] of STRIPS) {
    const row = document.createElement("div")
    row.dataset.strip = label
    row.style.cssText = `display:flex;align-items:center;gap:12px;padding:8px 12px;background:${background};color:${color}`
    for (const [src, px] of [16, 32].flatMap((px) => ["/favicon.svg?v=9", ...badges].map((src): [string, number] => [src, px]))) {
      const img = document.createElement("img")
      img.src = src
      img.width = img.height = px
      row.append(img)
    }
    row.append(label)
    root.append(row)
  }
  window.specimenReady = true
}
base.src = "/favicon.svg?v=9"
