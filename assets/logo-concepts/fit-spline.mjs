#!/usr/bin/env node
// ONE unified spline. A single open path, two free ends, no separate crossbar.
//
// The reference is one stroke, and the giveaway is the waist: three strands meet
// there in a TRIANGLE of crossings, which is what one path passing through the
// middle three times looks like. A closed figure-eight with a bar laid across it
// would put four strands through a single node instead. Reading it as two
// strokes is what made every previous attempt land as "an eight with a line
// through it".
//
// Traversal: left tail rises right, up the top loop's right side, over the apex,
// down its left side, on down into the bottom loop, round the bottom, up its
// right side, and out to the upper right. The entry and exit tails end up
// roughly collinear, which is the whole "crossbar" — it is not a stroke.
//
// Waypoints are seeded from a row-profile measurement of the reference, then
// hill-climbed on pixel overlap. Judging this by eye is what cost six rounds.
//
//   node fit-spline.mjs           fit and report
//   node fit-spline.mjs --quick   fewer passes

import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePngAlpha } from "../../scripts/generate-icons.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fitDir = join(here, "fit")
mkdirSync(fitDir, { recursive: true })

const N = 256
const REF_SRC = "/Users/me/.ntwine/projects/029a30af-f126-40e3-b04c-d80e74e3e090/attachments/1786229519809-a8ae5c59-ef1bad9f-c28b-4a7a-9ede-0bf540f997b2.png"

function referenceMask() {
  const raw = execFileSync("magick", [REF_SRC, "-colorspace", "gray", "-resize", `${N}x${N}!`, "-depth", "8", "gray:-"], {
    maxBuffer: 1 << 26,
    encoding: "buffer",
  })
  const m = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i += 1) m[i] = raw[i] > 90 ? 1 : 0
  return m
}

/** Catmull-Rom through the waypoints, as one open cubic path. */
export function splinePath(pts) {
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? pts[i + 1]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return d
}

export function markSvg(state, size = N, ink = "#fff") {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${N} ${N}" xmlns="http://www.w3.org/2000/svg">
  <path d="${splinePath(state.pts)}" fill="none" stroke="${ink}" stroke-width="${state.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`
}

let evals = 0
function maskOf(state) {
  evals += 1
  const svgPath = join(fitDir, "spline-cand.svg")
  const pngPath = join(fitDir, "spline-cand.png")
  writeFileSync(svgPath, markSvg(state))
  execFileSync("rsvg-convert", ["-w", String(N), "-h", String(N), svgPath, "-o", pngPath])
  const { alpha } = decodePngAlpha(pngPath)
  const m = new Uint8Array(N * N)
  for (let i = 0; i < m.length; i += 1) m[i] = alpha[i] > 127 ? 1 : 0
  return m
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

function main() {
  const REF = referenceMask()
  const loss = (s) => 1 - iou(REF, maskOf(s))

  // Seeded from the reference's row profile: loop widths and branch positions at
  // each height, the two apexes, the waist, and the two tail ends.
  let best = {
    stroke: 10,
    pts: [
      [55, 137], [78, 132], [100, 124], [118, 114],
      [134, 100], [144, 80], [146, 60], [140, 42],
      [127, 32], [114, 40], [108, 58], [108, 78],
      [114, 96], [120, 112], [118, 130], [110, 152],
      [107, 175], [112, 197], [127, 209], [143, 200],
      [151, 180], [152, 158], [146, 136], [140, 120],
      [152, 110], [170, 100], [188, 92], [202, 88],
    ],
  }

  let bestLoss = loss(best)
  console.log(`seed IoU ${(1 - bestLoss).toFixed(4)}  (${best.pts.length} waypoints)`)

  const clone = (s) => ({ stroke: s.stroke, pts: s.pts.map((p) => [p[0], p[1]]) })
  const passes = process.argv.includes("--quick") ? 2 : 6

  for (let step = 6; step >= 0.4; step *= 0.6) {
    for (let pass = 0; pass < passes; pass += 1) {
      let improved = false
      for (let i = 0; i < best.pts.length; i += 1) {
        for (const axis of [0, 1]) {
          for (const sign of [1, -1]) {
            const trial = clone(best)
            trial.pts[i][axis] += sign * step
            const l = loss(trial)
            if (l < bestLoss - 1e-6) {
              best = trial
              bestLoss = l
              improved = true
            }
          }
        }
      }
      for (const sign of [1, -1]) {
        const trial = clone(best)
        trial.stroke += sign * step * 0.25
        if (trial.stroke < 4) continue
        const l = loss(trial)
        if (l < bestLoss - 1e-6) {
          best = trial
          bestLoss = l
          improved = true
        }
      }
      if (!improved) break
    }
    console.log(`step ${step.toFixed(2)}: IoU ${(1 - bestLoss).toFixed(4)}`)
  }

  writeFileSync(join(fitDir, "spline-best.json"), JSON.stringify({ iou: 1 - bestLoss, ...best }, null, 2))
  writeFileSync(join(fitDir, "spline.svg"), markSvg(best, 512, "#efbf2e"))
  console.log(`\nfinal IoU ${(1 - bestLoss).toFixed(4)} after ${evals} renders, stroke ${best.stroke.toFixed(2)}`)

}

// Only fit when run directly; importing this module must not re-run the search.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
