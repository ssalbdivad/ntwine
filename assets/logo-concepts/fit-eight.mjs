#!/usr/bin/env node
// Fit a parametric mark to the reference image by PIXEL OVERLAP rather than by
// eye. Renders a candidate, compares its ink mask with the reference's, and
// hill-climbs the parameters to maximise intersection-over-union.
//
// Judging shape by eye is what produced six rounds of near-misses. IoU is a
// number: it says how close the shape is, it says whether a change helped, and
// it does not get tired or talk itself into a match.
//
//   node fit-eight.mjs            fit and report
//   node fit-eight.mjs --quick    fewer rounds, for iterating on the model

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePngAlpha } from "../../scripts/generate-icons.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fitDir = join(here, "fit")
mkdirSync(fitDir, { recursive: true })

const N = 256 // working resolution for the comparison
const REF_SRC = "/Users/me/.ntwine/projects/029a30af-f126-40e3-b04c-d80e74e3e090/attachments/1786229519809-a8ae5c59-ef1bad9f-c28b-4a7a-9ede-0bf540f997b2.png"

// ------------------------------------------------------------- reference mask

function referenceMask() {
  const raw = execFileSync("magick", [REF_SRC, "-colorspace", "gray", "-resize", `${N}x${N}!`, "-depth", "8", "gray:-"], {
    maxBuffer: 1 << 26,
    encoding: "buffer",
  })
  const mask = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i += 1) mask[i] = raw[i] > 90 ? 1 : 0
  return mask
}

// ------------------------------------------------------------------ the model

/**
 * The figure-eight, with the two loops sized independently.
 *
 * `u = cos t` runs +1 at the top apex to -1 at the bottom, so blending the
 * height and width across u gives one smooth closed curve whose top and bottom
 * loops differ — which is the whole point. The reference's bottom loop is 40%
 * taller than its top and its waist sits at 42% height, and that asymmetry is
 * what makes it read as an f rather than as an 8.
 */
function eightPath(p, steps = 300) {
  const pts = []
  for (let i = 0; i <= steps; i += 1) {
    const t = (2 * Math.PI * i) / steps
    const u = Math.cos(t)
    const h = (p.topH * (1 + u)) / 2 + (p.botH * (1 - u)) / 2
    const w = (p.topW * (1 + u)) / 2 + (p.botW * (1 - u)) / 2
    const dx = (p.topDx * (1 + u)) / 2 + (p.botDx * (1 - u)) / 2
    const y = p.cy - h * u
    // `waistK` separates the two branches at the waist: it is the one term whose
    // sign depends on the branch rather than on height, so it turns the single
    // pinch point into a crossing with the branches running alongside each
    // other — which is what the reference does and where the fit was losing.
    // Independent shear per loop: it tilts the two loops against each other,
    // which rotates the branches where they meet and is the only handle that
    // moves the crossing itself rather than the loops around it.
    const sh = (p.topShear * (1 + u)) / 2 + (p.botShear * (1 - u)) / 2
    pts.push([p.cx + dx + (w / 2) * Math.sin(2 * t) + p.waistK * Math.sin(t) + sh * (p.cy - y), y])
  }
  return pts
}

/** The crossbar: a quadratic through two ends with a perpendicular bow. */
function barPath(p) {
  const [x0, y0, x1, y1] = [p.bx0, p.by0, p.bx1, p.by1]
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const cxp = mx - (dy / len) * p.bow
  const cyp = my + (dx / len) * p.bow
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} Q${cxp.toFixed(2)} ${cyp.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function smoothClosed(points) {
  const p = points
  let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = p[i - 1] ?? p[p.length - 2]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[i + 2] ?? p[1]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return `${d}Z`
}

export function markSvg(p, size = N, flat = true) {
  const ink = flat ? "#fff" : "url(#ink)"
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${N} ${N}" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="${ink}" stroke-width="${p.stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${smoothClosed(eightPath(p))}"/>
    <path d="${barPath(p)}"/>
  </g>
</svg>
`
}

let evals = 0
function candidateMask(p) {
  evals += 1
  const svgPath = join(fitDir, "cand.svg")
  const pngPath = join(fitDir, "cand.png")
  writeFileSync(svgPath, markSvg(p))
  execFileSync("rsvg-convert", ["-w", String(N), "-h", String(N), svgPath, "-o", pngPath])
  const { alpha } = decodePngAlpha(pngPath)
  const mask = new Uint8Array(N * N)
  for (let i = 0; i < mask.length; i += 1) mask[i] = alpha[i] > 127 ? 1 : 0
  return mask
}

function iou(a, b) {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] || b[i]) union += 1
    if (a[i] && b[i]) inter += 1
  }
  return union ? inter / union : 0
}

// ------------------------------------------------------------------ the fit

const REF = referenceMask()
const loss = (p) => 1 - iou(REF, candidateMask(p))

// Seeded from the row-profile measurement of the reference, not from taste.
let best = {
  cx: 127, cy: 105,
  topH: 77, botH: 108,
  topW: 35, botW: 41,
  topShear: 0, botShear: 0, stroke: 9,
  topDx: 0, botDx: 0, waistK: 0,
  bx0: 55, by0: 137, bx1: 202, by1: 89, bow: 10,
}
const STEPS = {
  cx: 4, cy: 4, topH: 5, botH: 5, topW: 4, botW: 4,
  topShear: 0.06, botShear: 0.06, stroke: 1.5, topDx: 4, botDx: 4, waistK: 3,
  bx0: 5, by0: 5, bx1: 5, by1: 5, bow: 4,
}
const keys = Object.keys(best)
let bestLoss = loss(best)
console.log(`seed IoU ${(1 - bestLoss).toFixed(4)}`)

const rounds = process.argv.includes("--quick") ? 3 : 24
let scale = 1
for (let round = 0; round < rounds; round += 1) {
  let improved = false
  for (const k of keys) {
    for (const sign of [1, -1]) {
      const trial = { ...best, [k]: best[k] + sign * STEPS[k] * scale }
      if (k === "stroke" && trial.stroke < 3) continue
      const l = loss(trial)
      if (l < bestLoss - 1e-6) {
        best = trial
        bestLoss = l
        improved = true
      }
    }
  }
  console.log(`round ${round + 1} (step x${scale.toFixed(2)}): IoU ${(1 - bestLoss).toFixed(4)}${improved ? "" : "  (no improvement)"}`)
  if (!improved) scale *= 0.5
  if (scale < 0.02) break
}

// Coordinate descent only moves one parameter at a time, so it stalls whenever
// two parameters have to move together. A short deterministic random-direction
// search shakes it loose. Seeded LCG, so the fit is reproducible.
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
for (let amp = 1; amp >= 0.05; amp *= 0.7) {
  let stuck = 0
  while (stuck < 60) {
    const trial = { ...best }
    for (const k of keys) trial[k] = best[k] + rnd() * STEPS[k] * amp
    if (trial.stroke < 3) continue
    const l = loss(trial)
    if (l < bestLoss - 1e-6) {
      best = trial
      bestLoss = l
      stuck = 0
    } else stuck += 1
  }
}
console.log(`after pattern search: IoU ${(1 - bestLoss).toFixed(4)}`)

writeFileSync(join(fitDir, "best.json"), JSON.stringify({ iou: 1 - bestLoss, params: best }, null, 2))
writeFileSync(join(fitDir, "best.svg"), markSvg(best, 512))
console.log(`\nfinal IoU ${(1 - bestLoss).toFixed(4)} after ${evals} renders`)
console.log(JSON.stringify(best))
