#!/usr/bin/env node
// The shipped mark written three times in a row — cursive "fff" — as ONE stroke
// with a single free end at each side.
//
// The connecting tails are TRIMMED so the glyphs sit close; the full tail is put
// back only on the far left and far right. Trimming equal arc length from both
// ends keeps the glyph C2, so its two ends still leave in the same direction and
// the copies chain by translation alone, with no blending.
//
// Order matters: trim FIRST, then level. Levelling the untrimmed glyph and then
// cutting its tails leaves the two new ends at different heights — 7.3 units
// apart at trim 0.09 — and translating horizontally then puts a visible step at
// every join. Levelling the TRIMMED ends removes it.
//
// The row stays C2 about its own centre: the middle glyph maps to itself under a
// half turn and the outer two swap.
//
//   node build-fff.mjs               default spacing
//   TRIM=0.06 node build-fff.mjs     looser; 0 is tails at full length
//   REPEATS=5 node build-fff.mjs     a longer run

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierSample, catmullPath } from "./fit-two.mjs"
import { render } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const finalDir = join(here, "final")
mkdirSync(finalDir, { recursive: true })

const REPEATS = Number(process.env.REPEATS ?? 3)
// f041, locked in. 0.11 is as close as the glyphs go before the loops interleave
// and the mark reads as a thicket rather than three letters; 0.25 keeps the two
// outer tails as short stubs, which is what makes the row read as a block rather
// than as a line with a flourish at each end. Aspect comes out at 1.02, so it
// sits in a square tile without letterboxing.
const TRIM = Number(process.env.TRIM ?? 0.11)
const TAIL = Number(process.env.TAIL ?? 0.25)
const { stroke, anchors } = JSON.parse(readFileSync(join(finalDir, "anchors.json"), "utf8"))

const dense = bezierSample(anchors, 400)
let L = 0
const cum = [0]
for (let i = 1; i < dense.length; i += 1) {
  L += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1])
  cum.push(L)
}
const idxAt = (len) => {
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (cum[m] < len) lo = m + 1
    else hi = m
  }
  return lo
}

const a = idxAt(L * TRIM)
const b = dense.length - 1 - a

// Level the TRIMMED ends, so the chain runs along a baseline.
const ang = -Math.atan2(dense[b][1] - dense[a][1], dense[b][0] - dense[a][0])
const ca = Math.cos(ang)
const sa = Math.sin(ang)
const spin = ([x, y]) => [256 + (x - 256) * ca - (y - 256) * sa, 256 + (x - 256) * sa + (y - 256) * ca]
const rotated = dense.map(spin)

const core = rotated.slice(a, b + 1)
let head = rotated.slice(0, a + 1)
if (TAIL < 1) head = head.slice(idxAt(cum[a] * (1 - TAIL)))
// The far end is the head's exact 180-degree image about the glyph's centre.
// Building it independently lets a rounded index desymmetrise the row.
const tail = head.map(([x, y]) => [512 - x, 512 - y]).reverse()
const pitch = core[core.length - 1][0] - core[0][0]
const step = Math.abs(core[core.length - 1][1] - core[0][1])
console.log(`trim ${TRIM}: pitch ${pitch.toFixed(1)}, vertical step at each join ${step.toFixed(3)} units`)

const shift = (pts, dx) => pts.map(([x, y]) => [x + dx, y])
let row = [...head]
for (let i = 0; i < REPEATS; i += 1) row = [...row, ...shift(core, pitch * i).slice(1)]
row = [...row, ...shift(tail, pitch * (REPEATS - 1)).slice(1)]

const crossings = selfCrossings(row.filter((_, i) => i % 3 === 0))
console.log(`${REPEATS} glyphs -> ${crossings.length} self-crossings (expect ${2 * REPEATS})`)

const cx = (row[0][0] + row[row.length - 1][0]) / 2
const cy = (row[0][1] + row[row.length - 1][1]) / 2
let c2 = 0
for (let i = 0; i < row.length; i += 1) {
  const p = row[i]
  const q = row[row.length - 1 - i]
  c2 = Math.max(c2, Math.hypot(p[0] - (2 * cx - q[0]), p[1] - (2 * cy - q[1])))
}
console.log(`row C2 error about its own centre: ${c2.toExponential(2)} units`)

