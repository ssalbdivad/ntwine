#!/usr/bin/env node
// Turn the chosen variant into the production icon.
//
// Only HALF the stroke is curve-fitted. The other half is that half's anchors
// rotated 180 degrees, reversed, with the handles swapped — so the symmetry is
// carried by the path data itself and cannot drift. Fitting all the anchors
// independently would leave a mark that measures symmetric to a few tenths of a
// unit instead of to floating-point noise, and would drift further with every
// later edit.
//
// Composing the rotation with the reversal leaves each anchor's tangent ANGLE
// unchanged (rotation negates it, reversal negates it back) and swaps its
// incoming and outgoing handles. The centre anchor is shared by both halves, so
// the join there is a single anchor with a single tangent and cannot kink.
//
//   node finalize.mjs                 write assets/logo-concepts/final/
//   node finalize.mjs --install       also replace packages/web/public/favicon.svg

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierPath, bezierSample, catmullSample } from "./fit-two.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const finalDir = join(here, "final")
mkdirSync(finalDir, { recursive: true })

const CHOSEN = process.env.VARIANT ?? "r144"
const N = 256
const C = 128
const rad = (d) => (d * Math.PI) / 180

// ------------------------------------------------- rebuild the chosen half

function baseHalves() {
  const c = JSON.parse(readFileSync(join(here, "fit/curve-best.json"), "utf8"))
  const dense = bezierSample(c.anchors, 200)
  const xs = selfCrossings(dense)
  const M = [(xs[0][0] + xs[1][0]) / 2, (xs[0][1] + xs[1][1]) / 2]
  let bi = -1
  let bd = Infinity
  for (let i = Math.floor(dense.length * 0.25); i < Math.floor(dense.length * 0.75); i += 1) {
    const d = Math.hypot(dense[i][0] - M[0], dense[i][1] - M[1])
    if (d < bd) {
      bd = d
      bi = i
    }
  }
  const at = dense[bi]
  const shift = (seg) => seg.map(([x, y]) => [x - at[0] + C, y - at[1] + C])
  return { lower: shift(dense.slice(bi)), upper: shift(dense.slice(0, bi + 1).reverse()) }
}

function deform(half, { grow, twist, ease, aniso, shear }) {
  let len = 0
  const cum = [0]
  for (let i = 1; i < half.length; i += 1) {
    len += Math.hypot(half[i][0] - half[i - 1][0], half[i][1] - half[i - 1][1])
    cum.push(len)
  }
  return half.map(([x, y], i) => {
    const t = Math.pow(cum[i] / len, ease)
    const s = 1 + (grow - 1) * t
    const a = rad(twist) * t
    let dx = (x - C) * s
    let dy = (y - C) * s
    const rx = dx * Math.cos(a) - dy * Math.sin(a)
    const ry = dx * Math.sin(a) + dy * Math.cos(a)
    dx = rx * aniso
    dy = ry / aniso
    return [C + dx + shear * -dy, C + dy]
  })
}

/**
 * half anchors -> the whole symmetric path.
 *
 * The centre anchor's two handles must be EQUAL. The incoming segment there is
 * the rotation of the outgoing one, so it is built from the centre's `out`
 * length; if `in` differs, the join stops being symmetric. Letting the optimiser
 * move them independently cost 2.28 units of asymmetry — small enough to look
 * fine and far too large to be exact.
 */
function completeAnchors(half) {
  half = half.map((a, i) => (i === 0 ? { ...a, in: a.out } : a))
  const rotated = []
  for (let i = half.length - 1; i >= 1; i -= 1) {
    const a = half[i]
    rotated.push({ x: 2 * C - a.x, y: 2 * C - a.y, th: a.th, in: a.out, out: a.in })
  }
  return [...rotated, ...half]
}

function chamfer(a, b) {
  let sum = 0
  for (const [ax, ay] of a) {
    let best = Infinity
    for (const [bx, by] of b) {
      const d = (ax - bx) ** 2 + (ay - by) ** 2
      if (d < best) best = d
    }
    sum += Math.sqrt(best)
  }
  return sum / a.length
}

function c2Error(pts) {
  let worst = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[pts.length - 1 - i]
    worst = Math.max(worst, Math.hypot(a[0] - (2 * C - b[0]), a[1] - (2 * C - b[1])))
  }
  return worst
}

const variants = JSON.parse(readFileSync(join(here, "out-two-refined/variants.json"), "utf8"))
const p = variants.find((v) => v.id === CHOSEN)
if (!p) throw new Error(`${CHOSEN} not found`)
console.log(`${CHOSEN}: ${JSON.stringify({ base: p.base, grow: p.grow, twist: p.twist, ease: p.ease, aniso: p.aniso, shear: p.shear, stroke: p.stroke })}`)

const target = deform(baseHalves()[p.base], p)

