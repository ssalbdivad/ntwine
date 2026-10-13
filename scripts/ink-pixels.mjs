// Measure a mark's PAINTED INK from real rendered pixels — the extent the eye actually reads.
//
// The visual-review skill's routine measures ink from GEOMETRY: canvas text metrics for glyphs, the
// union of an SVG's geometry children for icons. That is exact for those, and BLIND to everything a
// mark paints outside its geometry — a `box-shadow` halo, an `outline`, a blur, a glow. Two dots with
// the same 6px box and the same `getBoundingClientRect` read as different-sized marks when one of them
// carries a 1px halo and the other does not, and no DOM measurement will tell you (found 2026-07-30:
// the queue card's quiet shell dot painted 6.0px of ink against the bright dot's 8.0px, which is why
// it read as "so small" while every box measurement said the two were identical).
//
// So this one screenshots each element with a padded clip, decodes it back onto a canvas inside the
// page, and scans the centre row/column for pixels that differ from the surface behind them. Whatever
// is painted, it counts.
//
// Animated marks are frozen before the shot — pass `--phase` to pick where in each element's own cycle
// to sample (default 0 = the start of the keyframes, which for a pulse is its brightest instant). A
// random phase makes two runs incomparable.
//
// Usage:
//   node scripts/ink-pixels.mjs <url> "<css-selector>" [--dsf=4] [--w=760] [--h=800] [--wait=2200]
//     [--phase=0] [--pad=5] [--threshold=8] [--before=@/tmp/routine.js]
//
// Prints one row per matched element: the CSS box, the painted ink in device px and CSS px, and the
// peak channel-sum contrast against the surface (a tone reading — how loud the mark is, as opposed to
// how big). Compare ink to judge SIZE and contrast to judge EMPHASIS; they are different questions.
import { readFileSync } from "node:fs"
import { launchHeadless } from "./lib/headless-browser.mjs"

const args = process.argv.slice(2)
const pos = args.filter((a) => !a.startsWith("--"))
// Split on the FIRST "=" only. A --clip selector ([data-x="y"]) and an inline --before expression both
// carry their own "=", and a naive split("=") silently truncated the value to everything before it —
// so the flag became a no-op and the run produced a confident, wrong screenshot rather than an error.
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const s = a.replace(/^--/, ""); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }))
const [url, selector] = pos
if (!url || !selector) {
  console.error('usage: node scripts/ink-pixels.mjs <url> "<css-selector>" [--dsf=4] [--phase=0] [--before=@file]')
  process.exit(1)
}
const DSF = Number(flags.dsf) || 4
const W = Number(flags.w) || 760
const H = Number(flags.h) || 800
const WAIT = Number(flags.wait) || 2200
const PHASE = flags.phase === undefined ? 0 : Number(flags.phase)
const PAD = Number(flags.pad) || 5
const THRESHOLD = Number(flags.threshold) || 8

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  // A high device scale factor is the resolution of the instrument: at dsf 4 a 1px halo is 4 sample
  // rows, so an 8px mark and a 6px mark are 8 device px apart and cannot be confused for rounding.
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, WAIT))
  if (flags.before) {
    const expr = flags.before.startsWith("@") ? readFileSync(flags.before.slice(1), "utf8") : flags.before
    await page.evaluate(expr)
  }

  const boxes = await page.evaluate((sel, phase) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      for (const a of el.getAnimations()) {
        a.pause()
        a.currentTime = a.effect.getTiming().duration * phase
      }
      const r = el.getBoundingClientRect()
      return { cls: el.className, box: [+r.width.toFixed(2), +r.height.toFixed(2)], x: r.left, y: r.top, w: r.width, h: r.height }
    })
  }, selector, PHASE)
  if (boxes.length === 0) {
    console.error(`no element matched ${selector}`)
    process.exit(1)
  }

  const out = []
  for (const b of boxes) {
    const b64 = await page.screenshot({
      clip: { x: b.x - PAD, y: b.y - PAD, width: b.w + PAD * 2, height: b.h + PAD * 2 },
      encoding: "base64",
    })
    const ink = await page.evaluate(async (data, threshold) => {
      const img = new Image()
      img.src = "data:image/png;base64," + data
      await img.decode()
      const c = document.createElement("canvas")
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
      // The surface behind the mark, read from a corner of the padded clip rather than assumed — the
      // row it sits on may be tinted, hovered, or inside a card with its own background.
      const bg = at(0, 0)
      const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2])
      const span = (n, sample) => {
        const hits = []
        for (let i = 0; i < n; i++) if (dist(sample(i)) > threshold) hits.push(i)
        return hits.length ? hits[hits.length - 1] - hits[0] + 1 : 0
      }
      const cy = Math.round(c.height / 2)
      const cx = Math.round(c.width / 2)
      let peak = 0
      for (let x = 0; x < c.width; x++) peak = Math.max(peak, dist(at(x, cy)))
      return { w: span(c.width, (x) => at(x, cy)), h: span(c.height, (y) => at(cx, y)), peak }
    }, b64, THRESHOLD)
    out.push({
      cls: b.cls,
      boxCssPx: b.box,
      inkDevicePx: [ink.w, ink.h],
      inkCssPx: [+(ink.w / DSF).toFixed(2), +(ink.h / DSF).toFixed(2)],
      peakContrast: ink.peak,
    })
  }
  console.log(JSON.stringify(out, null, 2))
} finally {
  await browser.close()
}