const path = catmullPath(row.filter((_, i) => i % 10 === 0))
const xs = row.map((p) => p[0])
const ys = row.map((p) => p[1])
const pad = stroke / 2 + 16
const box = {
  x: Math.min(...xs) - pad,
  y: Math.min(...ys) - pad,
  w: Math.max(...xs) - Math.min(...xs) + pad * 2,
  h: Math.max(...ys) - Math.min(...ys) + pad * 2,
}
const view = `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`
const INK = `<defs><radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="${(box.x + box.w / 2).toFixed(1)}" cy="${(box.y + box.h / 2).toFixed(1)}" r="${(box.w / 2).toFixed(1)}">
      <stop offset="0" stop-color="#ffdf7f"/><stop offset="0.62" stop-color="#eabe2c"/><stop offset="1" stop-color="#cf9412"/>
    </radialGradient></defs>`
const STROKE = `fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"`

writeFileSync(join(finalDir, "fff.svg"), `<svg width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${view}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <path d="${path}" ${STROKE}/>
</svg>
`)
writeFileSync(join(finalDir, "fff-dark.svg"), `<svg width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${view}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" fill="#0d0e10"/>
  <path d="${path}" ${STROKE}/>
</svg>
`)
const side = Math.max(box.w, box.h)
const sx = box.x + box.w / 2 - side / 2
const sy = box.y + box.h / 2 - side / 2
writeFileSync(join(finalDir, "fff-tile.svg"), `<svg width="512" height="512" viewBox="${sx.toFixed(1)} ${sy.toFixed(1)} ${side.toFixed(1)} ${side.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="${(side * 0.226).toFixed(1)}" fill="#0d0e10"/>
  <path d="${path}" ${STROKE}/>
</svg>
`)
// ---------------------------------------------------------------- the icon
//
// The production favicon, in the structure scripts/generate-icons.mjs requires:
// one #icon-background, one #icon-border, one #icon-glow and one untransformed
// #icon-mark. The maskable build scales the mark to 0.78 and asserts it stays
// inside the central 80% safe circle, so the mark's ink radius has to clear
// 204.8/0.78 = 262. A near-square mark's corners sit at half-width x sqrt(2),
// which is what caps the size here rather than the tile's own edges.
const ICON_R = 240
let markR = 0
for (const [x, y] of row) markR = Math.max(markR, Math.hypot(x - (box.x + box.w / 2), y - (box.y + box.h / 2)))
const k = (ICON_R - stroke / 2) / markR
const mcx = box.x + box.w / 2
const mcy = box.y + box.h / 2
const iconRow = row.map(([x, y]) => [256 + (x - mcx) * k, 256 + (y - mcy) * k])
const iconStroke = stroke * k
const iconPath = catmullPath(iconRow.filter((_, i) => i % 10 === 0))
console.log(`icon: ink radius ${(markR * k + iconStroke / 2).toFixed(1)}, stroke ${iconStroke.toFixed(2)} (maskable needs ${((markR * k + iconStroke / 2) * 0.78).toFixed(1)} <= 204.8)`)

const favicon = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="tile">
      <rect x="16" y="16" width="480" height="480" rx="116"/>
    </clipPath>
    <linearGradient id="background" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#191a20"/>
      <stop offset="1" stop-color="#0d0e10"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#e8b923" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#e8b923" stop-opacity="0"/>
    </radialGradient>
    <!-- Radial and centred: a linear gradient reverses under a half turn, which
         would render a rotationally symmetric mark asymmetric. -->
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
      <stop offset="0" stop-color="#ffdf7f"/>
      <stop offset="0.62" stop-color="#eabe2c"/>
      <stop offset="1" stop-color="#cf9412"/>
    </radialGradient>
  </defs>

  <rect id="icon-background" x="16" y="16" width="480" height="480" rx="116" fill="url(#background)"/>
  <rect id="icon-border" x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle id="icon-glow" cx="256" cy="256" r="205" fill="url(#glow)"/>

  <!-- The cursive f written three times as ONE stroke: two free ends, six
       self-crossings, exact 180-degree rotational symmetry about the middle
       glyph. Rebuild with assets/logo-concepts/build-fff.mjs; do not hand-edit
       one side without mirroring the other. -->
  <g id="icon-mark" clip-path="url(#tile)">
    <path d="${iconPath}" fill="none" stroke="url(#ink)" stroke-width="${iconStroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`
writeFileSync(join(finalDir, "fff-favicon.svg"), favicon)

for (const [name, w] of [["fff-dark", 1200], ["fff-tile", 512]]) render(join(finalDir, `${name}.svg`), join(finalDir, `${name}.png`), w)

if (process.argv.includes("--install")) {
  writeFileSync(join(here, "../../packages/web/public/favicon.svg"), favicon)
  console.log("installed -> packages/web/public/favicon.svg")
}
console.log(`wrote final/fff.svg, final/fff-dark.svg, final/fff-tile.svg (${Math.round(box.w)}x${Math.round(box.h)})`)
