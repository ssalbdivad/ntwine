#!/usr/bin/env node
// Smooth the constructed two-crossing mark into a short chain of cubic Beziers.
//
// This fits the CENTRELINE, not the reference image. Fitting pixel overlap
// against a reference that has only one crossing, while forcing two, can only
// tear a loop open — which is exactly what it did: the descender unrolled into a
// hook. The shape is constructed first and the curve fit second, so smoothing
// cannot change the topology.
//
// Loss is symmetric chamfer distance to the target centreline, so it needs no
// rendering and runs a few thousand evaluations in seconds. The crossing count
// is still a hard constraint, checked at the same density as the final report.
//
//   node fit-curve.mjs

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierPath, bezierSample, catmullSample, svgFor } from "./fit-two.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fitDir = join(here, "fit")
mkdirSync(fitDir, { recursive: true })

const WANT_CROSSINGS = 2
const CHECK_PER = 40

/** Symmetric mean nearest-point distance between two polylines. */
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
  for (const [bx, by] of b) {
    let best = Infinity
    for (const [ax, ay] of a) {
      const d = (ax - bx) ** 2 + (ay - by) ** 2
      if (d < best) best = d
    }
    sum += Math.sqrt(best)
  }
  return sum / (a.length + b.length)
}

/** Total variation of curvature per 100 units of arc — how much the bend jitters. */
export function roughness(p) {
  const k = []
  for (let i = 1; i < p.length - 1; i += 1) {
    const [ax, ay] = p[i - 1]
    const [bx, by] = p[i]
    const [cx, cy] = p[i + 1]
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
    const d1 = Math.hypot(bx - ax, by - ay)
    const d2 = Math.hypot(cx - bx, cy - by)
    const d3 = Math.hypot(cx - ax, cy - ay)
    k.push(d1 * d2 * d3 < 1e-9 ? 0 : (2 * cross) / (d1 * d2 * d3))
  }
  let tv = 0
  for (let i = 1; i < k.length; i += 1) tv += Math.abs(k[i] - k[i - 1])
  let len = 0
  for (let i = 1; i < p.length; i += 1) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  return (tv / len) * 100
}

function main() {
  const waypoints = JSON.parse(readFileSync(join(fitDir, "two-crossing-waypoints.json"), "utf8"))
  const target = catmullSample(waypoints, 30)

  const K = Number(process.env.ANCHORS ?? 13)
  const anchors = []
  for (let i = 0; i < K; i += 1) {
    const idx = Math.round((i * (target.length - 1)) / (K - 1))
    const a = target[Math.max(0, idx - 8)]
    const b = target[Math.min(target.length - 1, idx + 8)]
    anchors.push({ x: target[idx][0], y: target[idx][1], th: Math.atan2(b[1] - a[1], b[0] - a[0]), in: 14, out: 14 })
  }

  const loss = (s) => {
    const pts = bezierSample(s, CHECK_PER)
    if (selfCrossings(pts).length !== WANT_CROSSINGS) return 1e6
    return chamfer(bezierSample(s, 12), target)
  }

  let best = anchors
  let bestLoss = loss(best)
  console.log(`${K} anchors — seed chamfer ${bestLoss.toFixed(3)}px`)

  const FIELDS = [["x", 1], ["y", 1], ["th", 0.05], ["in", 1.5], ["out", 1.5]]
  for (let step = 4; step >= 0.06; step *= 0.65) {
    for (let pass = 0; pass < 10; pass += 1) {
      let improved = false
      for (let i = 0; i < best.length; i += 1) {
        for (const [field, unit] of FIELDS) {
          for (const sign of [1, -1]) {
            const trial = best.map((a) => ({ ...a }))
            trial[i][field] += sign * step * unit
            if (trial[i].in < 1 || trial[i].out < 1) continue
            const l = loss(trial)
            if (l < bestLoss - 1e-6) {
              best = trial
              bestLoss = l
              improved = true
            }
          }
        }
      }
      if (!improved) break
    }
  }

  const dense = bezierSample(best, 140)
  const crossings = selfCrossings(dense)
  const stroke = 9.4
  const d = bezierPath(best)
  writeFileSync(join(fitDir, "curve-best.json"), JSON.stringify({ chamfer: bestLoss, crossings: crossings.length, stroke, anchors: best }, null, 2))
  writeFileSync(join(fitDir, "curve-replica.svg"), svgFor(d, stroke, 512, "#efbf2e", true))
  writeFileSync(join(fitDir, "curve-mark.svg"), svgFor(d, stroke, 512, "#efbf2e", false))
  console.log(`chamfer to the constructed centreline: ${bestLoss.toFixed(3)}px`)
  console.log(`self-crossings: ${crossings.length} at ${crossings.map((p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`).join(" ")}`)
  console.log(`curvature roughness: waypoints ${roughness(target).toFixed(2)} -> beziers ${roughness(dense).toFixed(2)} per 100u`)
  console.log(`${best.length - 1} cubic segments\n`)
  console.log(d)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
