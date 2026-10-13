#!/usr/bin/env node
// The mark as one stroke with EXACTLY TWO self-crossings, fitted to the
// reference and finished as a small chain of cubic Beziers.
//
// Two crossings is what separates a cursive f from a figure eight. One crossing
// at the waist makes BOTH loops at once — that is an 8, and it is what every
// earlier attempt produced. Two means each loop closes on its own, with a stem
// running between them: the ascender loop shuts by crossing its own upstroke,
// the descender loop shuts by crossing the downstroke.
//
// The count is a hard constraint, not a hope: any candidate that does not have
// exactly two is rejected outright, so the optimiser cannot quietly slide back
// into an eight while chasing pixels.
//
// Stage 1 fits waypoints (robust, tolerant of a rough seed). Stage 2 refits the
// result as G1-continuous cubic segments, where tangent continuity is structural
// and curvature can only vary as fast as a cubic allows.
//
//   nub fit-two.mjs

import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePngAlpha } from "../../scripts/generate-icons.mjs"
import { selfCrossings } from "./crossings.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fitDir = join(here, "fit")
mkdirSync(fitDir, { recursive: true })

const N = 256
const WANT_CROSSINGS = 2
// Sample the constraint check as densely as the final check. A coarse check is
// not a weaker check, it is a DIFFERENT one, and an optimiser will find the gap
// between them: at 16 samples per segment this accepted a shape that had five
// crossings when measured properly.
const CHECK_PER = 40
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

// ------------------------------------------------------------------ curves

export function catmullSample(pts, per) {
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

export function catmullPath(pts) {
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

export function bezierSample(anchors, per) {
  const out = []
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i]
    const b = anchors[i + 1]
    const p0 = [a.x, a.y]
    const p1 = [a.x + Math.cos(a.th) * a.out, a.y + Math.sin(a.th) * a.out]
    const p2 = [b.x - Math.cos(b.th) * b.in, b.y - Math.sin(b.th) * b.in]
    const p3 = [b.x, b.y]
    for (let s = 0; s < per; s += 1) {
      const t = s / per
      const m = 1 - t
      out.push([
        m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
        m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1],
      ])
    }
  }
  out.push([anchors[anchors.length - 1].x, anchors[anchors.length - 1].y])
  return out
}