// Fit the half to a short chain of G1 cubics.
const K = Number(process.env.ANCHORS ?? 8)
let anchors = []
for (let i = 0; i < K; i += 1) {
  const idx = Math.round((i * (target.length - 1)) / (K - 1))
  const a = target[Math.max(0, idx - 8)]
  const b = target[Math.min(target.length - 1, idx + 8)]
  anchors.push({ x: target[idx][0], y: target[idx][1], th: Math.atan2(b[1] - a[1], b[0] - a[0]), in: 10, out: 10 })
}
const loss = (h) => {
  const full = completeAnchors(h)
  const pts = bezierSample(full, 40)
  if (selfCrossings(pts).length !== 2) return 1e6
  return chamfer(bezierSample(h, 14), target)
}
let bestLoss = loss(anchors)
const FIELDS = [["x", 1], ["y", 1], ["th", 0.05], ["in", 1.5], ["out", 1.5]]
for (let step = 4; step >= 0.05; step *= 0.65) {
  for (let pass = 0; pass < 10; pass += 1) {
    let improved = false
    // The centre anchor's POSITION is pinned: it is the centre of symmetry, and
    // letting it wander would move the whole mark off the tile's middle.
    for (let i = 0; i < anchors.length; i += 1) {
      for (const [field, unit] of FIELDS) {
        if (i === 0 && (field === "x" || field === "y" || field === "in")) continue
        for (const sign of [1, -1]) {
          const trial = anchors.map((a) => ({ ...a }))
          trial[i][field] += sign * step * unit
          if (trial[i].in < 1 || trial[i].out < 1) continue
          const l = loss(trial)
          if (l < bestLoss - 1e-6) {
            anchors = trial
            bestLoss = l
            improved = true
          }
        }
      }
    }
    if (!improved) break
  }
}

const full = completeAnchors(anchors)
const dense = bezierSample(full, 200)
const crossings = selfCrossings(dense)
console.log(`half fitted with ${K} anchors, chamfer ${bestLoss.toFixed(3)}px`)
console.log(`full path: ${full.length - 1} cubic segments, ${crossings.length} crossings, C2 error ${c2Error(dense).toExponential(2)} units`)

// ------------------------------------------------ scale into the 512 icon grid

const STROKE_256 = p.stroke
let maxR = 0
for (const [x, y] of dense) maxR = Math.max(maxR, Math.hypot(x - C, y - C))
const TARGET_R = 200 // ink radius in the 512 grid: inside the tile, and 0.78x of it clears the maskable safe circle
const k = (TARGET_R - (STROKE_256 * 2) / 2) / (maxR * 2)
const S = 2 * k
const scaled = full.map((a) => ({ x: 256 + (a.x - C) * S, y: 256 + (a.y - C) * S, th: a.th, in: a.in * S, out: a.out * S }))
const stroke = STROKE_256 * S
const inkR = maxR * S + stroke / 2
console.log(`512 grid: ink radius ${inkR.toFixed(1)}, stroke ${stroke.toFixed(2)}  (maskable check needs ${(inkR * 0.78).toFixed(1)} <= 204.8)`)

const d = bezierPath(scaled)
writeFileSync(join(finalDir, "path.txt"), `${d}\n`)
// The anchors, so the mark can be rebuilt or chained without re-deriving it.
writeFileSync(join(finalDir, "anchors.json"), JSON.stringify({ variant: CHOSEN, stroke, anchors: scaled }, null, 2))
writeFileSync(join(finalDir, "mark.svg"), `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <path d="${d}" fill="none" stroke="#efbf2e" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`)

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
    <!-- Radial, and centred: a linear gradient reverses under a half turn, which
         would leave a rotationally symmetric mark rendering asymmetric. -->
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
      <stop offset="0" stop-color="#ffdf7f"/>
      <stop offset="0.62" stop-color="#eabe2c"/>
      <stop offset="1" stop-color="#cf9412"/>
    </radialGradient>
  </defs>

  <rect id="icon-background" x="16" y="16" width="480" height="480" rx="116" fill="url(#background)"/>
  <rect id="icon-border" x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle id="icon-glow" cx="256" cy="256" r="205" fill="url(#glow)"/>

  <!-- One continuous stroke: a cursive f with exactly two self-crossings, one
       per loop, and exact 180-degree rotational symmetry. The second half of the
       path is the first half's anchors rotated and reversed, so the symmetry
       lives in the data. Do not edit one side without mirroring the other. -->
  <g id="icon-mark" clip-path="url(#tile)">
    <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`
writeFileSync(join(finalDir, "favicon.svg"), favicon)
console.log(`\nwrote final/mark.svg, final/favicon.svg, final/path.txt`)

if (process.argv.includes("--install")) {
  const dest = join(here, "../../packages/web/public/favicon.svg")
  writeFileSync(dest, favicon)
  console.log(`installed -> packages/web/public/favicon.svg`)
}
