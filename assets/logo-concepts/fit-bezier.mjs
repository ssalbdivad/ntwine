#!/usr/bin/env node
// Refit the mark as a proper cubic Bezier path: few anchors, real tangents,
// naturally flowing curvature.
//
// The 28-waypoint version matched the reference but was 28 points hill-climbed
// independently, so every one of them chased pixels on its own and the curvature
// came out lumpy — smooth to the eye at a glance, but not a drawn curve.
//
// Here the path is a handful of cubic segments joined G1: each anchor carries a
// position, ONE tangent direction shared by the segments either side of it, and
// an incoming and outgoing handle length. Tangent continuity is structural, so
// no amount of fitting can introduce a corner, and curvature can only vary as
// fast as a cubic allows.
//
//   node fit-bezier.mjs            fit with the default anchor count
//   ANCHORS=9 node fit-bezier.mjs  try a different one

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePngAlpha } from "../../scripts/generate-icons.mjs"
import { splinePath } from "./fit-spline.mjs"

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

/**
 * Anchors -> one open cubic path.
 *
 * Each anchor has a single tangent angle used by both adjoining segments, so
 * the joins are G1 by construction rather than by fitting.
 */
export function bezierPath(anchors) {
  const p = anchors
  let d = `M${p[0].x.toFixed(2)} ${p[0].y.toFixed(2)}`
  for (let i = 0; i < p.length - 1; i += 1) {
    const a = p[i]
    const b = p[i + 1]
    const c1x = a.x + Math.cos(a.th) * a.out
    const c1y = a.y + Math.sin(a.th) * a.out
    const c2x = b.x - Math.cos(b.th) * b.in
    const c2y = b.y - Math.sin(b.th) * b.in
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
  }
  return d
}

export function bezierSvg(state, size = N, ink = "#fff") {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${N} ${N}" xmlns="http://www.w3.org/2000/svg">
  <path d="${bezierPath(state.anchors)}" fill="none" stroke="${ink}" stroke-width="${state.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`
}

let evals = 0
function maskOf(state) {
  evals += 1
  const svgPath = join(fitDir, "bez-cand.svg")
  const pngPath = join(fitDir, "bez-cand.png")
  writeFileSync(svgPath, bezierSvg(state))
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

/** Densely sample a Catmull-Rom polyline, for seeding. */
function sampleCatmull(pts, per = 24) {
  const out = []
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? pts[i + 1]
    for (let s = 0; s < per; s += 1) {
      const t = s / per
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Total variation of curvature along a path — how much the bend jitters. */
export function curvatureRoughness(points) {
  const k = []
  for (let i = 1; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const [cx, cy] = points[i + 1]
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
    const d1 = Math.hypot(bx - ax, by - ay)
    const d2 = Math.hypot(cx - bx, cy - by)
    const d3 = Math.hypot(cx - ax, cy - ay)
    k.push(d1 * d2 * d3 < 1e-9 ? 0 : (2 * cross) / (d1 * d2 * d3))
  }
  let tv = 0
  for (let i = 1; i < k.length; i += 1) tv += Math.abs(k[i] - k[i - 1])
  return tv
}

function samplePath(d, per = 400) {
  // Sample the rendered path by walking its own points; cheap enough via the
  // anchors' dense reconstruction rather than a real path parser.
  return d
}

function main() {
  const REF = referenceMask()
  const loss = (s) => 1 - iou(REF, maskOf(s))

  const prev = JSON.parse(readFileSync(join(fitDir, "spline-best.json"), "utf8"))
  const dense = sampleCatmull(prev.pts)

  const K = Number(process.env.ANCHORS ?? 11)
  const anchors = []
  for (let i = 0; i < K; i += 1) {
    const idx = Math.round((i * (dense.length - 1)) / (K - 1))
    const [x, y] = dense[idx]
    const a = dense[Math.max(0, idx - 6)]
    const b = dense[Math.min(dense.length - 1, idx + 6)]
    const th = Math.atan2(b[1] - a[1], b[0] - a[0])
    const seg = dense.length / (K - 1) / 24
    anchors.push({ x, y, th, in: 12, out: 12 })
  }
  let best = { stroke: prev.stroke, anchors }
  let bestLoss = loss(best)
  console.log(`${K} anchors — seed IoU ${(1 - bestLoss).toFixed(4)}`)

  const clone = (s) => ({ stroke: s.stroke, anchors: s.anchors.map((a) => ({ ...a })) })
  const FIELDS = [
    ["x", 1],
    ["y", 1],
    ["th", 0.06],
    ["in", 1.2],
    ["out", 1.2],
  ]

  for (let step = 6; step >= 0.25; step *= 0.6) {
    for (let pass = 0; pass < 8; pass += 1) {
      let improved = false
      for (let i = 0; i < best.anchors.length; i += 1) {
        for (const [field, unit] of FIELDS) {
          for (const sign of [1, -1]) {
            const trial = clone(best)
            trial.anchors[i][field] += sign * step * unit
            if (trial.anchors[i].in < 1 || trial.anchors[i].out < 1) continue
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
        trial.stroke += sign * step * 0.2
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

  writeFileSync(join(fitDir, "bezier-best.json"), JSON.stringify({ iou: 1 - bestLoss, ...best }, null, 2))
  writeFileSync(join(fitDir, "bezier.svg"), bezierSvg(best, 512, "#efbf2e"))
  console.log(`\nfinal IoU ${(1 - bestLoss).toFixed(4)} after ${evals} renders`)
  console.log(`${best.anchors.length} anchors, ${best.anchors.length - 1} cubic segments, stroke ${best.stroke.toFixed(2)}`)
  console.log(`\npath d:\n${bezierPath(best.anchors)}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