export function bezierPath(anchors) {
  let d = `M${anchors[0].x.toFixed(2)} ${anchors[0].y.toFixed(2)}`
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i]
    const b = anchors[i + 1]
    d += `C${(a.x + Math.cos(a.th) * a.out).toFixed(2)} ${(a.y + Math.sin(a.th) * a.out).toFixed(2)} ${(b.x - Math.cos(b.th) * b.in).toFixed(2)} ${(b.y - Math.sin(b.th) * b.in).toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
  }
  return d
}

export const svgFor = (d, stroke, size = N, ink = "#fff", tile = false) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${N} ${N}" xmlns="http://www.w3.org/2000/svg">
${tile ? `  <rect x="8" y="8" width="240" height="240" rx="58" fill="#0d0e10"/>\n` : ""}  <path d="${d}" fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

// ------------------------------------------------------------------ scoring

let evals = 0
function maskOf(d, stroke) {
  evals += 1
  const svgPath = join(fitDir, "two-cand.svg")
  const pngPath = join(fitDir, "two-cand.png")
  writeFileSync(svgPath, svgFor(d, stroke))
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

/** Coordinate descent over an arbitrary state, with a hard reject predicate. */
function descend({ state, fields, loss, steps, passes = 8, label }) {
  let best = state
  let bestLoss = loss(best)
  for (const step of steps) {
    for (let pass = 0; pass < passes; pass += 1) {
      let improved = false
      for (const f of fields(best)) {
        for (const sign of [1, -1]) {
          const trial = f.apply(best, sign * step * f.unit)
          if (!trial) continue
          const l = loss(trial)
          if (l < bestLoss - 1e-6) {
            best = trial
            bestLoss = l
            improved = true
          }
        }
      }
      if (!improved) break
    }
    console.log(`  ${label} step ${step.toFixed(2)}: IoU ${(1 - bestLoss).toFixed(4)}`)
  }
  return { best, bestLoss }
}

function main() {
  const REF = referenceMask()

  // Seeded by hand so the topology starts right: entry tail, ascender loop that
  // shuts on its own upstroke, stem, descender loop that shuts on the
  // downstroke, exit tail. Verified at 2 crossings before any fitting.
  const SEED = [
    [55, 141], [84, 134], [110, 126],
    [132, 112], [145, 90], [147, 64],
    [136, 40], [118, 33], [103, 45],
    [97, 68], [100, 92], [110, 114],
    [120, 136], [130, 158], [133, 182],
    [124, 203], [106, 196], [99, 172],
    [104, 148], [118, 132],
    [142, 120], [170, 106], [200, 92],
  ]

  // ------------------------------------------------------- stage 1: waypoints
  const wpLoss = (s) => {
    const crossings = selfCrossings(catmullSample(s.pts, CHECK_PER)).length
    if (crossings !== WANT_CROSSINGS) return 10 + Math.abs(crossings - WANT_CROSSINGS)
    return 1 - iou(REF, maskOf(catmullPath(s.pts), s.stroke))
  }
  const wpFields = (s) => {
    const out = []
    for (let i = 0; i < s.pts.length; i += 1) {
      for (const axis of [0, 1]) {
        out.push({
          unit: 1,
          apply: (st, d) => {
            const n = { stroke: st.stroke, pts: st.pts.map((p) => [p[0], p[1]]) }
            n.pts[i][axis] += d
            return n
          },
        })
      }
    }
    out.push({
      unit: 0.25,
      apply: (st, d) => (st.stroke + d < 4 ? null : { stroke: st.stroke + d, pts: st.pts.map((p) => [p[0], p[1]]) }),
    })
    return out
  }
  console.log("stage 1 — waypoints")
  const stage1 = descend({
    state: { stroke: 9.1, pts: SEED },
    fields: wpFields,
    loss: wpLoss,
    steps: [6, 3.6, 2.16, 1.3, 0.78, 0.47],
    label: "wp",
  })

  // -------------------------------------------------------- stage 2: beziers
  const dense = catmullSample(stage1.best.pts, 24)
  const K = Number(process.env.ANCHORS ?? 12)
  const anchors = []
  for (let i = 0; i < K; i += 1) {
    const idx = Math.round((i * (dense.length - 1)) / (K - 1))
    const a = dense[Math.max(0, idx - 6)]
    const b = dense[Math.min(dense.length - 1, idx + 6)]
    anchors.push({ x: dense[idx][0], y: dense[idx][1], th: Math.atan2(b[1] - a[1], b[0] - a[0]), in: 12, out: 12 })
  }

  const bzLoss = (s) => {
    const crossings = selfCrossings(bezierSample(s.anchors, CHECK_PER)).length
    if (crossings !== WANT_CROSSINGS) return 10 + Math.abs(crossings - WANT_CROSSINGS)
    return 1 - iou(REF, maskOf(bezierPath(s.anchors), s.stroke))
  }
  const FIELDS = [["x", 1], ["y", 1], ["th", 0.06], ["in", 1.2], ["out", 1.2]]
  const bzFields = (s) => {
    const out = []
    for (let i = 0; i < s.anchors.length; i += 1) {
      for (const [field, unit] of FIELDS) {
        out.push({
          unit,
          apply: (st, d) => {
            const n = { stroke: st.stroke, anchors: st.anchors.map((a) => ({ ...a })) }
            n.anchors[i][field] += d
            return n.anchors[i].in < 1 || n.anchors[i].out < 1 ? null : n
          },
        })
      }
    }
    out.push({
      unit: 0.2,
      apply: (st, d) => (st.stroke + d < 4 ? null : { stroke: st.stroke + d, anchors: st.anchors.map((a) => ({ ...a })) }),
    })
    return out
  }
  console.log(`\nstage 2 — ${K} anchors, ${K - 1} cubic segments`)
  const stage2 = descend({
    state: { stroke: stage1.best.stroke, anchors },
    fields: bzFields,
    loss: bzLoss,
    steps: [4, 2.4, 1.4, 0.86, 0.52, 0.31],
    label: "bz",
  })

  const finalPts = bezierSample(stage2.best.anchors, 140)
  const crossings = selfCrossings(finalPts)
  const d = bezierPath(stage2.best.anchors)
  writeFileSync(join(fitDir, "two-best.json"), JSON.stringify({ iou: 1 - stage2.bestLoss, crossings: crossings.length, ...stage2.best }, null, 2))
  writeFileSync(join(fitDir, "two-replica.svg"), svgFor(d, stage2.best.stroke, 512, "#efbf2e", true))
  console.log(`\nfinal IoU ${(1 - stage2.bestLoss).toFixed(4)} after ${evals} renders`)
  console.log(`self-crossings: ${crossings.length} at ${crossings.map((p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`).join(" ")}`)
  console.log(`${stage2.best.anchors.length - 1} cubic segments, stroke ${stage2.best.stroke.toFixed(2)}`)
  console.log(`\npath d:\n${d}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
